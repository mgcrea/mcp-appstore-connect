import type { AppStoreConnectClient } from "../client/asc.js";
import {
  APP_INFO_ATTRIBUTES,
  VERSION_ATTRIBUTES,
  type ListingDocument,
  type ListingField,
  type LocaleFields,
  digest,
} from "./document.js";

type Rec = Record<string, unknown>;

type Resource = {
  id?: unknown;
  type?: unknown;
  attributes?: Rec;
  relationships?: Record<string, { data?: { id?: unknown } | null } | undefined>;
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const attr = (resource: Resource | undefined, key: string): string | undefined =>
  str(resource?.attributes?.[key]);

const relationshipId = (resource: Resource | undefined, key: string): string | undefined =>
  str(resource?.relationships?.[key]?.data?.id);

/**
 * Compare version strings numerically, segment by segment. A lexical sort puts
 * "1.10.0" before "1.9.0", which silently exports the wrong version's copy —
 * the kind of bug you only notice after pushing release notes to the wrong one.
 */
const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
};

/**
 * Which version "latest" means. Ordered by how much it looks like the version
 * you are currently preparing: anything editable beats anything shipped.
 */
const STATE_PRECEDENCE = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "METADATA_REJECTED",
  "REJECTED",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "PENDING_DEVELOPER_RELEASE",
  "READY_FOR_SALE",
];

/** States whose appInfo is frozen — the editable record is the other one. */
const FROZEN_APP_INFO_STATES = new Set(["READY_FOR_SALE", "REPLACED_WITH_NEW_INFO"]);

export class ListingFetchError extends Error {}

export const selectVersion = (versions: Resource[], selector: string): Resource => {
  if (versions.length === 0) {
    throw new ListingFetchError(
      "This app has no App Store versions for that platform. Create one with " +
        "app_store_connect_create_version first.",
    );
  }

  const describe = (): string =>
    versions
      .map((v) => `${attr(v, "versionString") ?? "?"} (${attr(v, "appStoreState") ?? "?"})`)
      .join(", ");

  if (selector === "latest" || selector === "live") {
    const states = selector === "live" ? ["READY_FOR_SALE"] : STATE_PRECEDENCE;
    for (const state of states) {
      const matches = versions
        .filter((v) => attr(v, "appStoreState") === state)
        .toSorted((a, b) =>
          compareVersions(attr(b, "versionString") ?? "0", attr(a, "versionString") ?? "0"),
        );
      const best = matches[0];
      if (best) return best;
    }
    throw new ListingFetchError(
      selector === "live"
        ? `No version is READY_FOR_SALE. Available: ${describe()}.`
        : `No version is in an editable or shipped state. Available: ${describe()}.`,
    );
  }

  const exact = versions.find((v) => attr(v, "versionString") === selector);
  if (!exact) {
    throw new ListingFetchError(`No version "${selector}" for this app. Available: ${describe()}.`);
  }
  return exact;
};

/** An app has up to two appInfos; the editable one is whichever is not frozen. */
export const selectAppInfo = (appInfos: Resource[]): Resource => {
  if (appInfos.length === 0) {
    throw new ListingFetchError(
      "This app has no appInfo record, so its name, subtitle and privacy policy are unreadable.",
    );
  }
  const editable = appInfos.find((info) => {
    const state = attr(info, "appStoreState") ?? attr(info, "state");
    return state === undefined || !FROZEN_APP_INFO_STATES.has(state);
  });
  return editable ?? (appInfos[0] as Resource);
};

export type LocalizationSet = {
  locales: Record<string, LocaleFields>;
  localizationIds: ListingDocument["localizationIds"];
};

/**
 * Read both halves of the per-locale copy for a version. Apply re-reads through
 * this using the ids recorded at export, rather than re-resolving "latest" —
 * otherwise a version created between export and apply would silently redirect
 * the write to a different version's metadata.
 */
export const fetchLocalizations = async (
  client: AppStoreConnectClient,
  opts: { versionId: string; appInfoId: string; locales?: string[] },
): Promise<LocalizationSet> => {
  const [versionLocs, appInfoLocs] = await Promise.all([
    client.getAll<Resource>(`/v1/appStoreVersions/${opts.versionId}/appStoreVersionLocalizations`, {
      limit: 200,
    }),
    client.getAll<Resource>(`/v1/appInfos/${opts.appInfoId}/appInfoLocalizations`, { limit: 200 }),
  ]);

  const wanted = opts.locales?.length ? new Set(opts.locales) : undefined;
  const locales: Record<string, LocaleFields> = {};
  const localizationIds: ListingDocument["localizationIds"] = {};

  const collect = (
    rows: Resource[],
    mapping: Record<string, string>,
    side: "version" | "appInfo",
  ): void => {
    for (const row of rows) {
      const locale = attr(row, "locale");
      const id = str(row.id);
      if (!locale || !id) continue;
      if (wanted && !wanted.has(locale)) continue;

      (localizationIds[locale] ??= {})[side] = id;
      const fields = (locales[locale] ??= {});
      for (const [field, attribute] of Object.entries(mapping)) {
        const value = row.attributes?.[attribute];
        // null is a real answer here: the field exists and is empty.
        if (value === undefined) continue;
        fields[field as ListingField] = typeof value === "string" ? value : "";
      }
    }
  };

  collect(versionLocs.data, VERSION_ATTRIBUTES, "version");
  collect(appInfoLocs.data, APP_INFO_ATTRIBUTES, "appInfo");

  return { locales, localizationIds };
};

export type FetchListingOptions = {
  appId: string;
  version: string;
  platform: string;
  locales?: string[] | undefined;
  now: () => Date;
};

export const fetchListing = async (
  client: AppStoreConnectClient,
  opts: FetchListingOptions,
): Promise<ListingDocument> => {
  const [app, versionsPage, appInfosPage] = await Promise.all([
    client.get<{ data?: Resource }>(`/v1/apps/${opts.appId}`),
    client.getAll<Resource>(`/v1/apps/${opts.appId}/appStoreVersions`, {
      "filter[platform]": opts.platform,
      limit: 200,
    }),
    client.getAll<Resource>(`/v1/apps/${opts.appId}/appInfos`, { limit: 50 }),
  ]);

  const version = selectVersion(versionsPage.data, opts.version);
  const appInfo = selectAppInfo(appInfosPage.data);
  const versionId = str(version.id);
  const appInfoId = str(appInfo.id);
  if (!versionId || !appInfoId) {
    throw new ListingFetchError("App Store Connect returned a version or appInfo with no id.");
  }

  const { locales, localizationIds } = await fetchLocalizations(client, {
    versionId,
    appInfoId,
    ...(opts.locales !== undefined ? { locales: opts.locales } : {}),
  });

  const wanted = opts.locales?.length ? new Set(opts.locales) : undefined;
  if (wanted) {
    const missing = [...wanted].filter((locale) => locales[locale] === undefined);
    if (missing.length > 0) {
      throw new ListingFetchError(
        `This version has no localization for: ${missing.join(", ")}. Available: ` +
          `${Object.keys(locales).toSorted().join(", ")}.`,
      );
    }
  }

  const baseline: ListingDocument["baseline"] = {};
  for (const [locale, fields] of Object.entries(locales)) {
    const digests: Partial<Record<ListingField, string>> = {};
    for (const [field, value] of Object.entries(fields)) {
      digests[field as ListingField] = digest(value);
    }
    baseline[locale] = digests;
  }

  const primaryLocale =
    attr(app.data, "primaryLocale") ?? Object.keys(locales).toSorted()[0] ?? "en-US";

  return {
    schemaVersion: 1,
    app: {
      id: opts.appId,
      ...(attr(app.data, "bundleId") !== undefined
        ? { bundleId: attr(app.data, "bundleId") as string }
        : {}),
      ...(attr(app.data, "sku") !== undefined ? { sku: attr(app.data, "sku") as string } : {}),
      primaryLocale,
    },
    version: {
      id: versionId,
      versionString: attr(version, "versionString") ?? "",
      platform: attr(version, "platform") ?? opts.platform,
      ...(attr(version, "appStoreState") !== undefined
        ? { appStoreState: attr(version, "appStoreState") as string }
        : {}),
    },
    appInfo: {
      id: appInfoId,
      ...(attr(appInfo, "appStoreState") !== undefined
        ? { appStoreState: attr(appInfo, "appStoreState") as string }
        : {}),
      ...(relationshipId(appInfo, "primaryCategory") !== undefined
        ? { primaryCategory: relationshipId(appInfo, "primaryCategory") as string }
        : {}),
      ...(relationshipId(appInfo, "secondaryCategory") !== undefined
        ? { secondaryCategory: relationshipId(appInfo, "secondaryCategory") as string }
        : {}),
    },
    exportedAt: opts.now().toISOString(),
    localizationIds,
    locales,
    baseline,
  };
};
