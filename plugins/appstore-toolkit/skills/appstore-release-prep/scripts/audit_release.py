#!/usr/bin/env python3
"""Pre-flight audit for an App Store release.

Answers the questions you cannot reliably eyeball:
  - What version are we shipping, and where is the boundary of the last release?
  - Which commits land in this release, and which shipped in the LAST one but
    were never announced?
  - Does every App Store Connect field fit inside Apple's character limits?
  - Where is the store copy still carrying em dashes?
  - Has the screenshot config drifted from the copy that documents it?

Usage:
    python3 audit_release.py [--repo PATH] [--json]
"""

import argparse
import json
import os
import re
import subprocess
import sys

# Apple's App Store Connect limits. Spaces count toward every one of these.
FIELD_LIMITS = {
    "SUBTITLE": 30,
    "PROMOTIONAL TEXT": 170,
    "KEYWORDS": 100,
    "DESCRIPTION": 4000,
    "WHAT'S NEW": 4000,
}

# Header aliases -> canonical field name.
FIELD_ALIASES = {
    "SUBTITLE": "SUBTITLE",
    "PROMOTIONAL TEXT": "PROMOTIONAL TEXT",
    "PROMO TEXT": "PROMOTIONAL TEXT",
    "KEYWORDS": "KEYWORDS",
    "DESCRIPTION": "DESCRIPTION",
    "WHAT'S NEW": "WHAT'S NEW",
    "WHATS NEW": "WHAT'S NEW",
    "WHAT'S NEW IN THIS VERSION": "WHAT'S NEW",
    "RELEASE NOTES": "WHAT'S NEW",
}

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
    # The app target's version is the first one; test targets often pin 1.0.
    mv = re.findall(r"MARKETING_VERSION\s*=\s*([^;]+);", text)
    bn = re.findall(r"CURRENT_PROJECT_VERSION\s*=\s*([^;]+);", text)
    return {
        "pbxproj": os.path.relpath(pbx, repo),
        "marketing_version": mv[0].strip() if mv else None,
        "build": bn[0].strip() if bn else None,
        "all_marketing_versions": sorted(set(v.strip() for v in mv)),
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


METADATA_ROOT = "fastlane/metadata"

# fastlane deliver's filenames -> this script's canonical field names. The
# appstore-connect MCP's export_listing writes exactly this tree, so an exported
# listing audits with no conversion step in between.
METADATA_FILE_FIELDS = {
    "subtitle.txt": "SUBTITLE",
    "promotional_text.txt": "PROMOTIONAL TEXT",
    "keywords.txt": "KEYWORDS",
    "description.txt": "DESCRIPTION",
    "release_notes.txt": "WHAT'S NEW",
}


def find_metadata_locale(repo, override=None):
    """Which locale directory to audit: explicit, else the sidecar's primary, else en-US."""
    root = os.path.join(repo, METADATA_ROOT)
    if not os.path.isdir(root):
        return None
    locales = sorted(d for d in os.listdir(root)
                     if os.path.isdir(os.path.join(root, d)))
    if not locales:
        return None
    if override:
        return override if override in locales else None
    sidecar = os.path.join(root, ".listing.json")
    if os.path.exists(sidecar):
        try:
            with open(sidecar, encoding="utf-8") as fh:
                primary = json.load(fh).get("app", {}).get("primaryLocale")
            if primary in locales:
                return primary
        except (ValueError, OSError):
            pass  # a broken sidecar should not stop the audit
    if "en-US" in locales:
        return "en-US"
    return locales[0]


def read_metadata_dir(repo, locale):
    """
    Read the store fields from fastlane/metadata/<locale>/*.txt.

    One file per field means there is nothing to parse: the file content IS the
    value. That removes the entire class of failure the heading parser below has
    to defend against -- a description whose own subheadings look like field
    boundaries, which then measures short and quietly passes a limit it busts.
    """
    base = os.path.join(repo, METADATA_ROOT, locale)
    fields = {}
    for filename, name in METADATA_FILE_FIELDS.items():
        full = os.path.join(base, filename)
        if not os.path.exists(full):
            continue
        content = open(full, encoding="utf-8", errors="replace").read()
        # Exactly one trailing newline is written on export; strip it back off.
        if content.endswith("\n"):
            content = content[:-1]
        limit = FIELD_LIMITS[name]
        n = len(content)
        entry = {"chars": n, "limit": limit, "over_by": max(0, n - limit),
                 "ok": n <= limit, "text": content}
        if name == "KEYWORDS":
            entry.update(keyword_checks(content))
        fields[name] = entry
    return {
        "exists": True,
        "source": "metadata-dir",
        "locale": locale,
        "path": f"{METADATA_ROOT}/{locale}/",
        "fields": fields,
        "missing": sorted(set(FIELD_LIMITS) - set(fields)),
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
                "fields": {}, "missing": sorted(FIELD_LIMITS)}
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
        n = len(content)
        entry = {"chars": n, "limit": limit, "over_by": max(0, n - limit), "ok": n <= limit,
                 "text": content}
        if name == "KEYWORDS":
            entry.update(keyword_checks(content))
        # First occurrence wins; a later duplicate heading is usually a reference table.
        fields.setdefault(name, entry)

    return {
        "exists": True,
        "source": "markdown-doc",
        "path": path,
        "fields": fields,
        "missing": sorted(set(FIELD_LIMITS) - set(fields)),
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
    "whatsNew": "WHAT'S NEW",
    "whats_new": "WHAT'S NEW",
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
        n = len(text)
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

def audit(repo, fields_file=None, live_fields=None, locale=None):
    versions = read_versions(repo)
    cl = parse_changelog(repo)
    dated = [v for v in cl["versions"] if v["version"].lower() != "unreleased" and v["date"]]
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
    metadata_locale = None if fields_file else find_metadata_locale(repo, locale)
    if metadata_locale:
        store = read_metadata_dir(repo, metadata_locale)
        # The prose lives in several files now, so the em-dash scan takes a list.
        # screenshot_sync still wants one document to look for taglines in; the
        # description is where a tagline would appear.
        prose = [f"{METADATA_ROOT}/{metadata_locale}/{n}" for n in
                 ("description.txt", "release_notes.txt", "promotional_text.txt", "subtitle.txt")]
        store_doc = f"{METADATA_ROOT}/{metadata_locale}/description.txt"
    else:
        store_doc = find_store_doc(repo, fields_file)
        store = parse_store_fields(repo, store_doc)
        prose = [store_doc]
    live = compare_live(store, normalize_live_fields(live_fields) if live_fields is not None else None)

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
        "em_dashes": scan_em_dashes(repo, prose + ["CHANGELOG.md"] + ([cfg] if cfg else [])),
        "screenshots": screenshot_sync(repo, cfg, store_doc) if cfg else None,
    }


def report(a):
    L = []
    v = a["version"]
    L.append("VERSION")
    L.append(f"  shipping (MARKETING_VERSION): {v['marketing_version'] or '??'}  build {v['build'] or '?'}")
    L.append(f"  last documented release:      {v['last_documented_release'] or 'none'}")
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
    origin = "metadata tree" if s.get("source") == "metadata-dir" else "markdown doc"
    L.append(f"APP STORE FIELDS  ({s['path']} -- {origin})")
    if not s["exists"]:
        L.append("  ! file does not exist -- every field needs writing from scratch")
    for name, f in s["fields"].items():
        flag = "OK  " if f["ok"] else "OVER"
        L.append(f"  {flag} {name:<18} {f['chars']:>5} / {f['limit']}" + (f"  (over by {f['over_by']})" if not f["ok"] else ""))
        for note in f.get("notes", []):
            L.append(f"       - {note}")
    for name in s["missing"]:
        L.append(f"  MISSING {name:<14} (limit {FIELD_LIMITS[name]})")
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
    L.append("EM DASHES IN PROSE")
    if em:
        L.append(f"  {len(em)} line(s). Reword them -- a hyphen is the same tell.")
        for h in em[:20]:
            L.append(f"    {h['file']}:{h['line']}  {h['text']}")
        if len(em) > 20:
            L.append(f"    ... and {len(em) - 20} more")
    else:
        L.append("  none outside bullet-label separators")
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
                    help="Locale directory to audit under fastlane/metadata/. Defaults to the "
                         "primaryLocale in .listing.json, else en-US.")
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

    a = audit(repo, fields_file=args.fields_file, live_fields=live_fields, locale=args.locale)
    if args.json:
        json.dump(a, sys.stdout, indent=2)
        print()
    else:
        print(report(a))
    # Exit non-zero when something is objectively wrong, so this can gate a release.
    broken = (
        any(not f["ok"] for f in a["store"]["fields"].values())
        or a["store"]["missing"]
        or not a["store"]["exists"]
    )
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
