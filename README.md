# @mgcrea/mcp-appstore-connect

Model Context Protocol server for the Apple [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi) — inspect your apps, versions, builds, TestFlight, sales and users, and (opt-in) edit metadata and manage testers, straight from an MCP client like Claude.

> **Unofficial.** Not affiliated with or endorsed by Apple. It talks to Apple's public App Store Connect REST API using an API key you generate yourself.

## Features

- **Local ES256 JWT auth** — signs short-lived App Store Connect tokens from your `.p8` key with Node's built-in crypto (no `jsonwebtoken`/`jose` dependency).
- **Read by default, writes opt-in** — mutating tools are not even registered unless `APP_STORE_CONNECT_ALLOW_WRITES=1`; destructive ones additionally require `confirm: true`.
- **Broad coverage** — apps, App Store versions & localizations, builds, TestFlight groups/testers/feedback, sales & finance reports, analytics, users, bundle ids & capabilities, devices.
- **Small & typed** — two runtime deps (`@modelcontextprotocol/sdk`, `zod`), ESM, built with tsdown, linted/formatted with oxc, tested with vitest.

## Install

```sh
pnpm install
pnpm build
```

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

## Run

```sh
node dist/cli.js
```

### Wire into Claude Code

```json
{
  "mcpServers": {
    "appstore-connect": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-appstore-connect/dist/cli.js"],
      "env": {
        "APP_STORE_CONNECT_KEY_ID": "XXXXXXXXXX",
        "APP_STORE_CONNECT_ISSUER_ID": "00000000-0000-0000-0000-000000000000",
        "APP_STORE_CONNECT_P8_PATH": "/absolute/path/to/AuthKey_XXXXXXXXXX.p8"
      }
    }
  }
}
```

### Inspect the tools

```sh
npx @modelcontextprotocol/inspector node dist/cli.js
```

## Tools

**Apps** — `list_apps`, `get_app`

**Versions & metadata** — `list_versions`, `list_version_localizations`, `get_version_localization`, _`create_version`_\*, _`update_version_localization`_\* (description, keywords, what's-new, promo text)

**Builds** — `list_builds`

**TestFlight** — `list_beta_groups`, `list_beta_testers`, `list_beta_feedback`, _`invite_beta_tester`_\*, _`add_tester_to_group`_\*, _`remove_tester_from_group`_\*†

**Reports & analytics** — `download_sales_report`, `download_finance_report`, `list_analytics_reports`, _`create_analytics_report_request`_\*

**Users** — `list_users`

**Bundle IDs** — `list_bundle_ids`, `get_bundle_id`, _`create_bundle_id`_\*, _`enable_capability`_\*, _`disable_capability`_\*†

**Devices** — `list_devices`, _`register_device`_\*

_Italic\*_ tools are writes, hidden unless `APP_STORE_CONNECT_ALLOW_WRITES=1`. † additionally requires `confirm: true`.

Tool names are prefixed `app_store_connect_` (omitted above for brevity).

## Notes

- **Tokens are minted locally.** Each request carries a fresh-enough ES256 JWT (`aud: appstoreconnect-v1`), cached and re-signed shortly before Apple's 20-minute cap. The `.p8` never leaves your machine.
- **Reports are TSV, not JSON.** `download_sales_report` / `download_finance_report` gunzip Apple's report and return the text (truncated to `maxLines`). Reports lag ~24–48h and are keyed by date/frequency.
- **Analytics is asynchronous.** Create a report request, wait for Apple to generate it, then list its reports.

## Develop

```sh
pnpm dev            # tsdown --watch
pnpm test           # vitest (offline; no real credentials needed)
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint
pnpm format         # oxfmt --write .
```

Tests run entirely offline: JWT signing is verified against a throwaway P-256 key, and the tools are driven over an in-memory MCP transport with a mocked `fetch`.

## License

MIT — Olivier Louvignes
