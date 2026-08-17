/**
 * Sky and light.
 *
 * The sky is an analytic gradient on an inward-facing sphere, plus a sun disc and
 * a broad glow. Because it is analytic, the water shader can evaluate the same
 * function to get a reflection without a probe or a render target, which is the
 * whole reason for doing it this way.
 *
 * `Atmosphere.setTimeOfDay` is the single control for the world's light. It
 * drives the sun direction, the sun and sky colours, the ambient level, and the
 * fog colour and density, and it writes them straight into the shared uniform
 * block - so every material in the scene, from the terrain to the roof tiles,
 * changes together. Sunrise reddens the light, lengthens the ray-marched
 * shadows and thickens the haze in the valleys, all from one number.
 */

import * as THREE from 'three';
import { WORLD_KM } from '../core/config';
import { clamp01, lerp } from '../util/math';
import type { WorldUniforms } from './WorldResources';

const SKY_VERTEX = /* glsl */ `
precision highp float;

in vec3 position;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;

out vec3 vDir;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vDir = normalize(world.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const SKY_FRAGMENT = /* glsl */ `
precision highp float;

in vec3 vDir;
out vec4 fragColor;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uGroundHaze;
uniform float uSunIntensity;

void main() {
  vec3 dir = normalize(vDir);
  float up = dir.y;

  // Below the horizon the dome shows haze, so the world never has a hard edge
  // when the camera tilts low over the sea.
  vec3 col;
  if (up >= 0.0) {
    col = mix(uHorizonColor, uZenithColor, pow(clamp(up, 0.0, 1.0), 0.52));
  } else {
    col = mix(uHorizonColor, uGroundHaze, pow(clamp(-up * 2.4, 0.0, 1.0), 0.7));
  }

  float sunDot = max(dot(dir, uSunDir), 0.0);
  // Disc, inner glow, and a very wide forward-scattering term.
  col += uSunColor * pow(sunDot, 1400.0) * 9.0 * uSunIntensity;
  col += uSunColor * pow(sunDot, 24.0) * 0.22 * uSunIntensity;
  col += uSunColor * pow(sunDot, 3.0) * 0.07 * uSunIntensity;

  fragColor = vec4(col, 1.0);
}
`;

/** Key light colours through the day, sampled and interpolated. */
interface LightKey {
  /** Sun elevation in degrees at which this key applies. */
  elevation: number;
  sun: [number, number, number];
  zenith: [number, number, number];
  horizon: [number, number, number];
  ambient: number;
  fog: [number, number, number];
  fogDensity: number;
}

const KEYS: LightKey[] = [
  {
    elevation: -8,
    sun: [0.22, 0.16, 0.2],
    zenith: [0.05, 0.07, 0.13],
    horizon: [0.12, 0.12, 0.19],
    ambient: 0.2,
    fog: [0.1, 0.11, 0.17],
    fogDensity: 0.00034,
  },
  {
    elevation: 0,
    sun: [1.0, 0.44, 0.24],
    zenith: [0.16, 0.2, 0.34],
    horizon: [0.86, 0.5, 0.34],
    ambient: 0.32,
    fog: [0.6, 0.44, 0.4],
    fogDensity: 0.00042,
  },
  {
    elevation: 8,
    sun: [1.0, 0.72, 0.5],
    zenith: [0.24, 0.36, 0.56],
    horizon: [0.82, 0.68, 0.58],
    ambient: 0.42,
    fog: [0.68, 0.6, 0.56],
    fogDensity: 0.00032,
  },
  {
    elevation: 25,
    sun: [1.0, 0.93, 0.82],
    zenith: [0.28, 0.44, 0.68],
    horizon: [0.66, 0.74, 0.82],
    ambient: 0.5,
    fog: [0.62, 0.69, 0.78],
    fogDensity: 0.00023,
  },
  {
    elevation: 55,
    sun: [1.0, 0.98, 0.94],
    zenith: [0.24, 0.42, 0.72],
    horizon: [0.62, 0.72, 0.84],
    ambient: 0.56,
    fog: [0.6, 0.68, 0.79],
    fogDensity: 0.00019,
  },
  {
    elevation: 90,
    sun: [1.0, 1.0, 0.98],
    zenith: [0.2, 0.4, 0.74],
    horizon: [0.6, 0.71, 0.85],
    ambient: 0.58,
    fog: [0.6, 0.68, 0.8],
    fogDensity: 0.00018,
  },
];

function sampleKeys(elevationDeg: number): LightKey {
  if (elevationDeg <= KEYS[0].elevation) return KEYS[0];
  if (elevationDeg >= KEYS[KEYS.length - 1].elevation) return KEYS[KEYS.length - 1];
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i];
    const b = KEYS[i + 1];
    if (elevationDeg >= a.elevation && elevationDeg <= b.elevation) {
      const t = (elevationDeg - a.elevation) / (b.elevation - a.elevation);
      const mix3 = (p: [number, number, number], q: [number, number, number]): [number, number, number] => [
        lerp(p[0], q[0], t),
        lerp(p[1], q[1], t),
        lerp(p[2], q[2], t),
      ];
      return {
        elevation: elevationDeg,
        sun: mix3(a.sun, b.sun),
        zenith: mix3(a.zenith, b.zenith),
        horizon: mix3(a.horizon, b.horizon),
        ambient: lerp(a.ambient, b.ambient, t),
        fog: mix3(a.fog, b.fog),
        fogDensity: lerp(a.fogDensity, b.fogDensity, t),
      };
    }
  }
  return KEYS[KEYS.length - 1];
}

export class Atmosphere {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.RawShaderMaterial;
  readonly horizonColor = new THREE.Color();

  private uniforms: WorldUniforms;
  /**
   * 0..1 through the day; 0.5 is local noon. The default is mid-morning rather
   * than noon on purpose: relief shading depends entirely on a raking light, and a
   * sun overhead flattens a mountain range into a pale smear. Cartographers have
   * lit relief from the north-west at about forty-five degrees for two centuries
   * for exactly this reason.
   */
  private timeOfDay = 0.385;
  /** Sun azimuth in radians, so the light can be swung around a feature. */
  private azimuth = -0.85;
  /** Cached sun elevation, so the haze query does not recompute the day curve. */
  private currentElevationDeg = 45;

  constructor(uniforms: WorldUniforms) {
    this.uniforms = uniforms;
    const shared = uniforms as unknown as Record<string, THREE.IUniform>;

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uZenithColor: { value: new THREE.Color(0.24, 0.42, 0.72) },
        uHorizonColor: { value: this.horizonColor },
        uGroundHaze: { value: new THREE.Color(0.32, 0.32, 0.34) },
        uSunIntensity: { value: 1 },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });

    // Large enough to contain any camera position in the world.
    const geo = new THREE.SphereGeometry(WORLD_KM * 3.2, 32, 20);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;

    this.apply();
  }

  /** 0..1 through the day. 0 and 1 are midnight; 0.5 is noon. */
  setTimeOfDay(t: number): void {
    this.timeOfDay = clamp01(t);
    this.apply();
  }

  getTimeOfDay(): number {
    return this.timeOfDay;
  }

  setAzimuth(radians: number): void {
    this.azimuth = radians;
    this.apply();
  }

  getAzimuth(): number {
    return this.azimuth;
  }

  /**
   * How thick the haze should be right now, relative to the daytime baseline.
   * WorldView owns the absolute density because it depends on the camera
   * distance; this supplies the time-of-day part - dawn and dusk are hazier.
   */
  hazeStrength(): number {
    const key = sampleKeys(this.currentElevationDeg);
    return key.fogDensity / 0.00023;
  }

  /** Keeps the dome centred on the camera. */
  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
  }

  private apply(): void {
    // Sun elevation over a full 24-hour cycle: maximum at noon (t = 0.5), the
    // horizon at 06:00 and 18:00, and fully below it at midnight. The factor of
    // two matters - halving it makes the curve reach the horizon at midnight
    // instead of at dawn, so the control only ever spans morning.
    //
    // The peak is 58 degrees rather than the zenith. Even at local noon the light
    // stays oblique enough to model the terrain, which matters more here than
    // astronomical accuracy.
    const dayAngle = (this.timeOfDay - 0.5) * Math.PI * 2;
    const elevationRad = Math.cos(dayAngle) * (Math.PI / 2) * 0.645;
    const elevationDeg = (elevationRad * 180) / Math.PI;

    this.currentElevationDeg = elevationDeg;
    const key = sampleKeys(elevationDeg);
    const u = this.uniforms;

    const cosEl = Math.cos(elevationRad);
    u.uSunDir.value.set(
      Math.cos(this.azimuth) * cosEl,
      Math.sin(elevationRad),
      Math.sin(this.azimuth) * cosEl,
    );
    // Below the horizon the direction is kept just above it, so the shadow march
    // and the hillshade degrade into flat night rather than inverting.
    if (u.uSunDir.value.y < 0.03) {
      u.uSunDir.value.y = 0.03;
      u.uSunDir.value.normalize();
    } else {
      u.uSunDir.value.normalize();
    }

    // Direct light fades out below the horizon; ambient carries the night.
    const daylight = clamp01((elevationDeg + 6) / 14);
    u.uSunColor.value.setRGB(key.sun[0], key.sun[1], key.sun[2]).multiplyScalar(0.96 * daylight);
    u.uSkyColor.value.setRGB(key.zenith[0], key.zenith[1], key.zenith[2]);
    u.uGroundColor.value.setRGB(key.fog[0] * 0.4, key.fog[1] * 0.34, key.fog[2] * 0.3);
    u.uAmbient.value = key.ambient;
    u.uFogColor.value.setRGB(key.fog[0], key.fog[1], key.fog[2]);
    // Low sun rakes across the terrain, so its shadows should be strong; a high
    // sun should not black out every north face.
    u.uShadowStrength.value = lerp(0.76, 0.5, clamp01(elevationDeg / 60)) * daylight;

    this.horizonColor.setRGB(key.horizon[0], key.horizon[1], key.horizon[2]);
    (this.material.uniforms.uZenithColor.value as THREE.Color).setRGB(
      key.zenith[0],
      key.zenith[1],
      key.zenith[2],
    );
    (this.material.uniforms.uGroundHaze.value as THREE.Color).setRGB(
      key.fog[0] * 0.55,
      key.fog[1] * 0.55,
      key.fog[2] * 0.6,
    );
    this.material.uniforms.uSunIntensity.value = daylight;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
