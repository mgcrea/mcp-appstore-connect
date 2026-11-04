import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import {
  attributesOf,
  includedIndex,
  type Rec,
  relatedId,
  resourceOf,
  resourcesOf,
  summarizeResource,
  summarizeResponse,
} from "#/client/shape";
import {
  appIdArg,
  appIdsArg,
  compact,
  confirmArg,
  getOrNull,
  limitArg,
  PLATFORMS,
  PreconditionError,
  saveToPath,
  savePathArg,
  type SavedFile,
  summarizeWithApp,
  wrap,
  wrapSaved,
} from "#/tools/util";

const groupIdArg = z
  .string()
  .min(1)
  .describe("The beta group id (from app_store_connect_list_beta_groups).");

const testerIdArg = z
  .string()
  .min(1)
  .describe("The beta tester id (from app_store_connect_list_beta_testers).");

const crashSubmissionIdArg = z
  .string()
  .min(1)
  .describe("The betaFeedbackCrashSubmission id (from app_store_connect_list_beta_crash_reports).");

/**
 * The lines of a crash log that say what happened, so the caller can tell one
 * crash from another without opening the file. Best effort: a log in a format
 * these do not match just yields none.
 */
const HEADLINE =
  /^(Exception Type|Exception Codes|Exception Reason|Termination Reason|Crashed Thread|Triggered by Thread):/;

const headlineOf = (logText: string): string[] =>
  logText
    .split(/\r?\n/)
    .filter((line) => HEADLINE.test(line.trim()))
    .map((line) => line.trim())
    .slice(0, 6);

/**
 * A submission's crash log, or `null` when Apple holds none for it. Apple says
 * "none" as a 404 or as a 200 without `logText`, depending on the submission.
 */
const crashLogText = async (
  client: AppStoreConnectClient,
  submissionId: string,
): Promise<string | null> => {
  const log = resourceOf(
    await getOrNull(client, `/v1/betaFeedbackCrashSubmissions/${submissionId}/crashLog`),
  );
  const text = attributesOf(log).logText;
  return typeof text === "string" && text !== "" ? text : null;
};

/** Write one crash log verbatim and report what landed. */
const saveCrashLog = async (
  path: string,
  logText: string,
): Promise<{ saved: SavedFile; headline: string[] }> => ({
  saved: { ...(await saveToPath(path, logText, "crash log")), content: "text" },
  headline: headlineOf(logText),
});

const NO_CRASH_LOG =
  "Apple holds no crash log for this submission. The tester's report still counts; the log " +
  "may simply not have been uploaded from the device.";

export const registerTestflightTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_beta_groups",
    {
      title: "App Store Connect: List Beta Groups",
      description:
        "List an app's TestFlight beta groups (internal and external), with their public-link " +
        "state. Returns the group ids used to manage testers.",
      inputSchema: z.object({ appId: appIdsArg, limit: limitArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeWithApp(
          await client.get(
            "/v1/betaGroups",
            // include=app is what puts `data` on the app relationship; without
            // it several apps' groups are indistinguishable.
            compact({ "filter[app]": appId, include: "app", limit }),
          ),
          appId,
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_beta_testers",
    {
      title: "App Store Connect: List Beta Testers",
      description:
        "List TestFlight beta testers. Scope to one group with `groupId`, or search all testers " +
        "by email. Returns each tester's id, email, name and invite state.",
      inputSchema: z.object({
        groupId: z.string().optional().describe("Only testers in this beta group."),
        email: z.string().optional().describe("Filter by tester email."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ groupId, email, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          // One endpoint for both filters: the group's own betaTesters path takes
          // no email filter, so passing both there silently dropped the email.
          await client.get(
            "/v1/betaTesters",
            compact({ "filter[betaGroups]": groupId, "filter[email]": email, limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_beta_feedback",
    {
      title: "App Store Connect: List Beta Feedback",
      description:
        "List TestFlight beta feedback SCREENSHOT submissions for an app (tester comment, device " +
        "model, OS version, and screenshot asset links). Crash reports testers sent are not " +
        "here: they are app_store_connect_list_beta_crash_reports. An empty list here says " +
        "nothing about crashes.",
      inputSchema: z.object({ appId: appIdArg, limit: limitArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/betaFeedbackScreenshotSubmissions`,
            compact({ limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_beta_crash_reports",
    {
      title: "App Store Connect: List Beta Crash Reports",
      description:
        "List the crash reports TestFlight testers submitted for an app, newest first: date, " +
        "tester comment and email, device model and family, OS version, platform, architecture, " +
        "app uptime, and the build (`buildId`, `buildNumber`). Pass `crashLogDir` to also save " +
        "each report's crash log there as <submissionId>.crash, or fetch one with " +
        "app_store_connect_get_beta_crash_log. These are only crashes a TESTER chose to send " +
        "from TestFlight: not every crash, and nothing from App Store customers. Crash counts " +
        'for released versions are the "App Crashes" report in ' +
        "app_store_connect_get_analytics_report, and App Store crash logs are only in Xcode " +
        "Organizer or Xcode's MCP (GetTopCrashIssues). An empty list does not mean the build " +
        "does not crash.",
      inputSchema: z.object({
        appId: appIdArg,
        buildId: z
          .string()
          .min(1)
          .optional()
          .describe("Only reports from this build (from app_store_connect_list_builds)."),
        platform: z.enum(PLATFORMS).optional().describe("Only reports for this app platform."),
        limit: limitArg,
        crashLogDir: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Absolute directory to save each listed report's crash log to, as " +
              "<submissionId>.crash. One extra request per report. Omit to list only.",
          ),
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, buildId, platform, limit, crashLogDir, savePath }) =>
      wrapSaved(savePath, async () => {
        const response = await client.get(
          `/v1/apps/${appId}/betaFeedbackCrashSubmissions`,
          compact({
            "filter[build]": buildId,
            "filter[appPlatform]": platform,
            include: "build",
            "fields[builds]": "version,uploadedDate",
            sort: "-createdDate",
            limit,
          }),
        );
        const builds = includedIndex(response, "builds");
        const submissions = resourcesOf(response);
        // Sequential on purpose: one request per report, and a page of 200 fired
        // at once is a 429 waiting to happen.
        const logs: (Rec | undefined)[] = [];
        for (const submission of submissions) {
          if (crashLogDir === undefined) {
            logs.push(undefined);
            continue;
          }
          const id = String(submission.id);
          const text = await crashLogText(client, id);
          logs.push(
            text === null
              ? { crashLog: null }
              : { crashLog: await saveCrashLog(join(crashLogDir, `${id}.crash`), text) },
          );
        }
        const summary = summarizeResponse(response) as Rec;
        return {
          ...summary,
          data: submissions.map((submission, index) => {
            const id = relatedId(submission, "build");
            const build = id === undefined ? undefined : builds.get(id);
            return {
              ...(summarizeResource(submission) as Rec),
              buildId: id,
              buildNumber: build === undefined ? undefined : attributesOf(build).version,
              ...logs[index],
            };
          }),
          ...(submissions.length === 0
            ? {
                note:
                  "No tester sent a crash report through TestFlight for this filter. That is " +
                  "not evidence the app does not crash: most crashes are never reported by hand.",
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_get_beta_crash_log",
    {
      title: "App Store Connect: Get Beta Crash Log",
      description:
        "Save the crash log of one TestFlight crash report to `savePath`, verbatim. The log is " +
        "not inlined; the response carries the file receipt and its headline lines (exception " +
        "type, termination reason, crashed thread) when the log has them. `crashLog: null` " +
        "means Apple holds no log for that report, not that the report is invalid.",
      inputSchema: z.object({
        submissionId: crashSubmissionIdArg,
        savePath: z
          .string()
          .min(1)
          .describe("Absolute path to write the crash log to, e.g. /tmp/crash-1.crash. Required."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ submissionId, savePath }) =>
      wrap(async () => {
        const text = await crashLogText(client, submissionId);
        if (text === null) return { submissionId, crashLog: null, note: NO_CRASH_LOG };
        return { submissionId, crashLog: await saveCrashLog(savePath, text) };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_beta_group",
    {
      title: "App Store Connect: Create Beta Group",
      description:
        "Create a TestFlight beta group for an app — the container builds are distributed " +
        "through. An app with no group has nowhere to send a build, so this is the first step " +
        "of setting up TestFlight; every other beta tool needs the group id it returns. " +
        "Internal groups take testers who are already Users on the App Store Connect account " +
        "(up to 100) and receive builds without Beta App Review, which makes " +
        "`hasAccessToAllBuilds` the quickest way to make existing builds installable. External " +
        "groups take anyone by email, and their first build needs review.",
      inputSchema: z.object({
        appId: appIdArg,
        name: z
          .string()
          .min(1)
          .describe('Group name, unique within the app, e.g. "Internal" or "Public Beta".'),
        isInternalGroup: z
          .boolean()
          .default(true)
          .describe(
            "True for an internal group (testers must be account Users; no Beta App Review). " +
              "False for an external group.",
          ),
        hasAccessToAllBuilds: z
          .boolean()
          .optional()
          .describe(
            "Internal groups only. Give the group every build automatically, including ones " +
              "already uploaded, instead of assigning builds one at a time.",
          ),
        publicLinkEnabled: z
          .boolean()
          .optional()
          .describe("External groups only. Enable a public TestFlight invite link."),
        publicLinkLimit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("External groups only. Cap how many testers the public link admits."),
        feedbackEnabled: z
          .boolean()
          .optional()
          .describe("Let testers send feedback and screenshots from the TestFlight app."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({
      appId,
      name,
      isInternalGroup,
      hasAccessToAllBuilds,
      publicLinkEnabled,
      publicLinkLimit,
      feedbackEnabled,
    }) =>
      wrap(async () => {
        // Apple rejects the cross-kind attributes outright, and its error names the
        // field rather than the reason. Fail here instead, where we can say which
        // way the group is wrong.
        if (isInternalGroup && (publicLinkEnabled !== undefined || publicLinkLimit !== undefined)) {
          throw new PreconditionError("Public links are only available on external beta groups.", {
            isInternalGroup,
            publicLinkEnabled,
            publicLinkLimit,
          });
        }
        if (!isInternalGroup && hasAccessToAllBuilds !== undefined) {
          throw new PreconditionError(
            "hasAccessToAllBuilds is only available on internal beta groups.",
            { isInternalGroup, hasAccessToAllBuilds },
          );
        }
        return summarizeResponse(
          await client.post("/v1/betaGroups", {
            data: {
              type: "betaGroups",
              attributes: compact({
                name,
                isInternalGroup,
                hasAccessToAllBuilds,
                publicLinkEnabled,
                publicLinkLimit,
                feedbackEnabled,
              }),
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          }),
        );
      }),
  );

  server.registerTool(
    "app_store_connect_invite_beta_tester",
    {
      title: "App Store Connect: Invite Beta Tester",
      description:
        "Invite a new external TestFlight tester by email into a beta group. Sends them an " +
        "invitation. Use app_store_connect_add_tester_to_group for a tester that already exists.",
      inputSchema: z.object({
        groupId: groupIdArg,
        email: z.string().min(1).describe("The tester's email address."),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ groupId, email, firstName, lastName }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/betaTesters", {
            data: {
              type: "betaTesters",
              attributes: compact({ email, firstName, lastName }),
              relationships: { betaGroups: { data: [{ type: "betaGroups", id: groupId }] } },
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_add_tester_to_group",
    {
      title: "App Store Connect: Add Tester to Group",
      description: "Add an existing beta tester to a beta group.",
      inputSchema: z.object({ groupId: groupIdArg, testerId: testerIdArg }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ groupId, testerId }) =>
      wrap(async () => {
        await client.post(`/v1/betaGroups/${groupId}/relationships/betaTesters`, {
          data: [{ type: "betaTesters", id: testerId }],
        });
        return { added: testerId, groupId };
      }),
  );

  server.registerTool(
    "app_store_connect_remove_tester_from_group",
    {
      title: "App Store Connect: Remove Tester from Group",
      description:
        "Remove a beta tester from a beta group. They lose access to that group's builds.",
      inputSchema: z.object({ groupId: groupIdArg, testerId: testerIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ groupId, testerId }) =>
      wrap(async () => {
        await client.del(`/v1/betaGroups/${groupId}/relationships/betaTesters`, {
          data: [{ type: "betaTesters", id: testerId }],
        });
        return { removed: testerId, groupId };
      }),
  );
};
