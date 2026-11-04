import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import {
  attributesOf,
  firstIncluded,
  type Rec,
  relatedId,
  resourceOf,
  summarizeResource,
  summarizeResponse,
} from "#/client/shape";
import {
  confirmArg,
  PreconditionError,
  savePathArg,
  versionIdArg,
  wrap,
  wrapSaved,
} from "#/tools/util";

/**
 * Apple's 7-day schedule: the share of automatic-update users offered the
 * update on each day of an active phased release. Day 7 is everyone.
 */
const ROLLOUT_PERCENT = [1, 2, 5, 10, 20, 50, 100] as const;

/**
 * States a version only reaches once it is out. A phased release has to be set
 * up before that, and Apple answers a late one with a bare error.
 */
const RELEASED_STATES = [
  "READY_FOR_SALE",
  "PROCESSING_FOR_APP_STORE",
  "REPLACED_WITH_NEW_VERSION",
  "REMOVED_FROM_SALE",
  "DEVELOPER_REMOVED_FROM_SALE",
];

const PAUSE_SEMANTICS =
  "Pausing only stops AUTOMATIC updates: people who already received the version keep it, " +
  "and anyone can still update by hand from the App Store, so a pause does not contain a bad " +
  "build. Apple caps the total pause at 30 days.";

const ACTIONS = {
  PAUSE: { to: "PAUSED", from: ["ACTIVE"] },
  RESUME: { to: "ACTIVE", from: ["PAUSED"] },
  COMPLETE: { to: "COMPLETE", from: ["ACTIVE", "PAUSED"] },
} as const;

type Action = keyof typeof ACTIONS;

type VersionWithPhase = {
  version: Rec;
  phased: Rec | undefined;
};

/** One read for both the version's state and its phased release, if any. */
const readVersion = async (
  client: AppStoreConnectClient,
  versionId: string,
): Promise<VersionWithPhase> => {
  const response = await client.get(`/v1/appStoreVersions/${versionId}`, {
    include: "appStoreVersionPhasedRelease",
  });
  const version = resourceOf(response);
  // Apple links the relationship and sideloads the resource; read the id off
  // the relationship so an unrelated sideload can never be mistaken for it.
  const phasedId = relatedId(version, "appStoreVersionPhasedRelease");
  const included = firstIncluded(response, "appStoreVersionPhasedReleases");
  const phased =
    included !== undefined && (phasedId === undefined || included.id === phasedId)
      ? included
      : phasedId !== undefined
        ? { id: phasedId, type: "appStoreVersionPhasedReleases" }
        : undefined;
  return { version, phased };
};

/** What one phased release means today, in the words a release decision needs. */
const describePhase = (phased: Rec): Rec => {
  const attrs = attributesOf(phased);
  const day = typeof attrs.currentDayNumber === "number" ? attrs.currentDayNumber : undefined;
  const state = attrs.phasedReleaseState;
  const percent =
    state === "COMPLETE"
      ? 100
      : (state === "ACTIVE" || state === "PAUSED") && day !== undefined && day >= 1
        ? ROLLOUT_PERCENT[Math.min(day, ROLLOUT_PERCENT.length) - 1]
        : undefined;
  return {
    ...(summarizeResource(phased) as Rec),
    ...(percent !== undefined ? { rolloutPercent: percent } : {}),
  };
};

const stateNote = (state: unknown, appStoreState: unknown): string => {
  switch (state) {
    case "INACTIVE":
      return (
        `Set up but not started: the rollout begins when the version is released ` +
        `(it is ${String(appStoreState)}).`
      );
    case "ACTIVE":
      return (
        "Rolling out. rolloutPercent is the share of automatic-update users OFFERED the update " +
        "today, not how many have it; anyone can update by hand at any time."
      );
    case "PAUSED":
      return `Paused. ${PAUSE_SEMANTICS}`;
    case "COMPLETE":
      return "Complete: every automatic-update user has been offered the version.";
    default:
      return "";
  }
};

export const registerPhasedReleaseTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_get_phased_release",
    {
      title: "App Store Connect: Get Phased Release",
      description:
        "Get a version's phased release: its state (INACTIVE: set up, starts when the version is " +
        "released; ACTIVE; PAUSED; COMPLETE), startDate, currentDayNumber, totalPauseDuration " +
        "(days), and `rolloutPercent`, Apple's 7-day schedule (1, 2, 5, 10, 20, 50, 100%) for " +
        "the current day. rolloutPercent is the share of automatic-update users OFFERED the " +
        "update, not adoption: anyone can update by hand from day one. `phasedRelease: null` " +
        "means the version has none and will reach everyone at once when released.",
      inputSchema: z.object({ versionId: versionIdArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ versionId, savePath }) =>
      wrapSaved(savePath, async () => {
        const { version, phased } = await readVersion(client, versionId);
        const attrs = attributesOf(version);
        const base = {
          versionId,
          versionString: attrs.versionString,
          appStoreState: attrs.appStoreState,
        };
        if (phased === undefined) {
          return {
            ...base,
            phasedRelease: null,
            note:
              "No phased release: when released, this version is offered to every user at " +
              "once. Set one up with app_store_connect_create_phased_release before releasing.",
          };
        }
        return {
          ...base,
          phasedRelease: describePhase(phased),
          note: stateNote(attributesOf(phased).phasedReleaseState, attrs.appStoreState),
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_phased_release",
    {
      title: "App Store Connect: Create Phased Release",
      description:
        "Set a version to roll out as a phased release: over 7 days, to 1, 2, 5, 10, 20, 50 then " +
        "100% of users with automatic updates on. It is created INACTIVE and starts by itself " +
        "when the version is released (on approval, at its scheduled date, or by " +
        "app_store_connect_release_version), so set it up BEFORE release; Apple refuses one on " +
        "a version already out. Phasing only paces automatic updates: anyone can update by " +
        "hand from the App Store on day one, and new downloads always get the new version. " +
        "Control it afterwards with app_store_connect_update_phased_release.",
      inputSchema: z.object({ versionId: versionIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ versionId }) =>
      wrap(async () => {
        const { version, phased } = await readVersion(client, versionId);
        const attrs = attributesOf(version);
        if (phased !== undefined) {
          throw new PreconditionError(
            "This version already has a phased release; read or change it with " +
              "app_store_connect_get_phased_release / app_store_connect_update_phased_release.",
            { versionId, phasedRelease: describePhase(phased) },
          );
        }
        if (
          typeof attrs.appStoreState === "string" &&
          RELEASED_STATES.includes(attrs.appStoreState)
        ) {
          throw new PreconditionError(
            `Cannot phase this version: it is ${attrs.appStoreState}, already released. A ` +
              `phased release has to be set up before the version goes out.`,
            { versionId, appStoreState: attrs.appStoreState, versionString: attrs.versionString },
          );
        }
        const created = await client.post("/v1/appStoreVersionPhasedReleases", {
          data: {
            type: "appStoreVersionPhasedReleases",
            attributes: { phasedReleaseState: "INACTIVE" },
            relationships: {
              appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
            },
          },
        });
        return {
          versionId,
          versionString: attrs.versionString,
          appStoreState: attrs.appStoreState,
          ...(summarizeResponse(created) as Rec),
          note: stateNote("INACTIVE", attrs.appStoreState),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_update_phased_release",
    {
      title: "App Store Connect: Update Phased Release",
      description:
        "Pause, resume or complete a version's running phased release. Takes the version id and " +
        "finds its phased release itself. PAUSE (from ACTIVE): " +
        `${PAUSE_SEMANTICS} RESUME (from PAUSED) picks up the 7-day schedule where it stopped. ` +
        "COMPLETE (from ACTIVE or PAUSED) releases to EVERY automatic-update user now and cannot " +
        "be undone. An INACTIVE phased release has not started, so there is nothing to pause: it " +
        "starts when the version is released. Returns the state before and after.",
      inputSchema: z.object({
        versionId: versionIdArg,
        action: z
          .enum(["PAUSE", "RESUME", "COMPLETE"])
          .describe("PAUSE an active rollout, RESUME a paused one, or COMPLETE it (everyone now)."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ versionId, action }) =>
      wrap(async () => {
        const { version, phased } = await readVersion(client, versionId);
        const attrs = attributesOf(version);
        if (phased === undefined) {
          throw new PreconditionError(
            "This version has no phased release to change. Create one with " +
              "app_store_connect_create_phased_release before the version is released.",
            { versionId, appStoreState: attrs.appStoreState },
          );
        }
        const rule = ACTIONS[action as Action];
        const from = attributesOf(phased).phasedReleaseState;
        if (from === rule.to) {
          // Idempotent: asking for the state it is already in changes nothing.
          return {
            versionId,
            action,
            previousState: from,
            phasedRelease: describePhase(phased),
            note: `Already ${String(from)}; nothing was changed.`,
          };
        }
        if (typeof from === "string" && !(rule.from as readonly string[]).includes(from)) {
          throw new PreconditionError(
            `Cannot ${action} a phased release that is ${from}; ${action} applies to ` +
              `${rule.from.join(" or ")}. ${stateNote(from, attrs.appStoreState)}`,
            { versionId, phasedReleaseState: from, appStoreState: attrs.appStoreState },
          );
        }
        const updated = await client.patch(
          `/v1/appStoreVersionPhasedReleases/${String(phased.id)}`,
          {
            data: {
              type: "appStoreVersionPhasedReleases",
              id: phased.id,
              attributes: { phasedReleaseState: rule.to },
            },
          },
        );
        const after = resourceOf(updated);
        return {
          versionId,
          action,
          previousState: from,
          phasedRelease: after.id === undefined ? summarizeResponse(updated) : describePhase(after),
          note: stateNote(rule.to, attrs.appStoreState),
        };
      }),
  );
};
