import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
  baseConfig,
  callArgs,
  connect,
  jsonResponse,
  patchCall,
  payloadOf,
  postCall,
} from "../helpers.js";

describe("in-app purchase pricing", () => {
  const IAP_ID = "6f4d2c1a-0000-4000-8000-000000000001";
  const PRICE_POINT_ID = "eyJzIjoiNjc0NCIsInQiOiJVU0EiLCJwIjoiMTAwMDgifQ";

  const pricePointsBody = (): unknown => ({
    data: [
      {
        id: PRICE_POINT_ID,
        type: "inAppPurchasePricePoints",
        attributes: { customerPrice: "4.99", proceeds: "3.49" },
      },
      {
        id: "other-point",
        type: "inAppPurchasePricePoints",
        attributes: { customerPrice: "9.99", proceeds: "6.99" },
      },
    ],
  });

  /** Price-point lookups are the preflight; the POST is the schedule create. */
  const routed = (points: unknown = pricePointsBody()): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      if (String(url).includes("/pricePoints")) return jsonResponse(points);
      return jsonResponse({ data: { id: "sched-1", type: "inAppPurchasePriceSchedules" } });
    });

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  it("builds the inline-create schedule and echoes the price it set", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_set_in_app_purchase_price",
      {
        inAppPurchaseId: IAP_ID,
        pricePointId: PRICE_POINT_ID,
        baseTerritory: "USA",
        confirm: true,
      },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const post = postCall(fetchImpl, "/v1/inAppPurchasePriceSchedules");
    const body = JSON.parse(String(post?.[1].body));

    // The placeholder in manualPrices must match the included price's id, or
    // Apple resolves the relationship to nothing.
    const placeholder = body.data.relationships.manualPrices.data[0].id;
    expect(body.included[0].id).toBe(placeholder);
    expect(body.data.relationships.inAppPurchase.data).toEqual({
      type: "inAppPurchases",
      id: IAP_ID,
    });
    expect(body.data.relationships.baseTerritory.data).toEqual({
      type: "territories",
      id: "USA",
    });
    expect(body.included[0].relationships.inAppPurchasePricePoint.data).toEqual({
      type: "inAppPurchasePricePoints",
      id: PRICE_POINT_ID,
    });
    // startDate omitted means "now" — it must not be sent as null.
    expect(body.included[0].attributes).toEqual({});

    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text).priced).toEqual({
      pricePointId: PRICE_POINT_ID,
      baseTerritory: "USA",
      customerPrice: "4.99",
      proceeds: "3.49",
      startDate: "immediate",
    });
  });

  it("passes start and end dates through as attributes", async () => {
    const fetchImpl = routed();

    await callTool(
      "app_store_connect_set_in_app_purchase_price",
      {
        inAppPurchaseId: IAP_ID,
        pricePointId: PRICE_POINT_ID,
        baseTerritory: "USA",
        startDate: "2026-09-01",
        endDate: "2026-12-31",
        confirm: true,
      },
      fetchImpl,
    );

    const body = JSON.parse(
      String(postCall(fetchImpl, "/v1/inAppPurchasePriceSchedules")?.[1].body),
    );
    expect(body.included[0].attributes).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-12-31",
    });
  });

  it("refuses a price point from another territory without pricing anything", async () => {
    // The IAP's USA catalogue simply does not contain the requested id.
    const fetchImpl = routed({ data: [] });

    const result = await callTool(
      "app_store_connect_set_in_app_purchase_price",
      {
        inAppPurchaseId: IAP_ID,
        pricePointId: PRICE_POINT_ID,
        baseTerritory: "USA",
        confirm: true,
      },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain(PRICE_POINT_ID);
    expect(postCall(fetchImpl, "/v1/inAppPurchasePriceSchedules")).toBeUndefined();
  });

  it("requires confirm before changing a price", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_set_in_app_purchase_price",
      { inAppPurchaseId: IAP_ID, pricePointId: PRICE_POINT_ID, baseTerritory: "USA" },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("filters price points by territory", async () => {
    const fetchImpl = routed();

    const result = await callTool(
      "app_store_connect_list_iap_price_points",
      { inAppPurchaseId: IAP_ID, territory: "FRA" },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const url = new URL(String(callArgs(fetchImpl)[0]));
    expect(url.pathname).toBe(`/v2/inAppPurchases/${IAP_ID}/pricePoints`);
    expect(url.searchParams.get("filter[territory]")).toBe("FRA");
  });

  it("flattens the price schedule's sideloaded prices", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/manualPrices")
        ? jsonResponse({
            data: [
              {
                id: "price-1",
                type: "inAppPurchasePrices",
                attributes: { startDate: "2026-09-01", endDate: null, manual: true },
                relationships: {
                  territory: { data: { id: "USA", type: "territories" } },
                  inAppPurchasePricePoint: {
                    data: { id: PRICE_POINT_ID, type: "inAppPurchasePricePoints" },
                  },
                },
              },
            ],
            included: [
              {
                id: PRICE_POINT_ID,
                type: "inAppPurchasePricePoints",
                attributes: { customerPrice: "4.99", proceeds: "3.49" },
              },
              { id: "USA", type: "territories", attributes: { currency: "USD" } },
            ],
          })
        : jsonResponse({
            data: {
              id: "sched-1",
              type: "inAppPurchasePriceSchedules",
              relationships: { baseTerritory: { data: { id: "USA", type: "territories" } } },
            },
          }),
    );

    const result = await callTool(
      "app_store_connect_get_iap_price_schedule",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}")).toEqual({
      scheduleId: "sched-1",
      baseTerritory: "USA",
      manualPrices: [
        {
          id: "price-1",
          startDate: "2026-09-01",
          endDate: null,
          manual: true,
          territory: "USA",
          pricePointId: PRICE_POINT_ID,
          customerPrice: "4.99",
          proceeds: "3.49",
        },
      ],
    });

    // Same 400 as the app-side schedule: /v2/inAppPurchases/{id}/iapPriceSchedule
    // takes only baseTerritory / manualPrices / automaticPrices, so the price
    // point can only be sideloaded on the schedule's own manualPrices endpoint.
    const includes = fetchImpl.mock.calls.map(
      (call) => new URL(String(call[0])).searchParams.get("include") ?? "",
    );
    expect(includes.every((include) => !include.includes("."))).toBe(true);
    expect(includes[1]).toBe("inAppPurchasePricePoint,territory");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      "/v1/inAppPurchasePriceSchedules/sched-1/manualPrices",
    );
  });

  it("reports an unpriced IAP as an empty price list", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/manualPrices")
        ? jsonResponse({ data: [] })
        : jsonResponse({ data: { id: "sched-1", type: "inAppPurchasePriceSchedules" } }),
    );

    const result = await callTool(
      "app_store_connect_get_iap_price_schedule",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(
      JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}").manualPrices,
    ).toEqual([]);
  });
});

describe("in-app purchase metadata", () => {
  const IAP_ID = "6f4d2c1a-0000-4000-8000-000000000001";
  const LOC_ID = "1a2b3c4d-0000-4000-8000-000000000002";

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  const okFetch = (body: unknown = { data: { id: LOC_ID, type: "inAppPurchaseLocalizations" } }) =>
    vi.fn(async () => jsonResponse(body));

  it("patches familySharable onto the v2 resource", async () => {
    const fetchImpl = okFetch({ data: { id: IAP_ID, type: "inAppPurchases" } });

    const result = await callTool(
      "app_store_connect_update_in_app_purchase",
      { inAppPurchaseId: IAP_ID, familySharable: true, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const patch = patchCall(fetchImpl);
    expect(new URL(String(patch?.[0])).pathname).toBe(`/v2/inAppPurchases/${IAP_ID}`);
    const body = JSON.parse(String(patch?.[1].body));
    expect(body.data.type).toBe("inAppPurchases");
    expect(body.data.attributes).toEqual({ familySharable: true });
    // `confirm` is a gate, not an attribute — sending it would 409.
    expect(body.data.attributes.confirm).toBeUndefined();
  });

  // The reference name is internal and allows 64 characters; 30 is the
  // customer-facing display name's limit, on the localization.
  it("takes a reference name up to Apple's 64 characters, and refuses past it", async () => {
    const accepted = okFetch({ data: { id: IAP_ID, type: "inAppPurchases" } });
    const ok = await callTool(
      "app_store_connect_update_in_app_purchase",
      { inAppPurchaseId: IAP_ID, name: "x".repeat(64), confirm: true },
      accepted,
    );
    expect(ok.isError).toBeFalsy();
    expect(patchCall(accepted)).toBeDefined();

    const refused = okFetch();
    const tooLong = await callTool(
      "app_store_connect_update_in_app_purchase",
      { inAppPurchaseId: IAP_ID, name: "x".repeat(65), confirm: true },
      refused,
    );
    expect(tooLong.isError).toBe(true);
    expect((tooLong.content as { text: string }[])[0]?.text ?? "").toContain("64-character");
    expect(patchCall(refused)).toBeUndefined();
  });

  it("creates a localization through the inAppPurchaseV2 relationship", async () => {
    const fetchImpl = okFetch();

    const result = await callTool(
      "app_store_connect_create_iap_localization",
      {
        inAppPurchaseId: IAP_ID,
        locale: "en-US",
        name: "Cadence Pro",
        description: "Every engine, batch queue and export.",
        confirm: true,
      },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(
      String(postCall(fetchImpl, "/v1/inAppPurchaseLocalizations")?.[1].body),
    );
    expect(body.data.type).toBe("inAppPurchaseLocalizations");
    expect(body.data.attributes).toEqual({
      name: "Cadence Pro",
      locale: "en-US",
      description: "Every engine, batch queue and export.",
    });
    // The relationship key is `inAppPurchaseV2`; `inAppPurchase` is rejected.
    expect(body.data.relationships.inAppPurchaseV2.data).toEqual({
      type: "inAppPurchases",
      id: IAP_ID,
    });
  });

  it("refuses an over-length name before calling Apple", async () => {
    const fetchImpl = okFetch();

    const result = await callTool(
      "app_store_connect_create_iap_localization",
      { inAppPurchaseId: IAP_ID, locale: "en-US", name: "x".repeat(31), confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("30-character");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an over-length description before calling Apple", async () => {
    const fetchImpl = okFetch();

    const result = await callTool(
      "app_store_connect_update_iap_localization",
      { localizationId: LOC_ID, description: "y".repeat(46), confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("45-character");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to submit an IAP that is still MISSING_METADATA", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { id: IAP_ID, type: "inAppPurchases", attributes: { state: "MISSING_METADATA" } },
      }),
    );

    const result = await callTool(
      "app_store_connect_submit_in_app_purchase_for_review",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("MISSING_METADATA");
    expect(postCall(fetchImpl, "/v1/inAppPurchaseSubmissions")).toBeUndefined();
  });

  it("submits an IAP that is READY_TO_SUBMIT", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ data: { id: "sub-1", type: "inAppPurchaseSubmissions" } });
      }
      return jsonResponse({
        data: { id: IAP_ID, type: "inAppPurchases", attributes: { state: "READY_TO_SUBMIT" } },
      });
    });

    const result = await callTool(
      "app_store_connect_submit_in_app_purchase_for_review",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(String(postCall(fetchImpl, "/v1/inAppPurchaseSubmissions")?.[1].body));
    expect(body.data.relationships.inAppPurchaseV2.data.id).toBe(IAP_ID);
  });
});

describe("in-app purchase availability", () => {
  const IAP_ID = "6f4d2c1a-0000-4000-8000-000000000001";

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    fetchImpl: ReturnType<typeof vi.fn>,
  ): ReturnType<Client["callTool"]> => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    return client.callTool({ name, arguments: args });
  };

  it("reports data:null when availability has never been set", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: null }));

    const result = await callTool(
      "app_store_connect_get_iap_availability",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(payloadOf(result).data).toBeNull();
  });

  it("resolves every territory when none are named", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ data: { id: "avail-1", type: "inAppPurchaseAvailabilities" } });
      }
      return jsonResponse({
        data: [
          { id: "USA", type: "territories" },
          { id: "FRA", type: "territories" },
        ],
      });
    });

    const result = await callTool(
      "app_store_connect_set_iap_availability",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(
      String(postCall(fetchImpl, "/v1/inAppPurchaseAvailabilities")?.[1].body),
    );
    // This endpoint uses `inAppPurchase`, unlike the localization and submission
    // endpoints which use `inAppPurchaseV2`.
    expect(body.data.relationships.inAppPurchase.data).toEqual({
      type: "inAppPurchases",
      id: IAP_ID,
    });
    expect(body.data.relationships.availableTerritories.data).toEqual([
      { type: "territories", id: "USA" },
      { type: "territories", id: "FRA" },
    ]);
    expect(body.data.attributes.availableInNewTerritories).toBe(true);
  });

  it("follows every page of the territory catalogue for 'everywhere'", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ data: { id: "avail-1", type: "inAppPurchaseAvailabilities" } });
      }
      return url.includes("cursor=")
        ? jsonResponse({ data: [{ id: "JPN", type: "territories" }] })
        : jsonResponse({
            data: [{ id: "USA", type: "territories" }],
            links: { next: "https://api.appstoreconnect.apple.com/v1/territories?cursor=AQ" },
          });
    });

    await callTool(
      "app_store_connect_set_iap_availability",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    const body = JSON.parse(
      String(postCall(fetchImpl, "/v1/inAppPurchaseAvailabilities")?.[1].body),
    );
    expect(body.data.relationships.availableTerritories.data).toEqual([
      { type: "territories", id: "USA" },
      { type: "territories", id: "JPN" },
    ]);
  });

  it("reads a never-attached review screenshot 404 as nothing, not an error", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ status: "404", code: "NOT_FOUND" }] }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await callTool(
      "app_store_connect_get_iap_review_screenshot",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    expect(payloadOf(result).data).toBeNull();
  });

  it("reads a never-set availability 404 as 'not set', not an error", async () => {
    // Apple 404s a to-one sub-resource that was never created, and names the
    // PARENT's id in the message — raw, that reads as a broken request.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errors: [
              {
                status: "404",
                code: "NOT_FOUND",
                detail:
                  "There is no resource of type 'inAppPurchaseAvailabilities' with id '" +
                  IAP_ID +
                  "'",
              },
            ],
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await callTool(
      "app_store_connect_get_iap_availability",
      { inAppPurchaseId: IAP_ID },
      fetchImpl,
    );

    expect(result.isError).toBeFalsy();
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("never been set");
  });

  it("says when the territory list is one page of several", async () => {
    // "Everywhere" is ~175 territories, so the default limit of 50 cuts it short.
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes("/availableTerritories")
        ? jsonResponse({
            data: [{ id: "USA", type: "territories" }],
            meta: { paging: { total: 175, limit: 1 } },
            links: { next: "https://api.appstoreconnect.apple.com/next" },
          })
        : jsonResponse({ data: { id: "avail-1", type: "inAppPurchaseAvailabilities" } }),
    );

    const result = await callTool(
      "app_store_connect_get_iap_availability",
      { inAppPurchaseId: IAP_ID, limit: 1 },
      fetchImpl,
    );

    const body = payloadOf(result) as { incomplete?: { missing: number } };
    expect(body.incomplete?.missing).toBe(174);
  });

  it("refuses to make an IAP available nowhere", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));

    const result = await callTool(
      "app_store_connect_set_iap_availability",
      { inAppPurchaseId: IAP_ID, confirm: true },
      fetchImpl,
    );

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text ?? "").toContain("available nowhere");
    expect(postCall(fetchImpl, "/v1/inAppPurchaseAvailabilities")).toBeUndefined();
  });
});
