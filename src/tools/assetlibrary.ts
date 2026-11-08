import { extname } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { AppStoreConnectApiError, hasApiError } from "#/client/errors";
import { sleep } from "#/client/http";
import { includedIndex, isRecord, resourcesOf, summarizeResponse, type Rec } from "#/client/shape";
import {
  attributesOf,
  idOf,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  readAsset,
  stripUploadOperations,
  uploadOperationsOf,
} from "#/tools/assets";
import {
  appIdArg,
  compact,
  confirmArg,
  limitArg,
  savePathArg,
  wrap,
  wrapSaved,
} from "#/tools/util";

// The App Asset Library (API 4.5.1) replaces screenshot sets, preview sets and
// in-app event media. An image or video is uploaded once into a per-app
// library, then *placed* on a surface — a version localization, a custom
// product page, an in-app event — under a placement type (APP_SCREENSHOT,
// PRODUCT_PAGE_HEADER_ASSET…) and a placement group (the device family).
//
// Placement groups and specifications are deliberately NOT hard-coded here, as
// the screenshot display types are: Apple adds device families (iPhone Duo was
// the first) to the reference data without an API version change, and says to
// read them at runtime. Every check below reads `/v1/appAssetLibraryRefData`.

const PLACEMENT_TYPES = [
  "APP_SCREENSHOT",
  "IMESSAGE_APP_SCREENSHOT",
  "APP_PREVIEW",
  "PRODUCT_PAGE_HEADER_ASSET",
  "APP_STORE_SEARCH_RESULTS_ASSET",
  "SEARCH_RESULTS_ADS_ASSET",
  "TODAY_TAB_ADS_ASSET",
  "EVENT_CARD_ASSET",
  "EVENT_DETAILS_PAGE_ASSET",
  "RETENTION_MESSAGE_ASSET",
] as const;

const ASSET_CATEGORIES = ["CREATIVE_ASSETS", "APP_SCREENSHOTS_AND_PREVIEWS"] as const;

const ASSET_STATES = [
  "AWAITING_UPLOAD",
  "UPLOAD_COMPLETE",
  "FAILED",
  "COMPLETE",
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "ACCEPTED",
  "APPROVED",
  "REJECTED",
  "ARCHIVED",
] as const;

/** The surfaces a placement can sit on, and the JSON:API names Apple uses for each. */
const SURFACES = {
  appStoreVersionLocalization: "appStoreVersionLocalizations",
  appCustomProductPageLocalization: "appCustomProductPageLocalizations",
  appEventLocalization: "appEventLocalizations",
  appStoreVersionExperimentTreatmentLocalization: "appStoreVersionExperimentTreatmentLocalizations",
} as const;
type Surface = keyof typeof SURFACES;
const SURFACE_NAMES = Object.keys(SURFACES) as [Surface, ...Surface[]];

/** Apple's ordering requests take no in-app event localization. */
const ORDERABLE_SURFACES = [
  "appStoreVersionLocalization",
  "appCustomProductPageLocalization",
  "appStoreVersionExperimentTreatmentLocalization",
] as const;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const VIDEO_EXTENSIONS = new Set([".mov", ".m4v", ".mp4"]);

/** The states an asset passes through before it can be placed. */
const PROCESSING_STATES = new Set(["AWAITING_UPLOAD", "UPLOAD_COMPLETE"]);

/**
 * Whether Apple has finished with the file, judged by what processing
 * produces rather than by `state` alone.
 *
 * The state is not enough: uploads in one Cadence batch came back `COMPLETE`
 * with `imageAsset: null` and no `specId`, while their siblings read
 * `UPLOAD_COMPLETE`, and both kinds reached PREPARE_FOR_SUBMISSION with a spec
 * later. An asset without its rendered file and matched spec cannot be checked
 * against a placement group, so it is still processing whatever it says.
 */
export const isProcessed = (kind: MediaKind, attrs: Rec): boolean => {
  const state = optString(attrs.state);
  if (state === undefined || state === "FAILED" || PROCESSING_STATES.has(state)) return false;
  return hasFile(kind, attrs) && optString(attrs.specId) !== undefined;
};

/**
 * Whether processing has produced the file. The two kinds spell it
 * differently: an image's `imageAsset` is an object (template URL and
 * dimensions), a video's `videoAsset` is the HLS playlist URL as a plain string.
 */
const hasFile = (kind: MediaKind, attrs: Rec): boolean =>
  kind === "image"
    ? isRecord(attrs.imageAsset)
    : isRecord(attrs.videoAsset) || optString(attrs.videoAsset) !== undefined;

/**
 * Apple's answer to a placement of an unapproved asset on a parent that is
 * already live: `409 ENTITY_ERROR.RELATIONSHIP.INVALID`, "The asset must be in
 * the APPROVED state because the parent is already approved."
 */
const APPROVED_PARENT = { code: "ENTITY_ERROR.RELATIONSHIP.INVALID", detail: /APPROVED/ };

const APPROVED_PARENT_ROUTE =
  "A parent that is already approved (a live version's localization, a running test's " +
  "treatment) only takes assets that are themselves APPROVED. Submit the asset on its own " +
  "with app_store_connect_submit_items_for_review (an app with an approved version can send " +
  "library assets to review without a new version), wait until " +
  "app_store_connect_get_library_asset reads APPROVED, then place it. Or place it on a version " +
  "still in PREPARE_FOR_SUBMISSION, where it is reviewed with that version.";

const POLL_INTERVALS_MS = [1000, 2000, 2000, 3000, 5000];

export type MediaKind = "image" | "video";
export const RESOURCE: Record<MediaKind, string> = {
  image: "appAssetLibraryImages",
  video: "appAssetLibraryVideos",
};

// ─── arguments ──────────────────────────────────────────────────────────────

const placementTypeArg = z
  .enum(PLACEMENT_TYPES)
  .describe(
    "Where the asset appears: APP_SCREENSHOT and APP_PREVIEW on the product page, " +
      "PRODUCT_PAGE_HEADER_ASSET and APP_STORE_SEARCH_RESULTS_ASSET for the iOS 27 creative " +
      "assets, EVENT_CARD_ASSET and EVENT_DETAILS_PAGE_ASSET for in-app events.",
  );

const placementGroupArg = z
  .string()
  .min(1)
  .describe(
    "The placement group (device family), e.g. IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE. Read the " +
      "valid groups for a placement type from app_store_connect_get_asset_specs — Apple adds " +
      "new device families (iPhone Duo) there without an API change.",
  );

const surfaceArg = z
  .enum(SURFACE_NAMES)
  .default("appStoreVersionLocalization")
  .describe(
    "What `localizationId` is: an App Store version localization (the default), a custom " +
      "product page localization, an in-app event localization, or a product page " +
      "optimization treatment localization.",
  );

const localizationIdArg = z
  .string()
  .min(1)
  .describe(
    "The localization the asset is placed on — by default an appStoreVersionLocalization id " +
      "(from app_store_connect_list_version_localizations). See `surface` for the others.",
  );

const assetIdArg = z
  .string()
  .min(1)
  .describe("An asset library image or video id (from app_store_connect_list_library_assets).");

const placementIdArg = z
  .string()
  .min(1)
  .describe("An asset library placement id (from app_store_connect_list_placements).");

const waitSecondsArg = (max: number, fallback: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(max)
    .default(fallback)
    .describe(
      "How long to wait for processing to finish (0 = don't wait). Timing out is not a " +
        "failure — the upload has already succeeded at that point.",
    );

// ─── reference data ─────────────────────────────────────────────────────────

type SpecMapping = { placementGroupId: string; specs: string[] };
type PlacementTypeRef = {
  placementTypeId: string;
  acceptsAssetCategories: string[];
  specMappings: SpecMapping[];
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Merge the attributes of every reference-data row. Apple returns the catalog
 * as a collection; nothing promises it is a single row, so a lookup that read
 * only the first one would miss a placement type the day it is split.
 */
const mergeRefData = (response: unknown): Rec => {
  const merged: Record<string, unknown[]> = {};
  for (const row of resourcesOf(response)) {
    const attrs = isRecord(row.attributes) ? row.attributes : {};
    for (const [key, value] of Object.entries(attrs)) {
      if (Array.isArray(value)) (merged[key] ??= []).push(...value);
    }
  }
  return merged;
};

const getRefData = async (
  client: AppStoreConnectClient,
  query: Record<string, string | undefined>,
): Promise<Rec> => mergeRefData(await client.get("/v1/appAssetLibraryRefData", compact(query)));

const placementTypeRef = async (
  client: AppStoreConnectClient,
  placementType: string,
): Promise<PlacementTypeRef> => {
  const ref = await getRefData(client, {
    "filter[placementTypes]": placementType,
    "fields[appAssetLibraryRefData]": "placementTypes",
  });
  const rows = Array.isArray(ref.placementTypes) ? ref.placementTypes : [];
  const row = rows.find((r) => isRecord(r) && r.placementTypeId === placementType);
  if (!isRecord(row)) {
    throw new Error(
      `App Store Connect's reference data has no placement type ${placementType}. Read the ` +
        `current catalog with app_store_connect_get_asset_specs.`,
    );
  }
  return {
    placementTypeId: placementType,
    acceptsAssetCategories: strings(row.acceptsAssetCategories),
    specMappings: (Array.isArray(row.specMappings) ? row.specMappings : [])
      .filter(isRecord)
      .map((m) => ({
        placementGroupId: typeof m.placementGroupId === "string" ? m.placementGroupId : "",
        specs: strings(m.specs),
      }))
      .filter((m) => m.placementGroupId !== ""),
  };
};

/**
 * Refuse a placement Apple would refuse, but with the valid choices in the
 * message. Apple's own answer to a wrong group is a bare 409; to a spec the
 * group does not take, a placement that sits FAILED until someone looks.
 */
const checkPlacement = (
  ref: PlacementTypeRef,
  placementGroup: string,
  asset?: { id: string; specId?: string | undefined; category?: string | undefined },
): void => {
  const mapping = ref.specMappings.find((m) => m.placementGroupId === placementGroup);
  if (!mapping) {
    const groups = ref.specMappings.map((m) => m.placementGroupId).toSorted();
    throw new Error(
      `${placementGroup} is not a placement group for ${ref.placementTypeId}. Valid groups: ` +
        `${groups.join(", ") || "(none listed)"}.`,
    );
  }
  if (!asset) return;
  if (
    asset.category !== undefined &&
    ref.acceptsAssetCategories.length > 0 &&
    !ref.acceptsAssetCategories.includes(asset.category)
  ) {
    throw new Error(
      `Asset ${asset.id} is in category ${asset.category}, and ${ref.placementTypeId} only ` +
        `accepts ${ref.acceptsAssetCategories.join(" or ")}. Upload it again with that category.`,
    );
  }
  if (
    asset.specId !== undefined &&
    mapping.specs.length > 0 &&
    !mapping.specs.includes(asset.specId)
  ) {
    throw new Error(
      `Asset ${asset.id} matched specification ${asset.specId}, which ${placementGroup} does ` +
        `not take for ${ref.placementTypeId} (it takes ${mapping.specs.join(", ")}). This is ` +
        `nearly always the wrong pixel dimensions or aspect ratio for that placement — check ` +
        `them with app_store_connect_get_asset_specs.`,
    );
  }
};

// ─── assets ─────────────────────────────────────────────────────────────────

const kindOfFile = (name: string): MediaKind => {
  const ext = extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  throw new Error(
    `"${name}" is neither an image (.png, .jpg, .jpeg) nor a video (.mov, .m4v, .mp4).`,
  );
};

/**
 * Read an asset by id without knowing whether it is an image or a video. The
 * two live in separate collections; an id from one 404s in the other.
 */
export const fetchAsset = async (
  client: AppStoreConnectClient,
  assetId: string,
): Promise<{ kind: MediaKind; response: unknown }> => {
  try {
    return { kind: "image", response: await client.get(`/v1/appAssetLibraryImages/${assetId}`) };
  } catch (err) {
    if (!(err instanceof AppStoreConnectApiError) || err.status !== 404) throw err;
  }
  try {
    return { kind: "video", response: await client.get(`/v1/appAssetLibraryVideos/${assetId}`) };
  } catch (err) {
    if (err instanceof AppStoreConnectApiError && err.status === 404) {
      throw new Error(`No asset library image or video has the id ${assetId}.`, { cause: err });
    }
    throw err;
  }
};

const optString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const describeDetails = (attrs: Rec): string =>
  (Array.isArray(attrs.stateDetails) ? attrs.stateDetails : [])
    .map((d) => (isRecord(d) ? [d.code, d.description].filter(Boolean).join(": ") : String(d)))
    .filter(Boolean)
    .join("; ");

const libraryIdOf = async (client: AppStoreConnectClient, appId: string): Promise<string> => {
  const id = idOf(await client.get(`/v1/apps/${appId}/assetLibrary`));
  if (!id) throw new Error(`App ${appId} returned no asset library.`);
  return id;
};

/**
 * Wait until Apple has processed the asset. Library assets report a flat
 * `state` string (AWAITING_UPLOAD → UPLOAD_COMPLETE → PREPARE_FOR_SUBMISSION),
 * not the nested `assetDeliveryState` of the old screenshot resources, and
 * `isProcessed` decides when that is done: the state alone has read COMPLETE
 * on an asset with no file and no spec yet.
 *
 * As there: the bytes are committed before this runs, so neither a timeout nor
 * a failed status read is a failed upload, and saying so would invite a retry
 * that duplicates the asset.
 */
const pollLibraryAsset = async (
  client: AppStoreConnectClient,
  kind: MediaKind,
  assetId: string,
  waitSeconds: number,
): Promise<{ done: boolean; attrs: Rec; note?: string }> => {
  const deadline = Date.now() + waitSeconds * 1000;
  for (let tick = 0; ; tick += 1) {
    let attrs: Rec;
    try {
      attrs = attributesOf(await client.get(`/v1/${RESOURCE[kind]}/${assetId}`));
    } catch (error) {
      return {
        done: false,
        attrs: {},
        note:
          `The upload itself succeeded, but reading its processing state failed ` +
          `(${error instanceof Error ? error.message : String(error)}). Do not re-upload — ` +
          `poll app_store_connect_get_library_asset for the final state.`,
      };
    }
    const state = optString(attrs.state);
    if (state === "FAILED") {
      const why = describeDetails(attrs);
      throw new Error(
        `App Store Connect rejected the ${kind} during processing${why ? `: ${why}` : ""}. ` +
          `This is nearly always dimensions, an alpha channel, or a duration outside the ` +
          `specification — see app_store_connect_get_asset_specs. The failed asset ${assetId} ` +
          `still exists — delete it with app_store_connect_delete_library_asset before retrying.`,
      );
    }
    if (isProcessed(kind, attrs)) return { done: true, attrs };
    if (Date.now() >= deadline) {
      return {
        done: false,
        attrs,
        note:
          `Still processing after ${waitSeconds}s. The upload itself succeeded, so this is not ` +
          `a failure and the asset must NOT be uploaded again. Poll ` +
          `app_store_connect_get_library_asset until it reports no \`stillProcessing\`.`,
      };
    }
    await sleep(POLL_INTERVALS_MS[Math.min(tick, POLL_INTERVALS_MS.length - 1)] as number);
  }
};

const createPlacementRequest = async (
  client: AppStoreConnectClient,
  args: {
    kind: MediaKind;
    assetId: string;
    surface: Surface;
    localizationId: string;
    placementType: string;
    placementGroup: string;
  },
): Promise<unknown> => {
  try {
    return await client.post("/v1/appAssetLibraryPlacements", {
      data: {
        type: "appAssetLibraryPlacements",
        attributes: { placementType: args.placementType, placementGroup: args.placementGroup },
        relationships: {
          [args.kind]: { data: { type: RESOURCE[args.kind], id: args.assetId } },
          [args.surface]: { data: { type: SURFACES[args.surface], id: args.localizationId } },
        },
      },
    });
  } catch (err) {
    if (hasApiError(err, APPROVED_PARENT.code, APPROVED_PARENT.detail)) {
      throw new Error(
        `Apple refused to place asset ${args.assetId} on ${args.localizationId}: the parent is ` +
          `already approved and the asset is not. ${APPROVED_PARENT_ROUTE}`,
        { cause: err },
      );
    }
    throw err;
  }
};

/** An asset's processing fields, plus `stillProcessing` when Apple is not done with it. */
const processingFields = (kind: MediaKind, attrs: Rec): Rec => ({
  state: optString(attrs.state) ?? "UNKNOWN",
  ...compact({
    specId: optString(attrs.specId),
    imageAsset: attrs.imageAsset ?? undefined,
    videoAsset: attrs.videoAsset ?? undefined,
  }),
  ...(isProcessed(kind, attrs) || attrs.state === "FAILED" ? {} : { stillProcessing: true }),
});

type UploadArgs = {
  appId: string;
  filePath?: string | undefined;
  fileData?: string | undefined;
  fileName?: string | undefined;
  referenceName?: string | undefined;
  category?: (typeof ASSET_CATEGORIES)[number] | undefined;
  previewFrameTimeCode?: string | undefined;
  localizationId?: string | undefined;
  surface: Surface;
  placementType?: (typeof PLACEMENT_TYPES)[number] | undefined;
  placementGroup?: string | undefined;
  waitSeconds: number;
};

const uploadLibraryAsset = async (
  client: AppStoreConnectClient,
  args: UploadArgs,
): Promise<unknown> => {
  const placing = [args.localizationId, args.placementType, args.placementGroup];
  const placeCount = placing.filter((v) => v !== undefined).length;
  if (placeCount !== 0 && placeCount !== 3) {
    throw new Error(
      "To place the asset in the same call, pass all three of `localizationId`, " +
        "`placementType` and `placementGroup` — or none of them, and place it later with " +
        "app_store_connect_create_placement.",
    );
  }

  const kind = kindOfFile(args.fileName ?? args.filePath ?? "");
  // Checked before any byte moves: a wrong group or category is cheaper to
  // learn now than after a 300 MB video has uploaded.
  const ref =
    args.placementType !== undefined
      ? await placementTypeRef(client, args.placementType)
      : undefined;
  if (ref && args.placementGroup !== undefined) checkPlacement(ref, args.placementGroup);

  const category = args.category ?? ref?.acceptsAssetCategories[0];
  if (!category) {
    throw new Error(
      "Pass `category` (CREATIVE_ASSETS for a header, search result or event asset; " +
        "APP_SCREENSHOTS_AND_PREVIEWS for a screenshot or app preview), or a `placementType` " +
        "to take it from.",
    );
  }

  const { bytes, name } = await readAsset(args.filePath, args.fileData, args.fileName, {
    what: kind === "image" ? "asset library image" : "asset library video",
    // Apple's image specs allow more than the 10 MB of the old screenshot
    // resources — a 5244x2950 universal PNG rarely fits in that — and each
    // spec states its own ceiling. Apple enforces it during processing.
    maxBytes: kind === "image" ? 5 * MAX_IMAGE_BYTES : MAX_VIDEO_BYTES,
    oversizeHint:
      kind === "image"
        ? "Export it at the exact required dimensions rather than oversampling."
        : "Re-encode it to bring it down.",
    inline: kind === "image",
  });

  const libraryId = await libraryIdOf(client, args.appId);
  const reserved = await client.post(`/v1/${RESOURCE[kind]}`, {
    data: {
      type: RESOURCE[kind],
      attributes: compact({
        category,
        fileName: name,
        fileSize: bytes.byteLength,
        referenceName: args.referenceName,
        ...(kind === "video" ? { previewFrameTimeCode: args.previewFrameTimeCode } : {}),
      }),
      relationships: {
        assetLibrary: { data: { type: "appAssetLibraries", id: libraryId } },
      },
    },
  });
  const assetId = idOf(reserved);
  if (!assetId) throw new Error(`Reserving the ${kind} returned no id.`);
  const operations = uploadOperationsOf(reserved);

  // Commit is `uploaded: true` alone: the asset library dropped the checksum.
  // An uncommitted reservation carries no diagnostic value, so a failure here
  // deletes it, best effort, before rethrowing.
  try {
    await client.uploadAsset(operations, bytes);
    await client.patch(`/v1/${RESOURCE[kind]}/${assetId}`, {
      data: { type: RESOURCE[kind], id: assetId, attributes: { uploaded: true } },
    });
  } catch (err) {
    await client.del(`/v1/${RESOURCE[kind]}/${assetId}`).catch(() => undefined);
    throw err;
  }

  const polled = await pollLibraryAsset(client, kind, assetId, args.waitSeconds);
  const result: Rec = {
    id: assetId,
    kind,
    category,
    fileName: name,
    fileSize: bytes.byteLength,
    parts: operations.length,
    ...processingFields(kind, polled.attrs),
  };
  if (!polled.done) {
    return {
      ...result,
      // Also when the status read failed and left no attributes to judge by.
      stillProcessing: true,
      note:
        polled.note +
        (placeCount === 3
          ? " It was not placed yet: once it is processed, call app_store_connect_create_placement."
          : ""),
    };
  }
  if (placeCount !== 3 || !ref) return result;

  // Check the spec Apple matched before placing, rather than leaving a placement
  // that sits FAILED: a 1320x2868 screenshot is no use as a product page header.
  checkPlacement(ref, args.placementGroup as string, {
    id: assetId,
    specId: optString(polled.attrs.specId),
    category,
  });
  const placement = await createPlacementRequest(client, {
    kind,
    assetId,
    surface: args.surface,
    localizationId: args.localizationId as string,
    placementType: args.placementType as string,
    placementGroup: args.placementGroup as string,
  });
  return { ...result, placement: summarizeResponse(placement) };
};

// ─── placements ─────────────────────────────────────────────────────────────

const placementsPath = (surface: Surface, localizationId: string): string =>
  `/v1/${SURFACES[surface]}/${localizationId}/placements`;

/**
 * Placements in display order, each with the file behind it, so a listing says
 * which screenshot sits where without a second call per row.
 */
const listPlacements = async (
  client: AppStoreConnectClient,
  args: {
    surface: Surface;
    localizationId: string;
    placementType?: string | undefined;
    placementGroup?: string | undefined;
    limit: number;
  },
): Promise<unknown> => {
  const response = await client.get(
    placementsPath(args.surface, args.localizationId),
    compact({
      "filter[placementType]": args.placementType,
      "filter[placementGroup]": args.placementGroup,
      sort: "placementGroupPosition",
      include: "image,video",
      limit: args.limit,
    }),
  );
  const images = includedIndex(response, "appAssetLibraryImages");
  const videos = includedIndex(response, "appAssetLibraryVideos");
  const summarized = summarizeResponse(response);
  if (!isRecord(summarized) || !Array.isArray(summarized.data)) return summarized;
  const raw = resourcesOf(response);
  return {
    ...summarized,
    data: summarized.data.map((row, i) => {
      const rels = raw[i]?.relationships;
      const linked = (name: "image" | "video"): Rec | undefined => {
        const rel = isRecord(rels) ? rels[name] : undefined;
        const ref = isRecord(rel) && isRecord(rel.data) ? rel.data : undefined;
        const id = optString(ref?.id);
        return id ? (name === "image" ? images : videos).get(id) : undefined;
      };
      const asset = linked("image") ?? linked("video");
      if (!asset || !isRecord(row)) return row;
      const attrs = isRecord(asset.attributes) ? asset.attributes : {};
      return {
        ...row,
        asset: compact({
          id: optString(asset.id),
          type: optString(asset.type),
          fileName: optString(attrs.fileName),
          referenceName: optString(attrs.referenceName),
          specId: optString(attrs.specId),
          state: optString(attrs.state),
          imageAsset: attrs.imageAsset,
          videoAsset: attrs.videoAsset,
        }),
      };
    }),
  };
};

/**
 * A group's placements in display order, each with its placement type. One
 * device group holds several types (the screenshots and the app preview), and
 * Apple orders each type on its own.
 */
const placementsInGroup = async (
  client: AppStoreConnectClient,
  surface: Surface,
  localizationId: string,
  placementGroup: string,
): Promise<{ id: string; placementType: string | undefined }[]> => {
  const { data } = await client.getAll<Rec>(placementsPath(surface, localizationId), {
    "filter[placementGroup]": placementGroup,
    sort: "placementGroupPosition",
    limit: 200,
  });
  return data.flatMap((row) => {
    const id = optString(row.id);
    if (id === undefined) return [];
    const attrs = isRecord(row.attributes) ? row.attributes : {};
    return [{ id, placementType: optString(attrs.placementType) }];
  });
};

/** "APP_PREVIEW: a, b; APP_SCREENSHOT: c" — a group's placements by type. */
const describeByType = (rows: { id: string; placementType: string | undefined }[]): string => {
  const byType = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.placementType ?? "unknown type";
    byType.set(key, [...(byType.get(key) ?? []), row.id]);
  }
  return [...byType].map(([type, ids]) => `${type}: ${ids.join(", ")}`).join("; ");
};

// ─── registration ───────────────────────────────────────────────────────────

export const registerAssetLibraryTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_get_asset_specs",
    {
      title: "App Store Connect: Get Asset Specifications",
      description:
        "Read the App Asset Library's reference data: the placement groups (device families, " +
        "e.g. IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE or the iPhone Duo group) each placement type " +
        "takes, which specifications each group accepts, and each image and video spec's " +
        "dimensions, aspect ratio, formats, alpha rule, size limit and duration. Apple adds " +
        "device families here without an API change, so read it rather than assuming. The " +
        "full catalog is large: filter by placement type, or pass savePath.",
      inputSchema: z.object({
        placementType: z
          .enum(PLACEMENT_TYPES)
          .optional()
          .describe("Only this placement type's groups and specs."),
        sections: z
          .array(
            z.enum([
              "features",
              "placementProfileGroups",
              "imageSpecs",
              "videoSpecs",
              "placementTypes",
              "displayClasses",
            ]),
          )
          .optional()
          .describe("Only these parts of the catalog. Omit for all of them."),
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ placementType, sections, savePath }) =>
      wrapSaved(savePath, async () =>
        getRefData(client, {
          "filter[placementTypes]": placementType,
          "fields[appAssetLibraryRefData]": sections?.join(","),
        }),
      ),
  );

  server.registerTool(
    "app_store_connect_list_library_assets",
    {
      title: "App Store Connect: List Library Assets",
      description:
        "List an app's App Asset Library: its images, or its videos, each with its category, " +
        "processing or review state, the specification App Store Connect matched (specId), " +
        "pixel size, reference name and how many placements use it.",
      inputSchema: z.object({
        appId: appIdArg,
        mediaType: z.enum(["image", "video"]).default("image").describe("Images or videos."),
        category: z.enum(ASSET_CATEGORIES).optional().describe("Only this category."),
        state: z.enum(ASSET_STATES).optional().describe("Only assets in this state."),
        referenceName: z.string().optional().describe("Only assets with this reference name."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, mediaType, category, state, referenceName, limit, savePath }) =>
      wrapSaved(savePath, async () => {
        const libraryId = await libraryIdOf(client, appId);
        const response = await client.get(
          `/v1/appAssetLibraries/${libraryId}/${mediaType === "image" ? "images" : "videos"}`,
          compact({
            "filter[category]": category,
            "filter[state]": state,
            "filter[referenceName]": referenceName,
            include: "placements",
            "limit[placements]": 50,
            sort: "-createdDate",
            limit,
          }),
        );
        const raw = resourcesOf(response);
        const summarized = stripUploadOperations(summarizeResponse(response));
        if (!isRecord(summarized) || !Array.isArray(summarized.data)) return summarized;
        return {
          libraryId,
          ...summarized,
          data: summarized.data.map((row, i) => {
            const rels = raw[i]?.relationships;
            const placements = isRecord(rels) && isRecord(rels.placements) ? rels.placements : {};
            const linked = Array.isArray(placements.data) ? placements.data.length : undefined;
            return isRecord(row) && linked !== undefined ? { ...row, placements: linked } : row;
          }),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_get_library_asset",
    {
      title: "App Store Connect: Get Library Asset",
      description:
        "Get one asset library image or video by id — its state (the way to follow an upload " +
        "that was still processing), the reason if it FAILED, the specification it matched, " +
        "and every placement that uses it. `stillProcessing: true` means Apple has not yet " +
        "produced the file or matched a spec, whatever `state` reads (it has read COMPLETE " +
        "then): wait, do not re-upload, and do not place it yet. APPROVED is what a live " +
        "parent needs before the asset can be placed on it.",
      inputSchema: z.object({ assetId: assetIdArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ assetId, savePath }) =>
      wrapSaved(savePath, async () => {
        const { kind, response } = await fetchAsset(client, assetId);
        const placements = await client.get(`/v1/${RESOURCE[kind]}/${assetId}/placements`, {
          limit: 200,
        });
        const asset = stripUploadOperations(summarizeResponse(response));
        const processing = processingFields(kind, attributesOf(response));
        return {
          kind,
          ...(isRecord(asset) && isRecord(asset.data) ? asset.data : { data: asset }),
          ...(processing.stillProcessing === true ? { stillProcessing: true } : {}),
          placements: summarizeResponse(placements),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_list_placements",
    {
      title: "App Store Connect: List Placements",
      description:
        "List the asset library placements on one localization — what appears where, in " +
        "display order, with the file behind each one. Filter by placement type or group. " +
        "This is the asset library's view of a product page's screenshots, previews and " +
        "creative assets.",
      inputSchema: z.object({
        localizationId: localizationIdArg,
        surface: surfaceArg,
        placementType: z.enum(PLACEMENT_TYPES).optional().describe("Only this placement type."),
        placementGroup: z.string().optional().describe("Only this placement group."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ savePath, ...args }) => wrapSaved(savePath, async () => listPlacements(client, args)),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_upload_library_asset",
    {
      title: "App Store Connect: Upload Library Asset",
      description:
        "Upload an image or video into an app's App Asset Library, and optionally place it in " +
        "the same call. This is the route Apple supports since API 4.5.1, and the only one for " +
        "iPhone Duo screenshots and the iOS 27 creative assets (product page header, search " +
        "results). Reserves the asset, uploads the bytes, commits, then waits for processing " +
        "and reports the specification App Store Connect matched (specId). When placing, the " +
        "placement group is checked against the reference data before anything uploads, and " +
        "the matched spec before the placement is created. " +
        "Processing: an asset is done only once it has its file (imageAsset/videoAsset) and a " +
        "specId; until then the result says `stillProcessing: true`, whatever `state` reads, " +
        "and nothing is placed. The default wait (40 s) stays under a 60 s MCP client timeout " +
        "with the transfer included. Running out of wait, or the client timing out, is NOT a " +
        "failure: the bytes are committed, so never re-upload; poll " +
        "app_store_connect_get_library_asset, then app_store_connect_create_placement. " +
        "Placing on a parent still in PREPARE_FOR_SUBMISSION (or back after a rejection) " +
        "always works. A parent that is already approved, such as a live version's " +
        "localization, answers 409 ENTITY_ERROR.RELATIONSHIP.INVALID 'The asset must be in " +
        "the APPROVED state': upload without placing, submit the asset alone with " +
        "app_store_connect_submit_items_for_review, wait for APPROVED, then place it.",
      inputSchema: z.object({
        appId: appIdArg,
        filePath: z
          .string()
          .optional()
          .describe(
            "Absolute path to a .png/.jpg/.jpeg image or a .mov/.m4v/.mp4 video, readable BY " +
              "THIS SERVER. If the server runs in Docker, a path inside the container.",
          ),
        fileData: z
          .string()
          .optional()
          .describe(
            "Base64 image bytes instead of `filePath` (images only). Requires `fileName`. Small " +
              "images only — this travels through the conversation.",
          ),
        fileName: z
          .string()
          .optional()
          .describe("Name to register. Defaults to the basename of `filePath`."),
        referenceName: z
          .string()
          .optional()
          .describe("A name for finding the asset in the library later."),
        category: z
          .enum(ASSET_CATEGORIES)
          .optional()
          .describe(
            "CREATIVE_ASSETS (header, search results, events) or APP_SCREENSHOTS_AND_PREVIEWS. " +
              "Defaults to what `placementType` accepts.",
          ),
        previewFrameTimeCode: z
          .string()
          .optional()
          .describe("Videos only: the poster frame, as HH:MM:SS:FF."),
        localizationId: localizationIdArg.optional(),
        surface: surfaceArg,
        placementType: placementTypeArg.optional(),
        placementGroup: placementGroupArg.optional(),
        waitSeconds: waitSecondsArg(600, 40),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => wrap(async () => uploadLibraryAsset(client, args)),
  );

  server.registerTool(
    "app_store_connect_create_placement",
    {
      title: "App Store Connect: Create Placement",
      description:
        "Place an asset already in the library on a localization, under a placement type and " +
        "group. One asset can back many placements, e.g. the same screenshot on every " +
        "localization. The group is checked against the reference data, and the asset's " +
        "matched specification against what the group takes, before anything is created, and " +
        "an asset still processing (no file or specId yet, whatever its state) is refused. " +
        "Parent: one in PREPARE_FOR_SUBMISSION takes any processed asset, which is then " +
        "reviewed with it; a draft product page optimization treatment localization (from " +
        "app_store_connect_create_experiment) works the same way. A parent that is already " +
        "approved, such as a live version's localization, only takes an APPROVED asset, and " +
        "Apple answers anything else 409 ENTITY_ERROR.RELATIONSHIP.INVALID 'The asset must be " +
        "in the APPROVED state because the parent is already approved'. The route there: " +
        "submit the asset on its own with app_store_connect_submit_items_for_review, wait for " +
        "APPROVED (app_store_connect_get_library_asset), then place it.",
      inputSchema: z.object({
        assetId: assetIdArg,
        localizationId: localizationIdArg,
        surface: surfaceArg,
        placementType: placementTypeArg,
        placementGroup: placementGroupArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) =>
      wrap(async () => {
        const { kind, response } = await fetchAsset(client, args.assetId);
        const attrs = attributesOf(response);
        const state = optString(attrs.state);
        if (state === "FAILED") {
          throw new Error(
            `Asset ${args.assetId} is FAILED, so it cannot be placed: ` +
              `${describeDetails(attrs) || "App Store Connect gave no reason"}.`,
          );
        }
        if (!isProcessed(kind, attrs)) {
          throw new Error(
            `Asset ${args.assetId} is still processing (state ${state ?? "unknown"}` +
              `${optString(attrs.specId) ? "" : ", no specId"}` +
              `${hasFile(kind, attrs) ? "" : ", no file yet"}), ` +
              `so it cannot be placed yet. Wait with app_store_connect_get_library_asset until it ` +
              `reports no stillProcessing; do not re-upload it.`,
          );
        }
        checkPlacement(await placementTypeRef(client, args.placementType), args.placementGroup, {
          id: args.assetId,
          specId: optString(attrs.specId),
          category: optString(attrs.category),
        });
        return summarizeResponse(await createPlacementRequest(client, { kind, ...args }));
      }),
  );

  server.registerTool(
    "app_store_connect_reorder_placements",
    {
      title: "App Store Connect: Reorder Placements",
      description:
        "Set the display order of the placements of one placement type in one group on one " +
        "localization — the order customers see. A device group can hold several types (its " +
        "screenshots and its app preview) and Apple orders each type on its own, so one call " +
        "orders one type: pass EVERY placement of that type in the group, and none of another. " +
        "The type is taken from the placements passed, or from `placementType`. The tool reads " +
        "the group first and refuses a list that leaves one of that type out, mixes types or " +
        "names one from elsewhere, because Apple does not document what an ordering request " +
        "does to a placement it omits.",
      inputSchema: z.object({
        localizationId: localizationIdArg,
        surface: z
          .enum(ORDERABLE_SURFACES)
          .default("appStoreVersionLocalization")
          .describe(
            "What `localizationId` is. In-app event localizations take no ordering request.",
          ),
        placementGroup: placementGroupArg,
        placementType: z
          .enum(PLACEMENT_TYPES)
          .optional()
          .describe(
            "The placement type being ordered, e.g. APP_SCREENSHOT. Defaults to the type of " +
              "the placements passed.",
          ),
        placementIds: z
          .array(z.string().min(1))
          .min(1)
          .describe("Every placement id of that type in the group, in the desired display order."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ localizationId, surface, placementGroup, placementType, placementIds }) =>
      wrap(async () => {
        const group = await placementsInGroup(client, surface, localizationId, placementGroup);
        const typeOf = new Map(group.map((row) => [row.id, row.placementType]));
        const passedTypes = [
          ...new Set(
            placementIds
              .map((id) => typeOf.get(id))
              .filter((type): type is string => type !== undefined),
          ),
        ];
        if (passedTypes.length > 1) {
          throw new Error(
            `The list mixes placement types (${passedTypes.join(", ")}), and Apple orders each ` +
              `type on its own. Order one type per call. The group currently holds, in order: ` +
              `${describeByType(group)}.`,
          );
        }
        const type = placementType ?? passedTypes[0];
        // Rows that carry no type are kept in, so a list is never checked
        // against less than it should be.
        const current = group
          .filter(
            (row) =>
              type === undefined || row.placementType === undefined || row.placementType === type,
          )
          .map((row) => row.id);
        const missing = current.filter((id) => !placementIds.includes(id));
        const foreign = placementIds.filter((id) => !current.includes(id));
        const repeated = placementIds.filter((id, i) => placementIds.indexOf(id) !== i);
        if (missing.length > 0 || foreign.length > 0 || repeated.length > 0) {
          const scope = type === undefined ? placementGroup : `${type} in ${placementGroup}`;
          throw new Error(
            [
              `The list must hold each placement of ${scope} exactly once.`,
              missing.length > 0 ? `Missing: ${missing.join(", ")}.` : "",
              foreign.length > 0 ? `Not ${scope}: ${foreign.join(", ")}.` : "",
              repeated.length > 0 ? `Repeated: ${[...new Set(repeated)].join(", ")}.` : "",
              `The group currently holds, in order: ${describeByType(group) || "(nothing)"}.`,
            ]
              .filter(Boolean)
              .join(" "),
          );
        }
        await client.post("/v1/appAssetLibraryPlacementOrderingRequests", {
          data: {
            type: "appAssetLibraryPlacementOrderingRequests",
            attributes: { placementGroup },
            relationships: {
              orderedPlacements: {
                data: placementIds.map((id) => ({ type: "appAssetLibraryPlacements", id })),
              },
              [surface]: { data: { type: SURFACES[surface], id: localizationId } },
            },
          },
        });
        return { localizationId, placementGroup, order: placementIds };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_placement",
    {
      title: "App Store Connect: Delete Placement",
      description:
        "Remove one placement: the asset stops appearing there, and stays in the library for " +
        "other placements. The parent must be editable.",
      inputSchema: z.object({ placementId: placementIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ placementId }) =>
      wrap(async () => {
        await client.del(`/v1/appAssetLibraryPlacements/${placementId}`);
        return { deleted: placementId };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_library_asset",
    {
      title: "App Store Connect: Delete Library Asset",
      description:
        "Delete an image or video from the asset library. Unlike the old screenshot sets, " +
        "nothing cascades: an asset that still has placements cannot be deleted — remove them " +
        "first with app_store_connect_delete_placement (app_store_connect_get_library_asset " +
        "lists them).",
      inputSchema: z.object({ assetId: assetIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ assetId }) =>
      wrap(async () => {
        const { kind } = await fetchAsset(client, assetId);
        try {
          await client.del(`/v1/${RESOURCE[kind]}/${assetId}`);
        } catch (err) {
          const codes =
            err instanceof AppStoreConnectApiError && Array.isArray(err.errors)
              ? err.errors.map((e) => (isRecord(e) ? optString(e.code) : undefined))
              : [];
          if (codes.includes("STATE_ERROR.ASSET_HAS_PLACEMENTS")) {
            const placements = await client.get(`/v1/${RESOURCE[kind]}/${assetId}/placements`, {
              limit: 200,
            });
            const ids = resourcesOf(placements)
              .map((p) => optString(p.id))
              .filter(Boolean);
            throw new Error(
              `Asset ${assetId} still has ${ids.length} placement(s): ${ids.join(", ")}. Delete ` +
                `them with app_store_connect_delete_placement first, then the asset.`,
              { cause: err },
            );
          }
          throw err;
        }
        return { deleted: assetId, kind };
      }),
  );
};
