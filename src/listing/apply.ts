import type { AppStoreConnectClient } from "../client/asc.js";
import {
  APP_INFO_ATTRIBUTES,
  FIELD_LIMITS,
  FIELD_TARGET,
  VERSION_ATTRIBUTES,
  type ListingField,
  type LocaleFields,
  charCount,
  digest,
  overLimit,
} from "./document.js";
import { fetchLocalizations } from "./fetch.js";
import type { ParsedManifest } from "./manifest.js";

export type ChangeAction =
  | "change"
  | "unchanged"
  | "converged"
  | "conflict"
  | "blocked"
  | "skipped";

export type PlannedChange = {
  locale: string;
  field: ListingField;
  target: "version" | "appInfo";
  action: ChangeAction;
  chars: number;
  limit: number;
  /**
   * Length of the value being replaced, never the value itself. Echoing a
   * 4000-character description back into the conversation burns context for no
   * benefit — the same reason screenshots.ts strips uploadOperations.
   */
  wasLength?: number;
  reason?: string;
};

export type Rejection = {
  locale: string;
  field: ListingField;
  chars: number;
  limit: number;
  overBy: number;
};

export type ApplyOptions = {
  dryRun: boolean;
  force: boolean;
  allowClear: boolean;
  createMissingLocales: boolean;
  locales?: string[] | undefined;
};

export type ApplyResult =
  | { ok: false; rejections: Rejection[] }
  | {
      ok: true;
      dryRun: boolean;
      applied: boolean;
      appId: string;
      versionString: string;
      summary: {
        changed: number;
        unchanged: number;
        converged: number;
        conflicts: number;
        blocked: number;
        skipped: number;
        localesCreated: number;
      };
      changes: PlannedChange[];
      localesCreated: string[];
      failures?: { locale: string; target: string; error: string }[];
    };

const attributeName = (field: ListingField): string =>
  FIELD_TARGET[field] === "version"
    ? (VERSION_ATTRIBUTES as Record<string, string>)[field]!
    : (APP_INFO_ATTRIBUTES as Record<string, string>)[field]!;

/**
 * Decide what a single edited field means, given the value on disk, the value
 * live right now, and the digest recorded when the tree was exported.
 *
 * The three-way comparison is the whole point: two-way (disk vs live) cannot
 * tell "I edited this" from "someone edited this in the web UI while I had the
 * file checked out", and would cheerfully overwrite the second.
 */
export const classify = (
  local: string,
  live: string | undefined,
  baseline: string | undefined,
  force: boolean,
  allowClear: boolean,
): { action: ChangeAction; reason?: string } => {
  if (live === undefined) {
    return {
      action: "skipped",
      reason: "App Store Connect does not return this field for this locale.",
    };
  }
  const drifted = baseline !== undefined && digest(live) !== baseline;

  if (local === live) {
    return drifted
      ? { action: "converged", reason: "Changed upstream to the same value already on disk." }
      : { action: "unchanged" };
  }
  if (drifted && !force) {
    return {
      action: "conflict",
      reason:
        "Changed in App Store Connect since this listing was exported. Re-export and merge, " +
        "or pass force: true to overwrite the upstream edit.",
    };
  }
  // An empty file is how the tree says "clear this field", but it is also what an
  // editor leaves behind when a file gets truncated by accident. Wiping live copy
  // is not something to infer from an absence, so it takes an explicit opt-in.
  if (local === "" && !allowClear) {
    return {
      action: "blocked",
      reason:
        "The file is empty, which would clear this field in App Store Connect. Delete the file " +
        "instead to leave the field alone, or pass allowClear: true if you really mean to clear it.",
    };
  }
  return { action: "change" };
};

export const applyListing = async (
  client: AppStoreConnectClient,
  manifest: ParsedManifest,
  opts: ApplyOptions,
): Promise<ApplyResult> => {
  const { sidecar } = manifest;
  const wanted = opts.locales?.length ? new Set(opts.locales) : undefined;

  const live = await fetchLocalizations(client, {
    versionId: sidecar.version.id,
    appInfoId: sidecar.appInfo.id,
    ...(opts.locales !== undefined ? { locales: opts.locales } : {}),
  });

  const changes: PlannedChange[] = [];
  const rejections: Rejection[] = [];
  const newLocales: string[] = [];

  for (const [locale, fields] of Object.entries(manifest.locales)) {
    if (wanted && !wanted.has(locale)) continue;

    const liveFields: LocaleFields | undefined = live.locales[locale];
    const isNew = liveFields === undefined;

    if (isNew && !opts.createMissingLocales) {
      for (const field of Object.keys(fields) as ListingField[]) {
        changes.push({
          locale,
          field,
          target: FIELD_TARGET[field],
          action: "skipped",
          chars: charCount(fields[field] ?? ""),
          limit: 0,
          reason: `Locale ${locale} does not exist on this version. Pass createMissingLocales: true to add it.`,
        });
      }
      continue;
    }
    if (isNew) newLocales.push(locale);

    for (const field of Object.keys(fields) as ListingField[]) {
      const local = fields[field] as string;
      const chars = charCount(local);
      const limit = FIELD_LIMITS[field];

      const { action, reason } = isNew
        ? { action: "change" as ChangeAction, reason: undefined }
        : classify(
            local,
            liveFields?.[field],
            sidecar.baseline[locale]?.[field],
            opts.force,
            opts.allowClear,
          );

      if (action === "change") {
        const breach = overLimit(field, local);
        if (breach) rejections.push({ locale, ...breach });
      }

      const liveValue = liveFields?.[field];
      changes.push({
        locale,
        field,
        target: FIELD_TARGET[field],
        action,
        chars,
        limit,
        ...(liveValue !== undefined ? { wasLength: charCount(liveValue) } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    }
  }

  // Validate everything before writing anything. A listing that is half-applied
  // because locale 7 blew the keyword limit is worse than one never touched.
  if (rejections.length > 0) return { ok: false, rejections };

  const summary = {
    changed: changes.filter((c) => c.action === "change").length,
    unchanged: changes.filter((c) => c.action === "unchanged").length,
    converged: changes.filter((c) => c.action === "converged").length,
    conflicts: changes.filter((c) => c.action === "conflict").length,
    blocked: changes.filter((c) => c.action === "blocked").length,
    skipped: changes.filter((c) => c.action === "skipped").length,
    localesCreated: opts.dryRun ? newLocales.length : 0,
  };

  const base = {
    ok: true as const,
    dryRun: opts.dryRun,
    appId: sidecar.app.id,
    versionString: sidecar.version.versionString,
    changes,
  };

  if (opts.dryRun) {
    return { ...base, applied: false, summary, localesCreated: newLocales };
  }

  const failures: { locale: string; target: string; error: string }[] = [];
  const created: string[] = [];

  // Sequential on purpose: App Store Connect rate-limits, and "locales 1-3
  // applied, 4 failed" is far more actionable than an interleaved dump.
  for (const locale of new Set(changes.map((c) => c.locale))) {
    const applicable = changes.filter((c) => c.locale === locale && c.action === "change");
    if (applicable.length === 0) continue;
    const isNew = newLocales.includes(locale);

    for (const target of ["version", "appInfo"] as const) {
      const forTarget = applicable.filter((c) => c.target === target);
      if (forTarget.length === 0) continue;

      const attributes: Record<string, string> = {};
      for (const change of forTarget) {
        attributes[attributeName(change.field)] = manifest.locales[locale]?.[change.field] ?? "";
      }

      try {
        if (isNew) {
          await createLocalization(client, sidecar, locale, target, attributes);
        } else {
          const id = live.localizationIds[locale]?.[target];
          if (id === undefined) {
            failures.push({
              locale,
              target,
              error: `No ${target} localization row for ${locale}; nothing to update.`,
            });
            continue;
          }
          await client.patch(
            target === "version"
              ? `/v1/appStoreVersionLocalizations/${id}`
              : `/v1/appInfoLocalizations/${id}`,
            {
              data: {
                type:
                  target === "version" ? "appStoreVersionLocalizations" : "appInfoLocalizations",
                id,
                attributes,
              },
            },
          );
        }
      } catch (err) {
        failures.push({
          locale,
          target,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (isNew && !failures.some((f) => f.locale === locale)) created.push(locale);
  }

  return {
    ...base,
    applied: true,
    summary: { ...summary, localesCreated: created.length },
    localesCreated: created,
    ...(failures.length > 0 ? { failures } : {}),
  };
};

const createLocalization = async (
  client: AppStoreConnectClient,
  sidecar: ParsedManifest["sidecar"],
  locale: string,
  target: "version" | "appInfo",
  attributes: Record<string, string>,
): Promise<void> => {
  const type = target === "version" ? "appStoreVersionLocalizations" : "appInfoLocalizations";
  const relationship =
    target === "version"
      ? { appStoreVersion: { data: { type: "appStoreVersions", id: sidecar.version.id } } }
      : { appInfo: { data: { type: "appInfos", id: sidecar.appInfo.id } } };

  await client.post(`/v1/${type}`, {
    data: { type, attributes: { locale, ...attributes }, relationships: relationship },
  });
};
