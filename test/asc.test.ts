import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { AppStoreConnectClient } from "#/client/asc";
import type { TokenProvider } from "#/client/auth";
import { AppStoreConnectApiError } from "#/client/errors";
import { backoffMs } from "#/client/http";

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

  it("spells out meta.associatedErrors, which is where a refused submission says why", async () => {
    // Shape taken from a real POST /v1/reviewSubmissionItems. The outer error only says to go
    // and look at the associated ones, so dropping them leaves the caller with "is not in valid
    // state" and no indication of which separate things are unset.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          errors: [
            {
              status: "409",
              code: "STATE_ERROR.ENTITY_STATE_INVALID",
              title: "appStoreVersions with id 'v-1' is not in valid state.",
              detail:
                "This resource cannot be reviewed, please check associated errors to see why.",
              meta: {
                associatedErrors: {
                  "/v1/appInfos/ai-1": [
                    {
                      code: "ENTITY_ERROR.RELATIONSHIP.REQUIRED",
                      detail: "You must provide a value for the relationship 'primaryCategory'",
                    },
                  ],
                  "/v2/appPrices/": [
                    {
                      code: "STATE_ERROR.APP_PRICING_REQUIRED",
                      detail: "App is not eligible for submission until pricing has been set.",
                    },
                  ],
                },
              },
            },
          ],
        },
        409,
      ),
    );
    const client = new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });

    const error = (await client
      .post("/v1/reviewSubmissionItems", {})
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toMatch(/primaryCategory/);
    expect(error.message).toMatch(/APP_PRICING_REQUIRED/);
    expect(error.message).toMatch(/\/v1\/appInfos\/ai-1/);
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

describe("AppStoreConnectClient.downloadSignedFile", () => {
  const SEGMENT_URL = "https://api-reports.itunes.apple.com/segments/abc?token=xyz";

  const clientWith = (fetchImpl: ReturnType<typeof vi.fn>): AppStoreConnectClient =>
    new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

  it("gunzips the segment and sends no Authorization header", async () => {
    const csv = "Date,Territory,Installations\n2026-06-01,US,1204\n";
    const fetchImpl = vi.fn(async () => new Response(gzipSync(Buffer.from(csv)), { status: 200 }));

    expect(await clientWith(fetchImpl).downloadSignedFile(SEGMENT_URL)).toBe(csv);
    expect(callUrl(fetchImpl)).toBe(SEGMENT_URL);
    // The pre-signed URL carries its own credentials; a Bearer token gets it rejected.
    expect(callInit(fetchImpl).headers).not.toHaveProperty("Authorization");
  });

  it("passes an uncompressed body through rather than failing in gunzip", async () => {
    const csv = "Date,Territory,Installations\n";
    const fetchImpl = vi.fn(async () => new Response(csv, { status: 200 }));

    expect(await clientWith(fetchImpl).downloadSignedFile(SEGMENT_URL)).toBe(csv);
  });

  /**
   * Apple does not serve segments from apple.com. They come from its own
   * `asp-<region>` S3 buckets, so an allowlist of apple.com alone refuses every
   * analytics download there is — the guard rejecting the only host the data ever
   * arrives on, with no way past it.
   */
  it("accepts Apple's asp-<region> S3 buckets, which is where segments actually live", async () => {
    const csv = "Date,Territory,Installations\n2026-08-13,US,3\n";
    const fetchImpl = vi.fn(async () => new Response(gzipSync(Buffer.from(csv)), { status: 200 }));

    const url = "https://asp-us-west-2.s3.amazonaws.com/segments/abc?X-Amz-Signature=xyz";
    expect(await clientWith(fetchImpl).downloadSignedFile(url)).toBe(csv);
    expect(callInit(fetchImpl).headers).not.toHaveProperty("Authorization");
  });

  it("refuses a host that is neither Apple nor one of its buckets", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 200 }));

    await expect(
      clientWith(fetchImpl).downloadSignedFile("https://evil.example.com/segments/abc"),
    ).rejects.toThrow(/Refusing to download/);
    // A bucket-shaped name on someone else's S3 account is still not Apple's.
    await expect(
      clientWith(fetchImpl).downloadSignedFile("https://asp-evil.s3.example.com/segments/abc"),
    ).rejects.toThrow(/Refusing to download/);
    await expect(
      clientWith(fetchImpl).downloadSignedFile("http://asp-us-west-2.s3.amazonaws.com/segments/a"),
    ).rejects.toThrow(/Refusing to download/);
    // Anyone can register s3-evilamazonaws.com; only a real .amazonaws.com passes.
    await expect(
      clientWith(fetchImpl).downloadSignedFile("https://asp-us-west-2.s3-evilamazonaws.com/a"),
    ).rejects.toThrow(/Refusing to download/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains that an expired url must be re-listed", async () => {
    const fetchImpl = vi.fn(async () => new Response("AccessDenied", { status: 403 }));

    await expect(clientWith(fetchImpl).downloadSignedFile(SEGMENT_URL)).rejects.toThrow(
      AppStoreConnectApiError,
    );
    await expect(clientWith(fetchImpl).downloadSignedFile(SEGMENT_URL)).rejects.toThrow(
      /short-lived and expire/,
    );
  });
});

describe("AppStoreConnectClient timeouts", () => {
  /** A connection that never answers, until the request's signal gives up on it. */
  const stalled = vi.fn(
    (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );

  it("fails a stalled request with a clear error, and does not replay it", async () => {
    stalled.mockClear();
    const client = new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: stalled as unknown as typeof fetch,
      timeoutMs: 20,
    });

    await expect(client.post("/v1/appStoreVersions", { data: {} })).rejects.toThrow(
      /timed out after 0.02s.*not retried/,
    );
    // A POST that may have landed must not be sent twice.
    expect(stalled).toHaveBeenCalledTimes(1);
  });

  it("bounds signed downloads with the transfer timeout", async () => {
    stalled.mockClear();
    const client = new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: stalled as unknown as typeof fetch,
      transferTimeoutMs: 20,
    });

    await expect(
      client.downloadSignedFile("https://asp-us-west-2.s3.amazonaws.com/segments/abc"),
    ).rejects.toThrow(/timed out/);
  });
});

describe("retry pacing", () => {
  it("jitters the backoff within half a step of the fixed schedule", () => {
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(0, () => 1)).toBe(1000);
    // Capped at 8s like before, only now spread over 4-8s.
    expect(backoffMs(10, () => 0)).toBe(4000);
    expect(backoffMs(10, () => 1)).toBe(8000);
  });

  it("returns a 429 at once rather than sleeping through a long Retry-After", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ status: "429", detail: "slow down" }] }), {
          status: 429,
          headers: { "Retry-After": "3600" },
        }),
    );
    const client = new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.get("/v1/apps")).rejects.toThrow(AppStoreConnectApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("download size caps", () => {
  const capped = (fetchImpl: ReturnType<typeof vi.fn>): AppStoreConnectClient =>
    new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
      maxDownloadBytes: 1024,
    });

  /** Small on the wire, large once inflated: the compressed size proves nothing. */
  it("refuses a report that decompresses past the cap", async () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024, "a"));
    expect(bomb.byteLength).toBeLessThan(1024);
    const fetchImpl = vi.fn(async () => new Response(bomb, { status: 200 }));

    await expect(capped(fetchImpl).downloadReport("/v1/salesReports", {})).rejects.toThrow(
      /decompressed report .* hold in memory/,
    );
  });

  it("refuses an announced oversized body without reading it", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("x".repeat(10), { status: 200, headers: { "Content-Length": "999999" } }),
    );

    await expect(
      capped(fetchImpl).downloadSignedFile("https://asp-us-west-2.s3.amazonaws.com/segments/a"),
    ).rejects.toThrow(/hold in memory/);
  });

  it("still reads a report under the cap", async () => {
    const tsv = "Provider\tUnits\nAPPLE\t3\n";
    const fetchImpl = vi.fn(async () => new Response(gzipSync(Buffer.from(tsv)), { status: 200 }));

    expect(await capped(fetchImpl).downloadReport("/v1/salesReports", {})).toBe(tsv);
  });
});

describe("AppStoreConnectClient.getPublicJson", () => {
  const clientWith = (fetchImpl: ReturnType<typeof vi.fn>): AppStoreConnectClient =>
    new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });

  // The JWT authorizes the whole account; a public endpoint must never see it.
  it("never sends the JWT to the public lookup host", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ resultCount: 0, results: [] }));

    await clientWith(fetchImpl).getPublicJson("https://itunes.apple.com/lookup?id=1&country=fr");

    expect(callUrl(fetchImpl)).toBe("https://itunes.apple.com/lookup?id=1&country=fr");
    const headers = callInit(fetchImpl).headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("refuses any other host before fetching", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));

    await expect(
      clientWith(fetchImpl).getPublicJson("https://evil.example.com/lookup?id=1"),
    ).rejects.toThrow(/not a known public Apple endpoint/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("AppStoreConnectClient request accept override", () => {
  it("sends the Accept type the caller names", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ productData: [] }));
    const client = new AppStoreConnectClient({
      tokenProvider: spyProvider(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.request("GET", "/v1/diagnosticSignatures/s1/logs", {
      accept: "application/vnd.apple.diagnostic-logs+json",
    });

    expect((callInit(fetchImpl).headers as Record<string, string>).Accept).toBe(
      "application/vnd.apple.diagnostic-logs+json",
    );
  });
});
