# Task 2 (M1) — V0 minimal morph harness: report

**Status: DONE_WITH_CONCERNS at first pass; see the fix round appended at the end — the
transition defect described below is FIXED as of commit 35df68f, and the always-visible-basis
recommendation in section 4 is WITHDRAWN.**

**First-pass status was: DONE_WITH_CONCERNS.** The technique's central claim is proven to the pixel. The
orchestration works and lands exactly on the destination. One thing does not work: the
value transition does not visibly interpolate — the morph currently *cuts* to the
destination instead of sliding to it. That is a deck.gl behaviour, it is measured, it is
understood, and the fix for it belongs in v1. Details in "The one thing that does not
work" below.

Deliverables:

- `static/labs/morph/v0/index.html` — the harness
- `tools/morph-lab/capture_v0.py` — the headless verification driver
- `tools/morph-lab/captures/v0/` — 9 PNGs + `RESULTS.txt` (the evidence)

---

## 1. The headline result

**The plateau claim is true.** 26,369 output-area polygons painted with their parent
borough's value are not an approximation of the 33-borough map — they are that map:

```
s1_show_borough.png vs s2_plateau_oa_borough.png
MAD 0.0445/255 (limit 2.0)   pixels >12/255: 419 of 1,220,800 = 0.0343% (limit 0.5%)
max channel diff 99
```

419 differing pixels out of 1.22 million, and they are hairline antialiasing on the
borough boundary silhouette, not structure. There is no seam where the internal OA edges
are: adjacent OAs at identical height share exact vertices, and the internal walls of the
extrusion are buried inside the solid. The swap in step 1 and step 3 of the morph is
genuinely free.

The two morph end-state assertions are tighter still, because they are two paths to the
same layer rather than two different layers:

**First pass — superseded by fix round 1.** The numbers immediately below are what this
harness measured *before* the transition fix (§4); they predate `SNAP_MS`, the two-frame
`afterCommit` wait and the FINALISE re-snap. They are kept here as the historical record of
the first pass, not as current numbers. The committed `RESULTS.txt` — quoted verbatim in
"Fix round 2 -> Current committed RESULTS.txt" at the end of this report — now reads
MAD 0.0000/255, 1 of 1,220,800 px (0.0001%), max 25 for `s3` vs `s4`, and MAD 0.0000/255,
0 px (0.0000%), max 1 for `s5` vs `s6`. (The "Fix round 1 -> New assertion numbers" summary
further below is itself a snapshot of that round's own re-verification, not the current
file — see the delta noted in Fix round 2.)

```
s3_show_ward.png vs s4_morph_borough_ward.png   (nested pair)
MAD 0.0003/255   15 of 1,220,800 = 0.0012%   max channel diff 37

s5_show_gla.png vs s6_morph_pcon_gla.png        (non-nested pair)
MAD 0.0001/255    4 of 1,220,800 = 0.0003%   max channel diff 26
```

The `pcon -> gla` pair matters most: those two tiers do not nest in each other at all, and
the morph still lands exactly on the Assembly-seat map, because both are nested in the
same OA basis. The technique does not need the endpoints to be related to each other.

Boot assertion, via `--dump-dom` as specified:

```
{"ready":true,"errors":0,"tier":"borough","morphBasis":null}
```

Driver exit code 0.

---

## 2. Construction: what was kept, what was cut

Started from a byte-exact copy of the three baked data lines (`CFG`, `MANIFEST`, `ORIENT`,
production lines 311–313) — they are substituted in mechanically, so the manifest, ramps,
gamma, camera and Thames/borough geometry are identical to production by construction.

**Kept, byte-identical where possible:** `measureFor`, `hexToRgb`/ramps/`rampFor`,
`clamp01`, `lerpRamp`, `colorFor`, `elevationFor`, `inflate`, `track`, `fetchContainer`,
`fetchJson`, `loadTier`, `SLOT_CTOR`/`SLOT_NODATA`, `readSlots`, `loadGroup`,
`groupCacheKey`, `loadBase`, `decode`, `shownValue`, `suppressed`, `easeCubicInOut`,
`easeDrop`, `easeLateFade`, `paint`, `lighting`, `thamesLayer`, `boroughCasing`,
`boroughLayer`, `charSet`, `boroughLabels`, `elevScale`, `polyLayer`, `layers`, `redraw`,
`buildStack`, the deck init and its production camera (`zoomAdj` included, so the harness
frames London exactly as production does).

`paint()` in particular is character-for-character production, including the fresh-buffer
contract, the `elevFPrev`/`elevF` pair, `barT0` and the `phase` bump. Its timing
instrumentation is a **wrapper applied after definition** (`paint = (function (inner) {…})(paint)`)
rather than two lines inside the body, so the function that goes back into production is
unchanged.

**Cut:** all UI construction (measure/year/area/mode/group pills, legend, switcher, story
text, scroll shield, reset button, loading bar), the tooltip and everything only it used
(`buildTooltip`, `placeName`, `boroughOf`, `codeOf`, `otherYearRow`, `yearValue`,
`bothCountsRow`, `estimateNote`, `denomLabel`, `fmt`), ranking (`ranksFor`) and centroids,
the change-view machinery (`asChange`, `changeValues`, `inChangeMode`, `CHANGE_CACHE`),
`apply`/`setTier`/`setArea`/`setYear`/`setGroup`/`setMeasure`, the prefetch plumbing, the
zoom-driven tier switch, `basemapLayer` (street mode is unreachable and it would have made
the captures depend on a CDN), query-param seeding, and the `__NG_DONE__` settle machinery.

**Neutralised:** `startPulse`/`stopPulse` are empty and `pulseLayer()` returns null, as
specified. `pickable: false` and no `getTooltip`. `applyZoom` keeps only the
`elevationScale` half.

**Fixed state:** `mode = "boroughs"` (so `CFG.polyOpacity` gives opaque bars — the whole
plateau argument depends on it), measure `pop_density` from `MANIFEST.initial`, year 2021
from `MANIFEST.baseYear`, basis `oa`, opening tier `borough`. At boot all six tiers'
geometry + denominators + values load together via `loadTier` and `loadGroup` — the
production path, so the coarse tiers correctly resolve to their bundled `g_all` file while
lsoa/oa resolve to `g_people`, with no filenames hand-rolled anywhere — plus
`oa.parents.json`. Roughly 3 MB, about 1.4 s off a local server.

Two `keep`-list items were deliberately dropped: `paintFlat` (only the curtain used it) and
the Libre Baskerville face (only the card used it). DM Sans is kept and **awaited** before
the first `redraw`, because `TextLayer` bakes its SDF atlas from whatever font is resident
the first time it is built; without the await the borough labels would differ between
captures for reasons that have nothing to do with the morph.

Parent indices come only from `oa.parents.json`, and the boot asserts
`parents[tier].length === nFeatures(oa)` for all five before flipping ready. The labels
files' `lad[]` is never read.

---

## 3. The new code

`loadParents()`, `paintFrom()`, `morphTo()`, `afterCommit()`, the snap gate and the
`buildStack` visibility rule are implemented to the contracts in the brief. Notes on the
parts where the contract left room:

**`paintFrom` colour memoisation.** The per-parent pass quantises with the same
`Math.round(v * 64)` bucket as `paint`, and walks parents in ascending feature order — the
same order `paint` first encounters each feature in, because rings are grouped by feature.
That matters: the memo returns the colour of the *first* value to land in a bucket, so a
different walk order would give a different representative colour and the "pixel-identical"
swap would be off by one bucket in places. Getting this wrong would have shown up as a
diffuse low-level difference in the S1/S2 assertion rather than an obvious failure.

**`afterCommit` — mechanism chosen: one-shot queue drained from deck's `onAfterRender`,
with the callbacks invoked one `requestAnimationFrame` later.** `onAfterRender` is a
statement from deck that the props are on screen; rAF alone would have been a guess about
its schedule. The extra frame exists because `onAfterRender` fires *inside* the render
loop, and calling `setProps` from in there is not a contract deck.gl offers.

The non-obvious part, and a genuine bug I hit and fixed: **the hook must be armed before
the `redraw()` it is waiting on.** deck.gl services a `setProps` that changes the layer
stack during the call — `onAfterRender` has already fired by the time `setProps` returns —
so a hook registered on the line after `redraw()` is waiting for a render that has already
happened. With nothing else on screen moving, deck has no reason to draw again, and the
morph stops dead at the seed: the map holds a borough picture built out of output areas,
forever, with no error anywhere. Two lines apart, and the difference between a working
morph and a frozen one. The harness reports `renders` in `#v0meta` so this is visible
rather than mysterious.

**Snap clearing.** `redraw()` clears every `T.snap` after `layers()` has been evaluated —
"cleared after the redraw that consumes it", exactly.

**Borough outline rule.** `buildStack` keys the outlines on `curTier` (the geography being
*represented*), not on the layer being drawn. That is what makes the seed swap invisible:
an OA basis painted with borough values *is* a borough map and must lose the outlines
exactly as the borough layer does. `plateau(b, p)` therefore sets `curTier = p` and
`morphBasis = b`, and `morphTo` sets `curTier = toKey` at ANIMATE time, as specified.

**Extras beyond the brief**, all additive and all in service of the driver:
`?dur=<ms>` and `?ease=drop` set the two controls from the URL (the driver uses `dur` to
run a slow morph it can photograph part way through); `#v0meta` and `#v0err` nodes
alongside `#v0status`, carrying `readyAt`, `renders`, `ticks`, the morph phase log and any
error text; and a 100 ms `setInterval` that refreshes the HUD and both status nodes. That
last one is not cosmetic — see §5.

---

## 4. The one thing that does not work: the transition cuts instead of sliding

**Symptom.** All three end-state assertions pass, but the mid-flight captures show the map
already sitting on the destination a quarter of the way through the transition. Measured by
the driver itself (`RESULTS.txt`, "mid-flight position"): with borough and ward 6.21/255
apart, all three of `mid_25`, `mid_50` and `mid_75` sit 0.03/255 from the ward end — 100%
across, at 25% of the way through. The morph is a cut.

**What I established, by measurement rather than reading.**

1. deck.gl transitions on these binary attributes *do* work. Reference test on the
   production page: `__setMeasure` produces a clean monotonic ramp — 0.97, 1.18, 2.21,
   2.60/255 over ~1 s, then flat. So nothing is wrong with the mechanism in the abstract.
2. The same harness code *does* animate when the seed paint is skipped. `morph('oa','ward')`
   — where the basis is already both visible and the source, so `morphTo` skips the seed —
   produces a moving picture, sampled frame by frame.
3. With a snap seed it does not. Sampled at ~85 ms intervals across a 6000 ms transition:
   flat, every frame identical, from the first sample to the last.
4. A morph run *after* an earlier morph on the same page load does animate.

**Diagnosis.** These attributes are supplied as binary buffers through `data.attributes`,
and such a buffer only reaches the GPU when the layer is actually *drawn*. Two consequences
that trap this particular manoeuvre from both sides:

- A layer painted while hidden does not upload. When it is shown, an update with
  transitions live interpolates out of an **empty** buffer — the whole tier lies flat on the
  ground and grows back. I have the screenshots: a bare Thames, borough outlines and place
  names, no bars at all, then bars growing in over the transition window.
- An update issued with `transitions: {}` uploads directly and looks perfect — that is
  exactly why the seed is pixel-identical and S1/S2 passes — but the **next** update of that
  attribute does not interpolate either. It cuts.

The seed needs the second behaviour and the animate needs the first, and they are mutually
exclusive on one layer. The production page never meets this because its curtain rises from
the ground: the baseline its incoming layer wants *is* zero, so being wrong about the
baseline costs it nothing. Here the baseline is a whole map.

**Things I tried that did not resolve it**, all reverted:

- `duration: 0` for the snap — deck falls back to a default and animates anyway (this is the
  same trap the brief already flagged for `T.dur = 0`, one level lower down).
- `duration: 1` — likewise not instant; the seed became a visible from-zero animation.
- Waiting 2 or 4 committed frames between seed and animate instead of 1 — no change.
- Warming every layer at boot by drawing each one alone for a frame or two — this left the
  *other* layers rendering blank and made things strictly worse.
- Keeping the basis primed with the current tier's plateau while hidden, so the seed is a
  bare visibility flip — the transition then ran, but out of an empty buffer, because a paint
  issued while the layer is hidden never uploaded.
- Setting the destination's snap again at FINALISE (as insurance for its first-ever draw) —
  this **regressed both morph assertions from 0.0002/255 to 17/255**, and is now a comment
  in the code warning against it. Caught by re-running the driver, which is the argument for
  having built it.

**Recommendation for v1.** The evidence points one way: the basis layer must never be
hidden and must never be snapped. Since the plateau is pixel-identical to the real tier's
own layer (0.0445/255, measured), the basis can simply **be** the map — draw it always,
painted as whatever tier is current, and drop the per-tier extruded layers from the render
path entirely (keeping them, if at all, only as the reference this harness compares
against). Then there is no seed, no snap, no swap, and a morph is a plain value transition
on a permanently visible layer — which is precisely the case that is already proven to
animate. Picking and tooltips stay solvable through `parentIdx`, which maps any OA back to
its parent row in one lookup.

That is a smaller v1 than the brief anticipated, and it is what the measurements support.

---

## 5. Headless setup: what worked, and what silently does not

**What shipped:** headless Edge driven over the DevTools protocol in **real time**, with a
small hand-rolled WebSocket client in the driver (Python's standard library has none). The
driver navigates, polls the page's own `#v0status`/`#v0meta` until the page says it has
finalised, and only then captures. Nothing is timed by guesswork.

**Flags:** the driver probes flag sets in order and records what happened. On this machine
the first one wins — **no GPU flags at all**: headless Edge on Windows uses the real GPU,
WebGL2 is available, and the whole run takes about 40 s. `--disable-gpu` also boots fine and
renders correctly through SwiftShader, but is roughly 30x slower on 26,369 extruded
polygons, so it is kept as the first fallback, followed by the two swiftshader variants.
`--enable-unsafe-swiftshader` was never needed here.

**The `--virtual-time-budget` approach in the brief does not work for this page, and fails
in a way worth recording.** It is fine for a still map — the boot assertion still uses it,
via `--dump-dom`, exactly as specified. But for anything animated:

- Virtual time stops issuing animation frames the moment the page is briefly idle, and once
  stopped it never restarts, because the only thing that would repaint the page is the frame
  that is not coming. Measured: the page's clock raced on to `now: 32244` while
  `renders` stayed at 3 and `ticks` at 14. deck.gl's entire render loop is rAF, so under
  virtual time no transition can run and no render-completion hook can fire.
- Adding `--deterministic-mode` (which implies begin-frame control and running all
  compositor stages before draw) revived frames — but only with a software GL backend, and
  only sometimes: the same command, same flags, produced a completed morph on one run and a
  frozen seed on the next.
- Screenshots taken while that was happening were sometimes *partial frames* — half the
  boroughs rendered as blown-out white blobs — which would have been very easy to mistake
  for a rendering bug in the harness.
- The page's `renders` and `ticks` counters were added specifically to tell these apart, and
  they are what made the diagnosis possible. They are worth keeping.

The 100 ms `setInterval` in the harness that refreshes the HUD and status nodes is part of
the same story: a status node that can only be updated from inside rAF freezes at whatever
it said when the frames stopped, which is exactly the state a driver most needs to read.

`--user-data-dir` per launch, and process trees are killed **by pid** on timeout, never by
image name — killing every `msedge.exe` on the machine would take the user's own browser
with it.

---

## 6. Full verification output

**First pass — superseded by fix round 1.** The block below is the `RESULTS.txt` this
driver produced *before* the transition fix (§4 / fix round 1) — it predates the
progression assertion entirely, and its "mid-flight position" section is the "the morph is
a cut" diagnostic, not the post-fix progression check. It is kept here as the historical
record of the first pass. It is **not** what `tools/morph-lab/captures/v0/RESULTS.txt`
currently contains — the current file is quoted verbatim in "Fix round 2 -> Current
committed RESULTS.txt" at the end of this report.

```
boot probe  [real GPU] {"ready":true,"errors":0,"tier":"borough","morphBasis":null}
morph probe [real GPU] log: seed, commit, animate, finalise all reached

PASS boot   --dump-dom of ?show=borough -> {"ready":true,"errors":0,...}
PASS frames a morph reaches finalise under [real GPU]

s1_show_borough        borough tier, true values         tier borough, morphBasis null
s2_plateau_oa_borough  OA basis, borough values          tier borough, morphBasis oa
s3_show_ward           ward tier, true values            tier ward
s4_morph_borough_ward  after finalise                    seed+6 commit+253 animate+258 finalise+1071
s5_show_gla            gla tier, true values             tier gla
s6_morph_pcon_gla      after finalise                    seed+5 commit+228 animate+230 finalise+1043
mid_25 / mid_50 / mid_75   25/50/75% of a 3000 ms morph

PASS s1 vs s2   MAD 0.0445/255   419 of 1,220,800 = 0.0343%   max channel diff 99
PASS s3 vs s4   MAD 0.0003/255    15 of 1,220,800 = 0.0012%   max channel diff 37
PASS s5 vs s6   MAD 0.0001/255     4 of 1,220,800 = 0.0003%   max channel diff 26

---- mid-flight position: a diagnostic, not an assertion ----
     borough and ward are 6.2071/255 apart
     mid_25.png  6.2235 from the borough start,  0.0310 from the ward end -> 100.3% across
     mid_50.png  6.2235 from the borough start,  0.0310 from the ward end -> 100.3% across
     mid_75.png  6.2235 from the borough start,  0.0310 from the ward end -> 100.3% across

RESULT ALL ASSERTIONS PASS    (exit 0)
```

Limits: MAD ≤ 2.0/255 and ≤ 0.5% of pixels differing by more than 12/255, over the whole
1400×950 frame with the top-left 420×260 control/HUD corner masked out.

Timings from the page's own HUD, on the real GPU: `paintFrom` over 26,369 features and
~1.4 M vertices runs in **1.5–6 ms**; steady-state frame time **5.6 ms EMA**. The one
expensive frame is the seed's, which is where the basis layer's tessellation is paid — 210
to 870 ms depending on how warm the process is, visible in the log as the gap between
`seed` and `commit`. `afterCommit` absorbs it rather than letting it eat the front of the
transition, which is the behaviour it was specified for.

---

## 7. Concerns

1. **The transition cuts.** §4. This is the open question for v1 and the recommendation
   there is concrete.
2. **The seed frame costs 210–870 ms.** All six tiers are painted at boot as the brief
   required, but painting a hidden layer does not tessellate it — deck defers that to the
   first draw — so the cost lands on the first morph regardless. If v1 keeps the basis
   permanently visible, this disappears with the same change that fixes the transition.
3. **The mid-flight PNGs are currently evidence of the defect, not of the effect.** They
   are committed anyway, and the driver prints where they sit between the endpoints so the
   file says what it is. An earlier run, before the `afterCommit` ordering fix, happened to
   catch a genuine part-morphed frame — bars part way between borough plateaus and ward
   detail, and it looked exactly as hoped. Not committed, because it came from a run whose
   assertions did not pass.
4. **Only one measure and one year are exercised.** `pop_density` is a `kind: "value"`
   measure, so `shownValue`'s share branch and the `suppressed`/`MIN_BASE` path for small
   denominators are barely touched. A count measure at OA grain, where suppression is
   common, would exercise the "suppressed parent hands NODATA to all its children" rule far
   harder than density does.
5. **Two of the six pairs are untested by assertion.** `lsoa -> oa` and `oa -> lsoa` are on
   the buttons and go through the `parentIdx === null` delegation path, but only
   `borough -> ward` and `pcon -> gla` are asserted. The delegation is exercised (the
   `?show=` captures all route through it), the specific pair is not.
6. **The driver needs an unsandboxed shell.** Launching a browser and binding a local port
   are both blocked by the default tool sandbox; the run needs it disabled. Worth knowing
   before anyone re-runs it.

---

# Fix round 1 — the morph now slides

**Status after the fix: DONE.** Commit `35df68f`. All four assertions pass, exit 0.

The coordinator was right and my §4 diagnosis was half wrong. I had two facts —
"a hidden paint does not upload" and "`transitions: {}` breaks the next paint" — and I
bundled them into one conclusion. Only the second is true. Production seeds its incoming
tier hidden via `paintFlat` and its FADE_UP rise animates in the shipped map, which is the
counter-example I should have taken seriously: hidden seeding is fine, and production never
passes an empty transitions object. The always-visible-basis pivot is withdrawn.

## What changed

**1. The snap is a zero-length transition, not an absent one.** `polyLayer` now always
emits the same transitions object and swaps only the duration:

```js
transitions: TRANSITION ? {
  getFillColor: { duration: T.snap ? SNAP_MS : (T.dur || TRANSITION), easing: … },
  getElevation: { duration: T.snap ? SNAP_MS : (T.dur || TRANSITION), easing: … }
} : {}
```

Because the prop's shape never changes, deck.gl keeps tracking the attribute and keeps the
buffer it will interpolate *from*, so the animate that follows a seed starts from the
seeded values.

**2. `SNAP_MS = 1`, not 0 — and this mattered.** With `duration: 0` the morph animated, but
out of the wrong picture: frames sat ~56/255 from *both* endpoints when the endpoints are
19/255 apart, i.e. off the segment entirely, sliding out of the raw output-area map.
deck.gl 9 treats a zero duration as unset and substitutes its own default, so `duration: 0`
is not a snap at all — it is a full-length animation wearing a snap's clothes, and the
animate 200 ms later interrupted it a quarter of the way along. One millisecond is a real
duration, is honoured, and completes on the frame after the one that starts it. Exactly the
fallback the coordinator anticipated.

**3. `afterCommit(cb, frames)`, and the seed waits two.** A transition that has only been
*created* has not yet been *applied* — on the render that first sees the new values, the
attribute still holds the old ones. Handing the animate over at that moment makes it
interpolate from the value the snap was supposed to have replaced. One more committed frame
and the snap has landed. (With one frame and `SNAP_MS = 1` the morph still slid out of the
pre-seed map; with two it is correct.)

**4. The destination layer is snapped again at FINALISE.** It is painted at ANIMATE while
hidden, and a hidden layer is not drawn, so the draw it gets at the swap is its first.
Without the snap deck.gl gave it a full-length transition and the tier just morphed to
faded up over 750 ms. This is the one place my previous round had it backwards: under
`transitions: {}` that same line turned the two end-state assertions from 0.0002/255 into
17/255, which is why I had removed it. Under a 1 ms duration it does the opposite — it is
what makes the swap exact:

```
without the FINALISE snap   s3 vs s4  MAD 0.9821/255   16,001 px (1.31%)
                            s5 vs s6  MAD 1.8533/255   35,267 px (2.89%)
with it                     s3 vs s4  MAD 0.0001/255        5 px (0.0004%)
                            s5 vs s6  MAD 0.0000/255        0 px (0.0000%)
```

**5. Boot warm-up.** All six painted tiers stay in the layer stack with only visibility
flipped, as before; boot now additionally draws the basis alone for one snapped frame
before `ready` flips, so the first morph's seed does not pay to tessellate 26,369 output
areas.

**6. The driver gained a progression assertion** (`progression()` in `capture_v0.py`),
which is now part of the exit code: pixel-progress of the three mid-flight frames must be
strictly increasing, p25 ≥ 1%, p50 within 15–85%, p75 ≤ 99.9%. Progress is
`MAD(frame, borough) / MAD(borough, ward)`. Note the metric has a floor of about 24%: the
borough outlines switch on at ANIMATE (`curTier` becomes ward), which is a real, intended
difference from the borough view and is present in every mid frame. The bands are generous
enough to absorb it, and every raw number is printed so it can be audited.

## New assertion numbers

```
PASS boot     --dump-dom of ?show=borough -> {"ready":true,"errors":0,...}
PASS frames   a morph reaches finalise under [real GPU]

PASS s1_show_borough vs s2_plateau_oa_borough      (the plateau claim)
     MAD 0.0445/255 (limit 2.0)   419 of 1,220,800 = 0.0343% (limit 0.5%)   max 99
PASS s3_show_ward vs s4_morph_borough_ward         (nested pair, end state)
     MAD 0.0001/255                 5 of 1,220,800 = 0.0004%                max 35
PASS s5_show_gla vs s6_morph_pcon_gla              (non-nested pair, end state)
     MAD 0.0000/255                 0 of 1,220,800 = 0.0000%                max 0

---- mid-flight progression: does the morph SLIDE? ----
     borough and ward are 6.2072/255 apart
     mid_25   2.0825 from the borough start,  4.4693 from the ward end  ->  33.55% across
     mid_50   4.5129 from the borough start,  2.3457 from the ward end  ->  72.70% across
     mid_75   6.0658 from the borough start,  0.2863 from the ward end  ->  97.72% across
     pass strictly increasing   pass p25 >= 1.0%   pass p50 within 15-85%   pass p75 <= 99.9%
PASS the morph interpolates: 33.55% -> 72.70% -> 97.72%

RESULT ALL ASSERTIONS PASS   (exit 0)
```

`s5` vs `s6` came in at a literal zero — not one pixel of 1.22 million differs between the
Assembly-seat map reached by morphing from constituencies and the same map drawn directly.
The mid-flight PNGs are now what they were always meant to be: `mid_50.png` shows ward
detail emerging out of the borough plateaus, with the borough outlines drawn over the top.

## Seed-frame cost after the fix

From the HUD baked into `mid_50.png`: `frame 5.6 ms ema`, `worst/2s 211.2 ms`,
`paint 0.3 ms`. The morph log reads `seed+4 commit+211 animate+214` — 211 ms across the two
committed frames the seed now waits for, and the worst single frame in the window is
211 ms, so essentially all of it is one frame.

Before the warm-up the equivalent worst frames were 683 ms and 1045 ms in captured HUDs,
and the cold-process morph probe logged `commit+865` for a single frame. So the warm-up
moved most of the cost into the load — `readyAt` goes from ~1.4 s to ~3.1 s — and left
~211 ms behind. That residual is deck.gl re-uploading the basis layer's attributes on the
frame it becomes visible again (1.4 M colour bytes plus 350 k elevation floats); the
warm-up cannot pre-pay it because the layer is hidden in between. It is one frame at the
very start of the morph, before anything is moving, and `afterCommit` absorbs it rather
than letting it eat the front of the transition — but it is a 211 ms hitch on the click and
worth attacking in v1.

## Remaining concerns

1. **211 ms seed frame** (above). Not a correctness problem; it is the one perceptible cost
   left in the interaction.
2. **`SNAP_MS = 1` is a deck.gl-version-sensitive constant.** It works because 1 is truthy
   and completes within a frame. A future deck.gl that clamps or rounds durations could turn
   it back into a visible animation. The comment in `polyLayer` says so, and the progression
   assertion plus the two end-state assertions would both catch it.
3. **The progression metric carries a ~24% floor** from the borough outlines switching on at
   ANIMATE. Harmless for a monotonicity check, but the absolute percentages should not be
   read as "the easing is at 33% here".
4. Unchanged from the first round: only `pop_density`/2021 is exercised, so the
   count-measure suppression path is barely touched; `lsoa↔oa` are wired to buttons but not
   asserted; and the driver needs an unsandboxed shell.

---

# Fix round 2 — assert page errors, and correct two stale-number passages

**Status: DONE.** Two review findings, fixed exactly as scoped; no other behaviour touched.

## Finding 1 — the six CDP capture runs never asserted page errors

Before this round, `is_ready`/`finalised` (the `poll()` wait-conditions) only checked
`ready`/the morph log, and `shot()`'s return value was just `got` — whether the wait
condition was reached — never `st.get("errors")`. A `window.onerror` or unhandled rejection
firing mid-morph (`noteError` in the harness, which still increments `LAB_ERRORS` and
updates `#v0status`'s `errors` count and `#v0err`'s text) would not fail the run: 6 of the 9
captures (`s1`-`s6`, via `shot()`) ignored it outright, and the 3 mid-flight captures
(`mid_25`/`mid_50`/`mid_75`) were not folded into `ok_all` at all — not even for `got`.

Changed in `tools/morph-lab/capture_v0.py`:

- `STATE_JS` now also reads `#v0err`'s text (`e`), alongside the existing `#v0status` (`s`)
  and `#v0meta` (`m`).
- `poll()` returns a fourth value, the `#v0err` text as it stood at the last successful read
  (`return True/False, st, mt, err`), so every caller can report it without a second
  round-trip. All three call sites updated.
- `shot()` now computes `ok = got and st.get("errors") == 0` and returns `ok`, not `got`. The
  status word distinguishes `"STATE NOT REACHED"` (wait condition never met) from
  `"PAGE ERROR"` (condition met, but the page recorded an error) so a failure is diagnosable
  from the log line alone. On `not ok` it prints `page errors (#v0err): <text>`.
- The mid-flight loop (`mid_25`/`mid_50`/`mid_75`), which previously had no ok-tracking
  whatsoever, now computes the same `ok = got and st.get("errors") == 0`, folds it into
  `ok_all` with `ok_all &= ok`, and prints the same status/log/error-text diagnostics on
  failure. These three captures now actually affect the exit code.
- The boot probe (`run_once`/`--dump-dom`) already asserted `st.get("errors") == 0`; that
  path is unchanged. The flag-set "FRAMES" probe (used only to pick a working flag set, not
  one of the 9 committed captures) now also logs `#v0err` text on the probe run, for the same
  diagnosability reason, without gating flag-set selection on it.

Verified by re-running the driver end-to-end (below): all `errors: 0` in every capture, and
every `shot`/mid-frame line reports `"ok"`, confirming the new check doesn't misfire on a
clean run.

## Finding 2 — stale pre-fix numbers in §1 and §6

§1 quoted the `s3` vs `s4` and `s5` vs `s6` MAD/pixel-count figures from the *first pass*
(0.0003/255, 15px / 0.0001/255, 4px) without noting the transition fix had since changed
them, and §6 asserted `RESULTS.txt` was "committed verbatim" while quoting the pre-fix
`RESULTS.txt` (no progression assertion, "mid-flight position: a diagnostic, not an
assertion" instead of the post-fix progression check). Both passages are now labelled
**"First pass — superseded by fix round 1"** in place, with the quoted first-pass numbers
left untouched (not deleted — this is the historical record of what fix round 1 changed) and
a pointer added to where the current numbers live: the "Fix round 1 -> New assertion
numbers" summary above, and the fresh verbatim `RESULTS.txt` quoted below.

## Re-run: an Edge-specific environmental snag, worked around via the driver's own `--browser` flag

`python tools/morph-lab/capture_v0.py` (unsandboxed shell) failed immediately: all four flag
sets in `FLAG_SETS` produced `<no status node>` from the `--dump-dom` boot probe in ~0.1 s
each, so `chosen` stayed `None` and the driver exited 1 before reaching the CDP-driven
capture phase at all.

**Diagnosis, by measurement, not by reading:**

- Isolated to the one-shot CLI flags specifically. `msedge.exe --headless=new --dump-dom
  about:blank` (no other flags at all) returns exit code 0 in ~0.05 s with **empty stdout and
  empty stderr** — even with `--enable-logging=stderr --v=1`, which should print Chromium's
  own startup logging if the process were doing any real work. `--screenshot=` behaves
  identically. `--no-sandbox`, `--single-process` and `--disable-dev-shm-usage` made no
  difference.
- The CDP path does not have this problem. `msedge.exe --remote-debugging-port=N
  --user-data-dir=<fresh temp dir> about:blank` launches correctly: the DevTools HTTP
  endpoint answers immediately with real browser/protocol info, even though the *launched*
  process itself also exits within ~2 s — headless Edge on Windows hands off from the
  process the OS started to a further, still-running process for this launch mode, and this
  driver's own `launch()`/`wait_devtools()` was already written to not care (it never checks
  the child's own exit status, only the DevTools port). `run_once()`, used only by the
  `--dump-dom` boot probe, does care — it captures the *launched* process's own stdout via
  `subprocess.run(...).communicate()` — so it is exposed to exactly the failure mode the CDP
  path is immune to.
- It is specific to this Edge install, not a general headless-Chromium regression on this
  machine: `chrome.exe --headless=new --dump-dom about:blank`, tested with Chrome already
  running (2 processes, same as Edge's many), returned real output —
  `<html><head></head><body></body></html>` — in 0.97 s.

This is an environmental problem: this machine's installed Edge (`Edg/151.0.4129.78`)
currently no-ops one-shot CLI automation flags outside the DevTools protocol, for reasons not
fully root-caused here (a Windows-specific relaunch/hand-off behaviour is the leading
hypothesis, per the point above, but it wasn't chased further since it sits outside both
findings' scope). It is unrelated to either fix in this round — neither touches `run_once`,
`FLAG_SETS`, or anything upstream of the CDP-driven capture phase — and predates them; nothing
was weakened to route around it.

`capture_v0.py` already ships a `--browser` override for exactly this situation, so the
re-verification ran as:

```
python tools/morph-lab/capture_v0.py --browser "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

**Result: exit 0, `RESULT ALL ASSERTIONS PASS`.** All 9 captures reported `"ok"` (`errors: 0`
throughout — Finding 1's new check had nothing to catch on a clean run), and the numbers are
the first pass's committed values within noise (different browser, different GPU driver
path):

```
PASS s1 vs s2   MAD 0.0445/255   419 of 1,220,800 = 0.0343%   max channel diff 99   (unchanged)
PASS s3 vs s4   MAD 0.0000/255     1 of 1,220,800 = 0.0001%   max channel diff 25   (was 0.0001/255, 5px, max 35)
PASS s5 vs s6   MAD 0.0000/255     0 of 1,220,800 = 0.0000%   max channel diff  1   (was 0.0000/255, 0px, max 0)

mid-flight: 33.81% -> 73.32% -> 97.98% across   (was 33.55% -> 72.70% -> 97.72%)
```

`tools/morph-lab/captures/v0/RESULTS.txt` and all 9 PNGs regenerated in place; the `browser`
line in `RESULTS.txt` now reads Chrome rather than Edge as a direct consequence of the
override, which is expected and not a code change.

## Current committed RESULTS.txt (verbatim)

This is `tools/morph-lab/captures/v0/RESULTS.txt` as committed at the end of this round, in
full, unedited. It is the single source of truth for every "current" number cited anywhere
in this report (§1, §6, and the delta comparison above).

```
driver     capture_v0.py
browser    C:\Program Files\Google\Chrome\Application\chrome.exe
serving    C:\Users\neilg\OneDrive\Documents\neilgarratt.com\Neil_Garratt_Hugo_Site\static  ->  http://127.0.0.1:53102/labs/morph/v0/

boot probe  [real GPU                              ] {"ready":true,"errors":0,"tier":"borough","morphBasis":null}  (4.6s)
morph probe [real GPU                              ] {"readyAt": 3262, "transition": 750, "dur": 750, "paintMs": 3.8, "now": 4805, "renders": 108, "ticks": 176, "queued": 0, "log": ["borough->ward", "seed+4", "commit+216", "animate+223", "finalise+1034"]}

PASS boot   --dump-dom of ?show=borough -> {"ready":true,"errors":0,"tier":"borough","morphBasis":null}
PASS frames a morph reaches finalise under [real GPU]

shot s1_show_borough.png          borough tier, true values            4.1s  ok
     {"status": {"ready": true, "errors": 0, "tier": "borough", "morphBasis": null}, "log": []}
shot s2_plateau_oa_borough.png    OA basis, borough values             1.8s  ok
     {"status": {"ready": true, "errors": 0, "tier": "borough", "morphBasis": "oa"}, "log": []}
shot s3_show_ward.png             ward tier, true values               1.8s  ok
     {"status": {"ready": true, "errors": 0, "tier": "ward", "morphBasis": null}, "log": []}
shot s4_morph_borough_ward.png    borough->ward, after finalise        3.3s  ok
     {"status": {"ready": true, "errors": 0, "tier": "ward", "morphBasis": null}, "log": ["borough->ward", "seed+4", "commit+214", "animate+218", "finalise+1033"]}
shot s5_show_gla.png              gla tier, true values                2.2s  ok
     {"status": {"ready": true, "errors": 0, "tier": "gla", "morphBasis": null}, "log": []}
shot s6_morph_pcon_gla.png        pcon->gla, after finalise            3.7s  ok
     {"status": {"ready": true, "errors": 0, "tier": "gla", "morphBasis": null}, "log": ["pcon->gla", "seed+4", "commit+233", "animate+237", "finalise+1051"]}
shot mid_25.png                   25% of a 3000 ms morph               2.8s  ok
shot mid_50.png                   50% of a 3000 ms morph               3.6s  ok
shot mid_75.png                   75% of a 3000 ms morph               4.4s  ok

---- assertions ----
PASS s1_show_borough.png vs s2_plateau_oa_borough.png
     the plateau claim: 26,369 output areas painted with their borough's value == the 33-borough map
     MAD 0.0445/255 (limit 2.0)   pixels >12/255: 419 of 1220800 = 0.0343% (limit 0.5%)   max channel diff 99

PASS s3_show_ward.png vs s4_morph_borough_ward.png
     nested pair: borough->ward morph lands exactly on the ward map
     MAD 0.0000/255 (limit 2.0)   pixels >12/255: 1 of 1220800 = 0.0001% (limit 0.5%)   max channel diff 25

PASS s5_show_gla.png vs s6_morph_pcon_gla.png
     non-nested pair: pcon->gla morph lands exactly on the Assembly-seat map
     MAD 0.0000/255 (limit 2.0)   pixels >12/255: 0 of 1220800 = 0.0000% (limit 0.5%)   max channel diff 1

---- mid-flight progression: does the morph SLIDE? ----
     borough and ward are 6.2072/255 apart
     mid_25   2.0988 from the borough start,  4.4574 from the ward end   ->  33.81% across
     mid_50   4.5509 from the borough start,  2.3042 from the ward end   ->  73.32% across
     mid_75   6.0817 from the borough start,  0.2603 from the ward end   ->  97.98% across
     pass strictly increasing
     pass p25 >= 1.0%
     pass p50 within 15-85%
     pass p75 <= 99.9%
PASS the morph interpolates: 33.81% -> 73.32% -> 97.98%

RESULT ALL ASSERTIONS PASS
```

**Not fixed, and out of scope for this round:** the Edge one-shot-flag snag itself. Whoever
next runs this driver on a machine where headless Edge exhibits the same behaviour will hit
the same `FAIL: no flag set both booted the page and ran a morph to finalise` at the boot
probe, before ever reaching the two findings fixed here. Worth a `run_once` rewrite onto the
CDP path (so the boot probe shares the same immunity the capture phase already has) in a
future round — flagged here rather than folded into either finding.

---

# Fix round 3 — §1/§6 were pointing at fix-round-1 numbers, not the current file

**Status: DONE. Documentation only — no code, no captures, no commit this round.**

Fix round 2's own reconciliation was itself one refresh cycle behind by the time it landed:
its Chrome re-run regenerated `RESULTS.txt` with slightly different pixel counts than the
numbers §1 quoted as "current," because §1 had been written against the *first* post-fix
run (the one under Edge, still described in "Fix round 1 -> New assertion numbers") rather
than the *final* one committed at the end of round 2 (under Chrome, quoted nowhere in full
until now). Neither number was wrong for the moment it was written; §1 just wasn't updated
after the ground moved under it a second time.

Fixed:

- §1's "now reads" sentence corrected to the actually-current values: MAD 0.0000/255,
  1 of 1,220,800 px (0.0001%), max 25 for `s3` vs `s4`; MAD 0.0000/255, 0 px (0.0000%),
  max 1 for `s5` vs `s6`. It now points at "Fix round 2 -> Current committed RESULTS.txt"
  (added this round, see below) instead of "Fix round 1 -> New assertion numbers," and says
  explicitly that the latter is a snapshot of round 1's own re-verification, not the current
  file.
- §6's pointer sentence corrected the same way.
- Fix round 2 previously claimed the current file was "quoted verbatim" in that section but
  only carried a 4-line delta summary — no such verbatim block existed. Added one: "Fix round
  2 -> Current committed RESULTS.txt," the full, unedited contents of the `RESULTS.txt`
  actually committed at the end of round 2. §1 and §6 now both resolve to a real quotation
  rather than a broken forward-reference.
- Checked the rest of the report against the currently committed `RESULTS.txt` (read fresh,
  not trusted from any earlier draft of this document) for the same failure mode: the `s1` vs
  `s2` plateau-claim figures (0.0445/255, 419 px, max 99) and the boot-assertion JSON are
  unchanged across every run from the first pass onward and needed no correction. §4 and §7's
  numbers are first-pass narrative about the transition-cut bug that no longer exists; they
  are already covered by the top-of-report banner marking the whole first-pass body FIXED/
  WITHDRAWN, so they were left as historical narrative rather than re-labelled line by line.
  "Fix round 1 -> New assertion numbers" is left as it was — a dated record of that round's
  own re-verification, not a claim of currency — since Fix round 2's delta comparison already
  states plainly what changed since ("was 0.0001/255, 5px, max 35 ... now 0.0000/255, 1px,
  max 25").

No driver run, no captures, no `tools/morph-lab/` code changes this round; nothing to commit.
