import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { AppStoreConnectApiError } from "#/client/errors";
import { attributesOf, includedIndex, type Rec, resourcesOf } from "#/client/shape";
import { compact, PLATFORMS, savePathArg, wrapSaved } from "#/tools/util";
import { versionWithBuild, type VersionWithBuild } from "#/tools/versionshape";

/** The one state that means customers can download it right now. */
const LIVE_STATE = "READY_FOR_SALE";

/**
 * Everything between "started" and "live". Ordered roughly by how far along it
 * is, so the array reads as a pipeline. `filter[appStoreState]` is an array
 * parameter, so asking for these costs no extra request — they ride the same one
 * as the live state.
 */
const IN_FLIGHT_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "METADATA_REJECTED",
  "REJECTED",
  "INVALID_BINARY",
  "READY_FOR_REVIEW",
  "WAITING_FOR_EXPORT_COMPLIANCE",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "PROCESSING_FOR_APP_STORE",
  "ACCEPTED",
  "PENDING_APPLE_RELEASE",
  "PENDING_DEVELOPER_RELEASE",
] as const;

/**
 * How many per-app reads to have in flight at once.
 *
 * Politeness rather than a limit: Apple allows on the order of 3600 requests an
 * hour per key, so even a 200-app account is comfortably inside it, and 429s are
 * already retried with `Retry-After`.
 */
const CONCURRENCY = 8;

/**
 * Compare version strings numerically, segment by segment.
 *
 * A lexical sort puts "1.10.0" before "1.9.0". Only reachable when Apple returns
 * two versions in the same state for one platform, which should not happen — but
 * "should not happen" resolved arbitrarily is how a portfolio report acquires a
 * wrong number that nobody can reproduce.
 */
const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
};

/** Run `fn` over every item, at most `CONCURRENCY` at a time, settling each. */
const mapSettled = async <T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> => {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    results.push(...(await Promise.allSettled(items.slice(i, i + CONCURRENCY).map(fn))));
  }
  return results;
};

/** Newest first by version number, so index 0 is the shipping one. */
const newestFirst = (versions: VersionWithBuild[]): VersionWithBuild[] =>
  [...versions].sort((a, b) =>
    compareVersions(String(b.versionString ?? "0"), String(a.versionString ?? "0")),
  );

/**
 * The one version per platform that customers actually get.
 *
 * Apple does NOT move a superseded version out of READY_FOR_SALE — every version
 * an app has ever shipped keeps that state forever. Filtering on it therefore
 * returns the app's whole release history, newest and oldest alike, all looking
 * equally current: one real account answered this filter with eleven versions
 * for a single Mac app. Anything that reads a shipping requirement off that list
 * without picking per platform gets a plausible number from an arbitrary old
 * binary, which is precisely the failure this tool exists to prevent.
 *
 * Per platform, not overall, because a universal app genuinely ships an IOS and
 * a MAC_OS version at once.
 */
const currentPerPlatform = (versions: VersionWithBuild[]): VersionWithBuild[] => {
  const byPlatform = new Map<string, VersionWithBuild>();
  for (const version of newestFirst(versions)) {
    const platform = String(version.platform ?? "UNKNOWN");
    if (!byPlatform.has(platform)) byPlatform.set(platform, version);
  }
  return [...byPlatform.values()].sort((a, b) =>
    String(a.platform ?? "").localeCompare(String(b.platform ?? "")),
  );
};

/**
 * The versions of one app in the given states, each with its own build.
 *
 * Shared with `get_app`'s `includeLiveVersion`, so the two cannot disagree about
 * what "the live build" means.
 */
export const versionsOfApp = async (
  client: AppStoreConnectClient,
  appId: string,
  states: string[],
  platform?: string,
): Promise<VersionWithBuild[]> => {
  const response = await client.get(
    `/v1/apps/${appId}/appStoreVersions`,
    compact({
      "filter[appStoreState]": states,
      "filter[platform]": platform,
      include: "build",
      limit: 200,
    }),
  );
  const builds = includedIndex(response, "builds");
  // `fields[builds]` is deliberately not restricted. minOsVersion is not the
  // whole story — computedMinMacOsVersion and lsMinimumSystemVersion are the
  // meaningful floor for a Mac binary, and pinning a field list would answer the
  // macOS case wrong, which is this tool's own bug class.
  return resourcesOf(response).map((version) => versionWithBuild(version, builds));
};

/** Newest-first live versions of one app, the block `get_app` also returns. */
export const liveVersionsOf = async (
  client: AppStoreConnectClient,
  appId: string,
): Promise<VersionWithBuild[]> => newestFirst(await versionsOfApp(client, appId, [LIVE_STATE]));

type AppRow = {
  appId: unknown;
  name: unknown;
  bundleId: unknown;
  live: VersionWithBuild[];
  supersededVersions?: number;
  inFlight?: VersionWithBuild[];
};

export const registerPortfolioTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  _allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_live_versions",
    {
      title: "App Store Connect: List Live Versions (What Each App Ships Today)",
      description:
        "For every app on the account (or a subset), the version customers can download RIGHT NOW " +
        "and the exact binary it ships — build number, minOsVersion, uploadedDate. This is the " +
        'answer to "what does our listing require today?" and "which OS floor is live across the ' +
        'portfolio", in one call instead of list_versions then get_version for each app. ' +
        "The live build is the one ATTACHED to the READY_FOR_SALE version; it is often several " +
        "builds old, and it is NOT the newest VALID build in app_store_connect_list_builds — " +
        "that one is usually a TestFlight or in-review binary. Universal apps ship IOS and MAC_OS " +
        "separately, so `live` is an array. An app whose read failed is reported in `errors` " +
        "rather than dropped, and an app with nothing live keeps its row with `live: []`.",
      inputSchema: z.object({
        appIds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "App Store Connect app ids (the `id` from list_apps). Omit for every app on the " +
              "account.",
          ),
        bundleIds: z
          .array(z.string().min(1))
          .optional()
          .describe('Select apps by bundle id instead, e.g. ["com.acme.app"].'),
        platform: z
          .enum(PLATFORMS)
          .optional()
          .describe("Restrict to one platform. Omit to report every platform each app ships."),
        includeInFlight: z
          .boolean()
          .default(false)
          .describe(
            "Also report the version in the pipeline (PREPARE_FOR_SUBMISSION through " +
              "PENDING_DEVELOPER_RELEASE) and its build. Costs no extra requests.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(200)
          .describe("Maximum number of APPS to report (1-200). Not a cap on versions per app."),
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appIds, bundleIds, platform, includeInFlight, limit, savePath }) =>
      wrapSaved(savePath, async () => {
        const states: string[] = includeInFlight ? [LIVE_STATE, ...IN_FLIGHT_STATES] : [LIVE_STATE];

        const appsResponse = await client.get(
          "/v1/apps",
          compact({
            "filter[id]": appIds,
            "filter[bundleId]": bundleIds,
            limit,
          }),
        );
        const apps = resourcesOf(appsResponse);

        // One request per app. Apple's include depth is exactly 1 — no path in
        // its spec offers a dotted include — so `/v1/apps?include=appStoreVersions.build`
        // does not exist and the version+build pair cannot be collapsed further
        // without giving up the guarantee that each app's live version is the
        // one reported.
        const settled = await mapSettled(apps, (app) =>
          versionsOfApp(client, String(app.id), states, platform),
        );

        const rows: AppRow[] = [];
        const errors: Rec[] = [];

        apps.forEach((app, index) => {
          const attrs = attributesOf(app);
          const result = settled[index] as PromiseSettledResult<VersionWithBuild[]>;
          if (result.status === "rejected") {
            const err: unknown = result.reason;
            errors.push({
              appId: app.id,
              name: attrs.name,
              ...(err instanceof AppStoreConnectApiError ? { status: err.status } : {}),
              message: err instanceof Error ? err.message : String(err),
            });
            return;
          }
          const versions = result.value;
          const shipped = versions.filter((v) => v.appStoreState === LIVE_STATE);
          const live = currentPerPlatform(shipped);
          rows.push({
            appId: app.id,
            name: attrs.name,
            bundleId: attrs.bundleId,
            live,
            // Counted rather than dropped, so the difference between "one
            // version" and "the newest of eleven" is visible.
            ...(shipped.length > live.length
              ? { supersededVersions: shipped.length - live.length }
              : {}),
            ...(includeInFlight
              ? { inFlight: newestFirst(versions.filter((v) => v.appStoreState !== LIVE_STATE)) }
              : {}),
          });
        });

        // One app failing is data about that app. Every app failing is the tool
        // failing — a credentials or connectivity problem — and reporting it as
        // an empty portfolio would read as "you ship nothing".
        if (apps.length > 0 && errors.length === apps.length) {
          throw new AppStoreConnectApiError(
            `Could not read versions for any of the ${apps.length} apps. This is a fault, not an ` +
              `empty portfolio. First failure: ${String(errors[0]?.message)}`,
            {
              status: typeof errors[0]?.status === "number" ? (errors[0].status as number) : 500,
              errors,
            },
          );
        }

        // Sorted by name so two runs of a portfolio report diff cleanly.
        rows.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

        const noLiveVersion = rows.filter((row) => row.live.length === 0).length;
        const superseded = rows.reduce((sum, row) => sum + (row.supersededVersions ?? 0), 0);
        const noBuild = rows.filter((row) => row.live.some((v) => v.build === null)).length;

        const notes: string[] = [];
        if (errors.length > 0) {
          // Named rather than merely counted: a summarizing model that sees 7
          // rows and no complaint reports 7 apps as the portfolio.
          notes.push(
            `${errors.length} of ${apps.length} apps could not be read (${errors
              .map((e) => String(e.name ?? e.appId))
              .join(", ")}) and are in \`errors\`, not in \`apps\`.`,
          );
        }
        if (noLiveVersion > 0) {
          notes.push(
            `${noLiveVersion} app(s) have no ${LIVE_STATE} version: either never shipped, or ` +
              `removed from sale. \`live: []\` is the row, not an omission.`,
          );
        }
        if (superseded > 0) {
          notes.push(
            `Apple leaves every version an app has ever shipped in ${LIVE_STATE}, so filtering on ` +
              `that state returns the whole release history — ${superseded} such older version(s) ` +
              `were set aside here. \`live\` holds only the newest per platform, which is what ` +
              `customers actually get.`,
          );
        }
        if (noBuild > 0) {
          notes.push(
            `${noBuild} app(s) have a live version with no build attached, so no minOsVersion ` +
              `is available for them — that is missing data, not an absent OS floor.`,
          );
        }

        return {
          apps: rows,
          ...(errors.length > 0 ? { errors } : {}),
          meta: {
            apps: rows.length,
            // 1 for the app list, plus one per app. Reported so the cost of a
            // portfolio read is visible rather than inferred.
            requests: 1 + apps.length,
            failed: errors.length,
            noLiveVersion,
          },
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
        };
      }),
  );
};
