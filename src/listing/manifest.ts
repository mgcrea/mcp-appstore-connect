import {
  FIELDS,
  FIELD_BY_FILE,
  FILE_MAP,
  METADATA_ROOT,
  SIDECAR_PATH,
  type ListingDocument,
  type ListingField,
  type LocaleFields,
  type Sidecar,
  orderLocales,
  sidecarSchema,
  stripTrailingNewline,
  toSidecar,
} from "./document.js";

export type ManifestFile = { path: string; content: string };

const SIDECAR_BASENAME = ".listing.json";
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * A field written as an empty file means "clear this field"; a field with no
 * file at all means "leave it alone". Expressing null-vs-empty as file presence
 * is what lets the tree stay plain text with no sentinel values in it.
 */
export const toManifest = (doc: ListingDocument): ManifestFile[] => {
  const files: ManifestFile[] = [
    { path: SIDECAR_PATH, content: `${JSON.stringify(toSidecar(doc), null, 2)}\n` },
  ];

  for (const locale of orderLocales(Object.keys(doc.locales), doc.app.primaryLocale)) {
    const fields = doc.locales[locale] ?? {};
    for (const field of FIELDS) {
      const value = fields[field];
      if (value === undefined) continue;
      files.push({
        path: `${METADATA_ROOT}/${locale}/${FILE_MAP[field]}`,
        content: `${value}\n`,
      });
    }
  }

  return files;
};

/** Normalize separators and drop any prefix above the metadata root. */
const normalizePath = (raw: string): string => {
  const unix = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  const index = unix.lastIndexOf(`${METADATA_ROOT}/`);
  return index === -1 ? unix : unix.slice(index);
};

export type ParsedManifest = {
  sidecar: Sidecar;
  /** Only the locales and fields actually present in the manifest. */
  locales: Record<string, LocaleFields>;
};

export class ManifestError extends Error {}

/**
 * Read a set of metadata files back into an edit set. Unknown paths are an
 * error rather than a silent skip: a typo'd filename that we quietly ignored
 * would look exactly like "that field had no changes".
 */
export const parseManifest = (files: ManifestFile[]): ParsedManifest => {
  let sidecarRaw: unknown;
  const locales: Record<string, LocaleFields> = {};

  for (const file of files) {
    const path = normalizePath(file.path);

    if (path === SIDECAR_PATH || path.endsWith(`/${SIDECAR_BASENAME}`)) {
      try {
        sidecarRaw = JSON.parse(file.content);
      } catch (err) {
        throw new ManifestError(
          `${SIDECAR_PATH} is not valid JSON (${err instanceof Error ? err.message : "parse error"}). ` +
            `Re-export the listing rather than repairing it by hand.`,
        );
      }
      continue;
    }

    const rest = path.startsWith(`${METADATA_ROOT}/`)
      ? path.slice(METADATA_ROOT.length + 1)
      : undefined;
    if (rest === undefined) {
      throw new ManifestError(
        `Unexpected path "${file.path}" — every metadata file must live under ${METADATA_ROOT}/.`,
      );
    }

    const segments = rest.split("/");
    if (segments.length !== 2) {
      throw new ManifestError(
        `Unexpected path "${file.path}" — expected ${METADATA_ROOT}/<locale>/<field>.txt.`,
      );
    }

    const [locale, basename] = segments as [string, string];
    if (!LOCALE_PATTERN.test(locale)) {
      throw new ManifestError(
        `"${locale}" in "${file.path}" is not a locale code (expected e.g. en-US, fr-FR, zh-Hans).`,
      );
    }

    const field: ListingField | undefined = FIELD_BY_FILE[basename];
    if (field === undefined) {
      throw new ManifestError(
        `"${basename}" in "${file.path}" is not a listing field. Expected one of: ` +
          `${Object.values(FILE_MAP).toSorted().join(", ")}.`,
      );
    }

    (locales[locale] ??= {})[field] = stripTrailingNewline(file.content);
  }

  if (sidecarRaw === undefined) {
    throw new ManifestError(
      `${SIDECAR_PATH} was not included. It carries the App Store Connect ids and the baseline ` +
        `digests used to detect conflicting edits, so it is required on every apply.`,
    );
  }

  const parsed = sidecarSchema.safeParse(sidecarRaw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ManifestError(
      `${SIDECAR_PATH} is malformed (${issues}). Re-export the listing rather than repairing it by hand.`,
    );
  }

  return { sidecar: parsed.data, locales };
};
