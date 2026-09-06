/**
 * What a report period actually covers, and what a 404 over it can honestly be
 * said to mean.
 *
 * Apple answers "this period has no rows" with an HTTP 404 — the same 404 it
 * answers for a period it has not assembled yet. Those are opposite conclusions
 * about the same response: one is a real zero, the other is reporting lag, and
 * getting it backwards understates a month. The server cannot tell them apart
 * from the status code, so until now it shipped prose telling the caller how to
 * check by hand.
 *
 * Most of that check needs no request at all. A period that has not ended, or
 * ended inside Apple's generation lag, cannot yet be a zero — that is a fact
 * about the calendar, not a claim about Apple's state, and it covers the case
 * that actually bites: a week that just ended and 404s while every day inside it
 * has sales.
 *
 * Pure and `now`-injected, and exported for direct unit testing, for the same
 * reason `previewReport` is: an off-by-one in a month boundary is invisible
 * through a tool call and wrong by a whole day at the edges.
 */

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type EmptyReason =
  /** The period has not started. A caller mistake, not data. */
  | "FUTURE_PERIOD"
  /** Ended, but too recently for Apple to have assembled it. Not a zero. */
  | "WITHIN_GENERATION_LAG"
  /** Older than Apple keeps sales reports for. Absence says nothing. */
  | "BEYOND_RETENTION"
  /** Proven lag: a finer-grained period inside this one has rows. */
  | "NOT_YET_GENERATED"
  /** Proven zero: every sub-period was checked and every one was empty. */
  | "NO_ROWS"
  /** Empty as far as was checked, which was not all of it. */
  | "NO_ROWS_OBSERVED"
  /** Nothing was established. Never to be read as a zero. */
  | "UNDETERMINED"
  /** Finance only: this region was empty while the account was not. */
  | "REGION_EMPTY";

export type Confidence = "proven" | "bounded" | "none";

export type PeriodSpan = { start: string; end: string; days: string[] };

const DAY_MS = 86_400_000;

const iso = (date: Date): string => date.toISOString().slice(0, 10);

const utc = (text: string): Date => new Date(`${text}T00:00:00Z`);

/**
 * Apple's daily reports appear about a day after the day closes. Used only to
 * decide whether a 404 for a very recent day is meaningful.
 *
 * An assumption, not a published SLA — which is why it is separate from
 * `PROBE_DAYS_BACK` in the tools, whose five days are a deliberately generous
 * margin for a different job (proving a vendor number is readable).
 */
export const SALES_LAG_DAYS = 2;

/**
 * How long after a coarse period ends before its absence starts to mean
 * something. Weekly and monthly reports are assembled after the dailies they
 * roll up, so they trail further behind than a single day does.
 */
export const COARSE_LAG_DAYS = 5;

/**
 * Roughly how far back Apple serves sales reports. Beyond this a 404 is about
 * retention rather than about sales, and reporting it as a zero would invent a
 * quiet year out of an expired one.
 */
export const SALES_RETENTION_DAYS = 365;

/** Days in a month, honouring leap years. */
const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The calendar span a report date covers.
 *
 * A weekly `reportDate` is the week-ENDING Sunday, so the span runs backwards
 * from it; monthly and yearly run forwards from their first day. Returns
 * undefined for a date that does not parse, which is Apple's problem to reject
 * rather than something to guess about.
 */
export const periodSpan = (frequency: Frequency, reportDate: string): PeriodSpan | undefined => {
  const span = (start: string, end: string): PeriodSpan => {
    const days: string[] = [];
    for (let t = utc(start).getTime(); t <= utc(end).getTime(); t += DAY_MS) {
      days.push(iso(new Date(t)));
    }
    return { start, end, days };
  };

  if (frequency === "DAILY") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return undefined;
    return span(reportDate, reportDate);
  }
  if (frequency === "WEEKLY") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return undefined;
    return span(iso(new Date(utc(reportDate).getTime() - 6 * DAY_MS)), reportDate);
  }
  if (frequency === "MONTHLY") {
    const match = /^(\d{4})-(\d{2})$/.exec(reportDate);
    if (!match) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) return undefined;
    const last = String(daysInMonth(year, month)).padStart(2, "0");
    return span(`${reportDate}-01`, `${reportDate}-${last}`);
  }
  if (!/^\d{4}$/.test(reportDate)) return undefined;
  return span(`${reportDate}-01-01`, `${reportDate}-12-31`);
};

/**
 * Step down one granularity, not all the way to daily.
 *
 * A year probed as 365 dailies is absurd; as 12 monthlies it is cheap. This is
 * what makes a *proven* `NO_ROWS` reachable at every frequency instead of only
 * at the ones with few enough days to enumerate.
 */
export const stepDown = (
  frequency: Frequency,
  reportDate: string,
): { frequency: Frequency; dates: string[] } | undefined => {
  const span = periodSpan(frequency, reportDate);
  if (span === undefined) return undefined;
  if (frequency === "DAILY") return undefined;
  if (frequency === "YEARLY") {
    return {
      frequency: "MONTHLY",
      dates: Array.from(
        { length: 12 },
        (_, i) => `${reportDate}-${String(i + 1).padStart(2, "0")}`,
      ),
    };
  }
  return { frequency: "DAILY", dates: span.days };
};

export type CalendarVerdict = {
  reason: EmptyReason;
  confidence: Confidence;
  periodStart: string;
  periodEnd: string;
  /** Whole days between the period ending and `now`. Negative while it is open. */
  endedDaysAgo: number;
};

/**
 * What the calendar alone can settle about a 404, before spending any request.
 *
 * Returns undefined when the period is old enough that its emptiness is a real
 * question — which is the only case worth probing, and is rare.
 */
export const classifyByCalendar = (
  frequency: Frequency,
  reportDate: string,
  now: Date,
): CalendarVerdict | undefined => {
  const span = periodSpan(frequency, reportDate);
  if (span === undefined) return undefined;

  const today = utc(iso(now)).getTime();
  const start = utc(span.start).getTime();
  const end = utc(span.end).getTime();
  const endedDaysAgo = Math.floor((today - end) / DAY_MS);
  const base = { periodStart: span.start, periodEnd: span.end, endedDaysAgo };

  if (start > today) {
    return { reason: "FUTURE_PERIOD", confidence: "proven", ...base };
  }
  // A period that has not closed, or closed inside the lag, cannot be reported
  // as a zero: Apple has not finished counting it. This is the case that bites.
  const lag = frequency === "DAILY" ? SALES_LAG_DAYS : COARSE_LAG_DAYS;
  if (endedDaysAgo < lag) {
    return { reason: "WITHIN_GENERATION_LAG", confidence: "proven", ...base };
  }
  if (endedDaysAgo > SALES_RETENTION_DAYS) {
    // "Probably" — the window is an assumption, so the confidence says so rather
    // than the reason overclaiming.
    return { reason: "BEYOND_RETENTION", confidence: "bounded", ...base };
  }
  return undefined;
};

/** One probed sub-period: how many data rows it held, or that it is unknown. */
export type ProbedPeriod = { date: string; rows: number | "unknown" };

export type ProbeVerdict = {
  reason: EmptyReason;
  confidence: Confidence;
  evidence: Record<string, unknown>;
};

/**
 * Read a set of probed sub-periods into a verdict.
 *
 * The asymmetry that matters: ONE sub-period with rows proves the coarse report
 * should exist, so it settles `NOT_YET_GENERATED` immediately. Proving the
 * opposite needs every sub-period, all of them empty and none of them unknown —
 * so anything short of that is `NO_ROWS_OBSERVED`, which carries what was
 * actually checked instead of claiming a total.
 */
export const classifyProbe = (
  probed: ProbedPeriod[],
  expected: number,
  probeFrequency: Frequency,
): ProbeVerdict => {
  const withRows = probed.filter((p) => typeof p.rows === "number" && p.rows > 0);
  const unknown = probed.filter((p) => p.rows === "unknown");
  const evidence = {
    probe: probeFrequency,
    periodsInSpan: expected,
    periodsChecked: probed.length,
    periodsWithRows: withRows.length,
    periodsConfirmedEmpty: probed.length - withRows.length - unknown.length,
    periodsUnknown: unknown.length,
    ...(withRows[0] !== undefined ? { firstPeriodWithRows: withRows[0].date } : {}),
  };

  if (withRows.length > 0) {
    return { reason: "NOT_YET_GENERATED", confidence: "proven", evidence };
  }
  if (probed.length >= expected && unknown.length === 0) {
    return { reason: "NO_ROWS", confidence: "proven", evidence };
  }
  return { reason: "NO_ROWS_OBSERVED", confidence: "bounded", evidence };
};
