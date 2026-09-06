import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import {
  type Rec,
  attributesOf,
  isRecord,
  relatedId,
  resourceOf,
  resourcesOf,
  summarizeResponse,
} from "#/client/shape";
import {
  appIdArg,
  compact,
  confirmArg,
  dryRunArg,
  limitArg,
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
 * Version states Apple still accepts into a review submission. The rejected ones
 * are editable again after review, so resubmitting them is the normal path back.
 */
/**
 * A version that has already been added to a draft submission. Spelled the same as
 * `DRAFT_STATE` but read off the *version*, not the submission — Apple reuses the
 * word for both, and conflating them is how this state ends up looking submittable.
 */
const STAGED_VERSION_STATE = "READY_FOR_REVIEW";

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
 * `summarizeResponse` drops relationships, which for a submission throws away the
 * one thing that identifies it — which version is being reviewed. Keep that id.
 */
const summarizeSubmissions = (response: unknown): unknown => ({
  data: resourcesOf(response).map((res) => ({
    id: res.id,
    type: res.type,
    ...attributesOf(res),
    appStoreVersionForReview: relatedId(res, "appStoreVersionForReview"),
  })),
});

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

const findStagedDraft = async (
  client: AppStoreConnectClient,
  versionResponse: unknown,
  versionId: string,
): Promise<string | undefined> =>
  (await findStaged(client, versionResponse, versionId))?.submissionId;

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
        "carries the id of the version under review.",
      inputSchema: z.object({
        appId: appIdArg,
        platform: z.enum(PLATFORMS).optional().describe("Filter by platform."),
        state: z.enum(SUBMISSION_STATES).optional().describe("Filter by submission state."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, platform, state, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeSubmissions(
          await client.get(
            `/v1/apps/${appId}/reviewSubmissions`,
            compact({
              "filter[platform]": platform,
              "filter[state]": state,
              include: "appStoreVersionForReview",
              limit,
            }),
          ),
        ),
      ),
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
        "review where it is. Do NOT cancel a rejected submission to start a clean one. " +
        "Once submitted the version is with Apple — use " +
        "app_store_connect_cancel_review_submission to withdraw it. " +
        "Pass dryRun to preflight instead: it stops before handing anything to Apple, and when " +
        "the version is not ready it surfaces every reason Apple gives — a missing primary " +
        "category, unanswered export compliance on the build, unset pricing, unpublished app " +
        "privacy — which is otherwise only visible by attempting a real submission. A dry run " +
        "of a draft does stage the version on it, which moves the version to READY_FOR_REVIEW; " +
        "calling again without dryRun finishes that same submission.",
      inputSchema: z.object({ versionId: versionIdArg, dryRun: dryRunArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ versionId, dryRun = false }) =>
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
        const stagedSubmissionId = await findStagedDraft(client, versionResponse, versionId);
        if (stagedSubmissionId !== undefined) {
          if (dryRun) {
            return {
              submissionId: stagedSubmissionId,
              versionId,
              reusedDraft: true,
              addedItem: false,
              dryRun: true,
              submitted: false,
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
            submission: summarizeResponse(resumed),
          };
        }

        const { appId, platform } = assertSubmittable(versionResponse);

        // A rejection comes back as a submission the developer owns again, and
        // it is the same submission that goes back to Apple. Handled before the
        // in-flight check below, because it is neither in flight nor a draft:
        // creating a fresh submission alongside it is what Apple 409s on, with
        // an error that blames the *version* ("Version is not ready to be
        // submitted yet") and never mentions the submission holding it.
        const returned = resourcesOf(
          await client.get(`/v1/apps/${appId}/reviewSubmissions`, {
            "filter[platform]": platform,
            "filter[state]": RETURNED_STATE,
            include: "appStoreVersionForReview",
            limit: 10,
          }),
        );
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

          const items = resourcesOf(
            await client.get(`/v1/reviewSubmissions/${submissionId}/items`, {
              include: "appStoreVersion",
              limit: 50,
            }),
          );

          // Only the rejected items are touched. The others are still
          // READY_FOR_REVIEW from the first submission and go back untouched —
          // that is how an in-app purchase keeps the review it had already
          // started rather than beginning again.
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
        }

        // One submission per app+platform: an in-flight one has to be cancelled
        // (or finish) before Apple will accept another.
        const inFlight = resourcesOf(
          await client.get(`/v1/apps/${appId}/reviewSubmissions`, {
            "filter[platform]": platform,
            "filter[state]": IN_FLIGHT_STATES,
            limit: 10,
          }),
        );
        if (inFlight.length > 0) {
          const current = inFlight[0] as Rec;
          throw new PreconditionError(
            `This app already has a review submission with Apple (state ` +
              `${String(attributesOf(current).state)}). Wait for it to finish, or withdraw it ` +
              `with app_store_connect_cancel_review_submission.`,
            { submissionId: current.id, state: attributesOf(current).state },
          );
        }

        const drafts = resourcesOf(
          await client.get(`/v1/apps/${appId}/reviewSubmissions`, {
            "filter[platform]": platform,
            "filter[state]": DRAFT_STATE,
            limit: 10,
          }),
        );
        const draft = drafts[0];
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
        // refuses. `findStagedDraft` above is what keeps that from being a one-way door: the
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

        if (dryRun) {
          return {
            submissionId,
            versionId,
            reusedDraft,
            addedItem: !alreadyAdded,
            dryRun: true,
            submitted: false,
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
    "app_store_connect_cancel_review_submission",
    {
      title: "App Store Connect: Cancel Review Submission",
      description:
        "Withdraw a review submission from Apple, returning its versions to an editable state. " +
        "Only works while the submission is still with Apple and has not started completing; a " +
        "cancelled submission cannot be un-cancelled — submit again to re-enter the queue. " +
        "This is the wrong tool for a rejection: a submission in UNRESOLVED_ISSUES is already " +
        "yours to edit, and app_store_connect_submit_version_for_review sends it back without " +
        "losing the queue position or restarting the review of any in-app purchase attached " +
        "to it.",
      inputSchema: z.object({ submissionId: submissionIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ submissionId }) =>
      wrap(async () =>
        summarizeResponse(
          await client.patch(`/v1/reviewSubmissions/${submissionId}`, {
            data: { type: "reviewSubmissions", id: submissionId, attributes: { canceled: true } },
          }),
        ),
      ),
  );
};
