import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { applyListing, type Rejection } from "../listing/apply.js";
import { FIELD_LIMITS, METADATA_ROOT, SIDECAR_PATH, charCount } from "../listing/document.js";
import { fetchListing } from "../listing/fetch.js";
import { ManifestError, parseManifest, toManifest } from "../listing/manifest.js";
import { renderReview } from "../listing/review.js";
import { appIdArg, fail, ok, okText, wrapResult } from "./util.js";

const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;

const localesArg = z
  .array(z.string())
  .optional()
  .describe('Restrict to these locales, e.g. ["en-US","fr-FR"]. Omit for every locale.');

/** Carries the per-field breach detail through the shared error path. */
class ListingOverLimitError extends Error {
  readonly details: { rejections: Rejection[] };

  constructor(rejections: Rejection[]) {
    super(
      `Nothing was written. ${rejections.length} field(s) exceed Apple's limit: ` +
        rejections.map((r) => `${r.locale}/${r.field} ${r.chars}/${r.limit}`).join(", ") +
        ". Shorten them and re-run.",
    );
    this.details = { rejections };
  }
}

export const registerListingTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_export_listing",
    {
      description:
        "Export an app's complete App Store listing — name, subtitle, description, keywords, " +
        "what's-new, promotional text and URLs, for every locale — as a set of files you can " +
        `commit to git. Returns paths and contents under ${METADATA_ROOT}/ (the layout fastlane ` +
        "deliver uses); write them yourself, then edit and push back with " +
        "app_store_connect_apply_listing. Use format 'review' to just read the listing.",
      inputSchema: {
        appId: appIdArg,
        version: z
          .string()
          .default("latest")
          .describe(
            '"latest" for the version you are preparing (PREPARE_FOR_SUBMISSION and friends), ' +
              '"live" for the one on sale, or an exact versionString like "1.4.0".',
          ),
        platform: z.enum(PLATFORMS).default("IOS").describe("Platform for the version."),
        locales: localesArg,
        format: z
          .enum(["files", "review", "json"])
          .default("files")
          .describe(
            "'files' returns the metadata tree to write to disk. 'review' returns a read-only " +
              "markdown summary with character counts. 'json' returns the raw listing document.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, version, platform, locales, format }) =>
      wrapResult(async () => {
        const doc = await fetchListing(client, {
          appId,
          version,
          platform,
          locales,
          now: () => new Date(),
        });

        if (format === "review") return okText(renderReview(doc));
        if (format === "json") return ok(doc);

        const over: { locale: string; field: string; chars: number; limit: number }[] = [];
        for (const [locale, fields] of Object.entries(doc.locales)) {
          for (const [field, value] of Object.entries(fields)) {
            const limit = FIELD_LIMITS[field as keyof typeof FIELD_LIMITS];
            const chars = charCount(value);
            if (chars > limit) over.push({ locale, field, chars, limit });
          }
        }

        return ok({
          version: doc.version,
          locales: Object.keys(doc.locales).length,
          files: toManifest(doc),
          overLimit: over,
          note:
            `Write each file at its path, relative to the repo root. ${SIDECAR_PATH} carries the ` +
            `ids and baseline digests that app_store_connect_apply_listing needs — commit it too. ` +
            `If ${METADATA_ROOT}/ already exists, diff before overwriting it.`,
        });
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_apply_listing",
    {
      description:
        "Push an edited App Store listing back to App Store Connect. Pass the metadata files you " +
        `changed plus ${SIDECAR_PATH}. Runs as a dry run by default: review the reported changes, ` +
        "then re-run with dryRun: false and confirm: true. Fields changed in App Store Connect " +
        "since the export are reported as conflicts and skipped unless you pass force.",
      inputSchema: {
        files: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .describe(`Repo-relative path, e.g. ${METADATA_ROOT}/en-US/description.txt`),
              content: z.string().describe("The file's exact contents."),
            }),
          )
          .min(1)
          .describe(
            `The metadata files you changed, plus ${SIDECAR_PATH} (always required — it carries ` +
              "the localization ids and the baseline digests used to detect conflicting edits).",
          ),
        dryRun: z
          .boolean()
          .default(true)
          .describe("Report the planned changes without writing anything. Defaults to true."),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Must be true when dryRun is false. Acknowledges this changes the live listing.",
          ),
        force: z
          .boolean()
          .default(false)
          .describe("Apply even where the listing changed upstream since export, overwriting it."),
        createMissingLocales: z
          .boolean()
          .default(false)
          .describe("Create localizations for locales in the files but not yet on the version."),
        locales: localesArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    // `confirm` is a plain boolean rather than the usual confirmArg (z.literal(true))
    // because the dry run has to be callable without it; the handler enforces the rule.
    async ({ files, dryRun, confirm, force, createMissingLocales, locales }) =>
      wrapResult(async () => {
        if (!dryRun && !confirm) {
          return fail(
            "Refusing to write: pass confirm: true together with dryRun: false. Run the dry run " +
              "first and read the reported changes.",
          );
        }

        let manifest;
        try {
          manifest = parseManifest(files);
        } catch (err) {
          if (err instanceof ManifestError) return fail(err.message);
          throw err;
        }

        const result = await applyListing(client, manifest, {
          dryRun,
          force,
          createMissingLocales,
          ...(locales !== undefined ? { locales } : {}),
        });
        if (!result.ok) throw new ListingOverLimitError(result.rejections);
        return ok(result);
      }),
  );
};
