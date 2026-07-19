import {
  DEFAULT_METADATA_ROOT,
  FIELDS,
  FIELD_LIMITS,
  type ListingDocument,
  type ListingField,
  charCount,
  orderLocales,
} from "./document.js";

const LABELS: Record<ListingField, string> = {
  name: "Name",
  subtitle: "Subtitle",
  promotionalText: "Promotional Text",
  description: "Description",
  keywords: "Keywords",
  whatsNew: "What's New",
  marketingUrl: "Marketing URL",
  supportUrl: "Support URL",
  privacyPolicyUrl: "Privacy Policy URL",
};

/** App Store Connect's own field order, so the output reads top to bottom. */
const DISPLAY_ORDER: ListingField[] = [
  "name",
  "subtitle",
  "promotionalText",
  "description",
  "keywords",
  "whatsNew",
  "marketingUrl",
  "supportUrl",
  "privacyPolicyUrl",
];

/**
 * A human-readable rendering of a listing, for reading in a terminal or pasting
 * into a review. This is deliberately one-directional: nothing parses it back.
 * The metadata tree is the format, and keeping the readable view lossy is what
 * lets it stay readable — no escaping, no sentinels, no round-trip constraints.
 */
export const renderReview = (
  doc: ListingDocument,
  metadataRoot: string = DEFAULT_METADATA_ROOT,
): string => {
  const out: string[] = [];
  const { app, version } = doc;

  out.push(`# ${app.bundleId ?? app.id} — ${version.versionString}`);
  out.push("");
  out.push(
    `${version.platform} · ${version.appStoreState ?? "unknown state"} · exported ${doc.exportedAt}`,
  );
  out.push("");
  out.push(
    metadataRoot === ""
      ? "_Read-only view. Edit the metadata files at the repo root instead._"
      : `_Read-only view. Edit the files under \`${metadataRoot}/\` instead._`,
  );

  for (const locale of orderLocales(Object.keys(doc.locales), app.primaryLocale)) {
    const fields = doc.locales[locale] ?? {};
    out.push("");
    out.push(`## ${locale}${locale === app.primaryLocale ? " (primary)" : ""}`);

    for (const field of DISPLAY_ORDER) {
      const value = fields[field];
      if (value === undefined) continue;
      const chars = charCount(value);
      const limit = FIELD_LIMITS[field];
      const flag = chars > limit ? " ⚠️ OVER" : "";
      out.push("");
      out.push(`### ${LABELS[field]} — ${chars}/${limit}${flag}`);
      out.push("");
      out.push(value === "" ? "_(empty)_" : value);
    }

    const missing = FIELDS.filter((f) => fields[f] === undefined);
    if (missing.length > 0) {
      out.push("");
      out.push(`_Not returned for this locale: ${missing.map((f) => LABELS[f]).join(", ")}._`);
    }
  }

  return `${out.join("\n")}\n`;
};
