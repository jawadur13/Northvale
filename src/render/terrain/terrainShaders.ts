/**
 * Terrain shaders.
 *
 * The terrain is one shared unit-grid geometry, drawn many times with different
 * chunk offsets and scales. Displacement happens in the vertex shader by sampling
 * the world height texture, so building or discarding a quadtree node costs a
 * matrix update and nothing else.
 *
 * The fragment shader does the heavy lifting:
 *
 *  - **Normals** are differenced from the height texture rather than baked, so
 *    they follow the live vertical exaggeration. The differencing step widens with
 *    the pixel's footprint (`fwidth`), which keeps distant terrain smooth instead
 *    of aliasing into noise.
 *  - **Cast shadows** are ray-marched through the height texture toward the sun,
 *    with a geometrically growing stride. This is what makes ranges throw real
 *    shadows across the plains beside them, and it updates with the time-of-day
 *    control because nothing is precomputed.
 *  - **Colour** comes from the shared continuous palette, with the thematic
 *    layers (hypsometric, biome, political) blended over it by weight, so
 *    switching layers is a cross-fade rather than a rebuild.
 *  - **Contours** are drawn analytically from the sampled height with
 *    derivative-based anti-aliasing, giving a real topographic overlay at any
 *    zoom.
 */

import { BIOME_LAYER_GLSL, HYPSOMETRIC_GLSL, TERRAIN_PALETTE_GLSL } from '../../world/palette';

/** Shared GLSL: value noise, used for close-range surface variation. */
export const NOISE_GLSL = /* glsl */ `
float nvHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float nvValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = nvHash(i);
  float b = nvHash(i + vec2(1.0, 0.0));
  float c = nvHash(i + vec2(0.0, 1.0));
  float d = nvHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

float nvFbm(vec2 p, int octaves) {
  // Each octave is rotated as well as scaled. Value noise sits on an axis-aligned
  // lattice; stacking octaves without rotating leaves that lattice visible as a
  // diagonal weave, which on a water surface reads as fabric rather than as sea.
  const mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += nvValueNoise(p) * amp;
    p = rot * p * 2.03;
    amp *= 0.5;
  }
  return sum;
}
`;

/**
 * Sub-texel relief.
 *
 * The height texture is 2 km per texel. That is ample for a continent and far too
 * coarse for a valley, so below that scale the terrain is *procedural*: a pure
 * function of world position, evaluated identically by the vertex shader (which
 * displaces by it) and the fragment shader (which differentiates it for the
 * normal). Being a pure function of position is what matters - adjacent chunks at
 * different LOD levels agree exactly, so no seam appears, and no extra memory is
 * spent to make a 4,000 km world hold up at a two-kilometre viewing distance.
 *
 * Amplitude is driven by orogenic history, so eroded uplands get texture and
 * floodplains and dry lake beds stay flat, which is where flatness belongs.
 */
export const TERRAIN_DETAIL_GLSL = /* glsl */ `
float nvTerrainDetail(vec2 w, float roughness, float fade) {
  if (fade <= 0.002) return 0.0;
  // Each octave is rotated. Value noise is built on an axis-aligned lattice, and
  // stacking octaves without rotating them leaves the lattice visible as a combed
  // texture running diagonally across every hillside.
  const mat2 r1 = mat2(0.86, 0.51, -0.51, 0.86);
  const mat2 r2 = mat2(0.28, -0.96, 0.96, 0.28);
  const mat2 r3 = mat2(-0.71, 0.70, -0.70, -0.71);
  float d = nvValueNoise(w * 0.38) * 0.062;
  d += nvValueNoise((r1 * w) * 1.07 + 31.7) * 0.026;
  d += nvValueNoise((r2 * w) * 2.9 - 12.3) * 0.0105;
  d += nvValueNoise((r3 * w) * 7.4 + 4.1) * 0.0038;
  return d * roughness * fade;
}

/**
 * How strongly to apply the procedural relief, from the vertex spacing of the
 * chunk being drawn. Detail finer than two vertices cannot be represented and
 * would alias, so it is faded out before that point.
 */
float nvDetailFade(float chunkScale, float segments) {
  float spacing = chunkScale / max(1.0, segments);
  return smoothstep(2.2, 0.55, spacing);
}
`;

export const TERRAIN_VERTEX = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec3 position;
/** 1.0 for skirt vertices, which hang below the surface to hide LOD seams. */
in float aSkirt;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;

uniform sampler2D uHeightTex;
uniform sampler2D uSurfaceTex;
uniform float uExaggeration;
uniform float uWorldSize;
uniform float uHalfWorld;
uniform float uSkirtDepth;
uniform float uSegments;

out vec2 vUv;
out vec3 vWorld;
out float vHeightKm;
out float vViewDist;
out float vDetailFade;
out float vRoughness;

${NOISE_GLSL}
${TERRAIN_DETAIL_GLSL}

void main() {
  // Chunk placement rides on the model matrix, so every visible chunk shares one
  // material and one draw setup - there are no per-chunk uniform uploads.
  vec4 placed = modelMatrix * vec4(position, 1.0);
  vec2 worldXZ = placed.xz;
  float chunkScale = length(modelMatrix[0].xyz);

  vec2 uv = (worldXZ + uHalfWorld) / uWorldSize;
  vUv = uv;

  float h = texture(uHeightTex, uv).r;

  // Procedural relief below the texture's resolution. Only on land, and only
  // where the chunk is dense enough to carry it.
  float fade = nvDetailFade(chunkScale, uSegments);
  vec4 surf = texture(uSurfaceTex, uv);
  float orogeny = surf.g;
  float developed = surf.r;
  float land = smoothstep(0.0, 0.05, h);
  // Built and cultivated ground is levelled ground. Attenuating the procedural
  // relief under settlements is both true - a town site gets graded - and the
  // thing that lets flat plot polygons sit on the terrain without z-fighting
  // against detail the CPU side cannot see.
  float levelled = 1.0 - developed * developed * 0.82;
  float roughness = (0.45 + orogeny * 1.9) * land * levelled;
  vDetailFade = fade;
  vRoughness = roughness;
  h += nvTerrainDetail(worldXZ, roughness, fade);

  vHeightKm = h;

  float y = h * uExaggeration;
  // The skirt has to reach at least as deep as the worst-case disagreement with a
  // neighbour one LOD coarser, which scales with the chunk's own size.
  y -= aSkirt * (uSkirtDepth + chunkScale * 0.09);

  vec3 world = vec3(worldXZ.x, y, worldXZ.y);
  vWorld = world;
  vViewDist = length(world - cameraPosition);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const TERRAIN_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec2 vUv;
in vec3 vWorld;
in float vHeightKm;
in float vViewDist;
in float vDetailFade;
in float vRoughness;

out vec4 fragColor;

uniform sampler2D uHeightTex;
uniform sampler2D uClimateTex;
uniform sampler2D uSurfaceTex;
uniform sampler2D uRegionTex;

uniform float uExaggeration;
uniform float uWorldSize;
uniform float uHeightTexel;   // 1.0 / FINE
uniform float uMacroTexel;    // 1.0 / MACRO

uniform vec3 uSunDir;         // normalised, pointing from the surface toward the sun
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbient;

uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeight;

uniform float uShadowSteps;
uniform float uShadowStrength;
uniform float uReliefBoost;

/** Layer weights: 0 terrain, 1 hypsometric, 2 biome, 3 political tint. */
uniform vec4 uLayerMix;
uniform float uContourStrength;
uniform float uContourInterval;
uniform float uGraticule;
uniform float uDetailStrength;
uniform float uTime;
uniform float uCamDistance;

${TERRAIN_PALETTE_GLSL}
${HYPSOMETRIC_GLSL}
${BIOME_LAYER_GLSL}
${NOISE_GLSL}
${TERRAIN_DETAIL_GLSL}

/** Height in km at a UV, clamped to the map. */
float heightAt(vec2 uv) {
  return texture(uHeightTex, clamp(uv, 0.0, 1.0)).r;
}

/**
 * Ray-marches the heightfield toward the sun. Returns 1.0 in full light,
 * approaching 0.0 in full shadow.
 *
 * The stride grows geometrically so a modest step count still reaches far enough
 * for a 6 km range to shadow the plain 40 km beside it.
 */
float sunShadow(vec2 uv, float hKm) {
  int steps = int(uShadowSteps);
  if (steps <= 0) return 1.0;

  vec2 dirUv = normalize(uSunDir.xz + vec2(1e-6));
  // The sun direction is a direction in *rendered* space, where Y has already
  // been multiplied by the vertical exaggeration. The heightfield is in true
  // kilometres. Marching the ray in rendered units while comparing against true
  // heights makes the ray climb by the exaggeration factor too fast, and nothing
  // in the world ever casts a shadow. So the comparison is done wholly in
  // rendered units instead.
  float climbRendered = max(uSunDir.y, 0.02) / max(length(uSunDir.xz), 0.02);

  float shade = 0.0;
  float distKm = 1.6;
  float strideKm = 1.6;
  for (int i = 0; i < 48; i++) {
    if (i >= steps) break;
    vec2 sampleUv = uv + dirUv * (distKm / uWorldSize);
    float sampleH = heightAt(sampleUv);
    // How far the terrain stands above the ray, both in rendered units.
    float over = (sampleH - hKm) * uExaggeration * uReliefBoost - climbRendered * distKm;
    // Softened so the shadow edge is a penumbra rather than a hard step, and
    // widening with distance the way a real penumbra does.
    float soften = 0.1 + distKm * 0.012;
    shade = max(shade, smoothstep(0.0, soften, over));
    distKm += strideKm;
    strideKm *= 1.32;
  }
  return 1.0 - shade * uShadowStrength;
}

void main() {
  // --- Normal, differenced at the pixel's own footprint ---
  // Using a single texel everywhere aliases badly at distance; using the
  // footprint everywhere loses crispness up close. Take the larger of the two.
  float footprint = max(fwidth(vUv.x), fwidth(vUv.y));
  float step = max(uHeightTexel, footprint * 0.75);
  float stepKm = step * uWorldSize;

  float hL = heightAt(vUv - vec2(step, 0.0));
  float hR = heightAt(vUv + vec2(step, 0.0));
  float hD = heightAt(vUv - vec2(0.0, step));
  float hU = heightAt(vUv + vec2(0.0, step));

  float gx = (hR - hL) * uExaggeration / (2.0 * stepKm);
  float gz = (hU - hD) * uExaggeration / (2.0 * stepKm);

  // Add the gradient of the procedural relief, differentiated at the pixel's own
  // footprint. Because it is the same function the vertex shader displaced by,
  // the shading agrees with the silhouette instead of contradicting it.
  if (vDetailFade > 0.002) {
    float dStep = max(0.06, footprint * uWorldSize * 0.9);
    float dL = nvTerrainDetail(vWorld.xz - vec2(dStep, 0.0), vRoughness, vDetailFade);
    float dR = nvTerrainDetail(vWorld.xz + vec2(dStep, 0.0), vRoughness, vDetailFade);
    float dD = nvTerrainDetail(vWorld.xz - vec2(0.0, dStep), vRoughness, vDetailFade);
    float dU = nvTerrainDetail(vWorld.xz + vec2(0.0, dStep), vRoughness, vDetailFade);
    gx += (dR - dL) * uExaggeration / (2.0 * dStep);
    gz += (dU - dD) * uExaggeration / (2.0 * dStep);
  }

  // Slope as an unexaggerated gradient, computed *before* the relief boost, so
  // the palette's rock and snow thresholds mean the same thing whatever the
  // exaggeration and shading controls are set to.
  float slope = clamp(length(vec2(gx, gz)) / uExaggeration / 0.45, 0.0, 1.0);

  // Shading exaggeration is deliberately larger than geometric exaggeration.
  // A world 4,000 km wide with 5 km of relief is, to scale, almost perfectly
  // smooth: a physically correct hillshade of it carries nearly no information.
  // Every printed relief map solves this the same way, by shading a steeper
  // surface than it draws. Applying it here rather than to the geometry keeps
  // silhouettes honest while making the modelling legible.
  vec3 N = normalize(vec3(-gx * uReliefBoost, 1.0, -gz * uReliefBoost));

  // --- Surface data ---
  vec4 clim = texture(uClimateTex, vUv);
  vec4 surf = texture(uSurfaceTex, vUv);
  float tempC = clim.r * 80.0 - 40.0;
  float moisture = clim.g;
  float veg = clim.b;
  float ao = clim.a;
  float developed = surf.r;
  float rock = surf.g;
  float coastKm = surf.a * 255.0;

  float h = vHeightKm;

  // --- Close-range surface variation ---
  // Without this, ground within a few kilometres of the camera is a flat wash of
  // colour. Two scales of noise: broad mottling and fine grain, both faded out
  // with distance so they never alias at altitude.
  float detailFade = uDetailStrength * (1.0 - smoothstep(60.0, 900.0, vViewDist));
  if (detailFade > 0.001) {
    vec2 np = vWorld.xz;
    float broad = nvFbm(np * 0.35, 3);
    float fine = nvFbm(np * 3.1, 2);
    veg = clamp(veg + broad * 0.16 * detailFade, 0.0, 1.0);
    moisture = clamp(moisture + broad * 0.07 * detailFade, 0.0, 1.0);
    // Perturb the normal so lit ground has texture rather than being a plane.
    N = normalize(N + vec3(fine * 0.22, 0.0, broad * 0.18) * detailFade);
  }

  // --- Albedo ---
  vec3 albedo = nvSurfaceColor(h, slope, tempC, moisture, veg, developed, rock, coastKm);

  if (uLayerMix.y > 0.001) albedo = mix(albedo, nvHypsometric(h), uLayerMix.y);
  if (uLayerMix.z > 0.001) albedo = mix(albedo, nvBiomeColor(tempC, moisture, h, slope), uLayerMix.z);
  if (uLayerMix.w > 0.001) {
    vec4 region = texture(uRegionTex, vUv);
    // Only tint claimed land; the ocean keeps its own colour.
    albedo = mix(albedo, mix(albedo, region.rgb, 0.62), uLayerMix.w * region.a);
  }

  // --- Lighting ---
  float ndl = max(dot(N, uSunDir), 0.0);
  // A mild gamma on the diffuse term. Straight Lambert on terrain this broad is
  // visually flat, because almost every surface faces roughly upward; the curve
  // pushes the mid-tones apart and is what makes a range read as a range.
  ndl = pow(ndl, 0.78);
  float shadow = h > 0.0 ? sunShadow(vUv, h) : 1.0;
  // Hemisphere ambient: sky from above, warm bounce from below.
  float hemi = 0.5 + 0.5 * N.y;
  vec3 ambient = mix(uGroundColor, uSkyColor, hemi) * uAmbient;
  // Occlusion applies to ambient much more strongly than to direct light.
  // Occlusion should darken a hollow, not black it out - there is always sky.
  ambient *= mix(0.66, 1.08, ao);

  vec3 lit = albedo * (ambient + uSunColor * ndl * shadow);

  // A cool rim on snow and ice reads as light scattering through the surface.
  float snowish = smoothstep(-2.0, -7.0, tempC) * (1.0 - slope * 0.6);
  lit += albedo * uSkyColor * snowish * 0.12;

  // A little sky fill on faces turned away from the sun. Without it, a steep
  // north face at this exaggeration goes to near-black and the relief reads as a
  // silhouette rather than as a landform.
  lit += albedo * uSkyColor * (1.0 - ndl) * 0.2 * mix(0.6, 1.0, ao);

  // --- Contour lines ---
  if (uContourStrength > 0.001 && h > 0.0) {
    float interval = uContourInterval;
    float t = h / interval;
    // Derivative-based line width keeps contours one pixel wide at any zoom.
    float d = abs(fract(t) - 0.5) / max(fwidth(t), 1e-5);
    float line = 1.0 - clamp(d - 0.5, 0.0, 1.0);
    // Index contours every fifth line, drawn heavier.
    float indexT = h / (interval * 5.0);
    float dIndex = abs(fract(indexT) - 0.5) / max(fwidth(indexT), 1e-5);
    float indexLine = 1.0 - clamp(dIndex - 0.9, 0.0, 1.0);
    float amount = clamp(line * 0.5 + indexLine * 0.7, 0.0, 1.0) * uContourStrength;
    lit = mix(lit, lit * 0.42, amount);
  }

  // --- Graticule ---
  if (uGraticule > 0.001) {
    vec2 g = vWorld.xz / 256.0;
    vec2 dg = abs(fract(g) - 0.5) / max(fwidth(g), vec2(1e-5));
    float gl = 1.0 - clamp(min(dg.x, dg.y) - 0.6, 0.0, 1.0);
    lit = mix(lit, lit * 0.72 + vec3(0.06, 0.07, 0.08), gl * uGraticule * 0.5);
  }

  // --- Atmosphere ---
  // Exponential distance fog with a height falloff, so the haze pools in the
  // valleys and thins over the summits.
  float heightFactor = exp(-max(vWorld.y, 0.0) / uFogHeight);
  float fogAmount = 1.0 - exp(-vViewDist * uFogDensity * heightFactor);
  fogAmount = clamp(fogAmount, 0.0, 0.94);
  vec3 col = mix(lit, uFogColor, fogAmount);

  fragColor = vec4(col, 1.0);
}
`;

/** Uniform names shared between the terrain and every other world material. */
export interface SharedTerrainUniforms {
  uHeightTex: { value: unknown };
  uClimateTex: { value: unknown };
  uSurfaceTex: { value: unknown };
  uRegionTex: { value: unknown };
  uExaggeration: { value: number };
  uWorldSize: { value: number };
  uHalfWorld: { value: number };
  uHeightTexel: { value: number };
  uMacroTexel: { value: number };
  uSunDir: { value: unknown };
  uSunColor: { value: unknown };
  uSkyColor: { value: unknown };
  uGroundColor: { value: unknown };
  uAmbient: { value: number };
  uFogColor: { value: unknown };
  uFogDensity: { value: number };
  uFogHeight: { value: number };
  uShadowSteps: { value: number };
  uShadowStrength: { value: number };
  uLayerMix: { value: unknown };
  uContourStrength: { value: number };
  uContourInterval: { value: number };
  uGraticule: { value: number };
  uDetailStrength: { value: number };
  uTime: { value: number };
  uCamDistance: { value: number };
}
