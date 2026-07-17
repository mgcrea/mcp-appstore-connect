import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { appIdArg, compact, limitArg, wrap } from "./util.js";

export const registerBuildTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  _allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_builds",
    {
      description:
        "List builds uploaded for an app (version, upload date, processing state, expiry). Filter " +
        "by version string or processing state to find e.g. the latest VALID build for TestFlight.",
      inputSchema: {
        appId: appIdArg,
        version: z
          .string()
          .optional()
          .describe("Filter by the build's version (the CFBundleVersion / build number)."),
        processingState: z
          .enum(["PROCESSING", "FAILED", "INVALID", "VALID"])
          .optional()
          .describe("Filter by processing state. VALID builds are ready to use."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, version, processingState, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            "/v1/builds",
            compact({
              "filter[app]": appId,
              "filter[version]": version,
              "filter[processingState]": processingState,
              limit,
            }),
          ),
        ),
      ),
  );
};
