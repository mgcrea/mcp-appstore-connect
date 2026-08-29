import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppStoreConnectClient } from "../client/asc.js";
import {
  attributesOf,
  firstIncluded,
  relatedId,
  resourceOf,
  resourcesOf,
} from "../client/shape.js";
import { fetchListing } from "../listing/fetch.js";
import { getOrNull, versionIdArg, wrap } from "./util.js";

type CheckStatus = "pass" | "fail" | "warn" | "manual";

type ReleaseCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
};

const SUBMITTABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  // A dry-run submission stages the version on a draft and moves it here.
  "READY_FOR_REVIEW",
]);

const nonEmpty = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Read-only release preflight. This intentionally does not call the submit tool's
 * dry-run path: dry-run is useful, but it creates/reuses a review submission and
 * can move the version to READY_FOR_REVIEW. A doctor should be safe to run from
 * CI, an agent loop, or a dashboard without changing App Store Connect state.
 */
export const registerReleaseDoctorTools = (
  server: McpServer,
  client: AppStoreConnectClient,
): void => {
  server.registerTool(
    "app_store_connect_release_doctor",
    {
      description:
        "Audit an App Store version for the common release blockers without changing anything. " +
        "Checks version state, attached build, pricing, content-rights declaration, primary " +
        "category, listing metadata, screenshots, age-rating answers and App Review Information. " +
        "App Privacy is reported as a manual check because Apple does not expose a usable public " +
        "API for that questionnaire. Use this before submit_version_for_review or in CI.",
      inputSchema: { versionId: versionIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ versionId }) =>
      wrap(async () => {
        const checks: ReleaseCheck[] = [];
        const add = (
          id: string,
          label: string,
          status: CheckStatus,
          detail: string,
          fix?: string,
        ): void => {
          checks.push({ id, label, status, detail, ...(fix ? { fix } : {}) });
        };

        const versionResponse = await client.get(`/v1/appStoreVersions/${versionId}`, {
          include: "app,build",
        });
        const version = resourceOf(versionResponse);
        const versionAttrs = attributesOf(version);
        const versionString =
          typeof versionAttrs.versionString === "string" ? versionAttrs.versionString : undefined;
        const platform = typeof versionAttrs.platform === "string" ? versionAttrs.platform : undefined;
        const appStoreState =
          typeof versionAttrs.appStoreState === "string" ? versionAttrs.appStoreState : undefined;
        const appId = relatedId(version, "app");
        const buildId = relatedId(version, "build");

        if (appStoreState && SUBMITTABLE_STATES.has(appStoreState)) {
          add(
            "version-state",
            "Version state",
            "pass",
            appStoreState === "READY_FOR_REVIEW"
              ? "READY_FOR_REVIEW — the version is already staged on a draft review submission; a submit call can resume it."
              : `${appStoreState} — this state can enter a review submission.`,
          );
        } else {
          add(
            "version-state",
            "Version state",
            "fail",
            appStoreState
              ? `${appStoreState} is not a state this server can submit from.`
              : "App Store Connect returned no appStoreState for this version.",
          );
        }

        if (!appId) {
          add(
            "app-relationship",
            "App relationship",
            "fail",
            "The version response did not identify its parent app, so app-level release gates cannot be checked.",
          );
        } else {
          add("app-relationship", "App relationship", "pass", `Parent app: ${appId}.`);
        }

        if (!buildId) {
          add(
            "build-attached",
            "Build attached",
            "fail",
            "No build is attached to this App Store version.",
            "Use app_store_connect_set_version_build.",
          );
        } else {
          const build = firstIncluded(versionResponse, "builds");
          const buildAttrs = build ? attributesOf(build) : {};
          const processingState = buildAttrs.processingState;
          const expired = buildAttrs.expired;

          if (processingState === "VALID" && expired !== true) {
            add(
              "build-attached",
              "Build attached",
              "pass",
              `Build ${buildId} is attached and VALID${expired === false ? " (not expired)" : ""}.`,
            );
          } else if (build) {
            add(
              "build-attached",
              "Build attached",
              "fail",
              `Build ${buildId} is attached, but processingState=${String(processingState)} and expired=${String(expired)}.`,
              "Wait for a VALID build or attach a newer build.",
            );
          } else {
            add(
              "build-attached",
              "Build attached",
              "warn",
              `Build ${buildId} is attached, but its included attributes were not returned, so processing/expiry could not be verified.`,
            );
          }
        }

        if (nonEmpty(versionAttrs.copyright)) {
          add("copyright", "Copyright", "pass", String(versionAttrs.copyright));
        } else {
          add(
            "copyright",
            "Copyright",
            "fail",
            "The version has no copyright value.",
            "Set the version metadata before submission.",
          );
        }

        let appAttrs: Record<string, unknown> = {};
        if (appId) {
          try {
            const appResponse = await client.get(`/v1/apps/${appId}`);
            appAttrs = attributesOf(resourceOf(appResponse));
            if (nonEmpty(appAttrs.contentRightsDeclaration)) {
              add(
                "content-rights",
                "Content rights declaration",
                "pass",
                String(appAttrs.contentRightsDeclaration),
              );
            } else {
              add(
                "content-rights",
                "Content rights declaration",
                "fail",
                "contentRightsDeclaration is unset. Apple requires this before review.",
                "Use app_store_connect_update_app with the truthful third-party-content declaration.",
              );
            }
          } catch (err) {
            add(
              "content-rights",
              "Content rights declaration",
              "warn",
              `Could not verify the app-level declaration: ${message(err)}`,
            );
          }
        }

        let listing:
          | Awaited<ReturnType<typeof fetchListing>>
          | undefined;
        if (appId && versionString && platform) {
          try {
            listing = await fetchListing(client, {
              appId,
              version: versionString,
              platform,
              now: () => new Date(),
            });

            if (listing.appInfo.primaryCategory) {
              add(
                "primary-category",
                "Primary category",
                "pass",
                `Category id ${listing.appInfo.primaryCategory}.`,
              );
            } else {
              add(
                "primary-category",
                "Primary category",
                "fail",
                "No primary App Store category is configured.",
                "Use app_store_connect_set_app_categories.",
              );
            }

            const primaryLocale = listing.app.primaryLocale;
            const primary = listing.locales[primaryLocale];
            if (!primary) {
              add(
                "primary-localization",
                "Primary localization",
                "fail",
                `No localization data was found for the app's primary locale ${primaryLocale}.`,
              );
            } else {
              const required = [
                ["name", "name"],
                ["description", "description"],
                ["keywords", "keywords"],
                ["supportUrl", "support URL"],
                ["privacyPolicyUrl", "privacy policy URL"],
              ] as const;
              const missing = required
                .filter(([field]) => !nonEmpty(primary[field]))
                .map(([, label]) => label);

              if (missing.length === 0) {
                add(
                  "primary-localization",
                  "Primary localization",
                  "pass",
                  `${primaryLocale} has name, description, keywords, support URL and privacy policy URL.`,
                );
              } else {
                add(
                  "primary-localization",
                  "Primary localization",
                  "fail",
                  `${primaryLocale} is missing: ${missing.join(", ")}.`,
                  "Export/edit/apply the listing with the listing tools.",
                );
              }
            }
          } catch (err) {
            add(
              "listing",
              "Listing metadata",
              "warn",
              `Could not complete the listing audit: ${message(err)}`,
            );
          }
        } else {
          add(
            "listing",
            "Listing metadata",
            "warn",
            "The app id, version string or platform was missing, so the listing could not be resolved.",
          );
        }

        if (appId) {
          try {
            const price = await getOrNull(client, `/v1/apps/${appId}/appPriceSchedule`, {
              include: "baseTerritory",
            });
            const priceId = resourceOf(price).id;
            if (typeof priceId === "string") {
              add(
                "pricing",
                "App price schedule",
                "pass",
                `Price schedule ${priceId} exists (free apps also need an explicit 0-price schedule).`,
              );
            } else {
              add(
                "pricing",
                "App price schedule",
                "fail",
                "No app price schedule exists. Even a free app must explicitly use a 0 price point.",
                "Use app_store_connect_set_app_price.",
              );
            }
          } catch (err) {
            add(
              "pricing",
              "App price schedule",
              "warn",
              `Could not verify pricing: ${message(err)}`,
            );
          }
        }

        try {
          const review = await getOrNull(
            client,
            `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`,
          );
          const reviewResource = resourceOf(review);
          const reviewId = reviewResource.id;
          const reviewAttrs = attributesOf(reviewResource);
          if (typeof reviewId !== "string") {
            add(
              "review-detail",
              "App Review Information",
              "fail",
              "No App Review Information record exists for this version.",
              "Use app_store_connect_set_app_store_review_detail.",
            );
          } else {
            const missingContact = [
              ["contactFirstName", "first name"],
              ["contactLastName", "last name"],
              ["contactEmail", "email"],
              ["contactPhone", "phone"],
            ]
              .filter(([field]) => !nonEmpty(reviewAttrs[field]))
              .map(([, label]) => label);
            const demoMissing =
              reviewAttrs.demoAccountRequired === true &&
              (!nonEmpty(reviewAttrs.demoAccountName) || !nonEmpty(reviewAttrs.demoAccountPassword));

            if (missingContact.length === 0 && !demoMissing) {
              add(
                "review-detail",
                "App Review Information",
                "pass",
                `Review detail ${reviewId} has a complete contact${reviewAttrs.demoAccountRequired === true ? " and demo credentials" : ""}.`,
              );
            } else {
              const reasons = [
                ...(missingContact.length > 0
                  ? [`missing contact fields: ${missingContact.join(", ")}`]
                  : []),
                ...(demoMissing ? ["demo account is required but its username/password is incomplete"] : []),
              ];
              add(
                "review-detail",
                "App Review Information",
                "fail",
                reasons.join("; "),
                "Use app_store_connect_set_app_store_review_detail.",
              );
            }
          }
        } catch (err) {
          add(
            "review-detail",
            "App Review Information",
            "warn",
            `Could not verify review information: ${message(err)}`,
          );
        }

        if (listing) {
          const appInfoId = listing.appInfo.id;
          try {
            const declaration = await getOrNull(
              client,
              `/v1/appInfos/${appInfoId}/ageRatingDeclaration`,
            );
            const declarationResource = resourceOf(declaration);
            const declarationId = declarationResource.id;
            const declarationAttrs = attributesOf(declarationResource);
            if (typeof declarationId !== "string") {
              add(
                "age-rating",
                "Age rating",
                "fail",
                "No age-rating declaration could be found for the editable appInfo.",
              );
            } else if (declarationAttrs.socialMedia === undefined) {
              add(
                "age-rating",
                "Age rating",
                "warn",
                `Age-rating declaration ${declarationId} exists, but socialMedia is unanswered. Apple requires the expanded questionnaire for releases from September 2026.`,
                "Use app_store_connect_update_age_rating_declaration.",
              );
            } else {
              add(
                "age-rating",
                "Age rating",
                "pass",
                `Age-rating declaration ${declarationId} exists and includes the socialMedia answer.`,
              );
            }
          } catch (err) {
            add("age-rating", "Age rating", "warn", `Could not verify age rating: ${message(err)}`);
          }

          const primaryLocale = listing.app.primaryLocale;
          const versionLocalizationId = listing.localizationIds[primaryLocale]?.version;
          if (!versionLocalizationId) {
            add(
              "screenshots",
              "Screenshots",
              "fail",
              `No App Store version localization id exists for primary locale ${primaryLocale}, so screenshots cannot be attached there.`,
            );
          } else {
            try {
              const setResponse = await client.get(
                `/v1/appStoreVersionLocalizations/${versionLocalizationId}/appScreenshotSets`,
                { limit: 50 },
              );
              const sets = resourcesOf(setResponse);
              let screenshotCount = 0;
              const deviceTypes: string[] = [];
              for (const set of sets) {
                const setId = typeof set.id === "string" ? set.id : undefined;
                const type = attributesOf(set).screenshotDisplayType;
                if (typeof type === "string") deviceTypes.push(type);
                if (!setId) continue;
                const screenshots = await client.get(
                  `/v1/appScreenshotSets/${setId}/appScreenshots`,
                  { limit: 50 },
                );
                screenshotCount += resourcesOf(screenshots).length;
              }

              if (screenshotCount > 0) {
                add(
                  "screenshots",
                  "Screenshots",
                  "pass",
                  `${primaryLocale} has ${screenshotCount} screenshot(s) across ${sets.length} set(s)` +
                    (deviceTypes.length ? `: ${deviceTypes.join(", ")}.` : "."),
                );
              } else {
                add(
                  "screenshots",
                  "Screenshots",
                  "fail",
                  `${primaryLocale} has no uploaded screenshots.`,
                  "Use app_store_connect_upload_screenshot for the required device families.",
                );
              }
            } catch (err) {
              add("screenshots", "Screenshots", "warn", `Could not verify screenshots: ${message(err)}`);
            }
          }
        }

        add(
          "app-privacy",
          "App Privacy questionnaire",
          "manual",
          "Verify Data Used to Track You / Data Linked to You / Data Not Linked to You in App Store Connect. Apple does not expose a reliable public API for this questionnaire, so the MCP cannot certify it.",
        );

        const blockers = checks.filter((check) => check.status === "fail");
        const warnings = checks.filter((check) => check.status === "warn");
        const manualChecks = checks.filter((check) => check.status === "manual");

        return {
          version: {
            id: versionId,
            versionString,
            platform,
            appStoreState,
            appId,
            buildId,
          },
          verdict:
            blockers.length > 0
              ? "blocked"
              : warnings.length > 0 || manualChecks.length > 0
                ? "manual_verification_required"
                : "looks_ready",
          automatedReady: blockers.length === 0,
          blockerCount: blockers.length,
          warningCount: warnings.length,
          manualCheckCount: manualChecks.length,
          checks,
          next:
            blockers.length > 0
              ? "Fix the failed checks, then run app_store_connect_release_doctor again."
              : "Automated checks passed. Complete the manual App Privacy check, then use app_store_connect_submit_version_for_review (dryRun first if you want Apple's authoritative preflight).",
        };
      }),
  );
};
