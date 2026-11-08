/**
 * Fixtures and assertions shared by the tool tests under test/tools/: a server
 * wired to a stub fetch, and readers for the calls it made and the results it gave.
 */
import { gzipSync } from "node:zlib";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { vi } from "vitest";

import { staticTokenProvider } from "#/client/auth";
import type { Config } from "#/config";
import { createServer } from "#/server";
export const baseConfig: Config = {
  keyId: "ABCD123456",
  issuerId: "69a6de70-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
  allowWrites: false,
  maxRetries: 3,
  tokenTtlSeconds: 1140,
  metadataRoot: "fastlane/metadata",
};

export const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Apple answers the report endpoints with a gzipped TSV, not JSON. */
export const gzipResponse = (body: string): Response =>
  new Response(gzipSync(Buffer.from(body)), {
    status: 200,
    headers: { "content-type": "application/a-gzip" },
  });

export const connect = async (
  config: Config,
  fetchImpl: typeof fetch = vi.fn(async () =>
    jsonResponse({ data: [] }),
  ) as unknown as typeof fetch,
): Promise<Client> => {
  const { server } = createServer({
    config,
    fetch: fetchImpl,
    tokenProvider: staticTokenProvider("jwt-token"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

export const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((t) => t.name).toSorted();

export const callArgs = (fetchImpl: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] =>
  fetchImpl.mock.calls[index] as unknown as [string, RequestInit];

export const patchCall = (fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit] | undefined =>
  fetchImpl.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH") as
    | [string, RequestInit]
    | undefined;

export const postCall = (
  fetchImpl: ReturnType<typeof vi.fn>,
  path: string,
): [string, RequestInit] | undefined =>
  fetchImpl.mock.calls.find(
    (call) =>
      String(call[0]).includes(path) && (call[1] as RequestInit | undefined)?.method === "POST",
  ) as [string, RequestInit] | undefined;

export const deleteCall = (
  fetchImpl: ReturnType<typeof vi.fn>,
): [string, RequestInit] | undefined =>
  fetchImpl.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "DELETE") as
    | [string, RequestInit]
    | undefined;

export const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

/**
 * The parsed tool payload. Prefer this over matching `textOf` against a
 * serialized spelling: an assertion on `'"created": true'` pins the formatting
 * of the response rather than its content, and breaks the moment ok() stops
 * pretty-printing.
 */
export const payloadOf = (
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> => JSON.parse(textOf(result) || "{}") as Record<string, unknown>;

/** One draft submission item, linked to a version by relationship. */
export const submissionItemFor = (versionId: string): unknown => ({
  id: "item-1",
  type: "reviewSubmissionItems",
  relationships: { appStoreVersion: { data: { id: versionId, type: "appStoreVersions" } } },
});

/** A one-segment `/segments` listing, with the attributes the test cares about. */
export const segmentsBody = (attributes: Record<string, unknown>): unknown => ({
  data: [{ id: "seg-1", type: "analyticsReportSegments", attributes }],
});

export const groupBody = (attributes: Record<string, unknown>): unknown => ({
  data: { id: "g-new", type: "betaGroups", attributes },
});

export const analyticsRequest = (id: string, accessType: string): unknown => ({
  id,
  type: "analyticsReportRequests",
  attributes: { accessType, stoppedDueToInactivity: false },
});

export const analyticsReport = (id: string, category: string): unknown => ({
  id,
  type: "analyticsReports",
  attributes: { name: `Report ${id}`, category },
});

export const analyticsInstance = (id: string, processingDate: string): unknown => ({
  id,
  type: "analyticsReportInstances",
  attributes: { granularity: "DAILY", processingDate },
});

// The five gates a first submission trips over live on the app and the appInfo,
// not on the version — so nothing in the version's own state hints at them, and
// Apple reports each one against a resource path with no id to chase.
export const notFound = (): Response =>
  new Response(JSON.stringify({ errors: [{ status: "404", code: "NOT_FOUND" }] }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

export const bodyOf = (init: RequestInit | undefined): Record<string, unknown> =>
  JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

export type Route = (url: URL, init: RequestInit) => Response | undefined;

/**
 * A stub App Store Connect that answers by method and path, and records every
 * call. Unrouted requests fail the test loudly instead of returning `{data: []}`.
 */
export const stub = (routes: Route[]) =>
  vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    for (const route of routes) {
      const res = route(url, init);
      if (res) return res;
    }
    throw new Error(`unrouted ${init.method ?? "GET"} ${url.pathname}${url.search}`);
  });

/** One route: answer `method path` (a string matches exactly, a RegExp by test). */
export const on =
  (method: string, path: string | RegExp, respond: (url: URL, init: RequestInit) => Response) =>
  (url: URL, init: RequestInit): Response | undefined =>
    (init.method ?? "GET") === method &&
    (typeof path === "string" ? url.pathname === path : path.test(url.pathname))
      ? respond(url, init)
      : undefined;

export type Call = [string, RequestInit];

export const callsOf = (fetchImpl: ReturnType<typeof vi.fn>): Call[] =>
  fetchImpl.mock.calls as unknown as Call[];

/** Every call made as `method path`, in order. */
export const callsTo = (
  fetchImpl: ReturnType<typeof vi.fn>,
  method: string,
  path: string,
): Call[] =>
  callsOf(fetchImpl).filter(
    ([url, init]) => (init.method ?? "GET") === method && new URL(url).pathname === path,
  );

/** The JSON body a recorded call sent. */
export const sentBody = (call: Call | undefined): Record<string, any> =>
  JSON.parse(String(call?.[1].body ?? "{}")) as Record<string, any>;

/** An App Store Connect error answer, with Apple's code and detail. */
export const apiError = (status: number, code: string, detail = code): Response =>
  new Response(JSON.stringify({ errors: [{ status: String(status), code, detail }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
