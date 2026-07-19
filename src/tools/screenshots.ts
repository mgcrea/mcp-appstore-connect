import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient, UploadOperation } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { compact, confirmArg, limitArg, wrap } from "./util.js";

/**
 * Apple's ScreenshotDisplayType enum (spec 3.2). Hardcoded rather than accepted
 * as a free string so a typo fails zod validation here instead of surfacing as
 * an opaque 409 three network round-trips later. A new Apple device family
 * means a release of this package.
 */
const SCREENSHOT_DISPLAY_TYPES = [
  "APP_IPHONE_67",
  "APP_IPHONE_61",
  "APP_IPHONE_65",
  "APP_IPHONE_58",
  "APP_IPHONE_55",
  "APP_IPHONE_47",
  "APP_IPHONE_40",
  "APP_IPHONE_35",
  "APP_IPAD_PRO_3GEN_129",
  "APP_IPAD_PRO_3GEN_11",
  "APP_IPAD_PRO_129",
  "APP_IPAD_105",
  "APP_IPAD_97",
  "APP_DESKTOP",
  "APP_WATCH_ULTRA",
  "APP_WATCH_SERIES_7",
  "APP_WATCH_SERIES_4",
  "APP_WATCH_SERIES_3",
  "APP_APPLE_TV",
  "APP_APPLE_VISION_PRO",
  "IMESSAGE_APP_IPHONE_67",
  "IMESSAGE_APP_IPHONE_61",
  "IMESSAGE_APP_IPHONE_65",
  "IMESSAGE_APP_IPHONE_58",
  "IMESSAGE_APP_IPHONE_55",
  "IMESSAGE_APP_IPHONE_47",
  "IMESSAGE_APP_IPHONE_40",
  "IMESSAGE_APP_IPAD_PRO_3GEN_129",
  "IMESSAGE_APP_IPAD_PRO_3GEN_11",
  "IMESSAGE_APP_IPAD_PRO_129",
  "IMESSAGE_APP_IPAD_105",
  "IMESSAGE_APP_IPAD_97",
] as const;

/** Apple rejects anything larger well before processing; fail before reserving. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const POLL_INTERVALS_MS = [1000, 2000, 2000, 3000, 5000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const localizationIdArg = z
  .string()
  .min(1)
  .describe(
    "The appStoreVersionLocalization id (from app_store_connect_list_version_localizations).",
  );

const screenshotSetIdArg = z
  .string()
  .min(1)
  .describe("The appScreenshotSet id (from app_store_connect_list_screenshot_sets).");

const screenshotIdArg = z
  .string()
  .min(1)
  .describe("The appScreenshot id (from app_store_connect_list_screenshots).");

const displayTypeArg = z
  .enum(SCREENSHOT_DISPLAY_TYPES)
  .describe(
    "Device family the screenshot is for. The two an iPhone/iPad submission requires are " +
      'APP_IPHONE_67 (6.7" — 1290x2796) and APP_IPAD_PRO_3GEN_129 (12.9" — 2048x2732). ' +
      "APP_DESKTOP is macOS.",
  );

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const attributesOf = (response: unknown): Rec => {
  if (!isRecord(response) || !isRecord(response.data)) return {};
  return isRecord(response.data.attributes) ? response.data.attributes : {};
};

const idOf = (response: unknown): string | undefined => {
  if (!isRecord(response) || !isRecord(response.data)) return undefined;
  return typeof response.data.id === "string" ? response.data.id : undefined;
};

/**
 * `uploadOperations` is a plain attribute, so the generic summarizer would echo
 * a wall of long pre-signed URLs back into the model's context. They are spent
 * by the time anyone reads a screenshot, so drop them.
 */
const stripUploadOperations = (summarized: unknown): unknown => {
  if (!isRecord(summarized) || !("data" in summarized)) return summarized;
  const strip = (row: unknown): unknown => {
    if (!isRecord(row)) return row;
    const { uploadOperations: _dropped, ...rest } = row;
    return rest;
  };
  const { data } = summarized;
  return { ...summarized, data: Array.isArray(data) ? data.map(strip) : strip(data) };
};

/**
 * Resolve the image bytes from either a server-side path or inline base64.
 * `filePath` is the realistic input — a model cannot emit a PNG — but this
 * server also ships as a Docker image, where the host paths a caller would
 * naturally reach for do not resolve inside the container.
 */
const readImage = async (
  filePath: string | undefined,
  fileData: string | undefined,
  fileName: string | undefined,
): Promise<{ bytes: Buffer; name: string }> => {
  if ((filePath === undefined) === (fileData === undefined)) {
    throw new Error(
      "Pass exactly one of `filePath` (a path readable by this server) or `fileData` (base64).",
    );
  }

  const resolved = await (async (): Promise<{ bytes: Buffer; name: string }> => {
    if (fileData !== undefined) {
      if (!fileName) throw new Error("`fileName` is required when passing `fileData`.");
      return { bytes: Buffer.from(fileData, "base64"), name: fileName };
    }

    const path = filePath as string;
    if (!isAbsolute(path)) {
      throw new Error(
        `\`filePath\` must be an absolute path (got "${path}") — this server's working ` +
          `directory is not necessarily yours.`,
      );
    }
    try {
      return { bytes: await readFile(path), name: fileName ?? basename(path) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(
        `Could not read the screenshot at ${path} (${code ?? "unknown error"}). If this MCP ` +
          `server runs in Docker the path must exist INSIDE the container — mount the folder ` +
          `(docker run -v /host/screenshots:/screenshots …) and pass the container path, or ` +
          `send the image as base64 via \`fileData\` instead.`,
        { cause: err },
      );
    }
  })();

  if (resolved.bytes.byteLength === 0) {
    throw new Error(`The screenshot is empty (0 bytes): ${filePath ?? resolved.name}.`);
  }
  if (resolved.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `The screenshot is ${resolved.bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES}-byte ` +
        `limit. Export it at the exact required dimensions rather than oversampling.`,
    );
  }
  return resolved;
};

/** Find the existing set for a display type, so uploads don't need a lookup first. */
const findScreenshotSet = async (
  client: AppStoreConnectClient,
  localizationId: string,
  displayType: string,
): Promise<string | undefined> => {
  const res = await client.get(
    `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`,
    { limit: 50 },
  );
  if (!isRecord(res) || !Array.isArray(res.data)) return undefined;
  for (const row of res.data) {
    if (!isRecord(row) || !isRecord(row.attributes)) continue;
    if (row.attributes.screenshotDisplayType === displayType && typeof row.id === "string") {
      return row.id;
    }
  }
  return undefined;
};

const createScreenshotSet = async (
  client: AppStoreConnectClient,
  localizationId: string,
  displayType: string,
): Promise<string> => {
  const res = await client.post("/v1/appScreenshotSets", {
    data: {
      type: "appScreenshotSets",
      attributes: { screenshotDisplayType: displayType },
      relationships: {
        appStoreVersionLocalization: {
          data: { type: "appStoreVersionLocalizations", id: localizationId },
        },
      },
    },
  });
  const id = idOf(res);
  if (!id) throw new Error(`Creating the ${displayType} screenshot set returned no id.`);
  return id;
};

type UploadMeta = {
  screenshotSetId: string;
  screenshotSetCreated: boolean;
  displayType: string;
  fileName: string;
  fileSize: number;
  parts: number;
};

const describeStateErrors = (state: Rec): string =>
  (Array.isArray(state.errors) ? state.errors : [])
    .map((e) => (isRecord(e) ? [e.code, e.description].filter(Boolean).join(": ") : String(e)))
    .filter(Boolean)
    .join("; ");

/**
 * Apple validates the image (dimensions, alpha channel) asynchronously, after
 * the bytes are committed — so this is where a wrongly-sized screenshot fails.
 */
const pollAssetState = async (
  client: AppStoreConnectClient,
  screenshotId: string,
  waitSeconds: number,
  meta: UploadMeta,
): Promise<unknown> => {
  const deadline = Date.now() + waitSeconds * 1000;
  let tick = 0;

  for (;;) {
    const attrs = attributesOf(await client.get(`/v1/appScreenshots/${screenshotId}`));
    const assetState = isRecord(attrs.assetDeliveryState) ? attrs.assetDeliveryState : {};
    const state = typeof assetState.state === "string" ? assetState.state : undefined;

    if (state === "COMPLETE") {
      return {
        id: screenshotId,
        state,
        ...meta,
        ...(attrs.imageAsset !== undefined ? { imageAsset: attrs.imageAsset } : {}),
        ...(Array.isArray(assetState.warnings) && assetState.warnings.length > 0
          ? { warnings: assetState.warnings }
          : {}),
      };
    }

    if (state === "FAILED") {
      const why = describeStateErrors(assetState);
      throw new Error(
        `App Store Connect rejected the screenshot during processing${why ? `: ${why}` : ""}. ` +
          `This is almost always the wrong pixel dimensions, or an alpha channel, for ` +
          `${meta.displayType}. The failed asset ${screenshotId} still exists — delete it with ` +
          `app_store_connect_delete_screenshot before retrying.`,
      );
    }

    if (Date.now() >= deadline) {
      // The bytes are committed by now, so this is NOT a failure. Throwing here
      // would read as "upload failed", prompting a retry that duplicates the
      // screenshot in the set.
      return {
        id: screenshotId,
        state: state ?? "UNKNOWN",
        stillProcessing: true,
        ...meta,
        note:
          `Still processing after ${waitSeconds}s. The upload itself succeeded — poll ` +
          `app_store_connect_get_screenshot for the final state.`,
      };
    }

    await sleep(POLL_INTERVALS_MS[Math.min(tick, POLL_INTERVALS_MS.length - 1)] as number);
    tick += 1;
  }
};

type UploadArgs = {
  localizationId: string;
  displayType: string;
  filePath?: string | undefined;
  fileData?: string | undefined;
  fileName?: string | undefined;
  screenshotSetId?: string | undefined;
  waitSeconds: number;
};

const uploadScreenshot = async (
  client: AppStoreConnectClient,
  args: UploadArgs,
): Promise<unknown> => {
  const { bytes, name } = await readImage(args.filePath, args.fileData, args.fileName);

  // 1. Resolve the target set: explicit id, else the existing set for this
  //    display type, else a new one.
  const existingSetId =
    args.screenshotSetId ??
    (await findScreenshotSet(client, args.localizationId, args.displayType));
  const screenshotSetId =
    existingSetId ?? (await createScreenshotSet(client, args.localizationId, args.displayType));

  // 2. Reserve the asset — the response carries the pre-signed upload URLs.
  const reserved = await client.post("/v1/appScreenshots", {
    data: {
      type: "appScreenshots",
      attributes: { fileName: name, fileSize: bytes.byteLength },
      relationships: {
        appScreenshotSet: { data: { type: "appScreenshotSets", id: screenshotSetId } },
      },
    },
  });
  const screenshotId = idOf(reserved);
  if (!screenshotId) throw new Error("Reserving the screenshot returned no id.");
  const attrs = attributesOf(reserved);
  const operations = (
    Array.isArray(attrs.uploadOperations) ? attrs.uploadOperations : []
  ) as UploadOperation[];

  try {
    // 3. PUT the raw bytes to Apple's blob store, then 4. commit the checksum.
    await client.uploadAsset(operations, bytes);
    await client.patch(`/v1/appScreenshots/${screenshotId}`, {
      data: {
        type: "appScreenshots",
        id: screenshotId,
        attributes: {
          uploaded: true,
          sourceFileChecksum: createHash("md5").update(bytes).digest("hex"),
        },
      },
    });
  } catch (err) {
    // A reservation that was never committed is invisible in the App Store
    // Connect UI but still blocks the version from being submitted, and it
    // carries no diagnostic value — so clean it up, best effort.
    await client.del(`/v1/appScreenshots/${screenshotId}`).catch(() => undefined);
    throw err;
  }

  // 5. Wait for Apple's asynchronous validation to land.
  return pollAssetState(client, screenshotId, args.waitSeconds, {
    screenshotSetId,
    screenshotSetCreated: existingSetId === undefined,
    displayType: args.displayType,
    fileName: name,
    fileSize: bytes.byteLength,
    parts: operations.length,
  });
};

export const registerScreenshotTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_screenshot_sets",
    {
      description:
        "List the screenshot sets of one App Store version localization — one set per device " +
        "type (screenshotDisplayType). Returns the set ids you upload into or reorder.",
      inputSchema: { localizationId: localizationIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ localizationId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`,
            compact({ limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_screenshots",
    {
      description:
        "List the screenshots in one set, in display order, with each file name, upload state " +
        "and image dimensions. Use it to audit what a device type currently shows on the store.",
      inputSchema: { screenshotSetId: screenshotSetIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ screenshotSetId, limit }) =>
      wrap(async () =>
        stripUploadOperations(
          summarizeResponse(
            await client.get(
              `/v1/appScreenshotSets/${screenshotSetId}/appScreenshots`,
              compact({ limit }),
            ),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_screenshot",
    {
      description:
        "Get one screenshot, including its assetDeliveryState — the way to check whether App " +
        "Store Connect finished processing an upload that was still in progress.",
      inputSchema: { screenshotId: screenshotIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ screenshotId }) =>
      wrap(async () =>
        stripUploadOperations(
          summarizeResponse(await client.get(`/v1/appScreenshots/${screenshotId}`)),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_upload_screenshot",
    {
      description:
        "Upload a screenshot image to an App Store version localization. Runs the whole upload " +
        "flow: finds or creates the set for the device type, reserves the asset, uploads the " +
        "bytes, commits the checksum, then waits for processing. App Store Connect validates " +
        "image dimensions during processing, so a wrongly-sized image fails here with the exact " +
        "reason. The version must be editable (PREPARE_FOR_SUBMISSION or DEVELOPER_REJECTED), " +
        "and a set holds at most 10 screenshots.",
      inputSchema: {
        localizationId: localizationIdArg,
        displayType: displayTypeArg,
        filePath: z
          .string()
          .optional()
          .describe(
            "Absolute path to a PNG/JPEG readable BY THIS SERVER. If the server runs in Docker, " +
              "this must be a path inside the container.",
          ),
        fileData: z
          .string()
          .optional()
          .describe(
            "Base64-encoded image bytes, as an alternative to `filePath` for a containerized " +
              "server. Requires `fileName`. Small images only — this travels through the " +
              "conversation.",
          ),
        fileName: z
          .string()
          .optional()
          .describe(
            "Name to register with App Store Connect. Defaults to the basename of `filePath`. " +
              "Required with `fileData`.",
          ),
        screenshotSetId: z
          .string()
          .optional()
          .describe("Upload into this exact set instead of looking one up by `displayType`."),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(180)
          .default(60)
          .describe(
            "How long to wait for processing to finish (0 = don't wait). Timing out is not a " +
              "failure — the upload has already succeeded at that point.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => wrap(async () => uploadScreenshot(client, args)),
  );

  server.registerTool(
    "app_store_connect_delete_screenshot",
    {
      description:
        "Delete one screenshot from its set. Use this to remove a screenshot App Store Connect " +
        "rejected during processing, or to make room in a full set.",
      inputSchema: { screenshotId: screenshotIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ screenshotId }) =>
      wrap(async () => {
        await client.del(`/v1/appScreenshots/${screenshotId}`);
        return { deleted: screenshotId };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_screenshot_set",
    {
      description:
        "Delete an entire screenshot set, and with it EVERY screenshot for that device type. " +
        "This is the way to replace a device type's screenshots wholesale: delete the set, then " +
        "upload the new images.",
      inputSchema: { screenshotSetId: screenshotSetIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ screenshotSetId }) =>
      wrap(async () => {
        await client.del(`/v1/appScreenshotSets/${screenshotSetId}`);
        return { deleted: screenshotSetId };
      }),
  );

  server.registerTool(
    "app_store_connect_reorder_screenshots",
    {
      description:
        "Set the display order of the screenshots in a set — this is the order customers see on " +
        "the App Store, and it is NOT the upload order. WARNING: the ids you pass REPLACE the " +
        "set's full contents, so any screenshot you omit is removed from the set. List the set " +
        "first and pass every id you want to keep.",
      inputSchema: {
        screenshotSetId: screenshotSetIdArg,
        screenshotIds: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Every screenshot id in the set, in the desired display order. Omitting an id " +
              "removes that screenshot from the set.",
          ),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ screenshotSetId, screenshotIds }) =>
      wrap(async () => {
        await client.patch(
          `/v1/appScreenshotSets/${screenshotSetId}/relationships/appScreenshots`,
          {
            data: screenshotIds.map((id) => ({ type: "appScreenshots", id })),
          },
        );
        return { screenshotSetId, order: screenshotIds };
      }),
  );
};
