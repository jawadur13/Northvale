/**
 * Texture baking.
 *
 * The renderer never sees the simulation's JavaScript arrays. It sees four
 * textures, and displaces and shades the terrain entirely from them:
 *
 *  - **height** (R32F, 2048^2) - sampled in the vertex shader, so a terrain
 *    chunk is just a shared unit grid plus two uniforms. Creating and destroying
 *    quadtree nodes therefore costs nothing.
 *  - **climate** (RGBA8, 1024^2) - temperature, moisture, vegetation, ambient
 *    occlusion. The shader blends surface colour from these *continuously*, which
 *    is why there are no biome polygon edges anywhere on the map.
 *  - **surface** (RGBA8, 1024^2) - cultivation, orogenic history, water table.
 *  - **region** (RGBA8, 1024^2) - political colour, for the territory layer.
 *
 * Note that normals are deliberately *not* baked. They are computed in the
 * fragment shader by differencing the height texture, because the vertical
 * exaggeration is a live control and a baked normal map would be wrong the
 * moment the user moved the slider - and at a 3x exaggeration the difference is
 * the entire hillshade.
 *
 * The fine heightmap is the macro simulation upsampled bicubically with two
 * octaves of detail added, amplitude-masked by land and slope so the detail never
 * ruffles open water or floods a coastline.
 */

import { FINE, MACRO, SEA_LEVEL, WORLD_KM } from '../../core/config';
import { Field } from '../../util/grid';
import { clamp, clamp01, lerp } from '../../util/math';
import { Simplex, fbm, ridged } from '../../util/noise';
import { deriveSeed } from '../../util/rng';
import { surfaceColor, type Rgb } from '../palette';
import type { ClimateResult } from './climate';

/**
 * Upsamples the simulation height to the render resolution and adds detail.
 *
 * Returns heights in kilometres. The detail octaves are deliberately keyed off
 * the *macro* slope: flat plains stay flat (so farmland and dry lake beds read as
 * flat), while steep ground gets rough, which is where roughness belongs.
 */
export function buildFineHeight(macro: Field, orogeny: Field, seed: number): Float32Array {
  const out = new Float32Array(FINE * FINE);
  const nDetail = new Simplex(deriveSeed(seed, 'fineDetail'));
  const nRough = new Simplex(deriveSeed(seed, 'fineRough'));

  // Precompute macro slope once; sampling it per fine texel is far cheaper than
  // recomputing central differences at fine resolution.
  const slope = new Field(MACRO);
  for (let y = 0; y < MACRO; y++) {
    for (let x = 0; x < MACRO; x++) {
      slope.data[y * MACRO + x] = macro.slopeAt(x, y);
    }
  }

  const scale = (MACRO - 1) / (FINE - 1);
  // Noise frequency in cycles across the world.
  const F = 96;
  const inv = 1 / (FINE - 1);

  for (let y = 0; y < FINE; y++) {
    const my = y * scale;
    const ny = y * inv * F;
    for (let x = 0; x < FINE; x++) {
      const mx = x * scale;
      const base = macro.sampleCubic(mx, my);
      // The land test uses the *nearest* simulation cell, not the interpolated
      // value. Bicubic interpolation undershoots near a coast, and without this
      // a coastal village placed on a land cell can end up under water.
      const nearestLand = macro.at(Math.round(mx), Math.round(my)) > SEA_LEVEL;

      let h = base;
      if (base > -0.12) {
        const sl = slope.sample(mx, my);
        const land = clamp01((base + 0.06) / 0.12);
        const orog = orogeny.sample(mx, my);
        // Roughness rises with gradient and with orogenic history.
        const amp = (0.012 + clamp01(sl * 9) * 0.055 + orog * 0.05) * land;
        if (amp > 0.0004) {
          const nx = x * inv * F;
          const d = fbm(nDetail, nx, ny, { octaves: 3, gain: 0.5 });
          // A touch of ridged noise on steep ground gives crest lines and gullies.
          const rg = (ridged(nRough, nx * 2.1, ny * 2.1, { octaves: 2 }) - 0.5) * clamp01(sl * 12);
          h += (d * 0.75 + rg * 0.5) * amp;
        }
        // Never let detail submerge land the simulation said was dry, or raise
        // the sea floor above the waterline.
        if (nearestLand) h = Math.max(h, SEA_LEVEL + 0.0012);
        else h = Math.min(h, SEA_LEVEL - 0.0004);
      } else if (nearestLand) {
        h = Math.max(h, SEA_LEVEL + 0.0012);
      }
      out[y * FINE + x] = h;
    }
  }

  return out;
}

/**
 * Multi-scale ambient occlusion on the simulation grid.
 *
 * The classic "height minus blurred height" estimator, evaluated at three radii.
 * It costs three separable blurs instead of a horizon search per texel, and at
 * this scale it is visually indistinguishable from the expensive version -
 * valleys darken, ridges stay bright, and broad basins sit in shadow.
 */
export function buildAmbientOcclusion(macro: Field): Field {
  const ao = new Field(MACRO);
  const scales = [
    { r: 2, w: 0.3, span: 0.35 },
    { r: 6, w: 0.38, span: 0.85 },
    { r: 16, w: 0.32, span: 1.9 },
  ];
  for (const s of scales) {
    const blurred = macro.clone().blur(s.r, 2);
    for (let i = 0; i < ao.data.length; i++) {
      // Positive when the cell stands above its neighbourhood.
      const rel = (macro.data[i] - blurred.data[i]) / s.span;
      ao.data[i] += clamp(rel, -1, 1) * s.w;
    }
  }
  for (let i = 0; i < ao.data.length; i++) {
    // Map to an occlusion multiplier: hollows about 0.55, ridges about 1.0.
    ao.data[i] = clamp01(0.78 + ao.data[i] * 0.5);
  }
  ao.blur(1, 1);
  return ao;
}

/**
 * Non-climatic surface properties.
 * R cultivation, G orogenic history (rock exposure), B water table,
 * A distance to open water in km, scaled so 255 means 255 km or more.
 */
export function buildSurfaceTexture(
  developed: Field,
  orogeny: Field,
  waterTable: Field,
  coastDistance: Field,
): Uint8Array {
  const out = new Uint8Array(MACRO * MACRO * 4);
  for (let i = 0; i < MACRO * MACRO; i++) {
    const o = i * 4;
    out[o] = Math.round(clamp01(developed.data[i]) * 255);
    out[o + 1] = Math.round(clamp01(orogeny.data[i]) * 255);
    out[o + 2] = Math.round(clamp01(waterTable.data[i]) * 255);
    out[o + 3] = Math.min(255, Math.round(coastDistance.data[i]));
  }
  return out;
}

/**
 * Packs the continuous climate fields into one RGBA8 texture.
 * R temperature (-40..40 C), G moisture, B vegetation cover, A ambient occlusion.
 */
export function buildClimateTexture(climate: ClimateResult, ao: Field): Uint8Array {
  const out = new Uint8Array(MACRO * MACRO * 4);
  for (let i = 0; i < MACRO * MACRO; i++) {
    const o = i * 4;
    out[o] = Math.round(clamp01((climate.temperature.data[i] + 40) / 80) * 255);
    out[o + 1] = Math.round(clamp01(climate.moisture.data[i]) * 255);
    out[o + 2] = Math.round(clamp01(climate.vegetation.data[i]) * 255);
    out[o + 3] = Math.round(clamp01(ao.data[i]) * 255);
  }
  return out;
}

/**
 * Political colour per cell, with alpha marking claimed land.
 *
 * Sampled with linear filtering, which bleeds colour across borders over about
 * four kilometres. That reads as a soft political wash rather than as an artefact,
 * and the crisp boundary itself is drawn separately as a line layer.
 */
export function buildRegionTexture(ownership: Int32Array, regionColors: number[]): Uint8Array {
  const out = new Uint8Array(MACRO * MACRO * 4);
  for (let i = 0; i < MACRO * MACRO; i++) {
    const r = ownership[i];
    const o = i * 4;
    if (r < 0) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 0;
      continue;
    }
    const c = regionColors[r] ?? 0x808080;
    out[o] = (c >> 16) & 255;
    out[o + 1] = (c >> 8) & 255;
    out[o + 2] = c & 255;
    out[o + 3] = 255;
  }
  return out;
}

/**
 * A small coloured relief image of the whole world, for the minimap and the
 * loading preview. It uses the same palette as the terrain shader, so the
 * minimap and the 3D view are the same map.
 */
export function buildOverviewImage(
  size: number,
  fineHeight: Float32Array,
  climate: ClimateResult,
  ao: Field,
  developed: Field,
  orogeny: Field,
  exaggeration = 4,
): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const hScale = (FINE - 1) / (size - 1);
  const cScale = (MACRO - 1) / (size - 1);
  const col: Rgb = { r: 0, g: 0, b: 0 };

  // Light from the north-west, the cartographic convention.
  const lx = -0.52;
  const ly = 0.58;
  const lz = -0.62;

  // Sample the gradient over the whole pixel footprint, not over two texels -
  // otherwise the hillshade is sub-pixel noise instead of relief.
  const reach = Math.max(1, Math.round(hScale));
  const stepKm = (WORLD_KM / (FINE - 1)) * reach;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = Math.round(x * hScale);
      const fy = Math.round(y * hScale);
      const h = fineHeight[fy * FINE + fx];
      const cx = x * cScale;
      const cy = y * cScale;
      const o = (y * size + x) * 4;

      surfaceColor(
        {
          h,
          slope: climate.slope.sample(cx, cy),
          tempC: climate.temperature.sample(cx, cy),
          moisture: climate.moisture.sample(cx, cy),
          veg: climate.vegetation.sample(cx, cy),
          developed: developed.sample(cx, cy),
          rock: orogeny.sample(cx, cy),
          coastKm: climate.coastDistance.sample(cx, cy),
        },
        col,
      );

      const hL = fineHeight[fy * FINE + Math.max(0, fx - reach)];
      const hR = fineHeight[fy * FINE + Math.min(FINE - 1, fx + reach)];
      const hD = fineHeight[Math.max(0, fy - reach) * FINE + fx];
      const hU = fineHeight[Math.min(FINE - 1, fy + reach) * FINE + fx];
      const gx = ((hR - hL) * exaggeration) / (2 * stepKm);
      const gz = ((hU - hD) * exaggeration) / (2 * stepKm);
      const nlen = Math.hypot(-gx, 1, -gz) || 1;
      const nx = -gx / nlen;
      const ny = 1 / nlen;
      const nz = -gz / nlen;

      const aoV = ao.sample(cx, cy);
      const lambert = clamp01(nx * lx + ny * ly + nz * lz);
      // Ambient from the sky plus direct sun, then occlusion. The 0.42 floor
      // keeps shadowed faces readable rather than black.
      const shade = h <= 0 ? 0.96 + lambert * 0.1 : (0.42 + lambert * 0.78) * lerp(0.7, 1.06, aoV);

      out[o] = clamp(col.r * 255 * shade, 0, 255);
      out[o + 1] = clamp(col.g * 255 * shade, 0, 255);
      out[o + 2] = clamp(col.b * 255 * shade, 0, 255);
      out[o + 3] = 255;
    }
  }
  return out;
}
