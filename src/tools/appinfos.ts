import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { appIdArg, compact, limitArg, wrap } from "./util.js";

// An app's listing is split across two resources, and which one holds a field is
// not guessable: appStoreVersionLocalizations carry the per-version copy
// (description, keywords, what's-new), while appInfoLocalizations carry the copy
// that outlives a version (name, subtitle, privacy policy). Without these tools
// the app's own name and subtitle are unreachable.

const appInfoIdArg = z
  .string()
  .min(1)
  .describe("The appInfo id (from app_store_connect_list_app_infos).");

const appInfoLocalizationIdArg = z
  .string()
  .min(1)
  .describe(
    "The appInfoLocalization id (from app_store_connect_list_app_info_localizations). " +
      "This is NOT the appStoreVersionLocalization id — they are different resources.",
  );

// The age rating questionnaire hangs off appInfo, not appStoreVersion — the
// version-scoped endpoint Apple used to expose is gone. `list_app_infos` returns
// the resulting rating (appStoreAgeRating) but not the answers behind it, and the
// answers are what Apple gates submissions on: from September 2026 `socialMedia`
// must be answered before any new version or notarization is accepted.

const ageRatingDeclarationIdArg = z
  .string()
  .min(1)
  .describe(
    "The ageRatingDeclaration id (from app_store_connect_get_age_rating_declaration). " +
      "This is NOT the appInfo id.",
  );

/** Apple grades most content questions on the same three-or-five-value scale. */
const frequency = (what: string) =>
  z
    .enum(["NONE", "INFREQUENT_OR_MILD", "FREQUENT_OR_INTENSE", "INFREQUENT", "FREQUENT"])
    .optional()
    .describe(`How often the app contains ${what}.`);

const flag = (what: string) => z.boolean().optional().describe(what);

export const registerAppInfoTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_app_infos",
    {
      description:
        "List an app's appInfo records, which hold the version-independent listing: name, " +
        "subtitle, privacy policy, categories and age rating. An app usually has two — the live " +
        "one (READY_FOR_SALE) and the editable one — so check `appStoreState` before updating.",
      inputSchema: { appId: appIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/appInfos`,
            compact({ limit, include: "primaryCategory,secondaryCategory" }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_app_info_localizations",
    {
      description:
        "List the per-locale name, subtitle and privacy policy for one appInfo. Returns the " +
        "localization ids you update.",
      inputSchema: { appInfoId: appInfoIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appInfoId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/appInfos/${appInfoId}/appInfoLocalizations`, compact({ limit })),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_app_info_localization",
    {
      description: "Get one locale's name, subtitle and privacy policy fields.",
      inputSchema: { localizationId: appInfoLocalizationIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ localizationId }) =>
      wrap(async () =>
        summarizeResponse(await client.get(`/v1/appInfoLocalizations/${localizationId}`)),
      ),
  );

  server.registerTool(
    "app_store_connect_get_age_rating_declaration",
    {
      description:
        "Read an app's age rating questionnaire answers — the content declarations behind the " +
        "rating, including `socialMedia`, `userGeneratedContent` and `messagingAndChat`. Returns " +
        "the declaration id that app_store_connect_update_age_rating_declaration takes. Note the " +
        "declaration is version-independent: there is one per appInfo, not one per release.",
      inputSchema: { appInfoId: appInfoIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appInfoId }) =>
      wrap(async () =>
        summarizeResponse(await client.get(`/v1/appInfos/${appInfoId}/ageRatingDeclaration`)),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_update_age_rating_declaration",
    {
      description:
        "Answer the age rating questionnaire. Only the fields you pass are changed, so a single " +
        "unanswered question can be filled in without restating the rest. Apple recomputes the " +
        "public rating from these answers, so a wrong value can change the app's rating or its " +
        "availability in a territory. From September 2026 `socialMedia` must be answered before " +
        "Apple accepts a new version, an update, or a notarization request.",
      inputSchema: {
        declarationId: ageRatingDeclarationIdArg,

        // Time Allowance / social — the September 2026 requirement.
        socialMedia: flag(
          "Whether the app can redistribute, amplify or interact with user-generated content " +
            "through a social feed or similar discovery method. Required from September 2026.",
        ),
        socialMediaAgeRestricted: flag(
          "Whether the app's social media features are age restricted.",
        ),
        userGeneratedContent: flag("Whether the app displays user-generated content."),
        messagingAndChat: flag("Whether the app offers messaging or chat."),
        ageAssurance: flag("Whether the app performs age assurance."),
        parentalControls: flag("Whether the app offers parental controls."),
        unrestrictedWebAccess: flag("Whether the app offers unrestricted web access."),
        advertising: flag("Whether the app contains advertising."),

        // Content questions.
        alcoholTobaccoOrDrugUseOrReferences: frequency(
          "alcohol, tobacco or drug use or references",
        ),
        contests: frequency("contests"),
        gambling: flag("Whether the app contains real gambling."),
        gamblingSimulated: frequency("simulated gambling"),
        lootBox: flag("Whether the app contains loot boxes."),
        gunsOrOtherWeapons: frequency("guns or other weapons"),
        healthOrWellnessTopics: flag("Whether the app covers health or wellness topics."),
        medicalOrTreatmentInformation: frequency("medical or treatment information"),
        profanityOrCrudeHumor: frequency("profanity or crude humor"),
        sexualContentOrNudity: frequency("sexual content or nudity"),
        sexualContentGraphicAndNudity: frequency("graphic sexual content and nudity"),
        horrorOrFearThemes: frequency("horror or fear themes"),
        matureOrSuggestiveThemes: frequency("mature or suggestive themes"),
        violenceCartoonOrFantasy: frequency("cartoon or fantasy violence"),
        violenceRealistic: frequency("realistic violence"),
        violenceRealisticProlongedGraphicOrSadistic: frequency(
          "prolonged, graphic or sadistic realistic violence",
        ),

        // Overrides and kids-category banding.
        kidsAgeBand: z
          .enum(["FIVE_AND_UNDER", "SIX_TO_EIGHT", "NINE_TO_ELEVEN"])
          .nullable()
          .optional()
          .describe("Kids Category age band. Pass null to take the app out of the Kids Category."),
        ageRatingOverride: z
          .enum(["NONE", "NINE_PLUS", "THIRTEEN_PLUS", "SIXTEEN_PLUS", "SEVENTEEN_PLUS", "UNRATED"])
          .optional()
          .describe("Raise the computed rating. NONE leaves Apple's computed rating in place."),
        ageRatingOverrideV2: z
          .enum(["NONE", "NINE_PLUS", "THIRTEEN_PLUS", "SIXTEEN_PLUS", "EIGHTEEN_PLUS", "UNRATED"])
          .optional()
          .describe("Current-generation rating override, which uses 18+ in place of 17+."),
        koreaAgeRatingOverride: z
          .enum(["NONE", "FIFTEEN_PLUS", "NINETEEN_PLUS"])
          .optional()
          .describe("Korea-specific rating override."),
        developerAgeRatingInfoUrl: z
          .string()
          .optional()
          .describe("URL explaining the developer's own age rating information."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ declarationId, ...attributes }) =>
      wrap(async () =>
        summarizeResponse(
          await client.patch(`/v1/ageRatingDeclarations/${declarationId}`, {
            data: {
              type: "ageRatingDeclarations",
              id: declarationId,
              attributes: compact(attributes),
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_update_app_info_localization",
    {
      description:
        "Update the version-independent listing fields for one locale: app name (30 chars), " +
        "subtitle (30 chars) and privacy policy. Only the fields you pass are changed. Apple " +
        "rejects a name change once the version is in review.",
      inputSchema: {
        localizationId: appInfoLocalizationIdArg,
        name: z.string().optional().describe("The app name as shown on the store (30-char limit)."),
        subtitle: z
          .string()
          .optional()
          .describe("Subtitle shown under the name; heavily indexed for search (30-char limit)."),
        privacyPolicyUrl: z.string().optional().describe("URL of the privacy policy."),
        privacyPolicyText: z
          .string()
          .optional()
          .describe("Privacy policy text (Apple TV apps only)."),
        privacyChoicesUrl: z
          .string()
          .optional()
          .describe("URL where users manage their privacy choices."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ localizationId, ...attributes }) =>
      wrap(async () =>
        summarizeResponse(
          await client.patch(`/v1/appInfoLocalizations/${localizationId}`, {
            data: {
              type: "appInfoLocalizations",
              id: localizationId,
              attributes: compact(attributes),
            },
          }),
        ),
      ),
  );
};
