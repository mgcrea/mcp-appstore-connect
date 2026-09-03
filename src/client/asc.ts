import { gunzipSync } from "node:zlib";

import type { Logger, TokenProvider } from "#/client/auth";
import {
  type AppStoreConnectError,
  AppStoreConnectApiError,
  flattenAssociatedErrors,
  formatAssociatedError,
} from "#/client/errors";
import { buildQuery, safeJsonParse, withRetry, type Query } from "#/client/http";

export type { Query, QueryValue } from "#/client/http";

export type RequestOptions = {
  query?: Query;
  body?: unknown;
};

export type AscClientOptions = {
  baseUrl?: string;
  tokenProvider: TokenProvider;
  maxRetries?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
};

const DEFAULT_BASE_URL = "https://api.appstoreconnect.apple.com";

/** Log prefix for this client's retry lines. */
const TAG = "[appstore-connect]";

/**
 * Analytics report segments are served from a blob store rather than the API
 * host, so `relativize()`'s same-origin rule cannot gate them.
 *
 * The URL arrives inside an authenticated response we just made, so that — not
 * the hostname — is the real guard; this list is defence in depth against
 * following a redirected or tampered url. It has to name every host Apple
 * actually serves from, and `apple.com` alone was not enough: segments come from
 * Apple's `asp-<region>` S3 buckets, so pinning to apple.com refused every
 * analytics download there was.
 */
const DOWNLOAD_HOSTS = [
  /(^|\.)apple\.com$/,
  // e.g. asp-us-west-2.s3.amazonaws.com, and the s3-<region> spelling.
  /^asp-[a-z0-9-]+\.s3[.-][a-z0-9.-]*amazonaws\.com$/,
];

const isGzip = (buf: Buffer): boolean => buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;

/** One leg of an asset upload, as handed back in an `uploadOperations` attribute. */
export type UploadOperation = {
  method?: string;
  url?: string;
  length?: number;
  offset?: number;
  requestHeaders?: { name?: string; value?: string }[];
};

/**
 * Apple echoes `Content-Length` back in `requestHeaders`, but undici computes it
 * itself and rejects the request when it is set by hand. Same for the other
 * connection-level headers, so drop them rather than passing them through.
 */
const UNSETTABLE_UPLOAD_HEADERS = new Set([
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
]);

/**
 * Minimal fetch-based client for the App Store Connect API. Paths are absolute
 * (`/v1/apps`). Retries a 401 (reminting the token first) and 429/5xx with
 * exponential backoff honoring `Retry-After`.
 */
export class AppStoreConnectClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: TokenProvider;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly userAgent: string;

  constructor(opts: AscClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.tokenProvider = opts.tokenProvider;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.userAgent = opts.userAgent ?? "mcp-appstore-connect-js";
  }

  /** Issue a request, returning the raw `Response` after the retry loop. */
  private async fetchWithRetry(
    method: string,
    path: string,
    opts: RequestOptions,
    accept: string,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    const hasBody = opts.body !== undefined;

    return withRetry(
      async () => {
        const token = await this.tokenProvider.getToken();
        return this.fetchImpl(url, {
          method,
          headers: {
            Accept: accept,
            Authorization: `Bearer ${token}`,
            "User-Agent": this.userAgent,
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
          },
          ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
        });
      },
      {
        maxRetries: this.maxRetries,
        label: `${method} ${url}`,
        tag: TAG,
        logger: this.logger,
        onUnauthorized: () => this.tokenProvider.invalidate(),
      },
    );
  }

  /**
   * Execute the `uploadOperations` Apple hands back when an asset is reserved
   * (a screenshot, app preview, …). These URLs are absolute and pre-signed, so
   * this deliberately skips `baseUrl`, the `Authorization` header and the JSON
   * encoding that `request()` applies — sending a Bearer token to Apple's blob
   * store gets the request rejected.
   *
   * Parts go up sequentially: assets are a few MB and usually a single
   * operation, so parallelism would add failure modes for no real gain. The
   * URLs are short-lived and single-use, so a failure here is not resumable.
   */
  async uploadAsset(operations: UploadOperation[], data: Uint8Array): Promise<void> {
    if (operations.length === 0) {
      throw new Error(
        "App Store Connect returned no uploadOperations for this asset. It may already have " +
          "been uploaded, or the reservation is in an unexpected state.",
      );
    }

    for (const [index, op] of operations.entries()) {
      const part = `part ${index + 1}/${operations.length}`;
      if (!op.url) {
        throw new Error(`uploadOperations[${index}] has no url — cannot upload ${part}.`);
      }

      const offset = op.offset ?? 0;
      const length = op.length ?? data.byteLength - offset;
      // A view, not a copy — `fetch` honors byteOffset/byteLength.
      const chunk = data.subarray(offset, offset + length);
      if (chunk.byteLength !== length) {
        throw new Error(
          `The file is smaller than the fileSize reserved with App Store Connect (needed bytes ` +
            `${offset}..${offset + length}, file is ${data.byteLength} bytes). The file changed ` +
            `on disk between reservation and upload — re-run the upload.`,
        );
      }

      const headers: Record<string, string> = {};
      for (const header of op.requestHeaders ?? []) {
        if (!header.name || header.value === undefined) continue;
        if (UNSETTABLE_UPLOAD_HEADERS.has(header.name.toLowerCase())) continue;
        headers[header.name] = header.value;
      }

      const url = op.url;
      const res = await withRetry(
        () => this.fetchImpl(url, { method: op.method ?? "PUT", headers, body: chunk }),
        { maxRetries: this.maxRetries, label: `PUT asset ${part}`, tag: TAG, logger: this.logger },
      );

      if (!res.ok) {
        const text = (await res.text()).slice(0, 500);
        throw new AppStoreConnectApiError(
          `Asset upload ${part} failed: HTTP ${res.status} ${res.statusText}` +
            (text ? ` — ${text}` : "") +
            `. App Store Connect upload URLs are short-lived and single-use; re-run the upload.`,
          { status: res.status, errors: text },
        );
      }
    }
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.fetchWithRetry(method, path, opts, "application/json");
    const text = await res.text();

    if (!res.ok) {
      throw new AppStoreConnectApiError(this.errorMessage(res, method, path, text), {
        status: res.status,
        errors: this.parseErrors(text),
      });
    }

    // 201 Created / 200 OK carry a JSON:API envelope; 204 No Content is empty.
    if (res.status === 204 || text.trim() === "") return null as T;
    return safeJsonParse(text) as T;
  }

  /**
   * Download a report. `/v1/salesReports` and `/v1/financeReports` answer with a
   * GZIP-compressed TSV body (not JSON), so this gunzips and returns plain text.
   */
  async downloadReport(path: string, query: Query): Promise<string> {
    const res = await this.fetchWithRetry("GET", path, { query }, "application/a-gzip");
    const buf = Buffer.from(await res.arrayBuffer());

    if (!res.ok) {
      const text = buf.toString("utf8");
      throw new AppStoreConnectApiError(this.errorMessage(res, "GET", path, text), {
        status: res.status,
        errors: this.parseErrors(text),
      });
    }
    return gunzipSync(buf).toString("utf8");
  }

  /**
   * Fetch one of Apple's pre-signed download URLs — the `url` on an analytics
   * report segment — and return its text. Like `uploadAsset`, these URLs carry
   * their own signature and do not live on the API host, so this deliberately
   * skips `baseUrl` and the `Authorization` header; sending the JWT to the blob
   * store gets the request rejected. A 401/403 means the URL expired, which
   * reminting the token cannot fix, so it is not retried.
   *
   * Segments arrive gzipped, but nothing in the response says so reliably, so
   * the magic bytes decide — an uncompressed body is returned as-is rather than
   * failing inside gunzip.
   */
  async downloadSignedFile(url: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Not a valid download URL: ${url}`);
    }
    if (
      parsed.protocol !== "https:" ||
      !DOWNLOAD_HOSTS.some((pattern) => pattern.test(parsed.hostname))
    ) {
      throw new Error(
        `Refusing to download from ${parsed.host} — signed report URLs must be https on an ` +
          `apple.com host or one of Apple's asp-<region> S3 buckets. If Apple handed this url ` +
          `back from a segments listing it is a host this client does not know about yet, and ` +
          `the allowlist needs it; otherwise re-list the segments to get a fresh url.`,
      );
    }

    const res = await withRetry(
      () => this.fetchImpl(url, { method: "GET", headers: { "User-Agent": this.userAgent } }),
      {
        maxRetries: this.maxRetries,
        label: `GET ${parsed.origin}${parsed.pathname}`,
        tag: TAG,
        logger: this.logger,
      },
    );
    const buf = Buffer.from(await res.arrayBuffer());

    if (!res.ok) {
      const text = buf.toString("utf8").slice(0, 500);
      throw new AppStoreConnectApiError(
        `Downloading the report segment failed: HTTP ${res.status} ${res.statusText}` +
          (text ? ` — ${text}` : "") +
          `. Segment URLs are short-lived and expire; re-list the segments for a fresh one.`,
        { status: res.status, errors: text },
      );
    }
    return isGzip(buf) ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  }

  private parseErrors(text: string): AppStoreConnectError[] | unknown {
    const parsed = safeJsonParse(text);
    if (parsed && typeof parsed === "object" && "errors" in parsed) {
      return (parsed as { errors: AppStoreConnectError[] }).errors;
    }
    return parsed;
  }

  private errorMessage(res: Response, method: string, path: string, text: string): string {
    const base =
      `App Store Connect API ${method} ${path} failed: HTTP ${res.status} ${res.statusText}`.trim();
    const errors = this.parseErrors(text);
    const detail = Array.isArray(errors)
      ? errors
          .map((e: AppStoreConnectError) => [e.code, e.title, e.detail].filter(Boolean).join(" — "))
          .filter(Boolean)
          .join("; ")
      : "";
    if (res.status === 401) {
      return (
        `${base} — the JWT was rejected. Check APP_STORE_CONNECT_KEY_ID / ISSUER_ID and that the ` +
        `.p8 matches the key. A team-scoped key also needs a scope claim` +
        (detail ? ` (${detail})` : "")
      );
    }
    if (res.status === 403) {
      return `${base} — authenticated, but this API key's role lacks permission for this resource${detail ? ` (${detail})` : ""}`;
    }
    // The reasons a submission is refused arrive nested rather than in `detail`, and the outer
    // error only says to go and look at them. Spell them out, or the caller is told the version
    // "is not in valid state" and nothing about which six things are missing.
    const associated = flattenAssociatedErrors(errors).map(formatAssociatedError).filter(Boolean);
    const because = associated.length > 0 ? ` Because: ${associated.join("; ")}` : "";
    return base + (detail ? ` — ${detail}` : "") + because;
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  /**
   * Turn an absolute `links.next` back into a path this client can request.
   * Returns undefined when the link points somewhere else entirely, so a
   * surprising cursor ends pagination rather than sending our JWT off-host.
   */
  private relativize(next: string): string | undefined {
    try {
      const url = new URL(next);
      const base = new URL(this.baseUrl);
      if (url.origin !== base.origin) return undefined;
      return `${url.pathname}${url.search}`;
    } catch {
      return undefined;
    }
  }

  /**
   * GET a collection, following `links.next` until it runs out.
   *
   * Apple caps `limit` at 200, so any app with more locales (or screenshots)
   * than that silently truncates without this. The next links are absolute and
   * already carry the cursor *and* every original param, so `query` is applied
   * to the first page only — re-applying it would clobber the cursor.
   */
  async getAll<T = unknown>(
    path: string,
    query?: Query,
    maxPages = 20,
  ): Promise<{ data: T[]; pages: number }> {
    type Envelope = { data?: T[]; links?: { next?: unknown } };
    const collected: T[] = [];
    let nextPath: string | undefined = path;
    let nextQuery = query;
    let pages = 0;

    while (nextPath !== undefined) {
      if (pages >= maxPages) {
        throw new Error(
          `Pagination exceeded ${maxPages} pages for ${path} (${collected.length} items so far). ` +
            `Raise maxPages if this collection is genuinely that large.`,
        );
      }
      const res: Envelope = await this.request<Envelope>("GET", nextPath, { query: nextQuery });
      pages += 1;
      if (Array.isArray(res?.data)) collected.push(...res.data);

      const next = res?.links?.next;
      nextPath = typeof next === "string" ? this.relativize(next) : undefined;
      nextQuery = undefined;
    }

    return { data: collected, pages };
  }

  post<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, { body, query });
  }

  patch<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("PATCH", path, { body, query });
  }

  del<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, { body, query });
  }
}
