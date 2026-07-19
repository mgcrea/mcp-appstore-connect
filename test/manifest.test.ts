import { describe, expect, it } from "vitest";

import {
  DEFAULT_METADATA_ROOT,
  type ListingDocument,
  MetadataRootError,
  digest,
  normalizeMetadataRoot,
  sidecarPath,
  toSidecar,
} from "../src/listing/document.js";
import { parseManifest, toManifest } from "../src/listing/manifest.js";
import { renderReview } from "../src/listing/review.js";

const SIDECAR_PATH = sidecarPath(DEFAULT_METADATA_ROOT);

/**
 * The exact content a single-document format would mangle: markdown headings
 * that collide with field names, a horizontal rule, a fenced block, an em dash
 * and non-Latin text. If this survives, the format has no escaping problem.
 */
const HOSTILE_DESCRIPTION = [
  "Acme is a native client for object storage.",
  "",
  "## Keywords",
  "",
  "These words look like a heading but are body text — they must survive.",
  "",
  "---",
  "",
  "```",
  "$ acme sync --bucket photos",
  "```",
  "",
  "日本語のテキストもそのまま残ります。",
].join("\n");

const doc = (): ListingDocument => ({
  schemaVersion: 1,
  app: { id: "1234567890", bundleId: "com.acme.app", primaryLocale: "en-US" },
  version: {
    id: "aaaa-1111",
    versionString: "1.4.0",
    platform: "IOS",
    appStoreState: "PREPARE_FOR_SUBMISSION",
  },
  appInfo: { id: "bbbb-2222" },
  exportedAt: "2026-07-19T09:12:00.000Z",
  localizationIds: {
    "en-US": { version: "vloc-en", appInfo: "aloc-en" },
    "fr-FR": { version: "vloc-fr", appInfo: "aloc-fr" },
  },
  locales: {
    "fr-FR": {
      name: "Acme",
      subtitle: "Gestion de stockage",
      description: "Bonjour.",
      keywords: "",
    },
    "en-US": {
      name: "Acme",
      subtitle: "Storage manager for R2 & S3",
      description: HOSTILE_DESCRIPTION,
      keywords: "bucket,storage,s3,r2",
      whatsNew: "Signed URLs.",
      marketingUrl: "",
    },
  },
  baseline: {
    "en-US": { description: digest(HOSTILE_DESCRIPTION) },
    "fr-FR": {},
  },
});

/** A valid sidecar body, for tests that care about paths rather than content. */
const SIDECAR_JSON = JSON.stringify(toSidecar(doc()));

describe("metadata manifest", () => {
  it("round-trips content that would break a single-document format", () => {
    const parsed = parseManifest(toManifest(doc()));
    expect(parsed.locales["en-US"]?.description).toBe(HOSTILE_DESCRIPTION);
    expect(parsed.locales["en-US"]?.subtitle).toBe("Storage manager for R2 & S3");
    expect(parsed.locales["fr-FR"]?.description).toBe("Bonjour.");
  });

  it("preserves the sidecar exactly", () => {
    const original = doc();
    expect(parseManifest(toManifest(original)).sidecar).toEqual(toSidecar(original));
  });

  it("distinguishes an empty field from an absent one", () => {
    const parsed = parseManifest(toManifest(doc()));
    // Written as an empty file -> present and empty -> "clear this field".
    expect(parsed.locales["en-US"]?.marketingUrl).toBe("");
    // Never returned by the API -> no file -> "leave it alone".
    expect(parsed.locales["en-US"]).not.toHaveProperty("supportUrl");
  });

  it("uses fastlane deliver's filenames", () => {
    const paths = toManifest(doc()).map((f) => f.path);
    expect(paths).toContain("fastlane/metadata/en-US/release_notes.txt");
    expect(paths).toContain("fastlane/metadata/en-US/keywords.txt");
    expect(paths).toContain("fastlane/metadata/fr-FR/subtitle.txt");
    expect(paths).toContain(SIDECAR_PATH);
  });

  it("writes the primary locale first so diffs stay stable", () => {
    const localeOrder = toManifest(doc())
      .map((f) => f.path.split("/")[2])
      .filter((segment): segment is string => segment !== undefined && segment.includes("-"));
    expect(localeOrder[0]).toBe("en-US");
    expect(new Set(localeOrder)).toEqual(new Set(["en-US", "fr-FR"]));
  });

  it("tolerates an absolute path and a ./ prefix", () => {
    const files = toManifest(doc()).map((f) => ({
      path: `/Users/me/repo/${f.path}`,
      content: f.content,
    }));
    expect(parseManifest(files).locales["en-US"]?.description).toBe(HOSTILE_DESCRIPTION);
  });

  it("strips exactly one trailing newline, not content", () => {
    const files = [
      ...toManifest(doc()).filter((f) => f.path === SIDECAR_PATH),
      { path: "fastlane/metadata/en-US/description.txt", content: "line\n\n\n" },
    ];
    expect(parseManifest(files).locales["en-US"]?.description).toBe("line\n\n");
  });

  it("rejects an unknown filename rather than silently ignoring it", () => {
    const files = [
      ...toManifest(doc()).filter((f) => f.path === SIDECAR_PATH),
      { path: "fastlane/metadata/en-US/descriptions.txt", content: "oops" },
    ];
    expect(() => parseManifest(files)).toThrow(/not a listing field/);
  });

  it("rejects a path that is not a locale directory", () => {
    const files = [
      ...toManifest(doc()).filter((f) => f.path === SIDECAR_PATH),
      { path: "fastlane/metadata/notalocale!/description.txt", content: "oops" },
    ];
    expect(() => parseManifest(files)).toThrow(/not a locale code/);
  });

  it("requires the sidecar", () => {
    const files = toManifest(doc()).filter((f) => f.path !== SIDECAR_PATH);
    expect(() => parseManifest(files)).toThrow(/\.listing\.json was not included/);
  });

  it("refuses a malformed sidecar instead of half-trusting it", () => {
    const files = [
      { path: SIDECAR_PATH, content: JSON.stringify({ schemaVersion: 1, app: { id: "x" } }) },
      { path: "fastlane/metadata/en-US/description.txt", content: "hi\n" },
    ];
    expect(() => parseManifest(files)).toThrow(/malformed/);
  });

  it("refuses a sidecar that is not JSON", () => {
    expect(() => parseManifest([{ path: SIDECAR_PATH, content: "{nope" }])).toThrow(
      /not valid JSON/,
    );
  });
});

describe("metadata root", () => {
  it.each(["fastlane/metadata", "Metadata", "a/b/c/meta", ""])(
    "round-trips a tree rooted at %j",
    (root) => {
      const files = toManifest(doc(), root);
      const prefix = root === "" ? "" : `${root}/`;
      expect(files.map((f) => f.path)).toContain(`${prefix}en-US/description.txt`);
      expect(files.map((f) => f.path)).toContain(`${prefix}.listing.json`);

      const parsed = parseManifest(files);
      expect(parsed.locales["en-US"]?.description).toBe(HOSTILE_DESCRIPTION);
      expect(parsed.sidecar).toEqual(toSidecar(doc()));
    },
  );

  /**
   * The old normalizePath sliced at the LAST occurrence of the root, so a repo
   * path that happened to repeat the root name lost everything before the
   * second one. Nothing catches that downstream — it applies against the wrong
   * ids — so it is pinned here rather than left to the round-trip tests.
   */
  it("does not mis-slice a path that repeats the root name", () => {
    const files = [
      { path: "a/meta/b/meta/.listing.json", content: SIDECAR_JSON },
      { path: "a/meta/b/meta/en-US/description.txt", content: "hi\n" },
    ];
    expect(parseManifest(files).locales["en-US"]?.description).toBe("hi");
  });

  it("rejects field files from a different tree than the sidecar", () => {
    const files = [
      { path: "Metadata/.listing.json", content: SIDECAR_JSON },
      { path: "fastlane/metadata/en-US/description.txt", content: "hi\n" },
    ];
    expect(() => parseManifest(files)).toThrow(/must live under "Metadata\/"/);
  });

  it("refuses more than one sidecar rather than letting the last one win", () => {
    const files = [
      { path: "Metadata/.listing.json", content: SIDECAR_JSON },
      { path: "fastlane/metadata/.listing.json", content: SIDECAR_JSON },
    ];
    expect(() => parseManifest(files)).toThrow(/More than one \.listing\.json/);
  });

  it("accepts windows separators on both the sidecar and the fields", () => {
    const files = toManifest(doc(), "Metadata").map((f) => ({
      path: f.path.replace(/\//g, "\\"),
      content: f.content,
    }));
    expect(parseManifest(files).locales["en-US"]?.description).toBe(HOSTILE_DESCRIPTION);
  });

  it("rejects a path containing ..", () => {
    const files = [
      { path: SIDECAR_PATH, content: SIDECAR_JSON },
      { path: "fastlane/metadata/../metadata/en-US/description.txt", content: "hi\n" },
    ];
    expect(() => parseManifest(files)).toThrow(/contains "\.\."/);
  });

  /**
   * Known regression from inferring the root: the two path styles no longer
   * normalize to a common form. Pinned deliberately — both sets come from one
   * export_listing response written by one agent, so mixing them means the
   * caller assembled the list by hand and the mismatch is worth surfacing.
   */
  it("rejects an absolute sidecar paired with relative field files", () => {
    const files = [
      { path: "/repo/fastlane/metadata/.listing.json", content: SIDECAR_JSON },
      { path: "fastlane/metadata/en-US/description.txt", content: "hi\n" },
    ];
    expect(() => parseManifest(files)).toThrow(/same style of path/);
  });
});

describe("normalizeMetadataRoot", () => {
  it.each([
    ["fastlane/metadata", "fastlane/metadata"],
    [".", ""],
    ["", ""],
    ["./Metadata/", "Metadata"],
    ["a//b/", "a/b"],
    ["Metadata\\en", "Metadata/en"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeMetadataRoot(input)).toBe(expected);
  });

  it.each(["/abs/path", "C:/x", "a/../b", "x/.listing.json"])("rejects %j", (input) => {
    expect(() => normalizeMetadataRoot(input)).toThrow(MetadataRootError);
  });
});

describe("review rendering", () => {
  it("reports character counts and flags an over-limit field", () => {
    const over = doc();
    over.locales["en-US"]!.subtitle = "x".repeat(31);
    const md = renderReview(over);
    expect(md).toContain("### Subtitle — 31/30 ⚠️ OVER");
    expect(md).toContain("en-US (primary)");
  });

  it("marks an empty field rather than rendering nothing", () => {
    expect(renderReview(doc())).toContain("_(empty)_");
  });
});
