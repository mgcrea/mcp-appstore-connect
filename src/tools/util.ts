import { z } from "zod";

import { AppStoreConnectApiError, WritesDisabledError } from "../client/errors.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }, null, 2) }],
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
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }, null, 2),
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

/** The App Store Connect resource id of an app (from list_apps), not its bundle id. */
export const appIdArg = z
  .string()
  .min(1)
  .describe(
    "The app's App Store Connect id (the `id` from app_store_connect_list_apps), NOT its bundle id.",
  );

/** Destructive tools require this, so an agent can never mutate something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this changes App Store Connect state.");

/** Drop undefined values so we never send `{"filter[x]": undefined}` upstream. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
