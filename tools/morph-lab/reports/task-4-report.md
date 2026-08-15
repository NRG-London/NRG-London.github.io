# Task 4 (M3) — V2 boundary warp: report

**Status: DONE. Two verdicts, and the second one is the deliverable.**
`transitions: {getPolygon}` — the technique the brief gated on — is NEGATIVE in both precision
modes, and worse than "does not animate": declaring one blanks the layer silently. Driving the
same warp from `requestAnimationFrame` instead is POSITIVE, at ~42 fps, and that is what the
committed page does. The driver exits **0**.

Read §1–§4 for the spike as it stood when the verdict was final, then **Continuation:
CPU-driven warp** for the pivot, the frame rates and what the CPU path cannot do.

Commits on `labs/morph`: **7833cef** (the experiment and the negative verdict), **cd6afa1**
(a self-review fix — proving the Float32 arm really ran under Float32), **97c1948** (the
CPU-driven warp). Deliverables:
`static/labs/morph/v2/index.html`, `tools/morph-lab/capture_v2.py`,
`tools/morph-lab/captures/v2/` (16 PNGs + RESULTS.txt after fix round 1), one line changed in
`static/labs/morph/index.html`. `content/_index.md` was never staged.

Driver: `python tools/morph-lab/capture_v2.py` → **exit 0**:

```
RESULT ALL ASSERTIONS PASS — built-in transitions negative, CPU path positive
```

(Before the continuation it exited 1 by design, the non-zero code being the recorded verdict.)

---

## 1. The spike verdict

### The question, and the answer

> Do `getPolygon` position transitions actually animate in this page's setup (binary
> attributes, `_normalize:false`, `positionFormat:"XY"`, Float64 positions → deck's fp64
> high/low split)?

**No — and not in the way the brief anticipated.** The failure is not that the interpolation
jumps, or produces garbage, or silently does nothing. Putting `getPolygon` into the layer's
`transitions` block **stops the `SolidPolygonLayer` drawing anything at all.** The map goes
blank: no extrusions, just the Thames polygon, the borough outlines and the labels.

The Float32 fallback the brief specifies changes nothing, and there is a mechanical reason it
cannot: `SolidPolygonLayer` declares its own `vertexPositions` attribute as
`{size: 3, type: "float64", fp64: this.use64bitPositions(), transition: …, accessor:
"getPolygon"}` (verified in the deployed `static/js/deck.min.js`). The precision of the array
*we* hand in never reaches the code that fails.

### Root cause, from the browser rather than from inference

The driver enables the CDP `Log` and `Runtime` domains and keeps the events instead of
discarding them while waiting for command replies. With the transition declared, every frame
logs:

```
WebGL: INVALID_OPERATION: beginTransformFeedback: not enough transform feedback buffers bound
WebGL: INVALID_OPERATION: endTransformFeedback: transform feedback is not active
```

deck.gl 9 runs an attribute transition as a **transform-feedback pass** (`nJ(device,
attribute)` in the bundle builds it, with a dedicated `aFrom` / `aFrom64Low` variant for
double-precision attributes). For `SolidPolygonLayer`'s double-precision `vertexPositions` it
cannot bind the buffers that pass needs. The pass fails, the destination buffer is never
written — and the layer draws from it anyway, which is why the result is an empty screen
rather than a stale one.

**It is completely silent to the page.** A WebGL `INVALID_OPERATION` is not a JavaScript
exception: nothing reaches `window.onerror` or `unhandledrejection`, and the lab's own error
count stayed at **0** through every blank capture. Every driver in this sprint gates on that
count. None of them would have caught this; that is why the `ink` measure below exists.

### The measured ladder

> **Which run these are.** The numbers in §1–§4 are the run committed at **cd6afa1**, when the
> verdict was negative and final. The continuation below re-ran the whole driver and replaced
> the committed captures, so `RESULTS.txt` at HEAD carries newer figures for three rows: S3 is
> 1.8981, S4 is 0.0008/255, and S5 now measures the CPU path instead of the built-in one. The
> negative half — ink, MAD, WebGL errors, precision confirmation — is identical in both.

`ink` = share of the map area (right of the 420 px panel) brighter than the ground — a blunt
"are there any extrusions on screen at all" measure, applied identically to every frame.

| # | Configuration | ink | MAD vs control | WebGL errors | page errors |
|---|---|---|---|---|---|
| S0 | control: ward map, no `getPolygon` transition | **0.3166** | — | 0 | 0 |
| S1 | `getPolygon` transition declared, Float64 | **0.0363** | **16.9966** | 12 | **0** |
| S2 | `getPolygon` transition declared, Float32 | **0.0363** | **16.9966** | 12 | **0** |
| S3 | ground truth: inset 0.90 applied **before the first draw** | 0.3045 | 1.8983 | 0 | 0 |
| S4 | the same inset applied **in place** | 0.3045 | **0.0002 vs S3** | 0 | 0 |
| S5 | the same inset asked for as a **3000 ms animation** | — | span 1.8981 | 0 | 0 |

Both precision arms are asserted to have actually *run* in that precision, by reading back the
buffer type the page reports building — `precision confirmed True` for each. Without that, two
blank maps producing identical numbers would be exactly what a `?pos=f32` that never took
effect would also produce.

S5's three sampled frames, timed against the page's own clock:

```
frame at  27.1% of the ease  ->  100.00% across
frame at  52.0% of the ease  ->  100.00% across
frame at  77.0% of the ease  ->  100.00% across
```

**It cuts.** Already at the destination a quarter of the way in.

So the ladder reads: the warp geometry is sound (S3), an in-place position swap lands
*pixel-exactly* where a first draw of the same geometry lands (S4, 0.0004/255 — the same
order as this sprint's other snap assertions), and the only thing that is missing is the
tween. Asking for the tween takes the picture away entirely (S1/S2).

Frames behind each row: `spike_trans_f64.png` and `spike_trans_f32.png` (both blank),
`ref_ward.png` (control), `spike_ground.png` (ground truth), `spike_inplace.png`,
`spike_anim_mid.png`.

### How the negative was reached, and what was ruled out first

The first driver run measured the brief's assertion form directly — a pure position tween
with the values frozen, three frames, pixel-progress bands — and returned "0.0000/255 apart"
for the two *endpoints*. That is not the shape of a broken interpolation; two endpoint frames
that are identical mean the position change never reached the screen at all. Four probes
followed rather than a conclusion:

1. **Is the page even giving deck the new buffer?** No, and yes: the tessellator *did* re-run
   (`state.polygonTesselator.attributes.positions[0]` changed from the true to the warped
   value) and the CPU-side attribute value changed with it. The page's plumbing was fine.
2. **Would a brand-new layer instance with the same buffers draw the warp?** Yes, plainly and
   visibly. So the buffers were right and something about *updating* was not.
3. **Is it the transition?** A four-cell matrix, `{f64,f32} × {transition, no transition}`,
   each from its own page load and each with a liveness control: blank in both transition
   cells, drawn in both others.
4. **What does a correct warp look like?** `?s0=` was added so the inset can be applied before
   the first paint — a ground truth no update path had a hand in. That is what turned "the
   in-place update seems partial" into "the in-place update is exact (0.0004/255)".

An in-page monkeypatch of `polyLayer` was tried and **discarded as unsound**: swapping the
shape of the `transitions` prop on a live layer tells you about the change, not the steady
state, and it froze the map in a way that made every subsequent number zero. That is why the
control arm is a page-level URL flag applied from the first draw (`?postrans=`) and not a
patch. It also cost a wrong intermediate reading, which is recorded here rather than quietly
dropped.

### What was **not** attempted

No shader extension, per the brief — that decision is the controller's. Also not attempted, and
listed only so the controller has the option space rather than as a recommendation: a
per-frame CPU rewrite of the position buffer driven by `requestAnimationFrame` (deck redraws
it correctly every time, as S4 proves; the cost is ~50,738 vertices re-warped and re-uploaded
per frame, and the page's own `warpMs` HUD readout measures exactly that), or a
`PathLayer`/`ScatterplotLayer`-style layer whose position attribute is not double-precision.

---

## 2. What was built

Fork of V0 (`static/labs/morph/v0/index.html`), additive, keeping V0's verified behaviours.

**Ward → borough mapping** (`buildWardToBorough`): derived only from `oa.parents.json`, never
from `ward.labels.lad` — one pass over 26,369 output areas setting
`wardToBorough[parents.ward[i]] = parents.borough[i]`. It **throws** on a conflicting borough
for a ward, on an out-of-range ward row *or borough row*, and if any ward finishes unmapped.
The counts are published in `#v2meta` so the driver can assert the check *ran*:
**689 of 689 wards mapped from 26,369 output areas, 0 conflicts.**

**`warpedPos(T, s)` / `setPos(T, s)`**: per ring, centroid = plain vertex mean, `v' = c +
(v−c)·s`, into a fresh buffer every time; `T.posTrue` is kept aside and never written, so a
warp is always derived from the true geometry and can never compound. `s ≥ 1` returns a fresh
*copy* rather than the shared array — handing deck back the buffer it already holds is the one
reliable way to make "the same values" look like "no change". `T.posPhase` is bumped by every
position swap and by nothing else.

**Carried in from V1**: `polyData(T)` per-tier cached data object, with the cache key
**extended to both counters** (`T.dataPhase !== T.phase || T.dataPos !== T.posPhase`) exactly
as the brief requires — a merge's phase 2 moves every vertex without repainting a single
colour, and `posPhase` alone is what earns it a new data object. Also ported: V1's
`afterCommit` **watchdog** (entry objects, 500 ms since the last committed render, `commits`
rather than `frames` so it stops shadowing the HUD's array).

**Kept from V0**: `SNAP_MS = 1` (applied to `getPolygon` as well), the two-commit `afterCommit`
wait, destination-snap-at-first-draw, fresh buffers + phase bumps, layer rebuilds only via
`redraw()`.

**Choreography**, as specified:
- *Split*: seed the ward layer hidden at `warpedPos(s)` + borough plateau (snapped) → swap
  visibility (the intentionally visible crack) → one animated repaint taking positions to true
  **and** values to the wards' own. Finalise is bookkeeping only: the layer that animated *is*
  the ward layer, so clearing `morphBasis` changes no pixels.
- *Merge*: phase 1 (values → borough plateau **and** positions → `warpedPos(0.94)`, together)
  → phase 2 via token-guarded timer (positions → true, **no repaint at all**) → invisible swap
  to the real borough layer, snap-painted as it is shown.

**Controls**: the six-pair strip is gone; `borough → ward (split)`, `ward → borough (merge)`,
a spike toggle, an inset slider (0.85–0.98, default 0.92), split 750 / merge 400 + 350 /
merge-inset 0.94, and the HUD (which gained `warp ms`, the current inset and the precision
mode). The panel still fits inside the driver's 420×260 crop.

**Auto-modes**: `?show=`, `?warp=split|merge&when=|at=` as the brief asks, plus `?spike=`,
and every control settable from the URL (`?dur= ?d1= ?d2= ?s= ?sm=`).

### Decisions taken on open details

1. **`?postrans=` defaults to OFF.** With the transition declared the page renders *nothing*,
   and a lab page that shows a blank screen is worth nothing to the user. Default off, so the
   page works and the warp cuts; `?postrans=1` reproduces the blank map in one click and is
   what the driver's S1/S2 measure. This is documented at the flag, in the workbench index and
   in RESULTS.txt.
2. **`?s0=<s>` added** — insets the ward tier before its first paint and leaves the boot
   standing on it. Built as the spike's ground truth; kept because it is now the only way to
   see the cracked state as a still, and it overrides the other auto-modes (each of which
   would paint over it).
3. **The warm-up tier changed from `oa` to `ward`.** V0 warms the layer it stands in for a
   coarser tier with; V2's stand-in is the ward layer. The crosswalk's own `BASIS = "oa"` and
   V0's parents-length assertions are untouched.
4. **No crack "dwell" was invented.** With positions cutting, the crack is visible for the two
   commits between the swap and the animate. Adding a hold would have produced a
   hold-then-cut animation that is *not* the style B being judged, so the crack is offered as
   a still (`split_crack.png`, `?s0=`) instead.
5. **`easeDrop` removed** (it existed for V0's easing selector); every phase is cubic-in-out.
6. **Interrupts** reuse V0's token pattern; a mid-flight opposite click restarts from the
   current interpolated state. `show()` additionally restores true outlines, which is what
   recovers a tier left part-way warped by an interrupted split.

---

## 3. Driver output — all numbers

From the run committed at **cd6afa1** (the file at HEAD is the continuation's run — its
assertion block is quoted in the continuation, §5). Assertion summary:

```
PASS 1 BOOT: ready, errors 0, and the ward->borough mapping was CHECKED, not assumed
     689 of 689 wards mapped from 26369 output areas, 0 conflicts (a conflict throws at boot)
     ward tier: 689 features, 50738 vertices; positions f64

FAIL S SPIKE: getPolygon position transitions animate
     f64 with the transition declared: ink 0.0363 vs control 0.3166, MAD 16.9966, WebGL errors 12, precision confirmed True
     f32 with the transition declared: ink 0.0363 vs control 0.3166, MAD 16.9966, WebGL errors 12, precision confirmed True
     pass S4 in-place position swap == a first draw of the same geometry (0.0002/255)
     S5 asked for as an animation: 100.00% -> 100.00% -> 100.00% across (a cut lands on 100/100/100)
     THE VERDICT IS THE FINDING, and the non-zero exit code below records it.

PASS ref_ward.png vs split_end.png
     2 SPLIT END-STATE: the cracked-open wards heal into exactly the ward map
     MAD 0.0004/255 (limit 2.0)   pixels >12/255: 23 of 1220800 = 0.0019% (limit 0.5%)   max channel diff 33

PASS ref_borough.png vs merge_end.png
     3 MERGE END-STATE: the wards converge and hand back to exactly the borough map
     MAD 0.0000/255 (limit 2.0)   pixels >12/255: 0 of 1220800 = 0.0000% (limit 0.5%)   max channel diff 1
```

Phase logs (page clock, ms from the click):

```
split: ["split", "seed+5", "watchdog+545", "crack+546", "animate+580", "finalise+3641"]
merge: ["merge", "phase1+6", "phase2+3072", "finalise+5762"]
```

Mid frames, timed against the page's own clock and reported at the fraction they actually
landed on: split 28.9 / 52.2 / 77.2% of a 3000 ms split; merge 51.9% of phase 1, 51.7% of
phase 2. Thresholds are V1's, unchanged (MAD ≤ 2.0/255, ≤ 0.5% of pixels over 12/255). Every
capture gates on the page reporting `errors == 0`; all did. 15 PNGs + RESULTS.txt, 4.6 MB.

The split's end-state residual (23 pixels out of 1,220,800 more than 12/255 apart, worst 33)
sits on ward edges and is the same order as the endpoint residuals V1 measured — antialiasing
where a bar edge falls between two pixels, not a geometry difference. The merge's landing,
which swaps to a different layer holding the same picture, is exact.

The 420×260 crop constant is still unasserted against the panel's real bounding box (a
deferred sprint minor), but it is now evidenced rather than assumed: the HUD inside that box
carries a live clock and frame-time readout, so it differs in *every* pair of frames — and the
merge end-state pair came in at MAD 0.0000/255 with a max channel difference of 1. Nothing of
the panel reaches outside the crop at this panel size.

The run was repeated end to end against the committed code to confirm the verdict and the
numbers reproduce (see §4.8).

---

## 4. Concerns

1. **The blank-layer failure is invisible to every driver in this sprint.** `errors == 0` is
   the gate V0, V1 and V2 all use, and it stayed 0 while the map showed nothing. Only the
   `ink` measure and the CDP log capture caught it. If any of this goes near production, the
   error gate needs a "did anything actually draw" companion.
2. **The watchdog fired on the split's seed** (`watchdog+539`), and that is not noise. The
   seed only repaints a *hidden* layer, so deck.gl has no reason to draw a frame, so the
   two-commit wait is never satisfied by real renders and the crack lands ~540 ms after the
   click instead of ~30 ms. It varies run to run (a probe run logged `crack+32` and another
   `crack+172`). V0/V1 never hit this because their seed always changed the visible layer.
   Porting V1's watchdog is the only reason the split completes at all here.
3. **A 0.92 inset is a small number in MAD terms** (a 0.90 inset measures 1.90/255 against the
   true map — *below* the driver's own 2.0 near-identity limit) because the change is thin
   gaps around otherwise unchanged interiors. It is clearly visible to the eye and to `ink`,
   but MAD is the wrong instrument for it, which is why no pixel band is asserted on the warp
   frames.
4. **Per-ring insetting shrinks holes towards their own centres**, so an enclave inside a ward
   grows rather than shrinking. This follows the brief's rule; few such rings exist at ward
   grain and none were seen to matter, but it is unasserted.
5. **The inset is a fixed fraction of each ward's size**, so small wards open small gaps and
   large wards open large ones. A constant-metre inset would read differently and is not
   built.
6. **The style-B judgement cannot actually be made from this build.** The user can see the
   cracked state as a still and the choreography as a cut, but not the warp as a warp. If the
   controller wants the aesthetic question answered, it needs one of the routes in §1 "what
   was not attempted" first.
7. **Unchanged from the sprint**: `content/_index.md` still carries the user's own uncommitted
   homepage edit; it was never staged. `tools/morph-lab/__pycache__` is still not gitignored
   (a deferred Task 3 minor); it was created by the diagnostic probes importing the driver as
   a module, was deleted rather than staged, and would come back for anyone who does the same.
8. **Reproducibility.** File mtimes under OneDrive are rewritten by sync, so "the committed
   results came from the committed code" could not be established from timestamps. The driver
   was therefore run three times end to end. The verdict and every number reproduce within
   noise; the committed `RESULTS.txt` is run 3, and the verbatim block in §3 is taken from it:

   | | run 1 | run 2 | run 3 (committed) |
   |---|---|---|---|
   | S1/S2 ink (control 0.3166) | 0.0363 | 0.0363 | 0.0363 |
   | S1/S2 MAD vs control | 16.9966 | 16.9967 | 16.9966 |
   | WebGL errors per blank capture | 12 | 12 | 12 |
   | S4 in-place vs ground truth | 0.0004/255 | 0.0003/255 | 0.0002/255 |
   | S5 progression | 100.00/100.00/100.00% | 99.99/100.00/100.00% | 100.00/100.00/100.00% |
   | split end-state | 0.0001/255, 1 px | 0.0001/255, 6 px | 0.0004/255, 23 px |
   | merge end-state | 0.0000/255, 0 px | 0.0000/255, 0 px | 0.0000/255, 0 px |
   | ward→borough | 689/689, 0 conflicts | 689/689, 0 conflicts | 689/689, 0 conflicts |
   | watchdog on the split seed | `+539` | `+536` | `+545` |

   The watchdog fires in all three, which makes concern 2 systematic rather than a one-off.
   Run 3 also carries the precision-arm assertion that runs 1 and 2 lacked, which is why it is
   the one committed.

---

# Continuation: CPU-driven warp

**Status: DONE — the CPU path works.** Driver exits **0**; every assertion passes.
`RESULT ALL ASSERTIONS PASS — built-in transitions negative, CPU path positive`.

The verdict is now two-sided and both halves are measured in the same run: deck.gl's built-in
transitions still cannot animate `getPolygon` (unchanged, still reproducible with
`?postrans=1`), and a `requestAnimationFrame` loop that rebuilds the position buffer every
frame animates it perfectly well at **~42 fps**.

## 1. Frame rate — the number the continuation was gated on

Ward grain, 689 features / 50,738 vertices, every frame: 101,476 ordinates re-warped, an
811 KB Float64 buffer allocated, and deck.gl re-tessellating all 689 features because the
geometry changed. Frame intervals exclude the first (which spans the click and the first
tessellation).

| beat | fps | frames | ema | worst |
|---|---|---|---|---|
| spike tween (3000 ms) | **41.9** | 126 | 22.6 ms | 38.9 ms |
| split heal beat | **46.0** | 139 | 22.8 ms | 50.0 ms |
| merge heal beat | **45.7** | 138 | 23.6 ms | 33.3 ms |

Against the brief's ~15 fps floor, with ~2.8× headroom. It is not vsync — a 60 fps frame is
16.7 ms and the ema is 22–24 ms — so the warp misses roughly every third frame. Whether that
reads as fluid is an eye question the driver does not answer, and it is listed as such.

Two cheap wins are in the build rather than left on the table: ring centroids are computed
once and cached (a frame is then one multiply-add per ordinate), and a warp frame rebuilds
**only the moving layer** rather than the whole stack — v0 measured that rebuilding six
polygon layers, two outline layers and a collision-filtered TextLayer per frame is on its own
enough to make a 60 fps animation stutter.

## 2. The spike assertion now PASSES on the CPU path

Same measurement the built-in transitions failed — a pure position tween, values frozen, three
frames timed against the page's own clock:

```
frame at  28.7% of the ease  ->    8.14% across
frame at  54.7% of the ease  ->   55.43% across
frame at  79.0% of the ease  ->   94.91% across
pass it SLIDES — every frame strictly between the ends, and rising
```

The negative half is unchanged and still measured every run: ink 0.0363 against the control's
0.3166, MAD 16.9966, 12 WebGL errors per capture, page error count 0, precision confirmed for
both arms.

## 3. What the CPU path cannot do, and what that forced

**The outlines and the values cannot move at the same time.** This is the continuation's one
real finding, and it changed the choreography. Three routes were tried and measured:

| approach | result |
|---|---|
| values CPU-lerped per frame alongside the positions | **never reach the screen** — 0.01% across at u = 0.64, at every duration from 1 ms to 750 ms, and with the colour trigger held constant |
| values left on deck's transition, running concurrently | **do not move while the outlines do** — 29.25% across at the 84% mark of the ease, where a working transition would be at ~96.6% (*corrected in fix round 1 — the figures originally quoted here, 62.87% and "ending 3.77/255 short", came from a development probe and do not reproduce; this row is now measured live every run by the driver's S6 arm*) |
| values taken out of `transitions` so they draw literally | **blanks the layer** the moment a vertex moves — and with no WebGL error at all this time |

The cause of the first is the same shape as the original spike: deck.gl draws a transitioned
attribute from the transition's own buffer, so a value handed over every frame is superseded
before it is ever applied. Moving a vertex forces re-tessellation, and both branches of the
condition that triggers it re-read every attribute — so the position loop restarts the colour
transition on every frame no matter how the update is routed.

The diagnosis was nailed down against a **statically rendered** u = 0.5 picture of the same
choreography: the live half-way frame sat 19.5% across where the static one sat 59.2%,
2.76/255 apart. Without that reference the lag was invisible, because the split's end state
was correct either way.

**So each beat moves one thing.** Split: `crack` (a cut — the warped plateau arrives, snapped)
→ `values` (deck's transition, seams held open) → `heal` (CPU loop). Merge is the mirror:
`open` (CPU) → `values` (deck) → `heal` (CPU) → invisible swap to the borough layer. Every
beat runs on a mechanism this sprint has proof for. Measured phase logs:

```
split: ["split", "crack+4", "values+42", "heal+3104", "finalise+6149"]
merge: ["merge", "open+0", "values+3049", "heal+6113", "finalise+9165"]
```

This is a deviation from the instruction that values "stay on the proven deck transition path
running concurrently" — concurrency is what the measurements rule out. Everything else in the
instruction is as asked.

## 4. Concern 2 is fixed, as the controller predicted

The seed and the crack are now one step: the ward layer is painted and made visible in the
same redraw, so its first drawn frame *is* the crack. The visibility change gives deck.gl
something to draw, the commits flow, and the watchdog never fires — `crack+4`, against the
previous build's `watchdog+545 crack+546` on every run. Nothing is lost: the crack was where
the choreography wanted to start anyway.

## 5. Driver

- The SPIKE assertion is renamed and now gates the run: built-in NEGATIVE (evidence retained
  in full) plus CPU path POSITIVE, and exit 0 requires the CPU half to pass.
- **`ink` is now a gate on every capture**, not just a number in the spike — this task's own
  lesson, since the failure it found was a blank map with a clean error count. Floor 0.15
  (drawn ward map 0.3166, blanked layer 0.0363). The two deliberately-blank spike captures opt
  out explicitly via `blank_ok=True`.
- Frame-rate assertion: `MIN_FPS = 15.0`, reported per beat.
- Mid frames re-cut for the beat structure: `split_values_50`, `split_heal_50`,
  `merge_open_50`, `merge_values_50`, `merge_heal_50`, all timed off the page's own clock and
  reported at the fraction they actually landed on (51.7–54.4%).

The committed `RESULTS.txt` assertion block, verbatim:

```
PASS 1 BOOT: ready, errors 0, and the ward->borough mapping was CHECKED, not assumed
     689 of 689 wards mapped from 26369 output areas, 0 conflicts (a conflict throws at boot)
     ward tier: 689 features, 50738 vertices; positions f64

PASS S SPIKE: the outlines animate — on the CPU path, not on deck's transitions
     built-in, f64: ink 0.0363 vs control 0.3166, MAD 16.9966, WebGL errors 12, precision confirmed True
     built-in, f32: ink 0.0363 vs control 0.3166, MAD 16.9966, WebGL errors 12, precision confirmed True
     pass S4 in-place position swap == a first draw of the same geometry (0.0008/255)
     pass S5 CPU path: 8.14% -> 55.43% -> 94.91% across
     pass S5 CPU path holds 41.9 fps (floor 15)

PASS ref_ward.png vs split_end.png
     2 SPLIT END-STATE: crack, values, heal — landing on exactly the ward map
     MAD 0.0000/255 (limit 2.0)   pixels >12/255: 0 of 1220800 = 0.0000% (limit 0.5%)   max channel diff 3

PASS ref_borough.png vs merge_end.png
     3 MERGE END-STATE: open, converge, heal — handing back exactly the borough map
     MAD 0.0000/255 (limit 2.0)   pixels >12/255: 0 of 1220800 = 0.0000% (limit 0.5%)   max channel diff 0
```

Captures: 15 PNGs + RESULTS.txt, still under the 20-file limit.

## 6. Decisions

1. **Beats, not concurrency** (§3) — forced by measurement, documented at `animateWarp`.
2. **`?postrans=1` preserved** as the blank-layer repro, and the transitions object is now
   documented as having exactly one safe shape: populated, and never mentioning `getPolygon`.
3. **Duration controls renamed to beats** — `values ms` (750), `open ms` (400), `heal ms`
   (350). The query names `?dur= ?d1= ?d2=` are unchanged so existing URLs keep working.
4. **Warp stats are per-beat and reset by the next** — an average taken across a split and the
   merge after it would describe neither.
5. **`?s0=` and `?cpuval=`**: `?s0=` kept (still the only way to see the crack as a still);
   `?cpuval=` was added during the value-duration sweep and **removed** once the sweep showed
   no duration works.

## 7. Concerns

1. **~42 fps is not 60.** The ema is 22–24 ms against a 16.7 ms budget, so the warp misses
   roughly every third frame, and the worst frame in one beat hit 50 ms. The dominant cost is
   deck.gl's per-frame re-tessellation of 689 features, which is not avoidable from outside
   the library — the buffer maths is comparatively free.
2. **This will not scale down a tier.** At LSOA (4,994 features) or output-area grain (26,369)
   the per-frame cost is 7×–38× larger. Style B is a ward↔borough effect on this evidence, and
   nothing here says it survives at finer grain.
3. **The choreography is three beats long** (values 750 + heal 350 = 1.1 s for a split; the
   merge adds an opening beat). Whether that reads as one gesture or as three is exactly the
   eye question the user is being handed, and it is in the UNTESTED list.
4. **The CPU loop is a second animation clock** in a page that already has deck's. They are
   never both animating the same layer at once by construction, but nothing enforces that
   beyond the token guards.
5. **`T.dur`/`T.ease` are now nearly vestigial** — the value beats still use them, but the
   resets at finalise are defensive no-ops. Left in place deliberately: they keep the invariant
   if a duration is ever reintroduced.
6. Unchanged from the first half: `content/_index.md` untouched and unstaged; `__pycache__`
   deleted rather than staged; the 420×260 crop constant still evidenced rather than asserted
   (both end-state pairs come in at MAD 0.0000 with a live HUD inside the crop).

---

# Fix round 1

Both findings addressed. Driver re-run end to end: **exit 0**,
`RESULT ALL ASSERTIONS PASS — built-in transitions negative, CPU path positive`.
Captures and RESULTS.txt regenerated in place (17 files, still under the 20-file limit —
`spike_concurrent_79.png` is new).

## Finding 1 — the three unattributed numbers

Fixed by **restoring the repro flag**, not by attribution, because attempting to re-measure
turned one of the three numbers out to be wrong.

`?concurrent=1` is back in the page: it collapses the split's second and third beats into the
configuration the brief drew — values on deck.gl's transition while the CPU loop moves the
outlines, both over the same duration. The driver measures it as **S6**, every run, and prints
live figures into RESULTS.txt.

**And the re-measurement corrected the record.** The claim in the committed evidence was that
the concurrent arm "lags — 62.87% across at the 79% mark, ending 3.77/255 short". Measured
live against a crack-to-ward span taken in the same document:

```
     the crack and the ward map are 5.2277/255 apart
     at 83.8% of the ease the values are 29.25% across — a working transition would
     be at ~96.6%, which is where cubic-in-out has got to by then
     confirmed the values do not move while the outlines do (under 50% across at the 79% mark)
     they arrive AFTERWARDS: 0.0002/255 from the ward map once the loop stops
```

The **end state is fine** — 0.0002/255, not 3.77 — because once the position loop stops
restarting it the transition converges. The reproducible harm is the *motion*: the colours
barely move while the animation is running and catch up after it has ended. So the assertion
now tests the lag (`< 50%` across at the 79% mark, against ~96.6% for a working transition)
rather than the landing, and it carries a line saying that a failure here would mean deck.gl
has changed and the three-beat split should be revisited.

The old number was wrong in the driver's printed evidence, in the page comment at
`animateWarp`, and in this report's §3 table. All three are corrected; the report row is marked
as corrected rather than quietly rewritten.

The two remaining probe-only claims — CPU-lerped values never arriving (0.01% at u = 0.64) and
an empty `transitions` object blanking the layer on a vertex move — are now **explicitly
attributed** in the printed verdict as "measured in separate probe runs during development and
NOT re-measured here", with a pointer to this report. They are not load-bearing for the design
decision on their own; the live S6 arm is.

`%%` literals at the three prose lines fixed (they were rendering as `62.87%%` in the committed
evidence). An AST check over every `log()` call in the driver now shows zero unformatted `%%`
literals; it was run as a one-off rather than added to the file.

## Finding 2 — `afterCommit` armed after its `redraw`

Moved above the `redraw()`, which is the invariant v0 established. The phase log is unchanged:
`logPhase("crack")` still fires immediately after the redraw that makes the layer visible, so
"crack" still names the moment the crack appears.

Timings after the move, from the committed run:

```
split: ["split", "crack+3", "values+54", "heal+3117", "finalise+6160"]
merge: ["merge", "open+0", "values+3049", "heal+6112", "finalise+9152"]
```

`crack+3`, against `crack+4`/`crack+6` before the move and `watchdog+545`/`crack+546` in the
pre-continuation build. No watchdog entry in either choreography.

The comment now says what was actually true of the old order rather than claiming an invariant
the code did not hold: it survived only because the one-millisecond snap issued just above
guarantees another render or two, with the watchdog behind that — neither being a reason to
rely on the order being wrong. The two boot-time `afterCommit` sites were checked and already
arm before their redraws; `merge()` uses none (it chains off the rAF loop).

## Numbers from the committed run

```
PASS S SPIKE: the outlines animate — on the CPU path, not on deck's transitions
     built-in, f64: ink 0.0363 vs control 0.3166, MAD 16.9966, WebGL errors 12, precision confirmed True
     built-in, f32: ink 0.0363 vs control 0.3166, MAD 16.9966, WebGL errors 12, precision confirmed True
     pass S4 in-place position swap == a first draw of the same geometry (0.0004/255)
     pass S5 CPU path: 8.50% -> 54.07% -> 94.94% across
     pass S5 CPU path holds 34.5 fps (floor 15)
     confirmed S6 outlines and values TOGETHER: the values are 29.25% across at the 84% mark
        (a working transition would be at ~96.6%), so the two cannot share a beat
```

Split end-state 0.0004/255, merge end-state 0.0000/255, 689/689 wards mapped with 0 conflicts.

## Concerns

1. **The frame rate moves between runs more than I first reported.** This run: 34.5 / 40.1 /
   43.4 fps for the three beats, against 41.9 / 46.0 / 45.7 in the run committed at 97c1948,
   and a worst frame of 55.6 ms. The floor assertion (15 fps) has ~2.3× headroom at the low
   end, so the verdict is not in doubt, but "~42 fps" from the continuation report is better
   read as **~35–46 fps on this machine**. The report's continuation §1 table is the earlier
   run and is labelled by its commit.
2. **S6 asserts a failure mode.** If deck.gl ever fixes concurrent transitions the assertion
   goes red, which reads as a regression when it is the opposite. That is deliberate and the
   printed line says so, but a future reader has to read the line.
3. Unchanged: `content/_index.md` untouched and unstaged, `__pycache__` deleted rather than
   staged, the two probe-only claims attributed rather than re-measured.
