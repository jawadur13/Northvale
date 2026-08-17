/**
 * Vegetation.
 *
 * There is no attempt to model every tree in a 4,000 km world - there are on the
 * order of 10^12 of them. Instead the scatter is *scale-adaptive*: the spacing
 * between instances is derived each frame from the camera distance so that the
 * instance count stays inside a fixed budget no matter where the camera is.
 *
 * At two kilometres up, spacing is a couple of hundred metres and each instance
 * is a tree. At two hundred kilometres up, spacing is a kilometre and each
 * instance is a stand of trees scaled to match - the eye reads canopy texture
 * either way, and the budget never moves. Above the regional tier the scatter
 * turns off entirely and the terrain shader's vegetation term carries the
 * forests, which is why zooming out never costs frame rate.
 *
 * Placement is a hash of the grid cell, so it is deterministic: rebuilding the
 * buffers after the camera moves produces the same trees in the same places
 * rather than a new forest.
 */

import * as THREE from 'three';
import { MACRO, WORLD_KM, HALF_KM } from '../../core/config';
import { hash2 } from '../../util/rng';
import { clamp } from '../../util/math';
import { Biome, BIOME_BY_ID, type PlantKind } from '../../world/gen/biomes';
import type { WorldUniforms } from '../WorldResources';

const PLANT_VERTEX = /* glsl */ `
precision highp float;

in vec3 position;
in vec3 normal;
in vec3 color;
in mat4 instanceMatrix;
in vec3 instanceColor;

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;

out vec3 vColor;
out vec3 vNormal;
out float vViewDist;
out vec3 vWorld;

void main() {
  vec4 world = instanceMatrix * vec4(position, 1.0);
  vColor = color * instanceColor;
  // Instance matrices here are translation, uniform scale and a Y rotation, so
  // the rotation part can be applied to the normal directly.
  vNormal = normalize(mat3(instanceMatrix) * normal);
  vWorld = world.xyz;
  vViewDist = length(world.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const PLANT_FRAGMENT = /* glsl */ `
precision highp float;

in vec3 vColor;
in vec3 vNormal;
in float vViewDist;
in vec3 vWorld;

out vec4 fragColor;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uFadeStart;
uniform float uFadeEnd;

void main() {
  vec3 N = normalize(vNormal);
  float ndl = max(dot(N, uSunDir), 0.0);
  float hemi = 0.5 + 0.5 * N.y;
  vec3 ambient = mix(uGroundColor, uSkyColor, hemi) * uAmbient;
  vec3 col = vColor * (ambient + uSunColor * ndl * 0.9);

  float heightFactor = exp(-max(vWorld.y, 0.0) / uFogHeight);
  float fogAmount = clamp(1.0 - exp(-vViewDist * uFogDensity * heightFactor), 0.0, 0.95);
  col = mix(col, uFogColor, fogAmount);

  // Fade out rather than pop out at the edge of the scatter radius.
  float alpha = 1.0 - smoothstep(uFadeStart, uFadeEnd, vViewDist);
  if (alpha < 0.01) discard;

  fragColor = vec4(col, alpha);
}
`;

/** Low-poly plant prototypes. Deliberately crude: they are never more than a few pixels tall. */
function buildPlantGeometry(kind: PlantKind): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (geo: THREE.BufferGeometry, r: number, g: number, b: number) => {
    const count = geo.attributes.position.count;
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      col[i * 3] = r;
      col[i * 3 + 1] = g;
      col[i * 3 + 2] = b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  };

  switch (kind) {
    case 'pine':
    case 'snowpine': {
      const trunk = new THREE.CylinderGeometry(0.055, 0.075, 0.34, 4);
      trunk.translate(0, 0.17, 0);
      paint(trunk, 0.32, 0.24, 0.18);
      parts.push(trunk);
      // Two stacked cones read as a conifer far more cheaply than a real one.
      const lower = new THREE.ConeGeometry(0.32, 0.66, 6);
      lower.translate(0, 0.6, 0);
      const upper = new THREE.ConeGeometry(0.2, 0.5, 6);
      upper.translate(0, 1.0, 0);
      if (kind === 'snowpine') {
        paint(lower, 0.3, 0.4, 0.36);
        paint(upper, 0.62, 0.68, 0.68);
      } else {
        paint(lower, 0.19, 0.32, 0.22);
        paint(upper, 0.24, 0.38, 0.26);
      }
      parts.push(lower, upper);
      break;
    }
    case 'broadleaf': {
      const trunk = new THREE.CylinderGeometry(0.06, 0.09, 0.4, 5);
      trunk.translate(0, 0.2, 0);
      paint(trunk, 0.34, 0.27, 0.2);
      parts.push(trunk);
      const crown = new THREE.IcosahedronGeometry(0.38, 0);
      crown.scale(1, 0.82, 1);
      crown.translate(0, 0.72, 0);
      paint(crown, 0.24, 0.4, 0.2);
      parts.push(crown);
      break;
    }
    case 'palm': {
      const trunk = new THREE.CylinderGeometry(0.04, 0.06, 0.85, 5);
      trunk.translate(0, 0.42, 0);
      paint(trunk, 0.42, 0.35, 0.24);
      parts.push(trunk);
      // Four drooping fronds, made from flattened cones.
      for (let i = 0; i < 4; i++) {
        const frond = new THREE.ConeGeometry(0.1, 0.46, 3);
        frond.scale(1, 1, 0.4);
        frond.rotateZ(Math.PI * 0.42);
        frond.rotateY((i / 4) * Math.PI * 2);
        frond.translate(0, 0.86, 0);
        paint(frond, 0.26, 0.42, 0.22);
        parts.push(frond);
      }
      break;
    }
    case 'cactus': {
      const body = new THREE.CylinderGeometry(0.09, 0.11, 0.62, 6);
      body.translate(0, 0.31, 0);
      paint(body, 0.28, 0.38, 0.24);
      parts.push(body);
      const arm = new THREE.CylinderGeometry(0.05, 0.055, 0.26, 5);
      arm.translate(0.13, 0.44, 0);
      paint(arm, 0.28, 0.38, 0.24);
      parts.push(arm);
      break;
    }
    case 'shrub': {
      const bush = new THREE.IcosahedronGeometry(0.2, 0);
      bush.scale(1.2, 0.62, 1.2);
      bush.translate(0, 0.12, 0);
      paint(bush, 0.34, 0.38, 0.22);
      parts.push(bush);
      break;
    }
    case 'reed': {
      for (let i = 0; i < 3; i++) {
        const blade = new THREE.ConeGeometry(0.035, 0.42, 3);
        blade.rotateZ((i - 1) * 0.24);
        blade.translate((i - 1) * 0.07, 0.22, 0);
        paint(blade, 0.42, 0.44, 0.24);
        parts.push(blade);
      }
      break;
    }
    case 'baobab': {
      const trunk = new THREE.CylinderGeometry(0.1, 0.22, 0.44, 6);
      trunk.translate(0, 0.22, 0);
      paint(trunk, 0.44, 0.36, 0.26);
      parts.push(trunk);
      const crown = new THREE.IcosahedronGeometry(0.34, 0);
      crown.scale(1.3, 0.34, 1.3);
      crown.translate(0, 0.56, 0);
      paint(crown, 0.34, 0.38, 0.2);
      parts.push(crown);
      break;
    }
    default: {
      const g = new THREE.IcosahedronGeometry(0.16, 0);
      paint(g, 0.3, 0.34, 0.22);
      parts.push(g);
    }
  }

  return mergeGeometries(parts);
}

/** Minimal geometry merge: position, normal and colour only. */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of list) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vertexCount * 3);
  const nor = new Float32Array(vertexCount * 3);
  const col = new Float32Array(vertexCount * 3);
  const idx = new Uint16Array(indexCount);

  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.attributes.position.array as ArrayLike<number>;
    const n = (g.attributes.normal?.array ?? new Float32Array(p.length)) as ArrayLike<number>;
    const c = g.attributes.color.array as ArrayLike<number>;
    const count = g.attributes.position.count;
    for (let i = 0; i < count * 3; i++) {
      pos[vo * 3 + i] = p[i];
      nor[vo * 3 + i] = n[i];
      col[vo * 3 + i] = c[i];
    }
    if (g.index) {
      const gi = g.index.array as ArrayLike<number>;
      for (let i = 0; i < g.index.count; i++) idx[io + i] = vo + gi[i];
      io += g.index.count;
    } else {
      for (let i = 0; i < count; i++) idx[io + i] = vo + i;
      io += count;
    }
    vo += count;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

const PLANT_KINDS: PlantKind[] = ['pine', 'snowpine', 'broadleaf', 'palm', 'cactus', 'shrub', 'baobab', 'reed'];

export class Vegetation {
  readonly group = new THREE.Group();
  private meshes = new Map<PlantKind, THREE.InstancedMesh>();
  private material: THREE.RawShaderMaterial;
  private budget: number;
  private biomeIds: Uint8Array;
  private climate: Uint8Array;
  private heightAt: (x: number, z: number) => number;
  private exaggeration: () => number;

  private lastCenterX = Infinity;
  private lastCenterZ = Infinity;
  private lastSpacing = -1;
  private matrix = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private scaleVec = new THREE.Vector3();
  private posVec = new THREE.Vector3();
  private colorObj = new THREE.Color();
  private enabled = true;
  private instanceCount = 0;

  constructor(
    uniforms: WorldUniforms,
    biomeIds: Uint8Array,
    climate: Uint8Array,
    heightAt: (x: number, z: number) => number,
    exaggeration: () => number,
    budget: number,
  ) {
    this.biomeIds = biomeIds;
    this.climate = climate;
    this.heightAt = heightAt;
    this.exaggeration = exaggeration;
    this.budget = budget;

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...(uniforms as unknown as Record<string, THREE.IUniform>),
        uFadeStart: { value: 200 },
        uFadeEnd: { value: 260 },
      },
      vertexShader: PLANT_VERTEX,
      fragmentShader: PLANT_FRAGMENT,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    });

    // Each plant type gets its own instanced mesh, sized for the worst case in
    // which the whole budget lands on one type.
    const perType = Math.max(256, Math.ceil(budget * 0.62));
    for (const kind of PLANT_KINDS) {
      const geo = buildPlantGeometry(kind);
      const mesh = new THREE.InstancedMesh(geo, this.material, perType);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(perType * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }
  }

  get lastInstanceCount(): number {
    return this.instanceCount;
  }

  setBudget(budget: number): void {
    this.budget = budget;
    this.lastSpacing = -1;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.group.visible = v;
  }

  /**
   * Rebuilds the scatter around a focus point, if the camera has moved or zoomed
   * enough to matter. Cheap to call every frame.
   */
  update(focusX: number, focusZ: number, camDistance: number): void {
    if (!this.enabled) return;

    // Above the local tier the terrain shader's vegetation term carries the
    // forests on its own, at no per-instance cost.
    if (camDistance > 95) {
      if (this.instanceCount !== 0) {
        for (const mesh of this.meshes.values()) mesh.count = 0;
        this.instanceCount = 0;
        this.lastSpacing = -1;
      }
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    // Radius covers roughly what the camera can resolve as individual plants.
    // It has to shrink with the camera, because a fixed instance budget spread
    // over a large disc forces the spacing up, and an instance spaced 150 m from
    // its neighbours has to be drawn 150 m tall to read as cover - which is not a
    // tree, it is a monument.
    const radius = clamp(camDistance * 1.15, 1.2, 32);
    // Spacing chosen so the disc holds about `budget` candidate sites.
    const spacing = Math.max(0.11, Math.sqrt((Math.PI * radius * radius) / this.budget));

    const moved = Math.hypot(focusX - this.lastCenterX, focusZ - this.lastCenterZ);
    const zoomChanged = Math.abs(spacing - this.lastSpacing) / Math.max(spacing, 1e-6) > 0.12;
    if (moved < spacing * 6 && !zoomChanged && this.lastSpacing > 0) {
      this.material.uniforms.uFadeStart.value = radius * 0.78;
      this.material.uniforms.uFadeEnd.value = radius;
      return;
    }

    this.lastCenterX = focusX;
    this.lastCenterZ = focusZ;
    this.lastSpacing = spacing;
    this.material.uniforms.uFadeStart.value = radius * 0.78;
    this.material.uniforms.uFadeEnd.value = radius;

    this.rebuild(focusX, focusZ, radius, spacing);
  }

  private rebuild(cx: number, cz: number, radius: number, spacing: number): void {
    const counts = new Map<PlantKind, number>();
    for (const kind of PLANT_KINDS) counts.set(kind, 0);

    const exag = this.exaggeration();
    // Instance size follows spacing so canopy density reads consistently, but is
    // capped: close in these are single trees at 25-40 m, further out they are
    // small stands, and they never grow past about 130 m however sparse they get.
    const baseScale = clamp(0.016 + spacing * 1.15, 0.02, 0.13);

    const g0x = Math.floor((cx - radius) / spacing);
    const g1x = Math.ceil((cx + radius) / spacing);
    const g0z = Math.floor((cz - radius) / spacing);
    const g1z = Math.ceil((cz + radius) / spacing);
    const r2 = radius * radius;
    const macroScale = (MACRO - 1) / WORLD_KM;

    for (let gz = g0z; gz <= g1z; gz++) {
      for (let gx = g0x; gx <= g1x; gx++) {
        // Deterministic jitter inside the cell, so the same tree lands in the
        // same place every time the buffers are rebuilt.
        const jx = hash2(gx, gz, 0x51ed);
        const jz = hash2(gx, gz, 0x2f19);
        const x = (gx + jx) * spacing;
        const z = (gz + jz) * spacing;
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz > r2) continue;
        if (x < -HALF_KM || x > HALF_KM || z < -HALF_KM || z > HALF_KM) continue;

        const mi =
          Math.min(MACRO - 1, Math.max(0, Math.round((z + HALF_KM) * macroScale))) * MACRO +
          Math.min(MACRO - 1, Math.max(0, Math.round((x + HALF_KM) * macroScale)));

        const biome = this.biomeIds[mi];
        const def = BIOME_BY_ID[biome];
        if (!def || def.plant === 'none') continue;
        if (biome === Biome.Ocean || biome === Biome.DeepOcean || biome === Biome.Shelf || biome === Biome.Lake) {
          continue;
        }

        const cover = this.climate[mi * 4 + 2] / 255;
        if (cover < 0.03) continue;
        // Accept in proportion to cover, using a third independent hash so the
        // acceptance pattern does not correlate with the jitter.
        if (hash2(gx, gz, 0x7a3d) > cover * 1.15) continue;

        const h = this.heightAt(x, z);
        if (h <= 0.001) continue;

        const kind = def.plant;
        const mesh = this.meshes.get(kind);
        if (!mesh) continue;
        const idx = counts.get(kind)!;
        if (idx >= mesh.instanceMatrix.count) continue;

        const sizeJitter = 0.62 + hash2(gx, gz, 0x1c4b) * 0.76;
        const s = baseScale * sizeJitter;
        this.posVec.set(x, h * exag, z);
        this.quat.setFromAxisAngle(UP, hash2(gx, gz, 0x9d31) * Math.PI * 2);
        this.scaleVec.set(s, s * (0.85 + hash2(gx, gz, 0x33af) * 0.45), s);
        this.matrix.compose(this.posVec, this.quat, this.scaleVec);
        mesh.setMatrixAt(idx, this.matrix);

        // Per-instance tint: a forest of identically coloured trees looks fake.
        const tint = 0.78 + hash2(gx, gz, 0x60d7) * 0.42;
        const warm = 0.94 + hash2(gx, gz, 0x0b7f) * 0.14;
        this.colorObj.setRGB(tint * warm, tint, tint * (2 - warm) * 0.98);
        mesh.setColorAt(idx, this.colorObj);

        counts.set(kind, idx + 1);
      }
    }

    let total = 0;
    for (const [kind, mesh] of this.meshes) {
      const n = counts.get(kind) ?? 0;
      mesh.count = n;
      total += n;
      if (n > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    this.instanceCount = total;
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.meshes.clear();
    this.material.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
