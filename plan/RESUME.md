# Resume here

Read this first, then §11 of [DETAIL-UPGRADE.md](DETAIL-UPGRADE.md) for the full
history.

---

## Where the work stands

**Phase A is complete and verified.** A1 street plans, A2 buildings, A3 works.

| | State |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |
| `npx tsx scripts/smoke.ts` | ALL CHECKS PASSED |
| `npx tsx scripts/measure.ts` | all numbers correct (below) |
| `npx tsx scripts/visual.ts` | clean, 0 console errors, 0 graphics warnings |
| `npx tsx scripts/visual.ts --plans` | clean, 0 console errors |
| Git | **nothing committed yet.** All of Phase A is uncommitted working tree |

Measured on the default seed:

```
capital  wall 11.8-13.5 m tall, 5.3 m thick, 282 panels, 102 towers, 4 gates
port     quay 61 pts / 1807 m, 0 points in water, 7 jetties all tipped over water
bridges  110 total, 102 snapped onto a channel, 8 with no channel within 14 km
city     32,759 buildings from 3,300 blocks
```

**Committing Phase A is the sensible first act next session** — it is eleven new
modules and a replaced renderer, and none of it is in git.

## What the last session found

Chasing the one unverified thing — the bridge — turned up the largest bug of the
phase. **Every flat lid in `gen/city/geometry3d.ts` was wound backwards and so
invisible.** A polygon wound counter-clockwise in the XZ plane projects *clockwise*
seen from above, which is the only direction a lid is ever seen from, so with
front-face culling the whole top surface was a back face.

It had been silently removing the roof of every flat-roofed building, the top of
every block in the massing tier, and every wall and tower coping for as long as
those had existed. None of it read as a bug, because a building with no roof still
looks like a building from above — it only became undeniable on a bridge, which is
almost nothing *but* lid. All four fans now go through one `capPoly`.

Two other things came out of it:

- **The generation slice is now proportional to the frame.** It was a fixed 10 ms,
  which is a fifth of a frame at sixty fps and a hundredth of one at one fps — so
  the machine that most needed its cities to finish filling was the one that never
  did. On the software rasteriser the same city now fills sixteen times faster.
- **The harness gained `--only=p3,p5,p10`** and a five-minute settle. A full pass
  is ten views of a large city on a software rasteriser; checking one change should
  not cost that.

## Next: Phase B — vegetation

~1.5-2 h. Independent of everything above. See §4 of DETAIL-UPGRADE.md.

- Impostor LOD chain: mesh → cross-billboard → the terrain shader's own term
- Raise the instance ceiling from 60,000 to 400,000
- Species mixes per biome instead of one prototype per biome
- Forest structure: edges, clearings, gallery forest along rivers, hedgerows
- Ground cover at close range

Two things Phase A leaves on Phase B's doorstep:

1. **Tree scale.** Capped at 42 m in `render/features/Vegetation.ts` (`baseScale`).
   That is a large conifer and it reads large beside a 9 m house. Phase B should
   set the scale per species rather than from instance spacing.
2. **Vegetation is suppressed on developed ground** (a square law on the developed
   mask). Gardens and orchards inside towns are coloured ground with nothing
   growing on them — worth revisiting once species exist.

## Then: Phase C — the rural landscape

~2.5-3 h. Field systems, farmsteads, mills and mines with their works, road
embankments. See §5.

One thing found in A3 that belongs here: **roads cross shallow water in the
archipelagos.** The road A\* navigates on 512 cells — 8 km each — and cannot see a
strait narrower than that. Not new, but newly visible now that there is built
detail on the coast to compare it against.

## Known loose ends, all small

- `ArchStyle.courtyard` in `gen/city/buildings.ts` is declared and never used.
- Roofs are flat-shaded per face. No dormers, no chimneys.
- 8 of 110 bridges cross a channel below the river-ribbon threshold and draw no
  deck. They still exist as named, labelled, describable features.
- The largest cities do not finish filling inside the harness's five-minute settle
  under software WebGL, so `p1`, `p4`, `p5` and `04-local-city` are partial. The
  harness says so per shot. On the target hardware this is a second or two.
- The quality governor in `core/App.ts` drops the preset when frames run long. The
  visual harness pins it to `high`; a new harness entry point must pin it too, or
  every shot is taken with four-kilometre terrain vertices.

## What to reach for

| Question | Tool |
| --- | --- |
| Is this the right size / in the right place? | `npx tsx scripts/measure.ts` — **not** a screenshot |
| Did one view change? | `npx tsx scripts/visual.ts --plans --only=p10` |
| Did the world generator break? | `npx tsx scripts/smoke.ts` |
| Did anything regress across zooms? | `npx tsx scripts/visual.ts` |

Screenshots settled almost none of the hard questions in Phase A and actively
misled on three of them. Measure first.

## Files added in Phase A

```
src/world/gen/city/       geometry2d, types, streets, blocks, districts, parcels,
                          plan, buildings, geometry3d, walls, harbour
src/render/features/      CityMeshes.ts       (replaced CityPlans + Settlements3D)
scripts/                  measure.ts          (what the generator builds, in metres)
```
