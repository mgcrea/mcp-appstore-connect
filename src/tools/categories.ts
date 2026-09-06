import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { includedOf, resourcesOf, summarizeResponse } from "#/client/shape";
import { compact, limitArg, PLATFORMS, savePathArg, wrap, wrapSaved } from "#/tools/util";

// A category is not metadata you can leave for later: an app with no
// primaryCategory is refused at submission with
// ENTITY_ERROR.RELATIONSHIP.REQUIRED against /v1/appInfos, and nothing in the
// version's own state hints at it. It lives on appInfo rather than on the
// version, so it outlives a release and only has to be set once.

const appInfoIdArg = z
  .string()
  .min(1)
  .describe("The appInfo id (from app_store_connect_list_app_infos).");

/**
 * Category ids are stable uppercase slugs ("PRODUCTIVITY", "UTILITIES"), not
 * opaque numbers, so they read as guessable — and mostly are. The ones that are
 * not are exactly the ones people reach for: developer tools is `DEVELOPER_TOOLS`
 * but only exists on macOS, and several App Store names differ from their slug.
 * List them rather than guessing; a wrong id is a 409 at submission, not here.
 */
const categoryRelationship = (id: string | undefined) =>
  id === undefined ? undefined : { data: { type: "appCategories", id } };

/**
 * Apple models "no secondary category" as an explicit null relationship rather
 * than an absent one, so clearing has to be distinguishable from not-mentioning.
 * `null` clears, `undefined` leaves alone.
 */
const clearableCategoryRelationship = (id: string | null | undefined) => {
  if (id === undefined) return undefined;
  return id === null ? { data: null } : { data: { type: "appCategories", id } };
};

const categoryArg = (what: string) =>
  z
    .string()
    .min(1)
    .optional()
    .describe(`${what} (an appCategories id from app_store_connect_list_app_categories).`);

const clearableCategoryArg = (what: string) =>
  z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      `${what} (an appCategories id from app_store_connect_list_app_categories). ` +
        "Pass null to clear it.",
    );

export const registerCategoryTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_app_categories",
    {
      title: "App Store Connect: List App Categories",
      description:
        "List the App Store categories an app can be filed under, with their subcategories. " +
        "Returns the appCategories ids that app_store_connect_set_app_categories takes. " +
        "Categories are platform-specific — Developer Tools exists on macOS and not on iOS — so " +
        "filter by the platform you are submitting for rather than assuming a shared list.",
      inputSchema: z.object({
        platform: z
          .enum(PLATFORMS)
          .optional()
          .describe("Only categories available on this platform."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ platform, limit, savePath }) =>
      wrapSaved(savePath, async () => {
        // `exists[parent]=false` keeps the top level only; without it the
        // subcategories come back as siblings of their own parents and the list
        // reads as a flat jumble of 60-odd entries.
        const response = await client.get(
          "/v1/appCategories",
          compact({
            "filter[platforms]": platform,
            "exists[parent]": "false",
            include: "subcategories",
            limit,
          }),
        );

        const subcategories = new Map(
          includedOf(response, "appCategories").map((sub) => [sub.id as string, sub]),
        );

        return {
          data: resourcesOf(response).map((category) => {
            const rels = (category.relationships ?? {}) as Record<string, unknown>;
            const subs = rels.subcategories as { data?: { id: string }[] } | undefined;
            return {
              id: category.id,
              platforms: (category.attributes as Record<string, unknown> | undefined)?.platforms,
              subcategories: (subs?.data ?? [])
                .map((ref) => subcategories.get(ref.id)?.id ?? ref.id)
                .filter(Boolean),
            };
          }),
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_set_app_categories",
    {
      title: "App Store Connect: Set App Categories",
      description:
        "Set an app's App Store category. A primary category is REQUIRED before a version can be " +
        "submitted; without one Apple refuses the submission with a relationship error against " +
        "the appInfo and names nothing else. Only the categories you pass are changed. " +
        "Subcategories are optional and only some categories accept them (Games most notably). " +
        "This is version-independent — set it once, not per release.",
      inputSchema: z.object({
        appInfoId: appInfoIdArg,
        primaryCategory: categoryArg("The app's main category"),
        primarySubcategoryOne: clearableCategoryArg("First subcategory of the primary category"),
        primarySubcategoryTwo: clearableCategoryArg("Second subcategory of the primary category"),
        secondaryCategory: clearableCategoryArg("The app's optional second category"),
        secondarySubcategoryOne: clearableCategoryArg(
          "First subcategory of the secondary category",
        ),
        secondarySubcategoryTwo: clearableCategoryArg(
          "Second subcategory of the secondary category",
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({
      appInfoId,
      primaryCategory,
      primarySubcategoryOne,
      primarySubcategoryTwo,
      secondaryCategory,
      secondarySubcategoryOne,
      secondarySubcategoryTwo,
    }) =>
      wrap(async () =>
        summarizeResponse(
          await client.patch(`/v1/appInfos/${appInfoId}`, {
            data: {
              type: "appInfos",
              id: appInfoId,
              relationships: compact({
                primaryCategory: categoryRelationship(primaryCategory),
                primarySubcategoryOne: clearableCategoryRelationship(primarySubcategoryOne),
                primarySubcategoryTwo: clearableCategoryRelationship(primarySubcategoryTwo),
                secondaryCategory: clearableCategoryRelationship(secondaryCategory),
                secondarySubcategoryOne: clearableCategoryRelationship(secondarySubcategoryOne),
                secondarySubcategoryTwo: clearableCategoryRelationship(secondarySubcategoryTwo),
              }),
            },
          }),
        ),
      ),
  );
};
