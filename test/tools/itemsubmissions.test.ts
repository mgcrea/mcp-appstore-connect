import { describe, expect, it } from "vitest";

import {
  apiError,
  baseConfig,
  callsTo,
  connect,
  jsonResponse,
  on,
  payloadOf,
  type Route,
  sentBody,
  stub,
  textOf,
} from "../helpers.js";

// Asset ids and attribute shapes are Cadence's (app 6798236186), read on
// 2026-11-08: the header creative asset, processed and unplaced.

const writes = { ...baseConfig, allowWrites: true };
const HEADER = "04c00019-534d-8a1a-8017-1011cafdafbe";
const SCREENSHOT = "c4c00019-534d-8a1a-8014-082cc6afde39";

const processedHeader = {
  category: "CREATIVE_ASSETS",
  fileName: "cadence-header-ebony.png",
  imageAsset: {
    templateUrl: "https://is1-ssl.mzstatic.com/image/thumb/SQUA_iG3dYSyMKYfXrT1Rg/{w}x{h}bb.{f}",
    width: 3840,
    height: 1646,
  },
  specId: "1eb43b80-e0b7-4d96-bd32-47a42a8c5fed",
  state: "PREPARE_FOR_SUBMISSION",
};

const image = (
  id: string,
  attributes: Record<string, unknown>,
  placements: string[] = [],
): Route[] => [
  on("GET", `/v1/appAssetLibraryImages/${id}`, () =>
    jsonResponse({ data: { id, type: "appAssetLibraryImages", attributes } }),
  ),
  on("GET", `/v1/appAssetLibraryImages/${id}/placements`, () =>
    jsonResponse({ data: placements.map((p) => ({ id: p, type: "appAssetLibraryPlacements" })) }),
  ),
];

const experimentRoute = (attributes: Record<string, unknown>): Route =>
  on("GET", "/v2/appStoreVersionExperiments/exp-1", () =>
    jsonResponse({
      data: {
        id: "exp-1",
        type: "appStoreVersionExperiments",
        attributes: { platform: "IOS", state: "PREPARE_FOR_SUBMISSION", ...attributes },
      },
    }),
  );

/** A submission row, as /v1/apps/{id}/reviewSubmissions answers with include=appStoreVersionForReview. */
const submission = (id: string, state: string, versionId?: string) => ({
  id,
  type: "reviewSubmissions",
  attributes: { platform: "IOS", state },
  relationships: {
    appStoreVersionForReview: {
      data: versionId ? { type: "appStoreVersions", id: versionId } : null,
    },
  },
});

/** An item, shaped as Apple answers with every kind included: one relationship set, the rest null. */
const item = (
  id: string,
  kind: string,
  type: string,
  targetId: string,
  state = "READY_FOR_REVIEW",
) => ({
  id,
  type: "reviewSubmissionItems",
  attributes: { state },
  relationships: { [kind]: { data: { type, id: targetId } }, appEvent: { data: null } },
});

const openSubmissions = (rows: unknown[], items: Record<string, unknown[]> = {}): Route[] => [
  on("GET", "/v1/apps/app-1/reviewSubmissions", (url) => {
    expect(url.searchParams.get("filter[platform]")).toBe("IOS");
    return jsonResponse({ data: rows });
  }),
  on("GET", /^\/v1\/reviewSubmissions\/[^/]+\/items$/, (url) =>
    jsonResponse({ data: items[url.pathname.split("/")[3] as string] ?? [] }),
  ),
];

const submitRoutes: Route[] = [
  on("POST", "/v1/reviewSubmissions", () =>
    jsonResponse({
      data: { id: "sub-new", type: "reviewSubmissions", attributes: { state: "READY_FOR_REVIEW" } },
    }),
  ),
  on("POST", "/v1/reviewSubmissionItems", () =>
    jsonResponse({ data: { id: "item-new", type: "reviewSubmissionItems" } }),
  ),
  on("PATCH", /^\/v1\/reviewSubmissions\/[^/]+$/, () =>
    jsonResponse({
      data: {
        id: "sub-new",
        type: "reviewSubmissions",
        attributes: { state: "WAITING_FOR_REVIEW" },
      },
    }),
  ),
];

const call = async (fetchImpl: ReturnType<typeof stub>, args: Record<string, unknown>) => {
  const client = await connect(writes, fetchImpl as unknown as typeof fetch);
  return client.callTool({
    name: "app_store_connect_submit_items_for_review",
    arguments: { appId: "app-1", confirm: true, ...args },
  });
};

describe("submit_items_for_review", () => {
  it("opens a submission with no version, adds an asset and a test, and submits", async () => {
    const fetchImpl = stub([
      ...image(HEADER, processedHeader),
      experimentRoute({}),
      ...openSubmissions([]),
      ...submitRoutes,
    ]);
    const result = await call(fetchImpl, { assetIds: [HEADER], experimentIds: ["exp-1"] });

    expect(result.isError, textOf(result)).toBeFalsy();
    const created = sentBody(callsTo(fetchImpl, "POST", "/v1/reviewSubmissions")[0]).data;
    expect(created.attributes).toEqual({ platform: "IOS" });
    expect(created.relationships).toEqual({ app: { data: { type: "apps", id: "app-1" } } });
    const items = callsTo(fetchImpl, "POST", "/v1/reviewSubmissionItems").map(
      (c) => sentBody(c).data.relationships,
    );
    expect(items).toEqual([
      {
        reviewSubmission: { data: { type: "reviewSubmissions", id: "sub-new" } },
        appAssetLibraryImage: { data: { type: "appAssetLibraryImages", id: HEADER } },
      },
      {
        reviewSubmission: { data: { type: "reviewSubmissions", id: "sub-new" } },
        appStoreVersionExperimentV2: { data: { type: "appStoreVersionExperiments", id: "exp-1" } },
      },
    ]);
    expect(
      sentBody(callsTo(fetchImpl, "PATCH", "/v1/reviewSubmissions/sub-new")[0]).data.attributes,
    ).toEqual({ submitted: true });
    expect(payloadOf(result)).toMatchObject({ submissionId: "sub-new", reusedDraft: false });
  });

  it("dryRun stages the items and never hands them to Apple", async () => {
    const fetchImpl = stub([
      ...image(HEADER, processedHeader),
      ...openSubmissions([]),
      ...submitRoutes,
    ]);
    const result = await call(fetchImpl, { assetIds: [HEADER], dryRun: true });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(callsTo(fetchImpl, "POST", "/v1/reviewSubmissionItems")).toHaveLength(1);
    expect(callsTo(fetchImpl, "PATCH", "/v1/reviewSubmissions/sub-new")).toHaveLength(0);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ dryRun: true, submitted: false });
    expect(payload.items).toEqual([
      { kind: "appAssetLibraryImage", id: HEADER, action: "wouldBeAdded" },
    ]);
    expect(String(payload.note)).toContain("one item-only submission per platform");
  });

  it("refuses a placed asset and an unprocessed one together, before creating anything", async () => {
    const fetchImpl = stub([
      ...image(HEADER, processedHeader, ["pl-on-treatment"]),
      ...image(SCREENSHOT, { state: "COMPLETE", imageAsset: null }),
      ...openSubmissions([]),
      ...submitRoutes,
    ]);
    const result = await call(fetchImpl, { assetIds: [HEADER, SCREENSHOT] });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("pl-on-treatment");
    expect(text).toContain("still processing");
    expect(callsTo(fetchImpl, "POST", "/v1/reviewSubmissions")).toHaveLength(0);
  });

  it("skips an asset that is already APPROVED", async () => {
    const fetchImpl = stub([
      ...image(HEADER, { ...processedHeader, state: "APPROVED" }),
      experimentRoute({}),
      ...openSubmissions([]),
      ...submitRoutes,
    ]);
    const result = await call(fetchImpl, { assetIds: [HEADER], experimentIds: ["exp-1"] });

    expect(payloadOf(result).items).toContainEqual({
      kind: "appAssetLibraryImage",
      id: HEADER,
      action: "skipped",
      reason: "already APPROVED",
    });
    expect(callsTo(fetchImpl, "POST", "/v1/reviewSubmissionItems")).toHaveLength(1);
  });

  it("refuses while another item-only submission is with Apple, and names it", async () => {
    const fetchImpl = stub([
      ...image(HEADER, processedHeader),
      ...openSubmissions([submission("sub-items", "WAITING_FOR_REVIEW")], {
        "sub-items": [item("i1", "appEvent", "appEvents", "ev-1")],
      }),
      ...submitRoutes,
    ]);
    const result = await call(fetchImpl, { assetIds: [HEADER] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("sub-items");
    expect(textOf(result)).toContain("one per platform");
    expect(callsTo(fetchImpl, "POST", "/v1/reviewSubmissions")).toHaveLength(0);
  });

  it("goes ahead beside a version submission that is with Apple", async () => {
    const fetchImpl = stub([
      ...image(HEADER, processedHeader),
      ...openSubmissions([submission("sub-version", "WAITING_FOR_REVIEW", "ver-1")]),
      ...submitRoutes,
    ]);
    const result = await call(fetchImpl, { assetIds: [HEADER] });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(payloadOf(result)).toMatchObject({ versionSubmissionWithApple: "sub-version" });
  });

  it("refuses a draft that holds a version, rather than riding along with it", async () => {
    const fetchImpl = stub([
      ...image(HEADER, processedHeader),
      ...openSubmissions([submission("sub-draft", "READY_FOR_REVIEW")], {
        "sub-draft": [item("i1", "appStoreVersion", "appStoreVersions", "ver-2")],
      }),
      ...submitRoutes,
    ]);
    const result = await call(fetchImpl, { assetIds: [HEADER] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("app_store_connect_remove_version_from_submission");
    expect(callsTo(fetchImpl, "POST", "/v1/reviewSubmissionItems")).toHaveLength(0);
  });

  it("resumes its own item-only draft without adding an item twice", async () => {
    const fetchImpl = stub([
      ...image(HEADER, { ...processedHeader, state: "READY_FOR_REVIEW" }),
      ...openSubmissions([submission("sub-draft", "READY_FOR_REVIEW")], {
        "sub-draft": [item("i1", "appAssetLibraryImage", "appAssetLibraryImages", HEADER)],
      }),
      ...submitRoutes,
    ]);
    const result = await call(fetchImpl, { assetIds: [HEADER] });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(callsTo(fetchImpl, "POST", "/v1/reviewSubmissions")).toHaveLength(0);
    expect(callsTo(fetchImpl, "POST", "/v1/reviewSubmissionItems")).toHaveLength(0);
    expect(callsTo(fetchImpl, "PATCH", "/v1/reviewSubmissions/sub-draft")).toHaveLength(1);
    expect(payloadOf(result)).toMatchObject({
      reusedDraft: true,
      items: [{ action: "alreadyOnSubmission" }],
    });
  });

  it("reports Apple's refusal of an item and submits nothing", async () => {
    const fetchImpl = stub([
      ...image(HEADER, processedHeader),
      experimentRoute({}),
      ...openSubmissions([]),
      on("POST", "/v1/reviewSubmissionItems", (_url, init) =>
        String(init.body).includes("appStoreVersionExperimentV2")
          ? apiError(409, "STATE_ERROR.ENTITY_STATE_INVALID", "Experiment is not ready for review")
          : jsonResponse({ data: { id: "item-new", type: "reviewSubmissionItems" } }),
      ),
      ...submitRoutes,
    ]);
    const result = await call(fetchImpl, { assetIds: [HEADER], experimentIds: ["exp-1"] });

    expect(result.isError, textOf(result)).toBeFalsy();
    const payload = payloadOf(result);
    expect(payload.submitted).toBe(false);
    const refused = (payload.items as Record<string, unknown>[]).find(
      (i) => i.action === "refused",
    );
    expect(refused).toMatchObject({ kind: "appStoreVersionExperimentV2", id: "exp-1" });
    expect(String(refused?.reason)).toContain("not ready for review");
    expect(callsTo(fetchImpl, "PATCH", "/v1/reviewSubmissions/sub-new")).toHaveLength(0);
  });

  it("refuses a test on another platform", async () => {
    const fetchImpl = stub([experimentRoute({ platform: "MAC_OS" }), ...openSubmissions([])]);
    const result = await call(fetchImpl, { experimentIds: ["exp-1"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("MAC_OS");
  });

  it("asks for at least one item", async () => {
    const fetchImpl = stub([]);
    const result = await call(fetchImpl, {});

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("item-only submissions elsewhere", () => {
  it("lists an item-only submission as such, naming a library asset item", async () => {
    const fetchImpl = stub([
      on("GET", "/v1/reviewSubmissions", () =>
        jsonResponse({
          data: [
            {
              ...submission("sub-items", "WAITING_FOR_REVIEW"),
              relationships: {
                app: { data: { type: "apps", id: "app-1" } },
                appStoreVersionForReview: { data: null },
                items: { data: [{ type: "reviewSubmissionItems", id: "i1" }] },
              },
            },
          ],
        }),
      ),
      on("GET", "/v1/reviewSubmissions/sub-items/items", (url) => {
        expect(url.searchParams.get("include")).toContain("appAssetLibraryImage");
        return jsonResponse({
          data: [item("i1", "appAssetLibraryImage", "appAssetLibraryImages", HEADER)],
        });
      }),
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_list_review_submissions",
      arguments: { appId: "app-1" },
    });

    const row = (payloadOf(result).data as Record<string, unknown>[])[0];
    expect(row).toMatchObject({
      itemOnly: true,
      items: [{ kind: "appAssetLibraryImage", targetId: HEADER }],
    });
  });

  it("cancel's dryRun says an item-only submission's items come back through the API", async () => {
    const fetchImpl = stub([
      on("GET", "/v1/reviewSubmissions/sub-items", () =>
        jsonResponse({ data: submission("sub-items", "WAITING_FOR_REVIEW") }),
      ),
      on("GET", "/v1/reviewSubmissions/sub-items/items", () =>
        jsonResponse({
          data: [
            item("i1", "appAssetLibraryImage", "appAssetLibraryImages", HEADER),
            item("i2", "appStoreVersionExperimentV2", "appStoreVersionExperiments", "exp-1"),
          ],
        }),
      ),
    ]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_cancel_review_submission",
      arguments: { submissionId: "sub-items", dryRun: true, confirm: true },
    });

    const payload = payloadOf(result);
    expect(String(payload.note)).toContain("item-only submission");
    expect(payload.otherItems).toEqual([
      expect.objectContaining({ kind: "appAssetLibraryImage", restoredBy: "api" }),
      expect.objectContaining({ kind: "appStoreVersionExperimentV2", restoredBy: "api" }),
    ]);
  });
});

describe("remove_submission_items", () => {
  const draftRoutes = (state: string): Route[] => [
    on("GET", "/v1/reviewSubmissions/sub-draft", () =>
      jsonResponse({ data: submission("sub-draft", state) }),
    ),
    on("GET", "/v1/reviewSubmissions/sub-draft/items", () =>
      jsonResponse({
        data: [
          item("i1", "appAssetLibraryImage", "appAssetLibraryImages", HEADER),
          item("i2", "appStoreVersionExperimentV2", "appStoreVersionExperiments", "exp-1"),
        ],
      }),
    ),
    on("DELETE", /^\/v1\/reviewSubmissionItems\//, () => new Response(null, { status: 204 })),
  ];
  const removeCall = async (fetchImpl: ReturnType<typeof stub>, itemIds: string[]) => {
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    return client.callTool({
      name: "app_store_connect_remove_submission_items",
      arguments: { submissionId: "sub-draft", itemIds, confirm: true },
    });
  };

  it("deletes the named items from a draft and reports what remains", async () => {
    const fetchImpl = stub(draftRoutes("READY_FOR_REVIEW"));
    const result = await removeCall(fetchImpl, ["i2"]);

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(callsTo(fetchImpl, "DELETE", "/v1/reviewSubmissionItems/i2")).toHaveLength(1);
    expect(payloadOf(result)).toMatchObject({
      removed: [{ id: "i2" }],
      remaining: [{ id: "i1" }],
    });
  });

  it("refuses a submission that is with Apple", async () => {
    const fetchImpl = stub(draftRoutes("WAITING_FOR_REVIEW"));
    const result = await removeCall(fetchImpl, ["i1"]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("app_store_connect_cancel_review_submission");
  });

  it("refuses ids that are not on the submission, removing nothing", async () => {
    const fetchImpl = stub(draftRoutes("READY_FOR_REVIEW"));
    const result = await removeCall(fetchImpl, ["i1", "nope"]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("nope");
    expect(callsTo(fetchImpl, "DELETE", "/v1/reviewSubmissionItems/i1")).toHaveLength(0);
  });
});
