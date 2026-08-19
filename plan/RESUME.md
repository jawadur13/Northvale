# Resume here

Read this first, then §11 of [DETAIL-UPGRADE.md](DETAIL-UPGRADE.md) for the full
history.

---

## Where the work stands

**All three phases are complete.** Street plans, buildings, works, vegetation at
real density and real scale, and the worked landscape between the last house and
the wilderness.

| | State |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |
| `npx tsx scripts/smoke.ts` | ALL CHECKS PASSED |
| `npx tsx scripts/measure.ts` | all numbers correct |
| `npx tsx scripts/visual.ts` | clean, 0 console errors, 0 graphics warnings |
| Git | committed on `phase-a-cities`; nothing pushed |

Measured on the default seed:

```
capital  wall 11.8-13.5 m tall, 5.3 m thick, 282 panels, 102 towers, 4 gates
port     quay 61 pts / 1807 m, 0 points in water, 7 jetties all tipped over water
bridges  110 total, 102 snapped onto a channel, 8 with no channel within 14 km
city     32,759 buildings from 3,300 blocks
forest   145,000 plants over a 2.4 km ring at 9 m spacing, true heights
fields   381 parcels over 7.7 km2 at a mean of 2.0 ha for a city of 179,000
works    406 landmarks, 811 patches of disturbed ground
```

## If you pick this up again

Nothing is half-finished. What is left is either deliberately not built, with the
reason recorded, or a known limit of the architecture. In rough order of value:

1. **Wire cultivated land to the vegetation layer.** Orchard districts inside towns
   and the field belt outside them both grow nothing, because the scatter
   suppresses planting on developed ground and knows nothing about city blocks or
   field parcels. `rural/fields.ts` now holds the shared notion of cultivated land
   that would fix it. See §13.
2. **Road construction** — embankments, cuttings, milestones. Deliberately skipped
   as the lowest-value part of §5; at one to five kilometres a road is already
   drawn at its minimum on-screen width. See §13.
3. **Ground cover and hedgerow planting** — §12 has the reasoning for both.
4. The deferred items in §6: terrain streaming, a larger world, and the deeper
   performance work. Each is written up with its cost and its risk.

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
- Works on ground steeper than about one in eight cannot sit on the terrain
  convincingly: the mesh has vertices two hundred metres apart there and a quarry
  is a hundred metres across. They sink by their own gradient up to a dozen metres,
  which covers ordinary ground and gives up on cliffs.

## What to reach for

| Question | Tool |
| --- | --- |
| Is this the right size / in the right place? | `npx tsx scripts/measure.ts` — **not** a screenshot |
| Did one view change? | `npx tsx scripts/visual.ts --plans --only=p10` |
| Did the world generator break? | `npx tsx scripts/smoke.ts` |
| Did anything regress across zooms? | `npx tsx scripts/visual.ts` |

Screenshots settled almost none of the hard questions in Phase A and actively
misled on three of them. Measure first.

## Files added across the three phases

```
src/world/gen/city/       geometry2d, types, streets, blocks, districts, parcels,
                          plan, buildings, geometry3d, walls, harbour
src/world/gen/rural/      fields, works
src/render/features/      CityMeshes.ts       (replaced CityPlans + Settlements3D)
                          PlantLibrary.ts     (prototypes at unit height, two tiers)
scripts/                  measure.ts          (what the generator builds, in metres)
```
