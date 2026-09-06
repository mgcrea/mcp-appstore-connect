#!/usr/bin/env python3
"""Tests for the parts of report_stats that decide WHICH bytes get summed.

Every other bug in this script is loud -- a wrong column name raises, a bad
filter returns nothing. The failure mode here is silent and expensive: summing
a truncated report and publishing the floor as a total. That is what
guard_truncation exists to stop, and what following a saved path has to avoid
re-introducing.

Run: python3 -m unittest discover -s <this directory>
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from report_stats import ReportError, guard_truncation, read_report  # noqa: E402

HEADER = "Date,Units"
FULL = "\n".join([HEADER] + ["2026-06-%02d,10" % d for d in range(1, 11)]) + "\n"
INLINE = "\n".join([HEADER] + ["2026-06-%02d,10" % d for d in range(1, 4)])


class ReadReportTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="report-stats-")

    def write(self, name, text):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def dump(self, name, blob):
        return self.write(name, json.dumps(blob))

    def saved_for(self, text, name="june.csv"):
        path = self.write(name, text)
        return {"path": path, "bytes": len(text.encode("utf-8")), "content": "report"}

    # -- the behaviour that existed before, unchanged ---------------------

    def test_truncated_inline_only_still_refuses(self):
        path = self.dump("d.json", {"inlineTruncated": True, "report": INLINE})
        _, _, truncated, note, _ = read_report(path)
        self.assertTrue(truncated)
        with self.assertRaises(ReportError):
            guard_truncation(path, truncated, note, allowed=False)

    def test_old_envelope_without_inline_truncated_still_refuses(self):
        """The pre-0.23 spelling. `truncated` is kept by the server precisely
        because its absence would read as false and stop the refusal."""
        path = self.dump("d.json", {"truncated": True, "note": "n", "report": INLINE})
        _, _, truncated, _, _ = read_report(path)
        self.assertTrue(truncated)

    def test_committed_old_fixture_still_refuses(self):
        fixture = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "evals", "fixtures", "june-engagement-truncated.json",
        )
        _, _, truncated, _, _ = read_report(fixture)
        self.assertTrue(truncated)

    def test_raw_csv_is_unaffected(self):
        path = self.write("raw.csv", FULL)
        rows, _, truncated, _, source = read_report(path)
        self.assertEqual(len(rows), 10)
        self.assertFalse(truncated)
        self.assertEqual(source, path)

    # -- following the saved copy ----------------------------------------

    def test_follows_saved_path_and_totals_the_whole_file(self):
        saved = self.saved_for(FULL)
        path = self.dump("d.json", {"inlineTruncated": True, "report": INLINE, "saved": saved})
        rows, _, truncated, _, source = read_report(path)

        self.assertFalse(truncated)
        self.assertEqual(len(rows), 10)  # not the 3 inlined
        self.assertEqual(source, saved["path"])
        guard_truncation(path, truncated, "", allowed=False)  # must not raise

    def test_missing_saved_file_still_refuses_and_names_it(self):
        saved = {"path": os.path.join(self.dir, "gone.csv"), "bytes": 99, "content": "report"}
        path = self.dump("d.json", {"inlineTruncated": True, "report": INLINE, "saved": saved})
        _, _, truncated, note, _ = read_report(path)

        self.assertTrue(truncated)
        self.assertIn("gone.csv", note)

    def test_byte_mismatch_is_refused_rather_than_trusted(self):
        saved = self.saved_for(FULL)
        saved["bytes"] = saved["bytes"] + 1
        path = self.dump("d.json", {"inlineTruncated": True, "report": INLINE, "saved": saved})
        _, _, truncated, note, _ = read_report(path)

        self.assertTrue(truncated)
        self.assertIn("expected", note)

    def test_byte_mismatch_with_complete_inline_copy_succeeds(self):
        """Never worse than before: a mismatched file falls back to an inline
        copy that lost nothing."""
        saved = self.saved_for(FULL)
        saved["bytes"] = 1
        path = self.dump("d.json", {"inlineTruncated": False, "report": FULL, "saved": saved})
        rows, _, truncated, _, source = read_report(path)

        self.assertFalse(truncated)
        self.assertEqual(len(rows), 10)
        self.assertEqual(source, path)

    def test_json_dump_is_not_parsed_as_a_table(self):
        """A read tool's savePath writes JSON. Following it would parse an
        object as a CSV and produce nonsense columns."""
        saved = self.saved_for('{"data": []}', name="builds.json")
        saved["content"] = "json"
        path = self.dump("d.json", {"inlineTruncated": True, "report": INLINE, "saved": saved})
        _, _, truncated, note, _ = read_report(path)

        self.assertTrue(truncated)
        self.assertIn("json", note)

    def test_sibling_recovery_for_a_moved_reports_directory(self):
        saved = self.saved_for(FULL)
        real = saved["path"]
        # The recorded path is one that does not exist here -- a container path,
        # or another machine -- but the file sits beside the dump.
        saved = dict(saved, path="/nonexistent/elsewhere/june.csv")
        path = self.dump("d.json", {"inlineTruncated": True, "report": INLINE, "saved": saved})
        rows, _, truncated, _, source = read_report(path)

        self.assertFalse(truncated)
        self.assertEqual(len(rows), 10)
        self.assertEqual(source, real)

    def test_sibling_recovery_refuses_a_same_named_different_file(self):
        saved = self.saved_for(FULL)
        saved = dict(saved, path="/nonexistent/elsewhere/june.csv", bytes=saved["bytes"] + 5)
        path = self.dump("d.json", {"inlineTruncated": True, "report": INLINE, "saved": saved})
        _, _, truncated, _, _ = read_report(path)

        self.assertTrue(truncated)


if __name__ == "__main__":
    unittest.main()
