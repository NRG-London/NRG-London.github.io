#!/usr/bin/env python3
"""Export real route identity from the bus database into the site.

Writes `data/bus/reference.json`: for every London bus route, its display name,
its two termini, whether it is a day/night/school service, and the deck and
model of the buses that actually run it.

WHY THIS EXISTS
---------------
The first prototype invented all of this — route numbers, terminus pairs, decks
and models were drawn at random by `make_bus_sample.py`, because the brief was
to build the front end against sample data. That produced a page which looked
right and was wrong in detail: SL7 shown as a single-decker between two places
it does not serve. Identity is not something a reader can be expected to treat
as placeholder, even when the numbers beside it obviously are.

So identity now comes from the real data and only the *metrics* are sampled.

STOPGAP. Once the weekly sweep in `E:\\Road Data` runs, it should emit these
fields in `weekly.json` itself (see `BUS-DATA-CONTRACT.md`) and this script
retires. Until then it is run by hand, on the machine that holds the database.

SOURCES, all read-only
----------------------
`E:\\Road Data\\platform\\buses.duckdb`:
  route         one row per route_id — service_class, origin, destination.
                `service_class` is the field to trust: the TfL Line API labels
                every route "Regular", night buses included, so `service_type`
                cannot tell a night bus from a day one.
  route_fleet   route -> model, with a vehicle count and share, per observation
                window. This is what makes the deck knowable: the fleet audit
                itself has NO route column, so the link runs through the
                vehicles actually seen working each route.
  model         deck, manufacturer, model name.

Usage:
    python scripts/export_bus_reference.py
    ROAD_DATA_DIR="E:/Road Data" python scripts/export_bus_reference.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
OUT = SITE / "data" / "bus" / "reference.json"
ROAD_DATA = Path(os.environ.get("ROAD_DATA_DIR", r"E:\Road Data"))
DB = ROAD_DATA / "platform" / "buses.duckdb"

# The database stores model names title-cased, which mangles the initialisms
# every Londoner sees written in full on the back of the bus. Cosmetic only —
# nothing is matched or joined on the display string.
ACRONYMS = {
    "Adl": "ADL", "Mmc": "MMC", "Ev": "EV", "Byd": "BYD", "Bev": "BEV",
    "Nrm": "NRM", "Rm": "RM", "Ukbus": "UKBus", "Lt": "LT",
    "Wf": "WF", "Wl": "WL", "Df": "DF", "Hev": "HEV", "Sr": "SR",
    "Mcv": "MCV", "Bmc": "BMC", "Vdl": "VDL", "Man": "MAN",
    "Streetlite": "StreetLite", "Streetdeck": "StreetDeck",
    "Evoseti": "EvoSeti", "Citaro": "Citaro",
}

# Manufacturers that also appear as their own initialism in the model name.
# "Alexander Dennis" + "Adl Enviro 400" is the same maker twice over.
MAKER_ALIASES = {
    "Alexander Dennis": {"ADL", "AD"},
    "Wrightbus": {"WRIGHT", "WRIGHTBUS"},
    "Mercedes-Benz": {"MERCEDES", "MB"},
}


def tidy_model(manufacturer: str | None, model_name: str | None) -> str | None:
    """A readable model label: "BYD ADL Enviro 400EV City"."""
    if not model_name:
        return manufacturer or None
    name = " ".join(ACRONYMS.get(w, w) for w in model_name.split())
    # Initialisms the word-wise pass cannot see, because they are welded to a
    # number or wrapped in brackets: "400Ev City", "(Ev)".
    name = re.sub(r"(\d)Ev\b", r"\1EV", name)
    name = name.replace("(Ev)", "(EV)")
    if not manufacturer:
        return name
    # "Alexander Dennis" + "Adl Enviro 400H Mmc" would read "Alexander Dennis
    # ADL Enviro …" — the same maker twice, once in full and once as its
    # initials. Drop the redundant head.
    aliases = {manufacturer.upper(),
               "".join(w[0] for w in manufacturer.split()).upper()}
    aliases |= MAKER_ALIASES.get(manufacturer, set())
    head = name.split()[0]
    if head.upper() in aliases and len(name.split()) > 1:
        name = " ".join(name.split()[1:])
    if name.upper().startswith(manufacturer.upper()):
        return name
    return f"{manufacturer} {name}"


def main() -> int:
    try:
        import duckdb
    except ImportError:
        print("duckdb is not installed here. pip install duckdb")
        return 2

    if not DB.exists():
        print(f"No database at {DB}. Set ROAD_DATA_DIR if it lives elsewhere.")
        return 2

    try:
        con = duckdb.connect(str(DB), read_only=True)
    except Exception as exc:                       # noqa: BLE001 - reported, not handled
        # DuckDB is single-writer; a running ingest holds the file.
        print(f"Could not open the database read-only: {exc}")
        return 1

    feed_date, snapshot = con.execute(
        "select max(feed_date), (select max(snapshot_date) from route_fleet) from route"
    ).fetchone()

    # The dominant model per route, from the most recent observation window.
    # Mixed routes take the majority; `share` is published so the page can say
    # "usually" honestly rather than implying uniformity.
    rows = con.execute("""
        with latest as (
            select route_id, max(window_end) as window_end
            from route_fleet group by route_id
        ),
        ranked as (
            select rf.route_id, m.deck, m.manufacturer, m.model_name,
                   rf.vehicle_count, rf.share,
                   row_number() over (
                       partition by rf.route_id
                       order by rf.share desc, rf.vehicle_count desc, m.model_id
                   ) as rn
            from route_fleet rf
            join latest l on l.route_id = rf.route_id and l.window_end = rf.window_end
            join model m using (model_id)
        )
        select r.route_id, r.service_class, r.origin, r.destination,
               ranked.deck, ranked.manufacturer, ranked.model_name,
               ranked.vehicle_count, ranked.share
        from route r
        left join ranked on ranked.route_id = r.route_id and ranked.rn = 1
        where r.origin is not null and r.destination is not null
        order by r.route_id
    """).fetchall()

    skipped = con.execute(
        "select count(*) from route where origin is null or destination is null"
    ).fetchone()[0]
    con.close()

    routes = []
    no_fleet = 0
    for route_id, service_class, origin, dest, deck, maker, model, count, share in rows:
        if not deck:
            no_fleet += 1
        routes.append({
            "route": route_id,
            "service_class": service_class,
            "termini": [origin, dest],
            # Default to a double-decker when the fleet is unknown: it is the
            # commoner London bus, and the illustration has to draw something.
            "deck": deck or "double",
            "deck_known": bool(deck),
            "vehicle_model": tidy_model(maker, model),
            "vehicle_share": round(share, 3) if share is not None else None,
            "vehicle_count": count,
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "version": 0,
        "source": "TfL route feed and fleet audit, via the Road Data project's buses.duckdb",
        "route_feed_date": str(feed_date),
        "fleet_snapshot_date": str(snapshot),
        "routes": routes,
    }, indent=1, ensure_ascii=False), encoding="utf-8")

    decks = {}
    classes = {}
    for r in routes:
        decks[r["deck"]] = decks.get(r["deck"], 0) + 1
        classes[r["service_class"]] = classes.get(r["service_class"], 0) + 1

    print(f"{len(routes)} routes -> {OUT}")
    print(f"  route feed {feed_date}, fleet snapshot {snapshot}")
    print(f"  service class: {classes}")
    print(f"  deck: {decks} ({no_fleet} assumed double, no fleet observed)")
    print(f"  skipped {skipped} routes with no origin/destination in the feed "
          f"(mostly school services) — a terminus-gate method has nothing to "
          f"measure at a route with no terminus")
    return 0


if __name__ == "__main__":
    sys.exit(main())
