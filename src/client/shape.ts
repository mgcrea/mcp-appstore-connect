// App Store Connect answers with JSON:API envelopes: a `data` array (or object)
// of resources, each `{ type, id, attributes, relationships, links }`, plus
// top-level `included`, `links` and `meta`. The `relationships`/`links` blocks
// are self-referential URL noise that swamps the context window, so list tools
// keep just `{ id, type, ...attributes }` and the pagination cursor.

export type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `data` object of a single-resource response, or `{}` when it is absent. */
export const resourceOf = (response: unknown): Rec =>
  isRecord(response) && isRecord(response.data) ? response.data : {};

/** The `data` array of a collection response, or `[]` for anything else. */
export const resourcesOf = (response: unknown): Rec[] =>
  isRecord(response) && Array.isArray(response.data) ? response.data.filter(isRecord) : [];

export const attributesOf = (res: Rec): Rec => (isRecord(res.attributes) ? res.attributes : {});

/** The id on the far side of a to-one relationship, e.g. which app a build belongs to. */
export const relatedId = (res: Rec, name: string): string | undefined => {
  const rels = isRecord(res.relationships) ? res.relationships : {};
  const rel = isRecord(rels[name]) ? (rels[name] as Rec) : {};
  return isRecord(rel.data) && typeof rel.data.id === "string" ? rel.data.id : undefined;
};

/** Pull the first sideloaded resource of a type out of the top-level `included` array. */
export const firstIncluded = (response: unknown, type: string): Rec | undefined => {
  if (!isRecord(response) || !Array.isArray(response.included)) return undefined;
  return response.included.find((item) => isRecord(item) && item.type === type) as Rec | undefined;
};

/** Every sideloaded resource of a type, for the to-many side of an `include`. */
export const includedOf = (response: unknown, type: string): Rec[] => {
  if (!isRecord(response) || !Array.isArray(response.included)) return [];
  return response.included.filter((item): item is Rec => isRecord(item) && item.type === type);
};

/**
 * Sideloaded resources of a type, keyed by id, so each parent can be matched to
 * its own.
 *
 * `firstIncluded` is right for a single-resource response and quietly wrong for
 * a collection: ten versions with ten sideloaded builds would every one of them
 * be handed `included[0]`, and the result reads as ten apps sharing a binary
 * rather than as a bug.
 */
export const includedIndex = (response: unknown, type: string): Map<string, Rec> =>
  new Map(
    includedOf(response, type)
      .filter((res) => typeof res.id === "string")
      .map((res) => [res.id as string, res] as const),
  );

export type Resource = {
  type?: unknown;
  id?: unknown;
  attributes?: Rec;
};

/** Flatten one JSON:API resource to `{ id, type, ...attributes }`. */
export const summarizeResource = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const { id, type, attributes } = value as Resource;
  if (id === undefined && attributes === undefined) return value;
  return { id, type, ...(isRecord(attributes) ? attributes : {}) };
};

/**
 * Whether this page is only part of the collection, and by how much.
 *
 * Apple puts the full count in `meta.paging.total` and quietly caps `data` at
 * `limit`. Nothing in the rows themselves says they are a subset, so a caller
 * reading a full page concludes the collection is what it can see — and then
 * reports something as ABSENT because it fell off the end. That happened for
 * real: a capped `list_builds` page was read as "half the upload never landed",
 * which would have sent someone re-uploading a build that was already there.
 *
 * Returned as a block rather than a bare flag so the numbers travel with the
 * claim, and named for what it says about the DATA — `truncated` already means
 * something else on the report envelope.
 */
const incompletePage = (
  data: unknown[],
  meta: unknown,
  next: string | undefined,
): Rec | undefined => {
  const paging = isRecord(meta) && isRecord(meta.paging) ? meta.paging : undefined;
  const total = typeof paging?.total === "number" ? paging.total : undefined;
  const missing = total === undefined ? undefined : total - data.length;
  if (missing === undefined) {
    // No total from Apple — a `next` link is then the only evidence, and it is
    // enough to know the page is not the whole collection.
    if (next === undefined) return undefined;
    return {
      returned: data.length,
      note:
        `This is one page, and more exist. Do NOT read anything as absent because it is not ` +
        `here — raise \`limit\` (max 200) or follow \`links.next\`.`,
    };
  }
  if (missing <= 0) return undefined;
  return {
    returned: data.length,
    total,
    missing,
    note:
      `This page holds ${data.length} of ${total}; ${missing} did not fit. Do NOT read anything ` +
      `as absent because it is not here — raise \`limit\` (max 200), narrow the filter, or ` +
      `follow \`links.next\`.`,
  };
};

/**
 * Summarize a full list/single response: flatten each resource in `data` and
 * surface `meta` (totals) and `links.next` (the pagination cursor) when present.
 *
 * A partial page also gets an `incomplete` block, because a capped list read as
 * a complete one is how a present thing gets reported missing.
 */
export const summarizeResponse = (response: unknown): unknown => {
  if (!isRecord(response) || !("data" in response)) return response;
  const { data, meta, links } = response as { data: unknown; meta?: unknown; links?: Rec };
  const summarizedData = Array.isArray(data)
    ? data.map(summarizeResource)
    : summarizeResource(data);
  const next = isRecord(links) && typeof links.next === "string" ? links.next : undefined;
  const incomplete = Array.isArray(data) ? incompletePage(data, meta, next) : undefined;
  return {
    data: summarizedData,
    ...(incomplete !== undefined ? { incomplete } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(next !== undefined ? { links: { next } } : {}),
  };
};
