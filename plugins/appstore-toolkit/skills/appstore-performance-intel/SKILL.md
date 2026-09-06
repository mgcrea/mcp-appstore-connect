---
name: appstore-performance-intel
description: Analyze how a shipped app is actually doing on the App Store — downloads, units, sales and proceeds, impressions, product page views, conversion rate, retention, deletions, and the star ratings behind them — by pulling the real numbers from App Store Connect into a single living markdown report. Use this whenever the user asks how their app is performing, what downloads or sales are doing, whether revenue is up or down, why conversion or installs dropped, where their traffic comes from, which territories matter, how a release affected the numbers, or asks for a performance / metrics / downloads / sales / revenue report — including the standing "how did we do last month" check. Reach for it even when the ask is vague or emotional ("did the 2.1 launch work?", "feels like downloads died", "are we growing?"), because the failure mode of answering those from memory is inventing a trend, and the checks that catch that live here. Also use it when a number needs explaining rather than producing — "why do App Store Connect and my analytics disagree", "is that units figure revenue or downloads", "what counts as an impression". This skill measures, diagnoses and recommends store-side actions from what it measured; feature and competitive strategy belong to app-market-intel.
---

# App Store performance intel

This answers one question with real data: **what are the numbers doing, and
why?** It reads App Store Connect, does the arithmetic in a script rather than
by eye, and maintains one living markdown report you can diff against last
month's.

**Every run has two deliverables, and neither substitutes for the other:** the
markdown file, and a summary of it in the conversation. A file path alone makes
the user open a document to learn whether anything is wrong; a chat-only answer
leaves nothing to diff next month. Step 6 specifies the summary — it is not a
sign-off line, it is the report's findings rendered for someone who will not open
the file.

The failure modes here are specific and they are why the skill exists. People
quote a truncated report as a total. They sum a per-unit money column and
understate revenue by a hundred times. They add euros to yen. They call a
release-day flood of free updates a sales surge. They report a conversion rate
without saying which two reports it came from. Every one of those produces a
confident number that is simply wrong, and none of them is visible in the
output. Run the numbers through the script, label every figure with its source,
and spend your judgment on what the movement means.

A second failure mode is subtler: **answering from the shape of the question.**
If the user says "downloads died", the answer is not sympathy and a plausible
cause. It is a measurement that either confirms it or doesn't, and quite often
doesn't.

## What this skill does not do

It does not propose features, read competitors, or judge positioning. When the
run surfaces something that needs a product decision, name it and hand off to
`app-market-intel`, which has the ledger of what has already been proposed and
rejected. Two skills inventing roadmap independently is how contradictory advice
gets written.

Recommendations here are allowed, expected, and **bounded**: every one must
trace to a number measured in this run. "Search impressions fell 28% while web
referrals rose — the keyword set is worth re-checking" is in scope. "Add a
widget" is not, no matter how good the idea.

## 1. Resolve the app and the window before pulling anything

Two things have to be pinned or every number afterwards is unattributable.

**The app id.** If the user names a repo or you are in one, the id is on disk —
`Listing/.listing.json` or the metadata sidecar carries it, and
`app-market-intel`'s `audit_release_state.py` extracts it with no network call.
Otherwise `app_store_connect_list_apps` and match the bundle id. Do not guess
between two apps; ask.

**The window, stated as dates.** "Last month" is ambiguous at month boundaries
and "recently" is not a window at all. Resolve it to explicit dates, say them in
the report, and use the same window for every report you pull — a funnel built
from two different windows is not a funnel.

**The release dates, which you have to derive rather than read.**
`app_store_connect_list_versions` is the starting point, but be exact about what
it returns: `createdDate` is when the **version record** was created, not when
the build went live, and `earliestReleaseDate` is null unless a scheduled release
was set. There is no release-date field. The gap is routinely days — a version
created on the 2nd, approved and released on the 4th — and since step 4 hangs
every attribution off these dates, using `createdDate` as the release date is how
a report confidently credits a movement to the wrong version.

Pin it properly: `createdDate` is the **earliest** the version could have
shipped, and the version's first appearance in a DAILY sales report is the latest
it could have. When a release matters to the argument, pull the dailies around
`createdDate` and quote the first date its `Version` value actually appears. If
you only have monthly data, say "released mid-July per the version record" rather
than naming a day you did not verify.

A metric that moved is interesting; a metric that moved the day 2.1 shipped is an
explanation — but only if that really was the day.

## 2. Pull the numbers

Read `references/asc-metrics.md` first — it holds the report catalogue, the
column semantics, and the traps. Two independent pipelines answer different
questions and they will not agree with each other:

- **Sales and Trends** (`download_sales_report`, `download_finance_report`) —
  units and money. Works immediately, needs a vendor number.
- **Analytics** (the five `analytics_report*` tools) — the funnel: impressions,
  page views, sources, installs, deletions, sessions. Needs a report request
  that may not exist yet.

Start with sales, because it always works:

```
app_store_connect_download_sales_report { reportDate, frequency, reportType: "SALES", maxLines: 5000 }
```

Then the analytics walk. It is four hops and the first one is the one people
skip:

```
app_store_connect_list_analytics_report_requests    { appId }
app_store_connect_list_analytics_reports            { reportRequestId, category }
app_store_connect_list_analytics_report_instances   { reportId, granularity }
app_store_connect_download_analytics_report_segment { instanceId }
```

**If there is no report request, analytics is not merely empty — it has never
been enabled.** Creating one needs `create_analytics_report_request`, a write
tool that only exists when the server runs with
`APP_STORE_CONNECT_ALLOW_WRITES=1`. If you cannot see that tool, that is the
reason; say so and let the user opt in. Even once created, Apple takes a day or
two to produce the first instance, so a first run on a new app legitimately has
no funnel data. Report the sales half and say what is pending — do not present
an empty analytics result as a collapse.

**Ask for both access types, and say why.** `accessType` decides whether you
ever see the past:

- `ONGOING` accumulates from the day it is created and **backfills nothing**.
- `ONE_TIME_SNAPSHOT` covers roughly the last 52 weeks — on an app that has been
  shipping for months, this is the only route to a funnel for any release that
  already happened.

Creating only the ONGOING one on a never-enabled app quietly forfeits the app's
whole history, and the loss is invisible: next month's run looks healthy because
it has data, and nobody notices the launch it cannot see. So on a first run,
propose both. The snapshot is also the one with a deadline — its window rolls
forward, so a launch older than ~52 weeks is gone for good.

Both are writes against the user's account. Confirm before creating either, and
name what each buys.

**When the snapshot and the ongoing request overlap, the snapshot wins.** They
cover the same months once both exist, and they do not always agree. An `ONGOING`
**monthly** instance has been observed holding every row of its most recent month
**twice** — reporting 7,764 impressions where the snapshot held 3,882, on three
apps at once, with nothing in the response saying so. `summary` now flags exact
duplicate rows, but the habit that catches it is to read history from the
snapshot, read recent weeks from the ongoing **weekly** instances, and treat an
ongoing monthly as suspect until it agrees with one of them.

Ratings are cheap and often the most actionable thing in the run:

```
app_store_connect_list_customer_reviews { appId, rating: [1,2], sort: "-createdDate" }
```

These are written reviews only, so treat them as directional signal, never as
"the app's rating". A cluster of 1-stars that starts on a release date is worth
more than the whole rest of the report.

### Save each report to a file with `savePath`

Pass `savePath` on every download. All three report tools take it:

```
app_store_connect_download_sales_report            { …, savePath: "<abs>/reports/2026-07-sales.tsv" }
app_store_connect_download_finance_report          { …, savePath: "<abs>/reports/2026-07-finance.tsv" }
app_store_connect_download_analytics_report_segment{ …, savePath: "<abs>/reports/2026-07-engagement.csv" }
```

The file gets the report **in full**, and `maxLines` then only trims the copy
inlined in the response. So `maxLines` stops being a correctness problem: set it
low to keep the response small, and the saved file is still complete. The flag
that says the inline copy was trimmed is `inlineTruncated`, and it describes only
that copy; `saved.dataRows` tells you what actually landed on disk. Use an
absolute path in or under the repo's scratch or report directory.

This replaces retyping a report into a file by hand, which is where rows went
missing — a report short one row still sums to a perfectly plausible number, and
nothing downstream notices.

**Every read takes `savePath` too**, not just the report downloads — `list_apps`,
`list_versions`, `get_version`, `list_builds`, `list_customer_reviews` and the
rest write their JSON result to the path you give. Use it for anything that ends
up in a document. The same transcription failure applies: eight apps' shipping
`minOsVersion` floors were once read out of tool responses and retyped into a
cache by hand, and were wrong by the time anyone read them back.

If you ever do have to transcribe a response by hand, guard it with the counts
the response already carries: `dataRows` is the number of data rows, `lines` is
that plus the header line. Assert one of them after writing —

```python
assert len(body) == payload["dataRows"]      # or: len(body) + 1 == payload["lines"]
```

— so a dropped row fails loudly instead of quietly shaving a total.

**Read `filter.inAppPurchaseRows` on every sales response.** In-app purchase rows
do not carry the app's Apple Identifier; the server matches them through
`Parent Identifier` and reports how many it found. Zero on an app you know sells
an IAP means either a genuinely empty period or an app with no rows of its own to
derive the SKU from — the response's `note` says which, and in the second case
you need to pass `sku`. See the identifier split in `references/asc-metrics.md`;
getting this wrong reports a paid app as earning nothing.

## 3. Do the arithmetic in the script, not in your head

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/report_stats.py summary <file>...
python3 ${CLAUDE_SKILL_DIR}/scripts/report_stats.py group   <file> --by "Source Type" --where "Event=Impression"
python3 ${CLAUDE_SKILL_DIR}/scripts/report_stats.py money   <file> --by "Product Type Identifier"
python3 ${CLAUDE_SKILL_DIR}/scripts/report_stats.py rate    <previous> <current> --days <days so far>
python3 ${CLAUDE_SKILL_DIR}/scripts/report_stats.py ratio   <file> --numerator "Event=Page view" --denominator "Event=Impression" --by Territory
python3 ${CLAUDE_SKILL_DIR}/scripts/report_stats.py compare <previous> <current> --by Territory
```

`summary` first, always. It reports the row count, the real date span, every
numeric total, and which columns are worth grouping by — which means you never
have to guess a column name, and you find out immediately if Apple returned a
different shape than you expected.

**A sales report covers the whole vendor account, not one app.** If the account
ships more than one, every row of every other app is in the same file, and an
unfiltered `summary` totals all of them into a number that reads exactly like
the app you asked about. Pass `--app` on every command:

```bash
report_stats.py summary <file> --app <APP_ID>
report_stats.py money   <file> --app <APP_ID> --by "Product Type Identifier"
```

**`--app`, never `--where "Apple Identifier=<APP_ID>"`.** An in-app purchase row
carries the IAP's own Apple Identifier and names the app only in
`Parent Identifier`, as the app's SKU — so the bare `--where` drops every
purchase and hands back a clean, complete-looking report with the revenue
removed. `--app` matches both, and prints the split it found
(`9 direct, 3 in-app purchase via Parent Identifier io.mgcrea.SwiftR2`). Read
that line: it is the check that the money is in your totals.

Check the app count before trusting any total — `summary` without a filter
lists `SKU` or `Title` under `groupable`, and more than one value there means
the unfiltered totals are wrong for your purposes. Every command echoes the
filter it applied and how many rows survived, so a filtered figure is never
mistaken for the file's.

The script refuses to work on a truncated file and exits non-zero. That is
deliberate: re-fetch with a higher `maxLines` or a narrower window. Passing
`--allow-truncated` to get past it turns every total in your report into a
floor, and nothing downstream will remind you.

Handed a saved **tool result** rather than a raw TSV, it follows the `saved.path`
inside it and reads the complete file, so a result whose inline copy was trimmed
is not refused when the full report is sitting on disk beside it. It says which
file it read. The path is only used when its size matches the `saved.bytes` the
result recorded, so a stale or half-written file is refused rather than totalled.

It also warns when a file contains **exact duplicate rows**. Apple's reports are
aggregates keyed by their dimension columns, so a repeated row means the file
double-counts, and the total is wrong by exactly that much while looking
perfectly well-formed — truncation's mirror image. Do not quote a figure from a
file that warns; cross-check it against another instance first.

It also encodes three things that are easy to get wrong by hand and that the
`money` command handles for you: per-unit money columns get weighted by units,
currencies are never combined, and free updates are separated from purchases.
Trust its labels over your own mental arithmetic.

**The funnel lives in rows, not columns.** There is no impressions column;
`Impression` and `Page view` are values of `Event` in the _same_ report, both
measured in `Counts`. So impression-to-page-view is a ratio of two row-sets in
one file — that is what `ratio` is for. Downloads-over-impressions genuinely does
span two pipelines, and when you quote it you name both reports and the window.

**Never quote a pooled conversion rate. Split it first.** A funnel rate is a
weighted average across territories and sources, and a weighted average moves
when the weights move, with nothing underneath it changing. This is the single
most expensive mistake this skill has made: three consecutive runs reported
impression-to-page-view "falling" from 3.24% to 0.54% and recommended redoing
the icon and screenshots. No territory's rate had fallen at all — one territory
converting at 0.24% had grown from 36% to 91% of impressions. The
recommendation came entirely out of the arithmetic of the mix.

```bash
report_stats.py ratio <file> --numerator "Event=Page view" \
                             --denominator "Event=Impression" --by Territory
report_stats.py ratio <previous> <current> --numerator "Event=Page view" \
                             --denominator "Event=Impression" --by "Source Type"
```

With one file it prints the rate per group beside the pooled one and warns when
one group dominates the denominator at an unlike rate. With two it splits the
change into a **mix effect** and a **rate effect** by direct standardisation, and
says outright when the pooled move is mostly mix. Run it `--by Territory` and
again `--by "Source Type"` before writing a word about conversion.

**Normalise per day before comparing two periods.** Months are 27–31 days and the
period you are reporting on is usually still in progress, so raw totals are not
comparable. `rate` divides each period by its real length and prints per-day and
per-30-day figures. Pass `--days` for the current period — the report's own dates
span the whole month even when only nine days of it have happened, and without it
two units in nine days reads as flat against last month's two rather than as more
than three times the pace.

## 4. Explain the movement, don't just report it

A table of numbers is not the deliverable. But before explaining a movement,
establish that there is one.

**Is it real?** At App Store volumes a percentage does not answer that: 7 → 2
units and 700 → 200 are both −71%, and only one of them is evidence. `rate`
gives the Poisson probability that the change is noise, and the answer is
frequently "it is" — a three-day run of zeros on a low-volume app came out at
P = 34%, which is a quiet week, not a signal. Run it before you reach for a
cause:

```bash
report_stats.py rate <previous> <current> --app <APP_ID> --days <days so far>
```

A period with **no rows at all** is the commonest interesting case — "nothing
for 27 days, is that real?" — and it is a real zero, not an error. Pass `--days`
and `rate` will test it against the base rate; without `--days` there are no
dates in the file to measure the window by, so it asks for one.

Under ~5% treat the movement as real and explain it. Over ~20% say the period
was quiet and that the change is within normal variation, and do not attach a
cause to it — an invented explanation for noise is worse than no explanation,
because it survives into the next run as an established fact. In between, report
it as weak and say so. Quote the sample sizes whenever they are small enough for
a percentage to mislead.

For anything that does move meaningfully, work the attribution in this order,
stopping when one holds:

1. **A release.** Line the change up against version dates from step 1.
2. **A source shift.** `group --by "Source Type"` on both periods. Search
   falling while referral rises is a different story from everything falling.
3. **A territory — as volume, and as mix.** Two different things live here and
   only the first is obvious. _Volume:_ one market moving can carry a global
   total, and `compare --by Territory` shows it in one line. _Mix:_ if the metric
   that moved is a **rate**, run `ratio --by Territory` across both periods
   before attributing it to anything. A pooled rate falls when a low-converting
   territory grows its share, with every territory's own rate flat. That is not
   a conversion problem and no listing change addresses it.
4. **A composition change.** Did units rise because of updates rather than
   purchases? Did a price change move proceeds without moving units?
5. **Apple's own reporting.** Late-arriving corrections, an empty date, a
   changed report shape — and a period that reads as zero because it was never
   generated. Apple answers a period with no rows and a period it has not
   assembled yet with the **same HTTP 404**, and the two mean opposite things.
   You no longer have to tell them apart by hand: `download_sales_report`
   returns `{"empty": true, "reason": …, "confidence": …}` instead of failing,
   and the reason is the answer. Read it, do not re-derive it:

   - `NO_ROWS` / `REGION_EMPTY` with `confidence: "proven"` — a real zero.
     Record it as 0.
   - `WITHIN_GENERATION_LAG`, `NOT_YET_GENERATED` — reporting lag. **Not** a
     zero. Recording it as one understates the period.
   - `NO_ROWS_OBSERVED`, `UNDETERMINED`, `BEYOND_RETENTION`, `FUTURE_PERIOD` —
     nothing was established. Say the period is unmeasured rather than empty.

   The `evidence` block says what was actually checked. Do not run your own
   finer-granularity sweep to second-guess a `proven` verdict — the server
   already did it, and re-running it spends a request per day for an answer you
   have.

If none of them holds, say the movement is unexplained. An honest "down 19% and
I can't attribute it" is worth more than a confident guess, and it tells the
user where to look next.

Distinguish "measured, cause unknown" from "not measured". A magnitude confirmed
by the script with no attributable cause is a finding, and worth stating as one.

Do not assert a cause you did not measure. The tell is a sentence where a
metric's fall is explained by something with no number attached to it.

## 5. Write the report

**One living document, rewritten in place: `<docs-dir>/appstore-performance.md`.**
Put it alongside whatever documentation directory the repo already uses. If the
repo has no documentation directory at all (common on app repos that keep only
`CHANGELOG.md` and a listing tree), do not go hunting across sibling repos or
invent a novel location: create `docs/` at the root of the repo the app lives in,
and say in the summary that you created it. Only ask when there is no repo to put
it in.

Do **not** write a dated file per run. Runs cluster — a release week can produce
three in two days — and dated files then accumulate near-identical documents that
disagree at the edges, which is worse than no history: a reader who opens the
wrong one gets last week's conclusion with this week's date on it. The living
document has exactly one current answer, and its history lives in the run log at
the bottom and in the repo's own version control, which diffs better than two
files side by side ever did.

When a run supersedes an earlier finding, **rewrite the body and record the
correction in the run log** rather than leaving the old claim standing beside the
new one. Never leave two files on disk answering the same question differently.

If you find dated reports or a separate `ledger.md` from an earlier version of
this skill, fold them into the living document and say in the summary that they
are now redundant. Do not delete them yourself unless asked — they may be
untracked, in which case deletion is unrecoverable.

Use this shape:

```markdown
# <App> — App Store performance

Living document. Rewritten in place each run; the run log at the bottom keeps
the history.

**Last updated:** <YYYY-MM-DD> · **Data through:** <last date Apple has generated>

<app id, SKU, platform, launch date, IAP ids, and the vendor-scope caveat>

## Where it stands

Two or three sentences of standing context — how old the app is, what order of
magnitude the numbers are, and how to read them. A returning reader needs this
before any table means anything.

## Headline

Three or four sentences. What moved, by how much, and the most likely why.

## The numbers

Tables from the script. Every figure labelled with the report it came from.

## Funnel

Impressions → product page views → downloads, with conversion stated as a
division and both sources named. Say when a stage is unavailable — and when the
app has no analytics request, say the stronger thing: the conversion rate **does
not exist for this window and cannot be computed**, because its numerator was
never collected. That is not the same as "unavailable", and it is worth spelling
out, because a rate quoted for this app in the past cannot have come from
measurement.

## What changed and why

The attribution work from step 4, including anything left unexplained.

## Ratings

Volume, recency, and whether a cluster lines up with a release.

## Recommendations

Store-side actions only, each one naming the number it comes from.

## Gaps

What could not be measured and why — no vendor number, no analytics request,
Apple's lag, a window with no data. This section is not optional.

## Open question for next run

The single unresolved thing this run leaves behind, and what would settle it.
Replaced each run — if the last one is now answered, say so in the run log
rather than keeping it here.

## Run log

One bullet per run, newest first: the date, the window, the headline figure, and
anything this run corrected in an earlier one.
```

**Read the run log and the open question before pulling anything, and append to
the log last.** They are what turn a series of snapshots into a trend and stop
the same movement being reported as new three runs running. A movement already
recorded there is not news — say it is unchanged and spend the run on what is.

**Always leave an open question, and answer the previous one first.** It is the
highest-value thing to carry forward and the easiest to lose: a movement you
could not attribute, a period Apple had not generated yet, a number that needed a
report you could not reach. Make it specific enough to act on — "does the
conversion dip hold once the July analytics instance lands" rather than "watch
conversion". If the previous run's question is now answerable, answer it in the
body and record the resolution in the run log.

Each entry should survive being read a year later without the rest of the
document: the window as explicit dates, the figure that mattered, and any
supersede note. Keep entries to a few lines; the body of the document carries the
detail, and a run log that grows into a second report defeats the point.

Do not commit anything unless asked.

## 6. Summarise it in the conversation

The file is half the deliverable. Now write the summary in chat — assume the user
will read only this and never open the file, and that they should still come away
knowing what moved, what it means, and what you could not see.

Do not paste the report. Re-render it, tighter:

- **The path**, once, plus whether you created the directory and whether you
  committed (default: you did not).
- **The headline**, in prose — what moved, by how much, over which explicit
  dates. Lead with the corrected reading, not the raw one: if units rose 1600%
  but three-quarters of that is a free-update flood, the headline is the flood,
  with the real acquisition number next to it. Never open with a figure you go on
  to debunk.
- **The two or three findings that carry weight**, each with its number attached.
  Something flat can outrank something that moved: revenue unchanged across an 8×
  rise in installs is a bigger finding than the rise.
- **The Gaps section, in full.** This is the one part that is repeated rather than
  compressed, because what could not be measured is exactly what gets lost when a
  path is handed over — and a reader who does not know the funnel was missing will
  read the whole summary as more complete than it is. Include the sample sizes
  here when they are small enough to make percentages misleading, and say which
  movements `rate` found indistinguishable from noise — a change the reader would
  otherwise take as real.
- **The open question for next run**, in one line. It is the thing most likely to
  be acted on before the next run happens.
- **Anything you wrote to the account**, with ids, if the run created an analytics
  report request or any other write.

Keep it scannable — short prose plus a bulleted Gaps list beats a wall of
sentences. Skip the tables; they are what the file is for.

Two things not to do. Do not restate the headline number three times in different
units, and do not close by offering next steps the skill has no mandate for —
feature and competitive strategy belong to `app-market-intel`, so name the handoff
and stop.
