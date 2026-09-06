import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { summarizeResponse } from "#/client/shape";
import { compact, limitArg, savePathArg, wrapSaved } from "#/tools/util";

export const registerUserTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  _allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_users",
    {
      title: "App Store Connect: List Users",
      description:
        "List the team members on your App Store Connect account (username, name, roles, and " +
        "whether they can manage all apps or only some).",
      inputSchema: z.object({
        username: z.string().optional().describe("Filter by username (Apple ID email)."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ username, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get("/v1/users", compact({ "filter[username]": username, limit })),
        ),
      ),
  );
};
