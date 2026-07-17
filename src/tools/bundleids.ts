import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { compact, confirmArg, limitArg, wrap } from "./util.js";

const BUNDLE_PLATFORMS = ["IOS", "MAC_OS", "UNIVERSAL"] as const;

const bundleIdArg = z
  .string()
  .min(1)
  .describe(
    "The bundle id RESOURCE id (from app_store_connect_list_bundle_ids), not the identifier string.",
  );

export const registerBundleIdTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_bundle_ids",
    {
      description:
        "List registered bundle ids (App IDs) on the developer account, with their identifier " +
        "string, name and platform. Returns the resource ids used to manage capabilities.",
      inputSchema: {
        identifier: z.string().optional().describe('Filter by identifier, e.g. "com.acme.app".'),
        platform: z.enum(BUNDLE_PLATFORMS).optional().describe("Filter by platform."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ identifier, platform, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            "/v1/bundleIds",
            compact({
              "filter[identifier]": identifier,
              "filter[platform]": platform,
              limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_bundle_id",
    {
      description: "Get one bundle id's attributes by its resource id.",
      inputSchema: { bundleId: bundleIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ bundleId }) =>
      wrap(async () => summarizeResponse(await client.get(`/v1/bundleIds/${bundleId}`))),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_bundle_id",
    {
      description:
        "Register a new bundle id (App ID) on the developer account. The identifier is permanent " +
        "and cannot be reused once created.",
      inputSchema: {
        identifier: z.string().min(1).describe('The bundle id, e.g. "com.acme.app".'),
        name: z.string().min(1).describe("A human-readable name for the App ID."),
        platform: z.enum(BUNDLE_PLATFORMS).default("UNIVERSAL"),
        seedId: z.string().optional().describe("Team seed id (App ID prefix). Usually inferred."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ identifier, name, platform, seedId }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/bundleIds", {
            data: {
              type: "bundleIds",
              attributes: compact({ identifier, name, platform, seedId }),
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_enable_capability",
    {
      description:
        "Enable a capability (App Service) on a bundle id, e.g. PUSH_NOTIFICATIONS, ICLOUD, " +
        "GAME_CENTER, ASSOCIATED_DOMAINS, APP_GROUPS.",
      inputSchema: {
        bundleId: bundleIdArg,
        capabilityType: z
          .string()
          .min(1)
          .describe('The capability type, e.g. "PUSH_NOTIFICATIONS", "ICLOUD", "APP_GROUPS".'),
        settings: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("Optional capability settings (JSON:API CapabilitySetting objects)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ bundleId, capabilityType, settings }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/bundleIdCapabilities", {
            data: {
              type: "bundleIdCapabilities",
              attributes: compact({ capabilityType, settings }),
              relationships: { bundleId: { data: { type: "bundleIds", id: bundleId } } },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_disable_capability",
    {
      description: "Disable a capability on a bundle id by its capability id.",
      inputSchema: {
        capabilityId: z
          .string()
          .min(1)
          .describe("The bundleIdCapability id (returned when the capability was enabled)."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ capabilityId }) =>
      wrap(async () => {
        await client.del(`/v1/bundleIdCapabilities/${capabilityId}`);
        return { disabled: capabilityId };
      }),
  );
};
