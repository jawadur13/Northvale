/**
 * Buildings.
 *
 * Every building is fitted to *its own plot* rather than stamped from a
 * prototype. That is the whole difference between a city and a field of boxes: a
 * plot is a long narrow strip because it was cut for frontage, so the house on it
 * stands narrow-side-to-the-street with its yard behind, and the street wall that
 * results is continuous and irregular in exactly the way a real one is. A library
 * of twenty prototypes scattered across the same plots would read as scenery.
 *
 * Form comes from culture, height from district, and both are already established
 * facts about the world rather than new inventions — the culture descriptions
 * written for the gazetteer say what these places are built of and how, and this
 * module is the first thing that makes those sentences true on the ground.
 *
 * Geometry is generated lazily per block, cached, and thrown away with the block.
 */

import { Rng } from '../../../util/rng';
import { clamp } from '../../../util/math';
import type { CultureInfo } from '../../types';
import {
  clipToConvex,
  extentAlong,
  longestEdge,
  polyArea,
  polyCentroid,
  rectanglePolygon,
  vertexCount,
  type Poly,
} from './geometry2d';
import { buildParcels } from './parcels';
import {
  DISTRICTS,
  type Block,
  type DistrictKind,
  type DistrictRule,
  type Parcel,
} from './types';

/** A footprint and the ridge line that goes with it. */
interface Footprint {
  poly: Poly;
  ridgeX: number;
  ridgeZ: number;
}

/**
 * Sets a rectangular building on a plot's street frontage.
 *
 * Slicing the street end off the plot, which is what this replaced, inherits the
 * plot's own shape - and plots are frequently triangles, because the blocks they
 * come from are. A quarter of triangular buildings reads as broken glass seen
 * from the air, not as a street.
 *
 * The rectangle is set square to the frontage, clipped back into the plot so it
 * can never overhang a neighbour, and capped in area so that a farmstead on four
 * acres is still a farmstead.
 */
function plotFootprint(
  parcel: Parcel,
  rule: DistrictRule,
  plotScale: number,
  rng: Rng,
): Footprint | null {
  const poly = parcel.poly;
  const n = vertexCount(poly);
  if (n < 3) return null;

  // The frontage edge, or the longest edge for a plot with no street at all.
  let i = parcel.frontage;
  if (i < 0 || i >= n) {
    const e = longestEdge(poly);
    if (!e) return null;
    i = e.index;
  }
  const j = (i + 1) % n;
  const ax = poly.pts[i * 2];
  const az = poly.pts[i * 2 + 1];
  const bx = poly.pts[j * 2];
  const bz = poly.pts[j * 2 + 1];
  let tx = bx - ax;
  let tz = bz - az;
  const frontage = Math.hypot(tx, tz);
  if (frontage < 1e-6) return null;
  tx /= frontage;
  tz /= frontage;

  // Inward normal: the one that points at the rest of the plot.
  const centre: [number, number] = [0, 0];
  polyCentroid(poly, centre);
  const mx = (ax + bx) * 0.5;
  const mz = (az + bz) * 0.5;
  let nx = -tz;
  let nz = tx;
  if ((centre[0] - mx) * nx + (centre[1] - mz) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }

  // How deep the plot runs back from this edge.
  const [lo, hi] = extentAlong(poly, nx, nz);
  const along = mx * nx + mz * nz;
  const behind = hi - along > along - lo ? hi - along : along - lo;
  if (behind < 0.004) return null;

  // How much of the plot is roofed. A cottage on a two-acre plot is still a
  // cottage: the house does not grow with the land around it, so the fraction it
  // covers shrinks as the plots get bigger.
  const cover = clamp((1 - rule.openness) / Math.pow(plotScale, 0.9), 0.1, 0.95);
  // The district's own plot area also sets the scale of building it expects,
  // which stops a village farmstead coming out the size of a city block.
  const maxArea = rule.parcelArea * (1 - rule.openness) * 1.7e-6;
  const area = Math.min(polyArea(poly) * cover * rng.range(0.86, 1.14), maxArea);

  // Area first, then an aspect. Sizing by a fraction of the plot's depth instead
  // gives a wide shallow plot a building three metres front to back, and a
  // quarter of those reads as fencing rather than as houses.
  let depth = Math.sqrt(area / 1.7);
  let width = area / depth;
  if (width > frontage * 0.95) {
    // Frontage-limited, as a burgage plot always is. The depth takes up the
    // slack, but only as far as an aspect that still reads as a building.
    width = frontage * rng.range(0.8, 0.95);
    depth = Math.min(area / width, width * 1.8);
  }
  depth = clamp(depth, 0.006, Math.max(0.005, behind - 0.0012));
  // A plot too shallow for the depth the area wanted gets a *shorter* building,
  // not a thinner one. Without this, a wide shallow plot yields a five-metre-deep
  // range thirty metres long, which from the air reads as a wall.
  width = clamp(width, 0.005, depth * 3.2);

  // Buildings come almost to the plot edge, which is what produces a continuous
  // street wall rather than a row of detached sheds.
  const setback = 0.0007;
  const rect = rectanglePolygon(
    mx + nx * (setback + depth * 0.5),
    mz + nz * (setback + depth * 0.5),
    width * 0.5,
    depth * 0.5,
    Math.atan2(tz, tx),
  );
  const clipped = clipToConvex(rect, poly);
  if (!clipped || vertexCount(clipped) < 3) return null;

  // The ridge runs along the longer side, as a roof does.
  const alongFrontage = width >= depth;
  return {
    poly: clipped,
    ridgeX: alongFrontage ? tx : nx,
    ridgeZ: alongFrontage ? tz : nz,
  };
}

/**
 * The roof forms, all produced by one routine: the eaves ring is projected onto a
 * ridge *segment*, and the segment decides the form. A full-length ridge gives a
 * gable, a shortened one a hip, a degenerate one a pyramid, and no rise at all a
 * flat roof.
 */
export type RoofForm = 'gable' | 'hip' | 'pyramid' | 'flat';

/** One building, in world kilometres, ready to be extruded. */
export interface BuildingSpec {
  /** Footprint, inset from the plot. */
  poly: Poly;
  /** Anchor point where the ground height is sampled, in world km. */
  ax: number;
  az: number;
  /** Eaves height above ground, in km. True scale - buildings are not exaggerated. */
  height: number;
  roof: RoofForm;
  /** Ridge rise above the eaves, in km. Zero for a flat roof. */
  roofHeight: number;
  /** Unit ridge direction in the ground plane. */
  ridgeX: number;
  ridgeZ: number;
  /** A tower or spire on this building; height above the eaves in km, 0 for none. */
  tower: number;
  /** Packed 0..1 colours. */
  wall: [number, number, number];
  roofColor: [number, number, number];
}

/** How each culture builds. Storey heights are in kilometres. */
interface ArchStyle {
  storey: number;
  roof: RoofForm;
  /** Ridge rise as a fraction of the footprint's half-width. */
  pitch: number;
  /** Fraction of large plots given over to a courtyard. */
  courtyard: number;
  /** Height variation between neighbours, 0..1. */
  jitter: number;
  /**
   * Roofing materials in use, packed RGB.
   *
   * A quarter roofed in one colour reads as a printed texture from the air; a
   * quarter roofed in three reads as a town. Real streets mix thatch, tile and
   * slate because they were re-roofed at different times by different people.
   */
  roofs: number[];
}

const STYLES: Record<CultureInfo['architecture'], ArchStyle> = {
  // Pale stone, low pitch, courtyards, and a storey height that shows off.
  marble: { roofs: [0xb06a4a, 0xc4bbaa, 0x8b8f92], storey: 0.0039, roof: 'hip', pitch: 0.3, courtyard: 0.36, jitter: 0.14 },
  // Jettied timber frames under steep thatch and tile.
  timber: { roofs: [0xa08a5c, 0x8f5236, 0x5a5652], storey: 0.0031, roof: 'gable', pitch: 0.78, courtyard: 0.08, jitter: 0.24 },
  // Low turf-roofed halls built heavy against the wind.
  nordic: { roofs: [0x4f5c3e, 0x3c4247, 0x6b6862], storey: 0.0026, roof: 'gable', pitch: 0.95, courtyard: 0.03, jitter: 0.2 },
  // Flat roofs, thick walls, and a courtyard in everything worth the name.
  adobe: { roofs: [0xc7a173, 0xae8a60, 0xd3b587], storey: 0.0033, roof: 'flat', pitch: 0, courtyard: 0.46, jitter: 0.12 },
  // Raised floors and very steep reed thatch that sheds a monsoon.
  reed: { roofs: [0x8e7a4a, 0xa08a55, 0x776540], storey: 0.0031, roof: 'gable', pitch: 1.05, courtyard: 0.02, jitter: 0.22 },
  // Stepped terraces; roofs double as the floor of the house above.
  terrace: { roofs: [0x7d5c4a, 0x8b7360, 0x9a8468], storey: 0.0030, roof: 'flat', pitch: 0.1, courtyard: 0.22, jitter: 0.3 },
  // Stone walls, stone roofs, nothing expected to burn or rot.
  stone: { roofs: [0x6e6a63, 0x4a4a4f, 0x5c6350], storey: 0.0033, roof: 'gable', pitch: 0.52, courtyard: 0.06, jitter: 0.16 },
};

/** Storey count range and storey-height multiplier, by district. */
const DISTRICT_FORM: Record<DistrictKind, { lo: number; hi: number; scale: number; tower: number }> = {
  plaza: { lo: 1, hi: 2, scale: 1.1, tower: 0.04 },
  civic: { lo: 3, hi: 5, scale: 1.35, tower: 0.32 },
  market: { lo: 2, hi: 3, scale: 1.15, tower: 0.06 },
  temple: { lo: 2, hi: 4, scale: 1.6, tower: 0.62 },
  artisan: { lo: 2, hi: 4, scale: 1, tower: 0.01 },
  residential: { lo: 1, hi: 3, scale: 1, tower: 0.008 },
  suburb: { lo: 1, hi: 2, scale: 1, tower: 0.004 },
  docks: { lo: 1, hi: 3, scale: 1.25, tower: 0.02 },
  warehouse: { lo: 2, hi: 3, scale: 1.45, tower: 0.01 },
  garrison: { lo: 2, hi: 3, scale: 1.2, tower: 0.22 },
  shanty: { lo: 1, hi: 1, scale: 0.82, tower: 0 },
  orchard: { lo: 1, hi: 2, scale: 0.95, tower: 0.006 },
};

function unpack(rgb: number): [number, number, number] {
  return [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255];
}

/**
 * What a whole block reads as from the air, without raising the buildings that
 * make it.
 *
 * The massing tier draws one prism per block, and paying for every house on the
 * block purely to average them is the single largest cost in filling a city.
 * That average has a closed form: the storey range is fixed by the district, the
 * storey height by the culture, and the per-building jitter is symmetric, so it
 * cancels. The colours are the same means taken over the same tables.
 *
 * Returns null for blocks too open to read as a solid mass — a plaza or an
 * orchard is mostly not building, and a prism over it would be a lie visible
 * from any angle.
 */
export function estimateBlockMass(
  block: Block,
  cultureInfo: CultureInfo,
): { height: number; wall: [number, number, number]; roof: [number, number, number] } | null {
  const rule = DISTRICTS[block.district];
  if (rule.openness > 0.55) return null;

  const style = STYLES[cultureInfo.architecture] ?? STYLES.stone;
  const form = DISTRICT_FORM[block.district] ?? DISTRICT_FORM.residential;

  // Mean storeys, less the reduction applied to plots with no street frontage.
  const storeys = (form.lo + form.hi) / 2 - 0.3;
  const eaves = Math.max(0.0022, storeys * style.storey * form.scale);
  // The cap sits between eaves and ridge, as it does in the boxed tier, so the
  // skyline does not step when a block crosses the boundary.
  const height = eaves * (1 + style.pitch * 0.13);

  const baseWall = unpack(cultureInfo.wallColor);
  const wall: [number, number, number] = [baseWall[0], baseWall[1], baseWall[2]];

  const roof: [number, number, number] = [0, 0, 0];
  for (const packed of style.roofs) {
    const c = unpack(packed);
    roof[0] += c[0];
    roof[1] += c[1];
    roof[2] += c[2];
  }
  const inv = 1 / Math.max(1, style.roofs.length);
  roof[0] *= inv;
  roof[1] *= inv;
  roof[2] *= inv;

  return { height, wall, roof };
}

/**
 * Generates the buildings for one block, caching the result on it.
 *
 * The buildings sit on parcels, so this implicitly materialises them.
 */
export function buildBuildings(
  block: Block,
  culture: number,
  cultureInfo: CultureInfo,
  seed: number,
): BuildingSpec[] {
  if (block.buildings) return block.buildings;

  const parcels = buildParcels(block, culture, seed);
  const style = STYLES[cultureInfo.architecture] ?? STYLES.stone;
  const form = DISTRICT_FORM[block.district] ?? DISTRICT_FORM.residential;
  const baseWall = unpack(cultureInfo.wallColor);

  const out: BuildingSpec[] = [];
  const centroid: [number, number] = [0, 0];

  for (const parcel of parcels) {
    const rng = new Rng(
      (seed ^ Math.round(parcel.poly.pts[0] * 65537) ^ Math.round(parcel.poly.pts[1] * 31)) | 0,
    );

    // The house stands on the street frontage; the rest of the plot is yard and
    // garden. How much it takes depends on the district: a warehouse covers its
    // whole site, a suburban villa sits in the middle of a garden.
    const rule = DISTRICTS[block.district];
    const fp = plotFootprint(parcel, rule, block.plotScale, rng);
    if (!fp) continue;
    const footprint = fp.poly;
    const area = polyArea(footprint);
    if (area < 22e-6) continue;

    polyCentroid(footprint, centroid);

    // --- Height ---
    let storeys = form.lo + Math.floor(rng.next() * (form.hi - form.lo + 1));
    // Corner and frontage plots build higher; back plots stay low.
    if (parcel.frontage < 0 && storeys > 1) storeys -= 1;
    const jitter = 1 + rng.range(-style.jitter, style.jitter);
    const height = Math.max(0.0022, storeys * style.storey * form.scale * jitter);

    // --- Ridge direction ---
    // Along the longer side of the footprint, which for a plot narrower than it
    // is deep turns the gable to the street - the pattern that makes a terraced
    // street read as terraced.
    const ridgeX = fp.ridgeX;
    const ridgeZ = fp.ridgeZ;

    // --- Roof ---
    const roof: RoofForm = style.roof;
    // The rise is measured *across* the ridge, because that is the span the
    // rafters actually cross. Taking it from the footprint as a whole gives a
    // long narrow house a roof three times the height of its walls, and a street
    // of those reads as a row of tents.
    const [lo, hi] = extentAlong(footprint, -ridgeZ, ridgeX);
    const across = hi - lo;
    const roofHeight =
      roof === 'flat' ? 0 : Math.min(across * 0.5 * style.pitch, height * 1.9) * rng.range(0.85, 1.15);

    // --- Tower ---
    const tower = rng.next() < form.tower ? height * rng.range(0.8, 2.2) + 0.004 : 0;

    // --- Colour ---
    // Per-building variation, plus a warm/cool shift so a street is not one hue.
    const v = 0.84 + rng.next() * 0.32;
    const warm = 0.96 + rng.next() * 0.09;
    const wall: [number, number, number] = [
      clamp(baseWall[0] * v * warm, 0, 1),
      clamp(baseWall[1] * v, 0, 1),
      clamp(baseWall[2] * v * (2 - warm), 0, 1),
    ];
    // Roofing material, then a shade within it.
    const pick = style.roofs[Math.floor(rng.next() * style.roofs.length)] ?? cultureInfo.roofColor;
    const chosen = unpack(pick);
    const rv = 0.84 + rng.next() * 0.3;
    const roofColor: [number, number, number] = [
      clamp(chosen[0] * rv, 0, 1),
      clamp(chosen[1] * rv, 0, 1),
      clamp(chosen[2] * rv, 0, 1),
    ];

    out.push({
      poly: footprint,
      ax: centroid[0],
      az: centroid[1],
      height,
      roof,
      roofHeight,
      ridgeX,
      ridgeZ,
      tower,
      wall,
      roofColor,
    });
  }

  block.buildings = out;
  return out;
}

/** Rough vertex cost of a building at full detail, for budgeting. */
export function buildingVertexCost(spec: BuildingSpec): number {
  const n = vertexCount(spec.poly);
  // Walls are four vertices per edge; the roof is a tent of two triangles per
  // edge, or a single cap when flat.
  return n * 4 + (spec.roof === 'flat' ? n : n * 6) + (spec.tower > 0 ? 20 : 0);
}
