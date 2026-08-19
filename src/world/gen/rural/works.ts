/**
 * Industrial works.
 *
 * A mine on this map was a label and a dot. What makes one legible from the air
 * is never the shaft — that is a hole a few metres across — but everything the
 * shaft produced: the spoil heap, which is bigger than the workings and a colour
 * that grows nowhere; the tramway to the road; the benches a quarry was cut in.
 * The same is true of a mill, where the building is the small part and the pond
 * and leat are the large one.
 *
 * So each of these is described as *the ground it disturbed*, and the building is
 * an afterthought sitting on it. All of it is laid on the terrain rather than cut
 * into it — the heightfield is baked long before anything knows a mine is here —
 * which at one to five kilometres is indistinguishable, and is the trade recorded
 * in §5 of the plan.
 */

import { Rng } from '../../../util/rng';
import { clamp, TAU } from '../../../util/math';

/** A disturbed patch of ground: spoil, bench, pond or platform. */
export interface WorkPatch {
  x: number;
  z: number;
  radiusKm: number;
  /** Height above the ground it sits on, in km. Negative reads as a cut. */
  riseKm: number;
  sides: number;
  angle: number;
  color: number;
}

/** A building on the works: mill house, engine house, kiln. */
export interface WorkBuilding {
  x: number;
  z: number;
  widthKm: number;
  depthKm: number;
  heightKm: number;
  angle: number;
  wall: number;
  roof: number;
}

export interface Works {
  patches: WorkPatch[];
  buildings: WorkBuilding[];
  /** Where the whole thing takes its ground height from. */
  ax: number;
  az: number;
  /**
   * How far to sink the whole works into the hill, in km.
   *
   * The works sample the terrain at a point; the terrain *mesh* interpolates
   * between vertices a couple of hundred metres apart, and on a steep face it
   * cuts the corner and sits well below the sampled height — multiplied by the
   * relief exaggeration, far enough to leave a quarry hanging in the air above
   * its own hillside. Sinking by the local gradient puts it back in the ground,
   * and a quarry cut into a slope is buried in it anyway.
   *
   * A dozen metres at the steepest, which is a real cut rather than a correction:
   * on ground steep enough that the mismatch is larger than that, no works of this
   * size can be represented at all — the terrain mesh there has vertices two
   * hundred metres apart and a quarry is a hundred metres across.
   */
  sinkKm: number;
}

/** Spoil, which is the rock that was in the way, and is never the local colour. */
const SPOIL = 0x6b6053;
const ROCK = 0xa39c90;
const POND = 0x3f5a68;
const MILL_WALL = 0x9a9184;
const MILL_ROOF = 0x5c5348;

/**
 * Builds the works for one landmark, or null for a kind that has none.
 *
 * `scale` comes from the feature's importance, so a great mine is a bigger scar
 * than a village adit — which is the only thing about it anyone can see.
 */
export function buildWorks(
  kind: string,
  x: number,
  z: number,
  importance: number,
  slope: number,
  seed: number,
): Works | null {
  const rng = new Rng(seed ^ 0x0dd5);
  const patches: WorkPatch[] = [];
  const buildings: WorkBuilding[] = [];
  const scale = clamp(0.55 + importance * 1.1, 0.55, 1.7);
  const angle = rng.range(0, TAU);

  switch (kind) {
    case 'mine': {
      // Two or three spoil heaps downhill of the adit, which is where spoil goes
      // — and an engine house, which is the only building worth the name.
      const heaps = 2 + Math.floor(rng.next() * 2);
      for (let i = 0; i < heaps; i++) {
        const a = angle + rng.range(-0.7, 0.7);
        const d = 0.02 * scale * (0.6 + i * 0.7);
        patches.push({
          x: x + Math.cos(a) * d,
          z: z + Math.sin(a) * d,
          radiusKm: 0.016 * scale * rng.range(0.7, 1.3),
          riseKm: 0.006 * scale * rng.range(0.7, 1.2),
          sides: 7,
          angle: rng.range(0, TAU),
          color: SPOIL,
        });
      }
      buildings.push({
        x,
        z,
        widthKm: 0.013 * scale,
        depthKm: 0.009 * scale,
        heightKm: 0.009 * scale,
        angle,
        wall: MILL_WALL,
        roof: MILL_ROOF,
      });
      break;
    }
    case 'quarry': {
      // Benches: concentric steps, each a little lower and wider than the last.
      // A quarry is a staircase cut into a hillside and read from above it is a
      // set of nested rings, which is exactly what this is.
      const benches = 3 + Math.floor(rng.next() * 2);
      for (let i = 0; i < benches; i++) {
        const t = i / benches;
        patches.push({
          x,
          z,
          radiusKm: 0.05 * scale * (1 - t * 0.62),
          riseKm: 0.0012 + i * 0.0016 * scale,
          sides: 9,
          angle: angle + i * 0.24,
          color: ROCK,
        });
      }
      patches.push({
        x: x + Math.cos(angle) * 0.062 * scale,
        z: z + Math.sin(angle) * 0.062 * scale,
        radiusKm: 0.022 * scale,
        riseKm: 0.007 * scale,
        sides: 7,
        angle: rng.range(0, TAU),
        color: SPOIL,
      });
      break;
    }
    case 'watermill':
    case 'sawmill': {
      // The pond is the works. A mill without a head of water is a shed.
      patches.push({
        x: x - Math.cos(angle) * 0.03 * scale,
        z: z - Math.sin(angle) * 0.03 * scale,
        radiusKm: 0.026 * scale,
        riseKm: 0.0008,
        sides: 8,
        angle: rng.range(0, TAU),
        color: POND,
      });
      buildings.push({
        x,
        z,
        widthKm: 0.014 * scale,
        depthKm: 0.009 * scale,
        heightKm: 0.011 * scale,
        angle,
        wall: MILL_WALL,
        roof: MILL_ROOF,
      });
      break;
    }
    case 'windmill': {
      // A mill on a mound, with the ground round it kept clear so the sails have
      // wind from every quarter — which is why a windmill stands alone.
      patches.push({
        x,
        z,
        radiusKm: 0.03 * scale,
        riseKm: 0.0025 * scale,
        sides: 9,
        angle,
        color: 0x7f7a5e,
      });
      buildings.push({
        x,
        z,
        widthKm: 0.008 * scale,
        depthKm: 0.008 * scale,
        heightKm: 0.017 * scale,
        angle,
        wall: MILL_WALL,
        roof: MILL_ROOF,
      });
      break;
    }
    default:
      return null;
  }

  return { patches, buildings, ax: x, az: z, sinkKm: clamp(slope, 0, 1) * 0.012 };
}
