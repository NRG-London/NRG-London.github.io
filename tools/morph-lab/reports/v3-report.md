# V3 — the boundary warp on the GPU: report

**Status: DONE. The spike is POSITIVE, and the consequence the brief predicted is the one
that happened: v2's three sequential beats collapse into one gesture.**

The V3 hypothesis was that deck.gl blanks a `SolidPolygonLayer` because of *what* v2 asked it
to animate — the double-precision `vertexPositions` attribute — and that a displacement applied
in the vertex shader from a separate attribute plus a uniform would sidestep the failure
entirely. It does. The position attribute is written once, at load, and never again; the whole
per-frame cost of a warp is one float. Because deck.gl never learns that anything moved, it
never re-tessellates, and because it never re-tessellates it never restarts the colour
transition — which is the exact mechanism that forced v2's crack / values / heal into three
separate beats.

Driver: `python tools/morph-lab/capture_v3.py` → **exit 0**, `RESULT ALL ASSERTIONS PASS`.

Commits on `labs/v3`. Deliverables: `static/labs/morph/v3/index.html`,
`tools/morph-lab/capture_v3.py`, `tools/morph-lab/captures/v3/` (36 PNGs + RESULTS.txt), one
entry added to `static/labs/morph/index.html`. Run 3 of four FAILED and is reported in full
under Concerns — it is what found the one real bug in this task.

---

## 1. The spike verdict

### The question

> Can a custom `deck.LayerExtension` displace a `SolidPolygonLayer`'s vertices without touching
> the attribute that blanks it — and if so, do deck's ordinary value transitions run
> concurrently with that displacement?

**Yes to both**, and the concurrency is measured rather than inferred.

### The injection point, and the two that do not work

deck.gl 9.3.7 declares exactly four shader hooks (read out of the bundle):

```
vs:DECKGL_FILTER_SIZE(inout vec3 size, VertexGeometry geometry)
vs:DECKGL_FILTER_GL_POSITION(inout vec4 position, VertexGeometry geometry)
vs:DECKGL_FILTER_COLOR(inout vec4 color, VertexGeometry geometry)
fs:DECKGL_FILTER_COLOR(inout vec4 color, FragmentGeometry geometry)
```

**`vs:DECKGL_FILTER_GL_POSITION` is the only one that can reach position**, and the two the
brief suggested as alternatives cannot, for reasons worth recording:

* **`vs:#decl`** is injected at luma.gl's `__LUMA_INJECT_DECLARATIONS__` marker, which sits
  *above* the shader body — before `in vec3 vertexPositions;` is declared. So it cannot
  macro-shadow the attribute, and a GLSL ES 3.0 `in` is read-only in any case.
* **`vs:#main-start`** lands immediately after `void main(void) {` — which is *before*
  `props.positions = vertexPositions;` — and **`vs:#main-end`** lands after
  `calculatePosition(props)` has already projected and lit the vertex. Neither can reach the
  assignment in between.

The hook fires at exactly the right moment. From the bundled `SolidPolygonLayer` source:

```glsl
gl_Position = project_position_to_clipspace(pos, pos64Low, vec3(0.), geometry.position);
DECKGL_FILTER_GL_POSITION(gl_Position, geometry);      // <- here
if (solidPolygon.extruded) {
  ...
  vec3 lightColor = lighting_getLightColor(colors.rgb, project.cameraPosition,
                                           geometry.position.xyz, geometry.normal);
```

— after projection, **before** the lighting, and in *both* the top-face and the side-wall
shader, because the two share `calculatePosition`.

The displacement is applied by re-projecting rather than by scaling an offset:

```glsl
vec3 pTrue = geometry.worldPosition;
vec2 warped = pTrue.xy + (morphCentroid - pTrue.xy) * morphWarp.amount;
vec3 dCommon = project_position(vec3(warped, pTrue.z)) - project_position(pTrue);
vec4 moved = vec4(geometry.position.xyz + dCommon, geometry.position.w);
position = project_common_position_to_clipspace(moved);
morphWarp_setCommonPosition(moved);
```

Differencing two full `project_position` calls keeps it exact under web mercator's latitude
distortion; adding `dCommon` to `geometry.position` rather than recomputing it preserves the
extrusion height, which `geometry.worldPosition` does not carry (the shader adds `elevations`
to `pos.z` *after* setting `worldPosition`).

### `morphWarp_setCommonPosition`, and why it has to exist

The hook's declared signature passes `geometry` **by value** — `inout` is on `position` only.
So the parameter shadows deck's file-scope `geometry` struct and assigning to it inside the
hook writes a copy that is discarded. The lighting runs *after* the hook and reads
`geometry.position.xyz` for its view vector, so without a way to write the real thing the
specular would be computed at the vertex's true position while the vertex is drawn somewhere
else. A function declared in the module body has no such parameter, so the name resolves to the
global; calling it from inside the hook writes it.

This was A/B'd rather than argued (`?warpgeom=0` drops the line):

| | MAD vs the CPU ground truth |
|---|---|
| with the write-back (shipped) | **0.0029/255** |
| without it | 0.0116/255 |

Four times closer. The line stays.

### Normals are left alone, and that is correct rather than approximate

`v' = c + (v − c)·s` is a uniform scale about a point — a similarity transform, which preserves
every direction exactly. The side-wall normal is built from `(pos − nextPos)`, whose direction
the warp does not change, and the top face's is `(0,0,1)`. So no normal has to be recomputed
and none is.

### The attribute is the ring CENTROID, not the displacement

The brief specified a per-vertex displacement `(c − v)`. That does not survive the side-wall
shader, which draws one instance per edge and interpolates:

```glsl
props.positions = mix(pos, nextPos, positions.x);
```

A per-vertex displacement would need a second view of the same buffer (deck.gl does provide the
mechanism — `shaderAttributes: {nextVertexPositions: {vertexOffset: 1}}` is how
`vertexPositions` itself does it) *and* would have to repeat the shader's
`RING_WINDING_ORDER_CW` swap of the two ends, or the walls shear. **The centroid is constant
along a ring**, both ends of any edge belong to the same ring, so mixing it is a no-op and the
winding order cannot matter. One attribute, no second view, no swap.

Precision: the centroid is Float32, whose ulp at latitude 51.5 is ~6.1e-6° (~0.68 m). It feeds
`(c − v)·amount` with `amount ≤ 0.08`, so the worst displacement error is ~5 cm against a
ground resolution of ~33 m/pixel — and at `amount = 0` it is multiplied by **zero**, which is
why the endpoint identity below is exact rather than merely close. Float64 would buy nothing:
`geometry.worldPosition` is the float32 high half of deck's own fp64 split and carries the same
0.68 m quantisation regardless.

### `stepMode: "dynamic"`

Copied from `SolidPolygonLayer`'s own declaration of `vertexPositions`, and load-bearing: the
layer draws top faces from a **non-instanced** model and side walls from an **instanced** one
off the same buffers. `"dynamic"` is what lets one attribute serve both. Anything else binds
correctly for one model and garbage for the other.

---

## 2. What was built

Fork of `static/labs/morph/v1/index.html`, additive. Every V1 invariant is untouched and still
load-bearing: `SNAP_MS = 1`, the two-commit `afterCommit` with its watchdog, the warm-commit
ghost reveals, `morphSeed` carry-over, the `polyData` cache, the interrupt tokens.

**The extension** (~40 lines of class, ~25 of GLSL, inline, no build step): one shader module
carrying a `morphWarpUniforms` UBO, an `in vec2 morphCentroid`, the write-back helper and the
hook injection; a `MorphWarpExtension extends deck.LayerExtension` adding the attribute in
`initializeState` and setting the uniform in `draw`. It is written as a `class` in a page that
is otherwise entirely ES5, because `deck.LayerExtension` is an ES6 class and
`Object.create` + `.call()` on it throws.

**`morphAmount` is a FUNCTION prop, not a number.** That is what makes the per-frame cost one
uniform write: the page changes a variable and pokes the live layer, and no layer is
constructed, no `data` object replaced, no prop diffed. A number would have meant rebuilding
the layer sixty times a second.

**The extension is attached for the life of the page**, not for the length of a gesture.
Adding or removing one sets `changeFlags.extensionsChanged`, which destroys and rebuilds the
layer's models and calls `invalidateAll()` on every attribute — a full re-tessellation, i.e.
exactly the stall the design exists to avoid. The ward layer always carries it; the warp is off
because the uniform is zero.

**The warp basis is the finer tier of the pair, not V1's output areas.** V1 animates everything
on the OA geometry because it is the one basis that can stand in for any pair. That is exactly
wrong for a warp: insetting 26,369 output-area rings cracks the map along output-area
boundaries, which is not the seam the reader is being shown. So a warped pair is drawn on the
finer of its two tiers — and for a nested pair that tier is *one of the two endpoints*, which
makes the choreography shorter than V1's:

* **Split (borough → ward):** the basis is the **destination**. Seeded with the borough plateau
  (pixel-identical to the borough map), warmed as a ghost, revealed, then animated to the
  wards' own values. At the end the ward layer holds the ward map on true geometry — it *is*
  the destination layer, so finalising changes no pixels and there is no second swap to hide.
* **Merge (ward → borough):** the basis is the **source**, already on screen holding exactly the
  right picture, so there is no seed at all. It animates to the borough plateau and only then
  hands over to the real borough layer, through V1's warm-commit ghost, unchanged.

**Ward→borough crosswalk** ported from v2, including its refusal to trust the labels file:
derived only from `oa.parents.json`, throwing on a conflicting borough for a ward, an
out-of-range row at either end, or any ward left unmapped. Built on demand (v1 loads tiers
lazily) and published so the driver can assert the check *ran*.

**The envelope.** One curve over the whole gesture, cubic-in-out on both arms so it leaves 0,
reaches the peak and returns to 0 with zero velocity at all three — no corner at the top, and
the heal settles rather than arriving. The peak sits at **0.38**, not the middle: the seams
want to be open while the *colours* are moving fastest, and cubic-in-out on the values puts
that around a third of the way in. A symmetric envelope reads as the crack leading and the
colours trailing after it.

**`?warp=0`** takes the extension out entirely — not disabled, never constructed — and every
pair falls back to V1's morph. A0 asserts that this is pixel-identical to v1 itself on the same
route.

**Lab affordances**, all inert unless asked for: `?bench=1` (a slider straight onto the
uniform), `?wt=` (hold the warp at a morphT), `?cpuwarp=<s>` (v2's warp applied to the position
buffer before the first draw — the CPU ground truth), `?stage=plateau` (hold the ward layer at
the borough plateau), `?warpgeom=0` (drop the geometry write-back), `?s=`, `?wk=`.

---

## 3. The one real defect found, and it was not the warp

Warming the ward tier at boot — necessary, because a cold split's seed is that layer's first
draw and cost a measured **625 ms** of tessellation before the crack could open — exposed
something worse:

**deck.gl scheduled no frame at all for the ghosted seed.** With the ward layer already
tessellated and in the stack, the seed's redraw made it visible-as-a-ghost with replaced
buffers, and `renderCount` measured **flat at 6 for the full 500 ms** until the watchdog forced
the reveal through. Before the warm-up existed the seed *did* commit, because the ward layer
was absent from the stack and adding a layer is a change deck.gl always draws for.

That is not a latency bug. A reveal reached by watchdog is a reveal whose seed never reached
the GPU — precisely the one-frame flash the ghost commit exists to remove.

Fixed with `deckgl.redraw(true)`, which renders synchronously and unconditionally so
`onAfterRender` — and therefore `afterCommit`'s counter — fires inside the call. Used only
directly after a redraw whose commit something is waiting on, never on a frame path. The warp
loop keeps the cheaper `layer.setNeedsRedraw()`, which is sufficient there because the layer it
pokes is on screen and drawing anyway.

Result: `seed+2 → watchdog+508 → reveal+509` became **`seed+6 → reveal+56 → gesture+69`**.

---

## 4. Driver

`capture_v3.py` inherits the whole of V1's battery and adds five arms. Two of V1's assertions
are pinned to `&warp=0`, and both for stated reasons rather than convenience:

* **A4 and A10** measure the transition by pixel distance between the two endpoint maps. That
  stops meaning anything the moment the geometry is also moving — on the warp path A4's own
  metric reads **320%**, because a cracked frame is far from both closed ones. They keep doing
  the job they were written for, on the path they were written for; **W2** makes the equivalent
  claim about the warp with references that carry the crack.
* **A12** exists to prove `morphReady()` lets a morph start with an *unpainted output-area
  basis*. borough→ward is warped in V3 and does not use that basis at all, so with the warp on,
  clearing `READY.oa.painted` would have tested nothing and the assertion would have passed for
  the wrong reason.

**A13's `?ghost=0` control leg is also pinned to `&warp=0`,** and this one is a finding rather
than a fix. The control's whole job is to prove the flicker probe can still *see* the defect;
measured on the warp path the same leg comes back 0.00%, i.e. it does not reproduce there.
**This run does not establish why.** The warp split still ships the ghost commit — it is cheap,
it is V1's invariant, and an unexplained absence is not a reason to remove a guard — but the
warp leg is reported as a number and gated on nothing, and it is *not* evidence that the ghost
is doing anything there. Only the V1 leg carries that.

New arms:

* **A0** — v3 under `?warp=0` against **v1 itself**, same route, same frame, both served from
  one origin. The strongest available form of "the V1 morph did not regress".
* **S** — the spike: the extension attached and its attribute bound; the page at rest against
  the page built without the extension; the shader warp against the CPU ground truth; the
  browser's own log read over CDP for WebGL errors; frame rate of a pure scrub.
* **W1** — endpoint identity for both warped directions.
* **W2/W3** — concurrency and frame rate, below.
* **W4** — a zoom (two `elevationScale` stack rebuilds) and an interrupt, both landing inside
  the gesture.
* **An ink gate over every committed frame**, and a zero-WebGL-errors gate over the whole run.
  This is v2's lesson and it is not optional: deck.gl blanked the layer for a whole sprint while
  `errors == 0` and nothing reached `window.onerror`, because a WebGL `INVALID_OPERATION` is not
  a JavaScript exception. `errors == 0` is not a drawing assertion.

### How W2 measures concurrency

A mid-warp frame is far from *both* endpoint maps for reasons that have nothing to do with the
values, so the value progress has to be measured against frames carrying the **same crack**.
The frame is sampled at the envelope's **peak**, where cubic-in-out is stationary — so the tens
of milliseconds a screenshot round trip costs barely move the displacement — the uniform is read
either side of the shot and averaged, and four references are then staged to match it:

| reference | values | crack |
|---|---|---|
| `?tier=ward&stage=plateau&wt=T` | borough plateau | live |
| `?tier=ward&wt=T` | ward's own | live |
| `?tier=ward&stage=plateau` | borough plateau | none |
| `?tier=ward&warp=0` | ward's own | none |

The first two give the value progress with the geometry divided out. The second two exist so
that the *displacement* can be proved from pixels rather than from the page's own report of its
uniform: the live frame is asserted to sit closer to the cracked pair than to the flat one, and
a frame whose geometry had not moved could not.

---

## 5. Numbers

From the committed `tools/morph-lab/captures/v3/RESULTS.txt` (36 PNGs). Driver exits **0**:
`RESULT ALL ASSERTIONS PASS`.

> **Every section of this report quotes the run that was committed at ITS stage, not the run
> in `RESULTS.txt` today.** The evidence regenerates on every driver run and each round
> appends rather than rewrites, so the figures below are the ones this section was written
> against and the file in `captures/v3/` is always the latest round's. Where a number has
> since moved — frame rates especially, which vary with machine load by a factor of three —
> the later section says so and the ranges in the workbench hub are written to stay true
> across all of them.

### The spike

```
pass the extension is attached and its attribute BOUND:
     float32 x2 dynamic, 101476 values for 50738 vertices
```

| # | what | result |
|---|---|---|
| A0 | v1 vs v3 `?warp=0`, same borough→ward route | **MAD 0.0001/255**, 5 px >12/255 |
| S1 | extension at rest vs the page built without it | **MAD 0.0001/255**, 8 px |
| S2 | shader warp vs CPU ground truth at inset 0.92 | **MAD 0.0029/255**, 217 px (0.0163%), max 51 |
| S2 | ink, same pair | 0.2714 vs **0.2714** |
| — | no blanking | ink 0.2783 at rest, 0.2714 fully warped (floor 0.15; v2's blanked layer **0.0363**) |
| — | WebGL errors, whole run | **0** |
| — | pure scrub | **179.9 fps**, 360 frames, worst frame **9.9 ms** |

### The gesture

| # | what | result |
|---|---|---|
| W1 | split endpoint (borough→ward) vs the ward map | **MAD 0.0003/255**, 14 px |
| W1 | merge endpoint (ward→borough) vs the borough map | **MAD 0.0000/255**, 0 px |
| W2 | gesture endpoint after the slow 3 s run | MAD 0.0002/255, 11 px |
| W4a | endpoint after a zoom landing mid-gesture | MAD 0.0001/255, 4 px |
| W4b | endpoint after an interrupt at 35% | **MAD 0.0000/255**, 0 px |
| W3 | fps across the gesture | **178.1 fps**, 529 frames, worst 21.6 ms |

Phase logs (page clock, ms from the click), at the default 750 ms:

```
split: ["borough->ward (warp)", "seed+4", "reveal+39", "gesture+49", "healed+805", "finalise+864"]
merge: ["ward->borough (warp)", "gesture+3", "healed+757", "finalise+822"]
```

The merge has **no seed and no reveal at all** — the ward layer is already the picture on
screen — so its crack starts 3 ms after the click. Compare v2's three-beat merge:
`["merge", "open+0", "values+3049", "heal+6113", "finalise+9165"]`.

### Concurrency — the number the whole thing is for

Sampled at the envelope's peak of a deliberately slow 3,000 ms gesture:

```
uniform 0.07986 -> morphT 0.9982 (inset 0.92, peak 0.38)
pass the page's own inset/peak match this driver's (0.92, 0.38)
     the two same-crack references are 4.7963/255 apart
     the live frame is 1.5069/255 from the plateau end and 3.9016/255 from the ward end
pass VALUE PROGRESS 31.42% across, strictly interior (band 10-90%)
pass POSITION DISPLACEMENT, from pixels rather than from the page's own report of
     its uniform: the live frame sits 5.4085/255 from the CRACKED pair and 6.1263/255
     from the same two states with the crack closed, so it belongs to the cracked family.
pass and the page reports the uniform at 0.07986, 99.8% of a full crack
```

**The crack is 99.8% open and the values are 31.4% across, in the same frame.** v2's
equivalent measurement, made live in its own driver every run, was 29.25% across at the
**84%** mark — the values barely moving while the outlines did, and only catching up after
the loop stopped. That is the difference the whole extension exists to make.

### V1's battery, inherited

All of A1–A13 pass. Selected:

```
PASS A4 the morph interpolates: 8.26% -> 54.88% -> 95.64%      (on ?warp=0, V1's path)
PASS A6 the measure change after a morph still animates
PASS A9 street mode never morphed: morphActive false in all samples
PASS A11 reduced motion: TRANSITION 0, no morph, the switch lands instantly
PASS A12 an unpainted basis is a morph that pays its own tessellation, not a dead one
PASS INK GATE   36 PNGs, ink from 0.1975 to 0.3083, floor 0.15
PASS NO WebGL ERRORS anywhere in the run (0)
```

A13's four gated legs:

```
pass fixed page, first arrival after a measure change    0.00%  (limit 1.00%, 104 frames)
pass ?warp=0&ghost=0 control, the same route            14.28%  (floor 5.00%,  99 frames)
pass measure change landing MID-MORPH                    0.02%  (limit 1.00%, 126 frames)
pass the CURTAIN under ?morph=0, the same route          0.00%  (limit 1.00%, 152 frames)
.... ?ghost=0 on the WARP path                           0.00%  (REPORTED,    138 frames)
```

The ward→borough crosswalk is checked, not assumed: **689 of 689 wards mapped from 26,369
output areas, 0 conflicts** (a conflict throws at boot).

---

## 6. Deviations from the brief

1. **The attribute is the ring centroid, not `morphDelta`.** §1 gives the reason: a per-vertex
   displacement does not survive the side-wall shader without a second buffer view and a
   winding-order swap, and the centroid needs neither. The maths and the aesthetic are v2's
   unchanged.
2. **The warp basis is the finer tier of the pair, not V1's fixed output-area basis.** Required
   by the aesthetic, not a shortcut: an OA basis would crack along output-area boundaries.
3. **A4, A10, A12 and A13's control leg are pinned to `&warp=0`** — §4, with reasons.
4. **One `class` in an otherwise ES5 file**, because `deck.LayerExtension` cannot be subclassed
   any other way.

## 7. Concerns

1. **The driver was run four times and the third run FAILED.** That run is not hidden and its
   two failures are the reason for two of the changes above:

   | | run 1 | run 2 | run 3 | run 4 (committed) |
   |---|---|---|---|---|
   | A5b retarget in the warm window | pass | pass | **FAIL** | pass |
   | A13 mid-morph one-frame excess | 0.08% | 0.00% | **1.25%** (limit 1.00%) | 0.02% |
   | A13 `?ghost=0` control | — | 36.89% | 14.27% | 14.28% |
   | A13 `?ghost=0` on the WARP path | 0.00% | 40.97% | 3.30% | 0.00% |
   | scrub worst frame | 8.4 ms | 50.4 ms | — | 9.9 ms |
   | S2 shader vs CPU truth | 0.0029 | 0.0034 | — | 0.0029 |

   Run 3's A5b failure was `a5b pre-visit borough: STATE NOT REACHED` — the driver waiting
   120 s for a `finalise` entry on a **pcon→borough** morph (V1's path, not the warp's) while
   the page sat settled with 0 errors and the endpoint landing at 0.0005/255. All four of
   A5b's substantive sub-checks passed in that run. **The mechanism is not established**, and
   it has not reproduced in three other runs. It is a V1-path arm and a V1-path morph, so it is
   not obviously V3's, but "not obviously" is the whole of what is known.

   It did, however, cause the one genuine bug in this task to be found — see 2.

2. **A regression I introduced and the third run caught.** Rewriting `endMorph` to retire the
   warp replaced V1's reset of the **output-area basis** with a reset of the warp basis, so
   every V1 morph that was ever *interrupted* left the OA basis carrying `dur`, `ease` and
   `noPick`. Nothing else clears them: the next morph on that basis would have run at a stale
   duration and the layer would have stayed unpickable for the life of the page. Both are now
   reset. It is worth recording that **no assertion in this file caught it directly** — it was
   found by reading the code while diagnosing run 3.

3. **The flicker probe is a noisy instrument on this page.** The `?ghost=0` legs range over
   0.00% / 3.30% / 14.28% / 40.97% across runs of identical code, and the mid-morph leg
   crossed its 1.00% limit once in four. The control leg is pinned to `?warp=0`, where it has
   been ≥ 14% in every run that measured it, so A13 retains a working "this probe can still
   fail" arm — but a single reading from any of these legs should not be trusted, and the
   1.25% outlier in run 3 is **unexplained** rather than dismissed.

4. **The worst frame is not the mean.** 179.9 fps mean with a 9.9 ms worst frame in the
   committed run, but 50.4 ms in run 2 and 21.6 ms across the W3 gesture. The per-frame warp
   cost is provably one uniform write, so the spikes are something else — driver screenshot
   traffic, GC, or shader/pipeline work — and they have not been chased down. Headless Chrome
   does not lock rAF to vsync, so **none of these numbers is a claim about a 60 Hz screen**.
   What is safe to say: the warp is 4–5× the CPU path's throughput in the same harness, and it
   is not the bottleneck in any frame measured.

5. **`?ghost=0` on the warp path does not reproduce the flash, and this is unresolved.**
   0.00% in the committed run. The warp split still ships the ghost commit and `forceFrame`
   behind it, because the mechanism that made it necessary — deck.gl declining to schedule a
   frame for a hidden→ghost change, `renderCount` flat for 500 ms — was measured directly.
   But the ghost's *effect* on the warp path is evidenced only by that measurement, not by
   A13.

6. **Inherited from v2, unchanged and still unasserted:** per-ring insetting shrinks holes
   towards their own centres, so an enclave inside a ward grows rather than shrinking; and the
   inset is a fixed fraction of each ward's size, so small wards open small gaps. V3 makes the
   first one slightly more forgiving by accident — the tessellation is fixed, so a hole that
   crosses its parent ring deforms rather than being re-triangulated — but neither is measured.

7. **Only ward↔borough warps.** The design generalises (the attribute is a property of the
   drawn tier's geometry, and `warpPair` is one lookup), but no second pair is wired and
   nothing here says the aesthetic survives at output-area grain. What V3 *can* say, and v2
   could not, is that the cost of trying is the same single float.

8. **The centroid array is 406 KB at ward grain** (50,738 vertices × 2 × 4 bytes, built in
   ~1.3 ms). At output-area grain it would be an order of magnitude larger. Not a problem here;
   worth knowing before the tier list grows.

9. **`morphAmount` is a function prop.** It is what makes the per-frame cost one uniform write
   rather than a layer rebuild, but it means the extension reads mutable page state during
   `draw()`. Anyone lifting this into the E:\ template should decide deliberately whether to
   keep that or pay for the rebuild.

10. **Picking depth during a warp is unasserted.** deck.gl's picking module injects
    `picking_setPickingAttribute(position.z / position.w)` into the same hook, and module
    injections are concatenated in module order — mine is last, so the picking depth is written
    from the *undisplaced* clip position. Picking is disabled for the length of a gesture
    (`noPick`), so nothing reads it, but the ordering is incidental rather than chosen.

11. **Lab-only page code ships in the deliverable:** `?cpuwarp=`, `?stage=`, `?bench=1`,
    `?warpgeom=0`, `?wt=`. All inert unless asked for, and `?cpuwarp=` and `?stage=` are load-
    bearing for the S and W2 assertions — they are the references. But they are extra surface
    on a page that is otherwise the production map.

12. **`content/` and `.superpowers/` were never staged.** Only `static/labs/morph/` and
    `tools/morph-lab/` are in the commits.

---

# Fix round 1

Both review Importants fixed and both cheap Minors folded in. Driver re-run end to end:
**exit 0**, `RESULT ALL ASSERTIONS PASS`, evidence regenerated in place (40 PNGs).

> As above: the figures in this section are from the run committed **at the end of this
> round**. `captures/v3/RESULTS.txt` now holds a later one.

## Important 1 — a warp gesture interrupted by a NON-warp morph

`apply()`'s guard for retiring a morph is `morphBasis && !doMorph`. A retarget **is** a morph,
so mid-split clicks on Constituencies, Assembly seats, Neighbourhoods or Output areas set
`doMorph = true, warpDir = null` and fell straight through it into V1's `morphTier`, which
knows nothing about the warp. Three things were left behind at once, and the endpoint was
perfect throughout:

* `morphTier` sets `morphBasis` to the **output areas**, so the ward layer stopped being
  drawn and the open crack left the screen on one frame — a snap, which is the one thing this
  page promises the crack never does;
* nothing bumped `WARP.token`, so the envelope's `requestAnimationFrame` loop **kept running,
  detached**, driving the uniform on a retired gesture's timeline against a layer nobody could
  see;
* the ward layer kept `noPick` and a stale `dur`/`ease` until some unrelated later `endMorph`
  happened to clear them.

`endMorph`'s two-basis reset is now split. **`retireWarp()`** retires the warp and nothing
else — it eases the crack shut through `releaseWarp()` (taking `WARP.token` with it, so the
loop stops and any later gesture blends whatever is left), clears `B_WARP`, and clears the warp
basis's `dur`/`ease`/`noPick`. It is called from `endMorph()` as before, and now also from
`apply()` on exactly the path above:

```js
if (morphBasis && !doMorph) endMorph();
else if (doMorph && !warpDir && B_WARP) retireWarp();
```

The crack is **eased**, not dropped — the nice-to-have rather than the acceptable minimum.
Measured live in the new W5 leg: the uniform is 0.07984 (a full crack) when the second pill is
clicked, and 0.0017 a tenth of a second later with `B_WARP` already released.

## Important 2 — the interrupted-state assertion

Run 3's regression class would have passed the old driver: every interrupt arm proved the map
**landed** correctly, and the defect was in what was left behind. There is now an `idle_clean()`
read-back that gates on both bases at once —

```
{oa: [READY.oa.dur, READY.oa.noPick], ward: [READY.ward.dur, READY.ward.noPick],
 warp: WARP.amount, bwarp: !!B_WARP, mb: morphBasis, seed: morphSeed, sw: switching}
```

— all of which must be null / false / zero. It runs after **A5**, **A5b**, **W4b** and both new
legs. Committed results, verbatim:

```
pass IDLE STATE after A5  (borough->pcon retargeted to ward)
pass IDLE STATE after A5b (retarget inside the warm window)
pass IDLE STATE after W4b (warp gesture interrupted at 35%)
pass IDLE STATE after W5  (warp gesture retargeted to a non-warp pair)
pass IDLE STATE after W6  (measure change mid-morph, ?warp=0)
     {"oa": [null, false], "ward": [null, false], "warp": 0, "bwarp": false,
      "mb": null, "seed": null, "sw": false}
```

Two new legs:

| leg | what | result |
|---|---|---|
| **W5** | a warp gesture retargeted onto a non-warp pair (ward→pcon, mid-split) — Important 1 | endpoint **MAD 0.0000/255**, 0 px; crack **0.07984** open when the retarget fired; idle clean |
| **W6** | a measure change landing mid V1 morph under `?warp=0` — `endMorph` on a plain V1 morph, the exact shape of run 3's regression | endpoint **MAD 0.0003/255**, 20 px; `morphBasis` was `'oa'` at the moment of the change; idle clean |

W5 asserts the crack really was open before the retarget, so a version of the fix that simply
never opened one could not pass it.

## Minor 3 — the hub quoted run-2-era numbers

`static/labs/morph/index.html` said ~169 fps, 0.0034 and a 50–60 ms worst frame while linking a
`RESULTS.txt` that said otherwise.

It was then re-pointed at the committed run — and that was still the wrong shape of fix, because
**the evidence regenerates on every driver run**, so any point figure in the hub goes stale the
next time anyone runs the driver, and the sentence attributing it to `RESULTS.txt` goes from
true to false without anyone touching it. The hub now quotes **ranges across runs** throughout
(values ~30–31% at a ~99.8% crack, shader-vs-CPU ≤0.0034/255, ~175–180 fps, split endpoint
≤0.0004/255, extension at rest ≤0.0001/255, worst frame 8.4–50.4 ms) and points at
`RESULTS.txt` for the committed run's own figures rather than reproducing them. The only point
figure left is the merge endpoint's 0.0000/255, which has been exactly that in every run.

## Minor 4 — A13's ghost-on leg on V1's path

The fixed-page leg's route ends on borough→ward, which V3 warps — so "V1's seed and reveal are
flash-free with the warm commits on" was asserted nowhere, despite this task touching
`endMorph`. The leg now runs a second time under `&warp=0`, gated on the same 1% limit:

```
pass fixed page, first arrival after a measure change    0.00%  (limit 1.00%, 139 frames)
pass fixed page on V1'S PATH, ?warp=0                    0.00%  (limit 1.00%,  80 frames)
pass ?warp=0&ghost=0 control, the same route            14.28%  (floor 5.00%,  80 frames)
pass measure change landing MID-MORPH                    0.00%  (limit 1.00%, 129 frames)
pass the CURTAIN under ?morph=0, the same route          0.01%  (limit 1.00%, 149 frames)
.... ?ghost=0 on the WARP path                           0.00%  (REPORTED,     93 frames)
```

## The rest of the committed run

Unchanged in substance from the previous one; the headline figures on this run are 176.8 fps
scrub (worst frame 12.3 ms) and 178.9 fps across the gesture (worst 16.5 ms), the shader warp
0.0033/255 from the CPU ground truth, value progress 29.76% at a 99.76% crack, split endpoint
0.0003/255 and merge endpoint 0.0000/255, zero WebGL errors, and the ink gate passing on all
40 frames.

## Deferred, on the review's instruction

* A13 noise diagnosability — dumping the probe's neighbourhood when a leg exceeds its limit.
  The legs still range widely between runs (concern 3) and a failure is still reported as a
  bare percentage, so a future limit-exceed is still awkward to diagnose.
* `warmWarp` returning its promise, and a comment on the `afterCommit` / `forceFrame`
  re-entrancy contract.
* **Making W5's falsifiability measured rather than argued** — concern 1 below. The driver
  already reads the state back mid-flight into `w5_state_mid`, at the instant the second pill
  is clicked and before `retireWarp()` has finished easing. The review's suggestion is to gate
  that read as **DIRTY**: the ward pair non-clean and `B_WARP` true, i.e. assert that there
  really was something live to retire. That would turn "this assertion can fail" from an
  argument into a measurement on every run, and it is the single cheapest thing left on this
  page. Deferred on instruction, not on merit.

## Concerns from this round

1. **W5 and W6 both pass on the first run after the fix, which means neither has been seen to
   fail against the bug it covers.** (The deferred item above is the fix for the W5 half of
   this, and it is deferred rather than dismissed.) W5's mechanism was reproduced by hand before the fix (the
   detached loop, the stale `noPick`) but not captured as a red run; W6 covers a regression that
   was already repaired. Both gate on state that was demonstrably wrong at some point in this
   task's history, but "this assertion can fail" is argued here, not measured.
2. `retireWarp()` eases over 180 ms while V1's `morphTier` is simultaneously animating the
   output-area basis. Both are proven to land (W5 endpoint 0.0000/255) and the ward layer is
   hidden for most of it, so the ease is largely invisible — which also means the *quality* of
   that hand-over is unjudged by anything except the eye.
3. `WARP.beat` is left holding the last beat's name after a completed gesture (`"merge"` in
   W4b's idle read-back). It is a HUD label only and is not gated, but it is state that
   `retireWarp` clears and a normal finish does not.

---

# All-pairs extension

V3 shipped warping exactly one pair, ward ↔ borough, with `WARP_TIER` and `WARP_PARENT` as two
constants and a note saying "any nested pair can follow by adding its finer tier here". This
round takes that note up for **all thirty ordered pairs** of the six area types, under one
policy table, and replaces the constants with live state the table writes per gesture.

**The amendment is folded in.** The task as first written had every non-nested pair keep the
plain V1 morph. The owner then asked for those to warp as well — an **OA-basis shatter** — on
the reasoning that V1 already draws those transitions on the output areas, so the same envelope
on that same layer is a city-wide craze while the values flow. That is what is built: three
modes, not two, and the "plain V1 morph" is now the *revert lever* rather than the default for
anything.

## The policy table

`static/labs/morph/v3/index.html`, at the top of the morph section, immediately after
`var BASIS = "oa"` — `WARP_POLICY_TABLE`. Thirty rows, one per ordered pair, one comment per
row, third column is the mode:

| mode | what it does | pairs |
| --- | --- | --- |
| `finer` | the crack runs on the **finer tier of the pair**, which for a nested pair is one of the two endpoints. Split: the finer tier is seeded with the coarser one's plateau and cracks open as the values arrive. Merge: the finer tier cracks, the values converge, and it heals into the coarser map. | 20 — the ten nested pairs, both directions |
| `oa` | **the shatter.** No plateau exists on either endpoint, so the morph is V1's — drawn on the output areas — with the envelope on that layer. | 10 — lsoa↔ward and every pcon pairing except oa↔pcon |
| `none` | V1's plain morph, no warp. | 0 by default |

Demoting a pair is editing its third column and nothing else: `WARP_BASIS_TIERS` — which
decides which layers carry the extension for the life of the page — is *derived* from the
table, so there is no second place to remember. `warpBasisFor(fromKey, toKey)` is the single
question `apply()` asks, and it returns either null (V1's morph) or a plan naming the basis,
its parent, the direction and the crosswalk.

There is also a **URL override**, `?warpmode=ward>pcon:none,…`, validated against the table and
reported as a page error if it cannot be read. It exists because the driver needs to photograph
a demoted pair without editing the file — see X3 and W5 below.

### Which pairs nest, and how that is established

`oa` sits inside every other tier; `lsoa` and `ward` each sit inside `borough`, and `borough`
inside `gla`. `lsoa` and `ward` do **not** nest in each other, and `pcon` nests in nothing but
takes the output areas. Every crosswalk is composed through `oa.parents.json` — never through
the labels file, whose `lad[]` is not a borough row index — by the generalised `buildXwalk`,
which **throws** on a conflicting parent, an out-of-range row at either end, or any unmapped
child. `WARD2BOROUGH` and `W2B_STATS` survive as the ward→borough entry, because the existing
`__v3.w2b()` surface and the `?stage=plateau` reference read them.

X0 builds all ten from a page with every tier resident, and prints what each one saw:

```
ward>borough      689 of 689    rows mapped, 0 conflicts, over 26369 output areas
ward>gla          689 of 689    rows mapped, 0 conflicts
borough>gla        33 of 33     rows mapped, 0 conflicts
lsoa>borough     4994 of 4994   rows mapped, 0 conflicts
lsoa>gla         4994 of 4994   rows mapped, 0 conflicts
oa>lsoa         26369 of 26369  rows mapped, 0 conflicts
oa>ward         26369 of 26369  rows mapped, 0 conflicts
oa>borough      26369 of 26369  rows mapped, 0 conflicts
oa>gla          26369 of 26369  rows mapped, 0 conflicts
oa>pcon         26369 of 26369  rows mapped, 0 conflicts
```

That is the nesting claim tested rather than restated: a `finer` line on a pair that does not
really nest fails here, loudly, instead of drawing a plateau that is not the coarser map.
`oa>pcon` is the one worth naming — pcon is a best-fit assignment in the build, and it comes
back exact in the shipped geometry, which is what makes `oa ↔ pcon` a legal `finer` line.

## What had to change, beyond the table

* **The crack is now per layer.** Four tiers carry the extension (`ward`, `borough`, `lsoa`,
  `oa`), so a single global uniform would crack all four at once, ghost commits included.
  `warpAmount(layer)` names the live basis by layer id — one stable function rather than a
  closure per tier, because deck.gl compares props between rebuilds.
* **`warpsOn()` is static.** Attaching or detaching an extension rebuilds a layer's models and
  invalidates every attribute, so the attach set cannot key on the tier the crack happens to be
  on right now. It keys on the table.
* **Centroids per tier**, cached on the tier, built at most once, with the cost published per
  tier (`__v3.centroids()`). The two expensive ones are pre-built off the interaction path:
  `warmMorph` builds the output-area array (26,435 rings / 350,538 vertices, **2–4 ms** across
  runs) alongside the basis it belongs to, and `warmWarp` keeps building the ward one plus any
  other resident warp-capable tier.
* **A retarget can now change the basis**, which was impossible before. The tier the crack
  *leaves* is (a) **released** of `dur`/`ease`/`noPick` — that is the W6 defect one tier along —
  and (b) **frozen** at the crack it had, for the warm window in which it is still the picture,
  so the swap between two bases happens at one crack width. `WARP_FROZEN` is cleared by
  `retireWarp()` and by both `handBack()`s, published in the status node, and gated by the
  driver's idle read-back.
* **`morphSeed` now means "the tier actually on screen"**, not "`fromKey`". With every pair
  warping, a retarget can land on a gesture that is drawing a third tier, and the old expression
  would have kept drawing a layer that was not the picture. Both morph functions now take
  `morphSeed || morphBasis || fromKey` and never clobber a standing seed. The same change closes
  a latent stuck-seed path on the warp merge (the A5b defect shape): a merge whose basis is
  already the picture now clears `morphSeed` instead of stranding it.
* **A merge can need a seed.** The single-pair version went straight into the gesture because
  the finer layer was always the picture; now it may not be, so the seed/ghost/reveal preamble
  is shared by both directions and gated on `picture === plan.finer`.
* **`retireWarp`'s guard set has shrunk** and the comment in `apply()` says so: with every pair
  warping by default, `doMorph && !plan && B_WARP` is now reached only by a demoted pair, a
  `?warpmode=` override, or a failed crosswalk. The two cases that used to fall through it — a
  basis change, and a move between modes — are handled inside the two morph functions, because
  those must *hand the crack over* rather than retire it.

## One defect found, and it was in the shipped carry

`runWarp` carries an open crack into the new envelope so an interrupt blends rather than snaps.
It measured that blend from the envelope's `t0`, in wall-clock time.

Retargeting onto the output-area basis repaints 350k vertices and hands deck.gl new buffers,
which **blocks the main thread for ~400 ms** — X6's tape shows the gap between two drawn frames.
So the whole 180 ms carry window expired before a single frame was drawn, and the first frame
the reader actually saw dropped the crack **from 0.08000 to 0.01409 in one step** and then
reopened it. Measured, on the tape, before the fix:

```
8029  oa  0.08000   <- last frame before the block
8452  oa  0.08000   <- 423 ms later, still nothing drawn in between
8456  oa  0.01409   <- JUMP -0.06590
```

The carry is now clocked from **the first frame it draws**, which is the right clock for a blend
meant for the reader's eye: a window that expires before anything is drawn has not blended, it
has snapped. The envelope itself stays on the wall clock, deliberately, because deck.gl's
attribute transition is wall-clocked too and the crack has to stay in step with the values. The
same fix also improves the ordinary same-basis interrupt, which was losing ~85 ms of its 180 ms
window to the retarget's own paint.

X6 gates it: the steepest one-frame fall anywhere in the hand-over, limit 0.03 of a 0.08 crack.
Committed run: **0.00707**. The pre-fix defect was 0.0659.

## Verification — the X arms

All of A1–A13, A0, S and W1–W6 stay green, unchanged in substance. W5 keeps its own scenario by
demoting its pair for that page only (`?warpmode=ward>pcon:none`), since ward → pcon is a
shatter now; that also makes it the one leg exercising a demoted pair end to end.

New, and every endpoint against a directly loaded reference:

| leg | what | result |
| --- | --- | --- |
| X0 | the table as the page holds it; 30 pairs, modes as expected; extension on exactly `borough, lsoa, oa, ward`; all ten crosswalks build | pass |
| X1a | ward → gla, crack on the wards | MAD 0.0000/255, 0 pixels past 12/255 |
| X1b | borough → gla, crack on the boroughs | MAD 0.0000/255, 0 pixels |
| X1c | lsoa → borough, 4,994 LSOAs cracking | MAD 0.0000/255, 0 pixels |
| X1d | oa → lsoa, 26,369 output areas cracking | MAD 0.0002/255, 13 pixels (0.0010%) |
| X2a | pcon → gla **shatter**, and it engaged (basis `oa`, uniform 0.08 at the peak) | MAD 0.0000/255, 0 pixels |
| X2b | lsoa → ward **shatter**, same | MAD 0.0002/255, 8 pixels (0.0006%) |
| X3 | ward → pcon **demoted to `none`**: uniform 0.00000 at the peak, no basis held, nothing frozen | MAD 0.0000/255, 0 pixels |
| X4 | borough → oa at **OA grain**, 26,435 rings | MAD 0.0000/255, 0 pixels |
| X5 | the **zoom auto-switch** at 12.6, camera moved, against the same route under `?morph=0` | MAD 0.0014/255, 81 pixels (0.0061%) |
| X5b | the zoom-warp **interrupted** by a pill click | idle read-back clean |
| X6 | a retarget **moving the crack between bases** | MAD 0.0001/255, 6 pixels |

The idle read-back now covers **every resident tier** rather than the two the single-pair build
could reach, plus `WARP_FROZEN` — a tier left holding a frozen crack would draw permanently
cracked the next time it was shown, and no endpoint assertion could see it.

The endpoint identity of a shatter is worth one sentence: it cannot distinguish a shatter from
V1, because the whole design is that the geometry is true again before the hand-off. X2's
mid-flight read is what separates them, and it reads the **basis** as well as the uniform — a
crack open on the wrong layer would pass a test that only asked whether the uniform was
non-zero.

### Frame rate at OA grain — reported, not gated

Committed run: **168.6 fps over 100 frames, worst 28 ms** for the borough → oa gesture. Across
the runs of this driver during this task the same leg measured **62.7, 93.3 and 168.6 fps**, and
the ward-grain legs moved with it (W3's gesture 141.9–178.9 fps, S's scrub 90.6–179.9). That
spread is machine contention rather than the build: the state and pixel gates did not move at
all between those runs. The two gated frame rates keep their floor of 55, which v2's CPU path
could not reach at ward grain under any load. `RESULTS.txt` carries this caveat in its header.

The per-frame cost of the warp does not depend on grain — it is one uniform write either way,
which is exactly the claim v2's CPU path could not make. What scales is the centroid array,
built once, off the interaction path, and measured.

## The aesthetics, and the zoom-scaled inset question

Four frames are committed for the owner's eye and asserted by nothing:
`beauty_oa_lsoa_crack.png`, `beauty_lsoa_borough_crack.png`,
`beauty_pcon_gla_shatter_z10.png`, `beauty_pcon_gla_shatter_z12p5.png`. All four are caught at
the envelope's peak, where cubic-in-out is stationary, and take `?shield=0` so the embed prompt
is not sitting across the map.

Beside them is a measurement, because "does an output-area crack read at all when the whole city
is in frame?" is an eye question but *how much of the picture it moves* is not. Two settled
frames of the same output-area map, uniform scrubbed from 0 to a full crack, nothing else
changing:

| view | MAD | pixels past 12/255 |
| --- | --- | --- |
| whole city (zoom ~10) | 1.3384/255 | **5.81%** of the frame |
| zoomed in (zoom 12.5) | 4.8229/255 | **15.40%** of the frame |

**The reading.** At 12.5 the shatter is unmistakable — the city crazes like a glaze, and it
reads as intent. At the default whole-city view it is not invisible, but it reads as a fine
texture or etching rather than as cracks, because at ~33 m per pixel most output-area gaps are
sub-pixel. So a zoom-scaled inset — deeper `s` when zoomed out — is a *plausible* lever, and the
ratio above (2.65x more of the frame moves when zoomed in) is the size of the gap it would be
closing. **It is not implemented**, per instruction. Two things argue for thinking before adding
it: the endpoint is exact because the inset returns to zero and not because of its depth, so a
zoom-dependent depth is safe on that count — but a deeper crack at whole-city view also eats a
larger share of each area's *visible* footprint, and at 0.08 the plateau silhouette is already
visibly nibbled at the city edge. The honest position is that the z10 shatter is
legible-but-subtle and the decision is the owner's.

> **Addendum, 2026-08-17 — the owner decided, and the numbers above are superseded.**
> The lever chosen was not zoom-scaling but a **per-basis-tier inset map**, on the reasoning
> that a crack's gap is proportional to the ring it opens around: `oa 0.80, lsoa 0.92,
> ward 0.92, borough 0.96`. Boroughs gaped at a shared 0.92 and their crack is halved
> (borough→gla also has little vertical movement to carry the eye, an Assembly seat being
> 2–3 similar boroughs); the output areas were deepened to 0.80 for exactly the subtlety this
> section measured. Re-measured on the same two frames: whole city **MAD 3.0322/255, 11.216%**
> (was 5.81%), zoom 12.5 **MAD 11.8406/255, 30.468%** (was 15.40%), ratio 2.72x. `?s=` remains
> a global lever and now overrides all four tiers at once. A zoom-scaled inset is still **not**
> implemented. Everything else in this report stands as measured at the single 0.92.
>
> **One gate moved with it.** X6/X8's "no drawn frame collapses the crack" limit was an
> absolute 0.03 — quoted throughout §X6 and §X8 below — set when 0.08 was the only depth
> there was. The carry blends depth `D` to zero over `RELEASE_MS` = 180 ms of drawn-frame
> time advanced at most `CARRY_STEP_MS` = 33 ms per frame, so an *honest* frame may fall
> `D × 33/180` = 0.183 D; at the output areas' 0.20 that is **0.037, above the old 0.03**,
> and the gate would have false-failed correct behaviour on a slow machine. It is now
> `DROP_LIMIT_FRAC` = 0.375 **of the depth of the basis the frame was on** — the ratio it
> always had (0.03/0.08), so ward stays 0.03 and oa becomes 0.075, with the same margin at
> every depth (honest 0.183 D, limit 0.375 D, collapse 1.000 D). Re-measured: X6 0.00723 on
> the oa arm (10% of its limit), X8 fixed 0.00705 on ward (24%), `?carry=wall` control
> 0.08000 on ward (**267%** — the control still fails, as it must).

## Deviations

1. **Centroids are built when a tier's layer is first BUILT, not when it first warps.** The
   brief asked for lazy-on-first-warp. The page's own stated invariant is that the extension and
   the centroid attribute are "attached together or not at all" — a layer carrying the extension
   with no centroids would fall back to `[0,0]` and pull every vertex towards null island the
   instant the uniform moved. Honouring that is worth more than strict laziness, so `polyData`
   builds the array for a warp-capable tier, cached, and the two warm-ups pre-build the
   expensive ones so the interaction path only ever hits the cache. The intent of the
   instruction — no OA-grain pass on a click — is met and measured.
2. **The shatter reuses `morphTier` rather than `morphWarpTier`.** The amendment describes it as
   V1's morph with the envelope on the OA layer, and that is literally what it is: one `runWarp`
   call in `animate()` and the basis bookkeeping at the top. A second copy of the choreography
   would have been a second thing to keep in step.
3. **One page fix outside the brief**: the carry clock, above. It was found by the new X6 leg,
   it is four lines, and leaving it would have shipped a one-frame crack collapse in the middle
   of every retarget onto the OA basis.
4. **Two lab hooks added** to `window.__v3`: `setZoom` (moves the camera and re-syncs
   `applyZoom` by hand, exactly as the reset button does) and `setWarpBasis` (points the at-rest
   scrub at a tier other than ward). Both are additive; every production hook is unchanged.
   `?cwtier=` was added beside `?cpuwarp=` so the CPU-truth reference names its tier explicitly
   rather than reading a `WARP_TIER` that now moves per gesture.

## Concerns

1. **The ~400 ms main-thread block when a retarget repaints the output-area basis is real and is
   not fixed.** It is V1's cost, not the warp's — the same two paints happen on every non-nested
   morph in the shipped build — but the warp makes it *legible*, because a frozen crack is more
   obviously frozen than a frozen map. X6's tape prints the gap. Nothing here says how it feels.
2. **The shatter at whole-city zoom is subtle**, quantified above, and whether that is the right
   amount of subtle is unjudged. The revert lever is one line per pair.
3. **X6 and X5b pass on the first run after the code that makes them pass was written**, which
   is the same shape as the standing W5/W6 concern. Only the carry gate has been seen red — its
   pre-fix numbers are in this report.
4. **`?warpmode=` is a lab affordance that reaches production behaviour.** It validates its
   input and reports a page error on anything it cannot read, but it is a query string that
   changes how the map animates, and it should be considered when this page is ported.
5. **`WARP.beat` is still left holding the last beat's name after a completed gesture** —
   unchanged from the previous round's concern 3, and now reading `"shatter"` as well as
   `"split"` and `"merge"`.

---

# All-pairs fix round

Lab merge approved as-is; the production port is conditional. Both review Importants
addressed — one fixed, one **measured and stopped on the numbers**, which is the outcome the
instruction allowed for. All three Minors folded in. Driver re-run end to end: **exit 0**,
`RESULT ALL ASSERTIONS PASS`, evidence regenerated (65 PNGs, all past the ink gate). Figures
below are from that run.

## Important 1 — the envelope could finish while the blend was still owed. FIXED.

`runWarp` checked `u >= 1` *before* the carry, so an envelope that reached its end inside a
main-thread stall finished there and put the uniform to zero with the whole 180 ms blend
outstanding: **a full crack to nothing in one frame**, arriving through the door marked
"finished". At the production 750 ms duration this needs a stall of ~570 ms, which is
squarely inside what the OA-basis repaint costs on slower hardware — X6 measured 397 ms at
the lab's 3000 ms.

Two changes, and the review asked for both:

1. **The envelope may no longer finish while the blend is unfinished.** `u >= 1` now also
   requires the carry to be spent; until it is, the loop keeps ticking the blend down.
2. **The blend is clocked in ACCUMULATED drawn-frame time**, not differenced from the first
   frame. Differencing fixed a stall *before* the blend and not one *inside* it — a single
   400 ms gap between the second and third drawn frames would have stepped over the rest of
   the window in one go. No single frame may now advance it by more than `CARRY_STEP_MS`
   (33 ms, two frames at 60 Hz), so the blend always has its shape in **at least ~6 drawn
   frames** however badly the machine is behaving. `releaseWarp` — the same ease, serving the
   same purpose on the no-next-gesture path — got the same treatment.

**And a hand-off can still never take a cracked basis.** Letting the blend outlive the
envelope breaks the sentence every finalise rests on ("the uniform is back at exactly zero and
has had a committed frame there"), which was previously guaranteed by arithmetic: the
envelope's span and the finalise timer were both `MORPH_DUR`. So the timer now asks instead of
assuming, through `whenHealed(tok, cb)` — used by both the warp finalise and the shatter's.
It waits **on a timer, not on rAF**, because it has to complete in a background tab where rAF
does not run at all, and it gives up after `RELEASE_MS + 120` and closes the crack by hand
(logging `healwait`) rather than leaving a morph stuck for the life of the tab.

### X8, and it is the one arm here whose falsifiability is measured

The stall is **staged, not waited for**: the morph is cut to 400 ms and the main thread is
blocked for 600 ms *from a timer*, which fires after `apply()`'s own microtasks — so the block
lands exactly where the OA repaint lands it in the wild, between `runWarp`'s `t0` and its first
executed frame. Nothing is mocked; the only addition is the stall.

`?carry=wall` restores **both** halves of what the fix changed — the clock and the ordering —
so the same leg runs twice on the same page and the defect is asserted **present** in one and
absent in the other:

| leg | staged stall | steepest one-frame fall | endpoint |
| --- | --- | --- | --- |
| fixed | 635 ms with nothing drawn | **0.00714** of a 0.08 crack (limit 0.030) | 0.0000/255 |
| `?carry=wall` control | 632 ms | **0.08000** — the whole crack, in one frame (floor 0.030) | 0.0000/255 |

Both endpoints are **0.0000/255 against the borough map**, which is the entire point: no
endpoint assertion in this file could ever have found this. The control also answers the
standing concern that W5/W6-class gates "have never been seen to fail" — this one fails on
demand, on every run.

The fixed leg's log shows the mechanism end to end: `gesture+2, healed+820, finalise+833`
against the control's `gesture+1, healed+631, finalise+640`. The fix spends ~180 ms more
finishing the blend and the hand-off waits for it; no `healwait` appears, so the bounded
fallback never fired.

## Important 2 — the retarget freeze. MEASURED, AND THE LINE IS STOPPED.

The port condition was the ~250 + 400 ms freeze with a crack open when a mid-gesture retarget
lands on the OA basis. The brief's hypothesis was that the block is `paintFrom`'s 26,369-value
expansion plus the attribute upload, and the mitigations offered were (a) cache the expanded
arrays and (c) schedule the heavy paint a frame behind. **Both are ruled out by measurement,
and the hypothesis is wrong about where the time goes.**

Timed on the page, OA basis, 26,435 rings / 350,538 vertices, three runs — each phase from the
`redraw()` that issues it to the committed frame that carries it:

| phase | our JS (`paintFrom`) | the commit |
| --- | --- | --- |
| seed (snapped + ghosted, all 350k vertices) | 3.6 – 8.3 ms | **146 – 164 ms** |
| reveal (visibility flip only) | 0 ms | 7 – 9 ms |
| animate (second full repaint, with a transition) | 3.8 – 5.4 ms | **141 – 159 ms** |
| **the ceiling on caching**: phase bumped, *buffers reused byte for byte, no expansion at all* | 0 – 0.1 ms | **125 – 132 ms** |

**The expansion is not the freeze.** It is 4–5 ms of a ~150 ms commit. And the last row is the
decisive one: handing the layer buffers it already holds, with nothing expanded and nothing
recomputed, still costs **125–132 ms per commit**. So mitigation (a) — caching the expanded
colour/elevation arrays keyed on (measure, parent, year) — has a hard ceiling of roughly
**15 % of one commit**, would add a keyed cache and its invalidation to `paintFrom`, and would
leave a ~260 ms freeze where there is now a ~300 ms one. That is not the ~150 ms bar, and it is
not close to it.

Mitigation (c) cannot work either, and for a more basic reason: **there are no frames to hide
the stall in.** The cost is inside the browser's frame production, so nothing animates during
it — an eased crack-close scheduled "a frame behind" simply does not get its frames. The only
variant that changes what the reader sees is to close the crack *fully before* issuing the
paint, which costs +180 ms of latency on every such retarget and leaves the freeze exactly as
long. That is a distortion of the machinery for no reduction in the freeze.

**Where the time actually goes**, on this evidence: deck.gl re-reading and re-uploading the
whole binary attribute set because the `data` object identity changed. The 125–132 ms floor
with identical buffers says the trigger is the object, not the values. The lever, if anyone
wants one, is therefore **not** caching our expansion — it is avoiding the new `data` object on
a repaint (partial attribute updates, or driving the change through `updateTriggers` alone),
which is a change to V1's core paint contract that every assertion in this file rests on. That
is a sprint, not a fix round, and it is out of scope here by instruction.

**So: stopped, reported, and the owner-sign-off route is the one this leaves open.** The freeze
is inherited V1 behaviour — the same two commits happen on every non-nested morph in the
shipped build — and what the warp changes is that it is now *legible*, because a frozen crack
is more obviously frozen than a frozen map. X6's tape prints the gap on every run.

## Minors

* **Provenance.** §5 and Fix round 1 now each carry a one-line note that their figures are the
  run committed at that stage, and that `captures/v3/RESULTS.txt` always holds the latest.
* **`WARP.beat` is cleared in both `handBack()`s**, so an idle page never reports a beat it is
  not running. Previous rounds' concern 3, now closed; the driver's idle read-backs show `""`.
* **X6's freeze-window gate is robust to faster machines.** It was "at least one frame was
  observed with the old basis frozen", which a machine that draws no frame inside the warm
  window would fail for the right reason and the wrong outcome. It is now
  *observed-or-provably-unnecessary*: **every** frame in which the old basis was still the
  picture must have had it frozen, vacuously true when there are none — and when there are
  none, nothing could have popped. This run drew 1 of 1.
* **`?warpmode` promotion legality is validated at parse.** Demotion to `none` is always legal
  and promotion to `oa` needs only the basis every tier can be drawn on, but `finer` asserts
  that one tier nests inside the other and only the table knows which do. Promoting a
  non-nesting pair is now refused at the query string with a named page error, instead of being
  accepted and dying inside `ensureXwalk` on the first click.

## Concerns

1. **The retarget freeze is unfixed and is now quantified** — see Important 2. It is a port
   condition, not a lab defect, and the numbers above are what a decision should be taken on.
2. **`whenHealed`'s bounded give-up can still snap a crack**, by design, after
   `RELEASE_MS + 120` of a crack that will not close — which in practice means a backgrounded
   tab. It logs `healwait` when it fires. It did not fire in any leg of this run, so that path
   is reasoned about rather than measured.
3. **The blend can now extend a gesture by up to ~180 ms** past `MORPH_DUR` when a stall has
   eaten its window. X8 measures it at 180 ms and the hand-off waits correctly, but it does
   mean the gesture's total length is no longer exactly `MORPH_DUR + 60` on that path.
4. **`?carry=wall` is a second lab flag that reaches production behaviour**, alongside
   `?warpmode=`. Both are validated and neither is reader-facing, but both should be
   considered at port time.
