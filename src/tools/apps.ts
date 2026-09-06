import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { summarizeResponse } from "#/client/shape";
import { appIdArg, compact, fieldsArg, limitArg, savePathArg, wrap, wrapSaved } from "#/tools/util";

export const registerAppTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_apps",
    {
      title: "App Store Connect: List Apps",
      description:
        "List the apps on your App Store Connect account. Filter by bundle id, name, or SKU. " +
        "Returns each app's id (used by the version/build/testflight tools), name and bundleId.",
      inputSchema: z.object({
        bundleId: z
          .string()
          .optional()
          .describe('Filter to an exact bundle id, e.g. "com.acme.app".'),
        name: z.string().optional().describe("Filter by app name (exact match)."),
        sku: z.string().optional().describe("Filter by SKU."),
        limit: limitArg,
        fields: fieldsArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ bundleId, name, sku, limit, fields, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(
            "/v1/apps",
            compact({
              "filter[bundleId]": bundleId,
              "filter[name]": name,
              "filter[sku]": sku,
              limit,
              "fields[apps]": fields,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_app",
    {
      title: "App Store Connect: Get App",
      description: "Get one app's full attributes by its App Store Connect id.",
      inputSchema: z.object({ appId: appIdArg, fields: fieldsArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, fields, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(`/v1/apps/${appId}`, compact({ "fields[apps]": fields })),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_update_app",
    {
      title: "App Store Connect: Update App",
      description:
        "Update the app-level attributes that are not part of any one version. " +
        "`contentRightsDeclaration` is REQUIRED before a version can be submitted: Apple refuses " +
        "the submission with ENTITY_ERROR.ATTRIBUTE.REQUIRED against /v1/apps and names nothing " +
        "else. Answer it from what the shipped binary does — an app that downloads models, " +
        "fonts, or media it did not author uses third-party content, and declaring otherwise to " +
        "clear the gate is a false statement to Apple. Only the fields you pass are changed.",
      inputSchema: z.object({
        appId: appIdArg,
        contentRightsDeclaration: z
          .enum(["DOES_NOT_USE_THIRD_PARTY_CONTENT", "USES_THIRD_PARTY_CONTENT"])
          .optional()
          .describe(
            "Whether the app contains, shows or accesses third-party content. Choose " +
              "USES_THIRD_PARTY_CONTENT if it does, and be ready to show you have the rights.",
          ),
        primaryLocale: z
          .string()
          .optional()
          .describe(
            'The app\'s primary locale, e.g. "en-US". Rarely changed after the first release.',
          ),
        subscriptionStatusUrl: z
          .string()
          .optional()
          .describe("Server-to-server notification URL for subscription status changes."),
        subscriptionStatusUrlVersion: z
          .enum(["V1", "V2"])
          .optional()
          .describe("Payload version for the subscription status URL."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ appId, ...attributes }) =>
      wrap(async () =>
        summarizeResponse(
          await client.patch(`/v1/apps/${appId}`, {
            data: { type: "apps", id: appId, attributes: compact(attributes) },
          }),
        ),
      ),
  );
};
