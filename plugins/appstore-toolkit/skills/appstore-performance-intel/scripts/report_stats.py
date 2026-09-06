#!/usr/bin/env python3
"""Aggregate an App Store Connect report into numbers you can quote.

Answers the questions you cannot reliably eyeball from a wall of TSV:
  - How many downloads/impressions/units, in total and broken down by territory,
    source, device or event?
  - What did the money actually come to, without mixing currencies or
    double-counting a per-unit column?
  - What changed between this period and the last one, per row?

Feed it the tool output verbatim. The report tools answer with
{"rows": N, "truncated": bool, "report": "<text>"}, and this reads that JSON
directly as well as a plain .tsv/.csv, so no hand-extraction step is needed --
that step is where the truncation flag usually gets lost.

Truncation is treated as a hard error, not a note. A report cut off at maxLines
still sums to a plausible-looking number, and a floor presented as a total is
the single worst failure mode here. Re-fetch with a higher maxLines (or a
SUMMARY subtype) rather than passing --allow-truncated, which only exists for
deliberately sampling the shape of a file.

A Sales and Trends report covers the whole *vendor account*, not one app. If you
ship more than one, every command needs --app to isolate the app you mean --
otherwise `summary` totals every app you have and reads as though it were one:

    --app <APP_ID>                            # or the app's SKU

Use --app, not --where "Apple Identifier=<APP_ID>". An in-app purchase row
carries the IAP's own Apple Identifier and names the app only in
`Parent Identifier`, as the app's SKU, so filtering on the app id drops every
purchase and returns a complete-looking report with the revenue removed. --app
matches both. --where remains for every other column.

Every command echoes the filter it applied and how many rows survived, so a
filtered total can never be mistaken for the whole file.

Usage:
    python3 report_stats.py summary FILE [FILE ...] [--app ID] [--where COL=VALUE]
    python3 report_stats.py group   FILE --by COL[,COL] [--metric COL] [--top N] [--app ID]
    python3 report_stats.py money   FILE [--by COL] [--top N] [--app ID]
    python3 report_stats.py rate    FILE [FILE ...] [--metric COL] [--days N] [--app ID]
    python3 report_stats.py ratio   FILE [CURRENT] --numerator COL=VAL --denominator COL=VAL
                                    [--by COL] [--top N] [--app ID]
    python3 report_stats.py compare BASE CURRENT --by COL [--metric COL] [--top N] [--app ID]

`rate` is the one to reach for before explaining any movement: it normalises
each period to a per-day rate (months are 27-31 days and the current one is
always partial) and gives the Poisson probability that the change between two
periods is noise. At App Store volumes a percentage does not answer that --
7 -> 2 units and 700 -> 200 are both -71%, and only one is evidence.

`ratio` is the one to reach for before quoting any conversion rate. A funnel
rate is a ratio of two row-sets, and the pooled figure is a weighted average
that moves when the weights move, with nothing underneath it changing. Three
consecutive runs of this skill reported impression-to-page-view "falling" from
3.24% to 0.54% and recommended redoing the icon and screenshots; no territory's
rate had fallen at all, one 0.24%-converting territory had simply grown from
36% to 91% of impressions. `ratio` prints the per-group rates beside the pooled
one, and with two files it splits the change into a mix effect and a rate
effect so that artifact cannot be published again.

Duplicated rows are caught too. Apple's reports are aggregates keyed by their
dimension columns, so a row appearing twice means the file double-counts; an
ONGOING monthly analytics instance was observed holding a whole month twice.
Every command says so rather than quietly totalling it.

This script never makes network calls. Fetch the reports with the
appstore-connect MCP and save what it returns.
"""

import argparse
import datetime
import json
import math
import os
import re
import sys

# Metric columns worth summing, in the order we would pick one automatically.
# "Counts" is what every Analytics report calls its measure; "Units" is the
# Sales and Trends equivalent. Unique* are deliberately ranked below the raw
# counts: they do not add up across rows (the same device appears in several),
# so a sum of them is only ever an upper bound.
METRIC_PREFERENCE = [
    "Counts",
    "Units",
    "Quantity",
    "Unique Counts",
    "Unique Devices",
]

NON_ADDITIVE = {"Unique Counts", "Unique Devices"}

# Numeric-looking columns that are labels, not measures. "App Apple Identifier"
# is the one that actually shows up, and a summed app id is pure noise.
ID_COLUMN = re.compile(r"\b(identifier|id)\b", re.IGNORECASE)

# Version strings parse as numbers ("1.2" -> 1.2) and slip straight past
# ID_COLUMN, so a Sales report would report a summed version number as though it
# were a total. Named rather than pattern-matched, because these are Apple's
# exact column names -- and excluding them here also promotes them to the
# `groupable` list, which is where a version actually belongs.
LABEL_COLUMNS = {"Version", "App Version", "Platform Version"}

# Sales and Trends money columns are PER UNIT, not per row. Total spend is
# Units x Customer Price; total proceeds is Units x Developer Proceeds. Summing
# the column straight is the classic mistake and understates a busy day by
# orders of magnitude.
PER_UNIT_PRICE = "Customer Price"
PER_UNIT_PROCEEDS = "Developer Proceeds"
UNITS = "Units"
PRODUCT_TYPE = "Product Type Identifier"

# The three columns that identify an app -- and the split that makes --app
# necessary. An in-app purchase row puts the IAP's own id in `Apple Identifier`
# and the IAP's own SKU in `SKU`; the app appears only in `Parent Identifier`,
# and there it is the app's SKU string, never its numeric id. See apply_app.
APPLE_ID = "Apple Identifier"
SKU = "SKU"
PARENT = "Parent Identifier"

# Summing either of these straight is meaningless -- that is what `money` is
# for. Hiding them from `summary` is worse though: a file with money in it that
# shows no money column reads as "this app earned nothing". So they are listed,
# carrying a flag that says what they are.
PER_UNIT_COLUMNS = {PER_UNIT_PRICE, PER_UNIT_PROCEEDS}

# Columns that stay in the summary even when every row holds the same value.
# See numeric_columns for why the general rule has to make an exception.
ALWAYS_SUMMABLE = set(METRIC_PREFERENCE) | PER_UNIT_COLUMNS

# Which currency each of those is denominated in. They differ: a French sale
# has Customer Price in EUR and Developer Proceeds in whatever Apple pays that
# region in, so the two cannot share a total.
CURRENCY_OF_PRICE = "Customer Currency"
CURRENCY_OF_PROCEEDS = "Currency of Proceeds"


class ReportError(Exception):
    """Something about the input makes the requested number unanswerable."""


def read_saved(saved, dump_path):
    """(text, source, why-not) for the complete file a tool result points at.

    Never raises. A file we cannot verify is a file we do not use, and the
    inline copy behind it is still subject to the truncation guard -- so the
    worst case here is the behaviour we had before this existed.

    The check is on BYTES, not row count. Comparing len(rows) to saved.dataRows
    would false-alarm on every finance report: those are multi-section with
    interior blank lines, which the row filter below drops and the tool's own
    line counter keeps.
    """
    if not isinstance(saved, dict):
        return None, None, ""
    # Absent on files written before `content` existed, and "report" is the
    # right default for those -- only the report downloads had savePath then.
    kind = saved.get("content", "report")
    if kind != "report":
        return None, None, "the saved file is a %s dump, not a report" % kind
    path = saved.get("path")
    if not isinstance(path, str) or not path:
        return None, None, "the result names no saved path"

    expected = saved.get("bytes")
    candidates = [path]
    # Recovers two real cases: a reports directory copied to another machine,
    # and a Docker container path that does not exist on the host. Both still
    # have to pass the byte check, so a same-named different file is refused.
    sibling = os.path.join(os.path.dirname(os.path.abspath(dump_path)), os.path.basename(path))
    if sibling != path:
        candidates.append(sibling)

    tried = []
    for candidate in candidates:
        if not os.path.exists(candidate):
            tried.append("%s (missing)" % candidate)
            continue
        size = os.path.getsize(candidate)
        if isinstance(expected, int) and size != expected:
            tried.append("%s (%d bytes, expected %d)" % (candidate, size, expected))
            continue
        with open(candidate, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read(), candidate, ""
    return None, None, "; ".join(tried)


def read_report(path):
    """Return (rows, columns, truncated, note, source) from a dump or raw file.

    Handed a tool result that saved the report to disk, this reads THAT file
    rather than the copy inlined in the response. The inline copy is the one
    maxLines trims, so without this an agent that saved the tool result got a
    refusal on a report that had lost nothing -- the failure `savedNote` was
    written to explain, one layer down.
    """
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        raw = fh.read()

    truncated = False
    note = ""
    source = path
    text = raw.strip()

    # The tool result shape: {"lines": N, "inlineTruncated": bool, "report": ...}.
    # Also tolerate the segment-download shape, which nests the same keys
    # alongside a "segment" block.
    if text.startswith("{"):
        try:
            blob = json.loads(text)
        except json.JSONDecodeError:
            blob = None
        if isinstance(blob, dict):
            if "error" in blob and "report" not in blob:
                raise ReportError(
                    "This file holds a tool ERROR, not a report: %s" % blob.get("error")
                )
            # An empty period is a successful measurement with no report in it.
            # Without this branch it raises "no 'report' key" -- a parse failure
            # for a legitimate zero, which is the original bug one layer down.
            if blob.get("empty"):
                reason = blob.get("reason", "UNKNOWN")
                confidence = blob.get("confidence", "none")
                if reason in ("NO_ROWS", "REGION_EMPTY"):
                    raise ReportError(
                        "%s reports an EMPTY period (%s, %s). That is a real zero -- "
                        "record it as 0, not as missing data. %s"
                        % (path, reason, confidence, blob.get("remedy", ""))
                    )
                raise ReportError(
                    "%s reports NO DATA for that period, and it is NOT established as a "
                    "zero (reason=%s, confidence=%s). Do NOT record it as 0. %s"
                    % (path, reason, confidence, blob.get("remedy", ""))
                )
            if "report" not in blob:
                raise ReportError(
                    "JSON input has no 'report' key. Save the whole tool result, "
                    "or save the raw TSV/CSV text."
                )
            # `truncated` is the pre-0.23 spelling, kept by the server forever
            # because its ABSENCE reads as false. Accept either.
            truncated = bool(blob.get("inlineTruncated", blob.get("truncated")))
            note = str(blob.get("inlineNote") or blob.get("note") or "")
            text = blob["report"]

            saved_text, saved_path, why = read_saved(blob.get("saved"), path)
            if saved_text is not None:
                # The complete file. Nothing here is a floor any more.
                text = saved_text
                source = saved_path
                truncated = False
                note = ""
                # Say which bytes are being summed. Same principle as every
                # command echoing the filter it applied: a total whose source
                # is ambiguous is a total nobody can check. stderr, so it never
                # lands in output something else is parsing.
                print("read: %s (complete copy named by %s)" % (source, path), file=sys.stderr)
            elif truncated and why:
                note = ("%s The result named a saved copy but it could not be used: %s." %
                        (note, why)).strip()

    lines = [ln for ln in text.split("\n") if ln.strip()]
    if not lines:
        raise ReportError("The report is empty -- Apple returned no rows for that query.")

    delimiter = "\t" if lines[0].count("\t") >= lines[0].count(",") else ","
    columns = [c.strip() for c in lines[0].split(delimiter)]
    rows = []
    for line in lines[1:]:
        cells = line.split(delimiter)
        # Ragged rows happen when a free-text field contains the delimiter.
        # Pad rather than drop: the metric columns are positional and early.
        if len(cells) < len(columns):
            cells += [""] * (len(columns) - len(cells))
        rows.append({col: cells[i].strip() for i, col in enumerate(columns)})

    return rows, columns, truncated, note, source


def to_number(value):
    """Parse a report cell as a number, or None when it is not one."""
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    if not text or text in {"-", "--"}:
        return None
    # Apple writes negative money as (1.23) in some finance reports.
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    text = re.sub(r"^[^\d.\-]+", "", text)
    try:
        number = float(text)
    except ValueError:
        return None
    return -number if negative else number


def numeric_columns(rows, columns):
    """Columns where most non-empty cells parse as numbers and a sum means something.

    Identifiers parse as numbers but adding them up is noise, and so is a column
    holding one repeated value -- a version string, a provider code. Both are
    excluded so the summary shows only totals worth reading.

    The constant-value rule needs one exception, and it bites hardest on exactly
    the apps this script is most useful for: a low-volume seller really does
    move one unit per row, which makes `Units` constant. Dropping it there hid
    every total the report existed to produce -- silently, since a missing line
    looks the same as a column that was not in the file. So the known metric and
    money columns are kept whatever their cardinality.
    """
    found = []
    for col in columns:
        if ID_COLUMN.search(col) or col in LABEL_COLUMNS:
            continue
        cells = [str(r.get(col, "")).strip() for r in rows]
        present = [c for c in cells if c]
        if not present:
            continue
        if len(set(present)) == 1 and col not in ALWAYS_SUMMABLE:
            continue
        parsed = [to_number(c) for c in present]
        if sum(v is not None for v in parsed) >= max(1, len(present) * 0.8):
            found.append(col)
    return found


def pick_metric(rows, columns, requested):
    if requested:
        if requested not in columns:
            raise ReportError(
                "No column %r. Available: %s" % (requested, ", ".join(columns))
            )
        return requested
    for candidate in METRIC_PREFERENCE:
        if candidate in columns:
            return candidate
    numeric = numeric_columns(rows, columns)
    if not numeric:
        raise ReportError(
            "No numeric column to total. Columns: %s" % ", ".join(columns)
        )
    return numeric[0]


def date_span(rows):
    """The min/max of whatever date column exists, for stating the real window."""
    for col in ("Date", "Begin Date", "End Date"):
        values = sorted({str(r[col]).strip() for r in rows if r.get(col, "").strip()})
        if values:
            return col, values[0], values[-1]
    return None, None, None


def aggregate(rows, by, metric):
    """Sum `metric` per distinct tuple of `by` columns."""
    totals = {}
    counted = 0
    for row in rows:
        value = to_number(row.get(metric))
        if value is None:
            continue
        key = tuple(str(row.get(col, "")).strip() or "(blank)" for col in by)
        totals[key] = totals.get(key, 0.0) + value
        counted += 1
    return totals, counted


def fmt(number):
    """Whole numbers read as counts; fractions are money and keep 2 places."""
    if abs(number - round(number)) < 1e-9:
        return "{:,}".format(int(round(number)))
    return "{:,.2f}".format(number)


def render_table(pairs, headers, total=None, total_column=-2):
    lines = []
    widths = [len(h) for h in headers]
    for row in pairs:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    lines.append("  ".join(h.ljust(widths[i]) for i, h in enumerate(headers)).rstrip())
    lines.append("  ".join("-" * widths[i] for i in range(len(headers))))
    for row in pairs:
        cells = []
        for i, cell in enumerate(row):
            text = str(cell)
            cells.append(text.rjust(widths[i]) if i else text.ljust(widths[i]))
        lines.append("  ".join(cells).rstrip())
    if total is not None:
        lines.append("  ".join("-" * widths[i] for i in range(len(headers))))
        # The total belongs under the metric column only. Repeating it under
        # every trailing column (share, %) reads as a second, contradictory
        # figure.
        cells = ["TOTAL".ljust(widths[0])] + [" " * widths[i] for i in range(1, len(headers))]
        cells[total_column] = str(total).rjust(widths[total_column])
        lines.append("  ".join(cells).rstrip())
    return "\n".join(lines)


def guard_truncation(path, truncated, note, allowed):
    if not truncated:
        return
    message = (
        "%s was TRUNCATED by the report tool and no complete copy was reachable, "
        "so every total below is a floor, not a total.%s Re-fetch it with a higher "
        "maxLines, pass savePath and point this at the .tsv itself, or switch to a "
        "SUMMARY subtype / narrower window." % (path, (" " + note) if note else "")
    )
    if not allowed:
        raise ReportError(message)
    print("!! %s\n" % message)


def duplicate_note(rows):
    """How many rows are byte-identical to another row, if any.

    Apple's reports are aggregates keyed by their dimension columns, so the same
    (Date, Event, Source Type, Territory, ...) tuple should appear once. A file
    where it appears twice has been double-counted, and every total from it is
    exactly wrong by that much while looking entirely well-formed -- the same
    failure shape as truncation, in the opposite direction.

    This is not hypothetical. An ONGOING monthly analytics instance was observed
    holding every row of its most recent month twice, reporting 7,764 impressions
    where the ONE_TIME_SNAPSHOT for the same month held 3,882. Nothing in the
    response said so; it was only caught by pulling a second instance and
    noticing the factor of two.

    Returns a warning string, or None when the file is clean.
    """
    seen = {}
    for row in rows:
        key = tuple(str(v) for v in row.values())
        seen[key] = seen.get(key, 0) + 1
    repeated = {k: n for k, n in seen.items() if n > 1}
    if not repeated:
        return None
    extra = sum(n - 1 for n in repeated.values())
    return (
        "%d of %d rows are exact duplicates of another row (%d distinct rows "
        "repeated). Every total from this file is inflated by those rows. Apple's "
        "ONGOING monthly analytics instances have been seen doubling a whole "
        "month this way -- cross-check the figure against the ONE_TIME_SNAPSHOT "
        "or a WEEKLY instance before quoting it."
        % (extra, len(rows), len(repeated))
    )


def warn_duplicates(path, rows):
    note = duplicate_note(rows)
    if note:
        print("!! %s: %s\n" % (path, note))


def cmd_summary(args):
    for path in args.files:
        rows, columns, truncated, note, source = read_report(path)
        guard_truncation(path, truncated, note, args.allow_truncated)
        warn_duplicates(path, rows)
        rows, filter_lines = apply_filters(rows, args, columns)
        print("== %s" % path)
        for line in filter_lines:
            print("   %s" % line)
        if not rows:
            print("   no rows survived the filter -- check the value spelling.\n")
            continue
        print("   rows: %d" % len(rows))
        col, first, last = date_span(rows)
        if col:
            print("   %s: %s .. %s" % (col, first, last))
        print("   columns: %s" % ", ".join(columns))
        numeric = numeric_columns(rows, columns)
        for metric in numeric:
            totals, counted = aggregate(rows, [], metric)
            value = totals.get((), 0.0)
            if metric in NON_ADDITIVE:
                flag = "  (not additive -- upper bound)"
            elif metric in PER_UNIT_COLUMNS:
                flag = "  (PER UNIT -- not a revenue total; use `money`)"
            else:
                flag = ""
            print("   sum(%s) = %s over %d rows%s" % (metric, fmt(value), counted, flag))
        # Dimensions are the interesting thing to group by next, so name the
        # low-cardinality ones rather than making the caller guess.
        dims = []
        for col_name in columns:
            if col_name in numeric:
                continue
            distinct = len({str(r.get(col_name, "")).strip() for r in rows})
            if 1 < distinct <= 40:
                dims.append("%s(%d)" % (col_name, distinct))
        if dims:
            print("   groupable: %s" % ", ".join(dims))
        print()
    return 0


def apply_where(rows, where, columns=None):
    """Filter rows by COL=VALUE clauses, all of which must match.

    A misspelled column is called out rather than silently matching nothing:
    `r.get(col, "")` returns "" for a column that does not exist, so every row
    would be dropped and the result would look exactly like a value that is
    genuinely absent. Those two need different fixes, so they get different
    errors.
    """
    if not where:
        return rows
    for clause in where:
        if "=" not in clause:
            raise ReportError("--where takes COL=VALUE, got %r" % clause)
        col, _, wanted = clause.partition("=")
        col, wanted = col.strip(), wanted.strip()
        if columns is not None and col not in columns:
            raise ReportError(
                "No column %r to filter on. Available: %s" % (col, ", ".join(columns))
            )
        rows = [r for r in rows if str(r.get(col, "")).strip() == wanted]
    return rows


def describe_filter(where, kept, total):
    """One line naming the filter, so a filtered total is never read as the file's."""
    if not where:
        return None
    return "filter: %s  -> %d of %d rows" % (" AND ".join(where), kept, total)


def apply_app(rows, app, columns):
    """Keep one app's rows INCLUDING its in-app purchases. Returns (rows, note).

    The reason this exists rather than --where "Apple Identifier=<APP_ID>": an
    in-app purchase row does not carry its app's Apple Identifier. It carries the
    IAP's own id and its own SKU, and names the app only in `Parent Identifier`,
    as the app's SKU string. So filtering on the app id drops every IA1 / IA1-M
    row, and what comes back is not an error or an empty file -- it is a clean,
    plausible, complete-looking report whose in-app revenue is exactly zero. Two
    real runs of this skill came one probe away from publishing "this app has
    never earned anything" off exactly that.

    The app's SKU does not have to be supplied: it is already on the app's own
    rows, so a first pass over the direct matches yields the key the second pass
    needs. An app with no rows of its own in the period is the one case that
    cannot self-heal, and it is called out rather than quietly returning less.
    """
    if not app:
        return rows, None
    if columns is not None and APPLE_ID not in columns and SKU not in columns:
        raise ReportError(
            "This report has neither an %r nor a %r column, so it cannot be "
            "filtered to one app. Columns: %s" % (APPLE_ID, SKU, ", ".join(columns))
        )

    direct = set()
    for i, row in enumerate(rows):
        if str(row.get(APPLE_ID, "")).strip() == app or str(row.get(SKU, "")).strip() == app:
            direct.add(i)

    skus = {str(rows[i].get(SKU, "")).strip() for i in direct}
    skus.discard("")

    has_parent = columns is None or PARENT in columns
    children = set()
    if has_parent and skus:
        for i, row in enumerate(rows):
            if i not in direct and str(row.get(PARENT, "")).strip() in skus:
                children.add(i)

    kept = [row for i, row in enumerate(rows) if i in direct or i in children]
    label = "app %s: %d of %d rows" % (app, len(kept), len(rows))

    if not has_parent:
        note = "%s (no %r column in this file, so it holds no in-app purchases)" % (label, PARENT)
    elif not direct:
        parents = sorted(
            {str(r.get(PARENT, "")).strip() for r in rows if str(r.get(PARENT, "")).strip()}
        )
        note = (
            "%s -- nothing carries that Apple Identifier or SKU, so its SKU could "
            "not be read off the file and no in-app purchase rows could be matched. "
            "%r values present: %s" % (label, PARENT, ", ".join(parents) or "none")
        )
    else:
        note = "%s (%d direct, %d in-app purchase via %s %s)" % (
            label,
            len(direct),
            len(children),
            PARENT,
            ", ".join(sorted(skus)),
        )
    return kept, note


def apply_filters(rows, args, columns):
    """--app then --where, with a description line for each so neither is invisible."""
    lines = []
    rows, app_note = apply_app(rows, getattr(args, "app", None), columns)
    if app_note:
        lines.append(app_note)
    before_where = len(rows)
    rows = apply_where(rows, args.where, columns)
    where_line = describe_filter(args.where, len(rows), before_where)
    if where_line:
        lines.append(where_line)
    return rows, lines


def cmd_group(args):
    rows, columns, truncated, note, source = read_report(args.file)
    guard_truncation(args.file, truncated, note, args.allow_truncated)
    warn_duplicates(args.file, rows)
    rows, filter_lines = apply_filters(rows, args, columns)
    if not rows:
        raise ReportError("No rows left after the filter. Check the value spelling.")

    by = [c.strip() for c in args.by.split(",")]
    for col in by:
        if col not in columns:
            raise ReportError("No column %r. Available: %s" % (col, ", ".join(columns)))
    metric = pick_metric(rows, columns, args.metric)

    totals, counted = aggregate(rows, by, metric)
    ordered = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
    grand = sum(totals.values())
    shown = ordered[: args.top] if args.top else ordered

    pairs = []
    for key, value in shown:
        share = ("%.1f%%" % (100.0 * value / grand)) if grand else "-"
        pairs.append(list(key) + [fmt(value), share])

    print("%s by %s -- %d rows" % (metric, ", ".join(by), counted))
    for line in filter_lines:
        print(line)
    if metric in NON_ADDITIVE:
        print(
            "NOTE: %s does not add up across rows (a device can appear in several).\n"
            "      Treat this as an upper bound, not a user count." % metric
        )
    col_name, first, last = date_span(rows)
    if col_name:
        print("%s: %s .. %s" % (col_name, first, last))
    print()
    print(render_table(pairs, by + [metric, "share"], total=fmt(grand)))
    if args.top and len(ordered) > args.top:
        rest = sum(v for _, v in ordered[args.top :])
        print("\n(%d more rows, %s remaining)" % (len(ordered) - args.top, fmt(rest)))
    return 0


def cmd_money(args):
    """Total a Sales and Trends report without mixing currencies.

    Kept separate from `group` because the money columns need different
    arithmetic: they are per-unit, so they have to be weighted by Units before
    anything is summed, and a total that spans currencies is meaningless no
    matter how it is computed.
    """
    rows, columns, truncated, note, source = read_report(args.file)
    guard_truncation(args.file, truncated, note, args.allow_truncated)
    warn_duplicates(args.file, rows)
    rows, money_filter_lines = apply_filters(rows, args, columns)
    if not rows:
        raise ReportError("No rows left after the filter. Check the value spelling.")

    if UNITS not in columns:
        raise ReportError(
            "No %r column -- this does not look like a Sales and Trends report. "
            "For an Analytics report use `group` instead." % UNITS
        )

    have_price = PER_UNIT_PRICE in columns
    have_proceeds = PER_UNIT_PROCEEDS in columns
    if not (have_price or have_proceeds):
        raise ReportError(
            "Neither %r nor %r is present, so there is no money in this report. "
            "A free app's SALES report is units-only." % (PER_UNIT_PRICE, PER_UNIT_PROCEEDS)
        )

    by = [c.strip() for c in args.by.split(",")] if args.by else []
    for col in by:
        if col not in columns:
            raise ReportError("No column %r. Available: %s" % (col, ", ".join(columns)))

    # Currency is part of the key whether the caller asked for it or not:
    # rolling EUR and USD into one figure is the trap this command exists to
    # close, and silently picking one currency would be worse than refusing.
    currency_col = (
        CURRENCY_OF_PROCEEDS
        if (have_proceeds and CURRENCY_OF_PROCEEDS in columns)
        else (CURRENCY_OF_PRICE if have_price and CURRENCY_OF_PRICE in columns else None)
    )

    buckets = {}
    for row in rows:
        units = to_number(row.get(UNITS)) or 0.0
        if not units:
            continue
        # Free rows carry no proceeds currency at all. Left blank it renders as
        # an empty column that reads like corrupt data rather than "nothing was
        # paid here", which is what it actually means.
        currency = (str(row.get(currency_col, "")).strip() if currency_col else "?") or "(free)"
        key = (currency,) + tuple(
            str(row.get(col, "")).strip() or "(blank)" for col in by
        )
        bucket = buckets.setdefault(key, {"units": 0.0, "spend": 0.0, "proceeds": 0.0})
        bucket["units"] += units
        if have_price:
            bucket["spend"] += units * (to_number(row.get(PER_UNIT_PRICE)) or 0.0)
        if have_proceeds:
            bucket["proceeds"] += units * (to_number(row.get(PER_UNIT_PROCEEDS)) or 0.0)

    if not buckets:
        raise ReportError("Every row has zero units -- nothing to total.")

    headers = ["currency"] + by + ["units"]
    if have_price:
        headers.append("customer spend")
    if have_proceeds:
        headers.append("est. proceeds")

    ordered = sorted(buckets.items(), key=lambda kv: kv[1]["proceeds"] or kv[1]["units"], reverse=True)
    if args.top:
        ordered = ordered[: args.top]

    pairs = []
    for key, agg in ordered:
        row = list(key) + [fmt(agg["units"])]
        if have_price:
            row.append(fmt(agg["spend"]))
        if have_proceeds:
            row.append(fmt(agg["proceeds"]))
        pairs.append(row)

    col_name, first, last = date_span(rows)
    for line in money_filter_lines:
        print(line)
    if col_name:
        print("%s: %s .. %s" % (col_name, first, last))
    print(
        "Money is per-unit in this report, so these are Units x %s / Units x %s."
        % (PER_UNIT_PRICE, PER_UNIT_PROCEEDS)
    )
    print(
        "Proceeds are Apple's post-commission estimate. The finance report is "
        "the authoritative figure for what you were actually paid.\n"
    )
    print(render_table(pairs, headers))
    # Units mixes new purchases with free updates and redownloads unless the
    # product type is pinned. That inflates "units" while leaving spend flat,
    # which reads as a collapsed price rather than as two different events.
    types = {str(r.get(PRODUCT_TYPE, "")).strip() for r in rows if r.get(PRODUCT_TYPE, "").strip()}
    if len(types) > 1 and PRODUCT_TYPE not in by:
        print(
            "\nNOTE: %d product types in this file (%s), so `units` mixes first-time "
            "purchases with updates and redownloads. Re-run with "
            "--by '%s' to separate them; see references/asc-metrics.md for what "
            "the codes mean." % (len(types), ", ".join(sorted(types)), PRODUCT_TYPE)
        )

    currencies = {key[0] for key in buckets}
    if len(currencies) > 1:
        print(
            "\nNOTE: %d currencies here (%s). They are listed separately on "
            "purpose -- do not add these rows together. Use the finance report "
            "for one consolidated figure." % (len(currencies), ", ".join(sorted(currencies)))
        )
    return 0


def parse_date(value):
    """Apple spells dates two ways: 07/31/2026 in Sales, 2026-07-31 in Analytics."""
    value = str(value).strip()
    for pattern in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.datetime.strptime(value, pattern).date()
        except ValueError:
            continue
    return None


def window(rows):
    """The real calendar span of a report, as (first, last, days).

    Not `date_span`: on a MONTHLY sales report every row carries the same
    `Begin Date`, so the min/max of one column is a single day and the period
    looks 1 day long. The pair of columns is what describes the window, and
    getting this wrong is the whole point of the command -- a rate divided by 1
    instead of 31 is off by a factor of 31.
    """
    starts = [parse_date(r.get("Begin Date", "")) for r in rows]
    ends = [parse_date(r.get("End Date", "")) for r in rows]
    starts = [d for d in starts if d]
    ends = [d for d in ends if d]
    if starts and ends:
        first, last = min(starts), max(ends)
    else:
        singles = [parse_date(r.get("Date", "")) for r in rows]
        singles = [d for d in singles if d]
        if not singles:
            return None, None, None
        first, last = min(singles), max(singles)
    return first, last, (last - first).days + 1


def poisson_cdf(k, lam):
    """P(X <= k) for X ~ Poisson(lam), summed in log space so lam can be large."""
    if k < 0:
        return 0.0
    if lam <= 0:
        return 1.0
    # Beyond this the sum is both slow and pointless: the distribution is
    # indistinguishable from a normal, and counts this size are never the
    # small-number question this command exists for.
    if lam > 20000 or k > 20000:
        z = (k + 0.5 - lam) / math.sqrt(lam)
        return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))
    total = 0.0
    for i in range(int(k) + 1):
        total += math.exp(-lam + i * math.log(lam) - math.lgamma(i + 1))
    return min(1.0, total)


def poisson_verdict(observed, expected):
    """Is a movement of this size distinguishable from noise? (tail, p, words).

    Counts of app units are Poisson-ish: independent purchases arriving at some
    rate. That is the model that answers the question the skill actually needs --
    "is 7 -> 2 a real fall or is it seven coin flips" -- and at these volumes it
    is not answerable by staring at a percentage. A drop from 7 to 2 is -71%, and
    so is a drop from 700 to 200; only one of them is evidence.

    `tail` is one-sided, in the direction the count actually moved, because the
    question is directional. `p` doubles it for the two-sided test, which is what
    the verdict is based on -- the conservative of the two readings.
    """
    if expected <= 0:
        return None, None, "no base rate to compare against"
    if observed <= expected:
        tail = poisson_cdf(observed, expected)
    else:
        tail = 1.0 - poisson_cdf(observed - 1, expected)
    p = min(1.0, 2.0 * tail)
    if p < 0.05:
        words = "unlikely to be noise -- worth explaining"
    elif p < 0.2:
        words = "weak signal; note it, do not build on it"
    else:
        words = "indistinguishable from noise at this volume"
    return tail, p, words


def cmd_rate(args):
    """Per-day rates, and whether a change between periods is real.

    Two things the skill kept needing and kept hand-rolling. Months are 27-31
    days and the current one is always partial, so raw period totals are not
    comparable: 2 units in 9 days of August is over three times July's pace, and
    reads as flat against July's 2. And at these volumes a percentage does not
    say whether anything happened -- both real runs of this skill had to work out
    a Poisson tail by hand to tell a signal (7 -> 2, ~3%) from one that was not
    (a three-day zero, P = 34%).
    """
    periods = []
    for path in args.files:
        rows, columns, truncated, note, source = read_report(path)
        guard_truncation(path, truncated, note, args.allow_truncated)
        warn_duplicates(path, rows)
        rows, filter_lines = apply_filters(rows, args, columns)

        # A period with nothing in it is the single most interesting case this
        # command has -- "no downloads for 27 days, is that real?" is a zero-run,
        # and refusing it forced two real runs of this skill to work the Poisson
        # tail out by hand. It is allowed for the LAST file only, and only with
        # --days, because a period with no rows has no dates to measure itself
        # by. An empty BASE period stays an error: a zero base rate gives nothing
        # to compare against.
        empty = not rows
        if empty:
            if path != args.files[-1]:
                raise ReportError(
                    "No rows left after the filter in %s, and it is not the last "
                    "file. A period with no activity cannot serve as the baseline "
                    "-- there is no rate to compare against. Check the spelling, "
                    "or pick a base period that has data." % path
                )
            if not args.days:
                raise ReportError(
                    "No rows left after the filter in %s. If that is a real zero "
                    "-- no units in the whole period -- pass --days N to say how "
                    "long the period was, and the zero will be tested against the "
                    "base rate. Without it there are no dates to measure the "
                    "window by. If it is not a real zero, check the spelling." % path
                )

        metric = args.metric or (UNITS if UNITS in columns else pick_metric(rows, columns, None))
        if metric not in columns:
            raise ReportError("No column %r in %s." % (metric, path))
        # A rate is a count per day, and the Poisson test below assumes counts.
        # Money is neither: proceeds are per-unit here, and "3.49 events" is not
        # a thing. Refusing beats printing a confident number about nothing.
        if metric in PER_UNIT_COLUMNS:
            raise ReportError(
                "%r is a PER-UNIT money column, not a count, so a rate and a "
                "significance test on it are meaningless. Use --metric %s, or "
                "`money` for the revenue question." % (metric, UNITS)
            )
        if metric in NON_ADDITIVE:
            raise ReportError(
                "%r does not add up across rows, so it has no per-day rate. "
                "Use --metric %s." % (metric, UNITS)
            )

        total = sum(to_number(r.get(metric)) or 0.0 for r in rows)
        first, last, days = window(rows) if rows else (None, None, 0)
        # --days applies to the LAST file only. It exists for a period still in
        # progress, and that is always the newest one; applying it to the base
        # too would rescale the very rate being compared against and quietly
        # invert the answer.
        overridden = bool(args.days) and path == args.files[-1]
        if overridden:
            days = args.days
        if not days:
            raise ReportError(
                "No parseable date column in %s, so the window length is unknown. "
                "Pass --days N to state it." % path
            )
        periods.append(
            {
                "path": path,
                "metric": metric,
                "total": total,
                "days": days,
                "first": first,
                "last": last,
                "overridden": overridden,
                "empty": empty,
                "filters": filter_lines,
            }
        )

    for period in periods:
        print("== %s" % period["path"])
        for line in period["filters"]:
            print("   %s" % line)
        # The report's own dates span the whole month even when only part of it
        # has happened, so an overridden count has to say it overrode them --
        # otherwise the line reads as a 31-day window measured over 9 days.
        note = " (from --days -- period still in progress)" if period["overridden"] else ""
        if period["first"]:
            print(
                "   window: %s .. %s  (%d days)%s"
                % (period["first"], period["last"], period["days"], note)
            )
        else:
            print("   window: %d days%s" % (period["days"], note))
        if period["empty"]:
            print("   no rows matched -- treating this period as a real zero over %d days" % period["days"])
        rate = period["total"] / period["days"]
        print(
            "   %s: %s   ->  %.3f/day   %.1f/30d"
            % (period["metric"], fmt(period["total"]), rate, rate * 30)
        )
        print()

    # A partial current period is the normal case -- Apple has not finished the
    # month yet -- and it is exactly where a raw comparison misleads, so the
    # per-day rate is what gets compared, never the totals.
    for earlier, later in zip(periods, periods[1:]):
        base_rate = earlier["total"] / earlier["days"]
        expected = base_rate * later["days"]
        observed = later["total"]
        pace = (observed / later["days"]) / base_rate if base_rate else None
        tail, p, words = poisson_verdict(observed, expected)

        print("%s -> %s" % (earlier["path"], later["path"]))
        print(
            "   base rate    %.3f %s/day  (%s over %d days)"
            % (base_rate, earlier["metric"], fmt(earlier["total"]), earlier["days"])
        )
        print(
            "   observed     %s over %d days  (expected %.2f at the base rate)"
            % (fmt(observed), later["days"], expected)
        )
        if pace is not None:
            print("   pace         %.2fx the earlier rate" % pace)
        if tail is None:
            print("   %s" % words)
        else:
            direction = "<=" if observed <= expected else ">="
            print(
                "   P(%s %s | rate %.2f) = %.1f%% one-sided, %.1f%% two-sided"
                % (direction, fmt(observed), expected, 100.0 * tail, 100.0 * p)
            )
            print("   -> %s" % words)
        print()
    return 0


def _ratio_sides(rows, columns, numerator, denominator, metric):
    """Sum `metric` over the numerator rows and the denominator rows separately."""
    num_rows = apply_where(rows, numerator, columns)
    den_rows = apply_where(rows, denominator, columns)
    total = lambda rs: sum(to_number(r.get(metric)) or 0.0 for r in rs)
    return num_rows, den_rows, total(num_rows), total(den_rows)


def _grouped(rows, by, metric):
    out = {}
    for row in rows:
        key = tuple(str(row.get(c, "")).strip() for c in by)
        out[key] = out.get(key, 0.0) + (to_number(row.get(metric)) or 0.0)
    return out


def _pct(part, whole):
    return ("%.2f%%" % (100.0 * part / whole)) if whole else "--"


def cmd_ratio(args):
    """A conversion rate, split by the dimension that decides whether it means anything.

    A funnel rate -- page views over impressions, installs over page views -- is
    a ratio of two row-sets in the same report, and the number people quote is
    the pooled one. That pooled number is a weighted average, and a weighted
    average moves when the weights move, with nothing underneath it changing.

    That is not a theoretical worry. Three consecutive runs of this skill
    reported that impression-to-page-view had fallen from 3.24% to 0.54% and
    concluded the product page was the problem. It had not fallen anywhere: one
    territory that converts at 0.24% had grown from 36% to 91% of impressions
    while every territory's own rate held flat. The recommendation that came out
    of it -- redo the icon and the screenshots -- was drawn entirely from the
    arithmetic of the mix.

    So this command never prints the pooled rate on its own. It prints the rate
    per group beside it, and with two files it decomposes the change into the
    part that came from the mix and the part that came from the rates.
    """
    files = args.files
    if len(files) > 2:
        raise ReportError("ratio takes one file, or two to compare (base first).")

    periods = []
    for path in files:
        rows, columns, truncated, note, source = read_report(path)
        guard_truncation(path, truncated, note, args.allow_truncated)
        warn_duplicates(path, rows)
        rows, filter_lines = apply_filters(rows, args, columns)
        if not rows:
            raise ReportError("No rows left after the filter in %s." % path)
        metric = pick_metric(rows, columns, args.metric)
        by = [c.strip() for c in args.by.split(",")] if args.by else []
        for col in by:
            if col not in columns:
                raise ReportError("No column %r. Available: %s" % (col, ", ".join(columns)))
        num_rows, den_rows, num, den = _ratio_sides(
            rows, columns, args.numerator, args.denominator, metric
        )
        if not den:
            raise ReportError(
                "The denominator (%s) sums to zero in %s, so there is no rate to "
                "compute." % (" ".join(args.denominator), path)
            )
        periods.append(
            {
                "path": path,
                "metric": metric,
                "by": by,
                "num": num,
                "den": den,
                "num_by": _grouped(num_rows, by, metric),
                "den_by": _grouped(den_rows, by, metric),
                "filters": filter_lines,
                "span": date_span(rows),
            }
        )

    by = periods[0]["by"]
    metric = periods[0]["metric"]
    label = "%s / %s" % (" ".join(args.numerator), " ".join(args.denominator))

    for period in periods:
        print("== %s" % period["path"])
        for line in period["filters"]:
            print("   %s" % line)
        col, first, last = period["span"]
        if col:
            print("   %s: %s .. %s" % (col, first, last))
        print(
            "   %s  =  %s / %s  =  %s   (measure: %s)"
            % (label, fmt(period["num"]), fmt(period["den"]), _pct(period["num"], period["den"]), metric)
        )
        print()

    if not by:
        print(
            "NOTE: no --by given, so this is the pooled rate and nothing else.\n"
            "      A pooled funnel rate is a weighted average across territories\n"
            "      and sources; re-run with --by Territory before quoting it."
        )
        return 0

    if len(periods) == 1:
        period = periods[0]
        keys = sorted(period["den_by"], key=lambda k: -period["den_by"][k])
        shown = keys[: args.top] if args.top else keys
        pairs = []
        for key in shown:
            d = period["den_by"][key]
            n = period["num_by"].get(key, 0.0)
            pairs.append(list(key) + [fmt(n), fmt(d), _pct(d, period["den"]), _pct(n, d)])
        print(render_table(pairs, by + ["numerator", "denominator", "share of denom", "rate"]))
        if args.top and len(keys) > args.top:
            print("\n(%d more groups not shown)" % (len(keys) - args.top))
        print()
        print("   pooled: %s" % _pct(period["num"], period["den"]))

        # The concentration warning. One group holding most of the denominator at
        # a rate unlike everyone else's is the setup for every mix artifact, and
        # it is invisible in the pooled figure by construction.
        top_key = keys[0]
        top_den = period["den_by"][top_key]
        top_num = period["num_by"].get(top_key, 0.0)
        rest_den = period["den"] - top_den
        rest_num = period["num"] - top_num
        share = top_den / period["den"]
        if share >= 0.4 and rest_den and top_den:
            top_rate = top_num / top_den
            rest_rate = rest_num / rest_den
            if top_rate and rest_rate:
                factor = max(top_rate, rest_rate) / min(top_rate, rest_rate)
            else:
                factor = float("inf")
            if factor >= 2.0:
                print()
                print(
                    "!! %s = %s holds %.0f%% of the denominator and converts at %s,\n"
                    "   against %s for everything else -- a factor of %s.\n"
                    "   The pooled rate is therefore mostly a statement about that one\n"
                    "   group. It will move whenever that group's share moves, with\n"
                    "   nothing underneath it changing. Do not quote it on its own."
                    % (
                        ", ".join(by),
                        "/".join(top_key),
                        100.0 * share,
                        _pct(top_num, top_den),
                        _pct(rest_num, rest_den),
                        ("%.1fx" % factor) if factor != float("inf") else "infinity",
                    )
                )
        return 0

    base, cur = periods
    blend_base = base["num"] / base["den"]
    blend_cur = cur["num"] / cur["den"]

    # Direct standardisation: hold each group's BASE rate and give it the
    # CURRENT mix. Whatever moves is the mix alone; the remainder is the rates.
    # Groups with no base denominator have no base rate, so they fall back to the
    # pooled base rate and are counted below, because silently dropping them
    # would hand the whole of their effect to the wrong term.
    fallback = 0
    standardised = 0.0
    for key, d_cur in cur["den_by"].items():
        d_base = base["den_by"].get(key, 0.0)
        if d_base:
            standardised += (base["num_by"].get(key, 0.0) / d_base) * d_cur
        else:
            standardised += blend_base * d_cur
            fallback += d_cur
    blend_mix = standardised / cur["den"]

    mix_effect = blend_mix - blend_base
    rate_effect = blend_cur - blend_mix

    print("%s -> %s" % (base["path"], cur["path"]))
    print("   pooled %s:  %s  ->  %s" % (label, _pct(base["num"], base["den"]), _pct(cur["num"], cur["den"])))
    print()
    print("   decomposition of the pooled change, by direct standardisation:")
    print("     mix effect   %+.3f pp   (base rates, current %s mix)" % (100.0 * mix_effect, ", ".join(by)))
    print("     rate effect  %+.3f pp   (what each group actually did)" % (100.0 * rate_effect))
    if fallback:
        print(
            "     note: %s of %s denominator (%s) sits in groups absent from the base\n"
            "           period; those were held at the pooled base rate."
            % (fmt(fallback), fmt(cur["den"]), _pct(fallback, cur["den"]))
        )
    print()

    if abs(mix_effect) > abs(rate_effect):
        print(
            "!! The pooled move is MOSTLY MIX. The %s mix changed; the per-group\n"
            "   rates did less. Attributing this movement to whatever the rate\n"
            "   measures -- a product page, a listing, a price -- is not supported\n"
            "   by this data. Read the per-group columns below instead." % ", ".join(by)
        )
    else:
        print(
            "-> The pooled move is mostly a real change in the per-group rates, not\n"
            "   a mix artifact. The per-group columns below say which groups moved."
        )
    print()

    keys = sorted(
        set(base["den_by"]) | set(cur["den_by"]),
        key=lambda k: -(cur["den_by"].get(k, 0.0) + base["den_by"].get(k, 0.0)),
    )
    shown = keys[: args.top] if args.top else keys
    pairs = []
    for key in shown:
        db, dc = base["den_by"].get(key, 0.0), cur["den_by"].get(key, 0.0)
        nb, nc = base["num_by"].get(key, 0.0), cur["num_by"].get(key, 0.0)
        pairs.append(
            list(key)
            + [
                _pct(db, base["den"]),
                _pct(dc, cur["den"]),
                _pct(nb, db),
                _pct(nc, dc),
            ]
        )
    print(render_table(pairs, by + ["share base", "share now", "rate base", "rate now"]))
    if args.top and len(keys) > args.top:
        print("\n(%d more groups not shown)" % (len(keys) - args.top))
    return 0


def cmd_compare(args):
    base_rows, base_cols, base_trunc, base_note, base_src = read_report(args.base)
    cur_rows, cur_cols, cur_trunc, cur_note, cur_src = read_report(args.current)
    guard_truncation(args.base, base_trunc, base_note, args.allow_truncated)
    guard_truncation(args.current, cur_trunc, cur_note, args.allow_truncated)

    # The same filter is applied to both sides on purpose: comparing one app's
    # month against the whole account's month is the kind of mistake that
    # produces a confident, enormous, meaningless percentage.
    base_rows, base_filter_lines = apply_filters(base_rows, args, base_cols)
    cur_rows, cur_filter_lines = apply_filters(cur_rows, args, cur_cols)
    if not base_rows or not cur_rows:
        raise ReportError(
            "No rows left after the filter in %s. Check the value spelling."
            % (args.base if not base_rows else args.current)
        )

    by = [c.strip() for c in args.by.split(",")]
    for col in by:
        for cols, path in ((base_cols, args.base), (cur_cols, args.current)):
            if col not in cols:
                raise ReportError("No column %r in %s." % (col, path))
    metric = pick_metric(cur_rows, cur_cols, args.metric)
    if metric not in base_cols:
        raise ReportError(
            "%r is in %s but not %s -- the two reports are not the same type, "
            "so a comparison would be meaningless." % (metric, args.current, args.base)
        )

    base_totals, _ = aggregate(base_rows, by, metric)
    cur_totals, _ = aggregate(cur_rows, by, metric)

    keys = set(base_totals) | set(cur_totals)
    deltas = []
    for key in keys:
        before = base_totals.get(key, 0.0)
        after = cur_totals.get(key, 0.0)
        change = after - before
        pct = ("%+.1f%%" % (100.0 * change / before)) if before else ("new" if after else "-")
        deltas.append((key, before, after, change, pct))

    deltas.sort(key=lambda d: abs(d[3]), reverse=True)
    shown = deltas[: args.top] if args.top else deltas

    base_sum = sum(base_totals.values())
    cur_sum = sum(cur_totals.values())
    overall = cur_sum - base_sum
    overall_pct = ("%+.1f%%" % (100.0 * overall / base_sum)) if base_sum else "-"

    _, b_first, b_last = date_span(base_rows)
    _, c_first, c_last = date_span(cur_rows)
    print("%s by %s" % (metric, ", ".join(by)))
    for line in base_filter_lines:
        print("  base:    %s" % line)
    for line in cur_filter_lines:
        print("  current: %s" % line)
    if b_first:
        print("  base:    %s  %s .. %s" % (args.base, b_first, b_last))
    if c_first:
        print("  current: %s  %s .. %s" % (args.current, c_first, c_last))
    print(
        "\nTotal %s -> %s  (%s, %s)\n"
        % (fmt(base_sum), fmt(cur_sum), fmt(overall), overall_pct)
    )
    pairs = [
        list(key) + [fmt(before), fmt(after), fmt(change), pct]
        for key, before, after, change, pct in shown
    ]
    print(render_table(pairs, by + ["base", "current", "change", "%"]))
    if args.top and len(deltas) > args.top:
        print("\n(%d more rows, ordered by absolute change)" % (len(deltas) - args.top))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--allow-truncated",
        action="store_true",
        help="Proceed on a truncated report. Every total becomes a floor -- only "
        "use this to inspect the shape of a file, never to quote a number.",
    )
    # --app and --where belong on every subcommand, not just `group`: a Sales
    # report holds the whole vendor account, so isolating one app is a
    # precondition for any correct total, not an optional refinement.
    def add_where(p):
        p.add_argument(
            "--app",
            help="Isolate one app by its Apple Identifier or SKU, INCLUDING its "
            "in-app purchases -- those rows carry the IAP's own identifier and "
            "name the app only in Parent Identifier, as the SKU, so a plain "
            "--where on Apple Identifier silently drops all of them.",
        )
        p.add_argument(
            "--where",
            action="append",
            help="Filter as COL=VALUE, e.g. \"Country Code=US\". Repeatable; all "
            "clauses must match. To isolate an app use --app, which also keeps "
            "its in-app purchase rows.",
        )

    sub = parser.add_subparsers(dest="command", required=True)

    p_summary = sub.add_parser(
        "summary", help="Columns, row count, date span and every numeric total."
    )
    p_summary.add_argument("files", nargs="+")
    add_where(p_summary)
    p_summary.set_defaults(func=cmd_summary)

    p_group = sub.add_parser("group", help="Sum a metric per dimension, ranked.")
    p_group.add_argument("file")
    p_group.add_argument("--by", required=True, help="Column(s) to group by, comma-separated.")
    p_group.add_argument("--metric", help="Column to sum. Auto-detected when omitted.")
    p_group.add_argument("--top", type=int, default=15, help="0 for all rows.")
    add_where(p_group)
    p_group.set_defaults(func=cmd_group)

    p_money = sub.add_parser(
        "money", help="Sales report totals, weighted per-unit and split by currency."
    )
    p_money.add_argument("file")
    p_money.add_argument("--by", help="Extra column(s) to break down by.")
    p_money.add_argument("--top", type=int, default=15, help="0 for all rows.")
    add_where(p_money)
    p_money.set_defaults(func=cmd_money)

    p_rate = sub.add_parser(
        "rate",
        help="Per-day rates, and whether a change between periods is real or noise.",
    )
    p_rate.add_argument("files", nargs="+", help="Oldest first; each is compared to the previous.")
    p_rate.add_argument("--metric", help="Column to count. Defaults to Units.")
    p_rate.add_argument(
        "--days",
        type=int,
        help="Window length of the LAST file, overriding its own dates. Needed for "
        "a period still in progress: its trailing zero-activity days are invisible "
        "in the report, so August measured to the 9th looks like a full month.",
    )
    add_where(p_rate)
    p_rate.set_defaults(func=cmd_rate)

    p_ratio = sub.add_parser(
        "ratio",
        help="A funnel rate, split by the dimension that decides whether it means anything.",
    )
    p_ratio.add_argument(
        "files",
        nargs="+",
        help="One report, or two to compare (base first).",
    )
    p_ratio.add_argument(
        "--numerator",
        action="append",
        required=True,
        metavar="COL=VALUE",
        help='Rows forming the top of the ratio, e.g. "Event=Page view". Repeatable.',
    )
    p_ratio.add_argument(
        "--denominator",
        action="append",
        required=True,
        metavar="COL=VALUE",
        help='Rows forming the bottom, e.g. "Event=Impression". Repeatable.',
    )
    p_ratio.add_argument(
        "--by",
        help="Dimension to split the rate by -- Territory and Source Type are the "
        "two that matter. Omitting it prints the pooled rate and a warning, "
        "because a pooled funnel rate is a weighted average and moves when the "
        "weights move.",
    )
    p_ratio.add_argument("--metric", help="Column to sum. Defaults to Counts.")
    p_ratio.add_argument("--top", type=int, default=12, help="0 for all groups.")
    add_where(p_ratio)
    p_ratio.set_defaults(func=cmd_ratio)

    p_compare = sub.add_parser("compare", help="Per-row delta between two periods.")
    p_compare.add_argument("base", help="The earlier report.")
    p_compare.add_argument("current", help="The later report.")
    p_compare.add_argument("--by", required=True)
    p_compare.add_argument("--metric")
    p_compare.add_argument("--top", type=int, default=15, help="0 for all rows.")
    add_where(p_compare)
    p_compare.set_defaults(func=cmd_compare)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ReportError as err:
        print("error: %s" % err, file=sys.stderr)
        return 2
    except FileNotFoundError as err:
        print("error: %s" % err, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
