/**
 * Fortification.
 *
 * A curtain wall is not a ribbon and it is not one long box either. It is a run of
 * *panels* between towers, each panel built level along its own stretch of ground,
 * so a wall crossing a slope steps rather than tilting — which is how every real
 * curtain was built, because masonry courses are level and the ground is not.
 *
 * That structure is also what makes it renderable. Each panel and each tower is a
 * separate piece with its own ground anchor, so the vertex shader samples the
 * terrain once per piece and the wall follows the hill without shearing. One long
 * extruded ring would have to pick a single anchor and would bury itself in the
 * first rise it met.
 *
 * Towers stand at the angles of the ring — a straight run of wall has no flanking
 * fire, so the angles are where you put the towers — with intermediate ones on any
 * stretch long enough to need them, and a pair at every gate.
 */

import { Rng } from '../../../util/rng';
import { clamp } from '../../../util/math';
import type { CityContext, Gate } from './types';

/** One stretch of curtain between towers, built level along its own ground. */
export interface WallPanel {
  /** Midpoint, world km. Also the ground anchor. */
  cx: number;
  cz: number;
  /** Unit direction along the wall. */
  dx: number;
  dz: number;
  lengthKm: number;
  heightKm: number;
}

/** A tower on the wall: a prism, taller than the curtain, with a wider cap. */
export interface WallTower {
  cx: number;
  cz: number;
  radiusKm: number;
  heightKm: number;
  /** 4 for a square tower, 6 or 8 for a round one. */
  sides: number;
  /** Rotation, so a square tower squares up to the wall it stands on. */
  angle: number;
}

/** A gate: an opening in the curtain with a gatehouse over it. */
export interface Gatehouse {
  cx: number;
  cz: number;
  /** Along the wall. */
  dx: number;
  dz: number;
  /** The opening, and the block of building over it. */
  widthKm: number;
  depthKm: number;
  heightKm: number;
}

export interface Fortification {
  panels: WallPanel[];
  towers: WallTower[];
  gates: Gatehouse[];
  /** Field-side ditch centreline, closed, as flat x,z pairs. */
  ditch: Float32Array;
  /** Town-side mural lane centreline: the strip kept clear behind the wall. */
  lane: Float32Array;
  thicknessKm: number;
}

/** Panel length: long enough that a town wall is not a thousand pieces. */
const PANEL_KM = 0.034;
/** No stretch of curtain runs further than this without a tower. */
const TOWER_SPACING_KM = 0.11;

/** Walks a closed ring, returning cumulative length and a sampler. */
function ringWalker(ring: Float32Array): {
  total: number;
  at: (s: number, out: [number, number, number, number]) => void;
} {
  const n = ring.length / 2;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    total += Math.hypot(ring[j * 2] - ring[i * 2], ring[j * 2 + 1] - ring[i * 2 + 1]);
    seg.push(total);
  }
  return {
    total,
    /** Position and unit direction at arc length `s`, wrapping. */
    at: (s, out) => {
      let t = s % total;
      if (t < 0) t += total;
      let i = 0;
      while (i < n - 1 && seg[i] < t) i++;
      const before = i === 0 ? 0 : seg[i - 1];
      const j = (i + 1) % n;
      const ax = ring[i * 2];
      const az = ring[i * 2 + 1];
      const bx = ring[j * 2];
      const bz = ring[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const u = clamp((t - before) / len, 0, 1);
      out[0] = ax + (bx - ax) * u;
      out[1] = az + (bz - az) * u;
      out[2] = (bx - ax) / len;
      out[3] = (bz - az) / len;
    },
  };
}

/** Arc length of the point on the ring nearest a position. */
function nearestArc(ring: Float32Array, x: number, z: number): number {
  const n = ring.length / 2;
  let best = 0;
  let bestD = Infinity;
  let run = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2];
    const az = ring[i * 2 + 1];
    const bx = ring[j * 2];
    const bz = ring[j * 2 + 1];
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez || 1;
    const u = clamp(((x - ax) * ex + (z - az) * ez) / len2, 0, 1);
    const px = ax + ex * u;
    const pz = az + ez * u;
    const d = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d < bestD) {
      bestD = d;
      best = run + Math.sqrt(len2) * u;
    }
    run += Math.sqrt(len2);
  }
  return best;
}

/**
 * Builds the fortification for one settlement from its wall ring and its gates.
 *
 * Gates arrive as bearings from the street layout, which is not quite the same
 * thing as points on the wall — the ring is jittered and the streets are not — so
 * each one is snapped to the nearest point on the ring before anything is placed.
 * Otherwise the gatehouse sits a few metres off its own wall, which at this scale
 * is instantly visible as a gap.
 */
export function buildFortification(
  ring: Float32Array,
  gates: Gate[],
  ctx: CityContext,
  seed: number,
): Fortification {
  const rng = new Rng(seed ^ 0x7a11);
  const walker = ringWalker(ring);
  const total = walker.total;

  // Height by what the place can afford. A hamlet's "wall" is a bank and a
  // palisade; a capital's is a masonry curtain three storeys high.
  const base =
    ctx.tier === 'capital' ? 0.0125 : ctx.tier === 'city' ? 0.0108 : ctx.tier === 'town' ? 0.0082 : 0.0055;
  // Thickness by height, as masonry is: a wall three storeys high needs a base
  // wide enough to stand up, and a wall walk wide enough to fight from.
  const thickness = base * 0.42;

  /** Nothing is built standing in water. */
  const dry = (x: number, z: number): boolean => ctx.heightAt(x, z) > 0.0005;

  // --- Gates, snapped to the ring ---------------------------------------
  const gateArcs = gates
    .map((g) => nearestArc(ring, g.x, g.z))
    .sort((a, b) => a - b);
  const gateWidth = clamp(base * 1.5, 0.012, 0.03);

  const p: [number, number, number, number] = [0, 0, 0, 0];
  const gateHouses: Gatehouse[] = [];
  for (const s of gateArcs) {
    walker.at(s, p);
    if (!dry(p[0], p[1])) continue;
    gateHouses.push({
      cx: p[0],
      cz: p[1],
      dx: p[2],
      dz: p[3],
      widthKm: gateWidth,
      depthKm: thickness * 2.6,
      heightKm: base * 1.55,
    });
  }

  /** True where the curtain gives way to a gate. */
  const inGate = (s: number): boolean =>
    gateArcs.some((g) => {
      let d = Math.abs(((s - g + total * 1.5) % total) - total * 0.5);
      d = total * 0.5 - d;
      return d < gateWidth * 0.62;
    });

  // --- Towers -------------------------------------------------------------
  // At the angles of the ring first: a straight run of wall cannot be defended
  // from itself, so the corners are where the towers go.
  const towerArcs: number[] = [];
  const n = ring.length / 2;
  let run = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = Math.hypot(ring[j * 2] - ring[i * 2], ring[j * 2 + 1] - ring[i * 2 + 1]);
    towerArcs.push(run);
    // Then intermediates, on any stretch long enough to leave a blind spot.
    const steps = Math.floor(len / TOWER_SPACING_KM);
    for (let k = 1; k <= steps; k++) towerArcs.push(run + (len * k) / (steps + 1));
    run += len;
  }
  // And a pair flanking every gate.
  for (const g of gateArcs) {
    towerArcs.push(g - gateWidth * 0.78, g + gateWidth * 0.78);
  }

  // Ring centroid, needed to tell the field side from the town side.
  let ccx = 0;
  let ccz = 0;
  for (let i = 0; i < n; i++) {
    ccx += ring[i * 2];
    ccz += ring[i * 2 + 1];
  }
  ccx /= n;
  ccz /= n;

  const towers: WallTower[] = [];
  for (const s of towerArcs) {
    if (inGate(s)) continue;
    walker.at(s, p);
    if (!dry(p[0], p[1])) continue;
    const round = rng.next() < (ctx.culture === 3 ? 0.25 : 0.62);
    const radius = thickness * rng.range(2.1, 2.6);
    // Pushed out into the field, along the wall's own normal. A mural tower exists
    // to shoot along the foot of its own wall, so it has to project past the wall
    // face — one centred on the curtain blocks the wall walk and defends nothing.
    let ox = -p[3];
    let oz = p[2];
    // Whichever of the two normals points away from the middle of the town.
    if ((p[0] - ccx) * ox + (p[1] - ccz) * oz < 0) {
      ox = -ox;
      oz = -oz;
    }
    const push = radius * 0.55;
    towers.push({
      cx: p[0] + ox * push,
      cz: p[1] + oz * push,
      radiusKm: radius,
      heightKm: base * rng.range(1.32, 1.58),
      sides: round ? 8 : 4,
      // A plain bearing in the XZ plane. `regularPolygon` and `rectanglePolygon`
      // both build in world XZ directly — the negated angle that a Three.js Y
      // rotation would need does not belong here, and putting it here turns the
      // curtain into a row of bars lying across its own line.
      angle: Math.atan2(p[3], p[2]),
    });
  }

  // --- Curtain panels -----------------------------------------------------
  const panels: WallPanel[] = [];
  const count = Math.max(8, Math.round(total / PANEL_KM));
  const step = total / count;
  for (let i = 0; i < count; i++) {
    const s = (i + 0.5) * step;
    if (inGate(s)) continue;
    walker.at(s, p);
    // A chord of the ring can cross a bay even when both its ends are on land, so
    // it is the panel that has to be tested, not the ring vertex.
    if (!dry(p[0], p[1])) continue;
    // Panels overlap their towers slightly, so the join is masonry rather than a
    // visible seam.
    panels.push({
      cx: p[0],
      cz: p[1],
      dx: p[2],
      dz: p[3],
      lengthKm: step * 1.04,
      // Every panel is level along its own ground, and each one is built to its
      // own course, so the run steps a little as it goes.
      heightKm: base * (0.94 + ((i * 2654435761) % 1000) / 1000 * 0.14),
    });
  }

  // --- Ditch and mural lane ----------------------------------------------
  // Offsets of the ring, outward and inward. The terrain cannot be cut — the
  // heightfield is baked before anything knows a town is here — so the ditch reads
  // as a band of dug earth on the field side, which from the air is what a ditch
  // looks like anyway.
  const ditch = new Float32Array(ring.length);
  const lane = new Float32Array(ring.length);
  const outward = base * 2.1 + thickness;
  const inward = base * 1.1 + thickness;
  for (let i = 0; i < n; i++) {
    const dx = ring[i * 2] - ccx;
    const dz = ring[i * 2 + 1] - ccz;
    const len = Math.hypot(dx, dz) || 1;
    ditch[i * 2] = ring[i * 2] + (dx / len) * outward;
    ditch[i * 2 + 1] = ring[i * 2 + 1] + (dz / len) * outward;
    lane[i * 2] = ring[i * 2] - (dx / len) * inward;
    lane[i * 2 + 1] = ring[i * 2 + 1] - (dz / len) * inward;
  }

  return { panels, towers, gates: gateHouses, ditch, lane, thicknessKm: thickness };
}
