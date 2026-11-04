import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  baseConfig,
  callArgs,
  connect,
  jsonResponse,
  payloadOf,
  postCall,
  textOf,
  toolNames,
} from "../helpers.js";

describe("tool registration", () => {
  let readOnly: string[];
  let withWrites: string[];

  beforeAll(async () => {
    readOnly = await toolNames(await connect(baseConfig));
    withWrites = await toolNames(await connect({ ...baseConfig, allowWrites: true }));
  });

  it("registers the read tools in both modes", () => {
    for (const name of [
      "app_store_connect_list_apps",
      "app_store_connect_get_app",
      "app_store_connect_list_live_versions",
      "app_store_connect_list_versions",
      "app_store_connect_get_version",
      "app_store_connect_list_review_submissions",
      "app_store_connect_list_asset_packs",
      "app_store_connect_list_app_infos",
      "app_store_connect_list_app_info_localizations",
      "app_store_connect_get_app_info_localization",
      "app_store_connect_get_age_rating_declaration",
      "app_store_connect_export_listing",
      "app_store_connect_list_screenshot_sets",
      "app_store_connect_list_screenshots",
      "app_store_connect_get_screenshot",
      "app_store_connect_list_preview_sets",
      "app_store_connect_list_previews",
      "app_store_connect_get_preview",
      "app_store_connect_list_builds",
      "app_store_connect_list_beta_groups",
      "app_store_connect_list_beta_testers",
      "app_store_connect_list_beta_feedback",
      "app_store_connect_list_beta_crash_reports",
      "app_store_connect_get_beta_crash_log",
      "app_store_connect_list_diagnostic_signatures",
      "app_store_connect_get_diagnostic_logs",
      "app_store_connect_get_rating_summary",
      "app_store_connect_get_phased_release",
      "app_store_connect_get_vendor_number",
      "app_store_connect_download_sales_report",
      "app_store_connect_download_finance_report",
      "app_store_connect_list_analytics_report_requests",
      "app_store_connect_list_analytics_reports",
      "app_store_connect_list_analytics_report_instances",
      "app_store_connect_list_analytics_report_segments",
      "app_store_connect_download_analytics_report_segment",
      "app_store_connect_get_analytics_status",
      "app_store_connect_list_users",
      "app_store_connect_list_bundle_ids",
      "app_store_connect_list_capabilities",
      "app_store_connect_list_devices",
      "app_store_connect_list_customer_reviews",
      "app_store_connect_list_iap_localizations",
      "app_store_connect_get_iap_review_screenshot",
      "app_store_connect_get_iap_availability",
      "app_store_connect_list_app_categories",
      "app_store_connect_list_app_price_points",
      "app_store_connect_get_app_price_schedule",
      "app_store_connect_get_app_store_review_detail",
    ]) {
      expect(readOnly, name).toContain(name);
      expect(withWrites, name).toContain(name);
    }
  });

  it("hides every write tool when writes are disabled", () => {
    const writeTools = withWrites.filter((name) => !readOnly.includes(name));
    expect(writeTools.length).toBeGreaterThan(6);
    for (const name of [
      "app_store_connect_create_version",
      "app_store_connect_update_version",
      "app_store_connect_update_version_localization",
      "app_store_connect_set_version_build",
      "app_store_connect_release_version",
      "app_store_connect_create_phased_release",
      "app_store_connect_update_phased_release",
      "app_store_connect_submit_version_for_review",
      "app_store_connect_cancel_review_submission",
      "app_store_connect_remove_version_from_submission",
      "app_store_connect_update_app_info_localization",
      "app_store_connect_update_age_rating_declaration",
      "app_store_connect_apply_listing",
      "app_store_connect_upload_screenshot",
      "app_store_connect_delete_screenshot",
      "app_store_connect_delete_screenshot_set",
      "app_store_connect_reorder_screenshots",
      "app_store_connect_upload_preview",
      "app_store_connect_set_preview_poster_frame",
      "app_store_connect_delete_preview",
      "app_store_connect_delete_preview_set",
      "app_store_connect_reorder_previews",
      "app_store_connect_create_beta_group",
      "app_store_connect_invite_beta_tester",
      "app_store_connect_remove_tester_from_group",
      "app_store_connect_set_in_app_purchase_price",
      "app_store_connect_update_in_app_purchase",
      "app_store_connect_set_iap_availability",
      "app_store_connect_create_iap_localization",
      "app_store_connect_update_iap_localization",
      "app_store_connect_delete_iap_localization",
      "app_store_connect_upload_iap_review_screenshot",
      "app_store_connect_delete_iap_review_screenshot",
      "app_store_connect_submit_in_app_purchase_for_review",
      "app_store_connect_create_bundle_id",
      "app_store_connect_enable_capability",
      "app_store_connect_disable_capability",
      "app_store_connect_register_device",
      "app_store_connect_create_analytics_report_request",
      "app_store_connect_update_app",
      "app_store_connect_set_app_categories",
      "app_store_connect_set_app_price",
      "app_store_connect_set_app_store_review_detail",
      "app_store_connect_reply_to_customer_review",
      "app_store_connect_delete_customer_review_response",
    ]) {
      expect(readOnly, name).not.toContain(name);
      expect(withWrites, name).toContain(name);
    }
  });

  it("marks read tools readOnly and destructive ones destructive", async () => {
    const client = await connect({ ...baseConfig, allowWrites: true });
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.get("app_store_connect_list_apps")?.annotations?.readOnlyHint).toBe(true);
    expect(
      byName.get("app_store_connect_remove_tester_from_group")?.annotations?.destructiveHint,
    ).toBe(true);
    expect(byName.get("app_store_connect_disable_capability")?.annotations?.destructiveHint).toBe(
      true,
    );
    expect(byName.get("app_store_connect_create_version")?.annotations?.destructiveHint).toBe(
      false,
    );
    // Both submit tools hand work to Apple for good, and say so the same way.
    for (const name of [
      "app_store_connect_submit_version_for_review",
      "app_store_connect_submit_in_app_purchase_for_review",
      "app_store_connect_set_iap_availability",
      "app_store_connect_set_app_price",
    ]) {
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(true);
    }
  });

  /**
   * The enforcement mechanism for "every read can save".
   *
   * The bug this feature fixes is an agent not reaching for `savePath` and
   * retyping values instead, so the promise has to be one an agent can rely on
   * without checking: all reads, no exceptions to remember. A curated list would
   * rot silently — nothing fails when a new read tool is added without it — so
   * the rule is asserted here, and each exception carries its reason.
   */
  it("offers savePath on every read tool", async () => {
    const EXCLUDED = new Map([
      // Registered before the config check, on a server that may have no
      // credentials at all. Five diagnostic fields; nothing to save.
      ["app_store_connect_auth_status", "diagnostic"],
      // Already has one, writing the raw TSV/CSV rather than the JSON envelope —
      // which is what report_stats.py and every spreadsheet want.
      ["app_store_connect_download_sales_report", "saves the raw report"],
      ["app_store_connect_download_finance_report", "saves the raw report"],
      ["app_store_connect_download_analytics_report_segment", "saves the raw report"],
      // savePath is required here and writes DER bytes; it is the save tool.
      ["app_store_connect_download_certificate", "saves the raw certificate"],
      // Returns {path, content} pairs precisely so the agent writes the metadata
      // tree under its own permission prompt. See the listing round-trip docs.
      ["app_store_connect_export_listing", "hands files back to be written"],
    ]);

    const client = await connect({ ...baseConfig, allowWrites: true });
    const reads = (await client.listTools()).tools.filter((t) => t.annotations?.readOnlyHint);
    expect(reads.length).toBeGreaterThan(40);

    for (const tool of reads) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      if (EXCLUDED.has(tool.name)) continue;
      expect(properties, tool.name).toHaveProperty("savePath");
    }
    // The exclusions are real tools, so a rename cannot quietly widen the list.
    const names = new Set(reads.map((t) => t.name));
    for (const name of EXCLUDED.keys()) expect(names, name).toContain(name);
  });
});

/**
 * The report downloads have saved to a path since they shipped, because a
 * retyped report loses rows while still looking well-formed. Every other read
 * had the same exposure and no answer for it: eight apps' minOsVersion floors
 * went through an agent into a cache by hand, and were stale by the time anyone
 * read them. These assertions are about the file being the source of truth
 * rather than a copy of the response.
 */
describe("savePath on JSON reads", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "asc-reads-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const buildsBody = {
    data: [
      {
        type: "builds",
        id: "b-1",
        attributes: { version: "155", minOsVersion: "16.0", processingState: "VALID" },
      },
    ],
  };

  it("writes the payload it returned, minus the receipt", async () => {
    const savePath = join(dir, "nested", "builds.json");
    const fetchImpl = vi.fn(async () => jsonResponse(buildsBody));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_builds",
        arguments: { appId: "123", savePath },
      }),
    ) as Record<string, unknown> & { saved: { path: string; bytes: number; content: string } };

    // Parent directories are created rather than being the caller's problem.
    const text = await readFile(savePath, "utf8");
    const { saved, ...payload } = body;
    // The file is what the tool would have returned without savePath — the
    // receipt is never written into the file it describes.
    expect(JSON.parse(text)).toEqual(payload);
    expect(saved).toEqual({
      path: savePath,
      bytes: Buffer.byteLength(text, "utf8"),
      content: "json",
    });
    // Pretty on disk, compact on the wire: this copy is one someone opens.
    expect(text).toContain("\n  ");
  });

  it("saves a hand-built payload too, not just a summarized list", async () => {
    const savePath = join(dir, "version.json");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          type: "appStoreVersions",
          id: "v-1",
          attributes: { versionString: "1.4.0", appStoreState: "READY_FOR_SALE" },
          relationships: { build: { data: { type: "builds", id: "b-9" } } },
        },
        included: [{ type: "builds", id: "b-9", attributes: { minOsVersion: "26.0" } }],
      }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_get_version",
      arguments: { versionId: "v-1", savePath },
    });

    // The whole point of the feature: the OS floor reaches the file without an
    // agent retyping it.
    const saved = JSON.parse(await readFile(savePath, "utf8")) as {
      build: { minOsVersion: string };
    };
    expect(saved.build.minOsVersion).toBe("26.0");
  });

  it("refuses a relative path rather than writing somewhere unexpected", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(buildsBody));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_list_builds",
      arguments: { appId: "123", savePath: "builds.json" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("absolute path");
  });

  /**
   * A failed write is a tool error, not a warning beside the data. Returning the
   * payload with a note would invite exactly the outcome the feature exists to
   * prevent — the agent shrugs and transcribes the inline copy.
   */
  it("fails the call when the write fails, naming the Docker case", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(buildsBody));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_list_builds",
      arguments: { appId: "123", savePath: dir },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Docker");
  });

  it("returns the payload unchanged when no savePath is given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(buildsBody));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_builds",
        arguments: { appId: "123" },
      }),
    ) as Record<string, unknown>;

    expect(body).not.toHaveProperty("saved");
  });
});

describe("read tool calls", () => {
  it("lists apps against /v1/apps with the bundle-id filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_apps",
      arguments: { bundleId: "com.acme.app" },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.origin + url.pathname).toBe("https://api.appstoreconnect.apple.com/v1/apps");
    expect(url.searchParams.get("filter[bundleId]")).toBe("com.acme.app");
  });
});

describe("destructive tools", () => {
  it("refuse to run without an explicit confirm", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_remove_tester_from_group",
      arguments: { groupId: "g1", testerId: "t1" },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("run when confirmed", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_remove_tester_from_group",
      arguments: { groupId: "g1", testerId: "t1", confirm: true },
    });

    expect(result.isError).toBeFalsy();
    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe(
      "https://api.appstoreconnect.apple.com/v1/betaGroups/g1/relationships/betaTesters",
    );
    expect(init.method).toBe("DELETE");
  });
});

describe("one-way creations", () => {
  it.each([
    [
      "app_store_connect_create_bundle_id",
      { identifier: "com.acme.app", name: "Acme" },
      "/v1/bundleIds",
    ],
    [
      "app_store_connect_register_device",
      { name: "QA iPhone", udid: "00008110-000A1B2C3D4E5F60" },
      "/v1/devices",
    ],
  ])("%s refuses without confirm, then posts with it", async (name, args, path) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: "new", type: "x" } }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const refused = await client.callTool({ name, arguments: args });
    expect(refused.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    const done = await client.callTool({ name, arguments: { ...args, confirm: true } });
    expect(done.isError).toBeFalsy();
    expect(postCall(fetchImpl, path)).toBeDefined();
  });
});

/**
 * Apple caps `data` at `limit` and puts the real count in `meta.paging.total`.
 * Nothing in the rows says they are a subset, so a caller reading a full page
 * concludes the collection is what it can see — and reports something as ABSENT
 * because it fell off the end. That is not hypothetical: a capped list_builds
 * page was read as "half the upload never landed", which would have sent
 * someone re-uploading a build that was already there.
 */
describe("partial pages", () => {
  const buildRows = (n: number): unknown[] =>
    Array.from({ length: n }, (_, i) => ({
      type: "builds",
      id: `b${i}`,
      attributes: { version: String(i) },
    }));

  it("says how many rows did not fit", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: buildRows(50), meta: { paging: { total: 137, limit: 50 } } }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_builds",
        arguments: { appId: "1" },
      }),
    ) as { incomplete: { returned: number; total: number; missing: number; note: string } };

    expect(body.incomplete).toMatchObject({ returned: 50, total: 137, missing: 87 });
    // The instruction that prevents the wrong conclusion, not just the numbers.
    expect(body.incomplete.note).toContain("Do NOT read anything as absent");
  });

  it("says nothing when the page holds everything", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: buildRows(3), meta: { paging: { total: 3, limit: 50 } } }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_builds",
        arguments: { appId: "1" },
      }),
    ) as Record<string, unknown>;

    // Absence of the block is itself a claim — that the list is complete — so it
    // must never appear when it has nothing to say.
    expect(body).not.toHaveProperty("incomplete");
  });

  /** Apple marks `total` optional in its own schema; a next link still proves it. */
  it("falls back to the next link when Apple omits the total", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: buildRows(50),
        meta: { paging: { limit: 50 } },
        links: { next: "https://api.appstoreconnect.apple.com/v1/builds?cursor=abc" },
      }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_builds",
        arguments: { appId: "1" },
      }),
    ) as { incomplete: { returned: number; note: string; total?: number } };

    expect(body.incomplete.returned).toBe(50);
    expect(body.incomplete.total).toBeUndefined();
    expect(body.incomplete.note).toContain("more exist");
  });

  it("applies to every list read, not just builds", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ type: "apps", id: "1", attributes: { name: "Alpha" } }],
        meta: { paging: { total: 9, limit: 1 } },
      }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({ name: "app_store_connect_list_apps", arguments: { limit: 1 } }),
    ) as { incomplete: { missing: number } };

    expect(body.incomplete.missing).toBe(8);
  });

  it("leaves a single-resource read alone", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { type: "apps", id: "1", attributes: { name: "Alpha" } } }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({ name: "app_store_connect_get_app", arguments: { appId: "1" } }),
    ) as Record<string, unknown>;

    expect(body).not.toHaveProperty("incomplete");
  });
});

/**
 * Only the three endpoints Apple's spec types `filter[app]` as an array — one
 * real request, no fan-out hidden behind a name that promises one call.
 */
describe("multi-app reads", () => {
  const buildRow = (id: string, appId: string): unknown => ({
    type: "builds",
    id,
    attributes: { version: id },
    relationships: { app: { data: { type: "apps", id: appId } } },
  });

  it("reads several apps' builds in one request, keyed by app", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [buildRow("155", "1"), buildRow("42", "2")] }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_builds",
        arguments: { appId: ["1", "2"] },
      }),
    ) as { data: { id: string; appId: string }[] };

    expect(fetchImpl.mock.calls).toHaveLength(1);
    const url = new URL(callArgs(fetchImpl, 0)[0]);
    expect(url.searchParams.get("filter[app]")).toBe("1,2");
    // Asserted on the REQUEST, not just on a hand-built fixture. Apple returns
    // the app relationship as links only unless `include=app` is asked for, so a
    // mock that supplies `data` unconditionally will pass while the live call
    // returns appId: undefined — which is exactly what happened.
    expect(url.searchParams.get("include")).toBe("app");
    // Without this the rows arrive interleaved with nothing to tell them apart.
    expect(body.data.map((b) => b.appId)).toEqual(["1", "2"]);
  });

  it("asks for include=app on every endpoint that reports a per-row appId", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["list_builds", { appId: ["1", "2"] }, "/v1/builds"],
      ["list_beta_groups", { appId: ["1", "2"] }, "/v1/betaGroups"],
      ["list_review_submissions", { appId: ["1", "2"] }, "/v1/reviewSubmissions"],
    ];

    for (const [tool, args, pathname] of cases) {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
      const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
      await client.callTool({ name: `app_store_connect_${tool}`, arguments: args });

      const url = new URL(callArgs(fetchImpl, 0)[0]);
      // The top-level collection, never /v1/apps/{id}/… — a path-scoped endpoint
      // given an array of ids would request /v1/apps/1,2/… and 404.
      expect(url.pathname, tool).toBe(pathname);
      expect(url.searchParams.get("filter[app]"), tool).toBe("1,2");
      expect(url.searchParams.get("include")?.split(",").includes("app"), tool).toBe(true);
    }
  });

  it("still takes a single id, and still says which app each row is", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [buildRow("155", "1")] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_builds",
        arguments: { appId: "1" },
      }),
    ) as { data: { appId: string }[]; note?: string };

    expect(new URL(callArgs(fetchImpl, 0)[0]).searchParams.get("filter[app]")).toBe("1");
    expect(body.data[0]?.appId).toBe("1");
    expect(body.note).toBeUndefined();
  });

  /**
   * The wrinkle that makes one HTTP call not a per-app answer: Apple's limit is
   * one cap across the union, and its sort cannot interleave, so a full page can
   * be entirely one app. Reading a missing app as "no builds" is the bug.
   */
  it("warns when a full page may have crowded an app out", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [buildRow("1", "1"), buildRow("2", "1")],
        meta: { paging: { total: 9, limit: 2 } },
      }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_builds",
        arguments: { appId: ["1", "2"], limit: 2 },
      }),
    ) as { note: string };

    expect(body.note).toContain("across all 2 apps");
    // And the general fact underneath it: 7 rows did not fit.
    expect((body as unknown as { incomplete: { missing: number } }).incomplete.missing).toBe(7);
  });

  it("does not warn when the page is not full", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [buildRow("1", "1")], meta: { paging: { total: 1, limit: 50 } } }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_builds",
        arguments: { appId: ["1", "2"], limit: 50 },
      }),
    ) as { note?: string };

    expect(body.note).toBeUndefined();
  });
});
