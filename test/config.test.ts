import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const baseEnv = (): NodeJS.ProcessEnv => ({
  APP_STORE_CONNECT_KEY_ID: "ABCD123456",
  APP_STORE_CONNECT_ISSUER_ID: "69a6de70-0000-0000-0000-000000000000",
  APP_STORE_CONNECT_P8: pem,
});

describe("loadConfig", () => {
  it("reads an inline PEM and applies defaults", () => {
    const config = loadConfig(baseEnv());
    expect(config.keyId).toBe("ABCD123456");
    expect(config.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(config.allowWrites).toBe(false);
    expect(config.maxRetries).toBe(3);
    expect(config.tokenTtlSeconds).toBe(1140);
    expect(config.vendorNumber).toBeUndefined();
  });

  it("reads the key from a .p8 file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "asc-"));
    const path = join(dir, "AuthKey.p8");
    writeFileSync(path, pem);
    const env = {
      APP_STORE_CONNECT_KEY_ID: "ABCD123456",
      APP_STORE_CONNECT_ISSUER_ID: "69a6de70-0000-0000-0000-000000000000",
      APP_STORE_CONNECT_P8_PATH: path,
    };
    expect(loadConfig(env).privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it("rejects setting both inline and path", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), APP_STORE_CONNECT_P8_PATH: "/tmp/whatever.p8" }),
    ).toThrow(/only one/i);
  });

  it("errors clearly when no key is provided", () => {
    const env = {
      APP_STORE_CONNECT_KEY_ID: "ABCD123456",
      APP_STORE_CONNECT_ISSUER_ID: "69a6de70-0000-0000-0000-000000000000",
    };
    expect(() => loadConfig(env)).toThrow(/No private key/);
  });

  it("requires key id and issuer id", () => {
    expect(() => loadConfig({ APP_STORE_CONNECT_P8: pem })).toThrow();
  });

  it("parses the write flag and vendor number", () => {
    const config = loadConfig({
      ...baseEnv(),
      APP_STORE_CONNECT_ALLOW_WRITES: "true",
      APP_STORE_CONNECT_VENDOR_NUMBER: "80000123",
    });
    expect(config.allowWrites).toBe(true);
    expect(config.vendorNumber).toBe("80000123");
  });

  it("rejects a private key that isn't a PEM", () => {
    expect(() => loadConfig({ ...baseEnv(), APP_STORE_CONNECT_P8: "not-a-key" })).toThrow(/PEM/);
  });
});
