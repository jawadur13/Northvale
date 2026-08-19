/**
 * District assignment.
 *
 * Every block is asked the same four questions a real quarter answers: how far
 * from the centre is it, is it inside the wall, does it front navigable water,
 * and is it on a main street. Those four give a surprisingly complete answer,
 * because they are the actual economics — land near the centre is expensive and
 * gets built dense, land on the water gets built for cargo, land outside the wall
 * gets built by whoever could not afford to be inside it.
 *
 * The assignment is deterministic given the block's position, so a district does
 * not shuffle when the plan is regenerated from cache.
 */

import { hash2 } from '../../../util/rng';
import { clamp01 } from '../../../util/math';
import type { CityContext, DistrictKind } from './types';

export interface DistrictInput {
  /** Normalised distance from the city centre, 0 at the middle, 1 at the edge. */
  t: number;
  /** Inside the curtain wall. */
  walled: boolean;
  /** Distance to open water in km; Infinity when inland. */
  waterKm: number;
  /** True when the block touches a primary street. */
  onPrimary: boolean;
  /** Local terrain gradient, 0..1. */
  slope: number;
  /** Block centroid, used only as a deterministic hash source. */
  cx: number;
  cz: number;
}

/**
 * Picks a district for one block.
 *
 * Order matters: the strongest claims are tested first. Waterfront beats
 * everything, because a quay is worth more than any amount of centrality; the
 * civic core beats residential; and anything left outside the wall is whatever
 * grew there.
 */
export function assignDistrict(input: DistrictInput, ctx: CityContext): DistrictKind {
  const { t, walled, waterKm, onPrimary, slope } = input;
  // Two independent deterministic rolls, so ties break consistently without the
  // districts correlating with each other.
  const r1 = hash2(Math.round(input.cx * 800), Math.round(input.cz * 800), 0x51a3);
  const r2 = hash2(Math.round(input.cx * 800), Math.round(input.cz * 800), 0x9c27);

  // Villages and hamlets do not have quarters. They have houses and gardens.
  if (ctx.tier === 'village' || ctx.tier === 'hamlet') {
    if (t > 0.72 || slope > 0.34) return 'orchard';
    return 'residential';
  }

  // --- Waterfront ---
  if (ctx.coastal && waterKm < 0.11) {
    return t < 0.66 || r1 < 0.55 ? 'docks' : 'warehouse';
  }
  if (ctx.coastal && waterKm < 0.26 && r1 < 0.6) return 'warehouse';

  // --- Outside the wall ---
  if (ctx.walled && !walled) {
    if (slope > 0.3 || t > 0.9) return 'orchard';
    return r1 < 0.62 ? 'shanty' : 'suburb';
  }

  // --- The core ---
  // Deliberately *not* probabilistic. A city has one civic core and one or two
  // temple precincts, not a thirty-percent chance of a temple on every central
  // block, which is what a dice roll here produces and what makes a plan read as
  // confetti. The singular buildings are placed explicitly by the planner; this
  // only decides the surrounding fabric.
  if (t < 0.11) return 'civic';
  if (t < 0.22) return onPrimary ? 'market' : 'artisan';

  // --- Garrison: against the wall, away from the water ---
  if (ctx.walled && walled && t > 0.72 && r2 < 0.14) return 'garrison';

  // --- The working town ---
  if (t < 0.5) {
    // Trades cluster on the through-streets, where the customers are.
    if (onPrimary && r1 < 0.66) return 'artisan';
    return r2 < 0.22 ? 'artisan' : 'residential';
  }

  // --- The edge ---
  if (t > 0.84 && !ctx.walled) return r1 < 0.5 ? 'suburb' : 'orchard';
  if (slope > 0.36) return 'orchard';
  return r2 < 0.2 ? 'suburb' : 'residential';
}

/**
 * How likely a block of this district is to be *built* rather than left open.
 *
 * Used by the plan renderer to leave courts, yards and green space, which is what
 * stops a town reading as a solid mat of roofs.
 */
export function builtFraction(kind: DistrictKind, r: number, t = 0.5): number {
  // Density falls off toward the edge of every real town: the last streets are
  // half-built and the plots are big. Without this the city is a uniform mat of
  // roofs right up to the boundary and reads as a printed texture.
  const edge = 1 - clamp01((t - 0.42) / 0.75) * 0.62;
  return rawBuiltFraction(kind, r) * edge;
}

function rawBuiltFraction(kind: DistrictKind, r: number): number {
  switch (kind) {
    case 'plaza':
      return 0.05 + r * 0.06;
    case 'market':
      return 0.28 + r * 0.2;
    case 'orchard':
      return 0.1 + r * 0.16;
    case 'civic':
    case 'temple':
      return 0.5 + r * 0.2;
    case 'shanty':
      return 0.82 + r * 0.14;
    case 'artisan':
      return 0.78 + r * 0.16;
    case 'residential':
      return 0.7 + r * 0.2;
    case 'suburb':
      return 0.42 + r * 0.22;
    case 'docks':
    case 'warehouse':
      return 0.62 + r * 0.2;
    case 'garrison':
      return 0.55 + r * 0.18;
    default:
      return 0.65;
  }
}

/** Slope above which nobody bothers building, by culture. */
export function maxBuildSlope(culture: number): number {
  // 5 Kethic terrace their hillsides and will build on anything.
  return culture === 5 ? 0.62 : 0.46;
}

export { clamp01 };
