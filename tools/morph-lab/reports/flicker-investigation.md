# The one-frame flash at the end of a morph — investigation and fix

**Status: FIXED.** Branch `labs/flicker-fix`. `python tools/morph-lab/capture_v1.py`
exits 0 with 13/13 assertions, A13 being new.

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
with each step settled before the next, on a fresh load. `d(prev)` / `d(next)` are
histogram distances in pixels-moved-a-bucket, out of 196,608; a **one-frame anomaly** is a
frame further from *both* neighbours than they are from each other.

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
  46,258 px  23.53% of the region   s5 SEED       redraw[vis=oa mb=oa sw=1 snap=oa] phase:seed
  16,328 px   8.30% of the region   s5 FINALISE   redraw[vis=borough mb=- sw=0 snap=borough]
     196 px   0.10%                 boot
      60 px   0.03%                 noise floor
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

**s5 SEED (n=488).** 20,810 away from the settled ward map under the previous measure —
and 20,810 is the constant that every borough hand-off in the table shows, because it is
the borough outlines switching on and off. The seed frame is therefore *the previous
measure's ward map, plus the outlines the seed turns on*: the basis's stale buffer,
exactly. Against its own correct picture one frame later it is 46,978 away.

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

Three measured facts about deck.gl 9.3.7 (with luma.gl 9.3.3 in the bundle), stacked:

1. **deck.gl does not draw `visible: false` layers at all.** In the bundle,
   `_shouldDrawLayer` returns false immediately on `!layer.props.visible`.
2. **A paint issued to a hidden layer therefore never reaches the GPU.** The morph paints
   the destination at ANIMATE while it is hidden; 750 ms later, at FINALISE, that update
   has still not been applied. It is not a race that more waiting fixes.
3. **On the render that first sees new attribute values, deck.gl still holds the old
   ones.** This is not new — it is exactly the fact the two-commit `afterCommit` encodes
   ("a transition that has only been created has not yet been applied"), recorded in
   task-2's fix round 1. What was not noticed is that *the layer is drawn on that render*.
   When the layer is hidden that costs nothing. When the same commit also reveals it, the
   reader gets a frame of the old buffer.

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

Nothing here is morph-specific in principle, but the curtain never meets it: its incoming
layer is rendered flat (`paintFlat`) for a full frame before it rises, so its first drawn
frame is the flat baseline it wanted anyway.

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

**Commit counts are unchanged where it matters.** The animate used to wait two commits of
an already-revealed basis; it now waits the warm commit and the reveal — the same two, the
same contract (created on the first, applied on the second), and no extra latency before
the animation starts. The morph log gains one entry, `reveal+N`, between `seed` and
`animate`. FINALISE gains exactly one commit, which is ~6–16 ms with nothing moving.

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
     region [500, 226, 512, 384] of [1400, 950], 98/97 committed frames signed
     pass fixed page      worst one-frame excess   0.00%  (limit 1.00%)
     pass ?ghost=0 control worst one-frame excess  14.28%  (floor 5.00%)
          the control's spike is at redraw[vis=ward mb=- sw=0 snap=ward ghost=-] phase:finalise
PASS A13 no committed frame shows a picture its neighbours do not
```

`?highlight=off` for the same reason A6 uses it: the peak pulse is a second animation over
the hand-off, and this metric is about what one frame does that its neighbours do not.

Across the full ten-step matrix rather than A13's single switch, the worst one-frame excess
anywhere in 973 committed frames on the fixed page is **42 px, 0.02%** — against 46,258 px,
**23.53%**, on the unfixed one. Three orders of magnitude, with the limits in the gap.

---

## 8. Full re-run

`python tools/morph-lab/capture_v1.py`, no arguments, **exit 0, 13/13**. Every
pre-existing number is stable within run-to-run noise, and `RESULTS.txt` plus all 18 PNGs
are regenerated in place.

```
                              after the fix       fix round 1 (before)
A2  default -> ward           0.0001/255   6px    0.0002/255  16px
A3  pcon -> gla               0.0000/255   0px    0.0000/255   0px
A3  ward -> borough           0.0000/255   0px    0.0000/255   0px
A4  progression        7.90% -> 54.93% -> 95.08%   7.77% -> 54.82% -> 94.99%
A5  interrupt                 0.0001/255   6px    0.0003/255  19px
A6  measure change     45.7% -> 56.8% -> 93.3%    45.7% -> 57.1% -> 92.2%
A7  suppression               0.0000/255   1px    0.0001/255   3px
A8  change view               0.0002/255  16px    0.0003/255  24px
A9  street mode        0 of 132 samples           0 of 130 samples
A10 zoom during morph  drift 0.00 pts             drift 0.02 pts
A11 reduced motion     0 of  94 samples           0 of  94 samples
A12 unpainted basis           0.0001/255   6px    0.0002/255   8px
A13 one-frame flash    0.00% fixed / 14.28% control        (new)
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

4. **The FINALISE hand-off now costs one extra committed frame.** ~6–16 ms with nothing on
   screen moving, and it is more than paid for by the hand-off frame itself dropping from
   58.3 ms to 8.5 ms. But it is one more commit that a future interrupt has to be able to
   land inside; the token guard covers it and A5 still passes, and `endMorph()` clearing
   ghosts is what makes an interrupt inside the window safe rather than blank.

5. **`depthCompare: "never"` is a deck.gl/luma.gl-version-sensitive constant**, in the same
   way `SNAP_MS = 1` is. If a future build stopped honouring per-layer `parameters`, the
   ghost would draw for real. `opacity: 0` would still hide the colour, but the depth
   writes would return and could punch holes in the basis. A13's fixed leg is what would
   catch it.

6. **The mechanism is latent everywhere a deck.gl layer is revealed and repainted in one
   commit,** not just here. Nothing in the shipped map does it today — the curtain's
   `paintFlat` accidentally avoids it — but anyone adding a hidden-then-shown layer to that
   page will meet it, and it is invisible in code review because the wrong frame is
   perfectly coherent.

7. **What is still left to the eye.** Whether the fixed hand-off *feels* seamless on a real
   60 Hz display, and whether the ~1.4 s of first-morph tessellation still reads as lag on
   the click. Neither is a still-frame question and neither is asserted here.
