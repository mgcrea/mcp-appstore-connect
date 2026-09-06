import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppStoreConnectClient } from "#/client/asc";
import { attributesOf, isRecord, resourceOf, summarizeResponse } from "#/client/shape";
import {
  compact,
  confirmArg,
  limitArg,
  type SavedFile,
  savePathArg,
  saveToPath,
  wrap,
  wrapSaved,
} from "#/tools/util";

/**
 * Apple's `CertificateType` is a moving target — DEVELOPER_ID_APPLICATION_G2 and
 * the IDENTIFIER_MANAGEMENT types were added after the endpoint shipped — so this
 * is a string with the common values documented rather than a `z.enum`. Apple
 * rejects an unknown value with a clear error the client already surfaces, and a
 * stale enum here would refuse a type that is perfectly valid.
 */
const certificateTypeArg = z
  .string()
  .min(1)
  .describe(
    "Apple's certificate type. Common values: DEVELOPER_ID_APPLICATION (signs a Mac app " +
      "distributed outside the App Store — this is the one notarization needs), " +
      "DEVELOPER_ID_KEXT, MAC_APP_DISTRIBUTION (Mac App Store), MAC_INSTALLER_DISTRIBUTION " +
      "(.pkg), MAC_APP_DEVELOPMENT, DEVELOPMENT, DISTRIBUTION, IOS_DEVELOPMENT, " +
      "IOS_DISTRIBUTION, PASS_TYPE_ID.",
  );

const certSavePathArg = z
  .string()
  .optional()
  .describe(
    "Absolute path to write the .cer to. Apple returns the certificate as base64 DER; this " +
      "decodes it and writes real DER bytes, so the file can be double-clicked to import into " +
      "the keychain. Parent directories are created.",
  );

/**
 * Decode Apple's base64 DER and write a double-clickable .cer.
 *
 * Goes through the shared writer, so this path gets the absolute-path rule and
 * the Docker-mount remedy it used to lack — a relative path here silently wrote
 * the certificate somewhere the caller could not find.
 */
const saveCertificate = async (content: unknown, path: string): Promise<SavedFile> => {
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("Apple returned no certificateContent to save.");
  }
  const written = await saveToPath(path, Buffer.from(content, "base64"), "certificate");
  return { ...written, content: "binary" };
};

/**
 * `certificateContent` is a multi-kilobyte base64 blob and `csrContent` is
 * another. Flattened by `summarizeResource` they land in the caller's context on
 * every single list, crowding out everything worth reading. Strip them and say
 * so — `download_certificate` exists to get the bytes deliberately.
 */
const stripBlobs = (row: unknown): unknown => {
  if (!isRecord(row)) return row;
  const { certificateContent, csrContent, ...rest } = row;
  return {
    ...rest,
    ...(certificateContent !== undefined ? { certificateContent: "<omitted>" } : {}),
    ...(csrContent !== undefined ? { csrContent: "<omitted>" } : {}),
  };
};

const withoutBlobs = (summarized: unknown): unknown => {
  if (!isRecord(summarized)) return summarized;
  const { data, ...rest } = summarized;
  return { data: Array.isArray(data) ? data.map(stripBlobs) : stripBlobs(data), ...rest };
};

export const registerCertificateTools = (
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "app_store_connect_list_certificates",
    {
      title: "App Store Connect: List Certificates",
      description:
        "List the signing certificates on the developer account — type, name, platform, serial " +
        "number and expiry. Use this before creating one: Developer ID certificates are capped " +
        "per team, and an existing one should be exported as a .p12 from the Mac that holds its " +
        "private key rather than replaced. The certificate and CSR bodies are omitted here; " +
        "app_store_connect_download_certificate writes them to a file.",
      inputSchema: z.object({
        certificateType: certificateTypeArg.optional(),
        displayName: z.string().optional().describe("Filter by display name (exact match)."),
        limit: limitArg,
        savePath: savePathArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ certificateType, displayName, limit, savePath }) =>
      wrapSaved(savePath, async () =>
        withoutBlobs(
          summarizeResponse(
            await client.get(
              "/v1/certificates",
              compact({
                "filter[certificateType]": certificateType,
                "filter[displayName]": displayName,
                limit,
              }),
            ),
          ),
        ),
      ),
  );

  server.registerTool(
    "app_store_connect_download_certificate",
    {
      title: "App Store Connect: Download Certificate",
      description:
        "Write an existing certificate to a .cer file, ready to double-click into the keychain. " +
        "Note this recovers only the public certificate: it is useless without the private key " +
        "generated alongside the CSR, which never leaves the Mac that made it. A certificate " +
        "downloaded onto a machine that lacks that key cannot sign anything.",
      inputSchema: z.object({
        certificateId: z.string().min(1).describe("Certificate id from list_certificates."),
        savePath: z.string().min(1).describe("Absolute path to write the .cer to."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ certificateId, savePath }) =>
      wrap(async () => {
        const response = await client.get(`/v1/certificates/${certificateId}`);
        const attributes = attributesOf(resourceOf(response));
        const saved = await saveCertificate(attributes.certificateContent, savePath);
        return {
          saved,
          // Deprecated alias for `saved.path`, removed in 0.24.
          savedTo: saved.path,
          certificateType: attributes.certificateType,
          name: attributes.name,
          expirationDate: attributes.expirationDate,
        };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "app_store_connect_create_certificate",
    {
      title: "App Store Connect: Create Certificate",
      description:
        "Create a signing certificate from a certificate signing request. " +
        "**The CSR must be generated locally first**, because it is bound to a private key that " +
        "must never leave the machine that will sign — that key is what makes a signature yours, " +
        "and this tool neither creates nor sees it.\n\n" +
        "Generate one either way:\n" +
        "  openssl req -new -newkey rsa:2048 -nodes -keyout devid.key -out devid.csr " +
        '-subj "/CN=Your Name/emailAddress=you@example.com/C=US"\n' +
        "or Keychain Access > Certificate Assistant > Request a Certificate From a Certificate " +
        "Authority, saved to disk (which keeps the private key in the keychain, where it is " +
        "harder to lose). Pass the PEM text of the .csr as csrContent.\n\n" +
        "With openssl you must import devid.key into the keychain too, or the downloaded " +
        "certificate will have no key to pair with and codesign will not see an identity.",
      inputSchema: z.object({
        certificateType: certificateTypeArg,
        csrContent: z
          .string()
          .min(1)
          .describe(
            "The full PEM text of the .csr, including the BEGIN/END CERTIFICATE REQUEST lines.",
          ),
        savePath: certSavePathArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ certificateType, csrContent, savePath }) =>
      wrap(async () => {
        const response = await client.post("/v1/certificates", {
          data: { type: "certificates", attributes: { certificateType, csrContent } },
        });
        const attributes = attributesOf(resourceOf(response));
        const saved = savePath
          ? await saveCertificate(attributes.certificateContent, savePath)
          : undefined;
        return compact({
          id: (resourceOf(response) as { id?: unknown }).id,
          certificateType: attributes.certificateType,
          name: attributes.name,
          serialNumber: attributes.serialNumber,
          expirationDate: attributes.expirationDate,
          saved,
          // Deprecated alias for `saved.path`, removed in 0.24. Losing it fails
          // loudly — a caller reading it gets undefined and says so — so unlike
          // `truncated` it does not need to be kept.
          savedTo: saved?.path,
          nextStep: saved
            ? `Double-click ${saved.path} to import it, then check: security find-identity -v -p codesigning`
            : "Pass savePath to write the .cer, or fetch it later with download_certificate.",
        });
      }),
  );

  server.registerTool(
    "app_store_connect_revoke_certificate",
    {
      title: "App Store Connect: Revoke Certificate",
      description:
        "Revoke a certificate. This is not undoable and it is not merely cleanup: anything still " +
        "distributed that was signed with it — and not yet notarized — can stop being trusted. " +
        "Revoke an expired or genuinely lost certificate, not one you are unsure about. " +
        "Developer ID certificates are capped per team, which is the usual reason to want this.",
      inputSchema: z.object({
        certificateId: z.string().min(1).describe("Certificate id from list_certificates."),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ certificateId }) =>
      wrap(async () => {
        await client.del(`/v1/certificates/${certificateId}`);
        return { revoked: certificateId };
      }),
  );
};
