// Build-time / runtime identity for the running server. `name`/`version` are
// read from package.json at startup (always accurate); `gitCommit` /
// `gitCommitDate` are injected by tsdown's `define` substitution at build time
// and fall back to "unknown" when running from source (e.g. vitest).

import { readFileSync } from "node:fs";

// oxlint-disable no-underscore-dangle -- bundler-injected build-time constants.
declare const __GIT_COMMIT__: string;
declare const __GIT_COMMIT_DATE__: string;

type PackageJson = { name: string; version: string };

const readPackageJson = (): PackageJson => {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    return JSON.parse(readFileSync(pkgUrl, "utf8")) as PackageJson;
  } catch {
    return { name: "@mgcrea/mcp-appstore-connect", version: "0.0.0" };
  }
};

const pkg = readPackageJson();

export type BuildInfo = {
  name: string;
  version: string;
  gitCommit: string;
  gitCommitDate: string;
};

export const BUILD_INFO: BuildInfo = {
  name: pkg.name,
  version: pkg.version,
  gitCommit: typeof __GIT_COMMIT__ === "string" ? __GIT_COMMIT__ : "unknown",
  gitCommitDate: typeof __GIT_COMMIT_DATE__ === "string" ? __GIT_COMMIT_DATE__ : "unknown",
};
