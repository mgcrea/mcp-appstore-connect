import { createHash } from "node:crypto";
import { extname } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient, UploadOperation } from "#/client/asc";
import { isRecord, summarizeResponse } from "#/client/shape";
import {
  attributesOf,
  idOf,
  MAX_VIDEO_BYTES,
  pollAssetState,
  readAsset,
  stripUploadOperations,
} from "#/tools/assets";
import { compact, confirmArg, limitArg, savePathArg, wrap, wrapSaved } from "#/tools/util";

/**
 * Apple's PreviewType enum (spec 4.5). Unlike screenshot display types these
 * carry no `APP_` prefix, and there is no Watch or iMessage entry — neither
 * takes a preview. Hardcoded for the same reason as SCREENSHOT_DISPLAY_TYPES.
 */
const PREVIEW_TYPES = [
  "IPHONE_67",
  "IPHONE_61",
  "IPHONE_65",
  "IPHONE_58",
  "IPHONE_55",
  "IPHONE_47",
  "IPHONE_40",
  "IPHONE_35",
  "IPAD_PRO_3GEN_129",
  "IPAD_PRO_3GEN_11",
  "IPAD_PRO_129",
  "IPAD_105",
  "IPAD_97",
  "DESKTOP",
  "APPLE_TV",
  "APPLE_VISION_PRO",
] as const;

/** The containers Apple accepts, keyed by extension so the type is sent with the reservation. */
const VIDEO_MIME_TYPES: Record<string, string> = {
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mp4": "video/mp4",
};

const localizationIdArg = z
  .string()
  .min(1)
  .describe(
    "The appStoreVersionLocalization id (from app_store_connect_list_version_localizations).",
  );

const previewSetIdArg = z
  .string()
  .min(1)
  .describe("The appPreviewSet id (from app_store_connect_list_preview_sets).");

const previewIdArg = z
  .string()
  .min(1)
  .describe("The appPreview id (from app_store_connect_list_previews).");

const previewTypeArg = z
  .enum(PREVIEW_TYPES)
  .describe(
    "Device family the preview is for. Same families as screenshots without the APP_ prefix: " +
      "IPHONE_67, IPAD_PRO_3GEN_129, DESKTOP (macOS), …",
  );

const frameTimeCodeArg = z
  .string()
  .regex(/^\d{2}:\d{2}:\d{2}:\d{2}$/, "Use hours:minutes:seconds:frames, e.g. 00:00:05:00.")
  .describe(
    "Poster frame — the still shown before the video plays — as hours:minutes:seconds:frames, " +
      "e.g. 00:00:05:00. App Store Connect picks one itself when unset.",
  );

const findPreviewSet = async (
  client: AppStoreConnectClient,
  localizationId: string,
  previewType: string,
): Promise<string | undefined> => {
  const res = await client.get(
    `/v1/appStoreVersionLocalizations/${localizationId}/appPreviewSets`,
    { limit: 50 },
  );
  if (!isRecord(res) || !Array.isArray(res.data)) return undefined;
  for (const row of res.data) {
    if (!isRecord(row) || !isRecord(row.attributes)) continue;
    if (row.attributes.previewType === previewType && typeof row.id === "string") return row.id;
  }
  return undefined;
};

const createPreviewSet = async (
  client: AppStoreConnectClient,
  localizationId: string,
  previewType: string,
): Promise<string> => {
  const res = await client.post("/v1/appPreviewSets", {
    data: {
      type: "appPreviewSets",
      attributes: { previewType },
      relationships: {
        appStoreVersionLocalization: {
          data: { type: "appStoreVersionLocalizations", id: localizationId },
        },
      },
    },
  });
  const id = idOf(res);
  if (!id) throw new Error(`Creating the ${previewType} preview set returned no id.`);
  return id;
};

const setPosterFrame = async (
  client: AppStoreConnectClient,
  previewId: string,
  previewFrameTimeCode: string,
): Promise<void> => {
  await client.patch(`/v1/appPreviews/${previewId}`, {
    data: { type: "appPreviews", id: previewId, attributes: { previewFrameTimeCode } },
  });
};

type UploadArgs = {
  localizationId: string;
  previewType: string;
  filePath: string;
  fileName?: string | undefined;
  previewSetId?: string | undefined;
  previewFrameTimeCode?: string | undefined;
  waitSeconds: number;
};

const uploadPreview = async (client: AppStoreConnectClient, args: UploadArgs): Promise<unknown> => {
  const mimeType = VIDEO_MIME_TYPES[extname(args.fileName ?? args.filePath).toLowerCase()];
  if (!mimeType) {
    throw new Error(
      `An app preview must be a .mov, .m4v or .mp4 file (got "${args.fileName ?? args.filePath}").`,
    );
  }
  const { bytes, name } = await readAsset(args.filePath, undefined, args.fileName, {
    what: "app preview",
    maxBytes: MAX_VIDEO_BYTES,
    oversizeHint: "Re-encode it (H.264 or ProRes 422 HQ, 15 to 30 seconds) to bring it down.",
    inline: false,
  });

  const existingSetId =
    args.previewSetId ?? (await findPreviewSet(client, args.localizationId, args.previewType));
  const previewSetId =
    existingSetId ?? (await createPreviewSet(client, args.localizationId, args.previewType));

  const reserved = await client.post("/v1/appPreviews", {
    data: {
      type: "appPreviews",
      attributes: { fileName: name, fileSize: bytes.byteLength, mimeType },
      relationships: {
        appPreviewSet: { data: { type: "appPreviewSets", id: previewSetId } },
      },
    },
  });
  const previewId = idOf(reserved);
  if (!previewId) throw new Error("Reserving the app preview returned no id.");
  const attrs = attributesOf(reserved);
  const operations = (
    Array.isArray(attrs.uploadOperations) ? attrs.uploadOperations : []
  ) as UploadOperation[];

  try {
    await client.uploadAsset(operations, bytes);
    await client.patch(`/v1/appPreviews/${previewId}`, {
      data: {
        type: "appPreviews",
        id: previewId,
        attributes: {
          uploaded: true,
          sourceFileChecksum: createHash("md5").update(bytes).digest("hex"),
        },
      },
    });
  } catch (err) {
    // Same reasoning as a screenshot: an uncommitted reservation is invisible
    // in the UI but still blocks submission.
    await client.del(`/v1/appPreviews/${previewId}`).catch(() => undefined);
    throw err;
  }

  const result = await pollAssetState(client, {
    resourcePath: "/v1/appPreviews",
    assetId: previewId,
    waitSeconds: args.waitSeconds,
    meta: {
      previewSetId,
      previewSetCreated: existingSetId === undefined,
      previewType: args.previewType,
      fileName: name,
      fileSize: bytes.byteLength,
      mimeType,
      parts: operations.length,
    },
    failureHint:
      `This is almost always the resolution, frame rate, duration (15 to 30 seconds) or audio ` +
      `track not matching Apple's app preview specifications for ${args.previewType}.`,
    deleteToolName: "app_store_connect_delete_preview",
    pollToolName: "app_store_connect_get_preview",
    stateAttributes: ["videoDeliveryState", "assetDeliveryState"],
    resultAttributes: ["previewFrameTimeCode", "previewFrameImage"],
    what: "video",
  });

  if (args.previewFrameTimeCode === undefined) return result;

  // A poster frame only sticks once the video is processed — App Store Connect
  // picks its own while it transcodes — so it is set after, never with the
  // reservation.
  if (!isRecord(result) || result.state !== "COMPLETE") {
    return {
      ...(isRecord(result) ? result : {}),
      posterFrameSet: false,
      posterFrameNote:
        `The poster frame can only be set once processing finishes — call ` +
        `app_store_connect_set_preview_poster_frame with ${args.previewFrameTimeCode} then.`,
    };
  }
  try {
    await setPosterFrame(client, previewId, args.previewFrameTimeCode);
  } catch (error) {
    return {
      ...result,
      posterFrameSet: false,
      posterFrameNote:
        `The video is uploaded, but setting the poster frame failed ` +
        `(${error instanceof Error ? error.message : String(error)}). Do not re-upload — retry ` +
        `with app_store_connect_set_preview_poster_frame.`,
    };
  }
  return { ...result, previewFrameTimeCode: args.previewFrameTimeCode, posterFrameSet: true };
};

export const registerPreviewTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_preview_sets",
    {
      title: "App Store Connect: List App Preview Sets",
      description:
        "List the app preview (video) sets of one App Store version localization — one set per " +
        "device type (previewType). Returns the set ids you upload into or reorder. A version " +
        "with no previews simply has no sets; previews are optional.",
      inputSchema: z.object({
        localizationId: localizationIdArg,
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ localizationId, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(
            `/v1/appStoreVersionLocalizations/${localizationId}/appPreviewSets`,
            compact({ limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_previews",
    {
      title: "App Store Connect: List App Previews",
      description:
        "List the app previews in one set, in display order, with each file name, poster frame " +
        "and processing state.",
      inputSchema: z.object({
        previewSetId: previewSetIdArg,
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ previewSetId, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        stripUploadOperations(
          summarizeResponse(
            await client.get(`/v1/appPreviewSets/${previewSetId}/appPreviews`, compact({ limit })),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_preview",
    {
      title: "App Store Connect: Get App Preview",
      description:
        "Get one app preview, including its videoDeliveryState — the way to check whether App " +
        "Store Connect finished processing an upload. Video processing often takes several " +
        "minutes.",
      inputSchema: z.object({ previewId: previewIdArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ previewId, savePath }) =>
      wrapSaved(savePath, async () =>
        stripUploadOperations(summarizeResponse(await client.get(`/v1/appPreviews/${previewId}`))),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_upload_preview",
    {
      title: "App Store Connect: Upload App Preview",
      description:
        "Upload an app preview video to an App Store version localization. Runs the whole " +
        "upload flow: finds or creates the set for the device type, reserves the asset, uploads " +
        "the bytes, commits the checksum, then waits for processing and, if asked, sets the " +
        "poster frame. App Store Connect checks the video (resolution, frame rate, 15 to 30 s " +
        "duration) while it transcodes, which often takes longer than the wait — a timeout is " +
        "not a failure. The version must be editable (PREPARE_FOR_SUBMISSION, or back after a " +
        "rejection), and a set holds at most 3 previews.",
      inputSchema: z.object({
        localizationId: localizationIdArg,
        previewType: previewTypeArg,
        filePath: z
          .string()
          .min(1)
          .describe(
            "Absolute path to a .mov/.m4v/.mp4 readable BY THIS SERVER (up to 500 MB). If the " +
              "server runs in Docker, this must be a path inside the container.",
          ),
        fileName: z
          .string()
          .optional()
          .describe("Name to register with App Store Connect. Defaults to the basename."),
        previewSetId: z
          .string()
          .optional()
          .describe("Upload into this exact set instead of looking one up by `previewType`."),
        previewFrameTimeCode: frameTimeCodeArg.optional(),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .default(120)
          .describe(
            "How long to wait for processing to finish (0 = don't wait). Timing out is not a " +
              "failure — the upload has already succeeded at that point.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => wrap(async () => uploadPreview(client, args)),
  );

  server.registerTool(
    "app_store_connect_set_preview_poster_frame",
    {
      title: "App Store Connect: Set App Preview Poster Frame",
      description:
        "Set an app preview's poster frame — the still customers see before the video plays. " +
        "Only takes effect once the preview has finished processing.",
      inputSchema: z.object({
        previewId: previewIdArg,
        previewFrameTimeCode: frameTimeCodeArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ previewId, previewFrameTimeCode }) =>
      wrap(async () => {
        await setPosterFrame(client, previewId, previewFrameTimeCode);
        return { previewId, previewFrameTimeCode };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_preview",
    {
      title: "App Store Connect: Delete App Preview",
      description:
        "Delete one app preview from its set. Use this to remove a preview App Store Connect " +
        "rejected during processing, or to make room in a full set.",
      inputSchema: z.object({ previewId: previewIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ previewId }) =>
      wrap(async () => {
        await client.del(`/v1/appPreviews/${previewId}`);
        return { deleted: previewId };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_preview_set",
    {
      title: "App Store Connect: Delete App Preview Set",
      description:
        "Delete an entire app preview set, and with it EVERY preview for that device type. " +
        "This is the way to replace a device type's previews wholesale: delete the set, then " +
        "upload the new videos.",
      inputSchema: z.object({ previewSetId: previewSetIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ previewSetId }) =>
      wrap(async () => {
        await client.del(`/v1/appPreviewSets/${previewSetId}`);
        return { deleted: previewSetId };
      }),
  );

  server.registerTool(
    "app_store_connect_reorder_previews",
    {
      title: "App Store Connect: Reorder App Previews",
      description:
        "Set the display order of the previews in a set — the first one autoplays on the App " +
        "Store. WARNING: the ids you pass REPLACE the set's full contents, so any preview you " +
        "omit is removed from the set. List the set first and pass every id you want to keep.",
      inputSchema: z.object({
        previewSetId: previewSetIdArg,
        previewIds: z
          .array(z.string().min(1))
          .min(1)
          .max(3)
          .describe(
            "Every preview id in the set, in the desired display order. Omitting an id removes " +
              "that preview from the set.",
          ),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ previewSetId, previewIds }) =>
      wrap(async () => {
        await client.patch(`/v1/appPreviewSets/${previewSetId}/relationships/appPreviews`, {
          data: previewIds.map((id) => ({ type: "appPreviews", id })),
        });
        return { previewSetId, order: previewIds };
      }),
  );
};
