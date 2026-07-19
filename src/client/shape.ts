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
 * Summarize a full list/single response: flatten each resource in `data` and
 * surface `meta` (totals) and `links.next` (the pagination cursor) when present.
 */
export const summarizeResponse = (response: unknown): unknown => {
  if (!isRecord(response) || !("data" in response)) return response;
  const { data, meta, links } = response as { data: unknown; meta?: unknown; links?: Rec };
  const summarizedData = Array.isArray(data)
    ? data.map(summarizeResource)
    : summarizeResource(data);
  const next = isRecord(links) && typeof links.next === "string" ? links.next : undefined;
  return {
    data: summarizedData,
    ...(meta !== undefined ? { meta } : {}),
    ...(next !== undefined ? { links: { next } } : {}),
  };
};
