import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import {
  attributesOf,
  includedOf,
  relatedId,
  resourceOf,
  resourcesOf,
  summarizeResponse,
} from "#/client/shape";
import {
  appIdArg,
  compact,
  confirmArg,
  getOrNull,
  limitArg,
  PreconditionError,
  savePathArg,
  territoryArg,
  wrap,
  wrapSaved,
} from "#/tools/util";

// The app's OWN price is a separate resource from any in-app purchase's, and
// having priced the IAP does nothing for it: a version cannot be submitted until
// /v2/appPrices has a schedule, and Apple reports that as
// STATE_ERROR.APP_PRICING_REQUIRED with no pointer to which resource is meant.
// A free app still has to say so — "free" is a price point, not the absence of
// one, which is why an app nobody ever charged for is still blocked.

/**
 * Apple's own maximum for the manualPrices endpoints. It comfortably exceeds the
 * ~175 territories a fully manual schedule can name, so one page is the whole
 * schedule in practice — but `manualPriceNote` says so rather than assuming it.
 */
export const MANUAL_PRICE_LIMIT = 200;

/** Never let a page read as the whole schedule when it might not be. */
export const manualPriceNote = (response: unknown): { manualPricesNote?: string } =>
  resourcesOf(response).length >= MANUAL_PRICE_LIMIT
    ? {
        manualPricesNote:
          `Exactly ${MANUAL_PRICE_LIMIT} prices came back, which is Apple's page maximum, so ` +
          `this list may be incomplete. Read the schedule's manualPrices directly if the ` +
          `missing territories matter.`,
      }
    : {};

/**
 * A price point id names a fixed amount in one territory, so pricing an app with
 * an id from the wrong territory silently charges the wrong amount. Apple accepts
 * that request, so the only place it can be caught is here, before the POST.
 */
const assertPricePointBelongs = async (
  client: AppStoreConnectClient,
  appId: string,
  pricePointId: string,
  territory: string,
): Promise<Record<string, unknown>> => {
  const { data } = await client.getAll<Record<string, unknown>>(
    `/v1/apps/${appId}/appPricePoints`,
    {
      "filter[territory]": territory,
      limit: 200,
    },
  );

  const match = data.find((point) => point.id === pricePointId);
  if (match !== undefined) return attributesOf(match);

  throw new PreconditionError(
    `Price point ${pricePointId} is not one of this app's ${territory} price points. List them ` +
      `with app_store_connect_list_app_price_points and pass an id from that response.`,
    { appId, pricePointId, territory, availablePricePoints: data.length },
  );
};

/**
 * Flatten a `manualPrices` collection into rows that carry the actual money.
 *
 * An `appPrice` / `inAppPurchasePrice` has almost no attributes of its own: the
 * amount lives on the related price point and the territory on a related
 * territory, so both are reachable only by sideloading. Ask for the prices alone
 * and Apple returns neither relationship, `relatedId` yields `undefined` at every
 * hop, and `JSON.stringify` drops undefined keys, so `territory` and
 * `pricePointId` do not come back *absent*, they come back invisible. The result
 * is a price schedule that answers "what does this app cost" with an opaque id
 * and nothing else, leaving the caller to base64-decode the id or page hundreds
 * of price points to find out that the app is free.
 *
 * The sideload cannot happen on the schedule resource. `GET
 * /v1/apps/{id}/appPriceSchedule` accepts exactly `app`, `baseTerritory`,
 * `manualPrices` and `automaticPrices` as `include` values — no nested paths, and
 * not even a `fields[appPricePoints]` to hang them off — so asking it for
 * `manualPrices.appPricePoint` is an HTTP 400, not a deeper answer. The same is
 * true of `/v2/inAppPurchases/{id}/iapPriceSchedule`. The prices therefore have
 * to be fetched from the schedule's own `manualPrices` endpoint, which does take
 * `include=appPricePoint,territory`, and this reads that second response: rows in
 * `data`, price points sideloaded in `included`.
 */
export const manualPriceRows = (
  response: unknown,
  pricePointRelationship: string,
  pricePointType: string,
): Record<string, unknown>[] => {
  const pricePoints = new Map<string, Record<string, unknown>>();
  for (const point of includedOf(response, pricePointType)) {
    if (typeof point.id === "string") pricePoints.set(point.id, attributesOf(point));
  }

  return resourcesOf(response).map((price) => {
    const pricePointId = relatedId(price, pricePointRelationship);
    const point = pricePointId === undefined ? undefined : pricePoints.get(pricePointId);
    return {
      id: price.id,
      ...attributesOf(price),
      ...compact({
        territory: relatedId(price, "territory"),
        pricePointId,
        customerPrice: point?.customerPrice,
        proceeds: point?.proceeds,
      }),
    };
  });
};

export const registerPricingTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_app_price_points",
    {
      title: "App Store Connect: List App Price Points",
      description:
        "List the price points an app can be sold at in one territory, each with its customer " +
        "price and your proceeds. Returns the appPricePoints ids that " +
        "app_store_connect_set_app_price takes. A free app uses the price point whose " +
        "customerPrice is 0 — filter for it rather than assuming an id.",
      inputSchema: z.object({
        appId: appIdArg,
        territory: territoryArg.describe(
          'Territory to list prices for, e.g. "USA". Price points are per-territory, and the ' +
            "one you pass here must be the same territory you later set as baseTerritory.",
        ),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, territory, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/appPricePoints`,
            compact({ "filter[territory]": territory, limit }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_app_price_schedule",
    {
      title: "App Store Connect: Get App Price Schedule",
      description:
        "Show what an app currently costs: its base territory and every manual price in force, " +
        "each with its territory, its customerPrice and proceeds, and its start/end date. A " +
        "customerPrice of 0 is how a free app is priced. A null result means the app has never " +
        "been priced, which blocks submission — this is the check for " +
        "STATE_ERROR.APP_PRICING_REQUIRED.",
      inputSchema: z.object({ appId: appIdArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, savePath }) =>
      wrapSaved(savePath, async () => {
        // The schedule resource carries nothing but relationships, so a price is
        // only legible once its price point is sideloaded — and that sideload is
        // not available here, only on the manualPrices endpoint. See
        // manualPriceRows for why this is two calls and not one include.
        const response = await getOrNull(client, `/v1/apps/${appId}/appPriceSchedule`, {
          include: "baseTerritory",
        });
        if (response === null) {
          return {
            data: null,
            note:
              "This app has never been priced, so it cannot be submitted. Set a price with " +
              "app_store_connect_set_app_price — a free app needs the 0 price point, not no price.",
          };
        }
        const schedule = resourceOf(response);
        const prices = await client.get(`/v1/appPriceSchedules/${schedule.id}/manualPrices`, {
          include: "appPricePoint,territory",
          limit: MANUAL_PRICE_LIMIT,
        });

        return {
          scheduleId: schedule.id,
          baseTerritory: relatedId(schedule, "baseTerritory"),
          manualPrices: manualPriceRows(prices, "appPricePoint", "appPricePoints"),
          ...manualPriceNote(prices),
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_set_app_price",
    {
      title: "App Store Connect: Set App Price",
      description:
        "Set what an app costs, by pointing it at a price point from " +
        "app_store_connect_list_app_price_points. Prices in every other territory are derived " +
        "from the base territory automatically, per Apple's equalization table. This REPLACES " +
        "the app's whole price schedule — any manual price already set is dropped — and once the " +
        "start date arrives it changes what real customers are charged. Omit startDate to price " +
        "it immediately. To make an app free, pass the price point whose customerPrice is 0.",
      inputSchema: z.object({
        appId: appIdArg,
        pricePointId: z
          .string()
          .min(1)
          .describe(
            "The appPricePoint id to charge (from app_store_connect_list_app_price_points). " +
              "Must belong to baseTerritory.",
          ),
        baseTerritory: territoryArg.describe(
          "The territory the price point belongs to and that every other territory is derived " +
            'from, e.g. "USA". Must match the territory you listed price points for.',
        ),
        startDate: z
          .string()
          .optional()
          .describe(
            'Date the price takes effect, "YYYY-MM-DD". Omit to apply it as soon as Apple ' +
              "processes the change.",
          ),
        endDate: z
          .string()
          .optional()
          .describe('Date the price stops applying, "YYYY-MM-DD". Omit to leave it open-ended.'),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ appId, pricePointId, baseTerritory, startDate, endDate }) =>
      wrap(async () => {
        const pricePoint = await assertPricePointBelongs(
          client,
          appId,
          pricePointId,
          baseTerritory,
        );

        // JSON:API inline create: `manualPrices` points at a placeholder id that
        // only resolves against the matching entry in `included`.
        const placeholder = "${new-price}";
        const response = await client.post("/v1/appPriceSchedules", {
          data: {
            type: "appPriceSchedules",
            relationships: {
              app: { data: { type: "apps", id: appId } },
              baseTerritory: { data: { type: "territories", id: baseTerritory } },
              manualPrices: { data: [{ type: "appPrices", id: placeholder }] },
            },
          },
          included: [
            {
              type: "appPrices",
              id: placeholder,
              attributes: compact({ startDate, endDate }),
              relationships: {
                appPricePoint: { data: { type: "appPricePoints", id: pricePointId } },
              },
            },
          ],
        });

        // Echo the price we just set — the response is relationships only, so
        // without this the caller never sees which amount landed.
        return {
          ...(summarizeResponse(response) as Record<string, unknown>),
          priced: {
            pricePointId,
            baseTerritory,
            customerPrice: pricePoint.customerPrice,
            proceeds: pricePoint.proceeds,
            startDate: startDate ?? "immediate",
          },
        };
      }),
  );
};
