/**
 * Water.
 *
 * Three surfaces, one shader:
 *
 *  - **The ocean** is a single large plane at y = 0. Because the terrain's
 *    bathymetry is a real heightfield, the shader can read the sea floor beneath
 *    each pixel and shade by actual depth - which is what makes the continental
 *    shelves visible as a pale rim around every landmass, and the trenches
 *    visible as near-black.
 *  - **Lakes** are merged quads emitted by the generator at each lake's own water
 *    level, so a tarn at 1,800 m and an inland sea at 40 m both sit correctly in
 *    their basins.
 *  - **Rivers** use the same shading path via the ribbon material, so the whole
 *    hydrology reads as one substance.
 *
 * The surface is animated by summing three scrolling wave layers into a normal
 * perturbation. There is no reflection probe and no screen-space pass: the sky is
 * a known analytic function, so the reflection can be evaluated directly, which
 * costs a few instructions instead of a render target.
 */

import * as THREE from 'three';
import { HALF_KM, WORLD_KM } from '../../core/config';
import type { WorldUniforms } from '../WorldResources';
import { NOISE_GLSL } from '../terrain/terrainShaders';

const WATER_VERTEX = /* glsl */ `
precision highp float;

in vec3 position;
/** Water surface elevation in km. Zero for the ocean plane. */
in float aLevel;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform float uExaggeration;
uniform float uHalfWorld;
uniform float uWorldSize;
uniform float uIsOcean;

out vec2 vUv;
out vec3 vWorld;
out float vViewDist;
out float vLevelKm;

void main() {
  vec4 placed = modelMatrix * vec4(position, 1.0);
  float levelKm = mix(aLevel, 0.0, uIsOcean);
  vec3 world = vec3(placed.x, levelKm * uExaggeration, placed.z);
  vWorld = world;
  vLevelKm = levelKm;
  vUv = (world.xz + uHalfWorld) / uWorldSize;
  vViewDist = length(world - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const WATER_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec2 vUv;
in vec3 vWorld;
in float vViewDist;
in float vLevelKm;

out vec4 fragColor;

uniform sampler2D uHeightTex;
uniform sampler2D uClimateTex;
uniform float uExaggeration;
uniform float uWorldSize;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uTime;
uniform float uWaterDetail;
uniform float uIsOcean;
uniform vec3 uCamPos;

${NOISE_GLSL}

/** Analytic sky colour along a direction, matching the sky dome shader. */
vec3 skyAlong(vec3 dir) {
  float up = clamp(dir.y, 0.0, 1.0);
  vec3 c = mix(uHorizonColor, uSkyColor, pow(up, 0.55));
  // Sun disc and its glow, so the water gets a real specular highlight.
  float sunDot = max(dot(normalize(dir), uSunDir), 0.0);
  c += uSunColor * pow(sunDot, 220.0) * 3.4;
  c += uSunColor * pow(sunDot, 12.0) * 0.16;
  return c;
}

void main() {
  float floorKm = texture(uHeightTex, clamp(vUv, 0.0, 1.0)).r;
  float depthKm = vLevelKm - floorKm;

  // Trim the ocean plane against the land instead of drawing over it. A depth
  // test alone would z-fight along every coastline in the world.
  if (uIsOcean > 0.5 && depthKm <= 0.0) discard;

  // --- Wave normal -------------------------------------------------------
  // Wave *wavelength is chosen from the viewing distance*, not fixed in world
  // units. A fixed 100 m wave is correct water and, seen from 300 km up, is
  // several cycles per pixel - which does not read as ocean, it reads as white
  // static. Tying the scale to the pixel footprint keeps the swell at a legible
  // size from a boat and from orbit, and it never aliases.
  // Inland water goes calm much sooner than the open sea: a lake seen from two
  // hundred kilometres is a mirror, and giving it swell at that range produces
  // streaks rather than water.
  float detailFade = uIsOcean > 0.5
    ? 1.0 - smoothstep(900.0, 4200.0, vViewDist)
    : 1.0 - smoothstep(40.0, 260.0, vViewDist);
  float amp = uWaterDetail * detailFade;
  vec3 N = vec3(0.0, 1.0, 0.0);
  if (amp > 0.001) {
    // Roughly forty pixels per wave at any distance.
    float waveKm = max(0.05, vViewDist * 0.02);
    vec2 p = vWorld.xz / waveKm;
    float t = uTime / max(0.6, sqrt(waveKm));
    float n1 = nvFbm(p * 0.9 + vec2(t * 0.06, t * 0.031), 2);
    float n2 = nvFbm(p * 2.1 + vec2(-t * 0.11, t * 0.07), 2);
    // Chop is suppressed in shallow water, which reads as a sheltered shore.
    float shelter = smoothstep(0.0, 0.25, depthKm);
    // Inland water is sheltered and much calmer than the open sea; giving lakes
    // ocean chop makes every tarn look like a storm.
    float k = amp * (0.3 + 0.7 * shelter) * (uIsOcean > 0.5 ? 0.5 : 0.3);
    N = normalize(vec3(
      (n1 * 0.35 + n2 * 0.2) * k,
      1.0,
      (n2 * 0.28 - n1 * 0.18) * k
    ));
  }

  // --- Depth-based body colour ------------------------------------------
  float d = clamp(depthKm / 3.2, 0.0, 1.0);
  vec3 shallow = vec3(0.30, 0.55, 0.56);
  vec3 mid = vec3(0.10, 0.28, 0.40);
  vec3 deep = vec3(0.026, 0.075, 0.16);
  vec3 body = mix(shallow, mid, smoothstep(0.0, 0.16, d));
  body = mix(body, deep, smoothstep(0.16, 0.72, d));

  // Lakes are fresher and greener than the sea, and never abyssal.
  if (uIsOcean < 0.5) {
    body = mix(vec3(0.20, 0.38, 0.40), vec3(0.07, 0.18, 0.26), smoothstep(0.0, 0.5, d));
  }

  // --- Reflection and Fresnel -------------------------------------------
  vec3 V = normalize(uCamPos - vWorld);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  fres = mix(0.028, 1.0, fres);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 reflection = skyAlong(R);

  vec3 col = mix(body, reflection, clamp(fres, 0.0, 0.92));

  // Direct specular from the sun, on top of the environment reflection. Kept
  // broad: a tight highlight on a perturbed normal is a sparkle generator.
  // Scaled by the wave amplitude on purpose. A perfectly flat surface has a
  // single normal, so a broad specular lobe either misses it entirely or lights
  // the whole body uniformly white - which is what a mirror-calm lake was doing.
  // Real still water shows a *reflection*, which the Fresnel term above already
  // provides; the specular is the contribution of the chop.
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 90.0);
  float specFade = 1.0 - smoothstep(60.0, 900.0, vViewDist);
  col += uSunColor * spec * 0.45 * specFade * amp;

  // --- Shoreline -------------------------------------------------------
  // A pale band where the water is only centimetres deep, plus a suggestion of
  // surf. This is the single detail that most sells a coastline at close range.
  // Only the sea gets a bright wash in the shallows. A lake is often only a few
  // metres deep across its whole area, and applying the same band to it turns the
  // entire lake into a pale sheet.
  float shoreBand = (1.0 - smoothstep(0.0, 0.035, depthKm)) * uIsOcean;
  col = mix(col, vec3(0.66, 0.73, 0.72), shoreBand * 0.45);
  float surfFade = 1.0 - smoothstep(30.0, 200.0, vViewDist);
  if (surfFade > 0.01) {
    float surf = smoothstep(0.004, 0.02, depthKm) * (1.0 - smoothstep(0.02, 0.075, depthKm));
    float surfPulse = 0.6 + 0.4 * sin(uTime * 0.9 + vWorld.x * 0.6 + vWorld.z * 0.4);
    col += vec3(0.5, 0.55, 0.55) * surf * surfPulse * 0.5 * surfFade;
  }

  // --- Atmosphere -------------------------------------------------------
  float heightFactor = exp(-max(vWorld.y, 0.0) / uFogHeight);
  float fogAmount = clamp(1.0 - exp(-vViewDist * uFogDensity * heightFactor), 0.0, 0.94);
  col = mix(col, uFogColor, fogAmount);

  fragColor = vec4(col, 1.0);
}
`;

export class Water {
  readonly group = new THREE.Group();
  readonly oceanMaterial: THREE.RawShaderMaterial;
  readonly lakeMaterial: THREE.RawShaderMaterial;

  private ocean: THREE.Mesh;
  private lakes: THREE.Mesh | null = null;

  constructor(
    uniforms: WorldUniforms,
    lakePositions: Float32Array,
    lakeIndices: Uint32Array,
    horizonColor: THREE.Color,
    camPos: THREE.Vector3,
  ) {
    const shared = uniforms as unknown as Record<string, THREE.IUniform>;

    const makeMaterial = (isOcean: number) =>
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          ...shared,
          uHorizonColor: { value: horizonColor },
          uWaterDetail: { value: 1 },
          uIsOcean: { value: isOcean },
          uCamPos: { value: camPos },
        },
        vertexShader: WATER_VERTEX,
        fragmentShader: WATER_FRAGMENT,
        side: THREE.DoubleSide,
      });

    this.oceanMaterial = makeMaterial(1);
    this.lakeMaterial = makeMaterial(0);

    // Five times the world's width. It has to be big enough that its own edge is
    // never what the viewer reads as the horizon - at world zoom a plane merely
    // larger than the map shows a hard diagonal cut across the ocean.
    const oceanGeo = new THREE.PlaneGeometry(WORLD_KM * 5, WORLD_KM * 5, 128, 128);
    oceanGeo.rotateX(-Math.PI / 2);
    // aLevel is unused for the ocean but the shader declares it, so supply zeros.
    oceanGeo.setAttribute(
      'aLevel',
      new THREE.BufferAttribute(new Float32Array(oceanGeo.attributes.position.count), 1),
    );
    this.ocean = new THREE.Mesh(oceanGeo, this.oceanMaterial);
    this.ocean.frustumCulled = false;
    this.ocean.renderOrder = 1;
    this.group.add(this.ocean);

    if (lakePositions.length > 0) {
      const geo = new THREE.BufferGeometry();
      // Lake quads arrive as x, levelKm, z triplets; split the level into its own
      // attribute so the vertex shader can apply the live exaggeration to it.
      const count = lakePositions.length / 3;
      const xz = new Float32Array(count * 3);
      const level = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        xz[i * 3] = lakePositions[i * 3];
        xz[i * 3 + 1] = 0;
        xz[i * 3 + 2] = lakePositions[i * 3 + 2];
        level[i] = lakePositions[i * 3 + 1];
      }
      geo.setAttribute('position', new THREE.BufferAttribute(xz, 3));
      geo.setAttribute('aLevel', new THREE.BufferAttribute(level, 1));
      geo.setIndex(new THREE.BufferAttribute(lakeIndices, 1));
      geo.computeBoundingSphere();
      this.lakes = new THREE.Mesh(geo, this.lakeMaterial);
      this.lakes.renderOrder = 2;
      this.group.add(this.lakes);
    }
  }

  /** Keeps the ocean plane centred under the camera so it always reaches the horizon. */
  follow(camX: number, camZ: number): void {
    const clampedX = Math.max(-HALF_KM, Math.min(HALF_KM, camX));
    const clampedZ = Math.max(-HALF_KM, Math.min(HALF_KM, camZ));
    this.ocean.position.set(clampedX, 0, clampedZ);
  }

  setDetail(level: number): void {
    this.oceanMaterial.uniforms.uWaterDetail.value = level;
    this.lakeMaterial.uniforms.uWaterDetail.value = level;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    this.ocean.geometry.dispose();
    this.oceanMaterial.dispose();
    this.lakeMaterial.dispose();
    if (this.lakes) this.lakes.geometry.dispose();
  }
}
