/**
 * Street networks.
 *
 * Two forms, chosen by culture, because "what shape is a town" is the single most
 * legible thing about a culture from the air:
 *
 *  - **Radial.** A market square at the centre, radial streets running out to the
 *    gates, and ring streets on the lines of successive walls. This is what a town
 *    that grew produces: the radials are the roads that were already there, and
 *    the rings are where the wall used to be. Every approach road becomes a
 *    radial, so the highway network genuinely runs *through* the town rather than
 *    stopping at a ring of buildings.
 *  - **Grid.** A surveyed grid at a fixed bearing, imposed on the site regardless
 *    of what the site thinks about it. This is what a town that was *founded*
 *    produces, and it is exactly what the Valen culture description already
 *    claims about them.
 *
 * The output is a set of superblocks — convex polygons bounded by streets — plus
 * the street centrelines for rendering. Convexity is guaranteed by construction:
 * the radial form emits quads between consecutive rings and radials, and the grid
 * form is produced by successively clipping a convex boundary with parallel lines.
 * Everything downstream depends on that invariant.
 */

import { Rng } from '../../../util/rng';
import { clamp, TAU } from '../../../util/math';
import {
  clipLineToConvex,
  ensureCCW,
  makePoly,
  polyArea,
  polyCentroid,
  regularPolygon,
  splitConvex,
  type Poly,
} from './geometry2d';
import { STREET_WIDTH, type CityContext, type Gate, type StreetSegment } from './types';

export interface StreetLayout {
  /** Mutable: the plan stage trims these against unbuildable ground. */
  streets: StreetSegment[];
  superblocks: Poly[];
  /** The market square or forum at the centre, if the form has one. */
  centre: Poly | null;
  boundary: Poly;
  gates: Gate[];
  form: 'radial' | 'grid';
}

/** Which cultures survey a grid rather than letting the town grow into one. */
function formForCulture(culture: number): 'radial' | 'grid' {
  // 0 Valen (a republic that imposes a grid), 3 Sahvari (courtyard blocks on a
  // surveyed grid). Everyone else grew organically.
  return culture === 0 || culture === 3 ? 'grid' : 'radial';
}

/**
 * The developable boundary.
 *
 * A jittered polygon, then pulled in wherever it lands in water or on ground too
 * steep to build on. Pulling vertices in rather than clipping the polygon keeps
 * it convex, which everything downstream relies on.
 */
function buildBoundary(
  cx: number,
  cz: number,
  radius: number,
  sides: number,
  rng: Rng,
  ctx: CityContext,
  rotation: number,
): Poly {
  const jitters: number[] = [];
  for (let i = 0; i < sides; i++) jitters.push(0.82 + rng.next() * 0.34);

  const poly = regularPolygon(
    cx,
    cz,
    radius,
    sides,
    (i) => jitters[i],
    rotation,
  );

  // Pull each vertex inward until it sits on buildable ground.
  const n = poly.pts.length / 2;
  for (let i = 0; i < n; i++) {
    let px = poly.pts[i * 2];
    let pz = poly.pts[i * 2 + 1];
    const dx = px - cx;
    const dz = pz - cz;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    let r = len;
    // Sixteen steps is enough resolution for a boundary of a few kilometres.
    for (let step = 0; step < 16 && r > radius * 0.16; step++) {
      const h = ctx.heightAt(px, pz);
      const s = ctx.slopeAt(px, pz);
      if (h > 0.004 && s < 0.62) break;
      r -= radius * 0.06;
      px = cx + ux * r;
      pz = cz + uz * r;
    }
    poly.pts[i * 2] = px;
    poly.pts[i * 2 + 1] = pz;
  }

  // The whole boundary fronts open country, not a street.
  poly.street.fill(0);
  return ensureCCW(poly);
}

/** Evenly spreads `count` bearings, honouring the fixed ones already present. */
function chooseRadialBearings(approaches: number[], count: number, rng: Rng): number[] {
  const norm = (a: number) => ((a % TAU) + TAU) % TAU;
  const out = approaches.map(norm);

  // Fill the largest angular gap repeatedly. This keeps the real roads exactly
  // where they arrive and distributes the invented streets sensibly between them.
  while (out.length < count) {
    out.sort((a, b) => a - b);
    let bestGap = -1;
    let bestAt = 0;
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = i === out.length - 1 ? out[0] + TAU : out[i + 1];
      const gap = b - a;
      if (gap > bestGap) {
        bestGap = gap;
        bestAt = a + gap / 2;
      }
    }
    if (bestGap < 0.24) break; // already dense enough
    out.push(norm(bestAt + rng.range(-0.08, 0.08)));
  }

  out.sort((a, b) => a - b);
  return out;
}

/** Distance from the centre to the boundary along a bearing. */
function boundaryReach(boundary: Poly, cx: number, cz: number, angle: number, fallback: number): number {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  const n = boundary.pts.length / 2;
  let best = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = boundary.pts[i * 2] - cx;
    const az = boundary.pts[i * 2 + 1] - cz;
    const bx = boundary.pts[j * 2] - cx;
    const bz = boundary.pts[j * 2 + 1] - cz;
    // Ray from origin along (dx,dz) against segment a->b.
    const ex = bx - ax;
    const ez = bz - az;
    const denom = dx * ez - dz * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const t = (ax * ez - az * ex) / denom;
    const u = (ax * dz - az * dx) / denom;
    if (t > 0 && u >= 0 && u <= 1 && t > best) best = t;
  }
  return best > 0 ? best : fallback;
}

// --------------------------------------------------------------------------
// Radial form
// --------------------------------------------------------------------------

function buildRadial(
  cx: number,
  cz: number,
  radius: number,
  rng: Rng,
  ctx: CityContext,
): StreetLayout {
  const sides = 20;
  const boundary = buildBoundary(cx, cz, radius, sides, rng, ctx, rng.range(0, TAU));

  // More radials for bigger towns, but never so many that blocks become slivers.
  const radialCount = clamp(
    Math.round(4 + radius * 3.4),
    Math.max(4, ctx.approaches.length),
    12,
  );
  const bearings = chooseRadialBearings(ctx.approaches, radialCount, rng);

  // Ring streets. The innermost is the market square edge; further rings mark
  // successive walls the town outgrew.
  const ringCount = radius > 1.9 ? 3 : radius > 0.85 ? 2 : radius > 0.34 ? 1 : 0;
  // The square has to be a real place, not a roundabout. Scaling it with the
  // town keeps it legible: at 160 m across it vanished inside a 3 km city.
  const squareR = clamp(radius * 0.1 + 0.05, 0.045, 0.34);
  const ringFractions: number[] = [];
  for (let i = 0; i < ringCount; i++) {
    // Rings crowd toward the centre, as real ones do: each wall enclosed less new
    // ground than the last.
    const t = (i + 1) / (ringCount + 1);
    ringFractions.push(0.24 + Math.pow(t, 0.78) * 0.66);
  }

  const streets: StreetSegment[] = [];
  const superblocks: Poly[] = [];

  // Per-bearing reach, so the plan follows the boundary's irregularity.
  const reach = bearings.map((a) => boundaryReach(boundary, cx, cz, a, radius));

  // Radial street centrelines.
  for (let i = 0; i < bearings.length; i++) {
    const a = bearings[i];
    const r1 = reach[i];
    const pts: number[] = [];
    const steps = 6;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const r = squareR * 0.4 + (r1 - squareR * 0.4) * t;
      // A gentle sway so the street is not a drawn ruler line.
      const sway = Math.sin(t * Math.PI) * radius * 0.02 * (rng.next() * 2 - 1);
      pts.push(cx + Math.cos(a + sway / Math.max(r, 0.05)) * r, cz + Math.sin(a + sway / Math.max(r, 0.05)) * r);
    }
    const isApproach = ctx.approaches.some((b) => Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) < 0.12);
    streets.push({
      pts: new Float32Array(pts),
      klass: isApproach ? 'primary' : 'secondary',
      widthKm: isApproach ? STREET_WIDTH.primary : STREET_WIDTH.secondary,
    });
  }

  // Ring street centrelines, drawn through the radial junctions so the rings and
  // the radials actually meet.
  for (const f of ringFractions) {
    const pts: number[] = [];
    for (let i = 0; i <= bearings.length; i++) {
      const k = i % bearings.length;
      const r = reach[k] * f;
      pts.push(cx + Math.cos(bearings[k]) * r, cz + Math.sin(bearings[k]) * r);
    }
    streets.push({ pts: new Float32Array(pts), klass: 'secondary', widthKm: STREET_WIDTH.secondary });
  }

  // Superblocks: quads between consecutive rings and consecutive radials.
  const radii = [squareR, ...ringFractions.map((f) => f), 1].map((f, i) => (i === 0 ? null : f));
  const ringRadiiFor = (k: number): number[] => {
    const rk = reach[k];
    const out = [squareR];
    for (const f of ringFractions) out.push(rk * f);
    out.push(rk);
    return out;
  };
  void radii;

  for (let i = 0; i < bearings.length; i++) {
    const k0 = i;
    const k1 = (i + 1) % bearings.length;
    const a0 = bearings[k0];
    let a1 = bearings[k1];
    if (a1 <= a0) a1 += TAU;
    const r0s = ringRadiiFor(k0);
    const r1s = ringRadiiFor(k1);

    for (let ring = 0; ring < r0s.length - 1; ring++) {
      const inner0 = r0s[ring];
      const outer0 = r0s[ring + 1];
      const inner1 = r1s[ring];
      const outer1 = r1s[ring + 1];
      const quad = makePoly(
        [
          cx + Math.cos(a0) * inner0, cz + Math.sin(a0) * inner0,
          cx + Math.cos(a0) * outer0, cz + Math.sin(a0) * outer0,
          cx + Math.cos(a1) * outer1, cz + Math.sin(a1) * outer1,
          cx + Math.cos(a1) * inner1, cz + Math.sin(a1) * inner1,
        ],
        // Edges: radial (street), outer arc (street unless it is the boundary),
        // radial (street), inner arc (street).
        [1, ring === r0s.length - 2 ? 0 : 1, 1, 1],
      );
      const poly = ensureCCW(quad);
      if (polyArea(poly) > 1e-7) superblocks.push(poly);
    }
  }

  // The market square itself.
  const centre = regularPolygon(cx, cz, squareR, Math.max(5, Math.min(9, bearings.length)), undefined, bearings[0]);
  centre.street.fill(1);

  const gates = buildGates(cx, cz, bearings, reach, ctx);

  return { streets, superblocks, centre, boundary, gates, form: 'radial' };
}

// --------------------------------------------------------------------------
// Grid form
// --------------------------------------------------------------------------

/** Splits a convex polygon repeatedly with a family of parallel lines. */
function sliceByParallels(
  polys: Poly[],
  ox: number,
  oz: number,
  dirX: number,
  dirZ: number,
  spacing: number,
  span: number,
): Poly[] {
  const out: Poly[] = [];
  // Offsets either side of the origin line, covering the whole extent.
  const steps = Math.ceil(span / spacing);
  const nx = -dirZ;
  const nz = dirX;

  for (const poly of polys) {
    let remaining: Poly | null = poly;
    for (let k = -steps; k <= steps && remaining; k++) {
      const lx = ox + nx * (k * spacing);
      const lz = oz + nz * (k * spacing);
      const res = splitConvex(remaining, lx, lz, dirX, dirZ, true);
      // Lines are visited in increasing order along the normal, so the piece
      // *behind* each line is finished and the piece ahead carries on to meet the
      // next one. Emitting the wrong half means the first cut keeps everything
      // and no further line ever intersects the remainder - which is why a grid
      // city was coming out with nine blocks instead of several thousand.
      if (res.left && polyArea(res.left) > 1e-8) out.push(res.left);
      remaining = res.right;
    }
    if (remaining && polyArea(remaining) > 1e-8) out.push(remaining);
  }
  return out;
}

function buildGrid(
  cx: number,
  cz: number,
  radius: number,
  rng: Rng,
  ctx: CityContext,
): StreetLayout {
  const rotation = rng.range(0, Math.PI / 2);
  const boundary = buildBoundary(cx, cz, radius, 14, rng, ctx, rng.range(0, TAU));

  // Insula size: Valen blocks are long rectangles, Sahvari blocks are compact and
  // courtyard-centred with much narrower streets between them.
  const longSide = ctx.culture === 3 ? 0.075 : 0.115;
  const shortSide = ctx.culture === 3 ? 0.062 : 0.072;

  const dirX = Math.cos(rotation);
  const dirZ = Math.sin(rotation);
  const span = radius * 2.4;

  let cells = sliceByParallels([boundary], cx, cz, dirX, dirZ, shortSide, span);
  cells = sliceByParallels(cells, cx, cz, -dirZ, dirX, longSide, span);

  const superblocks = cells.filter((c) => polyArea(c) > 1e-7);

  // Street centrelines mirroring the two families of cuts, clipped to the town.
  const streets: StreetSegment[] = [];
  const addFamily = (fx: number, fz: number, spacing: number, klass: 'primary' | 'secondary') => {
    const nx = -fz;
    const nz = fx;
    const steps = Math.ceil(span / spacing);
    for (let k = -steps; k <= steps; k++) {
      const lx = cx + nx * (k * spacing);
      const lz = cz + nz * (k * spacing);
      // Clip to the town. Drawing each grid line at full length instead paves the
      // surrounding countryside with streets that lead nowhere and belong to no
      // settlement - visible from kilometres away, and the single most obviously
      // wrong thing about the first grid-city render.
      const range = clipLineToConvex(boundary, lx, lz, fx, fz);
      if (!range) continue;
      const [t0, t1] = range;
      if (t1 - t0 < spacing * 0.4) continue;
      streets.push({
        pts: new Float32Array([lx + fx * t0, lz + fz * t0, lx + fx * t1, lz + fz * t1]),
        klass,
        widthKm: STREET_WIDTH[klass],
      });
    }
  };
  // Every fourth line in each family is an avenue.
  addFamily(dirX, dirZ, shortSide, 'secondary');
  addFamily(-dirZ, dirX, longSide, 'secondary');
  addFamily(dirX, dirZ, shortSide * 4, 'primary');
  addFamily(-dirZ, dirX, longSide * 4, 'primary');

  // The forum: the block nearest the centre, promoted.
  let centre: Poly | null = null;
  let bestD = Infinity;
  const tmp: [number, number] = [0, 0];
  for (const c of superblocks) {
    polyCentroid(c, tmp);
    const d = Math.hypot(tmp[0] - cx, tmp[1] - cz);
    if (d < bestD) {
      bestD = d;
      centre = c;
    }
  }
  if (centre) {
    const idx = superblocks.indexOf(centre);
    if (idx >= 0) superblocks.splice(idx, 1);
  }

  const bearings = chooseRadialBearings(ctx.approaches, Math.max(4, ctx.approaches.length), rng);
  const reach = bearings.map((a) => boundaryReach(boundary, cx, cz, a, radius));
  const gates = buildGates(cx, cz, bearings, reach, ctx);

  return { streets, superblocks, centre, boundary, gates, form: 'grid' };
}

function buildGates(
  cx: number,
  cz: number,
  bearings: number[],
  reach: number[],
  ctx: CityContext,
): Gate[] {
  if (!ctx.walled) return [];
  const gates: Gate[] = [];
  for (let i = 0; i < bearings.length; i++) {
    // A gate only exists where a real road arrives; invented streets stop at the
    // wall, which is why a walled town has fewer gates than it has streets.
    const a = bearings[i];
    const isApproach = ctx.approaches.some(
      (b) => Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) < 0.14,
    );
    if (!isApproach) continue;
    const r = reach[i] * 0.97;
    gates.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, bearing: a });
  }
  return gates;
}

export function buildStreetLayout(
  cx: number,
  cz: number,
  radius: number,
  seed: number,
  ctx: CityContext,
): StreetLayout {
  const rng = new Rng(seed);
  const form = formForCulture(ctx.culture);
  // Very small settlements never develop a form; they get a single lane, handled
  // by the caller falling back to the hamlet path.
  return form === 'grid' ? buildGrid(cx, cz, radius, rng, ctx) : buildRadial(cx, cz, radius, rng, ctx);
}
