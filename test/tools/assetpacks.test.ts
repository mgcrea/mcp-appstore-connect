import { describe, expect, it, vi } from "vitest";

import { planAssetPacks, type AssetPack } from "#/tools/assetpacks";

import { baseConfig, connect, jsonResponse, payloadOf } from "../helpers.js";

describe("list_asset_packs", () => {
  /** Shaped from App Store Connect API 4.5.1's BackgroundAsset / BackgroundAssetVersion. */
  const fetchImpl = (): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string) => {
      const { pathname } = new URL(url);
      if (pathname === "/v1/apps/6828592664/backgroundAssets") {
        return jsonResponse({
          data: [
            {
              id: "pack-a",
              type: "backgroundAssets",
              attributes: {
                assetPackIdentifier: "io.mgcrea.chevalet.pack-a",
                archived: false,
                usedBytes: 1024,
                createdDate: "2026-10-30T10:00:00Z",
              },
            },
          ],
        });
      }
      if (pathname === "/v1/backgroundAssets/pack-a/versions") {
        return jsonResponse({
          data: [
            {
              id: "bav-2",
              type: "backgroundAssetVersions",
              attributes: {
                version: "2",
                state: "FAILED",
                platforms: ["MAC_OS"],
                stateDetails: { errors: [{ code: "MANIFEST_INVALID" }] },
              },
              relationships: {
                appStoreRelease: {
                  data: { type: "backgroundAssetVersionAppStoreReleases", id: "rel-2" },
                },
              },
            },
            {
              id: "bav-1",
              type: "backgroundAssetVersions",
              attributes: { version: "1", state: "COMPLETE", platforms: ["MAC_OS"] },
              relationships: {
                appStoreRelease: {
                  data: { type: "backgroundAssetVersionAppStoreReleases", id: "rel-1" },
                },
                internalBetaRelease: {
                  data: { type: "backgroundAssetVersionInternalBetaReleases", id: "beta-1" },
                },
              },
            },
          ],
          included: [
            {
              id: "rel-2",
              type: "backgroundAssetVersionAppStoreReleases",
              attributes: { state: "PREPARE_FOR_SUBMISSION" },
            },
            {
              id: "rel-1",
              type: "backgroundAssetVersionAppStoreReleases",
              attributes: { state: "READY_FOR_DISTRIBUTION" },
            },
            {
              id: "beta-1",
              type: "backgroundAssetVersionInternalBetaReleases",
              attributes: { state: "READY_FOR_TESTING" },
            },
          ],
          links: {
            next: "https://api.appstoreconnect.apple.com/v1/backgroundAssets/pack-a/versions?cursor=x",
          },
        });
      }
      return jsonResponse({ data: [] });
    });

  it("lists each pack with its versions and their App Store release state", async () => {
    const fetch = fetchImpl();
    const client = await connect(baseConfig, fetch as unknown as typeof globalThis.fetch);

    const body = payloadOf(
      await client.callTool({
        name: "app_store_connect_list_asset_packs",
        arguments: { appId: "6828592664", platform: "MAC_OS" },
      }),
    ) as { data: AssetPack[] };

    expect(body.data).toEqual([
      {
        id: "pack-a",
        assetPackIdentifier: "io.mgcrea.chevalet.pack-a",
        archived: false,
        usedBytes: 1024,
        createdDate: "2026-10-30T10:00:00Z",
        versions: [
          {
            id: "bav-2",
            version: "2",
            state: "FAILED",
            platforms: ["MAC_OS"],
            appStoreReleaseState: "PREPARE_FOR_SUBMISSION",
            errors: [{ code: "MANIFEST_INVALID" }],
          },
          {
            id: "bav-1",
            version: "1",
            state: "COMPLETE",
            platforms: ["MAC_OS"],
            appStoreReleaseState: "READY_FOR_DISTRIBUTION",
            internalBetaReleaseState: "READY_FOR_TESTING",
          },
        ],
        moreVersions: true,
      },
    ]);

    const packsUrl = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(packsUrl.searchParams.get("filter[archived]")).toBe("false");
    expect(packsUrl.searchParams.get("filter[versions.platforms]")).toBe("MAC_OS");
    const versionsUrl = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(versionsUrl.searchParams.get("sort")).toBe("-version");
    expect(versionsUrl.searchParams.get("include")?.split(",")).toContain("appStoreRelease");
  });

  it("is a read tool, registered with writes off", async () => {
    const client = await connect(baseConfig);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("app_store_connect_list_asset_packs");
  });
});

describe("planAssetPacks", () => {
  const version = (
    id: string,
    state: string,
    appStoreReleaseState: string | undefined,
    locale?: string,
  ): AssetPack["versions"][number] => ({
    id,
    version: id,
    locale,
    state,
    platforms: ["IOS"],
    createdDate: undefined,
    ...(appStoreReleaseState !== undefined ? { appStoreReleaseState } : {}),
  });
  const pack = (versions: AssetPack["versions"]): AssetPack => ({
    id: "pack",
    assetPackIdentifier: "pack",
    archived: false,
    usedBytes: 0,
    createdDate: undefined,
    versions,
  });

  it("considers only the newest version, and does not reach past one still processing", () => {
    const [plan] = planAssetPacks(
      [
        pack([
          version("v2", "PROCESSING", "PREPARE_FOR_SUBMISSION"),
          version("v1", "COMPLETE", "PREPARE_FOR_SUBMISSION"),
        ]),
      ],
      new Set(),
    );
    expect(plan).toMatchObject({ versionId: "v2", action: "notAdded" });
    expect(plan?.reason).toContain("PROCESSING");
  });

  it("adds a rejected version back, and plans one row per locale", () => {
    const plans = planAssetPacks(
      [
        pack([
          version("en-2", "COMPLETE", "REJECTED", "en"),
          version("fr-2", "COMPLETE", "PREPARE_FOR_SUBMISSION", "fr"),
          version("en-1", "COMPLETE", "READY_FOR_DISTRIBUTION", "en"),
        ]),
      ],
      new Set(),
    );
    expect(plans.map((plan) => [plan.versionId, plan.action])).toEqual([
      ["en-2", "add"],
      ["fr-2", "add"],
    ]);
  });

  it("says so when a pack has no version for the platform", () => {
    expect(planAssetPacks([pack([])], new Set())).toEqual([
      expect.objectContaining({ action: "notAdded", reason: "no version for this platform" }),
    ]);
  });

  it("reports a missing App Store release rather than guessing", () => {
    const [plan] = planAssetPacks([pack([version("v1", "COMPLETE", undefined)])], new Set());
    expect(plan).toMatchObject({ action: "notAdded" });
    expect(plan?.reason).toContain("no App Store release");
  });
});
