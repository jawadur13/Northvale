# Northvale

An interactive 3D atlas of a world that does not exist.

Northvale is a single-page application that generates an entire 4,096 × 4,096 km
world in your browser — its geology, its rivers, its climate, its borders, its
five and a half thousand named places — and then lets you fly around it. It is not
a website with a map on it. The map is the whole thing.

Open it and you are looking at seven continents from four thousand kilometres up.
Zoom in and each step reveals a stratum of the world that was not there before:
oceans and continents, then regions and mountain ranges, then cities and rivers,
then towns and castles and mines, then villages, farms, windmills and the wreck of
the *Pale Fortune* on a reef nobody charted properly.

Fourteen of the things you will find are impossible.

---

## Contents

- [The concept](#the-concept)
- [Running it](#running-it)
- [Controls](#controls)
- [How the world is built](#how-the-world-is-built)
- [How the world is drawn](#how-the-world-is-drawn)
- [World structure and data](#world-structure-and-data)
- [Performance](#performance)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Extending it](#extending-it)

---

## The concept

The design problem is scale. A world large enough to explore for hours is far too
large to author by hand, and a world generated entirely by noise is large but not
worth exploring — it has texture without meaning. Northvale takes a middle path
that runs through the whole codebase:

> **The large structures are authored. Everything else is derived from them by
> simulation.**

Nine continental cores and eighteen orogenic belts are placed by hand in
[`src/world/gen/layout.ts`](src/world/gen/layout.ts). That fixes the shape of the
world: a polar continent, a temperate heartland, a subtropical desert, an
equatorial rainforest, a southern ice shelf, and the oceans between them.

Everything after that is consequence. Rain falls where the winds and the mountains
put it. Rivers form where the water actually flows. Deserts appear behind the
ranges that block the rain. Cities stand where there is a harbour, a ford, a
confluence, a pass or ore in the hills. Borders settle on the watersheds. Roads
climb the valleys. Not one of those is placed by a rule that says "put a city
here"; each is a measurable consequence of the terrain, which is why the map holds
up when you look closely at it.

The result is a world you can interrogate. Ask why a city is where it is and the
answer is in the panel, and the answer is true.

---

## Running it

Requires Node 18+ and a browser with **WebGL 2**.

```bash
npm install
npm run dev          # http://localhost:5173
```

Production build:

```bash
npm run build        # typecheck + bundle into dist/
npm run preview      # serve dist/ on http://localhost:4173
```

The build is fully static. `dist/` can be dropped on any web host; there is no
server component and nothing is fetched at runtime.

### Choosing a world

The default world is seed `0x4e56414c`. Any other seed produces a completely
different world with the same *structure* — the continents stay where they are,
because they are authored, but every coastline, river, region, settlement and name
changes.

```
?seed=12345
?seed=0xdeadbeef
?seed=anything            # text is hashed
```

There is also a seed field under **Settings → World**.

---

## Controls

### Mouse and trackpad

| Action | Control |
| --- | --- |
| Pan | Drag with the left button |
| Orbit and tilt | Drag with the right button, or hold <kbd>Shift</kbd> |
| Zoom | Wheel or trackpad scroll — zooms toward the cursor |
| Select a place | Click it, or click its label |
| Inspect | Hover for a one-line summary |
| Reset the bearing | Click the compass |
| Reset the view | Double-click the compass, or <kbd>Home</kbd> |
| Travel | Click anywhere on the minimap |

### Touch

| Action | Gesture |
| --- | --- |
| Pan | One finger |
| Zoom | Pinch |
| Rotate | Twist with two fingers |
| Tilt | Drag two fingers up or down |
| Select | Tap |

### Keyboard

| Key | Action |
| --- | --- |
| <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> / arrows | Pan |
| <kbd>Q</kbd> <kbd>E</kbd> | Rotate |
| <kbd>R</kbd> <kbd>F</kbd> | Tilt |
| <kbd>+</kbd> <kbd>−</kbd> | Zoom |
| <kbd>/</kbd> | Focus search |
| <kbd>L</kbd> | Labels |
| <kbd>P</kbd> | Political regions |
| <kbd>B</kbd> | Borders |
| <kbd>C</kbd> | Contour lines |
| <kbd>H</kbd> | Hypsometric tint |
| <kbd>G</kbd> | Reference grid |
| <kbd>V</kbd> | Vegetation |
| <kbd>Home</kbd> | Whole world |
| <kbd>Shift</kbd>+<kbd>F</kbd> | Fullscreen |
| <kbd>?</kbd> | Frame diagnostics |
| <kbd>Esc</kbd> | Close the location panel |

---

## How the world is built

Generation runs entirely in a Web Worker
([`src/world/worker.ts`](src/world/worker.ts)), so the loading screen animates at
full frame rate while roughly nine seconds of real computation happens. The
finished world is handed back as transferable typed arrays — about 60 MB moved at
zero copy cost.

The pipeline is in [`src/world/generate.ts`](src/world/generate.ts). Each stage
consumes the previous one, and the order is forced by those dependencies.

### 1. Elevation — `gen/elevation.ts`

Two passes over a 1,024² simulation grid (4 km per cell).

The first builds a *continental potential* field: the authored cores, plus a
domain-warped fractal that turns their ellipses into coastlines. A histogram then
picks the sea-level threshold that yields the target land fraction, so the
land/water balance is exact regardless of seed.

The second composes the actual surface — continental platform, orogenic uplift
along the belts (ridged multifractal, domain-warped so ranges curve and braid),
rolling hills, plateaus with flattened tops, stepped mesa country, dune fields,
coastal ravelling that produces fjords and offshore islets, volcanic island arcs,
shoal platforms that surface as archipelagos, rift valleys, continental shelves
and abyssal plains.

Belt and core influence is evaluated on a coarse 256² grid and bicubically
upsampled; these fields are inherently low-frequency and this keeps the stage under
a second.

### 2. Anomalies — `gen/anomalies.ts`

The fourteen impossible places are stamped into the heightfield **before**
hydrology runs, so the rest of the simulation treats them as real ground. The ring
mountain fills with a real lake because the depression filler finds a real
depression. The shaft through the hollow mountain floods because it reaches below
sea level. Rivers route around the 500 km wall the way they route around any other
obstacle.

That is the entire trick: the anomalies are impossible in *shape*, and the world's
physics accepts them without comment.

### 3. Hydrology — `gen/hydrology.ts`

This is the stage that makes the world believable.

1. **Priority-flood depression filling** (Barnes et al.) produces a surface with no
   interior sinks, seeded from the ocean and the map border. Lakes fall out as a
   by-product — every basin the fill had to raise is a lake, at the level it was
   raised to.
2. **D8 steepest descent** gives every land cell a downstream neighbour.
3. **Flow accumulation** in reverse fill order. The priority flood already pops
   cells in ascending elevation, which is a valid topological order, so the
   accumulation is free.
4. **Channel tracing.** Cells above a discharge threshold become channels; each
   river path runs from a single headwater to a mouth, always taking the largest
   tributary upstream at a confluence. That is how real river systems are named,
   and it is why the trunk river gets the name and its branches get their own.
5. **Valley carving.** Channels are cut back into the elevation, deeper with
   discharge and deeper again on steep, freshly uplifted ground — gorges in the
   mountains, broad floodplains in the lowlands.

Because step 5 changes the terrain, the whole thing runs twice. The dendritic
valley networks visible across every continent are the output of this loop, not a
noise function.

### 4. Climate — `gen/climate.ts`

Temperature is latitude, minus an elevation lapse rate, adjusted for continentality
and ocean-current anomalies.

Moisture is **simulated, not sampled**. Prevailing winds — trade easterlies in the
tropics, westerlies in the mid-latitudes, polar easterlies at the caps — march
across the grid carrying humidity. They evaporate over water and precipitate when
the land rises beneath them, with a continental recycling term so interiors reach
steppe rather than desiccating completely. Two meridional passes add monsoon-facing
coasts.

The consequence is that every desert in Northvale is in the lee of something, and
you can see what.

Biome classification is Whittaker-style, but against an **aridity index**
(precipitation over potential evapotranspiration) rather than raw rainfall — 400 mm
is semi-arid in the tropics and ample in the subarctic, and without the correction
every cold interior classifies as desert instead of the boreal forest it should be.

### 5. Landform analysis — `gen/landforms.ts`

Everything a cartographer would name is *detected* from the finished terrain:
landmasses by connected components, summits as windowed local maxima ranked by
approximate prominence, passes by discrete saddle detection (counting sign
alternations around the 8-ring), plateaus, valleys, cliffs, glaciers, dune fields,
forests, wetlands, badlands, salt flats, capes by local water-surround maxima, and
straits by narrow-passage search.

Nothing here is placed by fiat, which is why the labels agree with what is under
them.

### 6. Regions — `gen/regions.ts`

Regions are not Voronoi cells. They are grown by cheapest-path expansion over a
cost surface built from gradient, elevation, biome traversability and river
crossings. Borders therefore settle on watersheds, mountain crests and major
rivers on their own — where real borders end up.

Seats are allocated per landmass in proportion to area, so every continent is
subdivided rather than the wettest one absorbing the whole budget. Cultures come
from a smaller set of culture cores, so neighbouring regions share a language and
an architecture.

### 7. Settlements — `gen/settlements.ts`

Every land cell is scored as a settlement site. The score is a sum of the reasons a
real settlement exists — fresh water, a crossing point, a sheltered anchorage,
arable ground, a defensible rise, ore in the hills, a gap through a range, a spring
in the desert — and the **dominant term is recorded as the site reason**, which is
then what the settlement's description talks about.

Placement runs largest-first with a minimum separation per tier: capitals, cities,
towns, villages, hamlets. Roughly 1,600 settlements.

### 8. Roads — `gen/roads.ts`

Weighted A\* over a cost surface of gradient (squared, so roads would rather go a
long way round than climb), biome traversability, river crossings and altitude.

Two details make it a network rather than a bundle of independent lines:

- **Route reuse.** Cells already carrying a road are discounted heavily, so later
  routes converge onto earlier ones and trunk roads emerge with junction towns.
- **Importance ordering.** Routes are laid from the most important pair of
  settlements downward, so the lanes bend to meet the highways rather than the
  reverse.

Bridges are recorded wherever a route crosses a river above a discharge threshold,
and become named features.

### 9. Landmarks — `gen/landmarks.ts`

Forty kinds, each declaring a scoring function over the terrain rather than a spawn
probability. A mine scores on ore-bearing uplift with a road to get the ore out. A
lighthouse scores on a headland beside shipping water. A caravanserai scores on a
desert road with groundwater. A monastery scores on remoteness. About 1,900 of
them.

### 10. Naming and prose — `gen/names.ts`, `gen/lore.ts`

Seven cultures, each with its own syllable inventory and name shapes, so Skarn
settlements sound Skarn and Sahvari settlements sound Sahvari. Alongside that, the
atlas's own language builds compound toponyms the way English map names are built —
a qualifier plus a real topographic element: Blackfen, Coldharbour, Ravenscrag,
Thornmere. A registry enforces uniqueness using genuine cartographic
disambiguators (Upper, Nether, Little, New) rather than numbers.

Descriptions are template-driven for variety, but **every sentence has to be true of
the simulation**. A town's description names the river it was actually placed on at
the discharge the flow routing actually computed; a pass quotes the elevation the
saddle detector actually found. Zooming in on a claim tends to confirm it.

---

## How the world is drawn

Three.js on WebGL 2, with hand-written GLSL 3.0 throughout. No post-processing
stack, no shadow maps, no reflection probes — everything is analytic or ray-marched,
which is what keeps a world this size inside a frame budget.

### Terrain

A **screen-space-error quadtree** ([`render/terrain/TerrainSurface.ts`](src/render/terrain/TerrainSurface.ts)).
The root covers the entire world; a node subdivides when its projected size exceeds
a pixel threshold. Every visible node draws the *same* geometry — a unit grid with a
skirt — displaced in the vertex shader by sampling a single 2,048² R32F height
texture, with placement carried on the model matrix.

That means creating or discarding a node costs a matrix update and nothing else. The
LOD reacts instantly to a fast zoom with no pop-in queue, memory is constant however
far in you go, and no two chunks can disagree about elevation because they read one
texture. LOD seams are covered by skirts.

The height texture is 2 km per texel, which is ample for a continent and far too
coarse for a valley — so below that scale the terrain is **procedural**. A pure
function of world position is evaluated identically by the vertex shader (which
displaces by it) and the fragment shader (which differentiates it for the normal).
Being a pure function of position is what matters: chunks at different LOD levels
agree exactly, so there is no seam, and a 4,000 km world holds up at a two-kilometre
viewing distance without another byte of memory.

### Shading

The fragment shader does the heavy lifting
([`render/terrain/terrainShaders.ts`](src/render/terrain/terrainShaders.ts)):

- **Normals** are differenced from the height texture rather than baked, so they
  follow the live vertical exaggeration. The differencing step widens with the
  pixel's footprint, which keeps distant terrain smooth instead of aliasing.
- **Cast shadows** are ray-marched through the height texture toward the sun with a
  geometrically growing stride. Ranges throw real shadows across the plains beside
  them, and they move with the time-of-day control because nothing is precomputed.
- **Relief shading is deliberately steeper than the geometry.** A world 4,000 km
  wide with 5 km of relief is, to scale, almost perfectly smooth — a physically
  correct hillshade of it carries nearly no information. Every printed relief map
  solves this the same way, by shading a steeper surface than it draws. Applying it
  to shading only keeps silhouettes honest while making the modelling legible. It is
  exposed as **Settings → Relief shading**.
- **Colour** comes from a continuous palette that never looks up a biome id. Surface
  colour is composed from temperature, aridity, vegetation cover, gradient,
  elevation and cultivation, layered the way a landscape layers: substrate, then
  what grows on it, then what the weather does to it, then what people did to it.
  That is why there is no visible biome boundary anywhere on the map despite
  thirty-four named biomes.
- **Thematic layers** (hypsometric, biome, political) blend over it by weight, so
  switching layers cross-fades rather than rebuilding.
- **Contours** are drawn analytically from the sampled height with derivative-based
  anti-aliasing, with the interval adapting to zoom so the lines never crowd.

The palette has one source of truth — [`src/world/palette.ts`](src/world/palette.ts)
holds a JavaScript implementation *and* the equivalent GLSL, so the minimap and the
3D view cannot drift apart.

### Water

One shader, three surfaces. The ocean is a single plane; because the bathymetry is a
real heightfield the shader reads the sea floor beneath each pixel and shades by
actual depth, which is what makes the continental shelves visible as a pale rim
around every landmass. The ocean plane is trimmed against the land by discarding
where depth is negative, rather than relying on a depth test that would z-fight
along every coastline in the world.

Lakes are merged quads at their own water levels — a tarn at 1,800 m and an inland
sea at 40 m both sit correctly in their basins.

Wave *wavelength is chosen from the viewing distance* rather than fixed in world
units. A correct 100 m wave, seen from 300 km up, is several cycles per pixel, which
does not read as ocean — it reads as white static.

The sky is an analytic function, so the water's reflection is evaluated directly
instead of through a probe.

### Rivers and roads

Both are ribbons, and both face the same problem: a river is 400 m wide and the
world is 4,096 km across. Drawing them at true width makes them invisible; drawing
them at a fixed pixel width makes them absurd up close.

The solution is the one printed atlases use. The vertex shader expands each ribbon
to `max(trueHalfWidth, minimumOnScreenWidth)`, where the minimum is derived per
frame from the camera distance. Zoomed out, a river is a legible hairline; zoomed
in, it is 400 m of water in a valley it cut itself. Nothing is rebuilt in between —
it is one uniform. Colour comes from the *hydrological* width, so a stream stays a
stream however many pixels it happens to occupy.

Roads are coloured and dashed by class, following the cartographic convention that
an unmetalled way is dashed.

### Vegetation and built form

Vegetation is a **scale-adaptive scatter**: instance spacing is derived each frame
from the camera distance so the instance count stays inside a fixed budget wherever
the camera is. Placement is a hash of the grid cell, so rebuilding after the camera
moves produces the same trees in the same places rather than a new forest. Above the
local tier it switches off entirely and the terrain shader's vegetation term carries
the forests, which is why zooming out never costs frame rate.

Settlements are **planned, then built**, from their own deterministic seed. The plan
comes first: a street network — radial with a market square and ring streets, or a
grid where the culture builds on a grid — subdivided into superblocks, then blocks,
then burgage plots, with a district assigned to every block from where it sits
relative to the centre, the wall and the water. Then the plots are built on. Each
building is a rectangle fitted to *its own plot's street frontage*, one to five
storeys by district, under a gable, hip, pyramid or flat roof according to how the
culture builds, with the yard left behind it. Nothing is stamped from a prototype,
which is why the street wall comes out continuous and irregular the way a real one
is, and why Sahvari mudbrick under flat roofs and Skarn turf-roofed halls read as
different places rather than as recoloured copies.

Detail is chosen **per block**, not per settlement, from five tiers: full buildings,
the same footprints capped flat at mid-roof height, one prism for the whole block at
its estimated mean roof height, a flat parcel mosaic, and one polygon per block. A
town you are standing over is therefore not all-or-nothing with the town on the
horizon. Geometry is cached per block per tier and merged by `memcpy`, so the frequent
operation — the visible set changing as the camera moves — is a run of typed-array
copies rather than a regeneration, and the whole layer is three draw calls however
many cities are in view — buildings, ground, and the works, which get their own
because a quay has to stand on the waterline and everything else on the ground.

Generating anything new is bounded by a wall-clock slice per rebuild, sized as a
fraction of the frame that just went by: a large capital is 33,000 buildings and
about a second and a half of work from cold, spread over the next several frames
while those blocks draw a tier coarser. Proportional rather than fixed, because a
fixed ten milliseconds is a fifth of a frame on a fast machine and a hundredth of
one on a slow machine — so the machine that most needs the city to finish filling
would be the one that never did, and it would go on paying for the coarse tier for
as long as it did not.

Where a settlement is fortified, the wall is built rather than drawn: a run of
**panels between towers**, each panel level along its own stretch of ground, so a
curtain crossing a hill steps the way real masonry does. Towers stand at the angles
of the ring — a straight run of wall cannot be defended from itself — with
intermediates on any stretch long enough to leave a blind spot, and a pair flanking
each gate. A ditch runs outside it and a mural lane inside, kept clear the way a
town that intends to repair its wall keeps it clear. Nothing is built standing in
water: where the ring meets the sea the masonry stops, because there the water is
the defence.

A settlement on the water gets **harbour works**: a quay marched along its own
shoreline, jetties standing square to their piece of shore and running out until
they are over open water, a breakwater where there is a port worth sheltering, and
hulls moored alongside. Where a road crosses a river the **bridge** is piers and a
deck laid in bays, humped over the span the way an arched bridge is. All of this is
found by sampling the terrain rather than assumed, so a town whose bay faces
south-west gets its quay on the south-west.

Buildings are drawn at **true scale, unexaggerated**, while the terrain beneath them
is exaggerated. That is deliberate. A ten-metre house multiplied by the relief factor
would be a forty-metre house and every town would read as a city of towers; relief
exaggeration is a cartographic device for landforms and has no business being applied
to things whose real size the viewer knows.

### Camera

The camera orbits a focus point that slides across the terrain, and every input feeds
a *target* that the actual value chases with frame-rate-independent exponential
damping. Nothing in the view ever moves in the same frame the input arrived, which is
where the weight comes from.

Two decisions make the scale navigable: **pan speed is proportional to camera
distance**, so dragging moves the ground under the cursor by the same number of
pixels whether you are looking at a continent or a village street; and **pitch is
coupled to zoom**, so the world view is nearly top-down (how you read a map) and
close range is oblique (how you read terrain), with manual override that the coupling
yields to.

Flights interpolate focus, distance, bearing and pitch together along a raised arc —
long journeys pull back before descending, which reads as travel rather than as a
smear and keeps the LOD from thrashing through every intermediate level. Duration
grows with the logarithm of the distance, and any input cancels the flight.

### Labels

Four thousand names cannot all be shown, and choosing between them is the difference
between an atlas and a mess. Three mechanisms, in order: **zoom tiers** assigned in
the generator (a cartographic decision, not a rendering one); **importance ordering**
within a tier, so when space runs out it is the hamlets that lose; and **collision
rejection on a screen-space grid**, which is O(labels) rather than O(labels²) because
it runs every frame. The interface panels are stamped into that grid as occupied
space, so no label is spent behind them.

Labels are DOM elements — text rendering, hinting and accessibility come free, and a
few hundred absolutely-positioned spans are cheap when only the transform changes per
frame.

---

## World structure and data

```
World
└── Continents (7)               Aurenhal, Kaerith, Sahvarem, Ossuary Reach,
    └── Regions (~55)            Tolmereth, Veshanti, Kethrun
        └── Settlements          capitals, cities, towns, villages, hamlets
        └── Landmarks            40 kinds
Oceans and seas (19)             named by convention, as real oceans are
Landforms                        ranges, summits, passes, plateaus, valleys,
                                 cliffs, canyons, glaciers, dune fields, capes
Hydrology                        rivers, lakes, waterfalls, deltas, wetlands
Islands (~300) and archipelagos
Routes                           highways, roads, caravan routes, tracks, lanes
Anomalies (14)
```

A typical world contains around **5,500 named features**. Every one is a `Feature`
in [`src/world/types.ts`](src/world/types.ts) — one flat array with a discriminating
`kind`, which is what makes the gazetteer, the label layer and the search index
trivial. Adding a feature type needs a kind, an icon and a label tier.

Each feature carries its name, kind, position, elevation, region, continent,
importance, label tier, population where relevant, a description, a list of facts,
its extent, and any geometry (river polylines, region borders).

### The impossible places

Fourteen, in a world of five thousand. Each violates a specific rule the rest of the
world obeys, and the violation is geometric so it survives being looked at closely.

| | |
| --- | --- |
| **The Ninth Step** | A mountain in nine perfect concentric terraces, risers exactly 112 m |
| **The Cirque** | An unbroken ring of mountains, crest at a constant 1,840 m, lake inside, no ejecta outside |
| **The Drowned Stair** | A dry valley 410 m below sea level, eleven kilometres from an open coast |
| **Vantage** | A spire 9,340 m tall and 2.3 km wide, with no talus field |
| **The Ouroboros** | A river 68 km long that flows in a closed loop |
| **The Inverted Peak** | A pit that is the exact negative of the mountain beside it |
| **The Straight Shore** | 320 km of coastline that deviates from a line by under 11 m |
| **The Tessellation** | 11,000 km² of hexagonal columns, each 1.4 km across |
| **The Sundering** | A cleft 206 km long and exactly 1,000 m wide, walls parallel and mirrored |
| **The Nesting Lakes** | Lake, island, lake, island — five generations at exactly 1:3 |
| **The Quiet** | 190 km of ocean with a floor flat to within a metre |
| **The Level Range** | Nineteen separate summits, all at 3,412 m |
| **The Hollow** | A vertical shaft 1,400 m wide through a mountain, from summit to below sea level |
| **The Meridian Wall** | A natural wall 502 km long on a constant bearing, with four evenly spaced gaps |

---

## Performance

The world is enormous; the frame budget is not. What keeps it interactive:

- **Terrain LOD is a texture lookup, not geometry.** One shared grid mesh; nodes are
  transforms. Subdividing is free, memory is constant.
- **Frustum culling on real vertical bounds**, sampled lazily per node.
- **Sub-texel relief is procedural**, so close-range detail costs instructions rather
  than memory.
- **Everything batched.** Vegetation is one draw call per plant type; every city in
  view is three, however many buildings they hold.
- **Built geometry is cached per block per tier** and merged by `memcpy`, so a camera
  move is typed-array copies rather than a regeneration.
- **Generation is budgeted by wall clock**, not by count: a rebuild spends at most
  16 ms raising new buildings and draws the rest a tier coarser until a later frame
  affords them. A slow machine fills a city over more frames, not in one long freeze.
- **Scale-adaptive budgets.** Vegetation spacing and settlement counts are derived
  from camera distance to hold a fixed instance ceiling at any zoom.
- **Tier gating.** Vegetation stops above ~95 km, built form above ~150 km, surface
  detail noise above ~1,400 km, water chop with distance. Zooming out gets *cheaper*.
- **Analytic sky.** The water reflection needs no render target.
- **Ray-marched shadows** with a geometrically growing stride: 20 samples reach
  hundreds of kilometres.
- **Adaptive near and far planes** plus a logarithmic depth buffer, which is what
  makes a scene spanning 1.4 km to 7,600 km of camera distance workable.
- **DOM labels** touched only by transform, on a pooled element set.
- **Automatic quality governor.** Device capability picks a starting preset; if the
  median frame time misses budget the preset drops. Deliberately one-directional —
  quality that ratchets up and down produces visible pulsing.
- **Generation in a worker**, with every large buffer transferred rather than copied.

Four quality presets control chunk density, shadow steps, vegetation and city
budgets, water detail and pixel-ratio cap. They are in **Settings → Quality**.

---

## Project layout

```
src/
├── main.ts                    Entry point; WebGL 2 check, seed from URL
├── core/
│   ├── config.ts              World size, grid resolutions, zoom tiers, quality presets
│   └── App.ts                 Assembly, interaction policy, frame loop
├── util/
│   ├── math.ts noise.ts rng.ts grid.ts heap.ts contour.ts fuzzy.ts
├── world/
│   ├── types.ts               The Feature model and the worker payload
│   ├── palette.ts             The world's colour: JS and GLSL, one source
│   ├── generate.ts            The pipeline
│   ├── worker.ts              Worker entry; transfers the payload
│   └── gen/
│       ├── layout.ts          THE AUTHORED WORLD: cores, belts, shoals, seas
│       ├── elevation.ts       Continental potential and surface composition
│       ├── anomalies.ts       The fourteen impossible places
│       ├── hydrology.ts       Depression filling, flow routing, rivers, carving
│       ├── climate.ts         Temperature, orographic rainfall, aridity, biomes
│       ├── biomes.ts          34 biomes and the classification envelope
│       ├── landforms.ts       Detection of everything nameable
│       ├── regions.ts         Cost-based region growth, cultures, borders
│       ├── settlements.ts     Site scoring and placement
│       ├── roads.ts           A* network with route reuse
│       ├── landmarks.ts       40 kinds, each with a placement rule
│       ├── names.ts           Culture phonologies and compound toponyms
│       ├── lore.ts            Descriptions built from real measurements
│       ├── features.ts        Assembly, label tiers, cross-references
│       ├── geometry.ts        Ribbon, lake, coastline and border geometry
│       ├── textures.ts        Height, climate, surface, region, overview
│       └── city/              The inside of a settlement
│           ├── geometry2d.ts  Convex polygon algebra: split, inset, clip, edge tagging
│           ├── types.ts       Plan model, district rules, density and radius tables
│           ├── streets.ts     Radial and grid street networks, boundary, gates
│           ├── blocks.ts      Superblocks into blocks, grain coarsening outward
│           ├── districts.ts   District assignment, built-fraction falloff
│           ├── parcels.ts     Burgage-plot subdivision, lazy per block
│           ├── plan.ts        Assembly, wall, singular landmarks, street trimming
│           ├── buildings.ts   A building fitted to a plot; the closed-form block mass
│           ├── walls.ts       The curtain as pieces: panels, towers, gates, ditch
│           ├── harbour.ts     Quays marched along the shore, jetties, hulls
│           └── geometry3d.ts  Extrusion: buildings, roofs, fortification, works
├── render/
│   ├── WorldResources.ts      Textures and the shared uniform block
│   ├── WorldView.ts           Scene graph, layers, per-frame budgets
│   ├── Atmosphere.ts          Sky dome and the time-of-day light model
│   ├── terrain/               Quadtree and terrain shaders
│   ├── water/                 Ocean, lakes, wave model
│   └── features/              Ribbons, vegetation, built form
├── camera/
│   ├── MapControls.ts         Damped orbit-pan-zoom, touch and keyboard
│   └── CameraDirector.ts      Arced flights
├── interaction/Picker.ts      Heightfield ray-march, screen-space feature picking
├── ui/                        Labels, search, info panel, layers, chrome, loading
└── styles/app.css
scripts/
├── smoke.ts                   Headless generation test with diagnostic images
├── diagnostics.ts             Elevation, climate, region and network renders
├── visual.ts                  Browser harness: screenshots and console capture
├── measure.ts                 What the city generator builds, in metres
└── png.ts                     Minimal PNG encoder for the harness
```

### Where to change things

| To change | Edit |
| --- | --- |
| Continent shapes and positions | `gen/layout.ts` → `CORES` |
| Mountain ranges | `gen/layout.ts` → `BELTS` |
| Ocean and sea names | `gen/layout.ts` → `WATER_BODIES` |
| Biomes and their colours | `gen/biomes.ts` |
| A new landmark kind | `gen/landmarks.ts` → `SPECS` (one scoring function) |
| Naming style | `gen/names.ts` → `CULTURES`, `QUALIFIERS`, element lists |
| The world's colour | `world/palette.ts` (both implementations) |
| Label tiers | `gen/features.ts` |
| A new anomaly | `gen/anomalies.ts` → `ANOMALIES` (a stamp function) |
| How a district builds | `gen/city/types.ts` → `DISTRICTS`, `gen/city/buildings.ts` → `DISTRICT_FORM` |
| How a culture builds | `gen/city/buildings.ts` → `STYLES` |
| City detail radii and budgets | `render/features/CityMeshes.ts` |
| Wall and tower proportions | `gen/city/walls.ts` |
| Harbour layout | `gen/city/harbour.ts` |

---

## Testing

### `npm run smoke`

Runs the full pipeline headless in Node — it has no DOM dependencies — and asserts
the output is actually a world: plausible land fraction and elevation range, no
non-finite values, sensible land cover (not a desert planet, real forest and
grassland fractions), a feature census with minimums per kind, unique names, no
placeholder names, prose and facts on every feature, no settlement underwater, and a
label-tier population that means zooming in reveals something.

It also writes inspection images to `out/`:

| | |
| --- | --- |
| `overview.png` | The world as the minimap sees it |
| `diag-elevation.png` | Hypsometric elevation |
| `diag-climate.png` | Temperature, moisture and vegetation as RGB |
| `diag-regions.png` | Political partition |
| `diag-network.png` | Coast, rivers, roads, settlements, anomalies |

Looking at those catches the class of problem no assertion describes — a desert on
the windward side of a range, a river network that does not branch, borders that
ignore the terrain.

### `npx tsx scripts/visual.ts`

Builds are verified in a real browser. The harness serves `dist/`, drives Chrome or
Edge, waits for generation, flies to twelve viewpoints, captures each, and reports
every console error, page error and graphics warning. A shader that fails to compile
produces a black screen and no exception anywhere a unit test would look; this is
what catches it.

`npx tsx scripts/visual.ts --plans` runs a second set of ten views aimed at the
inside of settlements: a radial capital at three zooms, a grid city, a desert city, a
town, a village, a port at two heights and a bridge. Cities fill in over several
frames, so each shot waits on `__nv.stats().citiesSettled` before firing — a
photograph of a half-built city says nothing about how the finished thing looks,
which is how several building bugs survived an earlier pass. The harness also pins
the quality preset, because the application drops it when frames run long and
software WebGL makes every frame run long. `--only=p3,p5,p10` runs a subset: a full
pass is ten views of a large city on a software rasteriser, and checking one change
should not cost ten minutes.

Requires `npm run build` first and a local Chrome or Edge. It downloads no browser.
Screenshots land in `out/shots/`.

### `npx tsx scripts/measure.ts`

Prints the real dimensions of what the city generator builds — wall heights and
thicknesses, tower and gate counts, mean and tallest buildings, quay length, how far
the harbour works are from the town centre, and how many of them stand in water.

A screenshot cannot answer those questions. A wall four times too tall and a wall
correctly proportioned look much the same from a kilometre up, next to buildings you
have no independent scale for; and a coastline rendered at the lowest quality preset
puts dry land under water, so a correctly placed quay looks wrong. Both of those
cost real time in the session that built the walls, and this is the answer to them.

The application also exposes `window.__nv` for scripting — `__nv.jumpToNamed('The
Ouroboros')`, `__nv.setLayer('contours', true)`, `__nv.stats()` — which is how the
harness drives it and a faster way to check a place than searching for it.

---

## Extending it

The world data is structured so regions and locations can be added without touching
the renderer.

**A new kind of place** needs three things: a `FeatureKind` in `world/types.ts`, an
entry in `SPECS` in `gen/landmarks.ts` with a scoring function over the terrain, and
an icon plus a label tier in `ui/Labels.ts`. Everything else — search, the info
panel, picking, the legend, layer filtering — picks it up automatically because they
all read the same flat feature array.

**A new continent** is one entry in `CORES`, optionally with belts. The rest of the
pipeline will give it a coastline, a climate, rivers, regions, cities and names
without further intervention.

**A new anomaly** is one entry in `ANOMALIES` with a stamp function that writes into
the heightfield. Because it is stamped before hydrology, the world will treat
whatever you draw as real ground.

---

## Technical choices, briefly

**Three.js** for the WebGL 2 abstraction, with `RawShaderMaterial` and hand-written
GLSL 3.0 throughout — the material system is not used, only the context, buffer and
uniform management. **TypeScript** in strict mode, because a generator with this many
interacting stages is not maintainable without it. **Vite** for the build and its
first-class worker support. **No UI framework**: there are about thirty interactive
elements and one of them updates per frame, so a framework would add a build
dependency and a diffing pass to solve a problem forty lines of DOM helpers solve.

Total shipped: roughly 590 kB of JavaScript, 120 kB gzipped, plus a 21 kB stylesheet.
Everything else is computed on your machine.
