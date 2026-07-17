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
