import {
  DEFAULT_METADATA_ROOT,
  FIELDS,
  FIELD_BY_FILE,
  FILE_MAP,
  SIDECAR_BASENAME,
  type ListingDocument,
  type ListingField,
  type LocaleFields,
  type Sidecar,
  localeDir,
  orderLocales,
  sidecarPath,
  sidecarSchema,
  stripTrailingNewline,
  toSidecar,
} from "./document.js";

export type ManifestFile = { path: string; content: string };

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * A field written as an empty file means "clear this field"; a field with no
 * file at all means "leave it alone". Expressing null-vs-empty as file presence
 * is what lets the tree stay plain text with no sentinel values in it.
 */
export const toManifest = (
  doc: ListingDocument,
  metadataRoot: string = DEFAULT_METADATA_ROOT,
): ManifestFile[] => {
  const files: ManifestFile[] = [
    { path: sidecarPath(metadataRoot), content: `${JSON.stringify(toSidecar(doc), null, 2)}\n` },
  ];

  for (const locale of orderLocales(Object.keys(doc.locales), doc.app.primaryLocale)) {
    const fields = doc.locales[locale] ?? {};
    for (const field of FIELDS) {
      const value = fields[field];
      if (value === undefined) continue;
      files.push({
        path: `${localeDir(metadataRoot, locale)}/${FILE_MAP[field]}`,
        content: `${value}\n`,
      });
    }
  }

  return files;
};

/**
 * Separator normalization only — this knows nothing about any root. It used to
 * also slice off everything above "fastlane/metadata/", which quietly rewrote a
 * nested path into a top-level one and let files from one tree be applied with
 * another tree's sidecar. The root now comes from the sidecar instead.
 */
const toPosix = (raw: string): string => {
  const unix = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (unix.split("/").includes("..")) {
    throw new ManifestError(
      `Path "${raw}" contains "..". Pass the paths exactly as they appear in the repo.`,
    );
  }
  return unix;
};

const dirnameOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
};

/** How to name the root in an error, since "" has no path to quote. */
const describeRoot = (root: string): string =>
  root === "" ? "the repo root" : `"${root}/"`;

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
 *
 * The tree's location is inferred from the sidecar rather than fixed or passed
 * in. The sidecar has to be in the set anyway — it carries the ids and the
 * baseline digests — so its own directory is the one piece of information that
 * is always present, always unambiguous, and still correct after someone moves
 * the tree. Every other file is then required to sit under it, which is what
 * stops one tree's files being pushed with another tree's ids.
 */
export const parseManifest = (files: ManifestFile[]): ParsedManifest => {
  const normalized = files.map((file) => ({ ...file, unix: toPosix(file.path) }));
  const sidecars = normalized.filter(
    (file) => file.unix === SIDECAR_BASENAME || file.unix.endsWith(`/${SIDECAR_BASENAME}`),
  );

  if (sidecars.length === 0) {
    throw new ManifestError(
      `${SIDECAR_BASENAME} was not included. It carries the App Store Connect ids and the baseline ` +
        `digests used to detect conflicting edits, so it is required on every apply.`,
    );
  }
  if (sidecars.length > 1) {
    throw new ManifestError(
      `More than one ${SIDECAR_BASENAME} was passed (${sidecars.map((f) => `"${f.path}"`).join(", ")}). ` +
        `Pass exactly one — it identifies the metadata tree these files belong to.`,
    );
  }

  const [sidecarFile] = sidecars as [(typeof normalized)[number]];
  const root = dirnameOf(sidecarFile.unix);

  let sidecarRaw: unknown;
  try {
    sidecarRaw = JSON.parse(sidecarFile.content);
  } catch (err) {
    throw new ManifestError(
      `${sidecarFile.path} is not valid JSON (${err instanceof Error ? err.message : "parse error"}). ` +
        `Re-export the listing rather than repairing it by hand.`,
    );
  }

  const locales: Record<string, LocaleFields> = {};

  for (const file of normalized) {
    if (file === sidecarFile) continue;
    const path = file.unix;

    const prefix = root === "" ? "" : `${root}/`;
    if (!path.startsWith(prefix)) {
      throw new ManifestError(
        `Unexpected path "${file.path}" — the ${SIDECAR_BASENAME} you passed is at ` +
          `"${sidecarFile.path}", so every metadata file must live under ${describeRoot(root)}. ` +
          `Pass the sidecar from the same tree as the files, and use the same style of path ` +
          `(all repo-relative, or all absolute) for both.`,
      );
    }
    const rest = path.slice(prefix.length);

    const segments = rest.split("/");
    if (segments.length !== 2) {
      throw new ManifestError(
        `Unexpected path "${file.path}" — expected ` +
          `${root === "" ? "" : `${root}/`}<locale>/<field>.txt.`,
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

  const parsed = sidecarSchema.safeParse(sidecarRaw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ManifestError(
      `${sidecarFile.path} is malformed (${issues}). Re-export the listing rather than repairing it by hand.`,
    );
  }

  return { sidecar: parsed.data, locales };
};
