import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import {
  attributesOf,
  firstIncluded,
  relatedId,
  resourceOf,
  summarizeResponse,
} from "../client/shape.js";
import {
  PLATFORMS,
  PreconditionError,
  appIdArg,
  compact,
  limitArg,
  versionIdArg,
  wrap,
} from "./util.js";

const localizationIdArg = z
  .string()
  .min(1)
  .describe(
    "The appStoreVersionLocalization id (from app_store_connect_list_version_localizations).",
  );

/** Apple only accepts a build or attribute change while the version is still editable. */
const EDITABLE_STATES = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED"];

/** How an approved version reaches customers. */
const RELEASE_TYPES = ["MANUAL", "AFTER_APPROVAL", "SCHEDULED"] as const;

const RELEASE_TYPE_DESCRIPTION =
  "How the version reaches customers once Apple approves it: MANUAL (it waits in " +
  "PENDING_DEVELOPER_RELEASE until you release it by hand), AFTER_APPROVAL (released " +
  "automatically on approval), or SCHEDULED (released at earliestReleaseDate).";

const releaseTypeArg = z.enum(RELEASE_TYPES).describe(RELEASE_TYPE_DESCRIPTION);

const earliestReleaseDateArg = z
  .string()
  .describe(
    'ISO-8601 date-time for a SCHEDULED release, e.g. "2026-08-01T12:00:00-07:00". Required ' +
      "when releaseType is SCHEDULED, and rejected with any other releaseType.",
  );

/**
 * `earliestReleaseDate` only means something for a SCHEDULED release, and Apple
 * rejects the pairing rather than ignoring it. A flat input schema can't express
 * the dependency, so both tools that accept these fields check it here.
 */
const assertReleaseFieldsAgree = (
  releaseType: (typeof RELEASE_TYPES)[number] | undefined,
  earliestReleaseDate: string | undefined,
): void => {
  if (releaseType === "SCHEDULED" && earliestReleaseDate === undefined) {
    throw new Error("releaseType SCHEDULED requires earliestReleaseDate.");
  }
  if (
    releaseType !== undefined &&
    releaseType !== "SCHEDULED" &&
    earliestReleaseDate !== undefined
  ) {
    throw new Error(`earliestReleaseDate only applies to a SCHEDULED release, not ${releaseType}.`);
  }
};

/**
 * The state gate shared by every write to a version. Apple answers a change to a
 * locked version with a bare 409, so we read the state first and say which one
 * blocked it.
 */
const editableStateProblem = (appStoreState: unknown, change: string): string | undefined => {
  if (typeof appStoreState !== "string" || EDITABLE_STATES.includes(appStoreState)) {
    return undefined;
  }
  return (
    `the version is ${appStoreState}; ${change} can only be changed while it is ` +
    `${EDITABLE_STATES.join(" or ")}`
  );
};

/** Guard an attribute update the same way `assertAttachable` guards a build change. */
const assertEditable = (versionResponse: unknown): void => {
  const attrs = attributesOf(resourceOf(versionResponse));
  const problem = editableStateProblem(attrs.appStoreState, "its metadata");
  if (problem === undefined) return;
  throw new PreconditionError(`Cannot update this version: ${problem}.`, {
    appStoreState: attrs.appStoreState,
    versionString: attrs.versionString,
  });
};

/**
 * Apple answers a bad build attach with a bare 409 that names no cause, so we
 * read both resources first and report every failing precondition at once.
 * Returning them together means a caller with two problems learns both in one
 * round trip instead of playing whack-a-mole.
 */
const assertAttachable = (versionResponse: unknown, buildResponse: unknown): void => {
  const version = resourceOf(versionResponse);
  const build = resourceOf(buildResponse);
  const versionAttrs = attributesOf(version);
  const buildAttrs = attributesOf(build);
  const preRelease = attributesOf(firstIncluded(buildResponse, "preReleaseVersions") ?? {});

  const appStoreState = versionAttrs.appStoreState;
  const versionString = versionAttrs.versionString;
  const processingState = buildAttrs.processingState;
  const buildVersionString = preRelease.version;

  const problems: string[] = [];

  const stateProblem = editableStateProblem(appStoreState, "a build");
  if (stateProblem !== undefined) {
    problems.push(stateProblem);
  }

  const versionAppId = relatedId(version, "app");
  const buildAppId = relatedId(build, "app");
  if (versionAppId !== undefined && buildAppId !== undefined && versionAppId !== buildAppId) {
    problems.push(
      `the build belongs to app ${buildAppId}, but the version belongs to ${versionAppId}`,
    );
  }

  if (
    typeof versionAttrs.platform === "string" &&
    typeof preRelease.platform === "string" &&
    versionAttrs.platform !== preRelease.platform
  ) {
    problems.push(
      `the build is ${String(preRelease.platform)}, but the version is ${String(versionAttrs.platform)}`,
    );
  }

  if (typeof processingState === "string" && processingState !== "VALID") {
    problems.push(
      processingState === "PROCESSING"
        ? "the build is still PROCESSING; wait for it to reach VALID and retry"
        : `the build is ${processingState}, not VALID; upload a new build`,
    );
  }

  if (buildAttrs.expired === true) {
    problems.push("the build has expired and can no longer be attached");
  }

  if (
    typeof buildVersionString === "string" &&
    typeof versionString === "string" &&
    buildVersionString !== versionString
  ) {
    problems.push(
      `the build is for version ${buildVersionString}, but the App Store version is ${versionString}`,
    );
  }

  if (problems.length === 0) return;

  throw new PreconditionError(`Cannot attach this build: ${problems.join("; ")}.`, {
    appStoreState,
    versionString,
    processingState,
    expired: buildAttrs.expired,
    buildVersionString,
  });
};

export const registerVersionTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_versions",
    {
      description:
        "List an app's App Store versions (each versionString and its review state, e.g. " +
        "PREPARE_FOR_SUBMISSION, WAITING_FOR_REVIEW, READY_FOR_SALE).",
      inputSchema: {
        appId: appIdArg,
        platform: z.enum(PLATFORMS).optional().describe("Filter by platform."),
        appStoreState: z
          .string()
          .optional()
          .describe('Filter by review state, e.g. "READY_FOR_SALE".'),
        versionString: z.string().optional().describe('Filter to one version, e.g. "1.2.0".'),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, platform, appStoreState, versionString, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/appStoreVersions`,
            compact({
              "filter[platform]": platform,
              "filter[appStoreState]": appStoreState,
              "filter[versionString]": versionString,
              limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_version_localizations",
    {
      description:
        "List the per-locale metadata rows for one App Store version (each carries description, " +
        "keywords, what's-new, promotional text). Returns the localization ids you update.",
      inputSchema: { versionId: versionIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ versionId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
            compact({ limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_version_localization",
    {
      description:
        "Get one locale's full App Store metadata (description, keywords, what's-new, …).",
      inputSchema: { localizationId: localizationIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ localizationId }) =>
      wrap(async () =>
        summarizeResponse(await client.get(`/v1/appStoreVersionLocalizations/${localizationId}`)),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_version",
    {
      description:
        "Create a new App Store version for an app (e.g. start metadata for 1.3.0). The version " +
        "begins in PREPARE_FOR_SUBMISSION; attach a build with " +
        "app_store_connect_set_version_build, then hand it to Apple with " +
        "app_store_connect_submit_version_for_review.",
      inputSchema: {
        appId: appIdArg,
        versionString: z.string().min(1).describe('The new version number, e.g. "1.3.0".'),
        platform: z.enum(PLATFORMS).default("IOS").describe("Platform for the version."),
        releaseType: releaseTypeArg
          .optional()
          .describe(`${RELEASE_TYPE_DESCRIPTION} Defaults to Apple's AFTER_APPROVAL.`),
        earliestReleaseDate: earliestReleaseDateArg.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ appId, versionString, platform, releaseType, earliestReleaseDate }) =>
      wrap(async () => {
        assertReleaseFieldsAgree(releaseType, earliestReleaseDate);

        return summarizeResponse(
          await client.post("/v1/appStoreVersions", {
            data: {
              type: "appStoreVersions",
              attributes: compact({ platform, versionString, releaseType, earliestReleaseDate }),
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_update_version",
    {
      description:
        "Update an App Store version's own attributes — most usefully releaseType, which decides " +
        "whether an approved version goes live automatically (AFTER_APPROVAL), waits for you to " +
        "release it (MANUAL), or ships at a set time (SCHEDULED). Also renames the version or " +
        "sets its copyright. Only the fields you pass are changed. The version must still be " +
        "PREPARE_FOR_SUBMISSION or DEVELOPER_REJECTED. To change a version's build instead, use " +
        "app_store_connect_set_version_build.",
      inputSchema: {
        versionId: versionIdArg,
        releaseType: releaseTypeArg.optional(),
        earliestReleaseDate: earliestReleaseDateArg.optional(),
        versionString: z.string().min(1).optional().describe('Rename the version, e.g. "1.3.0".'),
        copyright: z.string().optional().describe('Copyright line, e.g. "2026 Acme Inc.".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ versionId, ...attrs }) =>
      wrap(async () => {
        const attributes = compact(attrs);
        if (Object.keys(attributes).length === 0) {
          throw new Error(
            "Pass at least one field to update: releaseType, earliestReleaseDate, " +
              "versionString or copyright.",
          );
        }
        assertReleaseFieldsAgree(attrs.releaseType, attrs.earliestReleaseDate);

        assertEditable(await client.get(`/v1/appStoreVersions/${versionId}`));

        return summarizeResponse(
          await client.patch(`/v1/appStoreVersions/${versionId}`, {
            data: { id: versionId, type: "appStoreVersions", attributes },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_update_version_localization",
    {
      description:
        "Update the App Store metadata for one locale of a version: description, keywords, " +
        "what's-new (release notes), promotional text, marketing/support URLs. Only the fields " +
        "you pass are changed. Keywords are a single comma-separated string (100-char limit).",
      inputSchema: {
        localizationId: localizationIdArg,
        description: z
          .string()
          .optional()
          .describe("Full App Store description (4000-char limit)."),
        keywords: z
          .string()
          .optional()
          .describe('Comma-separated keywords, e.g. "todo,tasks,productivity" (100-char limit).'),
        whatsNew: z
          .string()
          .optional()
          .describe("Release notes for this version (4000-char limit). Shown as 'What's New'."),
        promotionalText: z
          .string()
          .optional()
          .describe("Promotional text, editable without a new build (170-char limit)."),
        marketingUrl: z.string().optional(),
        supportUrl: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ localizationId, ...attrs }) =>
      wrap(async () =>
        summarizeResponse(
          await client.patch(`/v1/appStoreVersionLocalizations/${localizationId}`, {
            data: {
              type: "appStoreVersionLocalizations",
              id: localizationId,
              attributes: compact(attrs),
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_set_version_build",
    {
      description:
        "Attach a build to an App Store version — the last step before submitting. Pass detach: " +
        "true instead of a buildId to remove the currently attached build. The version must be " +
        "PREPARE_FOR_SUBMISSION or DEVELOPER_REJECTED, and the build must be VALID, unexpired, " +
        "and belong to the same app and version string.",
      inputSchema: {
        versionId: versionIdArg,
        buildId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The build id (from app_store_connect_list_builds). Required unless detach is true.",
          ),
        detach: z
          .boolean()
          .optional()
          .describe("Remove the currently attached build instead of setting one. Omit buildId."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ versionId, buildId, detach }) =>
      wrap(async () => {
        // A flat input schema can't express "exactly one of", so enforce it here.
        if (detach === true && buildId !== undefined) {
          throw new Error("Pass either buildId or detach, not both.");
        }
        if (detach !== true && buildId === undefined) {
          throw new Error(
            "Pass buildId to attach a build, or detach: true to remove the current one.",
          );
        }

        const version = await client.get(`/v1/appStoreVersions/${versionId}`);
        if (buildId === undefined) {
          // Nothing to validate about a build we're removing — only that the
          // version still accepts the change.
          assertAttachable(version, {});
        } else {
          assertAttachable(
            version,
            await client.get(`/v1/builds/${buildId}`, { include: "preReleaseVersion" }),
          );
        }

        return summarizeResponse(
          await client.patch(`/v1/appStoreVersions/${versionId}`, {
            data: {
              id: versionId,
              type: "appStoreVersions",
              relationships: {
                build: { data: buildId === undefined ? null : { id: buildId, type: "builds" } },
              },
            },
          }),
        );
      }),
  );
};
