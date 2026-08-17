/**
 * GPU resources shared by every material in the world.
 *
 * One height texture, one climate texture, one surface texture, one region
 * texture, and one uniform object that all of the world's materials reference by
 * identity. That last part matters: because terrain, water, rivers, roads,
 * borders, vegetation and buildings all hold the *same* uniform objects, moving
 * the exaggeration slider or the time-of-day control updates one number and every
 * material in the scene follows. There is no synchronisation code anywhere.
 */

import * as THREE from 'three';
import {
  DEFAULT_EXAGGERATION,
  FINE,
  MACRO,
  WORLD_KM,
  HALF_KM,
} from '../core/config';
import type { WorldPayload } from '../world/types';

export type LayerName = 'terrain' | 'elevation' | 'biomes' | 'political';

/**
 * TypeScript 5.7 parameterised the typed-array types by their backing buffer, and
 * DataTexture's DOM-derived signature asks specifically for an ArrayBuffer-backed
 * view. Nothing here is ever backed by a SharedArrayBuffer, so the cast is safe
 * and is confined to this one helper rather than sprinkled through the file.
 */
type TexData = ConstructorParameters<typeof THREE.DataTexture>[0];
const asTexData = (v: ArrayBufferView): TexData => v as unknown as TexData;

export interface WorldUniforms {
  uHeightTex: { value: THREE.Texture };
  uClimateTex: { value: THREE.Texture };
  uSurfaceTex: { value: THREE.Texture };
  uRegionTex: { value: THREE.Texture };
  uExaggeration: { value: number };
  uWorldSize: { value: number };
  uHalfWorld: { value: number };
  uHeightTexel: { value: number };
  uMacroTexel: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSkyColor: { value: THREE.Color };
  uGroundColor: { value: THREE.Color };
  uAmbient: { value: number };
  uFogColor: { value: THREE.Color };
  uFogDensity: { value: number };
  uFogHeight: { value: number };
  uShadowSteps: { value: number };
  uShadowStrength: { value: number };
  /** Extra steepness applied to shading only, never to geometry. */
  uReliefBoost: { value: number };
  uLayerMix: { value: THREE.Vector4 };
  uContourStrength: { value: number };
  uContourInterval: { value: number };
  uGraticule: { value: number };
  uDetailStrength: { value: number };
  uTime: { value: number };
  uCamDistance: { value: number };
  /** Minimum on-screen half-width for ribbons, in km, recomputed per frame. */
  uMinRibbonKm: { value: number };
}

export class WorldResources {
  readonly uniforms: WorldUniforms;
  readonly heightTexture: THREE.DataTexture;
  readonly climateTexture: THREE.DataTexture;
  readonly surfaceTexture: THREE.DataTexture;
  readonly regionTexture: THREE.DataTexture;
  /** CPU copy of the heightfield, for picking and for label placement. */
  readonly height: Float32Array;
  /** True when the GPU can linearly filter 32-bit float textures. */
  readonly floatLinear: boolean;

  constructor(payload: WorldPayload, renderer: THREE.WebGLRenderer) {
    this.height = payload.height;

    // Linear filtering of 32-bit float textures needs an extension. It is present
    // on essentially every WebGL2 implementation, but if it is missing the
    // heightfield still works - it just samples nearest, which shows as faint
    // faceting at extreme zoom rather than as a failure.
    this.floatLinear = renderer.getContext().getExtension('OES_texture_float_linear') !== null;
    const heightFilter = this.floatLinear ? THREE.LinearFilter : THREE.NearestFilter;

    this.heightTexture = new THREE.DataTexture(
      asTexData(payload.height),
      FINE,
      FINE,
      THREE.RedFormat,
      THREE.FloatType,
    );
    this.heightTexture.minFilter = heightFilter;
    this.heightTexture.magFilter = heightFilter;
    this.heightTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.heightTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTexture.generateMipmaps = false;
    this.heightTexture.needsUpdate = true;

    this.climateTexture = makeByteTexture(payload.climate, MACRO);
    this.surfaceTexture = makeByteTexture(payload.surface, MACRO);
    this.regionTexture = makeByteTexture(payload.regionMap, MACRO);

    this.uniforms = {
      uHeightTex: { value: this.heightTexture },
      uClimateTex: { value: this.climateTexture },
      uSurfaceTex: { value: this.surfaceTexture },
      uRegionTex: { value: this.regionTexture },
      uExaggeration: { value: DEFAULT_EXAGGERATION },
      uWorldSize: { value: WORLD_KM },
      uHalfWorld: { value: HALF_KM },
      uHeightTexel: { value: 1 / FINE },
      uMacroTexel: { value: 1 / MACRO },
      uSunDir: { value: new THREE.Vector3(-0.45, 0.72, -0.52).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.96, 0.88).multiplyScalar(0.98) },
      uSkyColor: { value: new THREE.Color(0.44, 0.56, 0.72) },
      uGroundColor: { value: new THREE.Color(0.24, 0.2, 0.16) },
      uAmbient: { value: 0.52 },
      uFogColor: { value: new THREE.Color(0.62, 0.69, 0.78) },
      uFogDensity: { value: 0.00022 },
      uFogHeight: { value: 9 },
      uShadowSteps: { value: 20 },
      uShadowStrength: { value: 0.82 },
      uReliefBoost: { value: 2.6 },
      uLayerMix: { value: new THREE.Vector4(1, 0, 0, 0) },
      uContourStrength: { value: 0 },
      uContourInterval: { value: 0.25 },
      uGraticule: { value: 0 },
      uDetailStrength: { value: 1 },
      uTime: { value: 0 },
      uCamDistance: { value: 3000 },
      uMinRibbonKm: { value: 0.4 },
    };
  }

  /** Bilinear height in km at a world position. Mirrors the shader's sampling. */
  heightAt(x: number, z: number): number {
    const u = ((x + HALF_KM) / WORLD_KM) * (FINE - 1);
    const v = ((z + HALF_KM) / WORLD_KM) * (FINE - 1);
    const cu = u < 0 ? 0 : u > FINE - 1.001 ? FINE - 1.001 : u;
    const cv = v < 0 ? 0 : v > FINE - 1.001 ? FINE - 1.001 : v;
    const x0 = cu | 0;
    const y0 = cv | 0;
    const tx = cu - x0;
    const ty = cv - y0;
    const d = this.height;
    const r0 = y0 * FINE;
    const r1 = r0 + FINE;
    const a = d[r0 + x0];
    const b = d[r0 + x0 + 1];
    const c = d[r1 + x0];
    const e = d[r1 + x0 + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
  }

  /** Rendered surface height (exaggerated) at a world position. */
  surfaceY(x: number, z: number): number {
    return this.heightAt(x, z) * this.uniforms.uExaggeration.value;
  }

  /** Cross-fades the four thematic layers. Weights need not sum to 1. */
  setLayerMix(terrain: number, elevation: number, biomes: number, political: number): void {
    this.uniforms.uLayerMix.value.set(terrain, elevation, biomes, political);
  }

  dispose(): void {
    this.heightTexture.dispose();
    this.climateTexture.dispose();
    this.surfaceTexture.dispose();
    this.regionTexture.dispose();
  }
}

function makeByteTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const t = new THREE.DataTexture(asTexData(data), size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
