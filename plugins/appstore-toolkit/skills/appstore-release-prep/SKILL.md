---
name: appstore-release-prep
description: Write the release documentation for an Xcode app about to be submitted to the App Store — the CHANGELOG entry for the new version, and every App Store Connect metadata field (What's New, promotional text, description, keywords, subtitle) in a fastlane/metadata/ tree, APPSTORE.md, or equivalent. Use this whenever the user is preparing, cutting, or submitting a release; asks to update the CHANGELOG or the App Store copy "with the latest features"; asks what's new since the last release or what still needs documenting; asks for release notes, store description, keywords, subtitle, or promo text; or says a field is over Apple's character limit. Reach for it even when they only mention one of the two files, or phrase it as "get this ready to ship" without naming a file — the two are two renderings of one release and drift apart when written separately. Also use it to audit a listing before submission, or when store copy reads as AI-written and needs the em dashes taken out.
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

The source is auto-detected: a `fastlane/metadata/<locale>/` tree wins, else
`APPSTORE.md`, `STORES.md` and friends. Pass `--fields-file <path>` to force a
document, or `--locale` to audit a locale other than the primary one. **Check the
source it reports** — the header says which file or directory the numbers came from.
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

It returns `{path, content}` pairs; write them as-is. The result is a
`fastlane/metadata/<locale>/` tree — one plain-text file per field — plus
`fastlane/metadata/.listing.json`, which carries the App Store Connect ids and a digest
of every field as it was at export. Commit all of it, including the sidecar.

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

Pass only the files you changed, plus `.listing.json`. Read the dry run before applying.
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

Limits, all counting spaces: subtitle 30, promo text 170, keywords 100, description
4,000, What's New 4,000. `references/appstore-fields.md` has the per-field rules —
read it before writing keywords or subtitle, which have non-obvious traps (no space
after keyword commas; plurals are stemmed; don't repeat the app name).

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

Write all of them, not just the ones that are currently empty.

In a metadata tree, each field is its own file under `fastlane/metadata/<locale>/`:
`release_notes.txt` (What's New), `promotional_text.txt`, `description.txt`,
`keywords.txt`, `subtitle.txt`, plus `name.txt` and the URL files. Write the exact copy
and nothing else — no headings, no character-count annotations, no surrounding prose.
The file content is pushed verbatim, so anything extra ships to customers. To leave a
field alone, delete its file; an empty file means "clear this field", and apply refuses
it unless you pass `allowClear: true`.

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

Also keep hardcoded prices out of copy where you can — a `$4.99` in the description is
wrong in most storefronts.

## 6. Verify, then stop

Re-run the audit. Every field must be inside its limit, none missing, no prose em
dashes. Report the final counts, because "3,905 / 4,000" tells the user something
useful that "done" does not: there is no room left for the next feature.

Say where things stand against the live listing. "Local and live now agree" and "local
is ahead, pending a push" are different states, and the user is the one who decides
when to push. If you exported a metadata tree, remind them the tree and
`.listing.json` need committing.

If the project generates its screenshots from a config, that config — not the doc —
is the source of truth for the taglines baked into the images. Changing a tagline
there means the PNGs are now stale; **say so**, since regenerating them is a separate
step the user has to run.

Do not bump versions, commit, tag, or submit. This skill writes documents; shipping
is the user's call.
