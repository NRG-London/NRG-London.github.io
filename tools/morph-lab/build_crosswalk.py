#!/usr/bin/env python3
"""Build the OA-basis parent crosswalk for the geography-morph lab.

Reads the ONS OA-to-higher-geography lookup CSV (read-only, lives outside
the repo) and the six frozen labels.json files copied into
static/labs/morph/d/ (the copy, NOT the production static/interactive/...
directory), cross-validates them against each other, and writes a plain
(non-gzipped) JSON crosswalk file mapping each of the 26,369 output areas
to its parent row index in each of five higher tiers: lsoa, ward, pcon,
borough, gla.

stdlib only (csv, json, sys, pathlib). Paths are resolved from this
script's own location so it works when run from anywhere. Re-runnable
idempotently -- it always reads the same inputs and overwrites the same
output file.

Prints one "PASS <check name>" line per assertion/validation performed.
On any failure prints "FAIL <check name>: <detail>" and exits 1. Exits 0
only when every check has passed and the output file has been written.
"""

import csv
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "static" / "labs" / "morph" / "d"
CSV_PATH = Path(r"E:\Crime Data\Shapefiles\london_oa_lookup.csv")
OUTPUT_PATH = DATA_DIR / "oa.parents.json"

NODATA_SENTINEL = 65535  # matches the 16-bit "no data" sentinel used elsewhere in this dataset

# Tiers that are parents of OA (the five tiers stored in the crosswalk output).
PARENT_TIERS = ["lsoa", "ward", "pcon", "borough", "gla"]
ALL_TIERS = ["oa"] + PARENT_TIERS

# tier -> CSV column holding that tier's code.
CSV_COLUMN = {
    "oa": "OA21CD",
    "lsoa": "LSOA21CD",
    "ward": "WD25CD",
    "pcon": "PCON25CD",
    "borough": "LAD22CD",
    "gla": "GLA24CD",
}

EXPECTED_ROW_COUNTS = {
    "oa": 26369,
    "lsoa": 4994,
    "ward": 689,
    "pcon": 75,
    "borough": 33,
    "gla": 14,
}

_passes = []
_failures = []


def check(name, condition, detail=""):
    """Record and print one PASS/FAIL line for a named assertion."""
    if condition:
        _passes.append(name)
        print(f"PASS {name}")
    else:
        _failures.append((name, detail))
        print(f"FAIL {name}: {detail}")


def stop_if_failed():
    """Exit 1 with a summary if any check recorded so far has failed."""
    if _failures:
        print(f"\n{len(_failures)} check(s) FAILED out of {len(_passes) + len(_failures)}.")
        sys.exit(1)


def load_labels(tier):
    path = DATA_DIR / f"{tier}.labels.json"
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def reconstruct_codes(labels):
    """code = codePrefix + str(n).zfill(codeWidth) for each n in codeNums."""
    prefix = labels["codePrefix"]
    width = labels["codeWidth"]
    return [f"{prefix}{n:0{width}d}" for n in labels["codeNums"]]


def main():
    # --- Load labels for all six tiers ---
    labels = {tier: load_labels(tier) for tier in ALL_TIERS}

    # --- Step 1: reconstruct code lists; ASSERT codeNums strictly ascending ---
    codes = {}
    for tier in ALL_TIERS:
        nums = labels[tier]["codeNums"]
        ascending = all(nums[i] < nums[i + 1] for i in range(len(nums) - 1))
        check(f"codes-ascending-{tier}", ascending,
              "" if ascending else "codeNums is not strictly ascending")

        codes[tier] = reconstruct_codes(labels[tier])
        n = len(codes[tier])
        expected = EXPECTED_ROW_COUNTS[tier]
        check(f"row-count-{tier}", n == expected,
              "" if n == expected else f"expected {expected} rows, got {n}")

    stop_if_failed()

    # --- Step 3: read the CSV once; cross-check columns against labels code lists ---
    with CSV_PATH.open("r", encoding="utf-8", newline="") as f:
        csv_rows = list(csv.DictReader(f))

    n_csv = len(csv_rows)
    check("csv-row-count", n_csv == EXPECTED_ROW_COUNTS["oa"],
          "" if n_csv == EXPECTED_ROW_COUNTS["oa"] else f"expected {EXPECTED_ROW_COUNTS['oa']} data rows, got {n_csv}")

    for tier in PARENT_TIERS:
        col = CSV_COLUMN[tier]
        csv_unique_sorted = sorted(set(row[col] for row in csv_rows))
        match = csv_unique_sorted == codes[tier]
        detail = ""
        if not match:
            if len(csv_unique_sorted) != len(codes[tier]):
                detail = f"length mismatch: csv={len(csv_unique_sorted)} labels={len(codes[tier])}"
            else:
                detail = "element-wise mismatch"
        check(f"csv-column-match-{tier}", match, detail)

    csv_oa_sorted = sorted(row["OA21CD"] for row in csv_rows)
    oa_match = csv_oa_sorted == codes["oa"]
    check("csv-oa-match", oa_match,
          "" if oa_match else "sorted CSV OA21CD list != oa labels code list")

    stop_if_failed()

    # --- Step 4: build code -> row index dicts per parent tier; index CSV by OA21CD ---
    parent_index = {
        tier: {code: i for i, code in enumerate(codes[tier])}
        for tier in PARENT_TIERS
    }
    csv_by_oa = {row["OA21CD"]: row for row in csv_rows}
    check("csv-oa-unique", len(csv_by_oa) == n_csv,
          "" if len(csv_by_oa) == n_csv else "duplicate OA21CD values in CSV")

    stop_if_failed()

    n_oa = len(codes["oa"])
    parents = {tier: [None] * n_oa for tier in PARENT_TIERS}

    missing_oa = []
    for oa_row, oa_code in enumerate(codes["oa"]):
        csv_row = csv_by_oa.get(oa_code)
        if csv_row is None:
            missing_oa.append(oa_code)
            continue
        for tier in PARENT_TIERS:
            parent_code = csv_row[CSV_COLUMN[tier]]
            parents[tier][oa_row] = parent_index[tier][parent_code]

    check("all-oa-found-in-csv", not missing_oa,
          "" if not missing_oa else f"{len(missing_oa)} OA codes from labels missing in CSV")

    stop_if_failed()

    # --- Step 5: cross-validate ---
    # NOTE ON INDEX SPACES: the brief describes each tier's `lad` array as
    # "borough row indices, aligned to that tier's rows" -- i.e. directly
    # comparable to parents["borough"], which is built from `borough`'s own
    # codeNums-sorted row order (the order borough.geom.bin etc. use). In
    # practice `lad[i]` is an index into that SAME tier's own `ladNames`
    # array, which is sorted ALPHABETICALLY by borough name -- a different
    # index space from borough.labels.json's code-sorted rows (borough row 0
    # is "City of London", code E09000001, not alphabetically first). Direct
    # index comparison therefore fails for every OA whose borough's
    # alphabetical position differs from its code-sorted position (5,158 of
    # 26,369 for the oa/borough case) even though the underlying OA<->borough
    # assignment is identical. Verified independently: translating lad
    # indices through each tier's own `ladNames` to a borough NAME, then to
    # borough.labels.json's own row via `borough.names`, gives 0 mismatches
    # against the CSV-built crosswalk across all three checks below. That
    # name-translated comparison is what is implemented here, since it is
    # the check that actually validates intent.
    borough_name_to_row = {name: i for i, name in enumerate(labels["borough"]["names"])}

    def lad_as_borough_row(tier, tier_row):
        """Resolve a `lad` index recorded on a tier row to borough.labels.json's own row order."""
        lad_names = labels[tier]["ladNames"]
        lad_idx = labels[tier]["lad"][tier_row]
        return borough_name_to_row[lad_names[lad_idx]]

    oa_lad_rows = [lad_as_borough_row("oa", i) for i in range(n_oa)]
    borough_match = parents["borough"] == oa_lad_rows
    check("crosswalk-borough-matches-oa-lad", borough_match,
          "" if borough_match else "parents['borough'] != oa.labels.lad (translated via ladNames/borough.names)")

    lsoa_consistent = all(
        lad_as_borough_row("lsoa", parents["lsoa"][i]) == parents["borough"][i]
        for i in range(n_oa)
    )
    check("crosswalk-lsoa-lad-consistent", lsoa_consistent,
          "" if lsoa_consistent else "lsoa.labels.lad disagrees with the borough parent for some OA")

    ward_consistent = all(
        lad_as_borough_row("ward", parents["ward"][i]) == parents["borough"][i]
        for i in range(n_oa)
    )
    check("crosswalk-ward-lad-consistent", ward_consistent,
          "" if ward_consistent else "ward.labels.lad disagrees with the borough parent for some OA")

    for tier in PARENT_TIERS:
        vals = parents[tier]
        bounded = all(v < NODATA_SENTINEL for v in vals)
        check(f"parent-index-bounds-{tier}", bounded,
              "" if bounded else f"a parent index in {tier} is >= {NODATA_SENTINEL}")

        n_tier = EXPECTED_ROW_COUNTS[tier]
        full_range = set(range(n_tier))
        covered = set(vals) == full_range
        detail = ""
        if not covered:
            missing = full_range - set(vals)
            extra = set(vals) - full_range
            detail = f"{len(missing)} orphan parent row(s), {len(extra)} out-of-range value(s)"
        check(f"parent-index-coverage-{tier}", covered, detail)

    stop_if_failed()

    # --- Step 6: write output (plain JSON, compact separators) ---
    output = {
        "basis": "oa",
        "n": n_oa,
        "source": "london_oa_lookup.csv",
        "parents": {tier: parents[tier] for tier in PARENT_TIERS},
    }
    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(output, f, separators=(",", ":"))

    check("output-written", OUTPUT_PATH.exists(), "")

    stop_if_failed()

    print(f"\n{len(_passes)} check(s) PASSED. Wrote {OUTPUT_PATH}")
    sys.exit(0)


if __name__ == "__main__":
    main()
