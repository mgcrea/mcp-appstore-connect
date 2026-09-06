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
2. **Destructive tools need `confirm: true`.** Deleting a screenshot, removing a tester, or submitting a version to Apple takes an explicit acknowledgement argument, so it can't happen as a side effect of some broader request. Submitting is the one that leaves your account — it is gated the same way, and refuses outright unless the version is in a submittable state with a build attached.
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
| `APP_STORE_CONNECT_VENDOR_NUMBER` | reports  | Needed by the sales/finance reports only, not by analytics.    |
| `APP_STORE_CONNECT_ALLOW_WRITES`  | no       | `1` to register the write tools. Off by default.               |
| `APP_STORE_CONNECT_MAX_RETRIES`   | no       | Retry budget for 401/429/5xx. Defaults to 3.                   |
| `APP_STORE_CONNECT_METADATA_ROOT` | no       | Where the listing tree lives. Defaults to `fastlane/metadata`. |
| `APP_STORE_CONNECT_DEBUG`         | no       | `1` to log to stderr.                                          |

See [.env.example](./.env.example) for the annotated list.

### Config file

If you'd rather not put credentials in your shell profile or in every MCP client config, the server reads a config file instead:

```jsonc
// ~/.config/appstore-connect/config.json   (chmod 600)
{
  "keyId": "XXXXXXXXXX",
  "issuerId": "00000000-0000-0000-0000-000000000000",
  "p8Path": "~/path/to/AuthKey_XXXXXXXXXX.p8",
  "allowWrites": true,
  "vendorNumber": "80000123",
  "contact": {
    "firstName": "Ada",
    "lastName": "Lovelace",
    "email": "ada@example.com",
    "phone": "+33 1 23 45 67 89",
  },
}
```

```sh
mkdir -p ~/.config/appstore-connect
$EDITOR ~/.config/appstore-connect/config.json
chmod 600 ~/.config/appstore-connect/config.json
```

With this in place an MCP client needs no `env` block at all — just `npx -y @mgcrea/mcp-appstore-connect`.

- **The environment wins, field by field.** A config file supplies whatever the environment doesn't, so Docker and CI keep working exactly as before, and a one-off `APP_STORE_CONNECT_ALLOW_WRITES=0` still overrides a file that says `true`.
- Keys are camelCase (`keyId`, not `APP_STORE_CONNECT_KEY_ID`), `~` is expanded in `p8Path`, and `p8` takes an inline PEM as the alternative to `p8Path`.
- `vendorNumber` is the better home for it than an MCP client config: it isn't a credential (it does nothing without your API key), but it is an account identifier, and `.mcp.json` files are usually tracked by git. Run `get_vendor_number` to see which layer a running server picked it up from.
- `contact` is the App Review contact — the person Apple phones or emails during review. It is the same person for every app and every version, so `set_app_store_review_detail` fills any contact field you omit from it. It only ever fills a **gap**: a value already on the record is left alone and reported back as `contactDrift`, so editing `notes` never silently rewrites a contact set in the web UI. Pass a contact field explicitly to override config for that call.
- `metadataRoot` sets where this machine's repos keep their listing tree — useful if you prefer `"AppStore"` to the fastlane default. It must be repo-relative; use `"."` for the repo root.
- **Unknown keys are an error**, not ignored — a typo'd `keyID` tells you so instead of silently falling back to the environment.
- Location: `$APP_STORE_CONNECT_CONFIG`, else `$XDG_CONFIG_HOME/appstore-connect/config.json`, else `~/.config/appstore-connect/config.json`. An absent file is fine; a malformed one is reported with its path.
- The server warns on stderr if the file is readable by other users.

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

To try it from a shell (reads the same env, or the [config file](#config-file)):

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
node dist/cli.js        # credentials from the env or the config file
```

Or wire the built entry directly: `"command": "node"`, `"args": ["/absolute/path/to/mcp-appstore-connect/dist/cli.js"]`.

### Inspect the tools

```sh
npx @modelcontextprotocol/inspector npx -y @mgcrea/mcp-appstore-connect
```

## Tools

**Apps** — `list_apps`, `get_app`, _`update_app`_\* — `update_app` carries `contentRightsDeclaration`, one of the gates below.

**Submission prerequisites** — what a **first** submission trips over. None of these lives on the version, so nothing in the version's own state hints at them, and `submit_version_for_review` fails with one error per missing item and no id to chase. Each is set once and outlives every release:

| Missing        | Apple's error                             | Fix with                                                                |
| -------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Category       | `RELATIONSHIP.REQUIRED` on `/v1/appInfos` | `list_app_categories`, _`set_app_categories`_\*                         |
| Content rights | `ATTRIBUTE.REQUIRED` on `/v1/apps`        | _`update_app`_\*                                                        |
| App price      | `STATE_ERROR.APP_PRICING_REQUIRED`        | `list_app_price_points`, `get_app_price_schedule`, _`set_app_price`_\*† |
| Review contact | `appStoreReviewDetail … was not found`    | `get_app_store_review_detail`, _`set_app_store_review_detail`_\*        |

A **free** app still needs a price: "free" is a price point, not the absence of one, so an app nobody ever charged for stays blocked until `set_app_price` points at the 0 price point.

`set_app_store_review_detail` creates or updates as needed: PATCH against a version with no detail 404s and POST against one that has it 409s, so the verb is a property of server state rather than of what you meant. Absence also arrives two ways — a 404, and a **200 with `data: null`** — and only handling the first sends a PATCH to a nonexistent id.

> **App Privacy has no public API, and is the fifth gate.** A version is refused with `STATE_ERROR.APP_DATA_USAGES_REQUIRED` until the data-collection questionnaire is answered _and published_, and there is no route to do it. Tools for it were written against Apple's documented resource names, then removed when every endpoint 404'd. The evidence, so nobody has to establish it twice:
>
> - `appDataUsages`, `appDataUsageCategories`, `appDataUsagePurposes`, `appDataUsageDataProtections` and `appDataUsageGroupings` all answer `PATH_ERROR — The resource 'v1/…' does not exist`, and `appDataUsages` is absent from the app resource's ~40 relationships.
> - **`POST` fails identically to `GET`.** A route that existed but disliked the body would answer 400 or 409; the same path error on both means it is not routed at all.
> - **Not a permissions problem** — the same key reads `/v1/users` and `/v1/apps/{id}/accessibilityDeclarations` (a comparably recent app-scoped resource) with 200.
> - `/v2/appDataUsages` and `appDataUsagesV2` are undefined types, so it is not a version-prefix issue. Note `PATH_ERROR` is a _different_ code from the `NOT_FOUND — path does not match a defined resource type` an invented name returns: Apple's gateway appears to know these names while not exposing them, which is why the docs describe resources you cannot call.
>
> Do it in the web UI: **App Privacy → Get Started**, answer, then **Publish** — saved-but-unpublished is refused exactly as unanswered is. The answers are app-scoped rather than version-scoped, so it is once per app, not once per release.

> **An app's first non-consumable IAP has no API path either**, and this one is worse because nothing fails until it is too late. Apple requires it to travel _inside_ the version's review submission (`STATE_ERROR.FIRST_NON_CONSUMABLE_MUST_BE_SUBMITTED_ON_VERSION`), and no route puts it there: `reviewSubmissionItems` rejects `inAppPurchase` and `inAppPurchaseV2` with `RELATIONSHIP.UNKNOWN`, `appStoreVersions` has no `inAppPurchases` relationship, and the IAP has no `appStoreVersion` relationship.
>
> **`submit_version_for_review` succeeds and silently leaves the IAP behind.** The version goes to review alone, the IAP stays `READY_TO_SUBMIT`, and the app ships with a paywall selling a product Apple never approved. So after submitting a release that introduces one, re-read `list_in_app_purchases`: a first IAP still reading `READY_TO_SUBMIT` means it was left out. Recovering means cancelling the submission — which returns the version to `DEVELOPER_REJECTED`, still submittable — and using the version page's **Add for Review** panel, which lists the IAP beside the version. Second and later IAPs go through `submit_in_app_purchase_for_review` normally.

> **`dryRun` stages the version, and that is the point.** Apple only adjudicates readiness when the version is added to a submission: `POST /v1/reviewSubmissionItems` answers an unready one with every missing item under `meta.associatedErrors`, and there is no cheaper way to ask. So a dry run goes that far and stops before `{"submitted": true}` — it is a preflight, not a no-op.
>
> The cost is that staging moves the version from `PREPARE_FOR_SUBMISSION` to `READY_FOR_REVIEW`, which is not a submittable state. `submit_version_for_review` therefore **resumes**: when a version is already sitting on this app's own un-submitted draft, it skips creating and adding and goes straight to submitting, reporting `resumedDraft: true`. Without that, the tool's own preflight locked it out of finishing — the draft sat with `submittedDate: null` and nothing in this server could send it, because no tool submits a submission by id.
>
> Resuming is only half of it, because the other thing `READY_FOR_REVIEW` freezes is the **build**. `set_version_build` refuses that state for attach and detach alike, so "preflight, then decide to rebuild first" had no way forward: `cancel_review_submission` cannot help either, since a draft has never been with Apple and Apple answers the PATCH `409 STATE_ERROR.ENTITY_STATE_INVALID`, _"Resource is not in cancellable state"_. **`remove_version_from_submission`** is the way back out — it `DELETE`s the draft's `reviewSubmissionItem` for that version, which drops it to `PREPARE_FOR_SUBMISSION` and unblocks `set_version_build`. It touches drafts only; a submission already with Apple is refused and redirected to `cancel_review_submission`.
>
> On the rejection branch a dry run writes **nothing at all** — no item is resolved and nothing goes back to Apple — since staging buys no diagnostic there and the next PATCH is the irreversible one.

> **After a rejection, resubmit the same submission — never cancel it.** Apple hands a rejected submission back as `UNRESOLVED_ISSUES`, which reads like a state that is still with Apple and is not: it is yours to edit again. `submit_version_for_review` detects it, `PATCH`es each `REJECTED` item with `{"resolved": true}` (the web UI's **Update review**), then `PATCH`es the submission with `{"submitted": true}` (**Resubmit to App Review**). The submission keeps its queue position, and every item that was _not_ rejected goes back untouched — which matters most for a first non-consumable IAP riding inside it, since that one is often already `IN_REVIEW` while the version was being rejected.
>
> Cancelling instead is unrecoverable in a way that costs real days: the queue position is gone, and the IAP is dragged back out of review to start over. The failure to recognise looks like this — attempting to open a _new_ submission alongside the returned one 409s, and the error blames the version while never mentioning the submission that actually holds it:
>
> ```
> STATE_ERROR.ENTITY_STATE_INVALID: appStoreVersions with id '…' is not in valid state.
> STATE_ERROR: Version is not ready to be submitted yet, please try again later.
> ```
>
> "Try again later" is misdirection: waiting never clears it, because nothing is in progress.

**Listing round-trip** — `export_listing`, _`apply_listing`_\* — pull the whole listing into a git-committable metadata tree, edit it locally, push it back. See [Listing round-trip](#listing-round-trip).

**Versions & metadata** — `list_versions`, `get_version` (resolves the attached build — which binary the version would actually ship, and when it was uploaded), `list_version_localizations`, `get_version_localization`, _`create_version`_\*, _`update_version`_\* (release type — auto on approval, manual, or scheduled), _`update_version_localization`_\* (description, keywords, what's-new, promo text)

**Review submissions** — `list_review_submissions`, _`submit_version_for_review`_\*†, _`cancel_review_submission`_\*†, _`remove_version_from_submission`_\*† — hand a finished version to Apple for review, withdraw one already with Apple, or take a version back off an un-submitted draft so its build can be changed again

**Release** — _`release_version`_\*† — release an approved version sitting in `PENDING_DEVELOPER_RELEASE` (the manual "Release This Version" button)

**App info** — `list_app_infos`, `list_app_info_localizations`, `get_app_info_localization`, _`update_app_info_localization`_\* (name, subtitle, privacy policy — the fields that outlive a version)

**Age rating** — `get_age_rating_declaration`, _`update_age_rating_declaration`_\* — the questionnaire answers behind the rating, one per appInfo rather than per version. `socialMedia` must be answered from September 2026 before Apple accepts a new version, an update, or a notarization request.

**In-app purchases** — `list_in_app_purchases`, `get_in_app_purchase`, `list_iap_price_points`, `get_iap_price_schedule`, _`set_in_app_purchase_price`_\*†, _`update_in_app_purchase`_\* — read the price-point catalogue for a territory, then price the IAP against one. `update_in_app_purchase` carries the reference name, the review note and `familySharable`. One-time purchases only; auto-renewable subscriptions are not covered.

**In-app purchase metadata** — `list_iap_localizations`, `get_iap_review_screenshot`, `get_iap_availability`, _`create_iap_localization`_\*, _`update_iap_localization`_\*, _`delete_iap_localization`_\*†, _`upload_iap_review_screenshot`_\*†, _`set_iap_availability`_\*, _`submit_in_app_purchase_for_review`_\*† — an IAP sits at `MISSING_METADATA`, and cannot be submitted, until **four** things exist: a per-locale display name, a description, a review screenshot, and territory availability. Availability is the one people miss, because the App Store Connect UI fills it in silently and the API does not — `set_iap_availability` defaults to every territory Apple offers. These are the customer-facing strings on the purchase sheet, not the app's own listing, and the limits are much tighter — **30** characters for the name and **45** for the description, checked locally because Apple answers an over-length value with a 409 that names neither the field nor the limit. `submit_in_app_purchase_for_review` refuses anything not already `READY_TO_SUBMIT` rather than forwarding a rejection.

**Screenshots** — `list_screenshot_sets`, `list_screenshots`, `get_screenshot`, _`upload_screenshot`_\*, _`delete_screenshot`_\*†, _`delete_screenshot_set`_\*†, _`reorder_screenshots`_\*†

**Builds** — `list_builds` — every binary uploaded for an app, with its `minOsVersion`. **`VALID` means Apple finished processing it, not that it is on the App Store.** The newest `VALID` build is normally a TestFlight or in-review binary, so an OS floor or deployment target read off it is wrong in the direction that looks right — it describes what you are about to ship, not what customers are running. The live binary is the one _attached_ to the `READY_FOR_SALE` version, often several builds older; `get_version` resolves it.

**TestFlight** — `list_beta_groups`, `list_beta_testers`, `list_beta_feedback`, _`create_beta_group`_\*, _`invite_beta_tester`_\*, _`add_tester_to_group`_\*, _`remove_tester_from_group`_\*† — an app with no group has nowhere to send a build, so `create_beta_group` is the first step of setting TestFlight up; every other tool here needs the group id it returns. Internal groups take testers who are already Users on the account and skip Beta App Review, so `hasAccessToAllBuilds` is the quickest way to make builds you have already uploaded installable.

**Sales & finance reports** — `get_vendor_number`, `download_sales_report`, `download_finance_report` — the Sales and Trends TSVs: units, proceeds, installs by territory and install type. Needs a vendor number; `get_vendor_number` reports the configured one, which layer it came from, and whether Apple accepts it. The sales report is account-wide and Apple offers no per-app filter, so pass `appleIdentifier` or `sku` to have the server apply one after download — it runs before `maxLines`, so truncation counts the app you asked about rather than an arbitrary slice of the portfolio, and the dropped row count comes back with it. **An in-app purchase row does not carry its app's Apple Identifier** — it carries the IAP's own, and names the app only in `Parent Identifier`, as the SKU. Filtering on the app id alone therefore returns a clean, plausible report showing no in-app revenue at all, so the server matches those rows through `Parent Identifier` too and says how many it found; `includeInAppPurchases: false` opts out and reports what that cost. **`download_finance_report` takes a _fiscal_ period, not a calendar one:** Apple's fiscal year opens in late September and its months are 4-4-5 weeks, so `2026-07` is fiscal month 7 of FY2026 — roughly late March to early May. Getting this wrong is silent, because a well-formed report comes back either way, so the response carries a `coverage` block with the start and end dates the report actually covers. Check it before quoting any figure.

**Analytics** — `get_analytics_status`, `list_analytics_report_requests`, `list_analytics_reports`, `list_analytics_report_instances`, `list_analytics_report_segments`, `download_analytics_report_segment`, _`create_analytics_report_request`_\* — App Analytics proper: impressions, product page views, conversion rate, installs, deletions, sessions, retention. `get_analytics_status` walks the whole chain in one call and answers "is there any data yet, and how far back does it go" — reach for it before the four-step walk, especially just after enabling analytics, since reports exist as soon as Apple registers them but hold nothing until instances appear a day or two later. See [Reading analytics](#reading-analytics).

**Customer reviews** — `list_customer_reviews` — star rating, title, body, territory and date, newest first; filter by rating to read just the complaints. These are **written** reviews only. Most people rate without writing, and Apple exposes no aggregate star average here, so a distribution computed from these is directional — it is not the App Store rating.

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

**The location is a default, not a requirement.** Keep the tree wherever you like — set
`APP_STORE_CONNECT_METADATA_ROOT` (or `metadataRoot` in the config file) to change it for
every repo on the machine, or pass `metadataRoot` to a single `export_listing` call. The
fastlane path is the default only because it's the one other tools already read.
`apply_listing` needs no such setting: it finds the tree from wherever you pass
`.listing.json`, so a tree you move later keeps working.

The server writes to disk only where you point it. `export_listing` hands back
`{path, content}` pairs and your agent writes them, so listing writes stay under your own
permission prompt. The three report downloads take an optional `savePath`, because the
alternative — retyping a TSV out of a tool result — loses rows silently, and a report
missing a row still totals to a plausible number. A saved file always holds the report in
full; `maxLines` then only trims the copy inlined in the response. Under Docker the path
must resolve inside the container, so mount the folder and pass the container path.

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
  ids and the per-field digests recorded at export, and its directory is what tells the
  server where the tree lives. Every file you pass must sit under that same directory;
  mixing two trees is an error rather than a silent push against the wrong ids.
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
- If the metadata tree already exists, diff before overwriting it.

## Reading analytics

App Analytics is not a single endpoint. Apple generates the reports asynchronously and
files them behind four nested resources, so reaching an actual number is a walk:

```
analyticsReportRequest   one per app, created once, then reused forever
  └─ report              a named dataset, e.g. "App Store Installation and Deletion"
       └─ instance       one per granularity (DAILY/WEEKLY/MONTHLY) and processing date
            └─ segment   the gzipped CSV that holds the rows
```

`get_analytics_status` collapses the whole walk into one call — request, report and instance
counts plus the earliest instance date — and is the right first move when the question is
simply whether there is any data yet. The four hops below are for reaching the numbers
themselves.

One tool per hop, in order:

1. `create_analytics_report_request` — **once per app**, and only if there isn't one
   already. Apple rejects a second `ONGOING` request, so run
   `list_analytics_report_requests` first and reuse the id it returns. **Create both access
   types.** `ONE_TIME_SNAPSHOT` is the only way to obtain history — it covers roughly the
   last 52 weeks as of when it is created, and that window rolls forward, so history no
   snapshot captured is gone permanently and no later request can recover it. `ONGOING`
   collects from now on and backfills nothing. Creating only `ONGOING` therefore forfeits
   the app's entire past, and the loss is invisible: next month looks healthy because it has
   data, while the year before it no longer exists.
2. `list_analytics_reports` — filter by `category`: `APP_STORE_ENGAGEMENT` for impressions,
   product page views and conversion rate; `APP_USAGE` for installs, deletions, sessions and
   retention; `COMMERCE` for sales and proceeds.
3. `list_analytics_report_instances` — filter by `granularity`, then pick a `processingDate`.
   There is one instance per date, so an unfiltered list is mostly noise.
4. `download_analytics_report_segment` — returns the rows as text, truncated to `maxLines`.

Notes worth knowing before the first run:

- **Nothing exists for a day or two after the request.** An empty report list is the
  expected answer immediately after `create_analytics_report_request`, not a failure.
- **The download resolves its own segment URL.** Those URLs are signed, off the API host,
  and expire within minutes, so `download_analytics_report_segment` takes an `instanceId`
  and re-lists the segments itself. Nothing has to carry a URL between calls.
- **A big instance is refused, not streamed.** The segment is decompressed in the server
  process, so anything over 25 MiB compressed fails with its size; raise `maxBytes` to
  override, or pick a `DAILY` instance instead of `MONTHLY`.
- **Segments are plural.** A large report splits across several; `list_analytics_report_segments`
  shows how many, and `segmentIndex` selects one.

This is a different pipeline from `download_sales_report` — that one is Sales and Trends,
keyed by vendor number and date rather than by report request, and it is the better source
for units and proceeds. Analytics is where the funnel metrics live.

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

The plugin ships the skills only — it does not bundle the MCP server. Install the server
yourself with any of the options under [Quick start](#quick-start); the skills call it by
tool name and do not care how it was launched. The plugin stores **no credentials of its
own** — set up the [config file](#config-file) once and the server finds them wherever you
work.

`apply_listing` is a write tool, so it stays hidden until writes are enabled
(`"allowWrites": true` in the config file, or `APP_STORE_CONNECT_ALLOW_WRITES=1`). That is
deliberate: installing a plugin should not silently grant it permission to overwrite a live
App Store listing.

The skill also ships an offline auditor (`scripts/audit_release.py`, stdlib Python, no network
calls) that measures every field against its limit and exits non-zero when one is over or
missing, so it can gate a release from CI.

## Notes

- **Tokens are minted locally.** Each request carries a fresh-enough ES256 JWT (`aud: appstoreconnect-v1`), cached and re-signed shortly before Apple's 20-minute cap. The `.p8` never leaves your machine.
- **Reports are TSV, not JSON.** `download_sales_report` / `download_finance_report` gunzip Apple's report and return the text (truncated to `maxLines`). Reports lag ~24–48h and are keyed by date/frequency.
- **A vendor number cannot be looked up over the API.** There is no vendor resource anywhere in the App Store Connect API, so `get_vendor_number` verifies the configured value rather than discovering one. Find yours under Payments and Financial Reports in App Store Connect, or read it out of the middle field of a report you already downloaded — Apple names them `S_<frequency>_<vendorNumber>_<date>.txt`. Apple also has no "unknown vendor" error: a number this key cannot read comes back as a bare HTTP 500, which is why a wrong one looks like an outage. Analytics reports need no vendor number at all.
- **Finance reports are keyed by fiscal month, not calendar month.** Apple's fiscal year opens in late September and its months run 4-4-5 weeks, so `reportDate: "2026-07"` returns fiscal month 7 of FY2026 — roughly 29 March to 2 May 2026. Nothing rejects a calendar month, because every well-formed period is a valid request, so the mistake surfaces as a plausible report for a period you did not choose. `download_finance_report` returns a `coverage` block with the real start and end dates read out of the report body; read it before quoting a number. Sales reports are unaffected — those are keyed by ordinary calendar dates.
- **Analytics is asynchronous and nested.** Create the report request once, wait a day or two for Apple to generate it, then walk request → report → instance → segment to reach the rows — or call `get_analytics_status` to check whether there is anything to walk. See [Reading analytics](#reading-analytics).
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
