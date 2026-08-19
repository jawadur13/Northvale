/**
 * City plan assembly.
 *
 * Turns one settlement feature into a plan: streets, superblocks, blocks and
 * districts. Parcels are *not* generated here — they are subdivided on demand by
 * `parcels.ts` when something actually looks closely at a block, because a large
 * city holds tens of thousands of them and nothing views more than a few hundred
 * at once.
 *
 * The whole plan is a pure function of the settlement's id and the terrain, so it
 * is stable across sessions and can be discarded and rebuilt freely.
 */

import { Rng } from '../../../util/rng';
import { clamp, TAU } from '../../../util/math';
import type { Feature } from '../../types';
import { blockOptions, subdivideIntoBlocks } from './blocks';
import { assignDistrict, maxBuildSlope } from './districts';
import { polyArea, polyCentroid, regularPolygon, type Poly } from './geometry2d';
import { buildStreetLayout } from './streets';
import { buildFortification } from './walls';
import { buildHarbour } from './harbour';
import {
  cityRadius,
  STREET_WIDTH,
  type Block,
  type CityContext,
  type CityPlan,
  type StreetSegment,
} from './types';

/** Distance from a point to the nearest water, sampled outward on a ring. */
function waterDistance(
  x: number,
  z: number,
  heightAt: (x: number, z: number) => number,
  maxKm: number,
): number {
  if (heightAt(x, z) <= 0) return 0;
  for (let r = 0.04; r <= maxKm; r *= 1.55) {
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * TAU;
      if (heightAt(x + Math.cos(ang) * r, z + Math.sin(ang) * r) <= 0) return r;
    }
  }
  return Infinity;
}

/**
 * How much larger a plot is than its town equivalent, by settlement tier.
 *
 * The district tables are written for a city, where land inside the wall is
 * expensive. Nobody in a hamlet is short of land, and the plots show it.
 */
const PLOT_SCALE: Record<CityContext['tier'], number> = {
  capital: 1,
  city: 1.05,
  town: 1.5,
  village: 2.7,
  hamlet: 3.4,
};

/**
 * The settlement tier as the city generator understands it.
 * Capitals and cities plan alike; the difference is size, not form.
 */
function tierOf(f: Feature): CityContext['tier'] {
  switch (f.kind) {
    case 'capital':
      return 'capital';
    case 'city':
      return 'city';
    case 'town':
      return 'town';
    case 'village':
      return 'village';
    default:
      return 'hamlet';
  }
}

export interface PlanInput {
  feature: Feature;
  culture: number;
  heightAt: (x: number, z: number) => number;
  slopeAt: (x: number, z: number) => number;
}

export function buildCityPlan(input: PlanInput): CityPlan {
  const { feature: f, culture, heightAt, slopeAt } = input;
  const seed = (f.id * 2654435761) ^ 0x5bf03635;
  const rng = new Rng(seed);

  const tier = tierOf(f);
  const population = f.population ?? 120;
  const radius = cityRadius(population, tier);
  const walled = (f.tags ?? []).includes('fortified');
  const coastal = (f.tags ?? []).includes('coastal');

  // Road approach bearings, supplied by the generator. A settlement with no
  // recorded approaches still gets a couple so the plan has a spine.
  const approaches: number[] = [];
  if (f.approaches && f.approaches.length) {
    for (let i = 0; i < f.approaches.length; i++) approaches.push(f.approaches[i]);
  }
  if (approaches.length === 0) {
    const base = rng.range(0, TAU);
    approaches.push(base, base + Math.PI + rng.range(-0.4, 0.4));
  }

  const ctx: CityContext = {
    heightAt,
    slopeAt,
    approaches,
    culture,
    walled,
    coastal,
    population,
    tier,
  };

  const layout = buildStreetLayout(f.x, f.z, radius, seed, ctx);

  // Trim streets back off unbuildable ground. The boundary polygon is convex, so
  // it can still enclose a river or a bluff that no block was placed on; without
  // this the plan shows streets running across open water to nowhere.
  layout.streets = trimStreets(layout.streets, heightAt);

  // --- Superblocks into blocks -------------------------------------------
  const dense = tier === 'capital' || tier === 'city' || tier === 'town';
  const rawBlocks: Poly[] = [];
  const blockRng = new Rng(seed ^ 0x1f2e3d);
  const sbCentre: [number, number] = [0, 0];
  for (const sb of layout.superblocks) {
    // Sized from where this superblock sits, so the grain of the plan coarsens
    // outward instead of being uniform across the whole town.
    polyCentroid(sb, sbCentre);
    const st = Math.hypot(sbCentre[0] - f.x, sbCentre[1] - f.z) / Math.max(radius, 1e-6);
    subdivideIntoBlocks(sb, blockOptions(radius, dense, st), blockRng, rawBlocks);
  }

  // --- Wall ---------------------------------------------------------------
  // A polygon a little outside the developable boundary. Blocks inside it are
  // walled; blocks outside grew after the wall was built.
  let wall: Float32Array | null = null;
  let wallRadius = Infinity;
  if (walled) {
    // The wall encloses the built-up core rather than the full sprawl.
    wallRadius = radius * 0.82;
    const ring = regularPolygon(f.x, f.z, wallRadius, Math.max(9, Math.min(18, Math.round(6 + radius * 4))), (i) =>
      0.94 + ((i * 2654435761) % 1000) / 1000 * 0.12,
    );
    // Nobody builds a curtain in the sea. Where the ring crosses water it is
    // pulled back to the shore — which is what a real wall does, because at the
    // waterline the water is the defence and the masonry stops.
    const n = ring.pts.length / 2;
    for (let i = 0; i < n; i++) {
      let px = ring.pts[i * 2];
      let pz = ring.pts[i * 2 + 1];
      if (heightAt(px, pz) > 0.001) continue;
      const dx = px - f.x;
      const dz = pz - f.z;
      const len = Math.hypot(dx, dz) || 1;
      for (let step = 0; step < 20; step++) {
        px -= (dx / len) * (wallRadius * 0.05);
        pz -= (dz / len) * (wallRadius * 0.05);
        if (heightAt(px, pz) > 0.001) break;
      }
      ring.pts[i * 2] = px;
      ring.pts[i * 2 + 1] = pz;
    }
    wall = ring.pts;
  }

  // --- Blocks: measure, filter, assign districts --------------------------
  const maxSlope = maxBuildSlope(culture);
  const blocks: Block[] = [];
  const tmp: [number, number] = [0, 0];

  const consider = (poly: Poly, forceDistrict?: Block['district']) => {
    const area = polyArea(poly);
    if (area < 1e-7) return;
    polyCentroid(poly, tmp);
    const cx = tmp[0];
    const cz = tmp[1];
    const groundKm = heightAt(cx, cz);
    // Nothing is built in the sea, and nothing is built on a cliff.
    if (groundKm <= 0.002) return;
    const slope = slopeAt(cx, cz);
    if (slope > maxSlope) return;

    const dist = Math.hypot(cx - f.x, cz - f.z);
    const t = clamp(dist / Math.max(radius, 1e-6), 0, 1.4);
    const isWalled = !walled || dist <= wallRadius;
    const waterKm = coastal ? waterDistance(cx, cz, heightAt, 0.55) : Infinity;

    const district =
      forceDistrict ??
      assignDistrict(
        {
          t,
          walled: isWalled,
          waterKm,
          // A block counts as being on a main street when it is close to a radial,
          // which for the radial form means close to one of the approach bearings.
          onPrimary: nearPrimary(cx - f.x, cz - f.z, approaches, dist, radius),
          slope,
          cx,
          cz,
        },
        ctx,
      );

    blocks.push({
      poly,
      district,
      cx,
      cz,
      area,
      t,
      groundKm,
      walled: isWalled,
      plotScale: PLOT_SCALE[ctx.tier],
      parcels: null,
      buildings: null,
      geom: { full: null, boxes: null, mass: null },
      flat: { built: null, plots: null, whole: null },
    });
  };

  for (const b of rawBlocks) consider(b);
  // The square or forum itself, left almost entirely open.
  if (layout.centre) consider(layout.centre, 'plaza');

  // --- Singular landmarks --------------------------------------------------
  // One temple precinct and one garrison per town, placed on specific blocks
  // rather than rolled for on every central block. A city has a cathedral; it
  // does not have a one-in-three chance of a cathedral on each street corner.
  if (tier !== 'village' && tier !== 'hamlet' && blocks.length > 12) {
    const byDistance = blocks
      .map((b, i) => ({ i, d: Math.hypot(b.cx - f.x, b.cz - f.z) }))
      .sort((a, b) => a.d - b.d);
    const pickRng = new Rng(seed ^ 0x77aa11);
    // The temple takes a good central block, but not the very middle - that is
    // the square.
    const templeSlot = byDistance[Math.min(byDistance.length - 1, 3 + pickRng.int(0, 5))];
    if (templeSlot) blocks[templeSlot.i].district = 'temple';
    if (radius > 1.4) {
      const second = byDistance[Math.min(byDistance.length - 1, 10 + pickRng.int(0, 8))];
      if (second) blocks[second.i].district = 'temple';
    }
    // The civic core: the first two blocks off the square.
    for (let k = 0; k < Math.min(2, byDistance.length); k++) {
      blocks[byDistance[k].i].district = 'civic';
    }
  }

  // --- Street length, for the stats readout -------------------------------
  let streetKm = 0;
  for (const s of layout.streets) {
    for (let i = 2; i < s.pts.length; i += 2) {
      streetKm += Math.hypot(s.pts[i] - s.pts[i - 2], s.pts[i + 1] - s.pts[i - 1]);
    }
  }

  return {
    featureId: f.id,
    name: f.name,
    cx: f.x,
    cz: f.z,
    radiusKm: radius,
    form: layout.form,
    culture,
    streets: layout.streets,
    blocks,
    wall,
    gates: layout.gates,
    // The wall as pieces, and the harbour works. Both are pure functions of the
    // ring, the gates and the terrain, so they belong to the plan rather than to
    // whatever happens to be drawing it.
    fort: wall ? buildFortification(wall, layout.gates, ctx, seed) : null,
    harbour: buildHarbour(f.x, f.z, radius, ctx, seed),
    works: null,
    ground: null,
    stats: { blocks: blocks.length, streetKm, parcels: 0 },
  };
}

/**
 * Splits street centrelines at unbuildable ground and drops the resulting stubs.
 *
 * Sampling rather than solving: streets are short and the terrain query is a
 * texture lookup, so walking the line at a fixed step is both simpler and more
 * robust than intersecting against a coastline that is itself only defined by
 * sampling.
 */
function trimStreets(
  streets: StreetSegment[],
  heightAt: (x: number, z: number) => number,
): StreetSegment[] {
  const out: StreetSegment[] = [];
  const STEP = 0.022; // ~22 m
  const MIN_RUN = 0.06; // discard anything shorter than 60 m

  for (const s of streets) {
    const n = s.pts.length / 2;
    if (n < 2) continue;

    // Resample the polyline at a fixed spacing so the buildability test has even
    // resolution regardless of how the centreline was generated.
    const dense: number[] = [];
    for (let i = 1; i < n; i++) {
      const ax = s.pts[i * 2 - 2];
      const az = s.pts[i * 2 - 1];
      const bx = s.pts[i * 2];
      const bz = s.pts[i * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / STEP));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        dense.push(ax + (bx - ax) * t, az + (bz - az) * t);
      }
    }
    dense.push(s.pts[(n - 1) * 2], s.pts[(n - 1) * 2 + 1]);

    let run: number[] = [];
    const flush = () => {
      if (run.length >= 4) {
        let len = 0;
        for (let i = 2; i < run.length; i += 2) {
          len += Math.hypot(run[i] - run[i - 2], run[i + 1] - run[i - 1]);
        }
        if (len >= MIN_RUN) {
          out.push({ pts: new Float32Array(run), klass: s.klass, widthKm: s.widthKm });
        }
      }
      run = [];
    };

    for (let i = 0; i < dense.length; i += 2) {
      if (heightAt(dense[i], dense[i + 1]) > 0.003) {
        run.push(dense[i], dense[i + 1]);
      } else {
        flush();
      }
    }
    flush();
  }
  return out;
}

/** Whether a point lies close to one of the through-street bearings. */
function nearPrimary(dx: number, dz: number, approaches: number[], dist: number, radius: number): boolean {
  if (dist < radius * 0.12) return true;
  const a = Math.atan2(dz, dx);
  // The angular half-width of a street's influence shrinks as you go out, so the
  // "on a main street" band stays roughly constant in metres.
  const halfWidth = clamp((STREET_WIDTH.primary * 3.5) / Math.max(dist, 0.05), 0.06, 0.5);
  for (const b of approaches) {
    if (Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) < halfWidth) return true;
  }
  return false;
}
