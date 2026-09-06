import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import {
  appIdsArg,
  compact,
  limitArg,
  savePathArg,
  summarizeWithApp,
  wrapSaved,
} from "#/tools/util";

export const registerBuildTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  _allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_builds",
    {
      title: "App Store Connect: List Builds",
      description:
        "List builds uploaded for an app (version, upload date, processing state, expiry, " +
        "minOsVersion). Filter by version string or processing state to find e.g. the latest " +
        "VALID build to distribute on TestFlight. **VALID means Apple finished processing the " +
        "binary — it does not mean the build is on the App Store.** The newest VALID build is " +
        "normally a TestFlight or in-review binary, so reading a shipping requirement off it " +
        "(minOsVersion, deployment target) gives an answer that is wrong in the direction that " +
        "looks right. The binary customers actually have is the one ATTACHED to the " +
        "READY_FOR_SALE version, often several builds older: resolve it with " +
        "app_store_connect_get_version. `appId` also accepts an ARRAY of ids, read in a single " +
        "request — but Apple applies `limit` across all of them at once, so a full page may be " +
        "one chatty app's builds and none of another's; the response says so when that can bite.",
      inputSchema: z.object({
        appId: appIdsArg,
        version: z
          .string()
          .optional()
          .describe("Filter by the build's version (the CFBundleVersion / build number)."),
        processingState: z
          .enum(["PROCESSING", "FAILED", "INVALID", "VALID"])
          .optional()
          .describe("Filter by processing state. VALID builds are ready to use."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, version, processingState, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeWithApp(
          await client.get(
            "/v1/builds",
            compact({
              "filter[app]": appId,
              "filter[version]": version,
              "filter[processingState]": processingState,
              limit,
            }),
          ),
          limit,
          appId,
        ),
      ),
  );
};
