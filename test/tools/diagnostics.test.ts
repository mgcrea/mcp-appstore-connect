import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { baseConfig, callArgs, connect, jsonResponse, payloadOf, textOf } from "../helpers.js";

const APP_ID = "1234567890";

const signature = (id: string, diagnosticType: string, weight: number): unknown => ({
  type: "diagnosticSignatures",
  id,
  attributes: { diagnosticType, signature: `App: frame ${id}`, weight },
  relationships: { logs: { links: { related: `https://x/v1/diagnosticSignatures/${id}/logs` } } },
});

describe("list_diagnostic_signatures", () => {
  it("lists a build's signatures with the type filter and tags each row with its build", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [signature("s1", "HANGS", 0.8)] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_diagnostic_signatures",
      arguments: { buildId: "b1", diagnosticType: "HANGS" },
    });

    expect(result.isError).toBeFalsy();
    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe("/v1/builds/b1/diagnosticSignatures");
    expect(url.searchParams.get("filter[diagnosticType]")).toBe("HANGS");
    const body = payloadOf(result) as { data: Record<string, unknown>[] };
    expect(body.data[0]).toMatchObject({ id: "s1", weight: 0.8, buildId: "b1" });
    // A non-empty result carries no "absent" note.
    expect(body).not.toHaveProperty("note");
  });

  it("resolves appId + versionString to the build attached to that version", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const { pathname } = new URL(url);
      if (pathname === `/v1/apps/${APP_ID}/appStoreVersions`) {
        return jsonResponse({
          data: [
            {
              type: "appStoreVersions",
              id: "v1",
              attributes: { versionString: "1.3.0", platform: "IOS" },
              relationships: { build: { data: { type: "builds", id: "b-shipped" } } },
            },
          ],
          included: [{ type: "builds", id: "b-shipped", attributes: { version: "42" } }],
        });
      }
      return jsonResponse({ data: [signature("s1", "LAUNCHES", 0.5)] });
    });
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_diagnostic_signatures",
      arguments: { appId: APP_ID, versionString: "1.3.0" },
    });

    expect(result.isError).toBeFalsy();
    const versionsUrl = new URL(callArgs(fetchImpl, 0)[0]);
    expect(versionsUrl.searchParams.get("filter[versionString]")).toBe("1.3.0");
    expect(versionsUrl.searchParams.get("include")).toBe("build");
    expect(new URL(callArgs(fetchImpl, 1)[0]).pathname).toBe(
      "/v1/builds/b-shipped/diagnosticSignatures",
    );
    expect(payloadOf(result).builds).toEqual([
      { buildId: "b-shipped", versionString: "1.3.0", platform: "IOS", buildNumber: "42" },
    ]);
  });

  it("refuses a version with no build attached instead of reporting no signatures", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ type: "appStoreVersions", id: "v1", attributes: { versionString: "1.3.0" } }],
      }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_diagnostic_signatures",
      arguments: { appId: APP_ID, versionString: "1.3.0" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no build attached");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires exactly one of buildId or appId + versionString", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    for (const args of [
      {},
      { appId: APP_ID },
      { buildId: "b1", appId: APP_ID, versionString: "1" },
    ]) {
      const result = await client.callTool({
        name: "app_store_connect_list_diagnostic_signatures",
        arguments: args,
      });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // The failure this guards is silent: "list signatures, none, so no crashes".
  it("says an empty list is not 'no crashes', and that crashes are elsewhere", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_diagnostic_signatures",
      arguments: { buildId: "b1" },
    });

    const note = String(payloadOf(result).note);
    expect(note).toContain("not that the build is healthy");
    expect(note).toContain("GetTopCrashIssues");
  });

  it("says in its description that the API carries no crashes", async () => {
    const client = await connect(baseConfig);
    const tools = (await client.listTools()).tools;
    for (const name of [
      "app_store_connect_list_diagnostic_signatures",
      "app_store_connect_get_diagnostic_logs",
    ]) {
      const description = tools.find((t) => t.name === name)?.description ?? "";
      expect(description, name).toContain("NO crashes");
      expect(description, name).toContain("GetTopCrashIssues");
    }
  });
});

describe("get_diagnostic_logs", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "asc-diag-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const logs = {
    version: "1.0",
    productData: [
      {
        signatureId: "s1",
        diagnosticInsights: [{ insightsCategory: "SQLiteSpill", insightsString: "Add an index." }],
        diagnosticLogs: [
          {
            diagnosticMetaData: { event: "hang", appVersion: "1.3.0", osVersion: "iOS 26.1" },
            callStackTree: [
              {
                callStacks: [
                  {
                    callStackRootFrames: [
                      {
                        rawFrame: "0 libdispatch",
                        isBlameFrame: false,
                        subFrames: [{ rawFrame: "1 -[Store load] (App)", isBlameFrame: true }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  it("asks for Apple's diagnostic-logs type, saves the whole document, and inlines no stacks", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(logs));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const savePath = join(dir, "logs.json");

    const result = await client.callTool({
      name: "app_store_connect_get_diagnostic_logs",
      arguments: { signatureId: "s1", savePath, limit: 3 },
    });

    expect(result.isError).toBeFalsy();
    const [url, init] = callArgs(fetchImpl);
    expect(new URL(url).pathname).toBe("/v1/diagnosticSignatures/s1/logs");
    expect(new URL(url).searchParams.get("limit")).toBe("3");
    expect((init.headers as Record<string, string>).Accept).toBe(
      "application/vnd.apple.diagnostic-logs+json",
    );

    const body = payloadOf(result);
    expect(body.logCount).toBe(1);
    expect(body.logs).toEqual([
      {
        event: "hang",
        appVersion: "1.3.0",
        osVersion: "iOS 26.1",
        blameFrames: ["1 -[Store load] (App)"],
      },
    ]);
    expect(textOf(result)).not.toContain("callStackTree");
    expect(body.saved).toMatchObject({ path: savePath, content: "json" });
    expect(JSON.parse(await readFile(savePath, "utf8"))).toEqual(logs);
  });

  it("requires a savePath", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(logs));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_get_diagnostic_logs",
      arguments: { signatureId: "s1" },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
