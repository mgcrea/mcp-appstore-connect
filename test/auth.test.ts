import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createTokenProvider, signJwt, type JwtCredentials } from "../src/client/auth.js";

/** A throwaway EC P-256 keypair — the curve App Store Connect's ES256 uses. */
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const creds: JwtCredentials = {
  keyId: "ABCD123456",
  issuerId: "69a6de70-0000-0000-0000-000000000000",
  privateKey: privateKeyPem,
};

const decodeSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;

describe("signJwt", () => {
  it("produces a well-formed ES256 App Store Connect JWT", () => {
    const jwt = signJwt(creds, 1_700_000_000, 1140);
    const [headerB64, payloadB64] = jwt.split(".");
    const header = decodeSegment(headerB64!);
    const payload = decodeSegment(payloadB64!);

    expect(header).toMatchObject({ alg: "ES256", kid: "ABCD123456", typ: "JWT" });
    expect(payload).toMatchObject({
      iss: creds.issuerId,
      aud: "appstoreconnect-v1",
      iat: 1_700_000_000,
      exp: 1_700_000_000 + 1140,
    });
    // No scope claim for an individual key.
    expect(payload).not.toHaveProperty("scope");
  });

  it("signs with the IEEE-P1363 form that Apple accepts (verifiable by the public key)", () => {
    const jwt = signJwt(creds, 1_700_000_000, 1140);
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const signingInput = `${headerB64}.${payloadB64}`;

    const verified = createVerify("SHA256")
      .update(signingInput)
      .verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sigB64!, "base64url"));
    expect(verified).toBe(true);
  });

  it("includes a scope claim only when one is configured", () => {
    const jwt = signJwt({ ...creds, scope: ["GET /v1/apps"] }, 1_700_000_000, 1140);
    const payload = decodeSegment(jwt.split(".")[1]!);
    expect(payload.scope).toEqual(["GET /v1/apps"]);
  });
});

describe("createTokenProvider", () => {
  it("caches the token until the refresh skew window, then remints", async () => {
    let clock = 1_700_000_000_000;
    const provider = createTokenProvider({
      credentials: creds,
      ttlSeconds: 1140,
      refreshSkewSeconds: 60,
      now: () => clock,
    });

    const first = await provider.getToken();
    expect(await provider.getToken()).toBe(first); // still cached

    // Advance past (ttl - skew) = 1080s → a fresh token is minted.
    clock += 1_081_000;
    expect(await provider.getToken()).not.toBe(first);
  });

  it("remints immediately after invalidate()", async () => {
    let clock = 1_700_000_000_000;
    const provider = createTokenProvider({ credentials: creds, now: () => clock });
    const first = await provider.getToken();
    provider.invalidate();
    // Same clock, but the cache was dropped → a new token (different iat is not
    // guaranteed at the same second, so assert it re-signs by clearing cache path).
    clock += 1000;
    expect(await provider.getToken()).not.toBe(first);
  });
});
