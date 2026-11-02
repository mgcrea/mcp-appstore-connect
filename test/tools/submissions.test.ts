import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
  baseConfig,
  bodyOf,
  callArgs,
  connect,
  deleteCall,
  jsonResponse,
  notFound,
  patchCall,
  payloadOf,
  postCall,
  submissionItemFor,
  textOf,
} from "../helpers.js";

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

  /** A rejected submission naming the version it holds, as Apple sends it. */
  const returnedHolding = (versionId: string): unknown => ({
    ...(submission("UNRESOLVED_ISSUES") as Record<string, unknown>),
    relationships: {
      appStoreVersionForReview: { data: { id: versionId, type: "appStoreVersions" } },
    },
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
    /** The app's asset packs (`/v1/apps/{id}/backgroundAssets`). */
    packs?: unknown[];
    /** Every pack's versions, with their sideloaded App Store releases under `included`. */
    packVersions?: { data: unknown[]; included?: unknown[] };
    /** Answer the POST adding an asset-pack item with this error response. */
    refuseAssetItem?: () => Response;
  };

  /** Route by URL, method and `filter[state]` — the three list GETs share a path. */
  const routed = (routes: Routes = {}): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const method = init?.method ?? "GET";
      // Apple takes a comma-separated state list and answers with every match.
      const states = (parsed.searchParams.get("filter[state]") ?? "").split(",");

      if (parsed.pathname.endsWith("/backgroundAssets")) {
        return jsonResponse({ data: routes.packs ?? [] });
      }
      if (parsed.pathname.includes("/backgroundAssets/") && parsed.pathname.endsWith("/versions")) {
        return jsonResponse(routes.packVersions ?? { data: [] });
      }
      if (
        routes.refuseAssetItem &&
        parsed.pathname.endsWith("/reviewSubmissionItems") &&
        method === "POST" &&
        String(init?.body).includes("backgroundAssetVersion")
      ) {
        return routes.refuseAssetItem();
      }
      if (parsed.pathname.includes("/reviewSubmissions") && parsed.pathname.includes("/items")) {
        return jsonResponse({ data: routes.items ?? [] });
      }
      if (parsed.pathname.endsWith("/reviewSubmissions") && method === "GET") {
        const inFlight = ["WAITING_FOR_REVIEW", "IN_REVIEW", "CANCELING", "COMPLETING"];
        return jsonResponse({
          data: [
            ...(states.includes("UNRESOLVED_ISSUES") ? (routes.returned ?? []) : []),
            ...(states.some((st) => inFlight.includes(st)) ? (routes.inFlight ?? []) : []),
            ...(states.includes("READY_FOR_REVIEW") ? (routes.drafts ?? []) : []),
          ],
        });
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
      returned: [returnedHolding(VERSION_ID)],
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
      returned: [returnedHolding(VERSION_ID)],
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

  /**
   * The bug this guards: resolving the rejected item elsewhere (a Resolution Center reply, the
   * web UI) moves the version to READY_FOR_REVIEW while the submission stays UNRESOLVED_ISSUES.
   * The state guard refused that version before the resubmit branch ran, so the only API route
   * left was pulling it out of the rejected submission, gambling its queue position.
   */
  it("resubmits a returned submission whose version was already resolved", async () => {
    const fetchImpl = routed({
      version: (withApp) => versionBody({ appStoreState: "READY_FOR_REVIEW" }, {}, withApp),
      returned: [submission("UNRESOLVED_ISSUES")],
      items: [{ ...stagedItem, attributes: { state: "READY_FOR_REVIEW", resolved: true } }],
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(postCall(fetchImpl, "/v1/reviewSubmissions")).toBeUndefined();
    expect(postCall(fetchImpl, "/v1/reviewSubmissionItems")).toBeUndefined();
    const patches = fetchImpl.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
    ) as [string, RequestInit][];
    // Nothing left to resolve, and nothing removed: only the submission is sent back.
    expect(patches).toHaveLength(1);
    expect(patches[0]?.[0]).toBe(
      `https://api.appstoreconnect.apple.com/v1/reviewSubmissions/${SUBMISSION_ID}`,
    );
    expect(JSON.parse(String(patches[0]?.[1].body)).data.attributes).toEqual({ submitted: true });
    expect(
      fetchImpl.mock.calls.some(
        (call) => (call[1] as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
    expect(JSON.parse(textOf(result)).resubmitted).toBe(true);
  });

  it("still refuses a READY_FOR_REVIEW version no returned submission holds", async () => {
    const fetchImpl = routed({
      version: (withApp) => versionBody({ appStoreState: "READY_FOR_REVIEW" }, {}, withApp),
      returned: [submission("UNRESOLVED_ISSUES")],
      items: [],
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeTruthy();
    expect(textOf(result)).toContain("READY_FOR_REVIEW");
    expect(patchCall(fetchImpl)).toBeUndefined();
  });

  /**
   * A rejected submission can hold only an in-app purchase. Resubmitting it on
   * a request for this version used to succeed and report the version as sent,
   * though it never left.
   */
  it("refuses to resubmit a rejected submission that does not hold the version", async () => {
    const fetchImpl = routed({
      returned: [submission("UNRESOLVED_ISSUES")],
      items: [
        {
          id: "item-iap",
          type: "reviewSubmissionItems",
          attributes: { state: "REJECTED" },
          relationships: {
            inAppPurchaseVersion: { data: { id: "iap-1", type: "inAppPurchaseVersions" } },
          },
        },
      ],
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does not hold version");
    expect(patchCall(fetchImpl)).toBeUndefined();
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

  /**
   * Shaped from Chevalet 1.0.0 (app 6828592664), which ships two Apple-hosted asset packs.
   * The version id is one of the two `14|…` targets its macOS submission carried; the pack
   * identifier and release states are illustrative.
   */
  const PACK_VERSION = "80a3af96-5df8-4681-8133-78ba31ddf3d5";
  const packs = (releaseState: string): Partial<Routes> => ({
    packs: [
      {
        id: "pack-a",
        type: "backgroundAssets",
        attributes: { assetPackIdentifier: "io.mgcrea.chevalet.pack-a", archived: false },
      },
    ],
    packVersions: {
      data: [
        {
          id: PACK_VERSION,
          type: "backgroundAssetVersions",
          attributes: { version: "1", state: "COMPLETE", platforms: ["MAC_OS"] },
          relationships: {
            appStoreRelease: {
              data: { type: "backgroundAssetVersionAppStoreReleases", id: "rel-a" },
            },
          },
        },
      ],
      included: [
        {
          id: "rel-a",
          type: "backgroundAssetVersionAppStoreReleases",
          attributes: { state: releaseState },
        },
      ],
    },
  });

  const isAssetItemPost = (call: unknown[]): boolean =>
    String(call[0]).endsWith("/v1/reviewSubmissionItems") &&
    (call[1] as RequestInit | undefined)?.method === "POST" &&
    String((call[1] as RequestInit).body).includes("backgroundAssetVersion");

  const assetItemBodies = (fetchImpl: ReturnType<typeof vi.fn>): unknown[] =>
    fetchImpl.mock.calls
      .filter(isAssetItemPost)
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)));

  type AssetPacksBody = {
    assetPacks: { packs: { action: string; reason?: string }[]; note?: string };
  };

  /**
   * The gap this closes: a cancel strips the asset packs from the submission, and a
   * resubmit that adds only the version ships the app without them.
   */
  it("adds the app's pending asset-pack versions before submitting", async () => {
    const fetchImpl = routed(packs("PREPARE_FOR_SUBMISSION"));

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(assetItemBodies(fetchImpl)).toEqual([
      {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: SUBMISSION_ID } },
            backgroundAssetVersion: {
              data: { type: "backgroundAssetVersions", id: PACK_VERSION },
            },
          },
        },
      },
    ]);
    // Added before the submission goes to Apple, never after.
    const assetAt = fetchImpl.mock.calls.findIndex(isAssetItemPost);
    const patchAt = fetchImpl.mock.calls.findIndex(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
    );
    expect(assetAt).toBeGreaterThan(-1);
    expect(assetAt).toBeLessThan(patchAt);
    expect((payloadOf(result) as AssetPacksBody).assetPacks.packs).toEqual([
      expect.objectContaining({ versionId: PACK_VERSION, action: "add" }),
    ]);
  });

  it("dryRun reports the asset packs it would add and adds none", async () => {
    const fetchImpl = routed(packs("PREPARE_FOR_SUBMISSION"));

    const result = await callTool(
      { versionId: VERSION_ID, dryRun: true, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(assetItemBodies(fetchImpl)).toEqual([]);
    expect(patchCall(fetchImpl)).toBeUndefined();
    expect((payloadOf(result) as AssetPacksBody).assetPacks.packs).toEqual([
      expect.objectContaining({ versionId: PACK_VERSION, action: "wouldAdd" }),
    ]);
  });

  it("reports a pack it does not add, with the reason", async () => {
    const fetchImpl = routed(packs("ACCEPTED"));

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(assetItemBodies(fetchImpl)).toEqual([]);
    const { assetPacks } = payloadOf(result) as AssetPacksBody;
    expect(assetPacks.packs[0]).toMatchObject({
      action: "notAdded",
      appStoreReleaseState: "ACCEPTED",
    });
    expect(assetPacks.packs[0]?.reason).toContain("Add for Review");
    expect(assetPacks.note).toContain("Add for Review");
  });

  it("adds the asset packs when resuming a staged draft too", async () => {
    const fetchImpl = routed({
      ...packs("PREPARE_FOR_SUBMISSION"),
      version: (withApp) => versionBody({ appStoreState: "READY_FOR_REVIEW" }, {}, withApp),
      drafts: [submission("READY_FOR_REVIEW")],
      items: [stagedItem],
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(assetItemBodies(fetchImpl)).toHaveLength(1);
    expect(JSON.parse(textOf(result)).resumedDraft).toBe(true);
  });

  it("does not add an asset-pack version the draft already holds", async () => {
    const fetchImpl = routed({
      ...packs("PREPARE_FOR_SUBMISSION"),
      version: (withApp) => versionBody({ appStoreState: "READY_FOR_REVIEW" }, {}, withApp),
      drafts: [submission("READY_FOR_REVIEW")],
      items: [
        stagedItem,
        {
          id: "item-2",
          type: "reviewSubmissionItems",
          relationships: {
            backgroundAssetVersion: {
              data: { id: PACK_VERSION, type: "backgroundAssetVersions" },
            },
          },
        },
      ],
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(assetItemBodies(fetchImpl)).toEqual([]);
    expect((payloadOf(result) as AssetPacksBody).assetPacks.packs[0]?.action).toBe(
      "alreadyOnSubmission",
    );
  });

  it("never reads asset packs when includeAssetPacks is false", async () => {
    const fetchImpl = routed(packs("PREPARE_FOR_SUBMISSION"));

    const result = await callTool(
      { versionId: VERSION_ID, includeAssetPacks: false, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("backgroundAssets"))).toBe(
      false,
    );
    expect(patchCall(fetchImpl)).toBeDefined();
  });

  it("does not submit when Apple refuses an asset pack, and says what is staged", async () => {
    const fetchImpl = routed({
      ...packs("PREPARE_FOR_SUBMISSION"),
      refuseAssetItem: () =>
        new Response(
          JSON.stringify({
            errors: [{ status: "409", code: "STATE_ERROR", title: "refused", detail: "refused" }],
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(patchCall(fetchImpl)).toBeUndefined();
    expect(textOf(result)).toContain("includeAssetPacks: false");
    expect(textOf(result)).toContain("NOT been sent to Apple");
  });

  it("leaves assetPacks out for an app that has none", async () => {
    const result = await callTool({ versionId: VERSION_ID, confirm: true }, routed());

    expect(payloadOf(result)).not.toHaveProperty("assetPacks");
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
    /** UNRESOLVED_ISSUES submissions: a rejection the developer has replied to. */
    returned?: unknown[];
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
        if (parsed.searchParams.get("filter[state]") === "UNRESOLVED_ISSUES") {
          return jsonResponse({ data: routes.returned ?? [] });
        }
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
   * Rejected, replied to in the Resolution Center: the version is READY_FOR_REVIEW
   * on no draft, but its submission is UNRESOLVED_ISSUES, which cancel refuses.
   * Pointing at cancel there sends the caller round in a loop.
   */
  it("names the rejected submission rather than pointing at cancel", async () => {
    const fetchImpl = routed({
      drafts: [],
      returned: [
        {
          id: "sub-returned",
          type: "reviewSubmissions",
          attributes: { platform: "MAC_OS", state: "UNRESOLVED_ISSUES" },
          relationships: {
            appStoreVersionForReview: { data: { id: VERSION_ID, type: "appStoreVersions" } },
          },
        },
      ],
    });

    const result = await callTool({ versionId: VERSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("sub-returned");
    expect(textOf(result)).toContain("app_store_connect_submit_version_for_review");
    expect(textOf(result)).not.toContain("has already gone to Apple");
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

describe("cancel_review_submission", () => {
  const SUBMISSION_ID = "sub-1";

  const routed = (
    state: string,
    items: unknown[] | (() => Response) = [],
  ): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      if (String(url).includes("/items")) {
        return typeof items === "function" ? items() : jsonResponse({ data: items });
      }
      return jsonResponse({
        data: { id: SUBMISSION_ID, type: "reviewSubmissions", attributes: { state } },
      });
    });

  /**
   * Chevalet's macOS submission (app 6828592664) as it stood on 2026-11-02: ids and states
   * recorded from list_review_submissions. Which relationship each item carries is what
   * Apple's items endpoint answers with `include`; the version and the two asset packs are
   * certain from the targets, the in-app purchase is the remaining item.
   */
  const chevaletItems = (): unknown[] => [
    {
      id: "ZWUxYjM0ZmUtZjdhMS00N2M0LTgzNTItOGYyYTZjYThjNTI3fDZ8ODk0MTgxNDAy",
      type: "reviewSubmissionItems",
      attributes: { state: "READY_FOR_REVIEW" },
      relationships: {
        appStoreVersion: {
          data: { type: "appStoreVersions", id: "05801b55-237e-48c8-9fc1-00ea3679759c" },
        },
      },
    },
    {
      id: "ZWUxYjM0ZmUtZjdhMS00N2M0LTgzNTItOGYyYTZjYThjNTI3fDE3fDQ4YTNkMDRiLThkODAtNGI5Mi1iYzcwLTljNzYyNzk0ZGY2Mw",
      type: "reviewSubmissionItems",
      attributes: { state: "READY_FOR_REVIEW" },
      relationships: {
        inAppPurchaseVersion: {
          data: { type: "inAppPurchaseVersions", id: "48a3d04b-8d80-4b92-bc70-9c762794df63" },
        },
      },
    },
    ...["76f69a11-31c0-4978-a9fa-6fd83955659d", "80a3af96-5df8-4681-8133-78ba31ddf3d5"].map(
      (target) => ({
        id: Buffer.from(`ee1b34fe-f7a1-47c4-8352-8f2a6ca8c527|14|${target}`).toString("base64"),
        type: "reviewSubmissionItems",
        attributes: { state: "ACCEPTED" },
        relationships: {
          backgroundAssetVersion: { data: { type: "backgroundAssetVersions", id: target } },
        },
      }),
    ),
  ];

  type CancelBody = {
    canceled?: boolean;
    otherItems: { kind?: string; restoredBy: string; how: string }[];
    note: string;
  };

  /** The decision Chevalet's cancel was made without: what else leaves with the version. */
  it("dryRun lists every other item and how it comes back, and cancels nothing", async () => {
    const fetchImpl = routed("WAITING_FOR_REVIEW", chevaletItems());

    const result = await callTool(
      { submissionId: SUBMISSION_ID, dryRun: true, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(patchCall(fetchImpl)).toBeUndefined();
    const body = payloadOf(result) as CancelBody;
    expect(body.canceled).toBe(false);
    expect(body.otherItems.map((item) => [item.kind, item.restoredBy])).toEqual([
      ["inAppPurchaseVersion", "webUi"],
      ["backgroundAssetVersion", "api"],
      ["backgroundAssetVersion", "api"],
    ]);
    expect(body.otherItems[0]?.how).toContain("Add for Review");
    expect(body.note).toContain("3 item(s) besides the version");
  });

  it("reports what the cancel removed", async () => {
    const fetchImpl = routed("WAITING_FOR_REVIEW", chevaletItems());

    const result = await callTool({ submissionId: SUBMISSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    expect(patchCall(fetchImpl)).toBeDefined();
    expect((payloadOf(result) as CancelBody).otherItems).toHaveLength(3);
  });

  it("does not cancel when the items cannot be read", async () => {
    const fetchImpl = routed(
      "WAITING_FOR_REVIEW",
      () =>
        new Response(JSON.stringify({ errors: [{ status: "500", code: "UNEXPECTED_ERROR" }] }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = await connect(
      { ...baseConfig, allowWrites: true, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_cancel_review_submission",
      arguments: { submissionId: SUBMISSION_ID, confirm: true },
    });

    expect(result.isError).toBe(true);
    expect(patchCall(fetchImpl)).toBeUndefined();
  });

  const callTool = async (
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name: "app_store_connect_cancel_review_submission", arguments: args });
  };

  it("cancels a submission that is waiting for review", async () => {
    const fetchImpl = routed("WAITING_FOR_REVIEW");

    const result = await callTool({ submissionId: SUBMISSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBeFalsy();
    const [url, init] = patchCall(fetchImpl) as [string, RequestInit];
    expect(url).toBe(`https://api.appstoreconnect.apple.com/v1/reviewSubmissions/${SUBMISSION_ID}`);
    expect(JSON.parse(String(init.body)).data.attributes).toEqual({ canceled: true });
  });

  /**
   * Apple accepts this cancel, and it is the expensive mistake: the rejected
   * submission is already editable, and resubmitting it keeps its queue position.
   */
  it("refuses a returned submission and points at resubmitting it", async () => {
    const fetchImpl = routed("UNRESOLVED_ISSUES");

    const result = await callTool({ submissionId: SUBMISSION_ID, confirm: true }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("app_store_connect_submit_version_for_review");
    expect(patchCall(fetchImpl)).toBeUndefined();
  });

  it("refuses without an explicit confirm", async () => {
    const fetchImpl = routed("WAITING_FOR_REVIEW");

    const result = await callTool({ submissionId: SUBMISSION_ID }, fetchImpl);

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("review submission items", () => {
  const submission = (id: string, state: string, itemIds: string[]): unknown => ({
    id,
    type: "reviewSubmissions",
    attributes: { state, platform: "IOS" },
    relationships: {
      items: { data: itemIds.map((itemId) => ({ type: "reviewSubmissionItems", id: itemId })) },
    },
  });
  const item = (id: string, state: string, relationships: unknown = {}): unknown => ({
    id,
    type: "reviewSubmissionItems",
    attributes: { state },
    relationships,
  });

  /**
   * Chevalet's macOS submission was WAITING_FOR_REVIEW with four items, and the list showed
   * only their ids and states. Whether a cancel would strip an asset pack is decided by what
   * each item is, on every row, not just a rejected one.
   */
  it("says what each item is on a submission still with Apple", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/v1/reviewSubmissions/sub-1/items")
        ? jsonResponse({
            data: [
              item("i1", "READY_FOR_REVIEW", {
                appStoreVersion: { data: { type: "appStoreVersions", id: "ver-1" } },
              }),
              item("i2", "ACCEPTED", {
                backgroundAssetVersion: {
                  data: { type: "backgroundAssetVersions", id: "bav-1" },
                },
              }),
            ],
          })
        : jsonResponse({
            data: [submission("sub-1", "WAITING_FOR_REVIEW", ["i1", "i2"])],
            included: [item("i1", "READY_FOR_REVIEW"), item("i2", "ACCEPTED")],
          }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_review_submissions",
        arguments: { appId: "1" },
      }),
    ) as { data: { items: unknown[] }[] };

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.searchParams.get("include")?.split(",")).toContain("items");
    expect(body.data[0]?.items).toEqual([
      { id: "i1", state: "READY_FOR_REVIEW", kind: "appStoreVersion", targetId: "ver-1" },
      { id: "i2", state: "ACCEPTED", kind: "backgroundAssetVersion", targetId: "bav-1" },
    ]);
  });

  it("skips the item read for a submission with no items", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [submission("sub-1", "COMPLETE", [])] }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_review_submissions",
      arguments: { appId: "1" },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /**
   * Recorded from Chevalet: an item id is base64 of `<submission>|<kind>|<target>`. With no
   * relationship to name it, the number and target are still worth reporting, as a number.
   */
  it("decodes the kind number and target when Apple names no relationship", async () => {
    const id =
      "ZWUxYjM0ZmUtZjdhMS00N2M0LTgzNTItOGYyYTZjYThjNTI3fDE3fDQ4YTNkMDRiLThkODAtNGI5Mi1iYzcwLTljNzYyNzk0ZGY2Mw";
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/items")
        ? jsonResponse({ data: [item(id, "READY_FOR_REVIEW")] })
        : jsonResponse({
            data: [submission("sub-1", "WAITING_FOR_REVIEW", [id])],
            included: [item(id, "READY_FOR_REVIEW")],
          }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_review_submissions",
        arguments: { appId: "1" },
      }),
    ) as { data: { items: unknown[] }[] };

    expect(body.data[0]?.items).toEqual([
      {
        id,
        state: "READY_FOR_REVIEW",
        kindCode: 17,
        targetId: "48a3d04b-8d80-4b92-bc70-9c762794df63",
      },
    ]);
  });

  /**
   * UNRESOLVED_ISSUES reads the same whether Apple turned down the version or the
   * in-app purchase riding with it; the item's kind is what tells them apart.
   */
  it("says what each item of a rejected submission is", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/v1/reviewSubmissions/sub-1/items")
        ? jsonResponse({
            data: [
              item("i1", "APPROVED", {
                appStoreVersion: { data: { type: "appStoreVersions", id: "ver-1" } },
              }),
              item("i2", "REJECTED", {
                inAppPurchaseVersion: { data: { type: "inAppPurchaseVersions", id: "iap-v1" } },
              }),
            ],
          })
        : jsonResponse({
            data: [submission("sub-1", "UNRESOLVED_ISSUES", ["i1", "i2"])],
            included: [item("i1", "APPROVED"), item("i2", "REJECTED")],
          }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_review_submissions",
        arguments: { appId: "1" },
      }),
    ) as { data: { items: unknown[] }[] };

    expect(body.data[0]?.items).toEqual([
      { id: "i1", state: "APPROVED", kind: "appStoreVersion", targetId: "ver-1" },
      { id: "i2", state: "REJECTED", kind: "inAppPurchaseVersion", targetId: "iap-v1" },
    ]);
  });

  /** Apple's answer to an include naming both experiment kinds, verbatim from the live API. */
  const bothExperiments = (): Response =>
    new Response(
      JSON.stringify({
        errors: [
          {
            status: "400",
            code: "PARAMETER_ERROR.INVALID",
            detail:
              "You cannot include appStoreVersionExperiment and appStoreVersionExperimentV2 at " +
              "the same time because they reference different versions of the same type.",
          },
        ],
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

  const returnedList = (): Response =>
    jsonResponse({
      data: [submission("sub-1", "UNRESOLVED_ISSUES", ["i1"])],
      included: [item("i1", "REJECTED")],
    });

  /** The bug this guards: asking for every item kind at once made Apple 400 the whole list. */
  it("never asks Apple for both experiment kinds at once", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (!String(url).includes("/items")) return returnedList();
      const include = new URL(url).searchParams.get("include")?.split(",") ?? [];
      return include.includes("appStoreVersionExperiment") &&
        include.includes("appStoreVersionExperimentV2")
        ? bothExperiments()
        : jsonResponse({
            data: [
              item("i1", "REJECTED", {
                appStoreVersion: { data: { type: "appStoreVersions", id: "ver-1" } },
              }),
            ],
          });
    });
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_review_submissions",
      arguments: { appId: "1" },
    });

    expect(result.isError).toBeFalsy();
    expect((payloadOf(result) as { data: { items: unknown[] }[] }).data[0]?.items).toEqual([
      { id: "i1", state: "REJECTED", kind: "appStoreVersion", targetId: "ver-1" },
    ]);
  });

  it("still lists the submissions when their items cannot be read", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/items") ? bothExperiments() : returnedList(),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_review_submissions",
      arguments: { appId: "1" },
    });

    expect(result.isError).toBeFalsy();
    const body = payloadOf(result) as { data: { items: unknown[] }[]; note?: string };
    expect(body.data[0]?.items).toEqual([{ id: "i1", state: "REJECTED" }]);
    expect(body.note).toContain("sub-1");
  });

  // Apple's `limit` spans the union of apps, so a partial page may hold one
  // app's rows only, the same warning builds and beta groups give.
  it("warns that a partial page across several apps may favour one", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [submission("sub-1", "COMPLETE", []), submission("sub-2", "COMPLETE", [])],
        meta: { paging: { total: 5, limit: 2 } },
      }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_review_submissions",
        arguments: { appId: ["1", "2"], limit: 2 },
      }),
    ) as { note?: string };

    expect(body.note).toContain("across all 2 apps");
  });

  it("says when the page is not the whole list", async () => {
    const next = "https://api.appstoreconnect.apple.com/v1/reviewSubmissions?cursor=Mg";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [submission("sub-1", "COMPLETE", []), submission("sub-2", "COMPLETE", [])],
        meta: { paging: { total: 5, limit: 2 } },
        links: { next },
      }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_review_submissions",
        arguments: { appId: "1", limit: 2 },
      }),
    ) as { incomplete?: { missing: number }; links?: { next: string } };

    expect(body.incomplete?.missing).toBe(3);
    expect(body.links?.next).toBe(next);
  });
});

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
