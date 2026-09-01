import { z } from "zod";

import type { AppStoreConnectClient, Query } from "#/client/asc";
import { AppStoreConnectApiError, WritesDisabledError } from "#/client/errors";

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
