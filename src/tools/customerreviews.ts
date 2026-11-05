import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import {
  type Rec,
  attributesOf,
  includedIndex,
  isRecord,
  relatedId,
  resourceOf,
  resourcesOf,
  summarizeResource,
  summarizeResponse,
} from "#/client/shape";
import { toAlpha2 } from "#/tools/territories";
import {
  appIdArg,
  compact,
  confirmArg,
  getOrNull,
  limitArg,
  RATING_RESET_WEB_ONLY,
  savePathArg,
  territoryArg,
  wrap,
  wrapSaved,
} from "#/tools/util";

/** Apple's cap on a developer response, as the web UI enforces it. */
const RESPONSE_MAX_CHARS = 5970;

const reviewIdArg = z
  .string()
  .min(1)
  .describe("The customerReview id (from app_store_connect_list_customer_reviews).");

/**
 * `summarizeResponse` drops `included`, which for a review list is where the
 * replies are: `include=response` sideloads them, and each review only points
 * at its own by id. Put each reply back on the review it answers.
 */
const withResponses = (response: unknown): unknown => {
  const summary = summarizeResponse(response);
  if (!isRecord(summary) || !Array.isArray(summary.data)) return summary;
  const replies = includedIndex(response, "customerReviewResponses");
  const reviews = resourcesOf(response);
  return {
    ...summary,
    data: summary.data.map((row: unknown, index) => {
      const replyId = reviews[index] ? relatedId(reviews[index], "response") : undefined;
      const reply = replyId === undefined ? undefined : replies.get(replyId);
      return reply === undefined || !isRecord(row)
        ? row
        : { ...row, response: summarizeResource(reply) };
    }),
  };
};

/**
 * The reply currently on a review, or `undefined` when there is none. Apple
 * says "none" either as a 404 or as a 200 with `data: null`, depending on
 * whether the review ever had one, so both are read as absent.
 */
const currentReply = async (
  client: AppStoreConnectClient,
  reviewId: string,
): Promise<Rec | undefined> => {
  const reply = resourceOf(await getOrNull(client, `/v1/customerReviews/${reviewId}/response`));
  return typeof reply.id === "string" ? reply : undefined;
};

/** The public storefront lookup. Unauthenticated; see `getPublicJson`. */
const LOOKUP_URL = "https://itunes.apple.com/lookup";

/** Storefronts read when the caller names none, and the most one call will read. */
const DEFAULT_TERRITORY_COUNT = 10;
const MAX_TERRITORIES = 50;

const RATING_SOURCE_NOTE =
  "Public data from Apple's iTunes Lookup API, not from App Store Connect: what a customer's " +
  "store page shows, cached by Apple (it can lag the store by hours) and possibly rounded, so " +
  "treat small differences as noise. Counts include star-only ratings, which " +
  "app_store_connect_list_customer_reviews never sees. There is no per-star breakdown here. " +
  "`currentVersion` is NOT the ratings given to that version alone: the summary carries over " +
  "from version to version, so it matches the overall figures unless the summary was reset " +
  "when that version was released. " +
  "NO_RATINGS means the app is on that storefront with no rating shown yet; " +
  "NOT_ON_STOREFRONT means the lookup did not find the app there at all (not sold there, or " +
  "not indexed yet); ERROR means the lookup itself failed and says nothing about ratings.";

type StorefrontRating = Rec & {
  territory: string;
  status: "RATED" | "NO_RATINGS" | "NOT_ON_STOREFRONT" | "ERROR";
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** One storefront's rating, keeping "nothing to show" apart from "could not ask". */
const lookupRating = async (
  client: AppStoreConnectClient,
  appId: string,
  territory: string,
): Promise<StorefrontRating> => {
  const country = toAlpha2(territory);
  if (country === undefined) {
    return { territory, status: "ERROR", error: `Unknown territory code "${territory}".` };
  }
  const url = `${LOOKUP_URL}?id=${encodeURIComponent(appId)}&country=${country.toLowerCase()}`;
  let response: unknown;
  try {
    response = await client.getPublicJson(url);
  } catch (err) {
    return {
      territory,
      country,
      status: "ERROR",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const results = isRecord(response) && Array.isArray(response.results) ? response.results : [];
  const app = results.find(isRecord);
  if (app === undefined) return { territory, country, status: "NOT_ON_STOREFRONT" };

  const average = num(app.averageUserRating);
  const count = num(app.userRatingCount);
  const currentAverage = num(app.averageUserRatingForCurrentVersion);
  const currentCount = num(app.userRatingCountForCurrentVersion);
  const rated = average !== undefined && count !== undefined && count > 0;
  return {
    territory,
    country,
    status: rated ? "RATED" : "NO_RATINGS",
    ...(rated ? { averageUserRating: average, userRatingCount: count } : {}),
    ...(currentAverage !== undefined || currentCount !== undefined
      ? {
          currentVersion: compact({
            version: app.version,
            averageUserRating: currentAverage,
            userRatingCount: currentCount,
          }),
        }
      : {}),
  };
};

/**
 * The storefronts worth asking about when the caller names none: the ones its
 * written reviews come from, most first. Asking all ~175 would trip the lookup
 * API's rate limit, and a storefront nobody reviews in is rarely the question.
 */
const reviewedTerritories = async (
  client: AppStoreConnectClient,
  appId: string,
): Promise<string[]> => {
  const reviews = resourcesOf(
    await client.get(`/v1/apps/${appId}/customerReviews`, {
      "fields[customerReviews]": "territory",
      sort: "-createdDate",
      limit: 200,
    }),
  );
  const counts = new Map<string, number>();
  for (const review of reviews) {
    const territory = attributesOf(review).territory;
    if (typeof territory === "string") counts.set(territory, (counts.get(territory) ?? 0) + 1);
  }
  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, DEFAULT_TERRITORY_COUNT)
    .map(([territory]) => territory);
};

export const registerCustomerReviewTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_customer_reviews",
    {
      title: "App Store Connect: List Customer Reviews",
      description:
        "List customer reviews for an app — star rating, title, body, nickname, territory and " +
        "date, newest first by default. Filter by rating to read just the 1-star complaints, or " +
        "by territory to see whether a problem is local. A review you have replied to carries " +
        "that reply as `response` (body, state, last modified); a review without one has no " +
        "`response` key. Note these are written reviews only: " +
        "most people rate without writing, and Apple exposes no aggregate star average through " +
        "this API, so a distribution computed from these is directional, not the App Store rating. " +
        "For the rating customers actually see, use app_store_connect_get_rating_summary.",
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
        withResponses(
          await client.get(
            `/v1/apps/${appId}/customerReviews`,
            compact({
              // buildQuery comma-joins arrays, which is what filter[rating] expects.
              "filter[rating]": rating?.map(String),
              "filter[territory]": territory,
              "exists[publishedResponse]": answered,
              include: "response",
              sort,
              limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_rating_summary",
    {
      title: "App Store Connect: Get Rating Summary",
      description:
        "Get the star rating customers see on the App Store, per storefront: the average and " +
        "the number of ratings (star-only ones included), plus the current version's own figures " +
        "where Apple publishes them. App Store Connect's API has no aggregate rating, so this " +
        "reads Apple's PUBLIC iTunes Lookup API instead: cached, possibly rounded, and no " +
        "per-star breakdown. It is the input for deciding whether resetting the rating summary " +
        `is worth it. ${RATING_RESET_WEB_ONLY} ` +
        "Each storefront has a `status`: RATED, NO_RATINGS (on sale there, nothing shown yet), " +
        "NOT_ON_STOREFRONT (the lookup did not find the app there), or ERROR (the lookup failed, " +
        "which says nothing about ratings). Omit `territories` to read the storefronts the app's " +
        `latest written reviews come from (top ${DEFAULT_TERRITORY_COUNT}, USA when there are ` +
        "none); the response says which were read and why.",
      inputSchema: z.object({
        appId: appIdArg,
        territories: z
          .array(territoryArg)
          .min(1)
          .max(MAX_TERRITORIES)
          .optional()
          .describe(
            'Storefronts to read (ISO-3166-1 alpha-3), e.g. ["USA","FRA"]. At most ' +
              `${MAX_TERRITORIES}. Omit to pick them from where the app's reviews come from.`,
          ),
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ appId, territories, savePath }) =>
      wrapSaved(savePath, async () => {
        let picked = territories?.map((t) => t.toUpperCase());
        let territoriesFrom = "requested";
        if (picked === undefined) {
          const reviewed = await reviewedTerritories(client, appId);
          picked = reviewed.length > 0 ? reviewed : ["USA"];
          territoriesFrom =
            reviewed.length > 0
              ? `the ${reviewed.length} storefront(s) with the most of the app's latest 200 ` +
                `written reviews; ratings in other storefronts were not read`
              : "USA, because the app has no written reviews to pick storefronts from";
        }
        const unique = [...new Set(picked)];
        // Sequential: the lookup API rate-limits per caller, and ten storefronts
        // a second apart is still a fast answer.
        const storefronts: StorefrontRating[] = [];
        for (const territory of unique) {
          storefronts.push(await lookupRating(client, appId, territory));
        }
        return {
          appId,
          source: "itunes-lookup",
          territoriesFrom,
          storefronts,
          note: RATING_SOURCE_NOTE,
          reset: RATING_RESET_WEB_ONLY,
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_reply_to_customer_review",
    {
      title: "App Store Connect: Reply to Customer Review",
      description:
        "Publish a developer reply under a customer review on the App Store. The reply is " +
        "public and shows up after a delay, and the reviewer is notified. A review holds one " +
        "reply only, so replying to an answered review OVERWRITES the existing reply: the one " +
        "it replaced is returned as `replaced`. Read the current one first with " +
        "app_store_connect_list_customer_reviews, where it is `response`.",
      inputSchema: z.object({
        reviewId: reviewIdArg,
        responseBody: z
          .string()
          .trim()
          .min(1)
          .max(RESPONSE_MAX_CHARS)
          .describe(
            `The reply text, as customers will read it. At most ${RESPONSE_MAX_CHARS} characters.`,
          ),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ reviewId, responseBody }) =>
      wrap(async () => {
        // Read before writing only to report what gets overwritten: Apple's POST
        // replaces an existing reply silently, and a public reply lost that way
        // cannot be recovered from anywhere else.
        const previous = await currentReply(client, reviewId);
        const created = await client.post("/v1/customerReviewResponses", {
          data: {
            type: "customerReviewResponses",
            attributes: { responseBody },
            relationships: { review: { data: { type: "customerReviews", id: reviewId } } },
          },
        });
        return {
          reviewId,
          ...(summarizeResponse(created) as Rec),
          ...(previous !== undefined ? { replaced: attributesOf(previous).responseBody } : {}),
        };
      }),
  );

  server.registerTool(
    "app_store_connect_delete_customer_review_response",
    {
      title: "App Store Connect: Delete Customer Review Response",
      description:
        "Remove your reply from a customer review. Takes the review id and looks the reply up " +
        "itself; the deleted text is returned as `deleted`. The reply disappears from the App " +
        "Store after a delay. To change a reply, use app_store_connect_reply_to_customer_review " +
        "instead, which overwrites it in place.",
      inputSchema: z.object({ reviewId: reviewIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ reviewId }) =>
      wrap(async () => {
        const reply = await currentReply(client, reviewId);
        if (reply === undefined) {
          return { deleted: null, reviewId, note: "This review has no reply." };
        }
        await client.del(`/v1/customerReviewResponses/${String(reply.id)}`);
        return { deleted: attributesOf(reply).responseBody, responseId: reply.id, reviewId };
      }),
  );
};
