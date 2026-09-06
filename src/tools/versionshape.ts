import { attributesOf, includedIndex, type Rec, relatedId, resourceOf } from "#/client/shape";

/**
 * A version together with the binary it would actually ship.
 *
 * `summarizeResponse` drops `relationships` and `included` deliberately — they
 * are URL noise on every other read — but the build link lives in exactly those
 * two places, so the one question worth asking about a version ("which binary
 * does this ship?") is the one its summarized form cannot answer. Both
 * `get_version` and the portfolio rollup rebuild it here rather than each
 * growing their own copy of the same three edge cases.
 */

export type BuildSummary = { id: string } & Rec;

export type VersionWithBuild = {
  id: unknown;
  appId: string | undefined;
  build: BuildSummary | null;
} & Rec;

/**
 * The build attached to a version, from a response that sideloaded builds.
 *
 * Three states, and the difference between the last two matters: `null` means
 * no build is attached, while `{ id }` alone means one is attached but Apple
 * returned the relationship without sideloading the resource. Collapsing those
 * would report "no minOsVersion" for a version that has one — an absence read
 * as a fact, which is the failure this whole module exists to prevent.
 */
export const buildOf = (version: Rec, builds: Map<string, Rec>): BuildSummary | null => {
  const buildId = relatedId(version, "build");
  if (buildId === undefined) return null;
  const build = builds.get(buildId);
  return { id: buildId, ...(build === undefined ? {} : attributesOf(build)) };
};

/** Flatten one version resource, resolving its build against a sideload index. */
export const versionWithBuild = (version: Rec, builds: Map<string, Rec>): VersionWithBuild => ({
  id: version.id,
  ...attributesOf(version),
  appId: relatedId(version, "app"),
  build: buildOf(version, builds),
});

/** The same, for a single-resource response that sideloaded exactly one build. */
export const versionOfResponse = (response: unknown): VersionWithBuild =>
  versionWithBuild(resourceOf(response), includedIndex(response, "builds"));
