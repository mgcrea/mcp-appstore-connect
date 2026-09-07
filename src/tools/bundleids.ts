import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { AppStoreConnectApiError, type AppStoreConnectError } from "#/client/errors";
import { summarizeResponse } from "#/client/shape";
import { compact, confirmArg, limitArg, savePathArg, wrap, wrapSaved } from "#/tools/util";

const BUNDLE_PLATFORMS = ["IOS", "MAC_OS", "UNIVERSAL"] as const;

/**
 * Did Apple refuse this capability type, rather than the request around it?
 *
 * `source.pointer` settles it when it is there — a live 409 files the error
 * against `/data/attributes/capabilityType` precisely, and `capabilityType` is
 * not the only attribute on this POST: a malformed `settings` entry raises the
 * same `ENTITY_ERROR.ATTRIBUTE.TYPE` code about something else entirely, and
 * answering that with directions to the portal would be a lie. The detail text,
 * then the bare code, are fallbacks for a payload that carries no pointer.
 */
const isUnknownCapabilityType = (err: AppStoreConnectApiError): boolean =>
  Array.isArray(err.errors) &&
  (err.errors as AppStoreConnectError[]).some((e) => {
    const pointer = e?.source?.pointer;
    if (pointer) return pointer.endsWith("/capabilityType");
    const detail = e?.detail ?? "";
    return detail ? detail.includes("capabilityType") : e?.code === "ENTITY_ERROR.ATTRIBUTE.TYPE";
  });

/** Name the App ID the way the portal lists it, so the caller can find the row to click. */
const describeBundleId = async (
  client: AppStoreConnectClient,
  bundleId: string,
): Promise<string> => {
  try {
    const res = await client.get<{ data?: { attributes?: Record<string, unknown> } }>(
      `/v1/bundleIds/${bundleId}`,
    );
    const { name, identifier } = (res?.data?.attributes ?? {}) as {
      name?: string;
      identifier?: string;
    };
    if (name && identifier) return `${name} (${identifier})`;
    return identifier ?? name ?? bundleId;
  } catch {
    // Only ever runs on an error path — a second failure must not replace the
    // first one, which is the one worth reading.
    return bundleId;
  }
};

/**
 * Say where a capability the API cannot set actually lives.
 *
 * Apple's `capabilityType` enum stopped growing before the App Services page
 * existed, and it does not only stand still: `IN_APP_PASS_PROVISIONING` was
 * accepted for two years and then rejected without notice. So everything the
 * portal has gained since — WeatherKit, Family Controls, Group Activities — can
 * only be ticked by hand. Apple answers with a 409 listing the values it does
 * take, which reads as "you typed the wrong one" when the truth is "this cannot
 * be done here at all", and sends the caller off to guess at spellings.
 *
 * Nothing is validated locally against that list on the way out. Refusing a
 * value ourselves would rebuild the exact staleness this exists to explain —
 * the day Apple adds WEATHERKIT, the tool has to start working on its own.
 *
 * Setting one is out of reach; confirming one is not, which is why this points
 * at list_capabilities — a portal-ticked capability does come back from the GET.
 */
const withCapabilityHint = async <T>(
  client: AppStoreConnectClient,
  bundleId: string,
  capabilityType: string,
  fn: () => Promise<T>,
): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppStoreConnectApiError && isUnknownCapabilityType(err)) {
      const who = await describeBundleId(client, bundleId);
      throw new AppStoreConnectApiError(
        `App Store Connect will not set ${capabilityType} on ${who} — its capabilityType enum ` +
          `never grew past the capabilities that predate the App Services page, so this one is ` +
          `portal-only. Tick it by hand: developer.apple.com → Certificates, Identifiers & ` +
          `Profiles → Identifiers → ${who} → App Services → ${capabilityType}. That regenerates ` +
          `the provisioning profile on the next build that passes -allowProvisioningUpdates. ` +
          `Then confirm it with app_store_connect_list_capabilities, which does report the ` +
          `capabilities only the portal can set. Original: ${err.message}`,
        { status: err.status, errors: err.errors },
      );
    }
    throw err;
  }
};

const bundleIdArg = z
  .string()
  .min(1)
  .describe(
    "The bundle id RESOURCE id (from app_store_connect_list_bundle_ids), not the identifier string.",
  );

export const registerBundleIdTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_bundle_ids",
    {
      title: "App Store Connect: List Bundle IDs",
      description:
        "List registered bundle ids (App IDs) on the developer account, with their identifier " +
        "string, name and platform. Returns the resource ids used to manage capabilities.",
      inputSchema: z.object({
        identifier: z.string().optional().describe('Filter by identifier, e.g. "com.acme.app".'),
        platform: z.enum(BUNDLE_PLATFORMS).optional().describe("Filter by platform."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ identifier, platform, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(
            "/v1/bundleIds",
            compact({
              "filter[identifier]": identifier,
              "filter[platform]": platform,
              limit,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_get_bundle_id",
    {
      title: "App Store Connect: Get Bundle ID",
      description: "Get one bundle id's attributes by its resource id.",
      inputSchema: z.object({ bundleId: bundleIdArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ bundleId, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(await client.get(`/v1/bundleIds/${bundleId}`)),
      ),
  );

  server.registerTool(
    "app_store_connect_list_capabilities",
    {
      title: "App Store Connect: List Capabilities",
      description:
        "List the capabilities (App Services) enabled on a bundle id. Returns the capability " +
        "ids that disable_capability needs, and is the only way to check a capability the API " +
        "cannot set — one ticked by hand in the developer portal, such as WEATHERKIT, is " +
        "reported here even though enable_capability is refused it.",
      inputSchema: z.object({ bundleId: bundleIdArg, limit: limitArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ bundleId, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        summarizeResponse(
          await client.get(`/v1/bundleIds/${bundleId}/bundleIdCapabilities`, compact({ limit })),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_bundle_id",
    {
      title: "App Store Connect: Create Bundle ID",
      description:
        "Register a new bundle id (App ID) on the developer account. The identifier is permanent " +
        "and cannot be reused once created.",
      inputSchema: z.object({
        identifier: z.string().min(1).describe('The bundle id, e.g. "com.acme.app".'),
        name: z.string().min(1).describe("A human-readable name for the App ID."),
        platform: z.enum(BUNDLE_PLATFORMS).default("UNIVERSAL"),
        seedId: z.string().optional().describe("Team seed id (App ID prefix). Usually inferred."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ identifier, name, platform, seedId }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/bundleIds", {
            data: {
              type: "bundleIds",
              attributes: compact({ identifier, name, platform, seedId }),
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_enable_capability",
    {
      title: "App Store Connect: Enable Capability",
      description:
        "Enable a capability (App Service) on a bundle id, e.g. PUSH_NOTIFICATIONS, ICLOUD, " +
        "GAME_CENTER, ASSOCIATED_DOMAINS, APP_GROUPS. Only capabilities that predate the App " +
        "Services page can be set through the API — WeatherKit, Family Controls, Group " +
        "Activities and everything newer are portal-only, and this says where to tick them " +
        "rather than failing blankly. Read what is already on with list_capabilities.",
      inputSchema: z.object({
        bundleId: bundleIdArg,
        capabilityType: z
          .string()
          .min(1)
          .describe('The capability type, e.g. "PUSH_NOTIFICATIONS", "ICLOUD", "APP_GROUPS".'),
        settings: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("Optional capability settings (JSON:API CapabilitySetting objects)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ bundleId, capabilityType, settings }) =>
      wrap(async () =>
        withCapabilityHint(client, bundleId, capabilityType, async () =>
          summarizeResponse(
            await client.post("/v1/bundleIdCapabilities", {
              data: {
                type: "bundleIdCapabilities",
                attributes: compact({ capabilityType, settings }),
                relationships: { bundleId: { data: { type: "bundleIds", id: bundleId } } },
              },
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_disable_capability",
    {
      title: "App Store Connect: Disable Capability",
      description: "Disable a capability on a bundle id by its capability id.",
      inputSchema: z.object({
        capabilityId: z
          .string()
          .min(1)
          .describe(
            "The bundleIdCapability id, from app_store_connect_list_capabilities or returned " +
              "when the capability was enabled.",
          ),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ capabilityId }) =>
      wrap(async () => {
        await client.del(`/v1/bundleIdCapabilities/${capabilityId}`);
        return { disabled: capabilityId };
      }),
  );
};
