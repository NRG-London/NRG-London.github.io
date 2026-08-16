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
`RESULTS.txt` that said otherwise. It now quotes the committed run (178–180 fps, 0.0029, value
progress 31.4%) and states the worst-frame spread across runs explicitly rather than quoting one
end of it.

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

## Concerns from this round

1. **W5 and W6 both pass on the first run after the fix, which means neither has been seen to
   fail against the bug it covers.** W5's mechanism was reproduced by hand before the fix (the
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
