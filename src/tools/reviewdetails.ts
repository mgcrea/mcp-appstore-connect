import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { attributesOf, resourceOf, summarizeResponse } from "#/client/shape";
import type { Contact } from "#/config";
import type { ToolContext } from "#/tools/index";
import { compact, getOrNull, savePathArg, versionIdArg, wrap, wrapSaved } from "#/tools/util";

// App Review Information: who Apple contacts, and how they get into the app.
// The resource does not exist until someone creates it, and a version without
// one is refused at submission with ENTITY_ERROR.RELATIONSHIP.INVALID —
// "The appStoreReviewDetail associated with appStoreVersions <id> was not
// found." That reads as a broken reference rather than as "you never filled in
// the review contact", which is what it means.

const reviewDetailFields = {
  contactFirstName: z.string().optional().describe("First name of the review contact."),
  contactLastName: z.string().optional().describe("Last name of the review contact."),
  contactPhone: z.string().optional().describe("Phone number Apple can reach the contact on."),
  contactEmail: z.string().optional().describe("Email address Apple can reach the contact on."),
  demoAccountName: z
    .string()
    .optional()
    .describe("Username of a working demo account, when the app needs a sign-in to review."),
  demoAccountPassword: z.string().optional().describe("Password for the demo account."),
  demoAccountRequired: z
    .boolean()
    .optional()
    .describe(
      "Whether reviewing the app requires signing in. Set false for an app with no accounts — " +
        "leaving it unset on an app that plainly has a login invites a rejection.",
    ),
  notes: z
    .string()
    .optional()
    .describe(
      "Notes for the reviewer: how to reach the feature being reviewed, what hardware it needs, " +
        "anything that would otherwise look broken. This is where an app whose main feature is " +
        "behind a paywall or a device capability explains itself.",
    ),
};

/**
 * The id of an existing review detail, or undefined when the version has none.
 *
 * Absence arrives two ways and neither is an error: `getOrNull` turns a 404 into
 * null, and a version that never had one answers **200 with `data: null`**. Both
 * mean "create it", and conflating either with a hit sends a PATCH to
 * `/appStoreReviewDetails/undefined`.
 */
const reviewDetailId = (response: unknown): string | undefined => {
  if (response === null) return undefined;
  const id = resourceOf(response).id;
  return typeof id === "string" ? id : undefined;
};

/** Which review-detail attribute each configured contact field feeds. */
const CONTACT_FIELDS = [
  ["firstName", "contactFirstName"],
  ["lastName", "contactLastName"],
  ["email", "contactEmail"],
  ["phone", "contactPhone"],
] as const satisfies readonly (readonly [keyof Contact, string])[];

type ContactDefaults = {
  attributes: Record<string, unknown>;
  /** Attributes this call is filling in from config, for the response. */
  fromConfig: string[];
  /** Attributes where the record disagrees with config, left as they are. */
  drift: Record<string, { record: string; config: string }>;
};

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * Fill contact attributes the caller left out from the configured contact.
 *
 * Precedence is explicit argument > whatever the record already holds > config.
 * Config only ever fills a *gap*, so a contact set in the App Store Connect web
 * UI is never silently rewritten by a call that meant to edit `notes`. On create
 * there is no record, so all four come from config — which is the case that
 * matters, since a version with no review detail cannot be submitted at all.
 *
 * A record value that disagrees with config is reported rather than corrected:
 * drift you can see is a decision, drift that fixes itself is a surprise write.
 */
const applyContactDefaults = (
  attributes: Record<string, unknown>,
  existing: Record<string, unknown>,
  contact: Contact | undefined,
): ContactDefaults => {
  const result: ContactDefaults = { attributes: { ...attributes }, fromConfig: [], drift: {} };
  if (!contact) return result;

  for (const [key, attribute] of CONTACT_FIELDS) {
    const configured = nonEmpty(contact[key]);
    if (configured === undefined) continue;
    // The caller was explicit — nothing to default, and nothing to report.
    if (nonEmpty(attributes[attribute]) !== undefined) continue;

    const current = nonEmpty(existing[attribute]);
    if (current === undefined) {
      result.attributes[attribute] = configured;
      result.fromConfig.push(attribute);
    } else if (current !== configured) {
      result.drift[attribute] = { record: current, config: configured };
    }
  }
  return result;
};

export const registerReviewDetailTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  { allowWrites, contact }: ToolContext,
): void => {
  server.registerTool(
    "app_store_connect_get_app_store_review_detail",
    {
      title: "App Store Connect: Get App Store Review Detail",
      description:
        "Get the App Review Information attached to a version: the contact Apple reaches, the " +
        "demo account, and the reviewer notes. A null result means none exists, which blocks " +
        "submission — this is the check for the 'appStoreReviewDetail … was not found' error.",
      inputSchema: z.object({ versionId: versionIdArg, savePath: savePathArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ versionId, savePath }) =>
      wrapSaved(savePath, async () => {
        const response = await getOrNull(
          client,
          `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`,
        );
        // Two spellings of "absent", and only one of them is a 404: a version
        // that never had a review detail answers 200 with `data: null`, so
        // testing the envelope alone would report the empty case as a hit.
        if (reviewDetailId(response) === undefined) {
          return {
            data: null,
            note:
              "This version has no App Review Information, so it cannot be submitted. Create it " +
              "with app_store_connect_set_app_store_review_detail.",
          };
        }
        return summarizeResponse(response);
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_set_app_store_review_detail",
    {
      title: "App Store Connect: Set App Store Review Detail",
      description:
        "Set the App Review Information for a version, creating it if this is the first time. " +
        "Required before submitting: a version with none is refused, and the error names a " +
        "missing relationship rather than the missing contact details. Only the fields you pass " +
        "are changed on an existing record. The contact is who Apple phones or emails if review " +
        "has a question, so it must be a real person who will answer — omit the contact " +
        "fields to use the one configured in config.json, which only fills what the record " +
        "is missing and reports any value that disagrees with it.",
      inputSchema: z.object({ versionId: versionIdArg, ...reviewDetailFields }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ versionId, ...attributes }) =>
      wrap(async () => {
        const existing = await getOrNull(
          client,
          `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`,
        );
        const existingId = reviewDetailId(existing);

        // The GET above already had to happen to choose the verb, so the current
        // attributes are free — which is what makes gap-filling possible without
        // a second round trip.
        const defaults = applyContactDefaults(
          compact(attributes),
          attributesOf(resourceOf(existing)),
          contact,
        );
        // Reported alongside the write so filling in a contact from config is
        // visible in the result rather than inferred from Apple's echo.
        const report = {
          ...(defaults.fromConfig.length > 0 ? { contactFromConfig: defaults.fromConfig } : {}),
          ...(Object.keys(defaults.drift).length > 0 ? { contactDrift: defaults.drift } : {}),
        };

        // PATCH and POST are not interchangeable here: PATCH against a version
        // that has no detail 404s, and POST against one that does 409s with a
        // duplicate-relationship error. Which verb is right is a property of the
        // server's state, not of the caller's intent, so it is resolved here
        // rather than pushed onto whoever is trying to fill in a phone number.
        if (existingId === undefined) {
          return {
            created: true,
            ...report,
            ...(summarizeResponse(
              await client.post("/v1/appStoreReviewDetails", {
                data: {
                  type: "appStoreReviewDetails",
                  attributes: defaults.attributes,
                  relationships: {
                    appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
                  },
                },
              }),
            ) as Record<string, unknown>),
          };
        }

        return {
          created: false,
          ...report,
          ...(summarizeResponse(
            await client.patch(`/v1/appStoreReviewDetails/${existingId}`, {
              data: {
                type: "appStoreReviewDetails",
                id: existingId,
                attributes: defaults.attributes,
              },
            }),
          ) as Record<string, unknown>),
        };
      }),
  );
};
