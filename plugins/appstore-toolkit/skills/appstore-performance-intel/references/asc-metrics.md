# App Store Connect metrics: which report holds what, and the traps that bite

Two entirely separate pipelines answer "how is the app doing", and they disagree
with each other on purpose. Pick the right one before pulling anything.

|          | Sales and Trends                                   | Analytics Reports                                       |
| -------- | -------------------------------------------------- | ------------------------------------------------------- |
| Tools    | `download_sales_report`, `download_finance_report` | the five `analytics_report*` tools                      |
| Needs    | `APP_STORE_CONNECT_VENDOR_NUMBER`                  | nothing extra                                           |
| Setup    | none, works immediately                            | a report request, then a day or two of waiting          |
| Shape    | one TSV per date + frequency                       | a request → report → instance → segment walk            |
| Good for | units, money, what you were paid                   | the funnel: impressions, page views, sources, retention |
| Lag      | ~24–48h                                            | longer, and the first instance can take days            |

The rule of thumb: **money questions go to Sales and Trends, discovery
questions go to Analytics.** Downloads exist in both and the two will not match
— see "Why the numbers disagree" below, which is the question that always comes
back from the user.

## Analytics: the reports that matter for marketing

Report names are what `list_analytics_reports` returns and what `filter[name]`
takes. Each has a Standard and a Detailed variant; Detailed adds `Source Info`,
`Page Title` and `Campaign`, and is what you need to attribute anything to a
specific referrer or campaign token.

| Report                                | Category               | Holds                                                                               |
| ------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| App Store Discovery and Engagement    | `APP_STORE_ENGAGEMENT` | impressions and product page views, by source and page type — the top of the funnel |
| App Store Downloads                   | `COMMERCE`             | downloads split by first-time / redownload / update, attributed to source           |
| App Store Purchases                   | `COMMERCE`             | paid app and IAP revenue, attributed to download source and page type               |
| App Store Installations and Deletions | `APP_USAGE`            | installs and deletions per device, with `App Download Date` for cohorting           |
| App Sessions                          | `APP_USAGE`            | how often people open the app and for how long                                      |
| App Store Pre-Order                   | `COMMERCE`             | pre-orders, only relevant around a launch                                           |

The columns are nearly uniform across all of them, which is what makes
`report_stats.py group` work the same way on each:

- `Date` — for weekly and monthly instances this is the **first day** of the
  period, not the last.
- `Counts` — the measure. This is the column you sum.
- `Unique Counts` / `Unique Devices` — deliberately **not** additive. The same
  device appears under several rows, so a sum is an upper bound, never a user
  count. The script flags this rather than letting it be quoted as "users".
- `Source Type` — App Store Search, App Store Browse, Web Referrer, App Referrer,
  Institutional Purchase, Unavailable. This is the single most useful dimension
  in the whole system: it separates "people found us in search" from "our
  website sent them".
- `Page Type` — Product page, Store sheet, No page, In-app event page.
- `Event` / `Download Type` / `Engagement Type` — the row's kind.
- `Territory`, `Device`, `Platform Version`, `App Version`.

### The funnel lives in rows, not columns

The most common mistake is looking for an "impressions" column. There isn't one.
In the Discovery and Engagement report the funnel stages are **values of the
`Event` column**, all measured in `Counts`:

```
group --by Event                                    # Impression vs Page view
group --by "Source Type" --where "Event=Impression" # where impressions come from
group --by "Source Type" --where "Event=Page view"  # where page views come from
```

Impression → page view is a ratio of two row-sets in **one** report, not two.
Downloads ÷ impressions genuinely does span two pipelines. Apple's own
"conversion rate" in the App Analytics web UI is computed the second way too, so
a small discrepancy is expected; state the window and the source reports rather
than quoting a bare percentage.

### A pooled conversion rate is a weighted average, and it lies

This is the most expensive trap in this document, because unlike the others it
produces a number that is arithmetically correct and substantively wrong.

A funnel rate computed over a whole report is weighted by each group's share of
the denominator. When that mix shifts, the pooled rate moves with nothing
underneath it changing. On one real account, impression-to-page-view "fell" from
3.24% to 0.54% across four months and three consecutive runs of this skill
reported it as a product-page problem and recommended new icons and screenshots.
Split by territory, no territory's rate had fallen:

| Month | pooled | DE share | DE rate | non-DE rate |
| ----- | ------ | -------- | ------- | ----------- |
| Apr   | 3.24%  | 36%      | 0.49%   | 4.82%       |
| May   | 1.70%  | 68%      | 0.00%   | 5.37%       |
| Jun   | 1.28%  | 86%      | 0.33%   | 7.11%       |
| Jul   | 0.54%  | 91%      | 0.20%   | 3.87%       |

One territory converting 8× below the rest grew from a third of impressions to
nine tenths. That is the whole movement. The same shape appeared on four sibling
apps and was reported the same wrong way on each.

`report_stats.py ratio` exists for this. Given one file it prints the per-group
rates beside the pooled one and warns when a single group dominates the
denominator at an unlike rate; given two it decomposes the change into a **mix
effect** and a **rate effect** and says which dominates. Run it `--by Territory`
and `--by "Source Type"` before quoting any conversion figure. `Source Type` is
the one that bites next: browse impressions have been seen converting 13× better
than search while making up 2.5% of the denominator.

### Instances and granularity

An instance is one (granularity, processing date) pair. `DAILY` instances hold a
single day, so a 30-day view means either 30 downloads or one `MONTHLY`
instance. Prefer the coarsest granularity that answers the question — the
segments get large fast, and `download_analytics_report_segment` refuses
anything over 25 MiB compressed by default.

Late-arriving data is real: Apple reissues instances as corrections, so an
instance you read last week can legitimately hold different numbers today. If a
figure moved and nothing else explains it, that is usually why.

**A processing date is not a data date.** `get_analytics_status` returns
`earliestInstanceDate` and `latestInstanceDate`, and they describe when Apple
_generated_ the instances, not how far back the numbers inside them go. On an
account where snapshots had just been created they read `2026-08-25` on every
app, while the segments themselves held twelve months of history. Asking "how far
back does this reach" and answering with `earliestInstanceDate` returns the
creation date every time and looks like a backfill that recovered nothing. **The
reach is the `Date` column inside the downloaded segment** — download it and look.

**Instances can be internally duplicated.** An `ONGOING` monthly instance was
observed holding every row of its most recent month twice: 428 rows where 214
were exact duplicates, reporting a month at exactly double its real size, on
three apps at once. Nothing in the response said so, and every total from it was
plausible. The `ONE_TIME_SNAPSHOT` and the `WEEKLY` instances for the same month
agreed with each other and disagreed with it by a clean factor of two.

Two habits follow. Read history from the snapshot and recent weeks from the
ongoing weeklies, treating an ongoing monthly as suspect where they overlap. And
run `report_stats.py summary`, which counts exact duplicate rows and says so —
these reports are aggregates keyed by their dimension columns, so a repeated row
is never legitimate.

## Sales and Trends: the money

`download_sales_report` takes a `reportType` and `reportSubType`. The ones worth
knowing:

- `SALES` + `SUMMARY` — the default. Units and per-unit money per territory.
- `SALES` + `DETAILED` — adds granularity but gets big; watch for truncation.
- `INSTALLS` + `SUMMARY_INSTALL_TYPE` — installs broken out by how they happened.
- `SUBSCRIPTION` / `SUBSCRIBER` / `SUBSCRIPTION_EVENT` — auto-renewable
  subscriptions. The MCP server has no subscription _management_ tools, but
  these reports still read fine.

Date keying is strict and silently wrong if you get it off: `DAILY` wants
`YYYY-MM-DD`, `WEEKLY` wants the **week-ending Sunday**, `MONTHLY` wants
`YYYY-MM`, `YEARLY` wants `YYYY`.

A weekly report straddles month boundaries, and nothing warns you. The week
ending 2026-08-02 carries six days of July, so a set of weeklies assembled into
"August" quietly imports them. For a calendar-month window use `MONTHLY`, or
`DAILY` concatenated.

### Three traps in the money columns

**`Developer Proceeds` and `Customer Price` are per unit, not per row.** A row
saying `Units 120, Developer Proceeds 3.49` means 120 × 3.49, not 3.49. Summing
the column straight understates a good month by two orders of magnitude.
`report_stats.py money` does the weighting and labels what it did.

**Currencies do not add up.** `Customer Currency` is what the buyer paid in;
`Currency of Proceeds` is what Apple pays you in for that region. A total across
territories is meaningless without conversion, and Apple does not supply the
rate. The `money` command splits by currency and refuses to combine them. When a
single consolidated figure is genuinely needed, that is what
`download_finance_report` is for — it is the authoritative record of what was
actually paid, per fiscal month and region.

**`Units` mixes purchases with free updates.** `Product Type Identifier`
separates them, and **the first thing to do is list the distinct values in the
file** — `summary` reports them under `groupable`. Apple adds codes, and the
platform decides whether the digit leads or trails, so reading the actual values
beats reasoning from any table including this one:

| Code                   | Means                                               |
| ---------------------- | --------------------------------------------------- |
| `1F` / `7F`            | iOS: first-time download / update (digit first)     |
| `F1` / `F7`            | macOS: first-time download / update (`F` first)     |
| `F3`                   | macOS redownload — neither a new user nor an update |
| `IA1` (`IA1-M` on Mac) | in-app purchase                                     |

The `1`-versus-`7` digit is the part that matters: `1` is a first-time download or
purchase, `7` is a free update. Everything else is platform decoration. A version
release floods the report with `7` rows, so an unfiltered unit count spikes on
release day and looks like a sales surge — it is the existing base updating. Split
by `Product Type Identifier` before quoting units, and quote the `1` rows when the
question is acquisition.

**An in-app purchase row does not carry its app's Apple Identifier.** This is the
single most expensive trap in this document, so read the row shape before
filtering anything. An `IA1` / `IA1-M` row carries:

| Column              | Holds                                                     |
| ------------------- | --------------------------------------------------------- |
| `Apple Identifier`  | the **IAP's** own numeric id, e.g. `6762885916`           |
| `SKU`               | the **IAP's** own SKU, e.g. `io.mgcrea.SwiftR2.pro`       |
| `Parent Identifier` | the app — **as its SKU string**, e.g. `io.mgcrea.SwiftR2` |

So the app's numeric id appears nowhere on the row that holds the money, and the
one column that does name the app holds a SKU, not an id. Filter a report to
`Apple Identifier=<APP_ID>` and every purchase disappears. What comes back is not
an error and not an empty file: it is a clean, plausible, non-truncated report
whose IAP revenue is exactly zero. Nothing about it looks wrong. Two separate runs
of this skill came one probe away from publishing "this app has never earned
anything" off precisely that report, and a paid app that later went
free-with-IAP is the case where the wrong answer is the confident inverse of the
right one.

Two ways through, in order of preference:

1. **Let the MCP do it.** `download_sales_report` matches child rows through
   `Parent Identifier` by default and reports `inAppPurchaseRows` and the
   `parentSkus` it keyed on. Read those two fields — `inAppPurchaseRows: 0` on an
   app you know sells an IAP means the period is genuinely empty, or that the app
   had no rows of its own to read the SKU off, and the response says which.
2. **`report_stats.py --app <APP_ID>`** when working a file by hand. It applies the
   same derivation — direct rows by id or SKU, then children whose
   `Parent Identifier` matches those rows' SKU — and prints the split.

Never hand-roll this with `--where "Apple Identifier=…"`. That filter is correct
only for the app's own units, and silently wrong for every question about money.

## Why the numbers disagree

Expect this question and answer it before it is asked:

- **Different populations.** Analytics only counts users who agreed to share
  data with developers; Sales and Trends counts every transaction. Analytics
  totals are therefore structurally lower and are a _sample_, not a census.
- **Different events.** Sales `Units` counts a purchase or first download;
  Analytics `App Store Downloads` splits first-time from redownloads and
  updates. Neither is wrong, they measure different things.
- **Different clocks.** Sales reports key on Apple's fiscal calendar and the
  report date; analytics instances key on a processing date. A "week" is not the
  same week.

Say which report a number came from every time. Two numbers that disagree are
fine when each is labelled; the failure is presenting one unlabelled figure as
"downloads".

## Customer reviews

`list_customer_reviews` returns **written** reviews only — rating, title, body,
territory, date. Most people who rate never write anything, and Apple exposes no
aggregate star average through this API at all. So:

- A distribution computed from these is directional, not the App Store rating.
  Never present it as "the app's rating".
- Volume and recency are the useful signals: a cluster of 1-stars in one week,
  or all complaints coming from one territory, is real information.
- `filter[rating]=[1,2]` plus `sort=-createdDate` is the fastest read on what is
  currently going wrong — on an app with enough reviews to have a distribution.
  Below roughly a dozen, drop the filter and pull them all: an empty 1–2 star
  list on an app with three reviews reads as "nothing wrong", when the finding is
  usually that the reviews are a year old and quote a price that has since
  changed.
- Correlate the date of a cluster against release dates. A rating cliff that
  starts the day a version shipped is the most actionable thing in this whole
  document.

## Preconditions that will stop you

**Analytics needs a report request that may not exist.** Check
`list_analytics_report_requests` first. If there is none, creating one needs
`create_analytics_report_request`, which is a **write** tool — it only exists
when the server runs with `APP_STORE_CONNECT_ALLOW_WRITES=1`. If you cannot see
it, that is the reason; say so and let the user opt in rather than reporting the
analysis as failed. Then Apple needs a day or two before the first instance
appears, so the first run of this skill on a new app returns no analytics at
all. Fall back to Sales and Trends and say what is pending.

The `accessType` matters more than it looks. `ONGOING` accumulates from the
moment it is created and backfills nothing; `ONE_TIME_SNAPSHOT` reaches back
roughly 52 weeks. On an app that has already shipped releases, only the snapshot
can produce a funnel for any of them, and its window keeps rolling forward — a
launch older than ~52 weeks is gone for good. Propose both on a first run.

**A sales report is account-wide.** It holds every app the vendor ships, keyed
by `SKU` / `Title` / `Apple Identifier`. There is no per-app filter on Apple's
side — `/v1/salesReports` takes no app parameter — so the split has to happen
after download. That is a trap, and also a saving: on a multi-app account, pull
each period **once** and split it N ways locally rather than downloading the same
file once per app. Pass `appleIdentifier` to `download_sales_report`, and
`report_stats.py --app <APP_ID>` on every command against a file. An unfiltered
total is the whole portfolio and looks identical to a single app's.

`--app` rather than `--where "Apple Identifier=<APP_ID>"`, always: the bare
`--where` is the in-app purchase trap above, and it fails by returning a
well-formed report with the revenue removed.

**The vendor number cannot be discovered from the API.** There is no vendor
resource in the App Store Connect API at all, so no tool can look one up for
you. Two places to get it: Payments and Financial Reports in App Store Connect,
or the filename of any report already downloaded from there, which embeds it as
`S_<frequency>_<vendorNumber>_<date>.txt`. Note also that Apple answers a vendor
number the key cannot read with a bare HTTP 500 `UNEXPECTED_ERROR`, identical to
a real outage — the MCP server rewrites that to name the vendor number as the
likely cause, but it stays ambiguous, so retry once before believing either
diagnosis.

**Start a sales pipeline with `app_store_connect_get_vendor_number`.** It cannot
discover a number, but it reports the one configured, which layer supplied it
(environment or config file), and whether Apple actually accepts it — one call
that separates "not configured", "configured but wrong", and "configured and
working" before you spend four report downloads finding out. Pass a candidate as
`vendorNumber` to test one without saving it.

**Sales reports need a vendor number.** They fail with "A vendor number is
required" unless one is set — `APP_STORE_CONNECT_VENDOR_NUMBER` in the MCP
server environment, or a `vendorNumber` key in
`~/.config/appstore-connect/config.json`, which is the better place for it since
`.mcp.json` files are usually tracked by git. If it is unset, say the revenue
data was unavailable and why — do not quietly substitute analytics downloads for
sales and call it revenue.

**An empty period is a result, not an error.** For a period with no activity —
including dates before the app shipped — Apple answers `/v1/salesReports` with
**HTTP 404**, `NOT_FOUND`, "There were no sales for the date specified". Check
the app's release date before concluding that downloads collapsed.

The trap is that the same 404 is returned for a period Apple has not generated
yet, and "no sales" and "not computed yet" mean opposite things. Weekly and
monthly reports are assembled after the dailies, so a just-ended week can 404
while every day inside it has sales.

**The tool answers this for you.** Rather than failing, `download_sales_report`
returns `{"empty": true, "reason": …, "confidence": …, "period": …, "evidence": …}`
and the reason states which case it is:

| reason                   | means                                            | record as        |
| ------------------------ | ------------------------------------------------ | ---------------- |
| `NO_ROWS` (proven)       | every sub-period was checked and all were empty  | 0                |
| `REGION_EMPTY` (finance) | this region was empty, the account was not       | 0 for the region |
| `NOT_YET_GENERATED`      | a finer period inside this one HAS rows          | not a zero — lag |
| `WITHIN_GENERATION_LAG`  | the period ended too recently to be assembled    | not a zero — lag |
| `FUTURE_PERIOD`          | the period has not started                       | not a zero       |
| `BEYOND_RETENTION`       | older than Apple serves                          | unmeasured       |
| `NO_ROWS_OBSERVED`       | empty as far as checked, which was not all of it | unmeasured       |
| `UNDETERMINED`           | nothing was established                          | unmeasured       |

Only `proven` confidence supports writing a zero down. `evidence` says what was
actually checked; `remedy` says what to do next. Do not re-derive the verdict by
sweeping the dailies yourself — that is what produced it.

Finance never returns `NO_ROWS` or `NOT_YET_GENERATED`: dating a fiscal report
that does not exist would need Apple's 4-4-5 calendar modelled, and the server
deliberately refuses to guess at it.
