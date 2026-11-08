import { describe, expect, it } from "vitest";

import {
  apiError,
  baseConfig,
  callsTo,
  connect,
  jsonResponse,
  on,
  payloadOf,
  type Route,
  sentBody,
  stub,
  textOf,
} from "../helpers.js";

// Shapes follow Apple's OpenAPI spec 4.6 (AppStoreVersionExperimentV2,
// AppStoreVersionExperimentTreatment, ...TreatmentLocalization). Cadence had no
// test to record when these were written; its empty list answered as
// `{ data: [], included: [], meta: { paging: { total: 0 } } }`.

const writes = { ...baseConfig, allowWrites: true };
const EXP = "/v2/appStoreVersionExperiments";

const experiment = (attributes: Record<string, unknown>, id = "exp-1") => ({
  id,
  type: "appStoreVersionExperiments",
  attributes: { name: "Ebony", platform: "IOS", trafficProportion: 30, ...attributes },
  relationships: {
    latestControlVersion: { data: { type: "appStoreVersions", id: "ver-live" } },
    appStoreVersionExperimentTreatments: {
      data: [{ type: "appStoreVersionExperimentTreatments", id: "tr-a" }],
    },
  },
});

const treatment = (attributes: Record<string, unknown> = {}, id = "tr-a") => ({
  id,
  type: "appStoreVersionExperimentTreatments",
  attributes: { name: "Treatment A", ...attributes },
  relationships: {
    appStoreVersionExperimentV2: { data: { type: "appStoreVersionExperiments", id: "exp-1" } },
    appStoreVersionExperimentTreatmentLocalizations: {
      data: [
        { type: "appStoreVersionExperimentTreatmentLocalizations", id: "trl-en" },
        { type: "appStoreVersionExperimentTreatmentLocalizations", id: "trl-fr" },
      ],
    },
  },
});

const treatmentLocalization = (id: string, locale: string) => ({
  id,
  type: "appStoreVersionExperimentTreatmentLocalizations",
  attributes: { locale },
});

describe("product page optimization reads", () => {
  it("lists tests with their treatments and control version, filtering platform after the read", async () => {
    const fetchImpl = stub([
      on("GET", "/v1/apps/app-1/appStoreVersionExperimentsV2", (url) => {
        // Apple's endpoint has no filter[platform].
        expect(url.searchParams.get("filter[platform]")).toBeNull();
        return jsonResponse({
          data: [
            experiment({ state: "PREPARE_FOR_SUBMISSION" }),
            experiment({ platform: "MAC_OS", state: "COMPLETED" }, "exp-mac"),
          ],
          included: [
            treatment(),
            {
              id: "ver-live",
              type: "appStoreVersions",
              attributes: { versionString: "1.10.1" },
            },
          ],
          meta: { paging: { total: 2, limit: 50 } },
        });
      }),
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_list_experiments",
      arguments: { appId: "app-1", platform: "IOS" },
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    const rows = payloadOf(result).data as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "exp-1",
      state: "PREPARE_FOR_SUBMISSION",
      controlVersionId: "ver-live",
      controlVersionString: "1.10.1",
      treatments: [{ id: "tr-a", name: "Treatment A" }],
    });
  });

  it("gets a test with each treatment's localization ids keyed by locale", async () => {
    const fetchImpl = stub([
      on("GET", `${EXP}/exp-1`, () => jsonResponse({ data: experiment({}) })),
      on("GET", `${EXP}/exp-1/appStoreVersionExperimentTreatments`, () =>
        jsonResponse({
          data: [treatment()],
          included: [
            treatmentLocalization("trl-en", "en-US"),
            treatmentLocalization("trl-fr", "fr-FR"),
          ],
        }),
      ),
    ]);
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_get_experiment",
      arguments: { experimentId: "exp-1" },
    });

    expect(payloadOf(result).treatments).toEqual([
      { id: "tr-a", name: "Treatment A", localizations: { "en-US": "trl-en", "fr-FR": "trl-fr" } },
    ]);
  });
});

describe("create_experiment", () => {
  const createRoutes = (extra: Route[] = []): Route[] => [
    ...extra,
    on("POST", EXP, () => jsonResponse({ data: experiment({ state: "PREPARE_FOR_SUBMISSION" }) })),
    on("GET", `${EXP}/exp-1`, () => jsonResponse({ data: experiment({}) })),
    on("GET", "/v1/appStoreVersions/ver-live/appStoreVersionLocalizations", () =>
      jsonResponse({
        data: [
          { id: "vl-en", type: "appStoreVersionLocalizations", attributes: { locale: "en-US" } },
          { id: "vl-fr", type: "appStoreVersionLocalizations", attributes: { locale: "fr-FR" } },
        ],
      }),
    ),
    on("POST", "/v1/appStoreVersionExperimentTreatments", () =>
      jsonResponse({ data: { ...treatment(), relationships: {} } }),
    ),
    // Apple may seed a treatment with some localizations; en-US is already there.
    on(
      "GET",
      "/v1/appStoreVersionExperimentTreatments/tr-a/appStoreVersionExperimentTreatmentLocalizations",
      () => jsonResponse({ data: [treatmentLocalization("trl-en", "en-US")] }),
    ),
    on("POST", "/v1/appStoreVersionExperimentTreatmentLocalizations", () =>
      jsonResponse({ data: treatmentLocalization("trl-fr", "fr-FR") }),
    ),
  ];

  it("creates the test against the app, a treatment, and only the missing localizations", async () => {
    const fetchImpl = stub(createRoutes());
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_create_experiment",
      arguments: {
        appId: "app-1",
        name: "Ebony",
        trafficProportion: 30,
        treatments: [{ name: "Treatment A" }],
      },
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    const created = sentBody(callsTo(fetchImpl, "POST", EXP)[0]).data;
    expect(created.attributes).toEqual({ name: "Ebony", platform: "IOS", trafficProportion: 30 });
    expect(created.relationships.app.data).toEqual({ type: "apps", id: "app-1" });
    const tr = sentBody(callsTo(fetchImpl, "POST", "/v1/appStoreVersionExperimentTreatments")[0]);
    expect(tr.data.relationships.appStoreVersionExperimentV2.data).toEqual({
      type: "appStoreVersionExperiments",
      id: "exp-1",
    });
    const locs = callsTo(fetchImpl, "POST", "/v1/appStoreVersionExperimentTreatmentLocalizations");
    expect(locs.map((c) => sentBody(c).data.attributes.locale)).toEqual(["fr-FR"]);
    expect(payloadOf(result).treatments).toEqual([
      { id: "tr-a", name: "Treatment A", localizations: { "en-US": "trl-en", "fr-FR": "trl-fr" } },
    ]);
    expect(String(payloadOf(result).next)).toContain("app_store_connect_create_placement");
  });

  it("deletes the new draft test again when a treatment fails", async () => {
    const fetchImpl = stub([
      on("POST", "/v1/appStoreVersionExperimentTreatments", () =>
        apiError(409, "ENTITY_ERROR.ATTRIBUTE.INVALID"),
      ),
      on("DELETE", `${EXP}/exp-1`, () => new Response(null, { status: 204 })),
      ...createRoutes(),
    ]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_create_experiment",
      arguments: {
        appId: "app-1",
        name: "Ebony",
        trafficProportion: 30,
        treatments: [{ name: "Treatment A" }],
        locales: ["en-US"],
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("was deleted again");
    expect(callsTo(fetchImpl, "DELETE", `${EXP}/exp-1`)).toHaveLength(1);
  });

  it("refuses more than three treatments", async () => {
    const fetchImpl = stub([]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_create_experiment",
      arguments: {
        appId: "app-1",
        name: "x",
        trafficProportion: 30,
        treatments: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
      },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("update_experiment and delete_experiment", () => {
  it("starts a test with the spec's `started` field", async () => {
    const fetchImpl = stub([
      on("PATCH", `${EXP}/exp-1`, () =>
        jsonResponse({
          data: experiment({ state: "ACCEPTED", startDate: "2026-11-09T00:00:00Z" }),
        }),
      ),
    ]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_update_experiment",
      arguments: { experimentId: "exp-1", start: true, confirm: true },
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(sentBody(callsTo(fetchImpl, "PATCH", `${EXP}/exp-1`)[0]).data.attributes).toEqual({
      started: true,
    });
  });

  it("says stopping is web-UI only", async () => {
    const client = await connect(writes);
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "app_store_connect_update_experiment",
    );
    expect(tool?.description).toContain("Stopping is NOT in the API");
  });

  it("refuses to delete a test that has started", async () => {
    const fetchImpl = stub([
      on("GET", `${EXP}/exp-1`, () =>
        jsonResponse({
          data: experiment({ state: "APPROVED", startDate: "2026-11-01T00:00:00Z" }),
        }),
      ),
    ]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_delete_experiment",
      arguments: { experimentId: "exp-1", confirm: true },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("before it starts");
    expect(callsTo(fetchImpl, "DELETE", `${EXP}/exp-1`)).toHaveLength(0);
  });

  it("deletes a draft test", async () => {
    const fetchImpl = stub([
      on("GET", `${EXP}/exp-1`, () =>
        jsonResponse({ data: experiment({ state: "PREPARE_FOR_SUBMISSION" }) }),
      ),
      on("DELETE", `${EXP}/exp-1`, () => new Response(null, { status: 204 })),
    ]);
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_delete_experiment",
      arguments: { experimentId: "exp-1", confirm: true },
    });

    expect(payloadOf(result)).toMatchObject({ deleted: "exp-1" });
  });
});

describe("apply_treatment", () => {
  const applyRoutes = (opts: {
    siblings?: unknown[];
    appVersionState?: string;
    experimentAttrs?: Record<string, unknown>;
  }): Route[] => [
    on("GET", "/v1/appStoreVersionExperimentTreatments/tr-a", () =>
      jsonResponse({ data: treatment() }),
    ),
    on("GET", `${EXP}/exp-1`, () =>
      jsonResponse({ data: experiment(opts.experimentAttrs ?? { state: "APPROVED" }) }),
    ),
    on("GET", `${EXP}/exp-1/appStoreVersionExperimentTreatments`, () =>
      jsonResponse({ data: opts.siblings ?? [treatment()] }),
    ),
    on("GET", "/v1/appStoreVersions/ver-live", () =>
      jsonResponse({
        data: {
          id: "ver-live",
          type: "appStoreVersions",
          attributes: {
            versionString: "1.10.1",
            platform: "IOS",
            appVersionState: opts.appVersionState ?? "READY_FOR_DISTRIBUTION",
          },
        },
      }),
    ),
    on("POST", "/v1/appStoreVersionPromotions", () =>
      jsonResponse({ data: { id: "promo-1", type: "appStoreVersionPromotions" } }),
    ),
  ];
  const args = { treatmentId: "tr-a", versionId: "ver-live", confirm: true };

  it("posts a promotion naming the version and the treatment", async () => {
    const fetchImpl = stub(
      applyRoutes({
        experimentAttrs: { state: "APPROVED", startDate: "2026-11-01T00:00:00Z" },
      }),
    );
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_apply_treatment",
      arguments: args,
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    const body = sentBody(callsTo(fetchImpl, "POST", "/v1/appStoreVersionPromotions")[0]).data;
    expect(body.relationships).toEqual({
      appStoreVersion: { data: { type: "appStoreVersions", id: "ver-live" } },
      appStoreVersionExperimentTreatment: {
        data: { type: "appStoreVersionExperimentTreatments", id: "tr-a" },
      },
    });
    expect(payloadOf(result)).toMatchObject({ applied: true, stopsRunningTest: true });
  });

  it("dryRun checks and sends nothing", async () => {
    const fetchImpl = stub(applyRoutes({}));
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_apply_treatment",
      arguments: { ...args, dryRun: true },
    });

    expect(payloadOf(result)).toMatchObject({ dryRun: true, applied: false });
    expect(callsTo(fetchImpl, "POST", "/v1/appStoreVersionPromotions")).toHaveLength(0);
  });

  it("refuses a second treatment of the same test and a version in review, at once", async () => {
    const fetchImpl = stub(
      applyRoutes({
        siblings: [treatment(), treatment({ promotedDate: "2026-10-01T00:00:00Z" }, "tr-b")],
        appVersionState: "WAITING_FOR_REVIEW",
      }),
    );
    const client = await connect(writes, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "app_store_connect_apply_treatment",
      arguments: args,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("tr-b");
    expect(textOf(result)).toContain("WAITING_FOR_REVIEW");
    expect(callsTo(fetchImpl, "POST", "/v1/appStoreVersionPromotions")).toHaveLength(0);
  });
});
