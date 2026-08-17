/**
 * Elevation synthesis.
 *
 * Two passes over the simulation grid:
 *
 *  1. Build the *continental potential* field from the authored cores plus a
 *     warped fractal, then pick the sea-level threshold from its histogram so
 *     the land fraction lands on target regardless of the seed.
 *  2. Build actual elevation, composing the continental platform, orogenic
 *     uplift along the authored belts, hills, plateaus, coastal ravelling,
 *     stepped mesa country and abyssal ocean floor.
 *
 * Belt and core influence is evaluated on a coarse 256-cell grid and bicubically
 * upsampled - these fields are inherently low-frequency, and doing it this way
 * keeps whole-world generation under a couple of seconds.
 */

import { MACRO, WORLD_KM, HALF_KM, MAX_ELEVATION_KM, MAX_DEPTH_KM } from '../../core/config';
import { Field } from '../../util/grid';
import { clamp01, lerp, smoothstep } from '../../util/math';
import { Simplex, fbm, ridged, billow } from '../../util/noise';
import { deriveSeed } from '../../util/rng';
import { BELTS, CORES, SHOALS, STEP_ZONES, coreInfluence, distToPolyline } from './layout';

/** Coarse grid used for the authored structural fields. */
const STRUCT = 256;

export interface ElevationResult {
  /** Elevation in km, negative below sea level. MACRO x MACRO. */
  height: Field;
  /** 0..1 orogenic intensity - drives ore, ruggedness and range detection. */
  orogeny: Field;
  /** 0..1 continental potential, used later for shelf and coast classification. */
  continental: Field;
  /** Sea-level threshold that was chosen for the continental field. */
  threshold: number;
  landFraction: number;
}

interface StructFields {
  core: Field;
  uplift: Field;
  rugged: Field;
  rift: Field;
  arc: Field;
  shoal: Field;
  shoalDensity: Field;
  step: Field;
  stepSize: Field;
}

function buildStructuralFields(): StructFields {
  const core = new Field(STRUCT);
  const uplift = new Field(STRUCT);
  const rugged = new Field(STRUCT);
  const rift = new Field(STRUCT);
  const arc = new Field(STRUCT);
  const shoal = new Field(STRUCT);
  const shoalDensity = new Field(STRUCT);
  const step = new Field(STRUCT);
  const stepSize = new Field(STRUCT);

  const toWorld = (i: number) => (i / (STRUCT - 1)) * WORLD_KM - HALF_KM;

  for (let gy = 0; gy < STRUCT; gy++) {
    const pz = toWorld(gy);
    for (let gx = 0; gx < STRUCT; gx++) {
      const px = toWorld(gx);
      const i = gy * STRUCT + gx;

      let c = 0;
      for (const k of CORES) c += coreInfluence(px, pz, k) * k.strength;
      core.data[i] = c;

      let up = 0;
      let rg = 0;
      let rf = 0;
      let ar = 0;
      for (const belt of BELTS) {
        const d = Math.sqrt(distToPolyline(px, pz, belt.pts));
        if (d > belt.width * 3.2) continue;
        // Cross-belt profile: full strength in the core, long shoulder outside.
        const t = d / belt.width;
        const profile = t < 1 ? 1 - 0.28 * t * t : Math.exp(-(t - 1) * 1.35);
        const w = profile * belt.strength;
        switch (belt.kind) {
          case 'collision':
          case 'coastal':
          case 'dome':
            up += w;
            rg = Math.max(rg, profile * belt.ruggedness);
            break;
          case 'arc':
            ar = Math.max(ar, w);
            rg = Math.max(rg, profile * belt.ruggedness);
            break;
          case 'rift':
            rf = Math.max(rf, w);
            break;
        }
      }
      uplift.data[i] = up;
      rugged.data[i] = rg;
      rift.data[i] = rf;
      arc.data[i] = ar;

      let sh = 0;
      let shd = 0;
      for (const s of SHOALS) {
        const d = Math.hypot(px - s.x, pz - s.z);
        if (d > s.r * 1.6) continue;
        const t = clamp01(1 - d / s.r);
        const w = t * t * (3 - 2 * t);
        if (w * s.rise > sh) {
          sh = w * s.rise;
          shd = w * s.density;
        }
      }
      shoal.data[i] = sh;
      shoalDensity.data[i] = shd;

      let st = 0;
      let ss = 0.1;
      for (const z of STEP_ZONES) {
        const d = Math.hypot(px - z.x, pz - z.z);
        if (d > z.r * 1.4) continue;
        const w = smoothstep(z.r * 1.25, z.r * 0.45, d) * z.strength;
        if (w > st) {
          st = w;
          ss = z.step;
        }
      }
      step.data[i] = st;
      stepSize.data[i] = ss;
    }
  }

  // Soften the polyline seams so belts read as ranges, not as stencilled ribbons.
  uplift.blur(2, 2);
  rugged.blur(2, 1);
  rift.blur(2, 2);
  arc.blur(1, 1);
  core.blur(1, 1);
  step.blur(2, 2);

  return { core, uplift, rugged, rift, arc, shoal, shoalDensity, step, stepSize };
}

/** Chooses the threshold on the continental field that yields the target land fraction. */
function thresholdForLandFraction(cont: Float32Array, target: number): number {
  const BINS = 2048;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < cont.length; i++) {
    const v = cont[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const hist = new Int32Array(BINS);
  const scale = (BINS - 1) / Math.max(1e-6, hi - lo);
  for (let i = 0; i < cont.length; i++) {
    hist[((cont[i] - lo) * scale) | 0]++;
  }
  const wanted = cont.length * (1 - target);
  let acc = 0;
  for (let b = 0; b < BINS; b++) {
    acc += hist[b];
    if (acc >= wanted) return lo + b / scale;
  }
  return hi;
}

export function generateElevation(seed: number, targetLand = 0.275): ElevationResult {
  const s = buildStructuralFields();

  // Upsample the structural fields to the simulation grid once.
  const core = s.core.resampleTo(MACRO);
  const uplift = s.uplift.resampleTo(MACRO);
  const rugged = s.rugged.resampleTo(MACRO);
  const rift = s.rift.resampleTo(MACRO);
  const arc = s.arc.resampleTo(MACRO);
  const shoal = s.shoal.resampleTo(MACRO);
  const shoalDensity = s.shoalDensity.resampleTo(MACRO);
  const stepAmt = s.step.resampleTo(MACRO);
  const stepSize = s.stepSize.resampleTo(MACRO);

  const nContinent = new Simplex(deriveSeed(seed, 'continent'));
  const nWarpA = new Simplex(deriveSeed(seed, 'warpA'));
  const nWarpB = new Simplex(deriveSeed(seed, 'warpB'));
  const nMountain = new Simplex(deriveSeed(seed, 'mountain'));
  const nMountainWarpA = new Simplex(deriveSeed(seed, 'mwarpA'));
  const nMountainWarpB = new Simplex(deriveSeed(seed, 'mwarpB'));
  const nHills = new Simplex(deriveSeed(seed, 'hills'));
  const nDetail = new Simplex(deriveSeed(seed, 'detail'));
  const nCoast = new Simplex(deriveSeed(seed, 'coast'));
  const nAbyss = new Simplex(deriveSeed(seed, 'abyss'));
  const nIsle = new Simplex(deriveSeed(seed, 'isle'));
  const nPlateau = new Simplex(deriveSeed(seed, 'plateau'));
  const nDune = new Simplex(deriveSeed(seed, 'dune'));

  // Noise domain: 1 unit = WORLD_KM / CONT_SCALE kilometres.
  const CONT_SCALE = 3.05;
  const inv = 1 / (MACRO - 1);

  // --- Pass 1: continental potential -------------------------------------
  const cont = new Float32Array(MACRO * MACRO);
  for (let gy = 0; gy < MACRO; gy++) {
    const v = gy * inv;
    const ny = v * CONT_SCALE;
    for (let gx = 0; gx < MACRO; gx++) {
      const u = gx * inv;
      const nx = u * CONT_SCALE;
      const i = gy * MACRO + gx;

      // Warping the continental field is what turns ellipses into coastlines.
      const wx = nx + fbm(nWarpA, nx * 0.55, ny * 0.55, { octaves: 3 }) * 0.62;
      const wy = ny + fbm(nWarpB, nx * 0.55 + 41.3, ny * 0.55 - 17.9, { octaves: 3 }) * 0.62;

      const broad = fbm(nContinent, wx, wy, { octaves: 5, gain: 0.52 });
      const medium = fbm(nContinent, wx * 2.7 + 9.1, wy * 2.7 - 4.4, { octaves: 3 }) * 0.42;

      let c = core.data[i] * 0.94 + broad * 0.66 + medium;

      // Belts drag the coast outward slightly - ranges rarely end exactly at the sea.
      c += uplift.data[i] * 0.1;
      // Rifts pull the crust down and can flood.
      c -= rift.data[i] * 0.34;
      // Volcanic arcs and shoals lift small patches out of the ocean.
      c += arc.data[i] * 0.3;
      c += shoalDensity.data[i] * 0.22;

      cont[i] = c;
    }
  }

  const threshold = thresholdForLandFraction(cont, targetLand);
  const continental = new Field(MACRO, cont);

  // --- Pass 2: elevation ---------------------------------------------------
  const height = new Field(MACRO);
  const orogeny = new Field(MACRO);
  const H = height.data;
  const O = orogeny.data;
  let landCells = 0;

  for (let gy = 0; gy < MACRO; gy++) {
    const v = gy * inv;
    const ny = v * CONT_SCALE;
    for (let gx = 0; gx < MACRO; gx++) {
      const u = gx * inv;
      const nx = u * CONT_SCALE;
      const i = gy * MACRO + gx;

      const c = cont[i] - threshold;

      // Continental platform: 0 at the waterline, 1 well inland.
      const land01 = smoothstep(0, 0.36, c);
      // Ocean depth ramp: 0 at the waterline, 1 in the abyss.
      const sea01 = smoothstep(0, -0.62, c);

      // --- Base surface ---
      let h = land01 * 0.34 - sea01 * MAX_DEPTH_KM * 0.82;

      // Abyssal relief: mid-ocean rises, seamounts, trenches near arcs.
      if (sea01 > 0.02) {
        const ab = fbm(nAbyss, nx * 3.1, ny * 3.1, { octaves: 4 });
        h += ab * 0.46 * sea01;
        // Continental shelf: a distinct flat step just off the coast.
        const shelf = smoothstep(0.34, 0, -c) * (1 - smoothstep(0, 0.16, -c));
        h += shelf * 0.22;
        // Shoal platforms rise from the floor and host archipelagos.
        h += shoal.data[i] * sea01 * 0.86;
        // Trench outboard of island arcs.
        h -= arc.data[i] * 0.9 * sea01;
      }

      // --- Orogenic uplift ---
      const up = uplift.data[i];
      const rg = rugged.data[i];
      let orog = 0;
      if (up > 0.015) {
        // Warp the ridged field so crests curve and braid instead of running straight.
        const mwx = nx * 1.9 + fbm(nMountainWarpA, nx * 1.1, ny * 1.1, { octaves: 3 }) * 0.5;
        const mwy = ny * 1.9 + fbm(nMountainWarpB, nx * 1.1 - 22.7, ny * 1.1 + 8.3, { octaves: 3 }) * 0.5;
        const crest = ridged(nMountain, mwx, mwy, { octaves: 6, gain: 0.52, lacunarity: 2.11 });
        // Second, finer ridged layer for spurs and side valleys.
        const spur = ridged(nMountain, mwx * 3.3 + 5.5, mwy * 3.3 - 2.1, { octaves: 4, gain: 0.5 });
        const shaped = Math.pow(crest, 1.35 + rg * 0.35) * (0.76 + 0.24 * spur);
        orog = clamp01(up * 0.9) * shaped;
        // Only build real mountains on land; over water the belt becomes an arc.
        const mask = lerp(0.14, 1, land01);
        h += orog * MAX_ELEVATION_KM * 0.86 * mask;
        // Broad dome uplift keeps ranges from being knife-edges on an otherwise flat plain.
        h += clamp01(up) * 0.55 * land01;
      }
      O[i] = orog;

      // Volcanic arcs: isolated steep cones rather than a continuous ridge.
      const arcAmt = arc.data[i];
      if (arcAmt > 0.05) {
        const cone = ridged(nIsle, nx * 8.4, ny * 8.4, { octaves: 3, gain: 0.46 });
        const peaked = Math.pow(cone, 2.6);
        h += peaked * arcAmt * 3.4;
      }

      if (land01 > 0.001) {
        // --- Hills and rolling relief ---
        const hillBase = fbm(nHills, nx * 6.4, ny * 6.4, { octaves: 5, gain: 0.5 });
        const hillRoll = billow(nHills, nx * 3.2 + 17.1, ny * 3.2 - 5.4, { octaves: 3 });
        h += (hillBase * 0.16 + (hillRoll - 0.4) * 0.2) * land01;

        // --- Plateaus: broad raised tablelands with flattened tops ---
        const plateauMask = smoothstep(0.18, 0.52, fbm(nPlateau, nx * 1.45, ny * 1.45, { octaves: 3 }));
        if (plateauMask > 0.01) {
          const target = 0.62 + plateauMask * 1.05;
          const blend = plateauMask * 0.5 * land01;
          h = lerp(h, Math.max(h * 0.55, target), blend);
        }

        // --- Fine detail ---
        const detail = fbm(nDetail, nx * 22, ny * 22, { octaves: 4, gain: 0.48 });
        h += detail * 0.055 * land01 * (0.5 + rg);

        // --- Dune fields: transverse ridges in low, flat, hot-looking country ---
        const flatLow = clamp01(1 - Math.abs(h - 0.25) / 0.55);
        const duneMask = smoothstep(0.3, 0.62, fbm(nDune, nx * 1.1 + 60, ny * 1.1 - 30, { octaves: 2 })) * flatLow;
        if (duneMask > 0.02) {
          const dunes = billow(nDune, nx * 30 + Math.sin(ny * 4.5) * 0.6, ny * 44, { octaves: 2 });
          h += dunes * 0.085 * duneMask * land01;
        }

        // --- Stepped mesa / canyon country ---
        const st = stepAmt.data[i];
        if (st > 0.02) {
          const ss = stepSize.data[i];
          const stepped = Math.floor(h / ss) * ss + ss * 0.5;
          // Jitter the terrace edges so they are not perfect contours.
          const jitter = fbm(nDetail, nx * 9 + 3.3, ny * 9 - 7.7, { octaves: 2 }) * ss * 0.45;
          h = lerp(h, stepped + jitter, st * 0.72 * land01);
        }
      }

      // --- Coastal ravelling: fjords, headlands, sea stacks, offshore islets ---
      const coastBand = Math.exp(-(h / 0.3) * (h / 0.3));
      if (coastBand > 0.02) {
        const rag = fbm(nCoast, nx * 26, ny * 26, { octaves: 4, gain: 0.52 });
        const rag2 = fbm(nCoast, nx * 62 + 11, ny * 62 - 4, { octaves: 3 });
        h += (rag * 0.085 + rag2 * 0.03) * coastBand;
      }

      // Archipelago emergence: shoal platforms sprout islands.
      const shd = shoalDensity.data[i];
      if (shd > 0.03 && h < 0.25) {
        const isl = ridged(nIsle, nx * 17, ny * 17, { octaves: 4, gain: 0.48 });
        const emerge = Math.pow(isl, 2.2) * shd;
        h += emerge * 1.15;
      }

      // Rift floors: below sea level inland becomes an inland sea or a dry basin.
      const rf = rift.data[i];
      if (rf > 0.02) {
        h -= rf * 1.25 * land01;
      }

      if (h > 0) landCells++;
      H[i] = h;
    }
  }

  return {
    height,
    orogeny,
    continental,
    threshold,
    landFraction: landCells / (MACRO * MACRO),
  };
}
