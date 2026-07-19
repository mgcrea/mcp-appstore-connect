#!/usr/bin/env python3
"""Pre-flight audit for an App Store release.

Answers the questions you cannot reliably eyeball:
  - What version are we shipping, and where is the boundary of the last release?
  - Which commits land in this release, and which shipped in the LAST one but
    were never announced?
  - Does every App Store Connect field, in every locale, fit inside Apple's
    character limits?
  - Which fields have been edited since the last export, and therefore need pushing?
  - Where is the store copy still carrying em dashes?
  - Has the screenshot config drifted from the copy that documents it?

Usage:
    python3 audit_release.py [--repo PATH] [--json]
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

# Apple's App Store Connect limits. Spaces count toward every one of these.
# Kept deliberately in lockstep with FIELD_LIMITS in src/listing/document.ts:
# apply_listing aborts the WHOLE apply if any field busts a limit, so an audit
# that measures a smaller set than the server enforces reports "clean" and then
# watches the push refuse everything.
FIELD_LIMITS = {
    "NAME": 30,
    "SUBTITLE": 30,
    "PROMOTIONAL TEXT": 170,
    "KEYWORDS": 100,
    "DESCRIPTION": 4000,
    "WHAT'S NEW": 4000,
    "MARKETING URL": 255,
    "SUPPORT URL": 255,
    "PRIVACY URL": 255,
}

# Fields whose absence is objectively broken and should fail the exit code.
# Everything else is legitimately optional: promotional text is a nice-to-have,
# the URLs are often unset, and an absent file means "leave this field alone"
# rather than "nobody wrote it" (see manifest.ts). WHAT'S NEW is required too,
# but only once there is a previous release -- Apple rejects release notes on a
# first version, so audit() drops it from this set for a 1.0.
REQUIRED_FIELDS = {"DESCRIPTION", "KEYWORDS", "SUBTITLE", "WHAT'S NEW"}

# Header aliases -> canonical field name.
FIELD_ALIASES = {
    "NAME": "NAME",
    "APP NAME": "NAME",
    "SUBTITLE": "SUBTITLE",
    "PROMOTIONAL TEXT": "PROMOTIONAL TEXT",
    "PROMO TEXT": "PROMOTIONAL TEXT",
    "KEYWORDS": "KEYWORDS",
    "DESCRIPTION": "DESCRIPTION",
    "WHAT'S NEW": "WHAT'S NEW",
    "WHATS NEW": "WHAT'S NEW",
    "WHAT'S NEW IN THIS VERSION": "WHAT'S NEW",
    "RELEASE NOTES": "WHAT'S NEW",
    "MARKETING URL": "MARKETING URL",
    "SUPPORT URL": "SUPPORT URL",
    "PRIVACY URL": "PRIVACY URL",
    "PRIVACY POLICY URL": "PRIVACY URL",
}


def char_count(s):
    """Count the way Apple counts: UTF-16 code units, not code points.

    An emoji is 2 and a CJK character is 1. Python's len() would call that emoji
    1, so a description measured here at 3,999/4,000 can be rejected by App Store
    Connect at 4,001 -- the audit passing is exactly when nobody re-checks. This
    mirrors charCount() in src/listing/document.ts, which is String.length.
    """
    return len(s.encode("utf-16-le")) // 2


def digest(s):
    """Mirror of digest() in src/listing/document.ts -- change detection, not crypto."""
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:8]

STOPWORDS = {
    "with", "from", "into", "that", "this", "when", "adds", "add", "and", "the",
    "for", "its", "their", "your", "whole", "across", "using", "over", "onto",
    "make", "made", "also", "instead", "rather", "every", "each", "them",
}

CONVENTIONAL = re.compile(r"^(feat|fix|perf|refactor|docs|chore|test|ci|build|style)(\([^)]*\))?!?:\s*(.*)$")
# Commit types that describe a user-visible change and therefore belong in
# release notes. refactor/chore/test/ci are real work but not news.
USER_FACING_TYPES = {"feat", "fix", "perf"}


def sh(args, cwd, default=""):
    try:
        out = subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return default


# --------------------------------------------------------------------------
# Version
# --------------------------------------------------------------------------

def find_pbxproj(repo):
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("build", "DerivedData", "node_modules")]
        if os.path.basename(root).endswith(".xcodeproj") and "project.pbxproj" in files:
            return os.path.join(root, "project.pbxproj")
    return None


def read_versions(repo):
    """Marketing version is the source of truth for what you are shipping.

    Do not infer the next version from the shape of the changes -- a release
    full of features can still ship as a patch if that is what the project
    decided. Read it, do not guess it.
    """
    pbx = find_pbxproj(repo)
    if not pbx:
        return {"pbxproj": None, "marketing_version": None, "build": None}
    text = open(pbx, encoding="utf-8", errors="replace").read()
    # The app target's version is usually the first one, but pbxproj ordering is
    # not guaranteed and test targets often pin 1.0. Taking [0] silently is how
    # you document a release under a test target's version number, so when the
    # file disagrees with itself, say so and let a human pick.
    mv = re.findall(r"MARKETING_VERSION\s*=\s*([^;]+);", text)
    bn = re.findall(r"CURRENT_PROJECT_VERSION\s*=\s*([^;]+);", text)
    distinct = sorted(set(v.strip() for v in mv))
    return {
        "pbxproj": os.path.relpath(pbx, repo),
        "marketing_version": mv[0].strip() if mv else None,
        "build": bn[0].strip() if bn else None,
        "all_marketing_versions": distinct,
        "ambiguous_version": len(distinct) > 1,
    }


# --------------------------------------------------------------------------
# Changelog + release boundary
# --------------------------------------------------------------------------

VERSION_HEADING = re.compile(r"^##\s*\[?([0-9]+\.[0-9]+(?:\.[0-9]+)?|Unreleased)\]?\s*(?:-\s*(\S+))?\s*$", re.I)


def parse_changelog(repo, path="CHANGELOG.md"):
    full = os.path.join(repo, path)
    if not os.path.exists(full):
        return {"exists": False, "path": path, "versions": []}
    versions = []
    for i, line in enumerate(open(full, encoding="utf-8", errors="replace"), 1):
        m = VERSION_HEADING.match(line.rstrip())
        if m:
            versions.append({"version": m.group(1), "date": m.group(2), "line": i})
    return {"exists": True, "path": path, "versions": versions}


def release_boundary(repo, changelog, version):
    """Find the commit that introduced a version's changelog heading.

    That commit is the release boundary: everything at or before it shipped in
    that release, everything after it is unreleased. This matters because a
    feature can be merged long before the release commit and still ship in it --
    the merge date tells you nothing, the boundary does.
    """
    if not version:
        return None
    for pattern in (f"## [{version}]", f"## {version}"):
        out = sh(["git", "log", "--format=%H", "-S", pattern, "--", changelog], repo)
        if out:
            return out.split("\n")[0]  # newest commit that changed this string
    return None


def commits_between(repo, since_sha, until="HEAD"):
    rng = f"{since_sha}..{until}" if since_sha else until
    raw = sh(["git", "log", "--format=%H%x1f%s", rng], repo)
    out = []
    for line in filter(None, raw.split("\n")):
        sha, _, subject = line.partition("\x1f")
        m = CONVENTIONAL.match(subject)
        ctype = m.group(1) if m else None
        out.append({
            "sha": sha[:8],
            "subject": subject,
            "type": ctype,
            "user_facing": ctype in USER_FACING_TYPES if ctype else False,
        })
    return out


def find_unannounced(repo, changelog, prev_boundary, boundary):
    """Commits that shipped in the LAST release but never made its notes.

    This is the trap. A feature merged before the release commit is in the
    shipped binary whether or not anyone wrote it down, and it silently stays
    undocumented forever -- the next release's notes only look at commits since
    the boundary, so it falls through the crack. Surface these so a human can
    decide: announce late in the upcoming notes, or backfill the old entry.
    """
    if not boundary:
        return []
    prior = commits_between(repo, prev_boundary, boundary)
    text = ""
    full = os.path.join(repo, changelog)
    if os.path.exists(full):
        text = open(full, encoding="utf-8", errors="replace").read().lower()
    suspects = []
    for c in prior:
        if not c["user_facing"]:
            continue
        # Keyword probe: pull the distinctive words out of the subject and ask how
        # many of them the changelog mentions anywhere. Score by RATIO, not by "any
        # match" -- a single incidental word ("folder") shared with an unrelated
        # entry would otherwise clear a feature that was never actually announced.
        # Tuned to over-report rather than under-report: a human confirms each one,
        # and a false positive costs a glance while a miss ships undocumented.
        m = CONVENTIONAL.match(c["subject"])
        desc = (m.group(3) if m else c["subject"]).lower()
        words = [w for w in re.findall(r"[a-z][a-z0-9-]{3,}", desc)
                 if w not in STOPWORDS]
        if not words:
            continue
        hits = [w for w in words if w in text]
        coverage = len(hits) / len(words)
        if coverage < 0.5:
            suspects.append({
                **c,
                "probe_words": words,
                "matched_in_changelog": hits,
                "coverage": round(coverage, 2),
            })
    return suspects


# --------------------------------------------------------------------------
# App Store copy
# --------------------------------------------------------------------------

# Projects name this doc whatever they like. Guessing one filename and reporting
# "every field needs writing from scratch" when the copy exists is actively
# dangerous: it invites rewriting live listing copy that was never missing.
STORE_DOC_CANDIDATES = (
    "APPSTORE.md", "APP_STORE.md", "STORES.md", "STORE.md",
    "AppStore.md", "app-store.md", "docs/APPSTORE.md", "docs/STORES.md",
)


# Conventional roots, tried in order, and ONLY when no sidecar was found -- a tree
# with a .listing.json is located by that, whatever its directory is called. So
# this list matters for hand-authored trees, which is exactly the case that must
# not fall through to the markdown-doc parser and report a full listing missing.
# fastlane/metadata stays first so a repo that really uses fastlane is unaffected.
DEFAULT_METADATA_ROOTS = ("fastlane/metadata", "Listing")
DEFAULT_METADATA_ROOT = DEFAULT_METADATA_ROOTS[0]  # the example used in messages
SIDECAR_BASENAME = ".listing.json"

# Mirrors LOCALE_PATTERN in src/listing/manifest.ts. Only needed because the
# root can now be the repo root, where "src" and "docs" sit next to "en-US".
LOCALE_DIR_RE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$")

# Directories that never hold store metadata but do hold thousands of files.
PRUNE_DIRS = {".git", "node_modules", "Pods", "build", "DerivedData", ".build",
              "vendor", ".venv", "Carthage"}


def normalize_metadata_root(raw):
    """Canonical form of a metadata root: relative, POSIX, no trailing slash.

    Mirrors normalizeMetadataRoot() in src/listing/document.ts -- change both
    together. "" means the repo root.
    """
    unix = re.sub(r"/+", "/", raw.replace("\\", "/"))
    if unix.startswith("/") or re.match(r"^[A-Za-z]:", unix):
        raise SystemExit(
            f"--metadata-root {raw!r} is absolute. Give a path relative to the repo "
            f"root, e.g. {DEFAULT_METADATA_ROOT!r}, or '.' for the repo root itself.")
    trimmed = re.sub(r"^\./", "", unix).rstrip("/")
    if trimmed in ("", "."):
        return ""
    for segment in trimmed.split("/"):
        if segment in ("", ".", ".."):
            raise SystemExit(
                f"--metadata-root {raw!r} must be a plain relative path. "
                f"Write it out in full, e.g. {DEFAULT_METADATA_ROOT!r}.")
        if segment == SIDECAR_BASENAME:
            raise SystemExit(
                f"--metadata-root {raw!r} points at {SIDECAR_BASENAME} itself. The root "
                f"is the directory that contains it, e.g. {DEFAULT_METADATA_ROOT!r}.")
    return trimmed


def find_sidecars(repo, max_depth=4):
    """Every .listing.json in the repo, repo-relative, shallowest first."""
    found = []
    for dirpath, dirnames, filenames in os.walk(repo):
        rel = os.path.relpath(dirpath, repo)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        if depth >= max_depth:
            dirnames[:] = []
        else:
            dirnames[:] = [d for d in dirnames if d not in PRUNE_DIRS]
        if SIDECAR_BASENAME in filenames:
            found.append("" if rel == "." else rel.replace(os.sep, "/"))
    return sorted(found, key=lambda p: (p.count("/"), p))


def find_metadata_root(repo, override=None):
    """Where this repo keeps its metadata tree, or None for markdown-doc mode.

    The miss rule is deliberately asymmetric. An explicit --metadata-root that
    is not there is a user error and must stop the audit: falling through would
    report "file does not exist -- every field needs writing from scratch",
    which reads as "no listing exists yet" and gets live store copy rewritten.
    An absent default is just this repo not using a tree, which is fine.
    """
    if override is not None:
        root = normalize_metadata_root(override)
        if not os.path.isdir(os.path.join(repo, root) if root else repo):
            raise SystemExit(
                f"--metadata-root {override!r} is not a directory under {repo}. "
                f"Nothing was audited. Check the path, or drop the flag to let the "
                f"tree be found from its {SIDECAR_BASENAME}.")
        return root

    sidecars = find_sidecars(repo)
    if len(sidecars) > 1:
        listed = ", ".join(f"{s}/{SIDECAR_BASENAME}" if s else SIDECAR_BASENAME
                           for s in sidecars)
        raise SystemExit(
            f"Found more than one {SIDECAR_BASENAME} ({listed}). Pass --metadata-root "
            f"to say which tree to audit.")
    if len(sidecars) == 1:
        return sidecars[0]

    # No sidecar: a hand-authored tree at a conventional path still counts. A
    # tree somewhere else with no sidecar needs the flag.
    present = [r for r in DEFAULT_METADATA_ROOTS
               if os.path.isdir(os.path.join(repo, r))]
    if len(present) > 1:
        # Never guess between them. A repo caught mid-migration has both, and
        # picking the first would audit the stale tree while the other is the one
        # being edited -- silently reporting "in sync" about the wrong files.
        raise SystemExit(
            f"Found more than one conventional metadata root ({', '.join(present)}) "
            f"and no {SIDECAR_BASENAME} to disambiguate. Pass --metadata-root to say "
            f"which tree to audit, or delete the one you no longer use.")
    if present:
        return present[0]
    return None


def under_root(root, *parts):
    """Join below a metadata root, tolerating the repo-root ("") case."""
    return "/".join([p for p in (root, *parts) if p])

# fastlane deliver's filenames -> this script's canonical field names. The
# appstore-connect MCP's export_listing writes exactly this tree, so an exported
# listing audits with no conversion step in between. Mirrors FILE_MAP in
# src/listing/document.ts.
METADATA_FILE_FIELDS = {
    "name.txt": "NAME",
    "subtitle.txt": "SUBTITLE",
    "promotional_text.txt": "PROMOTIONAL TEXT",
    "keywords.txt": "KEYWORDS",
    "description.txt": "DESCRIPTION",
    "release_notes.txt": "WHAT'S NEW",
    "marketing_url.txt": "MARKETING URL",
    "support_url.txt": "SUPPORT URL",
    "privacy_url.txt": "PRIVACY URL",
}

# Canonical name -> the key the sidecar's `baseline` uses, so a local file can be
# compared against the digest recorded at export.
SIDECAR_FIELD_KEYS = {
    "NAME": "name",
    "SUBTITLE": "subtitle",
    "PROMOTIONAL TEXT": "promotionalText",
    "KEYWORDS": "keywords",
    "DESCRIPTION": "description",
    "WHAT'S NEW": "whatsNew",
    "MARKETING URL": "marketingUrl",
    "SUPPORT URL": "supportUrl",
    "PRIVACY URL": "privacyPolicyUrl",
}

# Fields that PATCH to the appInfo resource rather than the version. They are not
# scoped to a version at all, so version state does not protect them.
APPINFO_FIELDS = {"NAME", "SUBTITLE", "PRIVACY URL"}


def read_sidecar(repo, root):
    """The export's record of what was live: ids, version state, per-field digests."""
    full = os.path.join(repo, *filter(None, [root, SIDECAR_BASENAME]))
    if not os.path.exists(full):
        return None
    try:
        with open(full, encoding="utf-8") as fh:
            return json.load(fh)
    except (ValueError, OSError):
        return None  # a broken sidecar should not stop the audit


def find_metadata_locales(repo, root, override=None):
    """Every locale directory under the metadata root, primary first.

    Auditing only one locale is a trap: export_listing writes every locale, and
    apply_listing aborts the ENTIRE apply if any one of them busts a limit. An
    audit that measures en-US alone reports clean and then the push refuses
    everything, naming a locale the user was never shown a count for.
    """
    full = os.path.join(repo, root) if root else repo
    if not os.path.isdir(full):
        return []
    locales = sorted(d for d in os.listdir(full)
                     if os.path.isdir(os.path.join(full, d))
                     and LOCALE_DIR_RE.match(d))
    if not locales:
        return []
    if override:
        return [override] if override in locales else []
    sidecar = read_sidecar(repo, root) or {}
    primary = sidecar.get("app", {}).get("primaryLocale")
    if primary not in locales:
        primary = "en-US" if "en-US" in locales else locales[0]
    return [primary] + [l for l in locales if l != primary]


def read_metadata_locale(repo, root, locale, sidecar=None):
    """
    Read the store fields from <metadata-root>/<locale>/*.txt.

    One file per field means there is nothing to parse: the file content IS the
    value. That removes the entire class of failure the heading parser below has
    to defend against -- a description whose own subheadings look like field
    boundaries, which then measures short and quietly passes a limit it busts.
    """
    base = os.path.join(repo, *filter(None, [root, locale]))
    baseline = ((sidecar or {}).get("baseline", {}) or {}).get(locale, {}) or {}
    fields, edited = {}, []
    for filename, name in METADATA_FILE_FIELDS.items():
        full = os.path.join(base, filename)
        if not os.path.exists(full):
            continue
        content = open(full, encoding="utf-8", errors="replace").read()
        # Exactly one trailing newline is written on export; strip it back off.
        if content.endswith("\n"):
            content = content[:-1]
        limit = FIELD_LIMITS[name]
        n = char_count(content)
        entry = {"chars": n, "limit": limit, "over_by": max(0, n - limit),
                 "ok": n <= limit, "text": content,
                 "file": under_root(root, locale, filename)}
        # Compare against the digest recorded at export. This is the whole
        # "which files do I pass to apply_listing" question, answered offline:
        # anything whose digest moved is an edit waiting to be pushed.
        base_digest = baseline.get(SIDECAR_FIELD_KEYS[name])
        if base_digest is not None:
            entry["changed_since_export"] = digest(content) != base_digest
            if entry["changed_since_export"]:
                edited.append(name)
        if name == "KEYWORDS":
            entry.update(keyword_checks(content))
        fields[name] = entry
    return {
        "locale": locale,
        "path": f"{under_root(root, locale)}/",
        "fields": fields,
        "missing": sorted(set(FIELD_LIMITS) - set(fields)),
        "edited_since_export": edited,
    }


def read_metadata_tree(repo, root, locales):
    sidecar = read_sidecar(repo, root)
    entries = [read_metadata_locale(repo, root, l, sidecar) for l in locales]
    return {
        "exists": True,
        "source": "metadata-dir",
        "root": root,
        "path": f"{root}/" if root else "",
        "sidecar_path": under_root(root, SIDECAR_BASENAME),
        "sidecar": sidecar_summary(sidecar),
        "locales": entries,
        # The primary locale is what the prose checks and the live diff act on;
        # every locale is still measured against the limits.
        "fields": entries[0]["fields"],
        "missing": entries[0]["missing"],
    }


def sidecar_summary(sidecar):
    """The bits of the sidecar an audit should report, chiefly the version state.

    export_listing's "latest" falls through to READY_FOR_SALE when no editable
    version exists, so the tree on disk can be the SHIPPED listing rather than the
    one being prepared -- and apply writes back to the id frozen here. Surfacing
    the state is what turns that from a silent overwrite into a decision.
    """
    if not sidecar:
        return None
    v = sidecar.get("version", {}) or {}
    return {
        "version": v.get("versionString"),
        "app_store_state": v.get("appStoreState"),
        "exported_at": sidecar.get("exportedAt"),
        "locales": sorted((sidecar.get("localizationIds") or {}).keys()),
        # Only PREPARE_FOR_SUBMISSION and the rejected states accept edits; the
        # rest mean this export is pointed at a version you should not be editing.
        "editable": v.get("appStoreState") in (
            None, "PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED",
            "METADATA_REJECTED", "REJECTED",
        ),
    }


def find_store_doc(repo, override=None):
    """Locate the store-copy doc. Explicit override wins, else first candidate present."""
    if override:
        return override
    for cand in STORE_DOC_CANDIDATES:
        if os.path.exists(os.path.join(repo, cand)):
            return cand
    return STORE_DOC_CANDIDATES[0]  # report the conventional name as missing


def parse_store_fields(repo, path=None):
    """Pull the ALL-CAPS store fields out of the metadata doc and measure them."""
    path = path or find_store_doc(repo)
    full = os.path.join(repo, path)
    if not os.path.exists(full):
        return {"exists": False, "source": "markdown-doc", "path": path,
                "sidecar": None, "fields": {}, "missing": sorted(FIELD_LIMITS),
                "locales": [{"locale": None, "path": path, "fields": {},
                             "missing": sorted(FIELD_LIMITS),
                             "edited_since_export": []}]}
    text = open(full, encoding="utf-8", errors="replace").read()

    # The store copy usually lives in a fenced block so it can be pasted verbatim,
    # but plenty of projects write it as plain markdown headings instead. Parse both:
    # a tool that reports "field missing" just because the doc is styled differently
    # is worse than no tool, because it sends you rewriting copy that already exists.
    fences = re.findall(r"```(?:txt|text)?\n(.*?)```", text, re.S)
    body = fences[0] if fences else text

    HEADING_PATTERNS = (
        r"^\s{0,3}#{1,6}\s*(.+?)\s*$",          # ## Subtitle (limit 30)
        r"^\s*\*\*(.+?)\*\*\s*:?\s*$",           # **Subtitle**
        # === SUBTITLE === / --- SUBTITLE ---, the paste-friendly banner style.
        # Without this the whole doc parses as zero fields, which reads exactly
        # like "no copy written yet".
        r"^\s*(?:={2,}|-{2,})\s*(.+?)\s*(?:={2,}|-{2,})\s*$",
        r"^([A-Z][A-Z'’\s&]{3,}?)(?:\s*\([^)]*\))?\s*$",  # SUBTITLE / SUBTITLE (limit 30)
    )
    # Use ONE heading style, not the union of all of them. A description routinely
    # contains its own ALL-CAPS section headers ("WHY DEVPULSE", "KEY FEATURES"),
    # and letting a second pattern add those as boundaries truncates the field at
    # the first one -- silently, and in the direction that looks passing (a short
    # field is never "over limit"). Pick whichever style names the most real
    # fields, and let that style alone define the boundaries.
    def marks_for(pat):
        found = []
        for m in re.finditer(pat, body, re.M):
            raw = m.group(1).strip()
            # Drop editorial annotations like "(limit 30)" or "(30 chars)".
            raw = re.sub(r"\(.*?\)", "", raw).strip()
            key = re.sub(r"[^A-Z' ]", "", raw.upper().replace("’", "'")).strip()
            found.append((FIELD_ALIASES.get(key), m.start(), m.end()))
        return found

    candidates = [marks_for(p) for p in HEADING_PATTERNS]
    marks = max(candidates, key=lambda ms: sum(1 for n, _s, _e in ms if n is not None))
    marks.sort(key=lambda t: t[1])

    fields = {}
    for i, (name, _s, end) in enumerate(marks):
        if name is None:
            continue  # unrecognized heading: still a boundary, just not a field
        stop = marks[i + 1][1] if i + 1 < len(marks) else len(body)
        content = clean_field_content(body[end:stop])
        limit = FIELD_LIMITS[name]
        n = char_count(content)
        entry = {"chars": n, "limit": limit, "over_by": max(0, n - limit), "ok": n <= limit,
                 "text": content, "file": path}
        if name == "KEYWORDS":
            entry.update(keyword_checks(content))
        # First occurrence wins; a later duplicate heading is usually a reference table.
        fields.setdefault(name, entry)

    missing = sorted(set(FIELD_LIMITS) - set(fields))
    return {
        "exists": True,
        "source": "markdown-doc",
        "path": path,
        "sidecar": None,
        "fields": fields,
        "missing": missing,
        # One doc is one locale by construction; keep the shape the tree uses so
        # the report and the exit gate have a single code path.
        "locales": [{"locale": None, "path": path, "fields": fields,
                     "missing": missing, "edited_since_export": []}],
    }


# Authors often annotate their copy with its own character count. Those annotations
# are not part of what gets pasted into App Store Connect, so counting them would
# report a field as over-limit when the real copy fits.
ANNOTATION = re.compile(
    r"^\s*("
    r"\(\s*(?:max\b[^)]*|limit\b[^)]*|\d+\s*(?:/\s*\d+)?)\s*\)"  # (max 30 characters) / (limit 30) / (30)
    r"|\d+\s*/\s*\d+(\s*chars?)?"                                  # 165 / 170
    r"|`{3,}.*"                                                    # fence
    r")\s*$", re.I)


def clean_field_content(chunk):
    lines = [l for l in chunk.strip().splitlines() if not ANNOTATION.match(l)]
    return "\n".join(lines).strip()


# --------------------------------------------------------------------------
# Live listing comparison
# --------------------------------------------------------------------------
#
# This script deliberately does not talk to App Store Connect: it gates releases,
# so it stays offline, deterministic, and usable in repos with no API credentials.
# But a file-only audit cannot see the one failure it most needs to: someone edits
# the listing in the web UI, nobody backports it, and the local doc silently drifts
# behind what customers actually read.
#
# So the caller fetches the live fields (the appstore-connect MCP's
# get_version_localization does it in one call) and hands them over as JSON. The
# comparison itself stays here, where it is testable and reproducible.

LIVE_KEY_ALIASES = {
    "description": "DESCRIPTION",
    "keywords": "KEYWORDS",
    "promotionalText": "PROMOTIONAL TEXT",
    "promotional_text": "PROMOTIONAL TEXT",
    "subtitle": "SUBTITLE",
    "name": "NAME",
    "whatsNew": "WHAT'S NEW",
    "whats_new": "WHAT'S NEW",
    "marketingUrl": "MARKETING URL",
    "supportUrl": "SUPPORT URL",
    "privacyPolicyUrl": "PRIVACY URL",
}


def normalize_live_fields(raw):
    """Accept either canonical names or the API's own camelCase keys."""
    out = {}
    for k, v in (raw or {}).items():
        if v is None:
            continue
        name = LIVE_KEY_ALIASES.get(k, LIVE_KEY_ALIASES.get(k.lower(), k.upper()))
        if name in FIELD_LIMITS:
            out[name] = str(v).strip()
    return out


def _norm(s):
    """Compare on content, not on whitespace the two sides format differently."""
    return re.sub(r"\s+", " ", (s or "")).strip()


def compare_live(local, live):
    """Measure the live fields and diff them against the local doc."""
    if live is None:
        return None
    fields, drift = {}, []
    for name, text in sorted(live.items()):
        limit = FIELD_LIMITS[name]
        n = char_count(text)
        fields[name] = {"chars": n, "limit": limit, "over_by": max(0, n - limit), "ok": n <= limit}
        local_entry = local.get("fields", {}).get(name)
        if local_entry is None:
            drift.append({"field": name, "kind": "missing-locally",
                          "detail": "live listing has copy the local doc does not"})
        elif _norm(local_entry.get("text")) != _norm(text):
            drift.append({"field": name, "kind": "differs",
                          "detail": f"local {local_entry['chars']} chars vs live {n}"})
    for name in sorted(set(local.get("fields", {})) - set(live)):
        # Absent can mean "not pushed yet" or "this endpoint does not return it"
        # (subtitle, for one, is not part of the version localization payload).
        # Don't assert a cause the data cannot support.
        drift.append({"field": name, "kind": "absent-live",
                      "detail": "not in the live payload: unpushed, or not returned by this endpoint"})
    return {"fields": fields, "drift": drift}


def keyword_checks(content):
    """The keyword field has rules that quietly waste characters if ignored."""
    notes = []
    if ", " in content:
        wasted = content.count(", ")
        notes.append(f"{wasted} space(s) after commas: each costs a character for nothing")
    terms = [t.strip() for t in content.split(",") if t.strip()]
    plurals = [t for t in terms if t.endswith("s") and not t.endswith("ss") and len(t) > 3]
    if plurals:
        notes.append(f"plural(s) {plurals}: Apple stems plurals, so the singular already matches")
    return {"terms": terms, "notes": notes}


EM_DASH = "—"
# "• Feature — description" is a label separator, not prose voice. It reads as
# formatting and is conventional in store listings, so it is not flagged.
BULLET_SEPARATOR = re.compile(r"^\s*[•\-\*]\s+[^—]{1,60}—\s")


def scan_em_dashes(repo, paths):
    """Em dashes in prose read as machine-written. Report them for rewording.

    Rewording is the point -- swapping in a hyphen keeps the same tell. The fix
    is a comma, a colon, a parenthetical, or two sentences.

    Only store copy is scanned here. The changelog gets its own advisory pass:
    it is read by developers, not customers or a reviewer, so an em dash in it is
    a style preference rather than the tell this check exists to catch. Mixing the
    two buries the lines that actually ship.

    The screenshot config is not scanned at all. Its captions are short label-like
    fragments where a dash reads as formatting, the same reason BULLET_SEPARATOR is
    exempt -- and the scan is line-based, so it cannot tell a caption from an
    internal "//" comment key anyway. Both hits were noise, and noise here costs
    more than it saves: a caption fix invalidates the goldens and forces a full
    recapture plus re-upload of an already-complete screenshot set.
    """
    hits = []
    for p in paths:
        full = os.path.join(repo, p)
        if not os.path.exists(full):
            continue
        for i, line in enumerate(open(full, encoding="utf-8", errors="replace"), 1):
            if EM_DASH not in line:
                continue
            if BULLET_SEPARATOR.match(line):
                continue
            hits.append({"file": p, "line": i, "text": line.strip()[:160]})
    return hits


def screenshot_sync(repo, config_rel, store_rel="APPSTORE.md"):
    """Taglines are baked into the shipped PNGs, so the config is the truth.

    If the doc's review table has drifted from the config, the doc is lying about
    what is actually on the store images.
    """
    cfg = os.path.join(repo, config_rel)
    store = os.path.join(repo, store_rel)
    if not (os.path.exists(cfg) and os.path.exists(store)):
        return None
    try:
        data = json.load(open(cfg, encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        return {"config": config_rel, "error": f"unreadable: {e}"}
    text = open(store, encoding="utf-8", errors="replace").read()
    screens = data.get("screens", [])
    drift, present = [], 0
    for s in screens:
        for key in ("title", "subtitle"):
            val = (s.get(key) or "").strip()
            if not val:
                continue
            if val in text:
                present += 1
            else:
                drift.append({"screen": s.get("id"), "key": key, "config_value": val})
    # If NOTHING from the config appears in the doc, the doc simply has no screenshot
    # section -- that is a gap to fill, not copy that has drifted out of sync. Calling
    # it "drift" would be noise that buries the real thing this check exists to catch:
    # a doc that has a table which no longer matches the images being shipped.
    documented = present > 0
    return {
        "config": config_rel,
        "screens": [s.get("id") for s in screens],
        "documented": documented,
        "drift": drift if documented else [],
        "undocumented": not documented,
    }


def find_screenshot_config(repo):
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
        for f in files:
            if "screenshot" in f.lower() and f.endswith(".json"):
                return os.path.relpath(os.path.join(root, f), repo)
    return None


# --------------------------------------------------------------------------

def version_key(v):
    """Sort key for a version string, so ordering does not depend on file layout."""
    return tuple(int(p) if p.isdigit() else 0 for p in v.split("."))


def audit(repo, fields_file=None, live_fields=None, locale=None, metadata_root=None):
    versions = read_versions(repo)
    cl = parse_changelog(repo)
    dated = [v for v in cl["versions"] if v["version"].lower() != "unreleased" and v["date"]]
    # Newest-first is the Keep a Changelog convention, but a project that writes
    # oldest-first would otherwise invert the release boundary silently -- and a
    # wrong boundary means documenting the wrong set of commits. Sort, don't assume.
    dated.sort(key=lambda v: version_key(v["version"]), reverse=True)
    last_released = dated[0]["version"] if dated else None
    prev_released = dated[1]["version"] if len(dated) > 1 else None

    boundary = release_boundary(repo, cl["path"], last_released)
    prev_boundary = release_boundary(repo, cl["path"], prev_released)

    shipping = versions["marketing_version"]
    already_documented = any(
        v["version"] == shipping and v["date"] for v in cl["versions"]
    ) if shipping else False

    cfg = find_screenshot_config(repo)
    # A fastlane metadata tree is unambiguous, so prefer it; an explicit
    # --fields-file still wins, and a project without the tree keeps the
    # markdown-doc parser it has always used.
    root = None if fields_file else find_metadata_root(repo, metadata_root)
    metadata_locales = [] if root is None else find_metadata_locales(repo, root, locale)
    if metadata_locales:
        store = read_metadata_tree(repo, root, metadata_locales)
        # The prose lives in several files now, so the em-dash scan takes a list.
        # Every locale is scanned: copy written by a translator drifts the same way.
        prose = [under_root(root, loc, n)
                 for loc in metadata_locales
                 for n in ("description.txt", "release_notes.txt",
                           "promotional_text.txt", "subtitle.txt")]
        # screenshot_sync wants one document to look for taglines in; the primary
        # locale's description is where a tagline would appear.
        store_doc = under_root(root, metadata_locales[0], "description.txt")
    else:
        store_doc = find_store_doc(repo, fields_file)
        store = parse_store_fields(repo, store_doc)
        prose = [store_doc]
    live = compare_live(store, normalize_live_fields(live_fields) if live_fields is not None else None)

    # Release notes are required once there is a previous release to differ from,
    # but Apple rejects a "What's New" on a first version -- so demanding one for a
    # 1.0 would gate the release on copy that must not exist.
    required = set(REQUIRED_FIELDS)
    if not last_released:
        required.discard("WHAT'S NEW")
    for entry in store["locales"]:
        entry["missing_required"] = sorted(required - set(entry["fields"]))

    return {
        "repo": repo,
        "version": {
            **versions,
            "last_documented_release": last_released,
            "shipping": shipping,
            "already_documented": already_documented,
        },
        "changelog": cl,
        "boundary": {"sha": boundary[:8] if boundary else None, "of_version": last_released},
        "commits_this_release": commits_between(repo, boundary),
        "unannounced_from_last_release": find_unannounced(repo, cl["path"], prev_boundary, boundary),
        "store": store,
        "live": live,
        "em_dashes": scan_em_dashes(repo, prose),
        "em_dashes_changelog": scan_em_dashes(repo, ["CHANGELOG.md"]),
        "screenshots": screenshot_sync(repo, cfg, store_doc) if cfg else None,
    }


def report(a):
    L = []
    v = a["version"]
    L.append("VERSION")
    L.append(f"  shipping (MARKETING_VERSION): {v['marketing_version'] or '??'}  build {v['build'] or '?'}")
    L.append(f"  last documented release:      {v['last_documented_release'] or 'none'}")
    if v.get("ambiguous_version"):
        L.append(f"  ! pbxproj holds several MARKETING_VERSIONs: {', '.join(v['all_marketing_versions'])}")
        L.append("    The first one was used. Confirm it belongs to the app target, not a test target.")
    if v["already_documented"]:
        L.append(f"  ! {v['marketing_version']} already has a dated CHANGELOG entry -- is this release already cut?")
    if v["marketing_version"] and v["marketing_version"] == v["last_documented_release"]:
        L.append("  ! pbxproj version == last released version. Bump before writing notes, or you will")
        L.append("    be documenting a release that already shipped.")
    L.append("")

    b = a["boundary"]
    L.append(f"RELEASE BOUNDARY  ({b['of_version']} -> {b['sha'] or 'not found'})")
    commits = a["commits_this_release"]
    news = [c for c in commits if c["user_facing"]]
    other = [c for c in commits if not c["user_facing"]]
    L.append(f"  {len(commits)} commit(s) since the boundary; {len(news)} user-facing")
    for c in news:
        L.append(f"    + {c['sha']}  {c['subject']}")
    for c in other:
        L.append(f"      {c['sha']}  {c['subject']}")
    L.append("")

    un = a["unannounced_from_last_release"]
    L.append("SHIPPED BUT NEVER ANNOUNCED")
    if un:
        L.append(f"  {len(un)} user-facing commit(s) were in the {b['of_version']} build but are not")
        L.append("  mentioned anywhere in the changelog. Confirm each, then decide: announce late in")
        L.append("  the upcoming notes, or backfill the old entry. Do not let them vanish.")
        for c in un:
            L.append(f"    ? {c['sha']}  {c['subject']}")
    else:
        L.append("  none detected")
    L.append("")

    s = a["store"]
    sidecar = s.get("sidecar")
    if sidecar:
        L.append(f"EXPORTED LISTING  ({s.get('sidecar_path', SIDECAR_BASENAME)})")
        L.append(f"  version {sidecar['version']}  state {sidecar['app_store_state'] or 'unknown'}"
                 f"  exported {sidecar['exported_at']}")
        if not sidecar["editable"]:
            L.append(f"  ! this export is pointed at a {sidecar['app_store_state']} version -- the SHIPPED one.")
            L.append("    export_listing's \"latest\" falls back to the live version when no editable one")
            L.append("    exists, so applying release notes here edits the release that is already out.")
            L.append("    Create the new version first (app_store_connect_create_version), then re-export.")
            L.append("    Note NAME, SUBTITLE and PRIVACY URL are appInfo-scoped and bypass version state")
            L.append("    entirely, so they are not protected even on an editable version.")
        L.append("")

    origin = "metadata tree" if s.get("source") == "metadata-dir" else "markdown doc"
    L.append(f"APP STORE FIELDS  ({s['path']} -- {origin})")
    if not s["exists"]:
        L.append("  ! file does not exist -- every field needs writing from scratch")
    for entry in s["locales"]:
        if entry["locale"]:
            L.append(f"  [{entry['locale']}]")
        for name, f in entry["fields"].items():
            flag = "OK  " if f["ok"] else "OVER"
            # A field edited since export is what you pass to apply_listing; a field
            # that never had a baseline (no sidecar, or newly created) is unknown, not
            # unchanged, so it gets no marker rather than a misleading one.
            mark = " *" if f.get("changed_since_export") else ""
            L.append(f"  {flag} {name:<18} {f['chars']:>5} / {f['limit']}"
                     + (f"  (over by {f['over_by']})" if not f["ok"] else "") + mark)
            for note in f.get("notes", []):
                L.append(f"       - {note}")
        for name in entry["missing"]:
            tag = "MISSING " if name in entry.get("missing_required", []) else "unset   "
            L.append(f"  {tag}{name:<16} (limit {FIELD_LIMITS[name]})")
        if entry["edited_since_export"]:
            files = [entry["fields"][n]["file"] for n in entry["edited_since_export"]]
            L.append("  * edited since export, pass these to apply_listing:")
            for p in files:
                L.append(f"      {p}")
    L.append("")

    live = a.get("live")
    if live is not None:
        L.append("LIVE LISTING  (App Store Connect)")
        for name, f in live["fields"].items():
            flag = "OK  " if f["ok"] else "OVER"
            L.append(f"  {flag} {name:<18} {f['chars']:>5} / {f['limit']}" + (f"  (over by {f['over_by']})" if not f["ok"] else ""))
        if live["drift"]:
            L.append("  ! local doc and live listing disagree:")
            for d in live["drift"]:
                L.append(f"      {d['field']:<18} {d['kind']}: {d['detail']}")
            L.append("  Reconcile before writing: the live text is what customers read today,")
            L.append("  and treating a stale local doc as the source overwrites copy that is live.")
        else:
            L.append("  in sync with the local doc")
        L.append("")

    em = a["em_dashes"]
    L.append("EM DASHES IN STORE PROSE")
    if em:
        L.append(f"  {len(em)} line(s). Reword them -- a hyphen is the same tell.")
        for h in em[:20]:
            L.append(f"    {h['file']}:{h['line']}  {h['text']}")
        if len(em) > 20:
            L.append(f"    ... and {len(em) - 20} more")
    else:
        L.append("  none outside bullet-label separators")
    cl_em = a.get("em_dashes_changelog") or []
    if cl_em:
        # Advisory only: the changelog is read by developers, not by customers or
        # an App Store reviewer, so this is taste rather than the machine-written tell.
        L.append(f"  ({len(cl_em)} more in CHANGELOG.md -- developer-facing, so optional)")
    L.append("")

    sc = a["screenshots"]
    if sc:
        L.append(f"SCREENSHOTS  ({sc['config']})")
        if sc.get("error"):
            L.append(f"  ! {sc['error']}")
        elif sc.get("undocumented"):
            L.append(f"  {len(sc['screens'])} screen(s) in the config, none documented in the store doc.")
            L.append("  The config is the source of truth for the taglines baked into the images;")
            L.append("  consider adding a review table so the doc stops being silent about them.")
        elif sc["drift"]:
            L.append("  ! config has copy that does not appear in the store doc (doc is stale, or the")
            L.append("    config changed and the images need regenerating):")
            for d in sc["drift"]:
                L.append(f"      {d['screen']}.{d['key']}: {d['config_value'][:80]}")
        else:
            L.append(f"  {len(sc['screens'])} screen(s), in sync with the doc")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--fields-file", default=None,
                    help="Repo-relative path to the store-copy doc. Auto-detected when omitted "
                         "(APPSTORE.md, STORES.md, ...).")
    ap.add_argument("--locale", default=None,
                    help="Narrow the audit to ONE locale under the metadata root. Every locale "
                         "is audited by default, because apply_listing refuses the whole push if "
                         "any single locale is over limit.")
    ap.add_argument("--metadata-root", default=None,
                    help="Repo-relative path to the metadata tree. Auto-detected from a "
                         ".listing.json, else fastlane/metadata or Listing; a tree elsewhere with "
                         "no sidecar needs this flag, as does a repo holding both conventional "
                         "roots. If the path given does not exist the audit "
                         "fails rather than falling back to the markdown-doc parser.")
    ap.add_argument("--live-fields", default=None,
                    help="JSON file of the LIVE App Store Connect fields, to diff against the "
                         "local doc. Accepts API keys (description, keywords, promotionalText, "
                         "subtitle, whatsNew) or canonical names. Fetch it with the "
                         "appstore-connect MCP; this script never makes network calls.")
    args = ap.parse_args()
    repo = os.path.abspath(args.repo)

    live_fields = None
    if args.live_fields:
        with open(args.live_fields, encoding="utf-8") as fh:
            live_fields = json.load(fh)
        # Tolerate a raw API response: {"data":[{"attributes":{...}}]}
        if isinstance(live_fields, dict) and "data" in live_fields:
            data = live_fields["data"]
            row = (data[0] if isinstance(data, list) and data else data) or {}
            live_fields = row.get("attributes", row)

    a = audit(repo, fields_file=args.fields_file, live_fields=live_fields, locale=args.locale,
              metadata_root=args.metadata_root)
    if args.json:
        json.dump(a, sys.stdout, indent=2)
        print()
    else:
        print(report(a))
    # Exit non-zero when something is objectively wrong, so this can gate a release.
    # Every locale counts: apply_listing refuses the whole push if any one of them
    # is over. Only genuinely required fields gate -- an unset marketing URL is a
    # choice, and failing the build over it would train people to ignore the gate.
    broken = not a["store"]["exists"] or any(
        any(not f["ok"] for f in entry["fields"].values()) or entry["missing_required"]
        for entry in a["store"]["locales"]
    )
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
