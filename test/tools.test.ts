import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "../src/client/auth.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const baseConfig: Config = {
  keyId: "ABCD123456",
  issuerId: "69a6de70-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
  allowWrites: false,
  maxRetries: 3,
  tokenTtlSeconds: 1140,
  metadataRoot: "fastlane/metadata",
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const connect = async (
  config: Config,
  fetchImpl: typeof fetch = vi.fn(async () =>
    jsonResponse({ data: [] }),
  ) as unknown as typeof fetch,
): Promise<Client> => {
  const { server } = createServer({
    config,
    fetch: fetchImpl,
    tokenProvider: staticTokenProvider("jwt-token"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((t) => t.name).sort();

const callArgs = (fetchImpl: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] =>
  fetchImpl.mock.calls[index] as unknown as [string, RequestInit];

const patchCall = (fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit] | undefined =>
  fetchImpl.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH") as
    | [string, RequestInit]
    | undefined;

const postCall = (
  fetchImpl: ReturnType<typeof vi.fn>,
  path: string,
): [string, RequestInit] | undefined =>
  fetchImpl.mock.calls.find(
    (call) =>
      String(call[0]).includes(path) && (call[1] as RequestInit | undefined)?.method === "POST",
  ) as [string, RequestInit] | undefined;

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
      "app_store_connect_list_versions",
      "app_store_connect_list_review_submissions",
      "app_store_connect_list_app_infos",
      "app_store_connect_list_app_info_localizations",
      "app_store_connect_get_app_info_localization",
      "app_store_connect_export_listing",
      "app_store_connect_list_screenshot_sets",
      "app_store_connect_list_screenshots",
      "app_store_connect_get_screenshot",
      "app_store_connect_list_builds",
      "app_store_connect_list_beta_groups",
      "app_store_connect_list_beta_testers",
      "app_store_connect_list_beta_feedback",
      "app_store_connect_download_sales_report",
      "app_store_connect_download_finance_report",
      "app_store_connect_list_analytics_reports",
      "app_store_connect_list_users",
      "app_store_connect_list_bundle_ids",
      "app_store_connect_list_devices",
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
      "app_store_connect_submit_version_for_review",
      "app_store_connect_cancel_review_submission",
      "app_store_connect_update_app_info_localization",
      "app_store_connect_apply_listing",
      "app_store_connect_upload_screenshot",
      "app_store_connect_delete_screenshot",
      "app_store_connect_delete_screenshot_set",
      "app_store_connect_reorder_screenshots",
      "app_store_connect_invite_beta_tester",
      "app_store_connect_remove_tester_from_group",
      "app_store_connect_create_bundle_id",
      "app_store_connect_enable_capability",
      "app_store_connect_disable_capability",
      "app_store_connect_register_device",
      "app_store_connect_create_analytics_report_request",
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

describe("set_version_build", () => {
  const VERSION_ID = "01f7fc5e-fef8-49ec-b749-7849cdde3e51";
  const BUILD_ID = "0c15a960-b73d-4893-8788-cfbab4ca072b";

  const versionBody = (overrides: Record<string, unknown> = {}): unknown => ({
    data: {
      id: VERSION_ID,
      type: "appStoreVersions",
      attributes: {
        platform: "MAC_OS",
        versionString: "1.8.0",
        appStoreState: "PREPARE_FOR_SUBMISSION",
        ...overrides,
      },
      relationships: { app: { data: { id: "6753819990", type: "apps" } } },
    },
  });

  // `builds.attributes.version` is the build number (192); the marketing
  // version only arrives via the included preReleaseVersion.
  const buildBody = (
    overrides: Record<string, unknown> = {},
    preRelease: Record<string, unknown> = {},
    appId = "6753819990",
  ): unknown => ({
    data: {
      id: BUILD_ID,
      type: "builds",
      attributes: { version: "192", processingState: "VALID", expired: false, ...overrides },
      relationships: { app: { data: { id: appId, type: "apps" } } },
    },
    included: [
      {
        id: "pre-1",
        type: "preReleaseVersions",
        attributes: { version: "1.8.0", platform: "MAC_OS", ...preRelease },
      },
    ],
  });

  /** Route by URL: the happy path is two preflight GETs then the PATCH. */
  const routed = (version: unknown, build: unknown): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      if (url.includes("/v1/builds/")) return jsonResponse(build);
      if (url.includes("/appStoreVersions/")) return jsonResponse(version);
      return jsonResponse({ data: {} });
    });

  const callTool = async (
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name: "app_store_connect_set_version_build", arguments: args });
  };

  it("attaches a build with the build relationship", async () => {
    const fetchImpl = routed(versionBody(), buildBody());

    const result = await callTool({ versionId: VERSION_ID, buildId: BUILD_ID }, fetchImpl);

    expect(result.isError).toBeFalsy();
    const patch = patchCall(fetchImpl);
    expect(patch?.[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${VERSION_ID}`,
    );
    expect(JSON.parse(String(patch?.[1].body))).toEqual({
      data: {
        id: VERSION_ID,
        type: "appStoreVersions",
        relationships: { build: { data: { id: BUILD_ID, type: "builds" } } },
      },
    });
  });

  it("sideloads the preReleaseVersion when preflighting the build", async () => {
    const fetchImpl = routed(versionBody(), buildBody());

    await callTool({ versionId: VERSION_ID, buildId: BUILD_ID }, fetchImpl);

    const buildCall = fetchImpl.mock.calls.find((call) => String(call[0]).includes("/v1/builds/"));
    expect(new URL(String(buildCall?.[0])).searchParams.get("include")).toBe("preReleaseVersion");
  });

  it("detaches with a null relationship and never reads a build", async () => {
    const fetchImpl = routed(versionBody(), buildBody());

    const result = await callTool({ versionId: VERSION_ID, detach: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(patchCall(fetchImpl)?.[1].body)).data.relationships.build).toEqual({
      data: null,
    });
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/v1/builds/"))).toBe(
      false,
    );
  });

  it.each([
    [
      "a version past PREPARE_FOR_SUBMISSION",
      versionBody({ appStoreState: "READY_FOR_SALE" }),
      buildBody(),
      "READY_FOR_SALE",
    ],
    [
      "a still-processing build",
      versionBody(),
      buildBody({ processingState: "PROCESSING" }),
      "PROCESSING",
    ],
    ["an invalid build", versionBody(), buildBody({ processingState: "INVALID" }), "INVALID"],
    ["an expired build", versionBody(), buildBody({ expired: true }), "expired"],
    ["a build from another app", versionBody(), buildBody({}, {}, "9999999999"), "belongs to app"],
    ["a mismatched version string", versionBody(), buildBody({}, { version: "1.7.1" }), "1.7.1"],
    ["a mismatched platform", versionBody(), buildBody({}, { platform: "IOS" }), "IOS"],
  ])("refuses %s without issuing a PATCH", async (_label, version, build, expected) => {
    const fetchImpl = routed(version, build);

    const result = await callTool({ versionId: VERSION_ID, buildId: BUILD_ID }, fetchImpl);

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain(expected);
    expect(patchCall(fetchImpl)).toBeUndefined();
  });

  it("reports every failing precondition at once", async () => {
    const fetchImpl = routed(
      versionBody({ appStoreState: "READY_FOR_SALE" }),
      buildBody({ processingState: "PROCESSING", expired: true }),
    );

    const result = await callTool({ versionId: VERSION_ID, buildId: BUILD_ID }, fetchImpl);

    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("READY_FOR_SALE");
    expect(text).toContain("PROCESSING");
    expect(text).toContain("expired");
  });

  it.each([
    ["both buildId and detach", { versionId: VERSION_ID, buildId: BUILD_ID, detach: true }],
    ["neither buildId nor detach", { versionId: VERSION_ID }],
  ])("rejects %s before any request", async (_label, args) => {
    const fetchImpl = routed(versionBody(), buildBody());

    const result = await callTool(args, fetchImpl);

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("update_version", () => {
  const VERSION_ID = "01f7fc5e-fef8-49ec-b749-7849cdde3e51";
  const APP_ID = "6753819990";

  const routed = (appStoreState = "PREPARE_FOR_SUBMISSION"): ReturnType<typeof vi.fn> =>
    vi.fn(async () =>
      jsonResponse({
        data: {
          id: VERSION_ID,
          type: "appStoreVersions",
          attributes: { platform: "MAC_OS", versionString: "1.8.0", appStoreState },
        },
      }),
    );

  const callTool = async (
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
    name = "app_store_connect_update_version",
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  it("patches only releaseType and never touches relationships", async () => {
    const fetchImpl = routed();

    const result = await callTool({ versionId: VERSION_ID, releaseType: "MANUAL" }, fetchImpl);

    expect(result.isError).toBeFalsy();
    const patch = patchCall(fetchImpl);
    expect(patch?.[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${VERSION_ID}`,
    );
    expect(JSON.parse(String(patch?.[1].body))).toEqual({
      data: {
        id: VERSION_ID,
        type: "appStoreVersions",
        attributes: { releaseType: "MANUAL" },
      },
    });
  });

  it("sends both attributes for a scheduled release", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      {
        versionId: VERSION_ID,
        releaseType: "SCHEDULED",
        earliestReleaseDate: "2026-08-01T12:00:00-07:00",
      },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(patchCall(fetchImpl)?.[1].body)).data.attributes).toEqual({
      releaseType: "SCHEDULED",
      earliestReleaseDate: "2026-08-01T12:00:00-07:00",
    });
  });

  it.each([
    ["SCHEDULED without a date", { versionId: VERSION_ID, releaseType: "SCHEDULED" }],
    [
      "a date on a manual release",
      {
        versionId: VERSION_ID,
        releaseType: "MANUAL",
        earliestReleaseDate: "2026-08-01T12:00:00-07:00",
      },
    ],
    ["no updatable field", { versionId: VERSION_ID }],
  ])("rejects %s before any request", async (_label, args) => {
    const fetchImpl = routed();

    const result = await callTool(args, fetchImpl);

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a version past PREPARE_FOR_SUBMISSION without issuing a PATCH", async () => {
    const fetchImpl = routed("READY_FOR_SALE");

    const result = await callTool({ versionId: VERSION_ID, releaseType: "MANUAL" }, fetchImpl);

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("READY_FOR_SALE");
    expect(patchCall(fetchImpl)).toBeUndefined();
  });

  it("creates a version already set to manual release", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      { appId: APP_ID, versionString: "1.9.0", platform: "MAC_OS", releaseType: "MANUAL" },
      fetchImpl,
      "app_store_connect_create_version",
    );

    expect(result.isError).toBeFalsy();
    const post = postCall(fetchImpl, "/v1/appStoreVersions");
    expect(JSON.parse(String(post?.[1].body)).data.attributes).toEqual({
      platform: "MAC_OS",
      versionString: "1.9.0",
      releaseType: "MANUAL",
    });
  });
});

describe("submit_version_for_review", () => {
  const VERSION_ID = "01f7fc5e-fef8-49ec-b749-7849cdde3e51";
  const APP_ID = "6753819990";
  const SUBMISSION_ID = "sub-1";

  /**
   * Shaped like Apple's actual answer: `build` is always in `relationships`, but
   * the `app` key is absent entirely unless the request asked for it via
   * `include`. A fixture that handed back `app` unconditionally is what let the
   * first cut of this tool ship broken.
   */
  const versionBody = (
    attrs: Record<string, unknown> = {},
    relationships: Record<string, unknown> = {},
    withApp = false,
  ): unknown => ({
    data: {
      id: VERSION_ID,
      type: "appStoreVersions",
      attributes: {
        platform: "MAC_OS",
        versionString: "1.8.0",
        appStoreState: "PREPARE_FOR_SUBMISSION",
        ...attrs,
      },
      relationships: {
        build: { data: { id: "build-1", type: "builds" } },
        ...(withApp ? { app: { data: { id: APP_ID, type: "apps" } } } : {}),
        ...relationships,
      },
    },
  });

  const submission = (state: string): unknown => ({
    id: SUBMISSION_ID,
    type: "reviewSubmissions",
    attributes: { platform: "MAC_OS", state },
  });

  type Routes = {
    /** Receives whether the request asked to include the app relationship. */
    version?: (withApp: boolean) => unknown;
    /** Submissions already with Apple, keyed off the in-flight filter. */
    inFlight?: unknown[];
    /** Not-yet-submitted drafts to reuse. */
    drafts?: unknown[];
    items?: unknown[];
  };

  /** Route by URL, method and `filter[state]` — the two list GETs share a path. */
  const routed = (routes: Routes = {}): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const method = init?.method ?? "GET";
      const state = parsed.searchParams.get("filter[state]") ?? "";

      if (parsed.pathname.includes("/reviewSubmissions") && parsed.pathname.includes("/items")) {
        return jsonResponse({ data: routes.items ?? [] });
      }
      if (parsed.pathname.endsWith("/reviewSubmissions") && method === "GET") {
        const drafts = state === "READY_FOR_REVIEW";
        return jsonResponse({ data: (drafts ? routes.drafts : routes.inFlight) ?? [] });
      }
      if (parsed.pathname.endsWith("/reviewSubmissions") && method === "POST") {
        return jsonResponse({ data: submission("READY_FOR_REVIEW") });
      }
      if (parsed.pathname.includes("/appStoreVersions/")) {
        const withApp = (parsed.searchParams.get("include") ?? "").split(",").includes("app");
        return jsonResponse(routes.version?.(withApp) ?? versionBody({}, {}, withApp));
      }
      return jsonResponse({ data: submission("WAITING_FOR_REVIEW") });
    });

  const callTool = async (
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({
      name: "app_store_connect_submit_version_for_review",
      arguments: args,
    });
  };

  it("creates a submission, adds the version and submits it", async () => {
    const fetchImpl = routed();

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();

    const created = postCall(fetchImpl, "/v1/reviewSubmissions") as [string, RequestInit];
    expect(JSON.parse(String(created[1].body))).toEqual({
      data: {
        type: "reviewSubmissions",
        attributes: { platform: "MAC_OS" },
        relationships: { app: { data: { type: "apps", id: APP_ID } } },
      },
    });

    const item = postCall(fetchImpl, "/v1/reviewSubmissionItems") as [string, RequestInit];
    expect(JSON.parse(String(item[1].body)).data.relationships).toEqual({
      reviewSubmission: { data: { type: "reviewSubmissions", id: SUBMISSION_ID } },
      appStoreVersion: { data: { type: "appStoreVersions", id: VERSION_ID } },
    });

    const patch = patchCall(fetchImpl);
    expect(patch?.[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/reviewSubmissions/${SUBMISSION_ID}`,
    );
    expect(JSON.parse(String(patch?.[1].body)).data.attributes).toEqual({ submitted: true });
  });

  it("reuses an existing draft rather than creating a second one", async () => {
    const fetchImpl = routed({ drafts: [submission("READY_FOR_REVIEW")] });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(postCall(fetchImpl, "/v1/reviewSubmissions")).toBeUndefined();
    expect(postCall(fetchImpl, "/v1/reviewSubmissionItems")).toBeDefined();
  });

  it("skips the item when the draft already holds this version", async () => {
    const fetchImpl = routed({
      drafts: [submission("READY_FOR_REVIEW")],
      items: [
        {
          id: "item-1",
          type: "reviewSubmissionItems",
          relationships: {
            appStoreVersion: { data: { id: VERSION_ID, type: "appStoreVersions" } },
          },
        },
      ],
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(postCall(fetchImpl, "/v1/reviewSubmissionItems")).toBeUndefined();
    expect(patchCall(fetchImpl)).toBeDefined();
  });

  it("refuses without an explicit confirm", async () => {
    const fetchImpl = routed();

    const result = await callTool({ versionId: VERSION_ID }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Apple omits the `app` relationship unless asked, so deriving the app id from
  // a bare GET fails on every real version. Assert the include, not just that the
  // happy path works against a lenient fixture.
  it("asks Apple to include the app relationship", async () => {
    const fetchImpl = routed();

    await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    const versionCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).includes("/v1/appStoreVersions/"),
    );
    const include = new URL(String(versionCall?.[0])).searchParams.get("include") ?? "";
    expect(include.split(",")).toContain("app");
  });

  it("names the app relationship, not the platform, when the app id is missing", async () => {
    // Force the pre-fix shape: a response that never carries `app`.
    const fetchImpl = routed({ version: () => versionBody({}, {}, false) });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("app relationship");
    expect(text).not.toContain("carries no platform");
  });

  it.each([
    [
      "a version with no build attached",
      { version: (withApp: boolean) => versionBody({}, { build: { data: null } }, withApp) },
      "no build is attached",
    ],
    [
      "a version already past submission",
      {
        version: (withApp: boolean) =>
          versionBody({ appStoreState: "READY_FOR_SALE" }, {}, withApp),
      },
      "READY_FOR_SALE",
    ],
    [
      "an app whose submission is already with Apple",
      { inFlight: [submission("IN_REVIEW")] },
      "IN_REVIEW",
    ],
  ])("refuses %s without submitting", async (_label, routes, expected) => {
    const fetchImpl = routed(routes);

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain(expected);
    expect(patchCall(fetchImpl)).toBeUndefined();
    expect(postCall(fetchImpl, "/v1/reviewSubmissionItems")).toBeUndefined();
  });
});

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
});
