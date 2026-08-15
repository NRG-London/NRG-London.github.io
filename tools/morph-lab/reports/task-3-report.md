# Task 3 (M2) — V1: the full census map with the curtain replaced by the morph

**Status: DONE.** Commits `67cb60f` and `ff6ca18` on `labs/morph`. All driver assertions pass,
exit 0.

> Sections 1–8 are the first round and their numbers are from that run. **Fix round 1** at the
> end of this document is the current state: one Important review finding fixed (`morphReady()`
> must not require `B.painted`), a twelfth assertion added for it, and concern 3 rewritten. The
> current count is **12 assertions**; §7's verbatim output predates A12.

Deliverables:

- `static/labs/morph/v1/index.html` — production `static/interactive/london-population/index.html`
  with 19 lines changed and 642 added (+16 in fix round 1).
- `tools/morph-lab/capture_v1.py` — 12 assertions, CDP-driven, Chrome by default.
- `tools/morph-lab/captures/v1/` — 18 PNGs + `RESULTS.txt`.

`content/_index.md` was never touched and is still unstaged; `.superpowers/` is not staged.

---

## 1. Headline

Every one of the six ordered pairs the driver exercises lands on the directly-loaded map to
within **MAD 0.0000–0.0004 of 255**, on a **full 1400×950 frame with no crop at all** —
production card, legend, pill rows, footer and Thames included. v0 had to crop a 420×260
corner because its lab panel carried a live frame-time readout; v1's three status nodes are
`display:none` and its HUD is off unless `?hud=1`, so there is nothing to crop around and the
comparison is strictly stronger than v0's.

```
A2  default boot -> ward, morphed     MAD 0.0002/255      11 px of 1,330,000  (0.0008%)
A3  pcon -> gla (non-nested)          MAD 0.0000/255       0 px               (0.0000%)
A3  ward -> borough (merge)           MAD 0.0000/255       0 px               (0.0000%)
A5  interrupt, retargeted mid-flight  MAD 0.0001/255       8 px               (0.0006%)
A7  lsoa -> oa under suppression      MAD 0.0001/255       6 px               (0.0005%)
A8  change view, borough -> ward      MAD 0.0002/255      18 px               (0.0014%)
A10 endpoint after a mid-flight zoom  MAD 0.0003/255      22 px               (0.0017%)
```

`ward -> borough` is a literal zero: not one pixel of 1.33 million differs between the borough
map reached by merging 689 wards into 33 boroughs and the same map loaded directly — including
the borough outlines correctly stepping back out at FINALISE.

Two things failed on the first run. Neither was a threshold problem and neither was weakened:
one was a real behavioural bug in the page (§6), the other a real flaw in my metric (§5).

---

## 2. The patch surface

19 production lines changed. `git diff` against a line-ending-normalised copy of production:
**642 insertions, 19 deletions**, and 9 of those 19 are the `data:` literal being moved
verbatim into a helper. The curtain block and the plain-paint block inside `apply()` are
**byte-for-byte** production; the only line altered in either is `if (crossFade) {` becoming
`} else if (crossFade) {`.

Complete list of production lines removed:

```
-<title>Mapping London's Population — Census 2011 and 2021 in 3D</title>
-  var DATA_BASE = "d/";
-      data: { …9 lines… },                     (moved into polyData(T))
-      extruded: true, filled: true, wireframe: false, pickable: true,
-          duration: T.dur || TRANSITION,
-        getElevation: { duration: T.dur || TRANSITION, easing: … }
-        if (T && T.painted) stack.push(polyLayer(T, fading ? t === fading : t === tier));
-        if (crossFade) {
-    onAfterRender: function () { framed = true; settle(); }
-  function notDone() { framed = false; settling = false; window.__NG_DONE__ = false; }
-  apply();
```

### Functions touched, and why

| Function | Change | Why |
|---|---|---|
| `polyLayer` | `pickable: !T.noPick`; `T.snap ? SNAP_MS : (T.dur \|\| TRANSITION)` in both transitions; `data: polyData(T)` | Picking off the basis for the flight; the v0 snap contract; §6 |
| `polyData` (new) | caches the binary `data` object per tier, keyed on `T.phase` | §6 — the A10 fix |
| `redraw` | clears `T.snap` on every resolved tier after `setProps` | A snap is a property of one paint, not of the tier |
| `buildStack` | `morphBasis ? t === morphBasis : (fading ? … : t === tier)` | The morph visibility rule, ahead of the curtain's |
| `apply` | captures `fromVals`/`fromNd` before the `CURRENT_VALS` reassignment; adds `doMorph`, an `endMorph()` guard, and a third branch | The morph needs the OUTGOING tier's values, which live for two more lines |
| `notDone` | `+ setStatus()` | Keeps `#v1status.ready` honest |
| `settle` | `+ setStatus()` | Same |
| deck `onAfterRender` | `+ onRendered()` | Drives `afterCommit` off deck's own commit, not a rAF guess |
| boot | `apply()` → `apply().then(warmMorph)` | Warm-up starts after the first view, and rejection still surfaces |
| `paint`, `paintFlat`, `suppressed`, `shownValue`, `changeValues`, `startPulse`, `pulseLayer`, `buildTooltip`, `applyZoom`, `setTier`, `setArea`, `setYear`, `setMeasure`, `loadTier`, `loadGroup`, `prefetchOtherYear`, all chrome | **untouched** | Inherited correctness |

`applyZoom` is deliberately **not** patched — see §6.

### Added (all new code, nothing rewritten)

`loadParents`/`PARENTS`, `paintFrom`, `SNAP_MS`, `polyData`, `afterCommit`/`fireCommit`/
`onRendered`/`armWatchdog`, `morphReady`, `endMorph`, `morphTier`, `warmMorph`, the morph
globals, the error/status/meta instrumentation, `window.__v1`, and the `?hud=1` overlay.

### The three fixes the brief asked for during transplant

1. **FINALISE destination snap guarded** — `if (toKey !== BASIS && READY[toKey]) READY[toKey].snap = true;`.
   Without the guard, a morph *to* the output areas would snap the very layer that had just
   spent 750 ms animating.
2. **`afterCommit(cb, frames)` → `afterCommit(cb, commits)`** — `frames` was the HUD's
   frame-time ring name in v0.
3. **Watchdog added**, with one deliberate change of shape: the timer is **restarted on every
   committed render**, so it means "nothing has been drawn for 500 ms", not "this has taken
   500 ms". v0 measured the first seed frame at ~210 ms on its own; a flat 500 ms budget for
   two of those would be perilously close, and pre-empting a slow-but-progressing pipeline
   would start the animate before the snap had landed — exactly the bug the two-commit wait
   exists to prevent. A stalled pipeline still self-heals, and a watchdog firing writes
   `watchdog+N` into the morph log where the driver can see it. It never fired in any run.

---

## 3. Decisions on open details

| Detail | Decision | Why |
|---|---|---|
| `morphReady()` signature | `morphReady(fromT, toKey, fromVals)`, not `morphReady()` | Beyond "basis warm + parents loaded" it also checks both endpoints are reachable from the basis and that `fromVals.length === fromT.header.nFeatures`. That last one is a real guard: a length mismatch means an earlier `apply()` is still in flight and the plateau would be seeded from the wrong tier's numbers. It falls back to the curtain rather than drawing a lie. |
| Where the warm-up hangs | `apply().then(warmMorph)` | `.then(fn)` with no rejection arm: a boot failure still reaches `unhandledrejection` exactly as production's bare `apply()` does. Adding `.catch` would have swallowed it. |
| What the warm draw shows | The basis painted **as the tier already on screen**, not as the OA map | v0 could flash the raw OA map during boot because nobody was looking. Here the map is already up, so the warm frame is the *plateau* — pixel-identical to the frame before it (v0 measured that swap at 0.0445/255). |
| Warm draw in street mode | Painted but never shown | At 0.3 opacity 26,369 blended solids do not compose identically to 33, so the "invisible" frame would not be invisible. Street mode keeps the curtain anyway; the cost is that the first morph after leaving it pays its own buffer upload. |
| A morph in flight when a non-morph `apply()` lands | New `endMorph()`, called from `apply()` before either legacy branch | Both branches paint `T` and redraw, and a live `morphBasis` would keep the basis as the only thing drawn and hide the result. Reachable via a measure or year change mid-morph. |
| `?morphdur=N` | Added, off by default | The driver needs a morph slow enough that a ~60 ms capture round trip is a small share of it. Reads through the page's existing `params` plumbing; three lines. |
| Extra status field | `morphReady` added to `#v1status`'s five | The driver must know when the curtain has stopped being the honest answer, or it would test the curtain and call it a morph. |
| Meta node | `#v1meta` added alongside `#v1status` | Carries the morph log, `t0`, render count and `curElevScale`, so mid-flight frames are taken against an absolute page-clock deadline rather than by sleeping and hoping. Both nodes `display:none`. |
| A5 interrupt target | `borough → pcon` retargeted to **ward**, not to pcon | Same test — a morph interrupted mid-flight must land exactly on the second target — but it reuses `a2_ref_ward.png` instead of needing a 19th PNG. |
| Crop region | **None** | Nothing in the lab moves a pixel by default, so all comparisons are full-frame. |

---

## 4. The suppression measure: `resident_under5y`, and why the pair is `lsoa → oa`

The brief asked for "a measure+tier pair with real suppression at OA level … run borough→ward
under it". I inspected the data first, and the second half of that does not exist. Suppression
is `residents <= 0 || base[denom] <= 0 || base[denom] < minBase`, counted over every tier, both
years, every denominator the 63 measures use:

```
gla      2021/2011   no suppression          borough  2021/2011   no suppression
pcon     2021/2011   no suppression          ward     2021/2011   no suppression*
lsoa     2021        no suppression*         lsoa     2011        residents=2 households=6
                                                                  res16plus=4 emp16plus=6
                                                                  nonukborn=5
oa       2021        emp16plus=9  nonukborn=294
oa       2011        residents=365 households=324 res3plus=329 res5plus=345
                     res16plus=341 emp16plus=464 nonukborn=1729
                                          (* ceres suppresses, but no measure uses it as a denominator)
```

**Borough and ward suppress nothing, on any measure the page ships.** A `borough → ward` run
under any measure would have exercised the suppression path zero times and asserted nothing —
it would have been a second copy of A2 wearing a different measure key.

So A7 runs **`lsoa → oa` on `resident_under5y`** (group `language`, denominator `nonukborn`,
`minBase` 30). That is where the holes actually are: 294 output areas, 1.11%, and none at lsoa.
The morph therefore starts on a plateau with no holes in it and ends on a map with 294, so the
NODATA colour and zero height are genuinely interpolated *into* during the flight, and the
endpoint identity (MAD 0.0001/255, 6 px) is the assertion that they landed in exactly the right
places. It also happens to cover the `lsoa↔oa` pair the zoom auto-switch drives, and the
`toKey === BASIS` branch of `morphTier` where `paintFrom` delegates to a plain `paint`.

---

## 5. A4: why the reference is the seed frame

v0's report flagged a ~24% floor under its progression metric and the brief asked me to decide
what to do about it. The floor is not noise — it is two real, instant changes that happen the
moment the pill is clicked and before one pixel of the morph has moved:

- the **borough outlines come on**. `setTier` assigns `tier` before `apply()` runs, so
  `buildStack`'s `tier !== "borough" || … || switching` rule flips on the first morph redraw.
- the **card, legend and pill row switch to the destination** — `setText()`, `renderLegend()`
  and `markActive()` run in `apply()`'s shared tail.

Both are inherited production behaviour: the curtain does exactly the same thing at exactly the
same moment. A separately loaded `?tier=borough` frame has neither, so every mid frame differs
from it by a constant that has nothing to do with the morph.

I take the zero from **the run itself, at the seed**, polling for the `seed+N` log entry — which
the page writes after the seed redraw and two committed frames before the animation starts. That
frame has the outlines and the ward chrome and is otherwise the borough map exactly, because
that is what the seed *is*. `a4_from.png` in the committed set shows it: 33 borough plateaus
built out of 26,369 output areas, ward chrome, outlines on.

Cost of catching it late is negligible — the easing is cubic-in-out, so 100 ms into a 3,000 ms
morph is 0.015% of the distance. The floor is gone: **p25 = 7.71%**, against v0's ~24% floor,
and the three frames run 7.71% → 54.13% → 95.03% against sampled times of 27.1% / 52.1% / 77.4%.

A6 needed the same treatment for a different reason, plus one of its own. Its zero is the
settled ward map *before* the measure change, so the chrome the change rewrites is a fixed part
of every number — which is why the binding claim is that the three frames **increase**, not that
any one equals the easing: a cut would put all three at 100%, a dead transition would put all
three on the same floor, and only a real slide increases. It also runs with **`?highlight=off`**,
the page's own switch: the peak-marker pulse is a second production animation that starts 200 ms
after any paint and runs for 810 ms, so it covers nearly the whole 750 ms measure ease. Measured,
its rings put **9,902 pixels more than 40/255 from *both* endpoints** and drove pixel-progress to
**116%**. With the pulse off: **six pixels**. Every other capture waits the pulse out instead
(`SETTLE = 1.6 s` > 1.01 s), so `highlight` is at its default everywhere else.

---

## 6. A10: zoom during a morph — mechanism, the failure, and the real cause

**Mechanism.** `window.__applyZoom(13)` then `__applyZoom(0)`, both issued in one CDP evaluate
with the second on an 80 ms page-side timer. `elevScale(z) = min(1, 2^(CAMERA.zoom − z))`, so
13 gives 0.113 and 0 gives exactly 1 — the restore is bit-exact, so the frame sampled at 75% is
directly comparable to `a4_mid75.png`. Both calls cross `applyZoom`'s 4% rule and rebuild the
layer stack mid-flight, which is the thing under test. I did not use a synthetic pointer event
(it would reveal the "Reset view" button, a chrome difference the references do not have) or a
controlled `viewState` (it would take the camera off the page's own uncontrolled one).

**It failed.** The frame 77.3% through a nudged morph sat at **36.39%** across, against
**94.99%** for the same frame un-nudged — a drift of **58.6 points**. The endpoint was still
exact, which is why endpoint identity alone could never have caught this: the transition
restarted, re-eased over a full duration, and was still moving when FINALISE swapped the real
layer in and cut the last third.

**The cause is not elevationScale.** The brief anticipated suppressing elevScale-only redraws
while `morphBasis` is set, so I measured before implementing. A **bare `redraw()` with no scale
change at all** — `__setMode("boroughs")` while already in boroughs mode, which calls `redraw()`
and `updateChrome()` and changes nothing else — did the same damage:

```
frac    plain     zoom-nudged   bare-redraw
 50%    53.93%      13.45%        15.45%
 70%    90.93%      28.32%        36.76%
 90%   100.03%      70.07%        79.53%
```

The cause is `polyLayer` building a fresh `data` object — and inside it a fresh `attributes`
object — on **every** call. `redraw()` rebuilds every layer, so deck.gl sees a new attribute
descriptor, reads it as the attribute having changed, and restarts the in-flight transition from
wherever it has got to.

**The fix is `polyData(T)`**: cache the binary data object per tier and rebuild it only when
`T.dataPhase !== T.phase`. `T.phase` is bumped by `paint`, `paintFlat` and `paintFrom` and by
nothing else, so the cache invalidates exactly when the buffers are genuinely new — which is
exactly when a transition *should* start. Same measurement after:

```
frac    plain     zoom-nudged   bare-redraw
 50%    54.02%      54.25%        54.25%
 70%    90.79%      90.86%        90.86%
 90%   100.03%     100.04%       100.05%
```

In the committed run, `a10_zoom_mid75` is 94.88% against `a4_mid75`'s 95.03% — **0.14 points of
drift**, down from 58.6.

I chose this over the brief's suggested suppression deliberately, and it is the smaller change
in behaviour: nothing is suppressed, so the bars keep rescaling live throughout a morph. That
matters most for the interaction this whole feature exists for — the `lsoa↔oa` auto-switch is
*triggered by zooming*, so the user is very likely still zooming while it runs, and suppression
would have frozen the bar scale for up to 810 ms and then popped it.

**This is a latent production bug too.** Nothing about it is morph-specific: a zoom during the
shipped curtain's 560 ms FADE_UP restarts that transition the same way. Worth carrying back.

---

## 7. Full driver output

Verbatim `tools/morph-lab/captures/v1/RESULTS.txt` as committed. `python tools/morph-lab/capture_v1.py`,
no arguments, exit 0.

```
driver     capture_v1.py
browser    C:\Program Files\Google\Chrome\Application\chrome.exe
serving    …\static  ->  http://127.0.0.1:63866/labs/morph/v1/
viewport   1400x950, FULL-FRAME comparison — no crop, because the lab's status nodes are
           display:none and the HUD is off unless ?hud=1
settle     1.6s before every committed capture, which outlasts the 1.01s peak pulse

probe [real GPU                              ] boot  {"ready": true, "errors": 0, "tier": "borough", "morphBasis": null, "switching": false, "morphReady": true}
                                             morph ["borough->ward", "seed+5", "animate+193", "finalise+1005"]

PASS probe  boots and morphs to finalise under [real GPU]

---- captures ----
shot a1_ref_borough.png       A1 boot ?morph=0, curtain build sanity         4.9s  ok
shot a2_ref_ward.png          A2 ward, loaded directly                       2.3s  ok
shot a2_morph_ward.png        A2 default boot -> ward, morphed               3.7s  ok
     {"status": {"ready": true, "errors": 0, "tier": "ward", "morphBasis": null, "switching": false, "morphReady": true}, "log": ["lsoa->ward", "seed+7", "animate+161", "finalise+973"]}
shot a3_ref_gla.png           A3 gla, loaded directly                        2.2s  ok
shot a3_morph_gla.png         A3 pcon -> gla (non-nested)                    3.7s  ok
     {"status": {"ready": true, "errors": 0, "tier": "gla", "morphBasis": null, "switching": false, "morphReady": true}, "log": ["pcon->gla", "seed+3", "animate+170", "finalise+984"]}
shot a3_morph_borough.png     A3 ward -> borough (merge)                     3.6s  ok
     {"status": {"ready": true, "errors": 0, "tier": "borough", "morphBasis": null, "switching": false, "morphReady": true}, "log": ["ward->borough", "seed+3", "animate+159", "finalise+973"]}

shot a4_from.png              A4 seed frame — the honest zero                1.4s  ok
shot a4_mid25.png             A4 mid-flight                                       landed at 27.1% of a 3000 ms morph
shot a4_mid50.png             A4 mid-flight                                       landed at 52.1% of a 3000 ms morph
shot a4_mid75.png             A4 mid-flight                                       landed at 77.4% of a 3000 ms morph

shot a5_interrupt_ward.png    A5 borough->pcon, retargeted to ward           3.8s  ok
     at +300 ms: {"ready": false, "errors": 0, "tier": "pcon", "morphBasis": "oa", "switching": true, "morphReady": true}
     final:      {"ready": true, "errors": 0, "tier": "ward", "morphBasis": null, "switching": false, "morphReady": true}
     log:        ["pcon->ward", "seed+0", "animate+16", "finalise+830"]

shot a6_meas_mid/end.png      A6 measure change after a morph                5.8s  ok
     three frames sampled at 125, 264, 484 ms into the 750 ms ease

shot a7_ref_oa.png            A7 oa / resident_under5y, loaded directly      2.5s  ok
shot a7_morph_oa.png          A7 lsoa -> oa under suppression                3.6s  ok
     {"status": {"ready": true, "errors": 0, "tier": "oa", "morphBasis": null, "switching": false, "morphReady": true}, "log": ["lsoa->oa", "seed+4", "animate+157", "finalise+980"]}

shot a8_ref_change.png        A8 ward change view, loaded directly           2.2s  ok
shot a8_morph_change.png      A8 change view, borough -> ward                3.6s  ok
     {"status": {"ready": true, "errors": 0, "tier": "ward", "morphBasis": null, "switching": false, "morphReady": true}, "log": ["borough->ward", "seed+2", "animate+171", "finalise+984"]}

shot -                        A9 street mode keeps the curtain               3.7s  ok
     129 state samples across the switch, morphActive true in 0

shot a10_zoom_mid75.png       A10 zoom during morph                          5.8s  ok
     curElevScale 1 -> 0.11323210104515069 -> 1 across the nudge; frame landed at 77.0% of the morph
     log: ["borough->ward", "seed+4", "animate+182", "finalise+3246"]

shot -                        A11 reduced motion switches instantly          2.5s  ok
     TRANSITION=0  MORPH_DUR=0  93 samples, morphActive true in 0

---- assertions ----
PASS A1 boot with ?morph=0: page ready, errors 0 (curtain build sanity)

PASS a2_ref_ward.png vs a2_morph_ward.png
     A2 endpoint: the default view morphed to ward through the real pill path lands on the ward map
     MAD 0.0002/255 (limit 2.0)   pixels >12/255: 11 of 1330000 = 0.0008% (limit 0.5%)   max channel diff 32

PASS a3_ref_gla.png vs a3_morph_gla.png
     A3 endpoint, non-nested: pcon -> gla lands on the Assembly-seat map
     MAD 0.0000/255 (limit 2.0)   pixels >12/255: 0 of 1330000 = 0.0000% (limit 0.5%)   max channel diff 1

PASS a1_ref_borough.png vs a3_morph_borough.png
     A3 endpoint, merge direction: ward -> borough lands on the borough map, borough outlines stepping back out
     MAD 0.0000/255 (limit 2.0)   pixels >12/255: 0 of 1330000 = 0.0000% (limit 0.5%)   max channel diff 0

A4 mid-flight progression: does the morph SLIDE?
     the seed frame and the ward map are 4.4044/255 apart
     a4_mid25   0.3395 from the seed,  4.1955 from the ward end  ->   7.71% across   (frame landed at 27.1%)
     a4_mid50   2.3839 from the seed,  2.5865 from the ward end  ->  54.13% across   (frame landed at 52.1%)
     a4_mid75   4.1854 from the seed,  0.3923 from the ward end  ->  95.03% across   (frame landed at 77.4%)
     pass strictly increasing
     pass p25 >= 1.0%
     pass p50 within 10-90%
     pass p75 <= 99.9%
PASS A4 the morph interpolates: 7.71% -> 54.13% -> 95.03%

PASS a2_ref_ward.png vs a5_interrupt_ward.png
     A5 interrupt: borough->pcon retargeted to ward 300 ms in, landing exactly on the ward map
     MAD 0.0001/255 (limit 2.0)   pixels >12/255: 8 of 1330000 = 0.0006% (limit 0.5%)   max channel diff 29
     pass a morph really was in flight when the second pill was clicked
     pass no stuck morphBasis and no stuck switching afterwards

A6 a measure change AFTER a morph still animates (the snap-poisoning regression)
     zero is the settled ward map on the OLD measure, so the chrome the change rewrites
     (title, legend, active pill) is a fixed part of every number below — which is why
     the claim is that they INCREASE, not that any one of them equals the easing.
        125 ms after the change  ->   45.66% across
        264 ms after the change  ->   57.13% across
        484 ms after the change  ->   92.71% across
     pass the first frame is strictly between the two ends (>2% and <98%)
     pass the three frames strictly increase — so it slides rather than cutting or stalling
PASS A6 the measure change after a morph still animates

PASS a7_ref_oa.png vs a7_morph_oa.png
     A7 suppression: lsoa -> oa on resident_under5y, whose denominator suppresses 294 output areas and none at any coarser grain
     MAD 0.0001/255 (limit 2.0)   pixels >12/255: 6 of 1330000 = 0.0005% (limit 0.5%)   max channel diff 34

PASS a8_ref_change.png vs a8_morph_change.png
     A8 change view: 2011->2021 at borough, morphed to ward, landing on the directly loaded change view
     MAD 0.0002/255 (limit 2.0)   pixels >12/255: 18 of 1330000 = 0.0014% (limit 0.5%)   max channel diff 26

PASS A9 street mode never morphed: morphActive false in all 129 samples across the switch, errors 0

PASS a2_ref_ward.png vs <a10 final frame, in memory>
     A10 endpoint after a mid-flight zoom still lands on the ward map
     MAD 0.0003/255 (limit 2.0)   pixels >12/255: 22 of 1330000 = 0.0017% (limit 0.5%)   max channel diff 35
     pass elevationScale really did move and come back (1 -> 0.11323210104515069 -> 1)
     a10_zoom_mid75 is 94.88% across, against a4_mid75's 95.03% (drift 0.14 pts, limit 15)
     A RESTART WOULD SHOW HERE, and did before the fix: this frame came in at 36.39%
     against a4_mid75's 94.99%, a drift of 58.6 points. The cause was NOT the scale — a
     bare redraw() with no scale change at all did the same damage (91% -> 37% at the
     70% mark) — it was polyLayer handing deck.gl a fresh data.attributes object on every
     redraw, which it reads as the attributes having changed. polyData() now caches that
     object per tier, keyed on the paint counter.
PASS A10 the in-flight transition survived the elevationScale redraws

PASS A11 reduced motion: TRANSITION 0, no morph in 93 samples, the switch lands instantly

---- UNTESTED-BY-DRIVER (left to the human eye) ----
  * the real zoom-gesture lsoa<->oa auto-switch, AS A GESTURE. This
    driver forces the tier through __setArea and elevationScale
    through __applyZoom, so how crossing the threshold mid-drag feels
    is unjudged. (A7 does morph lsoa->oa, just not by dragging.)
  * plateau seam shimmer under rotation and tilt. The plateau is
    26,369 coplanar solids; whether their shared edges sparkle as the
    camera moves is not a still-frame question.
  * overall aesthetics: whether a split reads as one map refining
    rather than as a wipe, and whether 750 ms is the right length.
  * the ~210 ms seed frame v0 measured, AS FELT on a click. It is
    still there — ?hud=1 shows it — and whether it reads as lag on
    the click is a judgement no assertion here makes.
  * street mode keeps the curtain deliberately; whether that is the
    right call over a pale basemap is a design question, not a bug.
  * the borough outlines coming on at t=0 of a borough->ward switch.
    That is inherited production behaviour (the curtain does it too),
    and A4 measures against it rather than around it — but whether it
    reads as a pop is an eye question.

RESULT ALL ASSERTIONS PASS
```

### Smoke tests outside the assertion set

Both flags the driver does not otherwise exercise, checked by hand over CDP:

- **`?morph=0` + a real pill switch** (borough → ward): the curtain runs — `switching` goes true,
  `morphBasis` never set across 135 samples — lands at ward, `errors 0`, `morphReady: false`
  (the warm-up correctly declines to run at all).
- **`?hud=1`**: overlay renders (`display: block`), the morph still completes, `errors 0`.
  HUD text: `frame 5.5 ema  worst/2s 289.0 / paint 1.8 ms  tier ward /
  borough->ward  seed+4  animate+176  finalise+990`. `window.__v1.morphActive()` and
  `.state()` both correct.

The `worst/2s 289.0 ms` is v0's residual seed-frame cost, a little higher here than v0's 211 ms
— this page carries more layers (Thames, casing, outlines, labels) and a real measure/legend
pipeline. It is one frame, before anything is moving, and `afterCommit` absorbs it rather than
letting it eat the front of the transition.

---

## 8. Concerns

1. **The `polyData` fix is a production bug fix that has not been carried back.** §6. Any redraw
   during any transition restarts it, on the shipped page as much as here. The shipped symptom is
   milder (a zoom during the curtain's FADE_UP, 560 ms rather than 750) but it is the same defect.
   Worth a small standalone patch to `static/interactive/london-population/index.html`.

2. **A curtain in flight has no retire path, and its timers throw when a second switch lands on
   top — a pre-existing PRODUCTION defect, inherited verbatim.** *(Corrected in fix round 1;
   the first version of this concern said "cosmetic", which was wrong.)*

   `endMorph()` retires a morph; the curtain's two nested `setTimeout`s are tokenless production
   code and I left them byte-for-byte as instructed. The outer one
   (`static/labs/morph/v1/index.html:2349`, production's own line) does:

   ```js
   T.dur = FADE_UP;
   paint(T, CURRENT_VALS, m, CURRENT_ND);
   ```

   `T` is captured in the closure, but `CURRENT_VALS` is read **live** — and by the time the
   timer fires, a second switch has reassigned it to the *new* tier's array. If the new tier is
   coarser than `T`, `paint` walks `T`'s feature count off the end of a shorter array:
   `vals[i]` → `undefined` → `decode` → `NaN` → `colorFor` → `lerpRamp` returns `undefined` →
   **TypeError inside the setTimeout**. The inner timer is registered *after* that line, so it
   never runs, and the curtain never clears `switching` — the borough outlines stay pinned on
   and the hand-off flag stays stuck for the life of the page.

   **This reproduces in the shipped map** with two rapid curtain switches (fine → coarse within
   FADE_DOWN + FADE_UP ≈ 1 s). It is not something the morph introduced.

   In V1 it is strictly narrower and self-healing: reaching it needs `morphReady()` to flip
   false→true *between* two clicks, i.e. a click landing in the ~1 s warm-up window, and the
   morph's own FINALISE clears `switching` unconditionally afterwards. Fixing it properly means
   touching the byte-for-byte curtain block, so it stays as-is here and goes on the production
   ticket list below.

3. **The `?highlight=off` in A6 is a metric accommodation, not a page change.** The pulse and the
   bar transition genuinely overlap in production and a reader sees both. Nothing asserts that
   the pulse *looks* right over a freshly morphed tier; A2/A3/A5/A7/A8 only prove it has finished
   and left a clean frame by 1.6 s.

4. **`RANKS` is cached on `T.key + ":" + m.key` and the change view reuses the level measure's
   key**, so entering the change view can serve stale ranks to the tooltip and the pulse. This is
   pre-existing production behaviour, unrelated to the morph, and out of scope — it does not
   affect any pixel at rest, which is why A8 still passes. Flagging it because I found it while
   tracing A8.

5. **`window.__setTier` never morphs** — it calls `apply()` with no `from`, so `crossFade` is
   false. That is production's own definition and I left it. Every driver assertion goes through
   `__setArea`, the real pill path, as the brief required; anyone testing this page with
   `__setTier` will silently get a plain repaint.

6. **`SNAP_MS = 1` remains deck.gl-version-sensitive**, unchanged from v0's concern 2. A future
   deck.gl that clamps or rounds small durations turns it back into a visible animation. A4 and
   the six endpoint assertions would both catch it.

7. **Only Chrome + real GPU was exercised.** The flag-set probe would have fallen through to
   SwiftShader, but the first set worked every run, so the software-raster paths are untested
   here. Edge remains unusable for one-shot CLI automation on this machine (v0's finding); this
   driver sidesteps it entirely by going through CDP for everything, and `--browser` still
   overrides.

8. **`tools/morph-lab/__pycache__/` is not in `.gitignore`.** Running either driver creates it if
   anything imports them as a module (my diagnostics did). I deleted it before staging; a
   `__pycache__/` line in `.gitignore` would stop it recurring.

---

# Fix round 1 — an unpainted basis must not kill the morph

**Status after the fix: DONE.** Commit `ff6ca18`. 12 assertions, exit 0, every earlier number
stable. Scope was exactly the two items the review raised.

## Finding 1 (Important) — `morphReady()` required `B.painted`, and the warm-up promised it would not

The reviewer was right, and the contradiction was inside my own file, two comments apart.

`warmMorph`'s bail-out (`index.html:2218-2222` as committed) fires whenever its `Promise.all`
resolves while a tier switch is in flight — `!T`, `!T.painted`, or a `CURRENT_VALS` length
mismatch. It sets `morphWarm = true` and returns **without painting the basis**, and its comment
says why that is fine: *"The basis is loaded and crosswalked, which is all a morph strictly
NEEDS; it will pay the tessellation on its own first seed instead of here."*

That is true of the SEED. It was not true of the gate in front of it:

```js
if (!B || !B.painted) return false;      // morphReady(), :2067
```

Nothing else ever paints the basis unless the reader visits the output-area tier. So a single
click landing in the ~1 s warm-up window put the page back on the curtain **for the rest of the
session** — and, worst of all, silently: `#v1status.morphReady` is fed from `morphWarm`, which
the bail-out had just set true, so the status node went on advertising a capability the page no
longer had. That is the exact field my driver gates on, so the driver would have been
photographing curtains and calling them morphs.

**Reproduced before fixing.** Clearing `READY.oa.painted` leaves precisely what the bail-out
leaves — basis resident, crosswalked, never painted, absent from the layer stack (`buildStack`
skips unpainted tiers). Against the unfixed page:

```
boot             {"ready":true,"errors":0,"tier":"borough","morphBasis":null,"morphReady":true}
cleared painted -> null
switch1 morphed: False | samples 87 | log []   | status {... "tier":"ward", "morphReady":true}
switch2 morphed: False | samples 92
```

Empty morph log: `morphTier` never ran at all. Both the switch that followed and the next one
curtained, while `morphReady` reported `true` throughout.

**The fix**, one predicate line:

```js
-    if (!B || !B.painted) return false;
+    if (!B) return false;
+    // It IS a genuine precondition in one case: a morph that starts AT the
+    // basis is the one the SEED skips, because the basis is already what is on
+    // screen — and it can only be that if something has already painted it.
+    if (fromT.key === BASIS && !B.painted) return false;
```

The reasoning the reviewer supplied is exactly right and worth restating: the SEED does
`if (fromKey !== BASIS && morphBasis !== BASIS) { B.snap = true; paintFrom(B, fromT, …); }` — it
paints the basis itself, so for any morph *from* a non-basis tier `B.painted` is an output of
the morph, not an input. It is only an input when `fromKey === BASIS`, because that is the one
case the SEED skips: the basis is already on screen, and it can only be on screen if something
painted it. The snap contract still holds either way — the seed sets `B.snap = true`, so the
basis's first draw is snapped, as verified behaviour 3 requires. The only cost of an unpainted
basis is that the ~210–290 ms tessellation lands on the seed frame, which `afterCommit` absorbs.

I also corrected the warm-up's bail-out comment to point at `morphReady()` and say why it must
not require `painted`, so the two cannot drift apart again.

## New assertion A12, and why it reproduces the state rather than the race

The reviewer asked for a driver probe "if cheap". Racing the real warm-up window from outside is
**not** cheap or reliable, and it is worth saying why: the warm-up's own fetches go through
`track()`, so they gate `inflight`, so they gate `__NG_DONE__`. By the time the driver can see
`ready`, the warm-up's loads have already landed and only ~2 commits separate it from
`morphWarm`. There is no stable window to aim at from out here.

Reproducing the **state** is deterministic and tests the same predicate, so A12 does that:

```
PASS a2_ref_ward.png vs <a12 final frame, in memory>
     A12 a morph started with an UNPAINTED basis still lands on the ward map
     MAD 0.0002/255 (limit 2.0)   pixels >12/255: 8 of 1330000 = 0.0006%   max channel diff 33
     pass it really morphed rather than falling back to the curtain
          (morphActive true in 31 of 78 samples)
PASS A12 an unpainted basis is a morph that pays its own tessellation, not a dead one
```

Two claims, not one: that it *morphed* (polling `morphBasis` across the switch, which is what
fails on the unfixed page) and that it *landed correctly* (endpoint identity, in memory, so no
19th PNG). It needs no new page surface — `READY` is a top-level `var` in a classic script and
therefore already on `window`.

## Full re-run after the fix

`python tools/morph-lab/capture_v1.py`, no arguments, **exit 0, 12/12**. Every pre-existing
number is stable within run-to-run noise:

```
                              fix round 1        first run
A2  default -> ward           0.0002/255  16px   0.0002/255  11px
A3  pcon -> gla               0.0000/255   0px   0.0000/255   0px
A3  ward -> borough           0.0000/255   0px   0.0000/255   0px
A4  progression        7.77% -> 54.82% -> 94.99%   7.71% -> 54.13% -> 95.03%
A5  interrupt                 0.0003/255  19px   0.0001/255   8px
A6  measure change     45.7% -> 57.1% -> 92.2%    45.7% -> 57.1% -> 92.7%
A7  suppression               0.0001/255   3px   0.0001/255   6px
A8  change view               0.0003/255  24px   0.0002/255  18px
A9  street mode        0 of 130 samples          0 of 129 samples
A10 zoom during morph  drift 0.02 pts            drift 0.14 pts
A11 reduced motion     0 of 94 samples           0 of 93 samples
A12 unpainted basis    0.0002/255  8px, morphed  (new)
```

Capture set unchanged at 18 PNGs + `RESULTS.txt`; A12 compares in memory.

## Finding 2 — concern 3 rewritten

Concern 3 in §8 above has been replaced (it is now numbered 2 in that list). The old text called
the curtain-timer interaction "cosmetic"; that was wrong, and the reviewer's diagnosis is
correct. The curtain's outer timer reads `CURRENT_VALS` **live** while holding `T` in its
closure, so after a second switch it paints the old tier with the new tier's array; if the new
tier is coarser, the out-of-range reads give `undefined` → `NaN` → `lerpRamp` returns
`undefined` → **TypeError inside the setTimeout**. The inner timer is registered after that line
and so never runs, and `switching` is never cleared. It is a **pre-existing production defect**
that two rapid curtain switches reproduce in the shipped map, inherited here verbatim by design;
V1 self-heals only because the morph's FINALISE clears `switching` unconditionally.

## Production tickets — to carry back to `static/interactive/london-population/index.html`

Neither of the first two was introduced by this work; both were found by it.

1. **`polyLayer` rebuilds `data.attributes` on every call, so any `redraw()` restarts any
   in-flight transition** (§6). Shipped symptom: a zoom during the curtain's 560 ms FADE_UP
   restarts it and the tail cuts. Fix is `polyData(T)` — cache the data object per tier, keyed
   on `T.phase`. Measured here: mid-flight drift 58.6 points → 0.14.
2. **The curtain's outer timer throws on a second switch and leaves `switching` stuck on**
   (concern 2 above). Fix is to capture `CURRENT_VALS`/`CURRENT_ND` into the closure alongside
   `T`, and/or to give the curtain a token like the morph's.
3. **`RANKS` is cached on `T.key + ":" + m.key` and the change view reuses the level measure's
   key**, so entering the change view can serve stale ranks to the tooltip and the pulse
   (concern 4 above). No pixel effect at rest.
