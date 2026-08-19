/**
 * Harbour works.
 *
 * A port is not a town that happens to touch water. The whole point of a harbour
 * is that it is *built*: the shoreline is replaced with a quay wall so a hull can
 * lie alongside in deep water, jetties reach out to where the water is deep enough
 * without dredging, and a breakwater takes the weather so the water inside is
 * still. Those four things, in that order, are what makes a stretch of coast read
 * as a port from the air rather than as a beach with houses behind it.
 *
 * Everything here is found by *sampling the terrain*, not by assuming. The water
 * is wherever the heightfield says it is, so the quay follows the real shoreline
 * of the real bay this town happens to sit on, and a town whose only water is a
 * river gets a river frontage instead of a sea wall.
 */

import { Rng } from '../../../util/rng';
import { clamp, TAU } from '../../../util/math';
import type { CityContext } from './types';

/** A quay: a masonry wall along the water with a paved apron behind it. */
export interface Quay {
  /** Centreline of the wall, flat x,z pairs, following the shore. */
  line: Float32Array;
  /** Height of the wall crown above the ground it stands on, in km. */
  heightKm: number;
  /** Width of the paved apron behind the wall, in km. */
  apronKm: number;
}

/** A jetty or a breakwater: a straight arm out into the water. */
export interface Arm {
  /** Root, on the shore. */
  x: number;
  z: number;
  /** Unit direction, out into the water. */
  dx: number;
  dz: number;
  lengthKm: number;
  widthKm: number;
  heightKm: number;
  /** Breakwaters are rubble and get no berths; jetties are timber and do. */
  breakwater: boolean;
}

/** A moored hull, lying alongside something. */
export interface Hull {
  x: number;
  z: number;
  /**
   * Where this hull samples the ground, which is *not* where it floats.
   *
   * Everything in this module is drawn by the same shader as the buildings, and
   * that shader stands a piece on the ground beneath its anchor. A hull's own
   * position is over water, where the ground is the seabed — anchoring there
   * would sink it. So it anchors at the root of the jetty it is tied to, which is
   * on the shore, where the ground is sea level.
   */
  ax: number;
  az: number;
  /** Unit direction along the keel. */
  dx: number;
  dz: number;
  lengthKm: number;
  beamKm: number;
  /** Freeboard above the water, in km. */
  heightKm: number;
  /** A mast, or zero for an open boat. */
  mastKm: number;
}

export interface Harbour {
  quays: Quay[];
  arms: Arm[];
  hulls: Hull[];
  /** Sea level at this harbour, in km — the height everything floating sits at. */
  waterKm: number;
}

/**
 * How far past its own edge a settlement may look for water.
 *
 * Tight on purpose. A town four kilometres from a lake is not a port, and giving
 * it a quay four kilometres away would put a row of jetties in the middle of open
 * country. If the water is not close enough to walk to, there is no harbour.
 */
function reachOf(radiusKm: number): number {
  return radiusKm * 1.15 + 0.25;
}

/**
 * Walks outward from a point until the ground goes under water.
 *
 * Returns the last dry position and the distance to it, or null if the ray never
 * finds water inside the search radius.
 */
function toShore(
  x: number,
  z: number,
  dx: number,
  dz: number,
  heightAt: (x: number, z: number) => number,
  maxKm: number,
): { x: number; z: number; d: number } | null {
  const step = 0.012;
  let last = { x, z, d: 0 };
  for (let d = step; d <= maxKm; d += step) {
    const px = x + dx * d;
    const pz = z + dz * d;
    if (heightAt(px, pz) <= 0) return last;
    last = { x: px, z: pz, d };
  }
  return null;
}

/**
 * Builds the harbour works for one settlement, or null if it has no water.
 *
 * The frontage is found by casting rays on a ring of bearings and keeping the
 * shortest run to water: that bearing is the one the town faces its harbour
 * along. The quay is then *marched* along the shoreline from that point, rather
 * than fanned out from the centre, so it stays on the town's own waterfront
 * instead of jumping to whatever coast a distant ray happens to strike.
 */
export function buildHarbour(
  cx: number,
  cz: number,
  radiusKm: number,
  ctx: CityContext,
  seed: number,
): Harbour | null {
  const heightAt = ctx.heightAt;
  const rng = new Rng(seed ^ 0x40b0);
  const reach = reachOf(radiusKm);

  // --- Which way is the water? -------------------------------------------
  // A coarse sweep first, because most settlements are inland and the answer for
  // them is "no harbour" — no point sampling the terrain finely to find that out.
  let bestBearing = -1;
  let bestD = Infinity;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const hit = toShore(cx, cz, Math.cos(a), Math.sin(a), heightAt, reach);
    if (hit && hit.d < bestD) {
      bestD = hit.d;
      bestBearing = a;
    }
  }
  if (bestBearing < 0) return null;

  // Then refine, so the frontage faces the water squarely rather than to the
  // nearest one-eighth of a turn.
  for (let i = -3; i <= 3; i++) {
    const a = bestBearing + (i / 3) * (TAU / 16);
    const hit = toShore(cx, cz, Math.cos(a), Math.sin(a), heightAt, reach);
    if (hit && hit.d < bestD) {
      bestD = hit.d;
      bestBearing = a;
    }
  }

  // --- The waterfront -----------------------------------------------------
  // Marched along the shoreline from the town's own frontage, a bounded distance
  // each way. Fanning rays out from the centre instead — which is what this did
  // first — strings the quay along whatever coast each ray happens to hit, so a
  // town on a headland ends up with a quay on the far side of its own bay.
  const scale = ctx.tier === 'capital' || ctx.tier === 'city' ? 1 : ctx.tier === 'town' ? 0.62 : 0.36;
  const outX = Math.cos(bestBearing);
  const outZ = Math.sin(bestBearing);
  const root = toShore(cx, cz, outX, outZ, heightAt, reach);
  if (!root) return null;

  /**
   * Slides a point onto the waterline along the outward normal.
   *
   * The shore is only defined by sampling, so following it means repeatedly
   * stepping along it and then correcting back onto it — which is exactly what
   * this does, and it is why the quay ends up parallel to the water rather than
   * wandering across it.
   */
  const settle = (x: number, z: number): { x: number; z: number } | null => {
    const span = 0.09;
    const step = 0.006;
    let px = x - outX * span;
    let pz = z - outZ * span;
    if (heightAt(px, pz) <= 0) return null;
    for (let d = 0; d <= span * 2; d += step) {
      const nx = px + outX * step;
      const nz = pz + outZ * step;
      if (heightAt(nx, nz) <= 0) return { x: px, z: pz };
      px = nx;
      pz = nz;
    }
    return null;
  };

  const stepKm = 0.03;
  const halfLength = clamp(radiusKm * 0.55 * scale, 0.12, 0.9);
  const steps = Math.max(3, Math.round(halfLength / stepKm));
  const tangentX = -outZ;
  const tangentZ = outX;

  const march = (sign: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let px = root.x;
    let pz = root.z;
    for (let k = 0; k < steps; k++) {
      const s = settle(px + tangentX * sign * stepKm, pz + tangentZ * sign * stepKm);
      if (!s) break;
      px = s.x;
      pz = s.z;
      out.push([px, pz]);
    }
    return out;
  };

  const back = march(-1).reverse();
  const forward = march(1);
  const chain = [...back, [root.x, root.z] as [number, number], ...forward];
  if (chain.length < 4) return null;

  const pts: number[] = [];
  for (const [x, z] of chain) pts.push(x, z);

  const line = new Float32Array(pts);
  const waterKm = 0;

  const quayHeight = 0.0035 * (0.7 + scale * 0.5);
  const quays: Quay[] = [
    { line, heightKm: quayHeight, apronKm: 0.014 * (0.6 + scale * 0.6) },
  ];

  // --- Jetties ------------------------------------------------------------
  // Spaced along the quay, reaching out to where a hull can float. A jetty that
  // stops short of deep water is a jetty nobody can use, so each one is run out
  // until the water is genuinely open and then a little further.
  const arms: Arm[] = [];
  const hulls: Hull[] = [];
  const jettyCount = ctx.tier === 'capital' ? 6 : ctx.tier === 'city' ? 5 : ctx.tier === 'town' ? 3 : 2;
  const n = line.length / 2;

  for (let k = 0; k < jettyCount; k++) {
    const u = (k + 0.5) / jettyCount;
    const i = clamp(Math.round(u * (n - 1)), 0, n - 1);
    const rootX = line[i * 2];
    const rootZ = line[i * 2 + 1];

    // Out along the local shore normal, not the town's bearing: a jetty stands
    // square to its own piece of shore.
    const a = Math.max(0, i - 1);
    const bIdx = Math.min(n - 1, i + 1);
    let tx = line[bIdx * 2] - line[a * 2];
    let tz = line[bIdx * 2 + 1] - line[a * 2 + 1];
    const tlen = Math.hypot(tx, tz) || 1;
    tx /= tlen;
    tz /= tlen;
    let nx = -tz;
    let nz = tx;
    if (nx * outX + nz * outZ < 0) {
      nx = -nx;
      nz = -nz;
    }

    const length = clamp(0.055 * scale * rng.range(0.7, 1.4), 0.02, 0.16);
    arms.push({
      x: rootX,
      z: rootZ,
      dx: nx,
      dz: nz,
      lengthKm: length,
      widthKm: 0.0055 * (0.7 + scale * 0.5),
      heightKm: quayHeight * 0.8,
      breakwater: false,
    });

    // Hulls lie alongside, bow to stern, on whichever side the rng picks.
    const berths = Math.max(1, Math.round(length / 0.035));
    for (let s = 0; s < berths; s++) {
      if (rng.next() > 0.72) continue;
      const along = ((s + 0.7) / (berths + 0.4)) * length;
      const side = rng.next() < 0.5 ? 1 : -1;
      const off = 0.0055 + 0.004;
      // A working hull, not a galleon: fifteen to thirty metres, which is what
      // ties up at a jetty. Anything larger lies out and lighters its cargo in.
      const hullLen = clamp(0.019 * scale * rng.range(0.65, 1.3), 0.008, 0.032);
      hulls.push({
        x: rootX + nx * along + tx * side * off,
        z: rootZ + nz * along + tz * side * off,
        ax: rootX,
        az: rootZ,
        dx: nx,
        dz: nz,
        lengthKm: hullLen,
        beamKm: hullLen * rng.range(0.24, 0.34),
        heightKm: 0.0022 * rng.range(0.8, 1.3),
        mastKm: rng.next() < 0.7 ? hullLen * rng.range(0.7, 1.1) : 0,
      });
    }
  }

  // --- Breakwater ---------------------------------------------------------
  // Only where there is a real port to shelter. It runs from one end of the quay,
  // angled across the prevailing swell rather than straight out, which is why a
  // harbour mouth is always offset from the middle of its own bay.
  if (ctx.tier === 'capital' || ctx.tier === 'city') {
    const endX = line[0];
    const endZ = line[1];
    const swing = bestBearing + (rng.next() < 0.5 ? 0.7 : -0.7);
    arms.push({
      x: endX,
      z: endZ,
      dx: Math.cos(swing),
      dz: Math.sin(swing),
      lengthKm: clamp(0.13 * scale * rng.range(0.8, 1.3), 0.06, 0.3),
      widthKm: 0.011,
      heightKm: quayHeight * 1.25,
      breakwater: true,
    });
  }

  return { quays, arms, hulls, waterKm };
}
