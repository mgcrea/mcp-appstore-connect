import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, resolveConfigPath } from "../src/config.js";

const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const baseEnv = (): NodeJS.ProcessEnv => ({
  APP_STORE_CONNECT_KEY_ID: "ABCD123456",
  APP_STORE_CONNECT_ISSUER_ID: "69a6de70-0000-0000-0000-000000000000",
  APP_STORE_CONNECT_P8: pem,
});

const tmp = (): string => mkdtempSync(join(tmpdir(), "asc-"));

/**
 * Every env-only test must name a config path that does not exist, or it would
 * quietly pick up the developer's real ~/.config/appstore-connect/config.json
 * and pass (or fail) for reasons that have nothing to do with the test.
 */
const noConfig = join(tmp(), "absent.json");

/** Write a config file and return its path. */
const configFile = (contents: unknown, mode = 0o600): string => {
  const path = join(tmp(), "config.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  chmodSync(path, mode);
  return path;
};

const keyFile = (): string => {
  const path = join(tmp(), "AuthKey.p8");
  writeFileSync(path, pem);
  return path;
};

describe("loadConfig", () => {
  it("reads an inline PEM and applies defaults", () => {
    const config = loadConfig(baseEnv(), noConfig);
    expect(config.keyId).toBe("ABCD123456");
    expect(config.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(config.allowWrites).toBe(false);
    expect(config.maxRetries).toBe(3);
    expect(config.tokenTtlSeconds).toBe(1140);
    expect(config.vendorNumber).toBeUndefined();
    expect(config.metadataRoot).toBe("fastlane/metadata");
  });

  it("reads the key from a .p8 file path", () => {
    const env = {
      APP_STORE_CONNECT_KEY_ID: "ABCD123456",
      APP_STORE_CONNECT_ISSUER_ID: "69a6de70-0000-0000-0000-000000000000",
      APP_STORE_CONNECT_P8_PATH: keyFile(),
    };
    expect(loadConfig(env, noConfig).privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it("rejects setting both inline and path", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), APP_STORE_CONNECT_P8_PATH: "/tmp/whatever.p8" }, noConfig),
    ).toThrow(/only one/i);
  });

  it("errors clearly when no key is provided", () => {
    const env = {
      APP_STORE_CONNECT_KEY_ID: "ABCD123456",
      APP_STORE_CONNECT_ISSUER_ID: "69a6de70-0000-0000-0000-000000000000",
    };
    expect(() => loadConfig(env, noConfig)).toThrow(/No private key/);
  });

  it("requires key id and issuer id", () => {
    expect(() => loadConfig({ APP_STORE_CONNECT_P8: pem }, noConfig)).toThrow();
  });

  it("parses the write flag and vendor number", () => {
    const config = loadConfig(
      {
        ...baseEnv(),
        APP_STORE_CONNECT_ALLOW_WRITES: "true",
        APP_STORE_CONNECT_VENDOR_NUMBER: "80000123",
      },
      noConfig,
    );
    expect(config.allowWrites).toBe(true);
    expect(config.vendorNumber).toBe("80000123");
  });

  it("rejects a private key that isn't a PEM", () => {
    expect(() => loadConfig({ ...baseEnv(), APP_STORE_CONNECT_P8: "not-a-key" }, noConfig)).toThrow(
      /PEM/,
    );
  });
});

describe("loadConfig from a config file", () => {
  it("loads everything from the file when the environment is empty", () => {
    const path = configFile({
      keyId: "ABCD123456",
      issuerId: "69a6de70-0000-0000-0000-000000000000",
      p8Path: keyFile(),
      vendorNumber: "80000123",
      allowWrites: true,
      maxRetries: 5,
      tokenTtlSeconds: 600,
    });
    const config = loadConfig({}, path);
    expect(config.keyId).toBe("ABCD123456");
    expect(config.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(config.vendorNumber).toBe("80000123");
    expect(config.allowWrites).toBe(true);
    expect(config.maxRetries).toBe(5);
    expect(config.tokenTtlSeconds).toBe(600);
  });

  it("accepts an inline PEM in the file", () => {
    const path = configFile({
      keyId: "ABCD123456",
      issuerId: "69a6de70-0000-0000-0000-000000000000",
      p8: pem,
    });
    expect(loadConfig({}, path).privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it("lets the environment override the file field by field", () => {
    const path = configFile({
      keyId: "FILEKEY123",
      issuerId: "69a6de70-0000-0000-0000-000000000000",
      p8: pem,
      allowWrites: true,
    });
    const config = loadConfig({ APP_STORE_CONNECT_KEY_ID: "ENVKEY9999" }, path);
    expect(config.keyId).toBe("ENVKEY9999"); // env wins
    expect(config.issuerId).toBe("69a6de70-0000-0000-0000-000000000000"); // file fills the gap
    expect(config.allowWrites).toBe(true); // untouched by env
  });

  it("lets the environment turn writes back off", () => {
    const path = configFile({
      keyId: "ABCD123456",
      issuerId: "69a6de70-0000-0000-0000-000000000000",
      p8: pem,
      allowWrites: true,
    });
    expect(loadConfig({ APP_STORE_CONNECT_ALLOW_WRITES: "0" }, path).allowWrites).toBe(false);
  });

  it("does not treat an env inline PEM as conflicting with a file p8Path", () => {
    const path = configFile({
      keyId: "ABCD123456",
      issuerId: "69a6de70-0000-0000-0000-000000000000",
      p8Path: "/nonexistent/key.p8",
    });
    // The env names a key, so it wins outright rather than colliding.
    expect(loadConfig({ APP_STORE_CONNECT_P8: pem }, path).privateKey).toContain("BEGIN");
  });

  it("rejects a file naming both p8 and p8Path", () => {
    const path = configFile({
      keyId: "ABCD123456",
      issuerId: "69a6de70-0000-0000-0000-000000000000",
      p8: pem,
      p8Path: "/tmp/whatever.p8",
    });
    expect(() => loadConfig({}, path)).toThrow(/only one/i);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    const path = configFile({
      keyID: "ABCD123456", // note the typo
      issuerId: "69a6de70-0000-0000-0000-000000000000",
      p8: pem,
    });
    expect(() => loadConfig({}, path)).toThrow(/not valid/i);
  });

  it("names the file when the JSON is malformed", () => {
    const path = configFile("{ not json");
    expect(() => loadConfig({}, path)).toThrow(new RegExp(path.replace(/[/\\]/g, "\\$&")));
  });

  it("is silent when the file is absent", () => {
    expect(() => loadConfig(baseEnv(), join(tmp(), "nope.json"))).not.toThrow();
  });
});

describe("metadataRoot", () => {
  it("reads the root from the config file", () => {
    const path = configFile({
      keyId: "ABCD123456",
      issuerId: "69a6de70-0000-0000-0000-000000000000",
      p8: pem,
      metadataRoot: "AppStore",
    });
    expect(loadConfig({}, path).metadataRoot).toBe("AppStore");
  });

  it("lets the env override the file", () => {
    const path = configFile({
      keyId: "ABCD123456",
      issuerId: "69a6de70-0000-0000-0000-000000000000",
      p8: pem,
      metadataRoot: "AppStore",
    });
    const env = { APP_STORE_CONNECT_METADATA_ROOT: "Metadata" };
    expect(loadConfig(env, path).metadataRoot).toBe("Metadata");
  });

  it("normalizes the value rather than storing it as written", () => {
    const env = { ...baseEnv(), APP_STORE_CONNECT_METADATA_ROOT: "./AppStore/" };
    expect(loadConfig(env, noConfig).metadataRoot).toBe("AppStore");
  });

  it('accepts "." for the repo root', () => {
    const env = { ...baseEnv(), APP_STORE_CONNECT_METADATA_ROOT: "." };
    expect(loadConfig(env, noConfig).metadataRoot).toBe("");
  });

  it("refuses an absolute root, naming what is wrong with it", () => {
    const env = { ...baseEnv(), APP_STORE_CONNECT_METADATA_ROOT: "/etc/metadata" };
    expect(() => loadConfig(env, noConfig)).toThrow(/absolute/i);
  });

  it("refuses a root containing ..", () => {
    const env = { ...baseEnv(), APP_STORE_CONNECT_METADATA_ROOT: "a/../b" };
    expect(() => loadConfig(env, noConfig)).toThrow(/plain relative path/i);
  });
});

describe("resolveConfigPath", () => {
  it("prefers an explicit override", () => {
    expect(resolveConfigPath({ APP_STORE_CONNECT_CONFIG: "/etc/asc.json" })).toBe("/etc/asc.json");
  });

  it("falls back to XDG_CONFIG_HOME", () => {
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "appstore-connect", "config.json"),
    );
  });

  it("expands a leading tilde", () => {
    expect(resolveConfigPath({ APP_STORE_CONNECT_CONFIG: "~/asc.json" })).not.toContain("~");
  });
});
