import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  baseConfig,
  callsOf,
  connect,
  jsonResponse,
  on,
  payloadOf,
  type Route,
  stub,
  textOf,
} from "../helpers.js";

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/screenshot.png", import.meta.url));
const FIXTURE_SIZE = statSync(FIXTURE_PATH).size;
const UPLOAD_HOST = "https://upload.appstoreconnect.example";
const writes = { ...baseConfig, allowWrites: true };

/** What a processed image carries besides its state: the rendered file. */
const IMAGE_FILE = {
  templateUrl: "https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}bb.{f}",
  width: 1320,
  height: 2868,
};

const errorResponse = (status: number, code: string): Response =>
  new Response(JSON.stringify({ errors: [{ status: String(status), code, detail: code }] }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Reference data for APP_SCREENSHOT: two iPhone groups, each taking one spec. */
const refData = {
  data: [
    {
      id: "ref",
      type: "appAssetLibraryRefData",
      attributes: {
        placementTypes: [
          {
            placementTypeId: "APP_SCREENSHOT",
            acceptsAssetCategories: ["APP_SCREENSHOTS_AND_PREVIEWS"],
            specMappings: [
              { placementGroupId: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE", specs: ["SPEC_69"] },
              { placementGroupId: "IPHONE_DUO_PROFILE", specs: ["SPEC_DUO_INNER"] },
            ],
          },
        ],
      },
    },
  ],
};

type Call = [string, RequestInit];
const bodyOf = (call: Call | undefined): Record<string, any> =>
  JSON.parse(String(call?.[1].body ?? "{}")) as Record<string, any>;
const find = (
  fetchImpl: ReturnType<typeof vi.fn>,
  method: string,
  path: string,
): Call | undefined =>
  callsOf(fetchImpl).find(
    ([url, init]) => (init.method ?? "GET") === method && new URL(url).pathname === path,
  );

/** The routes every upload of `img-1` into `lib-1` takes, with a final state. */
const uploadRoutes = (finalAttributes: Record<string, unknown>): Route[] => [
  on("GET", "/v1/appAssetLibraryRefData", () => jsonResponse(refData)),
  on("GET", "/v1/apps/app-1/assetLibrary", () =>
    jsonResponse({ data: { id: "lib-1", type: "appAssetLibraries" } }),
  ),
  on("POST", "/v1/appAssetLibraryImages", () =>
    jsonResponse({
      data: {
        id: "img-1",
        type: "appAssetLibraryImages",
        attributes: {
          state: "AWAITING_UPLOAD",
          uploadOperations: [
            { method: "PUT", url: `${UPLOAD_HOST}/part-1`, offset: 0, length: FIXTURE_SIZE },
          ],
        },
      },
    }),
  ),
  (url, init) =>
    url.origin === UPLOAD_HOST && init.method === "PUT" ? new Response(null) : undefined,
  on("PATCH", "/v1/appAssetLibraryImages/img-1", () =>
    jsonResponse({ data: { id: "img-1", type: "appAssetLibraryImages" } }),
  ),
  on("GET", "/v1/appAssetLibraryImages/img-1", () =>
    jsonResponse({
      data: { id: "img-1", type: "appAssetLibraryImages", attributes: finalAttributes },
    }),
  ),
  on("POST", "/v1/appAssetLibraryPlacements", () =>
    jsonResponse({
      data: {
        id: "pl-1",
        type: "appAssetLibraryPlacements",
        attributes: { state: "PARENT_PREPARE_FOR_SUBMISSION" },
      },
    }),
  ),
];

const uploadArgs = {
  appId: "app-1",
  filePath: FIXTURE_PATH,
  localizationId: "loc-1",
  placementType: "APP_SCREENSHOT",
  placementGroup: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE",
};

describe("asset library upload", () => {
  it("reserves in the library, commits without a checksum, waits, then places", async () => {
    const fetchImpl = stub(
      uploadRoutes({ state: "PREPARE_FOR_SUBMISSION", specId: "SPEC_69", imageAsset: IMAGE_FILE }),
    );
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_upload_library_asset",
      arguments: uploadArgs,
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    const reserve = bodyOf(find(fetchImpl, "POST", "/v1/appAssetLibraryImages")).data;
    // The category comes from what the placement type accepts.
    expect(reserve.attributes.category).toBe("APP_SCREENSHOTS_AND_PREVIEWS");
    expect(reserve.attributes.fileName).toBe("screenshot.png");
    expect(reserve.relationships.assetLibrary.data).toEqual({
      type: "appAssetLibraries",
      id: "lib-1",
    });
    // The asset library dropped the checksum: `uploaded: true` and nothing else.
    expect(
      bodyOf(find(fetchImpl, "PATCH", "/v1/appAssetLibraryImages/img-1")).data.attributes,
    ).toEqual({ uploaded: true });
    const placement = bodyOf(find(fetchImpl, "POST", "/v1/appAssetLibraryPlacements")).data;
    expect(placement.attributes).toEqual({
      placementType: "APP_SCREENSHOT",
      placementGroup: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE",
    });
    expect(placement.relationships).toEqual({
      image: { data: { type: "appAssetLibraryImages", id: "img-1" } },
      appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: "loc-1" } },
    });
    const payload = payloadOf(result);
    expect(payload.specId).toBe("SPEC_69");
    expect(payload.placement).toMatchObject({ data: { id: "pl-1" } });
  });

  it("refuses an unknown placement group before uploading anything", async () => {
    const fetchImpl = stub(uploadRoutes({ state: "PREPARE_FOR_SUBMISSION" }));
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_upload_library_asset",
      arguments: { ...uploadArgs, placementGroup: "APP_IPHONE_67" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("IPHONE_DUO_PROFILE, IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE");
    expect(find(fetchImpl, "POST", "/v1/appAssetLibraryImages")).toBeUndefined();
  });

  it("does not place an asset whose matched spec the group does not take", async () => {
    const fetchImpl = stub(
      uploadRoutes({
        state: "PREPARE_FOR_SUBMISSION",
        specId: "SPEC_HEADER",
        imageAsset: IMAGE_FILE,
      }),
    );
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_upload_library_asset",
      arguments: uploadArgs,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("SPEC_HEADER");
    expect(textOf(result)).toContain("SPEC_69");
    expect(find(fetchImpl, "POST", "/v1/appAssetLibraryPlacements")).toBeUndefined();
  });

  it("names the delete tool when processing fails", async () => {
    const fetchImpl = stub(
      uploadRoutes({
        state: "FAILED",
        stateDetails: [{ code: "IMAGE_INCORRECT_DIMENSIONS", description: "wrong size" }],
      }),
    );
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_upload_library_asset",
      arguments: uploadArgs,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("IMAGE_INCORRECT_DIMENSIONS");
    expect(textOf(result)).toContain("app_store_connect_delete_library_asset");
  });

  it("treats COMPLETE with no file and no spec as still processing, and does not place", async () => {
    // Recorded from Cadence: some uploads in one batch answered COMPLETE with
    // `imageAsset: null` and no specId, while their siblings read UPLOAD_COMPLETE.
    const fetchImpl = stub(uploadRoutes({ state: "COMPLETE", imageAsset: null }));
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_upload_library_asset",
      arguments: { ...uploadArgs, waitSeconds: 0 },
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ id: "img-1", state: "COMPLETE", stillProcessing: true });
    expect(String(payload.note)).toContain("not a failure");
    expect(String(payload.note)).toContain("app_store_connect_create_placement");
    expect(find(fetchImpl, "POST", "/v1/appAssetLibraryPlacements")).toBeUndefined();
  });

  it("says stillProcessing on UPLOAD_COMPLETE too, the same way", async () => {
    const fetchImpl = stub(uploadRoutes({ state: "UPLOAD_COMPLETE" }));
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_upload_library_asset",
      arguments: {
        appId: "app-1",
        filePath: FIXTURE_PATH,
        category: "CREATIVE_ASSETS",
        waitSeconds: 0,
      },
    });

    expect(payloadOf(result)).toMatchObject({ state: "UPLOAD_COMPLETE", stillProcessing: true });
  });

  it("defaults the wait below a 60 s client timeout", async () => {
    const client = await connect(writes);
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "app_store_connect_upload_library_asset",
    );
    const properties = (tool?.inputSchema.properties ?? {}) as Record<string, { default?: number }>;
    const wait = properties.waitSeconds;
    expect(wait?.default).toBeLessThan(60);
  });

  it("asks for all three placement arguments or none", async () => {
    const fetchImpl = stub([]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_upload_library_asset",
      arguments: { appId: "app-1", filePath: FIXTURE_PATH, localizationId: "loc-1" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("all three");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("asset library placements", () => {
  const groupRoute = on("GET", "/v1/appStoreVersionLocalizations/loc-1/placements", () =>
    jsonResponse({
      data: [
        { id: "pl-a", type: "appAssetLibraryPlacements" },
        { id: "pl-b", type: "appAssetLibraryPlacements" },
      ],
    }),
  );

  it("refuses an order that leaves a placement out", async () => {
    const fetchImpl = stub([groupRoute]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_reorder_placements",
      arguments: {
        localizationId: "loc-1",
        placementGroup: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE",
        placementIds: ["pl-b"],
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Missing: pl-a");
    expect(find(fetchImpl, "POST", "/v1/appAssetLibraryPlacementOrderingRequests")).toBeUndefined();
  });

  it("posts an ordering request naming every placement in order", async () => {
    const fetchImpl = stub([
      groupRoute,
      on(
        "POST",
        "/v1/appAssetLibraryPlacementOrderingRequests",
        () => new Response(null, { status: 201 }),
      ),
    ]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_reorder_placements",
      arguments: {
        localizationId: "loc-1",
        placementGroup: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE",
        placementIds: ["pl-b", "pl-a"],
        confirm: true,
      },
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    const body = bodyOf(
      find(fetchImpl, "POST", "/v1/appAssetLibraryPlacementOrderingRequests"),
    ).data;
    expect(body.attributes).toEqual({ placementGroup: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE" });
    expect(body.relationships.orderedPlacements.data.map((p: { id: string }) => p.id)).toEqual([
      "pl-b",
      "pl-a",
    ]);
    expect(body.relationships.appStoreVersionLocalization.data.id).toBe("loc-1");
  });

  // Recorded from Cadence: one device group holds the screenshots and the app
  // preview, and Apple orders each placement type on its own — a request that
  // names both answers 409 "must have the same 'placementType'".
  const mixedGroupRoute = on("GET", "/v1/appStoreVersionLocalizations/loc-1/placements", () =>
    jsonResponse({
      data: [
        {
          id: "pl-vid",
          type: "appAssetLibraryPlacements",
          attributes: { placementType: "APP_PREVIEW" },
        },
        {
          id: "pl-a",
          type: "appAssetLibraryPlacements",
          attributes: { placementType: "APP_SCREENSHOT" },
        },
        {
          id: "pl-b",
          type: "appAssetLibraryPlacements",
          attributes: { placementType: "APP_SCREENSHOT" },
        },
      ],
    }),
  );

  it("orders the screenshots of a group that also holds a preview, without the preview", async () => {
    const fetchImpl = stub([
      mixedGroupRoute,
      on(
        "POST",
        "/v1/appAssetLibraryPlacementOrderingRequests",
        () => new Response(null, { status: 201 }),
      ),
    ]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_reorder_placements",
      arguments: {
        localizationId: "loc-1",
        placementGroup: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE",
        placementIds: ["pl-b", "pl-a"],
        confirm: true,
      },
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    const body = bodyOf(
      find(fetchImpl, "POST", "/v1/appAssetLibraryPlacementOrderingRequests"),
    ).data;
    expect(body.relationships.orderedPlacements.data.map((p: { id: string }) => p.id)).toEqual([
      "pl-b",
      "pl-a",
    ]);
  });

  it("refuses an order that mixes placement types, before Apple's 409", async () => {
    const fetchImpl = stub([mixedGroupRoute]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_reorder_placements",
      arguments: {
        localizationId: "loc-1",
        placementGroup: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE",
        placementIds: ["pl-vid", "pl-b", "pl-a"],
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("APP_PREVIEW");
    expect(text).toContain("APP_SCREENSHOT");
    expect(find(fetchImpl, "POST", "/v1/appAssetLibraryPlacementOrderingRequests")).toBeUndefined();
  });

  it("checks for missing placements within the one placement type", async () => {
    const fetchImpl = stub([mixedGroupRoute]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_reorder_placements",
      arguments: {
        localizationId: "loc-1",
        placementGroup: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE",
        placementType: "APP_SCREENSHOT",
        placementIds: ["pl-b"],
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Missing: pl-a.");
    expect(text).not.toContain("Missing: pl-vid");
    expect(find(fetchImpl, "POST", "/v1/appAssetLibraryPlacementOrderingRequests")).toBeUndefined();
  });

  it("lists placements with the file behind each one", async () => {
    const fetchImpl = stub([
      on("GET", "/v1/appStoreVersionLocalizations/loc-1/placements", (url) => {
        expect(url.searchParams.get("sort")).toBe("placementGroupPosition");
        expect(url.searchParams.get("include")).toBe("image,video");
        return jsonResponse({
          data: [
            {
              id: "pl-a",
              type: "appAssetLibraryPlacements",
              attributes: { placementType: "APP_SCREENSHOT", placementGroup: "G" },
              relationships: { image: { data: { type: "appAssetLibraryImages", id: "img-1" } } },
            },
          ],
          included: [
            {
              id: "img-1",
              type: "appAssetLibraryImages",
              attributes: { fileName: "01-fan~light.png", specId: "SPEC_69", state: "APPROVED" },
            },
          ],
        });
      }),
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_list_placements",
      arguments: { localizationId: "loc-1" },
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    const rows = payloadOf(result).data as Record<string, any>[];
    expect(rows[0]?.asset).toMatchObject({ id: "img-1", fileName: "01-fan~light.png" });
  });

  it("explains an asset that cannot be deleted while it is placed", async () => {
    const fetchImpl = stub([
      on("GET", "/v1/appAssetLibraryImages/img-1", () =>
        jsonResponse({ data: { id: "img-1", type: "appAssetLibraryImages", attributes: {} } }),
      ),
      on("DELETE", "/v1/appAssetLibraryImages/img-1", () =>
        errorResponse(409, "STATE_ERROR.ASSET_HAS_PLACEMENTS"),
      ),
      on("GET", "/v1/appAssetLibraryImages/img-1/placements", () =>
        jsonResponse({ data: [{ id: "pl-a", type: "appAssetLibraryPlacements" }] }),
      ),
    ]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_delete_library_asset",
      arguments: { assetId: "img-1", confirm: true },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("pl-a");
    expect(textOf(result)).toContain("app_store_connect_delete_placement");
  });

  const imageRoute = (attributes: Record<string, unknown>): Route =>
    on("GET", "/v1/appAssetLibraryImages/img-1", () =>
      jsonResponse({ data: { id: "img-1", type: "appAssetLibraryImages", attributes } }),
    );
  const placeArgs = {
    assetId: "img-1",
    localizationId: "loc-live",
    placementType: "APP_SCREENSHOT",
    placementGroup: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE",
  };

  it("refuses to place an asset that reads COMPLETE but has no file or spec yet", async () => {
    const fetchImpl = stub([imageRoute({ state: "COMPLETE", imageAsset: null })]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_create_placement",
      arguments: placeArgs,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("still processing");
    expect(find(fetchImpl, "POST", "/v1/appAssetLibraryPlacements")).toBeUndefined();
  });

  it("explains the 409 an approved parent gives an unapproved asset, and the route out", async () => {
    // Recorded from Cadence: placing on the live iOS 1.10.1 localization.
    const fetchImpl = stub([
      imageRoute({
        state: "PREPARE_FOR_SUBMISSION",
        specId: "SPEC_69",
        category: "APP_SCREENSHOTS_AND_PREVIEWS",
        imageAsset: IMAGE_FILE,
      }),
      on("GET", "/v1/appAssetLibraryRefData", () => jsonResponse(refData)),
      on(
        "POST",
        "/v1/appAssetLibraryPlacements",
        () =>
          new Response(
            JSON.stringify({
              errors: [
                {
                  status: "409",
                  code: "ENTITY_ERROR.RELATIONSHIP.INVALID",
                  title: "The provided entity includes a relationship with an invalid value",
                  detail:
                    "The asset must be in the APPROVED state because the parent is already approved.",
                },
              ],
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      ),
    ]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_create_placement",
      arguments: placeArgs,
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("already approved");
    expect(text).toContain("app_store_connect_submit_items_for_review");
    expect(text).toContain("APPROVED");
  });

  it("flags an asset still processing when it is read", async () => {
    const fetchImpl = stub([
      imageRoute({ state: "COMPLETE", imageAsset: null }),
      on("GET", "/v1/appAssetLibraryImages/img-1/placements", () => jsonResponse({ data: [] })),
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_get_library_asset",
      arguments: { assetId: "img-1" },
    });

    expect(payloadOf(result)).toMatchObject({ state: "COMPLETE", stillProcessing: true });
  });

  it("finds a video by id when it is not an image", async () => {
    const fetchImpl = stub([
      on("GET", "/v1/appAssetLibraryImages/vid-1", () => errorResponse(404, "NOT_FOUND")),
      on("GET", "/v1/appAssetLibraryVideos/vid-1", () =>
        jsonResponse({
          data: { id: "vid-1", type: "appAssetLibraryVideos", attributes: { state: "APPROVED" } },
        }),
      ),
      on("GET", "/v1/appAssetLibraryVideos/vid-1/placements", () => jsonResponse({ data: [] })),
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_get_library_asset",
      arguments: { assetId: "vid-1" },
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(payloadOf(result)).toMatchObject({ kind: "video", id: "vid-1", state: "APPROVED" });
  });

  // Recorded from Cadence: a processed video's `videoAsset` is the HLS URL as a
  // plain string, where an image's `imageAsset` is an object.
  const PROCESSED_VIDEO = {
    state: "PREPARE_FOR_SUBMISSION",
    specId: "SPEC_PREVIEW",
    category: "APP_SCREENSHOTS_AND_PREVIEWS",
    videoAsset: "https://apptrailers.itunes.apple.com/itunes-assets/x/P1_default.m3u8",
  };
  const videoRoutes = (attributes: Record<string, unknown>): Route[] => [
    on("GET", "/v1/appAssetLibraryImages/vid-1", () => errorResponse(404, "NOT_FOUND")),
    on("GET", "/v1/appAssetLibraryVideos/vid-1", () =>
      jsonResponse({ data: { id: "vid-1", type: "appAssetLibraryVideos", attributes } }),
    ),
  ];

  it("does not flag a processed video whose file is a URL string", async () => {
    const fetchImpl = stub([
      ...videoRoutes(PROCESSED_VIDEO),
      on("GET", "/v1/appAssetLibraryVideos/vid-1/placements", () => jsonResponse({ data: [] })),
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_get_library_asset",
      arguments: { assetId: "vid-1" },
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(payloadOf(result)).not.toHaveProperty("stillProcessing");
  });

  it("places a processed video", async () => {
    const previewRef = {
      data: [
        {
          id: "ref",
          type: "appAssetLibraryRefData",
          attributes: {
            placementTypes: [
              {
                placementTypeId: "APP_PREVIEW",
                acceptsAssetCategories: ["APP_SCREENSHOTS_AND_PREVIEWS"],
                specMappings: [
                  {
                    placementGroupId: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE",
                    specs: ["SPEC_PREVIEW"],
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const fetchImpl = stub([
      ...videoRoutes(PROCESSED_VIDEO),
      on("GET", "/v1/appAssetLibraryRefData", () => jsonResponse(previewRef)),
      on("POST", "/v1/appAssetLibraryPlacements", () =>
        jsonResponse({ data: { id: "pl-vid", type: "appAssetLibraryPlacements" } }),
      ),
    ]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_create_placement",
      arguments: {
        assetId: "vid-1",
        localizationId: "loc-1",
        placementType: "APP_PREVIEW",
        placementGroup: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE",
      },
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    const body = bodyOf(find(fetchImpl, "POST", "/v1/appAssetLibraryPlacements")).data;
    expect(body.relationships.video.data.id).toBe("vid-1");
  });

  it("still refuses a video with no file yet", async () => {
    const fetchImpl = stub(videoRoutes({ ...PROCESSED_VIDEO, videoAsset: null }));
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_create_placement",
      arguments: {
        assetId: "vid-1",
        localizationId: "loc-1",
        placementType: "APP_PREVIEW",
        placementGroup: "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE",
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no file yet");
  });
});
