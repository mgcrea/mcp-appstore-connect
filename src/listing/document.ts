import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * The listing is stored as one plain-text file per field per locale, in the
 * layout `fastlane deliver` already uses. The point of file-per-field is that
 * the file content *is* the value, byte for byte: there are no delimiters, so a
 * description containing "## Keywords", a "---" line or a fenced code block is
 * just text. Every single-document format needs an escape hatch for content that
 * looks like its own syntax, and when that escaping is wrong the failure is
 * silent — a truncated description pushed live.
 */
export const METADATA_ROOT = "fastlane/metadata";
export const SIDECAR_PATH = `${METADATA_ROOT}/.listing.json`;

export type ListingField =
  | "name"
  | "subtitle"
  | "privacyPolicyUrl"
  | "description"
  | "keywords"
  | "whatsNew"
  | "promotionalText"
  | "marketingUrl"
  | "supportUrl";

/** Which resource each field is PATCHed back to. Drives the whole apply path. */
export const FIELD_TARGET = {
  name: "appInfo",
  subtitle: "appInfo",
  privacyPolicyUrl: "appInfo",
  description: "version",
  keywords: "version",
  whatsNew: "version",
  promotionalText: "version",
  marketingUrl: "version",
  supportUrl: "version",
} as const satisfies Record<ListingField, "appInfo" | "version">;

/**
 * Apple counts UTF-16 code units, which is exactly `String.length` — so an emoji
 * costs 2 and a CJK character costs 1. Do not "fix" this to count code points.
 */
export const FIELD_LIMITS = {
  name: 30,
  subtitle: 30,
  privacyPolicyUrl: 255,
  description: 4000,
  keywords: 100,
  whatsNew: 4000,
  promotionalText: 170,
  marketingUrl: 255,
  supportUrl: 255,
} as const satisfies Record<ListingField, number>;

/** Field <-> filename, using fastlane deliver's names so the tree interops. */
export const FILE_MAP = {
  name: "name.txt",
  subtitle: "subtitle.txt",
  privacyPolicyUrl: "privacy_url.txt",
  description: "description.txt",
  keywords: "keywords.txt",
  whatsNew: "release_notes.txt",
  promotionalText: "promotional_text.txt",
  marketingUrl: "marketing_url.txt",
  supportUrl: "support_url.txt",
} as const satisfies Record<ListingField, string>;

export const FIELDS = Object.keys(FILE_MAP) as ListingField[];

export const FIELD_BY_FILE = Object.fromEntries(
  FIELDS.map((field) => [FILE_MAP[field], field]),
) as Record<string, ListingField>;

/** ASC attribute name -> our field name. They agree except for what's-new. */
export const VERSION_ATTRIBUTES = {
  description: "description",
  keywords: "keywords",
  whatsNew: "whatsNew",
  promotionalText: "promotionalText",
  marketingUrl: "marketingUrl",
  supportUrl: "supportUrl",
} as const;

export const APP_INFO_ATTRIBUTES = {
  name: "name",
  subtitle: "subtitle",
  privacyPolicyUrl: "privacyPolicyUrl",
} as const;

export type LocaleFields = Partial<Record<ListingField, string>>;

export type ListingDocument = {
  schemaVersion: 1;
  app: { id: string; bundleId?: string; sku?: string; primaryLocale: string };
  version: {
    id: string;
    versionString: string;
    platform: string;
    appStoreState?: string;
  };
  appInfo: {
    id: string;
    appStoreState?: string;
    primaryCategory?: string;
    secondaryCategory?: string;
  };
  exportedAt: string;
  /** locale -> the two localization row ids it maps to. Either may be absent. */
  localizationIds: Record<string, { version?: string; appInfo?: string }>;
  /** locale -> the copy itself. Absent key means the field was not present live. */
  locales: Record<string, LocaleFields>;
  /** locale -> field -> digest of the value at export time. Powers conflict detection. */
  baseline: Record<string, Partial<Record<ListingField, string>>>;
};

/** Short digest — this is change detection, not cryptography. */
export const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);

export const charCount = (value: string): number => value.length;

/**
 * Editors add or strip a trailing newline without being asked, and a bare "\n"
 * difference would otherwise read as a real edit and push a no-op change live.
 * One trailing newline is written on export and stripped on read, so the two
 * cancel out; anything beyond one is content and is preserved.
 */
export const stripTrailingNewline = (content: string): string =>
  content.endsWith("\n") ? content.slice(0, -1) : content;

export const overLimit = (
  field: ListingField,
  value: string,
): { field: ListingField; chars: number; limit: number; overBy: number } | undefined => {
  const limit = FIELD_LIMITS[field];
  const chars = charCount(value);
  return chars > limit ? { field, chars, limit, overBy: chars - limit } : undefined;
};

const localizationIdsSchema = z.record(
  z.string(),
  z.object({ version: z.string().optional(), appInfo: z.string().optional() }),
);

const baselineSchema = z.record(z.string(), z.record(z.string(), z.string()));

/**
 * The sidecar is committed, hand-editable, and load-bearing: it carries the ids
 * we PATCH and the digests that decide whether an edit is a change or a
 * conflict. Parse it strictly and refuse anything surprising — a half-understood
 * sidecar is how you overwrite someone else's listing.
 */
export const sidecarSchema = z.object({
  schemaVersion: z.literal(1),
  app: z.object({
    id: z.string().min(1),
    bundleId: z.string().optional(),
    sku: z.string().optional(),
    primaryLocale: z.string().min(1),
  }),
  version: z.object({
    id: z.string().min(1),
    versionString: z.string().min(1),
    platform: z.string().min(1),
    appStoreState: z.string().optional(),
  }),
  appInfo: z.object({
    id: z.string().min(1),
    appStoreState: z.string().optional(),
    primaryCategory: z.string().optional(),
    secondaryCategory: z.string().optional(),
  }),
  exportedAt: z.string().min(1),
  localizationIds: localizationIdsSchema,
  baseline: baselineSchema,
});

export type Sidecar = z.infer<typeof sidecarSchema>;

export const toSidecar = (doc: ListingDocument): Sidecar => ({
  schemaVersion: doc.schemaVersion,
  app: doc.app,
  version: doc.version,
  appInfo: doc.appInfo,
  exportedAt: doc.exportedAt,
  localizationIds: doc.localizationIds,
  baseline: doc.baseline,
});

/** Primary locale first, then alphabetical — stable output means clean diffs. */
export const orderLocales = (locales: string[], primaryLocale: string): string[] => {
  const rest = locales.filter((l) => l !== primaryLocale).toSorted();
  return locales.includes(primaryLocale) ? [primaryLocale, ...rest] : rest;
};
