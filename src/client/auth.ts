import { createSign } from "node:crypto";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

/**
 * A pluggable source of bearer tokens. The REST client calls `getToken()` on
 * every request and `invalidate()` on a 401 to force the next call to remint.
 */
export type TokenProvider = {
  getToken(): Promise<string>;
  invalidate(): void;
};

export type JwtCredentials = {
  /** The Key ID (`kid`) of the App Store Connect API key (10 chars). */
  keyId: string;
  /** The Issuer ID — a UUID from Users and Access → Integrations → Keys. */
  issuerId: string;
  /** The `.p8` private key, PEM-encoded (`-----BEGIN PRIVATE KEY-----`). */
  privateKey: string;
  /**
   * Team-scoped keys (created under a specific role) reject a token that has no
   * `scope`; individual keys reject one that has it. Leave undefined for the
   * common case and only set it if you hit a 401 with `NOT_AUTHORIZED`.
   * Each entry is `"METHOD /v1/path"`, e.g. `"GET /v1/apps"`.
   */
  scope?: string[] | undefined;
};

const base64url = (input: Buffer | string): string =>
  (typeof input === "string" ? Buffer.from(input) : input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * Mint a signed App Store Connect JWT. The API requires ES256 with the raw
 * `r || s` signature form (JOSE / IEEE P1363) — Node's default ECDSA output is
 * ASN.1/DER, which Apple rejects with `401 NOT_AUTHORIZED`, hence `dsaEncoding`.
 */
export const signJwt = (creds: JwtCredentials, nowSeconds: number, ttlSeconds: number): string => {
  const header = { alg: "ES256", kid: creds.keyId, typ: "JWT" };
  const payload = {
    iss: creds.issuerId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    aud: "appstoreconnect-v1",
    ...(creds.scope && creds.scope.length > 0 ? { scope: creds.scope } : {}),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key: creds.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
};

export type TokenProviderOptions = {
  credentials: JwtCredentials;
  logger?: Logger;
  /**
   * Token lifetime in seconds. Apple caps this at 20 minutes (1200s); default to
   * 19 minutes so a token minted just before a slow request is still valid when
   * it lands.
   */
  ttlSeconds?: number;
  /** Remint this many seconds before expiry. Clamped to half the lifetime. */
  refreshSkewSeconds?: number;
  /** Override `Date.now()` for tests. */
  now?: () => number;
};

/**
 * Caches a locally-signed JWT and remints it shortly before it expires. Unlike
 * an OAuth exchange this needs no network call, so there's no single-flight to
 * coordinate — signing is synchronous and cheap.
 */
export const createTokenProvider = (opts: TokenProviderOptions): TokenProvider => {
  const creds = opts.credentials;
  const ttlSeconds = Math.min(opts.ttlSeconds ?? 1140, 1200);
  const skewSeconds = Math.min(opts.refreshSkewSeconds ?? 60, ttlSeconds / 2);
  const now = opts.now ?? Date.now;

  let cached: { token: string; expiresAt: number } | undefined;

  const mint = (): string => {
    const nowSeconds = Math.floor(now() / 1000);
    const token = signJwt(creds, nowSeconds, ttlSeconds);
    cached = { token, expiresAt: (nowSeconds + ttlSeconds - skewSeconds) * 1000 };
    opts.logger?.debug?.(`[appstore-connect] token minted; valid for ${ttlSeconds}s`);
    return token;
  };

  return {
    async getToken(): Promise<string> {
      if (cached && now() < cached.expiresAt) return cached.token;
      return mint();
    },
    invalidate(): void {
      cached = undefined;
    },
  };
};

/** Trivial token provider that always returns a fixed string. Useful in tests. */
export const staticTokenProvider = (token: string): TokenProvider => ({
  getToken: async () => token,
  invalidate: () => {},
});
