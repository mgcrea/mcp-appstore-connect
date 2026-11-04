import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  baseConfig,
  callArgs,
  connect,
  groupBody,
  jsonResponse,
  notFound,
  payloadOf,
  postCall,
} from "../helpers.js";

describe("create_beta_group", () => {
  const APP_ID = "6798236186";

  const connectWithWrites = async (fetchImpl: ReturnType<typeof vi.fn>): Promise<Client> =>
    connect({ ...baseConfig, allowWrites: true }, fetchImpl as unknown as typeof fetch);

  it("posts an internal group with the app relationship", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(groupBody({ name: "Internal", isInternalGroup: true })),
    );
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: { appId: APP_ID, name: "Internal", hasAccessToAllBuilds: true },
    });

    expect(result.isError).toBeFalsy();
    const call = postCall(fetchImpl, "/v1/betaGroups");
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body)) as {
      data: { attributes: Record<string, unknown>; relationships: Record<string, unknown> };
    };
    expect(body.data.attributes).toMatchObject({
      name: "Internal",
      isInternalGroup: true,
      hasAccessToAllBuilds: true,
    });
    expect(body.data.relationships).toEqual({
      app: { data: { type: "apps", id: APP_ID } },
    });
  });

  it("omits attributes that were not supplied", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupBody({ name: "Internal" })));
    const client = await connectWithWrites(fetchImpl);

    await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: { appId: APP_ID, name: "Internal" },
    });

    const body = JSON.parse(String(postCall(fetchImpl, "/v1/betaGroups")?.[1]?.body)) as {
      data: { attributes: Record<string, unknown> };
    };
    expect(body.data.attributes).not.toHaveProperty("hasAccessToAllBuilds");
    expect(body.data.attributes).not.toHaveProperty("publicLinkEnabled");
  });

  // The two cross-kind attributes are the easy mistake, and Apple's own error
  // names the field without saying which kind of group it belongs to.
  it("rejects a public link on an internal group before calling Apple", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupBody({ name: "Internal" })));
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: { appId: APP_ID, name: "Internal", publicLinkEnabled: true },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects hasAccessToAllBuilds on an external group before calling Apple", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(groupBody({ name: "Public" })));
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_beta_group",
      arguments: {
        appId: APP_ID,
        name: "Public",
        isInternalGroup: false,
        hasAccessToAllBuilds: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("list_beta_testers", () => {
  it("filters by group and email together rather than dropping the email", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({
      name: "app_store_connect_list_beta_testers",
      arguments: { groupId: "g1", email: "alice@example.com" },
    });

    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe("/v1/betaTesters");
    expect(url.searchParams.get("filter[betaGroups]")).toBe("g1");
    expect(url.searchParams.get("filter[email]")).toBe("alice@example.com");
  });
});

describe("beta crash reports", () => {
  const APP_ID = "6798236186";
  const LOG = [
    "Incident Identifier: X",
    "Exception Type:  EXC_CRASH (SIGABRT)",
    "Termination Reason: SIGNAL 6 Abort trap: 6",
    "Triggered by Thread:  0",
    "Thread 0 Crashed:",
  ].join("\n");

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "asc-crash-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const submission = (id: string, buildId: string): unknown => ({
    type: "betaFeedbackCrashSubmissions",
    id,
    attributes: {
      createdDate: "2026-11-04T10:00:00Z",
      comment: "Crashed at launch",
      deviceModel: "iPhone17,1",
      osVersion: "26.1",
    },
    relationships: { build: { data: { type: "builds", id: buildId } } },
  });

  const routed = (logs: Record<string, string | null>): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      const { pathname } = new URL(url);
      const match = /betaFeedbackCrashSubmissions\/([^/]+)\/crashLog$/.exec(pathname);
      if (match) {
        const text = logs[match[1] as string];
        return text === null || text === undefined
          ? notFound()
          : jsonResponse({
              data: { type: "betaCrashLogs", id: "l", attributes: { logText: text } },
            });
      }
      return jsonResponse({
        data: [submission("c1", "b1"), submission("c2", "b1")],
        included: [{ type: "builds", id: "b1", attributes: { version: "42" } }],
      });
    });

  it("lists newest first with the build number resolved, filtered by build", async () => {
    const fetchImpl = routed({});
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_beta_crash_reports",
      arguments: { appId: APP_ID, buildId: "b1" },
    });

    expect(result.isError).toBeFalsy();
    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/apps/${APP_ID}/betaFeedbackCrashSubmissions`);
    expect(url.searchParams.get("filter[build]")).toBe("b1");
    expect(url.searchParams.get("sort")).toBe("-createdDate");
    expect(url.searchParams.get("include")).toBe("build");
    const rows = payloadOf(result).data as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({
      id: "c1",
      comment: "Crashed at launch",
      deviceModel: "iPhone17,1",
      osVersion: "26.1",
      buildId: "b1",
      buildNumber: "42",
    });
    // Listing alone never fetches logs.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("saves each crash log to crashLogDir, and marks a missing one null", async () => {
    const fetchImpl = routed({ c1: LOG, c2: null });
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_beta_crash_reports",
      arguments: { appId: APP_ID, crashLogDir: dir },
    });

    expect(result.isError).toBeFalsy();
    const rows = payloadOf(result).data as Record<string, unknown>[];
    expect(rows[0]?.crashLog).toMatchObject({
      saved: { path: join(dir, "c1.crash"), content: "text" },
      headline: [
        "Exception Type:  EXC_CRASH (SIGABRT)",
        "Termination Reason: SIGNAL 6 Abort trap: 6",
        "Triggered by Thread:  0",
      ],
    });
    expect(rows[1]?.crashLog).toBeNull();
    expect(await readFile(join(dir, "c1.crash"), "utf8")).toBe(LOG);
  });

  it("says an empty list is not evidence of no crashes", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_beta_crash_reports",
      arguments: { appId: APP_ID },
    });

    expect(String(payloadOf(result).note)).toContain("not evidence");
  });

  it("get_beta_crash_log writes the log verbatim and inlines only its headline", async () => {
    const fetchImpl = routed({ c1: LOG });
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const savePath = join(dir, "one.crash");

    const result = await client.callTool({
      name: "app_store_connect_get_beta_crash_log",
      arguments: { submissionId: "c1", savePath },
    });

    expect(result.isError).toBeFalsy();
    expect(new URL(callArgs(fetchImpl)[0]).pathname).toBe(
      "/v1/betaFeedbackCrashSubmissions/c1/crashLog",
    );
    expect(await readFile(savePath, "utf8")).toBe(LOG);
    expect(JSON.stringify(payloadOf(result))).not.toContain("Incident Identifier");
  });

  it("get_beta_crash_log answers null, not an error, when Apple holds no log", async () => {
    const client = await connect(baseConfig, routed({}) as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_get_beta_crash_log",
      arguments: { submissionId: "c9", savePath: join(dir, "none.crash") },
    });

    expect(result.isError).toBeFalsy();
    expect(payloadOf(result).crashLog).toBeNull();
  });
});
