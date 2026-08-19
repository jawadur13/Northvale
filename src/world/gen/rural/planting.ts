/**
 * Planting: the trees people put there on purpose.
 *
 * The vegetation scatter grows what the climate supports, and it is deliberately
 * blind to anything a person did — it suppresses itself on developed ground and
 * knows nothing about blocks, plots or field boundaries. That is the right shape
 * for wild cover and exactly the wrong shape for the three kinds of tree that are
 * *only* interesting because someone planted them in a line:
 *
 *   **Hedgerow trees**  standing in the boundary, one every fifty metres or so,
 *                       which is what turns a field boundary from a coloured
 *                       margin into something with height and a shadow.
 *   **Orchard rows**    a rectilinear grid of small crowns, which from the air is
 *                       the single most artificial-looking thing in any landscape
 *                       and the one that most obviously means people.
 *   **Windbreaks**      a hedge grown thick and tall on the exposed side, where a
 *                       hedgerow tree could not survive on its own.
 *
 * These come out of the field system and the city plan rather than the climate,
 * and they are handed to the scatter as extra sites — so they are drawn by the
 * same prototypes, at the same two levels of detail, with the same tinting, and
 * cost nothing beyond the instances themselves.
 */

import { Rng } from '../../../util/rng';
import { clamp, TAU } from '../../../util/math';
import { BIOME_BY_ID, type PlantKind } from '../biomes';
import { polyCentroid, vertexCount, type Poly } from '../city/geometry2d';
import type { Block } from '../city/types';
import type { FieldSystem } from './fields';

/** One deliberately planted tree. */
export interface PlantingSite {
  x: number;
  z: number;
  plant: PlantKind;
  /** Mature height in metres. */
  heightM: number;
  /** Foliage colour, packed RGB. */
  tint: number;
}

/**
 * Hedgerow trees, one per this many metres of boundary.
 *
 * Fifty is a real hedge — close enough to read as a line from the air, far enough
 * apart that each crown is a separate thing rather than a strip of woodland.
 */
const HEDGE_SPACING_KM = 0.05;

/** Orchard trees stand on a grid this far apart, which is how orchards are set. */
const ORCHARD_SPACING_KM = 0.009;

/** What grows in a hedge here, and how big it gets. */
function hedgeSpecies(biome: number): { plant: PlantKind; heightM: [number, number]; tint: number } {
  const def = BIOME_BY_ID[biome];
  const group = def ? def.group : 'grass';
  // A hedgerow tree is a standard left in the hedge when it was laid, so it is
  // whatever the country grows — but never a forest giant, because it stood alone
  // in the wind its whole life.
  if (group === 'alpine' || group === 'ice') {
    return { plant: 'snowpine', heightM: [6, 11], tint: 0x40564a };
  }
  if (group === 'arid') {
    return { plant: 'shrub', heightM: [1.4, 3], tint: 0x6d7248 };
  }
  if (group === 'wetland') {
    return { plant: 'birch', heightM: [7, 13], tint: 0x5d7442 };
  }
  return { plant: 'broadleaf', heightM: [9, 16], tint: 0x435f2e };
}

/**
 * Trees along the field boundaries and in the orchards.
 *
 * Boundaries are shared between neighbouring parcels, so an edge is keyed by its
 * own midpoint rather than by the parcel that offered it — both parcels hash the
 * same value and only one of them plants it. Without that every hedge is planted
 * twice and the belt comes out as a grid of double rows.
 */
export function buildPlanting(
  fields: FieldSystem,
  blocks: Block[],
  biomeAt: (x: number, z: number) => number,
  heightAt: (x: number, z: number) => number,
  seed: number,
): PlantingSite[] {
  const rng = new Rng(seed ^ 0x9c37);
  const out: PlantingSite[] = [];

  // --- Hedgerow trees and windbreaks --------------------------------------
  for (const parcel of fields.parcels) {
    // A bank-and-ditch boundary in wet country carries willows; a dry-stone wall
    // carries nothing at all, which is most of why walled country reads as bare.
    if (parcel.boundary === 0x8a857a) continue;

    const poly = parcel.poly;
    const n = vertexCount(poly);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = poly.pts[i * 2];
      const az = poly.pts[i * 2 + 1];
      const bx = poly.pts[j * 2];
      const bz = poly.pts[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < HEDGE_SPACING_KM * 0.8) continue;

      // Key on the edge midpoint, so both parcels sharing it agree who plants.
      const mx = (ax + bx) * 0.5;
      const mz = (az + bz) * 0.5;
      const owner = edgeHash(mx, mz);
      if (owner > 0.5) continue;

      const species = hedgeSpecies(biomeAt(mx, mz));
      // A windbreak is the same hedge grown out: on the exposed side of a parcel
      // it is planted twice as thick, which is the only difference anyone can see.
      const exposed = edgeHash(mx * 1.7, mz * 1.3) < 0.22;
      const step = HEDGE_SPACING_KM * (exposed ? 0.45 : 1);
      const count = Math.floor(len / step);
      for (let k = 0; k < count; k++) {
        const t = (k + 0.5) / count + rng.range(-0.16, 0.16) / count;
        if (!exposed && rng.next() > 0.62) continue;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        if (heightAt(x, z) <= 0.002) continue;
        out.push({
          x,
          z,
          plant: species.plant,
          heightM: species.heightM[0] + rng.next() * (species.heightM[1] - species.heightM[0]),
          tint: species.tint,
        });
      }
    }
  }

  // --- Orchard rows ---------------------------------------------------------
  // The one planting that is unmistakable from any height: a rectilinear grid of
  // equal crowns, which occurs nowhere in nature and everywhere people grow fruit.
  const centre: [number, number] = [0, 0];
  for (const block of blocks) {
    if (block.district !== 'orchard') continue;
    polyCentroid(block.poly, centre);
    const angle = rng.range(0, TAU);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const reach = blockReach(block.poly, centre[0], centre[1]);
    const rows = Math.min(14, Math.floor((reach * 2) / ORCHARD_SPACING_KM));
    if (rows < 2) continue;

    for (let r = -rows; r <= rows; r++) {
      for (let c = -rows; c <= rows; c++) {
        const u = r * ORCHARD_SPACING_KM;
        const v = c * ORCHARD_SPACING_KM;
        if (u * u + v * v > reach * reach) continue;
        const x = centre[0] + u * cos - v * sin;
        const z = centre[1] + u * sin + v * cos;
        if (!containsRoughly(block.poly, x, z)) continue;
        out.push({
          x,
          z,
          plant: 'broadleaf',
          // Fruit trees are kept small on purpose: nobody picks from a forty-foot
          // ladder. That, and the regular spacing, is the whole signature.
          heightM: 4.2 + rng.next() * 2.4,
          tint: 0x53703a,
        });
      }
    }
  }

  return out;
}

/** A stable hash of a boundary midpoint, so both sides of an edge agree. */
function edgeHash(x: number, z: number): number {
  const v = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/** Distance from a centre to the nearest edge of a convex polygon. */
function blockReach(poly: Poly, cx: number, cz: number): number {
  const n = vertexCount(poly);
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly.pts[i * 2];
    const az = poly.pts[i * 2 + 1];
    let ex = poly.pts[j * 2] - ax;
    let ez = poly.pts[j * 2 + 1] - az;
    const len = Math.hypot(ex, ez) || 1;
    ex /= len;
    ez /= len;
    // Perpendicular distance from the centre to this edge's line.
    best = Math.min(best, Math.abs((cx - ax) * ez - (cz - az) * ex));
  }
  return clamp(best - 0.004, 0, 0.09);
}

/** Convex containment with a small margin, for keeping rows off the boundary. */
function containsRoughly(poly: Poly, x: number, z: number): boolean {
  const n = vertexCount(poly);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly.pts[i * 2];
    const az = poly.pts[i * 2 + 1];
    const ex = poly.pts[j * 2] - ax;
    const ez = poly.pts[j * 2 + 1] - az;
    if ((x - ax) * ez - (z - az) * ex > 0) return false;
  }
  return true;
}
