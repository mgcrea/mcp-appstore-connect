import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { compact, limitArg, wrap } from "./util.js";

export const registerUserTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  _allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_users",
    {
      description:
        "List the team members on your App Store Connect account (username, name, roles, and " +
        "whether they can manage all apps or only some).",
      inputSchema: {
        username: z.string().optional().describe("Filter by username (Apple ID email)."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ username, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get("/v1/users", compact({ "filter[username]": username, limit })),
        ),
      ),
  );
};
