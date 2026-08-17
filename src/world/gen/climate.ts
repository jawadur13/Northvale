/**
 * Climate.
 *
 * Temperature is latitude minus an elevation lapse rate, nudged by
 * continentality and by ocean-current anomalies. Moisture is simulated rather
 * than sampled from noise: prevailing winds march across the grid carrying
 * humidity, pick it up over water and drop it as rain when the land rises under
 * them. That single mechanism is what puts rainforest on windward coasts,
 * deserts in the lee of every major range, and steppe in the deep interior -
 * and it means the deserts are *where they should be* rather than wherever the
 * noise happened to be dry.
 */

import { MACRO, MACRO_CELL_KM, SEA_LEVEL, zToLatitude, macroToWorldZ } from '../../core/config';
import { Field } from '../../util/grid';
import { clamp, clamp01, lerp, smoothstep } from '../../util/math';
import { Simplex, fbm } from '../../util/noise';
import { deriveSeed } from '../../util/rng';
import { Biome, BIOME_BY_ID, classifyLand, classifyWater } from './biomes';

/** Dry adiabatic-ish lapse rate in Celsius per kilometre. */
const LAPSE = 6.3;

export interface ClimateResult {
  /** Mean annual temperature in Celsius. */
  temperature: Field;
  /** 0..1 annual precipitation proxy. Used for facts and for the shader. */
  moisture: Field;
  /**
   * Precipitation divided by potential evapotranspiration, normalised so that a
   * temperate cell is unchanged. This is what biomes actually respond to: 400 mm
   * of rain is semi-arid in the tropics and ample in the subarctic, and without
   * the correction every cold continental interior classifies as cold desert
   * instead of as the boreal forest it should be.
   */
  aridity: Field;
  /** 0..1 vegetation cover, drives the shader and the instanced scatter. */
  vegetation: Field;
  /** Normalised terrain gradient, 0..1. */
  slope: Field;
  /** Kilometres to the nearest ocean cell. */
  coastDistance: Field;
  /** Discrete biome per cell. */
  biome: Uint8Array;
}

/**
 * Two-pass chamfer distance transform to the nearest ocean cell, in km.
 * Approximate but smooth, and it costs two linear sweeps instead of a BFS.
 */
function oceanDistance(height: Field): Field {
  const n = MACRO * MACRO;
  const d = new Field(MACRO);
  const D = d.data;
  const H = height.data;
  const BIG = 1e9;
  for (let i = 0; i < n; i++) D[i] = H[i] <= SEA_LEVEL ? 0 : BIG;

  const ORTHO = 1;
  const DIAG = Math.SQRT2;

  for (let y = 0; y < MACRO; y++) {
    for (let x = 0; x < MACRO; x++) {
      const i = y * MACRO + x;
      let v = D[i];
      if (y > 0) {
        v = Math.min(v, D[i - MACRO] + ORTHO);
        if (x > 0) v = Math.min(v, D[i - MACRO - 1] + DIAG);
        if (x < MACRO - 1) v = Math.min(v, D[i - MACRO + 1] + DIAG);
      }
      if (x > 0) v = Math.min(v, D[i - 1] + ORTHO);
      D[i] = v;
    }
  }
  for (let y = MACRO - 1; y >= 0; y--) {
    for (let x = MACRO - 1; x >= 0; x--) {
      const i = y * MACRO + x;
      let v = D[i];
      if (y < MACRO - 1) {
        v = Math.min(v, D[i + MACRO] + ORTHO);
        if (x > 0) v = Math.min(v, D[i + MACRO - 1] + DIAG);
        if (x < MACRO - 1) v = Math.min(v, D[i + MACRO + 1] + DIAG);
      }
      if (x < MACRO - 1) v = Math.min(v, D[i + 1] + ORTHO);
      D[i] = v;
    }
  }

  for (let i = 0; i < n; i++) D[i] = Math.min(D[i], 1e6) * MACRO_CELL_KM;
  return d;
}

/** Normalised gradient magnitude of the height field, 0..1. */
function computeSlope(height: Field): Field {
  const s = new Field(MACRO);
  const S = s.data;
  for (let y = 0; y < MACRO; y++) {
    for (let x = 0; x < MACRO; x++) {
      const dx = (height.at(x + 1, y) - height.at(x - 1, y)) / (2 * MACRO_CELL_KM);
      const dy = (height.at(x, y + 1) - height.at(x, y - 1)) / (2 * MACRO_CELL_KM);
      // dz/dx in km per km; a slope of 1 is 45 degrees. Compress so 0.45 reads as steep.
      S[y * MACRO + x] = clamp01(Math.hypot(dx, dy) / 0.45);
    }
  }
  return s;
}

/**
 * Prevailing wind at a latitude: trade easterlies in the tropics, westerlies in
 * the mid-latitudes, polar easterlies at the caps. Returns the direction the air
 * is *travelling*, as a sign on x.
 */
function zonalWindDir(latAbs: number): number {
  if (latAbs < 28) return -1; // trades blow east to west
  if (latAbs < 62) return 1; // westerlies blow west to east
  return -1; // polar easterlies
}

/** Base humidity a parcel can hold, from sea-surface temperature. */
function saturation(tempC: number): number {
  return clamp01(0.22 + 0.038 * (tempC + 8));
}

/**
 * Marches humidity across the grid along one axis and records precipitation.
 *
 * @param axis 0 for east-west rows, 1 for north-south columns
 * @param dirFor returns the travel direction (+1 / -1) for a given line index
 */
function marchMoisture(
  height: Field,
  temperature: Field,
  axis: 0 | 1,
  dirFor: (line: number) => number,
  out: Field,
): void {
  const H = height.data;
  const T = temperature.data;
  const O = out.data;

  for (let line = 0; line < MACRO; line++) {
    const dir = dirFor(line);
    const start = dir > 0 ? 0 : MACRO - 1;
    const end = dir > 0 ? MACRO : -1;

    let humidity = 0;
    let prevElev = 0;

    for (let step = start; step !== end; step += dir) {
      const i = axis === 0 ? line * MACRO + step : step * MACRO + line;
      const h = H[i];
      const t = T[i];
      const cap = saturation(t);

      if (h <= SEA_LEVEL) {
        // Over water: evaporate toward capacity. Warm seas charge the air fast.
        humidity = lerp(humidity, cap, 0.24 + clamp01(t / 40) * 0.3);
        prevElev = 0;
        // Deliberately *not* accumulated. Precipitation over the ocean is
        // irrelevant to biome classification, and including it would dominate
        // the normalisation percentile and flatten every land cell to desert.
        continue;
      }

      // Orographic lift: rising ground along the wind forces precipitation. This
      // is the term that carves the rain shadows.
      const rise = Math.max(0, h - prevElev);
      prevElev = h;
      const lift = clamp01(rise / 0.16);

      // Convective baseline: warm air rains a little everywhere it goes.
      const convective = 0.006 + clamp01(t / 34) * 0.014;
      let rain = humidity * (convective + lift * 0.62);

      // Cold air simply cannot carry much, so high latitudes dry out.
      if (humidity > cap) rain += (humidity - cap) * 0.5;

      rain = Math.min(rain, humidity);
      humidity -= rain;

      // Continental recycling. Roughly half of what falls on land returns to the
      // air as evapotranspiration and falls again further downwind. Without this
      // the march desiccates completely within about 400 km and every continental
      // interior comes out as hyper-arid desert, which is not how continents work.
      humidity += rain * 0.55;
      // A floor representing soil moisture and inland water, so deep interiors
      // land on steppe rather than on bare sand.
      const floor = cap * 0.085;
      if (humidity < floor) humidity = floor;

      O[i] += rain;
    }
  }
}

export function generateClimate(height: Field, orogeny: Field, waterTable: Field, seed: number): ClimateResult {
  const n = MACRO * MACRO;
  const H = height.data;

  const nAnomaly = new Simplex(deriveSeed(seed, 'sst'));
  const nTempJitter = new Simplex(deriveSeed(seed, 'tempjit'));
  const nMoistJitter = new Simplex(deriveSeed(seed, 'moistjit'));
  const nVeg = new Simplex(deriveSeed(seed, 'vegpatch'));

  const coastDistance = oceanDistance(height);
  const slope = computeSlope(height);

  // --- Temperature -------------------------------------------------------
  const temperature = new Field(MACRO);
  const T = temperature.data;
  const inv = 1 / (MACRO - 1);
  for (let gy = 0; gy < MACRO; gy++) {
    const lat = zToLatitude(macroToWorldZ(gy));
    const latAbs = Math.abs(lat);
    // 28 C at the equator falling to about -16 C at the poles. The exponent
    // matters more than the endpoints: a linear-ish falloff puts tundra at 50
    // degrees, which is roughly Britain, and turns a third of the world's land
    // into permafrost.
    const base = 28 - 44 * Math.pow(latAbs / 74, 1.85);
    const ny = gy * inv * 2.4;
    for (let gx = 0; gx < MACRO; gx++) {
      const i = gy * MACRO + gx;
      const nx = gx * inv * 2.4;
      // Ocean-current anomaly: warm and cold currents make coasts differ.
      const anomaly = fbm(nAnomaly, nx * 0.8, ny * 0.8, { octaves: 3 }) * 3.4;
      // Continentality: interiors run colder on the annual mean at high latitude.
      const cont = clamp01(coastDistance.data[i] / 900);
      const contTerm = -cont * 3.2 * (0.25 + (latAbs / 74) * 0.9);
      const jitter = fbm(nTempJitter, nx * 5, ny * 5, { octaves: 3 }) * 1.1;
      const elev = Math.max(0, H[i]);
      T[i] = base + anomaly * (H[i] <= SEA_LEVEL ? 1 : 0.45) + contTerm + jitter - elev * LAPSE;
    }
  }

  // --- Moisture ----------------------------------------------------------
  const rain = new Field(MACRO);

  // Zonal march (dominant).
  marchMoisture(height, temperature, 0, (row) => zonalWindDir(Math.abs(zToLatitude(macroToWorldZ(row)))), rain);

  // Meridional march: moisture drawn off the tropical oceans toward both poles,
  // which gives monsoon-facing coasts and keeps mid-continent from being uniform.
  const meridional = new Field(MACRO);
  marchMoisture(height, temperature, 1, () => 1, meridional);
  const meridional2 = new Field(MACRO);
  marchMoisture(height, temperature, 1, () => -1, meridional2);

  const moisture = new Field(MACRO);
  const M = moisture.data;
  for (let i = 0; i < n; i++) {
    M[i] = rain.data[i] * 0.62 + (meridional.data[i] + meridional2.data[i]) * 0.19;
  }
  moisture.blur(2, 1);

  // Normalise against a high percentile of the *land* distribution, so a handful
  // of drenched windward slopes do not squash the rest of the world dry.
  const landValues: number[] = [];
  for (let i = 0; i < n; i++) if (H[i] > SEA_LEVEL) landValues.push(M[i]);
  landValues.sort((a, b) => a - b);
  const p94 = landValues.length ? landValues[Math.floor(landValues.length * 0.94)] || 1 : 1;
  for (let i = 0; i < n; i++) {
    // Open water is saturated by definition; it is only classified by depth.
    M[i] = H[i] <= SEA_LEVEL ? 1 : clamp01(M[i] / p94);
  }

  // Latitude bands the march cannot express: the equatorial convergence zone is
  // wetter than pure advection implies, and the subtropical highs are drier.
  for (let gy = 0; gy < MACRO; gy++) {
    const latAbs = Math.abs(zToLatitude(macroToWorldZ(gy)));
    const itcz = Math.exp(-Math.pow(latAbs / 11, 2)) * 0.3;
    const horse = -Math.exp(-Math.pow((latAbs - 27) / 12, 2)) * 0.22;
    const ferrel = Math.exp(-Math.pow((latAbs - 52) / 14, 2)) * 0.12;
    const ny = gy * inv * 2.4;
    for (let gx = 0; gx < MACRO; gx++) {
      const i = gy * MACRO + gx;
      const nx = gx * inv * 2.4;
      const jitter = fbm(nMoistJitter, nx * 7, ny * 7, { octaves: 3 }) * 0.07;
      // Water bodies and river valleys raise local humidity.
      const local = waterTable.data[i] * 0.14;
      M[i] = clamp01(M[i] + itcz + horse + ferrel + jitter + local);
    }
  }

  // --- Aridity index -----------------------------------------------------
  const aridity = new Field(MACRO);
  for (let i = 0; i < n; i++) {
    const pet = clamp(0.55 + 0.03 * T[i], 0.42, 1.15);
    aridity.data[i] = clamp01(M[i] / pet);
  }

  // --- Biome classification ---------------------------------------------
  const biome = new Uint8Array(n);
  for (let gy = 0; gy < MACRO; gy++) {
    const latAbs = Math.abs(zToLatitude(macroToWorldZ(gy)));
    for (let gx = 0; gx < MACRO; gx++) {
      const i = gy * MACRO + gx;
      const h = H[i];
      if (h <= SEA_LEVEL) {
        biome[i] = classifyWater(-h);
        continue;
      }
      let b = classifyLand(T[i], aridity.data[i], h, slope.data[i], waterTable.data[i], latAbs);
      // Coastal fringe: sand where the land is flat, rock where it is steep.
      // Restricted to cells actually touching the water, or the fringe becomes a
      // significant fraction of the world's land area.
      if (coastDistance.data[i] <= MACRO_CELL_KM * 1.05 && h < 0.06) {
        b = slope.data[i] > 0.28 ? Biome.RockyShore : Biome.Beach;
      }
      // Fresh volcanic ground on the young arcs.
      if (orogeny.data[i] > 0.55 && h > 1.4 && aridity.data[i] < 0.5 && T[i] > 4) b = Biome.Volcanic;
      // Endorheic dry basins crust over with salt.
      if (h < 0.25 && M[i] < 0.08 && slope.data[i] < 0.05 && T[i] > 16) b = Biome.Salt;
      // Big arid dune fields.
      if ((b === Biome.Desert || b === Biome.RockyDesert) && slope.data[i] < 0.075 && M[i] < 0.1) {
        b = Biome.DuneSea;
      }
      biome[i] = b;
    }
  }

  // --- Vegetation density ------------------------------------------------
  const vegetation = new Field(MACRO);
  const V = vegetation.data;
  for (let gy = 0; gy < MACRO; gy++) {
    const ny = gy * inv * 2.4;
    for (let gx = 0; gx < MACRO; gx++) {
      const i = gy * MACRO + gx;
      const def = BIOME_BY_ID[biome[i]];
      if (!def) continue;
      // Clumping: forests are patchy, not a uniform carpet.
      const patch = 0.62 + 0.38 * smoothstep(-0.35, 0.45, fbm(nVeg, gx * inv * 9, ny * 3.75, { octaves: 4 }));
      const steepPenalty = 1 - clamp01((slope.data[i] - 0.55) / 0.45) * 0.7;
      const frostPenalty = clamp01((T[i] + 6) / 8);
      V[i] = clamp01(def.cover * patch * steepPenalty * frostPenalty);
    }
  }

  return { temperature, moisture, aridity, vegetation, slope, coastDistance, biome };
}

/** Mean annual temperature at an arbitrary elevation, for feature descriptions. */
export function temperatureAt(climate: ClimateResult, gx: number, gy: number): number {
  return climate.temperature.sample(gx, gy);
}

/** Human-readable climate label used in the info panel. */
export function climateLabel(tempC: number, moisture: number): string {
  const t =
    tempC < -8 ? 'polar' : tempC < 1 ? 'subarctic' : tempC < 9 ? 'cool' : tempC < 17 ? 'temperate' : tempC < 24 ? 'warm' : 'tropical';
  const m =
    moisture < 0.08 ? 'hyper-arid' : moisture < 0.2 ? 'arid' : moisture < 0.36 ? 'semi-arid' : moisture < 0.6 ? 'subhumid' : moisture < 0.82 ? 'humid' : 'perhumid';
  return `${t}, ${m}`;
}

/** Rough annual rainfall in mm from the 0..1 moisture proxy, for facts. */
export function rainfallMm(moisture: number): number {
  return Math.round(clamp(Math.pow(moisture, 1.55) * 3800, 8, 3800) / 10) * 10;
}
