import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { AppStoreConnectApiError } from "#/client/errors";
import { attributesOf, type Rec, resourcesOf, summarizeResponse } from "#/client/shape";
import {
  classifyByCalendar,
  classifyProbe,
  type Confidence,
  type EmptyReason,
  type Frequency,
  periodSpan,
  type ProbedPeriod,
  stepDown,
} from "#/reports/period";
import type { ToolContext } from "#/tools/index";
import {
  appIdArg,
  compact,
  limitArg,
  PreconditionError,
  type SavedFile,
  savePathArg,
  saveToPath,
  wrap,
  wrapSaved,
} from "#/tools/util";

const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;

/** Apple's analytics report categories, as accepted by `filter[category]`. */
const REPORT_CATEGORIES = [
  "APP_USAGE",
  "APP_STORE_ENGAGEMENT",
  "COMMERCE",
  "FRAMEWORK_USAGE",
  "PERFORMANCE",
] as const;

const GRANULARITIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;

/**
 * A segment is one gzipped CSV of a report instance. Big apps produce big ones,
 * and the whole file is decompressed in this process before being truncated, so
 * the compressed size is checked against this before anything is fetched.
 */
const DEFAULT_MAX_SEGMENT_BYTES = 25 * 1024 * 1024;

const SALES_REPORT_TYPES = [
  "SALES",
  "PRE_ORDER",
  "SUBSCRIPTION",
  "SUBSCRIPTION_EVENT",
  "SUBSCRIBER",
  "NEWSSTAND",
  "INSTALLS",
  "FIRST_ANNUAL",
] as const;

/**
 * Trim a downloaded TSV report so a huge one doesn't blow the context window.
 *
 * Apple terminates both the sales TSV and an analytics CSV segment with a
 * newline, so a naive `split` leaves a phantom empty line at the end. Counting
 * it overstates `lines`, and — the part that actually hurts — can tip a complete
 * report past `maxLines` and flag it truncated. That is not a cosmetic error:
 * `report_stats.py` treats truncation as a hard error precisely so a floor is
 * never quoted as a total, so a false flag makes it refuse a file that lost
 * nothing.
 *
 * It also counts data lines that are byte-identical to another data line.
 * Apple's reports are aggregates keyed by their dimension columns, so the same
 * key should appear once; a file where it appears twice double-counts, and every
 * total taken from it is wrong by exactly that much while looking perfectly
 * well-formed. That is truncation's mirror image, and it is not hypothetical —
 * an ONGOING monthly analytics instance was observed holding every row of its
 * most recent month twice, reporting 7,764 impressions where the
 * ONE_TIME_SNAPSHOT for the same month held 3,882, on three apps at once, with
 * nothing in the response saying so.
 *
 * Unlike truncation this is reported rather than treated as fatal: a DETAILED
 * subtype can legitimately repeat a line, so the caller is told to check rather
 * than stopped.
 *
 * Exported for direct unit testing: the trailing-newline rule is the kind of
 * off-by-one that a round-trip through a tool call can mask.
 */
export const previewReport = (tsv: string, maxLines: number): Record<string, unknown> => {
  const lines = tsv.split("\n");
  let count = lines.length;
  while (count > 0 && lines[count - 1] === "") count -= 1;

  // Data lines only — the header is unique by construction, and counting it
  // would make a single-row report look like it repeated itself.
  const seen = new Set<string>();
  let duplicateRows = 0;
  for (let i = 1; i < count; i += 1) {
    const line = lines[i] as string;
    if (seen.has(line)) duplicateRows += 1;
    else seen.add(line);
  }

  const inlineTruncated = count > maxLines;
  return {
    // Content lines with the header included, so this is one more than the
    // number of data rows. Named `lines` to match `saved.lines`: two names for
    // one count was itself a transcription trap, since `rows` reads as "data
    // rows" to everyone who has not read this function, and a caller checking a
    // transcription against it is off by exactly one and concludes it dropped a
    // row.
    lines: count,
    // Zero means Apple returned a header and nothing else.
    dataRows: Math.max(0, count - 1),
    // Describes `report` below — the copy inlined in this response — and nothing
    // else. A saved file is never truncated.
    inlineTruncated,
    ...(inlineTruncated ? { inlineNote: `Inlining the first ${maxLines} of ${count} lines.` } : {}),
    // Only present when there is something to say, so its absence is not a
    // claim and its presence is never noise.
    ...(duplicateRows > 0
      ? {
          duplicateRows,
          duplicateNote:
            `${duplicateRows} of ${Math.max(0, count - 1)} data rows are byte-identical to ` +
            `another row, so every total from this report is inflated by them. Apple's ONGOING ` +
            `monthly analytics instances have been seen doubling a whole month this way. ` +
            `Cross-check against the ONE_TIME_SNAPSHOT or a WEEKLY instance before quoting a ` +
            `figure, or de-duplicate first.`,
        }
      : {}),
    // Untruncated output is handed back byte-for-byte. Only the sliced path
    // drops the trailing newline, and there the text is already partial.
    report: inlineTruncated ? lines.slice(0, maxLines).join("\n") : tsv,
    /**
     * Deprecated alias for `inlineTruncated`, and unlike `rows` and `note` it is
     * kept rather than scheduled for removal.
     *
     * The asymmetry is what decides it. A reader that loses `rows` or `note`
     * fails loudly — a KeyError, an undefined, a failed assertion. A reader that
     * loses `truncated` fails *silently* in the one direction that matters:
     * `blob.get("truncated")` returns None, which is falsy, so a consumer that
     * refuses to total a truncated report stops refusing and publishes a floor
     * as a total. That is worse than the confusion the rename fixes, and it is
     * unobservable. So this stays, with its exact old value, indefinitely.
     */
    truncated: inlineTruncated,
  };
};

/**
 * The argument the three report DOWNLOADS take, described once.
 *
 * Distinct from the terse `savePathArg` every read shares: these write the raw
 * TSV/CSV rather than a JSON envelope, and the completeness guarantee is the
 * whole reason to reach for them, so it is worth the words here.
 */
const reportSavePathArg = z
  .string()
  .optional()
  .describe(
    "Absolute path to write the report to. The file gets the report in FULL — maxLines then " +
      "only trims the copy inlined in this response — so a saved file is never truncated and " +
      "needs no transcription. Parent directories are created. Use this rather than retyping " +
      "the report into a file, which is where rows go missing.",
  );

/**
 * Write a report where the caller asked, and report what landed.
 *
 * The alternative is the caller retyping the report out of a tool result, and a
 * report is exactly the kind of payload that survives a dropped row looking
 * perfectly well-formed — the totals just come out lower. Writing it here removes
 * the transcription step rather than defending against it.
 *
 * Counts come back with the path so the write can be checked against the same
 * `dataRows` the preview reports, and the two cannot disagree.
 */
const saveReport = async (
  path: string,
  text: string,
): Promise<SavedFile & { lines: number; dataRows: number }> => {
  const written = await saveToPath(path, text, "report");
  const lines = text
    .split("\n")
    .filter((line, index, all) => line !== "" || index < all.length - 1).length;
  return {
    ...written,
    // `report`, not `json`: this file is the raw TSV/CSV Apple returned, and
    // report_stats.py parses it as a table.
    content: "report",
    lines,
    dataRows: Math.max(0, lines - 1),
  };
};

/**
 * Combine the inline preview with the saved-file record.
 *
 * The two describe different things once a file has been written, and the
 * distinction matters downstream: `report_stats.py` treats truncation as a hard
 * error so that a floor is never quoted as a total. Reading the saved file's
 * completeness as a loss would make it refuse a file that lost nothing — which
 * is why `saved.path` is what it follows, and why the note below tells it to.
 */
const previewAndSave = async (
  text: string,
  maxLines: number,
  savePath: string | undefined,
): Promise<Record<string, unknown>> => {
  const preview = previewReport(text, maxLines);
  if (savePath === undefined) return preview;
  const saved = await saveReport(savePath, text);
  return {
    ...preview,
    saved,
    ...(preview.inlineTruncated === true
      ? {
          savedNote:
            `Read ${saved.path} for any total: it holds all ${saved.dataRows} data rows, while ` +
            `the \`report\` inlined above stops at ${maxLines}. ` +
            `report_stats.py follows this path on its own when handed this result.`,
        }
      : {}),
  };
};

/**
 * Split a report into its header line and data lines, discarding the trailing
 * blank Apple leaves behind. Shares `previewReport`'s rule about that newline so
 * a row count taken here cannot disagree with the one reported there.
 */
const splitReport = (tsv: string): { header: string; rows: string[] } | undefined => {
  const lines = tsv.split("\n");
  let count = lines.length;
  while (count > 0 && lines[count - 1] === "") count -= 1;
  if (count === 0) return undefined;
  return { header: lines[0] as string, rows: lines.slice(1, count) };
};

const columnIndexes = (header: string): Map<string, number> =>
  new Map(header.split("\t").map((name, index) => [name.trim(), index] as const));

const cellAt = (row: string, index: number): string => row.split("\t")[index]?.trim() ?? "";

/** `03/29/2026` -> `2026-03-29`; anything else is handed back untouched. */
const isoDate = (value: string): string => {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : value;
};

/**
 * Read the period a finance report actually covers out of its own rows.
 *
 * Apple keys finance reports by *fiscal* period, and its fiscal months are 4-4-5
 * weeks against a year that opens in late September — so `2026-07` is fiscal
 * month 7 of FY2026, roughly late March to early May, not July. Nothing in the
 * request says so and nothing in the response headline says so either, which
 * makes asking for the wrong quarter completely silent: a well-formed report
 * comes back, for a period nobody chose.
 *
 * The TSV carries `Start Date` and `End Date` on every row, so the answer is
 * already in the file. Surfacing it turns a trap that depends on knowing Apple's
 * fiscal calendar into a fact the caller can read off the result.
 *
 * Deliberately forgiving: finance reports are multi-section, and a shape this
 * does not recognise must return nothing rather than throw or guess. A missing
 * `coverage` costs a caller the convenience; a wrong one costs them the report.
 */
const financeCoverage = (tsv: string): { startDate: string; endDate: string } | undefined => {
  const lines = tsv.split("\n");
  const headerIndex = lines.findIndex(
    (line) => line.includes("Start Date") && line.includes("End Date"),
  );
  if (headerIndex === -1) return undefined;

  const columns = columnIndexes(lines[headerIndex] as string);
  const start = columns.get("Start Date");
  const end = columns.get("End Date");
  if (start === undefined || end === undefined) return undefined;

  const row = lines.slice(headerIndex + 1).find((line) => line.trim() !== "");
  if (row === undefined) return undefined;

  const startDate = cellAt(row, start);
  const endDate = cellAt(row, end);
  if (startDate === "" || endDate === "") return undefined;
  return { startDate: isoDate(startDate), endDate: isoDate(endDate) };
};

/** The sales TSV columns identifying an app, named as Apple spells them. */
const SALES_FILTER_COLUMNS = {
  appleIdentifier: "Apple Identifier",
  sku: "SKU",
} as const;

/**
 * The column an in-app purchase row names its parent app in — by SKU, not by the
 * numeric Apple Identifier the rest of the filtering uses. See filterSalesReport.
 */
const PARENT_COLUMN = "Parent Identifier";

type SalesFilter = { appleIdentifier?: string; sku?: string; includeInAppPurchases?: boolean };

/**
 * Keep only the rows belonging to one app, before anything is truncated.
 *
 * Apple has no per-app filter on the sales endpoint, so the TSV is account-wide:
 * every app the vendor ships, interleaved rather than grouped. Two things go
 * wrong when the caller filters it by eye afterwards. The obvious one is
 * quoting a portfolio total as one app's. The subtler one is that `maxLines`
 * then truncates across the interleaving, so a dropped tail removes an
 * arbitrary slice of *every* app — `truncated: true` says something was lost
 * but not that one app vanished from it entirely.
 *
 * Filtering here fixes both: the limit applies to the rows that were asked for,
 * so `truncated` means what it says, and the dropped count is reported rather
 * than left to be inferred.
 *
 * The third thing that goes wrong is the reason `includeInAppPurchases` exists.
 * An in-app purchase row does *not* carry its app's Apple Identifier — it carries
 * the IAP's own, and names the app only in `Parent Identifier`, as the app's SKU
 * string rather than its numeric id. So filtering an account-wide report to an app
 * id drops every IA1 / IA1-M row and returns a clean, plausible, `truncated: false`
 * report showing no in-app revenue at all. Nothing about that answer looks wrong;
 * two separate real runs of the reporting skill came one probe away from publishing
 * "this app has never earned anything" off the back of it.
 *
 * The app's SKU does not have to be supplied to fix this: it is already on the
 * app's own rows, so a first pass over the direct matches yields the parent keys a
 * second pass needs. The one case that cannot self-heal is an app with no direct
 * rows in the period, where there is nothing to read the SKU off — that one is
 * reported rather than silently returning fewer rows than exist.
 */
const filterSalesReport = (
  tsv: string,
  filter: SalesFilter,
): {
  tsv: string;
  matchedRows: number;
  droppedRows: number;
  inAppPurchaseRows: number;
  parentSkus: string[];
  hasParentColumn: boolean;
  droppedChildRows: number;
  droppedChildParents: string[];
  availableColumn: string;
  available: string[];
  availableParents: string[];
} => {
  const empty = {
    matchedRows: 0,
    droppedRows: 0,
    inAppPurchaseRows: 0,
    parentSkus: [],
    hasParentColumn: false,
    droppedChildRows: 0,
    droppedChildParents: [],
    availableColumn: "",
    available: [],
    availableParents: [],
  };
  const split = splitReport(tsv);
  if (split === undefined) return { tsv, ...empty };
  const { header, rows } = split;
  const columns = columnIndexes(header);

  const wanted = Object.entries(SALES_FILTER_COLUMNS)
    .map(([key, column]) => ({ key, column, value: filter[key as keyof SalesFilter] }))
    .filter((entry) => entry.value !== undefined && entry.value !== "");

  // A filter the report cannot honour must fail loudly. Ignoring it would hand
  // back the whole portfolio under a name that claims one app — precisely the
  // mistake this argument exists to prevent.
  const missing = wanted.filter((entry) => !columns.has(entry.column));
  if (missing.length > 0) {
    throw new PreconditionError(
      `This report has no ${missing.map((entry) => `"${entry.column}"`).join(" or ")} column, so ` +
        `it cannot be filtered by app. Summary reports carry it; some reportType / reportSubType ` +
        `combinations do not. Columns present: ${[...columns.keys()].join(", ")}.`,
      { columns: [...columns.keys()] },
    );
  }

  const direct = new Set<number>();
  rows.forEach((row, index) => {
    if (wanted.every((entry) => cellAt(row, columns.get(entry.column) as number) === entry.value)) {
      direct.add(index);
    }
  });

  // The parent keys are SKUs. An explicit `sku` filter is one directly; otherwise
  // they come off the app's own rows, which carry both identifiers side by side.
  const skuIndex = columns.get(SALES_FILTER_COLUMNS.sku);
  const parentIndex = columns.get(PARENT_COLUMN);
  const parentSkus = new Set<string>();
  if (filter.sku !== undefined && filter.sku !== "") parentSkus.add(filter.sku);
  if (skuIndex !== undefined) {
    for (const index of direct) {
      const value = cellAt(rows[index] as string, skuIndex);
      if (value !== "") parentSkus.add(value);
    }
  }

  // Children are found whether or not they are wanted: a caller who opts out still
  // needs to be told what opting out cost them, and that count is the whole point
  // of the note. Only the membership of `keep` depends on the flag.
  const children = new Set<number>();
  if (parentIndex !== undefined && parentSkus.size > 0) {
    rows.forEach((row, index) => {
      if (direct.has(index)) return;
      if (parentSkus.has(cellAt(row, parentIndex))) children.add(index);
    });
  }

  const includeChildren = filter.includeInAppPurchases !== false;
  const keep = includeChildren ? new Set([...direct, ...children]) : direct;
  // One pass over the original rows, so the output keeps the file's order rather
  // than listing the app's rows and then its purchases.
  const matched = rows.filter((_row, index) => keep.has(index));

  const distinct = (index: number | undefined, from: Set<number> | undefined): string[] =>
    index === undefined
      ? []
      : [
          ...new Set(
            (from === undefined ? rows : rows.filter((_row, i) => from.has(i))).map((row) =>
              cellAt(row, index),
            ),
          ),
        ]
          .filter((value) => value !== "")
          .slice(0, 25);

  // Only computed for the empty result, where naming the values actually present
  // is what distinguishes a typo from a report for the wrong account — and, since
  // the IAP split, from an app whose rows are all keyed under a parent.
  const probe = wanted[0];
  const nothingMatched = matched.length === 0;

  return {
    tsv: [header, ...matched].join("\n") + "\n",
    matchedRows: matched.length,
    droppedRows: rows.length - matched.length,
    inAppPurchaseRows: includeChildren ? children.size : 0,
    parentSkus: [...parentSkus],
    hasParentColumn: parentIndex !== undefined,
    droppedChildRows: includeChildren ? 0 : children.size,
    droppedChildParents: includeChildren ? [] : distinct(parentIndex, children),
    availableColumn: probe?.column ?? "",
    available:
      nothingMatched && probe !== undefined ? distinct(columns.get(probe.column), undefined) : [],
    availableParents: nothingMatched ? distinct(parentIndex, undefined) : [],
  };
};

/**
 * Say what the filter did in the two cases where the rows alone mislead.
 *
 * An empty result is the older of the two: it reads as "this app earned nothing"
 * when it usually means the id belongs to another account. Naming the values the
 * report does hold — including the parent identifiers, since the IAP split — turns
 * that into a fact the caller can act on.
 *
 * The newer case is a non-empty result that is quietly incomplete: children found
 * but excluded, or an app whose SKU could not be derived because it has no rows of
 * its own this period. Both return a well-formed report that is missing revenue,
 * which is the failure this whole mechanism exists to prevent, so neither is
 * allowed to pass silently.
 */
const salesFilterNote = (
  filtered: ReturnType<typeof filterSalesReport>,
  sku: string | undefined,
): string | undefined => {
  if (filtered.matchedRows === 0) {
    const parents = filtered.availableParents.length
      ? ` "${PARENT_COLUMN}" values present: ${filtered.availableParents.join(", ")} — an ` +
        `in-app purchase names its app there, by SKU, so a match in that list means the right ` +
        `app filtered by the wrong column.`
      : "";
    return (
      `No rows matched. The report holds ${filtered.droppedRows} rows for other ` +
      `apps, so the period itself is not empty — this is a filter that did not ` +
      `match, most often a correct-looking id from a different account. ` +
      `"${filtered.availableColumn}" values present: ` +
      `${filtered.available.join(", ") || "none"}.${parents}`
    );
  }

  if (filtered.droppedChildRows > 0) {
    return (
      `${filtered.droppedChildRows} dropped rows carry ${PARENT_COLUMN} ` +
      `${filtered.droppedChildParents.join(", ")} — these are this app's in-app purchases, ` +
      `excluded because includeInAppPurchases is false. Any revenue on them is missing from ` +
      `the totals below.`
    );
  }

  if (filtered.hasParentColumn && filtered.parentSkus.length === 0 && sku === undefined) {
    return (
      `This app has no rows of its own in this period, so its SKU could not be read off the ` +
      `report and no in-app purchase rows could be matched — ${PARENT_COLUMN} holds the SKU, ` +
      `not the app id. Pass sku to pick them up; without it, a period where only IAPs sold ` +
      `reads as zero.`
    );
  }

  if (filtered.inAppPurchaseRows > 0) {
    return (
      `${filtered.inAppPurchaseRows} of the ${filtered.matchedRows} rows are in-app purchases, ` +
      `matched through ${PARENT_COLUMN} = ${filtered.parentSkus.join(", ")}. They carry their ` +
      `own Apple Identifier and SKU, so these rows hold more than one of each — group by ` +
      `Product Type Identifier to separate app units from purchases.`
    );
  }

  return undefined;
};

/**
 * Apple answers a vendor number this key cannot read with a bare HTTP 500
 * `UNEXPECTED_ERROR` telling you to contact support. There is no "unknown
 * vendor" code, and no endpoint to look the right number up — the App Store
 * Connect API has no vendor resource at all (683 paths in the 3.2 spec, none of
 * them vendor-shaped). Surfaced raw, that 500 reads as an Apple outage and
 * sends you to the status page instead of to the one field that is wrong.
 */
const withVendorHint = async <T>(vendor: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppStoreConnectApiError && err.status >= 500) {
      throw new AppStoreConnectApiError(
        `Apple returned HTTP ${err.status} for this report. The usual cause is that vendor ` +
          `number ${vendor} is not one this API key can read — Apple does not distinguish a ` +
          `bad vendor number from a server fault here, and exposes no way to list the valid ` +
          `ones. Check Payments and Financial Reports in App Store Connect, or read it out ` +
          `of a previously downloaded report's filename (S_<freq>_<vendorNumber>_<date>.txt). ` +
          `If the number is definitely right, retry — a genuine 5xx looks identical. ` +
          `Original: ${err.message}`,
        { status: err.status, errors: err.errors },
      );
    }
    throw err;
  }
};

/**
 * Apple reports "this period has no rows" as an HTTP 404, so a quiet month and a
 * broken call are the same shape. Left raw it reads as a failure; reported as
 * data it reads as a zero. Both are wrong often enough to matter, because the
 * *same* 404 covers a third case: a period Apple has not assembled yet.
 *
 * Weekly and monthly reports are built after the dailies, so a week that just
 * ended can 404 while every day inside it has sales — and "no sales" versus "not
 * computed yet" are opposite conclusions about the same response. The caller
 * cannot tell them apart from the status code, so the message names the check
 * that can.
 *
 * That check differs by report, which is why the remedy is a parameter. Sales
 * reports can be re-asked at a finer granularity; finance reports have no
 * granularity at all, so telling their caller to "re-ask at DAILY" names an
 * argument that tool does not have.
 */
type EmptyPeriod = {
  empty: true;
  reason: EmptyReason;
  confidence: Confidence;
  period: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  note: string;
  remedy: string;
};

/**
 * Run a report download, turning Apple's empty-period 404 into a result rather
 * than an error.
 *
 * "The month had no sales" is a successful measurement, and an agent branches on
 * a result while it retries or gives up on an error — which is the understated
 * month arriving by another route. It is also already the house pattern:
 * `getOrNull` turns a 404-means-not-configured into null, `get_vendor_number`
 * reports an unreadable vendor as a success, `get_analytics_status` answers "no
 * data yet" with `instances: 0`. This 404 was the one place it was not applied.
 *
 * The quiet failure mode of that change is a caller who forgets to check
 * `empty` and reads zero rows as a real zero, so the empty result carries no
 * `report`, `lines` or `dataRows` key at all: reaching for rows gets undefined
 * and fails loudly rather than summing an empty string.
 */
const downloadOrEmpty = async (
  fn: () => Promise<string>,
  onEmpty: (err: AppStoreConnectApiError) => Promise<EmptyPeriod>,
): Promise<string | EmptyPeriod> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppStoreConnectApiError && err.status === 404) return onEmpty(err);
    throw err;
  }
};

/** The sentence every empty-period result opens with, whatever settled it. */
const emptyNote = (period: string): string =>
  `Apple returned no rows for ${period}. A 404 is how it reports both a period with no ` +
  `activity and a period it has not assembled yet, so the reason below says which — read it ` +
  `before recording a zero.`;

/** Data rows in a downloaded report, by the same trailing-newline rule as previewReport. */
const dataRowCount = (tsv: string): number => {
  const lines = tsv.split("\n");
  let count = lines.length;
  while (count > 0 && lines[count - 1] === "") count -= 1;
  return Math.max(0, count - 1);
};

/** Raised when Apple rejects the probe's parameters, so no verdict is claimed from it. */
class ProbeUnsupported extends Error {}

/**
 * Ask a finer granularity whether the coarse period really was quiet.
 *
 * Sentinel first — the OLDEST sub-period, the one furthest past the daily lag,
 * so its own 404 is meaningful — then batches of seven, checking between them.
 * That collapses the common lag case to two requests total: one day with rows
 * proves the coarse report should exist and there is nothing left to establish.
 *
 * Calls `client.downloadReport` directly, never through `downloadOrEmpty`. A
 * probe that recursed into probes would be a 31x31 request bomb, and the same
 * coupling is already flagged in probeVendor's tests.
 */
const probeSubPeriods = async (
  client: AppStoreConnectClient,
  params: { vendor: string; reportType: string; reportSubType: string },
  step: { frequency: Frequency; dates: string[] },
  maxProbes: number,
  now: Date,
): Promise<ProbedPeriod[]> => {
  const dates = step.dates.slice(0, maxProbes);
  const probed: ProbedPeriod[] = [];

  const one = async (date: string): Promise<ProbedPeriod> => {
    try {
      const tsv = await client.downloadReport("/v1/salesReports", {
        "filter[frequency]": step.frequency,
        // The caller's report type is passed through unchanged: a SUBSCRIPTION
        // 404 probed with SALES dailies proves nothing about subscriptions.
        "filter[reportType]": params.reportType,
        "filter[reportSubType]": params.reportSubType,
        "filter[vendorNumber]": params.vendor,
        "filter[reportDate]": date,
      });
      return { date, rows: dataRowCount(tsv) };
    } catch (err) {
      if (!(err instanceof AppStoreConnectApiError)) throw err;
      // Apple refuses this reportType/subType at this granularity. Nothing can
      // be concluded, so say so rather than reading a rejection as a zero.
      if (err.status === 400) throw new ProbeUnsupported(err.message);
      if (err.status === 404) {
        // A 404 on a sub-period is only evidence of emptiness once that
        // sub-period is itself past the lag; inside it, it is the same
        // ambiguity one level down.
        const verdict = classifyByCalendar(step.frequency, date, now);
        return { date, rows: verdict === undefined ? 0 : "unknown" };
      }
      // A transient fault must never be counted as an empty day — that is how a
      // 5xx manufactures a zero.
      return { date, rows: "unknown" };
    }
  };

  // Oldest first: its 404 is the one that carries information.
  probed.push(await one(dates[0] as string));
  if (typeof probed[0]?.rows === "number" && probed[0].rows > 0) return probed;

  for (let i = 1; i < dates.length; i += 7) {
    probed.push(...(await Promise.all(dates.slice(i, i + 7).map(one))));
    if (probed.some((p) => typeof p.rows === "number" && p.rows > 0)) break;
  }
  return probed;
};

/**
 * What a 404 on a sales report means, from the calendar alone.
 *
 * Most of the answer costs no request. The dangerous case the old prose asked
 * the caller to check by hand — a week that just ended and 404s while its days
 * have sales — is `WITHIN_GENERATION_LAG`, settled here for free. Only a period
 * that ended well past the lag and still 404s is genuinely ambiguous, and that
 * is rare.
 */
const emptySalesPeriod = async (
  frequency: (typeof FREQUENCIES)[number],
  reportDate: string,
  now: Date,
  probe?: {
    client: AppStoreConnectClient;
    vendor: string;
    reportType: string;
    reportSubType: string;
    maxProbeDays: number;
  },
): Promise<EmptyPeriod> => {
  const span = periodSpan(frequency, reportDate);
  const calendar = classifyByCalendar(frequency, reportDate, now);
  const period = compact({
    frequency,
    reportDate,
    start: span?.start,
    end: span?.end,
    daysInPeriod: span?.days.length,
  });

  if (calendar !== undefined) {
    return {
      empty: true,
      reason: calendar.reason,
      confidence: calendar.confidence,
      period,
      evidence: { endedDaysAgo: calendar.endedDaysAgo, requests: 1 },
      note: emptyNote(`${frequency} ${reportDate}`),
      remedy: CALENDAR_REMEDY[calendar.reason] ?? SALES_EMPTY_REMEDY,
    };
  }

  // Old enough that the calendar cannot settle it — the narrow, genuinely
  // ambiguous residue. This is the only case worth spending requests on.
  const step = probe === undefined ? undefined : stepDown(frequency, reportDate);
  if (probe !== undefined && step !== undefined) {
    try {
      const probed = await probeSubPeriods(probe.client, probe, step, probe.maxProbeDays, now);
      const verdict = classifyProbe(probed, step.dates.length, step.frequency);
      return {
        empty: true,
        reason: verdict.reason,
        confidence: verdict.confidence,
        period,
        evidence: { ...verdict.evidence, requests: 1 + probed.length },
        note: emptyNote(`${frequency} ${reportDate}`),
        remedy: PROBE_REMEDY[verdict.reason] ?? SALES_EMPTY_REMEDY,
      };
    } catch (err) {
      if (!(err instanceof ProbeUnsupported)) throw err;
      return {
        empty: true,
        reason: "UNDETERMINED",
        confidence: "none",
        period,
        evidence: { requests: 2, probeUnsupported: true, probeError: err.message },
        note: emptyNote(`${frequency} ${reportDate}`),
        remedy:
          `Apple rejected a ${step.frequency} probe for reportType ${probe.reportType} / ` +
          `${probe.reportSubType}, so nothing was established about this period. Do NOT record ` +
          `a zero. Check that this reportType/reportSubType pair exists at a finer granularity.`,
      };
    }
  }

  // Probe off, or nothing finer to ask. Say nothing was established rather than
  // guessing — turning the probe off must never silently upgrade a guess into a
  // claim, which is what a NO_ROWS here would be.
  return {
    empty: true,
    reason: "UNDETERMINED",
    confidence: "none",
    period,
    evidence: { requests: 1, ...(probe === undefined ? { probed: false } : {}) },
    note: emptyNote(`${frequency} ${reportDate}`),
    remedy: SALES_EMPTY_REMEDY,
  };
};

/**
 * The same for finance, which can honestly say much less.
 *
 * Never NO_ROWS and never NOT_YET_GENERATED: dating a finance report that does
 * not exist would need Apple's 4-4-5 fiscal calendar modelled, and this file
 * deliberately refuses to do that — `financeCoverage` reads the dates out of the
 * report precisely so it never has to guess. Adding a fiscal calendar solely to
 * date a report that is not there would invent the certainty this change exists
 * to remove.
 */
const emptyFinancePeriod = async (
  reportDate: string,
  regionCode: string,
  probe?: { client: AppStoreConnectClient; vendor: string },
): Promise<EmptyPeriod> => {
  const base = {
    empty: true as const,
    period: {
      requestedFiscalPeriod: reportDate,
      regionCode,
      // Null rather than absent: nobody should read "calendar July was zero" out
      // of "fiscal 2026-07 returned nothing".
      coverage: null,
    },
    note: emptyNote(`fiscal ${reportDate} in region ${regionCode}`),
  };

  // The one thing finance can actually establish. ZZ covers every region, so
  // rows there prove the account was not quiet and this region was — a
  // distinction the prose could only suggest.
  if (probe !== undefined && regionCode.toUpperCase() !== "ZZ") {
    try {
      const tsv = await probe.client.downloadReport("/v1/financeReports", {
        "filter[regionCode]": "ZZ",
        "filter[reportType]": "FINANCIAL",
        "filter[vendorNumber]": probe.vendor,
        "filter[reportDate]": reportDate,
      });
      if (dataRowCount(tsv) > 0) {
        return {
          ...base,
          reason: "REGION_EMPTY",
          confidence: "proven",
          evidence: { probedRegion: "ZZ", rowsInAllRegions: dataRowCount(tsv), requests: 2 },
          remedy:
            `Region ${regionCode} had no activity in fiscal ${reportDate}, but the account did — ` +
            `the all-regions report (ZZ) has rows. Record 0 for this region only, and read ZZ ` +
            `for the account total.`,
        };
      }
    } catch {
      // ZZ failing too tells us nothing extra; fall through to the honest
      // "undetermined" rather than reading one failure as evidence about another.
    }
  }

  return {
    ...base,
    // Never NO_ROWS and never NOT_YET_GENERATED. Separating publication lag from
    // a real zero here would need Apple's 4-4-5 fiscal calendar modelled, and
    // financeCoverage deliberately reads dates out of the report rather than
    // deriving them — inventing that certainty is what this change removes.
    reason: "NO_ROWS_OBSERVED",
    confidence: "bounded",
    evidence: {
      ...(probe !== undefined && regionCode.toUpperCase() !== "ZZ"
        ? { probedRegion: "ZZ", rowsInAllRegions: 0 }
        : {}),
      requests: probe === undefined ? 1 : 2,
    },
    remedy: FINANCE_EMPTY_REMEDY,
  };
};

/**
 * What to do about a reason the calendar settled on its own. Each is specific:
 * a generic "check the dailies" would send the caller probing a period Apple has
 * not finished counting, which cannot answer anything.
 */
const CALENDAR_REMEDY: Partial<Record<EmptyReason, string>> = {
  FUTURE_PERIOD:
    "This period has not started yet, so there is nothing to report and this is not a zero. " +
    "Check the date you asked for.",
  WITHIN_GENERATION_LAG:
    "This period ended too recently for Apple to have assembled it — weekly and monthly reports " +
    "are built after the dailies they roll up. It is reporting lag, NOT a zero, and must not be " +
    "recorded as one. Re-ask in a few days, or read the DAILY reports across the same span now.",
  BEYOND_RETENTION:
    "This period is older than Apple serves sales reports for, so its absence says nothing about " +
    "sales. If you have the figures, they came from a report downloaded at the time.",
};

/** What to say once the probe has actually looked. */
const PROBE_REMEDY: Partial<Record<EmptyReason, string>> = {
  NOT_YET_GENERATED:
    "A finer-grained period inside this one HAS rows, which proves Apple simply has not " +
    "assembled the coarser report yet. This is reporting lag and must NOT be recorded as zero. " +
    "Re-ask in a few days, or sum the finer periods if you need the figure now.",
  NO_ROWS:
    "Every sub-period inside this one was checked and every one was empty, so this is a real " +
    "zero. Record it as 0.",
  NO_ROWS_OBSERVED:
    "Every sub-period that could be checked was empty, but not all of them were reachable — see " +
    "evidence.periodsUnknown and periodsChecked. Treat this as unmeasured rather than as a zero; " +
    "raise maxProbeDays or retry to close the gap.",
};

/** Sales reports roll up from the dailies, so a finer granularity settles it. */
const SALES_EMPTY_REMEDY =
  "Before recording a zero, note that Apple returns this same 404 for a period it has not " +
  "generated yet: weekly and monthly reports are assembled after the dailies, so a recently " +
  "ended week can 404 while the days inside it have sales. Re-ask at DAILY granularity across " +
  "the same span — sales in the dailies mean this is reporting lag and must not be reported as " +
  "zero; empty dailies confirm a real zero.";

/**
 * Finance reports have no finer granularity to fall back on, so the checks are
 * different ones: whether the fiscal month has been published at all, and
 * whether the caller meant this fiscal period in the first place.
 */
const FINANCE_EMPTY_REMEDY =
  "Finance reports have no finer granularity to re-ask at, so check three other things before " +
  "recording a zero. Apple publishes them once the fiscal month closes and settles, several " +
  "weeks in arrears, so a recent period may simply not exist yet. A single region can be empty " +
  "while the account is not — try regionCode ZZ, which covers all regions. And confirm " +
  "reportDate is the fiscal period you meant: Apple's fiscal months are 4-4-5 against a year " +
  "opening in late September, so they do not line up with calendar months.";

/**
 * How far back to date the probe report. Sales reports lag ~24h, so "yesterday"
 * is a coin flip on whether Apple has closed the day yet — and a 404 for a day
 * that does not exist yet is indistinguishable from a 404 for a day with no
 * sales. Five days is comfortably inside both the lag and Apple's daily
 * retention window, so the only thing the probe can still fail on is the vendor
 * number itself, which is the whole point.
 */
const PROBE_DAYS_BACK = 5;

const probeDate = (now: Date): string =>
  new Date(now.getTime() - PROBE_DAYS_BACK * 86_400_000).toISOString().slice(0, 10);

type VendorProbe = { readable: boolean; reportDate: string; detail: string };

/**
 * Ask Apple whether this key can actually read this vendor number, by pulling
 * the cheapest report there is and reading the failure mode rather than the
 * body.
 *
 * The signal is inverted from what you would expect: **404 means the vendor
 * number is good.** Apple only reaches "there were no sales for the date
 * specified" after it has accepted and authorised the vendor, so a 404 proves
 * more than a 200 does — it is the answer for a valid vendor on a quiet day,
 * and a brand-new account with zero sales would never verify otherwise.
 *
 * A wrong vendor number surfaces as a bare 5xx (see `withVendorHint`). 401/403
 * are about the key, not the vendor, and a 400 means these probe parameters are
 * wrong — a bug here, not a user error — so both are rethrown rather than
 * reported as a bad vendor number.
 */
const probeVendor = async (
  client: AppStoreConnectClient,
  vendor: string,
  now: Date,
): Promise<VendorProbe> => {
  const reportDate = probeDate(now);
  try {
    await client.downloadReport("/v1/salesReports", {
      "filter[frequency]": "DAILY",
      "filter[reportType]": "SALES",
      "filter[reportSubType]": "SUMMARY",
      "filter[vendorNumber]": vendor,
      "filter[reportDate]": reportDate,
    });
    return { readable: true, reportDate, detail: "Apple returned a sales report for this vendor." };
  } catch (err) {
    if (!(err instanceof AppStoreConnectApiError)) throw err;
    if (err.status === 404) {
      return {
        readable: true,
        reportDate,
        detail:
          "Apple accepted the vendor number and reported no sales on that date, which only " +
          "happens once the vendor has been resolved and authorised.",
      };
    }
    if (err.status >= 500) {
      return {
        readable: false,
        reportDate,
        detail:
          `Apple returned HTTP ${err.status}. It has no "unknown vendor" code and answers a ` +
          `vendor number this key cannot read with a bare server error, so this almost ` +
          `certainly means ${vendor} is wrong or not visible to this key — but a genuine ` +
          `Apple outage looks identical, so retry before changing the setting.`,
      };
    }
    throw err;
  }
};

const requireVendor = (arg: string | undefined, ctxVendor: string | undefined): string => {
  const vendor = arg ?? ctxVendor;
  if (!vendor) {
    throw new Error(
      "A vendor number is required for reports. Set APP_STORE_CONNECT_VENDOR_NUMBER " +
        "(Payments and Financial Reports in App Store Connect) or pass `vendorNumber`.",
    );
  }
  return vendor;
};

/**
 * The MCP request handle a tool handler is given, narrowed to what progress
 * reporting needs.
 */
type ProgressRequest = {
  mcpReq: {
    _meta?: { progressToken?: string | number };
    notify: (n: { method: string; params: Rec }) => Promise<void>;
  };
};

/**
 * Report progress, when the caller asked for it.
 *
 * The analytics walks are the slowest thing this server does — sequential
 * stages, and Apple registers ~106 reports against a default probe of 20, so one
 * stage is several round trips on its own. Without this the caller sees nothing
 * until the whole chain finishes.
 *
 * Silent when no token was sent: progress is something a client opts into per
 * call, and emitting frames nobody asked for is traffic dropped at the far end.
 */
const progressNotifier =
  (req: ProgressRequest) =>
  async (progress: number, total: number, message: string): Promise<void> => {
    const progressToken = req.mcpReq._meta?.progressToken;
    if (progressToken === undefined) return;
    await req.mcpReq.notify({
      method: "notifications/progress",
      params: { progressToken, progress, total, message },
    });
  };

type AnalyticsWalk = {
  requests: Rec[];
  accessTypes: unknown[];
  /** Reports after the FRAMEWORK_USAGE filter. */
  reports: Rec[];
  probed: Rec[];
  instancePages: { data: Rec[] }[];
  excluded: number;
  /**
   * Which request each report came from, keyed by report id.
   *
   * Taken from the URL that fetched it, not from a relationship: Apple returns
   * `relationships.analyticsReportRequest` on a report as links only, with no
   * `data`, so reading the access type off the resource yields undefined — and
   * an undefined access type silently disables the MONTHLY snapshot preference
   * that exists to avoid a doubled month.
   */
  requestIdOf: Map<string, string>;
};

/**
 * Walk requests -> reports -> instances for one app.
 *
 * Shared by `get_analytics_status`, which asks "is there any data at all", and
 * `get_analytics_report`, which is looking for one particular instance. They
 * differ only in when to stop, which is what `stopWhen` is for — so the walk
 * itself, and its several paginated round trips, exist once.
 */
const walkAnalytics = async (
  client: AppStoreConnectClient,
  appId: string,
  opts: {
    category?: string | undefined;
    includeFrameworkUsage: boolean;
    maxReportsProbed: number;
    instanceQuery?: Record<string, unknown>;
    stopWhen?: (pages: { data: Rec[] }[]) => boolean;
  },
  notify: (progress: number, total: number, message: string) => Promise<void>,
): Promise<AnalyticsWalk> => {
  await notify(0, 2, "Reading analytics report requests");
  const requests = await client.getAll<Rec>(`/v1/apps/${appId}/analyticsReportRequests`, {
    limit: 200,
  });
  const accessTypes = requests.data.map((request) => attributesOf(request).accessType);
  const requestIdOf = new Map<string, string>();
  if (requests.data.length === 0) {
    return {
      requests: requests.data,
      accessTypes,
      reports: [],
      probed: [],
      instancePages: [],
      excluded: 0,
      requestIdOf,
    };
  }

  await notify(1, 2, `Listing reports for ${requests.data.length} requests`);
  const reportPages = await Promise.all(
    requests.data.map((request) =>
      client.getAll<Rec>(
        `/v1/analyticsReportRequests/${request.id}/reports`,
        compact({ "filter[category]": opts.category, limit: 200 }),
      ),
    ),
  );
  reportPages.forEach((page, index) => {
    const requestId = String(requests.data[index]?.id ?? "");
    for (const report of page.data) requestIdOf.set(String(report.id), requestId);
  });
  const allReports = reportPages.flatMap((page) => page.data);

  // Apple returns FRAMEWORK_USAGE for things like AirPlay discovery sessions on
  // apps that never touch them, and it dominates the catalogue by count.
  const isNoise = (report: Rec): boolean => attributesOf(report).category === "FRAMEWORK_USAGE";
  const filtering = opts.category === undefined && !opts.includeFrameworkUsage;
  const excluded = filtering ? allReports.filter(isNoise).length : 0;
  const reports = filtering ? allReports.filter((report) => !isNoise(report)) : allReports;

  /**
   * Probe in batches, and keep going while the answer is still zero.
   *
   * A bounded walk makes every count a floor, and a floor of zero answers
   * nothing — which matters because Apple registers ~106 reports against a
   * default of 20. Once a single instance has been found the cap is harmless:
   * the caller knows data exists and the floor caveat covers the rest.
   */
  const stopWhen = opts.stopWhen ?? ((pages) => pages.some((page) => page.data.length > 0));
  const probed: Rec[] = [];
  const instancePages: { data: Rec[] }[] = [];
  const total = 2 + reports.length;
  while (probed.length < reports.length) {
    const batch = reports.slice(probed.length, probed.length + opts.maxReportsProbed);
    const pages = await Promise.all(
      batch.map((report) =>
        client.getAll<Rec>(
          `/v1/analyticsReports/${report.id}/instances`,
          compact({ ...opts.instanceQuery, limit: 200 }),
        ),
      ),
    );
    probed.push(...batch);
    instancePages.push(...pages);
    await notify(2 + probed.length, total, `Probed ${probed.length} of ${reports.length} reports`);
    if (stopWhen(instancePages)) break;
  }

  return {
    requests: requests.data,
    accessTypes,
    reports,
    probed,
    instancePages,
    excluded,
    requestIdOf,
  };
};

/**
 * The report each category is usually being asked for.
 *
 * A category can hold several reports answering genuinely different questions —
 * COMMERCE carries both "App Store Downloads" and "App Store Purchases" — so the
 * pick is always reported alongside the alternatives rather than made silently.
 * Refusing instead would recreate the four-hop walk for the commonest metric
 * there is.
 */
const PREFERRED_REPORT: Record<string, string> = {
  APP_STORE_ENGAGEMENT: "App Store Discovery and Engagement",
  COMMERCE: "App Store Downloads",
  APP_USAGE: "App Store Installations and Deletions",
};

/** Apple names the richer variant by suffix; Standard is the one without it. */
const isDetailed = (name: string): boolean => /detailed/i.test(name);

/**
 * Analytics segments are comma-delimited while sales reports are tab-delimited,
 * and reading a CSV with a tab splitter yields one column holding everything.
 * Sniffed the same way report_stats.py does, rather than assumed per endpoint.
 */
const sniffDelimiter = (header: string): string =>
  header.split("\t").length >= header.split(",").length ? "\t" : ",";

/**
 * The real date range inside a report, read out of its Date column.
 *
 * The same move `financeCoverage` makes for the fiscal trap. An instance's
 * processingDate is when Apple GENERATED it, not what is inside it — a fresh
 * ONE_TIME_SNAPSHOT reports today while holding a year of history — so the only
 * honest answer to "which period did I actually get" comes from the data.
 */
const csvCoverage = (csv: string): { firstDate: string; lastDate: string; rows: number } | null => {
  const lines = csv.split("\n").filter((line) => line.trim() !== "");
  const header = lines[0];
  if (header === undefined || lines.length < 2) return null;
  const delimiter = sniffDelimiter(header);
  const index = header.split(delimiter).findIndex((col) => col.trim().toLowerCase() === "date");
  if (index === -1) return null;
  const dates = lines
    .slice(1)
    .map((line) => (line.split(delimiter)[index] ?? "").trim())
    .filter((date) => date !== "")
    .toSorted();
  if (dates.length === 0) return null;
  return {
    firstDate: dates[0] as string,
    lastDate: dates[dates.length - 1] as string,
    rows: lines.length - 1,
  };
};

/**
 * Join several segments into one report, dropping the header Apple repeats on
 * each. A leftover header becomes a phantom data row and inflates every count.
 */
const concatSegments = (parts: string[]): string => {
  const [first, ...rest] = parts;
  if (first === undefined) return "";
  // One segment is handed back byte for byte, trailing newline and all. Apple
  // terminates every report with one, and previewReport's row counting is built
  // around that — rewriting the bytes on the single-segment path would make the
  // common case differ from the raw download for no reason.
  if (rest.length === 0) return first;

  const header = first.split("\n")[0];
  const strip = (part: string): string => part.replace(/\n+$/, "");
  const bodies = rest.map((part) => {
    const lines = part.split("\n");
    return strip(lines[0] === header ? lines.slice(1).join("\n") : part);
  });
  return `${[strip(first), ...bodies].filter((part) => part !== "").join("\n")}\n`;
};

export const registerReportTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "app_store_connect_get_vendor_number",
    {
      title: "App Store Connect: Get Vendor Number",
      description:
        "Report the vendor number the sales and finance report tools will use, where it came " +
        "from, and whether this API key can actually read it. Apple exposes no endpoint that " +
        "returns a vendor number, so this cannot discover one — it reads the configured value " +
        "and verifies it. When none is configured it returns the two places to find one rather " +
        "than failing. Start here when a report tool errors, or when you need to know which " +
        "account the report numbers cover.",
      inputSchema: z.object({
        vendorNumber: z
          .string()
          .optional()
          .describe("Check this candidate instead of the configured value. Nothing is saved."),
        verify: z
          .boolean()
          .default(true)
          .describe(
            "Download one throwaway daily report to confirm Apple accepts the number. " +
              "Set false to read the configuration without calling Apple.",
          ),
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ vendorNumber, verify, savePath }) =>
      wrapSaved(savePath, async () => {
        const vendor = vendorNumber ?? ctx.vendorNumber;
        if (!vendor) {
          return {
            vendorNumber: null,
            configured: false,
            hint:
              "No vendor number is configured, so the sales and finance report tools will " +
              "fail. There is no API that returns one: read it from Payments and Financial " +
              "Reports in App Store Connect, or from the middle field of a previously " +
              "downloaded report's filename (S_<frequency>_<vendorNumber>_<date>.txt). Then " +
              "set APP_STORE_CONNECT_VENDOR_NUMBER, or add a `vendorNumber` key to the " +
              "config file. Analytics reports need no vendor number and are unaffected.",
          };
        }

        const source = vendorNumber
          ? "argument"
          : // Only absent when the number came from neither loader, which cannot
            // happen for a configured value — but the type allows it, so say so
            // rather than asserting.
            (ctx.vendorNumberSource ?? "unknown");

        if (!verify) {
          return { vendorNumber: vendor, configured: true, source, verified: false };
        }

        const probe = await probeVendor(client, vendor, new Date());
        return {
          vendorNumber: vendor,
          configured: true,
          source,
          verified: true,
          readable: probe.readable,
          probe: { reportDate: probe.reportDate, detail: probe.detail },
          // Every report this vendor number produces spans the whole account, so
          // a per-app number is always a filter away, never the report total.
          scope: "Account-wide: reports cover every app under this vendor, not one app.",
        };
      }),
  );

  server.registerTool(
    "app_store_connect_download_sales_report",
    {
      title: "App Store Connect: Download Sales Report",
      description:
        "Download a sales & trends report (units, proceeds) as TSV. Reports lag ~24h and are " +
        "keyed by date: DAILY needs YYYY-MM-DD, WEEKLY the week-ending Sunday, MONTHLY YYYY-MM, " +
        "YEARLY YYYY. Requires a vendor number. The report is account-wide — it holds every app " +
        "the vendor ships, keyed by SKU / Title / Apple Identifier. Apple offers no per-app " +
        "filter, so pass appleIdentifier or sku to have this tool apply one after download — " +
        "otherwise every total spans the whole portfolio. In-app purchase rows carry the IAP's " +
        "own Apple Identifier and name the app only in Parent Identifier, as its SKU, so they " +
        "are kept via that column (see includeInAppPurchases) and the filtered rows can hold " +
        "more than one Apple Identifier. Units mix first-time downloads with free updates (see " +
        "Product Type Identifier), and Developer Proceeds / Customer Price are per unit, not " +
        "per row. A period with no rows comes back as a 404.",
      inputSchema: z.object({
        reportDate: z
          .string()
          .min(1)
          .describe("Report date: YYYY-MM-DD (daily/weekly), YYYY-MM (monthly), or YYYY (yearly)."),
        frequency: z.enum(FREQUENCIES).default("MONTHLY"),
        reportType: z.enum(SALES_REPORT_TYPES).default("SALES"),
        reportSubType: z
          .enum(["SUMMARY", "DETAILED", "SUMMARY_INSTALL_TYPE", "SUMMARY_TERRITORY"])
          .default("SUMMARY"),
        vendorNumber: z
          .string()
          .optional()
          .describe("Override APP_STORE_CONNECT_VENDOR_NUMBER for this call."),
        appleIdentifier: z
          .string()
          .optional()
          .describe(
            'Keep only rows whose "Apple Identifier" matches this app id, dropping the rest of ' +
              "the portfolio. Applied before maxLines, so truncation counts this app's rows " +
              "only. This id matches the app's own rows; its in-app purchases are kept through " +
              "Parent Identifier instead — see includeInAppPurchases.",
          ),
        sku: z
          .string()
          .optional()
          .describe(
            'Keep only rows whose "SKU" matches. Combines with appleIdentifier. Also seeds the ' +
              "in-app purchase match, which is worth passing for a period where the app itself " +
              "sold nothing, since the SKU cannot then be read off its own rows.",
          ),
        includeInAppPurchases: z
          .boolean()
          .default(true)
          .describe(
            'Also keep rows whose "Parent Identifier" is this app\'s SKU — its in-app ' +
              "purchases, which carry the IAP's Apple Identifier rather than the app's and are " +
              "therefore invisible to an appleIdentifier filter. Defaults to true: leaving them " +
              "out reports an app with paid IAPs as earning nothing, and the result looks " +
              "entirely well-formed. Set false only to count the app's own units in isolation.",
          ),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe(
            "Truncate the inlined TSV to this many lines. Defaults to 500. Does not affect the " +
              "file written by savePath.",
          ),
        probe: z
          .boolean()
          .default(true)
          .describe(
            "When Apple returns no rows for a period, check a finer granularity before " +
              "answering, so `reason` distinguishes a real zero from a report Apple has not " +
              "assembled yet. Costs nothing on the normal path and nothing when the calendar " +
              "already settles it. Turning it off never produces NO_ROWS — you get UNDETERMINED, " +
              "because an unchecked period is not a zero.",
          ),
        maxProbeDays: z
          .number()
          .int()
          .min(1)
          .max(366)
          .default(31)
          .describe(
            "Cap on sub-periods checked by the probe. Defaults to 31, a full month. Hitting the " +
              "cap yields NO_ROWS_OBSERVED, never NO_ROWS.",
          ),
        savePath: reportSavePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({
      reportDate,
      frequency,
      reportType,
      reportSubType,
      vendorNumber,
      appleIdentifier,
      sku,
      includeInAppPurchases,
      maxLines,
      probe,
      maxProbeDays,
      savePath,
    }) =>
      wrap(async () => {
        const vendor = requireVendor(vendorNumber, ctx.vendorNumber);
        const outcome = await withVendorHint(vendor, () =>
          downloadOrEmpty(
            () =>
              client.downloadReport("/v1/salesReports", {
                "filter[frequency]": frequency,
                "filter[reportType]": reportType,
                "filter[reportSubType]": reportSubType,
                "filter[vendorNumber]": vendor,
                "filter[reportDate]": reportDate,
              }),
            () =>
              emptySalesPeriod(
                frequency,
                reportDate,
                new Date(),
                probe ? { client, vendor, reportType, reportSubType, maxProbeDays } : undefined,
              ),
          ),
        );
        if (typeof outcome !== "string") {
          // No file is written for an empty period. A header-only file would
          // trip report_stats.py's own empty check, relocating the bug rather
          // than answering it.
          return savePath === undefined ? outcome : { ...outcome, saved: null };
        }
        const tsv = outcome;

        if (appleIdentifier === undefined && sku === undefined) {
          return previewAndSave(tsv, maxLines, savePath);
        }

        const filtered = filterSalesReport(tsv, { appleIdentifier, sku, includeInAppPurchases });
        return {
          filter: {
            ...compact({ appleIdentifier, sku }),
            includeInAppPurchases,
            matchedRows: filtered.matchedRows,
            droppedRows: filtered.droppedRows,
            ...(filtered.hasParentColumn
              ? { inAppPurchaseRows: filtered.inAppPurchaseRows, parentSkus: filtered.parentSkus }
              : {}),
            ...compact({ note: salesFilterNote(filtered, sku) }),
          },
          // The saved file is the filtered report, so it is already app-scoped.
          ...(await previewAndSave(filtered.tsv, maxLines, savePath)),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_download_finance_report",
    {
      title: "App Store Connect: Download Finance Report",
      description:
        "Download a financial report (money Apple actually paid, by region) as TSV for one " +
        "fiscal month. This is the authoritative source for proceeds — prefer it over the sales " +
        "report when the question is revenue. Requires a vendor number. " +
        "reportDate is a FISCAL period, not a calendar one: Apple's fiscal year opens in late " +
        "September and its months are 4-4-5 weeks, so 2026-07 means fiscal month 7 of FY2026 — " +
        "roughly late March to early May — not July. Asking for the wrong period is silent, " +
        "because a well-formed report comes back either way, so read the returned `coverage` " +
        "start and end dates before quoting any number from it. A period with no rows, or one " +
        "Apple has not published yet, comes back as a 404.",
      inputSchema: z.object({
        reportDate: z
          .string()
          .min(1)
          .describe(
            "Fiscal period as YYYY-MM. Fiscal, not calendar — FY2026 opens in late September " +
              "2025, so 2026-07 spans roughly late March to early May 2026. Check `coverage` in " +
              "the response to confirm which dates you actually got.",
          ),
        regionCode: z
          .string()
          .min(1)
          .describe('Financial region code, e.g. "ZZ" for all regions, "US", "EU", "JP".'),
        vendorNumber: z
          .string()
          .optional()
          .describe("Override APP_STORE_CONNECT_VENDOR_NUMBER for this call."),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe(
            "Truncate the inlined TSV to this many lines. Defaults to 500. Does not affect the " +
              "file written by savePath.",
          ),
        probe: z
          .boolean()
          .default(true)
          .describe(
            "When this region has no rows, retry once against regionCode ZZ (all regions) so the " +
              "answer can distinguish an empty REGION from an empty account. Costs one request, " +
              "and only on the empty path.",
          ),
        savePath: reportSavePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ reportDate, regionCode, vendorNumber, maxLines, probe, savePath }) =>
      wrap(async () => {
        const vendor = requireVendor(vendorNumber, ctx.vendorNumber);
        const outcome = await withVendorHint(vendor, () =>
          downloadOrEmpty(
            () =>
              client.downloadReport("/v1/financeReports", {
                "filter[regionCode]": regionCode,
                "filter[reportType]": "FINANCIAL",
                "filter[vendorNumber]": vendor,
                "filter[reportDate]": reportDate,
              }),
            () =>
              emptyFinancePeriod(reportDate, regionCode, probe ? { client, vendor } : undefined),
          ),
        );
        if (typeof outcome !== "string") {
          return savePath === undefined ? outcome : { ...outcome, saved: null };
        }
        const tsv = outcome;

        // The dates the report covers are in the report, so the fiscal-vs-calendar
        // question is answered from the data rather than from the caller's memory
        // of Apple's calendar.
        const coverage = financeCoverage(tsv);
        return {
          ...(coverage
            ? { coverage: { ...coverage, requestedFiscalPeriod: reportDate } }
            : {
                coverage: null,
                coverageNote:
                  "This report carries no Start Date / End Date columns, so the fiscal period " +
                  "it covers could not be confirmed from the data. Verify the dates before " +
                  "quoting figures — reportDate is fiscal, not calendar.",
              }),
          ...(await previewAndSave(tsv, maxLines, savePath)),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_list_analytics_report_requests",
    {
      title: "App Store Connect: List Analytics Report Requests",
      description:
        "List an app's existing analytics report requests. Step 1 of reading analytics: a request " +
        "is created once per app and then keeps producing reports, so list first and reuse the id " +
        "rather than creating a second one (Apple rejects a duplicate ONGOING request). Then: " +
        "list_analytics_reports -> list_analytics_report_instances -> " +
        "download_analytics_report_segment.",
      inputSchema: z.object({
        appId: appIdArg,
        accessType: z
          .enum(["ONE_TIME_SNAPSHOT", "ONGOING"])
          .optional()
          .describe("Filter by access type. Omit to list both."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, accessType, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/analyticsReportRequests`,
            compact({ "filter[accessType]": accessType, limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_analytics_reports",
    {
      title: "App Store Connect: List Analytics Reports",
      description:
        "List the reports produced for an analytics report request (step 2). Each report is a " +
        "named dataset — installs and deletions, discovery and engagement, sales, retention — and " +
        "carries no data itself: pass its id to app_store_connect_list_analytics_report_instances " +
        "to reach the dated instances holding the numbers. An empty list means Apple has not " +
        "finished generating them yet (allow a day or two after creating the request).",
      inputSchema: z.object({
        reportRequestId: z
          .string()
          .min(1)
          .describe(
            "The analyticsReportRequest id, from app_store_connect_list_analytics_report_requests.",
          ),
        category: z
          .enum(REPORT_CATEGORIES)
          .optional()
          .describe(
            "Filter by category. APP_STORE_ENGAGEMENT covers impressions, product page views and " +
              "conversion; APP_USAGE covers installs, sessions and retention; COMMERCE covers " +
              "sales and proceeds.",
          ),
        name: z
          .string()
          .optional()
          .describe('Filter by exact report name, e.g. "App Store Installation and Deletion".'),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ reportRequestId, category, name, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(
            `/v1/analyticsReportRequests/${reportRequestId}/reports`,
            compact({ "filter[category]": category, "filter[name]": name, limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_analytics_report_instances",
    {
      title: "App Store Connect: List Analytics Report Instances",
      description:
        "List the instances of an analytics report (step 3) — one per granularity and processing " +
        "date. Pick the instance you want, then pass its id to " +
        "app_store_connect_download_analytics_report_segment to get the actual rows. Filter by " +
        "granularity first: a report usually has one instance per day, so an unfiltered list is " +
        "mostly noise.",
      inputSchema: z.object({
        reportId: z
          .string()
          .min(1)
          .describe("The analyticsReport id, from app_store_connect_list_analytics_reports."),
        granularity: z
          .enum(GRANULARITIES)
          .optional()
          .describe("Filter by granularity. Not every report offers all three."),
        processingDate: z
          .string()
          .optional()
          .describe("Filter to one processing date, as YYYY-MM-DD."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ reportId, granularity, processingDate, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(
            `/v1/analyticsReports/${reportId}/instances`,
            compact({
              "filter[granularity]": granularity,
              "filter[processingDate]": processingDate,
              limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_analytics_report_segments",
    {
      title: "App Store Connect: List Analytics Report Segments",
      description:
        "List the segments of an analytics report instance — the files the data is split across, " +
        "with their compressed size and checksum. Use this to see how large a download will be; " +
        "app_store_connect_download_analytics_report_segment fetches one. The `url` on a segment " +
        "expires within minutes, so re-list rather than reusing an old one.",
      inputSchema: z.object({
        instanceId: z
          .string()
          .min(1)
          .describe(
            "The analyticsReportInstance id, from " +
              "app_store_connect_list_analytics_report_instances.",
          ),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ instanceId, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(
            `/v1/analyticsReportInstances/${instanceId}/segments`,
            compact({ limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_download_analytics_report_segment",
    {
      title: "App Store Connect: Download Analytics Report Segment",
      description:
        "Download the actual analytics data for a report instance (step 4) and return it as text. " +
        "This is the only tool that reaches the numbers — impressions, product page views, " +
        "installs, deletions, sessions, retention, proceeds — depending on which report the " +
        "instance belongs to. Resolves the instance's segments itself, so no expiring url has to " +
        "be passed around. A report split across several segments needs one call per segmentIndex.",
      inputSchema: z.object({
        instanceId: z
          .string()
          .min(1)
          .describe(
            "The analyticsReportInstance id, from " +
              "app_store_connect_list_analytics_report_instances.",
          ),
        segmentIndex: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Which segment to download, when the instance has more than one. 0-based."),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe(
            "Truncate the inlined rows to this many lines. Defaults to 500. Does not affect the " +
              "file written by savePath.",
          ),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .default(DEFAULT_MAX_SEGMENT_BYTES)
          .describe(
            "Refuse a segment whose compressed size exceeds this, before downloading it. " +
              "Defaults to 25 MiB.",
          ),
        savePath: reportSavePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ instanceId, segmentIndex, maxLines, maxBytes, savePath }) =>
      wrap(async () => {
        const response = await client.get(`/v1/analyticsReportInstances/${instanceId}/segments`);
        const segments = resourcesOf(response);
        if (segments.length === 0) {
          throw new PreconditionError(
            "This report instance has no segments. Apple is still generating it, or it holds no " +
              "data for that date — pick another instance.",
            { instanceId },
          );
        }

        const segment = segments[segmentIndex];
        if (!segment) {
          throw new PreconditionError(
            `Segment ${segmentIndex} does not exist — this instance has ${segments.length}.`,
            { instanceId, segments: segments.length },
          );
        }

        const attributes = attributesOf(segment);
        const sizeInBytes = typeof attributes.sizeInBytes === "number" ? attributes.sizeInBytes : 0;
        if (sizeInBytes > maxBytes) {
          throw new PreconditionError(
            `Segment ${segmentIndex} is ${sizeInBytes} bytes compressed, over the ${maxBytes} ` +
              `byte limit. Raise maxBytes to fetch it anyway, or pick a narrower instance ` +
              `(a DAILY granularity covers far less than MONTHLY).`,
            { instanceId, segmentIndex, sizeInBytes, maxBytes },
          );
        }
        if (typeof attributes.url !== "string" || attributes.url === "") {
          throw new PreconditionError(`Segment ${segmentIndex} came back without a download url.`, {
            instanceId,
            segmentIndex,
          });
        }

        const csv = await client.downloadSignedFile(attributes.url);
        return {
          segment: {
            index: segmentIndex,
            of: segments.length,
            ...(typeof attributes.checksum === "string" ? { checksum: attributes.checksum } : {}),
            sizeInBytes,
          },
          ...(await previewAndSave(csv, maxLines, savePath)),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_get_analytics_status",
    {
      title: "App Store Connect: Get Analytics Status",
      description:
        'Answer "is there any analytics data yet" in one call. Walks the whole chain — ' +
        "requests, then reports, then instances — and returns the counts plus the earliest and " +
        "latest instance PROCESSING dates, instead of the four-to-six paginated calls the walk " +
        "normally takes. Use this first whenever the question is whether analytics are " +
        "available at all, especially just after creating a request: instances is the number " +
        "that matters, because reports exist as soon as Apple registers them but hold nothing " +
        "until instances appear a day or two later. " +
        "It does NOT answer how far back the data reaches. earliestInstanceDate is when Apple " +
        "generated the instance, not the oldest date inside it: on an account where snapshots " +
        "had just been created it read 2026-08-25 on every app while the segments held twelve " +
        "months of history, so reading it as the reach makes a full backfill look like it " +
        "recovered nothing. The reach is the Date column inside the segment — download one with " +
        "app_store_connect_download_analytics_report_segment and look. " +
        "FRAMEWORK_USAGE reports are excluded by default — they are the bulk of the catalogue " +
        "and almost never what a product question is about.",
      inputSchema: z.object({
        appId: appIdArg,
        category: z
          .enum(REPORT_CATEGORIES)
          .optional()
          .describe(
            "Restrict to one category. APP_STORE_ENGAGEMENT covers impressions, product page " +
              "views and conversion; APP_USAGE covers installs, sessions and retention; COMMERCE " +
              "covers sales and proceeds.",
          ),
        includeFrameworkUsage: z
          .boolean()
          .default(false)
          .describe("Include FRAMEWORK_USAGE reports, which are excluded by default as noise."),
        maxReportsProbed: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe(
            "How many reports to check for instances before answering. Defaults to 20. The cap " +
              "is ignored while the count is still zero — probing continues until an instance " +
              "is found or every report has been checked — so a zero is never a floor, which " +
              'is what makes this tool answerable for "is there any data yet".',
          ),
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, category, includeFrameworkUsage, maxReportsProbed, savePath }, req) =>
      wrapSaved(savePath, async () => {
        const walk = await walkAnalytics(
          client,
          appId,
          { category, includeFrameworkUsage, maxReportsProbed },
          progressNotifier(req),
        );
        const { requests, accessTypes, reports, probed, instancePages, excluded } = walk;

        if (requests.length === 0) {
          return {
            requests: 0,
            reports: 0,
            instances: 0,
            earliestInstanceDate: null,
            latestInstanceDate: null,
            note:
              "This app has no analytics report requests, so Apple is collecting nothing for it " +
              "and no analytics can be read. Create one with " +
              "app_store_connect_create_analytics_report_request — both access types, since " +
              "ONGOING backfills nothing and only ONE_TIME_SNAPSHOT can reach the past.",
          };
        }

        const byCategory: Record<string, { reports: number; instances: number }> = {};
        for (const report of reports) {
          const name = String(attributesOf(report).category ?? "UNKNOWN");
          byCategory[name] ??= { reports: 0, instances: 0 };
          (byCategory[name] as { reports: number }).reports += 1;
        }
        probed.forEach((report, index) => {
          const name = String(attributesOf(report).category ?? "UNKNOWN");
          byCategory[name] ??= { reports: 0, instances: 0 };
          (byCategory[name] as { instances: number }).instances +=
            instancePages[index]?.data.length ?? 0;
        });

        const dates = instancePages
          .flatMap((page) => page.data)
          .map((instance) => attributesOf(instance).processingDate)
          .filter((date): date is string => typeof date === "string" && date !== "")
          .toSorted();
        const instances = instancePages.reduce((sum, page) => sum + page.data.length, 0);

        const unprobed = reports.length - probed.length;
        return {
          requests: requests.length,
          accessTypes,
          reports: reports.length,
          instances,
          earliestInstanceDate: dates[0] ?? null,
          latestInstanceDate: dates[dates.length - 1] ?? null,
          // The description says this too, but a caller reading a payload is
          // looking at the dates, not at the schema. A field named
          // `earliestInstanceDate` sitting beside an instance count reads as the
          // start of the data unless something in the payload says otherwise.
          ...(dates.length > 0
            ? {
                instanceDatesNote:
                  "earliest/latestInstanceDate are PROCESSING dates — when Apple generated the " +
                  "instances — and say nothing about how far back the data inside them goes. A " +
                  "freshly created ONE_TIME_SNAPSHOT carries ~52 weeks of history and still " +
                  "reports today's date here. For the actual reach, download a segment and read " +
                  "its Date column.",
              }
            : {}),
          byCategory,
          reportsProbed: probed.length,
          ...(excluded > 0 ? { frameworkUsageReportsExcluded: excluded } : {}),
          ...compact({
            // Never let a bounded walk read as a complete one. A zero never gets
            // here — probing does not stop while the count is still zero — so this
            // only ever qualifies a count that is already known to be non-zero.
            truncationNote:
              unprobed > 0 && instances > 0
                ? `${unprobed} of ${reports.length} reports were not probed for instances, so ` +
                  `the instance count is a floor, not a total. Raise maxReportsProbed or pass ` +
                  `a category to narrow it. Data definitely exists either way.`
                : undefined,
            note:
              instances === 0
                ? `None of the ${reports.length} reports hold any instance yet, so there is no ` +
                  `data to read — every one was checked, so this is a real zero and not a ` +
                  `partial walk. Apple generates instances a day or two after a request is ` +
                  `created; this is normal immediately after enabling analytics, and is not an ` +
                  `error.`
                : undefined,
            // The failure mode #6 warns about, detectable here for free.
            historyWarning: !accessTypes.includes("ONE_TIME_SNAPSHOT")
              ? "No ONE_TIME_SNAPSHOT request exists — only ONGOING, which backfills nothing. " +
                "The snapshot window rolls forward, so history before the ONGOING request was " +
                "created is being lost permanently. Create a snapshot request now if any past " +
                "data still matters."
              : undefined,
          }),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_get_analytics_report",
    {
      title: "App Store Connect: Get Analytics Report",
      description:
        "Get the actual analytics numbers for an app in ONE call — impressions, product page " +
        "views, conversion, downloads, installs, deletions, sessions, proceeds — instead of the " +
        "four-step walk (list requests, list reports, list instances, list segments, download). " +
        "Picks the report and instance itself and says which it picked, in `selection`, with the " +
        "alternatives it passed over. Returns `coverage` read from the data's own Date column, " +
        "which is the only honest answer to which period you got: an instance's processingDate " +
        "is when Apple GENERATED it, and a fresh ONE_TIME_SNAPSHOT reports today while holding a " +
        "year of history. Use app_store_connect_get_analytics_status first if the question is " +
        'merely "is there any data yet". This tool does not create a report request — that is a ' +
        "write, and creating the wrong access type loses history permanently.",
      inputSchema: z.object({
        appId: appIdArg,
        category: z
          .enum(REPORT_CATEGORIES)
          .describe(
            "Required — it decides WHICH numbers you get, and defaulting it would silently pick " +
              "a dataset out of ~106. APP_STORE_ENGAGEMENT covers impressions, product page " +
              "views and conversion; COMMERCE covers downloads and proceeds; APP_USAGE covers " +
              "installs, deletions, sessions and retention.",
          ),
        reportName: z
          .string()
          .optional()
          .describe(
            'Exact report name, e.g. "App Store Purchases". Omit to let the category decide; ' +
              "the response always says which was chosen and what else was available.",
          ),
        detailed: z
          .boolean()
          .default(false)
          .describe(
            "Prefer the Detailed variant, which adds Source Info, Page Title and Campaign — " +
              "needed to attribute anything to a specific referrer. Defaults to Standard.",
          ),
        granularity: z.enum(GRANULARITIES).default("DAILY").describe("Instance granularity."),
        processingDate: z
          .string()
          .optional()
          .describe(
            "Pick the instance Apple generated on this date (YYYY-MM-DD). NOT the date of the " +
              "data inside it. Omit for the most recent instance.",
          ),
        accessType: z
          .enum(["ONE_TIME_SNAPSHOT", "ONGOING", "ANY"])
          .optional()
          .describe(
            "Which request to read from. Defaults to ONE_TIME_SNAPSHOT for MONTHLY, the " +
              "documented-safe side: an ONGOING monthly instance has been seen holding every row " +
              "of its month twice.",
          ),
        allSegments: z
          .boolean()
          .default(true)
          .describe(
            "Download every segment and concatenate them. Defaults to true, because the failure " +
              "of taking only the first is a silent undercount.",
          ),
        maxReportsProbed: z.number().int().min(1).max(100).default(20),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe("Truncate the inlined rows. Does not affect the file written by savePath."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .default(DEFAULT_MAX_SEGMENT_BYTES)
          .describe(
            "Refuse the download when the segments' TOTAL compressed size exceeds this, before " +
              "fetching anything. Defaults to 25 MiB.",
          ),
        savePath: reportSavePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async (
      {
        appId,
        category,
        reportName,
        detailed,
        granularity,
        processingDate,
        accessType,
        allSegments,
        maxReportsProbed,
        maxLines,
        maxBytes,
        savePath,
      },
      req,
    ) =>
      wrap(async () => {
        const notify = progressNotifier(req);
        // MONTHLY defaults to the snapshot: an ONGOING monthly instance was seen
        // holding every row of its month twice, reporting 7,764 impressions where
        // the snapshot held 3,882, on three apps at once.
        const wantedAccess =
          accessType ?? (granularity === "MONTHLY" ? "ONE_TIME_SNAPSHOT" : undefined);

        const walk = await walkAnalytics(
          client,
          appId,
          {
            category,
            includeFrameworkUsage: true,
            maxReportsProbed,
            instanceQuery: compact({
              "filter[granularity]": granularity,
              "filter[processingDate]": processingDate,
            }),
            // Unlike the status walk, an instance is only useful if it belongs to
            // a report we would actually pick.
            stopWhen: (pages) => pages.some((page) => page.data.length > 0),
          },
          notify,
        );

        if (walk.requests.length === 0) {
          return {
            empty: true,
            reason: "NO_REPORT_REQUEST",
            writesEnabled: ctx.allowWrites,
            note:
              "This app has no analytics report request, so Apple is collecting nothing for it. " +
              "Create one with app_store_connect_create_analytics_report_request — both access " +
              "types, since ONGOING backfills nothing and only ONE_TIME_SNAPSHOT reaches the " +
              "past. This tool will not create it: that is a write, and creating only ONGOING " +
              "forfeits the app's entire history permanently and invisibly." +
              (ctx.allowWrites ? "" : " Writes are currently disabled on this server."),
          };
        }

        // Which request each report belongs to, so accessType can be honoured.
        const accessOf = new Map(
          walk.requests.map((request) => [
            String(request.id),
            String(attributesOf(request).accessType ?? ""),
          ]),
        );

        const named = walk.probed.filter((report) => {
          const attrs = attributesOf(report);
          if (reportName !== undefined) return attrs.name === reportName;
          return true;
        });
        if (reportName !== undefined && named.length === 0) {
          throw new PreconditionError(
            `No report named "${reportName}" in category ${category} for this app.`,
            {
              reportName,
              available: [
                ...new Set(walk.probed.map((r) => String(attributesOf(r).name ?? ""))),
              ].toSorted(),
            },
          );
        }

        // Standard vs Detailed, then the category's usual answer.
        const variant = named.filter(
          (report) => isDetailed(String(attributesOf(report).name ?? "")) === detailed,
        );
        const pool = variant.length > 0 ? variant : named;
        const preferred = PREFERRED_REPORT[category];
        const byName =
          reportName === undefined && preferred !== undefined
            ? pool.filter((report) => String(attributesOf(report).name ?? "").startsWith(preferred))
            : pool;
        let candidates = byName.length > 0 ? byName : pool;

        const wanted = candidates.filter((report) => {
          if (wantedAccess === undefined || wantedAccess === "ANY") return true;
          const requestId = walk.requestIdOf.get(String(report.id));
          return requestId === undefined || accessOf.get(requestId) === wantedAccess;
        });
        if (wanted.length > 0) candidates = wanted;

        // Only reports that actually have an instance at this granularity.
        const withInstances = candidates.filter((report) => {
          const index = walk.probed.indexOf(report);
          return (walk.instancePages[index]?.data.length ?? 0) > 0;
        });

        if (withInstances.length === 0) {
          return {
            empty: true,
            reason: candidates.length === 0 ? "NO_MATCHING_REPORT" : "NO_INSTANCES_FOR_GRANULARITY",
            granularity,
            reportsConsidered: candidates.map((r) => attributesOf(r).name),
            reportsProbed: walk.probed.length,
            reportsTotal: walk.reports.length,
            note:
              `No ${granularity} instance exists for the report(s) matching this request` +
              (processingDate === undefined ? "" : ` on processingDate ${processingDate}`) +
              ". Not every report offers all three granularities, and Apple generates instances " +
              "a day or two after a request is created. Try another granularity, or " +
              "app_store_connect_get_analytics_status to see what does exist." +
              (walk.probed.length < walk.reports.length
                ? ` Only ${walk.probed.length} of ${walk.reports.length} reports were probed, so ` +
                  `this is a floor — raise maxReportsProbed.`
                : ""),
          };
        }

        const chosen = withInstances[0] as Rec;
        const chosenIndex = walk.probed.indexOf(chosen);
        const chosenAttrs = attributesOf(chosen);
        const chosenRequestId = walk.requestIdOf.get(String(chosen.id));

        // Newest instance unless the caller named a processing date.
        const instances = (walk.instancePages[chosenIndex]?.data ?? []).toSorted((a, b) =>
          String(attributesOf(b).processingDate ?? "").localeCompare(
            String(attributesOf(a).processingDate ?? ""),
          ),
        );
        const instance = instances[0] as Rec;

        await notify(3, 5, "Listing segments");
        const segmentsResponse = await client.get(
          `/v1/analyticsReportInstances/${String(instance.id)}/segments`,
        );
        const segments = resourcesOf(segmentsResponse);
        if (segments.length === 0) {
          return {
            empty: true,
            reason: "INSTANCE_HAS_NO_SEGMENTS",
            instanceId: instance.id,
            note:
              "Apple has registered this instance but not yet written its data, or it holds " +
              "nothing for that date. Try an earlier processingDate.",
          };
        }

        const wantedSegments = allSegments ? segments : segments.slice(0, 1);
        // The TOTAL, not each: a per-segment check waves through ten 20 MiB files.
        const totalBytes = wantedSegments.reduce((sum, segment) => {
          const size = attributesOf(segment).sizeInBytes;
          return sum + (typeof size === "number" ? size : 0);
        }, 0);
        if (totalBytes > maxBytes) {
          throw new PreconditionError(
            `These ${wantedSegments.length} segment(s) are ${totalBytes} bytes compressed in ` +
              `total, over the ${maxBytes} byte limit. Raise maxBytes to fetch them anyway, or ` +
              `pick a narrower instance (a DAILY granularity covers far less than MONTHLY).`,
            { instanceId: instance.id, segments: wantedSegments.length, totalBytes, maxBytes },
          );
        }

        await notify(4, 5, `Downloading ${wantedSegments.length} segment(s)`);
        const parts: string[] = [];
        for (const segment of wantedSegments) {
          const url = attributesOf(segment).url;
          if (typeof url !== "string" || url === "") {
            throw new PreconditionError("A segment came back without a download url.", {
              instanceId: instance.id,
            });
          }
          parts.push(await client.downloadSignedFile(url));
        }
        // Segments repeat the header; a leftover one becomes a phantom data row.
        const csv = concatSegments(parts);
        await notify(5, 5, "Done");

        const alternatives = [
          ...new Set(
            walk.probed
              .filter((report) => report !== chosen)
              .map((report) => String(attributesOf(report).name ?? "")),
          ),
        ].toSorted();

        return {
          selection: {
            reportId: chosen.id,
            reportName: chosenAttrs.name,
            category: chosenAttrs.category,
            accessType: chosenRequestId === undefined ? undefined : accessOf.get(chosenRequestId),
            instanceId: instance.id,
            granularity: attributesOf(instance).granularity,
            processingDate: attributesOf(instance).processingDate,
            chosenFrom: withInstances.length,
            ...(alternatives.length > 0 ? { alternatives } : {}),
          },
          segments: { downloaded: wantedSegments.length, of: segments.length, totalBytes },
          // Read from the data, not from the instance: processingDate is when
          // Apple generated it and says nothing about what is inside.
          coverage: csvCoverage(csv),
          ...(!allSegments && segments.length > 1
            ? {
                segmentsNote:
                  `Only 1 of ${segments.length} segments was downloaded, so every total below is ` +
                  `a floor. Set allSegments to get the whole instance.`,
              }
            : {}),
          ...(walk.probed.length < walk.reports.length
            ? {
                probeNote:
                  `${walk.probed.length} of ${walk.reports.length} reports were probed. The one ` +
                  `chosen is real; other candidates may not have been seen.`,
              }
            : {}),
          ...(await previewAndSave(csv, maxLines, savePath)),
        };
      }),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "app_store_connect_create_analytics_report_request",
    {
      title: "App Store Connect: Create Analytics Report Request",
      description:
        "Request analytics reports for an app — the one-off setup step before any analytics can " +
        "be read. Check app_store_connect_list_analytics_report_requests first: Apple rejects a " +
        "second ONGOING request for the same app, and an existing one is reusable forever. Apple " +
        "then generates reports asynchronously over the following day or two. " +
        "Normally create BOTH access types, because they cover different time and neither " +
        "substitutes for the other. ONE_TIME_SNAPSHOT is the only way to obtain history: it " +
        "covers the last ~52 weeks as of when it is created, and that window rolls forward, so " +
        "history not captured by a snapshot is lost permanently and no later request can recover " +
        "it. ONGOING starts collecting from now and backfills nothing. Creating only ONGOING " +
        "therefore silently forfeits the app's entire past, and the loss is invisible — next " +
        "month looks healthy because it has data, while the year before it no longer exists.",
      inputSchema: z.object({
        appId: appIdArg,
        accessType: z.enum(["ONE_TIME_SNAPSHOT", "ONGOING"]).default("ONGOING"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ appId, accessType }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/analyticsReportRequests", {
            data: {
              type: "analyticsReportRequests",
              attributes: { accessType },
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          }),
        ),
      ),
  );
};
