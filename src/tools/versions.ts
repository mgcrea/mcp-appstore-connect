import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { appIdArg, compact, limitArg, wrap } from "./util.js";

const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;

const versionIdArg = z
  .string()
  .min(1)
  .describe("The appStoreVersion id (from app_store_connect_list_versions).");

const localizationIdArg = z
  .string()
  .min(1)
  .describe(
    "The appStoreVersionLocalization id (from app_store_connect_list_version_localizations).",
  );

export const registerVersionTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_versions",
    {
      description:
        "List an app's App Store versions (each versionString and its review state, e.g. " +
        "PREPARE_FOR_SUBMISSION, WAITING_FOR_REVIEW, READY_FOR_SALE).",
      inputSchema: {
        appId: appIdArg,
        platform: z.enum(PLATFORMS).optional().describe("Filter by platform."),
        appStoreState: z
          .string()
          .optional()
          .describe('Filter by review state, e.g. "READY_FOR_SALE".'),
        versionString: z.string().optional().describe('Filter to one version, e.g. "1.2.0".'),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, platform, appStoreState, versionString, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/appStoreVersions`,
            compact({
              "filter[platform]": platform,
              "filter[appStoreState]": appStoreState,
              "filter[versionString]": versionString,
              limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_version_localizations",
    {
      description:
        "List the per-locale metadata rows for one App Store version (each carries description, " +
        "keywords, what's-new, promotional text). Returns the localization ids you update.",
      inputSchema: { versionId: versionIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ versionId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
            compact({ limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_version_localization",
    {
      description:
        "Get one locale's full App Store metadata (description, keywords, what's-new, …).",
      inputSchema: { localizationId: localizationIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ localizationId }) =>
      wrap(async () =>
        summarizeResponse(await client.get(`/v1/appStoreVersionLocalizations/${localizationId}`)),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_version",
    {
      description:
        "Create a new App Store version for an app (e.g. start metadata for 1.3.0). The version " +
        "begins in PREPARE_FOR_SUBMISSION; attach a build and submit it separately.",
      inputSchema: {
        appId: appIdArg,
        versionString: z.string().min(1).describe('The new version number, e.g. "1.3.0".'),
        platform: z.enum(PLATFORMS).default("IOS").describe("Platform for the version."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ appId, versionString, platform }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/appStoreVersions", {
            data: {
              type: "appStoreVersions",
              attributes: { platform, versionString },
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_update_version_localization",
    {
      description:
        "Update the App Store metadata for one locale of a version: description, keywords, " +
        "what's-new (release notes), promotional text, marketing/support URLs. Only the fields " +
        "you pass are changed. Keywords are a single comma-separated string (100-char limit).",
      inputSchema: {
        localizationId: localizationIdArg,
        description: z
          .string()
          .optional()
          .describe("Full App Store description (4000-char limit)."),
        keywords: z
          .string()
          .optional()
          .describe('Comma-separated keywords, e.g. "todo,tasks,productivity" (100-char limit).'),
        whatsNew: z
          .string()
          .optional()
          .describe("Release notes for this version (4000-char limit). Shown as 'What's New'."),
        promotionalText: z
          .string()
          .optional()
          .describe("Promotional text, editable without a new build (170-char limit)."),
        marketingUrl: z.string().optional(),
        supportUrl: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ localizationId, ...attributes }) =>
      wrap(async () =>
        summarizeResponse(
          await client.patch(`/v1/appStoreVersionLocalizations/${localizationId}`, {
            data: {
              type: "appStoreVersionLocalizations",
              id: localizationId,
              attributes: compact(attributes),
            },
          }),
        ),
      ),
  );
};
