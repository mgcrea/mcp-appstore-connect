import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { summarizeResponse } from "#/client/shape";
import {
  appIdArg,
  appIdsArg,
  compact,
  confirmArg,
  limitArg,
  PreconditionError,
  savePathArg,
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
          limit,
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
          groupId
            ? await client.get(`/v1/betaGroups/${groupId}/betaTesters`, compact({ limit }))
            : await client.get("/v1/betaTesters", compact({ "filter[email]": email, limit })),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_beta_feedback",
    {
      title: "App Store Connect: List Beta Feedback",
      description:
        "List TestFlight beta feedback screenshot submissions for an app (tester comment, device " +
        "model, OS version, and screenshot asset links).",
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
