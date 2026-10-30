import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { attributesOf, type Rec, resourcesOf, summarizeResponse } from "#/client/shape";
import { concatSegments, csvCoverage } from "#/reports/tsv";
import { isDetailed, PREFERRED_REPORT, progressNotifier, walkAnalytics } from "#/reports/walk";
import type { ToolContext } from "#/tools/index";
import { previewAndSave, reportSavePathArg } from "#/tools/reports";
import {
  appIdArg,
  compact,
  limitArg,
  PreconditionError,
  savePathArg,
  wrap,
  wrapSaved,
} from "#/tools/util";

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
/**
 * The analytics side of reporting: request, list and walk report instances,
 * and download their segments. Sales and finance live in `tools/reports.ts`.
 */
export const registerAnalyticsTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  ctx: ToolContext,
): void => {
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
        const preferred = PREFERRED_REPORT[category];
        // The selection's own first choice, before any of its fallbacks: the
        // named report (or the category's usual one) in the asked-for variant,
        // from a request of the wanted access type.
        const wouldPick = (report: Rec, access: unknown): boolean => {
          const name = String(attributesOf(report).name ?? "");
          if (reportName !== undefined) {
            if (name !== reportName) return false;
          } else {
            if (isDetailed(name) !== detailed) return false;
            if (preferred !== undefined && !name.startsWith(preferred)) return false;
          }
          if (wantedAccess === undefined || wantedAccess === "ANY") return true;
          return access === undefined || access === wantedAccess;
        };

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
            // a report we would actually pick: stopping at any instance left a
            // wanted report in a later batch unseen, refused as missing or passed
            // over (with MONTHLY, for the double-counting ONGOING copy).
            stopWhen: (pages, probed, accessTypeOf) =>
              pages.some((page, index) => {
                const report = probed[index];
                return (
                  page.data.length > 0 &&
                  report !== undefined &&
                  wouldPick(report, accessTypeOf(report))
                );
              }),
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
        const byName =
          reportName === undefined && preferred !== undefined
            ? pool.filter((report) => String(attributesOf(report).name ?? "").startsWith(preferred))
            : pool;
        let candidates = byName.length > 0 ? byName : pool;
        const beforeAccess = candidates;

        const wanted = candidates.filter((report) => {
          if (wantedAccess === undefined || wantedAccess === "ANY") return true;
          const requestId = walk.requestIdOf.get(String(report.id));
          return requestId === undefined || accessOf.get(requestId) === wantedAccess;
        });
        if (wanted.length > 0) candidates = wanted;

        // Only reports that actually have an instance at this granularity.
        const hasInstance = (report: Rec): boolean =>
          (walk.instancePages[walk.probed.indexOf(report)]?.data.length ?? 0) > 0;
        const withInstances = candidates.filter(hasInstance);

        if (withInstances.length === 0) {
          // The defaulted snapshot preference can hide data that does exist on
          // the other access type. Falling back silently would bring back the
          // double-counted ONGOING month the default avoids, so say so instead.
          const elsewhere =
            accessType === undefined && wantedAccess !== undefined
              ? beforeAccess.filter((report) => !candidates.includes(report) && hasInstance(report))
              : [];
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
            ...(elsewhere.length > 0
              ? {
                  otherAccessType: {
                    reports: elsewhere.map((r) => attributesOf(r).name),
                    note:
                      `A ${granularity} instance does exist on a request other than ` +
                      `${wantedAccess}, which ${granularity} defaults to. It was not used: ONGOING ` +
                      `monthly instances have been seen holding every row of their month twice. ` +
                      `Pass accessType "ONGOING" to read it anyway, and check duplicateRows ` +
                      `before quoting a total.`,
                  },
                }
              : {}),
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
