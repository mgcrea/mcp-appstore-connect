import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import {
  attributesOf,
  includedIndex,
  isRecord,
  relatedId,
  relatedIds,
  resourceOf,
  resourcesOf,
  summarizeResponse,
  type Rec,
} from "#/client/shape";
import {
  appIdArg,
  compact,
  confirmArg,
  dryRunArg,
  limitArg,
  PLATFORMS,
  PreconditionError,
  savePathArg,
  versionIdArg,
  wrap,
  wrapSaved,
} from "#/tools/util";

// Product page optimization (PPO): an A/B test of the product page's icon,
// screenshots and previews. Verified against Apple's OpenAPI spec 4.6 (a
// superset of 4.5.1):
//
//   app ─< appStoreVersionExperiments (v2, owned by the app + a platform)
//            ─< appStoreVersionExperimentTreatments (up to three)
//                 ─< appStoreVersionExperimentTreatmentLocalizations (one per locale)
//                      ─< appAssetLibraryPlacements (the treatment's media)
//
// The v1 experiment, owned by an appStoreVersion, is deprecated and not used
// here. Its v2 successor is created against the app, and Apple fills in
// `latestControlVersion` (the live version the test runs against) itself.
//
// What the spec does NOT have, so these tools say so rather than invent it:
// no field or route stops a running test (the update request's only lifecycle
// field is `started`), and nothing reads test results (they are in App
// Analytics, in the web UI).

const EXPERIMENT_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "ACCEPTED",
  "APPROVED",
  "REJECTED",
  "COMPLETED",
  "STOPPED",
] as const;

/** States in which the experiment is with Apple, so deleting it would pull it out of review. */
const IN_REVIEW_STATES = new Set(["READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW"]);

/** The version states Apple's help says a treatment can be applied to. */
const PROMOTABLE_VERSION_STATES = new Set(["READY_FOR_DISTRIBUTION", "PREPARE_FOR_SUBMISSION"]);

const MAX_TREATMENTS = 3;

const EXPERIMENTS = "/v2/appStoreVersionExperiments";
const TREATMENTS = "/v1/appStoreVersionExperimentTreatments";
const TREATMENT_LOCALIZATIONS = "/v1/appStoreVersionExperimentTreatmentLocalizations";

const experimentIdArg = z
  .string()
  .min(1)
  .describe("The product page optimization test id (from app_store_connect_list_experiments).");

const treatmentIdArg = z
  .string()
  .min(1)
  .describe("A treatment id (from app_store_connect_get_experiment).");

const trafficProportionArg = z
  .number()
  .int()
  .min(1)
  .max(100)
  .describe(
    "Percent of the page's visitors shown a treatment instead of the original, split evenly " +
      "between the treatments: 30 with three treatments shows each to 10%.",
  );

const optString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

// ─── reading ────────────────────────────────────────────────────────────────

type TreatmentSummary = {
  id: string;
  name?: string | undefined;
  appIconName?: string | undefined;
  promotedDate?: string | undefined;
  /** locale → treatment localization id, the `localizationId` create_placement takes. */
  localizations?: Record<string, string>;
};

const summarizeTreatment = (res: Rec, localizations?: Map<string, Rec>): TreatmentSummary => {
  const attrs = attributesOf(res);
  const summary: TreatmentSummary = {
    id: String(res.id),
    ...compact({
      name: optString(attrs.name),
      appIconName: optString(attrs.appIconName),
      promotedDate: optString(attrs.promotedDate),
    }),
  };
  if (!localizations) return summary;
  const byLocale: Record<string, string> = {};
  for (const id of relatedIds(res, "appStoreVersionExperimentTreatmentLocalizations")) {
    const locale = optString(attributesOf(localizations.get(id) ?? {}).locale);
    if (locale !== undefined) byLocale[locale] = id;
  }
  return { ...summary, localizations: byLocale };
};

const summarizeExperiment = (
  res: Rec,
  versions: Map<string, Rec>,
  treatments?: TreatmentSummary[],
): Rec => {
  const attrs = attributesOf(res);
  const controlVersionId = relatedId(res, "latestControlVersion");
  const control = controlVersionId ? versions.get(controlVersionId) : undefined;
  return {
    id: res.id,
    ...compact({
      name: attrs.name,
      platform: attrs.platform,
      state: attrs.state,
      trafficProportion: attrs.trafficProportion,
      reviewRequired: attrs.reviewRequired,
      startDate: attrs.startDate ?? undefined,
      endDate: attrs.endDate ?? undefined,
      controlVersionId,
      controlVersionString: control ? attributesOf(control).versionString : undefined,
    }),
    ...(treatments ? { treatments } : {}),
  };
};

/** One experiment with every treatment and, per treatment, its localization ids by locale. */
const readExperiment = async (
  client: AppStoreConnectClient,
  experimentId: string,
): Promise<Rec> => {
  const experiment = await client.get(`${EXPERIMENTS}/${experimentId}`, {
    include: "latestControlVersion",
    "fields[appStoreVersions]": "versionString,appVersionState,platform",
  });
  const treatments = await client.get(
    `${EXPERIMENTS}/${experimentId}/appStoreVersionExperimentTreatments`,
    {
      include: "appStoreVersionExperimentTreatmentLocalizations",
      "limit[appStoreVersionExperimentTreatmentLocalizations]": 50,
      limit: 10,
    },
  );
  const localizations = includedIndex(
    treatments,
    "appStoreVersionExperimentTreatmentLocalizations",
  );
  return summarizeExperiment(
    resourceOf(experiment),
    includedIndex(experiment, "appStoreVersions"),
    resourcesOf(treatments).map((t) => summarizeTreatment(t, localizations)),
  );
};

/** Whether customers are seeing the test right now, as far as its dates say. */
const isRunning = (attrs: Rec): boolean =>
  typeof attrs.startDate === "string" &&
  typeof attrs.endDate !== "string" &&
  attrs.state !== "COMPLETED" &&
  attrs.state !== "STOPPED";

// ─── creating ───────────────────────────────────────────────────────────────

/** The locales of the version a test runs against, the web UI's default for a new test. */
const controlLocales = async (
  client: AppStoreConnectClient,
  experimentId: string,
): Promise<string[]> => {
  const experiment = await client.get(`${EXPERIMENTS}/${experimentId}`, {
    include: "latestControlVersion",
  });
  const versionId = relatedId(resourceOf(experiment), "latestControlVersion");
  if (versionId === undefined) {
    throw new Error(
      "Apple gave the new test no control version, so there are no locales to default to. " +
        "The app needs a live version on this platform. Pass `locales` explicitly.",
    );
  }
  const localizations = await client.get(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    { "fields[appStoreVersionLocalizations]": "locale", limit: 50 },
  );
  return resourcesOf(localizations)
    .map((l) => optString(attributesOf(l).locale))
    .filter((l): l is string => l !== undefined);
};

/**
 * The treatment's localizations, created where missing. Read first: the spec
 * does not say whether Apple seeds a new treatment with localizations, and a
 * duplicate locale is a 409 that would abort the whole create.
 */
const ensureLocalizations = async (
  client: AppStoreConnectClient,
  treatmentId: string,
  locales: string[],
): Promise<Record<string, string>> => {
  const existing = await client.get(
    `${TREATMENTS}/${treatmentId}/appStoreVersionExperimentTreatmentLocalizations`,
    { limit: 50 },
  );
  const byLocale: Record<string, string> = {};
  for (const loc of resourcesOf(existing)) {
    const locale = optString(attributesOf(loc).locale);
    if (locale !== undefined) byLocale[locale] = String(loc.id);
  }
  for (const locale of locales) {
    if (byLocale[locale] !== undefined) continue;
    const created = await client.post(TREATMENT_LOCALIZATIONS, {
      data: {
        type: "appStoreVersionExperimentTreatmentLocalizations",
        attributes: { locale },
        relationships: {
          appStoreVersionExperimentTreatment: {
            data: { type: "appStoreVersionExperimentTreatments", id: treatmentId },
          },
        },
      },
    });
    byLocale[locale] = String(resourceOf(created).id);
  }
  return byLocale;
};

type CreateArgs = {
  appId: string;
  platform: (typeof PLATFORMS)[number];
  name: string;
  trafficProportion: number;
  treatments: { name: string; appIconName?: string | undefined }[];
  locales?: string[] | undefined;
};

const createExperiment = async (client: AppStoreConnectClient, args: CreateArgs): Promise<Rec> => {
  const created = await client.post(EXPERIMENTS, {
    data: {
      type: "appStoreVersionExperiments",
      attributes: {
        name: args.name,
        platform: args.platform,
        trafficProportion: args.trafficProportion,
      },
      relationships: { app: { data: { type: "apps", id: args.appId } } },
    },
  });
  const experimentId = optString(resourceOf(created).id);
  if (experimentId === undefined) throw new Error("Creating the test returned no id.");

  // Everything after this point builds on a draft nobody else has seen, so a
  // failure rolls it back rather than leaving half a test behind. Apple says a
  // test can be deleted until it starts, and this one has not.
  const treatments: TreatmentSummary[] = [];
  try {
    const locales = args.locales ?? (await controlLocales(client, experimentId));
    for (const treatment of args.treatments) {
      const res = resourceOf(
        await client.post(TREATMENTS, {
          data: {
            type: "appStoreVersionExperimentTreatments",
            attributes: compact({ name: treatment.name, appIconName: treatment.appIconName }),
            relationships: {
              appStoreVersionExperimentV2: {
                data: { type: "appStoreVersionExperiments", id: experimentId },
              },
            },
          },
        }),
      );
      const treatmentId = String(res.id);
      treatments.push({
        ...summarizeTreatment(res),
        localizations: await ensureLocalizations(client, treatmentId, locales),
      });
    }
  } catch (err) {
    const rolledBack = await client
      .del(`${EXPERIMENTS}/${experimentId}`)
      .then(() => true)
      .catch(() => false);
    throw new PreconditionError(
      `Creating the test's treatments failed: ${err instanceof Error ? err.message : String(err)}. ` +
        (rolledBack
          ? `The draft test ${experimentId} was deleted again, so nothing is left behind.`
          : `Deleting the draft test ${experimentId} failed too: delete it with ` +
            `app_store_connect_delete_experiment before retrying.`),
      { experimentId, rolledBack, treatmentsCreated: treatments },
    );
  }

  return {
    ...summarizeExperiment(resourceOf(created), new Map(), treatments),
    next:
      "Place each treatment's screenshots and previews with app_store_connect_create_placement " +
      "(surface: appStoreVersionExperimentTreatmentLocalization, localizationId: " +
      "treatments[].localizations[locale]). A treatment left without media for a device size " +
      "shows the original page's. Then send the test to review with " +
      "app_store_connect_submit_items_for_review (experimentIds) and start it with " +
      "app_store_connect_update_experiment once Apple has accepted it.",
  };
};

// ─── registration ───────────────────────────────────────────────────────────

export const registerExperimentTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_experiments",
    {
      title: "App Store Connect: List Product Page Optimization Tests",
      description:
        "List an app's product page optimization (A/B) tests: each one's state, platform, " +
        "traffic proportion, start and end dates, the live version it runs against " +
        "(controlVersionId), and its treatments with any promotedDate (a treatment already " +
        "applied to the product page). Treatment localization ids, which " +
        "app_store_connect_create_placement needs, come from app_store_connect_get_experiment. " +
        "Apple's endpoint has no platform filter, so `platform` is applied after the read and " +
        "`limit` counts every platform. Test results are not in the API: they are in App " +
        "Analytics in the web UI.",
      inputSchema: z.object({
        appId: appIdArg,
        platform: z.enum(PLATFORMS).optional().describe("Only tests on this platform."),
        state: z.enum(EXPERIMENT_STATES).optional().describe("Only tests in this state."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ appId, platform, state, limit, savePath }) =>
      wrapSaved(savePath, async () => {
        const response = await client.get(
          `/v1/apps/${appId}/appStoreVersionExperimentsV2`,
          compact({
            "filter[state]": state,
            include: "appStoreVersionExperimentTreatments,latestControlVersion",
            "fields[appStoreVersions]": "versionString,appVersionState,platform",
            "limit[appStoreVersionExperimentTreatments]": 10,
            limit,
          }),
        );
        const treatments = includedIndex(response, "appStoreVersionExperimentTreatments");
        const versions = includedIndex(response, "appStoreVersions");
        const rows = resourcesOf(response)
          .filter((res) => platform === undefined || attributesOf(res).platform === platform)
          .map((res) =>
            summarizeExperiment(
              res,
              versions,
              relatedIds(res, "appStoreVersionExperimentTreatments").map((id) =>
                summarizeTreatment(treatments.get(id) ?? { id }),
              ),
            ),
          );
        // The paging verdict (`incomplete`, `meta`, `links.next`) comes from
        // summarizeResponse, so a capped page is never read as the whole list.
        const summarized = summarizeResponse(response);
        return { ...(isRecord(summarized) ? summarized : {}), data: rows };
      }),
  );

  server.registerTool(
    "app_store_connect_get_experiment",
    {
      title: "App Store Connect: Get Product Page Optimization Test",
      description:
        "Get one product page optimization test with every treatment and, per treatment, its " +
        "localization ids keyed by locale (`treatments[].localizations`). Those ids are what " +
        "app_store_connect_create_placement and app_store_connect_list_placements take with " +
        "surface appStoreVersionExperimentTreatmentLocalization to put screenshots and " +
        "previews on a treatment, or to see what it carries.",
      inputSchema: z.object({ experimentId: experimentIdArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ experimentId, savePath }) =>
      wrapSaved(savePath, async () => readExperiment(client, experimentId)),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_experiment",
    {
      title: "App Store Connect: Create Product Page Optimization Test",
      description:
        "Create a product page optimization test with up to three treatments and a " +
        "localization per locale on each, and return every treatment localization id by " +
        "locale, ready for app_store_connect_create_placement (surface " +
        "appStoreVersionExperimentTreatmentLocalization). Apple runs tests on iOS and iPadOS " +
        "only, for apps with a version live on the App Store; the test runs against that live " +
        "version (controlVersionId), so a screenshot-only test needs no new build. Locales " +
        "default to the live version's, as the web UI does; a visitor whose locale is left out " +
        "is not in the test. If any treatment or localization fails, the new draft test is " +
        "deleted again rather than left half-built. Not started and not submitted: place the " +
        "media, send the test to review with app_store_connect_submit_items_for_review, then " +
        "start it with app_store_connect_update_experiment. A treatment icon (appIconName) must " +
        "be an alternate icon in the live binary; only screenshots and previews can be changed " +
        "without a new version.",
      inputSchema: z.object({
        appId: appIdArg,
        platform: z
          .enum(PLATFORMS)
          .default("IOS")
          .describe("IOS (the default) covers iPhone and iPad. Apple offers tests on iOS only."),
        name: z
          .string()
          .min(1)
          .describe("Reference name, shown in App Store Connect and App Analytics."),
        trafficProportion: trafficProportionArg,
        treatments: z
          .array(
            z.object({
              name: z.string().min(1).describe("Treatment name, e.g. 'Ebony background'."),
              appIconName: z
                .string()
                .optional()
                .describe("An alternate icon name from the live binary. Omit to keep the icon."),
            }),
          )
          .min(1)
          .max(MAX_TREATMENTS)
          .describe("One to three treatments, each shown in place of the original page."),
        locales: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Locales to test, e.g. ['en-US', 'fr-FR']. Defaults to every locale of the live " +
              "version.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => wrap(async () => createExperiment(client, args)),
  );

  server.registerTool(
    "app_store_connect_update_experiment",
    {
      title: "App Store Connect: Update Product Page Optimization Test",
      description:
        "Rename a product page optimization test, change its traffic proportion, or start it " +
        "(`start: true`). Apple's update request has exactly these three fields. Start a test " +
        "once its treatments' media are approved: Apple's help says to have every treatment's " +
        "metadata approved first, and a test holding unapproved media goes to review with " +
        "app_store_connect_submit_items_for_review. A test runs for 90 days unless stopped. " +
        "Stopping is NOT in the API: the spec has no stop field or route, so stopping a running " +
        "test is web-UI only (Product Page Optimization, the test, Stop Test), and a stopped " +
        "test cannot be restarted. Applying a treatment with " +
        "app_store_connect_apply_treatment also stops it.",
      inputSchema: z.object({
        experimentId: experimentIdArg,
        name: z.string().min(1).optional().describe("New reference name."),
        trafficProportion: trafficProportionArg.optional(),
        start: z.literal(true).optional().describe("Start the test. It cannot be un-started."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ experimentId, name, trafficProportion, start }) =>
      wrap(async () => {
        if (name === undefined && trafficProportion === undefined && start === undefined) {
          throw new Error("Pass at least one of `name`, `trafficProportion` or `start`.");
        }
        const updated = await client.patch(`${EXPERIMENTS}/${experimentId}`, {
          data: {
            type: "appStoreVersionExperiments",
            id: experimentId,
            attributes: compact({ name, trafficProportion, started: start }),
          },
        });
        return summarizeExperiment(resourceOf(updated), new Map());
      }),
  );

  server.registerTool(
    "app_store_connect_delete_experiment",
    {
      title: "App Store Connect: Delete Product Page Optimization Test",
      description:
        "Delete a product page optimization test that has not started, with its treatments. " +
        "Apple only deletes a test before it starts, so a started one is refused here with its " +
        "dates. A test that is in review is refused too: withdraw the submission holding it " +
        "with app_store_connect_cancel_review_submission first.",
      inputSchema: z.object({ experimentId: experimentIdArg, confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ experimentId }) =>
      wrap(async () => {
        const attrs = attributesOf(resourceOf(await client.get(`${EXPERIMENTS}/${experimentId}`)));
        const state = optString(attrs.state);
        if (typeof attrs.startDate === "string") {
          throw new PreconditionError(
            `Test ${experimentId} started on ${attrs.startDate}, and Apple only deletes a test ` +
              `before it starts.` +
              (isRunning(attrs)
                ? " Stopping a running test is web-UI only (Product Page Optimization, the " +
                  "test, Stop Test)."
                : ""),
            { experimentId, state, startDate: attrs.startDate, endDate: attrs.endDate },
          );
        }
        if (state !== undefined && IN_REVIEW_STATES.has(state)) {
          throw new PreconditionError(
            `Test ${experimentId} is ${state}, so it sits on a review submission. Withdraw that ` +
              `with app_store_connect_cancel_review_submission (dryRun first) before deleting it.`,
            { experimentId, state },
          );
        }
        await client.del(`${EXPERIMENTS}/${experimentId}`);
        return { deleted: experimentId, state };
      }),
  );

  server.registerTool(
    "app_store_connect_apply_treatment",
    {
      title: "App Store Connect: Apply Treatment to Product Page",
      description:
        "Apply a test treatment to a version's product page (Apple's appStoreVersionPromotions, " +
        "the web UI's 'Apply Treatment to Current Product Page'). Caveats, from Apple's help: " +
        "only the treatment's screenshots and app previews are applied, NEVER its icon (ship " +
        "an icon as the default in the next version instead); it cannot be undone; one " +
        "treatment per test can be applied; and applying one while the test runs stops the " +
        "test for good. The version must be READY_FOR_DISTRIBUTION (the live page) or " +
        "PREPARE_FOR_SUBMISSION; this checks that, the platform, and that no other treatment " +
        "of the test was applied, before anything is sent. One version per call: the web UI's " +
        "multi-version choice is several calls here. dryRun runs those checks and sends " +
        "nothing.",
      inputSchema: z.object({
        treatmentId: treatmentIdArg,
        versionId: versionIdArg.describe(
          "The appStoreVersion whose product page takes the treatment: the live one, or one " +
            "in PREPARE_FOR_SUBMISSION (app_store_connect_list_versions).",
        ),
        dryRun: dryRunArg,
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ treatmentId, versionId, dryRun = false }) =>
      wrap(async () => {
        const treatment = resourceOf(
          await client.get(`${TREATMENTS}/${treatmentId}`, {
            include: "appStoreVersionExperimentV2",
          }),
        );
        const experimentId = relatedId(treatment, "appStoreVersionExperimentV2");
        if (experimentId === undefined) {
          throw new PreconditionError(
            `Treatment ${treatmentId} belongs to no v2 test (it may be a deprecated v1 test, ` +
              `which this server does not handle). Apply it in the web UI.`,
            { treatmentId },
          );
        }
        const experiment = resourceOf(await client.get(`${EXPERIMENTS}/${experimentId}`));
        const expAttrs = attributesOf(experiment);
        const siblings = resourcesOf(
          await client.get(`${EXPERIMENTS}/${experimentId}/appStoreVersionExperimentTreatments`, {
            limit: 10,
          }),
        );
        const applied = siblings.find((t) => typeof attributesOf(t).promotedDate === "string");
        const version = attributesOf(
          resourceOf(
            await client.get(`/v1/appStoreVersions/${versionId}`, {
              "fields[appStoreVersions]": "versionString,appVersionState,platform",
            }),
          ),
        );

        const problems = [
          applied !== undefined
            ? `treatment ${String(applied.id)} of this test was already applied on ` +
              `${String(attributesOf(applied).promotedDate)}, and Apple allows one per test`
            : undefined,
          !PROMOTABLE_VERSION_STATES.has(String(version.appVersionState))
            ? `version ${String(version.versionString)} is ${String(version.appVersionState)}; ` +
              `a treatment applies only to a version that is READY_FOR_DISTRIBUTION or ` +
              `PREPARE_FOR_SUBMISSION`
            : undefined,
          version.platform !== undefined &&
          expAttrs.platform !== undefined &&
          version.platform !== expAttrs.platform
            ? `the version is ${String(version.platform)} and the test is ` +
              `${String(expAttrs.platform)}`
            : undefined,
        ].filter((p): p is string => p !== undefined);
        if (problems.length > 0) {
          throw new PreconditionError(`Cannot apply this treatment: ${problems.join("; ")}.`, {
            treatmentId,
            experimentId,
            versionId,
          });
        }

        const running = isRunning(expAttrs);
        const summary = {
          treatmentId,
          treatmentName: attributesOf(treatment).name,
          experimentId,
          versionId,
          versionString: version.versionString,
          stopsRunningTest: running,
        };
        if (dryRun) {
          return {
            ...summary,
            dryRun: true,
            applied: false,
            note:
              "Checks passed and nothing was sent. Applying copies the treatment's screenshots " +
              "and previews (not its icon) onto this version's product page, cannot be undone" +
              (running ? ", and stops the running test for good." : "."),
          };
        }
        await client.post("/v1/appStoreVersionPromotions", {
          data: {
            type: "appStoreVersionPromotions",
            relationships: {
              appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
              appStoreVersionExperimentTreatment: {
                data: { type: "appStoreVersionExperimentTreatments", id: treatmentId },
              },
            },
          },
        });
        return {
          ...summary,
          applied: true,
          note:
            "Applied: the treatment's screenshots and previews are now this version's. Its " +
            "icon was not applied. Check the result with app_store_connect_list_placements on " +
            "the version's localizations." +
            (running ? " The test was running and is now stopped." : ""),
        };
      }),
  );
};
