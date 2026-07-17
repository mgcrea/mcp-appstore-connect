import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppStoreConnectClient } from "../client/asc.js";
import { summarizeResponse } from "../client/shape.js";
import { compact, limitArg, wrap } from "./util.js";

export const registerDeviceTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_devices",
    {
      description:
        "List devices registered on the developer account for development and ad-hoc " +
        "distribution (name, UDID, class, platform, enabled/disabled status).",
      inputSchema: {
        status: z.enum(["ENABLED", "DISABLED"]).optional().describe("Filter by device status."),
        platform: z.enum(["IOS", "MAC_OS"]).optional().describe("Filter by platform."),
        limit: limitArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, platform, limit }) =>
      wrap(async () =>
        summarizeResponse(
          await client.get(
            "/v1/devices",
            compact({ "filter[status]": status, "filter[platform]": platform, limit }),
          ),
        ),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_register_device",
    {
      description:
        "Register a device by UDID so it can install development and ad-hoc builds. Apple does " +
        "not allow deleting devices — a wrong entry can only be disabled from the portal.",
      inputSchema: {
        name: z.string().min(1).describe("A label for the device."),
        udid: z.string().min(1).describe("The device UDID (40-char hex, or newer 25-char form)."),
        platform: z.enum(["IOS", "MAC_OS"]).default("IOS"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, udid, platform }) =>
      wrap(async () =>
        summarizeResponse(
          await client.post("/v1/devices", {
            data: { type: "devices", attributes: { name, udid, platform } },
          }),
        ),
      ),
  );
};
