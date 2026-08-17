/**
 * Vector geometry, built in the worker so the main thread never has to.
 *
 * Rivers and roads are ribbons rather than lines, because a line has one width
 * in pixels and a river has a width in kilometres that varies with discharge.
 * The ribbons carry a per-vertex side and half-width, and the vertex shader
 * expands them with a floor on the on-screen width - so a river is
 * hydrologically correct when you are close to it and still legible when you are
 * four thousand kilometres away, which is exactly how a printed atlas behaves.
 *
 * Every vertex stores its elevation in kilometres rather than a final Y, so
 * changing the vertical exaggeration slider does not require rebuilding a
 * single buffer.
 */

import { FINE, MACRO, SEA_LEVEL, WORLD_KM, HALF_KM, macroToWorldX, macroToWorldZ } from '../../core/config';
import { marchingSquares } from '../../util/contour';
import { Field } from '../../util/grid';
import { clamp } from '../../util/math';
import type { HydrologyResult, RiverPath } from './hydrology';
import { riverHalfWidth } from './hydrology';
import type { RoadClass, RoadPath } from './roads';

/** Ribbon vertex layout, ready for THREE.BufferAttribute. */
export interface RibbonGeometry {
  /** x, heightKm, z */
  positions: Float32Array;
  /** perpendicular x, z (unit, in the ground plane) */
  perp: Float32Array;
  /** side (-1 or +1), halfWidthKm, alongLengthKm, kindFlag */
  params: Float32Array;
  indices: Uint32Array;
}

interface RibbonBuilder {
  pos: number[];
  perp: number[];
  params: number[];
  idx: number[];
  vertex: number;
}

function newBuilder(): RibbonBuilder {
  return { pos: [], perp: [], params: [], idx: [], vertex: 0 };
}

function finishBuilder(b: RibbonBuilder): RibbonGeometry {
  return {
    positions: new Float32Array(b.pos),
    perp: new Float32Array(b.perp),
    params: new Float32Array(b.params),
    indices: new Uint32Array(b.idx),
  };
}

/**
 * Appends one ribbon along a polyline.
 *
 * @param pts flat world x,z pairs
 * @param heightAt returns elevation in km at a world position
 * @param halfWidthAt returns half-width in km at vertex i
 * @param kindFlag passed through to the shader for styling
 */
function addRibbon(
  b: RibbonBuilder,
  pts: Float32Array,
  heightAt: (x: number, z: number) => number,
  halfWidthAt: (i: number) => number,
  kindFlag: number,
): void {
  const n = pts.length / 2;
  if (n < 2) return;

  let along = 0;
  const startVertex = b.vertex;

  for (let i = 0; i < n; i++) {
    const x = pts[i * 2];
    const z = pts[i * 2 + 1];

    // Tangent from the neighbours, so joints miter smoothly.
    const px = pts[Math.max(0, i - 1) * 2];
    const pz = pts[Math.max(0, i - 1) * 2 + 1];
    const nx2 = pts[Math.min(n - 1, i + 1) * 2];
    const nz2 = pts[Math.min(n - 1, i + 1) * 2 + 1];
    let tx = nx2 - px;
    let tz = nz2 - pz;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    // Perpendicular in the ground plane.
    const perpX = -tz;
    const perpZ = tx;

    if (i > 0) {
      along += Math.hypot(x - pts[i * 2 - 2], z - pts[i * 2 - 1]);
    }

    const y = heightAt(x, z);
    const hw = halfWidthAt(i);

    for (let s = 0; s < 2; s++) {
      b.pos.push(x, y, z);
      b.perp.push(perpX, perpZ);
      b.params.push(s === 0 ? -1 : 1, hw, along, kindFlag);
      b.vertex++;
    }

    if (i > 0) {
      const a = startVertex + (i - 1) * 2;
      b.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
}

/** Catmull-Rom resample of a polyline to a target spacing, in world km. */
export function resamplePolyline(pts: Float32Array, spacingKm: number): Float32Array {
  const n = pts.length / 2;
  if (n < 3) return pts;

  const get = (i: number, c: number) => pts[clamp(i, 0, n - 1) * 2 + c];
  const out: number[] = [];

  for (let i = 0; i < n - 1; i++) {
    const x0 = get(i - 1, 0);
    const z0 = get(i - 1, 1);
    const x1 = get(i, 0);
    const z1 = get(i, 1);
    const x2 = get(i + 1, 0);
    const z2 = get(i + 1, 1);
    const x3 = get(i + 2, 0);
    const z3 = get(i + 2, 1);
    const segLen = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(1, Math.ceil(segLen / spacingKm));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const cx =
        0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3);
      const cz =
        0.5 * (2 * z1 + (-z0 + z2) * t + (2 * z0 - 5 * z1 + 4 * z2 - z3) * t2 + (-z0 + 3 * z1 - 3 * z2 + z3) * t3);
      out.push(cx, cz);
    }
  }
  out.push(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
  return new Float32Array(out);
}

/** Bilinear sample of the fine height texture at a world position, in km. */
export function makeHeightSampler(fineHeight: Float32Array): (x: number, z: number) => number {
  return (x: number, z: number) => {
    const u = ((x + HALF_KM) / WORLD_KM) * (FINE - 1);
    const v = ((z + HALF_KM) / WORLD_KM) * (FINE - 1);
    const x0 = clamp(Math.floor(u), 0, FINE - 2);
    const y0 = clamp(Math.floor(v), 0, FINE - 2);
    const tx = clamp(u - x0, 0, 1);
    const ty = clamp(v - y0, 0, 1);
    const r0 = y0 * FINE;
    const r1 = r0 + FINE;
    const a = fineHeight[r0 + x0];
    const bb = fineHeight[r0 + x0 + 1];
    const c = fineHeight[r1 + x0];
    const d = fineHeight[r1 + x0 + 1];
    return (a + (bb - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
}

/** River paths -> world polylines plus per-vertex discharge. */
export function buildRiverGeometry(
  rivers: RiverPath[],
  fineHeight: Float32Array,
): { geometry: RibbonGeometry; polylines: Float32Array[]; totalLengthKm: number } {
  const b = newBuilder();
  const sampler = makeHeightSampler(fineHeight);
  const polylines: Float32Array[] = [];
  let totalLengthKm = 0;

  for (const river of rivers) {
    const n = river.cells.length;
    if (n < 3) continue;
    const raw = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const c = river.cells[i];
      raw[i * 2] = macroToWorldX(c % MACRO);
      raw[i * 2 + 1] = macroToWorldZ((c / MACRO) | 0);
    }
    // Resample finer than the simulation grid so the channel curves smoothly.
    const smooth = resamplePolyline(raw, 2.2);
    polylines.push(smooth);
    totalLengthKm += river.length;

    // Interpolate discharge along the resampled line.
    const ratio = (n - 1) / Math.max(1, smooth.length / 2 - 1);
    const halfWidthAt = (i: number) => {
      const srcF = i * ratio;
      const s0 = clamp(Math.floor(srcF), 0, n - 1);
      const s1 = clamp(s0 + 1, 0, n - 1);
      const t = srcF - s0;
      const flow = river.flow[s0] * (1 - t) + river.flow[s1] * t;
      return riverHalfWidth(flow);
    };

    // Rivers sit slightly proud of their carved bed so they are never z-buried.
    addRibbon(b, smooth, (x, z) => sampler(x, z) + 0.006, halfWidthAt, 0);
  }

  return { geometry: finishBuilder(b), polylines, totalLengthKm };
}

const ROAD_HALF_WIDTH: Record<RoadClass, number> = {
  highway: 0.055,
  road: 0.04,
  caravan: 0.035,
  track: 0.026,
  lane: 0.018,
};

const ROAD_FLAG: Record<RoadClass, number> = {
  highway: 1,
  road: 2,
  caravan: 3,
  track: 4,
  lane: 5,
};

export function buildRoadGeometry(
  roads: RoadPath[],
  fineHeight: Float32Array,
): { geometry: RibbonGeometry; totalLengthKm: number } {
  const b = newBuilder();
  const sampler = makeHeightSampler(fineHeight);
  let totalLengthKm = 0;

  // Draw the smallest first so trunk roads overlay lanes at junctions.
  const order: RoadClass[] = ['lane', 'track', 'caravan', 'road', 'highway'];
  for (const klass of order) {
    for (const road of roads) {
      if (road.klass !== klass) continue;
      if (road.pts.length < 6) continue;
      totalLengthKm += road.lengthKm;
      const smooth = resamplePolyline(road.pts, 2.6);
      const hw = ROAD_HALF_WIDTH[klass];
      addRibbon(b, smooth, (x, z) => sampler(x, z) + 0.008, () => hw, ROAD_FLAG[klass]);
    }
  }

  return { geometry: finishBuilder(b), totalLengthKm };
}

/**
 * Lake surfaces as merged quad strips.
 *
 * Runs of consecutive cells in a row are merged into a single quad, which cuts
 * the vertex count for large lakes by roughly an order of magnitude while keeping
 * the exact cell-accurate outline.
 */
export function buildLakeGeometry(hydro: HydrologyResult): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = [];
  const idx: number[] = [];
  const cellKm = WORLD_KM / (MACRO - 1);
  const half = cellKm * 0.5;

  const inLake = new Uint8Array(MACRO * MACRO);
  const level = new Float32Array(MACRO * MACRO);
  for (const lake of hydro.lakes) {
    for (let k = 0; k < lake.cells.length; k++) {
      inLake[lake.cells[k]] = 1;
      level[lake.cells[k]] = lake.level;
    }
  }

  for (let y = 0; y < MACRO; y++) {
    let x = 0;
    while (x < MACRO) {
      const i = y * MACRO + x;
      if (!inLake[i]) {
        x++;
        continue;
      }
      const lv = level[i];
      let end = x;
      while (end + 1 < MACRO && inLake[y * MACRO + end + 1] && Math.abs(level[y * MACRO + end + 1] - lv) < 1e-4) {
        end++;
      }
      const x0 = macroToWorldX(x) - half;
      const x1 = macroToWorldX(end) + half;
      const z0 = macroToWorldZ(y) - half;
      const z1 = macroToWorldZ(y) + half;
      const base = pos.length / 3;
      // Lake surface sits a hair above the level so the shore reads cleanly.
      const yy = lv + 0.002;
      pos.push(x0, yy, z0, x1, yy, z0, x1, yy, z1, x0, yy, z1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      x = end + 1;
    }
  }

  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Coastline as line segments at sea level, for the cartographic outline layer. */
export function buildCoastline(macroHeight: Field): { vertices: Float32Array; lengthKm: number } {
  const segs = marchingSquares(macroHeight.data, MACRO, SEA_LEVEL, (gx, gy, out) => {
    out[0] = macroToWorldX(gx);
    out[1] = macroToWorldZ(gy);
  });

  // Expand to 3D at sea level, and measure total length while we are here.
  const count = segs.length / 4;
  const vertices = new Float32Array(count * 6);
  let lengthKm = 0;
  for (let s = 0; s < count; s++) {
    const ax = segs[s * 4];
    const az = segs[s * 4 + 1];
    const bx = segs[s * 4 + 2];
    const bz = segs[s * 4 + 3];
    const seg = Math.hypot(bx - ax, bz - az);
    if (Number.isFinite(seg)) lengthKm += seg;
    const o = s * 6;
    vertices[o] = ax;
    vertices[o + 1] = 0;
    vertices[o + 2] = az;
    vertices[o + 3] = bx;
    vertices[o + 4] = 0;
    vertices[o + 5] = bz;
  }
  return { vertices, lengthKm };
}

/** Political borders as 3D line segments draped over the terrain. */
export function buildBorderGeometry(borderSegments: Float32Array, fineHeight: Float32Array): Float32Array {
  const sampler = makeHeightSampler(fineHeight);
  const count = borderSegments.length / 4;
  const out = new Float32Array(count * 6);
  for (let s = 0; s < count; s++) {
    const ax = borderSegments[s * 4];
    const az = borderSegments[s * 4 + 1];
    const bx = borderSegments[s * 4 + 2];
    const bz = borderSegments[s * 4 + 3];
    const o = s * 6;
    out[o] = ax;
    out[o + 1] = sampler(ax, az);
    out[o + 2] = az;
    out[o + 3] = bx;
    out[o + 4] = sampler(bx, bz);
    out[o + 5] = bz;
  }
  return out;
}
