# Task 1 (M0) — Report

Status: DONE_WITH_CONCERNS (one factual correction to the brief was needed; see Deviations below — no scope was skipped, everything specified was implemented and verified).

Commit: `a9d0baf` on branch `labs/morph` — "Morph lab M0: workbench + OA parent crosswalk"

## What was done

### 1. Directories + data copy
- Created `static\labs\morph\`, `static\labs\morph\d\`, `tools\morph-lab\`.
- Copied all 69 files from `static\interactive\london-population\d\` into `static\labs\morph\d\` (`cp -p`, preserving mtimes).
- Verified: source count = 69, destination count (before the crosswalk script ran) = 69, `diff -q` between the two directories reported **no differences** (byte-identical).

### 2. Hub page — `static\labs\morph\index.html`
Plain self-contained HTML, 1,247 bytes (well under the ~3 KB budget). Contains:
- `<title>[LAB] Geography-morph workbench</title>`
- `<meta name="robots" content="noindex, nofollow">`
- `<meta name="viewport" content="width=device-width, initial-scale=1">`
- An h1, a paragraph stating it's a temporary prototype workbench for morphing between geography levels on the census map, and a three-item list linking to `v0/`, `v1/`, `v2/` with the exact one-line descriptions from the brief.
- `<section id="notes"><h2>Checklist notes</h2></section>` placeholder.
- One small inline `<style>` block, dark theme, no external assets.
- Links to `v0/`, `v1/`, `v2/` point to pages that don't exist yet — correct per the brief.

### 3. Crosswalk builder — `tools\morph-lab\build_crosswalk.py`
Python 3, stdlib only (`csv`, `json`, `sys`, `pathlib`). Repo root resolved via `Path(__file__).resolve().parents[2]`. Reads `E:\Crime Data\Shapefiles\london_oa_lookup.csv` (read-only, untouched) and the six `*.labels.json` files from the **copy** at `static\labs\morph\d\` (not production). Implements the algorithm exactly as specified in steps 1–4 and 6 of the brief. Verified idempotent: ran the script twice back-to-back and diffed stdout — identical output both times, and the output file is fully overwritten each run.

## Complete crosswalk-script output (all PASS, exit 0)

```
PASS codes-ascending-oa
PASS row-count-oa
PASS codes-ascending-lsoa
PASS row-count-lsoa
PASS codes-ascending-ward
PASS row-count-ward
PASS codes-ascending-pcon
PASS row-count-pcon
PASS codes-ascending-borough
PASS row-count-borough
PASS codes-ascending-gla
PASS row-count-gla
PASS csv-row-count
PASS csv-column-match-lsoa
PASS csv-column-match-ward
PASS csv-column-match-pcon
PASS csv-column-match-borough
PASS csv-column-match-gla
PASS csv-oa-match
PASS csv-oa-unique
PASS all-oa-found-in-csv
PASS crosswalk-borough-matches-oa-lad
PASS crosswalk-lsoa-lad-consistent
PASS crosswalk-ward-lad-consistent
PASS parent-index-bounds-lsoa
PASS parent-index-coverage-lsoa
PASS parent-index-bounds-ward
PASS parent-index-coverage-ward
PASS parent-index-bounds-pcon
PASS parent-index-coverage-pcon
PASS parent-index-bounds-borough
PASS parent-index-coverage-borough
PASS parent-index-bounds-gla
PASS parent-index-coverage-gla
PASS output-written

35 check(s) PASSED. Wrote C:\Users\neilg\OneDrive\Documents\neilgarratt.com\Neil_Garratt_Hugo_Site\static\labs\morph\d\oa.parents.json
EXIT CODE: 0
```

35 checks total. Beyond the checks the brief explicitly enumerates (codes-ascending per tier, CSV-column-match per tier, csv-oa-match, the three cross-validation checks, and the index-bounds/coverage check), I added a handful of defensive assertions in the same spirit (`row-count-<tier>` against the brief's stated expected counts, `csv-row-count`, `csv-oa-unique`, `all-oa-found-in-csv`, `output-written`) so that a malformed input fails loudly with a specific named check rather than crashing with a raw traceback or silently producing wrong data. These are internal safety nets, not new features — the script's inputs, outputs, and file paths are exactly what the brief specifies.

## Sanity-check results

```python
keys: ['basis', 'n', 'parents', 'source']
basis: oa
n: 26369
source: london_oa_lookup.csv
lsoa len= 26369 max= 4993 (< 4994: True)
ward len= 26369 max= 688  (< 689:  True)
pcon len= 26369 max= 74   (< 75:   True)
borough len= 26369 max= 32 (< 33:  True)
gla len= 26369 max= 13    (< 14:   True)
```

- File starts with `{"` (confirmed plain JSON, not gzip — gzip magic is `\x1f\x8b`).
- First 300 characters confirm compact separators (no spaces after `,`/`:`) and correct key order: `{"basis":"oa","n":26369,"source":"london_oa_lookup.csv","parents":{"lsoa":[...`.
- `static\labs\morph\d\` file count: **70** = 69 (copied) + 1 (`oa.parents.json`), matching source-count + 1 exactly.

## File counts
- Source (`static\interactive\london-population\d\`): 69 files.
- Destination (`static\labs\morph\d\`) after copy, before running the script: 69 files, byte-identical to source (`diff -q` clean).
- Destination after running the script: 70 files.
- Commit: 72 files changed (70 in `d/` + `index.html` + `build_crosswalk.py`), 286 insertions, 0 deletions — additive only.
- `git status` after commit: clean (no `.superpowers/` staged; it's excluded by its own nested `.gitignore`, confirmed via `git status --porcelain --ignored=matching`).

## Deviations / concerns

**One factual correction to the brief was necessary to make the script pass at all**, and I want to flag it explicitly rather than silently work around it.

The brief's "Labels format facts" section states: *"`oa`, `lsoa`, `ward` additionally have `lad` (array of borough row indices, aligned to that tier's rows)."* Taken literally, step 5's first three cross-validation checks (`parents["borough"]` equals `oa.labels.lad` element-wise; the lsoa/ward `lad`-consistency checks) assume `lad[i]` is directly comparable to `parents["borough"][i]` — i.e. both index into `borough.labels.json`'s own codeNums-sorted row order (row 0 = `E09000001` "City of London", by code, per `codes-ascending-borough`).

That assumption is false for the actual data. `lad[i]` is instead an index into that **same tier's own bundled `ladNames` array**, which is sorted **alphabetically** by borough name (`ladNames[:10]` = `['Barking and Dagenham', 'Barnet', 'Bexley', 'Brent', 'Bromley', 'Camden', 'City of London', 'Croydon', ...]`) — a different index space from `borough.labels.json`'s own code-sorted rows, where "City of London" is pulled out to row 0 because `E09000001` is its lowest code.

I diagnosed this by implementing the check literally first: it failed with **5,158 of 26,369 mismatches** on `crosswalk-borough-matches-oa-lad`. Inspecting individual cases (e.g. OA `E00000001`, real-world City of London, CSV `LAD22CD=E09000001`) showed `oa.labels.lad[0] = 6`, and `borough.labels ladNames[6] = "City of London"` — confirming the alphabetical-array-index theory, not a data-quality problem. I then verified, independently and exhaustively over all 26,369 OAs, that translating `lad[i]` through the tier's own `ladNames` to a borough **name**, then to `borough.labels.json`'s own row via `borough["names"]`, produces **zero mismatches** against the CSV-built crosswalk for all three checks (oa→borough, lsoa→borough, ward→borough).

This confirms two things:
1. My crosswalk (`parents["borough"]`, `parents["lsoa"]`, `parents["ward"]`) is correct — it's built purely from the CSV via code→row-index dicts derived from each tier's own codeNums order, which is the ordering the actual morph geometry/data files (`borough.geom.bin`, `borough.2021.base.bin`, etc.) use.
2. The `lad` fields in the frozen `oa`/`lsoa`/`ward` labels files are a genuinely independent second source of the same OA↔borough truth, just encoded in a different (alphabetical) index space intended for display/lookup convenience, not for indexing into the geometry-bearing tier arrays.

I implemented the three cross-validation checks using the name-translation approach (see the `lad_as_borough_row()` helper and the inline comment in `build_crosswalk.py`, lines 167–210) since that is the check that actually validates the intent stated in the brief — that the crosswalk agrees with the independently-encoded `lad` data — rather than the literal (and here, impossible) index equality. All three checks now pass with zero mismatches across all 26,369 OAs.

I'm flagging this as a concern rather than treating it as silently resolved because: (a) it means the brief's description of the `lad` field's index space was inaccurate, which could affect other tasks in this sprint if they rely on the same assumption, and (b) it was a judgment call on my part about what the check should actually verify, made without being able to consult the brief's author mid-task. If a later task (e.g. one building the actual morph viewer) reads `lad` from `oa.labels.json`/`lsoa.labels.json`/`ward.labels.json` expecting it to index directly into `borough.labels.json`'s own rows, it will get wrong results unless it also translates through `ladNames` → `borough.names` as done here, or reads `oa.parents.json` instead (which is already in the correct, geometry-aligned index space and doesn't need this translation).

No other deviations. All paths, file names, formats, and commit conventions match the brief exactly. Nothing outside `static\labs\morph\` and `tools\morph-lab\` was touched or staged.
