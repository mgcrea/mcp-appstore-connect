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
    let attempt = 0;

    for (;;) {
      this.logger?.debug?.(`[appstore-connect] ${method} ${url} (attempt ${attempt + 1})`);
      const token = await this.tokenProvider.getToken();
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      });

      if (res.status === 401 && attempt < this.maxRetries) {
        this.logger?.warn?.(`[appstore-connect] HTTP 401 — reminting token and retrying`);
        this.tokenProvider.invalidate();
        attempt += 1;
        continue;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const delay = retryAfterMs(res) ?? backoffMs(attempt);
        this.logger?.warn?.(`[appstore-connect] HTTP ${res.status} — retrying in ${delay}ms`);
        await sleep(delay);
        attempt += 1;
        continue;
      }

      return res;
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
