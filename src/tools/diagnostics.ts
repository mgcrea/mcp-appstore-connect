import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import {
  attributesOf,
  includedIndex,
  isRecord,
  type Rec,
  relatedId,
  resourcesOf,
  summarizeResource,
  summarizeResponse,
} from "#/client/shape";
import {
  appIdArg,
  compact,
  limitArg,
  PLATFORMS,
  PreconditionError,
  saveToPath,
  savePathArg,
  type SavedFile,
  wrap,
  wrapSaved,
} from "#/tools/util";

/** Every type `filter[diagnosticType]` accepts. There is no CRASHES. */
const DIAGNOSTIC_TYPES = ["HANGS", "DISK_WRITES", "LAUNCHES"] as const;

/** What the logs endpoint answers, per Apple's spec. Not application/json. */
const DIAGNOSTIC_LOGS_ACCEPT = "application/vnd.apple.diagnostic-logs+json";

/**
 * Said in both descriptions and on every empty result, because the failure it
 * prevents is silent: an agent asked "is it crashing?" lists signatures, gets
 * none, and reports "no crashes".
 */
const NO_CRASHES =
  "This API carries NO crashes: its only types are HANGS, DISK_WRITES and LAUNCHES (slow " +
  "launches). Crash reports for App Store builds are only in Xcode Organizer or Xcode's MCP " +
  "(GetTopCrashIssues / GetCrashIssueLogs); TestFlight crash reports are in " +
  'app_store_connect_list_beta_crash_reports; crash COUNTS over time are the "App Crashes" ' +
  "report in app_store_connect_get_analytics_report.";

const signatureIdArg = z
  .string()
  .min(1)
  .describe("The diagnosticSignature id (from app_store_connect_list_diagnostic_signatures).");

type ResolvedBuild = {
  buildId: string;
  versionString?: unknown;
  platform?: unknown;
  buildNumber?: unknown;
};

/**
 * The builds behind an App Store version string: the one ATTACHED to each
 * platform's version, which is the binary customers run. Diagnostics are per
 * build, and the newest build carrying that version number is usually a
 * TestFlight one that no customer has.
 */
const buildsForVersion = async (
  client: AppStoreConnectClient,
  appId: string,
  versionString: string,
  platform: string | undefined,
): Promise<ResolvedBuild[]> => {
  const response = await client.get(
    `/v1/apps/${appId}/appStoreVersions`,
    compact({
      "filter[versionString]": versionString,
      "filter[platform]": platform,
      include: "build",
    }),
  );
  const versions = resourcesOf(response);
  if (versions.length === 0) {
    throw new PreconditionError(
      `App ${appId} has no App Store version "${versionString}"` +
        (platform === undefined ? "" : ` on ${platform}`) +
        `. Check app_store_connect_list_versions, or pass a buildId instead.`,
      { appId, versionString, platform },
    );
  }
  const builds = includedIndex(response, "builds");
  const resolved = versions.flatMap((version): ResolvedBuild[] => {
    const buildId = relatedId(version, "build");
    if (buildId === undefined) return [];
    const attrs = attributesOf(version);
    return [
      {
        buildId,
        versionString: attrs.versionString,
        platform: attrs.platform,
        buildNumber: attributesOf(builds.get(buildId) ?? {}).version,
      },
    ];
  });
  if (resolved.length === 0) {
    throw new PreconditionError(
      `Version "${versionString}" has no build attached, so there is no binary to read ` +
        `diagnostics for. Pass a buildId from app_store_connect_list_builds (a TestFlight build ` +
        `works too).`,
      { appId, versionString, platform },
    );
  }
  return resolved;
};

/** Every frame Apple marked as the one to blame, depth-first, deduplicated. */
const blameFrames = (node: unknown, out: Set<string>): Set<string> => {
  if (Array.isArray(node)) {
    for (const child of node) blameFrames(child, out);
    return out;
  }
  if (!isRecord(node)) return out;
  if (node.isBlameFrame === true) {
    const frame = node.rawFrame ?? node.symbolName;
    if (typeof frame === "string") out.add(frame);
  }
  for (const value of Object.values(node)) {
    if (typeof value === "object" && value !== null) blameFrames(value, out);
  }
  return out;
};

/**
 * The inline part of a logs response: what each log is about and where Apple
 * points the finger, without the call-stack trees, which are what makes the
 * response large and are in the saved file.
 */
const summarizeLogs = (response: unknown): Rec => {
  const productData =
    isRecord(response) && Array.isArray(response.productData) ? response.productData : [];
  const insights: unknown[] = [];
  const logs: Rec[] = [];
  for (const product of productData) {
    if (!isRecord(product)) continue;
    if (Array.isArray(product.diagnosticInsights)) insights.push(...product.diagnosticInsights);
    for (const log of Array.isArray(product.diagnosticLogs) ? product.diagnosticLogs : []) {
      if (!isRecord(log)) continue;
      const frames = [...blameFrames(log.callStackTree, new Set())];
      logs.push({
        ...(isRecord(log.diagnosticMetaData) ? log.diagnosticMetaData : {}),
        ...(frames.length > 0 ? { blameFrames: frames.slice(0, 5) } : {}),
      });
    }
  }
  return { logCount: logs.length, insights, logs };
};

export const registerDiagnosticTools = (server: McpServer, client: AppStoreConnectClient): void => {
  server.registerTool(
    "app_store_connect_list_diagnostic_signatures",
    {
      title: "App Store Connect: List Diagnostic Signatures",
      description:
        "List the diagnostic signatures Apple aggregated for one build: clusters of HANGS, " +
        "DISK_WRITES or LAUNCHES (slow launches) reports from devices whose owners share " +
        "analytics, each with a `signature` (the top frame), a `weight` (0-1, this signature's " +
        "share of that build's reports of its type, not a count of users) and Apple's `insight` " +
        "(a TREND against earlier versions, when there is one). Pass a buildId, or an appId and " +
        "App Store versionString to read the build attached to that version (the one customers " +
        "run). Then fetch a signature's backtraces with app_store_connect_get_diagnostic_logs. " +
        `${NO_CRASHES} An empty list means Apple has not aggregated any signature of that type ` +
        "for this build yet (it needs enough opted-in devices and takes days), not that the " +
        "build is healthy.",
      inputSchema: z.object({
        buildId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The build id (from app_store_connect_list_builds). Or pass appId + versionString.",
          ),
        appId: appIdArg.optional(),
        versionString: z
          .string()
          .min(1)
          .optional()
          .describe('The App Store version, e.g. "1.3.0". Used with appId instead of buildId.'),
        platform: z
          .enum(PLATFORMS)
          .optional()
          .describe("With appId + versionString: only that platform's version. Omit for all."),
        diagnosticType: z
          .enum(DIAGNOSTIC_TYPES)
          .optional()
          .describe("Only this type. Omit for all three. There is no crash type."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ buildId, appId, versionString, platform, diagnosticType, limit, savePath }) =>
      wrapSaved(savePath, async () => {
        // A flat input schema cannot say "exactly one of", so say it here.
        if (buildId !== undefined && (appId !== undefined || versionString !== undefined)) {
          throw new PreconditionError("Pass either buildId, or appId + versionString, not both.", {
            buildId,
            appId,
            versionString,
          });
        }
        if (buildId === undefined && (appId === undefined || versionString === undefined)) {
          throw new PreconditionError(
            "Pass a buildId, or both appId and versionString to read the build attached to " +
              "that App Store version.",
            { appId, versionString },
          );
        }

        const builds: ResolvedBuild[] =
          buildId !== undefined
            ? [{ buildId }]
            : await buildsForVersion(client, appId as string, versionString as string, platform);

        const results = await Promise.all(
          builds.map(async (build) => {
            const response = await client.get(
              `/v1/builds/${build.buildId}/diagnosticSignatures`,
              compact({ "filter[diagnosticType]": diagnosticType, limit }),
            );
            const summary = summarizeResponse(response) as Rec;
            return {
              rows: resourcesOf(response).map((res) => ({
                ...(summarizeResource(res) as Rec),
                buildId: build.buildId,
              })),
              incomplete: summary.incomplete,
              build,
            };
          }),
        );

        const data = results.flatMap((result) => result.rows);
        const incomplete = results
          .filter((result) => result.incomplete !== undefined)
          .map((result) => ({ buildId: result.build.buildId, ...(result.incomplete as Rec) }));
        return {
          builds: builds.map((build) => compact(build)),
          data,
          ...(incomplete.length > 0 ? { incomplete } : {}),
          ...(data.length === 0
            ? {
                note:
                  `No ${diagnosticType ?? "HANGS, DISK_WRITES or LAUNCHES"} signature for ` +
                  `${builds.length === 1 ? "this build" : "these builds"}. That means Apple has ` +
                  `not aggregated one, not that the build is healthy. ${NO_CRASHES}`,
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_get_diagnostic_logs",
    {
      title: "App Store Connect: Get Diagnostic Logs",
      description:
        "Fetch the anonymized backtrace logs behind one diagnostic signature (a hang, disk-write " +
        "or slow-launch cluster) and SAVE them to `savePath`. The call-stack trees are large, so " +
        "they go to the file only; the response carries each log's metadata (app version, build, " +
        "OS, device, event detail), the frames Apple marked as the culprit (`blameFrames`) and " +
        "Apple's insights. Logs are a sample of the signature's reports, not all of them, and " +
        `come only from devices whose owners share analytics. ${NO_CRASHES}`,
      inputSchema: z.object({
        signatureId: signatureIdArg,
        savePath: z
          .string()
          .min(1)
          .describe(
            "Absolute path to write the full logs to, as pretty-printed JSON (Apple's " +
              "diagnostic-logs document, call stacks included). Required: the logs are not inlined.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(10)
          .describe("Maximum number of logs to fetch (1-200). Defaults to 10."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ signatureId, savePath, limit }) =>
      wrap(async () => {
        const response = await client.request(
          "GET",
          `/v1/diagnosticSignatures/${signatureId}/logs`,
          {
            query: { limit },
            accept: DIAGNOSTIC_LOGS_ACCEPT,
          },
        );
        const saved: SavedFile = {
          ...(await saveToPath(savePath, `${JSON.stringify(response, null, 2)}\n`, "logs")),
          content: "json",
        };
        return { signatureId, ...summarizeLogs(response), saved };
      }),
  );
};
