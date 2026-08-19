/**
 * Blocks into parcels.
 *
 * The rule that matters: **plots are cut perpendicular to the street they front.**
 *
 * Frontage is the scarce, valuable thing; depth is nearly free. So a medieval
 * town divides a block into long narrow strips running back from the street — the
 * burgage plot — and only cuts across the strip when it becomes absurdly deep, at
 * which point the back half becomes a separate holding reached by an alley.
 * Subdividing by area alone instead produces squares, and a field of squares
 * reads as a modern housing estate no matter what is built on it.
 *
 * Parcels are generated lazily, per block, because a large city has tens of
 * thousands of them and nothing looks at more than a few hundred at once.
 */

import { Rng } from '../../../util/rng';
import { clamp } from '../../../util/math';
import {
  extentAlong,
  insetConvex,
  longestEdge,
  polyArea,
  polyCentroid,
  splitConvex,
  type Poly,
} from './geometry2d';
import { builtFraction } from './districts';
import { DISTRICTS, type Block, type DistrictKind, type Parcel } from './types';

/** Square metres to square kilometres. */
const M2 = 1e-6;

interface SubdivideOpts {
  targetArea: number;
  minFrontage: number;
  /** Beyond this depth-to-frontage ratio, cut a back plot off. */
  maxAspect: number;
  maxDepth: number;
}

/**
 * Recursive plot subdivision.
 *
 * At each step the polygon is cut either *across* its frontage (making two
 * narrower plots, each keeping street access) or *behind* it (making a front plot
 * and a back plot). The choice is made by aspect ratio, which is what actually
 * governs it on the ground.
 */
function subdivide(poly: Poly, opts: SubdivideOpts, rng: Rng, out: Poly[], depth: number): void {
  const area = polyArea(poly);
  if (area <= opts.targetArea || depth >= opts.maxDepth) {
    out.push(poly);
    return;
  }

  // The street this plot fronts. Without one the polygon is landlocked and gets
  // divided on its own long axis instead.
  const street = longestEdge(poly, (i) => poly.street[i] === 1);
  const axis = street ?? longestEdge(poly);
  if (!axis) {
    out.push(poly);
    return;
  }

  // Frontage runs along the street; depth runs away from it.
  const perpX = -axis.dz;
  const perpZ = axis.dx;
  const [fLo, fHi] = extentAlong(poly, axis.dx, axis.dz);
  const [dLo, dHi] = extentAlong(poly, perpX, perpZ);
  const frontage = fHi - fLo;
  const depthSpan = dHi - dLo;

  const aspect = depthSpan / Math.max(frontage, 1e-6);
  // Cut across the frontage while the plot is still wide enough to halve, and
  // only cut a back plot off once it is disproportionately deep.
  const cutBehind = aspect > opts.maxAspect && depthSpan > opts.minFrontage * 2.2;

  let dirX: number;
  let dirZ: number;
  let t: number;
  let axX: number;
  let axZ: number;

  if (cutBehind) {
    // The cut line runs parallel to the street, offset back from it.
    dirX = axis.dx;
    dirZ = axis.dz;
    axX = perpX;
    axZ = perpZ;
    // Front plots are shallower than back plots: the front is worth more.
    t = dLo + depthSpan * clamp(0.5 + rng.range(-0.1, 0.1), 0.3, 0.7);
  } else {
    if (frontage < opts.minFrontage * 2) {
      out.push(poly);
      return;
    }
    dirX = perpX;
    dirZ = perpZ;
    axX = axis.dx;
    axZ = axis.dz;
    t = fLo + frontage * (0.5 + rng.range(-0.14, 0.14));
  }

  const res = splitConvex(poly, axX * t, axZ * t, dirX, dirZ, false);
  if (!res.left || !res.right) {
    out.push(poly);
    return;
  }
  subdivide(res.left, opts, rng, out, depth + 1);
  subdivide(res.right, opts, rng, out, depth + 1);
}

/** Which edge of a finished parcel fronts a street, or -1. */
function frontageEdge(poly: Poly): number {
  const n = poly.pts.length / 2;
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < n; i++) {
    if (!poly.street[i]) continue;
    const j = (i + 1) % n;
    const len = Math.hypot(
      poly.pts[j * 2] - poly.pts[i * 2],
      poly.pts[j * 2 + 1] - poly.pts[i * 2 + 1],
    );
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  return best;
}

/**
 * Subdivides one block, caching the result on it.
 *
 * The block is first inset by the street setback — the pavement and the road
 * itself — so that plots stop at the building line rather than in the middle of
 * the carriageway. Then a fraction of the plots is dropped to leave yards,
 * courts and gardens, which is what keeps a quarter from reading as a solid mat.
 */
export function buildParcels(block: Block, culture: number, seed: number): Parcel[] {
  if (block.parcels) return block.parcels;

  const rule = DISTRICTS[block.district];
  const rng = new Rng(seed ^ Math.round(block.cx * 7919) ^ Math.round(block.cz * 104729));

  // Setback: half a lane plus a pavement. Sahvari streets are famously narrow.
  const setback = culture === 3 ? 0.0035 : 0.0055;
  const inner = insetConvex(block.poly, setback);
  if (!inner || polyArea(inner) < 8 * M2) {
    block.parcels = [];
    return block.parcels;
  }

  const raw: Poly[] = [];
  subdivide(
    inner,
    {
      targetArea: rule.parcelArea * block.plotScale * M2,
      minFrontage: rule.minFrontage * Math.sqrt(block.plotScale) * 0.001,
      // Deep, narrow plots in the trades quarters; shallow and wide in suburbs.
      maxAspect: block.district === 'artisan' || block.district === 'shanty' ? 4.2 : 2.6,
      maxDepth: 8,
    },
    rng,
    raw,
    0,
  );

  const built = builtFraction(block.district, rng.next(), block.t);
  const parcels: Parcel[] = [];
  const tmp: [number, number] = [0, 0];

  for (const poly of raw) {
    const area = polyArea(poly);
    if (area < 24 * M2) continue;
    // Leave the openness fraction as yards and courts.
    if (rng.next() > built) continue;
    polyCentroid(poly, tmp);
    parcels.push({
      poly,
      district: block.district,
      area,
      frontage: frontageEdge(poly),
      variant: rng.next(),
    });
  }

  block.parcels = parcels;
  return parcels;
}

/** Rough parcel count for a block, without subdividing it. Used for budgeting. */
export function estimateParcels(block: Block): number {
  const rule = DISTRICTS[block.district];
  return Math.max(1, Math.round((block.area / (rule.parcelArea * M2)) * 0.72));
}

export type { DistrictKind };
