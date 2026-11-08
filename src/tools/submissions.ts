import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import {
  AppStoreConnectApiError,
  flattenAssociatedErrors,
  formatAssociatedError,
} from "#/client/errors";
import {
  type Rec,
  attributesOf,
  includedIndex,
  isRecord,
  relatedId,
  relatedIds,
  resourceOf,
  resourcesOf,
  summarizeResponse,
} from "#/client/shape";
import { fetchAsset, isProcessed, RESOURCE } from "#/tools/assetlibrary";
import {
  type AssetPack,
  type AssetPackPlan,
  planAssetPacks,
  readAssetPacks,
} from "#/tools/assetpacks";
import {
  appIdArg,
  appIdsArg,
  compact,
  confirmArg,
  dryRunArg,
  limitArg,
  multiAppLimitNote,
  PLATFORMS,
  PreconditionError,
  savePathArg,
  versionIdArg,
  wrap,
  wrapSaved,
} from "#/tools/util";

const SUBMISSION_STATES = [
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "UNRESOLVED_ISSUES",
  "CANCELING",
  "COMPLETING",
  "COMPLETE",
] as const;

/**
 * A submission Apple has not been handed yet: still a draft, so a version can be
 * added to it and it can be submitted. There is at most one per app+platform.
 */
const DRAFT_STATE = "READY_FOR_REVIEW";

/** States that mean this app already has a submission with Apple. */
const IN_FLIGHT_STATES = ["WAITING_FOR_REVIEW", "IN_REVIEW", "CANCELING", "COMPLETING"];

/**
 * Apple reviewed this submission and handed it back rejected. Deliberately *not*
 * an in-flight state: the submission is the developer's again, and the way back
 * into the queue is to resolve the rejected items and submit the same submission
 * a second time — which is what App Store Connect's "Update review" then
 * "Resubmit to App Review" buttons do.
 *
 * Cancelling one instead is the expensive mistake this constant exists to
 * prevent. A cancel cannot be undone, it surrenders the queue position, and it
 * drags every *other* item out with it — an in-app purchase that Apple had
 * already started reviewing alongside the rejected version goes back to the end
 * of the line with it.
 */
const RETURNED_STATE = "UNRESOLVED_ISSUES";

/** The per-item state that a resubmission has to clear before Apple accepts it. */
const REJECTED_ITEM_STATE = "REJECTED";

/**
 * A version that has already been added to a draft submission. Spelled the same as
 * `DRAFT_STATE` but read off the *version*, not the submission — Apple reuses the
 * word for both, and conflating them is how this state ends up looking submittable.
 */
const STAGED_VERSION_STATE = "READY_FOR_REVIEW";

/**
 * Version states Apple still accepts into a review submission. The rejected ones
 * are editable again after review, so resubmitting them is the normal path back.
 */
const SUBMITTABLE_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
];

const submissionIdArg = z
  .string()
  .min(1)
  .describe("The reviewSubmission id (from app_store_connect_list_review_submissions).");

/**
 * Everything a review submission item can carry, one to-one relationship per
 * kind. An item fills exactly one of them, so asking for all of them is what
 * says *what* each item is — the version, an in-app purchase, a subscription.
 *
 * All but `appStoreVersionExperiment`, the deprecated v1 experiment: Apple
 * answers 400 to an include naming both it and `appStoreVersionExperimentV2`
 * ("they reference different versions of the same type"), and that one refusal
 * took the whole submission list down with it. An item of that kind still
 * comes back, with its id and state but no `kind`.
 */
const ITEM_KINDS = [
  "appStoreVersion",
  "inAppPurchaseVersion",
  "subscriptionVersion",
  "subscriptionGroupVersion",
  "appEvent",
  "appCustomProductPageVersion",
  "appStoreVersionExperimentV2",
  "appAssetLibraryImage",
  "appAssetLibraryVideo",
  "retentionMessageVersion",
  "backgroundAssetVersion",
  "gameCenterAchievementVersion",
  "gameCenterActivityVersion",
  "gameCenterChallengeVersion",
  "gameCenterLeaderboardSetVersion",
  "gameCenterLeaderboardVersion",
] as const;

type ItemSummary = {
  id: unknown;
  state: unknown;
  kind?: string;
  targetId?: string;
  /** Apple's internal kind number, reported only when no relationship named the item. */
  kindCode?: number;
};

/**
 * An item id is base64 of `<submissionId>|<kind number>|<target id>`. Not a
 * documented format, so it is only a fallback for an item whose relationship
 * Apple did not return, and the number is reported as a number, never mapped
 * to a name: which number means what is not something the API states.
 */
const decodeItemId = (id: unknown): { kindCode: number; targetId: string } | undefined => {
  if (typeof id !== "string") return undefined;
  const match = /^[^|]+\|(\d+)\|(.+)$/.exec(Buffer.from(id, "base64").toString("utf8"));
  return match ? { kindCode: Number(match[1]), targetId: String(match[2]) } : undefined;
};

/**
 * Whether an item a cancel removes can be put back through this server, and how.
 *
 * A cancel moves every item to REMOVED, and Apple does not put any of them back
 * when the version is submitted again. Each one has to be re-added, and for most
 * kinds this server has no tool that does it.
 */
type Restore = { restoredBy: "api" | "webUi"; how: string };

const WEB_UI = "App Store Connect's Add for Review panel on the version page";

const restoreOf = (kind: string | undefined): Restore => {
  switch (kind) {
    case "appStoreVersion":
      return { restoredBy: "api", how: "app_store_connect_submit_version_for_review" };
    case "backgroundAssetVersion":
      return {
        restoredBy: "api",
        how:
          "app_store_connect_submit_version_for_review re-adds the app's pending asset-pack " +
          "versions (includeAssetPacks, on by default) and reports each pack it did not add",
      };
    case "appAssetLibraryImage":
    case "appAssetLibraryVideo":
    case "appStoreVersionExperimentV2":
    case "appCustomProductPageVersion":
    case "appEvent":
      return {
        restoredBy: "api",
        how:
          "app_store_connect_submit_items_for_review, as an item-only submission (no version), " +
          "once the app has an approved version",
      };
    case "inAppPurchaseVersion":
      return {
        restoredBy: "webUi",
        how:
          `${WEB_UI}. An app's first non-consumable can only go back that way; a second or ` +
          `later in-app purchase can instead be submitted alone with ` +
          `app_store_connect_submit_in_app_purchase_for_review`,
      };
    case undefined:
      return {
        restoredBy: "webUi",
        how: `${WEB_UI}: Apple did not say what this item is, so nothing here can re-add it`,
      };
    default:
      return {
        restoredBy: "webUi",
        how: `${WEB_UI}: this server has no tool that adds a ${kind} to a review submission`,
      };
  }
};

/** One item's state and, when its relationships were included, what it is. */
const summarizeItem = (item: Rec): ItemSummary => {
  const kind = ITEM_KINDS.find((name) => relatedId(item, name) !== undefined);
  const decoded = kind === undefined ? decodeItemId(item.id) : undefined;
  return {
    id: item.id,
    state: attributesOf(item).state,
    ...(kind !== undefined ? { kind, targetId: relatedId(item, kind) } : {}),
    ...decoded,
  };
};

/**
 * One submission's items, each saying what it is. Asks for every kind; if Apple
 * refuses that include, falls back to ids and states, which still decode to a
 * kind number and target.
 */
const readItems = async (
  client: AppStoreConnectClient,
  submissionId: string,
): Promise<ItemSummary[]> => {
  const path = `/v1/reviewSubmissions/${submissionId}/items`;
  try {
    return resourcesOf(await client.get(path, { include: ITEM_KINDS.join(","), limit: 50 })).map(
      summarizeItem,
    );
  } catch {
    return resourcesOf(await client.get(path, { limit: 50 })).map(summarizeItem);
  }
};

/**
 * `summarizeResponse` drops relationships, which for a submission throws away the
 * one thing that identifies it — which version is being reviewed. Keep that id.
 *
 * The items come along too, because a submission's state alone cannot say what
 * Apple rejected: UNRESOLVED_ISSUES is the same whether the version or the
 * in-app purchase riding with it was turned down. `itemDetails` replaces the
 * sideloaded id+state with the fuller rows fetched for returned submissions.
 */
const summarizeSubmissions = (
  response: unknown,
  { details, failed }: ItemDetails = { details: new Map(), failed: [] },
  appIds: string | string[] = [],
): unknown => {
  const sideloaded = includedIndex(response, "reviewSubmissionItems");
  // The paging verdict (`incomplete`, `meta`, `links.next`) comes from
  // summarizeResponse, so a capped list is never read as the whole one.
  const summarized = summarizeResponse(response) as Record<string, unknown>;
  const notes = [
    multiAppLimitNote(appIds, summarized.incomplete),
    failed.length > 0
      ? `Could not read what each item is for ${failed.join(", ")}; those rows list their ` +
        `items with id and state only.`
      : undefined,
  ].filter((note) => note !== undefined);
  return {
    ...summarized,
    data: resourcesOf(response).map((res) => {
      const items =
        details.get(String(res.id)) ??
        relatedIds(res, "items").map((id) => summarizeItem(sideloaded.get(id) ?? { id }));
      return {
        id: res.id,
        type: res.type,
        ...attributesOf(res),
        // Also the app, so several apps' submissions can be read in one request and
        // still be told apart.
        appId: relatedId(res, "app"),
        appStoreVersionForReview: relatedId(res, "appStoreVersionForReview"),
        // An item-only submission: library assets, a test, a custom product
        // page or an event, reviewed without a version. Apple allows one such
        // per platform under review, beside one that holds a version.
        ...(isItemOnly(res, items) ? { itemOnly: true } : {}),
        ...(items.length > 0 ? { items } : {}),
      };
    }),
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
};

type ItemDetails = { details: Map<string, ItemSummary[]>; failed: string[] };

/**
 * Whether a submission carries no version. Read off both the submission's own
 * `appStoreVersionForReview` and its items, since a draft can hold a version
 * item before Apple fills in the former.
 */
const isItemOnly = (submission: Rec, items: ItemSummary[]): boolean =>
  relatedId(submission, "appStoreVersionForReview") === undefined &&
  items.length > 0 &&
  items.every((item) => item.kind !== undefined && item.kind !== "appStoreVersion");

/** How many submissions' items are read at once, so a long list does not burst Apple's rate limit. */
const ITEM_READ_CONCURRENCY = 5;

/**
 * The items of every listed submission that has any, with what each one is.
 * One extra request per such row, because `items.<kind>` cannot be sideloaded
 * from the list endpoint itself, and an item's id and state alone cannot say
 * whether it is the version, an in-app purchase or an asset pack. That is the
 * question both "which item did Apple reject?" and "what would a cancel strip?"
 * turn on.
 *
 * Extra detail, never a precondition: a submission whose items cannot be read
 * falls back to the sideloaded id+state and is named in `failed`, rather than
 * failing a list that had already succeeded.
 */
const itemDetails = async (
  client: AppStoreConnectClient,
  response: unknown,
): Promise<ItemDetails> => {
  const withItems = resourcesOf(response).filter((res) => relatedIds(res, "items").length > 0);
  const failed: string[] = [];
  const details = new Map<string, ItemSummary[]>();
  for (let i = 0; i < withItems.length; i += ITEM_READ_CONCURRENCY) {
    await Promise.all(
      withItems.slice(i, i + ITEM_READ_CONCURRENCY).map(async (res) => {
        const id = String(res.id);
        try {
          details.set(id, await readItems(client, id));
        } catch {
          failed.push(id);
        }
      }),
    );
  }
  return { details, failed };
};

/**
 * Whether this version is already an item on the submission. Apple 409s on a
 * duplicate item, and a re-run after a half-finished submit is exactly when that
 * happens, so we look before adding rather than guessing from the error.
 */
const containsVersion = (itemsResponse: unknown, versionId: string): boolean => {
  const viaRelationship = resourcesOf(itemsResponse).some(
    (item) => relatedId(item, "appStoreVersion") === versionId,
  );
  if (viaRelationship) return true;
  // Some responses carry the link only as a sideloaded resource.
  const included =
    isRecord(itemsResponse) && Array.isArray(itemsResponse.included) ? itemsResponse.included : [];
  return included.some(
    (res) => isRecord(res) && res.type === "appStoreVersions" && res.id === versionId,
  );
};

/**
 * The id of the submission item carrying this version.
 *
 * Read off the item's own `appStoreVersion` relationship and nowhere else.
 * `containsVersion` may fall back to a sideloaded resource to answer "is this
 * version in here", which is enough to decide whether to resume a submission but
 * NOT enough to delete one: that needs the single item's id, and picking by
 * position when the relationship is absent would drop a different item — on a
 * submission carrying a first in-app purchase, that is somebody else's review.
 */
const findVersionItemId = (itemsResponse: unknown, versionId: string): string | undefined => {
  for (const item of resourcesOf(itemsResponse)) {
    if (relatedId(item, "appStoreVersion") === versionId) return String(item.id);
  }
  return undefined;
};

/** A version found sitting on one of this app's own un-submitted drafts. */
type StagedVersion = {
  submissionId: string;
  /** `undefined` when the version matched only by sideload, so no item is addressable. */
  itemId: string | undefined;
};

/**
 * The app's own draft submission already holding this version, if there is one.
 *
 * ⚠️ Consulted *before* `assertSubmittable`, and that ordering is the entire point.
 * Adding the item moves the version to READY_FOR_REVIEW, which is not a submittable
 * state — so once a run has staged a version, and every `dryRun` does, the state
 * guard refuses every later attempt and nothing in this server can finish what was
 * started. The draft holding the version is the evidence that the half-done work is
 * the caller's own, which is what turns that lockout into a resume.
 */
const findStaged = async (
  client: AppStoreConnectClient,
  versionResponse: unknown,
  versionId: string,
): Promise<StagedVersion | undefined> => {
  const version = resourceOf(versionResponse);
  const attrs = attributesOf(version);
  if (attrs.appStoreState !== STAGED_VERSION_STATE) return undefined;

  const appId = relatedId(version, "app");
  const platform = attrs.platform;
  // Nothing to look up without both; `assertSubmittable` reports the missing one.
  if (typeof appId !== "string" || typeof platform !== "string") return undefined;

  const drafts = resourcesOf(
    await client.get(`/v1/apps/${appId}/reviewSubmissions`, {
      "filter[platform]": platform,
      "filter[state]": DRAFT_STATE,
      limit: 10,
    }),
  );
  for (const draft of drafts) {
    const submissionId = String(draft.id);
    const items = await client.get(`/v1/reviewSubmissions/${submissionId}/items`, {
      include: "appStoreVersion",
      limit: 50,
    });
    if (containsVersion(items, versionId)) {
      return { submissionId, itemId: findVersionItemId(items, versionId) };
    }
  }
  return undefined;
};

/**
 * The app's returned (UNRESOLVED_ISSUES) submission that already holds this
 * version as a resolved item, if there is one.
 *
 * ⚠️ Consulted before `assertSubmittable`, for the same reason as `findStaged`.
 * Resolving the rejected item — which a Resolution Center reply or the web UI's
 * "Update review" does, as well as a half-finished run of this tool — moves the
 * version to READY_FOR_REVIEW while the submission stays UNRESOLVED_ISSUES. The
 * state guard refuses that version, so without this the only API route left is
 * pulling the version out of the rejected submission, which risks its queue slot.
 */
const findResolvedInReturned = async (
  client: AppStoreConnectClient,
  versionResponse: unknown,
  versionId: string,
): Promise<string | undefined> => {
  const version = resourceOf(versionResponse);
  const attrs = attributesOf(version);
  if (attrs.appStoreState !== STAGED_VERSION_STATE) return undefined;

  const appId = relatedId(version, "app");
  const platform = attrs.platform;
  if (typeof appId !== "string" || typeof platform !== "string") return undefined;

  const returned = resourcesOf(
    await client.get(`/v1/apps/${appId}/reviewSubmissions`, {
      "filter[platform]": platform,
      "filter[state]": RETURNED_STATE,
      include: "appStoreVersionForReview",
      limit: 10,
    }),
  );
  for (const submission of returned) {
    const submissionId = String(submission.id);
    // Positive evidence only: a READY_FOR_REVIEW version is not submittable, so
    // resubmitting on a guess would bypass the guard for somebody else's version.
    if (relatedId(submission, "appStoreVersionForReview") === versionId) return submissionId;
    const items = await client.get(`/v1/reviewSubmissions/${submissionId}/items`, {
      include: "appStoreVersion",
      limit: 50,
    });
    if (containsVersion(items, versionId)) return submissionId;
  }
  return undefined;
};

/**
 * Send a submission Apple handed back (UNRESOLVED_ISSUES) back to it: resolve
 * whatever items are still rejected, then submit that same submission again.
 */
const resubmitReturned = async (
  client: AppStoreConnectClient,
  submissionId: string,
  versionId: string,
  dryRun: boolean,
  /** False when the caller already has positive evidence the version is on it. */
  verifyHoldsVersion = false,
): Promise<unknown> => {
  const itemsResponse = await client.get(`/v1/reviewSubmissions/${submissionId}/items`, {
    include: "appStoreVersion",
    limit: 50,
  });
  const items = resourcesOf(itemsResponse);

  // A returned submission can hold only an in-app purchase. Resubmitting it
  // would then report this version as sent while it never left, so without
  // other evidence refuse unless the version is provably one of the items.
  if (verifyHoldsVersion && !containsVersion(itemsResponse, versionId)) {
    throw new PreconditionError(
      `The rejected review submission ${submissionId} does not hold version ${versionId} — ` +
        `none of its ${items.length} item(s) is this version — so resubmitting it would not ` +
        `send this version to Apple. Add the version to that submission in App Store Connect, ` +
        `then resubmit.`,
      {
        submissionId,
        versionId,
        items: items.map((item) => ({ id: item.id, state: attributesOf(item).state })),
      },
    );
  }

  // Only the rejected items are touched. The others are still READY_FOR_REVIEW
  // from the first submission, or already resolved, and go back untouched —
  // that is how an in-app purchase keeps the review it had already started
  // rather than beginning again.
  const rejected = items.filter((item) => attributesOf(item).state === REJECTED_ITEM_STATE);

  // ⚠️ Nothing is written on a dry run of this branch. Unlike the draft path,
  // where staging the item IS the preflight Apple answers, resolving items
  // here buys no diagnostic — and the PATCH after it hands the submission
  // straight back to Apple. A dryRun that resubmits is the one thing the
  // flag exists to prevent.
  if (dryRun) {
    return {
      submissionId,
      versionId,
      resubmitted: false,
      dryRun: true,
      submitted: false,
      wouldResolveItems: rejected.length,
      note:
        "This app has a rejected submission holding this version. Re-running without " +
        "dryRun resolves its rejected item(s) and sends the same submission back, " +
        "keeping its queue position. Nothing has been written.",
    };
  }

  for (const item of rejected) {
    await client.patch(`/v1/reviewSubmissionItems/${String(item.id)}`, {
      data: {
        type: "reviewSubmissionItems",
        id: String(item.id),
        attributes: { resolved: true },
      },
    });
  }

  const resubmitted = await client.patch(`/v1/reviewSubmissions/${submissionId}`, {
    data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } },
  });

  return {
    submissionId,
    versionId,
    resubmitted: true,
    resolvedItems: rejected.length,
    submission: summarizeResponse(resubmitted),
  };
};

type AssetPackStep =
  | {
      packs: (Omit<AssetPackPlan, "action"> & { action: AssetPackPlan["action"] | "wouldAdd" })[];
      note?: string;
    }
  | { error: string; note: string }
  | { skipped: true };

/**
 * Put the app's pending asset-pack versions on the draft, before it is handed
 * to Apple. An asset pack reaches the App Store only as an item of the app's
 * review submission, and nothing else in a submit adds it: a version submitted
 * alone goes to review without the packs it downloads. That is exactly what a
 * cancel-then-resubmit leaves behind.
 *
 * `undefined` for an app with no asset packs, so the answer only mentions packs
 * when there are some. A failed *read* does not block the submit (it is
 * reported loudly instead); a failed *add* does, because the draft is then
 * half-built and submitting it would ship without a pack Apple was asked for.
 */
const addAssetPacks = async (
  client: AppStoreConnectClient,
  opts: {
    appId: string;
    platform: string;
    submissionId: string;
    /** False for a submission created by this call, which can hold no pack yet. */
    readExisting: boolean;
    dryRun: boolean;
    include: boolean;
  },
): Promise<AssetPackStep | undefined> => {
  const { appId, platform, submissionId, readExisting, dryRun, include } = opts;
  if (!include) return { skipped: true };

  let packs: AssetPack[];
  try {
    ({ packs } = await readAssetPacks(client, appId, { platform }));
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      note:
        "Could not read this app's asset packs, so none were added. If the app ships Apple-" +
        `hosted asset packs, check app_store_connect_list_asset_packs and ${WEB_UI}.`,
    };
  }
  if (packs.length === 0) return undefined;

  const onSubmission = new Set<string>();
  if (readExisting) {
    const items = await client.get(`/v1/reviewSubmissions/${submissionId}/items`, {
      include: "backgroundAssetVersion",
      limit: 50,
    });
    for (const item of resourcesOf(items)) {
      const id = relatedId(item, "backgroundAssetVersion");
      if (id !== undefined) onSubmission.add(id);
    }
  }

  const plans = planAssetPacks(packs, onSubmission);
  const added: string[] = [];
  if (!dryRun) {
    for (const plan of plans) {
      if (plan.action !== "add" || plan.versionId === undefined) continue;
      try {
        await client.post("/v1/reviewSubmissionItems", {
          data: {
            type: "reviewSubmissionItems",
            relationships: {
              reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
              backgroundAssetVersion: {
                data: { type: "backgroundAssetVersions", id: plan.versionId },
              },
            },
          },
        });
        added.push(plan.versionId);
      } catch (err) {
        throw new PreconditionError(
          `Apple refused to add asset pack ${String(plan.assetPackIdentifier)} (version ` +
            `${String(plan.version)}, ${plan.versionId}) to review submission ${submissionId}: ` +
            `${err instanceof Error ? err.message : String(err)}. The submission has NOT been ` +
            `sent to Apple. The version is staged on it` +
            (added.length > 0 ? `, as are asset-pack version(s) ${added.join(", ")}` : "") +
            `. Re-run to retry, pass includeAssetPacks: false to submit without the remaining ` +
            `packs, or add them in ${WEB_UI}.`,
          { submissionId, assetPacks: plans, added },
        );
      }
    }
  }

  const notAdded = plans.filter((plan) => plan.action === "notAdded");
  return {
    packs: plans.map((plan) =>
      dryRun && plan.action === "add" ? { ...plan, action: "wouldAdd" as const } : plan,
    ),
    ...(notAdded.length > 0
      ? {
          note:
            `${notAdded.length} asset pack(s) were not added; each says why. One that has to ` +
            `ship with this release must be added in ${WEB_UI}.`,
        }
      : {}),
  };
};

/**
 * Read the version and report every reason it cannot be submitted at once. Apple
 * answers an unsubmittable version with a generic error that names no cause, and
 * a caller with two problems should learn both in one round trip.
 */
const assertSubmittable = (versionResponse: unknown): { appId: string; platform: string } => {
  const version = resourceOf(versionResponse);
  const attrs = attributesOf(version);
  const appStoreState = attrs.appStoreState;
  const platform = attrs.platform;
  const appId = relatedId(version, "app");
  const buildId = relatedId(version, "build");

  const problems: string[] = [];

  if (typeof appStoreState === "string" && !SUBMITTABLE_STATES.includes(appStoreState)) {
    problems.push(
      `the version is ${appStoreState}; it can only be submitted while it is ` +
        `${SUBMITTABLE_STATES.join(", ")}`,
    );
  }

  if (buildId === undefined) {
    problems.push(
      "no build is attached; attach one with app_store_connect_set_version_build before submitting",
    );
  }

  if (appId === undefined) {
    problems.push(
      "the version response carries no app relationship, so the app it belongs to cannot be " +
        "determined — this is a bug in this tool, not something you can fix in App Store Connect",
    );
  }

  if (typeof platform !== "string") {
    problems.push("the version response carries no platform — cannot open a review submission");
  }

  if (problems.length > 0) {
    throw new PreconditionError(`Cannot submit this version: ${problems.join("; ")}.`, {
      appStoreState,
      versionString: attrs.versionString,
      platform,
      appId,
      buildId,
    });
  }

  return { appId: appId as string, platform: platform as string };
};

// ─── item-only submissions ──────────────────────────────────────────────────
//
// Once an app has an approved version, Apple reviews library assets, product
// page optimization tests, custom product page versions and in-app events
// without a version: a review submission whose items are only those. Apple
// allows one such submission per platform under review at a time, beside one
// that holds a version. `reviewSubmissionItems` takes each through its own
// to-one relationship (spec 4.6, ReviewSubmissionItemCreateRequest).

/** The item kinds this server submits without a version, by relationship name. */
const ITEM_ONLY_KINDS = {
  appAssetLibraryImage: "appAssetLibraryImages",
  appAssetLibraryVideo: "appAssetLibraryVideos",
  appStoreVersionExperimentV2: "appStoreVersionExperiments",
  appCustomProductPageVersion: "appCustomProductPageVersions",
  appEvent: "appEvents",
} as const;
type ItemOnlyKind = keyof typeof ITEM_ONLY_KINDS;

/** Library asset states that can still go to review, or are already staged for it. */
const SUBMITTABLE_ASSET_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "REJECTED",
  "READY_FOR_REVIEW",
]);

/** Test states that can still go to review, or are already staged for it. */
const SUBMITTABLE_EXPERIMENT_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "REJECTED",
  "READY_FOR_REVIEW",
]);

type PlannedItem = { kind: ItemOnlyKind; id: string; note?: string };

type ItemOutcome = PlannedItem & {
  action: "added" | "wouldBeAdded" | "alreadyOnSubmission" | "skipped" | "refused";
  reason?: string;
};

type ItemOnlyArgs = {
  appId: string;
  platform: (typeof PLATFORMS)[number];
  assetIds?: string[] | undefined;
  experimentIds?: string[] | undefined;
  customProductPageVersionIds?: string[] | undefined;
  appEventIds?: string[] | undefined;
  dryRun: boolean;
};

const errorText = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  const associated = flattenAssociatedErrors(
    err instanceof AppStoreConnectApiError ? err.errors : undefined,
  ).map(formatAssociatedError);
  return associated.length > 0 ? `${err.message} (${associated.join("; ")})` : err.message;
};

/**
 * Read each named item and decide, before anything is created, whether it can
 * go to review alone. Every problem is collected, so a caller with three bad
 * ids learns all three in one round trip.
 */
const planItems = async (
  client: AppStoreConnectClient,
  args: ItemOnlyArgs,
): Promise<{ planned: PlannedItem[]; skipped: ItemOutcome[] }> => {
  const planned: PlannedItem[] = [];
  const skipped: ItemOutcome[] = [];
  const problems: string[] = [];

  for (const id of args.assetIds ?? []) {
    const { kind, response } = await fetchAsset(client, id);
    const attrs = attributesOf(resourceOf(response));
    const itemKind: ItemOnlyKind =
      kind === "image" ? "appAssetLibraryImage" : "appAssetLibraryVideo";
    const state = String(attrs.state);
    if (state === "APPROVED") {
      skipped.push({ kind: itemKind, id, action: "skipped", reason: "already APPROVED" });
      continue;
    }
    if (!isProcessed(kind, attrs)) {
      problems.push(`asset ${id} is still processing (state ${state}); wait for it first`);
      continue;
    }
    if (!SUBMITTABLE_ASSET_STATES.has(state)) {
      problems.push(`asset ${id} is ${state}, which is not a state Apple takes for review`);
      continue;
    }
    const placements = resourcesOf(
      await client.get(`/v1/${RESOURCE[kind]}/${id}/placements`, { limit: 5 }),
    );
    if (placements.length > 0) {
      // Apple's help: an asset placed on a version, custom product page, test
      // or event "is reviewed with that item and can't be submitted separately".
      problems.push(
        `asset ${id} is placed (${placements.map((p) => String(p.id)).join(", ")}), and Apple ` +
          `reviews a placed asset with what it is placed on, never alone: submit that test, ` +
          `custom product page or event instead, or the version it sits on`,
      );
      continue;
    }
    planned.push({ kind: itemKind, id });
  }

  for (const id of args.experimentIds ?? []) {
    const attrs = attributesOf(
      resourceOf(await client.get(`/v2/appStoreVersionExperiments/${id}`)),
    );
    const state = String(attrs.state);
    if (attrs.platform !== undefined && attrs.platform !== args.platform) {
      problems.push(`test ${id} is on ${String(attrs.platform)}, not ${args.platform}`);
    } else if (!SUBMITTABLE_EXPERIMENT_STATES.has(state)) {
      problems.push(`test ${id} is ${state}, which is not a state Apple takes for review`);
    } else {
      planned.push({
        kind: "appStoreVersionExperimentV2",
        id,
        ...(attrs.reviewRequired === false
          ? {
              note:
                "Apple marks this test reviewRequired: false. If Apple refuses it here, start " +
                "it with app_store_connect_update_experiment instead.",
            }
          : {}),
      });
    }
  }

  for (const id of args.customProductPageVersionIds ?? []) {
    planned.push({ kind: "appCustomProductPageVersion", id });
  }
  for (const id of args.appEventIds ?? []) planned.push({ kind: "appEvent", id });

  if (problems.length > 0) {
    throw new PreconditionError(`Nothing was created or submitted: ${problems.join("; ")}.`, {
      problems,
      wouldSkip: skipped,
    });
  }
  return { planned, skipped };
};

/**
 * The app's open submissions on this platform, each with what it holds, and
 * the one a new item-only submission can use: its own draft, if it has one
 * that holds no version.
 */
const findItemOnlyDraft = async (
  client: AppStoreConnectClient,
  appId: string,
  platform: string,
): Promise<{ draftId?: string; draftItems: ItemSummary[]; versionInFlight?: string }> => {
  const open = resourcesOf(
    await client.get(`/v1/apps/${appId}/reviewSubmissions`, {
      "filter[platform]": platform,
      "filter[state]": [RETURNED_STATE, ...IN_FLIGHT_STATES, DRAFT_STATE],
      include: "appStoreVersionForReview",
      limit: 50,
    }),
  );
  let draftId: string | undefined;
  let draftItems: ItemSummary[] = [];
  let versionInFlight: string | undefined;
  for (const submission of open) {
    const id = String(submission.id);
    const state = String(attributesOf(submission).state);
    const items = await readItems(client, id);
    const holdsVersion =
      relatedId(submission, "appStoreVersionForReview") !== undefined ||
      items.some((item) => item.kind === "appStoreVersion");

    if (holdsVersion) {
      if (state === DRAFT_STATE) {
        throw new PreconditionError(
          `This app's ${platform} draft submission ${id} holds a version, so items added to it ` +
            `would go to review with that version, not on their own. Submit the version with ` +
            `app_store_connect_submit_version_for_review first, or take it off the draft with ` +
            `app_store_connect_remove_version_from_submission.`,
          { submissionId: id, state, items },
        );
      }
      if (state !== RETURNED_STATE) versionInFlight = id;
      continue;
    }
    if (state === DRAFT_STATE) {
      draftId = id;
      draftItems = items;
      continue;
    }
    throw new PreconditionError(
      state === RETURNED_STATE
        ? `This app's item-only ${platform} submission ${id} came back from Apple ` +
            `(UNRESOLVED_ISSUES). Apple allows one item-only submission per platform at a time: ` +
            `resolve that one in App Store Connect's App Review page, or cancel it with ` +
            `app_store_connect_cancel_review_submission, before sending another.`
        : `This app already has an item-only ${platform} submission with Apple (${id}, ${state}), ` +
            `and Apple allows one per platform under review at a time. Wait for it to finish, or ` +
            `withdraw it with app_store_connect_cancel_review_submission (dryRun first).`,
      { submissionId: id, state, items },
    );
  }
  return { ...compact({ draftId, versionInFlight }), draftItems };
};

const submitItemsForReview = async (
  client: AppStoreConnectClient,
  args: ItemOnlyArgs,
): Promise<unknown> => {
  const { planned, skipped } = await planItems(client, args);
  if (planned.length === 0) {
    throw new PreconditionError("None of the items needs review, so nothing was created.", {
      items: skipped,
    });
  }

  const { draftId, draftItems, versionInFlight } = await findItemOnlyDraft(
    client,
    args.appId,
    args.platform,
  );
  const submissionId =
    draftId ??
    String(
      resourceOf(
        await client.post("/v1/reviewSubmissions", {
          data: {
            type: "reviewSubmissions",
            attributes: { platform: args.platform },
            relationships: { app: { data: { type: "apps", id: args.appId } } },
          },
        }),
      ).id,
    );

  // Adding the item is where Apple adjudicates each kind, as with a version:
  // a refusal here is Apple's answer for that item, so the rest still go on
  // and every answer is reported, but nothing is submitted while any is refused.
  const outcomes: ItemOutcome[] = [...skipped];
  for (const item of planned) {
    if (draftItems.some((d) => d.kind === item.kind && d.targetId === item.id)) {
      outcomes.push({ ...item, action: "alreadyOnSubmission" });
      continue;
    }
    try {
      await client.post("/v1/reviewSubmissionItems", {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
            [item.kind]: { data: { type: ITEM_ONLY_KINDS[item.kind], id: item.id } },
          },
        },
      });
      outcomes.push({ ...item, action: args.dryRun ? "wouldBeAdded" : "added" });
    } catch (err) {
      outcomes.push({ ...item, action: "refused", reason: errorText(err) });
    }
  }
  // Items already on the reused draft that this call did not name ride along.
  const alsoOnDraft = draftItems.filter(
    (d) => d.state !== "REMOVED" && !planned.some((p) => p.kind === d.kind && p.id === d.targetId),
  );

  const refused = outcomes.filter((o) => o.action === "refused");
  const base = {
    submissionId,
    platform: args.platform,
    reusedDraft: draftId !== undefined,
    items: outcomes,
    ...(alsoOnDraft.length > 0 ? { alsoOnDraft } : {}),
    ...(versionInFlight !== undefined ? { versionSubmissionWithApple: versionInFlight } : {}),
  };
  const ONE_PER_PLATFORM =
    "Apple allows one item-only submission per platform under review at a time, beside one " +
    "that holds a version.";

  if (refused.length > 0) {
    return {
      ...base,
      submitted: false,
      ...(args.dryRun ? { dryRun: true } : {}),
      note:
        `Apple refused ${refused.length} item(s); each says why. The submission has NOT been ` +
        `sent to Apple. The accepted items stay staged on draft ${submissionId}: re-run ` +
        `without the refused ones to submit, or take items off the draft with ` +
        `app_store_connect_remove_submission_items. ${ONE_PER_PLATFORM}`,
    };
  }

  if (args.dryRun) {
    return {
      ...base,
      dryRun: true,
      submitted: false,
      note:
        "The items are ready: Apple accepted them onto the draft submission, which is still " +
        "yours and has NOT been sent for review. Staging may move each item to " +
        "READY_FOR_REVIEW; re-run without dryRun to finish the submission from here, or take " +
        `items back off with app_store_connect_remove_submission_items. ${ONE_PER_PLATFORM}`,
    };
  }

  const submitted = await client.patch(`/v1/reviewSubmissions/${submissionId}`, {
    data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } },
  });
  return {
    ...base,
    submission: summarizeResponse(submitted),
    note:
      `Sent to Apple without a version. ${ONE_PER_PLATFORM} Follow it with ` +
      `app_store_connect_list_review_submissions; an approved library asset reads APPROVED in ` +
      `app_store_connect_get_library_asset, and can then be placed on a live product page.`,
  };
};

export const registerSubmissionTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_review_submissions",
    {
      title: "App Store Connect: List Review Submissions",
      description:
        "List an app's App Store review submissions and their state (READY_FOR_REVIEW is a draft " +
        "not yet sent to Apple; WAITING_FOR_REVIEW and IN_REVIEW are with Apple). Each row " +
        "carries the id of the version under review and its `items`, each with its state, " +
        "what it is (`kind`: appStoreVersion, inAppPurchaseVersion, backgroundAssetVersion " +
        "for an asset pack, subscriptionVersion, ...) and its `targetId`. On an " +
        "UNRESOLVED_ISSUES row (rejected) the item in state REJECTED is the one Apple turned " +
        "down. When Apple names no relationship for an item, it carries `kindCode`, Apple's " +
        "internal kind number decoded from the item id, instead of a `kind`. A submission " +
        "holding more than the version loses all of it on a cancel: see " +
        "app_store_connect_cancel_review_submission. Costs one extra request per submission " +
        "with items. Apple's rejection message itself is not in the API: read it in App Store " +
        "Connect's App Review page.",
      inputSchema: z.object({
        appId: appIdsArg,
        platform: z.enum(PLATFORMS).optional().describe("Filter by platform."),
        state: z.enum(SUBMISSION_STATES).optional().describe("Filter by submission state."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, platform, state, limit, savePath }) =>
      wrapSaved(savePath, async () => {
        const response = await client.get(
          // The top-level collection, not /v1/apps/{id}/reviewSubmissions:
          // `filter[app]` is an array here, so several apps come back in one
          // request, and `include=app` is what puts `data` on the relationship
          // so the rows can be told apart.
          "/v1/reviewSubmissions",
          compact({
            "filter[app]": appId,
            "filter[platform]": platform,
            "filter[state]": state,
            include: "app,appStoreVersionForReview,items",
            "limit[items]": 50,
            limit,
          }),
        );
        return summarizeSubmissions(response, await itemDetails(client, response), appId);
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_submit_version_for_review",
    {
      title: "App Store Connect: Submit Version for Review",
      description:
        "Submit an App Store version to Apple for review — the final step of a release. Creates " +
        "(or reuses) the app's draft review submission, adds the version to it, and submits it. " +
        "The version must be in a submittable state with a build attached; everything Apple " +
        "requires (metadata, screenshots, age rating, review details) must already be in place. " +
        "Also handles resubmitting after a rejection: when the app's submission came back " +
        "UNRESOLVED_ISSUES, this resolves the rejected items and sends that same submission " +
        "back, which keeps its queue position and leaves any in-app purchase already under " +
        "review where it is. That includes a version already READY_FOR_REVIEW inside the " +
        "rejected submission because its item was resolved elsewhere (a Resolution Center " +
        "reply, the web UI): it is sent back as is, not pulled out. " +
        "Do NOT cancel a rejected submission to start a clean one. " +
        "Once submitted the version is with Apple — use " +
        "app_store_connect_cancel_review_submission to withdraw it. " +
        "Pass dryRun to preflight instead: it stops before handing anything to Apple, and when " +
        "the version is not ready it surfaces every reason Apple gives — a missing primary " +
        "category, unanswered export compliance on the build, unset pricing, unpublished app " +
        "privacy — which is otherwise only visible by attempting a real submission. A dry run " +
        "of a draft does stage the version on it, which moves the version to READY_FOR_REVIEW; " +
        "calling again without dryRun finishes that same submission. " +
        "Asset packs: an app's Apple-hosted asset packs (Background Assets) reach the App " +
        "Store only as items of this same submission, so by default this also adds the newest " +
        "processed version of each pack whose App Store release is PREPARE_FOR_SUBMISSION or " +
        "REJECTED, before submitting. `assetPacks` reports every pack: added, already on the " +
        "submission, or not added with the reason. A dry run reports `wouldAdd` and adds none. " +
        "The rejection branch resubmits the items already on the submission and adds no packs. " +
        "An app's first non-consumable in-app purchase is NOT added — see " +
        "app_store_connect_submit_in_app_purchase_for_review.",
      inputSchema: z.object({
        versionId: versionIdArg,
        includeAssetPacks: z
          .boolean()
          .default(true)
          .describe(
            "Add the app's pending asset-pack versions to the submission before submitting. " +
              "Defaults to true. Pass false to submit the version without them.",
          ),
        dryRun: dryRunArg,
        confirm: confirmArg,
      }),
      // Hands the version to Apple irrecoverably, like submit_in_app_purchase_for_review.
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ versionId, includeAssetPacks = true, dryRun = false }) =>
      wrap(async () => {
        // `app` must be included explicitly: unlike `build`, Apple omits that
        // relationship entirely from a bare GET, so the app id is not derivable
        // without it.
        const versionResponse = await client.get(`/v1/appStoreVersions/${versionId}`, {
          include: "app,build",
        });

        // A version sitting on this app's own draft is a submission half-finished,
        // not a submission refused — and the commonest way to get here is this
        // tool's own dryRun, which stages the version deliberately. Resuming is
        // handled before `assertSubmittable`, which refuses READY_FOR_REVIEW and
        // would otherwise make the preflight a one-way door.
        const stagedSubmissionId = (await findStaged(client, versionResponse, versionId))
          ?.submissionId;
        if (stagedSubmissionId !== undefined) {
          // findStaged only matches with both present.
          const staged = resourceOf(versionResponse);
          const assetPacks = await addAssetPacks(client, {
            appId: String(relatedId(staged, "app")),
            platform: String(attributesOf(staged).platform),
            submissionId: stagedSubmissionId,
            readExisting: true,
            dryRun,
            include: includeAssetPacks,
          });
          if (dryRun) {
            return {
              submissionId: stagedSubmissionId,
              versionId,
              reusedDraft: true,
              addedItem: false,
              dryRun: true,
              submitted: false,
              ...compact({ assetPacks }),
              note:
                "Already staged on this app's draft submission and NOT handed to Apple. " +
                "Apple accepted the version onto the draft, so it is ready. Re-run without " +
                "dryRun to submit it.",
            };
          }

          const resumed = await client.patch(`/v1/reviewSubmissions/${stagedSubmissionId}`, {
            data: {
              type: "reviewSubmissions",
              id: stagedSubmissionId,
              attributes: { submitted: true },
            },
          });

          return {
            submissionId: stagedSubmissionId,
            versionId,
            resumedDraft: true,
            addedItem: false,
            ...compact({ assetPacks }),
            submission: summarizeResponse(resumed),
          };
        }

        // The same lockout from the other side: the rejected item was resolved
        // (Resolution Center reply, the web UI, or an earlier run of this tool
        // that stopped short), leaving the version READY_FOR_REVIEW inside the
        // returned submission. Sending that submission back is all that is left.
        const resolvedIn = await findResolvedInReturned(client, versionResponse, versionId);
        if (resolvedIn !== undefined) {
          return resubmitReturned(client, resolvedIn, versionId, dryRun);
        }

        const { appId, platform } = assertSubmittable(versionResponse);

        // A rejection comes back as a submission the developer owns again, and
        // it is the same submission that goes back to Apple. Handled before the
        // in-flight check below, because it is neither in flight nor a draft:
        // creating a fresh submission alongside it is what Apple 409s on, with
        // an error that blames the *version* ("Version is not ready to be
        // submitted yet") and never mentions the submission holding it.
        //
        // One read covers all three questions below (returned, in flight, draft),
        // split by state here rather than asked of Apple three times in a row.
        const open = resourcesOf(
          await client.get(`/v1/apps/${appId}/reviewSubmissions`, {
            "filter[platform]": platform,
            "filter[state]": [RETURNED_STATE, ...IN_FLIGHT_STATES, DRAFT_STATE],
            include: "appStoreVersionForReview",
            limit: 50,
          }),
        );
        const inState = (states: string[]): Rec[] =>
          open.filter((res) => states.includes(String(attributesOf(res).state)));
        const returned = inState([RETURNED_STATE]);
        if (returned.length > 0) {
          const submission = returned[0] as Rec;
          const submissionId = submission.id as string;

          // Apple allows one submission per app+platform, so a returned one all
          // but certainly holds this version — but resubmitting somebody else's
          // version because the ids happened not to match is not a mistake worth
          // risking silently.
          const under = relatedId(submission, "appStoreVersionForReview");
          if (under !== undefined && under !== versionId) {
            throw new PreconditionError(
              `This app has a rejected review submission for a different version (${under}). ` +
                `Resolve or cancel that one before submitting ${versionId}.`,
              { submissionId, versionUnderReview: under },
            );
          }

          // No appStoreVersionForReview means nothing yet says this version is
          // on it, so resubmitReturned has to find it among the items.
          return resubmitReturned(client, submissionId, versionId, dryRun, under === undefined);
        }

        // One submission per app+platform: an in-flight one has to be cancelled
        // (or finish) before Apple will accept another.
        const inFlight = inState(IN_FLIGHT_STATES);
        if (inFlight.length > 0) {
          const current = inFlight[0] as Rec;
          throw new PreconditionError(
            `This app already has a review submission with Apple (state ` +
              `${String(attributesOf(current).state)}). Wait for it to finish, or withdraw it ` +
              `with app_store_connect_cancel_review_submission.`,
            { submissionId: current.id, state: attributesOf(current).state },
          );
        }

        const draft = inState([DRAFT_STATE])[0];
        const reusedDraft = draft !== undefined;

        const submissionId =
          typeof draft?.id === "string"
            ? draft.id
            : (resourceOf(
                await client.post("/v1/reviewSubmissions", {
                  data: {
                    type: "reviewSubmissions",
                    attributes: { platform },
                    relationships: { app: { data: { type: "apps", id: appId } } },
                  },
                }),
              ).id as string);

        const alreadyAdded =
          reusedDraft &&
          containsVersion(
            await client.get(`/v1/reviewSubmissions/${submissionId}/items`, {
              include: "appStoreVersion",
              limit: 50,
            }),
            versionId,
          );

        // Adding the item is where Apple actually adjudicates readiness: it answers a version
        // that cannot be reviewed with the full list of what is unset, nested under
        // `meta.associatedErrors`. That makes this call the preflight, and it is why dryRun
        // stops *after* it rather than before — there is no cheaper way to ask.
        //
        // The cost is that it moves the version to READY_FOR_REVIEW, which `assertSubmittable`
        // refuses. `findStaged` above is what keeps that from being a one-way door: the
        // next call finds this draft and finishes the submission instead of being turned away.
        if (!alreadyAdded) {
          await client.post("/v1/reviewSubmissionItems", {
            data: {
              type: "reviewSubmissionItems",
              relationships: {
                reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
                appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
              },
            },
          });
        }

        const assetPacks = await addAssetPacks(client, {
          appId,
          platform,
          submissionId,
          readExisting: reusedDraft,
          dryRun,
          include: includeAssetPacks,
        });

        if (dryRun) {
          return {
            submissionId,
            versionId,
            reusedDraft,
            addedItem: !alreadyAdded,
            dryRun: true,
            submitted: false,
            ...compact({ assetPacks }),
            note:
              "The version is ready: Apple accepted it onto the draft submission, which is " +
              "still yours and has NOT been sent for review. Staging it moved the version to " +
              "READY_FOR_REVIEW, so re-run without dryRun to finish the submission from here. " +
              "Note that an app's first non-consumable in-app purchase cannot ride along — see " +
              "app_store_connect_submit_in_app_purchase_for_review.",
          };
        }

        const submitted = await client.patch(`/v1/reviewSubmissions/${submissionId}`, {
          data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } },
        });

        return {
          submissionId,
          versionId,
          reusedDraft,
          addedItem: !alreadyAdded,
          ...compact({ assetPacks }),
          submission: summarizeResponse(submitted),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_remove_version_from_submission",
    {
      title: "App Store Connect: Remove Version from Submission",
      description:
        "Take a version back off this app's un-submitted draft review submission, returning it " +
        "to PREPARE_FOR_SUBMISSION so its build and metadata can be changed again. " +
        "This is the counterpart to the staging that submit_version_for_review performs — every " +
        "dryRun stages, because adding the item is how Apple adjudicates readiness. Staging " +
        "also freezes the build: app_store_connect_set_version_build refuses a READY_FOR_REVIEW " +
        "version, for attach and detach alike. And cancel_review_submission cannot undo it, " +
        "because a draft has never been with Apple — Apple answers that 409 " +
        "STATE_ERROR.ENTITY_STATE_INVALID, 'Resource is not in cancellable state'. Without this " +
        "tool a preflight followed by 'rebuild it first' could only be unwound in the App Store " +
        "Connect web UI. " +
        "Drafts only: a submission already handed to Apple is refused and named, since " +
        "withdrawing that one is cancel_review_submission's job.",
      inputSchema: z.object({ versionId: versionIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ versionId }) =>
      wrap(async () => {
        // `app` must be included explicitly — Apple omits that relationship from a
        // bare GET, and `findStaged` needs it to locate the app's drafts.
        const versionResponse = await client.get(`/v1/appStoreVersions/${versionId}`, {
          include: "app",
        });
        const attrs = attributesOf(resourceOf(versionResponse));
        const staged = await findStaged(client, versionResponse, versionId);

        if (staged === undefined) {
          const state = attrs.appStoreState;
          // A rejection the developer replied to also leaves the version
          // READY_FOR_REVIEW on no draft, but its submission is UNRESOLVED_ISSUES,
          // which cancel_review_submission refuses — so it needs its own answer.
          const returnedId = await findResolvedInReturned(client, versionResponse, versionId);
          if (returnedId !== undefined) {
            throw new PreconditionError(
              `This version is ${STAGED_VERSION_STATE} as the resolved item of rejected ` +
                `submission ${returnedId} (UNRESOLVED_ISSUES), not on a draft, so there is ` +
                `nothing to remove here, and cancel_review_submission refuses a rejected ` +
                `submission. Resubmit it as it is with ` +
                `app_store_connect_submit_version_for_review, or remove it from that submission ` +
                `in App Store Connect's web UI to change its build.`,
              {
                appStoreState: state,
                versionString: attrs.versionString,
                submissionId: returnedId,
              },
            );
          }
          throw new PreconditionError(
            state === STAGED_VERSION_STATE
              ? `This version is ${STAGED_VERSION_STATE} but sits on no un-submitted draft for ` +
                  `this app, which means the submission holding it has already gone to Apple. ` +
                  `Withdraw that with app_store_connect_cancel_review_submission instead.`
              : `This version is ${String(state)}, not staged on a draft submission, so there ` +
                  `is nothing to remove — its build can already be changed with ` +
                  `app_store_connect_set_version_build.`,
            { appStoreState: state, versionString: attrs.versionString },
          );
        }

        if (staged.itemId === undefined) {
          throw new PreconditionError(
            `Found the draft submission holding this version (${staged.submissionId}), but none ` +
              `of its items carries an appStoreVersion relationship naming ${versionId}, so the ` +
              `item to delete cannot be identified. Remove the version in App Store Connect ` +
              `instead: deleting a guessed item could drop an in-app purchase out of review.`,
            { submissionId: staged.submissionId, versionId },
          );
        }

        await client.del(`/v1/reviewSubmissionItems/${staged.itemId}`);

        // Report the state Apple actually left the version in rather than the one
        // this tool intends: the whole point is to unblock set_version_build, and
        // the caller needs to know whether it now will.
        const after = attributesOf(
          resourceOf(await client.get(`/v1/appStoreVersions/${versionId}`)),
        );

        return {
          versionId,
          submissionId: staged.submissionId,
          removedItem: staged.itemId,
          appStoreState: after.appStoreState,
          note:
            "Removed from the draft submission, which was never sent to Apple. The version is " +
            "editable again — attach a different build with app_store_connect_set_version_build, " +
            "then submit with app_store_connect_submit_version_for_review.",
        };
      }),
  );

  server.registerTool(
    "app_store_connect_submit_items_for_review",
    {
      title: "App Store Connect: Submit Items for Review (No Version)",
      description:
        "Send items to App Review WITHOUT an app version: library assets (images, videos), " +
        "product page optimization tests, custom product page versions and in-app events. " +
        "Apple allows this once the app has an approved version; before that, these items go " +
        "in the same submission as the first version. Creates (or reuses) the app's draft " +
        "submission for the platform that holds no version, adds each item, and submits. " +
        "Apple allows ONE item-only submission per platform under review at a time, beside one " +
        "that holds a version: a second is refused here and the one in the way is named. A " +
        "draft that holds a version is refused too, since the items would then go to review " +
        "with that version. Checked first, all at once: an asset still processing; an asset " +
        "that is placed (Apple reviews a placed asset with the version, test, page or event it " +
        "sits on, never alone, so submit that instead: the test, for screenshots placed on its " +
        "treatments); a test on another platform. An APPROVED asset is skipped. This is the " +
        "route for an asset bound for a live product page: a live parent only takes APPROVED " +
        "assets (409 ENTITY_ERROR.RELATIONSHIP.INVALID otherwise), so submit it here, wait for " +
        "APPROVED, then place it. Each item reports Apple's answer: added, alreadyOnSubmission, " +
        "skipped, or refused with Apple's error; nothing is submitted while any is refused. " +
        "Pass dryRun to preflight: it stops before handing anything to Apple and reports what " +
        "Apple says of each item. A dry run does stage the items on the draft; calling again " +
        "without dryRun finishes that same submission, and " +
        "app_store_connect_remove_submission_items takes items back off. Custom product page " +
        "versions and in-app events are passed through as given (this server has no tools that " +
        "read them), and neither has been exercised against a live app yet.",
      inputSchema: z.object({
        appId: appIdArg,
        platform: z
          .enum(PLATFORMS)
          .default("IOS")
          .describe("The platform whose item-only submission this is. Defaults to IOS."),
        assetIds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Asset library image or video ids (app_store_connect_list_library_assets), not placed.",
          ),
        experimentIds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Product page optimization test ids (app_store_connect_list_experiments). Their " +
              "treatments' placed media go to review with them.",
          ),
        customProductPageVersionIds: z
          .array(z.string().min(1))
          .optional()
          .describe("appCustomProductPageVersion ids."),
        appEventIds: z.array(z.string().min(1)).optional().describe("appEvent ids."),
        dryRun: dryRunArg,
        confirm: confirmArg,
      }),
      // Hands the items to Apple irrecoverably, like submit_version_for_review.
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ confirm: _confirm, dryRun = false, ...args }) =>
      wrap(async () => {
        const named =
          (args.assetIds?.length ?? 0) +
          (args.experimentIds?.length ?? 0) +
          (args.customProductPageVersionIds?.length ?? 0) +
          (args.appEventIds?.length ?? 0);
        if (named === 0) {
          throw new Error(
            "Name at least one item: assetIds, experimentIds, customProductPageVersionIds or " +
              "appEventIds.",
          );
        }
        return submitItemsForReview(client, { ...args, dryRun });
      }),
  );

  server.registerTool(
    "app_store_connect_remove_submission_items",
    {
      title: "App Store Connect: Remove Items from Draft Submission",
      description:
        "Take items back off an un-submitted draft review submission (state READY_FOR_REVIEW), " +
        "e.g. after a dryRun of app_store_connect_submit_items_for_review staged something that " +
        "should not go. Item ids come from app_store_connect_list_review_submissions (each " +
        "row's `items`). Drafts only: a submission already with Apple is refused, since " +
        "withdrawing that is app_store_connect_cancel_review_submission's job. For a version " +
        "item, app_store_connect_remove_version_from_submission also reports the version's " +
        "state afterwards. Apple has no route that deletes a draft submission itself; an " +
        "emptied draft stays and is reused by the next submission on that platform.",
      inputSchema: z.object({
        submissionId: submissionIdArg,
        itemIds: z
          .array(z.string().min(1))
          .min(1)
          .describe("The reviewSubmissionItem ids to remove."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ submissionId, itemIds }) =>
      wrap(async () => {
        const state = attributesOf(
          resourceOf(await client.get(`/v1/reviewSubmissions/${submissionId}`)),
        ).state;
        if (state !== DRAFT_STATE) {
          throw new PreconditionError(
            `Submission ${submissionId} is ${String(state)}, not an un-submitted draft ` +
              `(${DRAFT_STATE}). Withdraw a submission that is with Apple with ` +
              `app_store_connect_cancel_review_submission.`,
            { submissionId, state },
          );
        }
        const items = await readItems(client, submissionId);
        const foreign = itemIds.filter((id) => !items.some((item) => item.id === id));
        if (foreign.length > 0) {
          throw new PreconditionError(
            `Not items of submission ${submissionId}: ${foreign.join(", ")}. Nothing was removed.`,
            { submissionId, items },
          );
        }
        for (const id of itemIds) await client.del(`/v1/reviewSubmissionItems/${id}`);
        return {
          submissionId,
          removed: items.filter((item) => itemIds.includes(String(item.id))),
          remaining: items.filter((item) => !itemIds.includes(String(item.id))),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_cancel_review_submission",
    {
      title: "App Store Connect: Cancel Review Submission",
      description:
        "Withdraw a review submission from Apple, returning its versions to an editable state. " +
        "Works the same on an item-only submission (no version: library assets, a test, a " +
        "custom product page, an event), whose items app_store_connect_submit_items_for_review " +
        "can send again. " +
        "Only works while the submission is still with Apple and has not started completing; a " +
        "cancelled submission cannot be un-cancelled — submit again to re-enter the queue. " +
        "A cancel removes EVERY item on the submission, not just the version, and submitting " +
        "the version again does not bring them back. Asset-pack versions " +
        "(backgroundAssetVersion) are re-added by app_store_connect_submit_version_for_review. " +
        "Library assets, in-app events, custom product pages and product page optimization " +
        "tests can be sent again on their own with app_store_connect_submit_items_for_review. " +
        "An app's first non-consumable in-app purchase, subscriptions and Game Center items can " +
        "only be put back by hand, in App Store Connect's Add for Review panel on the version " +
        "page. Call with dryRun first: it " +
        "lists every item besides the version and how each one comes back, and cancels " +
        "nothing. A real cancel reports the same list as `otherItems`. " +
        "This is the wrong tool for a rejection: a submission in UNRESOLVED_ISSUES is already " +
        "yours to edit, and app_store_connect_submit_version_for_review sends it back without " +
        "losing the queue position or restarting the review of any in-app purchase attached " +
        "to it.",
      inputSchema: z.object({
        submissionId: submissionIdArg,
        dryRun: dryRunArg,
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ submissionId, dryRun = false }) =>
      wrap(async () => {
        // Apple accepts a cancel on a returned submission, so the description
        // alone is the only thing between an agent and the mistake RETURNED_STATE
        // documents. Read the state first and refuse that one case.
        const current = resourceOf(await client.get(`/v1/reviewSubmissions/${submissionId}`));
        const state = attributesOf(current).state;
        if (state === RETURNED_STATE) {
          throw new PreconditionError(
            `This submission is ${RETURNED_STATE}: Apple handed it back and it is already ` +
              `yours to edit. Cancelling it would surrender its queue position and restart the ` +
              `review of every other item on it. Resolve the rejected items, then resubmit it ` +
              `with app_store_connect_submit_version_for_review.`,
            { submissionId, state },
          );
        }

        // What the cancel will strip. Read before cancelling and never skipped:
        // the item list is the warning, and a cancel that could not produce it
        // is the one that strands an asset pack or a first IAP unnoticed. A
        // read that fails therefore fails the cancel.
        const allItems = await readItems(client, submissionId);
        const holdsVersion =
          relatedId(current, "appStoreVersionForReview") !== undefined ||
          allItems.some((item) => item.kind === "appStoreVersion");
        const otherItems = allItems
          .filter((item) => item.kind !== "appStoreVersion" && item.state !== "REMOVED")
          .map((item) => ({ ...item, ...restoreOf(item.kind) }));
        const byHand = otherItems.filter((item) => item.restoredBy === "webUi");
        const note =
          otherItems.length === 0
            ? "The submission holds only the version, which submit_version_for_review puts back."
            : !holdsVersion
              ? `This is an item-only submission (no version). Cancelling removes its ` +
                `${otherItems.length} item(s); send them again with ` +
                `app_store_connect_submit_items_for_review. ` +
                (byHand.length > 0
                  ? `${byHand.length} of them can only be re-added by hand; see each item's \`how\`.`
                  : "")
              : `Cancelling removes ${otherItems.length} item(s) besides the version, and ` +
                `resubmitting the version does not bring them back. ` +
                (byHand.length > 0
                  ? `${byHand.length} of them can only be re-added by hand in ${WEB_UI}; see ` +
                    `each item's \`how\`.`
                  : `submit_version_for_review re-adds all of them.`);

        if (dryRun) {
          return { submissionId, state, dryRun: true, canceled: false, otherItems, note };
        }

        const canceled = summarizeResponse(
          await client.patch(`/v1/reviewSubmissions/${submissionId}`, {
            data: { type: "reviewSubmissions", id: submissionId, attributes: { canceled: true } },
          }),
        );
        return { ...(isRecord(canceled) ? canceled : { data: canceled }), otherItems, note };
      }),
  );
};
