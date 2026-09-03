import type { Logger } from "#/client/auth";

export type QueryValue = string | number | boolean | string[] | undefined;
export type Query = Record<string, QueryValue>;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

export const safeJsonParse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
};

/**
 * Array values are joined with commas rather than repeated as separate keys.
 * That is the JSON:API convention App Store Connect expects for its bracketed
 * sparse-fieldset and filter params (`fields[apps]=name,bundleId`,
 * `filter[bundleId]=com.acme`), and the bracketed keys pass through
 * URLSearchParams literally. CloudKit takes plain keys and is unaffected.
 */
export const buildQuery = (query: Query | undefined): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

export type RetryPolicy = {
  maxRetries: number;
  /** Prefix for the debug/warn lines, e.g. `GET https://…` or `PUT asset part 1/2`. */
  label: string;
  /** Log prefix identifying the service, e.g. `[appstore-connect]`. */
  tag: string;
  logger?: Logger | undefined;
  /**
   * Invoked before retrying a 401. Omitted for Apple's pre-signed upload URLs,
   * where a 401/403 means the URL expired and reminting the JWT cannot help —
   * and for CloudKit, whose management token is static, so a 401 means the token
   * is wrong or revoked and retrying it would only burn the budget.
   */
  onUnauthorized?: (() => void) | undefined;
};

/** Run `perform` until it yields a non-retryable response or the budget runs out. */
export const withRetry = async (
  perform: () => Promise<Response>,
  policy: RetryPolicy,
): Promise<Response> => {
  let attempt = 0;

  for (;;) {
    policy.logger?.debug?.(`${policy.tag} ${policy.label} (attempt ${attempt + 1})`);
    const res = await perform();

    if (res.status === 401 && policy.onUnauthorized && attempt < policy.maxRetries) {
      policy.logger?.warn?.(`${policy.tag} HTTP 401 — reminting token and retrying`);
      policy.onUnauthorized();
      attempt += 1;
      continue;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < policy.maxRetries) {
      const delay = retryAfterMs(res) ?? backoffMs(attempt);
      policy.logger?.warn?.(`${policy.tag} HTTP ${res.status} — retrying in ${delay}ms`);
      await sleep(delay);
      attempt += 1;
      continue;
    }

    return res;
  }
};
