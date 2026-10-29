import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
  baseConfig,
  callArgs,
  connect,
  jsonResponse,
  patchCall,
  payloadOf,
  postCall,
  textOf,
} from "../helpers.js";

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
  // Apple omits the app relationship unless the request asks for include=app,
  // so the fixture does too — returning it unconditionally hid a skipped check.
  const asApple = (url: string, body: unknown): unknown => {
    const include = new URL(url).searchParams.get("include") ?? "";
    if (include.split(",").includes("app")) return body;
    const { data, ...rest } = body as { data: { relationships?: Record<string, unknown> } };
    const { app: _app, ...relationships } = data.relationships ?? {};
    return { ...rest, data: { ...data, relationships } };
  };

  const routed = (version: unknown, build: unknown): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      if (url.includes("/v1/builds/")) return jsonResponse(asApple(url, build));
      if (url.includes("/appStoreVersions/")) return jsonResponse(asApple(url, version));
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
    expect(new URL(String(buildCall?.[0])).searchParams.get("include")?.split(",")).toContain(
      "preReleaseVersion",
    );
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

  // The rejected iOS 1.8.1 case: App Review's REJECTED is not our DEVELOPER_REJECTED,
  // yet the web UI swaps its build and resubmits — the tool must not be stricter.
  it.each(["DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"])(
    "attaches and detaches on a %s version",
    async (appStoreState) => {
      const attach = routed(versionBody({ appStoreState }), buildBody());
      const attached = await callTool({ versionId: VERSION_ID, buildId: BUILD_ID }, attach);
      expect(attached.isError).toBeFalsy();
      expect(patchCall(attach)).toBeDefined();

      const detach = routed(versionBody({ appStoreState }), buildBody());
      const detached = await callTool({ versionId: VERSION_ID, detach: true }, detach);
      expect(detached.isError).toBeFalsy();
      expect(patchCall(detach)).toBeDefined();
    },
  );

  it.each(["WAITING_FOR_REVIEW", "IN_REVIEW", "READY_FOR_REVIEW", "PENDING_DEVELOPER_RELEASE"])(
    "still refuses a %s version, naming every editable state",
    async (appStoreState) => {
      const fetchImpl = routed(versionBody({ appStoreState }), buildBody());

      const result = await callTool({ versionId: VERSION_ID, buildId: BUILD_ID }, fetchImpl);

      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0]?.text ?? "";
      expect(text).toContain(appStoreState);
      expect(text).toContain(
        "PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED, REJECTED, METADATA_REJECTED or INVALID_BINARY",
      );
      expect(patchCall(fetchImpl)).toBeUndefined();
    },
  );

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

  it("updates a version App Review rejected", async () => {
    const fetchImpl = routed("REJECTED");

    const result = await callTool({ versionId: VERSION_ID, releaseType: "MANUAL" }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(patchCall(fetchImpl)).toBeDefined();
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

  /** Omitted means Apple's AFTER_APPROVAL, which answers a bare 409 to a date. */
  it("rejects a create with a date but no releaseType before any request", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      {
        appId: APP_ID,
        versionString: "1.9.0",
        platform: "MAC_OS",
        earliestReleaseDate: "2026-08-01T12:00:00-07:00",
      },
      fetchImpl,
      "app_store_connect_create_version",
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("SCHEDULED");
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

/**
 * The rollup exists because answering "what OS does our listing require today?"
 * across a portfolio was list_versions -> get_version per app, and the shortcut
 * everyone reaches for instead — the newest VALID build in list_builds — is a
 * proxy that is usually a TestFlight or in-review binary. Eight apps' floors
 * were measured that way and were wrong.
 */
describe("list_live_versions", () => {
  const app = (id: string, name: string): unknown => ({
    type: "apps",
    id,
    attributes: { name, bundleId: `com.acme.${name.toLowerCase()}` },
  });

  const version = (
    id: string,
    versionString: string,
    appStoreState: string,
    buildId: string | null,
    platform = "IOS",
  ): unknown => ({
    type: "appStoreVersions",
    id,
    attributes: { versionString, appStoreState, platform },
    // No `build` key at all when nothing is attached, which is the shape Apple
    // sends — distinct from a build that is attached but not sideloaded.
    relationships: buildId === null ? {} : { build: { data: { type: "builds", id: buildId } } },
  });

  const build = (id: string, minOsVersion: string, buildVersion: string): unknown => ({
    type: "builds",
    id,
    attributes: { minOsVersion, version: buildVersion, uploadedDate: "2026-08-03T13:46:17-07:00" },
  });

  /** Route by URL, since this tool makes several different calls per invocation. */
  const routed = (routes: [RegExp, (url: string) => Response][]): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      const hit = routes.find(([re]) => re.test(String(url)));
      if (!hit) throw new Error(`unrouted: ${String(url)}`);
      return hit[1](String(url));
    });

  // A factory, not a constant: a Response body can only be read once, so a
  // shared instance passes the first test and fails every later one.
  const threeApps = (): Response =>
    jsonResponse({ data: [app("1", "Alpha"), app("2", "Beta"), app("3", "Gamma")] });

  it("says when the app list stopped at limit, rather than reading as the portfolio", async () => {
    const fetchImpl = routed([
      [
        /\/v1\/apps\?/,
        () =>
          jsonResponse({
            data: [app("1", "Alpha"), app("2", "Beta")],
            meta: { paging: { total: 5, limit: 2 } },
          }),
      ],
      [/\/appStoreVersions/, () => jsonResponse({ data: [] })],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_live_versions",
        arguments: { limit: 2 },
      }),
    );

    expect(body.meta).toMatchObject({ apps: 2, incomplete: true, appsTotal: 5 });
    expect(String(body.note)).toContain("Only 2 of 5 apps");
  });

  it("makes one request for the apps and one per app, no more", async () => {
    const fetchImpl = routed([
      [/\/v1\/apps\?/, () => threeApps()],
      [
        /\/appStoreVersions/,
        () =>
          jsonResponse({
            data: [version("v1", "1.4.0", "READY_FOR_SALE", "b1")],
            included: [build("b1", "16.0", "155")],
          }),
      ],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({ name: "app_store_connect_list_live_versions", arguments: {} }),
    ) as {
      apps: { name: string; live: { build: { minOsVersion: string } }[] }[];
      meta: Record<string, number>;
    };

    // The regression that keeps a rollup a rollup: 1 + N, never N * 3.
    expect(fetchImpl.mock.calls).toHaveLength(4);
    expect(body.meta.requests).toBe(4);
    expect(body.apps.map((a) => a.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(body.apps[0]?.live[0]?.build.minOsVersion).toBe("16.0");
  });

  it("asks Apple for the live state and the build, rather than filtering locally", async () => {
    const fetchImpl = routed([
      [/\/v1\/apps\?/, () => jsonResponse({ data: [app("1", "Alpha")] })],
      [/\/appStoreVersions/, () => jsonResponse({ data: [] })],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    await client.callTool({ name: "app_store_connect_list_live_versions", arguments: {} });

    const url = new URL(callArgs(fetchImpl, 1)[0]);
    expect(url.pathname).toBe("/v1/apps/1/appStoreVersions");
    expect(url.searchParams.get("filter[appStoreState]")).toBe("READY_FOR_SALE");
    expect(url.searchParams.get("include")).toBe("build");
  });

  /**
   * The test that catches a naive port of `firstIncluded`: a collection
   * sideloads many builds, and handing every version `included[0]` reads as a
   * portfolio sharing one binary rather than as a bug.
   */
  it("gives each version its own sideloaded build", async () => {
    const fetchImpl = routed([
      [/\/v1\/apps\?/, () => jsonResponse({ data: [app("1", "Universal")] })],
      [
        /\/appStoreVersions/,
        () =>
          jsonResponse({
            data: [
              version("v1", "1.4.0", "READY_FOR_SALE", "b-ios", "IOS"),
              version("v2", "1.4.0", "READY_FOR_SALE", "b-mac", "MAC_OS"),
            ],
            included: [build("b-ios", "16.0", "155"), build("b-mac", "26.0", "160")],
          }),
      ],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({ name: "app_store_connect_list_live_versions", arguments: {} }),
    ) as { apps: { live: { platform: string; build: { minOsVersion: string } }[] }[] };

    const live = body.apps[0]?.live ?? [];
    expect(live).toHaveLength(2);
    expect(live.find((v) => v.platform === "IOS")?.build.minOsVersion).toBe("16.0");
    expect(live.find((v) => v.platform === "MAC_OS")?.build.minOsVersion).toBe("26.0");
  });

  it("reports an app that failed instead of dropping it", async () => {
    const fetchImpl = routed([
      [/\/v1\/apps\?/, () => threeApps()],
      [
        /\/v1\/apps\/2\/appStoreVersions/,
        () => new Response(JSON.stringify({ errors: [{ status: "403" }] }), { status: 403 }),
      ],
      [
        /\/appStoreVersions/,
        () =>
          jsonResponse({
            data: [version("v1", "1.4.0", "READY_FOR_SALE", "b1")],
            included: [build("b1", "16.0", "155")],
          }),
      ],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_live_versions",
      arguments: {},
    });
    const body = payloadOf(result) as {
      apps: unknown[];
      errors: { appId: string; name: string; status: number }[];
      meta: { failed: number };
      note: string;
    };

    expect(result.isError).toBeFalsy();
    expect(body.apps).toHaveLength(2);
    expect(body.errors[0]).toMatchObject({ appId: "2", name: "Beta", status: 403 });
    expect(body.meta.failed).toBe(1);
    // Named, not merely counted: a model summarizing 2 rows must not report the
    // portfolio as two apps.
    expect(body.note).toContain("Beta");
  });

  it("fails the call when no app could be read at all", async () => {
    const fetchImpl = routed([
      [/\/v1\/apps\?/, () => jsonResponse({ data: [app("1", "Alpha")] })],
      [/\/appStoreVersions/, () => new Response("{}", { status: 403 })],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_live_versions",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not an empty portfolio");
  });

  it("keeps a row for an app with nothing live", async () => {
    const fetchImpl = routed([
      [/\/v1\/apps\?/, () => jsonResponse({ data: [app("1", "Alpha")] })],
      [/\/appStoreVersions/, () => jsonResponse({ data: [] })],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({ name: "app_store_connect_list_live_versions", arguments: {} }),
    ) as {
      apps: { name: string; live: unknown[] }[];
      meta: { noLiveVersion: number };
      note: string;
    };

    expect(body.apps).toHaveLength(1);
    expect(body.apps[0]?.live).toEqual([]);
    expect(body.meta.noLiveVersion).toBe(1);
    expect(body.note).toContain("never shipped");
  });

  /**
   * A build attached but not sideloaded. `{id}` with no minOsVersion has to stay
   * distinguishable from `null`, or a missing attribute reads as "no OS floor".
   */
  it("distinguishes an unsideloaded build from no build at all", async () => {
    const fetchImpl = routed([
      [/\/v1\/apps\?/, () => jsonResponse({ data: [app("1", "Alpha"), app("2", "Beta")] })],
      [
        /\/v1\/apps\/1\/appStoreVersions/,
        () => jsonResponse({ data: [version("v1", "1.0", "READY_FOR_SALE", "b9")], included: [] }),
      ],
      [
        /\/appStoreVersions/,
        () => jsonResponse({ data: [version("v2", "1.0", "READY_FOR_SALE", null)] }),
      ],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({ name: "app_store_connect_list_live_versions", arguments: {} }),
    ) as { apps: { name: string; live: { build: unknown }[] }[]; note: string };

    const alpha = body.apps.find((a) => a.name === "Alpha");
    const beta = body.apps.find((a) => a.name === "Beta");
    expect(alpha?.live[0]?.build).toEqual({ id: "b9" });
    expect(beta?.live[0]?.build).toBeNull();
    expect(body.note).toContain("missing data, not an absent OS floor");
  });

  it("selects a subset without enumerating the account", async () => {
    const fetchImpl = routed([
      [/\/v1\/apps\?/, () => jsonResponse({ data: [app("a", "Alpha")] })],
      [/\/appStoreVersions/, () => jsonResponse({ data: [] })],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    await client.callTool({
      name: "app_store_connect_list_live_versions",
      arguments: { appIds: ["a", "b"], limit: 2 },
    });

    const url = new URL(callArgs(fetchImpl, 0)[0]);
    // Comma-joined, the JSON:API spelling Apple expects.
    expect(url.searchParams.get("filter[id]")).toBe("a,b");
    expect(url.searchParams.get("limit")).toBe("2");
  });

  it("adds the pipeline states to the same request rather than a second one", async () => {
    const fetchImpl = routed([
      [/\/v1\/apps\?/, () => jsonResponse({ data: [app("1", "Alpha")] })],
      [
        /\/appStoreVersions/,
        () =>
          jsonResponse({
            data: [
              version("v1", "1.4.0", "READY_FOR_SALE", null),
              version("v2", "1.5.0", "WAITING_FOR_REVIEW", null),
            ],
          }),
      ],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_live_versions",
        arguments: { includeInFlight: true },
      }),
    ) as { apps: { live: { versionString: string }[]; inFlight: { versionString: string }[] }[] };

    expect(fetchImpl.mock.calls).toHaveLength(2); // still 1 + N
    const states = new URL(callArgs(fetchImpl, 1)[0]).searchParams.get("filter[appStoreState]");
    expect(states?.startsWith("READY_FOR_SALE,")).toBe(true);
    expect(body.apps[0]?.live.map((v) => v.versionString)).toEqual(["1.4.0"]);
    expect(body.apps[0]?.inFlight.map((v) => v.versionString)).toEqual(["1.5.0"]);
  });

  /**
   * Apple does NOT move a superseded version out of READY_FOR_SALE — every
   * version an app has ever shipped keeps that state forever. Filtering on it
   * returns the whole release history, all of it looking equally current: one
   * real account answered with eleven versions for a single Mac app, and 74
   * across the portfolio. Reading an OS floor off an arbitrary member of that
   * list is the bug this tool exists to prevent.
   */
  it("keeps only the newest version per platform out of the release history", async () => {
    const fetchImpl = routed([
      [/\/v1\/apps\?/, () => jsonResponse({ data: [app("1", "Universal")] })],
      [
        /\/appStoreVersions/,
        () =>
          jsonResponse({
            data: [
              version("v-old", "1.0.0", "READY_FOR_SALE", "b-old", "MAC_OS"),
              version("v-new", "1.8.1", "READY_FOR_SALE", "b-new", "MAC_OS"),
              version("v-mid", "1.7.0", "READY_FOR_SALE", "b-mid", "MAC_OS"),
              version("v-ios", "1.8.1", "READY_FOR_SALE", "b-ios", "IOS"),
            ],
            included: [
              build("b-old", "15.5", "36"),
              build("b-new", "26.0", "275"),
              build("b-mid", "26.0", "242"),
              build("b-ios", "17.0", "275"),
            ],
          }),
      ],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({ name: "app_store_connect_list_live_versions", arguments: {} }),
    ) as {
      apps: {
        live: { platform: string; versionString: string; build: { minOsVersion: string } }[];
        supersededVersions: number;
      }[];
      note: string;
    };

    const row = body.apps[0];
    // One per platform, not four rows all claiming to be live.
    expect(row?.live).toHaveLength(2);
    expect(row?.live.find((v) => v.platform === "MAC_OS")?.versionString).toBe("1.8.1");
    // The one that matters: the OS floor comes from the CURRENT binary, not the
    // 15.5 of a version shipped two years ago that is still READY_FOR_SALE.
    expect(row?.live.find((v) => v.platform === "MAC_OS")?.build.minOsVersion).toBe("26.0");
    expect(row?.live.find((v) => v.platform === "IOS")?.versionString).toBe("1.8.1");
    // Set aside, not silently dropped.
    expect(row?.supersededVersions).toBe(2);
    expect(body.note).toContain("whole release history");
  });

  it("orders numerically, so 1.10.0 beats 1.9.0", async () => {
    const fetchImpl = routed([
      [/\/v1\/apps\?/, () => jsonResponse({ data: [app("1", "Alpha")] })],
      [
        /\/appStoreVersions/,
        () =>
          jsonResponse({
            data: [
              version("v9", "1.9.0", "READY_FOR_SALE", "b9"),
              version("v10", "1.10.0", "READY_FOR_SALE", "b10"),
            ],
            included: [build("b9", "16.0", "90"), build("b10", "26.0", "100")],
          }),
      ],
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({ name: "app_store_connect_list_live_versions", arguments: {} }),
    ) as { apps: { live: { versionString: string }[] }[] };

    // A lexical sort picks 1.9.0 and reports an OS floor from the wrong binary.
    expect(body.apps[0]?.live[0]?.versionString).toBe("1.10.0");
  });

  /** The description of the tool that misleads must point at the one that does not. */
  it("is named by list_builds' description", async () => {
    const client = await connect(baseConfig);
    const tools = (await client.listTools()).tools;
    const builds = tools.find((t) => t.name === "app_store_connect_list_builds");

    expect(builds?.description).toContain("app_store_connect_get_version");
  });
});

describe("get_app includeLiveVersion", () => {
  const appBody = {
    data: { type: "apps", id: "1", attributes: { name: "Alpha", bundleId: "com.acme.alpha" } },
  };

  it("costs nothing extra when it is not asked for", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(appBody));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({ name: "app_store_connect_get_app", arguments: { appId: "1" } }),
    );

    expect(fetchImpl.mock.calls).toHaveLength(1);
    expect(body).not.toHaveProperty("live");
  });

  it("resolves the shipping binary in exactly one extra request", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("appStoreVersions")
        ? jsonResponse({
            data: [
              {
                type: "appStoreVersions",
                id: "v1",
                attributes: { versionString: "1.4.0", appStoreState: "READY_FOR_SALE" },
                relationships: { build: { data: { type: "builds", id: "b1" } } },
              },
            ],
            included: [{ type: "builds", id: "b1", attributes: { minOsVersion: "26.0" } }],
          })
        : jsonResponse(appBody),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_get_app",
        arguments: { appId: "1", includeLiveVersion: true },
      }),
    ) as { data: { name: string }; live: { build: { minOsVersion: string } }[] };

    expect(fetchImpl.mock.calls).toHaveLength(2);
    expect(body.live[0]?.build.minOsVersion).toBe("26.0");
  });

  /**
   * Both go through liveVersionsOf, so they cannot disagree about what "live"
   * means — and Apple leaves every shipped version in READY_FOR_SALE, so
   * skipping the per-platform pick here returns the whole release history while
   * the rollup returns one row.
   */
  it("returns the current version per platform, not the release history", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("appStoreVersions")
        ? jsonResponse({
            data: [
              {
                type: "appStoreVersions",
                id: "old",
                attributes: {
                  versionString: "1.0.0",
                  appStoreState: "READY_FOR_SALE",
                  platform: "MAC_OS",
                },
                relationships: { build: { data: { type: "builds", id: "b-old" } } },
              },
              {
                type: "appStoreVersions",
                id: "new",
                attributes: {
                  versionString: "1.8.1",
                  appStoreState: "READY_FOR_SALE",
                  platform: "MAC_OS",
                },
                relationships: { build: { data: { type: "builds", id: "b-new" } } },
              },
            ],
            included: [
              { type: "builds", id: "b-old", attributes: { minOsVersion: "15.5" } },
              { type: "builds", id: "b-new", attributes: { minOsVersion: "26.0" } },
            ],
          })
        : jsonResponse(appBody),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_get_app",
        arguments: { appId: "1", includeLiveVersion: true },
      }),
    ) as { live: { versionString: string; build: { minOsVersion: string } }[] };

    expect(body.live).toHaveLength(1);
    expect(body.live[0]?.versionString).toBe("1.8.1");
    expect(body.live[0]?.build.minOsVersion).toBe("26.0");
  });
});
