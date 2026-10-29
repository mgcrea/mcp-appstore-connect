import { gzipSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
  analyticsInstance,
  analyticsReport,
  analyticsRequest,
  baseConfig,
  callArgs,
  connect,
  jsonResponse,
  payloadOf,
  segmentsBody,
  textOf,
  toolNames,
} from "../helpers.js";

describe("get_analytics_status", () => {
  const APP_ID = "1234567890";

  /** Routes the three hops of the walk by pathname, as Apple lays them out. */
  const walk = (opts: {
    requests: unknown[];
    reports?: unknown[];
    instances?: Record<string, unknown[]>;
  }): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      const { pathname } = new URL(String(url));
      if (pathname.endsWith("/analyticsReportRequests")) {
        return jsonResponse({ data: opts.requests });
      }
      if (pathname.endsWith("/reports")) return jsonResponse({ data: opts.reports ?? [] });
      const match = /\/v1\/analyticsReports\/([^/]+)\/instances$/.exec(pathname);
      if (match) return jsonResponse({ data: opts.instances?.[match[1] as string] ?? [] });
      return jsonResponse({ data: [] });
    });

  const status = async (
    fetchImpl: ReturnType<typeof vi.fn>,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_get_analytics_status",
      arguments: { appId: APP_ID, ...args },
    });
    expect(result.isError).toBeFalsy();
    return JSON.parse(textOf(result)) as Record<string, unknown>;
  };

  it("answers the whole walk — requests, reports, instances, earliest date — in one call", async () => {
    const body = await status(
      walk({
        requests: [
          analyticsRequest("req-1", "ONGOING"),
          analyticsRequest("req-2", "ONE_TIME_SNAPSHOT"),
        ],
        reports: [
          analyticsReport("rep-1", "APP_STORE_ENGAGEMENT"),
          analyticsReport("rep-2", "APP_USAGE"),
        ],
        instances: {
          "rep-1": [
            analyticsInstance("ins-1", "2026-06-02"),
            analyticsInstance("ins-2", "2026-06-01"),
          ],
          "rep-2": [analyticsInstance("ins-3", "2026-07-15")],
        },
      }),
    );

    // Two requests, each listing the same two reports: the counts are totals
    // across the whole walk, not one request's slice.
    expect(body.requests).toBe(2);
    expect(body.reports).toBe(4);
    expect(body.instances).toBe(6);
    expect(body.earliestInstanceDate).toBe("2026-06-01");
    expect(body.latestInstanceDate).toBe("2026-07-15");
    expect(body.accessTypes).toEqual(["ONGOING", "ONE_TIME_SNAPSHOT"]);
    expect(body.byCategory).toMatchObject({
      APP_STORE_ENGAGEMENT: { reports: 2, instances: 4 },
      APP_USAGE: { reports: 2, instances: 2 },
    });
  });

  /**
   * FRAMEWORK_USAGE dominates the catalogue by count — AirPlay discovery sessions
   * on an app that has never touched AirPlay — and is almost never what a product
   * question is about. Dropping it silently would be its own problem, so the
   * count that was removed is reported.
   */
  it("excludes FRAMEWORK_USAGE by default and says how much it removed", async () => {
    const fetchImpl = walk({
      requests: [analyticsRequest("req-1", "ONGOING")],
      reports: [
        analyticsReport("rep-1", "APP_STORE_ENGAGEMENT"),
        analyticsReport("rep-2", "FRAMEWORK_USAGE"),
        analyticsReport("rep-3", "FRAMEWORK_USAGE"),
      ],
      instances: { "rep-1": [analyticsInstance("ins-1", "2026-06-01")] },
    });

    const body = await status(fetchImpl);
    expect(body.reports).toBe(1);
    expect(body.frameworkUsageReportsExcluded).toBe(2);

    const kept = await status(
      walk({
        requests: [analyticsRequest("req-1", "ONGOING")],
        reports: [
          analyticsReport("rep-1", "APP_STORE_ENGAGEMENT"),
          analyticsReport("rep-2", "FRAMEWORK_USAGE"),
        ],
      }),
      { includeFrameworkUsage: true },
    );
    expect(kept.reports).toBe(2);
    expect(kept.frameworkUsageReportsExcluded).toBeUndefined();
  });

  /**
   * "Reports exist" and "there is data" are different answers, and the gap between
   * them is the normal state for a day or two after enabling analytics. Reporting
   * it as an error would send someone debugging credentials that are fine.
   */
  it("separates reports existing from instances holding anything", async () => {
    const body = await status(
      walk({
        requests: [
          analyticsRequest("req-1", "ONGOING"),
          analyticsRequest("req-2", "ONE_TIME_SNAPSHOT"),
        ],
        reports: [analyticsReport("rep-1", "APP_USAGE")],
        instances: {},
      }),
    );

    expect(body.reports).toBe(2);
    expect(body.instances).toBe(0);
    expect(body.earliestInstanceDate).toBeNull();
    expect(String(body.note)).toContain("a day or two");
  });

  it("reports no request at all as the actionable state it is", async () => {
    const fetchImpl = walk({ requests: [] });
    const body = await status(fetchImpl);

    expect(body).toMatchObject({ requests: 0, reports: 0, instances: 0 });
    expect(body.earliestInstanceDate).toBeNull();
    expect(String(body.note)).toContain("create_analytics_report_request");
    // Nothing further to walk, so nothing further is fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /**
   * The loss #6 warns about, caught for free: ONGOING backfills nothing and the
   * snapshot window rolls forward, so an account with only ONGOING is shedding
   * history invisibly — next month looks healthy because it has data.
   */
  it("warns when only ONGOING exists, because the past is being lost", async () => {
    const withOngoingOnly = await status(
      walk({
        requests: [analyticsRequest("req-1", "ONGOING")],
        reports: [analyticsReport("rep-1", "APP_USAGE")],
        instances: { "rep-1": [analyticsInstance("ins-1", "2026-06-01")] },
      }),
    );
    expect(String(withOngoingOnly.historyWarning)).toContain("backfills nothing");

    const withSnapshot = await status(
      walk({
        requests: [
          analyticsRequest("req-1", "ONGOING"),
          analyticsRequest("req-2", "ONE_TIME_SNAPSHOT"),
        ],
        reports: [analyticsReport("rep-1", "APP_USAGE")],
        instances: { "rep-1": [analyticsInstance("ins-1", "2026-06-01")] },
      }),
    );
    expect(withSnapshot.historyWarning).toBeUndefined();
  });

  /**
   * A bounded walk that reads as a complete one is the failure mode this tool
   * exists to remove, so the cap has to be visible in the payload — an instance
   * count that is a floor must say it is a floor.
   */
  it("never lets a capped probe read as a total", async () => {
    const body = await status(
      walk({
        requests: [analyticsRequest("req-1", "ONE_TIME_SNAPSHOT")],
        reports: [analyticsReport("rep-1", "APP_USAGE"), analyticsReport("rep-2", "COMMERCE")],
        instances: {
          "rep-1": [analyticsInstance("ins-1", "2026-06-01")],
          "rep-2": [analyticsInstance("ins-2", "2026-06-02")],
        },
      }),
      { maxReportsProbed: 1 },
    );

    expect(body.reports).toBe(2);
    expect(body.reportsProbed).toBe(1);
    expect(String(body.truncationNote)).toContain("floor, not a total");
  });

  /**
   * A floor of zero answers nothing, and "is there any data yet" is the question
   * this tool exists for. Apple registers ~106 reports against a default cap of
   * 20, so a bounded walk reports zero on an app whose data sits at report 25 —
   * indistinguishable from an app that genuinely has none. Probing therefore
   * continues while the count is still zero; once anything is found the cap
   * applies again, because the floor caveat is harmless when data exists.
   */
  it("keeps probing while the answer is still zero, so a zero is never a floor", async () => {
    const many = Array.from({ length: 30 }, (_v, i) => analyticsReport(`rep-${i}`, "APP_USAGE"));

    const found = await status(
      walk({
        requests: [analyticsRequest("req-1", "ONE_TIME_SNAPSHOT")],
        reports: many,
        instances: { "rep-12": [analyticsInstance("ins-1", "2026-08-13")] },
      }),
      { maxReportsProbed: 5 },
    );
    expect(found.instances).toBe(1);
    expect(found.earliestInstanceDate).toBe("2026-08-13");
    // Report 12 lands in the third batch of five, and the walk stops there rather
    // than continuing through all 30 — the cap still bounds a non-zero answer.
    expect(found.reportsProbed).toBe(15);
    expect(String(found.truncationNote)).toContain("floor, not a total");

    const empty = await status(
      walk({
        requests: [analyticsRequest("req-1", "ONE_TIME_SNAPSHOT")],
        reports: many,
        instances: {},
      }),
      { maxReportsProbed: 5 },
    );
    expect(empty.instances).toBe(0);
    expect(empty.reportsProbed).toBe(30);
    // Nothing may qualify a zero as partial, because it is not.
    expect(empty.truncationNote).toBeUndefined();
    expect(String(empty.note)).toContain("every one was checked");
  });

  it("passes a category filter through to Apple rather than filtering locally", async () => {
    const fetchImpl = walk({
      requests: [analyticsRequest("req-1", "ONGOING")],
      reports: [analyticsReport("rep-1", "COMMERCE")],
    });
    await status(fetchImpl, { category: "COMMERCE" });

    const reportsCall = fetchImpl.mock.calls
      .map((call) => new URL(String(call[0])))
      .find((url) => url.pathname.endsWith("/reports"));
    expect(reportsCall?.searchParams.get("filter[category]")).toBe("COMMERCE");
  });
});

describe("analytics reports", () => {
  const APP_ID = "1234567890";
  const REQUEST_ID = "req-0000-4000-8000-000000000001";
  const REPORT_ID = "rep-0000-4000-8000-000000000002";
  const INSTANCE_ID = "ins-0000-4000-8000-000000000003";
  const SEGMENT_URL = "https://api-reports.itunes.apple.com/segments/abc?token=xyz";

  const CSV = "Date\tTerritory\tInstallations\n2026-06-01\tUS\t1204\n2026-06-01\tFR\t311\n";

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    return client.callTool({ name, arguments: args });
  };

  it("lists an app's existing report requests so a duplicate is not created", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    await callTool(
      "app_store_connect_list_analytics_report_requests",
      { appId: APP_ID, accessType: "ONGOING" },
      fetchImpl,
    );

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/apps/${APP_ID}/analyticsReportRequests`);
    expect(url.searchParams.get("filter[accessType]")).toBe("ONGOING");
  });

  it("lists reports for a request with the category filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    await callTool(
      "app_store_connect_list_analytics_reports",
      { reportRequestId: REQUEST_ID, category: "APP_STORE_ENGAGEMENT" },
      fetchImpl,
    );

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/analyticsReportRequests/${REQUEST_ID}/reports`);
    expect(url.searchParams.get("filter[category]")).toBe("APP_STORE_ENGAGEMENT");
  });

  it("lists instances for a report with the granularity filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    await callTool(
      "app_store_connect_list_analytics_report_instances",
      { reportId: REPORT_ID, granularity: "DAILY" },
      fetchImpl,
    );

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/analyticsReports/${REPORT_ID}/instances`);
    expect(url.searchParams.get("filter[granularity]")).toBe("DAILY");
  });

  it("lists segments for an instance", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    await callTool(
      "app_store_connect_list_analytics_report_segments",
      { instanceId: INSTANCE_ID },
      fetchImpl,
    );

    expect(new URL(callArgs(fetchImpl)[0]).pathname).toBe(
      `/v1/analyticsReportInstances/${INSTANCE_ID}/segments`,
    );
  });

  /**
   * The point of the whole chain: the segment's `url` is the only place the
   * numbers live, and it is a short-lived signed URL off the API host, so the
   * tool resolves it itself rather than making the caller carry it between calls.
   */
  it("resolves the segment and returns the decompressed rows", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).startsWith("https://api-reports.")
        ? new Response(gzipSync(Buffer.from(CSV)), { status: 200 })
        : jsonResponse(segmentsBody({ url: SEGMENT_URL, sizeInBytes: 512, checksum: "deadbeef" })),
    );

    const result = await callTool(
      "app_store_connect_download_analytics_report_segment",
      { instanceId: INSTANCE_ID },
      fetchImpl as ReturnType<typeof vi.fn>,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result));
    expect(body.segment).toEqual({ index: 0, of: 1, checksum: "deadbeef", sizeInBytes: 512 });
    expect(body.report).toBe(CSV);
    expect(body.inlineTruncated).toBe(false);
    expect(callArgs(fetchImpl as ReturnType<typeof vi.fn>, 1)[0]).toBe(SEGMENT_URL);
  });

  it("truncates a long segment to maxLines", async () => {
    const long = `${Array.from({ length: 40 }, (_, i) => `2026-06-01\tUS\t${i}`).join("\n")}\n`;
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).startsWith("https://api-reports.")
        ? new Response(gzipSync(Buffer.from(long)), { status: 200 })
        : jsonResponse(segmentsBody({ url: SEGMENT_URL, sizeInBytes: 512 })),
    );

    const result = await callTool(
      "app_store_connect_download_analytics_report_segment",
      { instanceId: INSTANCE_ID, maxLines: 5 },
      fetchImpl as ReturnType<typeof vi.fn>,
    );

    const body = JSON.parse(textOf(result));
    expect(body.inlineTruncated).toBe(true);
    expect(body.report.split("\n")).toHaveLength(5);
  });

  /**
   * Apple terminates every report with a newline, so splitting on it leaves a
   * phantom empty line. Counting that line used to flag a complete report as
   * truncated the moment its real content reached `maxLines` exactly. Nothing
   * downstream shrugs that off: report_stats.py treats truncation as a hard
   * error so a floor is never quoted as a total, so the false flag refused a
   * file that had lost nothing.
   */
  it("does not call a complete report truncated because of its trailing newline", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).startsWith("https://api-reports.")
        ? new Response(gzipSync(Buffer.from(CSV)), { status: 200 })
        : jsonResponse(segmentsBody({ url: SEGMENT_URL, sizeInBytes: 512 })),
    );

    // CSV is a header plus two data rows — exactly maxLines of real content.
    const result = await callTool(
      "app_store_connect_download_analytics_report_segment",
      { instanceId: INSTANCE_ID, maxLines: 3 },
      fetchImpl as ReturnType<typeof vi.fn>,
    );

    const body = JSON.parse(textOf(result));
    expect(body.inlineTruncated).toBe(false);
    expect(body.lines).toBe(3); // content lines, not the phantom blank
    expect(body.dataRows).toBe(2); // the same count without the header
    expect(body.report).toBe(CSV);
  });

  it("refuses an oversized segment before downloading it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(segmentsBody({ url: SEGMENT_URL, sizeInBytes: 900_000_000 })),
    );

    const result = await callTool(
      "app_store_connect_download_analytics_report_segment",
      { instanceId: INSTANCE_ID },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Raise maxBytes");
    // Only the segments listing went out — the blob was never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("says an instance has no data rather than returning an empty report", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    const result = await callTool(
      "app_store_connect_download_analytics_report_segment",
      { instanceId: INSTANCE_ID },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no segments");
  });

  it("reports how many segments exist when the index is out of range", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(segmentsBody({ url: SEGMENT_URL, sizeInBytes: 512 })),
    );

    const result = await callTool(
      "app_store_connect_download_analytics_report_segment",
      { instanceId: INSTANCE_ID, segmentIndex: 3 },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("this instance has 1");
  });
});

/**
 * The four-hop walk — create request, list reports, list instances, list
 * segments, download — done once, per app per metric. This collapses it, and
 * the risk of collapsing it is that the picks become invisible: which of ~106
 * reports, which access type, which instance. Every one of those is reported.
 */
describe("get_analytics_report", () => {
  const REQ = "req-1";
  const SEGMENT_URL = "https://api-reports.apple.com/seg-1";
  const CSV = "Date,Impressions\n2026-06-01,120\n2026-06-02,140\n";

  const report = (id: string, name: string, category: string, requestId = REQ): unknown => ({
    type: "analyticsReports",
    id,
    attributes: { name, category },
    relationships: {
      analyticsReportRequest: { data: { type: "analyticsReportRequests", id: requestId } },
    },
  });

  const instance = (id: string, granularity = "DAILY", processingDate = "2026-06-03"): unknown => ({
    type: "analyticsReportInstances",
    id,
    attributes: { granularity, processingDate },
  });

  /**
   * The five hops, routed by URL.
   *
   * `reports` is keyed by REQUEST id, not flat, because that is how Apple serves
   * it — /v1/analyticsReportRequests/{id}/reports — and a mock that returns the
   * same reports for every request hides which one a report belongs to. That is
   * exactly the fact the access-type preference depends on.
   */
  const walk = (opts: {
    requests?: unknown[];
    reports?: unknown[] | Record<string, unknown[]>;
    instances?: Record<string, unknown[]>;
    segments?: unknown[];
    csv?: string;
  }): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith(SEGMENT_URL)) {
        return new Response(gzipSync(Buffer.from(opts.csv ?? CSV)), { status: 200 });
      }
      if (u.includes("/analyticsReportRequests") && u.includes("/v1/apps/")) {
        return jsonResponse({
          data: opts.requests ?? [
            {
              type: "analyticsReportRequests",
              id: REQ,
              attributes: { accessType: "ONE_TIME_SNAPSHOT" },
            },
          ],
        });
      }
      if (u.includes("/reports")) {
        const requestId = /analyticsReportRequests\/([^/?]+)/.exec(u)?.[1] ?? "";
        const reports = Array.isArray(opts.reports)
          ? opts.reports
          : (opts.reports?.[requestId] ?? []);
        return jsonResponse({ data: reports });
      }
      if (u.includes("/instances")) {
        const id = /analyticsReports\/([^/?]+)/.exec(u)?.[1] ?? "";
        return jsonResponse({ data: opts.instances?.[id] ?? [] });
      }
      if (u.includes("/segments")) {
        return jsonResponse({
          data: opts.segments ?? [
            {
              type: "analyticsReportSegments",
              id: "seg-1",
              attributes: { url: SEGMENT_URL, sizeInBytes: 512, checksum: "abc" },
            },
          ],
        });
      }
      throw new Error(`unrouted: ${u}`);
    });

  const call = async (
    fetchImpl: ReturnType<typeof vi.fn>,
    args: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> => {
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    return client.callTool({
      name: "app_store_connect_get_analytics_report",
      arguments: { appId: "1", category: "APP_STORE_ENGAGEMENT", ...args },
    });
  };

  it("reaches the numbers in five calls and says what it picked", async () => {
    const fetchImpl = walk({
      reports: [report("r1", "App Store Discovery and Engagement", "APP_STORE_ENGAGEMENT")],
      instances: { r1: [instance("i1")] },
    });

    const body = payloadOf(await call(fetchImpl, {})) as {
      selection: Record<string, unknown>;
      coverage: Record<string, unknown>;
      report: string;
    };

    // requests -> reports -> instances -> segments -> the signed download.
    expect(fetchImpl.mock.calls).toHaveLength(5);
    expect(body.selection).toMatchObject({
      reportId: "r1",
      reportName: "App Store Discovery and Engagement",
      accessType: "ONE_TIME_SNAPSHOT",
      instanceId: "i1",
    });
    expect(body.report).toBe(CSV);
  });

  /**
   * MONTHLY defaults to the snapshot because ONGOING months double-count. When
   * only ONGOING has the month, an empty answer that does not say so reads as
   * "no data" — but falling back silently would reintroduce the double count.
   */
  it("points at an ONGOING instance the defaulted snapshot preference skipped", async () => {
    const name = "App Store Discovery and Engagement Standard";
    const fetchImpl = (): ReturnType<typeof vi.fn> =>
      walk({
        requests: [
          {
            type: "analyticsReportRequests",
            id: "req-s",
            attributes: { accessType: "ONE_TIME_SNAPSHOT" },
          },
          { type: "analyticsReportRequests", id: "req-o", attributes: { accessType: "ONGOING" } },
        ],
        reports: {
          "req-s": [report("rs", name, "APP_STORE_ENGAGEMENT", "req-s")],
          "req-o": [report("ro", name, "APP_STORE_ENGAGEMENT", "req-o")],
        },
        instances: { ro: [instance("io", "MONTHLY")] },
      });

    const defaulted = payloadOf(await call(fetchImpl(), { granularity: "MONTHLY" }));
    expect(defaulted).toMatchObject({ empty: true, reason: "NO_INSTANCES_FOR_GRANULARITY" });
    expect(defaulted.otherAccessType).toMatchObject({ reports: [name] });
    expect(String((defaulted.otherAccessType as Record<string, unknown>).note)).toContain(
      'accessType "ONGOING"',
    );

    // Asked for explicitly, the snapshot is the answer and nothing more is said.
    const explicit = payloadOf(
      await call(fetchImpl(), { granularity: "MONTHLY", accessType: "ONE_TIME_SNAPSHOT" }),
    );
    expect(explicit.empty).toBe(true);
    expect(explicit.otherAccessType).toBeUndefined();
  });

  it("filters by category and granularity at Apple, not locally", async () => {
    const fetchImpl = walk({
      reports: [report("r1", "App Store Downloads", "COMMERCE")],
      instances: { r1: [instance("i1", "WEEKLY")] },
    });
    await call(fetchImpl, { category: "COMMERCE", granularity: "WEEKLY" });

    const reportsUrl = new URL(
      fetchImpl.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/reports")) ?? "",
    );
    expect(reportsUrl.searchParams.get("filter[category]")).toBe("COMMERCE");
    const instancesUrl = new URL(
      fetchImpl.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/instances")) ?? "",
    );
    expect(instancesUrl.searchParams.get("filter[granularity]")).toBe("WEEKLY");
  });

  it("prefers Standard over Detailed, and flips on request", async () => {
    const reports = [
      report("r1", "App Store Discovery and Engagement Detailed", "APP_STORE_ENGAGEMENT"),
      report("r2", "App Store Discovery and Engagement Standard", "APP_STORE_ENGAGEMENT"),
    ];
    const instances = { r1: [instance("i1")], r2: [instance("i2")] };

    const standard = payloadOf(await call(walk({ reports, instances }), {})) as {
      selection: { reportId: string; alternatives: string[] };
    };
    expect(standard.selection.reportId).toBe("r2");
    // The pick is never silent — what it passed over is named.
    expect(standard.selection.alternatives).toContain(
      "App Store Discovery and Engagement Detailed",
    );

    const detailed = payloadOf(await call(walk({ reports, instances }), { detailed: true })) as {
      selection: { reportId: string };
    };
    expect(detailed.selection.reportId).toBe("r1");
  });

  /**
   * COMMERCE holds both Downloads and Purchases, which answer different
   * questions. It picks, but never silently.
   */
  it("names the alternatives when a category holds several reports", async () => {
    const fetchImpl = walk({
      reports: [
        report("r1", "App Store Purchases", "COMMERCE"),
        report("r2", "App Store Downloads", "COMMERCE"),
      ],
      instances: { r1: [instance("i1")], r2: [instance("i2")] },
    });

    const body = payloadOf(await call(fetchImpl, { category: "COMMERCE" })) as {
      selection: { reportName: string; alternatives: string[] };
    };

    expect(body.selection.reportName).toBe("App Store Downloads");
    expect(body.selection.alternatives).toContain("App Store Purchases");
  });

  // Apple's own spelling, singular, and listed after "Shortcut App Usage" — the
  // order the live APP_USAGE list comes back in.
  it("picks installs and deletions for APP_USAGE", async () => {
    const fetchImpl = walk({
      reports: [
        report("r1", "Shortcut App Usage", "APP_USAGE"),
        report("r2", "App Store Installation and Deletion Standard", "APP_USAGE"),
      ],
      instances: { r1: [instance("i1")], r2: [instance("i2")] },
    });

    const body = payloadOf(await call(fetchImpl, { category: "APP_USAGE" })) as {
      selection: { reportName: string };
    };

    expect(body.selection.reportName).toBe("App Store Installation and Deletion Standard");
  });

  it("refuses a reportName that does not exist rather than guessing", async () => {
    const fetchImpl = walk({
      reports: [report("r1", "App Store Discovery and Engagement", "APP_STORE_ENGAGEMENT")],
      instances: { r1: [instance("i1")] },
    });

    const result = await call(fetchImpl, { reportName: "App Store Nonsense" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("App Store Discovery and Engagement");
    // Nothing was downloaded on the way to refusing.
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).startsWith(SEGMENT_URL))).toBe(false);
  });

  /**
   * The doubled-month hazard: an ONGOING monthly instance was seen holding every
   * row of its month twice. MONTHLY defaults to the snapshot for that reason.
   */
  it("defaults MONTHLY to the snapshot request", async () => {
    const fetchImpl = walk({
      requests: [
        { type: "analyticsReportRequests", id: "ongoing", attributes: { accessType: "ONGOING" } },
        {
          type: "analyticsReportRequests",
          id: "snap",
          attributes: { accessType: "ONE_TIME_SNAPSHOT" },
        },
      ],
      // Each request serves its own copy of the same report name — which is what
      // the account really looks like, and why the pick has to be per request.
      reports: {
        ongoing: [
          report("r1", "App Store Discovery and Engagement", "APP_STORE_ENGAGEMENT", "ongoing"),
        ],
        snap: [report("r2", "App Store Discovery and Engagement", "APP_STORE_ENGAGEMENT", "snap")],
      },
      instances: { r1: [instance("i1", "MONTHLY")], r2: [instance("i2", "MONTHLY")] },
    });

    const body = payloadOf(await call(fetchImpl, { granularity: "MONTHLY" })) as {
      selection: { accessType: string; instanceId: string };
    };

    expect(body.selection.accessType).toBe("ONE_TIME_SNAPSHOT");
    expect(body.selection.instanceId).toBe("i2");
  });

  /**
   * Apple returns `relationships.analyticsReportRequest` on a report as links
   * only, with no `data`, so reading the access type off the resource yields
   * undefined — which silently disables the preference above. The request id is
   * therefore taken from the URL that fetched the report.
   */
  it("resolves the access type even when Apple omits the relationship data", async () => {
    const bare = (id: string): unknown => ({
      type: "analyticsReports",
      id,
      attributes: { name: "App Store Discovery and Engagement", category: "APP_STORE_ENGAGEMENT" },
      // No `relationships` at all — the live shape.
    });
    const fetchImpl = walk({
      requests: [
        { type: "analyticsReportRequests", id: "ongoing", attributes: { accessType: "ONGOING" } },
        {
          type: "analyticsReportRequests",
          id: "snap",
          attributes: { accessType: "ONE_TIME_SNAPSHOT" },
        },
      ],
      reports: { ongoing: [bare("r1")], snap: [bare("r2")] },
      instances: { r1: [instance("i1", "MONTHLY")], r2: [instance("i2", "MONTHLY")] },
    });

    const body = payloadOf(await call(fetchImpl, { granularity: "MONTHLY" })) as {
      selection: { accessType: string; instanceId: string };
    };

    expect(body.selection.accessType).toBe("ONE_TIME_SNAPSHOT");
    expect(body.selection.instanceId).toBe("i2");
  });

  it("reads coverage out of the data's own Date column", async () => {
    const fetchImpl = walk({
      reports: [report("r1", "App Store Discovery and Engagement", "APP_STORE_ENGAGEMENT")],
      // processingDate says the instance was generated in June; the data inside
      // reaches back to January, and only the data can say so.
      instances: { r1: [instance("i1", "DAILY", "2026-06-03")] },
      csv: "Date,Impressions\n2026-01-05,10\n2026-05-30,20\n",
    });

    const body = payloadOf(await call(fetchImpl, {})) as {
      coverage: { firstDate: string; lastDate: string; rows: number };
      selection: { processingDate: string };
    };

    expect(body.selection.processingDate).toBe("2026-06-03");
    expect(body.coverage).toEqual({ firstDate: "2026-01-05", lastDate: "2026-05-30", rows: 2 });
  });

  it("reads coverage from a tab-delimited body too", async () => {
    const fetchImpl = walk({
      reports: [report("r1", "App Store Discovery and Engagement", "APP_STORE_ENGAGEMENT")],
      instances: { r1: [instance("i1")] },
      csv: "Date\tImpressions\n2026-02-01\t10\n",
    });

    const body = payloadOf(await call(fetchImpl, {})) as { coverage: { firstDate: string } };

    // Analytics segments are comma-delimited and sales reports tab-delimited;
    // a hardcoded splitter yields one column holding everything.
    expect(body.coverage.firstDate).toBe("2026-02-01");
  });

  it("joins segments without repeating the header", async () => {
    let n = 0;
    const base = walk({
      reports: [report("r1", "App Store Discovery and Engagement", "APP_STORE_ENGAGEMENT")],
      instances: { r1: [instance("i1")] },
      segments: [
        {
          type: "analyticsReportSegments",
          id: "s1",
          attributes: { url: `${SEGMENT_URL}?p=1`, sizeInBytes: 10 },
        },
        {
          type: "analyticsReportSegments",
          id: "s2",
          attributes: { url: `${SEGMENT_URL}?p=2`, sizeInBytes: 10 },
        },
      ],
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).startsWith(SEGMENT_URL)) {
        n += 1;
        const body =
          n === 1 ? "Date,Impressions\n2026-06-01,120\n" : "Date,Impressions\n2026-06-02,140\n";
        return new Response(gzipSync(Buffer.from(body)), { status: 200 });
      }
      return (base as unknown as (u: string) => Promise<Response>)(url);
    });

    const body = payloadOf(await call(fetchImpl, {})) as {
      dataRows: number;
      duplicateRows?: number;
      segments: { downloaded: number; of: number };
    };

    // Two data rows, not three: the repeated header would have become a phantom.
    expect(body.dataRows).toBe(2);
    expect(body.duplicateRows).toBeUndefined();
    expect(body.segments).toMatchObject({ downloaded: 2, of: 2 });
  });

  it("checks the segments' total size, not each one, before fetching", async () => {
    const fetchImpl = walk({
      reports: [report("r1", "App Store Discovery and Engagement", "APP_STORE_ENGAGEMENT")],
      instances: { r1: [instance("i1")] },
      segments: [
        {
          type: "analyticsReportSegments",
          id: "s1",
          attributes: { url: `${SEGMENT_URL}?p=1`, sizeInBytes: 600 },
        },
        {
          type: "analyticsReportSegments",
          id: "s2",
          attributes: { url: `${SEGMENT_URL}?p=2`, sizeInBytes: 600 },
        },
      ],
    });

    // Each segment is under the cap; together they are over it. A per-segment
    // check would wave this through.
    const result = await call(fetchImpl, { maxBytes: 1000 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("1200 bytes compressed in total");
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).startsWith(SEGMENT_URL))).toBe(false);
  });

  it("will not create the report request, and says why", async () => {
    const fetchImpl = walk({ requests: [] });

    const body = payloadOf(await call(fetchImpl, {})) as {
      empty: boolean;
      reason: string;
      writesEnabled: boolean;
      note: string;
    };

    expect(body.empty).toBe(true);
    expect(body.reason).toBe("NO_REPORT_REQUEST");
    expect(body.writesEnabled).toBe(false);
    expect(body.note).toContain("app_store_connect_create_analytics_report_request");
    // Creating only ONGOING loses the past permanently, so it is not a getter's
    // decision to make on the caller's behalf.
    expect(body.note).toContain("ONGOING backfills nothing");
  });

  it("names the granularities problem rather than returning nothing", async () => {
    const fetchImpl = walk({
      reports: [report("r1", "App Store Discovery and Engagement", "APP_STORE_ENGAGEMENT")],
      instances: {},
    });

    const body = payloadOf(await call(fetchImpl, { granularity: "MONTHLY" })) as {
      empty: boolean;
      reason: string;
      note: string;
    };

    expect(body.empty).toBe(true);
    expect(body.reason).toBe("NO_INSTANCES_FOR_GRANULARITY");
    expect(body.note).toContain("not every report offers all three granularities".slice(4));
  });

  it("registers in read-only mode", async () => {
    expect(await toolNames(await connect(baseConfig))).toContain(
      "app_store_connect_get_analytics_report",
    );
  });
});
