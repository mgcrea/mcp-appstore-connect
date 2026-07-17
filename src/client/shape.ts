// App Store Connect answers with JSON:API envelopes: a `data` array (or object)
// of resources, each `{ type, id, attributes, relationships, links }`, plus
// top-level `included`, `links` and `meta`. The `relationships`/`links` blocks
// are self-referential URL noise that swamps the context window, so list tools
// keep just `{ id, type, ...attributes }` and the pagination cursor.

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
