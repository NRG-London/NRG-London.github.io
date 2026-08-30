# Bus performance data contract — v0.9

**What the website expects, so the pipeline in `E:\Road Data` can write it.**
Written 27 Aug 2026 by the front-end build, against the draft contract in that
repo's `HANDOVER-bus-website.md`. The front end is complete and running on
sample data generated to this spec by `scripts/make_bus_sample.py` — the fastest
way to see what a field is for is to read that script and the page it feeds.

**Nothing outside this repo writes code into the site.** The bus engine
(`static/js/ngbus-*.js`, `static/css/ngbus.css`, the layouts and shortcodes) is
maintained here. `E:\Road Data` writes **data files only** — which is the one
thing the rail project's chartkit does differently, and the reason it needs a
hash guard to stop its publish clobbering the crime charts.

## Where the files go

```
<hugo>/data/bus/weekly.json          the league table: one row per route, latest week
<hugo>/data/bus/routes/<route>.json  per-terminus weekly history, one file per route
<hugo>/data/bus/reference.json       route identity — STOPGAP, see below
```

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

## reference.json — the stopgap, and why it exists

The first prototype invented route identity as well as the numbers: route lists,
terminus pairs, decks and models were all sampled at random. That produced a page
that looked right and was wrong in detail — SL7 shown as a single-decker between
two places it does not serve — and it was spotted within a minute of looking.

The lesson: **a reader will forgive invented numbers when they are labelled, and
will not forgive invented identity.** A route number and its termini read as
fact whatever the caveat above them says.

So `scripts/export_bus_reference.py` now pulls identity straight out of
`buses.duckdb` (read-only) into `data/bus/reference.json`, and
`make_bus_sample.py` fabricates only the metrics. The queries it uses are the
ones the weekly sweep should absorb:

```sql
-- termini and service class: one row per route
select route_id, service_class, origin, destination from route
where origin is not null and destination is not null;      -- 642 of 811

-- deck and model: dominant model in the latest observation window
with latest as (select route_id, max(window_end) w from route_fleet group by 1)
select rf.route_id, m.deck, m.manufacturer, m.model_name, rf.share
from route_fleet rf
join latest l on l.route_id = rf.route_id and l.window_end = rf.w
join model m using (model_id);                             -- 612 of 642 have a fleet
```

**169 routes have no origin/destination in the feed** — mostly school services.
They are excluded: a terminus-gate method has nothing to measure at a route with
no terminus. If they should appear anyway, say so and they can be listed as
permanently unmeasured.

**Once the weekly sweep emits `deck`, `vehicle_model`, `service_class` and
`termini` itself, this file and its exporter retire.**

## Gaps are permanent, and the page now has three treatments for them

The source has been down for a month, for a single day (TfL sent BODS nothing),
and for part of a day. That is not a run of bad luck to be waited out — it is
what this data is like. The front end therefore distinguishes three states
rather than two:

| State | How it arrives | How it draws |
|---|---|---|
| **Nothing** | `null` metrics, `coverage` under `coverage_threshold` | "no data" in tables; the line breaks; never a zero |
| **Thin** | metrics present, `coverage` under 0.9 | a pale column behind the plot, "thin" beside the figure in the weekly table, and the exact coverage in the chart tooltip |
| **Declared outage** | the date range appears in `holes` | a stronger band, labelled "no data", plus a named note under the page |

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

**The thin threshold stays at 0.9.** With coverage measured properly it now
marks 6.8% of cells rather than 39%, and 52% sit at exactly 1.0. It is doing what
it was meant to do — the earlier figure was measuring the old heuristic.

## Curtailments — the front end is built and waiting

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

## Headway routes and timetabled routes are two different measurements

**Excess wait time only means anything on a high-frequency route.** Where buses
run every 20 minutes or less, a rider turns up and waits, and EWT is the right
number. Where they run to a published timetable — the S4 and its like — a rider
consults the timetable and turns up for a departure, and the question is not
"how long did I wait" but "did it go when it said it would". The right metric
there is on-time percentage against the timetable.

This is not a refinement to file for later. It is currently visible on the live
page: 30 routes report a **negative** excess wait, down to −3.75 minutes on the
166, all at 98% coverage. A negative EWT is EWT being computed on a population it
does not describe, and because the league table sorts on it, "shortest waits"
currently ranks the routes where the metric applies least.

What the front end needs, once the backend separates them:

```jsonc
{
  "route": "S4",
  "frequency_type": "timetabled",   // "headway" | "timetabled"
  "ewt_min": null,                  // null on a timetabled route, NOT computed
  "p_wait_gt10": null,
  "on_time_pct": 0.86,              // the timetabled equivalent
  "on_time_window": "-1 to +5 min"  // what "on time" counted as
}
```

Given `frequency_type`, the page can rank the two populations separately rather
than pretending one number covers both, and a timetabled route's page can lead
with punctuality instead of a wait it cannot honestly quote. Until the field
exists the front end has no way to tell the two apart, so it shows what it is
given — which is the right behaviour, and the reason the problem is visible at
all.

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
  "sample": true,                       // OMIT on real data — it drives the "sample
                                        // figures, not measurements" warning
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

      // Route-level figures: the departures-weighted mean across the termini
      // that reported. null when none did — never 0, never omitted.
      "ewt_min": 1.25,
      "p_wait_gt10": 0.195,
      "coverage": 0.96,

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
         "curtailment_rate": 0.004, "worst_gap_min": 38,
         "departures": 306, "scheduled": 330, "coverage": 0.96},
        {"week_ending": "2026-08-02", "ewt_min": null, "p_wait_gt10": null,
         "curtailment_rate": null, "worst_gap_min": null,
         "departures": 0, "scheduled": null, "coverage": 0.0}
      ]
    }
  ]
}
```

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
