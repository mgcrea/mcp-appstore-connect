import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
  baseConfig,
  bodyOf,
  callArgs,
  connect,
  jsonResponse,
  patchCall,
  payloadOf,
  postCall,
  textOf,
} from "../helpers.js";

const VERSION_ID = "v1";

/** A version read with include=appStoreVersionPhasedRelease, as Apple answers it. */
const versionWith = (
  appStoreState: string,
  phased?: Record<string, unknown>,
): Record<string, unknown> => ({
  data: {
    type: "appStoreVersions",
    id: VERSION_ID,
    attributes: { versionString: "1.3.1", appStoreState },
    relationships: {
      appStoreVersionPhasedRelease: {
        data: phased === undefined ? null : { type: "appStoreVersionPhasedReleases", id: "pr1" },
      },
    },
  },
  ...(phased === undefined
    ? {}
    : { included: [{ type: "appStoreVersionPhasedReleases", id: "pr1", attributes: phased }] }),
});

const phasedResponse = (attributes: Record<string, unknown>): unknown => ({
  data: { type: "appStoreVersionPhasedReleases", id: "pr1", attributes },
});

const routed = (
  version: Record<string, unknown>,
  written: unknown = phasedResponse({ phasedReleaseState: "INACTIVE" }),
): ReturnType<typeof vi.fn> =>
  vi.fn(async (_url: string, init?: RequestInit) =>
    jsonResponse(init?.method === "POST" || init?.method === "PATCH" ? written : version),
  );

const connectWithWrites = async (fetchImpl: ReturnType<typeof vi.fn>): Promise<Client> =>
  connect({ ...baseConfig, allowWrites: true }, fetchImpl as unknown as typeof fetch);

describe("get_phased_release", () => {
  it("reads the version and its phased release in one call, with the day's rollout share", async () => {
    const fetchImpl = routed(
      versionWith("READY_FOR_SALE", {
        phasedReleaseState: "ACTIVE",
        currentDayNumber: 4,
        startDate: "2026-11-01T00:00:00Z",
        totalPauseDuration: 0,
      }),
    );
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({
      name: "app_store_connect_get_phased_release",
      arguments: { versionId: VERSION_ID },
    });

    expect(result.isError).toBeFalsy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(callArgs(fetchImpl)[0]);
    expect(url.pathname).toBe(`/v1/appStoreVersions/${VERSION_ID}`);
    expect(url.searchParams.get("include")).toBe("appStoreVersionPhasedRelease");
    const body = payloadOf(result);
    expect(body.phasedRelease).toMatchObject({
      id: "pr1",
      phasedReleaseState: "ACTIVE",
      currentDayNumber: 4,
      rolloutPercent: 10,
    });
    expect(String(body.note)).toContain("OFFERED");
  });

  it("answers null, not an error, for a version with no phased release", async () => {
    const client = await connect(
      baseConfig,
      routed(versionWith("PENDING_DEVELOPER_RELEASE")) as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "app_store_connect_get_phased_release",
      arguments: { versionId: VERSION_ID },
    });

    expect(result.isError).toBeFalsy();
    expect(payloadOf(result).phasedRelease).toBeNull();
  });
});

describe("create_phased_release", () => {
  it("creates it INACTIVE against the version", async () => {
    const fetchImpl = routed(versionWith("PENDING_DEVELOPER_RELEASE"));
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_phased_release",
      arguments: { versionId: VERSION_ID, confirm: true },
    });

    expect(result.isError).toBeFalsy();
    const call = postCall(fetchImpl, "/v1/appStoreVersionPhasedReleases");
    expect(bodyOf(call?.[1])).toEqual({
      data: {
        type: "appStoreVersionPhasedReleases",
        attributes: { phasedReleaseState: "INACTIVE" },
        relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: VERSION_ID } },
        },
      },
    });
  });

  it("requires confirm", async () => {
    const fetchImpl = routed(versionWith("PENDING_DEVELOPER_RELEASE"));
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_phased_release",
      arguments: { versionId: VERSION_ID },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a version that is already released, naming the state", async () => {
    const fetchImpl = routed(versionWith("READY_FOR_SALE"));
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_phased_release",
      arguments: { versionId: VERSION_ID, confirm: true },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("READY_FOR_SALE");
    expect(postCall(fetchImpl, "/v1/appStoreVersionPhasedReleases")).toBeUndefined();
  });

  it("refuses a second phased release on the same version", async () => {
    const fetchImpl = routed(
      versionWith("PENDING_DEVELOPER_RELEASE", { phasedReleaseState: "INACTIVE" }),
    );
    const client = await connectWithWrites(fetchImpl);

    const result = await client.callTool({
      name: "app_store_connect_create_phased_release",
      arguments: { versionId: VERSION_ID, confirm: true },
    });

    expect(result.isError).toBe(true);
    expect(postCall(fetchImpl, "/v1/appStoreVersionPhasedReleases")).toBeUndefined();
  });
});

describe("update_phased_release", () => {
  const update = async (
    fetchImpl: ReturnType<typeof vi.fn>,
    action: string,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> =>
    (await connectWithWrites(fetchImpl)).callTool({
      name: "app_store_connect_update_phased_release",
      arguments: { versionId: VERSION_ID, action, confirm: true },
    });

  it.each([
    ["PAUSE", "ACTIVE", "PAUSED"],
    ["RESUME", "PAUSED", "ACTIVE"],
    ["COMPLETE", "ACTIVE", "COMPLETE"],
    ["COMPLETE", "PAUSED", "COMPLETE"],
  ])("%s moves %s to %s", async (action, from, to) => {
    const fetchImpl = routed(
      versionWith("READY_FOR_SALE", { phasedReleaseState: from, currentDayNumber: 3 }),
      phasedResponse({ phasedReleaseState: to, currentDayNumber: 3 }),
    );

    const result = await update(fetchImpl, action);

    expect(result.isError).toBeFalsy();
    const call = patchCall(fetchImpl);
    expect(new URL(String(call?.[0])).pathname).toBe("/v1/appStoreVersionPhasedReleases/pr1");
    expect(bodyOf(call?.[1])).toEqual({
      data: {
        type: "appStoreVersionPhasedReleases",
        id: "pr1",
        attributes: { phasedReleaseState: to },
      },
    });
    expect(payloadOf(result)).toMatchObject({ previousState: from, action });
  });

  it("says a pause does not stop manual updates", async () => {
    const fetchImpl = routed(
      versionWith("READY_FOR_SALE", { phasedReleaseState: "ACTIVE" }),
      phasedResponse({ phasedReleaseState: "PAUSED" }),
    );

    const note = String(payloadOf(await update(fetchImpl, "PAUSE")).note);

    expect(note).toContain("people who already received the version keep it");
    expect(note).toContain("update by hand");
  });

  it("refuses to pause one that has not started, without writing", async () => {
    const fetchImpl = routed(
      versionWith("PENDING_DEVELOPER_RELEASE", { phasedReleaseState: "INACTIVE" }),
    );

    const result = await update(fetchImpl, "PAUSE");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("INACTIVE");
    expect(patchCall(fetchImpl)).toBeUndefined();
  });

  it("refuses to resume a completed one", async () => {
    const fetchImpl = routed(versionWith("READY_FOR_SALE", { phasedReleaseState: "COMPLETE" }));

    const result = await update(fetchImpl, "RESUME");

    expect(result.isError).toBe(true);
    expect(patchCall(fetchImpl)).toBeUndefined();
  });

  it("changes nothing when already in the requested state", async () => {
    const fetchImpl = routed(versionWith("READY_FOR_SALE", { phasedReleaseState: "PAUSED" }));

    const result = await update(fetchImpl, "PAUSE");

    expect(result.isError).toBeFalsy();
    expect(patchCall(fetchImpl)).toBeUndefined();
  });

  it("refuses a version with no phased release", async () => {
    const fetchImpl = routed(versionWith("READY_FOR_SALE"));

    const result = await update(fetchImpl, "COMPLETE");

    expect(result.isError).toBe(true);
    expect(patchCall(fetchImpl)).toBeUndefined();
  });
});
