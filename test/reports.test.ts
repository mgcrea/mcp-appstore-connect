import { describe, expect, it } from "vitest";

import { classifyByCalendar, classifyProbe, periodSpan, stepDown } from "#/reports/period";
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

/**
 * Apple answers "no rows" and "not assembled yet" with the same 404, and the two
 * are opposite conclusions: one is a real zero, the other is reporting lag, and
 * getting it backwards understates a month. Most of the distinction is available
 * from the calendar for no requests at all, and these drive that half directly —
 * a month-boundary off-by-one is invisible through a tool call and wrong by a
 * whole day at the edges.
 */
describe("periodSpan", () => {
  it("runs a weekly period backwards from its week-ending Sunday", () => {
    // Apple keys a weekly report by the day it ENDS, so a naive forward span
    // would name seven days that mostly have not happened.
    expect(periodSpan("WEEKLY", "2026-08-09")).toMatchObject({
      start: "2026-08-03",
      end: "2026-08-09",
    });
    expect(periodSpan("WEEKLY", "2026-08-09")?.days).toHaveLength(7);
  });

  it("gets month lengths right, February included", () => {
    expect(periodSpan("MONTHLY", "2026-02")?.days).toHaveLength(28);
    expect(periodSpan("MONTHLY", "2024-02")?.days).toHaveLength(29); // leap year
    expect(periodSpan("MONTHLY", "2026-01")?.days).toHaveLength(31);
    expect(periodSpan("MONTHLY", "2026-04")?.days).toHaveLength(30);
    expect(periodSpan("MONTHLY", "2026-12")).toMatchObject({
      start: "2026-12-01",
      end: "2026-12-31",
    });
  });

  it("covers a day and a year", () => {
    expect(periodSpan("DAILY", "2026-06-15")?.days).toEqual(["2026-06-15"]);
    expect(periodSpan("YEARLY", "2026")?.days).toHaveLength(365);
  });

  it("returns nothing for a date that does not match its frequency", () => {
    expect(periodSpan("MONTHLY", "2026-06-15")).toBeUndefined();
    expect(periodSpan("DAILY", "2026-06")).toBeUndefined();
    expect(periodSpan("MONTHLY", "2026-13")).toBeUndefined();
  });
});

describe("stepDown", () => {
  /** A year probed as 365 dailies is absurd; as 12 monthlies it is affordable. */
  it("steps a year down to twelve months, not 365 days", () => {
    const step = stepDown("YEARLY", "2026");
    expect(step?.frequency).toBe("MONTHLY");
    expect(step?.dates).toHaveLength(12);
    expect(step?.dates[0]).toBe("2026-01");
    expect(step?.dates[11]).toBe("2026-12");
  });

  it("steps weeks and months down to days", () => {
    expect(stepDown("WEEKLY", "2026-08-09")?.dates).toHaveLength(7);
    expect(stepDown("MONTHLY", "2026-02")?.dates).toHaveLength(28);
  });

  it("has nowhere to step a daily report down to", () => {
    expect(stepDown("DAILY", "2026-06-15")).toBeUndefined();
  });
});

describe("classifyByCalendar", () => {
  const now = new Date("2026-08-11T09:00:00Z");

  it("calls a period that has not started what it is", () => {
    expect(classifyByCalendar("MONTHLY", "2026-12", now)?.reason).toBe("FUTURE_PERIOD");
  });

  /**
   * The case that actually bit: a week that just ended 404s while every day
   * inside it has sales. Settled here for zero extra requests.
   */
  it("calls a just-ended week reporting lag, not a zero", () => {
    const verdict = classifyByCalendar("WEEKLY", "2026-08-09", now);
    expect(verdict?.reason).toBe("WITHIN_GENERATION_LAG");
    expect(verdict?.confidence).toBe("proven");
    expect(verdict?.endedDaysAgo).toBe(2);
  });

  it("holds a daily report to a shorter lag than a weekly one", () => {
    // Dailies appear about a day later; the coarse reports are built on top of
    // them, so they trail further. One rule for both would be wrong twice.
    expect(classifyByCalendar("DAILY", "2026-08-10", now)?.reason).toBe("WITHIN_GENERATION_LAG");
    expect(classifyByCalendar("DAILY", "2026-08-08", now)).toBeUndefined();
    expect(classifyByCalendar("WEEKLY", "2026-08-08", now)?.reason).toBe("WITHIN_GENERATION_LAG");
  });

  it("says nothing about a period older than Apple serves", () => {
    const verdict = classifyByCalendar("DAILY", "2024-01-01", now);
    expect(verdict?.reason).toBe("BEYOND_RETENTION");
    // The retention window is an assumption, so it does not claim proof.
    expect(verdict?.confidence).toBe("bounded");
  });

  /** The residue worth spending requests on — and it is deliberately narrow. */
  it("declines to settle a period that is simply old enough to be a real zero", () => {
    expect(classifyByCalendar("MONTHLY", "2026-06", now)).toBeUndefined();
  });
});

describe("classifyProbe", () => {
  it("treats one sub-period with rows as proof of lag", () => {
    const verdict = classifyProbe(
      [
        { date: "2026-08-03", rows: 0 },
        { date: "2026-08-04", rows: 41 },
      ],
      7,
      "DAILY",
    );

    // One day with sales proves the week should exist, so it settles even though
    // five days were never checked.
    expect(verdict.reason).toBe("NOT_YET_GENERATED");
    expect(verdict.confidence).toBe("proven");
    expect(verdict.evidence).toMatchObject({ firstPeriodWithRows: "2026-08-04" });
  });

  it("only calls it a zero with full coverage and no unknowns", () => {
    const days = Array.from({ length: 7 }, (_, i) => ({ date: `d${i}`, rows: 0 }));
    const verdict = classifyProbe(days, 7, "DAILY");

    expect(verdict.reason).toBe("NO_ROWS");
    expect(verdict.confidence).toBe("proven");
  });

  /**
   * The guard that keeps a bounded check from being read as a total. A transient
   * Apple fault on one day must never turn into a manufactured zero.
   */
  it("refuses to call it a zero when a sub-period is unknown", () => {
    const days = [
      ...Array.from({ length: 6 }, (_, i) => ({ date: `d${i}`, rows: 0 as const })),
      { date: "d6", rows: "unknown" as const },
    ];
    const verdict = classifyProbe(days, 7, "DAILY");

    expect(verdict.reason).toBe("NO_ROWS_OBSERVED");
    expect(verdict.reason).not.toBe("NO_ROWS");
    expect(verdict.confidence).toBe("bounded");
    expect(verdict.evidence).toMatchObject({ periodsUnknown: 1, periodsConfirmedEmpty: 6 });
  });

  it("refuses to call it a zero when the probe was cut short", () => {
    const days = Array.from({ length: 5 }, (_, i) => ({ date: `d${i}`, rows: 0 }));
    const verdict = classifyProbe(days, 31, "DAILY");

    expect(verdict.reason).toBe("NO_ROWS_OBSERVED");
    expect(verdict.evidence).toMatchObject({ periodsChecked: 5, periodsInSpan: 31 });
  });
});
