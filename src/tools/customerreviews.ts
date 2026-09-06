import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { summarizeResponse } from "#/client/shape";
import { appIdArg, compact, limitArg, savePathArg, territoryArg, wrapSaved } from "#/tools/util";

export const registerCustomerReviewTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  _allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_customer_reviews",
    {
      title: "App Store Connect: List Customer Reviews",
      description:
        "List customer reviews for an app — star rating, title, body, nickname, territory and " +
        "date, newest first by default. Filter by rating to read just the 1-star complaints, or " +
        "by territory to see whether a problem is local. Note these are written reviews only: " +
        "most people rate without writing, and Apple exposes no aggregate star average through " +
        "this API, so a distribution computed from these is directional, not the App Store rating.",
      inputSchema: z.object({
        appId: appIdArg,
        rating: z
          .array(z.number().int().min(1).max(5))
          .optional()
          .describe("Only these star ratings, e.g. [1,2] for the complaints."),
        territory: territoryArg.optional(),
        sort: z
          .enum(["-createdDate", "createdDate", "-rating", "rating"])
          .default("-createdDate")
          .describe("Defaults to newest first."),
        answered: z
          .boolean()
          .optional()
          .describe(
            "true for reviews you have already replied to, false for the unanswered ones. Omit " +
              "for both.",
          ),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, rating, territory, sort, answered, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/customerReviews`,
            compact({
              // buildQuery comma-joins arrays, which is what filter[rating] expects.
              "filter[rating]": rating?.map(String),
              "filter[territory]": territory,
              "exists[publishedResponse]": answered,
              sort,
              limit,
            }),
          ),
        ),
      ),
  );
};
