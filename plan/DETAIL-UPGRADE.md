# Northvale — Detail Upgrade Plan

**Goal:** far more detail — cities with real street plans and buildings, villages
with houses and farmyards, working rural infrastructure.

**Status:** **Complete.** Phases A, B and C — street plans, buildings, works,
vegetation at real density and real scale, and the worked landscape between the
last house and the wilderness. See §11–§13 for the progress logs, and
**[RESUME.md](RESUME.md)** for what was deliberately left undone.
**Written against:** the current build — 18,500 lines, 54 TS modules, ~11 s
generation, 5,500 named features.

---

## 0. Locked scope

| Decision | Chosen | Consequence |
| --- | --- | --- |
| **Zoom depth** | Aerial — 1–5 km up | Cities read as real plans. No door handles, no street furniture, no walkable camera. Buildings need correct massing, roof form and colour; at 1 km altitude a 10 m building is ~16 px. |
| **World extent** | Unchanged at 4,096 km | No simulation-grid growth, no generation-time cost, no new risk. All effort goes into density. |
| **Hardware target** | Desktop with a discrete GPU | Generous budgets. Lower quality presets still exist and still scale, but defaults are tuned for a real GPU. |
| **Scope** | Phases A → B → C | **5 sessions.** Cities, vegetation, rural landscape. No architectural risk; each phase ships independently. |

Terrain streaming (was Phase D), a larger world (was Phase E) and the deeper
performance work (was Phase F) are **deferred** — kept in §6 as documented
follow-ons with their reasoning intact, so the decision is revisitable rather than
lost.

---

## 1. Where we are now

| | Current |
| --- | --- |
| World extent | 4,096 × 4,096 km |
| Simulation grid | 1,024² — **4 km per cell** |
| Render heightfield | 2,048² — **2 km per texel**, plus procedural detail in-shader |
| Named features | ~5,500 |
| Settlements | ~1,600 — radial ring layout, 3 box prototypes |
| Buildings on screen | ~600–1,300 |
| Vegetation instances | up to 60,000 |
| GPU grid memory | 33 MB |
| Draw calls | ~15 |
| Generation | ~11 s, single pass, all upfront |

The world is broad but **thin**. Above regional zoom it reads well; below about
20 km it is a good relief map with props on it, not a place.

Three specific gaps, and the chosen scope addresses all three:

1. **Cities are a ring pattern, not a plan.** No streets, blocks, plots or
   districts. Three prototypes explain the entire built world. → **Phase A**
2. **Vegetation is sparse and uniform.** One prototype per biome, 60k ceiling, no
   forest structure. → **Phase B**
3. **Nothing exists between "settlement" and "wilderness".** No fields, hedges,
   farmyards, mill races, spoil heaps, orchards, quays. → **Phase C**

---

## 2. The constraint that shapes everything

Storing a global heightfield across 4,096 km, by resolution:

| Resolution | Texels across | Total | Storage (R16F) |
| --- | --- | --- | --- |
| 2 km *(current)* | 2,048 | 4 M | **16 MB** |
| 100 m | 40,960 | 1.7 G | 3 GB |
| 30 m *(SRTM-class)* | 136,533 | 18.6 G | 35 GB |
| 1 m *(Google Earth)* | 4,096,000 | 16,777 G | **31 TB** |

**Google Earth ships 31 TB from a data centre. We have ~1 GB in a browser tab.**
Global high resolution is not available at any world size, and no amount of
optimisation closes a four-orders-of-magnitude gap.

Everything detailed must therefore be **generated near the camera and discarded**,
derived from a deterministic seed so it returns identical. The existing
`util/rng.ts` already works this way, and Phases A–C follow the same rule:
settlement plans and scatter are functions of position and seed, cached by
proximity, evicted by distance.

At the chosen aerial zoom this is comfortable. The 2 km heightfield plus in-shader
procedural detail already holds up well at 1–5 km altitude — the current coastal
screenshot at 14 km is evidence. What is missing at that altitude is not terrain
resolution, it is **things on the terrain**, which is exactly what A–C add.

---

## 3. Phase A — Cities that are actually cities

**2.5 sessions.** The single largest visual gain available. Independent of any
terrain work: buildings sit on the heightfield we already have.

### What it replaces

`Settlements3D.ts` currently lays concentric rings of boxes with a wall around
them. It goes; a real settlement generator takes its place.

### What gets built

- **Street network.** Incoming highways route *through* the town instead of
  stopping at its edge. A primary network connects the gates; secondary streets
  subdivide by recursive splitting biased along the contours; lanes fill the
  blocks. Streets follow terrain and bend around water.
- **Blocks → plots.** Each enclosed block is subdivided into parcels by recursive
  oriented-bounding-box splitting with a minimum frontage. Corner plots, back
  plots, yards.
- **Districts**, assigned from distance to centre, river frontage, wall proximity
  and road access: civic core, market, artisan quarter, residential, docks,
  warehouses, garrison, temple precinct, and shanty growth outside the wall.
- **Parametric buildings.** Footprint inset from the parcel; height and storeys by
  district; roof form, pitch, gable direction, courtyards and arcades by culture.
  Roughly 20 forms with per-culture materials, replacing 3 prototypes.
- **Walls that mean something.** The curtain follows terrain, has gates where roads
  cross it, towers at intervals, and a ditch on the field side.
- **Harbours.** Quays, breakwaters, jetties, slipways, moored hulls, waterfront
  warehouses.
- **Bridges as geometry** — piers, arches, roadway — instead of a flat ribbon.

### How it renders

Merged per-block meshes with three LODs: full geometry → simplified boxes → a
single tinted footprint patch. One draw call per block-LOD group. Layouts are
cached per settlement and evicted by distance, exactly as the current code caches
layouts today.

### Session breakdown

| | Work | Verified by |
| --- | --- | --- |
| **A1** ✅ | Street network, blocks, parcels, district assignment. Rendered as flat coloured plots. | The *plan* reads correctly from above before a single building exists — cheapest possible place to catch a bad street network |
| **A2** ✅ | Parametric building generator, per-culture materials, merged mesh builder, 5-level LOD | Close-range city shots; draw-call and frame-time budget |
| **A3** ✅ | Walls, gates, towers on terrain; harbours; bridge geometry; visual pass | Full shot set incl. a walled city, a port, a river crossing |

### Budget (desktop GPU)

~40,000 buildings visible; ~80 MB resident city geometry; < 120 draw calls.

| | |
| --- | --- |
| New code | `src/world/gen/city/` — streets, blocks, parcels, districts, buildings (~2,000 lines) |
| | `src/render/features/CityMeshes.ts` — merged mesh builder, LOD, cache (~700 lines) |
| Touches | `Settlements3D.ts` *(replaced)*, `features.ts`, `types.ts`, `config.ts` |
| Risk | **Medium-high** — street networks look wrong in a dozen subtle ways before they look right. Budget 2–3 visual passes. A1 exists specifically to front-load that discovery. |

---

## 4. Phase B — Vegetation at real density ✅

**Shipped.** See §12 for what was built and what was not.

- **Impostor LOD chain**: mesh → cross-billboard → terrain shader term. Only the
  nearest few thousand trees are real geometry.
- **Raise the ceiling** from 60,000 to **400,000** instances (desktop GPU target).
- **Species mixes** per biome instead of one prototype — a boreal forest is spruce
  *and* birch *and* dead standing timber.
- **Forest structure**: edges thicken, clearings, riverside gallery forest,
  hedgerows on field boundaries, orchard and vineyard rows, windbreaks.
- **Ground cover** at close range: grass tufts, rocks, scrub, snow drifts.

| | |
| --- | --- |
| New code | `src/render/features/Impostors.ts` (~500 lines), species tables |
| Touches | `Vegetation.ts` *(substantial rework)*, `biomes.ts` |
| Risk | **Low-medium** — impostor popping and the mesh→billboard transition need care and hysteresis. |

---

## 5. Phase C — The rural landscape ✅

**Shipped.** See §13 for what was built and what was not.

- **Field systems.** Parcels around every settlement, shaped by slope and drainage,
  bounded by hedges, dry-stone walls or ditches depending on culture and biome.
  Crop colour varies per parcel.
- **Farmsteads**: house, barn, yard, midden, track out to the road.
- **Works with their actual workings**: mills with a leat, pond and wheel; mines
  with adits, spoil heaps and a tramway to the road; quarries cut in benches;
  saltworks with pans; lime kilns; charcoal platforms.
- **Roads gain construction**: embankments, cuttings, ditches, milestones, passing
  places, fords with approach ramps.

Note: without the deferred terrain-tile system, road cuttings and quarry benches
are **geometry laid on the terrain** rather than cut into it. At 1–5 km altitude
that is indistinguishable; it only matters if the camera later goes lower.

### Session breakdown

| | Work |
| --- | --- |
| **C1** | Field parcels, boundaries, farmsteads |
| **C2** *(half)* | Mills, mines, quarries and their works; road embankments and cuttings |

| | |
| --- | --- |
| New code | `src/world/gen/rural/` — fields, farms, works (~1,200 lines) |
| Touches | `landmarks.ts`, `CityMeshes.ts`, `geometry.ts` |
| Risk | **Medium** — field tessellation on sloped terrain is fiddly. |

---

## 6. Deferred, with reasoning kept

Not in the current scope. Documented so the decision stays revisitable.

### Streaming terrain detail

A sparse tile cache (16 m and 4 m tiers — the 1 m tier is unnecessary for aerial
viewing), generated by a worker pool, sampled by the terrain shader from an atlas.
Would add real close-range landforms — gullies, scree, terraces, riverbanks — and
allow terrain *modification*: roads cutting and filling, cities terracing their
sites, quarries carving benches.

**~2 sessions, high risk** (LOD seams, cache thrash, worker throughput). Worth
doing only if the camera later needs to go below ~1 km.

### A larger world

- **8,192 km** — 4× area. Simulation grid to 2,048² (4.2 M cells); generation ~11 s
  → ~45 s; grid memory 33 → 132 MB. ~1 session.
- **16,384 km** — 16× area, requires two-level simulation (coarse global pass, local
  refinement on demand). ~2.5 sessions, high risk: global flow routing does not
  chunk cleanly.

Deferred because 4,096 km is already Lisbon-to-the-Urals and virtually all of the
"this is huge" feeling comes from density, not extent.

### Deeper performance work

GPU occlusion culling, a formal memory-budget manager, WebGPU evaluation (compute
shaders would make per-tile erosion and instance culling far cheaper). Partly
folded into A–C as budget discipline rather than a separate phase; the existing
automatic quality governor already scales presets.

---

## 7. Effort summary

A **session** is a long continuous working block of the kind that produced the
current build — roughly 4,000–8,000 lines including verification.

| Phase | Sessions | Human-equivalent (skilled solo dev) |
| --- | --- | --- |
| A — Cities | 2.5 | 3–4 weeks |
| B — Vegetation | 1.0 | 1–2 weeks |
| C — Rural landscape | 1.5 | 2 weeks |
| **Committed total** | **5.0** | **~6–8 weeks** |
| *(deferred)* Terrain streaming | *2.0* | *3 weeks* |
| *(deferred)* Larger world | *1.0 – 2.5* | *1.5 – 4 weeks* |

**Fallback if 5 sessions is too much:** a cut-down Phase A (streets, blocks, plots,
varied buildings — no districts or harbours) plus the Phase B impostor work is
**1.5 sessions** and delivers roughly 60% of the visible gain.

---

## 8. Budgets (desktop GPU target)

| Resource | Ceiling | Why |
| --- | --- | --- |
| GPU memory | 900 MB | Comfortable on a discrete card; presets scale it down |
| JS heap | 700 MB | Browsers get unstable past ~1 GB |
| Initial generation | ≤ 20 s | Currently 11 s; city plans are generated lazily, not upfront |
| Frame time | 16 ms desktop | Existing quality governor extends to the new budgets |
| Draw calls | < 400 | Currently ~15; merged block meshes keep this in hand |
| Buildings visible | ~40,000 | |
| Vegetation instances | ~400,000 | |

---

## 9. Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| City streets look procedural | **High** | Iterative — expect 2–3 visual passes. A1 renders the plan flat, before any buildings, so a bad network is caught at the cheapest possible point |
| Frame time collapses with 40k buildings | Medium | Block-level LOD and merging; frame-time regression tracking added to the shot set |
| Field tessellation breaks on steep slopes | Medium | Reject parcels above a gradient threshold; terraces only where the culture builds them |
| Impostor popping | Medium | Hysteresis on LOD transitions; cross-fade |
| Generation time creeps past 20 s | Low | City and field layouts are lazy and cached, not part of the upfront pass |
| **Existing 4 km grid becomes visible** | Medium | Rivers, coastlines, lake shores and borders are traced at 4 km. They are fine today; adding dense detail around them will make them read as chunky by comparison. Mitigate by smoothing those polylines further in Phase C; a real fix needs the deferred terrain work |

---

## 10. Acceptance criteria

Each phase is done when it passes both the existing harnesses and its own checks.

**Phase A**
- A city's street network is connected, reaches every gate, and carries the
  incoming highways through
- No building overlaps a street or another building
- Districts are visibly distinguishable from 2 km up
- Walls follow terrain with no floating or buried segments
- < 120 draw calls and ≥ 60 fps at 2 km over the largest city
- `npm run smoke` and `npm run visual` pass with zero console errors

**Phase B**
- ≥ 250,000 instances sustained at 60 fps
- No visible pop at the mesh→impostor transition under normal camera motion
- Forest edges, clearings and hedgerows visible from 3 km

**Phase C**
- Every settlement above village size has a coherent field system
- Mills sit on real watercourses; mines sit on real ore-bearing ground
- No field parcel on ground steeper than its culture would farm

---

## Appendix — files that change

| Area | Files |
| --- | --- |
| New: city generation | `src/world/gen/city/{streets,blocks,parcels,districts,buildings}.ts` |
| New: rural generation | `src/world/gen/rural/{fields,farms,works}.ts` |
| New: rendering | `src/render/features/{CityMeshes,Impostors,Props}.ts` |
| Heavily reworked | `Settlements3D.ts`, `Vegetation.ts` |
| Extended | `config.ts` (budgets, tiers), `types.ts`, `landmarks.ts`, `features.ts`, `geometry.ts` |
| Testing | `scripts/visual.ts` (close-range city, village and field shots), new `scripts/perf.ts` |


---

## 11. Progress log

### A1 — street network, blocks, parcels, districts ✅

**Shipped.** ~1,900 lines across seven new modules.

| File | What it does |
| --- | --- |
| `world/gen/city/geometry2d.ts` | Convex polygon algebra: split, inset, clip-to-convex, edge tagging |
| `world/gen/city/types.ts` | Plan model, district rules, density and radius tables |
| `world/gen/city/streets.ts` | Radial and grid street networks, boundary, gates |
| `world/gen/city/blocks.ts` | Superblocks into blocks, grain coarsening outward |
| `world/gen/city/districts.ts` | District assignment, built-fraction falloff |
| `world/gen/city/parcels.ts` | Burgage-plot subdivision, lazy per block |
| `world/gen/city/plan.ts` | Assembly, wall, singular landmarks, street trimming |
| `render/features/CityPlans.ts` | Merged draped geometry, block/parcel LOD, plan cache |

Also: `Feature.approaches` carries road bearings from the generator, so highways
route *through* towns; the terrain shader levels ground under developed land; and
vegetation is suppressed on built ground.

**Measured on the default seed:** the largest city plans into ~3,400 blocks and
~34,000 parcels within the parcel radius, in one draw call. Grid cities ~4,400
blocks. Towns ~640, villages ~570. Zero console errors across the full shot set.

**Verification:** `npx tsx scripts/visual.ts --plans` renders eight plan-specific
views (radial capital at three zooms, a Valen grid city, a Sahvari desert city, a
town, a village, a port).

#### Bugs found — all of them invisible without the flat-plan render

1. **Plots buried by terrain.** Plot polygons sampled the *base* heightfield on the
   CPU while the terrain shader displaced the surface by procedural detail the CPU
   could not reproduce — the hash is chaotic enough that a JavaScript port would
   not agree bit for bit. Fixed by computing the height in the plan's own vertex
   shader with the same function. **This constraint will apply to every later
   layer that must sit on the ground.**
2. **`insetConvex` kept the wrong half** of each edge clip, so every block inset
   to a sliver and *no parcels were ever produced*. Silent: it read as "these
   blocks are too small for plots".
3. **Grid slicing peeled from the wrong end**, so the first cut kept everything
   and no later line intersected the remainder. Grid cities came out with nine
   blocks instead of four thousand.
4. **Grid streets were drawn at full length**, paving the surrounding countryside
   with streets belonging to no settlement. Fixed with line-to-convex clipping.
5. **Streets ran across water** inside the convex boundary. Fixed by trimming
   centrelines against buildable ground.
6. **A third of every city centre was a temple** — the district roll was
   probabilistic per block. Singular landmarks are now placed explicitly.
7. **Uniform density to the city edge**, reading as wallpaper. Block size now
   coarsens outward and built fraction falls off.
8. **Forest growing down the middle of the market square.** Linear suppression at
   0.985 still left one tree in nine; a square law was needed.

#### Carried into A2

- The wall is a flat ribbon; real geometry with gates and towers is A3.
- `Settlements3D` still exists and is suppressed while plans are drawing. A2
  replaces it outright.
- Frame rate is unverified on real hardware — the harness runs software WebGL.
  Draw calls are 1 for the whole plan layer, well inside budget.

### A2 — buildings ✅

**Shipped.** Every plot in view carries a building extruded from the plot itself:
walls, a roof of the culture's form, and towers and spires where the district
warrants them. `CityPlans.ts` and `Settlements3D.ts` are gone, replaced by
`render/features/CityMeshes.ts`.

| File | What it does |
| --- | --- |
| `world/gen/city/buildings.ts` | Fits a building to a plot: footprint, height, ridge, roof, colour. Also the closed-form block massing |
| `world/gen/city/geometry3d.ts` | Extrusion: walls, one roof routine for all four forms, towers, block prisms |
| `render/features/CityMeshes.ts` | Five per-block detail tiers, merged into two draw calls, cached and budgeted |
| `world/gen/city/geometry2d.ts` | Gained `clipToConvex` |

**Detail tiers**, chosen per block from its distance to the camera focus:

| Tier | Geometry | Radius at 4 km altitude |
| --- | --- | --- |
| 0 | Buildings with roofs, towers, spires | 2.0 km |
| 1 | The same footprints capped at mid-roof height | 3.0 km |
| 2 | One prism per block at the estimated mean roof height | 12.8 km |
| 3 | Flat parcel mosaic | 20 km |
| 4 | One flat polygon per block | to the fade |

**Measured on the default seed:** the largest capital renders 32,700 buildings
from 3,300 blocks; the largest grid city 36,600 from 4,400. Two draw calls for the
whole layer. Warm rebuild 3–380 ms under software WebGL with the CPU also
rasterising — the same work on a discrete GPU is a fraction of that, since none of
it is GPU-bound.

#### Bugs found

1. **Buildings read as thin walls.** They filled their entire burgage plots, and a
   plot is four times as long as it is wide. The house now takes the street end
   and the rest stays yard, in the proportion the district's `openness` sets.
2. **Then they read as wedges.** Slicing the street end off a plot inherits the
   plot's shape, and plots are frequently triangles because the blocks they come
   from are. Buildings are now rectangles fitted to the frontage and clipped back
   into the plot.
3. **Then they read as fencing.** Taking a fixed fraction of the plot's *depth*
   gives a wide shallow plot a building three metres front to back. Sizing is now
   by area, with an aspect the shape can actually be.
4. **Roofs three times the height of their walls.** The rise was taken from
   `sqrt(area)` rather than the span across the ridge, so a long narrow house got
   the roof of a square one. A street of them read as a row of tents.
5. **A village with 2,149 buildings for 2,624 people.** The district tables are
   written for a city, where land inside the wall is expensive. `Block.plotScale`
   now carries the settlement tier down to the subdivider.
6. **Trees 130 m tall beside 9 m buildings.** Vegetation scale had never had
   anything true-scale next to it to be wrong against.
7. **Roofs read as one flat brown mat.** Three roofing materials per architecture:
   a quarter roofed in one colour reads as a printed texture from the air.
8. **The convex boundary polygon was visible** as a hard nine-sided rim where the
   developed ground stopped. Outer blocks now paint short of their extent, and
   some of them not at all.
9. **The whole city was one shade of brown.** Ground colour now varies per block
   and mixes toward garden green in proportion to plot size — which is most of the
   visual difference between a village and a city quarter.
10. **A 1,079 ms freeze on first approach.** Three separate costs, all unbudgeted
    and each found only after the one in front of it was fixed:
    - City layout, at ~0.5 s for a capital, ran for every city entering range in
      the same frame. Now one plan per rebuild, nearest first.
    - Plot subdivision and building generation ran for every newly visible block.
      Now bounded by a 16 ms wall-clock slice per rebuild, with the remainder
      drawn a tier coarser until a later frame affords it. A time slice rather
      than a block count, because a cathedral close and a shanty block differ by
      two orders of magnitude, and because it scales itself to the machine.
    - Ground surfacing was re-emitted from scratch every rebuild — thousands of
      `Array.push` calls per city per frame. Now baked to typed arrays per block
      and per city and merged by `memcpy`, like the solid tiers already were.
    - The plan cache held 48 entries and evicted in insertion order while up to 48
      cities could be drawn, so a city still on screen was sometimes discarded and
      re-laid-out on the next frame. Eviction is now distance-aware.
11. **The block-massing tier cost as much to generate as full buildings**, because
    it averaged the buildings it was replacing. The average has a closed form:
    the storey range is fixed by the district, the storey height by the culture,
    and the jitter is symmetric, so it cancels.
12. **Both budgets were spent in block-list order.** Blocks were visited in the
    order the plan happened to hold them, so when the vertex budget or the
    generation slice ran out, whichever blocks came first got the detail — thin
    patches in the middle of the frame, dense ones at its edge, according to
    nothing the viewer could see. Visible blocks are now collected and sorted by
    distance to the focus before any tier is decided, which also makes a city fill
    in outward from what the camera is looking at.
13. **Over budget, a block fell straight past both solid tiers to flat plots** —
    the one fallback that stops reading as built. It now steps down one tier at a
    time.
14. **`QualitySettings.cityBudget` had been dead** since `Settlements3D` was
    removed: it counted settlements, and detail is chosen per block now.
    Repurposed as `cityVertexBudget`, 260k on low through 2.6M on ultra, and
    actually wired to the layer.

#### Harness

`stats().citiesSettled` reports whether the last rebuild deferred any work, and
`scripts/visual.ts` waits on it before each screenshot. Every plan shot before
this was of a half-built city, which is why several of these bugs survived a
verification pass.

#### Carried into A3

- The curtain wall is still a flat ribbon. Real geometry with gates and towers,
  harbour works, and bridge decks are A3.
- Roofs are flat-shaded per face. No dormers, chimneys or courtyard voids —
  `ArchStyle.courtyard` is declared and not yet used.
- Under software WebGL a filled city takes the terrain quadtree's frame budget
  with it, dropping to a handful of chunks. That is the adaptive quality system
  working as designed on a renderer 50× slower than the target, but it means the
  harness cannot judge terrain LOD and city detail in the same shot.

### A3 — walls, harbours, bridges ✅

**Shipped.** The works: everything a settlement builds that is not a house.

| File | What it does |
| --- | --- |
| `world/gen/city/walls.ts` | The curtain as buildable pieces: panels, towers, gatehouses, ditch, mural lane |
| `world/gen/city/harbour.ts` | The waterfront, marched along the real shoreline: quay, jetties, breakwater, moored hulls |
| `world/gen/city/geometry3d.ts` | Gained `emitFortification`, `emitHarbour`, `emitBridge` |
| `render/features/CityMeshes.ts` | A third mesh for the works, with the ground clamped at sea level |
| `scripts/measure.ts` | Prints what the generator builds, in metres |

**The wall is panels, not a ribbon.** Each panel is built level along its own
stretch of ground and carries its own anchor, so a curtain crossing a hill *steps*
the way masonry does rather than shearing. Towers stand at the angles of the ring —
a straight run of wall cannot be defended from itself — with intermediates on any
stretch over 110 m and a pair flanking every gate, pushed out along the wall's
normal so they can shoot along its foot. A capital's is 12.5 m high, 5.3 m thick,
282 panels and 102 towers.

**The harbour is found, not assumed.** Rays from the town centre locate the water;
the quay then *marches* along the shoreline from the town's own frontage, correcting
back onto the waterline at every step. Jetties stand square to their own piece of
shore and run out until they are over open water; hulls lie alongside them.

#### Bugs found

1. **The rotation convention was wrong for every piece.** `rectanglePolygon` and
   `regularPolygon` build directly in world XZ, but the angle passed to them was
   negated — the convention a Three.js Y rotation needs. Every wall panel came out
   lying *across* its own line, so the curtain was a row of bars with gaps between
   them. This is the third time this session that handedness has cost real time.
2. **A quay four kilometres from its town.** The waterfront was a fan of rays from
   the centre, so a town on a headland strung its quay along whatever coast each
   ray happened to hit, including the far side of its own bay. Replaced with the
   shoreline march.
3. **The harbour was under water.** Everything here is drawn by the building
   shader, which computes its own ground height from the terrain texture *plus*
   procedural detail the CPU cannot reproduce, then multiplies by the relief
   exaggeration — so a shore the generator measured at +3 m arrives at −13 m. The
   works now have their own mesh whose ground is clamped at sea level. A wall on a
   hill is unaffected; a quay is the difference between standing on the shore and
   lying on the seabed.
4. **The curtain ran out into the sea.** Pulling the ring's *vertices* onto land
   was not enough — a straight chord between two dry vertices still crosses a bay.
   Panels, towers and gates are now tested individually and simply not built where
   they stand in water, which is also what real walls do.
5. **Bridges were up to four kilometres from their rivers.** Their position came
   from the road A\* grid, which is 512 cells across the world — eight kilometres a
   cell. Fine for "a road crosses a river around here", useless for laying a deck.
   Bridges now snap to the nearest point on an actual river channel and take their
   bearing square across it, which is both more accurate than the road bearing and
   simpler than carrying one; elevation and the "On the Such-and-such" fact are
   corrected to match. Two follow-on mistakes, each hidden by the one before it:
   - The snap was written inside `assembleFeatures`, which is handed
     `riverPolylines: []` — the real ones need the render heightfield and are
     attached afterwards. It had nothing to snap to and silently did nothing to
     all 110 bridges. It now runs in `generate.ts`, beside the attachment it
     depends on.
   - It then snapped only to *named* rivers. Ninety-six rivers in this world carry
     a feature of their own; the network that is drawn has hundreds of channels,
     and most road crossings are of an unnamed one. 104 of 110 still had nothing
     to snap to. Against every channel, 102 of 110 land on water; the remaining 8
     cross something below the ribbon threshold and draw no deck.
6. **The mural lane read as the wall.** The strip inside the curtain was drawn in
   the old wall ribbon's dark colour and twenty-two metres wide, so it out-drew the
   masonry it was meant to sit behind.
7. **Piers stood on the bank.** A bridge pier ran from the abutment's ground level
   up to the deck, leaving it hanging above the river rather than in it.
8. **Every flat lid in the module was wound backwards, and so invisible.** A
   polygon wound counter-clockwise in the XZ plane projects *clockwise* when it is
   looked at from above — the only direction a lid is ever seen from — so with
   front-face culling the whole top surface is a back face. Found on the bridge,
   which is almost nothing *but* lid: the deck vanished and left a row of piers
   with a one-pixel edge between them. It had been quietly removing the roof of
   every flat-roofed building, the top of every block in the massing tier and the
   coping of every wall and tower for as long as those had existed — none of which
   was visible as an absence, because a building with no roof still reads as a
   building from above. All four fans now go through one `capPoly`, so there is one
   place to get the winding wrong instead of four.

#### Verification

Screenshots could not settle most of this, and one of the corrections above was
made twice before the measurement caught that it had never taken effect at all. A wall four times too tall and a wall
correctly proportioned look much the same from a kilometre up, next to buildings
you have no independent scale for; and the application drops its quality preset
when frames run long, which under software WebGL means *always*, so every shot was
taken with four-kilometre terrain vertices — enough to lose the coastline a port
stands on and put dry land under water. Two changes came out of that:

- **`scripts/measure.ts`** prints the numbers: wall heights and thicknesses, tower
  and gate counts, quay length, how far the works are from the town centre, and how
  many pieces stand in water. It is what proved the placement correct while the
  screenshots still looked wrong.
- **The harness pins the quality preset.** Terrain at the port went from 14 chunks
  to 82 the moment it did. It also gained `--only=p3,p5,p10`, because a full pass
  is ten views of a large city under software WebGL and checking one change should
  not cost ten minutes.

#### One product fix that came out of the harness

The city generation slice was a fixed 10 ms per rebuild. That is a fifth of a frame
on a machine drawing at sixty a second, and a *hundredth* of one on a machine taking
a second a frame — so the machine that most needs its cities to finish filling was
the one that never did, and went on paying for the coarse tier indefinitely. The
slice is now a fraction of the frame that just went by, floored and capped. Fast
machines are unaffected; on the software rasteriser the same city filled sixteen
times faster.

#### Carried into Phase B

- Trees are capped at 42 m, which is a large conifer and reads large beside a 9 m
  house. Phase B reworks vegetation entirely and should set the scale from species.
- Roads cross shallow water in the archipelagos: the road A\* navigates on 8 km
  cells and cannot see a strait narrower than that. Not new, and visible now only
  because there is finally something else on the coast to compare it against.
- `ArchStyle.courtyard` is still declared and unused. No dormers or chimneys.

---

## 12. Phase B — vegetation ✅

**Shipped.** Two new modules and a rewritten scatter.

| File | What it does |
| --- | --- |
| `render/features/PlantLibrary.ts` | Eleven prototypes at unit height, each at two detail tiers |
| `render/features/Vegetation.ts` | Rewritten: species mixes, real heights, forest structure, two-tier LOD |
| `world/gen/biomes.ts` | Every biome gained a `mix` of species with real height ranges |
| `core/config.ts` | Instance budgets raised from 9k–110k to 25k–400k |
| `core/App.ts` | `__nv.jumpToBiome`, which finds the *middle* of a biome rather than its edge |

### The one decision everything follows from

**Cover is a matter of how many, not how large.**

The old scatter held its ring at the camera's full view radius and scaled each
instance up to compensate — a tree spaced 150 m from its neighbours drawn 150 m
tall so the canopy would meet. It kept the instance budget and it read as cover,
right up until Phase A put buildings on the ground at true scale and the trees were
revealed as monuments: a 130 m oak beside a 9 m house.

Once instances are at true height, everything else is forced:

- **Spacing is nine metres**, which is where a conifer canopy closes. Not the
  twenty-two the first attempt used, at which the arithmetic works and the forest
  comes out as a field of dots on lit ground. What makes forest read as forest from
  the air is that it shadows itself.
- **The ring is therefore small** — about 2.5 km at the 240,000-instance high
  preset — and the terrain shader's own vegetation term carries everything beyond
  it, dissolved into over most of the ring's width so the handover is not an edge.
- **Spacing loosens above the height where a crown is a pixel wide.** Thinning a
  stand nobody can resolve is free; stopping short of the view is not.

### Structure

Three terms, all multipliers on the cover the classifier already decided:

- **Clearings** from low-frequency value noise. Real forest is stands with gaps
  between them; without this a biome boundary is the only edge anything has.
- **Edges** thicken. A forest edge is denser than its interior because light
  reaches the side of it — four taps at one macro cell out find one.
- **Gallery woodland** follows the water table, hardest where there is least of it.
  The line of green along a watercourse through dry country is one of the most
  recognisable things in any aerial view of anywhere.

### Bugs found

1. **Cover was taken from the climate model alone**, which put a boreal forest on
   the ground at a third of the density the biome classifier had just assigned it.
   The biome is the authority on what a place supports; the climate value modulates
   within it.
2. **The scatter vanished the moment the camera climbed.** The ring is a *ground*
   distance from the focus and the fade is a *view* distance from the eye, and the
   two differ by the whole height of the camera. Fading at the ring radius alone
   discarded every instance as soon as the camera was higher than the ring was
   wide — a forest that disappears when you pull back.
3. **A visible disc of trees** lying on the landscape, where the ring ended and the
   terrain term took over. Fixed by dissolving over 80% of the ring rather than
   38%, and by letting spacing loosen with altitude so the ring reaches the view.
4. **Three renderer crashes**, mid-suite, with nothing but a puppeteer stack trace
   to go on — a crash arrives on `page.on('error')`, not on the console, and kills
   the run before the summary can print. Instance buffers were being sized to fit
   demand, so a continuous zoom disposed and rebuilt GPU buffers every frame for as
   long as the wheel turned. They now double instead: seven reallocations between
   four thousand instances and the whole budget, for an entire session. The harness
   reports crashes the moment they happen and the JS heap after every shot, which
   is what turned an unexplained death into a number that stopped growing.
5. **A wide forest view silently lost half its trees.** Buckets are given back after
   four rebuilds drawing nothing, and `mesh.count` describes the *previous*
   rebuild — so a bucket created a moment ago by the current one reads as empty and
   was evicted mid-fill. It only showed after enough camera movement to bring the
   capacity ceiling into play, which made it look like a load-dependent renderer
   problem rather than a bug.

### Not built, and why

- **Ground cover** — grass tufts, scrub, snow drifts. At the locked zoom floor of
  1.4 km a grass tuft is a hundredth of a pixel. Boulders are in the arid and
  alpine mixes instead, which is the part of that item that can actually be seen.
- **Hedgerows, orchard rows, windbreaks.** All three are boundaries of field
  systems, and field systems are Phase C. Building them now would mean inventing
  the field boundaries twice.

### Carried into Phase C

- Orchard districts inside towns are coloured ground with nothing growing on them,
  because the scatter suppresses planting on developed ground and knows nothing
  about city blocks. Worth wiring up when Phase C gives the two a shared notion of
  cultivated land.

---

## 13. Phase C — the rural landscape ✅

**Shipped.** Two new modules; the layer between the last house and the wilderness.

| File | What it does |
| --- | --- |
| `world/gen/rural/fields.ts` | The field belt: parcels, boundaries, farmsteads |
| `world/gen/rural/works.ts` | What a mine, quarry or mill did to the ground it stands on |
| `world/gen/city/geometry3d.ts` | Gained `emitWorks` |
| `render/features/CityMeshes.ts` | Draws the belt flat, the farmsteads and works solid |
| `core/App.ts` | `__nv.jumpToKind`, which finds a landmark you can actually see |

### Fields

A ring of worked land around every settlement, built as an annulus of sectors and
subdivided by the same recursive halving that cuts city blocks — not a shortcut
but the right shape, since a field is a convex parcel bounded by its neighbours,
cut off the long axis of whatever it came from, exactly like a burgage plot.

What a boundary *is* comes from the ground: hedge where hedges grow, dry-stone
wall where the fields are full of stone and nothing grows tall, bank and ditch in
wet country. It is drawn as the parcel's own outline — the whole parcel in the
boundary colour with the crop laid inside it — so a hedged field is two polygons
rather than a polygon and a ribbon.

Not every parcel in the ring is worked; the share falls with distance, so the belt
does not read as a dartboard drawn round the town. Nothing is ploughed on ground
steeper than about one in three, under water, or on infertile biome.

**Measured on the default seed:** a city of 179,000 works 381 parcels over 7.7 km²
at a mean of 2.0 ha, reaching 2.1 town radii; a village of 1,958 works 161 parcels
over 1.8 km² at 1.1 ha. None in water, none on ground too steep to plough.

### Works

A mine was a label and a dot. What makes one legible from the air is never the
shaft — that is a hole a few metres across — but everything the shaft produced:
the spoil heap, which is bigger than the workings and a colour that grows nowhere;
the benches a quarry was cut in; the pond that is the whole point of a watermill.
So each is described as *the ground it disturbed*, with the building an
afterthought sitting on it. 406 landmarks, 811 patches of disturbed ground.

### Bugs found

1. **A landscape of allotments.** Field parcels came out at 0.3 ha because the
   target area was written as `0.00004` for what was meant to be four hectares —
   a square kilometre is a hundred hectares, so that is forty square metres. The
   subdivision then ran to its depth limit instead of to its target, which hid the
   unit error behind a plausible-looking recursion cap.
2. **A quarry hanging in the air above its own hillside.** The works sample the
   terrain at a point; the terrain *mesh* interpolates between vertices two hundred
   metres apart, and on a steep face it cuts the corner and sits well below the
   sampled height — multiplied by the relief exaggeration, half a kilometre of
   screen offset. Works now sink into the hill by their local gradient, up to a
   dozen metres, which is a real cut rather than a correction. On ground steeper
   than that nothing of this size can be represented at all, and the note in §5
   about laying rather than cutting is where that limit lives.
3. **Two landmark views that looked like rendering faults and were not.** The first
   quarry in the list is perched over deep water with half the view below sea
   level; the most inland one is on a 2,400 m cliff. `jumpToKind` now scores for
   dry, gentle, inhabited ground, because a landmark view that shows no landmark
   costs more to diagnose than it does to write.

### Not built, and why

- **Road embankments, cuttings, ditches, milestones, passing places.** At one to
  five kilometres a road is already drawn at its minimum on-screen width, so an
  embankment under it is a slightly wider road; milestones and passing places are
  sub-pixel. The whole item is the lowest-value part of §5 and the only one whose
  absence is invisible.
- **Tramways from mines to roads, charcoal platforms, saltworks, lime kilns.** The
  three works that were built cover the kinds that actually appear in quantity;
  the rest are a handful of features each.

### Carried forward

- Orchard districts inside towns still grow nothing. The scatter suppresses
  planting on developed ground and knows nothing about city blocks or field
  parcels; the shared notion of cultivated land that would fix it now exists in
  `rural/fields.ts` but is not wired to the vegetation layer.
- The field belt feeds a village but not a city: a settlement of 179,000 works
  7.7 km², which is a fraction of what it eats. That is correct — a city imports,
  and the rest of its supply is other people's villages, which have their own
  belts — but it means the belt scales with the town's *radius* rather than with
  its appetite.
