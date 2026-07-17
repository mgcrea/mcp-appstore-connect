import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { appIdArg, compact, confirmArg, limitArg, wrap } from "./util.js";

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
      description:
        "List an app's TestFlight beta groups (internal and external), with their public-link " +
        "state. Returns the group ids used to manage testers.",
      inputSchema: { appId: appIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get("/v1/betaGroups", compact({ "filter[app]": appId, limit })),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_list_beta_testers",
    {
      description:
        "List TestFlight beta testers. Scope to one group with `groupId`, or search all testers " +
        "by email. Returns each tester's id, email, name and invite state.",
      inputSchema: {
        groupId: z.string().optional().describe("Only testers in this beta group."),
        email: z.string().optional().describe("Filter by tester email."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ groupId, email, limit }) =>
      wrap(async () =>
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
      description:
        "List TestFlight beta feedback screenshot submissions for an app (tester comment, device " +
        "model, OS version, and screenshot asset links).",
      inputSchema: { appId: appIdArg, limit: limitArg },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, limit }) =>
      wrap(async () =>
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
    "app_store_connect_invite_beta_tester",
    {
      description:
        "Invite a new external TestFlight tester by email into a beta group. Sends them an " +
        "invitation. Use app_store_connect_add_tester_to_group for a tester that already exists.",
      inputSchema: {
        groupId: groupIdArg,
        email: z.string().min(1).describe("The tester's email address."),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
      },
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
      description: "Add an existing beta tester to a beta group.",
      inputSchema: { groupId: groupIdArg, testerId: testerIdArg },
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
      description:
        "Remove a beta tester from a beta group. They lose access to that group's builds.",
      inputSchema: { groupId: groupIdArg, testerId: testerIdArg, confirm: confirmArg },
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
