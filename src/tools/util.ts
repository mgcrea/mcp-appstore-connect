import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { z } from "zod";

import type { AppStoreConnectClient, Query } from "#/client/asc";
import { AppStoreConnectApiError, WritesDisabledError } from "#/client/errors";
import {
  isRecord,
  relatedId,
  resourcesOf,
  summarizeResource,
  summarizeResponse,
} from "#/client/shape";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed. `null, 2` adds 19-41% to every response — worst
 * on wide lists of short-keyed objects, which are exactly the replies already
 * big enough to hurt. No model needs the indentation, and every tool returns
 * through here. Files written to disk for humans stay pretty.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/**
 * Return text as-is. `ok()` JSON-stringifies, which turns a markdown document
 * into one escaped "# Locale\n\n…" line that no one can read.
 */
export const okText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

export const fail = (message: string, extra?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }),
    },
  ],
  isError: true,
});

/** Render a thrown value as a tool error, preserving App Store Connect detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof AppStoreConnectApiError) {
    return fail(err.message, { status: err.status, errors: err.errors });
  }
  if (err instanceof WritesDisabledError) {
    return fail(err.message);
  }
  if (err instanceof Error) {
    // Let an error carry structured detail through, e.g. per-field limit breaches.
    const details = (err as Error & { details?: unknown }).details;
    return fail(err.message, details);
  }
  return fail("Unknown error", err);
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/**
 * What a save produced. `content` says how to read the file back: `json` is a
 * tool result, `report` a raw TSV/CSV, `binary` DER bytes. Downstream readers
 * branch on it rather than guessing from the extension — `report_stats.py`
 * parses a `report` file as a table and must not try that on a `json` dump.
 */
export type SavedFile = { path: string; bytes: number; content: "json" | "report" | "binary" };

/**
 * Write a file where the caller asked, and report what landed.
 *
 * The one place this server writes to a path the caller named. The absolute-path
 * rule and the Docker remedy live here so the three tools that save — reports,
 * certificates, and every read — cannot drift into three different answers to
 * the same question. Before this, only the report path checked either.
 */
export const saveToPath = async (
  path: string,
  data: string | Uint8Array,
  what = "result",
): Promise<{ path: string; bytes: number }> => {
  if (!isAbsolute(path)) {
    throw new PreconditionError(
      `\`savePath\` must be an absolute path (got "${path}") — this server's working directory ` +
        `is not necessarily yours.`,
      { savePath: path },
    );
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new PreconditionError(
      `Could not write the ${what} to ${path} (${code ?? "unknown error"}). If this MCP server ` +
        `runs in Docker the path must be INSIDE the container — mount the folder ` +
        `(docker run -v /host/reports:/reports …) and pass the container path. Omitting ` +
        `savePath returns the ${what} inline instead.`,
      { savePath: path, code },
    );
  }
  return {
    path,
    bytes: typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength,
  };
};

/**
 * The `savePath` every read tool takes, described once.
 *
 * Deliberately terse. The report downloads spell the rationale out at length
 * because they have three tools to spend it on; repeating that prose across
 * forty reads would cost more context than the feature saves.
 */
export const savePathArg = z
  .string()
  .optional()
  .describe(
    "Absolute path to also write this result to, as pretty-printed JSON. Use it rather than " +
      "copying values out of the response into a file by hand. Parent directories are created.",
  );

/**
 * Like `wrap`, plus: when `savePath` is set, write the payload to disk and hand
 * back a `saved` receipt beside it.
 *
 * Every read tool takes this, uniformly, and that uniformity is the point. The
 * failure it fixes is an agent not reaching for the feature — so "which reads
 * can save?" has to answer "all of them". A curated subset reproduces the bug:
 * the caller has to remember which tools qualify, a wrong guess is a schema
 * error, and the fallback from a schema error is retyping the values, which is
 * where they go stale. Eight apps' minOsVersion floors went into a cache that
 * way, and were wrong by the time anyone read them.
 *
 * The file holds exactly what the tool would have returned without `savePath`;
 * the receipt is never written into the file it describes.
 */
export const wrapSaved = async <T>(
  savePath: string | undefined,
  fn: () => Promise<T>,
): Promise<ToolResult> =>
  wrap(async () => {
    const payload = await fn();
    if (savePath === undefined) return payload;
    // `null, 2` here and nowhere else — see the note on `ok()`. This copy is a
    // file someone will open, not a wire payload.
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const saved: SavedFile = { ...(await saveToPath(savePath, text)), content: "json" };
    // Every read returns a record today, but a bare value would otherwise be
    // swallowed by the spread rather than saved.
    return isRecord(payload) ? { ...payload, saved } : { data: payload, saved };
  });

/** Like `wrap`, but the body chooses its own result shape (e.g. raw markdown). */
export const wrapResult = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return toFailure(err);
  }
};

/** App Store Connect caps `limit` at 200 on most collections. */
export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(200)
  .default(50)
  .describe("Maximum number of results to return (1-200). Defaults to 50.");

/**
 * JSON:API sparse fieldset — a per-call escape hatch to fetch attributes the
 * summarizer would otherwise drop. Rarely needed; list tools return all
 * attributes by default.
 */
export const fieldsArg = z
  .array(z.string())
  .optional()
  .describe(
    'Restrict returned attributes (JSON:API sparse fieldset), e.g. ["name","bundleId"]. ' +
      "Omit to return every attribute of each resource.",
  );

export const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;

/**
 * A local check that failed before we sent anything to Apple. Carries the state
 * it read, so the caller sees why rather than just that something was wrong.
 */
export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The App Store Connect resource id of an app (from list_apps), not its bundle id. */
export const appIdArg = z
  .string()
  .min(1)
  .describe(
    "The app's App Store Connect id (the `id` from app_store_connect_list_apps), NOT its bundle id.",
  );

/**
 * One app id, or several.
 *
 * Only offered on the collection endpoints Apple can genuinely serve in a single
 * request — `/v1/builds`, `/v1/betaGroups`, `/v1/reviewSubmissions`, whose
 * `filter[app]` its spec types as an array. Everything else app-scoped is a
 * `/v1/apps/{id}/…` path with no top-level collection, where accepting a list
 * would hide a fan-out behind a name that promises one call.
 */
export const appIdsArg = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe(
    "One app's App Store Connect id (the `id` from app_store_connect_list_apps, NOT its bundle " +
      "id), or an array of them to read several apps in a single request. Each returned row " +
      "carries the `appId` it belongs to.",
  );

/**
 * Flatten a collection response, adding the `appId` each row belongs to.
 *
 * `summarizeResponse` drops `relationships`, which is where the owning app is —
 * fine for a single-app read, and unusable across several, since the rows arrive
 * interleaved with nothing to tell them apart.
 *
 * The saturation note matters more than it looks. Apple's `limit` on these
 * endpoints is one global cap across the union of apps, and their `sort` offers
 * no way to interleave fairly, so a full page can be entirely one chatty app
 * while another contributes nothing — and a caller reading that as "this app has
 * no builds" is wrong in a way the payload does not otherwise show.
 */
export const summarizeWithApp = (
  response: unknown,
  limit: number,
  appIds: string | string[],
): Record<string, unknown> => {
  const rows = resourcesOf(response).map((res) => ({
    ...(summarizeResource(res) as Record<string, unknown>),
    appId: relatedId(res, "app"),
  }));
  const summarized = summarizeResponse(response) as Record<string, unknown>;
  const many = Array.isArray(appIds) && appIds.length > 1;
  // Only when the page really is a subset — `incomplete` is summarizeResponse's
  // own verdict on that, so a page that happens to be exactly `limit` long and
  // complete does not get warned about.
  const partial = summarized.incomplete !== undefined;
  return {
    ...summarized,
    data: rows,
    ...(many && partial
      ? {
          note:
            `Apple applies \`limit\` across all ${appIds.length} apps at once rather than per ` +
            `app, and its sort cannot interleave them, so the rows that did not fit may all ` +
            `belong to one app — see \`incomplete\`. An app missing from this page has not been ` +
            `shown to have nothing. Raise limit, or ask per app.`,
        }
      : {}),
  };
};

export const versionIdArg = z
  .string()
  .min(1)
  .describe("The appStoreVersion id (from app_store_connect_list_versions).");

/** Destructive tools require this, so an agent can never mutate something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this changes App Store Connect state.");

/**
 * Opt-in preflight. Defaults to false, so adding it never turns an existing call into a no-op.
 *
 * Still requires `confirm`, and deliberately: a dry run of a submission creates the draft and
 * adds the version to it. Only the irreversible step — handing it to Apple — is skipped.
 *
 * Staging moves the version to READY_FOR_REVIEW, which is not a submittable state, so the
 * submit tool has to be able to resume from its own dry run rather than refuse it.
 */
export const dryRunArg = z
  .boolean()
  .default(false)
  .describe("Stop before the irreversible step and report what would happen. Defaults to false.");

/** Drop undefined values so we never send `{"filter[x]": undefined}` upstream. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * GET a to-one sub-resource that may never have been created, e.g. an app's
 * price schedule, its review detail, or an IAP's availability.
 *
 * Apple does not answer those with `data: null` — it answers **404**, with a
 * message naming the *parent's* id as though it were a missing resource of the
 * child's type ("no resource of type 'appPriceSchedules' with id <the app id>").
 * Surfaced raw that reads as a broken request rather than as "not configured
 * yet", which is the one thing the caller actually needs to know: it is the
 * state every app starts in, and the reason submission is refused.
 */
export const getOrNull = async <T>(
  client: AppStoreConnectClient,
  path: string,
  query?: Query,
): Promise<T | null> => {
  try {
    return await client.get<T>(path, query);
  } catch (err) {
    if (err instanceof AppStoreConnectApiError && err.status === 404) return null;
    throw err;
  }
};

/**
 * Apple keys territories by ISO-3166-1 alpha-3, and the base territory decides
 * which price point id is meaningful — a price point belongs to exactly one
 * territory, so USA's $4.99 and FRA's 5,99 € are different resources.
 */
export const territoryArg = z
  .string()
  .length(3)
  .describe('Territory code (ISO-3166-1 alpha-3), e.g. "USA", "FRA", "JPN".');
