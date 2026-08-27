# Bus performance data contract — v0.3

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
