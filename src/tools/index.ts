import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppStoreConnectClient } from "../client/asc.js";
import { registerAppInfoTools } from "./appinfos.js";
import { registerAppTools } from "./apps.js";
import { registerBuildTools } from "./builds.js";
import { registerBundleIdTools } from "./bundleids.js";
import { registerDeviceTools } from "./devices.js";
import { registerListingTools } from "./listing.js";
import { registerReportTools } from "./reports.js";
import { registerScreenshotTools } from "./screenshots.js";
import { registerTestflightTools } from "./testflight.js";
import { registerUserTools } from "./users.js";
import { registerVersionTools } from "./versions.js";

export type ToolContext = {
  /** Register the mutating tools too. Off by default — see APP_STORE_CONNECT_ALLOW_WRITES. */
  allowWrites: boolean;
  /** Vendor number for sales/finance reports. Reports fail with a clear error when unset. */
  vendorNumber?: string | undefined;
  /**
   * Where this repo keeps its metadata tree, already normalized. Baked into the
   * listing tool descriptions at registration time, which is the only channel
   * that tells the caller where to write the files.
   */
  metadataRoot: string;
};

/**
 * Register the App Store Connect tools. Read tools are always registered; write
 * tools are only registered when `allowWrites` is set, so with the flag off they
 * are not merely refused — they are invisible, and cannot be called at all.
 */
export const registerTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  ctx: ToolContext,
): void => {
  const { allowWrites } = ctx;
  registerAppTools(server, client, allowWrites);
  registerVersionTools(server, client, allowWrites);
  registerAppInfoTools(server, client, allowWrites);
  registerListingTools(server, client, ctx);
  registerScreenshotTools(server, client, allowWrites);
  registerBuildTools(server, client, allowWrites);
  registerTestflightTools(server, client, allowWrites);
  registerReportTools(server, client, ctx);
  registerUserTools(server, client, allowWrites);
  registerBundleIdTools(server, client, allowWrites);
  registerDeviceTools(server, client, allowWrites);
};
