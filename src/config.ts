import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  DEFAULT_METADATA_ROOT,
  MetadataRootError,
  normalizeMetadataRoot,
} from "#/listing/document";

/**
 * Shared by both schemas so a bad root is rejected the same way whether it came
 * from the env or the config file, and normalized before anything reads it.
 */
const metadataRootSchema = z.string().superRefine((value, ctx) => {
  try {
    normalizeMetadataRoot(value);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof MetadataRootError ? err.message : message(err),
    });
  }
});

/**
 * The App Review contact: who Apple phones or emails if review has a question.
 * Nested rather than four flat `contactFirstName` keys because it is one fact
 * about a person, and it is the same person for every app and every version —
 * which is the whole reason it is worth keeping here instead of retyping it
 * into each `set_app_store_review_detail` call.
 *
 * Every field is optional. A half-filled contact is still useful: it fills the
 * gaps it can and leaves the rest to the caller, which beats refusing to start
 * because a phone number is missing.
 */
const contactSchema = z
  .object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
  })
  .strict();

export type Contact = z.infer<typeof contactSchema>;

const ConfigSchema = z
  .object({
    // Optional at the schema level so "nothing is configured" is a state the
    // server can report, not a crash before it ever connects — see loadConfig.
    keyId: z.string().min(1).optional(),
    issuerId: z.string().min(1).optional(),
    privateKey: z
      .string()
      .min(1)
      .optional()
      .refine((v) => v === undefined || (v.includes("BEGIN") && v.includes("PRIVATE KEY")), {
        message:
          "The private key does not look like a PEM `.p8` file (missing `BEGIN PRIVATE KEY`). " +
          "Point APP_STORE_CONNECT_P8_PATH at the AuthKey_XXXX.p8 you downloaded from Apple.",
      }),
    vendorNumber: z.string().min(1).optional(),
    /**
     * Which layer supplied `vendorNumber`. Derived, never user-set: by the time
     * the two sources are merged the origin is lost, and "I edited the env var
     * and nothing changed" is the single most common way this field goes wrong
     * — the config file silently wins nothing, but a stale file value looks
     * identical to an env var that never got exported.
     */
    vendorNumberSource: z.enum(["environment", "file"]).optional(),
    allowWrites: z.boolean().default(false),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    tokenTtlSeconds: z.number().int().min(60).max(1200).default(1140),
    metadataRoot: metadataRootSchema
      .default(DEFAULT_METADATA_ROOT)
      .transform(normalizeMetadataRoot),
    contact: contactSchema.optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The on-disk config document. Keys are camelCase to mirror `Config` rather than
 * the env var names: this is a typed JSON file, not a shell.
 *
 * `.strict()` on purpose — a typo'd `keyID` must be an error. Silently ignoring
 * an unknown key looks exactly like "that setting had no effect", which is the
 * worst way to learn your credentials came from somewhere else.
 */
const FileConfigSchema = z
  .object({
    keyId: z.string().min(1).optional(),
    issuerId: z.string().min(1).optional(),
    p8: z.string().min(1).optional(),
    p8Path: z.string().min(1).optional(),
    vendorNumber: z.string().min(1).optional(),
    allowWrites: z.boolean().optional(),
    maxRetries: z.number().int().nonnegative().max(10).optional(),
    tokenTtlSeconds: z.number().int().min(60).max(1200).optional(),
    metadataRoot: metadataRootSchema.optional(),
    contact: contactSchema.optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `readFileSync` does not expand `~`, but it is the natural thing to write in a config file. */
const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

/**
 * Where the config file lives, most specific first: an explicit override, then
 * the XDG location, then the conventional `~/.config`.
 */
export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.APP_STORE_CONNECT_CONFIG);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "appstore-connect", "config.json");
};

/**
 * The config file and the `.p8` it points at: either being readable by other
 * users is worth saying out loud, and the key most of all — one saved from a
 * browser download is typically 644. It is a warning and not an error: refusing
 * to start would be a worse trade for someone on a single-user machine.
 */
const warnIfGroupReadable = (path: string): void => {
  if (process.platform === "win32") return; // mode bits mean nothing here
  try {
    if (statSync(path).mode & 0o077) {
      process.stderr.write(
        `[appstore-connect] ${path} is readable by other users. Run: chmod 600 ${path}\n`,
      );
    }
  } catch {
    // Not worth failing startup over; the read below reports anything that matters.
  }
};

/**
 * Read the config file, treating "absent" as "contributes nothing". Every other
 * failure throws and names the path, so a malformed file is never mistaken for
 * a missing one — that confusion would send you hunting for credentials that
 * were sitting right there.
 */
const readConfigFile = (path: string): FileConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read the config file (${path}): ${message(err)}`, { cause: err });
  }

  warnIfGroupReadable(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The config file (${path}) is not valid JSON: ${message(err)}`, { cause: err });
  }

  const result = FileConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`The config file (${path}) is not valid: ${issues}`);
  }
  return result.data;
};

/**
 * Resolve the `.p8` private key from an inline PEM (handy for Docker/CI secrets)
 * or a file path. Exactly one must be set.
 *
 * Whichever source names a key wins outright: an inline PEM in the environment
 * is not a conflict with a `p8Path` in the config file, it simply overrides it.
 * Only naming both *within one source* is a genuine ambiguity.
 */
/**
 * An inline PEM whose newlines arrived as literal `\n`, which is the only way
 * `docker --env-file` and many CI secret stores can carry a multi-line value.
 * Left as is it passes the PEM check and then fails every signature, so turn
 * the escapes back into newlines. A key with real newlines is never touched.
 */
const unescapeNewlines = (pem: string): string =>
  pem.includes("\n") ? pem : pem.replaceAll("\\n", "\n");

export const resolvePrivateKey = (
  env: NodeJS.ProcessEnv,
  file: FileConfig = {},
): string | undefined => {
  const fromEnv = {
    inline: trimmed(env.APP_STORE_CONNECT_P8),
    path: trimmed(env.APP_STORE_CONNECT_P8_PATH),
    inlineLabel: "APP_STORE_CONNECT_P8 (inline PEM)",
    pathLabel: "APP_STORE_CONNECT_P8_PATH (file path)",
  };
  const fromFile = {
    inline: file.p8,
    path: file.p8Path,
    inlineLabel: "p8 (inline PEM)",
    pathLabel: "p8Path (file path)",
  };
  const source = (fromEnv.inline ?? fromEnv.path) ? fromEnv : fromFile;

  if (source.inline && source.path) {
    throw new Error(`Set only one of ${source.inlineLabel} or ${source.pathLabel}, not both.`);
  }
  if (source.inline) return unescapeNewlines(source.inline);
  if (source.path) {
    const path = expandTilde(source.path);
    let key: string;
    try {
      key = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(`Could not read the private key (${path}): ${message(err)}`, { cause: err });
    }
    warnIfGroupReadable(path);
    return key;
  }
  // Deliberately not a throw. A missing key means "unconfigured", which the
  // server reports through app_store_connect_auth_status; exiting here would
  // surface in the client as a bare "Connection closed" with this explanation
  // swallowed. setupInstructions() carries the guidance instead.
  return undefined;
};

/**
 * Environment first, config file second, **per field** — not whole-source.
 * Docker and CI inject the environment and must keep working untouched, while a
 * one-off `APP_STORE_CONNECT_ALLOW_WRITES=0` still has to override a file that
 * says `true`. Merging field by field is the only rule that gives both.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
): Config => {
  const file = readConfigFile(configPath);
  const envVendor = trimmed(env.APP_STORE_CONNECT_VENDOR_NUMBER);
  return ConfigSchema.parse({
    keyId: trimmed(env.APP_STORE_CONNECT_KEY_ID) ?? file.keyId,
    issuerId: trimmed(env.APP_STORE_CONNECT_ISSUER_ID) ?? file.issuerId,
    privateKey: resolvePrivateKey(env, file),
    vendorNumber: envVendor ?? file.vendorNumber,
    vendorNumberSource: envVendor ? "environment" : file.vendorNumber ? "file" : undefined,
    allowWrites: parseBool(env.APP_STORE_CONNECT_ALLOW_WRITES) ?? file.allowWrites,
    maxRetries: parseIntOpt(env.APP_STORE_CONNECT_MAX_RETRIES) ?? file.maxRetries,
    tokenTtlSeconds: parseIntOpt(env.APP_STORE_CONNECT_TOKEN_TTL_SECONDS) ?? file.tokenTtlSeconds,
    // `trimmed` maps "" to undefined, so the repo root is spelled "." here.
    metadataRoot: trimmed(env.APP_STORE_CONNECT_METADATA_ROOT) ?? file.metadataRoot,
    contact: mergeContact(env, file.contact),
  });
};

/**
 * Merged per field like everything else, so `APP_STORE_CONNECT_CONTACT_EMAIL`
 * can override one line of a file that supplies the other three. Returns
 * undefined rather than `{}` when nothing is set anywhere: an empty object would
 * read downstream as "a contact was configured" and suppress the hint telling
 * you to configure one.
 */
const mergeContact = (env: NodeJS.ProcessEnv, file: Contact | undefined): Contact | undefined => {
  const merged = compactContact({
    firstName: trimmed(env.APP_STORE_CONNECT_CONTACT_FIRST_NAME) ?? file?.firstName,
    lastName: trimmed(env.APP_STORE_CONNECT_CONTACT_LAST_NAME) ?? file?.lastName,
    email: trimmed(env.APP_STORE_CONNECT_CONTACT_EMAIL) ?? file?.email,
    phone: trimmed(env.APP_STORE_CONNECT_CONTACT_PHONE) ?? file?.phone,
  });
  return Object.keys(merged).length > 0 ? merged : undefined;
};

const compactContact = (contact: Contact): Contact =>
  Object.fromEntries(Object.entries(contact).filter(([, v]) => v !== undefined));

/** True once the server can actually mint a JWT for App Store Connect. */
export const isConfigured = (config: Config): boolean =>
  Boolean(config.keyId && config.issuerId && config.privateKey);

/**
 * Returned by app_store_connect_auth_status and printed to stderr at startup.
 * Prose rather than a code, because this is the text someone acts on when
 * nothing works.
 */
export const setupInstructions = (
  config: Config,
  configPath: string = resolveConfigPath(),
): string[] => {
  if (isConfigured(config)) return [];
  const steps: string[] = [];
  if (!config.keyId) steps.push("Set APP_STORE_CONNECT_KEY_ID (the 10-character key id).");
  if (!config.issuerId) steps.push("Set APP_STORE_CONNECT_ISSUER_ID (a UUID).");
  if (!config.privateKey) {
    steps.push(
      "No private key found. Set APP_STORE_CONNECT_P8_PATH to your AuthKey_XXXX.p8 file " +
        "(or APP_STORE_CONNECT_P8 to its inline PEM contents), or add `p8Path` to " +
        `${configPath}.`,
    );
  }
  steps.push(
    "Create the key at https://appstoreconnect.apple.com/access/integrations/api — the .p8 is " +
      "downloadable exactly once.",
    "Then restart the server.",
  );
  return steps;
};
