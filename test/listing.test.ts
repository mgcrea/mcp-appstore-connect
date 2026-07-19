import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "../src/client/auth.js";
import type { Config } from "../src/config.js";
import { digest } from "../src/listing/document.js";
import { createServer } from "../src/server.js";

const baseConfig: Config = {
  keyId: "ABCD123456",
  issuerId: "69a6de70-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
  allowWrites: true,
  maxRetries: 3,
  tokenTtlSeconds: 1140,
  metadataRoot: "fastlane/metadata",
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Export fires several requests in parallel, so the fake routes on URL rather
 * than call order. Longest match wins, otherwise "/v1/apps/1" would swallow
 * "/v1/apps/1/appStoreVersions".
 */
const routes = (map: Record<string, unknown>): ReturnType<typeof vi.fn> => {
  const keys = Object.keys(map).toSorted((a, b) => b.length - a.length);
  return vi.fn(async (url: string) => {
    const key = keys.find((k) => String(url).includes(k));
    if (key === undefined) throw new Error(`unstubbed request: ${String(url)}`);
    return jsonResponse(map[key]);
  });
};

const connect = async (fetchImpl: unknown, config: Config = baseConfig): Promise<Client> => {
  const { server } = createServer({
    config,
    fetch: fetchImpl as typeof fetch,
    tokenProvider: staticTokenProvider("jwt-token"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const text = (result: unknown): string =>
  ((result as { content: { text: string }[] }).content[0] as { text: string }).text;

const resource = (id: string, type: string, attributes: Record<string, unknown>): unknown => ({
  id,
  type,
  attributes,
});

const LIVE_DESCRIPTION = "Live description.";
const LIVE_SUBTITLE = "Live subtitle";

const versionLocalizations = {
  data: [
    resource("vloc-en", "appStoreVersionLocalizations", {
      locale: "en-US",
      description: LIVE_DESCRIPTION,
      keywords: "bucket,storage",
      whatsNew: "Live notes.",
      promotionalText: "Live promo.",
      marketingUrl: null,
      supportUrl: "https://acme.dev/support",
    }),
  ],
};

const appInfoLocalizations = {
  data: [
    resource("aloc-en", "appInfoLocalizations", {
      locale: "en-US",
      name: "Acme",
      subtitle: LIVE_SUBTITLE,
      privacyPolicyUrl: "https://acme.dev/privacy",
    }),
  ],
};

const exportRoutes = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  "/v1/apps/1234567890/appStoreVersions": {
    data: [
      resource("v-live", "appStoreVersions", {
        versionString: "1.3.0",
        platform: "IOS",
        appStoreState: "READY_FOR_SALE",
      }),
      resource("v-edit", "appStoreVersions", {
        versionString: "1.4.0",
        platform: "IOS",
        appStoreState: "PREPARE_FOR_SUBMISSION",
      }),
    ],
  },
  "/v1/apps/1234567890/appInfos": {
    data: [
      resource("appinfo-live", "appInfos", { appStoreState: "READY_FOR_SALE" }),
      resource("appinfo-edit", "appInfos", { appStoreState: "PREPARE_FOR_SUBMISSION" }),
    ],
  },
  "/v1/apps/1234567890": {
    data: resource("1234567890", "apps", {
      bundleId: "com.acme.app",
      sku: "ACME1",
      primaryLocale: "en-US",
    }),
  },
  "/appStoreVersionLocalizations": versionLocalizations,
  "/appInfoLocalizations": appInfoLocalizations,
  ...overrides,
});

const sidecar = (baselineOverrides: Record<string, string> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    app: { id: "1234567890", bundleId: "com.acme.app", primaryLocale: "en-US" },
    version: {
      id: "v-edit",
      versionString: "1.4.0",
      platform: "IOS",
      appStoreState: "PREPARE_FOR_SUBMISSION",
    },
    appInfo: { id: "appinfo-edit" },
    exportedAt: "2026-07-19T09:12:00.000Z",
    localizationIds: { "en-US": { version: "vloc-en", appInfo: "aloc-en" } },
    baseline: {
      "en-US": {
        description: digest(LIVE_DESCRIPTION),
        subtitle: digest(LIVE_SUBTITLE),
        ...baselineOverrides,
      },
    },
  });

const applyCall = async (
  client: Client,
  args: Record<string, unknown>,
  files: { path: string; content: string }[],
  baselineOverrides: Record<string, string> = {},
): Promise<unknown> =>
  client.callTool({
    name: "app_store_connect_apply_listing",
    arguments: {
      files: [
        { path: "fastlane/metadata/.listing.json", content: sidecar(baselineOverrides) },
        ...files,
      ],
      ...args,
    },
  });

const writeCalls = (fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit][] =>
  (fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter(
    ([, init]) => (init?.method ?? "GET") !== "GET",
  );

describe("listing tool registration", () => {
  it("exposes export in both modes but apply only when writes are on", async () => {
    const names = async (allowWrites: boolean): Promise<string[]> =>
      (await (await connect(routes({}), { ...baseConfig, allowWrites })).listTools()).tools.map(
        (t) => t.name,
      );

    expect(await names(false)).toContain("app_store_connect_export_listing");
    expect(await names(false)).not.toContain("app_store_connect_apply_listing");
    expect(await names(true)).toContain("app_store_connect_apply_listing");
  });
});

describe("export_listing", () => {
  it("returns a fastlane metadata tree with the sidecar", async () => {
    const client = await connect(routes(exportRoutes()));
    const result = await client.callTool({
      name: "app_store_connect_export_listing",
      arguments: { appId: "1234567890" },
    });
    const payload = JSON.parse(text(result)) as {
      files: { path: string; content: string }[];
      version: { versionString: string };
    };
    const paths = payload.files.map((f) => f.path);

    expect(payload.version.versionString).toBe("1.4.0");
    expect(paths).toContain("fastlane/metadata/.listing.json");
    expect(paths).toContain("fastlane/metadata/en-US/description.txt");
    expect(paths).toContain("fastlane/metadata/en-US/subtitle.txt");
    expect(paths).toContain("fastlane/metadata/en-US/release_notes.txt");
    expect(payload.files.find((f) => f.path.endsWith("description.txt"))?.content).toBe(
      `${LIVE_DESCRIPTION}\n`,
    );
  });

  it("resolves 'latest' to the editable version, not the shipped one", async () => {
    const client = await connect(routes(exportRoutes()));
    const result = await client.callTool({
      name: "app_store_connect_export_listing",
      arguments: { appId: "1234567890", format: "json" },
    });
    const doc = JSON.parse(text(result)) as { version: { id: string; appStoreState: string } };
    expect(doc.version.id).toBe("v-edit");
    expect(doc.version.appStoreState).toBe("PREPARE_FOR_SUBMISSION");
  });

  it("resolves 'live' to the shipped version", async () => {
    const client = await connect(routes(exportRoutes()));
    const result = await client.callTool({
      name: "app_store_connect_export_listing",
      arguments: { appId: "1234567890", version: "live", format: "json" },
    });
    expect((JSON.parse(text(result)) as { version: { id: string } }).version.id).toBe("v-live");
  });

  it("orders versions numerically, so 1.10.0 beats 1.9.0", async () => {
    const client = await connect(
      routes(
        exportRoutes({
          "/v1/apps/1234567890/appStoreVersions": {
            data: [
              resource("v-nine", "appStoreVersions", {
                versionString: "1.9.0",
                platform: "IOS",
                appStoreState: "PREPARE_FOR_SUBMISSION",
              }),
              resource("v-ten", "appStoreVersions", {
                versionString: "1.10.0",
                platform: "IOS",
                appStoreState: "PREPARE_FOR_SUBMISSION",
              }),
            ],
          },
        }),
      ),
    );
    const result = await client.callTool({
      name: "app_store_connect_export_listing",
      arguments: { appId: "1234567890", format: "json" },
    });
    expect((JSON.parse(text(result)) as { version: { id: string } }).version.id).toBe("v-ten");
  });

  it("picks the editable appInfo over the live one", async () => {
    const client = await connect(routes(exportRoutes()));
    const result = await client.callTool({
      name: "app_store_connect_export_listing",
      arguments: { appId: "1234567890", format: "json" },
    });
    expect((JSON.parse(text(result)) as { appInfo: { id: string } }).appInfo.id).toBe(
      "appinfo-edit",
    );
  });

  it("names the available versions when the requested one is missing", async () => {
    const client = await connect(routes(exportRoutes()));
    const result = await client.callTool({
      name: "app_store_connect_export_listing",
      arguments: { appId: "1234567890", version: "9.9.9" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain("1.4.0 (PREPARE_FOR_SUBMISSION)");
  });

  it("follows links.next rather than truncating at the page limit", async () => {
    const nextUrl =
      "https://api.appstoreconnect.apple.com/v1/appStoreVersions/v-edit/appStoreVersionLocalizations?cursor=PAGE2";
    let page = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("appStoreVersionLocalizations")) {
        page += 1;
        return page === 1
          ? jsonResponse({ ...versionLocalizations, links: { next: nextUrl } })
          : jsonResponse({
              data: [
                resource("vloc-fr", "appStoreVersionLocalizations", {
                  locale: "fr-FR",
                  description: "Bonjour.",
                }),
              ],
            });
      }
      const map = exportRoutes();
      const key = Object.keys(map)
        .toSorted((a, b) => b.length - a.length)
        .find((k) => url.includes(k));
      if (key === undefined) throw new Error(`unstubbed ${url}`);
      return jsonResponse(map[key]);
    });

    const client = await connect(fetchImpl);
    const result = await client.callTool({
      name: "app_store_connect_export_listing",
      arguments: { appId: "1234567890", format: "json" },
    });
    const doc = JSON.parse(text(result)) as { locales: Record<string, unknown> };

    expect(Object.keys(doc.locales).toSorted()).toEqual(["en-US", "fr-FR"]);
    const requested = fetchImpl.mock.calls.map(([url]) => url as string);
    expect(requested).toContain(nextUrl);
  });

  it("returns the review format as raw markdown, not escaped JSON", async () => {
    const client = await connect(routes(exportRoutes()));
    const result = await client.callTool({
      name: "app_store_connect_export_listing",
      arguments: { appId: "1234567890", format: "review" },
    });
    const md = text(result);
    expect(md.startsWith("# com.acme.app — 1.4.0")).toBe(true);
    expect(md).toContain("### Description — 17/4000");
  });
});

describe("a relocated metadata tree", () => {
  it("export_listing writes the tree wherever metadataRoot says", async () => {
    const client = await connect(routes(exportRoutes()));
    const result = await client.callTool({
      name: "app_store_connect_export_listing",
      arguments: { appId: "1234567890", metadataRoot: "AppStore" },
    });
    const payload = JSON.parse(text(result)) as {
      files: { path: string; content: string }[];
      note: string;
    };
    const paths = payload.files.map((f) => f.path);

    expect(paths).toContain("AppStore/.listing.json");
    expect(paths).toContain("AppStore/en-US/description.txt");
    expect(paths.some((p) => p.startsWith("fastlane/"))).toBe(false);
    expect(payload.note).toContain("AppStore/.listing.json");
  });

  it("export_listing refuses a root that is not a plain relative path", async () => {
    const client = await connect(routes(exportRoutes()));
    const result = await client.callTool({
      name: "app_store_connect_export_listing",
      arguments: { appId: "1234567890", metadataRoot: "/etc/passwd" },
    });
    expect(text(result)).toMatch(/absolute/i);
  });

  /**
   * The point of the whole feature: apply is never told where the tree is, and
   * still patches the same rows as the default-root test above.
   */
  it("apply_listing finds the tree from the sidecar alone", async () => {
    const fetchImpl = routes(exportRoutes());
    const client = await connect(fetchImpl);
    const result = await client.callTool({
      name: "app_store_connect_apply_listing",
      arguments: {
        files: [
          { path: "AppStore/.listing.json", content: sidecar() },
          { path: "AppStore/en-US/description.txt", content: "New description.\n" },
        ],
        dryRun: false,
        confirm: true,
      },
    });
    const payload = JSON.parse(text(result)) as { applied: boolean };
    expect(payload.applied).toBe(true);

    const patches = writeCalls(fetchImpl);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0]![1].body as string).data.attributes.description).toBe(
      "New description.",
    );
  });
});

describe("apply_listing", () => {
  const changedDescription = {
    path: "fastlane/metadata/en-US/description.txt",
    content: "New description.\n",
  };

  it("writes nothing on a dry run", async () => {
    const fetchImpl = routes(exportRoutes());
    const client = await connect(fetchImpl);
    const result = await applyCall(client, { dryRun: true }, [changedDescription]);
    const payload = JSON.parse(text(result)) as {
      applied: boolean;
      summary: { changed: number };
    };

    expect(payload.applied).toBe(false);
    expect(payload.summary.changed).toBe(1);
    expect(writeCalls(fetchImpl)).toHaveLength(0);
  });

  it("refuses to write without confirm", async () => {
    const fetchImpl = routes(exportRoutes());
    const client = await connect(fetchImpl);
    const result = await applyCall(client, { dryRun: false }, [changedDescription]);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain("confirm: true");
    expect(writeCalls(fetchImpl)).toHaveLength(0);
  });

  it("PATCHes only the changed field", async () => {
    const fetchImpl = routes(exportRoutes());
    const client = await connect(fetchImpl);
    await applyCall(client, { dryRun: false, confirm: true }, [changedDescription]);

    const writes = writeCalls(fetchImpl);
    expect(writes).toHaveLength(1);
    const [url, init] = writes[0]!;
    expect(url).toContain("/v1/appStoreVersionLocalizations/vloc-en");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      data: {
        type: "appStoreVersionLocalizations",
        id: "vloc-en",
        attributes: { description: "New description." },
      },
    });
  });

  it("routes appInfo fields to the appInfo endpoint", async () => {
    const fetchImpl = routes(exportRoutes());
    const client = await connect(fetchImpl);
    await applyCall(client, { dryRun: false, confirm: true }, [
      changedDescription,
      { path: "fastlane/metadata/en-US/subtitle.txt", content: "New subtitle\n" },
    ]);

    const writes = writeCalls(fetchImpl);
    expect(writes).toHaveLength(2);
    const targets = writes.map(([url]) => url);
    expect(targets.some((u) => u.includes("/v1/appStoreVersionLocalizations/vloc-en"))).toBe(true);
    expect(targets.some((u) => u.includes("/v1/appInfoLocalizations/aloc-en"))).toBe(true);
  });

  it("reports an upstream edit as a conflict and writes nothing", async () => {
    const fetchImpl = routes(
      exportRoutes({
        "/appStoreVersionLocalizations": {
          data: [
            resource("vloc-en", "appStoreVersionLocalizations", {
              locale: "en-US",
              description: "Someone edited this in the web UI.",
            }),
          ],
        },
      }),
    );
    const client = await connect(fetchImpl);
    const result = await applyCall(client, { dryRun: false, confirm: true }, [changedDescription]);
    const payload = JSON.parse(text(result)) as {
      summary: { conflicts: number };
      changes: { action: string; reason?: string }[];
    };

    expect(payload.summary.conflicts).toBe(1);
    expect(payload.changes[0]?.reason).toContain("force: true");
    expect(writeCalls(fetchImpl)).toHaveLength(0);
  });

  it("overwrites the upstream edit when forced", async () => {
    const fetchImpl = routes(
      exportRoutes({
        "/appStoreVersionLocalizations": {
          data: [
            resource("vloc-en", "appStoreVersionLocalizations", {
              locale: "en-US",
              description: "Someone edited this in the web UI.",
            }),
          ],
        },
      }),
    );
    const client = await connect(fetchImpl);
    await applyCall(client, { dryRun: false, confirm: true, force: true }, [changedDescription]);
    expect(writeCalls(fetchImpl)).toHaveLength(1);
  });

  it("aborts the whole apply when any field is over its limit", async () => {
    const fetchImpl = routes(exportRoutes());
    const client = await connect(fetchImpl);
    const result = await applyCall(client, { dryRun: false, confirm: true }, [
      changedDescription,
      { path: "fastlane/metadata/en-US/subtitle.txt", content: `${"x".repeat(31)}\n` },
    ]);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain("en-US/subtitle 31/30");
    expect(writeCalls(fetchImpl)).toHaveLength(0);
  });

  it("reports an unchanged field without writing", async () => {
    const fetchImpl = routes(exportRoutes());
    const client = await connect(fetchImpl);
    const result = await applyCall(client, { dryRun: false, confirm: true }, [
      { path: "fastlane/metadata/en-US/description.txt", content: `${LIVE_DESCRIPTION}\n` },
    ]);

    expect((JSON.parse(text(result)) as { summary: { unchanged: number } }).summary.unchanged).toBe(
      1,
    );
    expect(writeCalls(fetchImpl)).toHaveLength(0);
  });

  it("blocks an empty file from clearing live copy", async () => {
    const fetchImpl = routes(exportRoutes());
    const client = await connect(fetchImpl);
    const result = await applyCall(client, { dryRun: false, confirm: true }, [
      { path: "fastlane/metadata/en-US/description.txt", content: "" },
    ]);
    const payload = JSON.parse(text(result)) as {
      summary: { blocked: number };
      changes: { action: string; reason?: string }[];
    };

    expect(payload.summary.blocked).toBe(1);
    expect(payload.changes[0]?.reason).toContain("allowClear: true");
    expect(writeCalls(fetchImpl)).toHaveLength(0);
  });

  it("clears the field when allowClear is set", async () => {
    const fetchImpl = routes(exportRoutes());
    const client = await connect(fetchImpl);
    await applyCall(client, { dryRun: false, confirm: true, allowClear: true }, [
      { path: "fastlane/metadata/en-US/description.txt", content: "" },
    ]);

    const writes = writeCalls(fetchImpl);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]![1].body as string).data.attributes).toEqual({ description: "" });
  });

  it("does not block a field that is already empty upstream", async () => {
    const fetchImpl = routes(
      exportRoutes({
        "/appStoreVersionLocalizations": {
          data: [
            resource("vloc-en", "appStoreVersionLocalizations", {
              locale: "en-US",
              description: "",
            }),
          ],
        },
      }),
    );
    const client = await connect(fetchImpl);
    // The baseline agrees the field was already empty at export, so this is a
    // genuine no-op rather than an upstream change.
    const result = await applyCall(
      client,
      { dryRun: true },
      [{ path: "fastlane/metadata/en-US/description.txt", content: "" }],
      { description: digest("") },
    );

    const payload = JSON.parse(text(result)) as { summary: { blocked: number; unchanged: number } };
    expect(payload.summary.blocked).toBe(0);
    expect(payload.summary.unchanged).toBe(1);
  });

  it("rejects a manifest with no sidecar", async () => {
    const client = await connect(routes(exportRoutes()));
    const result = await client.callTool({
      name: "app_store_connect_apply_listing",
      arguments: { files: [changedDescription], dryRun: true },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain(".listing.json was not included");
  });
});
