import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import {
  type Rec,
  attributesOf,
  includedIndex,
  isRecord,
  relatedId,
  resourcesOf,
} from "#/client/shape";
import { appIdArg, compact, PLATFORMS, savePathArg, wrapSaved } from "#/tools/util";

/**
 * Apple-hosted asset packs (Background Assets), uploaded with
 * `altool --upload-asset-pack`. Each pack (`backgroundAssets`) has versions, and
 * a version reaches the App Store by riding inside the app's review submission
 * as a `backgroundAssetVersion` item, which App Store Connect API 4.5.1 accepts
 * on `ReviewSubmissionItemCreateRequest`.
 *
 * That is why this module exists. A cancelled submission drops those items,
 * and nothing re-adds them unless something knows the packs are there.
 */

/** A version that has finished processing. Anything else cannot be submitted yet. */
const PROCESSED_STATE = "COMPLETE";

/**
 * App Store release states (`backgroundAssetVersionAppStoreReleases.state`) a
 * version can be added to a review submission from. Kept deliberately narrow:
 * every other state is reported with a reason instead of being added.
 */
export const ADDABLE_RELEASE_STATES = ["PREPARE_FOR_SUBMISSION", "REJECTED"];

/** Why a version in this release state was not added, in the caller's terms. */
const NOT_ADDED_REASONS: Record<string, string> = {
  READY_FOR_REVIEW: "already staged on another un-submitted review submission",
  WAITING_FOR_REVIEW: "already with Apple on another review submission",
  IN_REVIEW: "already with Apple on another review submission",
  ACCEPTED:
    "Apple accepted it on an earlier submission. If that submission was cancelled and App " +
    "Store Connect's Add for Review panel still offers this pack, add it there",
  PROCESSING_FOR_DISTRIBUTION: "already released",
  READY_FOR_DISTRIBUTION: "already released",
  SUPERSEDED: "superseded by a newer version",
};

const versionsLimitArg = z
  .number()
  .int()
  .min(1)
  .max(50)
  .default(10)
  .describe("How many versions to read per pack, newest first (1-50). Defaults to 10.");

export type AssetPackVersion = {
  id: string;
  version: unknown;
  locale: unknown;
  /** Processing state: AWAITING_UPLOAD, PROCESSING, FAILED, COMPLETE. */
  state: unknown;
  platforms: unknown;
  createdDate: unknown;
  /** Where the version stands for the App Store: PREPARE_FOR_SUBMISSION … READY_FOR_DISTRIBUTION. */
  appStoreReleaseState?: unknown;
  internalBetaReleaseState?: unknown;
  externalBetaReleaseState?: unknown;
  errors?: unknown;
};

export type AssetPack = {
  id: string;
  assetPackIdentifier: unknown;
  archived: unknown;
  usedBytes: unknown;
  createdDate: unknown;
  versions: AssetPackVersion[];
  /** Set when the pack has more versions than were read. */
  moreVersions?: true;
};

const stateOf = (index: Map<string, Rec>, version: Rec, relationship: string): unknown => {
  const id = relatedId(version, relationship);
  return id === undefined ? undefined : attributesOf(index.get(id) ?? {}).state;
};

const summarizeVersion = (response: unknown, version: Rec): AssetPackVersion => {
  const attrs = attributesOf(version);
  const errors = isRecord(attrs.stateDetails) ? attrs.stateDetails.errors : undefined;
  return {
    id: String(version.id),
    version: attrs.version,
    locale: attrs.locale,
    state: attrs.state,
    platforms: attrs.platforms,
    createdDate: attrs.createdDate,
    ...compact({
      appStoreReleaseState: stateOf(
        includedIndex(response, "backgroundAssetVersionAppStoreReleases"),
        version,
        "appStoreRelease",
      ),
      internalBetaReleaseState: stateOf(
        includedIndex(response, "backgroundAssetVersionInternalBetaReleases"),
        version,
        "internalBetaRelease",
      ),
      externalBetaReleaseState: stateOf(
        includedIndex(response, "backgroundAssetVersionExternalBetaReleases"),
        version,
        "externalBetaRelease",
      ),
      errors: Array.isArray(errors) && errors.length > 0 ? errors : undefined,
    }),
  };
};

/**
 * An app's asset packs with their newest versions, each carrying its App Store
 * release state. `1 + N` requests: the packs, then each pack's versions.
 */
export const readAssetPacks = async (
  client: AppStoreConnectClient,
  appId: string,
  {
    platform,
    includeArchived = false,
    versionsLimit = 10,
  }: { platform?: string | undefined; includeArchived?: boolean; versionsLimit?: number } = {},
): Promise<{ packs: AssetPack[]; morePacks: boolean }> => {
  const packsResponse = await client.get(
    `/v1/apps/${appId}/backgroundAssets`,
    compact({
      "filter[archived]": includeArchived ? undefined : "false",
      "filter[versions.platforms]": platform,
      sort: "assetPackIdentifier",
      limit: 200,
    }),
  );
  const morePacks = hasNext(packsResponse);

  const packs = await Promise.all(
    resourcesOf(packsResponse).map(async (pack): Promise<AssetPack> => {
      const versionsResponse = await client.get(
        `/v1/backgroundAssets/${String(pack.id)}/versions`,
        compact({
          "filter[platforms]": platform,
          include: "appStoreRelease,internalBetaRelease,externalBetaRelease",
          sort: "-version",
          limit: versionsLimit,
        }),
      );
      const attrs = attributesOf(pack);
      return {
        id: String(pack.id),
        assetPackIdentifier: attrs.assetPackIdentifier,
        archived: attrs.archived,
        usedBytes: attrs.usedBytes,
        createdDate: attrs.createdDate,
        versions: resourcesOf(versionsResponse).map((v) => summarizeVersion(versionsResponse, v)),
        ...(hasNext(versionsResponse) ? { moreVersions: true as const } : {}),
      };
    }),
  );
  return { packs, morePacks };
};

const hasNext = (response: unknown): boolean =>
  isRecord(response) && isRecord(response.links) && typeof response.links.next === "string";

/** What submit_version_for_review did, or would do, with one pack. */
export type AssetPackPlan = {
  backgroundAssetId: string;
  assetPackIdentifier: unknown;
  versionId?: string;
  version?: unknown;
  locale?: unknown;
  state?: unknown;
  appStoreReleaseState?: unknown;
  action: "add" | "alreadyOnSubmission" | "notAdded";
  reason?: string;
};

/**
 * One plan per pack and locale, from the newest version for this platform.
 * Only the newest is considered: submitting an older version beside a newer one
 * is never what a release means, and a newer one that is not addable is
 * reported rather than worked around.
 */
export const planAssetPacks = (packs: AssetPack[], onSubmission: Set<string>): AssetPackPlan[] =>
  packs.flatMap((pack) => {
    const newestByLocale = new Map<string, AssetPackVersion>();
    for (const version of pack.versions) {
      const key = String(version.locale ?? "");
      if (!newestByLocale.has(key)) newestByLocale.set(key, version);
    }
    const base = { backgroundAssetId: pack.id, assetPackIdentifier: pack.assetPackIdentifier };
    if (newestByLocale.size === 0) {
      return [{ ...base, action: "notAdded", reason: "no version for this platform" } as const];
    }
    return [...newestByLocale.values()].map((version): AssetPackPlan => {
      const release = version.appStoreReleaseState;
      const row = {
        ...base,
        versionId: version.id,
        version: version.version,
        ...compact({ locale: version.locale }),
        state: version.state,
        appStoreReleaseState: release,
      };
      if (onSubmission.has(version.id)) return { ...row, action: "alreadyOnSubmission" };
      if (version.state !== PROCESSED_STATE) {
        return {
          ...row,
          action: "notAdded",
          reason: `the version is ${String(version.state)}, not ${PROCESSED_STATE}: Apple has not finished processing it`,
        };
      }
      if (typeof release === "string" && ADDABLE_RELEASE_STATES.includes(release)) {
        return { ...row, action: "add" };
      }
      return {
        ...row,
        action: "notAdded",
        reason:
          release === undefined
            ? "Apple returned no App Store release for this version"
            : (NOT_ADDED_REASONS[String(release)] ?? `its App Store release is ${String(release)}`),
      };
    });
  });

export const registerAssetPackTools = (server: McpServer, client: AppStoreConnectClient): void => {
  server.registerTool(
    "app_store_connect_list_asset_packs",
    {
      title: "App Store Connect: List Asset Packs",
      description:
        "List an app's Apple-hosted asset packs (Background Assets, uploaded with `altool " +
        "--upload-asset-pack`) and their newest versions. Each version carries its processing " +
        "`state` (AWAITING_UPLOAD, PROCESSING, FAILED, COMPLETE) and `appStoreReleaseState`, " +
        "which says where it stands for the App Store: PREPARE_FOR_SUBMISSION means it still " +
        "has to go to review inside the app's review submission. " +
        "A pack version reaches the App Store only as an item of the app's review submission, " +
        "and cancelling that submission removes it. app_store_connect_submit_version_for_review " +
        "adds the pending versions back by default. Check here after a cancel, or when " +
        "list_review_submissions shows a backgroundAssetVersion item you need to identify.",
      inputSchema: z.object({
        appId: appIdArg,
        platform: z
          .enum(PLATFORMS)
          .optional()
          .describe("Only packs, and versions, available on this platform."),
        includeArchived: z
          .boolean()
          .default(false)
          .describe("Include archived packs. Defaults to false."),
        versionsLimit: versionsLimitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, platform, includeArchived, versionsLimit, savePath }) =>
      wrapSaved(savePath, async () => {
        const { packs, morePacks } = await readAssetPacks(client, appId, {
          platform,
          includeArchived,
          versionsLimit,
        });
        return {
          appId,
          data: packs,
          ...(morePacks
            ? { note: "The app has more than 200 asset packs; only the first 200 are listed." }
            : {}),
        };
      }),
  );
};
