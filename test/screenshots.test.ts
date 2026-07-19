import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "../src/client/auth.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/screenshot.png", import.meta.url));
const FIXTURE_BYTES = readFileSync(FIXTURE_PATH);

const baseConfig: Config = {
  keyId: "ABCD123456",
  issuerId: "69a6de70-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
  allowWrites: true,
  maxRetries: 3,
  tokenTtlSeconds: 1140,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const connect = async (fetchImpl: typeof fetch, config: Config = baseConfig): Promise<Client> => {
  const { server } = createServer({
    config,
    fetch: fetchImpl,
    tokenProvider: staticTokenProvider("jwt-token"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

type Call = [string, RequestInit];
const calls = (fetchImpl: ReturnType<typeof vi.fn>): Call[] =>
  fetchImpl.mock.calls as unknown as Call[];

const UPLOAD_HOST = "https://upload.appstoreconnect.example";

/** One upload operation covering the whole file, mirroring Apple's response shape. */
const singleOperation = (size: number) => ({
  method: "PUT",
  url: `${UPLOAD_HOST}/part1`,
  offset: 0,
  length: size,
  requestHeaders: [
    { name: "Content-Type", value: "image/png" },
    // Apple echoes this back, but undici must compute it — the client drops it.
    { name: "Content-Length", value: String(size) },
  ],
});

type RouterOptions = {
  existingSets?: { id: string; screenshotDisplayType: string }[];
  operations?: unknown[];
  /** Sequence of assetDeliveryState objects returned by successive GETs. */
  states?: unknown[];
  uploadResponses?: Response[];
  fileSize?: number;
};

/**
 * Route on method + URL the way the real API does, so each test states only the
 * responses it cares about.
 */
const router = (opts: RouterOptions = {}): ReturnType<typeof vi.fn> => {
  const size = opts.fileSize ?? FIXTURE_BYTES.byteLength;
  const uploads = [...(opts.uploadResponses ?? [])];
  const states = [...(opts.states ?? [{ state: "COMPLETE" }])];
  let lastState: unknown = states[0];

  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";

    if (url.startsWith(UPLOAD_HOST)) {
      return uploads.shift() ?? new Response(null, { status: 200 });
    }
    if (method === "GET" && url.includes("/appScreenshotSets") && url.includes("Localizations/")) {
      return jsonResponse({
        data: (opts.existingSets ?? []).map((set) => ({
          type: "appScreenshotSets",
          id: set.id,
          attributes: { screenshotDisplayType: set.screenshotDisplayType },
        })),
      });
    }
    if (method === "POST" && url.endsWith("/v1/appScreenshotSets")) {
      return jsonResponse({ data: { type: "appScreenshotSets", id: "set-new" } }, 201);
    }
    if (method === "POST" && url.endsWith("/v1/appScreenshots")) {
      return jsonResponse(
        {
          data: {
            type: "appScreenshots",
            id: "shot-1",
            attributes: { uploadOperations: opts.operations ?? [singleOperation(size)] },
          },
        },
        201,
      );
    }
    if (method === "PATCH" && url.includes("/v1/appScreenshots/")) {
      return jsonResponse({ data: { type: "appScreenshots", id: "shot-1", attributes: {} } });
    }
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.includes("/v1/appScreenshots/")) {
      lastState = states.shift() ?? lastState;
      return jsonResponse({
        data: {
          type: "appScreenshots",
          id: "shot-1",
          attributes: {
            fileName: "screenshot.png",
            assetDeliveryState: lastState,
            imageAsset: { width: 1290, height: 2796 },
          },
        },
      });
    }
    return jsonResponse({ data: [] });
  });
};

const upload = async (
  client: Client,
  args: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<Client["callTool"]>>> =>
  client.callTool({
    name: "app_store_connect_upload_screenshot",
    arguments: {
      localizationId: "loc-1",
      displayType: "APP_IPHONE_67",
      filePath: FIXTURE_PATH,
      waitSeconds: 0,
      ...args,
    },
  });

describe("app_store_connect_upload_screenshot", () => {
  it("runs the full reservation flow against an existing set", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "set-67", screenshotDisplayType: "APP_IPHONE_67" }],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client);
    expect(result.isError).toBeFalsy();

    const seen = calls(fetchImpl).map(([url, init]) => `${init.method ?? "GET"} ${url}`);
    expect(seen[0]).toContain("/v1/appStoreVersionLocalizations/loc-1/appScreenshotSets");
    // The existing set is reused — no set is created.
    expect(
      seen.some((c) => c === "POST https://api.appstoreconnect.apple.com/v1/appScreenshotSets"),
    ).toBe(false);
    expect(seen[1]).toBe("POST https://api.appstoreconnect.apple.com/v1/appScreenshots");
    expect(seen[2]).toBe(`PUT ${UPLOAD_HOST}/part1`);
    expect(seen[3]).toBe("PATCH https://api.appstoreconnect.apple.com/v1/appScreenshots/shot-1");

    const reserve = JSON.parse(calls(fetchImpl)[1]![1].body as string);
    expect(reserve.data.attributes).toMatchObject({
      fileName: "screenshot.png",
      fileSize: FIXTURE_BYTES.byteLength,
    });
    expect(reserve.data.relationships.appScreenshotSet.data.id).toBe("set-67");

    const commit = JSON.parse(calls(fetchImpl)[3]![1].body as string);
    expect(commit.data.attributes.uploaded).toBe(true);
    expect(commit.data.attributes.sourceFileChecksum).toBe(
      createHash("md5").update(FIXTURE_BYTES).digest("hex"),
    );

    const payload = JSON.parse(textOf(result));
    expect(payload).toMatchObject({ id: "shot-1", state: "COMPLETE", screenshotSetCreated: false });
  });

  it("PUTs raw bytes with no Authorization, no JSON content-type and no Content-Length", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "set-67", screenshotDisplayType: "APP_IPHONE_67" }],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    await upload(client);

    const put = calls(fetchImpl).find(([url]) => url.startsWith(UPLOAD_HOST))![1];
    const headers = put.headers as Record<string, string>;
    expect(headers).toEqual({ "Content-Type": "image/png" });
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("content-length");
    expect(Buffer.from(put.body as Uint8Array)).toEqual(FIXTURE_BYTES);
  });

  it("slices the file across multi-part upload operations", async () => {
    const size = FIXTURE_BYTES.byteLength;
    const split = 30;
    const fetchImpl = router({
      existingSets: [{ id: "set-67", screenshotDisplayType: "APP_IPHONE_67" }],
      operations: [
        { method: "PUT", url: `${UPLOAD_HOST}/part1`, offset: 0, length: split },
        { method: "PUT", url: `${UPLOAD_HOST}/part2`, offset: split, length: size - split },
      ],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    await upload(client);

    const puts = calls(fetchImpl).filter(([url]) => url.startsWith(UPLOAD_HOST));
    expect(puts).toHaveLength(2);
    expect(Buffer.from(puts[0]![1].body as Uint8Array)).toEqual(FIXTURE_BYTES.subarray(0, split));
    expect(Buffer.from(puts[1]![1].body as Uint8Array)).toEqual(FIXTURE_BYTES.subarray(split));
  });

  it("creates the screenshot set when the display type has none", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "set-ipad", screenshotDisplayType: "APP_IPAD_PRO_3GEN_129" }],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client);
    expect(result.isError).toBeFalsy();

    const create = calls(fetchImpl).find(
      ([url, init]) => init.method === "POST" && url.endsWith("/v1/appScreenshotSets"),
    );
    const body = JSON.parse(create![1].body as string);
    expect(body.data.attributes.screenshotDisplayType).toBe("APP_IPHONE_67");
    expect(body.data.relationships.appStoreVersionLocalization.data).toMatchObject({
      type: "appStoreVersionLocalizations",
      id: "loc-1",
    });
    expect(JSON.parse(textOf(result)).screenshotSetCreated).toBe(true);
  });

  it("reports Apple's rejection reason when processing FAILS", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "set-67", screenshotDisplayType: "APP_IPHONE_67" }],
      states: [
        {
          state: "FAILED",
          errors: [{ code: "IMAGE_DIMENSIONS", description: "Expected 1290x2796, got 800x600" }],
        },
      ],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { waitSeconds: 5 });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Expected 1290x2796, got 800x600");
    expect(text).toContain("app_store_connect_delete_screenshot");
    // The failed asset is evidence — it is deliberately left in place.
    expect(calls(fetchImpl).some(([, init]) => init.method === "DELETE")).toBe(false);
  });

  it("treats a processing timeout as success, not an error", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "set-67", screenshotDisplayType: "APP_IPHONE_67" }],
      states: [{ state: "UPLOAD_COMPLETE" }],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { waitSeconds: 0 });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.stillProcessing).toBe(true);
    expect(payload.state).toBe("UPLOAD_COMPLETE");
    expect(payload.note).toContain("app_store_connect_get_screenshot");
  });

  it("retries a 5xx on the upload URL without reserving a second screenshot", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "set-67", screenshotDisplayType: "APP_IPHONE_67" }],
      uploadResponses: [new Response("boom", { status: 500 }), new Response(null, { status: 200 })],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client);

    expect(result.isError).toBeFalsy();
    expect(calls(fetchImpl).filter(([url]) => url.startsWith(UPLOAD_HOST))).toHaveLength(2);
    const reservations = calls(fetchImpl).filter(
      ([url, init]) => init.method === "POST" && url.endsWith("/v1/appScreenshots"),
    );
    expect(reservations).toHaveLength(1);
  });

  it("deletes the dangling reservation when the upload hard-fails", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "set-67", screenshotDisplayType: "APP_IPHONE_67" }],
      uploadResponses: [new Response("expired", { status: 403 })],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("403");
    const cleanup = calls(fetchImpl).find(([, init]) => init.method === "DELETE");
    expect(cleanup![0]).toBe("https://api.appstoreconnect.apple.com/v1/appScreenshots/shot-1");
  });

  it("accepts inline base64 without touching the filesystem", async () => {
    const fetchImpl = router({
      existingSets: [{ id: "set-67", screenshotDisplayType: "APP_IPHONE_67" }],
    });
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, {
      filePath: undefined,
      fileData: FIXTURE_BYTES.toString("base64"),
      fileName: "inline.png",
    });

    expect(result.isError).toBeFalsy();
    const reserve = JSON.parse(calls(fetchImpl)[1]![1].body as string);
    expect(reserve.data.attributes.fileName).toBe("inline.png");
    const put = calls(fetchImpl).find(([url]) => url.startsWith(UPLOAD_HOST))![1];
    expect(Buffer.from(put.body as Uint8Array)).toEqual(FIXTURE_BYTES);
  });

  it("explains the Docker path caveat when the file cannot be read", async () => {
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { filePath: "/nope/missing.png" });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("/nope/missing.png");
    expect(text).toContain("Docker");
    expect(text).toContain("fileData");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a relative filePath", async () => {
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { filePath: "screenshot.png" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("absolute");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects passing both filePath and fileData, or neither", async () => {
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const both = await upload(client, { fileData: "AAAA", fileName: "a.png" });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain("exactly one");

    const neither = await upload(client, { filePath: undefined });
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toContain("exactly one");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an unknown display type at the schema boundary", async () => {
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await upload(client, { displayType: "APP_IPHONE_69" });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("screenshot read tools", () => {
  it("strips spent uploadOperations out of listed screenshots", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            type: "appScreenshots",
            id: "shot-1",
            attributes: {
              fileName: "a.png",
              uploadOperations: [{ url: `${UPLOAD_HOST}/secret-and-very-long` }],
            },
          },
        ],
      }),
    );
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_list_screenshots",
      arguments: { screenshotSetId: "set-67" },
    });

    const text = textOf(result);
    expect(text).toContain("a.png");
    expect(text).not.toContain("uploadOperations");
    expect(text).not.toContain("secret-and-very-long");
  });
});

describe("screenshot write tools", () => {
  it("are hidden when writes are disabled", async () => {
    const readOnly = await connect(router() as unknown as typeof fetch, {
      ...baseConfig,
      allowWrites: false,
    });
    const names = (await readOnly.listTools()).tools.map((t) => t.name);

    expect(names).toContain("app_store_connect_list_screenshot_sets");
    expect(names).toContain("app_store_connect_list_screenshots");
    expect(names).toContain("app_store_connect_get_screenshot");
    for (const name of [
      "app_store_connect_upload_screenshot",
      "app_store_connect_delete_screenshot",
      "app_store_connect_delete_screenshot_set",
      "app_store_connect_reorder_screenshots",
    ]) {
      expect(names, name).not.toContain(name);
    }
  });

  it("refuse to delete without an explicit confirm", async () => {
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_delete_screenshot",
      arguments: { screenshotId: "shot-1" },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reorder sends the full ordered relationship list", async () => {
    const fetchImpl = router();
    const client = await connect(fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_reorder_screenshots",
      arguments: { screenshotSetId: "set-67", screenshotIds: ["b", "a", "c"], confirm: true },
    });

    expect(result.isError).toBeFalsy();
    const [url, init] = calls(fetchImpl)[0]!;
    expect(url).toBe(
      "https://api.appstoreconnect.apple.com/v1/appScreenshotSets/set-67/relationships/appScreenshots",
    );
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string).data).toEqual([
      { type: "appScreenshots", id: "b" },
      { type: "appScreenshots", id: "a" },
      { type: "appScreenshots", id: "c" },
    ]);
  });
});
