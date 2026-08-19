# Resume here

Read this first, then §11 of [DETAIL-UPGRADE.md](DETAIL-UPGRADE.md) for the full
history.

---

## Where the work stands

**Phases A and B are complete.** Street plans, buildings, works, and vegetation at
real density and real scale.

| | State |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |
| `npx tsx scripts/smoke.ts` | ALL CHECKS PASSED |
| `npx tsx scripts/measure.ts` | all numbers correct |
| `npx tsx scripts/visual.ts --plans` | clean, 0 console errors |
| Git | Phase A committed on `phase-a-cities`; Phase B on top |

Measured on the default seed:

```
capital  wall 11.8-13.5 m tall, 5.3 m thick, 282 panels, 102 towers, 4 gates
port     quay 61 pts / 1807 m, 0 points in water, 7 jetties all tipped over water
bridges  110 total, 102 snapped onto a channel, 8 with no channel within 14 km
city     32,759 buildings from 3,300 blocks
forest   145,000 plants over a 2.4 km ring at 9 m spacing, true heights
```

## What Phase B settled

Vegetation now stands at true height and true density inside a ring around the
camera, with the terrain shader's own term carrying everything beyond it. The one
decision the rest follows from is **cover is a matter of how many, not how large** —
see §12 for the three bugs that came out of it, all of which were versions of the
same mistake about which distance a thing is measured from.

Both items Phase A left on Phase B's doorstep are closed: tree scale now comes from
a per-species height range in metres, and the developed-ground suppression is
unchanged but is now the *only* thing keeping towns clear, which it does correctly.

Two Phase B items were deliberately not built, for reasons in §12: ground cover
(sub-pixel at the locked zoom floor) and hedgerows / orchard rows / windbreaks (all
three are field-system boundaries, and field systems are Phase C).

## Next: Phase C — the rural landscape

~3.5-5 h. Field systems, farmsteads, mills and mines with their works, road
embankments. See §5.

Two things found earlier that belong here. **Orchard districts inside towns are
coloured ground with nothing growing on them** — the scatter suppresses planting on
developed ground and knows nothing about city blocks; worth wiring up when field
systems give the two a shared notion of cultivated land. And **roads cross shallow
water in the archipelagos** — the road A\* navigates on 512 cells, 8 km each, and
cannot see a strait narrower than that. Neither is new; both are newly visible now that there is
built detail to compare them against.

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

## Files added in Phases A and B

```
src/world/gen/city/       geometry2d, types, streets, blocks, districts, parcels,
                          plan, buildings, geometry3d, walls, harbour
src/render/features/      CityMeshes.ts       (replaced CityPlans + Settlements3D)
                          PlantLibrary.ts     (prototypes at unit height, two tiers)
scripts/                  measure.ts          (what the generator builds, in metres)
```
