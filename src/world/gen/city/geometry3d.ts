/**
 * Building geometry.
 *
 * Extrudes a building from its footprint. Two things here are worth stating
 * because they are not obvious and both were arrived at deliberately:
 *
 * **1. Every vertex carries an anchor.** The vertex shader has to compute the
 * ground height itself — the terrain is displaced by procedural detail whose hash
 * the CPU cannot reproduce bit for bit — but if each vertex sampled the ground at
 * *its own* position, a building on a slope would shear into a parallelogram and
 * its roof would warp. So every vertex of a building carries the same anchor
 * point, the footprint centroid, and the shader samples the ground once per
 * building. The Y channel of the position is then a true local height above that
 * base.
 *
 * **2. The roof is one algorithm.** Rather than separate gable, hip and pyramid
 * cases, each eaves vertex is projected onto a ridge segment and lifted toward
 * it. A rectangle with the ridge along its length gives a gable; a squarish plan
 * gives a hip; a zero-length ridge gives a pyramid; zero rise gives a flat cap.
 * One routine, correct for any convex footprint, which matters because the
 * footprints are plots and plots are whatever shape the subdivision left.
 */

import {
  ensureCCW,
  makePoly,
  polyCentroid,
  rectanglePolygon,
  regularPolygon,
  vertexCount,
  type Poly,
} from './geometry2d';
import type { BuildingSpec } from './buildings';
import type { Fortification } from './walls';
import type { Harbour } from './harbour';
import type { Works } from '../rural/works';

/** Accumulates interleaved geometry for one block. */
export interface GeomBuilder {
  pos: number[];
  nor: number[];
  col: number[];
  anchor: number[];
  idx: number[];
  vertex: number;
}

export function newGeomBuilder(): GeomBuilder {
  return { pos: [], nor: [], col: [], anchor: [], idx: [], vertex: 0 };
}

function pushVertex(
  b: GeomBuilder,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  r: number,
  g: number,
  bl: number,
  ax: number,
  az: number,
): number {
  b.pos.push(x, y, z);
  b.nor.push(nx, ny, nz);
  b.col.push(r, g, bl);
  b.anchor.push(ax, az);
  return b.vertex++;
}

/** Emits the walls of an extruded footprint, flat-shaded per face. */
function emitWalls(
  b: GeomBuilder,
  poly: Poly,
  height: number,
  wall: [number, number, number],
  ax: number,
  az: number,
  shadeBase: number,
  /** Height of the bottom of the wall above the ground, for a course laid on top. */
  baseY = 0,
): void {
  const n = vertexCount(poly);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = poly.pts[i * 2];
    const z0 = poly.pts[i * 2 + 1];
    const x1 = poly.pts[j * 2];
    const z1 = poly.pts[j * 2 + 1];
    let ex = x1 - x0;
    let ez = z1 - z0;
    const len = Math.hypot(ex, ez);
    if (len < 1e-7) continue;
    ex /= len;
    ez /= len;
    // Outward normal for counter-clockwise winding.
    const nx = ez;
    const nz = -ex;

    // A touch of per-face shading variation so a long terrace does not read as
    // one extruded ribbon.
    const s = shadeBase + ((i * 37) % 7) * 0.012;
    const r = wall[0] * s;
    const g = wall[1] * s;
    const bl = wall[2] * s;

    const a = pushVertex(b, x0, baseY, z0, nx, 0, nz, r, g, bl, ax, az);
    const c = pushVertex(b, x1, baseY, z1, nx, 0, nz, r, g, bl, ax, az);
    const d = pushVertex(b, x1, baseY + height, z1, nx, 0, nz, r, g, bl, ax, az);
    const e = pushVertex(b, x0, baseY + height, z0, nx, 0, nz, r, g, bl, ax, az);
    b.idx.push(a, c, d, a, d, e);
  }
}

/**
 * Caps a polygon at a height, as a flat lid.
 *
 * Every horizontal top surface in this module goes through here — roofs, block
 * massing, wall coping, bridge decks — for one reason: the winding is easy to get
 * wrong and impossible to see that you have. A polygon wound counter-clockwise in
 * the XZ plane projects *clockwise* when looked at from above, which is the only
 * direction a lid is ever seen from, so the obvious fan makes a back face and the
 * whole top of the thing silently disappears.
 */
function capPoly(
  b: GeomBuilder,
  poly: Poly,
  y: number,
  ax: number,
  az: number,
  col: [number, number, number],
  shade: number,
): void {
  const n = vertexCount(poly);
  const base = b.vertex;
  for (let i = 0; i < n; i++) {
    pushVertex(
      b,
      poly.pts[i * 2],
      y,
      poly.pts[i * 2 + 1],
      0,
      1,
      0,
      col[0] * shade,
      col[1] * shade,
      col[2] * shade,
      ax,
      az,
    );
  }
  for (let i = 1; i < n - 1; i++) b.idx.push(base, base + i + 1, base + i);
}

/**
 * Emits a roof over the footprint.
 *
 * Each eaves vertex is paired with a point on the ridge segment, found by
 * projecting it along the ridge axis and clamping to the ridge's extent. Lifting
 * to that point produces a gable, a hip or a pyramid according to how long the
 * ridge is relative to the plan, with no special cases.
 */
function emitRoof(b: GeomBuilder, spec: BuildingSpec, ax: number, az: number): void {
  const poly = spec.poly;
  const n = vertexCount(poly);
  const { height, roofHeight } = spec;
  const col = spec.roofColor;

  if (roofHeight <= 1e-6) {
    capPoly(b, poly, height, ax, az, col, 1);
    return;
  }

  const c: [number, number] = [0, 0];
  polyCentroid(poly, c);
  const rx = spec.ridgeX;
  const rz = spec.ridgeZ;

  // Ridge extent: the footprint's span along the ridge axis, pulled in so the
  // ends slope rather than running out to a knife edge at the wall.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = (poly.pts[i * 2] - c[0]) * rx + (poly.pts[i * 2 + 1] - c[1]) * rz;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  // A hip roof pulls the ridge well in; a gable barely at all.
  const shrink = spec.roof === 'hip' ? 0.42 : 0.82;
  const rLo = lo * shrink;
  const rHi = hi * shrink;

  const ridgePoint = (t: number): [number, number] => {
    const cl = Math.max(rLo, Math.min(rHi, t));
    return [c[0] + rx * cl, c[1] + rz * cl];
  };

  const apexY = height + roofHeight;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = poly.pts[i * 2];
    const z0 = poly.pts[i * 2 + 1];
    const x1 = poly.pts[j * 2];
    const z1 = poly.pts[j * 2 + 1];
    const t0 = (x0 - c[0]) * rx + (z0 - c[1]) * rz;
    const t1 = (x1 - c[0]) * rx + (z1 - c[1]) * rz;
    const p0 = ridgePoint(t0);
    const p1 = ridgePoint(t1);

    // Face normal: the cross product of the eaves edge (ux, 0, uz) with the
    // vector rising to the ridge (vx, roofHeight, vz).
    const ux = x1 - x0;
    const uz = z1 - z0;
    const vx = p0[0] - x0;
    const vy = roofHeight;
    const vz = p0[1] - z0;
    let nx = -uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    const a = pushVertex(b, x0, height, z0, nx, ny, nz, col[0], col[1], col[2], ax, az);
    const bb = pushVertex(b, x1, height, z1, nx, ny, nz, col[0], col[1], col[2], ax, az);
    // The ridge is lit a little brighter, which reads as the sky catching it.
    const rc = 1.08;
    const cc = pushVertex(b, p1[0], apexY, p1[1], nx, ny, nz, col[0] * rc, col[1] * rc, col[2] * rc, ax, az);
    const d = pushVertex(b, p0[0], apexY, p0[1], nx, ny, nz, col[0] * rc, col[1] * rc, col[2] * rc, ax, az);
    b.idx.push(a, bb, cc, a, cc, d);
  }
}

/** A slim square tower or spire, centred on the footprint. */
function emitTower(b: GeomBuilder, spec: BuildingSpec, ax: number, az: number): void {
  const c: [number, number] = [0, 0];
  polyCentroid(spec.poly, c);
  // Sized from the footprint so a spire on a small chapel is a small spire.
  const half = Math.min(0.006, Math.sqrt(polyAreaOf(spec.poly)) * 0.16);
  if (half < 0.0008) return;
  const top = spec.height + spec.tower;
  const col = spec.roofColor;
  const wall = spec.wall;

  const corners: Array<[number, number]> = [
    [c[0] - half, c[1] - half],
    [c[0] + half, c[1] - half],
    [c[0] + half, c[1] + half],
    [c[0] - half, c[1] + half],
  ];

  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[j];
    let ex = x1 - x0;
    let ez = z1 - z0;
    const len = Math.hypot(ex, ez) || 1;
    ex /= len;
    ez /= len;
    const nx = ez;
    const nz = -ex;
    const s = 0.94 + i * 0.02;
    const a = pushVertex(b, x0, 0, z0, nx, 0, nz, wall[0] * s, wall[1] * s, wall[2] * s, ax, az);
    const bb = pushVertex(b, x1, 0, z1, nx, 0, nz, wall[0] * s, wall[1] * s, wall[2] * s, ax, az);
    const cc = pushVertex(b, x1, top, z1, nx, 0, nz, wall[0] * s, wall[1] * s, wall[2] * s, ax, az);
    const d = pushVertex(b, x0, top, z0, nx, 0, nz, wall[0] * s, wall[1] * s, wall[2] * s, ax, az);
    b.idx.push(a, bb, cc, a, cc, d);
  }

  // A pyramid cap.
  const capTop = top + half * 2.4;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[j];
    const a = pushVertex(b, x0, top, z0, 0, 0.7, 0, col[0], col[1], col[2], ax, az);
    const bb = pushVertex(b, x1, top, z1, 0, 0.7, 0, col[0], col[1], col[2], ax, az);
    const cc = pushVertex(b, c[0], capTop, c[1], 0, 1, 0, col[0] * 1.1, col[1] * 1.1, col[2] * 1.1, ax, az);
    b.idx.push(a, bb, cc);
  }
}

function polyAreaOf(p: Poly): number {
  const n = vertexCount(p);
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p.pts[i * 2] * p.pts[j * 2 + 1] - p.pts[j * 2] * p.pts[i * 2 + 1];
  }
  return Math.abs(a) * 0.5;
}

/** Full detail: walls, roof and any tower. */
export function emitBuilding(b: GeomBuilder, spec: BuildingSpec): void {
  emitWalls(b, spec.poly, spec.height, spec.wall, spec.ax, spec.az, 0.94);
  emitRoof(b, spec, spec.ax, spec.az);
  if (spec.tower > 0) emitTower(b, spec, spec.ax, spec.az);
}

/**
 * Reduced detail: walls capped flat at the mid-roof height.
 *
 * Capping at the *average* of eaves and ridge rather than at the eaves keeps the
 * silhouette and the apparent massing of the town unchanged across the LOD
 * boundary, so the transition is not visible as a sudden drop in the skyline.
 */
export function emitBuildingBox(b: GeomBuilder, spec: BuildingSpec): void {
  const h = spec.height + spec.roofHeight * 0.45;
  emitWalls(b, spec.poly, h, spec.wall, spec.ax, spec.az, 0.92);
  capPoly(b, spec.poly, h, spec.ax, spec.az, spec.roofColor, 1);
}

/**
 * Coarsest solid tier: the whole block extruded as one mass.
 *
 * From three kilometres up a city block *is* a single mass with a broken top -
 * you cannot resolve the gaps between its houses. Emitting one prism per block
 * instead of one per building costs roughly a tenth of the vertices for a nearly
 * identical silhouette, and it is what keeps a whole city three-dimensional to
 * the horizon rather than collapsing to a flat plan.
 */
export function emitBlockMass(
  b: GeomBuilder,
  poly: Poly,
  height: number,
  wall: [number, number, number],
  roof: [number, number, number],
): void {
  const c: [number, number] = [0, 0];
  polyCentroid(poly, c);
  emitWalls(b, poly, height, wall, c[0], c[1], 0.9);
  capPoly(b, poly, height, c[0], c[1], roof, 1);
}

/** Freezes a builder into typed arrays. */
export function freezeGeometry(b: GeomBuilder): {
  pos: Float32Array;
  nor: Float32Array;
  col: Float32Array;
  anchor: Float32Array;
  idx: Uint32Array;
} {
  return {
    pos: new Float32Array(b.pos),
    nor: new Float32Array(b.nor),
    col: new Float32Array(b.col),
    anchor: new Float32Array(b.anchor),
    idx: new Uint32Array(b.idx),
  };
}

/**
 * Emits a whole fortification: curtain panels, towers and gatehouses.
 *
 * Each piece anchors at its own centre, so every one of them sits on the ground
 * where it actually stands and the wall steps its way over a hill instead of
 * shearing. That is the reason the wall is modelled as pieces at all.
 *
 * Every piece is finished with a **coping** — a slab a little wider than the
 * masonry below it, in a paler stone. It is 80 cm of geometry and it is what makes
 * a wall read as a wall from a kilometre up: the overhang catches the light along
 * the whole run and draws a line, where a plain box just shows two grey faces.
 */
export function emitFortification(
  b: GeomBuilder,
  fort: Fortification,
  stone: [number, number, number],
  coping: [number, number, number],
): void {
  const COPING_KM = 0.0008;

  /** The coping course: a slab with its own sides, so the overhang casts a line. */
  const copingSlab = (poly: Poly, y: number, cx: number, cz: number, shade: number): void => {
    emitWalls(b, poly, COPING_KM, coping, cx, cz, shade, y);
    capPoly(b, poly, y + COPING_KM, cx, cz, coping, 1);
  };

  for (const p of fort.panels) {
    const angle = Math.atan2(p.dz, p.dx);
    const body = rectanglePolygon(p.cx, p.cz, p.lengthKm * 0.5, fort.thicknessKm * 0.5, angle);
    emitWalls(b, body, p.heightKm, stone, p.cx, p.cz, 0.9);
    copingSlab(
      rectanglePolygon(p.cx, p.cz, p.lengthKm * 0.5, fort.thicknessKm * 0.68, angle),
      p.heightKm,
      p.cx,
      p.cz,
      0.98,
    );
  }

  for (const t of fort.towers) {
    const body = regularPolygon(t.cx, t.cz, t.radiusKm, t.sides, undefined, t.angle);
    emitWalls(b, body, t.heightKm, stone, t.cx, t.cz, 0.94);
    copingSlab(
      regularPolygon(t.cx, t.cz, t.radiusKm * 1.16, t.sides, undefined, t.angle),
      t.heightKm,
      t.cx,
      t.cz,
      1.02,
    );
  }

  for (const g of fort.gates) {
    // The gatehouse spans the opening and projects on both faces of the wall, the
    // way a barbican does: it is the only part of a curtain anyone builds deep.
    const angle = Math.atan2(g.dz, g.dx);
    const body = rectanglePolygon(g.cx, g.cz, g.widthKm * 0.5, g.depthKm * 0.5, angle);
    emitWalls(b, body, g.heightKm, stone, g.cx, g.cz, 0.97);
    copingSlab(
      rectanglePolygon(g.cx, g.cz, g.widthKm * 0.5, g.depthKm * 0.62, angle),
      g.heightKm,
      g.cx,
      g.cz,
      1.04,
    );
  }
}

/** Colours for harbour works: masonry, timber, and a hull. */
export interface HarbourPalette {
  quay: [number, number, number];
  timber: [number, number, number];
  rubble: [number, number, number];
  hull: [number, number, number];
}

/**
 * Emits the harbour works: quay wall, jetties, breakwater and moored hulls.
 *
 * The one thing worth knowing is where each piece takes its ground from. A quay
 * segment anchors on its own stretch of shore, so the quay follows the real
 * shoreline up and down. A jetty anchors at its **root**, not its middle, so its
 * deck runs out level over the water instead of following the seabed down. And a
 * hull anchors at the root of the jetty it is tied to, for the same reason — its
 * own position is over open water, and a hull that samples the seabed sinks.
 */
export function emitHarbour(b: GeomBuilder, harbour: Harbour, pal: HarbourPalette): void {
  for (const q of harbour.quays) {
    const n = q.line.length / 2;
    for (let i = 0; i < n - 1; i++) {
      const x0 = q.line[i * 2];
      const z0 = q.line[i * 2 + 1];
      const x1 = q.line[(i + 1) * 2];
      const z1 = q.line[(i + 1) * 2 + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-5) continue;
      const mx = (x0 + x1) * 0.5;
      const mz = (z0 + z1) * 0.5;
      const angle = Math.atan2(z1 - z0, x1 - x0);
      // The wall, then the apron behind it as a low kerb, which is what gives the
      // quay a width rather than reading as a fence along the water.
      // Seven metres deep. A quay is a retaining wall with a working apron on
      // top; at four it read as a fence along the water.
      const wall = rectanglePolygon(mx, mz, len * 0.52, 0.0035, angle);
      emitWalls(b, wall, q.heightKm, pal.quay, mx, mz, 0.98);
      capPoly(b, wall, q.heightKm, mx, mz, pal.quay, 1.06);
    }
  }

  for (const a of harbour.arms) {
    const cxx = a.x + a.dx * a.lengthKm * 0.5;
    const czz = a.z + a.dz * a.lengthKm * 0.5;
    const angle = Math.atan2(a.dz, a.dx);
    const deck = rectanglePolygon(cxx, czz, a.lengthKm * 0.5, a.widthKm * 0.5, angle);
    const col = a.breakwater ? pal.rubble : pal.timber;
    // Anchored at the root, on the shore: a deck runs level out over the water.
    emitWalls(b, deck, a.heightKm, col, a.x, a.z, 0.95);
    capPoly(b, deck, a.heightKm, a.x, a.z, col, a.breakwater ? 1.0 : 1.08);
  }

  for (const h of harbour.hulls) {
    const angle = Math.atan2(h.dz, h.dx);
    // A hull is a hexagon, not a box: two blunt ends and a beam amidships. Three
    // extra vertices, and it is the difference between a boat and a crate.
    const hl = h.lengthKm * 0.5;
    const hb = h.beamKm * 0.5;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const local = (u: number, v: number): [number, number] => [
      h.x + u * c - v * s,
      h.z + u * s + v * c,
    ];
    const corners = [
      local(-hl, 0),
      local(-hl * 0.55, -hb),
      local(hl * 0.6, -hb * 0.82),
      local(hl, 0),
      local(hl * 0.6, hb * 0.82),
      local(-hl * 0.55, hb),
    ];
    const poly = ensureCCW(makePoly(corners.flat()));
    emitWalls(b, poly, h.heightKm, pal.hull, h.ax, h.az, 0.9);
    capPoly(b, poly, h.heightKm, h.ax, h.az, pal.hull, 1.12);

    if (h.mastKm > 0) {
      const t = h.beamKm * 0.11;
      const mast = rectanglePolygon(h.x, h.z, t, t, angle);
      emitWalls(b, mast, h.mastKm, pal.timber, h.ax, h.az, 1.0, h.heightKm);
    }
  }
}


/** A bridge, as the renderer needs it: where, which way, how far, how big. */
export interface BridgeSpec {
  x: number;
  z: number;
  /** Unit direction of the road across the river. */
  dx: number;
  dz: number;
  spanKm: number;
  widthKm: number;
  /** Height of the deck above the water, in km. */
  riseKm: number;
  /** Where the deck samples the ground: a bank, not the riverbed. */
  ax: number;
  az: number;
}

/**
 * Emits a bridge: piers, and a deck carried on them.
 *
 * The deck is not one box. It is laid in bays between piers, each bay lifted a
 * little toward the middle of the span, because a masonry bridge is a series of
 * arches and the road over them humps — which is the single detail that reads as
 * "bridge" rather than "causeway" from the air. The arches themselves are below
 * the resolution of any view this map offers; the hump is not.
 */
export function emitBridge(b: GeomBuilder, spec: BridgeSpec, stone: [number, number, number]): void {
  const angle = Math.atan2(spec.dz, spec.dx);
  const half = spec.spanKm * 0.5;
  const bays = Math.max(2, Math.round(spec.spanKm / 0.045));
  const deckThickness = Math.max(0.0012, spec.widthKm * 0.22);
  const pierWidth = spec.widthKm * 0.62;

  for (let i = 0; i < bays; i++) {
    const u0 = -half + (spec.spanKm * i) / bays;
    const u1 = -half + (spec.spanKm * (i + 1)) / bays;
    const mid = (u0 + u1) * 0.5;
    // The hump: a shallow parabola over the whole span.
    const t = mid / half;
    const y = spec.riseKm * (1 - t * t * 0.62);
    const cx = spec.x + spec.dx * mid;
    const cz = spec.z + spec.dz * mid;
    const bay = rectanglePolygon(cx, cz, (u1 - u0) * 0.52, spec.widthKm * 0.5, angle);
    emitWalls(b, bay, deckThickness, stone, spec.ax, spec.az, 0.9, y);
    capPoly(b, bay, y + deckThickness, spec.ax, spec.az, stone, 1.06);
  }

  // Piers between the bays. They start below the abutment the deck is measured
  // from, because the river runs lower than its own banks, and stop at the deck.
  // Nothing here models a riverbed, so they end where the water hides them.
  const foot = spec.riseKm + 0.004;
  for (let i = 1; i < bays; i++) {
    const u = -half + (spec.spanKm * i) / bays;
    const t = u / half;
    const y = spec.riseKm * (1 - t * t * 0.62);
    const cx = spec.x + spec.dx * u;
    const cz = spec.z + spec.dz * u;
    const pier = rectanglePolygon(cx, cz, pierWidth * 0.42, spec.widthKm * 0.62, angle);
    emitWalls(b, pier, y + foot, stone, spec.ax, spec.az, 0.82, -foot);
  }
}

/**
 * Emits an industrial works: disturbed ground, then whatever stands on it.
 *
 * Every piece anchors at the works' own origin rather than its own centre, so a
 * quarry's benches step relative to each other rather than each following the
 * hillside independently — which is the difference between a staircase cut into a
 * slope and a set of discs draped over one.
 */
export function emitWorks(b: GeomBuilder, works: Works): void {
  const sink = -works.sinkKm;
  for (const p of works.patches) {
    const poly = regularPolygon(p.x, p.z, p.radiusKm, p.sides, undefined, p.angle);
    const col = unpack(p.color);
    emitWalls(b, poly, Math.abs(p.riseKm) + works.sinkKm, col, works.ax, works.az, 0.86, sink);
    capPoly(b, poly, sink + Math.abs(p.riseKm) + works.sinkKm, works.ax, works.az, col, 1.05);
  }
  for (const s of works.buildings) {
    const poly = rectanglePolygon(s.x, s.z, s.widthKm * 0.5, s.depthKm * 0.5, s.angle);
    emitWalls(b, poly, s.heightKm + works.sinkKm, unpack(s.wall), works.ax, works.az, 0.95, sink);
    capPoly(b, poly, s.heightKm, works.ax, works.az, unpack(s.roof), 1.04);
  }
}

/** Unpacks a packed RGB colour to 0..1 components. */
function unpack(rgb: number): [number, number, number] {
  return [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255];
}
