#!/usr/bin/env python3
"""Generate SAMPLE bus performance METRICS for the unlisted bus pages.

This exists so the front end can be built, styled and reviewed before the real
weekly pipeline in `E:\\Road Data` emits anything. It writes files that match the
published data contract exactly, so swapping in real artifacts is a file copy and
nothing else changes.

WHAT IS REAL HERE AND WHAT IS NOT
---------------------------------
**Route identity is real.** The route list, the display names, both termini, the
service class, the deck and the vehicle model all come from
`data/bus/reference.json`, exported from the actual database by
`export_bus_reference.py`. Run that first.

**Every number is invented.** Excess wait, P(wait>10), coverage, departures,
curtailment — all sampled, none measured.

The first version of this script invented the identity too, and the result was a
page that looked right and was wrong in detail: SL7 drawn as a single-decker
between two places it does not serve. A reader cannot be expected to treat a
route number and its termini as placeholder, however clearly the numbers beside
them are labelled as samples. So identity is real and only the metrics are not.

    python scripts/make_bus_sample.py             # 17 weeks, all 642 routes
    python scripts/make_bus_sample.py --weeks 60  # the shape once the backfill lands

What it writes (both are Hugo data files, consumed at build time and never
copied into public/):

    data/bus/weekly.json          one row per route for the latest week
    data/bus/routes/<route>.json  per-terminus weekly history for that route

THE THINGS THAT MATTER, and why the sample deliberately contains them
--------------------------------------------------------------------
* A **collection hole**, 28 Jul - 26 Aug 2026. Real and unrecoverable: the NDL
  archive server was down for that month, and no amount of backfill brings it
  back. Every week inside it carries `coverage: 0.0` and `null` metrics, and
  must render as "no data" - never as a zero and never as good performance. If
  the page ever shows 0.0 there, the page is wrong.
  It currently sits immediately before the present week, which is the worst
  place it could be and the hardest case for the rendering; it recedes into the
  past week by week from here.
* **Good, bad and no-data routes** in the same table, so the three treatments can
  be compared side by side without hunting for an example.
* Realistic magnitudes, from the Jun-Jul 2026 measurements in
  `docs/bus-performance-methodology.md` s4: EWT 0.3-2.2 min (433 best, 157
  worst), P(wait>10) 0.18-0.33, curtailment 0-1.5%, ~85-95 departures per day
  per terminus, scheduled headways 10-12 min.

Deterministic: same seed, same numbers, so a rebuild never produces a spurious
git diff.
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import date, timedelta
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
DATA = SITE / "data" / "bus"
REFERENCE = DATA / "reference.json"

SEED = 20260827
# The first fully-collected week after the 28 Jul - 26 Aug outage: live capture
# started 27 Aug, so 31 Aug - 6 Sep is the first week we can stand behind. That
# puts a five-week hole immediately before the current week, which is exactly
# the shape the page will have when it first goes live - and the hardest case
# for the "no data" rendering to get right.
WEEK_ENDING = date(2026, 9, 6)           # a Sunday
COVERAGE_THRESHOLD = 0.60
SPARK_WEEKS = 12

ATTRIBUTION = ("Contains public sector information licensed under the Open Government "
               "Licence v3.0; bus location data via the DfT Bus Open Data Service and "
               "Transport for London.")

# Known collection outages. The front end draws these as labelled bands rather
# than inferring a gap from missing weeks - inference cannot tell "we did not
# collect" from "the route did not run".
HOLES = [
    {"start": "2026-02-16", "end": "2026-02-27",
     "reason": "Archive collection outage - no data was captured"},
    {"start": "2026-07-28", "end": "2026-08-26",
     "reason": "Archive collection outage - no data was captured"},
]

# Terminus names, decks, models and the route list itself all come from
# reference.json now. Nothing about a route's identity is generated here.


def sundays(n: int, last: date) -> list[str]:
    """The n week-ending Sundays up to and including `last`, oldest first."""
    return [(last - timedelta(weeks=i)).isoformat() for i in range(n - 1, -1, -1)]


def in_hole(week_ending: str) -> bool:
    """True if an outage covers any day of this week.

    Deliberately generous: a week that is only half collected is not a week we
    are willing to publish an average for.
    """
    end = date.fromisoformat(week_ending)
    start = end - timedelta(days=6)
    for h in HOLES:
        hs, he = date.fromisoformat(h["start"]), date.fromisoformat(h["end"])
        if start <= he and end >= hs:
            return True
    return False


def route_sort_key(route: str) -> tuple:
    """Natural order: 9 before 18, letter-prefixed routes grouped after the numbers.

    `ngbus-table.js` sorts with the same rule. If you change one, change both, or
    the server-rendered rows and the JS-sorted rows will disagree.
    """
    head = "".join(c for c in route if c.isalpha())
    tail = "".join(c for c in route if c.isdigit())
    return (head != "", head, int(tail) if tail else 0)


def load_reference() -> dict:
    if not REFERENCE.exists():
        raise SystemExit(
            f"No {REFERENCE}.\n"
            "Run `python scripts/export_bus_reference.py` first — it pulls the real "
            "route list, termini and fleet from the bus database. Sample metrics are "
            "fine; invented route identity is not."
        )
    ref = json.loads(REFERENCE.read_text(encoding="utf-8"))
    ref["routes"] = sorted(ref["routes"], key=lambda r: route_sort_key(r["route"]))
    return ref


def build(weeks: int) -> None:
    rng = random.Random(SEED)
    ref_file = load_reference()
    reference = ref_file["routes"]
    week_list = sundays(weeks, WEEK_ENDING)
    last = len(week_list) - 1

    rows = []
    (DATA / "routes").mkdir(parents=True, exist_ok=True)
    for stale in (DATA / "routes").glob("*.json"):
        stale.unlink()

    for ref in reference:
        route = ref["route"]
        deck = ref["deck"]
        model = ref["vehicle_model"]

        # Each route holds a quality level across the period with week-to-week
        # noise on top: regularity is a property of the route, not the week.
        base_ewt = round(rng.triangular(0.3, 2.4, 1.0), 2)
        drift = rng.uniform(-0.030, 0.030)          # minutes per week
        headway = round(rng.uniform(7.0, 14.0), 1)

        termini_names = ref["termini"]
        # Small per-terminus offset: both ends of a route track each other.
        offsets = [round(rng.uniform(-0.35, 0.35), 2) for _ in termini_names]

        # A few routes simply are not reporting this week - a gate that needs
        # revisiting, or a route that did not run. They must not rank as "best".
        dark = rng.random() < 0.035

        history = []
        for name, off in zip(termini_names, offsets):
            series = []
            for i, week in enumerate(week_list):
                if in_hole(week):
                    series.append({"week_ending": week, "ewt_min": None,
                                   "p_wait_gt10": None, "curtailment_rate": None,
                                   "worst_gap_min": None, "departures": 0,
                                   "scheduled": None, "coverage": 0.0})
                    continue
                back = last - i
                ewt = max(0.15, round(base_ewt + off - drift * back + rng.gauss(0, 0.16), 2))
                # P(wait>10) rises with EWT and with headway. Anchored so a 10-12
                # min headway at EWT ~1.0 lands near the measured 0.20.
                p = 0.10 + 0.085 * ewt + 0.011 * (headway - 10) + rng.gauss(0, 0.012)
                p = min(0.62, max(0.04, round(p, 3)))
                scheduled = int(round(15 * 60 / headway)) * 5   # 07:00-22:00, 5 weekdays
                coverage = round(min(0.99, rng.triangular(0.86, 0.99, 0.97)), 2)
                series.append({
                    "week_ending": week,
                    "ewt_min": ewt,
                    "p_wait_gt10": p,
                    "curtailment_rate": round(max(0.0, rng.gauss(0.004, 0.004)), 4),
                    "worst_gap_min": int(round(headway * rng.uniform(2.4, 4.2))),
                    "departures": int(scheduled * coverage * rng.uniform(0.93, 1.01)),
                    "scheduled": scheduled,
                    "coverage": coverage,
                })
            history.append({"name": name, "series": series})

        if dark:
            for terminus in history:
                terminus["series"][-1].update(
                    {"ewt_min": None, "p_wait_gt10": None, "curtailment_rate": None,
                     "worst_gap_min": None, "departures": 0,
                     "coverage": round(rng.uniform(0.0, 0.4), 2)})

        # Route files carry only what is theirs. The attribution string, the
        # outage list, the coverage threshold and the sample flag live once in
        # weekly.json and are read from there - 642 copies of the same paragraph
        # is both repo weight and four places for them to fall out of step.
        # `week_ending` stays, so a half-finished publish is detectable.
        #
        # Written compact: these are generated, never hand-edited, and at ~600
        # files rewritten every week the pretty-printing is about 3 MB a week of
        # git history that nobody will ever read. weekly.json stays indented,
        # because that one IS worth reading a diff of.
        (DATA / "routes" / f"{route}.json").write_text(json.dumps({
            "version": 0,
            "route": route,
            "deck": deck,
            "deck_known": ref.get("deck_known", True),
            "vehicle_model": model,
            "vehicle_share": ref.get("vehicle_share"),
            "service_class": ref.get("service_class"),
            "week_ending": WEEK_ENDING.isoformat(),
            "termini": history,
        }, separators=(",", ":")), encoding="utf-8")

        # ---- the league table row ----------------------------------------
        # Route-level figures are the departures-weighted mean of the termini
        # that reported. Both ends of a route track each other (methodology s4),
        # so a mean is honest; the route page shows each end separately anyway.
        def week_row(idx, history=history):
            cells = [t["series"][idx] for t in history]
            good = [c for c in cells if c["ewt_min"] is not None
                    and c["coverage"] >= COVERAGE_THRESHOLD]
            if not good:
                return None, None, round(sum(c["coverage"] for c in cells) / len(cells), 2)
            weight = sum(c["departures"] for c in good) or len(good)
            ewt = sum(c["ewt_min"] * (c["departures"] or 1) for c in good) / weight
            p = sum(c["p_wait_gt10"] * (c["departures"] or 1) for c in good) / weight
            return round(ewt, 2), round(p, 3), round(sum(c["coverage"] for c in good) / len(good), 2)

        ewt_now, p_now, cov_now = week_row(last)
        spark_from = max(0, last - SPARK_WEEKS + 1)
        spark = [week_row(i)[0] for i in range(spark_from, last + 1)]

        # Movement against roughly four weeks ago. The comparison week is named
        # rather than assumed: four weeks back can land inside an outage, and a
        # hole must never masquerade as an improvement. Walk back to the most
        # recent week that actually reported, and publish which week that was so
        # the page can label it honestly instead of claiming "vs 4 weeks ago".
        delta = delta_from = delta_weeks = None
        if ewt_now is not None:
            for i in range(last - 4, -1, -1):
                then = week_row(i)[0]
                if then is not None:
                    delta = round(ewt_now - then, 2)
                    delta_from = week_list[i]
                    delta_weeks = last - i
                    break

        flags = []
        if ewt_now is not None and ewt_now >= 2.0:
            flags.append("watchlist")
        if delta is not None and delta <= -0.4:
            flags.append("improving")

        rows.append({
            "route": route,
            "deck": deck,
            "deck_known": ref.get("deck_known", True),
            "vehicle_model": model,
            "vehicle_share": ref.get("vehicle_share"),
            "service_class": ref.get("service_class"),
            "ewt_min": ewt_now,
            "p_wait_gt10": p_now,
            "coverage": cov_now,
            "delta": delta,
            "delta_from": delta_from,
            "delta_weeks": delta_weeks,
            "spark": spark,
            "termini": [{"name": t["name"],
                         **{k: v for k, v in t["series"][-1].items() if k != "week_ending"}}
                        for t in history],
            "flags": flags,
        })

    reporting = sorted((r for r in rows if r["ewt_min"] is not None),
                       key=lambda r: r["ewt_min"])

    (DATA / "weekly.json").write_text(json.dumps({
        "version": 0,
        "generated": f"{WEEK_ENDING.isoformat()}T04:00:00Z",
        "week_ending": WEEK_ENDING.isoformat(),
        "weeks": week_list,
        "spark_weeks": week_list[max(0, last - SPARK_WEEKS + 1):],
        "coverage_threshold": COVERAGE_THRESHOLD,
        "holes": HOLES,
        "attribution": ATTRIBUTION,
        "sample": True,
        "window": "weekdays, 07:00-22:00",
        # Route identity is real even while the metrics are not; dating it
        # separately is how the page can say so without implying the numbers
        # are real too.
        "reference": {
            "route_feed_date": ref_file.get("route_feed_date"),
            "fleet_snapshot_date": ref_file.get("fleet_snapshot_date"),
            "source": ref_file.get("source"),
        },
        "summary": {
            "routes": len(rows),
            "reporting": len(reporting),
            "median_ewt_min": reporting[len(reporting) // 2]["ewt_min"] if reporting else None,
            "worst_route": reporting[-1]["route"] if reporting else None,
            "worst_ewt_min": reporting[-1]["ewt_min"] if reporting else None,
            "best_route": reporting[0]["route"] if reporting else None,
            "best_ewt_min": reporting[0]["ewt_min"] if reporting else None,
        },
        "routes": rows,
    }, indent=1), encoding="utf-8")

    lost = sum(1 for w in week_list if in_hole(w))
    print(f"{len(rows)} routes, {len(week_list)} weeks "
          f"({week_list[0]} to {week_list[-1]}), {lost} lost to outages, "
          f"{len(rows) - len(reporting)} routes not reporting this week")
    print(f"  {DATA / 'weekly.json'}")
    print(f"  {DATA / 'routes'}\\*.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    # 17 weeks reaches back to 11 May 2026, which is as far as the archive
    # backfill had got by 27 Aug. Another ~312 days are still downloading, so
    # pass --weeks 60 to see how the chart and the sparkline behave once the
    # series is long and the July hole is a long way from the right-hand edge.
    ap.add_argument("--weeks", type=int, default=17,
                    help="weeks of history to generate (default 17)")
    build(ap.parse_args().weeks)
