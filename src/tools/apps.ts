import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { summarizeResponse } from "#/client/shape";
import { liveVersionsOf } from "#/tools/portfolio";
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
        "Returns each app's id (used by the version/build/testflight tools), name and bundleId. " +
        "It does NOT say which version or binary each app currently ships — Apple cannot sideload " +
        "a build onto this response at all. Use app_store_connect_list_live_versions for that.",
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
      description:
        "Get one app's full attributes by its App Store Connect id. Pass includeLiveVersion to " +
        "also resolve the version customers can download right now and the binary it ships " +
        "(minOsVersion, build number, uploadedDate) — the app record alone says nothing about " +
        "either. For every app at once, use app_store_connect_list_live_versions.",
      inputSchema: z.object({
        appId: appIdArg,
        includeLiveVersion: z
          .boolean()
          .default(false)
          .describe(
            "Also return `live`: the READY_FOR_SALE version(s) and the build attached to each. " +
              "Costs one extra request. Universal apps ship IOS and MAC_OS separately, so it is " +
              "an array; `[]` means nothing is live.",
          ),
        fields: fieldsArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, includeLiveVersion, fields, savePath }) =>
      wrapSaved(savePath, async () => {
        const app = summarizeResponse(
          await client.get(`/v1/apps/${appId}`, compact({ "fields[apps]": fields })),
        );
        if (!includeLiveVersion) return app;
        // Through the rollup's own helper, so a single app and the portfolio
        // cannot disagree about what "the live build" means.
        return { ...(app as Record<string, unknown>), live: await liveVersionsOf(client, appId) };
      }),
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
