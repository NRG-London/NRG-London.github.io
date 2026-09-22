# Bus performance data contract — v1.2

**What the website expects, so the pipeline in `E:\Road Data` can write it.**
First written 27 Aug 2026 against the draft in that repo's
`HANDOVER-bus-website.md`; revised to v1.0 on 14 Sep 2026, when the pages moved
from a first set of metrics to a designed one, to v1.1 the same day once the back
end had answered the asks, and to v1.2 on 22 Sep when that work landed and the
pages were rebuilt on it. The pages run on live sweep output.

**v1.0 in one paragraph.** Frequent routes and timetabled routes are now
different pages with different headline measures, night routes are parked, and
facts about our data (coverage, departures seen) are kept apart from facts about
the buses. All of that ships on today's fields. What comes next is a list of
asks, lettered A–M under "The v1.0 asks" below, each of which the front end will
build dormant-until-present, exactly as it did curtailments — so the two ends
never have to deploy in step.

**v1.1: agreed, with one foundational change.** Waits move from a gate at each
terminus to TfL's timing points, per direction; route pages move from termini to
directions; weeks move to Sunday–Saturday. See "The v1.0 asks" for the agreed
shapes and the order they arrive in.

## v1.2 — what landed, and what the pages now read

The publish of 15 Sep (week ending Sat 12 Sep, `version: 1`) brought A, C, D, M,
`directions[]`, `tfl_quarterly`, `wait_by_band`, Saturday weeks and contiguous
weeks in one go. The week ending 19 Sep followed on 20 Sep. **The front end was
rebuilt on 22 Sep and now reads all of it.**

**The switch to directions is done — `termini[]` can stop, with one exception.**
Frequent route pages, the chart and the league table's route lines are all built
from `directions[]`. The exception: **timetabled routes still read
`termini[].series[].on_time_pct`**, because `punctuality` is null in every
direction cell (ask F ships later). The page switches those over on its own the
moment a direction cell carries `punctuality` — so keep `termini[]` until F
lands, then drop it and tell the front end.

| Field | Where it shows now |
|---|---|
| `directions[].name` | the card heading — "towards Victoria" — the chart's line names, and the league's route line (with "towards " trimmed) |
| `directions[].measured` | `false` lists the direction under "About this data → Not measured" rather than drawing an empty card |
| `ewt_min`, `ewt_turned_short_min` | the headline, and a line under it: "0.2 min of it from buses turned short" |
| `wait_bands` {10, 20, 30} | three rows per direction, each with the timetable figure under it; the 10-minute band also drives the chart, its dashed timetable line, and a "vs 27%" note in the league table |
| `wait_p95_min` | "1 in 20 wait over 24 min" |
| `worst_gap` {min, start, place, direction} | its own line under the cards, with the place, the direction and the moment |
| `wait_by_band` | the "When it goes wrong" block: one bar per time band, with the timetable's share marked on the bar |
| `daily` {days, coverage, min_hours, series} | the "Last month" and "Last week" chips on the chart; daily `wait_bands` supply the timetable line, so a thin weekend timetable no longer reads as a bad weekend |
| `tfl_quarterly` | the "Compared with TfL's own figures" table |
| `journeys`, `measured_days` | "597 journeys tracked across seven days", under "About this data" |
| `journeys_turned_short_pct`, `ewt_turned_short_min` (route level) | the first line of "Journeys cut short" |
| `journeys_turned_short` / `journeys` (per direction) | the chart's "Cut short" measure, since direction cells carry no rate |
| `measured` (route level) | not used yet — the page decides from whether any direction or terminus has ever reported |

**Three things the pages cannot show yet**, all expected:

1. `punctuality` is null everywhere, so timetabled routes keep the old on-time
   figure and their cards still read as termini.
2. `tfl_quarterly.our_ewt_min` is null on 174 of 538 routes — those rows print
   "no figure" against TfL's, which is honest but thin. Worth filling if the
   quarters can be recomputed on the new measure.
3. The daily series carry no turned-short figure, so the "Cut short" chip is
   disabled on the last-month and last-week spans.

**Two notes from the rebuild:**

- **`worst_gap.start` is `2026-09-15T23:05+01:00`** — no seconds, so it is not
  RFC 3339 and Hugo's `time.AsTime` will not parse it. The page slices the date
  and the time out of the string instead. Seconds would let it be parsed properly.
- **Direction names carry TfL's interchange markup** ("towards Morden Station
  <>"). No action needed — `bus-place.html` strips it, as it does every other
  stop name.

**Nothing outside this repo writes code into the site.** The bus engine
(`static/js/ngbus-*.js`, `static/css/ngbus.css`, the layouts and shortcodes) is
maintained here. `E:\Road Data` writes **data files only** — which is the one
thing the rail project's chartkit does differently, and the reason it needs a
hash guard to stop its publish clobbering the crime charts.

## Where the files go

```
<hugo>/data/bus/weekly.json          the league table: one row per route, latest week
<hugo>/data/bus/routes/<route>.json  per-terminus weekly history, one file per route
<hugo>/data/bus/reference.json       route identity — unused, see below
```

**The weekly run commits to a branch, `bus-data/<week_ending>`, not to `main`.**
The files above reach the site only when that branch is merged. An old week on the
pages usually means an unmerged branch.

Hugo `data/` files are read at build time and never copied into `public/`, so
there is no public URL, no cache-buster to bump, and no runtime fetch. A data
refresh is a page change: write the files, commit, push, CI rebuilds.

**This is the right place and the cost is fine.** `data/bus` is 10.6 MB raw
across 631 route files, and a weekly emit rewrites all of them — but JSON with
repeated keys compresses about 13:1, so the whole directory is 0.8 MB packed and
each emit costs at most that in history, less once git deltas it against the
previous version. Against a `.git` already at 580 MB (the deck.gl bundles and
map imagery), it is not the thing to worry about. No change needed.

The route filename is the route as printed — `157.json`, `N155.json`, `X26.json`.
Case is preserved in the data; the **page URL is lowercased by Hugo**
(`/bus/n155/`), which the templates and `ngbus-table.js` both already handle.

## reference.json — retired in practice

The first prototype invented route identity as well as the numbers, and SL7 was
shown as a single-decker between two places it does not serve. The lesson stands:
**a reader will forgive invented numbers when they are labelled, and will not
forgive invented identity.**

The sweep now emits `deck`, `vehicle_model`, `vehicle_share`, `service_class`
and `termini` itself, and **no template reads `data/bus/reference.json` any
more.** The file and `scripts/export_bus_reference.py` can go whenever convenient.
`service_class` must still come from `route.service_class` and never from the
TfL Line API's `service_type`, which labels night buses "Regular".

## Gaps are permanent, and the page has three treatments for them

The source has been down for a month, for a single day (TfL sent BODS nothing),
and for part of a day. That is not a run of bad luck to be waited out — it is
what this data is like. The front end therefore distinguishes three states
rather than two:

| State | How it arrives | How it draws |
|---|---|---|
| **Nothing** | `null` metrics, `coverage` under `coverage_threshold` | "no data" in tables; the line breaks; never a zero |
| **Thin** | metrics present, `coverage` under 0.9 | a pale column behind the plot, "thin" beside the figure in the weekly table, and the exact coverage in the chart tooltip |
| **Declared outage** | the date range appears in `holes` | named in the chart tooltip for every week it touches, and listed in "About this data" |

**39% of published week-cells in the live data sit between 0.6 and 0.98
coverage**, so "thin" is the common case, not an edge one. A week resting on
three days' watching plotted identically to a week resting on five was the
weakest point on the page.

**`holes` is now generated from the coverage masks — 24 entries and growing.**
Granted in a stronger form than asked for. Two consequences the front end had to
absorb, both worth knowing before touching this code:

1. **A hole no longer means a missing week.** Nineteen of the twenty-four are
   partial days — two or three hours gone from an otherwise ordinary Tuesday —
   and the week they fall in publishes fine. The old chart banded any week that
   touched a hole, which with the complete list blacked out **16 of 44 weeks on
   the 157, several at 98% coverage**. The band now derives from coverage alone:
   no terminus cleared the publish threshold that week. `holes` supplies the
   *reason*, never the *verdict*.
2. **Expect dozens, and rising.** They are a hover away on the chart — each week
   names the gaps that touch it — and collected in a `<details>` under the page,
   collapsed, one per line. As a running paragraph 24 of them took up half the
   page height and answered a question nobody arrived with.

`reason` is still printed verbatim, and the wording is doing real work: "no bus
service on Christmas Day" reads as a fact about the network, where "gap in the
volunteer BODS archive" reads as a fact about us. Keep that distinction.

**`coverage` is one network-wide number per week.** It is identical on every
route and every terminus (checked across all 631 files and 59 weeks) — the share
of the week we hold any bus data for. So in v1.0 it no longer sits in the terminus
cards, where it read as a fact about the route, and the "thin" tooltip no longer
talks about "expected observations". It lives in a collapsed **About this data**
panel with the departures seen and the list of gaps, and the chart tooltip reads
"Data collected for 99% of the week".

**The thin threshold stays at 0.9.** With coverage measured properly it now
marks 6.8% of cells rather than 39%, and 52% sit at exactly 1.0. It is doing what
it was meant to do — the earlier figure was measuring the old heuristic.

## Curtailments — built, and live since 28 Aug

Built 28 Aug against the additions relayed from the sweep, and dormant until the
data carries them. Every part of it is conditional on the fields being present,
so the pages render exactly as they do today until the first emit lands, and
nothing needs deploying in step with it.

**What the pages do with each field**

| Field | Where it shows |
|---|---|
| `routes[].curtailment_rate` | a **Cut short** column in the league table, a sortable header, and a **Most cut short** view ranking by rate (not count, so a busy trunk route does not top the list for being busy) |
| `routes[].curtailments` | the row's tooltip — "N journeys cut short in the week" |
| `routes[].flags` containing `"curtailments"` | the figure is set in bold blue: these are the routes where curtailment is the notable thing, and the ones with a detail block |
| `summary.curtailments_week` | a network line under the table |
| `series[].curtailment_rate` | a third measure on the route timeline, beside excess wait and P(wait>10) |
| `curtailment_detail` | a "Journeys cut short" block on the route page: the count, the hour profile as a 24-bar chart, and the turn-point stops |

**The emit landed 28 Aug 23:23 and the pages read it correctly.** Recorded here
because two details differed from the relay:

* **`curtailment_detail.weeks` is the LIST of week-endings covered, not a count
  of them.** Printing it produced a raw JSON array in the middle of a sentence.
  The page now takes its length and names the span.
* **Those weeks are not necessarily consecutive.** The 157's four are 28 Jun,
  12 Jul, 19 Jul and 26 Jul — 5 Jul is missing. So the page says "four weeks of
  observation, 28 June to 26 July" rather than "the last four weeks", which
  would claim a run that was never watched.

Point 1 below was honoured: 43 routes came through at exactly `0.0` and render
"0.0%", 37 as `null` and render "no data". That distinction is working.

**Units: the page converts, and says what it is showing**

`per_10_days_by_hour` is an analyst's normalisation, and putting it on a page
beside a four-week total gave the reader two units and no way to reconcile them.
Route 38 read "345 in four weeks" next to "peak 15.0 per 10 days" — and 345 over
28 days is 123 per 10 days, so the two looked impossible. They were not: 15.0 was
the peak in a single HOUR and the label never said so.

The field is unchanged and still wanted in that form. The page now divides by ten
and draws **journeys per hour on an average day**, so the bars sum to a daily rate
printed in the lead sentence — 345 in four weeks becomes "about 12 a day", the
bars come to 12.4, and the busiest hour is labelled "13:00 — 1.5 a day". Nothing
on the page is in a unit the reader has to convert.

`turn_stops` is likewise a top five, covering between 52% and 100% of a route's
total across the live data. Five counts that visibly fail to add up to the
headline is the same species of puzzle, so the page states the remainder: "the
other 22 turned round somewhere else along the route."

**Four things the emit needs to get right**

1. **`curtailment_rate` must be `0.0`, not `null`, when a route genuinely cut
   nothing short.** The page draws a hard line between "none" and "not measured",
   and that line is the whole ethic of these pages. In the fixture 235 of 631
   routes sit at exactly 0.0 and render "0.0%"; 113 are null and render
   "no data". If zero arrives as null, hundreds of well-run routes will be
   reported as unmeasured.

2. **`per_10_days_by_hour` must have exactly 24 entries**, one per hour from
   00:00, with `null` for an hour with too little observation. A `null` is shaded
   as unobserved; a `0.0` draws a minimum-height bar, so an hour with no
   curtailments still reads as counted rather than missing.

3. **`weekly.json`'s `week_ending` is not always the last entry in `weeks`.**
   Today it is 2026-07-26 while the series runs to 2026-08-30 through the
   outage — correct, and the pages handle it, but anything computing "this week"
   must look the date up rather than take `series[-1]`. Doing exactly that
   produced a fixture with no curtailments anywhere and cost half an hour.

4. **`turn_stops[].name` may carry TfL's interchange markup** (`<>`, `#`, `>t<`,
   `[dlr]`) — no action needed, the page strips it through `bus-place.html` like
   every other stop name. Sending it raw is fine.

**Not needed:** a per-terminus curtailment figure in `weekly.json`'s `termini[]`
snapshot. The route page reads the time series for that, and the terminus cards
stay about waiting.

## Route classes — frequent, timetabled, night

**Landed and live.** `frequency_type` splits at a 12.5-minute scheduled headway,
and timetabled routes carry `on_time_pct` with `ewt_min: null`. Negative excess
wait, which was on 30 routes when this was first raised, is down to three frequent
routes (247, 427 and 143; the lowest is −0.15). The pages use the split
everywhere:

| Class | How the page decides | Headline | Terminus cards | League table |
|---|---|---|---|---|
| **Frequent** | `frequency_type: "headway"` | excess wait | excess wait, wait > 10 min, longest gap | *Frequent routes* tab |
| **Timetabled** | `frequency_type: "timetabled"` | % on time, against the timetabled-route median | on time | *Timetabled routes* tab |
| **Night** | `service_class: "night"` | "Night route" — measured separately, later; links the day route where one exists | none | left out; a search names them |

`service_class` and `frequency_type` are read from the **league row**. The route
files do not carry them, and reading `service_class` from there is why the
"Night route." caption never once appeared.

School services go by their `frequency_type` like any other route. 29 of the 31
have never produced a figure, and their pages say "No figures yet" rather than
"No data this week".

**What the front end computes for itself, for now** (ask L would retire it): the
timetabled tab needs a trend and a change, and `spark` and `delta` are null on
every timetabled row. The league shortcode rebuilds both from the route files —
the departures-weighted mean of each terminus's `on_time_pct`, which reproduces
the sweep's route-level figure on all 181 routes — compared against the same week
the frequent routes use (`delta_from`).

## Seven changes from the draft in HANDOVER-bus-website.md

These are what the front end actually needs. All seven are implemented in the
sample generator, so you can diff against its output.

1. **`routes/<route>.json` needs a terminus dimension.** The draft's `series` was
   flat, but `weekly.json` was per-terminus. It has to be per-terminus in both:
   your own five-route battery found 154 and 157 diverging *at the same stand*
   (EWT 0.8 vs 1.5 at Morden), and a route-level line hides exactly that.

2. **`weekly.json` needs a trend, not just a snapshot.** Each row carries
   `spark` — the last 12 weekly route-level EWT values, nulls allowed — and a
   `delta`. Without them the league table has no trend column and the
   "most improved" view has nothing to rank.

3. **`delta` names its comparison week.** `delta_4w` was the draft's idea and it
   cannot survive the July outage: four weeks back from the current week lands
   inside a five-week hole, so every route would read "no change". Instead walk
   back from four weeks to the most recent week that actually reported, and
   publish `delta`, `delta_from` (that week's `week_ending`) and `delta_weeks`.
   The page then says "compared with the week ending 26 Jul" rather than
   claiming a four-week comparison it did not make.

4. **`deck`, `vehicle_model` and `service_class` per route.** `deck` is
   `"double"` or `"single"` and picks the illustration; `vehicle_model` becomes
   the caption ("Usually an Alexander Dennis Enviro 400H MMC"). **Solved** — the
   `route_fleet` ⋈ `model` join above already has both, and `route_fleet` is
   how the deck becomes knowable at all, since the fleet audit itself has no
   route column (your `CLAUDE.md` lists that as an already-caused wrong result).
   Mixed routes take the majority and `vehicle_share` is published so "usually"
   is honest; 30 routes have no observed fleet and fall back to a double-decker
   with no caption. `service_class` must come from `route.service_class`
   (`regular` / `night` / `school`) and **never** from `service_type` — the TfL
   Line API labels every route "Regular", night buses included.

5. **`holes`: an explicit list of collection outages**, `{start, end, reason}`,
   in `weekly.json`. The chart draws these as labelled "no data" bands. It must
   not infer them from missing values, because inference cannot tell "we did not
   collect" from "this route did not run", and those deserve different words.

6. **`coverage_threshold` lives in the file**, not in the JavaScript. The
   threshold for "too little data to publish" is a methodology decision, and it
   should move when the methodology moves, not when someone edits a script.

7. **`week_ending` on every route file**, matching `weekly.json`. A mismatch
   means a half-finished publish, and it is better to be able to detect that
   than to serve fresh league rows beside stale route pages.

Still outstanding: **`boroughs`** per route. Not in the reference export, because
nothing in the database maps a route to boroughs directly — it would come from
`route_link` or `route_run_stop` against the `borough` table. All-London with no
local lens is the current design, so this is not blocking; with the field present
a "Croydon & Sutton" filter chip becomes a one-line addition. The sample data
deliberately does **not** fake it.

## weekly.json

```jsonc
{
  "version": 0,
  "generated": "2026-09-06T04:00:00Z",
  "week_ending": "2026-09-06",          // Sunday
  "weeks": ["2026-05-17", …],           // every week in the history, oldest first
  "spark_weeks": ["2026-06-21", …],     // the 12 weeks the `spark` arrays cover
  "coverage_threshold": 0.6,
  "holes": [{"start": "2026-07-28", "end": "2026-08-26", "reason": "…"}],
  "attribution": "Contains public sector information licensed under …",
  "window": "weekdays, 07:00-22:00",
  // "sample": true                     // only on generated data — it puts a
                                        // "sample figures" warning on every page
  "summary": {
    "routes": 642, "reporting": 620,
    "median_ewt_min": 1.16,
    "worst_route": "371", "worst_ewt_min": 2.57,
    "best_route": "U8",  "best_ewt_min": 0.19
  },
  "routes": [
    {
      "route": "157",
      "deck": "double",
      "deck_known": true,                // false -> assumed, caption suppressed
      "vehicle_model": "BYD ADL Enviro 400EV City",
      "vehicle_share": 1.0,              // share of the route's observed fleet
      "service_class": "regular",        // regular | night | school
      "frequency_type": "headway",       // headway | timetabled — picks the page's class
      "scheduled_headway_min": 10.8,

      // Route-level figures: the departures-weighted mean across the termini
      // that reported. null when none did — never 0, never omitted.
      "ewt_min": 1.25,                   // null on a timetabled route
      "p_wait_gt10": 0.195,
      "on_time_pct": null,               // the timetabled route's headline instead
      "on_time_window": null,            // "-2.5 to +5 min"; the page words it from this
      "coverage": 0.96,
      "curtailment_rate": 0.0107, "curtailments": 13,

      "delta": -0.02, "delta_from": "2026-07-26", "delta_weeks": 6,
      "spark": [1.25, 1.02, …, null, null, 1.25],   // len == spark_weeks

      "termini": [                       // this week only; history lives in the route file
        {"name": "Crystal Palace Bus Station", "ewt_min": 2.2, "p_wait_gt10": 0.33,
         "worst_gap_min": 41, "departures": 545, "scheduled": 680, "coverage": 0.97}
      ],
      "flags": ["watchlist"]             // "watchlist", "improving" — advisory only
    }
  ]
}
```

## routes/&lt;route&gt;.json

Route files carry **only what is theirs**. `attribution`, `holes`,
`coverage_threshold` and `sample` live once in `weekly.json` and the page reads
them from there — 642 copies of the same paragraph is repo weight and four
places for them to fall out of step. `week_ending` stays, so a half-finished
publish is detectable.

Write these **compact** (no indent). They are generated, never hand-edited, and
at ~640 files rewritten weekly the pretty-printing is a few MB a week of git
history nobody will read. `weekly.json` stays indented — that one is worth
diffing.

```jsonc
{
  "version": 0,
  "route": "157",
  "deck": "double",
  "vehicle_model": "…",
  "week_ending": "2026-09-06",           // must match weekly.json
  "termini": [
    {
      "name": "Crystal Palace Bus Station",
      "series": [                        // one entry per week in weekly.json's `weeks`,
                                         // SAME ORDER, SAME LENGTH — the page indexes
                                         // them positionally against that list
        {"week_ending": "2026-05-17", "ewt_min": 1.42, "p_wait_gt10": 0.21,
         "on_time_pct": null, "curtailment_rate": 0.004, "worst_gap_min": 38,
         "departures": 306, "scheduled": 330, "coverage": 0.96},
        {"week_ending": "2026-08-02", "ewt_min": null, "p_wait_gt10": null,
         "curtailment_rate": null, "worst_gap_min": null,
         "departures": 0, "scheduled": null, "coverage": 0.0}
      ]
    }
  ]
}
```

## Quirks in today's data the front end absorbs

Recorded so nobody "fixes" the page and brings them back. Each is also an ask
below, so the workaround can go.

1. **`spark` runs past `week_ending`.** `spark_weeks` ends 30 August against a
   week ending 26 July, so the last two points are the partial weeks after it.
   The table drops spark weeks after `week_ending`, so each trend line ends on
   the week the table describes.
2. **`spark` carries values for weeks under the publish threshold.** The 157's
   spark has 2.58 for the week ending 5 July at 43% coverage, and 2.12 for
   2 August at 14%. The rule on these pages is that such a week is "no data"
   everywhere, so the table blanks them against coverage.
3. **Termini beyond the real two.** The sweep takes the first stop of every
   `Run` in TfL's `bus-sequences.csv`, so 96 routes list 3–5 termini: short
   workings (87: Vauxhall, Millbank Tower), school journeys, duplicate stop codes
   (184). They never carry a figure, and their `departures` count both real ends
   together. Pages and the league table show only termini that have produced a
   figure in some week, and name the rest in "About this data". **43 routes have
   one end that is never measured** (24, 55 and 77 among them), and **route 38
   has three measured termini**, two with `p_wait_gt10` but no `ewt_min`.
4. **`scheduled` can be below `departures`.** Banstead on the 166: 271 seen,
   147 scheduled. It is the aimed departures buses broadcast, not the timetable,
   so the page no longer prints it as a denominator. "Departures observed" shows
   the count seen, and nothing else.
5. **`worst_gap_min` is capped below 45**, because longer gaps are dropped as
   probable day edges. It still shows, with a tooltip saying so.
6. **`weeks` is not contiguous.** A week the sweep has nothing for is left out of
   the list altogether — 22 Feb 2026, and 9, 16 and 23 Aug 2026 — so 2 Aug and
   30 Aug sit next to each other. The chart now places points by date and shades
   any absent week as "no data"; before that, the August outage simply vanished.

## The v1.0 asks — agreed 14 Sep, and what changed in agreeing them

The back end answered all thirteen (`E:\Road Data\docs\relay-frontend-2026-09-14.md`)
and Neil approved its plan. Every field stays additive and dormant-until-present.
The shapes below are the agreed ones: where the reply changed a name or a rule,
this section now says what was agreed, not what was first asked.

**The big change: waits are measured by direction, at TfL's timing points.** The
38 showed that measuring at a 250 m gate round the first stop of each `Run` is
wrong, not just untidy, and it is not only the 38. Clapton Pond is passed twice
by every bus because the route loops beyond it. Graham Road counts every
through bus both ways. About 40% of "from Victoria" trips never reach Victoria.
112 terminus figures this week rest on fewer than 75% of the departures buses
advertised, and ranks disagree with TfL's by a wide margin: the 58 is our worst
and TfL's 148th, and the 245 is TfL's worst and our 283rd. So ask E ("real
termini only") is superseded, and ask H becomes the foundation:

> Waits are measured at TfL's timing points along the route, per direction, from
> the per-stop journey store, against the GTFS timetable, and checked against
> TfL's quarterly figures before publishing.

Short workings then count wherever they run, a bus turned short is missing where
it should have been, and nothing is counted twice.

### Order of arrival

| # | What | Front end |
|---|---|---|
| 1 | Week ending 13 Sep (merged 14 Sep); ask L's first three items, re-staged shortly | Pages already read both. The league shortcode's on-time spark and delta step aside when the sweep's arrive |
| 2 | Timing-point measure built and checked against TfL — no new fields | Nothing to do |
| 3 | **One publish:** A, C, D, F, M, `directions[]`, Saturday weeks, contiguous weeks, `tfl_quarterly`, `version: 1` | The big front-end rebuild: direction cards, wait bands, worst gap, punctuality split, daily spans, TfL comparison |
| 4 | Later: G, I, H's worst stretch | One block each |

### Directions replace termini on the route page

- **`directions[]` arrives beside `termini[]`.** Cards read "Towards Victoria" and
  "Towards Clapton Pond", labelled from the end stops of Runs 1 and 2. A direction
  with no figure carries `"measured": false`.
- **`termini[]` keeps arriving, frozen on its current basis, until the front end
  confirms it has switched.** Tell the back end when the direction pages ship.
- On switching, the page's "only termini that have produced a figure" filter, the
  "Not measured" note and the league's `where` line built from measured termini
  all retire. The league line under a route number should stay the two ends
  ("Clapton Pond ↔ Victoria"), which the direction labels supply.

### Weeks run Sunday to Saturday

- The Sunday 06:00 run publishes the seven days ending on the Saturday just gone,
  so the data is 1–8 days old.
- **`week_ending` becomes a Saturday**, and every week in `weeks` is re-keyed to
  Saturdays, in the same publish as the new window (A), when every historical
  number changes anyway.
- `weeks` becomes contiguous at the same time: every Saturday listed, empty weeks
  with null cells and `coverage: 0.0`.
- Front end: every date is read from the data, so Saturday keys need no code
  change. The chart's handling of absent weeks becomes a no-op, and the tooltip
  holes window (`week_ending` minus six days) is right for either.

### The weekly run lands on a branch

The run commits each week to `bus-data/<week_ending>` in a separate worktree and
stops. **Nothing reaches the site until that branch is merged into `main`.** If
the pages show an old week, look for an unmerged branch before suspecting the
templates.

---

### A. Measurement window: 05:00–23:59, every day

**Agreed, with the timing-point measure and not before.** On the old method the
45-minute gap cap would quietly drop real early, late and Sunday gaps and flatter
those routes. `window` will read `"every day, 05:00-23:59"`, and `coverage` is
computed on the same basis.

### B. Join the GTFS timetable in the sweep

**Agreed.** Internal, no field. Needs a scheduled-times-per-stop build first.

### C. Waits over 10, 20 and 30 minutes, against the timetable

**Agreed as specified, at timing points, per direction.** The same length-biased
calculation as `p_wait_gt10`, over the observed gaps and over the timetabled gaps
in the same window: `P(wait > X) = Σ max(0, gap − X) / Σ gap`. Also the 95th
percentile of the wait, worded "1 in 20 people wait longer than".

On TfL's Q1 2026/27 figures, waits over 10 minutes track the timetabled frequency
(r = 0.93 with scheduled wait) and barely reflect reliability (0.18 with EWT);
over 30 minutes is mostly reliability (0.71). Hence all three bands, each with
its timetable figure.

**Rule for the front end: never rank on over-30.** At direction level in a single
week it rests on a handful of events. Show it; don't sort a league by it.

```jsonc
// weekly cell, per direction; route-level on the league row
"wait_bands": {
  "10": {"actual": 0.273, "timetable": 0.061},
  "20": {"actual": 0.031, "timetable": 0.002},
  "30": {"actual": 0.006, "timetable": 0.0}
},
"wait_p95_min": 21.5,
// route file only, pooled over the last 4 publishable weeks
"wait_by_band": [
  {"band": "am_peak", "label": "Weekdays 07:00–10:00",
   "p_wait_gt20": 0.042, "p_wait_gt20_timetable": 0.0, "ewt_min": 1.9}
]
```

Bands: early (05–07), AM peak (07–10), inter-peak (10–16), PM peak (16–19),
evening (19–24), Saturday, Sunday.

### D. The worst gap, with when and where

**Agreed, with one added rule:** the gap must also appear at the next timing
point, so one missed ping can't invent it. Gaps overlapping declared holes are
excluded, and day edges come from the timetable. **`terminus` becomes `place`
(a timing point) plus `direction`.**

```jsonc
"worst_gap": {"min": 58, "start": "2026-07-21T17:12:00+01:00",
              "place": "Brixton Station", "direction": "Towards Morden"}
```

### E. Real termini only

**Superseded** by directions (above).

### F. Timetabled routes: the four-way split

**Agreed, measured at timing points** as TfL does — at the stand, layover hides
lateness. **The fourth bucket is `not_run_or_unseen`, worded "didn't run or
wasn't seen"**: a bus with its tracker off looks exactly like one that didn't
run, and TfL's own label is "non arrival or not linked". It ships only once the
back end has measured how often the feed misses buses that did run.

TfL's bands: **on time** 2½ minutes early to 5 late, **early** 2½–8 minutes early,
**late** 5–15 minutes late, **didn't run or wasn't seen** over 15 minutes late or
never seen. Early earns its own figure: a timetabled bus that leaves early strands
the person who arrived on time. (TfL's prose says "two minutes early"; its table
bands and the sweep both use 2½, and the pages follow the bands.)

```jsonc
"punctuality": {"on_time": 0.61, "early": 0.09, "late": 0.22,
                "not_run_or_unseen": 0.08, "timetabled": 412}
```

### G. Journey time against the timetable (later)

**Agreed, later phase.** Measured over the **longest section every full-length
trip shares**, not end to end, because short workings muddle end to end. **Adds
`p90_min` beside the median** — "allow 68 minutes" — because the median
understates what a traveller has to plan for.

```jsonc
"runtime": [{"direction": "Towards Morden", "band": "pm_peak", "from": "…", "to": "…",
             "timetable_min": 48, "actual_min": 61, "p90_min": 68, "ran_share": 0.93}],
"timetable_changes": [{"effective": "2026-03-14", "direction": "Towards Morden", "change_min": 4}]
```

### H. Timing-point EWT, and the worst stretch

**Timing-point EWT is now the core measure: it is simply what `ewt_min` becomes**
(no separate `ewt_timing_points_min`). Expect every figure to move, and the league
to reorder, in the publish that brings it.

**Worst stretch comes later, and only where it survives a split-half check.** The
worst of hundreds of noisy cells is always extreme, so a stretch is named only if
it is also worst or near-worst in the other half of the weeks; otherwise `null`.
The page must treat `null` as "no stretch stands out", not as missing data.

```jsonc
"worst_stretch": {"from": "Brixton Station", "to": "Clapham Common", "band": "evening",
                  "direction": "Towards Morden", "p_wait_gt20": 0.083, "weeks": 4}
```

### I. The last bus (later)

**Agreed, later, without `night_route`.** Night routes are parked, and naming the
one that takes over is identity data: added only where it can be derived, not
guessed.

```jsonc
"last_bus": {"nights": 28, "ran": 26, "left_early": 1,
             "early": [{"date": "2026-07-18", "timetabled": "00:42", "left": "00:38"}]}
```

### J. TfL's own figures, each quarter

**Agreed, owned by the back end, and used first as the check on the new measure.**
Both quarter reports are archived there (TfL's URL is overwritten every quarter),
and the front end's audit scripts are copied into
`platform/prototypes/qsi_audit_frontend/`. `our_ewt_min` is the new measure on TfL's
quarter dates and hours. The pass mark for the new measure: clearly better rank
agreement than today's 0.68–0.73, and the outliers (58, SL5, E8, 245) moving
towards TfL.

```jsonc
"tfl_quarterly": [{"quarter": "2026/27 Q1", "tfl_ewt_min": 1.10, "our_ewt_min": 1.19,
                   "tfl_on_time": null, "our_on_time": null}]
```

### K. Night routes, 00:00–04:59

**Parked.** 24-hour routes keep their daytime figures.

### L. Tidy-ups to today's fields

Being re-staged now:
- `spark` ends at `week_ending` and is `null` under `coverage_threshold`;
- `delta` compares only against a week that cleared the threshold;
- timetabled rows carry `spark` and `delta` of `on_time_pct`. **`flags: "improving"`
  stays an excess-wait judgement only**, so it will not appear on timetabled rows;
- `termini[]` in `weekly.json` carries `on_time_pct`.

With the Saturday re-key: contiguous `weeks`.

### M. Daily figures for the last 35 days

**Agreed, with the new measure.** The route chart will add "Last month" and "Last
week" spans on these.

- `daily.days`: 35 contiguous dates **ending on `week_ending`**, empty days included.
- One series per **direction**, with the same measures as the weekly cells.
- The noise floor is stated in the file: `daily.min_gaps` (frequent) and
  `daily.min_departures` (timetabled). Below it a day is `null`.
- **Daily timetable figures ride alongside.** Weekend timetables are thinner, so
  waits over 10 minutes jump every Saturday and Sunday; without the timetable line
  beside it, every Sunday looks like a bad day. The daily chart must draw both.

```jsonc
"daily": {
  "days": ["2026-08-09", …, "2026-09-12"],
  "min_gaps": 20, "min_departures": 10,
  "coverage": [1.0, 0.92, …],
  "series": [{"direction": "Towards Victoria",
              "p_wait_gt10": […], "p_wait_gt10_timetable": […],
              "ewt_min": […], "on_time_pct": […]}]
}
```

(Illustrative: the exact keys follow whatever the weekly direction cells use.)

## The rules the front end will not break

- **A `null` metric, or `coverage` below `coverage_threshold`, renders as
  "no data".** Never a zero, never a dash, and never ranked as good performance.
  A route that did not report is excluded from "shortest waits" outright rather
  than winning it by absence.
- **Missing weeks break the line.** The timeline never joins across a gap, and
  the sparkline never draws through one.
- **The attribution string appears on every page.** It is taken from the data
  file, so changing it there changes it everywhere.
- **`sample: true` puts a warning on the page.** Drop it the moment the numbers
  are real — and not before.

## Checking a real publish

```bash
cd Neil_Garratt_Hugo_Site
hugo --minify --destination /tmp/check      # NOT --quiet: it hides template errors
```

Then, against `/tmp/check` (never against `public/`, which a running
`hugo server` rewrites):

- `campaigns/bus-performance/index.html` and `bus/157/index.html` exist
- `grep -c "bus" sitemap.xml` → `0`
- the twenty table rows are in the raw HTML before any JavaScript runs
- a route inside the outage shows "no data", not `0.0`
