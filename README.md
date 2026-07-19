# @mgcrea/mcp-appstore-connect

[![npm version](https://img.shields.io/npm/v/@mgcrea/mcp-appstore-connect.svg?style=for-the-badge)](https://www.npmjs.com/package/@mgcrea/mcp-appstore-connect)
[![GHCR](https://img.shields.io/badge/ghcr.io-container_image-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/mgcrea/mcp-appstore-connect/pkgs/container/mcp-appstore-connect)

Model Context Protocol server for the Apple [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi) — inspect your apps, versions, builds, TestFlight, sales and users, and (opt-in) edit metadata and manage testers, straight from an MCP client like Claude.

> **Unofficial.** Not affiliated with or endorsed by Apple. It talks to Apple's public App Store Connect REST API using an API key you generate yourself.

## Features

- **Broad coverage** — apps, App Store versions & localizations, builds, TestFlight groups/testers/feedback, sales & finance reports, analytics, users, bundle ids & capabilities, devices.
- **Listing round-trip** — export the whole store listing to a git-committable metadata tree, edit it locally, apply it back with digest-based conflict detection.
- **Read by default, writes opt-in** — mutating tools are not registered at all unless you ask for them. See [Security](#security).
- **Typed & tested** — ESM, built with tsdown, linted/formatted with oxc, tested with vitest. Tests run fully offline.

## Security

You are pointing an AI agent at the account that ships your apps, so the honest details matter more than reassurance.

### Supply chain

**Two direct dependencies:** `@modelcontextprotocol/sdk` and `zod`. Nothing else is chosen by us.

Being straight about what that actually costs: those two pull in **~94 packages** transitively — the number `npm install` prints, and every one of them arrives via the official MCP SDK. That's the honest figure, not "two dependencies". Two things keep the real exposure much smaller than 94:

- **Nothing runs at install time.** Not one package in the tree declares a `preinstall`, `install` or `postinstall` script, so `npm install` executes no third-party code — the most common supply-chain attack path simply isn't open.
- **Only 5 are reachable when the server runs:** the SDK, `zod`, `ajv`, `ajv-formats` and `zod-to-json-schema`. This server speaks **stdio only**, so the SDK's HTTP/SSE/OAuth stack (`express`, `hono`, `jose`, `cors`, `pkce-challenge`, `eventsource`) sits in the tree but is never imported.

Check all of it yourself:

```sh
npm view @mgcrea/mcp-appstore-connect dependencies       # the two
npm ls --omit=dev --all                                  # the ~94
grep -hoE '^import[^;]*from "[^"]+"' node_modules/@mgcrea/mcp-appstore-connect/dist/*.js
```

That last command prints everything the shipped bundle imports — the SDK's stdio entrypoints, `zod`, and Node builtins. Nothing else.

### Verified builds

Neither artifact is published from a laptop:

- **npm** — published by CI through [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so there is no long-lived `NPM_TOKEN` in existence to leak, plus a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements).
- **Container** — build provenance, an SBOM, and a [cosign](https://github.com/sigstore/cosign) keyless signature.

Both trace back to the exact commit and CI run that produced them. The commands to check are in [Verify](#verify) — please run them rather than take this section's word for it.

### Your credentials

**The `.p8` never leaves your machine, and never goes over the wire.** Tokens are minted locally: the server signs short-lived ES256 JWTs (20-minute cap, re-signed just before expiry) using Node's built-in `node:crypto`. There is no `jsonwebtoken` or `jose` in the signing path — one less dependency between your private key and the network. Under Docker the key is mounted read-only and is never baked into the image.

**The server never writes to your disk.** `export_listing` hands back `{path, content}` pairs and your agent writes them, so every file write stays under your own MCP client's permission prompt rather than happening invisibly inside the server.

### Blast radius

Three independent limits, smallest first:

1. **Writes are off by default.** Mutating tools aren't merely refused when `APP_STORE_CONNECT_ALLOW_WRITES=1` is unset — they are never registered, so they don't appear in the tool list and a confused agent cannot call them. The default install is read-only.
2. **Destructive tools need `confirm: true`.** Deleting a screenshot or removing a tester takes an explicit acknowledgement argument, so it can't happen as a side effect of some broader request.
3. **Your API key's role is the real ceiling**, and this server can't raise it. A read-only role is enough for every list/get tool; issue one of those and no bug here can write anything. Scope the key to the narrowest role that does your job.

Applying a listing has its own rails — digest-based conflict detection, an `allowClear` gate before any field is emptied, and a whole-apply abort if any field is over Apple's limit. See [Listing round-trip](#listing-round-trip).

## Configure

Create a key in App Store Connect → **Users and Access → Integrations → Keys → App Store Connect API**. Apple gives you an **Issuer ID**, a **Key ID**, and a one-time **`.p8`** download. Then set:

| Variable                          | Required | Notes                                                          |
| --------------------------------- | -------- | -------------------------------------------------------------- |
| `APP_STORE_CONNECT_KEY_ID`        | yes      | The 10-char Key ID.                                            |
| `APP_STORE_CONNECT_ISSUER_ID`     | yes      | The Issuer ID (a UUID).                                        |
| `APP_STORE_CONNECT_P8_PATH`       | one of   | Path to the `AuthKey_XXXX.p8` file.                            |
| `APP_STORE_CONNECT_P8`            | one of   | Inline PEM contents (for Docker/CI); set this **or** the path. |
| `APP_STORE_CONNECT_VENDOR_NUMBER` | reports  | Needed only by the sales/finance report tools.                 |
| `APP_STORE_CONNECT_ALLOW_WRITES`  | no       | `1` to register the write tools. Off by default.               |
| `APP_STORE_CONNECT_MAX_RETRIES`   | no       | Retry budget for 401/429/5xx. Defaults to 3.                   |
| `APP_STORE_CONNECT_DEBUG`         | no       | `1` to log to stderr.                                          |

See [.env.example](./.env.example) for the annotated list.

> The API key's **role** (set when you create it) decides what it can touch. A read-only role is enough for the list/get tools; editing metadata or managing testers needs App Manager or Admin. Team-scoped keys may require a JWT `scope` claim — if a call fails with `401 NOT_AUTHORIZED`, that's the likely cause.

## Quick start

Pick one of the three. All talk to the same App Store Connect API — the difference is only how the server is launched. Options A and B need nothing checked out.

### A. npx — recommended

Zero install; `npx` fetches and runs the published package. Wire it into Claude Code (or any MCP client) with your credentials:

```json
{
  "mcpServers": {
    "appstore-connect": {
      "command": "npx",
      "args": ["-y", "@mgcrea/mcp-appstore-connect"],
      "env": {
        "APP_STORE_CONNECT_KEY_ID": "XXXXXXXXXX",
        "APP_STORE_CONNECT_ISSUER_ID": "00000000-0000-0000-0000-000000000000",
        "APP_STORE_CONNECT_P8_PATH": "/absolute/path/to/AuthKey_XXXXXXXXXX.p8"
      }
    }
  }
}
```

To try it from a shell (reads the same env, or a local `.env`):

```sh
npx -y @mgcrea/mcp-appstore-connect
```

### B. Docker (stdio)

Runs the container image published to GHCR. The `.p8` never goes into the image or the config — mount it read-only and point `APP_STORE_CONNECT_P8_PATH` at the in-container path. The `-e VAR` (no value) flags forward the key id / issuer id from the `env` block, so no secret sits in `args`:

```json
{
  "mcpServers": {
    "appstore-connect": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "APP_STORE_CONNECT_KEY_ID",
        "-e",
        "APP_STORE_CONNECT_ISSUER_ID",
        "-e",
        "APP_STORE_CONNECT_P8_PATH=/keys/key.p8",
        "-v",
        "/absolute/path/to/AuthKey_XXXXXXXXXX.p8:/keys/key.p8:ro",
        "ghcr.io/mgcrea/mcp-appstore-connect:latest"
      ],
      "env": {
        "APP_STORE_CONNECT_KEY_ID": "XXXXXXXXXX",
        "APP_STORE_CONNECT_ISSUER_ID": "00000000-0000-0000-0000-000000000000"
      }
    }
  }
}
```

`-i` keeps stdin open, which the stdio transport needs — don't drop it. The left side of `-v` is the host path to your `.p8`; the container only ever sees `/keys/key.p8`. GHCR is the only registry CI publishes to — it's what carries the provenance/SBOM/cosign signature described in **Verify** below.

### C. From source (development)

```sh
git clone https://github.com/mgcrea/mcp-appstore-connect.git
cd mcp-appstore-connect
pnpm install
pnpm build
node dist/cli.js        # reads a local .env
```

Or wire the built entry directly: `"command": "node"`, `"args": ["/absolute/path/to/mcp-appstore-connect/dist/cli.js"]`.

### Inspect the tools

```sh
npx @modelcontextprotocol/inspector npx -y @mgcrea/mcp-appstore-connect
```

## Tools

**Apps** — `list_apps`, `get_app`

**Listing round-trip** — `export_listing`, _`apply_listing`_\* — pull the whole listing into a git-committable metadata tree, edit it locally, push it back. See [Listing round-trip](#listing-round-trip).

**Versions & metadata** — `list_versions`, `list_version_localizations`, `get_version_localization`, _`create_version`_\*, _`update_version_localization`_\* (description, keywords, what's-new, promo text)

**App info** — `list_app_infos`, `list_app_info_localizations`, `get_app_info_localization`, _`update_app_info_localization`_\* (name, subtitle, privacy policy — the fields that outlive a version)

**Screenshots** — `list_screenshot_sets`, `list_screenshots`, `get_screenshot`, _`upload_screenshot`_\*, _`delete_screenshot`_\*†, _`delete_screenshot_set`_\*†, _`reorder_screenshots`_\*†

**Builds** — `list_builds`

**TestFlight** — `list_beta_groups`, `list_beta_testers`, `list_beta_feedback`, _`invite_beta_tester`_\*, _`add_tester_to_group`_\*, _`remove_tester_from_group`_\*†

**Reports & analytics** — `download_sales_report`, `download_finance_report`, `list_analytics_reports`, _`create_analytics_report_request`_\*

**Users** — `list_users`

**Bundle IDs** — `list_bundle_ids`, `get_bundle_id`, _`create_bundle_id`_\*, _`enable_capability`_\*, _`disable_capability`_\*†

**Devices** — `list_devices`, _`register_device`_\*

_Italic\*_ tools are writes, hidden unless `APP_STORE_CONNECT_ALLOW_WRITES=1`. † additionally requires `confirm: true`.

Tool names are prefixed `app_store_connect_` (omitted above for brevity).

A Claude Code skill that drives these tools through a full release ships alongside the server —
see [Release-prep plugin](#release-prep-plugin).

## Listing round-trip

`export_listing` returns the complete listing — name, subtitle, description, keywords,
what's-new, promotional text and URLs, across every locale — as a set of files to write
into your repo:

```
fastlane/metadata/
  .listing.json          # ids + baseline digests. Commit it; never hand-edit it.
  en-US/
    name.txt  subtitle.txt  description.txt  keywords.txt
    release_notes.txt  promotional_text.txt
    marketing_url.txt  support_url.txt  privacy_url.txt
  fr-FR/
    ...
```

This is the layout `fastlane deliver` already uses, so the tree interops with it. One
file per field means the file content _is_ the value, byte for byte — a description
containing `## Keywords`, a `---` rule or a fenced code block is just text, and `git
diff` shows you the field that changed rather than a line number in a wall of copy.

The server never writes to disk: `export_listing` hands back `{path, content}` pairs and
your agent writes them, so every write stays under your own permission prompt and nothing
depends on host paths being visible inside Docker.

Editing and pushing back:

```
export_listing { appId }                       # version defaults to "latest"
# ...edit the .txt files, commit, review...
apply_listing  { files: [...] }                # dry run by default
apply_listing  { files: [...], dryRun: false, confirm: true }
```

- `version` accepts `"latest"` (the one you're preparing), `"live"` (on sale) or an exact
  `"1.4.0"`. Versions are ordered numerically, so `1.10.0` beats `1.9.0`.
- Pass **only the files you changed**, plus `.listing.json` — it carries the localization
  ids and the per-field digests recorded at export.
- Those digests make apply a three-way merge. A field edited in App Store Connect's web UI
  since your export is reported as a **conflict** and skipped, rather than silently
  overwritten; re-export and merge, or pass `force: true`.
- **An absent file leaves a field alone; an empty file clears it** — but clearing needs
  `allowClear: true`, so a file truncated by accident is reported as `blocked` rather than
  wiping live copy.
- Any field over Apple's limit aborts the whole apply before the first write — a
  half-applied listing is worse than an untouched one.
- `format: "review"` renders a read-only markdown summary with character counts, for when
  you just want to read the listing. Nothing parses it back.
- If `fastlane/metadata/` already exists, diff before overwriting it.

## Release-prep plugin

This repo doubles as a [Claude Code](https://claude.com/claude-code) plugin marketplace. The
`appstore-toolkit` plugin bundles the **`appstore-release-prep`** skill, which drives the
round-trip above: it audits what shipped since the last release, writes the CHANGELOG entry
and every store field within Apple's limits, and pushes the result back through
`apply_listing`.

```text
/plugin marketplace add mgcrea/mcp-appstore-connect
/plugin install appstore-toolkit@mgcrea-appstore
```

Installing it also wires up the `appstore-connect` MCP server, so the skill and the tools it
calls arrive together. The server config reads these from your shell environment — nothing is
stored in the plugin:

| Variable                          | Required                         |
| --------------------------------- | -------------------------------- |
| `APP_STORE_CONNECT_KEY_ID`        | yes                              |
| `APP_STORE_CONNECT_ISSUER_ID`     | yes                              |
| `APP_STORE_CONNECT_P8_PATH`       | yes                              |
| `APP_STORE_CONNECT_VENDOR_NUMBER` | only for `download_sales_report` |
| `APP_STORE_CONNECT_ALLOW_WRITES`  | set to `1` to expose write tools |

`apply_listing` is a write tool, so it stays hidden until `APP_STORE_CONNECT_ALLOW_WRITES=1`.
That is deliberate: installing a plugin should not silently grant it permission to overwrite a
live App Store listing.

The skill also ships an offline auditor (`scripts/audit_release.py`, stdlib Python, no network
calls) that measures every field against its limit and exits non-zero when one is over or
missing, so it can gate a release from CI.

## Notes

- **Tokens are minted locally.** Each request carries a fresh-enough ES256 JWT (`aud: appstoreconnect-v1`), cached and re-signed shortly before Apple's 20-minute cap. The `.p8` never leaves your machine.
- **Reports are TSV, not JSON.** `download_sales_report` / `download_finance_report` gunzip Apple's report and return the text (truncated to `maxLines`). Reports lag ~24–48h and are keyed by date/frequency.
- **Analytics is asynchronous.** Create a report request, wait for Apple to generate it, then list its reports.
- **`upload_screenshot` reads the file server-side.** Pass an absolute `filePath` the server can reach. Under Docker that means a path _inside_ the container — mount the folder (`-v /host/screenshots:/screenshots`) and pass the container path, or send small images inline as base64 via `fileData`.
- **Screenshots validate after upload.** Apple checks pixel dimensions asynchronously, so a wrongly-sized image fails during processing rather than at upload; the tool waits (`waitSeconds`, default 60) and reports Apple's exact reason. Timing out is not a failure — the upload already succeeded, so poll `get_screenshot` instead of retrying. The version must be editable (`PREPARE_FOR_SUBMISSION` or `DEVELOPER_REJECTED`), and a set holds at most 10 screenshots.
- **Screenshot order is explicit.** `reorder_screenshots` replaces a set's full contents, so pass every id you want to keep — an omitted one is removed from the set.

## Develop

```sh
pnpm dev            # tsdown --watch
pnpm test           # vitest (offline; no real credentials needed)
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint
pnpm format         # oxfmt --write .
```

Tests run entirely offline: JWT signing is verified against a throwaway P-256 key, and the tools are driven over an in-memory MCP transport with a mocked `fetch`.

### Publish

Options A (npx) and B (Docker) resolve only once a release is out. Pushing a `v*.*.*` tag triggers CI to:

- publish to npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC — no `NPM_TOKEN` stored anywhere) with a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements), and
- build, sign, and push the multi-arch image to `ghcr.io/mgcrea/mcp-appstore-connect`, with build provenance, an SBOM, and a [cosign](https://github.com/sigstore/cosign) keyless signature.

Both artifacts are cryptographically traceable back to the exact commit and CI run that produced them — see **Verify** below. Until a release exists, use Option C from source.

### Verify

Before trusting an artifact from Option A or B, you can check it was actually built by this repo's CI rather than published from someone's laptop:

```sh
# npm — provenance attestation (also shown as a badge on the npmjs.com package page)
npm audit signatures

# Docker — cosign keyless signature, tied to this repo's GitHub Actions identity
cosign verify \
  --certificate-identity-regexp 'https://github.com/mgcrea/mcp-appstore-connect/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/mgcrea/mcp-appstore-connect:latest
```

## License

MIT — Olivier Louvignes
