import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { appIdArg, compact, fieldsArg, limitArg, wrap } from "./util.js";

export const registerAppTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  _allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_apps",
    {
      description:
        "List the apps on your App Store Connect account. Filter by bundle id, name, or SKU. " +
        "Returns each app's id (used by the version/build/testflight tools), name and bundleId.",
      inputSchema: {
        bundleId: z
          .string()
          .optional()
          .describe('Filter to an exact bundle id, e.g. "com.acme.app".'),
        name: z.string().optional().describe("Filter by app name (exact match)."),
        sku: z.string().optional().describe("Filter by SKU."),
        limit: limitArg,
        fields: fieldsArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ bundleId, name, sku, limit, fields }) =>
      wrap(async () =>
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
      description: "Get one app's full attributes by its App Store Connect id.",
      inputSchema: { appId: appIdArg, fields: fieldsArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, fields }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v1/apps/${appId}`, compact({ "fields[apps]": fields })),
        ),
      ),
  );
};
