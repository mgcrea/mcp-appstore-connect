import { describe, expect, it, vi } from "vitest";

import type { Config } from "#/config";

import {
  baseConfig,
  callArgs,
  connect,
  deleteCall,
  jsonResponse,
  payloadOf,
  postCall,
} from "../helpers.js";

describe("customer reviews", () => {
  const APP_ID = "1234567890";

  it("lists newest-first and comma-joins the rating filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID, rating: [1, 2], territory: "FRA" },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/apps/${APP_ID}/customerReviews`);
    // JSON:API takes a comma-joined list here, not repeated keys.
    expect(url.searchParams.get("filter[rating]")).toBe("1,2");
    expect(url.searchParams.get("filter[territory]")).toBe("FRA");
    expect(url.searchParams.get("sort")).toBe("-createdDate");
  });

  it("omits the answered filter entirely when it is not asked for", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.searchParams.has("exists[publishedResponse]")).toBe(false);
    expect(url.searchParams.has("filter[rating]")).toBe(false);
  });

  it("passes answered:false through as the unanswered filter", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_customer_reviews",
      arguments: { appId: APP_ID, answered: false },
    });

    // `compact` drops undefined, not false — a `false` here is a real filter.
    expect(new URL(callArgs(fetchImpl)[0]).searchParams.get("exists[publishedResponse]")).toBe(
      "false",
    );
  });
});

describe("customer review replies", () => {
  const APP_ID = "1234567890";
  const REVIEW_ID = "review-1";
  const writeConfig: Config = { ...baseConfig, allowWrites: true };

  const reply = (body: string): unknown => ({
    data: {
      id: "resp-1",
      type: "customerReviewResponses",
      attributes: { responseBody: body, state: "PUBLISHED" },
    },
  });
  const noReply = (): Response => new Response(JSON.stringify({ errors: [] }), { status: 404 });

  it("puts each sideloaded reply back on the review it answers", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: "r1",
            type: "customerReviews",
            attributes: { rating: 1, body: "Crashes" },
            relationships: { response: { data: { type: "customerReviewResponses", id: "p1" } } },
          },
          { id: "r2", type: "customerReviews", attributes: { rating: 5, body: "Great" } },
        ],
        included: [
          {
            id: "p1",
            type: "customerReviewResponses",
            attributes: { responseBody: "Fixed in 1.2", state: "PUBLISHED" },
          },
        ],
      }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_customer_reviews",
        arguments: { appId: APP_ID },
      }),
    ) as { data: { id: string; response?: { responseBody: string } }[] };

    expect(new URL(callArgs(fetchImpl)[0]).searchParams.get("include")).toBe("response");
    expect(body.data[0]?.response?.responseBody).toBe("Fixed in 1.2");
    expect(body.data[1]).not.toHaveProperty("response");
  });

  it("refuses to reply without an explicit confirm", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(reply("x")));
    const client = await connect(writeConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_reply_to_customer_review",
      arguments: { reviewId: REVIEW_ID, responseBody: "Thanks!" },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the reply linked to the review", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? jsonResponse(reply("Thanks!")) : noReply(),
    );
    const client = await connect(writeConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_reply_to_customer_review",
        arguments: { reviewId: REVIEW_ID, responseBody: "Thanks!", confirm: true },
      }),
    );

    const post = postCall(fetchImpl, "/v1/customerReviewResponses");
    expect(JSON.parse(String(post?.[1].body))).toEqual({
      data: {
        type: "customerReviewResponses",
        attributes: { responseBody: "Thanks!" },
        relationships: { review: { data: { type: "customerReviews", id: REVIEW_ID } } },
      },
    });
    expect(body).not.toHaveProperty("replaced");
  });

  /** Apple's POST overwrites an existing reply without a word; the old text must not vanish silently. */
  it("reports the reply it overwrote", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      jsonResponse(init?.method === "POST" ? reply("New text") : reply("Old text")),
    );
    const client = await connect(writeConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_reply_to_customer_review",
        arguments: { reviewId: REVIEW_ID, responseBody: "New text", confirm: true },
      }),
    );

    expect(new URL(callArgs(fetchImpl, 0)[0]).pathname).toBe(
      `/v1/customerReviews/${REVIEW_ID}/response`,
    );
    expect(body.replaced).toBe("Old text");
  });

  it("deletes the review's reply by looking its id up", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : jsonResponse(reply("Bye")),
    );
    const client = await connect(writeConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_delete_customer_review_response",
        arguments: { reviewId: REVIEW_ID, confirm: true },
      }),
    );

    expect(new URL(deleteCall(fetchImpl)?.[0] ?? "").pathname).toBe(
      "/v1/customerReviewResponses/resp-1",
    );
    expect(body.deleted).toBe("Bye");
  });

  it.each([
    ["a 404", noReply],
    ["data: null", () => jsonResponse({ data: null })],
  ])("deletes nothing when the review has no reply (%s)", async (_label, answer) => {
    const fetchImpl = vi.fn(async () => answer());
    const client = await connect(writeConfig, fetchImpl as unknown as typeof fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_delete_customer_review_response",
        arguments: { reviewId: REVIEW_ID, confirm: true },
      }),
    );

    expect(body.deleted).toBeNull();
    expect(deleteCall(fetchImpl)).toBeUndefined();
  });
});

describe("get_rating_summary", () => {
  const APP_ID = "1234567890";

  const lookup = (results: unknown[]): Response =>
    new Response(JSON.stringify({ resultCount: results.length, results }), {
      status: 200,
      headers: { "content-type": "text/javascript" },
    });

  /** iTunes answers per storefront; the ASC host answers the review listing. */
  const routed = (
    storefronts: Record<string, Response | (() => Response)>,
    reviews: unknown[] = [],
  ): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.hostname === "itunes.apple.com") {
        const entry = storefronts[u.searchParams.get("country") ?? ""];
        if (entry === undefined) return lookup([]);
        return typeof entry === "function" ? entry() : entry.clone();
      }
      return jsonResponse({ data: reviews });
    });

  const call = async (
    fetchImpl: ReturnType<typeof vi.fn>,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_get_rating_summary",
      arguments: { appId: APP_ID, ...args },
    });
    expect(result.isError).toBeFalsy();
    return payloadOf(result);
  };

  it("converts alpha-3 territories to the lookup's alpha-2 storefronts", async () => {
    const fetchImpl = routed({
      fr: lookup([
        {
          trackId: 1234567890,
          version: "1.3.1",
          averageUserRating: 3.2,
          userRatingCount: 41,
          averageUserRatingForCurrentVersion: 1.5,
          userRatingCountForCurrentVersion: 2,
        },
      ]),
    });

    const body = await call(fetchImpl, { territories: ["FRA"] });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.origin + url.pathname).toBe("https://itunes.apple.com/lookup");
    expect(url.searchParams.get("id")).toBe(APP_ID);
    expect(url.searchParams.get("country")).toBe("fr");
    expect(body.storefronts).toEqual([
      {
        territory: "FRA",
        country: "FR",
        status: "RATED",
        averageUserRating: 3.2,
        userRatingCount: 41,
        currentVersion: { version: "1.3.1", averageUserRating: 1.5, userRatingCount: 2 },
      },
    ]);
    expect(String(body.note)).toContain("cached");
  });

  // "No ratings here" and "could not ask" lead to opposite decisions.
  it("keeps no ratings, not on the storefront, and a failed lookup distinct", async () => {
    const fetchImpl = routed({
      us: lookup([{ trackId: 1, userRatingCount: 0, averageUserRating: 0 }]),
      de: lookup([]),
      jp: () => new Response("busy", { status: 403 }),
    });

    const body = await call(fetchImpl, { territories: ["USA", "DEU", "JPN"] });

    const byTerritory = Object.fromEntries(
      (body.storefronts as Record<string, unknown>[]).map((s) => [s.territory, s]),
    );
    expect(byTerritory.USA).toMatchObject({ status: "NO_RATINGS" });
    expect(byTerritory.USA).not.toHaveProperty("averageUserRating");
    expect(byTerritory.DEU).toMatchObject({ status: "NOT_ON_STOREFRONT" });
    expect(byTerritory.JPN).toMatchObject({ status: "ERROR" });
    expect(String(byTerritory.JPN?.error)).toContain("403");
  });

  it("reports an unknown territory code as an error without asking", async () => {
    const fetchImpl = routed({});

    const body = await call(fetchImpl, { territories: ["ZZZ"] });

    expect(body.storefronts).toEqual([
      expect.objectContaining({ territory: "ZZZ", status: "ERROR" }),
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("defaults to the storefronts the latest written reviews come from", async () => {
    const review = (territory: string): unknown => ({
      type: "customerReviews",
      id: `r-${territory}-${Math.random()}`,
      attributes: { territory },
    });
    const fetchImpl = routed({}, [review("FRA"), review("FRA"), review("BEL"), review("FRA")]);

    const body = await call(fetchImpl);

    const reviewsUrl = new URL(callArgs(fetchImpl, 0)[0]);
    expect(reviewsUrl.pathname).toBe(`/v1/apps/${APP_ID}/customerReviews`);
    const countries = fetchImpl.mock.calls
      .map((c) => new URL(String(c[0])))
      .filter((u) => u.hostname === "itunes.apple.com")
      .map((u) => u.searchParams.get("country"));
    expect(countries).toEqual(["fr", "be"]);
    expect(String(body.territoriesFrom)).toContain("not read");
  });

  it("falls back to USA for an app with no written reviews, and says so", async () => {
    const fetchImpl = routed({});

    const body = await call(fetchImpl);

    expect((body.storefronts as Record<string, unknown>[])[0]).toMatchObject({
      territory: "USA",
    });
    expect(String(body.territoriesFrom)).toContain("no written reviews");
  });
});
