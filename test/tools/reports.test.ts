import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  baseConfig,
  callArgs,
  connect,
  gzipResponse,
  jsonResponse,
  payloadOf,
  textOf,
} from "../helpers.js";

describe("reports require a vendor number", () => {
  it("fails clearly when neither config nor argument supplies one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_download_sales_report",
      arguments: { reportDate: "2026-06" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("vendor number");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * Apple does not distinguish "that vendor number is not yours" from a genuine
   * server fault: both are a bare 500 UNEXPECTED_ERROR telling you to contact
   * support. Since there is no endpoint that lists valid vendor numbers, the
   * raw error sends you to the status page instead of to the wrong field.
   */
  it("reads a 500 on a sales report as a probable bad vendor number", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ code: "UNEXPECTED_ERROR" }] }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_download_sales_report",
      arguments: { reportDate: "2026-06", vendorNumber: "00000000" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("00000000");
    expect(text).toContain("Payments and Financial Reports");
    // The genuine-outage case must stay reachable, not be asserted away.
    expect(text).toContain("retry");
  });

  /**
   * Apple answers a period with no rows with a 404, so the raw error reads as a
   * broken call when it is actually data. The dangerous half is that the same
   * 404 covers a period Apple has not assembled yet — a just-ended week can 404
   * while its dailies have sales — so the message has to send the caller to the
   * finer granularity rather than let them record a zero.
   */
  it("explains a 404 on a sales report as an empty-or-ungenerated period", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ code: "NOT_FOUND", detail: "There were no sales for the date specified." }],
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    // Only Date is faked, so timers and promises behave normally. The verdict is
    // a statement about how long ago the period ended, so it has to be read
    // against a fixed clock or it decays into a different answer next month.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
    const result = await client.callTool({
      name: "app_store_connect_download_sales_report",
      arguments: { reportDate: "2026-08-09", frequency: "WEEKLY", vendorNumber: "85326407" },
    });
    vi.useRealTimers();

    // An empty period is a measurement, not a fault. An agent branches on a
    // result; on an error it retries or gives up and reports "I could not get
    // the data", which is the understated month arriving another way.
    expect(result.isError).toBeFalsy();
    const body = payloadOf(result) as {
      empty: boolean;
      reason: string;
      confidence: string;
      period: Record<string, unknown>;
      remedy: string;
      note: string;
    };

    expect(body.empty).toBe(true);
    // Settled from the calendar alone: the week ended two days before `now`, so
    // Apple cannot have assembled it yet. No extra request was spent.
    expect(body.reason).toBe("WITHIN_GENERATION_LAG");
    expect(body.confidence).toBe("proven");
    expect(fetchImpl.mock.calls).toHaveLength(1);
    // The span is stated rather than left for the caller to work out.
    expect(body.period).toMatchObject({
      frequency: "WEEKLY",
      reportDate: "2026-08-09",
      start: "2026-08-03",
      end: "2026-08-09",
      daysInPeriod: 7,
    });
    expect(body.remedy).toContain("must not be");
    expect(body.note).toContain("WEEKLY 2026-08-09");

    // The guard against the quiet failure of returning a success: a consumer
    // reaching for rows must get undefined, never an empty report to total.
    expect(body).not.toHaveProperty("report");
    expect(body).not.toHaveProperty("lines");
    expect(body).not.toHaveProperty("dataRows");
  });

  const notFound = (): Response => new Response(JSON.stringify({ errors: [] }), { status: 404 });

  /**
   * The narrow residue the calendar cannot settle: a period old enough that its
   * emptiness is a real question. Only here is a request worth spending.
   */
  it("proves a real zero by checking every day inside the month", async () => {
    const fetchImpl = vi.fn(async () => notFound());
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_sales_report",
        arguments: { reportDate: "2026-03", frequency: "MONTHLY", vendorNumber: "85326407" },
      }),
    ) as { reason: string; confidence: string; evidence: Record<string, unknown> };

    expect(body.reason).toBe("NO_ROWS");
    expect(body.confidence).toBe("proven");
    expect(body.evidence).toMatchObject({
      probe: "DAILY",
      periodsInSpan: 31,
      periodsChecked: 31,
      periodsUnknown: 0,
    });
    expect(fetchImpl.mock.calls).toHaveLength(32); // the month, plus 31 days
  });

  /**
   * The whole point of the probe. One day with sales proves Apple owes a monthly
   * report it has not built, so reporting the month as zero would understate it.
   */
  it("stops at the first day with rows and calls it lag, not a zero", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new URL(String(url)).searchParams.get("filter[frequency]") === "DAILY"
        ? gzipResponse("Provider\tUnits\nAPPLE\t41\n")
        : notFound(),
    );
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_sales_report",
        arguments: { reportDate: "2026-03", frequency: "MONTHLY", vendorNumber: "85326407" },
      }),
    ) as { reason: string; confidence: string; remedy: string };

    expect(body.reason).toBe("NOT_YET_GENERATED");
    expect(body.confidence).toBe("proven");
    expect(body.remedy).toContain("must NOT be recorded as zero");
    // Sentinel first, then stop: the oldest day answered it, so nothing else was
    // asked. Guards against this quietly becoming a 31-request sweep.
    expect(fetchImpl.mock.calls).toHaveLength(2);
    // The caller's own report type, not a substituted SALES: a SUBSCRIPTION 404
    // probed with SALES dailies would prove nothing about subscriptions.
    expect(new URL(callArgs(fetchImpl, 1)[0]).searchParams.get("filter[reportSubType]")).toBe(
      "SUMMARY",
    );
  });

  it("passes the caller's report type down to the probe", async () => {
    const fetchImpl = vi.fn(async () => notFound());
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );
    await client.callTool({
      name: "app_store_connect_download_sales_report",
      arguments: {
        reportDate: "2026-03-15",
        frequency: "WEEKLY",
        reportType: "SUBSCRIPTION",
        vendorNumber: "85326407",
      },
    });

    expect(new URL(callArgs(fetchImpl, 1)[0]).searchParams.get("filter[reportType]")).toBe(
      "SUBSCRIPTION",
    );
  });

  /**
   * Turning the probe off must never silently upgrade a guess into a claim. An
   * unchecked period is unmeasured, not empty.
   */
  it("answers UNDETERMINED with the probe off, and spends exactly one request", async () => {
    const fetchImpl = vi.fn(async () => notFound());
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_sales_report",
        arguments: {
          reportDate: "2026-03",
          frequency: "MONTHLY",
          vendorNumber: "85326407",
          probe: false,
        },
      }),
    ) as { reason: string; confidence: string };

    expect(body.reason).toBe("UNDETERMINED");
    expect(body.reason).not.toBe("NO_ROWS");
    expect(body.confidence).toBe("none");
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it("will not call a capped probe a zero", async () => {
    const fetchImpl = vi.fn(async () => notFound());
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_sales_report",
        arguments: {
          reportDate: "2026-03",
          frequency: "MONTHLY",
          vendorNumber: "85326407",
          maxProbeDays: 5,
        },
      }),
    ) as { reason: string; evidence: Record<string, unknown> };

    expect(body.reason).toBe("NO_ROWS_OBSERVED");
    expect(body.reason).not.toBe("NO_ROWS");
    expect(body.evidence).toMatchObject({ periodsChecked: 5, periodsInSpan: 31 });
  });

  /** A transient Apple fault must not be able to manufacture a zero. */
  it("degrades a failing probe day to unknown rather than to empty", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 3 ? new Response("{}", { status: 500 }) : notFound();
    });
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_sales_report",
        arguments: { reportDate: "2026-03-15", frequency: "WEEKLY", vendorNumber: "85326407" },
      }),
    ) as { reason: string; evidence: Record<string, unknown> };

    expect(body.reason).toBe("NO_ROWS_OBSERVED");
    expect(body.reason).not.toBe("NO_ROWS");
    expect(body.evidence).toMatchObject({ periodsUnknown: 1 });
  });

  it("claims nothing when Apple rejects the probe's parameters", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 1 ? notFound() : new Response("{}", { status: 400 });
    });
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_sales_report",
        arguments: { reportDate: "2026-03-15", frequency: "WEEKLY", vendorNumber: "85326407" },
      }),
    ) as { reason: string; evidence: Record<string, unknown>; remedy: string };

    expect(body.reason).toBe("UNDETERMINED");
    expect(body.evidence).toMatchObject({ probeUnsupported: true });
    expect(body.remedy).toContain("Do NOT record");
  });

  it("refuses to record a period that has not started", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ errors: [] }), { status: 404 }),
    );
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_sales_report",
        arguments: { reportDate: "2099-01-01", frequency: "DAILY", vendorNumber: "85326407" },
      }),
    ) as { reason: string; remedy: string };

    expect(body.reason).toBe("FUTURE_PERIOD");
    expect(body.remedy).toContain("has not started");
  });

  it("writes no file for an empty period", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asc-empty-"));
    const savePath = join(dir, "sales.tsv");
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ errors: [] }), { status: 404 }),
    );
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_sales_report",
        arguments: {
          reportDate: "2026-08-09",
          frequency: "WEEKLY",
          vendorNumber: "85326407",
          savePath,
        },
      }),
    ) as { saved: null };

    // A header-only file would trip report_stats.py's own empty check, which
    // relocates the problem instead of answering it.
    expect(body.saved).toBeNull();
    await expect(readFile(savePath, "utf8")).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * Apple keys finance reports by *fiscal* period: its year opens in late
 * September and its months are 4-4-5 weeks, so `2026-07` is fiscal month 7 of
 * FY2026 — late March to early May — not July. Nothing in the request or the
 * response headline says so, which makes asking for the wrong quarter entirely
 * silent: a well-formed report for a period nobody chose. The dates are already
 * in the TSV, so the tool reads them back rather than relying on the caller
 * knowing Apple's calendar.
 */
describe("download_finance_report", () => {
  const VENDOR = "85326407";
  const FINANCE_TSV =
    "Start Date\tEnd Date\tVendor Identifier\tQuantity\tExtended Partner Share\tCurrency\n" +
    "03/29/2026\t05/02/2026\tD1EXPLORER\t42\t123.45\tUSD\n";

  it("sends the fiscal period and region as Apple's filters", async () => {
    const fetchImpl = vi.fn(async () => gzipResponse(FINANCE_TSV));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_download_finance_report",
      arguments: { reportDate: "2026-07", regionCode: "ZZ", vendorNumber: VENDOR },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe("/v1/financeReports");
    expect(url.searchParams.get("filter[regionCode]")).toBe("ZZ");
    expect(url.searchParams.get("filter[reportType]")).toBe("FINANCIAL");
    expect(url.searchParams.get("filter[reportDate]")).toBe("2026-07");
    expect(url.searchParams.get("filter[vendorNumber]")).toBe(VENDOR);
  });

  it("reports the calendar dates the fiscal period actually covers", async () => {
    const fetchImpl = vi.fn(async () => gzipResponse(FINANCE_TSV));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_download_finance_report",
      arguments: { reportDate: "2026-07", regionCode: "ZZ", vendorNumber: VENDOR },
    });

    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    // Asking for "2026-07" and being handed late March is the whole trap; the
    // answer has to be in the payload, not in a document nobody read.
    expect(body.coverage).toEqual({
      startDate: "2026-03-29",
      endDate: "2026-05-02",
      requestedFiscalPeriod: "2026-07",
    });
    // The report itself is untouched, so downstream parsing is unaffected.
    expect(body.report).toBe(FINANCE_TSV);
    expect(body.dataRows).toBe(1);
    // One currency is nothing to warn about.
    expect(body.currencies).toBeUndefined();
  });

  it("names every currency when an all-regions report mixes them", async () => {
    const tsv =
      "Start Date\tEnd Date\tVendor Identifier\tQuantity\tExtended Partner Share\t" +
      "Partner Share Currency\n" +
      "03/29/2026\t05/02/2026\tD1EXPLORER\t42\t123.45\tUSD\n" +
      "03/29/2026\t05/02/2026\tD1EXPLORER\t7\t1800\tJPY\n" +
      "03/29/2026\t05/02/2026\tD1EXPLORER\t3\t9.99\tEUR\n" +
      "Total_Rows\t3\n";
    const fetchImpl = vi.fn(async () => gzipResponse(tsv));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_finance_report",
        arguments: { reportDate: "2026-07", regionCode: "ZZ", vendorNumber: VENDOR },
      }),
    );

    expect(body.currencies).toEqual(["EUR", "JPY", "USD"]);
    expect(String(body.currencyNote)).toContain("not a revenue figure");
  });

  /**
   * Finance reports are multi-section and Apple has changed their columns before.
   * An unrecognised shape must cost the caller the convenience, not the report —
   * but it must still say the period is unconfirmed, because silence here reads
   * as agreement that the month was the one requested.
   */
  it("says so rather than guessing when the report carries no dates", async () => {
    const fetchImpl = vi.fn(async () => gzipResponse("Vendor Identifier\tQuantity\nD1\t42\n"));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_download_finance_report",
      arguments: { reportDate: "2026-07", regionCode: "ZZ", vendorNumber: VENDOR },
    });

    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(body.coverage).toBeNull();
    expect(String(body.coverageNote)).toContain("fiscal, not calendar");
    expect(body.dataRows).toBe(1);
  });

  /**
   * The empty-period hint is shared with the sales tool, which tells the caller
   * to re-ask at DAILY granularity. Finance reports have no frequency argument
   * at all, so that advice names a parameter this tool does not have.
   */
  it("gives a 404 remedy that fits a report with no granularity", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_download_finance_report",
      arguments: { reportDate: "2026-07", regionCode: "US", vendorNumber: VENDOR },
    });

    expect(result.isError).toBeFalsy();
    const body = payloadOf(result) as {
      empty: boolean;
      reason: string;
      period: Record<string, unknown>;
      note: string;
      remedy: string;
    };

    expect(body.empty).toBe(true);
    expect(body.note).toContain("fiscal 2026-07 in region US");
    // Finance can never claim a proven zero: separating publication lag from a
    // real zero would need Apple's 4-4-5 calendar modelled, which this file
    // refuses to do.
    expect(body.reason).toBe("NO_ROWS_OBSERVED");
    expect(body.reason).not.toBe("NO_ROWS");
    expect(body.reason).not.toBe("NOT_YET_GENERATED");
    // Null, not absent, so nobody reads "calendar July was zero" out of this.
    expect(body.period).toMatchObject({ requestedFiscalPeriod: "2026-07", coverage: null });
    // The checks that do apply here: publication lag, region, fiscal calendar.
    expect(body.remedy).toContain("regionCode ZZ");
    expect(body.remedy).toContain("4-4-5");
    // And not the one that does not.
    expect(JSON.stringify(body)).not.toContain("DAILY");
  });

  /**
   * The one thing finance can actually prove. A region can be empty while the
   * account is not, and the old prose could only suggest checking ZZ by hand.
   */
  it("proves an empty region against the all-regions report", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new URL(String(url)).searchParams.get("filter[regionCode]") === "ZZ"
        ? gzipResponse(FINANCE_TSV)
        : new Response(JSON.stringify({ errors: [] }), { status: 404 }),
    );
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_finance_report",
        arguments: { reportDate: "2026-07", regionCode: "US", vendorNumber: VENDOR },
      }),
    ) as { reason: string; confidence: string; evidence: Record<string, unknown>; remedy: string };

    expect(body.reason).toBe("REGION_EMPTY");
    expect(body.confidence).toBe("proven");
    expect(body.evidence).toMatchObject({ probedRegion: "ZZ" });
    expect(body.remedy).toContain("Record 0 for this region only");
    expect(fetchImpl.mock.calls).toHaveLength(2);
  });

  it("does not re-probe ZZ against itself", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ errors: [] }), { status: 404 }),
    );
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_finance_report",
        arguments: { reportDate: "2026-07", regionCode: "ZZ", vendorNumber: VENDOR },
      }),
    ) as { reason: string; evidence: Record<string, unknown> };

    expect(body.reason).toBe("NO_ROWS_OBSERVED");
    expect(fetchImpl.mock.calls).toHaveLength(1);
    expect(body.evidence.requests).toBe(1);
  });

  // A ZZ that failed measured nothing, so it must not read as "0 rows anywhere".
  it("does not report a failed ZZ probe as an empty account", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new URL(String(url)).searchParams.get("filter[regionCode]") === "ZZ"
        ? new Response(JSON.stringify({ errors: [] }), { status: 500 })
        : new Response(JSON.stringify({ errors: [] }), { status: 404 }),
    );
    const client = await connect(
      { ...baseConfig, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_download_finance_report",
        arguments: { reportDate: "2026-07", regionCode: "US", vendorNumber: VENDOR },
      }),
    ) as { reason: string; evidence: Record<string, unknown> };

    expect(body.reason).toBe("NO_ROWS_OBSERVED");
    expect(body.evidence.rowsInAllRegions).toBeUndefined();
    expect(body.evidence.probeError).toBeDefined();
  });
});

/**
 * Apple has no per-app filter on the sales endpoint, so the TSV is account-wide
 * and interleaved. Filtering it by eye is both tedious and the likeliest way to
 * quote a portfolio total as one app's — and truncation across the interleaving
 * silently removes part of every app rather than a clean tail.
 */
describe("download_sales_report per-app filter", () => {
  const VENDOR = "85326407";
  const HEADER = "Provider\tSKU\tTitle\tUnits\tApple Identifier";
  const SALES_TSV =
    `${HEADER}\n` +
    "APPLE\tD1EXPLORER\tD1 Explorer\t10\t6740111111\n" +
    "APPLE\tOTHERAPP\tOther App\t5\t6740222222\n" +
    "APPLE\tD1EXPLORER\tD1 Explorer\t3\t6740111111\n";

  const download = async (
    args: Record<string, unknown>,
    tsv = SALES_TSV,
  ): ReturnType<Client["callTool"]> => {
    const fetchImpl = vi.fn(async () => gzipResponse(tsv));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    return client.callTool({
      name: "app_store_connect_download_sales_report",
      arguments: { reportDate: "2026-07", vendorNumber: VENDOR, ...args },
    });
  };

  it("returns the whole portfolio untouched when no filter is given", async () => {
    const body = JSON.parse(textOf(await download({}))) as Record<string, unknown>;

    expect(body.filter).toBeUndefined();
    expect(body.report).toBe(SALES_TSV);
    expect(body.dataRows).toBe(3);
  });

  it("keeps one app's rows, preserves the header, and counts what it dropped", async () => {
    const body = JSON.parse(textOf(await download({ appleIdentifier: "6740111111" }))) as Record<
      string,
      unknown
    >;

    expect(body.filter).toMatchObject({
      appleIdentifier: "6740111111",
      matchedRows: 2,
      droppedRows: 1,
    });
    // The header has to survive: report_stats.py keys on the column names.
    expect(String(body.report).split("\n")[0]).toBe(HEADER);
    expect(String(body.report)).not.toContain("OTHERAPP");
    expect(body.dataRows).toBe(2);
  });

  it("filters on SKU too, and combines the two", async () => {
    const bySku = JSON.parse(textOf(await download({ sku: "OTHERAPP" }))) as Record<
      string,
      unknown
    >;
    expect(bySku.filter).toMatchObject({ matchedRows: 1, droppedRows: 2 });

    // Contradictory pair: this SKU never appears against that Apple Identifier.
    const both = JSON.parse(
      textOf(await download({ sku: "OTHERAPP", appleIdentifier: "6740111111" })),
    ) as Record<string, unknown>;
    expect(both.filter).toMatchObject({ matchedRows: 0 });
  });

  /**
   * The reason filtering belongs in the server rather than downstream: truncation
   * runs over the filtered rows, so `truncated` describes this app. Applied to
   * the raw report the same limit would cut across every app at once, and
   * `truncated: true` would not reveal that one had vanished entirely.
   */
  it("truncates the filtered rows, not an arbitrary slice of the portfolio", async () => {
    const filtered = JSON.parse(
      textOf(await download({ appleIdentifier: "6740111111", maxLines: 3 })),
    ) as Record<string, unknown>;
    // Header plus this app's two rows is exactly 3 lines: complete, not truncated.
    expect(filtered.truncated).toBe(false);
    expect(filtered.dataRows).toBe(2);

    const unfiltered = JSON.parse(textOf(await download({ maxLines: 3 }))) as Record<
      string,
      unknown
    >;
    // The same limit over the raw report drops a row without saying which app lost it.
    expect(unfiltered.truncated).toBe(true);
  });

  /**
   * An empty result after filtering is ambiguous in the one way that matters: a
   * quiet app and a wrong id look identical. The row count for everything else
   * settles it, and the ids actually present turn a dead end into the next step.
   */
  it("distinguishes a filter that matched nothing from an empty period", async () => {
    const body = JSON.parse(textOf(await download({ appleIdentifier: "9999999999" }))) as Record<
      string,
      unknown
    >;

    const filter = body.filter as Record<string, unknown>;
    expect(filter).toMatchObject({ matchedRows: 0, droppedRows: 3 });
    expect(String(filter.note)).toContain("the period itself is not empty");
    expect(String(filter.note)).toContain("6740111111");
    expect(String(filter.note)).toContain("6740222222");
    // Still a well-formed report, just an empty one.
    expect(String(body.report).split("\n")[0]).toBe(HEADER);
    expect(body.dataRows).toBe(0);
  });

  /**
   * Silently ignoring an unhonourable filter would hand back the entire portfolio
   * under a name claiming one app — exactly the error the argument exists to
   * prevent, and worse than failing because the number looks plausible.
   */
  it("fails rather than ignoring a filter the report cannot honour", async () => {
    const result = await download(
      { appleIdentifier: "6740111111" },
      "Provider\tUnits\nAPPLE\t10\n",
    );

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Apple Identifier");
    expect(text).toContain("Provider, Units");
  });

  /**
   * The trap this whole block of behaviour exists for. An in-app purchase row
   * carries the IAP's own Apple Identifier and names its app only in `Parent
   * Identifier`, as the SKU. Filtering on the app id therefore drops every one of
   * them and returns a clean, plausible, `truncated: false` report showing no
   * in-app revenue — an answer with nothing about it that looks wrong. Two real
   * runs of the reporting skill came one probe away from publishing "this app has
   * never earned anything" off exactly this.
   */
  describe("in-app purchase rows", () => {
    const IAP_HEADER =
      "Provider\tSKU\tTitle\tUnits\tApple Identifier\tProduct Type Identifier\tParent Identifier";
    const IAP_TSV =
      `${IAP_HEADER}\n` +
      "APPLE\tD1EXPLORER\tD1 Explorer\t10\t6740111111\tF1\t\n" +
      "APPLE\tOTHERAPP\tOther App\t5\t6740222222\tF1\t\n" +
      "APPLE\tD1PRO\tD1 Explorer Pro\t3\t6762885916\tIA1-M\tD1EXPLORER\n" +
      "APPLE\tD1EXPLORER\tD1 Explorer\t2\t6740111111\tF7\t\n";

    it("keeps them by default, matching through Parent Identifier", async () => {
      const body = JSON.parse(
        textOf(await download({ appleIdentifier: "6740111111" }, IAP_TSV)),
      ) as Record<string, unknown>;

      expect(body.filter).toMatchObject({
        matchedRows: 3,
        inAppPurchaseRows: 1,
        parentSkus: ["D1EXPLORER"],
      });
      // The purchase row is the one carrying the money, and it is the row an
      // Apple Identifier filter silently discards.
      expect(String(body.report)).toContain("D1PRO");
      expect(String(body.report)).not.toContain("OTHERAPP");
      // File order, not app rows followed by purchases.
      expect(String(body.report).split("\n")[3]).toContain("F7");
      expect(String(body.filter && (body.filter as Record<string, unknown>).note)).toContain(
        "more than one",
      );
    });

    it("says what opting out costs, rather than quietly returning less", async () => {
      const body = JSON.parse(
        textOf(
          await download({ appleIdentifier: "6740111111", includeInAppPurchases: false }, IAP_TSV),
        ),
      ) as Record<string, unknown>;

      expect(body.filter).toMatchObject({ matchedRows: 2, inAppPurchaseRows: 0 });
      const note = String((body.filter as Record<string, unknown>).note);
      expect(note).toContain("1 dropped rows carry Parent Identifier D1EXPLORER");
      expect(note).toContain("in-app purchases");
    });

    /**
     * The one case the report cannot answer for itself: with no rows of the app's
     * own, there is nothing to read the SKU off, so the parent match has no key.
     * Returning the app's two-row-shaped nothing without saying so is how a period
     * where only IAPs sold reads as zero.
     */
    it("says so when the app's SKU cannot be derived from the file", async () => {
      const onlyIap =
        `${IAP_HEADER}\n` +
        "APPLE\tOTHERAPP\tOther App\t5\t6740222222\tF1\t\n" +
        "APPLE\tD1PRO\tD1 Explorer Pro\t3\t6762885916\tIA1-M\tD1EXPLORER\n";
      const body = JSON.parse(
        textOf(await download({ appleIdentifier: "6740111111" }, onlyIap)),
      ) as Record<string, unknown>;

      const note = String((body.filter as Record<string, unknown>).note);
      expect(note).toContain("D1EXPLORER");
      expect(note).toContain("Parent Identifier");

      // Passing the SKU recovers the rows the id alone cannot reach.
      const withSku = JSON.parse(textOf(await download({ sku: "D1EXPLORER" }, onlyIap))) as Record<
        string,
        unknown
      >;
      expect(withSku.filter).toMatchObject({ matchedRows: 1, inAppPurchaseRows: 1 });
      expect(String(withSku.report)).toContain("D1PRO");
    });

    it("names the parent identifiers when nothing matched at all", async () => {
      const body = JSON.parse(
        textOf(await download({ appleIdentifier: "9999999999" }, IAP_TSV)),
      ) as Record<string, unknown>;

      const note = String((body.filter as Record<string, unknown>).note);
      expect(note).toContain("the period itself is not empty");
      expect(note).toContain("D1EXPLORER");
    });

    it("filters a report with no Parent Identifier column without complaint", async () => {
      const body = JSON.parse(
        textOf(await download({ appleIdentifier: "6740111111" }, SALES_TSV)),
      ) as Record<string, unknown>;

      expect(body.filter).toMatchObject({ matchedRows: 2, droppedRows: 1 });
      // Nothing to report about a split this report shape cannot express.
      expect((body.filter as Record<string, unknown>).inAppPurchaseRows).toBeUndefined();
      expect((body.filter as Record<string, unknown>).note).toBeUndefined();
    });
  });

  /**
   * Without this the caller has to retype the report into a file, and a report is
   * exactly the payload that survives a dropped row looking well-formed — the
   * totals simply come out lower. Writing it here removes the step rather than
   * defending against it.
   */
  describe("savePath", () => {
    let dir = "";

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "asc-reports-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("writes the report and reports counts matching the preview", async () => {
      const savePath = join(dir, "nested", "sales.tsv");
      const body = JSON.parse(textOf(await download({ savePath }))) as Record<string, unknown>;

      // Parent directories are created rather than being the caller's problem.
      expect(await readFile(savePath, "utf8")).toBe(SALES_TSV);
      expect(body.saved).toMatchObject({ path: savePath, dataRows: 3, lines: 4 });
      expect((body.saved as Record<string, unknown>).dataRows).toBe(body.dataRows);
    });

    it("counts the same rows as the preview when the report ends in blank lines", async () => {
      const savePath = join(dir, "sales.tsv");
      const body = JSON.parse(textOf(await download({ savePath }, `${SALES_TSV}\n\n`))) as Record<
        string,
        unknown
      >;

      expect(body.dataRows).toBe(3);
      expect(body.saved).toMatchObject({ dataRows: 3, lines: 4 });
    });

    /**
     * The distinction that keeps the pipeline honest: `report_stats.py` treats
     * `truncated` as a hard error so a floor is never quoted as a total. Once a
     * file has been written that flag describes the inlined copy only, and reading
     * it as data loss would reject a file that lost nothing.
     */
    it("saves the whole report even when the inlined copy is truncated", async () => {
      const savePath = join(dir, "sales.tsv");
      const body = JSON.parse(textOf(await download({ savePath, maxLines: 2 }))) as Record<
        string,
        unknown
      >;

      expect(body.inlineTruncated).toBe(true);
      expect(await readFile(savePath, "utf8")).toBe(SALES_TSV);
      expect(body.saved).toMatchObject({ dataRows: 3, content: "report" });
      // The note is an instruction, not a correction: it says where the totals
      // are and that report_stats.py goes there by itself.
      expect(String(body.savedNote)).toContain("all 3 data rows");
      expect(String(body.savedNote)).toContain(savePath);
    });

    it("saves the filtered rows, not the whole portfolio", async () => {
      const savePath = join(dir, "sales.tsv");
      await download({ savePath, appleIdentifier: "6740111111" });

      const written = await readFile(savePath, "utf8");
      expect(written).not.toContain("OTHERAPP");
      expect(written.split("\n")[0]).toBe(HEADER);
    });

    it("refuses a relative path rather than writing somewhere arbitrary", async () => {
      const result = await download({ savePath: "reports/sales.tsv" });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("absolute path");
    });

    it("says what to do when the path is unwritable, naming the Docker case", async () => {
      // A directory where a file is expected: the closest portable stand-in for
      // the host path that does not exist inside a container.
      const result = await download({ savePath: dir });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Docker");
    });
  });
});

describe("get_vendor_number", () => {
  it("returns where to look instead of failing when none is configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_get_vendor_number",
      arguments: {},
    });

    // Not an error: "you have not set one, here is where it lives" is the
    // answer, and an isError result would push a caller to give up instead.
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(body.configured).toBe(false);
    expect(body.vendorNumber).toBeNull();
    expect(String(body.hint)).toContain("S_<frequency>_<vendorNumber>_<date>.txt");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports which config layer supplied the number", async () => {
    const fetchImpl = vi.fn(async () => gzipResponse("Provider\tVendor\n"));
    const client = await connect(
      { ...baseConfig, vendorNumber: "85326407", vendorNumberSource: "file" },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_get_vendor_number",
      arguments: {},
    });

    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(body).toMatchObject({ vendorNumber: "85326407", source: "file", readable: true });
  });

  it("probes a recent daily report and skips the call when verify is off", async () => {
    const fetchImpl = vi.fn(async () => gzipResponse("Provider\tVendor\n"));
    const client = await connect(
      { ...baseConfig, vendorNumber: "85326407", vendorNumberSource: "environment" },
      fetchImpl as unknown as typeof fetch,
    );

    await client.callTool({
      name: "app_store_connect_get_vendor_number",
      arguments: {},
    });
    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe("/v1/salesReports");
    expect(url.searchParams.get("filter[vendorNumber]")).toBe("85326407");
    expect(url.searchParams.get("filter[frequency]")).toBe("DAILY");
    // Five days back, so the probe cannot fail on a day Apple has not closed yet.
    expect(url.searchParams.get("filter[reportDate]")).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const skipped = await client.callTool({
      name: "app_store_connect_get_vendor_number",
      arguments: { verify: false },
    });
    expect(JSON.parse(textOf(skipped))).toMatchObject({ verified: false, source: "environment" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /**
   * The inverted signal: a 404 is Apple saying "no sales that day", which it can
   * only say after resolving and authorising the vendor. Treating it as failure
   * would make a valid vendor number on a quiet account unverifiable.
   */
  /**
   * Also guards a coupling that is easy to miss: `withEmptyPeriodHint` rewrites a
   * 404 on the report-download tools into "no rows for this period", which would
   * turn this successful verification into an error if it ever wrapped the probe.
   * The probe calls the client directly to stay out of that path -- if this test
   * starts failing with a message about DAILY granularity, that is why.
   */
  it("treats a no-sales 404 as proof the vendor number is readable", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = await connect(
      { ...baseConfig, vendorNumber: "85326407", vendorNumberSource: "file" },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_get_vendor_number",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toMatchObject({ readable: true });
  });

  it("reports a 500 as an unreadable vendor number without erroring the tool", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ code: "UNEXPECTED_ERROR" }] }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = await connect(
      { ...baseConfig, maxRetries: 0, vendorNumber: "00000000", vendorNumberSource: "environment" },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_get_vendor_number",
      arguments: { vendorNumber: "00000000" },
    });

    // A diagnostic that throws tells you nothing; the verdict is the payload.
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(body).toMatchObject({ readable: false, source: "argument" });
    expect(String((body.probe as Record<string, unknown>).detail)).toContain("retry");
  });

  it("rethrows an auth failure rather than blaming the vendor number", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ code: "FORBIDDEN_ERROR" }] }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = await connect(
      { ...baseConfig, maxRetries: 0, vendorNumber: "85326407", vendorNumberSource: "file" },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_get_vendor_number",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('"readable"');
  });
});
