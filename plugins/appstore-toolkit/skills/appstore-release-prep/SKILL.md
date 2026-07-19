---
name: appstore-release-prep
description: Write the release documentation for an Xcode app about to be submitted to the App Store — the CHANGELOG entry for the new version, and every App Store Connect metadata field (What's New, promotional text, description, keywords, subtitle) in a Listing/ or fastlane/metadata/ tree, APPSTORE.md, or equivalent. Use this whenever the user is preparing, cutting, or submitting a release; asks to update the CHANGELOG or the App Store copy "with the latest features"; asks what's new since the last release or what still needs documenting; asks for release notes, store description, keywords, subtitle, or promo text; or says a field is over Apple's character limit. Reach for it even when they only mention one of the two files, or phrase it as "get this ready to ship" without naming a file — the two are two renderings of one release and drift apart when written separately. Also use it to audit a listing before submission, or when store copy reads as AI-written and needs the em dashes taken out. It also covers the shipping step itself when the user explicitly asks for it — archiving and uploading a build with App Store Connect API credentials, attaching it to the version, submitting for review, and repricing an in-app purchase — including why a build number in a commit message is not an uploaded build.
---

# App Store release prep

Turn "what changed since the last release" into two documents that stay in sync: a
**CHANGELOG entry** (for developers, complete) and the **App Store Connect fields**
(for customers, ruthlessly short and hard-limited).

The failure modes here are boring and specific, and they are why this skill exists:
people guess the version, miss features that shipped without ever being written
down, and blow a 4,000-character limit they never measured. Run the audit first —
it answers all three deterministically — then spend your judgment on the copy.

## 1. Audit before writing anything

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/audit_release.py --repo <repo>   # add --json for machine output
```

It reports: the shipping version and the last documented one, the release boundary
commit and everything since it, commits that shipped in the _last_ release but were
never announced, every store field measured against Apple's limit, em dashes in
prose, and screenshot-config drift. It exits non-zero if a field is over or missing,
so it can gate a release.

The source is auto-detected: a metadata tree wins, else `APPSTORE.md`, `STORES.md`
and friends. The tree is found from its `.listing.json` wherever that sits, falling
back to `fastlane/metadata/` or `Listing/`; pass `--metadata-root <path>` for a tree
that was moved and has no sidecar, or when the repo holds more than one. Pass `--fields-file <path>`
to force a document, or `--locale` to audit a locale other than the primary one.
**Check the source it reports** — the header says which file or directory the numbers
came from.
If it reports "file does not exist" for a project that plainly has store copy, you
pointed it at the wrong place; do not take that as license to write every field from
scratch, or you will replace live copy with a rewrite nobody asked for.

### Pull the live listing first when an App Store Connect MCP is available

The script never makes network calls: it gates releases, so it stays offline and
deterministic. That leaves one failure it structurally cannot see — someone edits the
listing in App Store Connect's web UI, nobody backports it, and the local copy quietly
falls behind what customers are reading. **The local files are the draft; the live
listing is what shipped. Neither is automatically right.**

With `@mgcrea/mcp-appstore-connect`, pull the whole listing into the repo:

```
app_store_connect_export_listing { appId }        # version defaults to "latest"
```

It returns `{path, content}` pairs; write them as-is, at the paths it gives you. The
result is a `<root>/<locale>/` tree — one plain-text file per field, for **every** locale —
plus `<root>/.listing.json`, which carries the App Store Connect ids and a digest of every
field as it was at export. Commit all of it, including the sidecar. The root is
`fastlane/metadata/` unless this server or repo is configured otherwise (`Listing/` is the
other convention the audit knows), so read the paths returned to you rather than assuming
them; `apply_listing` later locates the tree from wherever the sidecar
sits, so never move the sidecar out of its tree.

**Check which version you just exported.** `latest` does not mean "the one being
prepared" — it means the highest-precedence version that exists, and when no editable
version exists yet it falls back to the one that is **already on sale**. The audit reads
`version.appStoreState` out of the sidecar and says so:

```
! this export is pointed at a READY_FOR_SALE version -- the SHIPPED one.
```

That is the state you are in whenever the new version has not been created in App Store
Connect yet, which is the normal state when you are about to submit. Writing release notes
into that tree and applying them edits the release that already shipped. Create the version
first (`app_store_connect_create_version`), then re-export, and the tree points at the
right one. Two things make this worth checking rather than assuming: nothing in
`apply_listing` inspects version state, so the dry run reports the write as a normal
change; and `name`, `subtitle` and `privacy_url` are appInfo-scoped rather than
version-scoped, so they are never protected by version state at all.

Then `audit_release.py` reads that tree directly, so "what is live" and "what the audit
measures" are the same bytes. Working this way removes the whole class of drift the
`--live-fields` diff existed to catch, and it also fixes a subtler measurement bug: in a
single markdown doc, a description containing its own `## Keywords` or `KEY FEATURES`
heading gets truncated at that line, so the field measures short and passes a limit it
actually busts. One file per field has no boundaries to get wrong.

If the project has no metadata tree, the audit falls back to `APPSTORE.md` and friends,
and you can still diff against live the old way:

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/audit_release.py --repo <repo> --live-fields live.json
```

`--live-fields` accepts a raw `{"data":[{"attributes":{…}}]}` from
`list_version_localizations`, or the document from `export_listing --format json` (which
additionally covers subtitle, a field the version-localization endpoint does not return).
The `LIVE LISTING` section then names every field where local and live disagree.
Reconcile before writing: pull anything live-only back into the local copy first, then
edit on top.

### Push the edits back

Once the copy is written and the audit is clean:

```
app_store_connect_apply_listing { files: [...] }                        # dry run
app_store_connect_apply_listing { files: [...], dryRun: false, confirm: true }
```

`apply_listing` is a write tool, so it only exists when the server was started with
`APP_STORE_CONNECT_ALLOW_WRITES=1`. If you cannot see it, that is the reason — say so and let
the user opt in, rather than reporting the push as failed.

Pass only the files you changed, plus `.listing.json`. You do not have to remember which
those were: the audit compares each file against the digest recorded at export and prints
the list under `* edited since export, pass these to apply_listing`.

Read the dry run before applying.
Fields reported as **conflict** were edited in App Store Connect since your export — do
not `force` past them without asking the user; re-export and merge instead. Fields
reported as **blocked** are empty files that would clear live copy; confirm that is
intended before passing `allowClear`. Pushing is
still the user's call, so ask before the non-dry run.

Read the whole report before you write. Three of its findings change what you do:

**The version is read, not inferred.** It comes from `MARKETING_VERSION` in the
pbxproj. A release full of features can still ship as a patch if that is what the
project decided — don't apply semver reflexes to someone else's versioning. If the
pbxproj version already has a dated changelog entry, that release is _already cut_:
stop and ask whether to bump first, rather than documenting a shipped release.

**The release boundary is a commit, not a date.** Everything at or before the commit
that introduced the last version's changelog heading shipped in that release;
everything after it is what you are documenting now. Merge dates tell you nothing —
a feature can be merged weeks early and still ship in the release that follows.

**Features can ship without ever being announced.** A commit merged before the
release boundary is in that shipped binary whether or not anyone wrote it down, and
it then falls through the crack forever, because the next release only looks at
commits _since_ the boundary. The audit flags these. They are real: confirm each
against the diff, then ask the user which they want — announce it late in the
upcoming notes (usually right: customers have never been told), or backfill the old
entry (accurate history, but nobody rereads old notes). Do not silently drop them,
and do not silently move released work between versions.

## 2. Budget the character count _before_ writing

A mature description sits at 3,700–3,900 of its 4,000. Adding a feature therefore
means **removing** something. Take the current count from the audit, subtract from
the limit, and know what you are shopping with. Writing first and measuring after is
how you end up 1,300 over and hacking good sentences apart to claw it back.

Limits, all counting spaces: name 30, subtitle 30, promo text 170, keywords 100,
description 4,000, What's New 4,000, and 255 for each of the three URLs.
`references/appstore-fields.md` has the per-field rules — read it before writing keywords
or subtitle, which have non-obvious traps (no space after keyword commas; plurals are
stemmed; don't repeat the app name).

Two things about the counting. Apple counts **UTF-16 code units**, so an emoji costs 2 and
a CJK character costs 1 — never eyeball a field that has emoji in it. And the budget is
per **locale**: the audit measures every locale in the tree because `apply_listing` refuses
the entire push if any single one is over, so a French description nobody looked at will
block the English one you did.

When the description is over budget, tighten the _whole_ listing rather than
mutilating only the new paragraph — merging two thin bullets or cutting a hedge
usually buys more than butchering the feature you just added.

## 3. Write the CHANGELOG entry

Match the file's existing conventions rather than importing your own; read the last
two entries first. Most projects use Keep a Changelog (`## [1.4.0] - YYYY-MM-DD`,
then `### Added` / `### Changed` / `### Fixed`), and many keep a project-specific
block — a fenced `### App Store release notes` section, an `### Internal` section —
that you should populate too, not skip.

Group by what the change _does for a user_, not by commit. Several commits routinely
collapse into one entry, and a `refactor:` that no user can perceive belongs in an
internal section or nowhere. Say what the feature is _for_, not what the diff did:
the reason a check exists is more useful than the fact that it exists.

## 4. Fill every App Store field

Write all of them, not just the ones that are currently empty — but "all" means the fields
the release actually needs. `promotional_text.txt` and the URL files are genuinely
optional, and a **first** version must not carry release notes at all (Apple rejects a
What's New on 1.0). The audit distinguishes these: `MISSING` gates the release, `unset` is
just telling you the field is empty.

In a metadata tree, each field is its own file under `<root>/<locale>/` (the audit
header tells you the root; `fastlane/metadata/` or `Listing/` by default):
`release_notes.txt` (What's New), `promotional_text.txt`, `description.txt`,
`keywords.txt`, `subtitle.txt`, `name.txt`, and `marketing_url.txt` /
`support_url.txt` / `privacy_url.txt`. Write the exact copy
and nothing else — no headings, no character-count annotations, no surrounding prose.
The file content is pushed verbatim, so anything extra ships to customers. To leave a
field alone, delete its file; an empty file means "clear this field", and apply refuses
it unless you pass `allowClear: true`.

If the tree has more than one locale, the release notes you just wrote apply to all of
them, and the other locales are still carrying the _previous_ version's copy. You cannot
translate them yourself to a standard worth shipping — say which locales are now stale and
let the user decide, rather than leaving it silent or machine-translating it.

In a single markdown doc, order the sections as App Store Connect does — What's New,
promotional text, description, keywords, subtitle — so it can be pasted top to bottom.

- **What's New** — lead with the single headline change; customers skim one line and
  stop. Short bulleted tail for the rest. It is not the changelog.
- **Promotional text** — the _only_ field editable without a new submission. Spend it
  on what is true right now (the newest feature), not an evergreen restatement of the
  pitch.
- **Description** — for a human deciding whether to tap Get. Not indexed, so stuffing
  keywords into it is wasted.
- **Keywords** — 100 chars, comma separated, no space after commas, singular only.
  Competitor trademarks are a genuine review risk and a genuine traffic win; that
  tradeoff is the user's call, so ask rather than deciding for them.
- **Subtitle** — 30 chars, heavily indexed. Add searchable words the name doesn't
  already have.

## 5. Don't write like a machine

Store copy is read by customers and by a reviewer. The tell that reads as
machine-written is the **em dash in prose** — the audit lists every one. Reword them;
swapping in a hyphen keeps the same tell. A comma, a colon, a parenthetical, or two
sentences all work, and the sentence usually gets better:

- `preview objects — from a fast interface` → `preview objects from a fast interface`
- `never runs them — it is sandboxed — so they are` → `never runs them: it is sandboxed, so they are`
- `Pay once — no subscription — and Pro unlocks` → `Pay once, with no subscription, and Pro unlocks`

An em dash used as a **bullet label separator** (`• Object Browser — Navigate your
buckets…`) is formatting, not voice, and is conventional in store listings. The audit
does not flag those; leave them unless the user asks otherwise.

**Screenshot captions are exempt too**, and the audit no longer scans the screenshot
config. They are short label-like fragments where a dash reads as formatting, and the
cost of "fixing" one is out of all proportion: it invalidates the goldens and forces a
full recapture plus a re-upload of a screenshot set that was already complete. The
check exists to catch machine-sounding _prose_ — description, release notes, promo
text, subtitle. Hold that line there.

Also keep hardcoded prices out of copy where you can — a `$4.99` in the description is
wrong in most storefronts.

## 6. Verify, then stop

Re-run the audit. Every field in every locale must be inside its limit, nothing `MISSING`,
no prose em dashes. Report the final counts, because "3,905 / 4,000" tells the user
something useful that "done" does not: there is no room left for the next feature.

Say where things stand against the live listing. "Local and live now agree" and "local
is ahead, pending a push" are different states, and the user is the one who decides
when to push. If you exported a metadata tree, remind them the tree and
`.listing.json` need committing.

If the project generates its screenshots from a config, that config — not the doc —
is the source of truth for the taglines baked into the images. Changing a tagline
there means the PNGs are now stale; **say so**, since regenerating them is a separate
step the user has to run. The `xcode-screenshot-pipeline` skill covers actually
regenerating them, and `app_store_connect_list_screenshot_sets` will tell you whether the
version has a complete set — an incomplete one blocks submission, and nothing in this
audit can see it.

Do not bump versions, commit, tag, or submit **on your own initiative**. This skill
writes documents; shipping is the user's call. When they do ask you to ship it, section 7
is the path.

## 7. Cutting the build and submitting — only when asked

Everything above is reversible. This section is not: it uploads a binary and hands a
version to Apple. Do it only on an explicit "submit it" / "ship it", never as the natural
next step after the copy is clean.

### Check a build actually exists before promising anything

```
app_store_connect_list_builds { appId, limit: 5 }
```

**A build number in a commit message or in `CURRENT_PROJECT_VERSION` is not a build.**
A repo can carry `chore: bump version to 1.4.1 (build 99)`, have `CURRENT_PROJECT_VERSION
= 99` in the pbxproj, and have nothing newer than build 92 on App Store Connect, because
nobody ran the archive. `list_builds` is the only source of truth. Check it before you
tell anyone submission is one call away.

### The binary has to match the metadata you just pushed

A build that predates today's UI work will contradict the screenshots you uploaded for
the same version. If a screenshot shows a price-free "Unlock Pro" button and the newest
uploaded build still contains a `?? "$4.99"` fallback, submitting that build ships a
binary its own store page misrepresents. After archiving, check the artifact rather than
trusting the diff:

```bash
BIN=build/App.xcarchive/Products/Applications/App.app/Contents/MacOS/App
strings "$BIN" | grep -c 'Unlock Pro'   # the new string is in
strings "$BIN" | grep '4\.99'           # the old one is gone (expect no output)
```

### Credentials

An ASC API key is usually already on the machine, in one of two places:

- `~/.config/appstore-connect/config.json` — `{keyId, issuerId, p8Path}`
- the MCP server's own env in `.mcp.json` — `APP_STORE_CONNECT_KEY_ID`,
  `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_P8_PATH`

The MCP holds those internally and exposes no upload-build tool, so uploading is a shell
job with `altool`. `altool` does **not** take a path to the key: it takes the key id and
searches `./private_keys`, `~/private_keys`, `~/.private_keys`, and
`~/.appstoreconnect/private_keys`. A key stored anywhere else has to be copied into one of
those first. **Say that you copied a private key, and offer to remove the copy afterwards**
— duplicating a credential is a side effect the user did not ask for, even when it is the
only way the tool works.

### Archive, export, validate, upload

```bash
xcodebuild -project App.xcodeproj -scheme App -configuration Release \
  -destination 'platform=macOS' -archivePath build/App.xcarchive archive

xcodebuild -exportArchive -archivePath build/App.xcarchive \
  -exportOptionsPlist exportOptions.plist -exportPath build/export

xcrun altool --validate-app -f build/export/App.pkg -t macos \
  --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>          # do this first, it is free
xcrun altool --upload-app  -f build/export/App.pkg -t macos \
  --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
```

`exportOptions.plist` needs `method = app-store-connect` (older Xcode called it
`app-store`), the `teamID`, and `manageAppVersionAndBuildNumber = false` — leave that true
and Xcode silently renumbers the build out from under you.

Always `--validate-app` before `--upload-app`. It catches signing, entitlement, and
Info.plist problems in seconds, against a failed upload that costs a full round trip.

### Attach and submit

Apple does not register the build immediately — `list_builds` returns nothing for a few
minutes after `UPLOAD SUCCEEDED`. Poll on a timer rather than in a tight loop, and wait
for `processingState: VALID`.

```
app_store_connect_set_version_build         { versionId, buildId }
app_store_connect_submit_version_for_review { versionId, confirm: true }
```

The version must be `PREPARE_FOR_SUBMISSION` or `DEVELOPER_REJECTED`, and the build must
be `VALID`, unexpired, and carry the same version string. Everything Apple requires —
screenshots, age rating, export compliance, review details — must already be in place;
`submit_version_for_review` fails rather than telling you which one is missing.

Approval is not release. A version created with `releaseType: MANUAL` sits in
`PENDING_DEVELOPER_RELEASE` until someone releases it, which is usually what you want:
it keeps the release moment under the user's control.

### Release

```
app_store_connect_release_version { versionId, confirm: true }
```

Only for a version already in `PENDING_DEVELOPER_RELEASE` — `AFTER_APPROVAL` and
`SCHEDULED` versions release themselves, and there is nothing to press. The state flips to
`READY_FOR_SALE` a moment after the request, so re-read it with `list_versions` rather than
trusting the response.

**Ask before releasing, every time.** The whole point of `MANUAL` is that a human picks the
moment, so a release the user did not ask for in this turn overrides the choice they already
made. It is also effectively irreversible: pulling a released version means removing the app
from sale.

### Submitting from a dirty tree

If the changes going into the binary are uncommitted, **say so before submitting**. A
shipped build that corresponds to no commit cannot be reproduced or bisected later, and
many repos have a `Scripts/releaseVersion.sh`-style helper that commits and tags. Offer it;
do not run it unprompted.

### If the release also changes price

IAP repricing is `app_store_connect_set_in_app_purchase_price`, and it **replaces the whole
price schedule** — read `get_iap_price_schedule` first so you know what you are dropping.
Price points are per-territory ids from `list_iap_price_points`; every other territory is
derived from the base one.

The trap is ordering, not mechanics. If any live screenshot has a price baked into the
image, repricing before the new build is **released** makes the store page advertise one
price and charge another, for the whole review period. Reprice after the new version is
live, and hold any website price edits until the same moment.
