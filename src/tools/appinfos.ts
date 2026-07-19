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

  if (!allowWrites) return;

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
