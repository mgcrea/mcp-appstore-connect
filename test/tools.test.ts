import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "#/client/auth";
import type { Config } from "#/config";
import { createServer } from "#/server";

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

/** Apple answers the report endpoints with a gzipped TSV, not JSON. */
const gzipResponse = (body: string): Response =>
  new Response(gzipSync(Buffer.from(body)), {
    status: 200,
    headers: { "content-type": "application/a-gzip" },
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

const deleteCall = (fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit] | undefined =>
  fetchImpl.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "DELETE") as
    | [string, RequestInit]
    | undefined;

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

/**
 * The parsed tool payload. Prefer this over matching `textOf` against a
 * serialized spelling: an assertion on `'"created": true'` pins the formatting
 * of the response rather than its content, and breaks the moment ok() stops
 * pretty-printing.
 */
const payloadOf = (result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> =>
  JSON.parse(textOf(result) || "{}") as Record<string, unknown>;

/** One draft submission item, linked to a version by relationship. */
const submissionItemFor = (versionId: string): unknown => ({
  id: "item-1",
  type: "reviewSubmissionItems",
  relationships: { appStoreVersion: { data: { id: versionId, type: "appStoreVersions" } } },
});

/** A one-segment `/segments` listing, with the attributes the test cares about. */
const segmentsBody = (attributes: Record<string, unknown>): unknown => ({
  data: [{ id: "seg-1", type: "analyticsReportSegments", attributes }],
});

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
      "app_store_connect_get_version",
      "app_store_connect_list_review_submissions",
      "app_store_connect_list_app_infos",
      "app_store_connect_list_app_info_localizations",
      "app_store_connect_get_app_info_localization",
      "app_store_connect_get_age_rating_declaration",
      "app_store_connect_export_listing",
      "app_store_connect_list_screenshot_sets",
      "app_store_connect_list_screenshots",
      "app_store_connect_get_screenshot",
      "app_store_connect_list_builds",
      "app_store_connect_list_beta_groups",
      "app_store_connect_list_beta_testers",
      "app_store_connect_list_beta_feedback",
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

const groupBody = (attributes: Record<string, unknown>): unknown => ({
  data: { id: "g-new", type: "betaGroups", attributes },
});

describe("create_beta_group", () => {
  const APP_ID = "6798236186";

  const connectWithWrites = async (fetchImpl: ReturnType<typeof vi.fn>): Promise<Client> =>
    connect({ ...baseConfig, allowWrites: true }, fetchImpl as unknown as typeof fetch);

  it("posts an internal group with the app relationship", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(groupBody({ name: "Internal", isInternalGroup: true })),
    );
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: { appId: APP_ID, name: "Internal", hasAccessToAllBuilds: true },
    });

    expect(result.isError).toBeFalsy();
    const call = postCall(fetchImpl, "/v1/betaGroups");
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body)) as {
      data: { attributes: Record<string, unknown>; relationships: Record<string, unknown> };
    };
    expect(body.data.attributes).toMatchObject({
      name: "Internal",
      isInternalGroup: true,
      hasAccessToAllBuilds: true,
    });
    expect(body.data.relationships).toEqual({
      app: { data: { type: "apps", id: APP_ID } },
    });
  });

  it("omits attributes that were not supplied", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupBody({ name: "Internal" })));
    const client = await connectWithWrites(fetchImpl);

    await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: { appId: APP_ID, name: "Internal" },
    });

    const body = JSON.parse(String(postCall(fetchImpl, "/v1/betaGroups")?.[1]?.body)) as {
      data: { attributes: Record<string, unknown> };
    };
    expect(body.data.attributes).not.toHaveProperty("hasAccessToAllBuilds");
    expect(body.data.attributes).not.toHaveProperty("publicLinkEnabled");
  });

  // The two cross-kind attributes are the easy mistake, and Apple's own error
  // names the field without saying which kind of group it belongs to.
  it("rejects a public link on an internal group before calling Apple", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupBody({ name: "Internal" })));
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: { appId: APP_ID, name: "Internal", publicLinkEnabled: true },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects hasAccessToAllBuilds on an external group before calling Apple", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupBody({ name: "Public" })));
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: {
        appId: APP_ID,
        name: "Public",
        isInternalGroup: false,
        hasAccessToAllBuilds: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("get_version", () => {
  const VERSION_ID = "3f3f8952-b1af-4704-8568-353fadf04d10";
  const BUILD_ID = "6befb88e-44c3-4230-a493-6bb43c11a078";

  const body = (attached: boolean): unknown => ({
    data: {
      id: VERSION_ID,
      type: "appStoreVersions",
      attributes: {
        platform: "MAC_OS",
        versionString: "1.3.0",
        appStoreState: "PREPARE_FOR_SUBMISSION",
      },
      relationships: {
        app: { data: { id: "6763524532", type: "apps" } },
        build: attached ? { data: { id: BUILD_ID, type: "builds" } } : { data: null },
      },
    },
    included: attached
      ? [
          {
            id: BUILD_ID,
            type: "builds",
            attributes: {
              version: "155",
              uploadedDate: "2026-08-03T13:46:17-07:00",
              processingState: "VALID",
              expired: false,
            },
          },
        ]
      : [],
  });

  const callTool = async (fetchImpl: ReturnType<typeof vi.fn>): ReturnType<Client["callTool"]> => {
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    return client.callTool({
      name: "app_store_connect_get_version",
      arguments: { versionId: VERSION_ID },
    });
  };

  it("resolves the attached build, which summarizeResponse would have dropped", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(body(true)));

    const result = await callTool(fetchImpl);

    // Without include=build Apple returns no `included`, and the whole point of
    // the tool is lost — assert the request, not just the response.
    expect(callArgs(fetchImpl)[0]).toContain("include=build");
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}")).toEqual({
      id: VERSION_ID,
      platform: "MAC_OS",
      versionString: "1.3.0",
      appStoreState: "PREPARE_FOR_SUBMISSION",
      appId: "6763524532",
      build: {
        id: BUILD_ID,
        version: "155",
        uploadedDate: "2026-08-03T13:46:17-07:00",
        processingState: "VALID",
        expired: false,
      },
    });
  });

  it("reports a version with no build attached as null rather than omitting it", async () => {
    const result = await callTool(vi.fn(async () => jsonResponse(body(false))));

    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}").build).toBeNull();
  });

  it("still returns the build id when Apple sideloads no build resource", async () => {
    const withoutInclude = body(true) as { included: unknown[] };
    withoutInclude.included = [];

    const result = await callTool(vi.fn(async () => jsonResponse(withoutInclude)));

    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}").build).toEqual({
      id: BUILD_ID,
    });
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

describe("age rating declaration", () => {
  const APP_INFO_ID = "63998931-e8e1-440e-b295-e2f37df48917";
  const DECLARATION_ID = "a1b2c3d4-0000-4000-8000-000000000001";

  const routed = (): ReturnType<typeof vi.fn> =>
    vi.fn(async () =>
      jsonResponse({
        data: {
          id: DECLARATION_ID,
          type: "ageRatingDeclarations",
          attributes: { socialMedia: null, userGeneratedContent: false },
        },
      }),
    );

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  it("reads the declaration through appInfos, not appStoreVersions", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_get_age_rating_declaration",
      { appInfoId: APP_INFO_ID },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(callArgs(fetchImpl)[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/appInfos/${APP_INFO_ID}/ageRatingDeclaration`,
    );
    // The id the update tool takes has to survive the summarizer.
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain(DECLARATION_ID);
  });

  it("patches only the answers it was given", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_update_age_rating_declaration",
      { declarationId: DECLARATION_ID, socialMedia: false },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const patch = patchCall(fetchImpl);
    expect(patch?.[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/ageRatingDeclarations/${DECLARATION_ID}`,
    );
    expect(JSON.parse(String(patch?.[1].body))).toEqual({
      data: {
        id: DECLARATION_ID,
        type: "ageRatingDeclarations",
        attributes: { socialMedia: false },
      },
    });
  });

  it("sends a null kidsAgeBand rather than dropping it", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_update_age_rating_declaration",
      { declarationId: DECLARATION_ID, kidsAgeBand: null },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(patchCall(fetchImpl)?.[1].body)).data.attributes).toEqual({
      kidsAgeBand: null,
    });
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

describe("in-app purchase pricing", () => {
  const IAP_ID = "6f4d2c1a-0000-4000-8000-000000000001";
  const PRICE_POINT_ID = "eyJzIjoiNjc0NCIsInQiOiJVU0EiLCJwIjoiMTAwMDgifQ";

  const pricePointsBody = (): unknown => ({
    data: [
      {
        id: PRICE_POINT_ID,
        type: "inAppPurchasePricePoints",
        attributes: { customerPrice: "4.99", proceeds: "3.49" },
      },
      {
        id: "other-point",
        type: "inAppPurchasePricePoints",
        attributes: { customerPrice: "9.99", proceeds: "6.99" },
      },
    ],
  });

  /** Price-point lookups are the preflight; the POST is the schedule create. */
  const routed = (points: unknown = pricePointsBody()): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      if (String(url).includes("/pricePoints")) return jsonResponse(points);
      return jsonResponse({ data: { id: "sched-1", type: "inAppPurchasePriceSchedules" } });
    });

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  it("builds the inline-create schedule and echoes the price it set", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_set_in_app_purchase_price",
      {
        inAppPurchaseId: IAP_ID,
        pricePointId: PRICE_POINT_ID,
        baseTerritory: "USA",
        confirm: true,
      },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const post = postCall(fetchImpl, "/v1/inAppPurchasePriceSchedules");
    const body = JSON.parse(String(post?.[1].body));

    // The placeholder in manualPrices must match the included price's id, or
    // Apple resolves the relationship to nothing.
    const placeholder = body.data.relationships.manualPrices.data[0].id;
    expect(body.included[0].id).toBe(placeholder);
    expect(body.data.relationships.inAppPurchase.data).toEqual({
      type: "inAppPurchases",
      id: IAP_ID,
    });
    expect(body.data.relationships.baseTerritory.data).toEqual({
      type: "territories",
      id: "USA",
    });
    expect(body.included[0].relationships.inAppPurchasePricePoint.data).toEqual({
      type: "inAppPurchasePricePoints",
      id: PRICE_POINT_ID,
    });
    // startDate omitted means "now" — it must not be sent as null.
    expect(body.included[0].attributes).toEqual({});

    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text).priced).toEqual({
      pricePointId: PRICE_POINT_ID,
      baseTerritory: "USA",
      customerPrice: "4.99",
      proceeds: "3.49",
      startDate: "immediate",
    });
  });

  it("passes start and end dates through as attributes", async () => {
    const fetchImpl = routed();

    await callTool(
      "app_store_connect_set_in_app_purchase_price",
      {
        inAppPurchaseId: IAP_ID,
        pricePointId: PRICE_POINT_ID,
        baseTerritory: "USA",
        startDate: "2026-09-01",
        endDate: "2026-12-31",
        confirm: true,
      },
      fetchImpl,
    );

    const body = JSON.parse(
      String(postCall(fetchImpl, "/v1/inAppPurchasePriceSchedules")?.[1].body),
    );
    expect(body.included[0].attributes).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-12-31",
    });
  });

  it("refuses a price point from another territory without pricing anything", async () => {
    // The IAP's USA catalogue simply does not contain the requested id.
    const fetchImpl = routed({ data: [] });

    const result = await callTool(
      "app_store_connect_set_in_app_purchase_price",
      {
        inAppPurchaseId: IAP_ID,
        pricePointId: PRICE_POINT_ID,
        baseTerritory: "USA",
        confirm: true,
      },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain(PRICE_POINT_ID);
    expect(postCall(fetchImpl, "/v1/inAppPurchasePriceSchedules")).toBeUndefined();
  });

  it("requires confirm before changing a price", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_set_in_app_purchase_price",
      { inAppPurchaseId: IAP_ID, pricePointId: PRICE_POINT_ID, baseTerritory: "USA" },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("filters price points by territory", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_list_iap_price_points",
      { inAppPurchaseId: IAP_ID, territory: "FRA" },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const url = new URL(String(callArgs(fetchImpl)[0]));
    expect(url.pathname).toBe(`/v2/inAppPurchases/${IAP_ID}/pricePoints`);
    expect(url.searchParams.get("filter[territory]")).toBe("FRA");
  });

  it("flattens the price schedule's sideloaded prices", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/manualPrices")
        ? jsonResponse({
            data: [
              {
                id: "price-1",
                type: "inAppPurchasePrices",
                attributes: { startDate: "2026-09-01", endDate: null, manual: true },
                relationships: {
                  territory: { data: { id: "USA", type: "territories" } },
                  inAppPurchasePricePoint: {
                    data: { id: PRICE_POINT_ID, type: "inAppPurchasePricePoints" },
                  },
                },
              },
            ],
            included: [
              {
                id: PRICE_POINT_ID,
                type: "inAppPurchasePricePoints",
                attributes: { customerPrice: "4.99", proceeds: "3.49" },
              },
              { id: "USA", type: "territories", attributes: { currency: "USD" } },
            ],
          })
        : jsonResponse({
            data: {
              id: "sched-1",
              type: "inAppPurchasePriceSchedules",
              relationships: { baseTerritory: { data: { id: "USA", type: "territories" } } },
            },
          }),
    );

    const result = await callTool(
      "app_store_connect_get_iap_price_schedule",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}")).toEqual({
      scheduleId: "sched-1",
      baseTerritory: "USA",
      manualPrices: [
        {
          id: "price-1",
          startDate: "2026-09-01",
          endDate: null,
          manual: true,
          territory: "USA",
          pricePointId: PRICE_POINT_ID,
          customerPrice: "4.99",
          proceeds: "3.49",
        },
      ],
    });

    // Same 400 as the app-side schedule: /v2/inAppPurchases/{id}/iapPriceSchedule
    // takes only baseTerritory / manualPrices / automaticPrices, so the price
    // point can only be sideloaded on the schedule's own manualPrices endpoint.
    const includes = fetchImpl.mock.calls.map(
      (call) => new URL(String(call[0])).searchParams.get("include") ?? "",
    );
    expect(includes.every((include) => !include.includes("."))).toBe(true);
    expect(includes[1]).toBe("inAppPurchasePricePoint,territory");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      "/v1/inAppPurchasePriceSchedules/sched-1/manualPrices",
    );
  });

  it("reports an unpriced IAP as an empty price list", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/manualPrices")
        ? jsonResponse({ data: [] })
        : jsonResponse({ data: { id: "sched-1", type: "inAppPurchasePriceSchedules" } }),
    );

    const result = await callTool(
      "app_store_connect_get_iap_price_schedule",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(
      JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}").manualPrices,
    ).toEqual([]);
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
    /** Submissions Apple rejected and handed back (UNRESOLVED_ISSUES). */
    returned?: unknown[];
    items?: unknown[];
  };

  /** Route by URL, method and `filter[state]` — the three list GETs share a path. */
  const routed = (routes: Routes = {}): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const method = init?.method ?? "GET";
      const state = parsed.searchParams.get("filter[state]") ?? "";

      if (parsed.pathname.includes("/reviewSubmissions") && parsed.pathname.includes("/items")) {
        return jsonResponse({ data: routes.items ?? [] });
      }
      if (parsed.pathname.endsWith("/reviewSubmissions") && method === "GET") {
        if (state === "READY_FOR_REVIEW") return jsonResponse({ data: routes.drafts ?? [] });
        if (state === "UNRESOLVED_ISSUES") return jsonResponse({ data: routes.returned ?? [] });
        return jsonResponse({ data: routes.inFlight ?? [] });
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

  /**
   * Adding the item IS the preflight — Apple adjudicates readiness there and answers an
   * unready version with the full list of what is unset — so a dry run has to go that far and
   * then stop. What it must never do is PATCH `submitted: true`.
   */
  it("dryRun adds the version to the draft but never hands it to Apple", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      { versionId: VERSION_ID, dryRun: true, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(postCall(fetchImpl, "/v1/reviewSubmissionItems")).toBeDefined();
    expect(patchCall(fetchImpl)).toBeUndefined();
  });

  /** An item already on the draft, which is what `containsVersion` matches on. */
  const stagedItem = {
    id: "item-1",
    type: "reviewSubmissionItems",
    relationships: { appStoreVersion: { data: { id: VERSION_ID, type: "appStoreVersions" } } },
  };

  /**
   * The bug this guards: staging moves the version to READY_FOR_REVIEW, which is not a
   * submittable state, so the state guard used to refuse every call after the first — and
   * since `dryRun` always stages, its own preflight locked the caller out of finishing.
   * Nothing else in the server can submit an existing draft, so the submission was stranded.
   */
  it("resumes a version already staged on the app's own draft", async () => {
    const fetchImpl = routed({
      version: (withApp) => versionBody({ appStoreState: "READY_FOR_REVIEW" }, {}, withApp),
      drafts: [submission("READY_FOR_REVIEW")],
      items: [stagedItem],
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    // The item is already there; adding it again is what Apple 409s on.
    expect(postCall(fetchImpl, "/v1/reviewSubmissionItems")).toBeUndefined();
    const patch = patchCall(fetchImpl);
    expect(patch?.[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/reviewSubmissions/${SUBMISSION_ID}`,
    );
    expect(JSON.parse(String(patch?.[1].body)).data.attributes).toEqual({ submitted: true });
    expect(JSON.parse(textOf(result)).resumedDraft).toBe(true);
  });

  it("dryRun on an already-staged version reports it without submitting", async () => {
    const fetchImpl = routed({
      version: (withApp) => versionBody({ appStoreState: "READY_FOR_REVIEW" }, {}, withApp),
      drafts: [submission("READY_FOR_REVIEW")],
      items: [stagedItem],
    });

    const result = await callTool(
      { versionId: VERSION_ID, dryRun: true, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(patchCall(fetchImpl)).toBeUndefined();
    expect(JSON.parse(textOf(result)).submitted).toBe(false);
  });

  /**
   * The resubmit branch used to ignore `dryRun` outright, so a preflight against a rejected
   * submission resolved its items and handed it back to Apple for real — the exact thing the
   * flag exists to prevent, on the one branch where it is least recoverable.
   */
  it("dryRun never resubmits a rejected submission", async () => {
    const fetchImpl = routed({
      returned: [submission("UNRESOLVED_ISSUES")],
      items: [{ id: "item-1", type: "reviewSubmissionItems", attributes: { state: "REJECTED" } }],
    });

    const result = await callTool(
      { versionId: VERSION_ID, dryRun: true, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(patchCall(fetchImpl)).toBeUndefined();
    const body = JSON.parse(textOf(result));
    expect(body.submitted).toBe(false);
    expect(body.wouldResolveItems).toBe(1);
  });

  /**
   * The path back after a rejection. Cancelling and starting clean is the
   * expensive wrong answer: it forfeits the queue position and restarts the
   * review of anything else riding along, so the same submission has to go back.
   */
  it("resubmits a rejected submission instead of creating a new one", async () => {
    const fetchImpl = routed({
      returned: [submission("UNRESOLVED_ISSUES")],
      items: [
        { id: "item-version", type: "reviewSubmissionItems", attributes: { state: "REJECTED" } },
        {
          id: "item-iap",
          type: "reviewSubmissionItems",
          attributes: { state: "READY_FOR_REVIEW" },
        },
      ],
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(postCall(fetchImpl, "/v1/reviewSubmissions")).toBeUndefined();
    expect(postCall(fetchImpl, "/v1/reviewSubmissionItems")).toBeUndefined();

    const patches = fetchImpl.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
    ) as [string, RequestInit][];

    // Only the rejected item is resolved. The one still READY_FOR_REVIEW is an
    // in-app purchase Apple had already started on, and touching it would send
    // it back to the start.
    const resolved = patches.filter(([url]) => url.includes("/reviewSubmissionItems/"));
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.[0]).toContain("/reviewSubmissionItems/item-version");
    expect(JSON.parse(String(resolved[0]?.[1].body)).data.attributes).toEqual({ resolved: true });

    const submit = patches.find(([url]) => url.endsWith(`/reviewSubmissions/${SUBMISSION_ID}`));
    expect(JSON.parse(String(submit?.[1].body)).data.attributes).toEqual({ submitted: true });
  });

  it("refuses to resubmit when the rejected submission holds another version", async () => {
    const fetchImpl = routed({
      returned: [
        {
          ...(submission("UNRESOLVED_ISSUES") as Record<string, unknown>),
          relationships: {
            appStoreVersionForReview: {
              data: { id: "some-other-version", type: "appStoreVersions" },
            },
          },
        },
      ],
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain("different version");
    expect(patchCall(fetchImpl)).toBeUndefined();
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

/**
 * The other half of the staging trap. `submit_version_for_review` learned to
 * *resume* a draft its own dryRun staged; this is how a caller backs out of one
 * instead, which is the only route to changing the build afterwards:
 *
 *   - `set_version_build` refuses a READY_FOR_REVIEW version, attach and detach alike
 *   - `cancel_review_submission` 409s on a draft — it was never with Apple
 *
 * Before this tool those two dead ends left the web UI as the only way out.
 */
describe("remove_version_from_submission", () => {
  const VERSION_ID = "01f7fc5e-fef8-49ec-b749-7849cdde3e51";
  const APP_ID = "6753819990";
  const SUBMISSION_ID = "sub-1";

  const versionBody = (attrs: Record<string, unknown> = {}, withApp = true): unknown => ({
    data: {
      id: VERSION_ID,
      type: "appStoreVersions",
      attributes: {
        platform: "MAC_OS",
        versionString: "1.2.1",
        appStoreState: "READY_FOR_REVIEW",
        ...attrs,
      },
      relationships: withApp ? { app: { data: { id: APP_ID, type: "apps" } } } : {},
    },
  });

  const draft = {
    id: SUBMISSION_ID,
    type: "reviewSubmissions",
    attributes: { platform: "MAC_OS", state: "READY_FOR_REVIEW" },
  };

  type Routes = {
    version?: unknown;
    /** Successive `/appStoreVersions/` reads: staged first, then post-delete. */
    versionAfter?: unknown;
    drafts?: unknown[];
    items?: unknown[];
    /** Report the version only in `included`, never on an item relationship. */
    sideloadVersion?: boolean;
  };

  const routed = (routes: Routes = {}): ReturnType<typeof vi.fn> => {
    let versionReads = 0;
    return vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const method = init?.method ?? "GET";

      if (parsed.pathname.includes("/reviewSubmissionItems/") && method === "DELETE") {
        return jsonResponse({});
      }
      if (parsed.pathname.includes("/reviewSubmissions") && parsed.pathname.includes("/items")) {
        return jsonResponse({
          data: routes.items ?? [submissionItemFor(VERSION_ID)],
          ...(routes.sideloadVersion === true
            ? { included: [{ id: VERSION_ID, type: "appStoreVersions" }] }
            : {}),
        });
      }
      if (parsed.pathname.endsWith("/reviewSubmissions")) {
        return jsonResponse({ data: routes.drafts ?? [draft] });
      }
      if (parsed.pathname.includes("/appStoreVersions/")) {
        versionReads += 1;
        if (versionReads > 1 && routes.versionAfter !== undefined) {
          return jsonResponse(routes.versionAfter);
        }
        return jsonResponse(routes.version ?? versionBody());
      }
      return jsonResponse({ data: [] });
    });
  };

  const callTool = async (
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({
      name: "app_store_connect_remove_version_from_submission",
      arguments: args,
    });
  };

  it("deletes the staged item and reports the version editable again", async () => {
    const fetchImpl = routed({
      versionAfter: versionBody({ appStoreState: "PREPARE_FOR_SUBMISSION" }),
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(deleteCall(fetchImpl)?.[0]).toContain("/v1/reviewSubmissionItems/item-1");

    const body = JSON.parse(textOf(result));
    expect(body.removedItem).toBe("item-1");
    expect(body.submissionId).toBe(SUBMISSION_ID);
    // The point of the whole tool: set_version_build will now be accepted.
    expect(body.appStoreState).toBe("PREPARE_FOR_SUBMISSION");
  });

  // Same reason submit_version_for_review has to ask: Apple omits `app` from a
  // bare GET, and without it the app's drafts cannot be listed at all.
  it("asks Apple to include the app relationship", async () => {
    const fetchImpl = routed();

    await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    const versionCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).includes("/v1/appStoreVersions/"),
    );
    const include = new URL(String(versionCall?.[0])).searchParams.get("include") ?? "";
    expect(include.split(",")).toContain("app");
  });

  it("refuses a version that is not staged, and names the state", async () => {
    const fetchImpl = routed({ version: versionBody({ appStoreState: "PREPARE_FOR_SUBMISSION" }) });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PREPARE_FOR_SUBMISSION");
    expect(deleteCall(fetchImpl)).toBeUndefined();
  });

  /**
   * Staged, but the draft holding it is gone — the submission went to Apple. The
   * fix is a withdrawal, not a delete, and saying so is the difference between a
   * one-line redirect and a hunt through the API docs.
   */
  it("points at cancel_review_submission when no draft holds the version", async () => {
    const fetchImpl = routed({ drafts: [] });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("app_store_connect_cancel_review_submission");
    expect(deleteCall(fetchImpl)).toBeUndefined();
  });

  /**
   * The version is provably on the draft — but only as a sideloaded resource, so
   * no item id can be tied to it. Deleting the single item present would look
   * right and could drop a first in-app purchase out of review, so refuse.
   */
  it("refuses rather than guessing when no item names the version", async () => {
    // The version is provably present, but only in `included` — the sideload path
    // `containsVersion` accepts. The one item on the draft names a different
    // version, so there is nothing safe to delete.
    const fetchImpl = routed({
      items: [submissionItemFor("some-other-version")],
      sideloadVersion: true,
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cannot be identified");
    expect(deleteCall(fetchImpl)).toBeUndefined();
  });

  it("refuses without an explicit confirm", async () => {
    const fetchImpl = routed();

    const result = await callTool({ versionId: VERSION_ID }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("release_version", () => {
  const VERSION_ID = "01f7fc5e-fef8-49ec-b749-7849cdde3e51";

  const routed = (appStoreState = "PENDING_DEVELOPER_RELEASE"): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return jsonResponse({ data: { id: "rel-1", type: "appStoreVersionReleaseRequests" } });
      }
      return jsonResponse({
        data: {
          id: VERSION_ID,
          type: "appStoreVersions",
          attributes: { versionString: "1.8.0", appStoreState },
        },
      });
    });

  const callTool = async (
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name: "app_store_connect_release_version", arguments: args });
  };

  it("posts a release request for a version pending developer release", async () => {
    const fetchImpl = routed();

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    const posted = postCall(fetchImpl, "/v1/appStoreVersionReleaseRequests") as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(posted[1].body))).toEqual({
      data: {
        type: "appStoreVersionReleaseRequests",
        relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: VERSION_ID } },
        },
      },
    });
  });

  it("refuses without an explicit confirm", async () => {
    const fetchImpl = routed();

    const result = await callTool({ versionId: VERSION_ID }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["READY_FOR_SALE", "already READY_FOR_SALE"],
    ["PENDING_APPLE_RELEASE", "nothing to release by hand"],
    ["WAITING_FOR_REVIEW", "only a version Apple has approved"],
  ])("refuses a %s version without posting", async (state, expected) => {
    const fetchImpl = routed(state);

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain(expected);
    expect(postCall(fetchImpl, "/v1/appStoreVersionReleaseRequests")).toBeUndefined();
  });
});

describe("customer reviews", () => {
  const APP_ID = "1234567890";

  it("lists newest-first and comma-joins the rating filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID, rating: [1, 2], territory: "FRA" },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/apps/${APP_ID}/customerReviews`);
    // JSON:API takes a comma-joined list here, not repeated keys.
    expect(url.searchParams.get("filter[rating]")).toBe("1,2");
    expect(url.searchParams.get("filter[territory]")).toBe("FRA");
    expect(url.searchParams.get("sort")).toBe("-createdDate");
  });

  it("omits the answered filter entirely when it is not asked for", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.searchParams.has("exists[publishedResponse]")).toBe(false);
    expect(url.searchParams.has("filter[rating]")).toBe(false);
  });

  it("passes answered:false through as the unanswered filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID, answered: false },
    });

    // `compact` drops undefined, not false — a `false` here is a real filter.
    expect(new URL(callArgs(fetchImpl)[0]).searchParams.get("exists[publishedResponse]")).toBe(
      "false",
    );
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

    const result = await client.callTool({
      name: "app_store_connect_download_sales_report",
      arguments: { reportDate: "2026-08-09", frequency: "WEEKLY", vendorNumber: "85326407" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    // Names the period asked for, so the message is not generic.
    expect(text).toContain("WEEKLY 2026-08-09");
    // Says this is an answer, and clears the credentials it would otherwise implicate.
    expect(text).toContain("not a fault");
    // The disambiguation that stops a lag being written down as zero.
    expect(text).toContain("DAILY");
    expect(text).toContain("must not be reported as zero");
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

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("fiscal 2026-07 in region US");
    expect(text).toContain("not a fault");
    // The checks that do apply here: publication lag, region, fiscal calendar.
    expect(text).toContain("regionCode ZZ");
    expect(text).toContain("4-4-5");
    // And not the one that does not.
    expect(text).not.toContain("DAILY");
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

      expect(body.truncated).toBe(true);
      expect(await readFile(savePath, "utf8")).toBe(SALES_TSV);
      expect(body.saved).toMatchObject({ dataRows: 3 });
      expect(String(body.savedNote)).toContain("all 3 data rows");
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

const analyticsRequest = (id: string, accessType: string): unknown => ({
  id,
  type: "analyticsReportRequests",
  attributes: { accessType, stoppedDueToInactivity: false },
});
const analyticsReport = (id: string, category: string): unknown => ({
  id,
  type: "analyticsReports",
  attributes: { name: `Report ${id}`, category },
});
const analyticsInstance = (id: string, processingDate: string): unknown => ({
  id,
  type: "analyticsReportInstances",
  attributes: { granularity: "DAILY", processingDate },
});

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
    expect(body.truncated).toBe(false);
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
    expect(body.truncated).toBe(true);
    expect(body.report.split("\n")).toHaveLength(5);
  });

  /**
   * Apple terminates every report with a newline, so splitting on it leaves a
   * phantom empty line. Counting that line used to flag a complete report as
   * truncated the moment its real content reached `maxLines` exactly. Nothing
   * downstream shrugs that off: report_stats.py treats `truncated` as a hard
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
    expect(body.truncated).toBe(false);
    expect(body.rows).toBe(3); // content lines, not the phantom blank
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

describe("in-app purchase metadata", () => {
  const IAP_ID = "6f4d2c1a-0000-4000-8000-000000000001";
  const LOC_ID = "1a2b3c4d-0000-4000-8000-000000000002";

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  const okFetch = (body: unknown = { data: { id: LOC_ID, type: "inAppPurchaseLocalizations" } }) =>
    vi.fn(async () => jsonResponse(body));

  it("patches familySharable onto the v2 resource", async () => {
    const fetchImpl = okFetch({ data: { id: IAP_ID, type: "inAppPurchases" } });

    const result = await callTool(
      "app_store_connect_update_in_app_purchase",
      { inAppPurchaseId: IAP_ID, familySharable: true, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const patch = patchCall(fetchImpl);
    expect(new URL(String(patch?.[0])).pathname).toBe(`/v2/inAppPurchases/${IAP_ID}`);
    const body = JSON.parse(String(patch?.[1].body));
    expect(body.data.type).toBe("inAppPurchases");
    expect(body.data.attributes).toEqual({ familySharable: true });
    // `confirm` is a gate, not an attribute — sending it would 409.
    expect(body.data.attributes.confirm).toBeUndefined();
  });

  it("creates a localization through the inAppPurchaseV2 relationship", async () => {
    const fetchImpl = okFetch();

    const result = await callTool(
      "app_store_connect_create_iap_localization",
      {
        inAppPurchaseId: IAP_ID,
        locale: "en-US",
        name: "Cadence Pro",
        description: "Every engine, batch queue and export.",
        confirm: true,
      },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(
      String(postCall(fetchImpl, "/v1/inAppPurchaseLocalizations")?.[1].body),
    );
    expect(body.data.type).toBe("inAppPurchaseLocalizations");
    expect(body.data.attributes).toEqual({
      name: "Cadence Pro",
      locale: "en-US",
      description: "Every engine, batch queue and export.",
    });
    // The relationship key is `inAppPurchaseV2`; `inAppPurchase` is rejected.
    expect(body.data.relationships.inAppPurchaseV2.data).toEqual({
      type: "inAppPurchases",
      id: IAP_ID,
    });
  });

  it("refuses an over-length name before calling Apple", async () => {
    const fetchImpl = okFetch();

    const result = await callTool(
      "app_store_connect_create_iap_localization",
      { inAppPurchaseId: IAP_ID, locale: "en-US", name: "x".repeat(31), confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("30-character");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an over-length description before calling Apple", async () => {
    const fetchImpl = okFetch();

    const result = await callTool(
      "app_store_connect_update_iap_localization",
      { localizationId: LOC_ID, description: "y".repeat(46), confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("45-character");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to submit an IAP that is still MISSING_METADATA", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { id: IAP_ID, type: "inAppPurchases", attributes: { state: "MISSING_METADATA" } },
      }),
    );

    const result = await callTool(
      "app_store_connect_submit_in_app_purchase_for_review",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("MISSING_METADATA");
    expect(postCall(fetchImpl, "/v1/inAppPurchaseSubmissions")).toBeUndefined();
  });

  it("submits an IAP that is READY_TO_SUBMIT", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ data: { id: "sub-1", type: "inAppPurchaseSubmissions" } });
      }
      return jsonResponse({
        data: { id: IAP_ID, type: "inAppPurchases", attributes: { state: "READY_TO_SUBMIT" } },
      });
    });

    const result = await callTool(
      "app_store_connect_submit_in_app_purchase_for_review",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(String(postCall(fetchImpl, "/v1/inAppPurchaseSubmissions")?.[1].body));
    expect(body.data.relationships.inAppPurchaseV2.data.id).toBe(IAP_ID);
  });
});

describe("in-app purchase availability", () => {
  const IAP_ID = "6f4d2c1a-0000-4000-8000-000000000001";

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  it("reports data:null when availability has never been set", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: null }));

    const result = await callTool(
      "app_store_connect_get_iap_availability",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(payloadOf(result).data).toBeNull();
  });

  it("resolves every territory when none are named", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ data: { id: "avail-1", type: "inAppPurchaseAvailabilities" } });
      }
      return jsonResponse({
        data: [
          { id: "USA", type: "territories" },
          { id: "FRA", type: "territories" },
        ],
      });
    });

    const result = await callTool(
      "app_store_connect_set_iap_availability",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(
      String(postCall(fetchImpl, "/v1/inAppPurchaseAvailabilities")?.[1].body),
    );
    // This endpoint uses `inAppPurchase`, unlike the localization and submission
    // endpoints which use `inAppPurchaseV2`.
    expect(body.data.relationships.inAppPurchase.data).toEqual({
      type: "inAppPurchases",
      id: IAP_ID,
    });
    expect(body.data.relationships.availableTerritories.data).toEqual([
      { type: "territories", id: "USA" },
      { type: "territories", id: "FRA" },
    ]);
    expect(body.data.attributes.availableInNewTerritories).toBe(true);
  });

  it("reads a never-set availability 404 as 'not set', not an error", async () => {
    // Apple 404s a to-one sub-resource that was never created, and names the
    // PARENT's id in the message — raw, that reads as a broken request.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errors: [
              {
                status: "404",
                code: "NOT_FOUND",
                detail:
                  "There is no resource of type 'inAppPurchaseAvailabilities' with id '" +
                  IAP_ID +
                  "'",
              },
            ],
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await callTool(
      "app_store_connect_get_iap_availability",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("never been set");
  });

  it("refuses to make an IAP available nowhere", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    const result = await callTool(
      "app_store_connect_set_iap_availability",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("available nowhere");
    expect(postCall(fetchImpl, "/v1/inAppPurchaseAvailabilities")).toBeUndefined();
  });
});

// The five gates a first submission trips over live on the app and the appInfo,
// not on the version — so nothing in the version's own state hints at them, and
// Apple reports each one against a resource path with no id to chase.
const notFound = (): Response =>
  new Response(JSON.stringify({ errors: [{ status: "404", code: "NOT_FOUND" }] }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

const bodyOf = (init: RequestInit | undefined): Record<string, unknown> =>
  JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

describe("submission prerequisites", () => {
  const APP_ID = "6798236186";
  const VERSION_ID = "437e7c81-a74a-4aca-ab17-c26bad76fc67";

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  describe("set_app_store_review_detail", () => {
    // PATCH against a version with no detail 404s and POST against one that has
    // it 409s, so picking the verb is a property of server state. Getting this
    // wrong is the whole reason the tool exists rather than two thinner ones.
    it("creates the detail when the version has none", async () => {
      // Matched on method, not path: the lookup GET ends in
      // `/appStoreReviewDetail` and the create POST goes to
      // `/appStoreReviewDetails`, so a substring match on the former also
      // swallows the latter and the create 404s too.
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? notFound()
          : jsonResponse({ data: { id: "rd-1", type: "appStoreReviewDetails" } }),
      );

      const result = await callTool(
        "app_store_connect_set_app_store_review_detail",
        { versionId: VERSION_ID, contactEmail: "dev@example.com", demoAccountRequired: false },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      expect(payloadOf(result).created).toBe(true);

      const post = postCall(fetchImpl, "/v1/appStoreReviewDetails");
      expect(post).toBeDefined();
      const data = bodyOf(post?.[1]).data as Record<string, unknown>;
      expect((data.attributes as Record<string, unknown>).contactEmail).toBe("dev@example.com");
      // demoAccountRequired: false must survive `compact`, which drops undefined
      // and must not drop a meaningful false.
      expect((data.attributes as Record<string, unknown>).demoAccountRequired).toBe(false);
      expect(data.relationships).toEqual({
        appStoreVersion: { data: { type: "appStoreVersions", id: VERSION_ID } },
      });
    });

    it("patches the existing detail instead of creating a second one", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ data: { id: "rd-existing", type: "appStoreReviewDetails" } }),
      );

      const result = await callTool(
        "app_store_connect_set_app_store_review_detail",
        { versionId: VERSION_ID, notes: "No account needed." },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      expect(payloadOf(result).created).toBe(false);
      expect(postCall(fetchImpl, "/v1/appStoreReviewDetails")).toBeUndefined();

      const patch = patchCall(fetchImpl);
      expect(patch?.[0]).toContain("/v1/appStoreReviewDetails/rd-existing");
    });

    it("reports a missing detail as null rather than a 404", async () => {
      const fetchImpl = vi.fn(async () => notFound());

      const result = await callTool(
        "app_store_connect_get_app_store_review_detail",
        { versionId: VERSION_ID },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("cannot be submitted");
    });
  });

  // The contact is the same person for every app and every version, so it lives
  // in config.json. What matters is that "configured default" never turns into
  // "silently rewrites App Store Connect".
  describe("set_app_store_review_detail contact defaults", () => {
    const CONTACT = {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      phone: "+33 1 23 45 67 89",
    };

    const callWithContact = async (
      args: Record<string, unknown>,
      fetchImpl: ReturnType<typeof vi.fn>,
      // `null` means "configure no contact at all" — a default parameter cannot
      // express that, since passing undefined re-applies the default.
      contact: Record<string, string> | null = CONTACT,
    ): ReturnType<Client["callTool"]> => {
      const client = await connect(
        { ...baseConfig, allowWrites: true, ...(contact ? { contact } : {}) },
        fetchImpl as unknown as typeof fetch,
      );
      return client.callTool({
        name: "app_store_connect_set_app_store_review_detail",
        arguments: args,
      });
    };

    /** A version whose review detail exists, with the attributes under test. */
    const existing = (attributes: Record<string, unknown>): ReturnType<typeof vi.fn> =>
      vi.fn(async () =>
        jsonResponse({ data: { id: "rd-1", type: "appStoreReviewDetails", attributes } }),
      );

    it("fills every contact field from config when creating", async () => {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? notFound()
          : jsonResponse({ data: { id: "rd-1", type: "appStoreReviewDetails" } }),
      );

      const result = await callWithContact({ versionId: VERSION_ID }, fetchImpl);

      expect(result.isError).toBeFalsy();
      const attributes = (
        bodyOf(postCall(fetchImpl, "/v1/appStoreReviewDetails")?.[1]).data as Record<
          string,
          unknown
        >
      ).attributes as Record<string, unknown>;
      expect(attributes.contactFirstName).toBe("Ada");
      expect(attributes.contactLastName).toBe("Lovelace");
      expect(attributes.contactEmail).toBe("ada@example.com");
      expect(attributes.contactPhone).toBe("+33 1 23 45 67 89");
      expect(textOf(result)).toContain("contactFromConfig");
    });

    it("lets an explicit argument win over the configured contact", async () => {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? notFound()
          : jsonResponse({ data: { id: "rd-1", type: "appStoreReviewDetails" } }),
      );

      await callWithContact(
        { versionId: VERSION_ID, contactEmail: "release@example.com" },
        fetchImpl,
      );

      const attributes = (
        bodyOf(postCall(fetchImpl, "/v1/appStoreReviewDetails")?.[1]).data as Record<
          string,
          unknown
        >
      ).attributes as Record<string, unknown>;
      expect(attributes.contactEmail).toBe("release@example.com");
      // The fields the caller stayed quiet about still come from config.
      expect(attributes.contactFirstName).toBe("Ada");
    });

    // The whole point of gap-filling: editing `notes` must not rewrite a contact
    // somebody set in the App Store Connect web UI.
    it("leaves a differing existing value alone and reports the drift", async () => {
      const fetchImpl = existing({
        contactFirstName: "Grace",
        contactEmail: "grace@example.com",
      });

      const result = await callWithContact(
        { versionId: VERSION_ID, notes: "No account needed." },
        fetchImpl,
      );

      const attributes = (bodyOf(patchCall(fetchImpl)?.[1]).data as Record<string, unknown>)
        .attributes as Record<string, unknown>;
      expect(attributes.contactFirstName).toBeUndefined();
      expect(attributes.contactEmail).toBeUndefined();
      // The gaps are still filled — only the disagreeing fields are held back.
      expect(attributes.contactLastName).toBe("Lovelace");

      const text = textOf(result);
      expect(text).toContain("contactDrift");
      expect(text).toContain("grace@example.com");
    });

    it("changes nothing when no contact is configured", async () => {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? notFound()
          : jsonResponse({ data: { id: "rd-1", type: "appStoreReviewDetails" } }),
      );

      const result = await callWithContact({ versionId: VERSION_ID }, fetchImpl, null);

      const attributes = (
        bodyOf(postCall(fetchImpl, "/v1/appStoreReviewDetails")?.[1]).data as Record<
          string,
          unknown
        >
      ).attributes as Record<string, unknown>;
      expect(attributes.contactFirstName).toBeUndefined();
      expect(textOf(result)).not.toContain("contactFromConfig");
    });
  });

  describe("set_app_price", () => {
    it("refuses a price point from another territory before pricing anything", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ data: [{ id: "usa-point", type: "appPricePoints", attributes: {} }] }),
      );

      const result = await callTool(
        "app_store_connect_set_app_price",
        {
          appId: APP_ID,
          pricePointId: "fra-point",
          baseTerritory: "USA",
          confirm: true,
        },
        fetchImpl,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not one of this app's USA price points");
      expect(postCall(fetchImpl, "/v1/appPriceSchedules")).toBeUndefined();
    });

    it("posts the schedule with the price inlined under `included`", async () => {
      const fetchImpl = vi.fn(async (url: string) =>
        String(url).includes("/appPricePoints")
          ? jsonResponse({
              data: [
                {
                  id: "free-point",
                  type: "appPricePoints",
                  attributes: { customerPrice: "0.00", proceeds: "0.00" },
                },
              ],
            })
          : jsonResponse({ data: { id: "sched-1", type: "appPriceSchedules" } }),
      );

      const result = await callTool(
        "app_store_connect_set_app_price",
        { appId: APP_ID, pricePointId: "free-point", baseTerritory: "USA", confirm: true },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      // The response is relationships only, so the echoed price is the caller's
      // only confirmation of which amount landed.
      expect((payloadOf(result).priced as Record<string, unknown>).customerPrice).toBe("0.00");

      const post = postCall(fetchImpl, "/v1/appPriceSchedules");
      const body = bodyOf(post?.[1]);
      const included = body.included as Record<string, unknown>[];
      expect(included[0]?.type).toBe("appPrices");
      // The placeholder id has to match on both sides or Apple rejects the create.
      const data = body.data as Record<string, unknown>;
      const rels = data.relationships as Record<string, { data?: { id?: string }[] }>;
      expect(rels.manualPrices?.data?.[0]?.id).toBe(included[0]?.id);
    });

    it("reports an unpriced app as null rather than a 404", async () => {
      const fetchImpl = vi.fn(async () => notFound());

      const result = await callTool(
        "app_store_connect_get_app_price_schedule",
        { appId: APP_ID },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("never been priced");
    });

    /**
     * The regression guard for the 400 this tool shipped with. The amount lives on
     * the price point, not on the price, so the prices are unreadable without a
     * sideload — but `/v1/apps/{id}/appPriceSchedule` takes exactly `app`,
     * `baseTerritory`, `manualPrices` and `automaticPrices` as `include` values.
     * A nested `manualPrices.appPricePoint` is not a deeper answer, it is
     * `'manualPrices.appPricePoint' is not a valid relationship name` and no
     * schedule at all. Any dot in an `include` this server sends is that bug.
     */
    it("never sends a nested include, and reads the prices from their own endpoint", async () => {
      const fetchImpl = vi.fn(async (url: string) =>
        String(url).includes("/manualPrices")
          ? jsonResponse({ data: [] })
          : jsonResponse({ data: { id: "sched-1", type: "appPriceSchedules" } }),
      );

      await callTool("app_store_connect_get_app_price_schedule", { appId: APP_ID }, fetchImpl);

      const includes = fetchImpl.mock.calls.map(
        (call) => new URL(String(call[0])).searchParams.get("include") ?? "",
      );
      expect(includes.every((include) => !include.includes("."))).toBe(true);
      expect(includes[0]).toBe("baseTerritory");
      expect(includes[1]).toBe("appPricePoint,territory");
      expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
        "/v1/appPriceSchedules/sched-1/manualPrices",
      );
    });

    it("inlines the price behind each price point so the cost is in the answer", async () => {
      const fetchImpl = vi.fn(async (url: string) =>
        String(url).includes("/manualPrices")
          ? jsonResponse({
              data: [
                {
                  id: "price-1",
                  type: "appPrices",
                  attributes: { startDate: null, endDate: null, manual: true },
                  relationships: {
                    territory: { data: { id: "USA", type: "territories" } },
                    appPricePoint: { data: { id: "free-point", type: "appPricePoints" } },
                  },
                },
              ],
              included: [
                {
                  id: "free-point",
                  type: "appPricePoints",
                  attributes: { customerPrice: "0.00", proceeds: "0.00" },
                },
                { id: "USA", type: "territories", attributes: { currency: "USD" } },
              ],
            })
          : jsonResponse({
              data: {
                id: "sched-1",
                type: "appPriceSchedules",
                relationships: { baseTerritory: { data: { id: "USA", type: "territories" } } },
              },
            }),
      );

      const result = await callTool(
        "app_store_connect_get_app_price_schedule",
        { appId: APP_ID },
        fetchImpl,
      );

      expect(JSON.parse(textOf(result))).toEqual({
        scheduleId: "sched-1",
        baseTerritory: "USA",
        manualPrices: [
          {
            id: "price-1",
            startDate: null,
            endDate: null,
            manual: true,
            territory: "USA",
            pricePointId: "free-point",
            // The two fields the caller actually asked for. A free app is
            // customerPrice "0.00" — the absence of a price is a different state.
            customerPrice: "0.00",
            proceeds: "0.00",
          },
        ],
      });
    });
  });

  describe("set_app_categories", () => {
    it("sends the category as a relationship, and null clears the secondary", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: "ai-1", type: "appInfos" } }));

      const result = await callTool(
        "app_store_connect_set_app_categories",
        { appInfoId: "ai-1", primaryCategory: "PRODUCTIVITY", secondaryCategory: null },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      const rels = (bodyOf(patchCall(fetchImpl)?.[1]).data as Record<string, unknown>)
        .relationships as Record<string, unknown>;

      expect(rels.primaryCategory).toEqual({
        data: { type: "appCategories", id: "PRODUCTIVITY" },
      });
      // Clearing is an explicit null relationship, and must stay distinguishable
      // from "not mentioned" — which is what `undefined` means here.
      expect(rels.secondaryCategory).toEqual({ data: null });
      expect(rels.primarySubcategoryOne).toBeUndefined();
    });
  });

  describe("update_app", () => {
    it("patches the content rights declaration", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ data: { id: APP_ID, type: "apps" } }));

      const result = await callTool(
        "app_store_connect_update_app",
        { appId: APP_ID, contentRightsDeclaration: "USES_THIRD_PARTY_CONTENT" },
        fetchImpl,
      );

      expect(result.isError).toBeFalsy();
      const patch = patchCall(fetchImpl);
      expect(patch?.[0]).toContain(`/v1/apps/${APP_ID}`);
      expect(
        ((bodyOf(patch?.[1]).data as Record<string, unknown>).attributes as Record<string, unknown>)
          .contentRightsDeclaration,
      ).toBe("USES_THIRD_PARTY_CONTENT");
    });
  });
});

describe("certificates", () => {
  const certAttributes = {
    certificateType: "DEVELOPER_ID_APPLICATION",
    displayName: "Magenta Creations",
    name: "Developer ID Application: Magenta Creations",
    platform: "MAC_OS",
    serialNumber: "1A2B3C",
    expirationDate: "2031-01-01T00:00:00.000+00:00",
    // Apple returns the certificate as base64 DER. "hello" as bytes.
    certificateContent: Buffer.from("hello").toString("base64"),
    csrContent: "-----BEGIN CERTIFICATE REQUEST-----\nblob\n-----END CERTIFICATE REQUEST-----",
  };

  const certResponse = (single = false): unknown => ({
    data: single
      ? { id: "cert-1", type: "certificates", attributes: certAttributes }
      : [{ id: "cert-1", type: "certificates", attributes: certAttributes }],
  });

  it("hides the mutating tools unless writes are allowed", async () => {
    const readOnly = await toolNames(await connect(baseConfig));
    expect(readOnly).toContain("app_store_connect_list_certificates");
    expect(readOnly).toContain("app_store_connect_download_certificate");
    expect(readOnly).not.toContain("app_store_connect_create_certificate");
    expect(readOnly).not.toContain("app_store_connect_revoke_certificate");

    const writable = await toolNames(await connect({ ...baseConfig, allowWrites: true }));
    expect(writable).toContain("app_store_connect_create_certificate");
    expect(writable).toContain("app_store_connect_revoke_certificate");
  });

  it("omits the base64 blobs from a listing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(certResponse()));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const text = textOf(
      await client.callTool({ name: "app_store_connect_list_certificates", arguments: {} }),
    );

    // The useful fields survive...
    expect(text).toContain("DEVELOPER_ID_APPLICATION");
    expect(text).toContain("1A2B3C");
    // ...and the multi-kilobyte ones do not reach the caller's context.
    expect(text).toContain("<omitted>");
    expect(text).not.toContain(certAttributes.certificateContent);
    expect(text).not.toContain("BEGIN CERTIFICATE REQUEST");
  });

  it("posts the CSR and writes decoded DER, not base64", async () => {
    const dir = await mkdtemp(join(tmpdir(), "certs-"));
    const savePath = join(dir, "nested", "devid.cer");
    const fetchImpl = vi.fn(async () => jsonResponse(certResponse(true)));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const text = textOf(
      await client.callTool({
        name: "app_store_connect_create_certificate",
        arguments: {
          certificateType: "DEVELOPER_ID_APPLICATION",
          csrContent: "-----BEGIN CERTIFICATE REQUEST-----\nabc\n-----END CERTIFICATE REQUEST-----",
          savePath,
        },
      }),
    );

    const post = postCall(fetchImpl, "/v1/certificates");
    expect(post).toBeDefined();
    const body = JSON.parse(String(post?.[1]?.body)) as {
      data: { attributes: Record<string, string> };
    };
    expect(body.data.attributes.certificateType).toBe("DEVELOPER_ID_APPLICATION");
    expect(body.data.attributes.csrContent).toContain("BEGIN CERTIFICATE REQUEST");

    // Decoded, so the file is importable rather than a base64 text blob.
    expect(await readFile(savePath)).toEqual(Buffer.from("hello"));
    expect(text).toContain(savePath);
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to revoke without an explicit confirm", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    const result = await client.callTool({
      name: "app_store_connect_revoke_certificate",
      arguments: { certificateId: "cert-1" },
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
