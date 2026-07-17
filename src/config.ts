import { readFileSync } from "node:fs";

import { z } from "zod";

const ConfigSchema = z
  .object({
    keyId: z.string().min(1, "APP_STORE_CONNECT_KEY_ID is required (the 10-char key id)"),
    issuerId: z.string().min(1, "APP_STORE_CONNECT_ISSUER_ID is required (a UUID)"),
    privateKey: z
      .string()
      .min(1)
      .refine((v) => v.includes("BEGIN") && v.includes("PRIVATE KEY"), {
        message:
          "The private key does not look like a PEM `.p8` file (missing `BEGIN PRIVATE KEY`). " +
          "Point APP_STORE_CONNECT_P8_PATH at the AuthKey_XXXX.p8 you downloaded from Apple.",
      }),
    vendorNumber: z.string().min(1).optional(),
    allowWrites: z.boolean().default(false),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    tokenTtlSeconds: z.number().int().min(60).max(1200).default(1140),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

const parseBool = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

/**
 * Resolve the `.p8` private key from either an inline PEM (APP_STORE_CONNECT_P8,
 * handy for Docker/CI secrets) or a file path (APP_STORE_CONNECT_P8_PATH).
 * Exactly one must be set.
 */
export const resolvePrivateKey = (env: NodeJS.ProcessEnv): string => {
  const inline = trimmed(env.APP_STORE_CONNECT_P8);
  const path = trimmed(env.APP_STORE_CONNECT_P8_PATH);
  if (inline && path) {
    throw new Error(
      "Set only one of APP_STORE_CONNECT_P8 (inline PEM) or APP_STORE_CONNECT_P8_PATH (file path), not both.",
    );
  }
  if (inline) return inline;
  if (path) {
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(
        `Could not read APP_STORE_CONNECT_P8_PATH (${path}): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  throw new Error(
    "No private key found. Set APP_STORE_CONNECT_P8_PATH to your AuthKey_XXXX.p8 file " +
      "(or APP_STORE_CONNECT_P8 to its inline PEM contents).",
  );
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  return ConfigSchema.parse({
    keyId: trimmed(env.APP_STORE_CONNECT_KEY_ID),
    issuerId: trimmed(env.APP_STORE_CONNECT_ISSUER_ID),
    privateKey: resolvePrivateKey(env),
    vendorNumber: trimmed(env.APP_STORE_CONNECT_VENDOR_NUMBER),
    allowWrites: parseBool(env.APP_STORE_CONNECT_ALLOW_WRITES),
    maxRetries: parseIntOpt(env.APP_STORE_CONNECT_MAX_RETRIES),
    tokenTtlSeconds: parseIntOpt(env.APP_STORE_CONNECT_TOKEN_TTL_SECONDS),
  });
};
