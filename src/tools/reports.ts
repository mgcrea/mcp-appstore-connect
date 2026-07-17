import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import type { ToolContext } from "./index.js";
import { appIdArg, compact, limitArg, wrap } from "./util.js";

const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;

const SALES_REPORT_TYPES = [
  "SALES",
  "PRE_ORDER",
  "SUBSCRIPTION",
  "SUBSCRIPTION_EVENT",
  "SUBSCRIBER",
  "NEWSSTAND",
  "INSTALLS",
  "FIRST_ANNUAL",
] as const;

/** Trim a downloaded TSV report so a huge one doesn't blow the context window. */
const previewReport = (tsv: string, maxLines: number): unknown => {
  const lines = tsv.split("\n");
  const truncated = lines.length > maxLines;
  return {
    rows: lines.length,
    truncated,
    ...(truncated ? { note: `Showing first ${maxLines} of ${lines.length} lines.` } : {}),
    report: (truncated ? lines.slice(0, maxLines) : lines).join("\n"),
  };
};

const requireVendor = (arg: string | undefined, ctxVendor: string | undefined): string => {
  const vendor = arg ?? ctxVendor;
  if (!vendor) {
    throw new Error(
      "A vendor number is required for reports. Set APP_STORE_CONNECT_VENDOR_NUMBER " +
        "(Payments and Financial Reports in App Store Connect) or pass `vendorNumber`.",
    );
  }
  return vendor;
};

export const registerReportTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "app_store_connect_download_sales_report",
    {
      description:
        "Download a sales & trends report (units, proceeds) as TSV. Reports lag ~24h and are " +
        "keyed by date: DAILY needs YYYY-MM-DD, WEEKLY the week-ending Sunday, MONTHLY YYYY-MM, " +
        "YEARLY YYYY. Requires a vendor number.",
      inputSchema: {
        reportDate: z
          .string()
          .min(1)
          .describe("Report date: YYYY-MM-DD (daily/weekly), YYYY-MM (monthly), or YYYY (yearly)."),
        frequency: z.enum(FREQUENCIES).default("MONTHLY"),
        reportType: z.enum(SALES_REPORT_TYPES).default("SALES"),
        reportSubType: z
          .enum(["SUMMARY", "DETAILED", "SUMMARY_INSTALL_TYPE", "SUMMARY_TERRITORY"])
          .default("SUMMARY"),
        vendorNumber: z
          .string()
          .optional()
          .describe("Override APP_STORE_CONNECT_VENDOR_NUMBER for this call."),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe("Truncate the TSV to this many lines. Defaults to 500."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ reportDate, frequency, reportType, reportSubType, vendorNumber, maxLines }) =>
      wrap(async () => {
        const vendor = requireVendor(vendorNumber, ctx.vendorNumber);
        const tsv = await client.downloadReport("/v1/salesReports", {
          "filter[frequency]": frequency,
          "filter[reportType]": reportType,
          "filter[reportSubType]": reportSubType,
          "filter[vendorNumber]": vendor,
          "filter[reportDate]": reportDate,
        });
        return previewReport(tsv, maxLines);
      }),
  );

  server.registerTool(
    "app_store_connect_download_finance_report",
    {
      description:
        "Download a financial report (proceeds by region) as TSV for one fiscal month and region. " +
        "Requires a vendor number.",
      inputSchema: {
        reportDate: z.string().min(1).describe("Fiscal period as YYYY-MM."),
        regionCode: z
          .string()
          .min(1)
          .describe('Financial region code, e.g. "ZZ" for all regions, "US", "EU", "JP".'),
        vendorNumber: z
          .string()
          .optional()
          .describe("Override APP_STORE_CONNECT_VENDOR_NUMBER for this call."),
        maxLines: z.number().int().min(1).max(5000).default(500),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ reportDate, regionCode, vendorNumber, maxLines }) =>
      wrap(async () => {
        const vendor = requireVendor(vendorNumber, ctx.vendorNumber);
        const tsv = await client.downloadReport("/v1/financeReports", {
          "filter[regionCode]": regionCode,
          "filter[reportType]": "FINANCIAL",
          "filter[vendorNumber]": vendor,
          "filter[reportDate]": reportDate,
        });
        return previewReport(tsv, maxLines);
      }),
  );

  server.registerTool(
    "app_store_connect_list_analytics_reports",
    {
      description:
        "List the analytics reports produced for an analytics report request. First create a " +
        "request with app_store_connect_create_analytics_report_request (or reuse an existing " +
        "request id), then list its reports and their download segments.",
      inputSchema: {
        reportRequestId: z
          .string()
          .min(1)
          .describe("The analyticsReportRequest id whose reports to list."),
        category: z
          .string()
          .optional()
          .describe('Filter by report category, e.g. "APP_USAGE", "APP_STORE_ENGAGEMENT".'),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ reportRequestId, category, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/analyticsReportRequests/${reportRequestId}/reports`,
            compact({ "filter[category]": category, limit }),
          ),
        ),
      ),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "app_store_connect_create_analytics_report_request",
    {
      description:
        "Request analytics reports for an app. Apple then generates the reports asynchronously; " +
        "list them with app_store_connect_list_analytics_reports once ready. ONE_TIME_SNAPSHOT " +
        "covers the last ~52 weeks; ONGOING keeps producing them.",
      inputSchema: {
        appId: appIdArg,
        accessType: z.enum(["ONE_TIME_SNAPSHOT", "ONGOING"]).default("ONGOING"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ appId, accessType }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/analyticsReportRequests", {
            data: {
              type: "analyticsReportRequests",
              attributes: { accessType },
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          }),
        ),
      ),
  );
};
