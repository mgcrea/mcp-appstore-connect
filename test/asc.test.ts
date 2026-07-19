import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { AppStoreConnectClient } from "../src/client/asc.js";
import type { TokenProvider } from "../src/client/auth.js";
import { AppStoreConnectApiError } from "../src/client/errors.js";

const spyProvider = (): TokenProvider & { invalidate: ReturnType<typeof vi.fn> } => ({
  getToken: async () => "jwt-token",
  invalidate: vi.fn(() => {}),
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const callUrl = (fetchImpl: ReturnType<typeof vi.fn>, index = 0): string =>
  (fetchImpl.mock.calls[index] as unknown as [string, RequestInit])[0];

const callInit = (fetchImpl: ReturnType<typeof vi.fn>, index = 0): RequestInit =>
  (fetchImpl.mock.calls[index] as unknown as [string, RequestInit])[1];

describe("AppStoreConnectClient query building", () => {
  it("encodes bracketed filter/fields params and comma-joins arrays", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.get("/v1/apps", {
      "filter[bundleId]": "com.acme.app",
      "fields[apps]": ["name", "bundleId"],
      limit: 50,
    });

    const url = new URL(callUrl(fetchImpl));
    expect(url.pathname).toBe("/v1/apps");
    expect(url.searchParams.get("filter[bundleId]")).toBe("com.acme.app");
    expect(url.searchParams.get("fields[apps]")).toBe("name,bundleId");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("sends a JSON body with PATCH", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: {} }));
    const client = new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.patch("/v1/appStoreVersionLocalizations/loc-1", {
      data: { type: "appStoreVersionLocalizations", id: "loc-1", attributes: { keywords: "a,b" } },
    });

    const init = callInit(fetchImpl);
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string).data.attributes.keywords).toBe("a,b");
  });
});

describe("AppStoreConnectClient retry & errors", () => {
  it("invalidates the token and retries once on a 401", async () => {
    const provider = spyProvider();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const client = new AppStoreConnectClient({
      tokenProvider: provider,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.get("/v1/apps");

    expect(provider.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps a JSON:API error body into AppStoreConnectApiError with detail", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          errors: [{ status: "404", code: "NOT_FOUND", title: "Not found", detail: "No such app" }],
        },
        404,
      ),
    );
    const client = new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });

    await expect(client.get("/v1/apps/nope")).rejects.toMatchObject({
      name: "AppStoreConnectApiError",
      status: 404,
    });
    await expect(client.get("/v1/apps/nope")).rejects.toThrow(/No such app/);
    expect(
      (await client.get("/v1/apps/nope").catch((e) => e)) instanceof AppStoreConnectApiError,
    ).toBe(true);
  });
});

const uploadClient = (
  fetchImpl: ReturnType<typeof vi.fn>,
  provider: TokenProvider = spyProvider(),
): AppStoreConnectClient =>
  new AppStoreConnectClient({
    tokenProvider: provider,
    fetch: fetchImpl as unknown as typeof fetch,
  });

describe("AppStoreConnectClient.uploadAsset", () => {
  const data = Buffer.from("0123456789");

  it("PUTs each byte range with Apple's headers, minus the unsettable ones", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await uploadClient(fetchImpl).uploadAsset(
      [
        {
          method: "PUT",
          url: "https://upload.example/part1",
          offset: 0,
          length: 4,
          requestHeaders: [
            { name: "Content-Type", value: "image/png" },
            { name: "Content-Length", value: "4" },
            { name: "Host", value: "upload.example" },
          ],
        },
        { method: "PUT", url: "https://upload.example/part2", offset: 4, length: 6 },
      ],
      data,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(callUrl(fetchImpl)).toBe("https://upload.example/part1");
    expect(callInit(fetchImpl).headers).toEqual({ "Content-Type": "image/png" });
    expect(Buffer.from(callInit(fetchImpl).body as Uint8Array).toString()).toBe("0123");
    expect(Buffer.from(callInit(fetchImpl, 1).body as Uint8Array).toString()).toBe("456789");
  });

  it("never attaches an Authorization header", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await uploadClient(fetchImpl).uploadAsset(
      [{ url: "https://upload.example/part1", offset: 0, length: data.byteLength }],
      data,
    );

    const headers = callInit(fetchImpl).headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("does not remint the token on a 401 — a pre-signed URL has simply expired", async () => {
    const provider = spyProvider();
    const fetchImpl = vi.fn(async () => new Response("expired", { status: 401 }));

    await expect(
      uploadClient(fetchImpl, provider).uploadAsset(
        [{ url: "https://upload.example/part1", offset: 0, length: data.byteLength }],
        data,
      ),
    ).rejects.toThrow(/401/);

    expect(provider.invalidate).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a file shorter than the reserved range instead of uploading a truncated body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(
      uploadClient(fetchImpl).uploadAsset(
        [{ url: "https://upload.example/part1", offset: 0, length: 99 }],
        data,
      ),
    ).rejects.toThrow(/smaller than the fileSize reserved/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails clearly when there are no upload operations", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(uploadClient(fetchImpl).uploadAsset([], data)).rejects.toThrow(
      /no uploadOperations/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("AppStoreConnectClient.downloadReport", () => {
  it("gunzips a gzipped TSV body and returns plain text", async () => {
    const tsv = "Provider\tSKU\tUnits\nAPPLE\tcom.acme\t42\n";
    const fetchImpl = vi.fn(
      async () =>
        new Response(gzipSync(Buffer.from(tsv)), {
          status: 200,
          headers: { "content-type": "application/a-gzip" },
        }),
    );
    const client = new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const out = await client.downloadReport("/v1/salesReports", {
      "filter[vendorNumber]": "80000123",
      "filter[reportDate]": "2026-06",
    });
    expect(out).toBe(tsv);
  });
});
