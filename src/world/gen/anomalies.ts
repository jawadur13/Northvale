/**
 * The impossible places.
 *
 * Fourteen of them, in a world of four thousand features. They are stamped into
 * the heightfield *before* hydrology runs, so the rest of the simulation treats
 * them as real ground: the ring mountain fills with a real lake, the shaft
 * through the hollow mountain floods, and rivers route around the wall as they
 * would around any other obstacle. That is the whole trick - the anomalies are
 * impossible in *shape*, but the world's own physics accepts them without
 * comment, which is what makes finding one unsettling rather than decorative.
 *
 * Each one violates a specific rule the rest of the world obeys, and the
 * violation is geometric, so it survives being looked at closely.
 */

import { MACRO, SEA_LEVEL, worldToMacroX, worldToMacroZ, macroToWorldX, macroToWorldZ } from '../../core/config';
import { Field } from '../../util/grid';
import { clamp, clamp01, lerp, smoothstep } from '../../util/math';
import { Simplex, fbm } from '../../util/noise';
import { deriveSeed } from '../../util/rng';

export interface AnomalyDef {
  name: string;
  /** What natural law it breaks, in one line, for the info panel. */
  violates: string;
  x: number;
  z: number;
  /** Nominal radius in km, for camera framing and for the stamp extent. */
  r: number;
  description: string;
  facts: string[];
  /** How hard it is to notice at world zoom. Drives label tier. */
  subtlety: 'obvious' | 'moderate' | 'hidden';
  stamp: (h: Field, def: AnomalyDef, noise: Simplex) => void;
}

/** Runs `fn` over every cell within `radiusKm` of a world point. */
function forEachInRadius(
  x: number,
  z: number,
  radiusKm: number,
  fn: (i: number, dxKm: number, dzKm: number, distKm: number) => void,
): void {
  const cx = worldToMacroX(x);
  const cz = worldToMacroZ(z);
  const kmPerCell = 4096 / (MACRO - 1);
  const rc = Math.ceil(radiusKm / kmPerCell);
  const x0 = Math.max(0, Math.floor(cx - rc));
  const x1 = Math.min(MACRO - 1, Math.ceil(cx + rc));
  const z0 = Math.max(0, Math.floor(cz - rc));
  const z1 = Math.min(MACRO - 1, Math.ceil(cz + rc));
  for (let gy = z0; gy <= z1; gy++) {
    const wz = macroToWorldZ(gy);
    const dz = wz - z;
    for (let gx = x0; gx <= x1; gx++) {
      const wx = macroToWorldX(gx);
      const dx = wx - x;
      const d = Math.hypot(dx, dz);
      if (d > radiusKm) continue;
      fn(gy * MACRO + gx, dx, dz, d);
    }
  }
}

/** Runs `fn` over an oriented rectangle. `u` is along the axis, `v` across it. */
function forEachInRect(
  x: number,
  z: number,
  angle: number,
  halfLengthKm: number,
  halfWidthKm: number,
  fn: (i: number, u: number, v: number) => void,
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const reach = Math.hypot(halfLengthKm, halfWidthKm);
  forEachInRadius(x, z, reach, (i, dx, dz) => {
    const u = dx * cos + dz * sin;
    const v = -dx * sin + dz * cos;
    if (Math.abs(u) > halfLengthKm || Math.abs(v) > halfWidthKm) return;
    fn(i, u, v);
  });
}

/**
 * Positive modulo. JavaScript's % keeps the sign of the dividend, which turns a
 * repeating-pattern expression into NaN the moment it is raised to a fractional
 * power on the negative side of the origin.
 */
function pmod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/** Triangle wave in [0,1] with period `m`, peaking at multiples of `m`. */
function sawTo(a: number, m: number): number {
  return Math.abs(pmod(a, m) / m - 0.5) * 2;
}

export const ANOMALIES: AnomalyDef[] = [
  {
    name: 'The Ninth Step',
    violates: 'Erosion does not produce concentric circles.',
    x: -690,
    z: -905,
    r: 46,
    subtlety: 'obvious',
    description:
      'A mountain in nine terraces. Each terrace is a perfect annulus, each riser is exactly one hundred and twelve metres, and the treads are level to within the width of a hand. Surveyors have measured it eleven times. It has never once been off.',
    facts: [
      'Nine terraces, each riser exactly 112 m',
      'Terrace treads level to within 90 mm over 4 km',
      'No sedimentary layering; the rock is uniform granite throughout',
      'Snowline follows the seventh riser exactly, all year',
    ],
    stamp: (h, def, noise) => {
      const STEPS = 9;
      const RISER = 0.112;
      const base = 0.42;
      forEachInRadius(def.x, def.z, def.r, (i, dx, dz, d) => {
        const t = d / def.r;
        // Perfectly concentric terraces, quantised with a hard edge.
        const step = Math.max(0, STEPS - Math.floor(t * STEPS + 0.0001));
        const target = base + step * RISER;
        // Only the outer edge blends into the surrounding land.
        const blend = smoothstep(1, 0.9, t);
        // A whisper of noise on the risers only, so the treads stay flat.
        const riserPhase = (t * STEPS) % 1;
        const edge = smoothstep(0.06, 0, Math.min(riserPhase, 1 - riserPhase));
        const jitter = fbm(noise, dx * 0.4, dz * 0.4, { octaves: 2 }) * 0.012 * edge;
        h.data[i] = lerp(h.data[i], target + jitter, blend);
      });
    },
  },
  {
    name: 'The Cirque',
    violates: 'A circular ridge cannot form without an impact, and there is no impact debris.',
    x: -1148,
    z: 418,
    r: 38,
    subtlety: 'obvious',
    description:
      'A ring of mountains twenty-nine kilometres across, unbroken, with a lake at the centre. The ring has no gap, no outflow and no inflow. The lake level has not changed in recorded history. There is no crater ejecta anywhere on the surrounding plain.',
    facts: [
      'Ring diameter 29.0 km, circular to within 40 m',
      'Ridge crest at a constant 1,840 m for its entire circumference',
      'Central lake has no inlet and no outlet',
      'The plain outside the ring is undisturbed',
    ],
    stamp: (h, def, noise) => {
      const ringR = def.r * 0.62;
      const ringW = def.r * 0.2;
      const crest = 1.84;
      forEachInRadius(def.x, def.z, def.r, (i, dx, dz, d) => {
        const dr = Math.abs(d - ringR);
        let target: number;
        if (dr < ringW) {
          // Constant-height crest with a smooth cross-section.
          const prof = Math.cos((dr / ringW) * Math.PI * 0.5);
          target = 0.34 + (crest - 0.34) * Math.pow(prof, 0.55);
        } else if (d < ringR) {
          // Flat basin floor, which hydrology will fill with a lake.
          target = 0.3;
        } else {
          target = lerp(0.34, h.data[i], smoothstep(ringR + ringW, def.r, d));
        }
        const blend = smoothstep(1, 0.86, d / def.r);
        const jitter = fbm(noise, dx * 0.5, dz * 0.5, { octaves: 2 }) * 0.02;
        h.data[i] = lerp(h.data[i], target + jitter * (dr < ringW ? 1 : 0.3), blend);
      });
    },
  },
  {
    name: 'The Drowned Stair',
    violates: 'A dry valley cannot sit below sea level ten kilometres from an open coast.',
    x: 1062,
    z: -128,
    r: 54,
    subtlety: 'moderate',
    description:
      'The floor of this valley lies four hundred and ten metres below sea level. The sea is eleven kilometres away, across a saddle that rises no higher than sixty metres. The valley is bone dry. Nothing holds the water back. The water simply does not come.',
    facts: [
      'Floor elevation -410 m',
      'Nearest open sea 11 km east, separated by a 58 m saddle',
      'Annual rainfall under 20 mm; no standing water at any season',
      'Salt crust chemistry is continental, not marine',
    ],
    stamp: (h, def, noise) => {
      forEachInRadius(def.x, def.z, def.r, (i, dx, dz, d) => {
        const t = d / def.r;
        // A stepped descent into a basin well below sea level.
        const depth = -0.41;
        const stairs = Math.floor((1 - t) * 6) / 6;
        const target = lerp(0.06, depth, smoothstep(0.9, 0.15, t)) + stairs * 0.02;
        const blend = smoothstep(1, 0.82, t);
        const jitter = fbm(noise, dx * 0.6, dz * 0.6, { octaves: 3 }) * 0.014;
        h.data[i] = lerp(h.data[i], target + jitter, blend);
      });
    },
  },
  {
    name: 'Vantage',
    violates: 'No rock has the compressive strength to stand this tall and this thin.',
    x: 118,
    z: 1204,
    r: 26,
    subtlety: 'obvious',
    description:
      'A single spire rising 9,340 metres from a plateau at 1,100. It is 6.8 kilometres wide at the base and 400 metres wide at the summit, and it has stood through every recorded earthquake without shedding so much as a boulder. It is the highest point in the world by three kilometres.',
    facts: [
      'Summit 9,340 m - the highest point in Northvale',
      'Base width 6.8 km; aspect ratio far beyond any known rock',
      'No talus field at the foot',
      'Casts a shadow 60 km long at midwinter',
    ],
    stamp: (h, def) => {
      const summit = 9.34;
      forEachInRadius(def.x, def.z, def.r, (i, _dx, _dz, d) => {
        const t = d / def.r;
        // A broad plateau, then a needle that ignores the angle of repose.
        const plateau = lerp(1.1, h.data[i], smoothstep(0.55, 1, t));
        const needleT = clamp01(1 - d / 3.4);
        const needle = Math.pow(needleT, 0.34) * (summit - 1.1);
        h.data[i] = Math.max(plateau, 1.1 + needle);
      });
    },
  },
  {
    name: 'The Ouroboros',
    violates: 'Water cannot flow in a closed loop. This water does.',
    x: 1466,
    z: 758,
    r: 34,
    subtlety: 'moderate',
    description:
      'A river sixty-eight kilometres long that begins and ends at the same point, flowing continuously in one direction around a closed circuit. Floats released anywhere on it return to where they started in about nine days. It has no source, no mouth, and it has never dried.',
    facts: [
      'Circuit length 68 km, closed',
      'Consistent downstream flow of 0.4 m/s the whole way round',
      'No inflow, no outflow, no measurable evaporation deficit',
      'Width constant at 6.4 km and depth at 3.1 m for the entire circuit',
    ],
    stamp: (h, def, noise) => {
      const ringR = def.r * 0.62;
      const channelW = 3.2;
      forEachInRadius(def.x, def.z, def.r, (i, dx, dz, d) => {
        const dr = Math.abs(d - ringR);
        // Gentle dome so the ring is visibly perched, then cut a level channel.
        const dome = lerp(0.62, 0.3, smoothstep(0, def.r, d));
        let target = dome;
        if (dr < channelW) {
          target = 0.28 - (1 - dr / channelW) * 0.02;
        }
        const blend = smoothstep(1, 0.85, d / def.r);
        const jitter = fbm(noise, dx * 0.7, dz * 0.7, { octaves: 2 }) * 0.01;
        h.data[i] = lerp(h.data[i], target + jitter, blend);
      });
    },
  },
  {
    name: 'The Inverted Peak',
    violates: 'It is the exact negative of the mountain beside it, to the metre.',
    x: -318,
    z: -1244,
    r: 30,
    subtlety: 'moderate',
    description:
      'A conical pit 2,180 metres deep, ten kilometres west of a mountain 2,180 metres tall. Every contour of the pit matches a contour of the mountain, mirrored. Two survey teams working independently produced the same result and neither would publish it.',
    facts: [
      'Depth 2,180 m; the neighbouring summit is 2,180 m',
      'Contours match the mountain under reflection, to survey tolerance',
      'The pit is dry - no lake, despite 800 mm of annual rainfall',
      'Air temperature at the bottom is 4 C warmer than the lapse rate allows',
    ],
    stamp: (h, def) => {
      // Mountain on the east, its exact inverse on the west.
      const peakH = 2.18;
      const sep = 10;
      forEachInRadius(def.x + sep, def.z, def.r * 0.55, (i, _dx, _dz, d) => {
        const t = clamp01(1 - d / (def.r * 0.55));
        h.data[i] = Math.max(h.data[i], 0.5 + Math.pow(t, 1.4) * peakH);
      });
      forEachInRadius(def.x - sep, def.z, def.r * 0.55, (i, _dx, _dz, d) => {
        const t = clamp01(1 - d / (def.r * 0.55));
        const target = 0.5 - Math.pow(t, 1.4) * peakH;
        h.data[i] = Math.min(h.data[i], target);
      });
    },
  },
  {
    name: 'The Straight Shore',
    violates: 'Coastlines are fractal. This one is a line.',
    x: 640,
    z: 246,
    r: 170,
    subtlety: 'moderate',
    description:
      'Three hundred and twenty kilometres of coast with no bay, no headland and no curve. It deviates from a straight line by less than eleven metres over its whole length. The rock is ordinary sandstone, the tide is ordinary, and the beach on the landward side is an ordinary beach.',
    facts: [
      'Length 320 km; maximum deviation from true 11 m',
      'Bearing constant at 041 degrees',
      'Depth 4 m at 100 m offshore, uniformly, along the entire length',
      'Neither erosion nor deposition has been measured in 200 years of records',
    ],
    stamp: (h, def) => {
      // Adaptive: find the nearest real coast and straighten *that*, so the
      // anomaly attaches to genuine geography rather than inventing land.
      const H = h.data;
      const cx = Math.round(worldToMacroX(def.x));
      const cz = Math.round(worldToMacroZ(def.z));
      let bestCell = -1;
      let bestD = Infinity;
      for (let gy = Math.max(1, cz - 60); gy < Math.min(MACRO - 1, cz + 60); gy++) {
        for (let gx = Math.max(1, cx - 60); gx < Math.min(MACRO - 1, cx + 60); gx++) {
          const i = gy * MACRO + gx;
          if (H[i] <= SEA_LEVEL) continue;
          if (
            H[i + 1] > SEA_LEVEL &&
            H[i - 1] > SEA_LEVEL &&
            H[i + MACRO] > SEA_LEVEL &&
            H[i - MACRO] > SEA_LEVEL
          ) {
            continue;
          }
          const d = (gx - cx) * (gx - cx) + (gy - cz) * (gy - cz);
          if (d < bestD) {
            bestD = d;
            bestCell = i;
          }
        }
      }
      if (bestCell < 0) return;

      const bx = bestCell % MACRO;
      const by = (bestCell / MACRO) | 0;
      // Local outward normal from the gradient of the land mask.
      let nx = 0;
      let nz = 0;
      for (let dy = -6; dy <= 6; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
          const gx = clamp(bx + dx, 0, MACRO - 1);
          const gy = clamp(by + dy, 0, MACRO - 1);
          const land = H[gy * MACRO + gx] > SEA_LEVEL ? 1 : -1;
          nx -= dx * land;
          nz -= dy * land;
        }
      }
      const len = Math.hypot(nx, nz) || 1;
      nx /= len;
      nz /= len;
      const angle = Math.atan2(nx, -nz); // rect axis runs along the shore

      const ox = macroToWorldX(bx);
      const oz = macroToWorldZ(by);

      // Which side of the line is currently land? Sample both and let the
      // terrain decide, so the straightened coast keeps the real orientation.
      let landSign = 1;
      {
        let plus = 0;
        let minus = 0;
        for (let t = 6; t <= 24; t += 3) {
          const px = bx + Math.round((nx * t) / (4096 / (MACRO - 1)));
          const pz = by + Math.round((nz * t) / (4096 / (MACRO - 1)));
          const mx = bx - Math.round((nx * t) / (4096 / (MACRO - 1)));
          const mz = by - Math.round((nz * t) / (4096 / (MACRO - 1)));
          if (H[clamp(pz, 0, MACRO - 1) * MACRO + clamp(px, 0, MACRO - 1)] > SEA_LEVEL) plus++;
          if (H[clamp(mz, 0, MACRO - 1) * MACRO + clamp(mx, 0, MACRO - 1)] > SEA_LEVEL) minus++;
        }
        // The rect's +v axis is the rotated normal, so agreement with `nx,nz`
        // tells us which sign of v points inland.
        landSign = plus >= minus ? 1 : -1;
      }

      forEachInRect(ox, oz, angle, 160, 34, (i, _u, v) => {
        // Force the land/water zero crossing exactly onto v = 0, while keeping
        // whatever relief texture the terrain already had on each side.
        const sign = v * landSign >= 0 ? 1 : -1;
        const mag = Math.abs(H[i]);
        const taper = smoothstep(34, 6, Math.abs(v));
        const forced = sign * Math.max(mag, 0.02 + Math.abs(v) * 0.004);
        H[i] = lerp(H[i], forced, taper);
      });
    },
  },
  {
    name: 'The Tessellation',
    violates: 'Basalt columns are centimetres across. These are six kilometres.',
    x: 764,
    z: -436,
    r: 96,
    subtlety: 'obvious',
    description:
      'Twenty-eight thousand square kilometres of hexagonal columns, each one flat-topped, each one 6.2 kilometres across, each one fitting its neighbours with a joint you cannot get a knife into. From the ground it is a plain of low cliffs. From altitude it is a honeycomb.',
    facts: [
      'Columns 6.2 km across, hexagonal, to a tolerance of 3 m',
      'Column tops vary by no more than 8 m across the whole field',
      'Tops stand 260 m above the plain the joints run down to',
      'Joints are 40-90 mm wide and vertical for their full depth',
      'Drilling has reached 900 m without finding the base of a column',
    ],
    stamp: (h, def, noise) => {
      const CELL = 6.2;
      forEachInRadius(def.x, def.z, def.r, (i, dx, dz, d) => {
        // Axial hex coordinates, rounded to the nearest hex centre.
        const q = ((dx * Math.sqrt(3)) / 3 - dz / 3) / CELL;
        const r = (dz * (2 / 3)) / CELL;
        let rq = Math.round(q);
        let rr = Math.round(r);
        const rs = Math.round(-q - r);
        if (Math.abs(rq - q) > Math.abs(rr - r) && Math.abs(rq - q) > Math.abs(-q - r - rs)) {
          rq = -rr - rs;
        } else if (Math.abs(rr - r) > Math.abs(-q - r - rs)) {
          rr = -rq - rs;
        }
        // Distance to the hex centre, normalised, gives the joint gutters.
        const hx = CELL * Math.sqrt(3) * (rq + rr / 2);
        const hz = CELL * 1.5 * rr;
        const inner = Math.hypot(dx - hx, dz - hz) / CELL;
        const joint = smoothstep(0.7, 0.99, inner);
        // The column tops are level to within a few metres, as the survey says.
        const top = 0.82 + fbm(noise, rq * 3.1, rr * 3.1, { octaves: 1 }) * 0.008;
        // The joints drop to the original ground rather than cutting a trench into
        // it. Cutting a closed lattice of trenches into a plateau gives the
        // depression filler a lattice of basins to fill, and the honeycomb comes
        // out as a honeycomb of lakes. Dropping to the pre-existing surface leaves
        // the original drainage intact, so the joints stay dry and the field reads
        // as what it is: columns standing above a plain.
        const floor = Math.min(h.data[i], top - 0.26);
        const target = lerp(top, floor, joint);
        const blend = smoothstep(1, 0.8, d / def.r);
        h.data[i] = lerp(h.data[i], target, blend);
      });
    },
  },
  {
    name: 'The Sundering',
    violates: 'Two rock faces cannot stay parallel for two hundred kilometres.',
    x: 1094,
    z: -352,
    r: 130,
    subtlety: 'moderate',
    description:
      'A cleft through the Zerrakhan tableland: 206 kilometres long, 940 metres deep, and exactly 5,000 metres wide from end to end. The two walls are vertical and parallel. They are also, in cross-section, mirror images - every ledge on one face has its match on the other.',
    facts: [
      'Length 206 km, width 5,000 m, depth 940 m',
      'Walls vertical to within 0.2 degrees',
      'Opposing faces are mirror-symmetric ledge for ledge',
      'No river at the bottom, and no evidence there ever was one',
    ],
    stamp: (h, def, noise) => {
      const angle = 0.42;
      forEachInRect(def.x, def.z, angle, 103, 34, (i, u, v) => {
        const av = Math.abs(v);
        if (av < 2.5) {
          // Floor: flat, and dead level along the full length.
          h.data[i] = 0.62;
        } else if (av < 3.4) {
          // The wall, as near to vertical as a heightfield permits.
          h.data[i] = lerp(0.62, 1.56, (av - 2.5) / 0.9);
        } else {
          // Tableland either side, with mirrored ledges.
          const ledge = Math.floor((av - 3.4) * 0.7) / 0.7;
          const jitter = fbm(noise, u * 0.3, ledge * 9, { octaves: 2 }) * 0.02;
          const target = 1.56 + ledge * 0.04 + jitter;
          h.data[i] = lerp(h.data[i], target, smoothstep(34, 4, av));
        }
      });
    },
  },
  {
    name: 'The Nesting Lakes',
    violates: 'Self-similarity at five orders of magnitude does not occur in nature.',
    x: -952,
    z: -1046,
    r: 30,
    subtlety: 'hidden',
    description:
      'A lake with an island. On the island, a lake. On that lake, an island, and so on, five times, each exactly one third the size of the last. The innermost lake is nine metres across and eleven centimetres deep. There is an island in it.',
    facts: [
      'Five nested generations, ratio exactly 1:3',
      'Outer lake 21.6 km across; innermost 9 m',
      'Every island is concentric with its parent to within 0.4%',
      'All five water surfaces sit at different elevations',
    ],
    stamp: (h, def) => {
      const outer = 10.8;
      forEachInRadius(def.x, def.z, def.r, (i, _dx, _dz, d) => {
        let target = 0.34;
        let radius = outer;
        let level = 0.3;
        // Alternate water / land inward, thirding each generation.
        for (let gen = 0; gen < 6; gen++) {
          if (d > radius) break;
          const isWater = gen % 2 === 0;
          target = isWater ? level - 0.03 : level + 0.05;
          level += isWater ? 0.008 : 0.012;
          radius /= 3;
        }
        const blend = smoothstep(def.r, def.r * 0.72, d);
        h.data[i] = lerp(h.data[i], target, blend);
      });
    },
  },
  {
    name: 'The Quiet',
    violates: 'The sea floor here is a plane. Sea floors are not planes.',
    x: -96,
    z: 322,
    r: 96,
    subtlety: 'hidden',
    description:
      'A disc of ocean 190 kilometres across in which the sea floor is flat to within a metre, at a uniform depth of 2,000. Inside the disc there are no waves above forty centimetres regardless of the weather outside it. Ships becalmed here report the silence as the worst part.',
    facts: [
      'Depth uniform at 2,000 m across 190 km',
      'Floor flat to within 1 m; no sediment gradient',
      'Wave height capped at 0.4 m in any conditions',
      'The boundary is sharp enough to see from a masthead',
    ],
    stamp: (h, def) => {
      forEachInRadius(def.x, def.z, def.r, (i, _dx, _dz, d) => {
        const blend = smoothstep(def.r, def.r * 0.94, d);
        h.data[i] = lerp(h.data[i], -2.0, blend);
      });
    },
  },
  {
    name: 'The Level Range',
    violates: 'Sixteen independent summits do not share an elevation.',
    x: -486,
    z: 1128,
    r: 88,
    subtlety: 'hidden',
    description:
      'Sixteen peaks along ninety kilometres of ridge. Every one of them stands at 3,412 metres. Not approximately - sixteen separate surveys, sixteen identical figures. The saddles between them vary normally. Only the summits agree.',
    facts: [
      'All 16 summits at 3,412 m',
      'Intervening saddles range from 2,180 m to 3,090 m',
      'Rock type varies between summits; the elevation does not',
      'Re-surveyed in three different decades with the same result',
    ],
    stamp: (h, def, noise) => {
      const LEVEL = 3.412;
      const angle = -0.18;
      forEachInRect(def.x, def.z, angle, 46, 16, (i, u, v) => {
        // A ridge with peaks at regular intervals, all clipped to one elevation.
        const peakPhase = sawTo(u, 11.5);
        const along = Math.pow(1 - peakPhase, 1.6);
        const across = Math.max(0, 1 - Math.abs(v) / 16);
        const ridge = 1.9 + along * 1.9 + fbm(noise, u * 0.6, v * 0.6, { octaves: 3 }) * 0.34;
        const shaped = lerp(h.data[i], ridge, across * across);
        // The clip is the anomaly: nothing may exceed the level.
        h.data[i] = Math.min(shaped, LEVEL - (1 - across) * 0.9);
      });
    },
  },
  {
    name: 'The Hollow',
    violates: 'A vertical shaft 4,600 m wide should have collapsed.',
    x: 1618,
    z: -712,
    r: 34,
    subtlety: 'moderate',
    description:
      'A mountain with a hole through the middle of it. The shaft is circular, 4,600 metres across, and vertical from the summit at 2,900 metres down past sea level. The bottom is water. Sounding lines have reached 600 metres below sea level without touching anything.',
    facts: [
      'Shaft diameter 4,600 m, circular to within 6 m',
      'Vertical from 2,900 m to below sea level - a 3.5 km drop',
      'Water at the bottom is fresh, and does not rise or fall with the tide',
      'No sound returns from the shaft. None at all.',
    ],
    stamp: (h, def) => {
      forEachInRadius(def.x, def.z, def.r, (i, _dx, _dz, d) => {
        const t = clamp01(1 - d / def.r);
        const cone = 0.4 + Math.pow(t, 1.5) * 2.5;
        h.data[i] = Math.max(h.data[i], cone);
        // Then punch the shaft.
        if (d < 2.3) {
          h.data[i] = -0.6;
        } else if (d < 3.0) {
          h.data[i] = lerp(-0.6, Math.max(h.data[i], cone), (d - 2.3) / 0.7);
        }
      });
    },
  },
  {
    name: 'The Meridian Wall',
    violates: 'It runs dead straight for 500 km across three different rock types.',
    x: 912,
    z: 96,
    r: 260,
    subtlety: 'obvious',
    description:
      'A natural wall of dark stone, 620 metres high and 6.4 kilometres thick, running due north for five hundred and two kilometres across the Sahvarem. It crosses sandstone, limestone and granite without changing composition, height or bearing. Caravans use the gaps. There are four gaps. They are evenly spaced.',
    facts: [
      'Length 502 km on a bearing of 000 degrees',
      'Height constant at 620 m above the plain, thickness 6.4 km',
      'Four gaps, spaced 100.4 km apart to within 300 m',
      'Composition identical along its whole length',
    ],
    stamp: (h, def, noise) => {
      forEachInRect(def.x, def.z, Math.PI / 2, 251, 22, (i, u, v) => {
        // Four evenly spaced gaps let the caravan roads through.
        const gapPhase = sawTo(u + 251, 100.4);
        const gap = smoothstep(0.965, 0.995, gapPhase);
        const av = Math.abs(v);
        const cross = smoothstep(1.0, 0.82, av / 3.2);
        const target = h.data[i] + 0.62 * cross * (1.0 - gap);
        const jitter = fbm(noise, u * 0.2, v * 0.6, { octaves: 2 }) * 0.014 * cross;
        h.data[i] = lerp(h.data[i], target + jitter, smoothstep(22, 3, av));
      });
    },
  },
];

/** Applies every anomaly to the heightfield. Must run before hydrology. */
export function stampAnomalies(height: Field, seed: number): void {
  const noise = new Simplex(deriveSeed(seed, 'anomaly'));
  for (const def of ANOMALIES) {
    def.stamp(height, def, noise);
  }
}

/** Label tier for an anomaly: the obvious ones are visible from world view. */
export function anomalyLabelTier(subtlety: AnomalyDef['subtlety']): number {
  return subtlety === 'obvious' ? 1 : subtlety === 'moderate' ? 2 : 3;
}
