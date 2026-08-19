/**
 * Superblocks into blocks.
 *
 * A superblock is whatever the street network left between its primary and
 * secondary streets. It is usually far too large to be a city block, so it is cut
 * down by lanes until every piece is small enough to be walked around.
 *
 * The cut direction is chosen to keep blocks *elongated along their street*
 * rather than square. That single rule is most of what separates a plan that
 * reads as a town from one that reads as graph paper: real blocks are long and
 * narrow because frontage on a street is the valuable thing and depth is not.
 */

import { Rng } from '../../../util/rng';
import { clamp } from '../../../util/math';
import { longestEdge, polyArea, splitConvex, extentAlong, type Poly } from './geometry2d';

export interface BlockOptions {
  /** Target block area in square kilometres. */
  targetArea: number;
  /** Never emit a block smaller than this. */
  minArea: number;
  /** Stop recursing past this depth, whatever the area. */
  maxDepth: number;
  /** How far the cut may wander from the middle, as a fraction of the span. */
  jitter: number;
}

/**
 * Recursively halves a convex polygon until the pieces are near the target area.
 *
 * Each cut becomes a lane, so the resulting pieces are correctly flagged as
 * fronting a street on their new edge - which is what lets the parcel stage give
 * every plot real frontage.
 */
export function subdivideIntoBlocks(poly: Poly, opts: BlockOptions, rng: Rng, out: Poly[], depth = 0): void {
  const area = polyArea(poly);
  if (area <= opts.targetArea || depth >= opts.maxDepth) {
    if (area >= opts.minArea) out.push(poly);
    return;
  }

  // Cut across the polygon's long axis. Using the longest edge as the axis
  // reference keeps the cut square to the street rather than diagonal to it.
  const edge = longestEdge(poly, (i) => poly.street[i] === 1) ?? longestEdge(poly);
  if (!edge) {
    out.push(poly);
    return;
  }

  // Perpendicular to the street edge, and the extent along it.
  const px = -edge.dz;
  const pz = edge.dx;
  const [alongLo, alongHi] = extentAlong(poly, edge.dx, edge.dz);
  const [deepLo, deepHi] = extentAlong(poly, px, pz);
  const alongSpan = alongHi - alongLo;
  const deepSpan = deepHi - deepLo;

  // Cut across whichever axis is longer, so blocks tend toward a 2:1 ratio rather
  // than toward slivers.
  let dirX: number;
  let dirZ: number;
  let span: number;
  let lo: number;
  if (alongSpan >= deepSpan) {
    // Cut perpendicular to the street: shortens the frontage run.
    dirX = px;
    dirZ = pz;
    span = alongSpan;
    lo = alongLo;
  } else {
    // Cut parallel to the street: creates a back block.
    dirX = edge.dx;
    dirZ = edge.dz;
    span = deepSpan;
    lo = deepLo;
  }

  const axisX = alongSpan >= deepSpan ? edge.dx : px;
  const axisZ = alongSpan >= deepSpan ? edge.dz : pz;
  const t = lo + span * (0.5 + rng.range(-opts.jitter, opts.jitter));
  const ox = axisX * t;
  const oz = axisZ * t;

  const res = splitConvex(poly, ox, oz, dirX, dirZ, true);
  if (!res.left || !res.right) {
    if (area >= opts.minArea) out.push(poly);
    return;
  }
  subdivideIntoBlocks(res.left, opts, rng, out, depth + 1);
  subdivideIntoBlocks(res.right, opts, rng, out, depth + 1);
}

/**
 * Block sizing.
 *
 * @param t normalised distance from the city centre
 *
 * Block size grows outward, and steeply. The core of a town is a warren of small
 * blocks because the land was worth subdividing; the edge is large plots and long
 * garden strips because it was not. A single target area for the whole town
 * produces a uniform grain that reads as wallpaper.
 */
export function blockOptions(radiusKm: number, dense: boolean, t = 0.5): BlockOptions {
  // Roughly 70 m x 50 m in a dense core.
  const base = dense ? 0.0034 : 0.0085;
  const outward = 1 + Math.pow(clamp(t, 0, 1.3), 1.6) * 2.6;
  const scaled = base * clamp(0.7 + radiusKm * 0.32, 0.7, 1.9) * outward;
  return {
    targetArea: scaled,
    minArea: scaled * 0.15,
    maxDepth: 7,
    jitter: 0.13,
  };
}
