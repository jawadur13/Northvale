/**
 * Field systems.
 *
 * The layer between the last house and the wilderness, which is most of the
 * inhabited world and until now was bare ground. A town of twenty-six thousand
 * people eats; the ring of worked land around it is several times the area of the
 * town itself, and from the air it is the single most legible sign that anyone
 * lives there.
 *
 * The belt is built as an annulus of sectors, each subdivided by the same
 * recursive halving that cuts city blocks — which is not a shortcut but the right
 * shape: a field is a convex parcel bounded by its neighbours, cut off the long
 * axis of whatever it was cut from, exactly like a burgage plot. Only the target
 * area and what happens at the boundary differ.
 *
 * What a boundary *is* comes from the ground. Hedge where hedges grow, dry-stone
 * wall where the fields are full of stone and nothing grows tall, bank and ditch
 * in wet country. It is drawn as the parcel's own outline: the whole parcel in the
 * boundary colour with the crop laid inside it, so a hedged field is two polygons
 * rather than a polygon and a ribbon.
 */

import { Rng } from '../../../util/rng';
import { clamp, TAU } from '../../../util/math';
import { BIOME_BY_ID, Biome } from '../biomes';
import { subdivideIntoBlocks } from '../city/blocks';
import {
  insetConvex,
  makePoly,
  polyArea,
  polyCentroid,
  ensureCCW,
  longestEdge,
  type Poly,
} from '../city/geometry2d';
import type { CityContext } from '../city/types';

/** One worked parcel. */
export interface FieldParcel {
  poly: Poly;
  /** The crop, packed RGB. */
  crop: number;
  /** The boundary — hedge, wall or bank — packed RGB. */
  boundary: number;
  /** Half-width of the boundary in km, which is how wide it is drawn. */
  boundaryKm: number;
}

/** A farmstead: a house and a barn about a yard. */
export interface Farmstead {
  x: number;
  z: number;
  /** Bearing the yard faces, radians. */
  angle: number;
  /** House and barn footprints and heights, in km. */
  houseW: number;
  houseD: number;
  houseH: number;
  barnW: number;
  barnD: number;
  barnH: number;
}

export interface FieldSystem {
  parcels: FieldParcel[];
  farms: Farmstead[];
}

/** What a field boundary is made of, and what it costs to cross. */
type BoundaryKind = 'hedge' | 'wall' | 'bank';

/**
 * Crop colours, in rotation.
 *
 * Four is not arbitrary: a three-field rotation plus pasture is what most of this
 * world's cultures would be running, and four distinct colours is also about the
 * most the eye will read as *different fields* rather than as noise.
 */
const CROPS = [
  0x8f9350, // standing corn, going over
  0x6f7c40, // green crop
  0x9a8a5f, // stubble and fallow
  0x74854a, // pasture
];

/** Boundary colours by kind. */
const BOUNDARY: Record<BoundaryKind, number> = {
  hedge: 0x3f5233,
  wall: 0x8a857a,
  bank: 0x6a6146,
};

/** Which boundary a place builds, from what the ground gives it. */
function boundaryFor(biome: number, slope: number): BoundaryKind {
  const def = BIOME_BY_ID[biome];
  if (!def) return 'hedge';
  if (def.group === 'wetland') return 'bank';
  // Stone country, or too high and exposed for a hedge to thrive.
  if (def.group === 'alpine' || def.group === 'arid' || slope > 0.22) return 'wall';
  return 'hedge';
}

/**
 * Builds the field belt around one settlement.
 *
 * The inner edge sits just outside the built ground and the outer edge at a
 * multiple of the town's own radius — a bigger town works more land, and works it
 * further out, because the near land is already taken.
 */
export function buildFields(
  cx: number,
  cz: number,
  radiusKm: number,
  ctx: CityContext,
  seed: number,
): FieldSystem {
  const rng = new Rng(seed ^ 0x1e1d5);
  const parcels: FieldParcel[] = [];
  const farms: Farmstead[] = [];

  // How far the worked land reaches. A day's walk out and back with a cart is the
  // real limit, which for a village is most of its belt and for a city is a small
  // fraction of what it eats — cities import, and the rest of the ring is other
  // people's villages, which have their own belts.
  const inner = radiusKm * 1.02;
  const outer = radiusKm * (ctx.tier === 'capital' || ctx.tier === 'city' ? 1.9 : 2.7);
  if (outer - inner < 0.05) return { parcels, farms };

  // Sectors: enough that each is a workable shape rather than a wedge, and the
  // count rises with the ring so they stay a similar size whatever the town is.
  const sectors = Math.max(10, Math.min(40, Math.round(inner * 9)));
  const centre: [number, number] = [0, 0];

  // Target parcel, in square kilometres: a hectare and a bit for a village's
  // strips, four for a city's larger enclosures. One square kilometre is a
  // hundred hectares, which is the conversion this got wrong the first time —
  // an eighteen-hectare field written as 0.00004 is forty square metres, and the
  // result was a landscape of allotments.
  const targetArea = 0.018 * clamp(0.7 + radiusKm * 0.55, 0.7, 2.4);

  for (let s = 0; s < sectors; s++) {
    const a0 = (s / sectors) * TAU;
    const a1 = ((s + 1) / sectors) * TAU;
    // A trapezoid between the two radii. Convex, which everything downstream
    // relies on, and close enough to an annular sector at these proportions.
    const jitterOut = outer * rng.range(0.82, 1.12);
    const sector = ensureCCW(
      makePoly([
        cx + Math.cos(a0) * inner,
        cz + Math.sin(a0) * inner,
        cx + Math.cos(a1) * inner,
        cz + Math.sin(a1) * inner,
        cx + Math.cos(a1) * jitterOut,
        cz + Math.sin(a1) * jitterOut,
        cx + Math.cos(a0) * jitterOut,
        cz + Math.sin(a0) * jitterOut,
      ]),
    );

    const pieces: Poly[] = [];
    subdivideIntoBlocks(
      sector,
      // Depth nine, not the seven a city block gets: a sector of the ring is a
      // couple of hundred times the area of a field, and stopping too early
      // leaves parcels several times the size they should be.
      { targetArea, minArea: targetArea * 0.3, maxDepth: 9, jitter: 0.2 },
      rng,
      pieces,
    );

    for (const piece of pieces) {
      polyCentroid(piece, centre);
      const px = centre[0];
      const pz = centre[1];

      const h = ctx.heightAt(px, pz);
      if (h <= 0.002) continue;
      const slope = ctx.slopeAt(px, pz);
      // Nobody ploughs a hillside. Above about one in three it is rough grazing,
      // which the vegetation layer already draws.
      if (slope > 0.34) continue;

      const biome = biomeAt(px, pz, ctx);
      const def = BIOME_BY_ID[biome];
      if (!def || def.fertility < 0.12) continue;
      if (
        biome === Biome.Ocean ||
        biome === Biome.DeepOcean ||
        biome === Biome.Shelf ||
        biome === Biome.Lake
      ) {
        continue;
      }

      // Not every parcel in the ring is worked. The further out, the more of it is
      // waste, wood and common — which is what keeps the belt from reading as a
      // dartboard drawn round the town.
      const t = Math.hypot(px - cx, pz - cz) / Math.max(outer, 1e-6);
      const worked = clamp(1.25 - t * 0.85, 0.15, 1) * clamp(def.fertility * 1.5, 0.2, 1);
      if (rng.next() > worked) continue;

      const kind = boundaryFor(biome, slope);
      parcels.push({
        poly: piece,
        crop: CROPS[Math.floor(rng.next() * CROPS.length)],
        boundary: BOUNDARY[kind],
        // A hedge is a couple of metres of thicket; a wall is a metre of stone.
        boundaryKm: kind === 'wall' ? 0.0013 : 0.0026,
      });

      // A farmstead on a small share of parcels, out among the fields rather than
      // in the town — which is the difference between a landscape of villages and
      // a landscape of isolated farms, and both exist here.
      if (rng.next() < 0.085 && polyArea(piece) > targetArea * 0.6) {
        const edge = longestEdge(piece);
        const angle = edge ? Math.atan2(edge.dz, edge.dx) : rng.range(0, TAU);
        const scale = 0.85 + rng.next() * 0.5;
        farms.push({
          x: px,
          z: pz,
          angle,
          houseW: 0.011 * scale,
          houseD: 0.007 * scale,
          houseH: 0.0055 * scale,
          barnW: 0.016 * scale,
          barnD: 0.008 * scale,
          barnH: 0.0068 * scale,
        });
      }
    }
  }

  return { parcels, farms };
}

/** The crop area of a parcel, inside its boundary. */
export function cropPoly(parcel: FieldParcel): Poly | null {
  return insetConvex(parcel.poly, parcel.boundaryKm);
}

/** Biome id at a world position, via the context's sampler. */
function biomeAt(x: number, z: number, ctx: CityContext): number {
  return ctx.biomeAt ? ctx.biomeAt(x, z) : Biome.Grassland;
}
