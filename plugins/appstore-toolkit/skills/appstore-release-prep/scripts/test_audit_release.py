#!/usr/bin/env python3
"""Tests for the parts of audit_release that decide WHAT the audit is about.

A wrong release boundary documents the wrong commits, and a wrong idea of
where the store copy lives reports copy that exists as missing -- both look
like ordinary, confident output. These pin the heuristics behind each.

Run: python3 -m unittest discover -s <this directory>
"""

import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audit_release import audit, parse_store_fields, unwrap_live_fields  # noqa: E402


def git(repo, *args):
    return subprocess.run(
        ["git", "-c", "user.name=test", "-c", "user.email=test@example.com", *args],
        cwd=repo, capture_output=True, text=True, check=True,
    ).stdout.strip()


def write(repo, rel, text):
    path = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


class ReleaseBoundaryTest(unittest.TestCase):
    """Keep a Changelog starts an entry as Unreleased and dates it at release.
    Dating it does not change how often "## [1.4.0]" appears, so the commit
    that cut the release is invisible to a search for the bare heading."""

    def test_boundary_is_the_commit_that_dated_the_entry(self):
        repo = tempfile.mkdtemp(prefix="audit-boundary-")
        git(repo, "init", "-q")

        def commit(message, changelog=None, touch=None):
            if changelog is not None:
                write(repo, "CHANGELOG.md", changelog)
            if touch is not None:
                write(repo, touch, message)
            git(repo, "add", "-A")
            git(repo, "commit", "-q", "-m", message)
            return git(repo, "rev-parse", "HEAD")

        commit("docs: start 1.4.0 entry", changelog="# Changelog\n\n## [1.4.0] - Unreleased\n")
        commit("feat: dark mode toggle", touch="dark.txt")
        commit("feat: export to pdf", touch="pdf.txt")
        cut = commit("release: cut 1.4.0", changelog="# Changelog\n\n## [1.4.0] - 2026-03-01\n")
        commit("feat: share sheet", touch="share.txt")

        result = audit(repo)

        self.assertEqual(result["boundary"]["sha"], cut[:8])
        subjects = [c["subject"] for c in result["commits_this_release"]]
        self.assertEqual(subjects, ["feat: share sheet"])


class GoldenChangesTest(unittest.TestCase):
    """Store images are uploaded separately from everything a release pushes, so a
    release whose goldens moved goes to review with the last version's pictures.
    Cadence 1.12.0 did, with every other section of the audit clean."""

    def make_repo(self):
        repo = tempfile.mkdtemp(prefix="audit-goldens-")
        git(repo, "init", "-q")

        def commit(message, files):
            for rel, text in files.items():
                write(repo, rel, text)
            git(repo, "add", "-A")
            git(repo, "commit", "-q", "-m", message)

        cfg = '{"platform": "ios", "screens": [{"id": "transcript"}]}'
        commit("feat: first", {"CHANGELOG.md": "# Changelog\n\n## [1.0.0] - Unreleased\n",
                               "Screenshots/ios/screenshots.config.json": cfg,
                               "Screenshots/ios/golden/iphone/transcript~dark.png": "v1",
                               "Screenshots/macos/screenshots.config.json": '{"screens": []}',
                               "Screenshots/macos/golden/main~dark.png": "v1"})
        commit("release: cut 1.0.0", {"CHANGELOG.md": "# Changelog\n\n## [1.0.0] - 2026-01-01\n"})
        return repo, commit

    def test_flags_goldens_moved_since_the_release_and_only_that_platform(self):
        repo, commit = self.make_repo()
        commit("chore: iPhone goldens for 1.1",
               {"Screenshots/ios/golden/iphone/transcript~dark.png": "v2"})

        changes = audit(repo)["golden_changes"]

        self.assertEqual([c["config"] for c in changes], ["Screenshots/ios/screenshots.config.json"])
        self.assertEqual([c["subject"] for c in changes[0]["commits"]],
                         ["chore: iPhone goldens for 1.1"])
        self.assertEqual(changes[0]["since_version"], "1.0.0")

    def test_counts_an_accept_not_committed_yet(self):
        repo, _ = self.make_repo()
        write(repo, "Screenshots/macos/golden/main~dark.png", "v2")

        changes = audit(repo)["golden_changes"]

        self.assertEqual([(c["config"], c["uncommitted"], c["commits"]) for c in changes],
                         [("Screenshots/macos/screenshots.config.json", 1, [])])

    def test_silent_when_nothing_moved(self):
        repo, _ = self.make_repo()
        self.assertEqual(audit(repo)["golden_changes"], [])


class LiveFieldsTest(unittest.TestCase):
    """SKILL.md says --live-fields takes export_listing's JSON document, whose
    fields sit under locales[<locale>], not at the top level."""

    DOC = {
        "schemaVersion": 1,
        "app": {"id": "1", "primaryLocale": "en-US"},
        "version": {"id": "v"},
        "appInfo": {"id": "a"},
        "locales": {
            "en-US": {"description": "English.", "subtitle": "Sub"},
            "fr-FR": {"description": "Français.", "subtitle": "Sous"},
        },
        "baseline": {},
    }

    def test_reads_the_primary_locale_of_an_export_listing_document(self):
        self.assertEqual(unwrap_live_fields(self.DOC), {"description": "English.", "subtitle": "Sub"})

    def test_reads_the_asked_for_locale(self):
        self.assertEqual(unwrap_live_fields(self.DOC, "fr-FR")["subtitle"], "Sous")

    def test_still_reads_a_raw_api_response(self):
        raw = {"data": [{"attributes": {"description": "Raw."}}]}
        self.assertEqual(unwrap_live_fields(raw), {"description": "Raw."})


class LocaleOverrideTest(unittest.TestCase):
    def test_refuses_a_locale_with_no_folder_rather_than_reading_the_doc(self):
        repo = tempfile.mkdtemp(prefix="audit-locale-")
        write(repo, "fastlane/metadata/en-US/description.txt", "A description.\n")
        write(repo, "fastlane/metadata/en-US/name.txt", "Acme\n")

        with self.assertRaises(SystemExit) as ctx:
            audit(repo, locale="fr")
        self.assertIn("en-US", str(ctx.exception))


class StoreDocTest(unittest.TestCase):
    def test_reads_a_doc_that_fences_each_field(self):
        repo = tempfile.mkdtemp(prefix="audit-doc-")
        write(repo, "APPSTORE.md", "\n".join([
            "# Store copy",
            "",
            "## Subtitle",
            "```",
            "Track everything",
            "```",
            "",
            "## Keywords",
            "```",
            "tracker,habits",
            "```",
            "",
        ]))

        fields = parse_store_fields(repo, "APPSTORE.md")["fields"]

        self.assertIn("SUBTITLE", fields)
        self.assertEqual(fields["SUBTITLE"]["chars"], 16)
        self.assertIn("KEYWORDS", fields)


if __name__ == "__main__":
    unittest.main()
