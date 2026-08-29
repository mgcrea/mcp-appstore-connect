import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "../src/client/auth.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const config: Config = {
  keyId: "ABCD123456",
  issuerId: "69a6de70-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
  allowWrites: false,
  maxRetries: 3,
  tokenTtlSeconds: 1140,
  metadataRoot: "fastlane/metadata",
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

describe("release doctor", () => {
  it("is read-only and reports blockers without staging a review submission", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/appStoreVersions/ver-1") {
        return jsonResponse({
          data: {
            id: "ver-1",
            type: "appStoreVersions",
            attributes: {
              versionString: "1.0.0",
              platform: "IOS",
              appStoreState: "PREPARE_FOR_SUBMISSION",
              copyright: "2026 Acme",
            },
            relationships: {
              app: { data: null },
              build: { data: null },
            },
          },
        });
      }
      if (url.pathname === "/v1/appStoreVersions/ver-1/appStoreReviewDetail") {
        return jsonResponse({ data: null });
      }
      throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
    });

    const { server } = createServer({
      config,
      fetch: fetchImpl as unknown as typeof fetch,
      tokenProvider: staticTokenProvider("jwt-token"),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "release-doctor-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = (await client.listTools()).tools;
    const doctor = tools.find((tool) => tool.name === "app_store_connect_release_doctor");
    expect(doctor?.annotations?.readOnlyHint).toBe(true);

    const result = await client.callTool({
      name: "app_store_connect_release_doctor",
      arguments: { versionId: "ver-1" },
    });
    const body = JSON.parse(textOf(result)) as {
      automatedReady: boolean;
      blockerCount: number;
      manualCheckCount: number;
      verdict: string;
    };

    expect(result.isError).toBeFalsy();
    expect(body.automatedReady).toBe(false);
    expect(body.blockerCount).toBeGreaterThan(0);
    expect(body.manualCheckCount).toBe(1);
    expect(body.verdict).toBe("blocked");

    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method ?? "GET").toBe("GET");
    }
  });
});
