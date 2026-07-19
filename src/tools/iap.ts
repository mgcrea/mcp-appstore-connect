import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import {
  attributesOf,
  includedOf,
  relatedId,
  resourceOf,
  summarizeResponse,
} from "../client/shape.js";
import { PreconditionError, appIdArg, compact, confirmArg, limitArg, wrap } from "./util.js";

const IAP_TYPES = ["CONSUMABLE", "NON_CONSUMABLE", "NON_RENEWING_SUBSCRIPTION"] as const;

const inAppPurchaseIdArg = z
  .string()
  .min(1)
  .describe(
    "The inAppPurchase id (from app_store_connect_list_in_app_purchases), NOT the productId string.",
  );

/**
 * Apple keys territories by ISO-3166-1 alpha-3, and the base territory decides
 * which price point id is meaningful — a price point belongs to exactly one
 * territory, so USA's $4.99 and FRA's 5,99 € are different resources.
 */
const territoryArg = z
  .string()
  .length(3)
  .describe('Territory code (ISO-3166-1 alpha-3), e.g. "USA", "FRA", "JPN".');

/**
 * A price point id names a fixed amount in one territory, so pricing an IAP with
 * an id from the wrong territory silently charges the wrong amount. Apple accepts
 * that request, so the only place it can be caught is here, before the POST.
 */
const assertPricePointBelongs = async (
  client: AppStoreConnectClient,
  inAppPurchaseId: string,
  pricePointId: string,
  territory: string,
): Promise<Record<string, unknown>> => {
  const { data } = await client.getAll<Record<string, unknown>>(
    `/v2/inAppPurchases/${inAppPurchaseId}/pricePoints`,
    { "filter[territory]": territory, limit: 200 },
  );

  const match = data.find((point) => point.id === pricePointId);
  if (match !== undefined) return attributesOf(match);

  throw new PreconditionError(
    `Price point ${pricePointId} is not one of this in-app purchase's ${territory} price ` +
      `points. List them with app_store_connect_list_iap_price_points and pass an id from ` +
      `that response.`,
    { inAppPurchaseId, pricePointId, territory, availablePricePoints: data.length },
  );
};

export const registerIapTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_in_app_purchases",
    {
      description:
        "List an app's in-app purchases (name, productId, type, review state). Returns the " +
        "inAppPurchase ids the pricing tools take. Covers one-time purchases only — " +
        "auto-renewable subscriptions live under subscription groups and are not exposed here.",
      inputSchema: {
        appId: appIdArg,
        productId: z.string().optional().describe('Filter by productId, e.g. "com.acme.app.pro".'),
        name: z.string().optional().describe("Filter by display name."),
        inAppPurchaseType: z.enum(IAP_TYPES).optional().describe("Filter by purchase type."),
        state: z
          .string()
          .optional()
          .describe('Filter by review state, e.g. "APPROVED", "READY_TO_SUBMIT".'),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ appId, productId, name, inAppPurchaseType, state, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            `/v1/apps/${appId}/inAppPurchasesV2`,
            compact({
              "filter[productId]": productId,
              "filter[name]": name,
              "filter[inAppPurchaseType]": inAppPurchaseType,
              "filter[state]": state,
              limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_in_app_purchase",
    {
      description: "Get one in-app purchase's attributes by its resource id.",
      inputSchema: { inAppPurchaseId: inAppPurchaseIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ inAppPurchaseId }) =>
      wrap(async () =>
        summarizeResponse(await client.get(`/v2/inAppPurchases/${inAppPurchaseId}`)),
      ),
  );

  server.registerTool(
    "app_store_connect_list_iap_price_points",
    {
      description:
        "List the price points available to an in-app purchase in one territory — each is an id " +
        "plus the customer-facing price and your proceeds. This is the catalogue you pick from: " +
        "pass the id of the row you want to app_store_connect_set_in_app_purchase_price. Apple " +
        "publishes hundreds per territory, so filter or raise the limit when hunting a " +
        "specific price.",
      inputSchema: {
        inAppPurchaseId: inAppPurchaseIdArg,
        territory: territoryArg,
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ inAppPurchaseId, territory, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(`/v2/inAppPurchases/${inAppPurchaseId}/pricePoints`, {
            "filter[territory]": territory,
            limit,
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_iap_price_schedule",
    {
      description:
        "Show what an in-app purchase currently costs: its base territory and every manual price " +
        "in force, each with the price point behind it and its start/end date. An empty price " +
        "list means the IAP has never been priced.",
      inputSchema: { inAppPurchaseId: inAppPurchaseIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ inAppPurchaseId }) =>
      wrap(async () => {
        // The schedule resource carries nothing but relationships, so the prices
        // only exist in `included` — summarizeResponse alone would return an id
        // and no prices at all.
        const response = await client.get(
          `/v2/inAppPurchases/${inAppPurchaseId}/iapPriceSchedule`,
          { include: "manualPrices,baseTerritory" },
        );
        const schedule = resourceOf(response);

        return {
          scheduleId: schedule.id,
          baseTerritory: relatedId(schedule, "baseTerritory"),
          manualPrices: includedOf(response, "inAppPurchasePrices").map((price) => ({
            id: price.id,
            ...attributesOf(price),
            territory: relatedId(price, "territory"),
            pricePointId: relatedId(price, "inAppPurchasePricePoint"),
          })),
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_set_in_app_purchase_price",
    {
      description:
        "Set what an in-app purchase costs, by pointing it at a price point from " +
        "app_store_connect_list_iap_price_points. Prices in every other territory are derived " +
        "from the base territory automatically, per Apple's equalization table. This REPLACES " +
        "the IAP's whole price schedule — any manual price already set is dropped — and once " +
        "the start date arrives it changes what real customers are charged. Omit startDate to " +
        "price it immediately.",
      inputSchema: {
        inAppPurchaseId: inAppPurchaseIdArg,
        pricePointId: z
          .string()
          .min(1)
          .describe(
            "The inAppPurchasePricePoint id to charge (from " +
              "app_store_connect_list_iap_price_points). Must belong to baseTerritory.",
          ),
        baseTerritory: territoryArg.describe(
          "The territory the price point belongs to and that every other territory is " +
            'derived from, e.g. "USA". Must match the territory you listed price points for.',
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
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ inAppPurchaseId, pricePointId, baseTerritory, startDate, endDate }) =>
      wrap(async () => {
        const pricePoint = await assertPricePointBelongs(
          client,
          inAppPurchaseId,
          pricePointId,
          baseTerritory,
        );

        // JSON:API inline create: `manualPrices` points at a placeholder id that
        // only resolves against the matching entry in `included`.
        const placeholder = "${new-price}";
        const response = await client.post("/v1/inAppPurchasePriceSchedules", {
          data: {
            type: "inAppPurchasePriceSchedules",
            relationships: {
              inAppPurchase: { data: { type: "inAppPurchases", id: inAppPurchaseId } },
              baseTerritory: { data: { type: "territories", id: baseTerritory } },
              manualPrices: { data: [{ type: "inAppPurchasePrices", id: placeholder }] },
            },
          },
          included: [
            {
              type: "inAppPurchasePrices",
              id: placeholder,
              attributes: compact({ startDate, endDate }),
              relationships: {
                inAppPurchasePricePoint: {
                  data: { type: "inAppPurchasePricePoints", id: pricePointId },
                },
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
