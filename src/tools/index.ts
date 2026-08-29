import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppStoreConnectClient } from "../client/asc.js";
import type { Contact } from "../config.js";
import { registerAppInfoTools } from "./appinfos.js";
import { registerAppTools } from "./apps.js";
import { registerBuildTools } from "./builds.js";
import { registerBundleIdTools } from "./bundleids.js";
import { registerCategoryTools } from "./categories.js";
import { registerCertificateTools } from "./certificates.js";
import { registerCustomerReviewTools } from "./customerreviews.js";
import { registerDeviceTools } from "./devices.js";
import { registerIapTools } from "./iap.js";
import { registerListingTools } from "./listing.js";
import { registerPricingTools } from "./pricing.js";
import { registerReleaseDoctorTools } from "./releasedoctor.js";
import { registerReportTools } from "./reports.js";
import { registerReviewDetailTools } from "./reviewdetails.js";
import { registerScreenshotTools } from "./screenshots.js";
import { registerSubmissionTools } from "./submissions.js";
import { registerTestflightTools } from "./testflight.js";
import { registerUserTools } from "./users.js";
import { registerVersionTools } from "./versions.js";

export type ToolContext = {
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
  registerAppTools(server, client, allowWrites);
  registerVersionTools(server, client, allowWrites);
  registerSubmissionTools(server, client, allowWrites);
  registerReleaseDoctorTools(server, client);
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
