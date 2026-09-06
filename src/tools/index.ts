import type { McpServer } from "@modelcontextprotocol/server";

import type { AppStoreConnectClient } from "#/client/asc";
import type { Contact } from "#/config";
import { isConfigured, type Config } from "#/config";
import { registerAppInfoTools } from "#/tools/appinfos";
import { registerAppTools } from "#/tools/apps";
import { registerBuildTools } from "#/tools/builds";
import { registerBundleIdTools } from "#/tools/bundleids";
import { registerCategoryTools } from "#/tools/categories";
import { registerCertificateTools } from "#/tools/certificates";
import { registerCustomerReviewTools } from "#/tools/customerreviews";
import { registerDeviceTools } from "#/tools/devices";
import { registerIapTools } from "#/tools/iap";
import { registerListingTools } from "#/tools/listing";
import { registerPortfolioTools } from "#/tools/portfolio";
import { registerPricingTools } from "#/tools/pricing";
import { registerReportTools } from "#/tools/reports";
import { registerReviewDetailTools } from "#/tools/reviewdetails";
import { registerScreenshotTools } from "#/tools/screenshots";
import { registerStatusTool } from "#/tools/status";
import { registerSubmissionTools } from "#/tools/submissions";
import { registerTestflightTools } from "#/tools/testflight";
import { registerUserTools } from "#/tools/users";
import { registerVersionTools } from "#/tools/versions";

export type ToolContext = {
  config: Config;
  /** Register the mutating tools too. Off by default — see APP_STORE_CONNECT_ALLOW_WRITES. */
  allowWrites: boolean;
  /** Vendor number for sales/finance reports. Reports fail with a clear error when unset. */
  vendorNumber?: string | undefined;
  /** Which config layer supplied `vendorNumber`, reported by get_vendor_number. */
  vendorNumberSource?: "environment" | "file" | undefined;
  /**
   * Where this repo keeps its metadata tree, already normalized. Baked into the
   * listing tool descriptions at registration time, which is the only channel
   * that tells the caller where to write the files.
   */
  metadataRoot: string;
  /**
   * The configured App Review contact, used by set_app_store_review_detail to
   * fill contact fields the caller did not pass. Optional: with none configured
   * the tool behaves exactly as it did before.
   */
  contact?: Contact | undefined;
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
  // Registered first and unconditionally, so an unconfigured server is still a
  // useful one — it can say what to set — rather than a connection that closes.
  registerStatusTool(server, ctx.config);
  if (!isConfigured(ctx.config)) return;

  registerAppTools(server, client, allowWrites);
  registerVersionTools(server, client, allowWrites);
  // Registered next to the version tools, because the question it answers —
  // which binary each app ships today — is the one people reach for
  // list_versions and list_builds to answer, and get wrong.
  registerPortfolioTools(server, client, allowWrites);
  registerSubmissionTools(server, client, allowWrites);
  registerAppInfoTools(server, client, allowWrites);
  // Gates a first submission trips over, none of them version-scoped: category,
  // content rights (on registerAppTools), price, and the review contact. The
  // fifth — App Privacy — has no public API at all and is deliberately absent;
  // see the README before trying to add it back.
  registerCategoryTools(server, client, allowWrites);
  registerPricingTools(server, client, allowWrites);
  registerReviewDetailTools(server, client, ctx);
  registerIapTools(server, client, allowWrites);
  registerListingTools(server, client, ctx);
  registerScreenshotTools(server, client, allowWrites);
  registerBuildTools(server, client, allowWrites);
  registerTestflightTools(server, client, allowWrites);
  registerReportTools(server, client, ctx);
  registerCustomerReviewTools(server, client, allowWrites);
  registerUserTools(server, client, allowWrites);
  registerBundleIdTools(server, client, allowWrites);
  registerDeviceTools(server, client, allowWrites);
  registerCertificateTools(server, client, allowWrites);
};
