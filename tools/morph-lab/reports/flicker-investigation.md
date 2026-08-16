# The one-frame flash at the end of a morph — investigation and fix

**Status: FIXED.** Branch `labs/flicker-fix`. `python tools/morph-lab/capture_v1.py`
exits 0 with 14/14 assertions (A1-A13 plus the new A5b).

> **Fix round 1** at the end of this document is the current state: one CRITICAL review
> finding fixed (a retarget landing inside the seed's warm window stranded `morphSeed`),
> one probe-liveness gap closed, and two paths that this report had declared clean by
> argument measured instead. §1–§9 have been corrected in place where they were wrong —
> the histogram metric is L1 and was described as a pixel count, §3's attribution of the
> seed residual to the borough outlines was wrong, §5's "a hidden paint never reaches the
> GPU" was too strong, and §6's latency figure was a guess and is now an A/B.

**Root cause in one sentence.** Both swaps in a morph reveal a poly layer on the same
committed render that first hands deck.gl that layer's new attribute values, and on that
render deck.gl still holds the previous ones — so the revealed layer draws exactly one
frame of whatever it was last *drawn* with, which is a different map precisely when a
measure, year or change-view switch has repainted the tier on screen and left every other
tier's buffer behind.

That is the owner's report, restated in the page's own terms: *first time only, per
measure*. The flash is not a property of the area type; it is a property of the pair
(area type, measure), and it cures itself on the second arrival because the first arrival
is what brings that layer's buffer up to date.

---

## 1. What was instrumented, and why nothing else would do

The artefact survives every screenshot the driver can take and does not appear in a 60 fps
screen recording, so it had to be caught from inside the frame loop. `?flickerprobe=1`
(off by default, nothing in the block runs or allocates without it) does this, in
`static/labs/morph/v1/index.html`:

- Inside deck's `onAfterRender` — the only moment the default framebuffer is guaranteed to
  still hold the frame just drawn, since nothing here sets `preserveDrawingBuffer` — it
  reads a fixed **512 × 384 region** of the deck canvas back with `gl.readPixels` and
  reduces it to a signature: mean luminance, standard deviation, and an eight-bucket
  luminance histogram.
- Each sample carries the page clock, the delta since the previous **committed render**,
  the cost of the read itself, the morph state (`morphBasis`, `tier`, `switching`), an
  event mark left by the `redraw()` about to be committed, and — decisively — **the
  browser frame it belongs to**.
- Raw bytes are kept for a short window around every marked event, so an anomalous frame
  can be pulled back out as a PNG and looked at rather than only measured.

Two design points earned their place by failing first:

**The region has to be re-derived when the canvas is resized.** deck.gl brings its device
up asynchronously and the canvas spends the first render or two at the HTML default of
300 × 150. A rect computed once, on the first committed render, came out as a 110 × 61
patch of the bottom-left corner and read the sky. The first run of the probe measured
nothing for exactly this reason.

**The frame counter is what separates a defect from a red herring.** deck.gl services a
`setProps` synchronously, so a `redraw()` issued from a promise or a timer draws a frame
*outside* the animation loop. If the loop then draws again before the compositor takes the
buffer, that first draw is overwritten and no reader ever sees it. A one-rAF counter
recorded per sample settles it: two samples sharing a value are two renders inside one
browser frame and only the last was on screen; two samples with different values are two
composited frames. **Every anomaly reported below has a distinct frame id from both its
neighbours** (e.g. 1399 / 1400 / 1401), so it is a frame the reader saw.

### The perturbation check

`readPixels` is a synchronous GPU stall, so its cost is recorded on every sample rather
than assumed:

```
region 512x384 (196,608 px)   read p50 2.3 ms  p90 4.2 ms  mean 4.0 ms
region 128x128 ( 16,384 px)   read p50 2.1 ms  p90 3.8 ms  mean 3.7 ms
committed-frame delta         p50 6.8 ms with the probe on, in every run
```

The cost is the stall, not the byte volume: a twelfth of the pixels costs 91% as much. So
the probe adds ~2.3 ms to a ~6.8 ms frame, and shrinking the region does not buy the
timing back. That matters because it means the perturbation cannot be tuned away — so it
was checked the other way instead:

1. **The anomaly survives the small region.** At 128 × 128 the seed anomaly is still there
   at 69.3% of the sampled region.
2. **The anomaly is a data fact, not a timing fact.** The wrong frame is an *exact* match
   for a specific earlier picture (§3, distance 8 of 196,608). A GPU stall cannot
   manufacture the previous measure's map.

---

## 2. Phase 1 — the frame, caught

The discriminating matrix from the brief, driven through the real `__setArea` pill path
with each step settled before the next, on a fresh load. A **one-frame anomaly** is a
frame further from *both* neighbours than they are from each other.

**What the distances are.** `d(a, b)` is the **L1 distance between the two eight-bucket
luminance histograms**, over a 196,608-pixel region. A pixel that changes bucket
decrements one bucket and increments another, so **L1 is about twice the number of pixels
that moved** — 46,642 of L1 is roughly 23,300 pixels, about 11.9% of the region. Every
number below, and every limit in A13, is in L1 units; where a share of the region is
quoted it is the L1 ratio, so halve it to read it as a share of pixels. (An earlier
draft of this report described the L1 figures as pixel counts. The assertions are
unaffected — limits and measurements are in the same units — but the prose overstated the
pixel counts twofold.)

Before the fix (`probe_p3`, 964 committed frames signed; reproduced identically in an
earlier run, `probe_p2`):

| step | switch | phase | d(prev) | d(next) | d(prev,next) | verdict |
|---|---|---|---|---|---|---|
| s0 | lsoa→borough, **first borough** | finalise | 20,810 | 0 | 20,810 | clean step |
| s1 | borough→ward, **first ward** | finalise | 538 | 0 | 538 | clean step |
| s2 | ward→borough, repeat | finalise | 20,810 | 0 | 20,810 | clean step |
| s3 | borough→ward, repeat | finalise | 536 | 2 | 538 | clean step |
| s4 | **measure change**, while on ward | — | — | — | — | — |
| s5 | ward→borough, stale buffer | **seed** | **46,642** | **46,978** | **384** | **ANOMALY, ratio 121.5** |
| s5 | ward→borough, stale buffer | **finalise** | **40,558** | **50,178** | **24,230** | **ANOMALY** |
| s6 | borough→ward (ward was repainted by s4) | finalise | 410 | 4 | 408 | clean step |
| s7 | ward→borough again, now fresh | finalise | 24,230 | 0 | 24,230 | clean step |
| s8 | ward→pcon, **first pcon** | finalise | 404 | 0 | 404 | clean step |
| s9 | pcon→ward, repeat | finalise | 406 | 4 | 406 | clean step |

Read as one-frame **excess** (`min(d(prev), d(next)) − d(prev,next)`), the whole run's
top of the table is:

```
  L1 46,258   23.53% of the region (~11.8% of its pixels)   s5 SEED
  L1 16,328    8.30% of the region (~ 4.2% of its pixels)   s5 FINALISE
  L1    196    0.10%                                        boot
  L1     60    0.03%                                        noise floor
```

Answers to the brief's four cases, directly:

- **(a) first arrival at a tier this session** — clean (s0, s1, s8). A layer deck.gl has
  never drawn has no previous buffer, so its first update is a plain allocation and there
  is nothing stale to show. **This falsifies H1 as stated.**
- **(b) repeat arrival, same measure** — clean (s2, s3, s7, s9).
- **(c) arrival at an already-visited tier after a MEASURE change** — **flashes** (s5), and
  only at the tier the measure change did *not* repaint. s6 goes to ward, which s4 had
  repainted because it was on screen, and s6 is clean. s7 repeats s5's switch with the
  buffer now up to date, and is clean.
- **(d) morph start (seed swap)** — **flashes**, on the same click as (c) and for the same
  reason one layer earlier. This is the owner's "occasionally at the START instead": it
  happens once per measure change (the next morph re-paints the basis from a tier it has
  just drawn), where the completion flash happens once per *area type* per measure.

So the owner's "per measure" instinct and "first time an area type is shown" observation
are the same rule seen from two ends, and both are exactly right.

---

## 3. What the wrong frame actually showed

Not a guess — the anomalous frames were pulled back out of the page as PNGs and matched
against the settled frames the same run had already recorded.

**s5 FINALISE (n=581).** Its histogram is **8** of 196,608 away from the settled borough
map under the *previous* measure (`pop_density`, sampled at n=101 and n=286, two steps
earlier), and **50,178** away from the correct borough map under the new measure
(`hh_density`, n=582, the very next frame). The hand-off frame is the old measure's map,
to within antialiasing noise.

**s5 SEED (n=488).** Identified by scanning the whole run for its nearest neighbour rather
than by reasoning, which is just as well, because the reasoning in the first draft of this
report was wrong. It sits at **distance 0** from six frames in three earlier steps —
n=97, n=102, n=103, n=104, n=281, n=282 — and all six are the basis drawn as the
**borough** plateau under the *previous* measure. Against its own correct picture one
frame later it is 46,978 away, and against the ward plateau the basis was actually last
animated to (n=379, the end of s3) it is 51,744 away.

So the seed's out-of-date frame is not simply "the paint before this one": it is an older
resident buffer still — the plateau the basis held two morphs earlier, before the
transition that ended on wards. That makes it unambiguously a stale GPU buffer rather than
any kind of partial or blended draw, and it is why the reader's report is of a *coherent
wrong map* rather than of tearing.

*(The first draft attributed the residual to the borough outlines switching on. That was
wrong and is retracted: `buildStack` keeps the outlines up both before the click, because
`tier` is ward, and during the morph, because `switching` is true, so nothing about them
changes across this frame. The nearest-neighbour scan above replaces the guess.)*

Visually: the seed frame shows a smooth, low-contrast map; the frame after it shows the
same geography at full ward detail. Nothing is half-drawn and nothing is blank — it is a
complete, coherent, *wrong* map for one frame. Which is why it reads as "a first paint, or
a brief redraw of polygons in a slow system".

---

## 4. The hypotheses, decided

| | verdict |
|---|---|
| **H1** — the destination's first visible draw renders from an empty or stale buffer | **Half right, and the half that is wrong matters.** Never-drawn layers are clean (s0/s1/s8): deck.gl allocates and uploads directly with no transition to lag behind. It is *previously drawn* layers that flash, and the stale content is not "empty", it is the last picture that layer was drawn with. The "buffers persist afterwards" story is right; "first time at this tier" is the wrong index — the index is (tier, measure). |
| **H2** — it is a long frame, not a wrong frame | **Not the flash, but a real and separate cost, now also fixed.** Before: the hand-off frame's delta was 54.4–63.2 ms, mean **58.3 ms**, on *every* morph. After: 5.7–13.6 ms, mean **8.5 ms**. The expensive first draw of the destination layer now lands on the invisible warm commit. A stutter cannot be the reported artefact — it happens every time and the owner reports first-time-only — but at 60 Hz it held the *wrong* frame on screen for one full refresh, so it made the flash more visible. |
| **H3** — the FINALISE stack change (outlines back, `switching=false`) | **Control case, confirmed as such.** It is a real change of 20,810 px on every borough hand-off and 538 on every ward one, and it is a clean *step* every time: `d(next) = 0`. It is the destination's true new appearance, not an artefact. |
| **H4** — the start flicker is the same mechanism on the basis layer | **Confirmed** (§2 case d), and fixed by the same change. |

---

## 5. Root cause

Two measured facts about deck.gl 9.3.7 (with luma.gl 9.3.3 in the bundle):

1. **deck.gl does not draw `visible: false` layers at all.** In the bundle,
   `_shouldDrawLayer` returns false immediately on `!layer.props.visible`.
2. **On the render that first DRAWS a layer after it has been repainted while hidden,
   deck.gl draws an out-of-date value. The frame after is correct.** This is the fact the
   two-commit `afterCommit` already encodes one level down ("a transition that has only
   been created has not yet been applied", task-2 fix round 1). What was not noticed is
   that the layer is *drawn* on that render. While it stays hidden that costs nothing;
   when the same commit also reveals it, the reader gets a frame of the old picture.

   The out-of-date value is **not reliably the paint immediately before**: §3 measured the
   seed's stale frame as the plateau the basis held two morphs earlier, at distance 0 from
   six independent frames. Nothing here depends on pinning that down further, and this
   report deliberately does not — the load-bearing claims are that the frame is coherent,
   out of date, corrected on the next render, and removable by giving the layer a drawn
   but pixel-free commit first. All four are measured.

   *(An earlier draft stated a third "fact" — that a paint issued to a hidden layer never
   reaches the GPU at all. That is too strong, and the curtain measurement below is what
   disproves it: `paintFlat` is issued to a hidden layer and its value is exactly what the
   curtain's reveal frame draws 380 ms later. Retracted.)*

Both swaps in `morphTier` did exactly that:

- **SEED** — `B.snap = true; paintFrom(B, …); morphBasis = BASIS; redraw();` — paint and
  reveal in one commit.
- **FINALISE** — `morphBasis = null; READY[toKey].snap = true; redraw();` — the
  destination's ANIMATE paint had never landed, so this commit both delivers it and
  reveals the layer.

The stale buffer is only *visibly* stale when something repainted the map without
repainting that layer. `apply()`'s plain-paint branch — a measure change, a year change,
entering or leaving the change view — paints `T`, the tier on screen, and nothing else.
Every other tier, and the basis, keep the buffers they were last drawn with. Hence: first
arrival at each area type after a measure change flashes; the second does not.

### The two other paths that reveal-and-repaint on one commit — measured, both clean

Nothing about the mechanism is morph-specific, so the two other places in this page that
reveal a layer on the same commit that repaints it were measured rather than reasoned
about. Both are clean, and both are now assertions (A13 legs 3 and 4).

**A measure, year or change-view switch landing MID-MORPH.** `apply()`'s plain-paint
branch does `endMorph(); paint(T); redraw();`, and `T` is the morph's hidden destination —
exactly the same shape as the two swaps. Worst one-frame excess over the switch: **0.00%**
in the standalone measurement and **0.01%** in the committed driver run, in both the
measure and the change-view variants; every marked frame is a clean step (negative
excess). The reveal frame does draw an out-of-date value — measured at mean
luminance 94.107, which is the tier's own map on the **old** measure — but that is
precisely where the 750 ms measure ease is supposed to start from. It is a legitimate
animation start, not a wrong frame, and warm-committing it would delete the animation.
**No fix, on the evidence.**

**The curtain, under `?morph=0`.** Its rise is `fading = null; T.dur = FADE_UP;
paint(T, …); redraw();` — reveal and repaint on one commit, with `paintFlat(T)` having been
issued 380 ms earlier while `T` was hidden. Measured on the same route (a repeat area
switch after a measure change, so `T`'s buffer is a whole measure out of date): worst
one-frame excess **0.00%**, and the reveal frame is **flat** — mean luminance 11.575 with
170,940 of 196,608 sampled pixels in the darkest bucket, `d(prev) = 0` — followed by a
smooth rise (11.575 → 11.588 → 11.686 → 11.849 → 12.48 → 13.53 → …) to the settled ward
map at 89.138.

So the curtain does **not** flash, and there is **no production ticket here** — but it is
clean for a different reason than this report first claimed. It is not that `paintFlat`
gives the incoming layer "a full frame" (it is hidden for that frame, and hidden layers
are not drawn). It is that the out-of-date value its reveal frame draws *is* the flat
baseline `paintFlat` established. The page's own comment on that line — "it does not have
to be VISIBLE to acquire one" — turns out to be exactly right, and now we know why it
works rather than only that it does.

---

## 6. The fix: one warm commit before each reveal

A layer that is about to be revealed is drawn once first, on a commit where it writes no
pixels. That commit is what delivers the update; the reveal is the commit after, by which
time the snap has landed.

**The ghost draw** (`polyLayer`): `parameters: { depthCompare: "never", depthWriteEnabled:
false }` and `opacity: 0`. `depthCompare: "never"` fails every fragment, so the layer is
fully drawn — deck.gl updates its attributes, uploads its buffers and applies its
transitions exactly as for any visible layer — and writes no colour and no depth. Opacity 0
is belt and braces. Per-layer `parameters` is honoured in this deck build
(`getLayerParameters` returns `layer.props.parameters` and the WebGL backend maps
`depthCompare`/`depthWriteEnabled` onto `depthFunc`/`depthMask`).

*Measured, not assumed:* across the whole matrix, every commit carrying a ghost sits
**0–10** pixels of 196,608 from the frame before it. The ghost writes nothing.

**SEED** now paints the basis, marks it a ghost, and leaves `morphSeed = fromKey` so the
**outgoing tier is still the picture on screen** for that commit; the reveal is one commit
later. `morphBasis` is set immediately, as before, so `apply()`'s `if (morphBasis &&
!doMorph) endMorph()` still retires a morph interrupted inside the new window, and
`#v1status` never lies about a morph being in flight.

**FINALISE** now snaps and ghosts the destination, commits, and hands back one commit
later.

**Commit counts are unchanged where it matters, and the cost was A/B'd rather than
argued.** The animate used to wait two commits of an already-revealed basis; it now waits
the warm commit and the reveal — the same two, the same contract (created on the first,
applied on the second). The morph log gains one entry, `reveal+N`, between `seed` and
`animate`, and FINALISE gains one commit.

Measured over **24 morphs on each setting, alternating borough↔ward inside one browser
session** (`?ghost=0` versus the fixed page, interleaved twice so browser warm-up cannot
favour either):

```
                        seed -> animate            finalise+                hand-off frame
?ghost=0    round 1     174.9 ms (150-240)         990.4 ms (966-1060)      56.6 ms (36.8-65.4)
ghosts on   round 1     162.9 ms (151-181)         989.8 ms (976-1009)       7.6 ms ( 5.4-10.7)
?ghost=0    round 2     158.8 ms (149-172)         974.1 ms (963- 989)      56.4 ms (51.1-60.1)
ghosts on   round 2     158.5 ms (151-168)         988.9 ms (976-1000)      11.1 ms ( 5.6-15.7)

                delta   -6.1 ms                    +7.1 ms                  -47 ms
```

**No measurable added latency before the animation starts** (−6.1 ms, inside the noise),
**+7.1 ms to the whole morph** for the extra hand-off commit, and the hand-off frame itself
**47 ms shorter**, because the destination's expensive first draw now lands on the
invisible warm commit instead of on the frame the reader sees.

*A note for anyone tempted to read this off `RESULTS.txt` instead:* don't. The per-capture
morph logs there vary by ±100 ms between whole-driver runs depending on browser state, and
comparing a pre-fix run against a post-fix run that way suggests a +75 to +195 ms
regression that the controlled A/B above shows is not there.

**Bounding the ghost.** `redraw()` clears `ghost` alongside `snap`, after the stack has
been built — so a ghost lasts exactly one commit and no path can leave a layer drawing
invisibly. `endMorph()` clears ghosts too, and that is not belt-and-braces: every caller
is on its way to paint the new tier and redraw, and a ghost surviving into *that* build
would draw the tier the reader is switching to with colour writes off — a blank frame,
which is a worse artefact than the one being removed.

### The patch surface

`static/labs/morph/v1/index.html`: **389 insertions, 31 deletions**. Most of that is not
the fix — 238 of the added lines are the `?flickerprobe=1` block and its two wrappers,
which are diagnostics, and 159 of the 389 are comments.

The fix proper touches **five places**: `polyLayer` (two props), `redraw` (clear ghosts),
`buildStack` (the `shown` rule plus `|| T.ghost`), `endMorph` (clear ghosts), and
`morphTier` (the two swaps). Plus the `morphSeed`, `ghostWarm`, `GHOST_PARAMS` and
`NORMAL_PARAMS` declarations. In `morphTier` the ANIMATE and hand-back bodies are lifted
verbatim into named functions (`animate()`, `handBack()`) so the callback chain stays
readable — that is re-indentation, not new logic, and it accounts for most of the churn
in that function.

The V0/V1 invariants all survive and are asserted: SNAP semantics unchanged (`SNAP_MS`
untouched, snap still swaps the duration and never the transitions object), the
two-commit rule before ANIMATE unchanged, the fresh-buffer contract and phase bumps
untouched, `polyData`'s cache untouched (no extra paint is issued, so no transition is
restarted — A10 confirms drift 0.00 pts), and the `?morph=0` curtain path reaches
`polyLayer` with `T.ghost` falsy, i.e. `opacity: CFG.polyOpacity[mode]` and
`parameters: {}`, which is what it had.

**v0 and v2 are deliberately untouched.** The mechanism needs a repaint that updates one
tier and leaves another's buffer behind, and neither harness has one: both fix
`measureKey = MANIFEST.initial` and never change it. There is nothing to manifest.

### Not adopted, and why

- **Warm-drawing every tier at boot** — cannot work. The staleness is created *later*, by
  each measure change, so a boot-time warm-up would be out of date by the first switch.
- **Repainting every tier when the measure changes** — cannot work either, and this is the
  trap worth recording: a layer's GPU buffer only changes when the layer is *drawn*, so
  repainting a hidden tier changes nothing the reader could ever see. No amount of CPU
  painting fixes a draw-time problem.
- **Re-warming the basis after every plain repaint** — would have moved the flash to the
  measure change rather than removed it: the basis's own reveal has the same defect.
- **One overlap frame with both extrusion sets visible** — the sprint's documented z-fight
  is only half the objection. The stale buffer can be *taller* than the correct one, so
  its bars would stand above the plateau's silhouette against the sky, where nothing
  covers them. A cover frame is only reliably invisible if it writes no pixels at all.
- **`transitions: {}` on the destination's update** — lands instantly with no stale frame,
  but v0 measured that it costs the attribute its transition state and the *next* update
  cuts. The next update of a just-arrived tier is a measure change the reader watches, i.e.
  precisely what A6 asserts. Rejected on that evidence rather than tried.

---

## 7. Phase 4 — the regression probe (A13)

`spike_of()` in `tools/morph-lab/capture_v1.py` asks one question of the per-frame
signature log: **is there a frame that sits further from both its neighbours than they sit
from each other?** That is the signature of a wrong frame and of nothing else — a moving
picture walks, so each frame is close to the one before and after while the neighbours are
far apart; a frame that is merely slow shows in `dt` and not here at all.

A13 drives the minimal reproducer — ward, borough, **measure change**, ward — clears the
probe log so the window is just that last switch, and reads the log back.

**It runs in both directions, and that is the point.** `?ghost=0` puts the old swap
sequence back (it is a lab switch with no reader-facing effect, in the spirit of
`?morph=0`), so the same probe, the same route and the same metric must SEE the defect on
one leg and not on the other. A regression probe that has only ever seen the fixed page
cannot tell a fix from a probe that has stopped looking.

```
A13 the one-frame flash: the first arrival at an area type after a
    measure change, signed frame by frame from inside the render loop
     region [500, 226, 512, 384] of [1400, 950]
     pass fixed page, first arrival after a measure change    0.00%  (limit 1.00%, 101 frames)
     pass ?ghost=0 control, the same route                   14.28%  (floor 5.00%,  91 frames)
          the control's spike is at redraw[vis=ward mb=- sw=0 snap=ward ghost=-] phase:finalise
     pass measure change landing MID-MORPH                    0.01%  (limit 1.00%, 112 frames)
     pass the CURTAIN under ?morph=0, the same route          0.02%  (limit 1.00%, 162 frames)
PASS A13 no committed frame shows a picture its neighbours do not
```

**Every leg asserts the probe was alive** — `info.on`, no `info.dead`, and at least 30
committed frames signed. Without that the fixed leg would pass loudest when the probe had
stopped looking altogether: `spike_of` returns 0.0 for a log shorter than three samples,
`__flicker.log()` returns `[]` when the probe never initialised, and `probeSample()` retires
itself into `PROBE.dead` rather than throwing, so the page's own errors gate would not catch
it either.

Legs 3 and 4 are the two paths §5 measured and did not change, asserted so that a future
deck.gl cannot quietly break them.

`?highlight=off` for the same reason A6 uses it: the peak pulse is a second animation over
the hand-off, and this metric is about what one frame does that its neighbours do not.

Across the full ten-step matrix rather than A13's single switch, the worst one-frame excess
anywhere in 973 committed frames on the fixed page is **L1 42, 0.02%** (about 21 pixels) — against L1 46,258,
**23.53%**, on the unfixed one. Three orders of magnitude, with the limits in the gap.

---

## 8. Full re-run

`python tools/morph-lab/capture_v1.py`, no arguments, **exit 0, 14/14**. Every
pre-existing number is stable within run-to-run noise, and `RESULTS.txt` plus all 18 PNGs
are regenerated in place.

```
                              this run            task 3, fix round 1 (before any of this)
A2  default -> ward           0.0002/255   9px    0.0002/255  16px
A3  pcon -> gla               0.0000/255   0px    0.0000/255   0px
A3  ward -> borough           0.0000/255   0px    0.0000/255   0px
A4  progression        7.91% -> 54.23% -> 94.95%   7.77% -> 54.82% -> 94.99%
A5  interrupt                 0.0002/255  10px    0.0003/255  19px
A5b retarget inside the seed's warm window
                              0.0002/255  10px    (new)
A6  measure change     45.7% -> 57.1% -> 92.7%    45.7% -> 57.1% -> 92.2%
A7  suppression               0.0000/255   1px    0.0001/255   3px
A8  change view               0.0003/255  21px    0.0003/255  24px
A9  street mode        0 of 128 samples           0 of 130 samples
A10 zoom during morph  drift 0.03 pts             drift 0.02 pts
A11 reduced motion     0 of  92 samples          0 of  94 samples
A12 unpainted basis           0.0002/255  12px    0.0002/255   8px
A13 one-frame flash    0.00 / 14.28 / 0.01 / 0.02%          (new, four legs)
```

---

## 9. Concerns

1. **The probe perturbs the thing it measures, by ~2.3 ms a frame, and cannot be made
   cheaper.** The cost is the synchronous `readPixels` stall, not the byte volume (a
   twelfth of the pixels costs 91% as much). The two arguments that it is not creating the
   artefact are in §1 and are strong — the anomaly survives a twelfth-size region, and it
   is an exact match for a specific earlier picture, which no stall can invent — but a
   WebGL2 pixel-pack-buffer readback with a fence would remove the doubt entirely and is
   the obvious next step if this ever has to be re-litigated.

2. **A13 is a single-region metric, and the region matters.** At 512 × 384 over central
   London it sees both the seed and the hand-off spikes; at 128 × 128 in the same area it
   saw the seed at 69.3% of the region and missed the hand-off. A defect that only ever
   moved pixels outside the sampled rect would pass. The rect is settable
   (`?fpx/fpy/fpw/fph`) but A13 uses the default.

3. **A pre-existing, unrelated flake in the borough labels bit one run of the driver.**
   `a1_ref_borough.png` — the `?morph=0` boot reference, on the curtain path this change
   does not touch — came back once with **no borough labels at all**, failing A3 at
   MAD 0.3661 / 9,221 px. The diff is the label glyphs and nothing else, and the morph
   endpoint `a3_morph_borough.png` matched its committed reference **byte-for-byte
   (MAD 0.0000, 0 px)** in that same run, so it is the reference that was wrong. Cause:
   `TextLayer` bakes its SDF atlas the first time it is built, and `fontsReady` gates
   `__NG_DONE__` but nothing re-draws when the face finally arrives. It is inherited
   production behaviour and it affects the shipped map too. 12 consecutive boots (6 with
   `?morph=0`, 6 without) all rendered labels, so it is rare; the committed run is clean.
   Worth a production ticket — one `redraw()` in the `document.fonts.ready` handler — but
   it is not this change's to make.

4. **The FINALISE hand-off now costs one extra committed frame.** A/B'd at **+7.1 ms** on
   the whole morph, with **no measurable change (−6.1 ms) before the animation starts** and
   the hand-off frame itself **47 ms shorter** (§6). But it is one more commit that an
   interrupt has to be able to land inside. That is now asserted — A5b drives a retarget
   into the warm window deliberately — and it is where fix round 1's critical finding
   lived.

5. **`depthCompare: "never"` is a deck.gl/luma.gl-version-sensitive constant**, in the same
   way `SNAP_MS = 1` is. If a future build stopped honouring per-layer `parameters`, the
   ghost would draw for real. `opacity: 0` would still hide the colour, but the depth
   writes would return and could punch holes in the basis. A13's fixed leg is what would
   catch it.

6. **The mechanism is latent everywhere a deck.gl layer is revealed and repainted in one
   commit,** not just here. Two such paths in this page were measured (§5) and both are
   clean — the mid-morph repaint because the out-of-date value is where its transition
   wants to start, the curtain because the out-of-date value is the flat baseline
   `paintFlat` established. Neither is clean by design; both are clean by luck, and both
   are now under assertion. Anyone adding a hidden-then-shown layer to this page or to the
   shipped map will meet the same thing, and it is invisible in code review because the
   wrong frame is perfectly coherent.

7. **What is still left to the eye.** Whether the fixed hand-off *feels* seamless on a real
   60 Hz display, and whether the ~1.4 s of first-morph tessellation still reads as lag on
   the click. Neither is a still-frame question and neither is asserted here.

---

# Fix round 1 — three review findings

**Status: DONE.** All three fixed or measured to scope; `capture_v1.py` exits 0 with 14/14,
`RESULTS.txt` and the PNGs regenerated in place. Two of the three turned out to need the
opposite of what was asked, and both are argued from measurement below.

## Finding 1 (CRITICAL) — a retarget inside the seed's warm window stranded `morphSeed`

The reviewer is right, and it is worse than the description: it is not just a stale
`shown`, it is a page that stops drawing.

**Reproduced before fixing.** The warm window is one committed render wide, so it cannot be
raced from outside with a timer — a retarget at +300 ms lands well past it, which is why
the first attempt at this test saw nothing. Both pill clicks issued in **one task** puts
the second `morphTier` in front of the first morph's warm commit deterministically, because
`apply()`'s promises resolve in microtasks and the render does not. Against the unfixed
build:

```
log        ["pcon->ward", "seed+0", "watchdog+693", "animate+702", "finalise+1521"]
morphSeed after everything settles:  "borough"      (morphBasis null, switching false)
committed renders across the whole 750 ms morph:  4
final picture vs the pre-click borough map:  MAD 1.579   (control, ?ghost=0:  5.840)
```

Four renders for a 750 ms animation, because the layer being animated was not the layer
being drawn; the watchdog forcing the animate through at +693 ms, because with a static
picture on screen deck.gl had no reason to draw a second frame for `afterCommit(…, 2)` to
count; and `morphSeed` still `"borough"` for the life of the page, so `buildStack` went on
resolving `shown` to a tier the reader had left. The endpoint alone would never have caught
it — FINALISE reveals the destination either way.

**The fix is not the suggested one, and the difference matters.** Clearing
`morphSeed = null` at `morphTier` entry is correct only if the previous morph's warm commit
has already *rendered*. In the reproduction above it has not — that is precisely how the
window is entered — so clearing it would reveal a basis whose buffer has not been uploaded:
the flash this whole mechanism exists to remove, reintroduced on the interrupt path.

Instead the warm sequence is **carried over**. `morphSeed` is left standing, and a second
predicate re-ghosts the basis and re-arms the reveal:

```js
if (fromKey !== BASIS && morphBasis !== BASIS) {
  B.snap = true;
  paintFrom(B, fromT, fromVals, fromNd, m, PARENTS[fromKey]);
  if (ghostWarm) morphSeed = fromKey;
}
var warmSeed = false;
if (ghostWarm && morphSeed) { B.ghost = true; warmSeed = true; }
```

`morphSeed` is non-null exactly while the basis has been painted and not yet REVEALED —
it may well have been *drawn* by then, as a ghost, which is the whole point — and that is
the invariant the mechanism needs. This morph's reveal clears it. The
outgoing tier — still the picture on screen, since nothing revealed the basis — stays
drawn for the carried-over warm commit. After the fix, the same reproduction:

```
log        ["pcon->ward", "seed+0", "reveal+167", "animate+178", "finalise+1003"]
morphSeed after everything settles:  null
committed renders across the morph:  20+ and climbing continuously
final picture vs the pre-click borough map:  MAD 5.840   — identical to the control
```

**New assertion A5b.** A5 fires at +300 ms, past both warm windows, so it asserted nothing
about them. A5b pre-visits ward, pcon and borough so every layer carries a drawn buffer,
then issues both clicks in one task and asserts four things at once: the endpoint is the
ward map (MAD 0.0002/255, 10 px of 1,330,000), `morphSeed` is clear afterwards, the morph
was actually *drawn* (at least 30 committed renders — it logged 256), and no watchdog entry
appears in the morph log. Stranding fails three of the four.

One task is a **superset** of a real double-click, not a copy of it. Two `setArea` calls
with no yield between them leave two `apply()` chains in flight over the same `tier`
global, so for the moment between them `READY[tier]` aliases and one `buildStack` can emit
two layers carrying the same `poly-<key>` id; a human double-click always has at least one
task boundary in it and cannot reach that state. It is used anyway, because the state it
*does* reach — the seed's warm window, entered with `morphSeed` standing — is the one under
test and is not reachable from outside the page any other way, and because a page that
survives the superset survives the subset.

## Finding 2 (IMPORTANT) — A13's fixed leg passed if the probe never ran

Correct, and it was the worst possible failure mode: the leg asserting the page is clean
returning its loudest pass when the probe had stopped looking. `spike_of` returns 0.0 for a
log shorter than three samples, `__flicker.log()` returns `[]` when `PROBE` is null, and
`probeSample()` deliberately swallows a throw into `PROBE.dead` (so that a diagnostic
cannot fail a run through the page's own errors gate) — which meant nothing anywhere would
have noticed.

Every A13 leg now folds `info.on && !info.dead && len(flog) >= 30` into its own `ok`, and
prints all three so a failure says which one it was. The committed run signs 101 / 91 / 112 /
162 frames across the four legs.

## Finding 3 — the two other reveal-and-repaint paths: measured, both clean, neither fixed

Both were measured with the same probe and metric before touching anything, and the
measurements say there is nothing to fix. Fixing either on the strength of the code shape
alone would have been exactly the blind fix this investigation is not allowed to make. Both
are now A13 legs so the finding cannot rot.

**(a) A measure / year / change-view switch landing mid-morph.** `endMorph(); paint(T);
redraw();` really does reveal the hidden destination on the same commit that first hands it
new values. Worst one-frame excess across the switch: **0.00%** standalone and **0.01%** in
the committed driver run, in both the measure and the change-view variants — every marked
frame is a clean step, with negative excess. The
reveal frame *does* draw an out-of-date value (mean luminance 94.107, the tier's own map on
the old measure), but that is where the 750 ms measure ease is supposed to start. Warm-
committing it would land the new measure instantly and delete the animation, which is a
worse page, not a better one. **No change made.**

**(b) The curtain, under `?morph=0`.** Section 5's original claim — that `paintFlat` gives
the incoming layer a clean frame — was wrong in its reasoning, and the reviewer was right to
challenge it: `paintFlat` runs while the layer is hidden, and hidden layers are not drawn.
But the conclusion survives measurement. On the same route (repeat area switch after a
measure change, so the incoming layer's buffer is a whole measure out of date):

```
worst one-frame excess    0.00% standalone / 0.02% over 162 frames in the driver run
the FADE_UP reveal frame                   mean luminance 11.575, d(prev) = 0,
                                           170,940 of 196,608 pixels in the darkest bucket
the frames after it   11.575 -> 11.588 -> 11.686 -> 11.849 -> 12.480 -> 13.530 -> ...
the settled ward map                       mean luminance 89.138
```

The rise starts **flat** and climbs smoothly. **The curtain does not flash, there is no
production ticket #5, and the shipped map does not have this defect** — but it is clean for
a different reason than first written down: the out-of-date value its reveal frame draws
*is* the flat baseline `paintFlat` established while it was hidden. The page's own comment
on that line ("it does not have to be VISIBLE to acquire one") turns out to be exactly
right. Sections 5 and 9.6 are corrected in place, and this measurement is what retracts the
too-strong "a hidden paint never reaches the GPU" claim in section 5.

## The smaller corrections from the review

- **The histogram metric is L1, and was described as a pixel count.** A pixel that changes
  bucket moves two counters, so L1 is about twice the number of pixels. Section 2 now
  defines it, quotes both, and says the assertions are unaffected because limits and
  measurements are in the same units. The same correction is in the page comment and in the
  A13 output.
- **Section 3's attribution of the seed residual to the borough outlines was wrong** —
  `buildStack` keeps them up both before the click (`tier` is ward) and during (`switching`
  is true), so nothing about them changes across that frame. Replaced with a
  nearest-neighbour scan of the whole run, which puts the frame at **distance 0** from six
  frames in three earlier steps, all of them the basis holding the *borough* plateau under
  the previous measure. Not the paint before this one; an older resident buffer still.
- **Section 6's "+6-16 ms" was a guess.** Replaced with an A/B of 24 morphs on each setting
  inside one browser session: **-6.1 ms** to the animation start, **+7.1 ms** to the whole
  morph, and the hand-off frame **47 ms shorter**. The section also warns against reading
  this off `RESULTS.txt`, whose per-capture logs vary by ±100 ms between whole-driver runs
  and suggest a +75 to +195 ms regression that the controlled A/B shows is not there.
- **The A13 single-region caveat is now printed in `RESULTS.txt`**, not only in section 9.2.
- **The "During a switch TWO are visible at once" comment above `buildStack` was already
  false and is now more so.** Rewritten: exactly one area type is ever visible for its
  pixels, and a second may be in the stack as a ghost, which is the only overlap there is.
