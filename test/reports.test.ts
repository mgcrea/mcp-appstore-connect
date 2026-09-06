import { describe, expect, it } from "vitest";

import { previewReport } from "#/tools/reports";

/**
 * `previewReport` decides two numbers a caller cannot check for themselves —
 * how many rows a report holds, and whether anything was dropped — and both are
 * consumed downstream as facts. `report_stats.py` refuses a file flagged
 * `truncated` precisely so a floor is never quoted as a total, so a false flag
 * is not cosmetic: it makes the pipeline reject a report that lost nothing.
 *
 * The behaviour is reachable through a tool call, but only via a gzip round
 * trip that obscures which byte caused which count. These drive the function.
 */
const header = "Provider\tSKU\tUnits";
const row = (units: number): string => `APPLE\tD1EXPLORER\t${units}`;

describe("previewReport", () => {
  it("does not count Apple's trailing newline as a row", () => {
    // Apple terminates every report with a newline. Counting it would report
    // three rows for a two-row file.
    const result = previewReport(`${header}\n${row(1)}\n`, 500);

    expect(result.lines).toBe(2);
    expect(result.dataRows).toBe(1);
    expect(result.inlineTruncated).toBe(false);
  });

  it("does not count several trailing newlines either", () => {
    const result = previewReport(`${header}\n${row(1)}\n\n\n`, 500);

    expect(result.lines).toBe(2);
    expect(result.dataRows).toBe(1);
  });

  it("does not flag a complete report as truncated because of that newline", () => {
    // The regression this guards: two content lines and a trailing newline split
    // into three, which used to tip `maxLines: 2` over and flag a file that lost
    // nothing. `report_stats.py` would then refuse it outright.
    const result = previewReport(`${header}\n${row(1)}\n`, 2);

    expect(result.inlineTruncated).toBe(false);
    expect(result.inlineNote).toBeUndefined();
    expect(result.report).toBe(`${header}\n${row(1)}\n`);
  });

  it("truncates only once the content genuinely exceeds maxLines", () => {
    const result = previewReport(`${header}\n${row(1)}\n${row(2)}\n`, 2);

    expect(result.inlineTruncated).toBe(true);
    expect(result.lines).toBe(3);
    expect(result.dataRows).toBe(2);
    // The count in the note is the stripped one, so it agrees with `lines`.
    expect(result.inlineNote).toBe("Inlining the first 2 of 3 lines.");
    expect(result.report).toBe(`${header}\n${row(1)}`);
  });

  it("hands an untruncated report back byte for byte", () => {
    // The trailing newline survives, so a checksum or a diff against the
    // original file still matches.
    const tsv = `${header}\n${row(1)}\n`;
    expect(previewReport(tsv, 500).report).toBe(tsv);
  });

  it("reports zero data rows for a header with nothing under it", () => {
    // Apple's answer for "this period exists but is empty". `dataRows` must
    // floor at 0 rather than go negative off the header subtraction.
    const result = previewReport(`${header}\n`, 500);

    expect(result.lines).toBe(1);
    expect(result.dataRows).toBe(0);
  });

  it("reports zero rows for an entirely empty body", () => {
    const result = previewReport("", 500);

    expect(result.lines).toBe(0);
    expect(result.dataRows).toBe(0);
    expect(result.inlineTruncated).toBe(false);
  });

  it("says nothing about duplicates when there are none", () => {
    // Absence of the field has to mean "checked, clean" — if it were present
    // and zero it would read as noise, and if it were absent on a dirty file it
    // would read as a clean bill of health.
    const result = previewReport(`${header}\n${row(1)}\n${row(2)}\n`, 500);

    expect(result.duplicateRows).toBeUndefined();
    expect(result.duplicateNote).toBeUndefined();
  });

  it("counts data rows that repeat another row byte for byte", () => {
    // The shape Apple's ONGOING monthly instances were caught in: every row of
    // a month present twice, so every total doubles while the file stays
    // perfectly well-formed. Nothing else in the response would show it.
    const result = previewReport(`${header}\n${row(1)}\n${row(2)}\n${row(1)}\n${row(2)}\n`, 500);

    expect(result.dataRows).toBe(4);
    expect(result.duplicateRows).toBe(2);
    expect(result.duplicateNote).toContain("inflated");
  });

  it("counts a row repeated more than twice once per extra copy", () => {
    const result = previewReport(`${header}\n${row(1)}\n${row(1)}\n${row(1)}\n`, 500);

    expect(result.duplicateRows).toBe(2);
  });

  it("does not count the header as a duplicate of an identical data row", () => {
    // Contrived, but the guard is a one-character slice and getting it wrong
    // would flag a clean single-row report.
    const result = previewReport(`${header}\n${header}\n`, 500);

    expect(result.dataRows).toBe(1);
    expect(result.duplicateRows).toBeUndefined();
  });

  it("counts duplicates across the whole report, not just the inlined preview", () => {
    // maxLines trims what is shown, never what is checked: a caller who sees
    // `truncated` and saves the file still needs to know the file double-counts.
    const result = previewReport(`${header}\n${row(1)}\n${row(2)}\n${row(1)}\n`, 2);

    expect(result.inlineTruncated).toBe(true);
    expect(result.duplicateRows).toBe(1);
  });
});

/**
 * `truncated` described the inlined copy while reading as though it described
 * the report, and needed a companion `savedNote` to un-mislead anyone who took
 * it at face value. `inlineTruncated` says what it means; `truncated` stays
 * behind it.
 */
describe("previewReport deprecated aliases", () => {
  const header = "Provider\tUnits";
  const row = (n: number): string => `APPLE\t${n}`;

  it("keeps `truncated` agreeing with `inlineTruncated` in both directions", () => {
    const short = previewReport(`${header}\n${row(1)}\n`, 500);
    expect(short.truncated).toBe(false);
    expect(short.truncated).toBe(short.inlineTruncated);

    const long = previewReport(`${header}\n${row(1)}\n${row(2)}\n`, 2);
    expect(long.truncated).toBe(true);
    expect(long.truncated).toBe(long.inlineTruncated);
  });

  /**
   * The reason `truncated` is kept rather than deprecated. A reader that loses
   * `rows` or `note` raises; a reader that loses `truncated` reads absence as
   * false, stops refusing a partial report, and publishes a floor as a total.
   * Silent, and in the one direction that costs money.
   */
  it("drops `rows` and `note`, which fail loudly, but never `truncated`", () => {
    const result = previewReport(`${header}\n${row(1)}\n${row(2)}\n`, 2);

    expect(result.rows).toBeUndefined();
    expect(result.note).toBeUndefined();
    expect(result).toHaveProperty("truncated");
  });
});
