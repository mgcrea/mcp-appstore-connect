import type { AppStoreConnectClient } from "#/client/asc";
import { AppStoreConnectApiError } from "#/client/errors";
import { compact } from "#/client/shape";
import {
  classifyByCalendar,
  classifyProbe,
  type Confidence,
  type EmptyReason,
  FREQUENCIES,
  type Frequency,
  periodSpan,
  type ProbedPeriod,
  stepDown,
} from "#/reports/period";
import { contentLineCount } from "#/reports/tsv";

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
export const downloadOrEmpty = async (
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
const dataRowCount = (tsv: string): number => Math.max(0, contentLineCount(tsv.split("\n")) - 1);

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
export const emptySalesPeriod = async (
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
export const emptyFinancePeriod = async (
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
  const probing = probe !== undefined && regionCode.toUpperCase() !== "ZZ";
  // Set when ZZ failed for any reason but its own 404, which then measured nothing.
  let probeError: string | undefined;
  if (probing) {
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
    } catch (err) {
      // ZZ failing too tells us nothing extra; fall through to the honest
      // "undetermined" rather than reading one failure as evidence about another.
      // A 404 is ZZ's own "no rows", so only that one still counts as a zero.
      if (!(err instanceof AppStoreConnectApiError && err.status === 404)) {
        probeError = err instanceof Error ? err.message : String(err);
      }
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
      ...(probing
        ? probeError === undefined
          ? { probedRegion: "ZZ", rowsInAllRegions: 0 }
          : { probedRegion: "ZZ", probeError }
        : {}),
      requests: probing ? 2 : 1,
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
