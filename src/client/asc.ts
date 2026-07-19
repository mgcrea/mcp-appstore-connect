import { gunzipSync } from "node:zlib";

import type { Logger, TokenProvider } from "./auth.js";
import { type AppStoreConnectError, AppStoreConnectApiError } from "./errors.js";

export type QueryValue = string | number | boolean | string[] | undefined;
export type Query = Record<string, QueryValue>;

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

const safeJsonParse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
};

/**
 * App Store Connect takes bracketed sparse-fieldset and filter params
 * (`fields[apps]=name,bundleId`, `filter[bundleId]=com.acme`). Array values are
 * joined with commas — that's the JSON:API convention Apple expects, NOT
 * repeated keys. The bracketed keys pass through URLSearchParams literally.
 */
const buildQuery = (query: Query | undefined): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

type RetryPolicy = {
  maxRetries: number;
  /** Prefix for the debug/warn lines, e.g. `GET https://…` or `PUT asset part 1/2`. */
  label: string;
  logger?: Logger | undefined;
  /**
   * Invoked before retrying a 401. Omitted for Apple's pre-signed upload URLs,
   * where a 401/403 means the URL expired and reminting the JWT cannot help.
   */
  onUnauthorized?: (() => void) | undefined;
};

/** Run `perform` until it yields a non-retryable response or the budget runs out. */
const withRetry = async (
  perform: () => Promise<Response>,
  policy: RetryPolicy,
): Promise<Response> => {
  let attempt = 0;

  for (;;) {
    policy.logger?.debug?.(`[appstore-connect] ${policy.label} (attempt ${attempt + 1})`);
    const res = await perform();

    if (res.status === 401 && policy.onUnauthorized && attempt < policy.maxRetries) {
      policy.logger?.warn?.(`[appstore-connect] HTTP 401 — reminting token and retrying`);
      policy.onUnauthorized();
      attempt += 1;
      continue;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < policy.maxRetries) {
      const delay = retryAfterMs(res) ?? backoffMs(attempt);
      policy.logger?.warn?.(`[appstore-connect] HTTP ${res.status} — retrying in ${delay}ms`);
      await sleep(delay);
      attempt += 1;
      continue;
    }

    return res;
  }
};

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
        { maxRetries: this.maxRetries, label: `PUT asset ${part}`, logger: this.logger },
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
    return base + (detail ? ` — ${detail}` : "");
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
