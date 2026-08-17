/**
 * The world's colour.
 *
 * One source of truth, expressed twice: a JavaScript implementation used by the
 * generator for the overview and minimap images, and the equivalent GLSL used by
 * the terrain shader. Keeping them in one file is deliberate - the minimap and
 * the 3D view have to agree, and two independent palettes always drift.
 *
 * The palette is *continuous*. It never looks up a biome id. Surface colour is
 * composed from temperature, aridity, vegetation cover, gradient, elevation and
 * cultivation, layered in the order a landscape actually layers: substrate,
 * then what grows on it, then what the weather does to it, then what people did
 * to it. That is why there is no visible biome boundary anywhere on the map even
 * though the gazetteer names thirty-four distinct biomes.
 */

import { clamp01, lerp, smoothstep } from '../util/math';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const tmp: Rgb = { r: 0, g: 0, b: 0 };

function mix(out: Rgb, r: number, g: number, b: number, t: number): void {
  out.r = lerp(out.r, r, t);
  out.g = lerp(out.g, g, t);
  out.b = lerp(out.b, b, t);
}

export interface SurfaceInputs {
  /** Elevation in km above sea level (negative under water). */
  h: number;
  /** Gradient, 0..1 where 1 is about 45 degrees. */
  slope: number;
  /** Mean annual temperature in Celsius. */
  tempC: number;
  /** Precipitation proxy, 0..1. */
  moisture: number;
  /** Vegetation cover, 0..1. */
  veg: number;
  /** Cultivation, 0..1. */
  developed: number;
  /** Orogenic history, 0..1 - raises rock exposure. */
  rock: number;
  /** Kilometres from open water, for the shore band. */
  coastKm: number;
}

/**
 * Surface albedo for a land or sea cell, as linear 0..1 RGB - the same units the
 * GLSL version returns, so the two cannot silently disagree.
 * Mirrors `TERRAIN_PALETTE_GLSL` exactly.
 */
export function surfaceColor(i: SurfaceInputs, out: Rgb = tmp): Rgb {
  if (i.h <= 0) {
    // --- Water: shallow shelf green through to abyssal indigo ---
    const depth = clamp01(-i.h / 4.2);
    out.r = 62;
    out.g = 122;
    out.b = 138;
    mix(out, 26, 66, 100, smoothstep(0.02, 0.14, depth));
    mix(out, 14, 38, 72, smoothstep(0.14, 0.55, depth));
    mix(out, 8, 22, 48, smoothstep(0.55, 1, depth));
    out.r /= 255;
    out.g /= 255;
    out.b /= 255;
    return out;
  }

  // --- 1. Substrate: dry sand through to damp loam ---
  // The moisture multiplier matters: at 1.25 a typical semi-humid cell still
  // reads as desert sand, and the whole world comes out the colour of a beach.
  const dry = 1 - clamp01(i.moisture * 1.75);
  out.r = lerp(96, 188, dry);
  out.g = lerp(88, 166, dry);
  out.b = lerp(66, 122, dry);
  // Hot deserts run redder than cold ones.
  mix(out, 186, 138, 96, clamp01(dry - 0.55) * smoothstep(14, 26, i.tempC) * 0.85);
  // Cold barrens run greyer.
  mix(out, 150, 148, 138, clamp01(dry - 0.3) * smoothstep(6, -6, i.tempC));

  // --- 2. Vegetation, with a temperature-dependent hue ---
  if (i.veg > 0.01) {
    // Cold conifer is blue-green; temperate is yellow-green; tropical is deep green.
    const cold = smoothstep(8, -6, i.tempC);
    const hot = smoothstep(16, 26, i.tempC);
    let vr = 92;
    let vg = 120;
    let vb = 66;
    vr = lerp(vr, 72, cold);
    vg = lerp(vg, 98, cold);
    vb = lerp(vb, 84, cold);
    vr = lerp(vr, 54, hot);
    vg = lerp(vg, 92, hot);
    vb = lerp(vb, 50, hot);
    // Dense cover is darker than sparse cover of the same type.
    const dense = smoothstep(0.35, 0.95, i.veg);
    vr = lerp(vr, vr * 0.66, dense);
    vg = lerp(vg, vg * 0.7, dense);
    vb = lerp(vb, vb * 0.62, dense);
    // Partial cover should still read green. At a 1:1 blend a grassland at 35%
    // cover is two-thirds bare soil, and the world's vegetation disappears.
    mix(out, vr, vg, vb, clamp01(i.veg * 1.45));
  }

  // --- 3. Cultivation ---
  if (i.developed > 0.02) {
    mix(out, 148, 146, 88, i.developed * 0.55);
  }

  // --- 4. Rock exposure on steep and freshly uplifted ground ---
  const rockAmount = clamp01(
    smoothstep(0.3, 0.78, i.slope) * (0.55 + 0.45 * clamp01(i.h / 3)) + i.rock * 0.22 * clamp01(i.h / 2),
  );
  if (rockAmount > 0.01) {
    // Rock hue shifts with climate: iron reds in the desert, grey schist in the wet.
    const rr = lerp(120, 148, dry);
    const rg = lerp(114, 126, dry);
    const rb = lerp(106, 104, dry);
    mix(out, rr, rg, rb, rockAmount * 0.9);
  }

  // --- 5. Snow and ice ---
  // Temperature already carries the elevation lapse rate, so the snowline
  // follows the terrain instead of being a flat contour.
  // Permanent snow needs a mean annual temperature well below freezing, not
  // merely below it. Using the freezing point puts an icecap on every temperate
  // upland and turns a third of the world white.
  let snow = smoothstep(-3, -9.5, i.tempC);
  // Steep faces shed their snow, which is what makes high ranges read as rock
  // and ice rather than as a white blanket.
  snow *= 1 - smoothstep(0.38, 0.85, i.slope) * 0.85;
  if (snow > 0.01) {
    // Deliberately not white. Pure white saturates the moment any light hits it,
    // and a saturated highlight carries no shading - the range stops looking like
    // a range and starts looking like a smear.
    mix(out, 214, 222, 232, snow * 0.94);
  }

  // --- 6. Shore band ---
  const shore = smoothstep(9, 1.5, i.coastKm) * smoothstep(0.12, 0.01, i.h) * (1 - snow);
  if (shore > 0.01) {
    mix(out, 206, 192, 158, shore * 0.7);
  }

  out.r /= 255;
  out.g /= 255;
  out.b /= 255;
  return out;
}

/**
 * GLSL translation of `surfaceColor`.
 *
 * Signature: `vec3 surfaceColor(float h, float slope, float tempC, float moisture,
 * float veg, float developed, float rock, float coastKm)`
 */
export const TERRAIN_PALETTE_GLSL = /* glsl */ `
vec3 nvSurfaceColor(
  float h, float slope, float tempC, float moisture,
  float veg, float developed, float rock, float coastKm
) {
  if (h <= 0.0) {
    float depth = clamp(-h / 4.2, 0.0, 1.0);
    vec3 c = vec3(62.0, 122.0, 138.0);
    c = mix(c, vec3(26.0, 66.0, 100.0), smoothstep(0.02, 0.14, depth));
    c = mix(c, vec3(14.0, 38.0, 72.0), smoothstep(0.14, 0.55, depth));
    c = mix(c, vec3(8.0, 22.0, 48.0), smoothstep(0.55, 1.0, depth));
    return c / 255.0;
  }

  float dry = 1.0 - clamp(moisture * 1.75, 0.0, 1.0);
  vec3 c = mix(vec3(96.0, 88.0, 66.0), vec3(188.0, 166.0, 122.0), dry);
  c = mix(c, vec3(186.0, 138.0, 96.0),
          clamp(dry - 0.55, 0.0, 1.0) * smoothstep(14.0, 26.0, tempC) * 0.85);
  c = mix(c, vec3(150.0, 148.0, 138.0),
          clamp(dry - 0.3, 0.0, 1.0) * smoothstep(6.0, -6.0, tempC));

  float cold = smoothstep(8.0, -6.0, tempC);
  float hot = smoothstep(16.0, 26.0, tempC);
  vec3 v = vec3(92.0, 120.0, 66.0);
  v = mix(v, vec3(72.0, 98.0, 84.0), cold);
  v = mix(v, vec3(54.0, 92.0, 50.0), hot);
  float dense = smoothstep(0.35, 0.95, veg);
  v = mix(v, v * vec3(0.66, 0.70, 0.62), dense);
  c = mix(c, v, clamp(veg * 1.45, 0.0, 1.0));

  c = mix(c, vec3(148.0, 146.0, 88.0), developed * 0.55);

  float rockAmount = clamp(
    smoothstep(0.3, 0.78, slope) * (0.55 + 0.45 * clamp(h / 3.0, 0.0, 1.0))
      + rock * 0.22 * clamp(h / 2.0, 0.0, 1.0),
    0.0, 1.0);
  vec3 rockCol = mix(vec3(120.0, 114.0, 106.0), vec3(148.0, 126.0, 104.0), dry);
  c = mix(c, rockCol, rockAmount * 0.9);

  float snow = smoothstep(-3.0, -9.5, tempC);
  snow *= 1.0 - smoothstep(0.38, 0.85, slope) * 0.85;
  c = mix(c, vec3(214.0, 222.0, 232.0), snow * 0.94);

  float shore = smoothstep(9.0, 1.5, coastKm) * smoothstep(0.12, 0.01, h) * (1.0 - snow);
  c = mix(c, vec3(206.0, 192.0, 158.0), shore * 0.7);

  return c / 255.0;
}
`;

/**
 * Hypsometric tint - the classic atlas elevation ramp, used by the Elevation
 * layer. Green lowland through tan and brown to white summits, with bathymetry
 * below the waterline.
 */
export const HYPSOMETRIC_GLSL = /* glsl */ `
vec3 nvHypsometric(float h) {
  if (h <= 0.0) {
    float d = clamp(-h / 5.5, 0.0, 1.0);
    vec3 c = vec3(150.0, 196.0, 214.0);
    c = mix(c, vec3(96.0, 156.0, 190.0), smoothstep(0.0, 0.08, d));
    c = mix(c, vec3(52.0, 108.0, 158.0), smoothstep(0.08, 0.3, d));
    c = mix(c, vec3(24.0, 60.0, 110.0), smoothstep(0.3, 0.7, d));
    c = mix(c, vec3(12.0, 32.0, 72.0), smoothstep(0.7, 1.0, d));
    return c / 255.0;
  }
  vec3 c = vec3(160.0, 190.0, 132.0);
  c = mix(c, vec3(196.0, 206.0, 140.0), smoothstep(0.0, 0.35, h));
  c = mix(c, vec3(214.0, 190.0, 124.0), smoothstep(0.35, 0.9, h));
  c = mix(c, vec3(196.0, 150.0, 100.0), smoothstep(0.9, 1.8, h));
  c = mix(c, vec3(166.0, 118.0, 88.0), smoothstep(1.8, 3.0, h));
  c = mix(c, vec3(196.0, 172.0, 158.0), smoothstep(3.0, 4.4, h));
  c = mix(c, vec3(250.0, 250.0, 252.0), smoothstep(4.4, 6.2, h));
  return c / 255.0;
}
`;

/** Biome-group colours for the Biomes layer and the legend swatches. */
export const BIOME_LAYER_GLSL = /* glsl */ `
vec3 nvBiomeColor(float tempC, float moisture, float h, float slope) {
  // A readable thematic map rather than a naturalistic one: distinct hues per
  // climate zone, so the Biomes layer answers "what grows here" at a glance.
  if (h <= 0.0) return vec3(0.10, 0.16, 0.26);
  vec3 ice = vec3(0.86, 0.90, 0.94);
  vec3 tundra = vec3(0.55, 0.57, 0.50);
  vec3 boreal = vec3(0.20, 0.36, 0.30);
  vec3 temperate = vec3(0.28, 0.50, 0.26);
  vec3 grass = vec3(0.62, 0.66, 0.32);
  vec3 steppe = vec3(0.72, 0.66, 0.40);
  vec3 desert = vec3(0.84, 0.72, 0.46);
  vec3 tropical = vec3(0.13, 0.42, 0.22);
  vec3 savanna = vec3(0.70, 0.60, 0.28);
  vec3 rock = vec3(0.48, 0.46, 0.44);

  vec3 c;
  if (tempC < -8.0) c = ice;
  else if (tempC < -1.0) c = mix(tundra, boreal, smoothstep(0.3, 0.6, moisture));
  else if (tempC < 6.0) c = mix(steppe, boreal, smoothstep(0.25, 0.55, moisture));
  else if (tempC < 15.0) c = mix(mix(steppe, grass, smoothstep(0.15, 0.4, moisture)),
                                temperate, smoothstep(0.45, 0.75, moisture));
  else if (tempC < 23.0) c = mix(mix(desert, grass, smoothstep(0.12, 0.42, moisture)),
                                temperate, smoothstep(0.5, 0.8, moisture));
  else c = mix(mix(desert, savanna, smoothstep(0.15, 0.45, moisture)),
               tropical, smoothstep(0.5, 0.85, moisture));
  c = mix(c, rock, smoothstep(0.55, 0.9, slope) * 0.7);
  c = mix(c, ice, smoothstep(0.5, -3.0, tempC) * 0.6);
  return c;
}
`;
