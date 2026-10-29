import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type { AppStoreConnectClient } from "#/client/asc";
import { sleep } from "#/client/http";
import { isRecord, type Rec } from "#/client/shape";

// Apple uploads every binary asset the same way — reserve, PUT the bytes to a
// pre-signed URL, commit a checksum, then poll while validation runs
// asynchronously. Only the resource type differs (appScreenshots,
// inAppPurchaseAppStoreReviewScreenshots, appPreviews…). This module holds the
// part that does not vary, so a second asset kind is a path plus a hint rather
// than a second copy of the flow.

/** Apple rejects anything larger well before processing; fail before reserving. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Apple's ceiling for an app preview video. */
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

const POLL_INTERVALS_MS = [1000, 2000, 2000, 3000, 5000];

export const attributesOf = (response: unknown): Rec => {
  if (!isRecord(response) || !isRecord(response.data)) return {};
  return isRecord(response.data.attributes) ? response.data.attributes : {};
};

export const idOf = (response: unknown): string | undefined => {
  if (!isRecord(response) || !isRecord(response.data)) return undefined;
  return typeof response.data.id === "string" ? response.data.id : undefined;
};

export type ReadAssetOptions = {
  /** Names the asset in every error, e.g. "review screenshot" or "app preview". */
  what: string;
  maxBytes: number;
  /** Appended to the over-size error: how to bring the file under the limit. */
  oversizeHint: string;
  /** Whether the caller may pass the bytes inline as base64 (`fileData`). */
  inline: boolean;
};

const assertSize = (bytes: number, opts: ReadAssetOptions): void => {
  if (bytes > opts.maxBytes) {
    throw new Error(
      `The ${opts.what} is ${bytes} bytes, over the ${opts.maxBytes}-byte limit. ` +
        opts.oversizeHint,
    );
  }
};

/**
 * Resolve the asset bytes from either a server-side path or inline base64.
 * `filePath` is the realistic input — a model cannot emit a PNG — but this
 * server also ships as a Docker image, where the host paths a caller would
 * naturally reach for do not resolve inside the container.
 */
export const readAsset = async (
  filePath: string | undefined,
  fileData: string | undefined,
  fileName: string | undefined,
  opts: ReadAssetOptions,
): Promise<{ bytes: Buffer; name: string }> => {
  const { what } = opts;
  if (!opts.inline && fileData !== undefined) {
    throw new Error(`The ${what} cannot be sent inline — pass \`filePath\` instead.`);
  }
  if ((filePath === undefined) === (fileData === undefined)) {
    throw new Error(
      opts.inline
        ? "Pass exactly one of `filePath` (a path readable by this server) or `fileData` (base64)."
        : "Pass `filePath`, a path readable by this server.",
    );
  }

  const resolved = await (async (): Promise<{ bytes: Buffer; name: string }> => {
    if (fileData !== undefined) {
      if (!fileName) throw new Error("`fileName` is required when passing `fileData`.");
      // Four base64 characters carry three bytes: refuse before decoding.
      assertSize(Math.floor((fileData.length * 3) / 4), opts);
      return { bytes: Buffer.from(fileData, "base64"), name: fileName };
    }

    const path = filePath as string;
    if (!isAbsolute(path)) {
      throw new Error(
        `\`filePath\` must be an absolute path (got "${path}") — this server's working ` +
          `directory is not necessarily yours.`,
      );
    }
    const unreadable = (err: unknown): Error => {
      const code = (err as NodeJS.ErrnoException).code;
      return new Error(
        `Could not read the ${what} at ${path} (${code ?? "unknown error"}). If this MCP ` +
          `server runs in Docker the path must exist INSIDE the container — mount the folder ` +
          `(docker run -v /host/media:/media …) and pass the container path` +
          (opts.inline ? `, or send the file as base64 via \`fileData\` instead.` : "."),
        { cause: err },
      );
    };
    // Sized before it is read, so a path pointed at the wrong, huge file fails
    // at once instead of after loading it.
    const size = await stat(path).then(
      (info) => info.size,
      (err: unknown) => {
        throw unreadable(err);
      },
    );
    assertSize(size, opts);
    try {
      return { bytes: await readFile(path), name: fileName ?? basename(path) };
    } catch (err) {
      throw unreadable(err);
    }
  })();

  if (resolved.bytes.byteLength === 0) {
    throw new Error(`The ${what} is empty (0 bytes): ${filePath ?? resolved.name}.`);
  }
  assertSize(resolved.bytes.byteLength, opts);
  return resolved;
};

/** An image asset: 10 MB, and accepted inline for a containerized server. */
export const readImage = async (
  filePath: string | undefined,
  fileData: string | undefined,
  fileName: string | undefined,
  what = "screenshot",
): Promise<{ bytes: Buffer; name: string }> =>
  readAsset(filePath, fileData, fileName, {
    what,
    maxBytes: MAX_IMAGE_BYTES,
    oversizeHint: "Export it at the exact required dimensions rather than oversampling.",
    inline: true,
  });

/**
 * `uploadOperations` is a plain attribute, so the generic summarizer would echo
 * a wall of long pre-signed URLs back into the model's context. They are spent
 * by the time anyone reads an asset, so drop them.
 */
const withoutUploadOperations = (row: unknown): unknown => {
  if (!isRecord(row)) return row;
  const { uploadOperations: _dropped, ...rest } = row;
  return rest;
};

export const stripUploadOperations = (summarized: unknown): unknown => {
  if (!isRecord(summarized) || !("data" in summarized)) return summarized;
  const { data } = summarized;
  return {
    ...summarized,
    data: Array.isArray(data) ? data.map(withoutUploadOperations) : withoutUploadOperations(data),
  };
};

export const describeStateErrors = (state: Rec): string =>
  (Array.isArray(state.errors) ? state.errors : [])
    .map((e) => (isRecord(e) ? [e.code, e.description].filter(Boolean).join(": ") : String(e)))
    .filter(Boolean)
    .join("; ");

export type PollOptions = {
  /** Collection path the asset lives under, e.g. `/v1/appScreenshots`. */
  resourcePath: string;
  assetId: string;
  waitSeconds: number;
  /** Echoed back on success so the caller sees what landed where. */
  meta: Record<string, unknown>;
  /**
   * Appended to the rejection message. Validation failures are nearly always
   * dimensions or an alpha channel, and the acceptable dimensions depend on the
   * asset kind — which only the caller knows.
   */
  failureHint: string;
  /** Named in the rejection message as the way to clear a failed asset. */
  deleteToolName: string;
  /** Named in the timeout note as the way to read the final state. */
  pollToolName: string;
  /**
   * Attributes holding the processing state, first present wins. Defaults to
   * `assetDeliveryState`; a video reports its own `videoDeliveryState`, which
   * keeps going (PROCESSING) after the asset state already says COMPLETE.
   */
  stateAttributes?: string[];
  /** Attributes echoed back once processing is COMPLETE. Defaults to `imageAsset`. */
  resultAttributes?: string[];
  /** What the rejection message calls the asset. Defaults to "image". */
  what?: string;
};

/**
 * Apple validates the image (dimensions, alpha channel) asynchronously, after
 * the bytes are committed — so this is where a wrongly-sized asset fails.
 */
export const pollAssetState = async (
  client: AppStoreConnectClient,
  opts: PollOptions,
): Promise<unknown> => {
  const { resourcePath, assetId, waitSeconds, meta } = opts;
  const deadline = Date.now() + waitSeconds * 1000;
  let tick = 0;

  for (;;) {
    let response: unknown;
    try {
      response = await client.get(`${resourcePath}/${assetId}`);
    } catch (error) {
      // Same reasoning as the deadline below: the bytes are committed, so a
      // failed status read must not surface as a failed upload.
      return {
        id: assetId,
        state: "UNKNOWN",
        stillProcessing: true,
        ...meta,
        note:
          `The upload itself succeeded, but reading its processing state failed ` +
          `(${error instanceof Error ? error.message : String(error)}). Do not re-upload — ` +
          `poll ${opts.pollToolName} for the final state.`,
      };
    }
    const attrs = attributesOf(response);
    const stateKey = (opts.stateAttributes ?? ["assetDeliveryState"]).find((key) =>
      isRecord(attrs[key]),
    );
    const assetState = stateKey && isRecord(attrs[stateKey]) ? attrs[stateKey] : {};
    const state = typeof assetState.state === "string" ? assetState.state : undefined;

    if (state === "COMPLETE") {
      return {
        id: assetId,
        state,
        ...meta,
        ...Object.fromEntries(
          (opts.resultAttributes ?? ["imageAsset"])
            .filter((key) => attrs[key] !== undefined)
            .map((key) => [key, attrs[key]]),
        ),
        ...(Array.isArray(assetState.warnings) && assetState.warnings.length > 0
          ? { warnings: assetState.warnings }
          : {}),
      };
    }

    if (state === "FAILED") {
      const why = describeStateErrors(assetState);
      throw new Error(
        `App Store Connect rejected the ${opts.what ?? "image"} during processing${why ? `: ${why}` : ""}. ` +
          `${opts.failureHint} The failed asset ${assetId} still exists — delete it with ` +
          `${opts.deleteToolName} before retrying.`,
      );
    }

    if (Date.now() >= deadline) {
      // The bytes are committed by now, so this is NOT a failure. Throwing here
      // would read as "upload failed", prompting a retry that duplicates the
      // asset.
      return {
        id: assetId,
        state: state ?? "UNKNOWN",
        stillProcessing: true,
        ...meta,
        note:
          `Still processing after ${waitSeconds}s. The upload itself succeeded — poll ` +
          `${opts.pollToolName} for the final state.`,
      };
    }

    await sleep(POLL_INTERVALS_MS[Math.min(tick, POLL_INTERVALS_MS.length - 1)] as number);
    tick += 1;
  }
};
