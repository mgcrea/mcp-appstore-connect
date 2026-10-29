import type { AppStoreConnectClient } from "#/client/asc";
import { attributesOf, compact, type Rec } from "#/client/shape";

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
export const progressNotifier =
  (req: ProgressRequest) =>
  async (progress: number, total: number, message: string): Promise<void> => {
    // oxlint-disable-next-line no-underscore-dangle -- `_meta` is the MCP protocol's own name.
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
 * Apple returns FRAMEWORK_USAGE for things like AirPlay discovery sessions on
 * apps that never touch them, and it dominates the catalogue by count.
 */
const isNoise = (report: Rec): boolean => attributesOf(report).category === "FRAMEWORK_USAGE";

/**
 * Walk requests -> reports -> instances for one app.
 *
 * Shared by `get_analytics_status`, which asks "is there any data at all", and
 * `get_analytics_report`, which is looking for one particular instance. They
 * differ only in when to stop, which is what `stopWhen` is for — so the walk
 * itself, and its several paginated round trips, exist once.
 */
export const walkAnalytics = async (
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
export const PREFERRED_REPORT: Record<string, string> = {
  APP_STORE_ENGAGEMENT: "App Store Discovery and Engagement",
  COMMERCE: "App Store Downloads",
  APP_USAGE: "App Store Installation and Deletion",
};
/** Apple names the richer variant by suffix; Standard is the one without it. */
export const isDetailed = (name: string): boolean => /detailed/i.test(name);
