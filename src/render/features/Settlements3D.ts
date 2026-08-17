/**
 * Built form.
 *
 * A settlement stops being a dot and becomes a place when you can see its plan.
 * Each settlement's layout is generated from its own deterministic seed:
 *
 *  - **Cities** get a radial street plan, density falling off from the centre, a
 *    curtain wall with towers if they are fortified, a keep or temple on the
 *    highest ground inside the wall, and piers if they are on the coast.
 *  - **Towns** get a main street with buildings along it and a market square.
 *  - **Villages** get a handful of buildings strung along the road, a church, and
 *    field walls.
 *
 * Layouts are built lazily for the settlements nearest the camera, up to a
 * budget, and cached. Everything is drawn from three instanced meshes - house,
 * tower, wall - so a city of four hundred buildings is three draw calls, and
 * twenty visible cities are still three draw calls.
 *
 * Buildings are coloured from their culture's palette, so Sahvari adobe and Skarn
 * turf-roofed halls are visibly different settlements, not recoloured copies.
 */

import * as THREE from 'three';
import { Rng } from '../../util/rng';
import { clamp } from '../../util/math';
import type { CultureInfo, Feature, RegionInfo } from '../../world/types';
import type { WorldUniforms } from '../WorldResources';

const BUILDING_VERTEX = /* glsl */ `
precision highp float;

in vec3 position;
in vec3 normal;
in mat4 instanceMatrix;
in vec3 instanceColor;

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;

out vec3 vColor;
out vec3 vNormal;
out float vViewDist;
out vec3 vWorld;
out float vUp;

void main() {
  vec4 world = instanceMatrix * vec4(position, 1.0);
  vColor = instanceColor;
  vNormal = normalize(mat3(instanceMatrix) * normal);
  vWorld = world.xyz;
  // Roofs are lit and coloured differently from walls; the local Y of the
  // prototype tells them apart without needing a second attribute.
  vUp = position.y;
  vViewDist = length(world.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const BUILDING_FRAGMENT = /* glsl */ `
precision highp float;

in vec3 vColor;
in vec3 vNormal;
in float vViewDist;
in vec3 vWorld;
in float vUp;

out vec4 fragColor;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeight;
uniform vec3 uRoofColor;
uniform float uFadeStart;
uniform float uFadeEnd;

void main() {
  vec3 N = normalize(vNormal);
  // Anything appreciably up-facing above the eaves line is roof.
  float roof = step(0.55, vUp) * step(0.4, N.y);
  vec3 base = mix(vColor, uRoofColor, roof);

  float ndl = max(dot(N, uSunDir), 0.0);
  float hemi = 0.5 + 0.5 * N.y;
  vec3 ambient = mix(uGroundColor, uSkyColor, hemi) * uAmbient;
  vec3 col = base * (ambient + uSunColor * ndl);

  float heightFactor = exp(-max(vWorld.y, 0.0) / uFogHeight);
  float fogAmount = clamp(1.0 - exp(-vViewDist * uFogDensity * heightFactor), 0.0, 0.95);
  col = mix(col, uFogColor, fogAmount);

  float alpha = 1.0 - smoothstep(uFadeStart, uFadeEnd, vViewDist);
  if (alpha < 0.01) discard;
  fragColor = vec4(col, alpha);
}
`;

interface Placement {
  x: number;
  z: number;
  /** Footprint in km. */
  w: number;
  d: number;
  /** Height in km. */
  h: number;
  rot: number;
  /** Index into the prototype list. */
  proto: number;
  colorR: number;
  colorG: number;
  colorB: number;
}

interface Layout {
  placements: Placement[];
  /** Bounding radius in km, for culling. */
  radius: number;
}

/** House: a box with a pitched roof, unit footprint, height 1. */
function buildHouseGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.BoxGeometry(1, 0.62, 1);
  body.translate(0, 0.31, 0);
  parts.push(body);
  // Pitched roof as a rotated, squashed 4-sided cone so it has real gables.
  const roof = new THREE.ConeGeometry(0.78, 0.46, 4);
  roof.rotateY(Math.PI / 4);
  roof.translate(0, 0.83, 0);
  parts.push(roof);
  return mergeSimple(parts);
}

/** Tower: a cylinder with a conical cap. */
function buildTowerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const shaft = new THREE.CylinderGeometry(0.42, 0.5, 0.78, 8);
  shaft.translate(0, 0.39, 0);
  parts.push(shaft);
  const cap = new THREE.ConeGeometry(0.56, 0.4, 8);
  cap.translate(0, 0.96, 0);
  parts.push(cap);
  return mergeSimple(parts);
}

/** Wall segment: a plain box, scaled along X to span between towers. */
function buildWallGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1, 0.5, 1);
  body.translate(0, 0.25, 0);
  // Crenellations, cheaply: a thinner band on top.
  const cap = new THREE.BoxGeometry(1, 0.12, 1.35);
  cap.translate(0, 0.54, 0);
  return mergeSimple([body, cap]);
}

function mergeSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of list) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vertexCount * 3);
  const nor = new Float32Array(vertexCount * 3);
  const idx = new Uint16Array(indexCount);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.attributes.position.array as ArrayLike<number>;
    const n = g.attributes.normal.array as ArrayLike<number>;
    const count = g.attributes.position.count;
    for (let i = 0; i < count * 3; i++) {
      pos[vo * 3 + i] = p[i];
      nor[vo * 3 + i] = n[i];
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
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

const PROTO_HOUSE = 0;
const PROTO_TOWER = 1;
const PROTO_WALL = 2;

export class Settlements3D {
  readonly group = new THREE.Group();
  private material: THREE.RawShaderMaterial;
  private meshes: THREE.InstancedMesh[] = [];
  private layouts = new Map<number, Layout>();
  private settlements: Feature[];
  private regions: RegionInfo[];
  private cultures: CultureInfo[];
  private heightAt: (x: number, z: number) => number;
  private exaggeration: () => number;
  private budget: number;
  private enabled = true;
  private activeIds: number[] = [];
  private buildingCount = 0;

  private matrix = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private posVec = new THREE.Vector3();
  private scaleVec = new THREE.Vector3();
  private colorObj = new THREE.Color();

  constructor(
    uniforms: WorldUniforms,
    features: Feature[],
    regions: RegionInfo[],
    cultures: CultureInfo[],
    heightAt: (x: number, z: number) => number,
    exaggeration: () => number,
    budget: number,
  ) {
    this.settlements = features.filter(
      (f) => f.kind === 'capital' || f.kind === 'city' || f.kind === 'town' || f.kind === 'village',
    );
    this.regions = regions;
    this.cultures = cultures;
    this.heightAt = heightAt;
    this.exaggeration = exaggeration;
    this.budget = budget;

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...(uniforms as unknown as Record<string, THREE.IUniform>),
        uRoofColor: { value: new THREE.Color(0.42, 0.3, 0.24) },
        uFadeStart: { value: 90 },
        uFadeEnd: { value: 120 },
      },
      vertexShader: BUILDING_VERTEX,
      fragmentShader: BUILDING_FRAGMENT,
      transparent: true,
      side: THREE.FrontSide,
    });

    const capacity = [16000, 1200, 2000];
    const geometries = [buildHouseGeometry(), buildTowerGeometry(), buildWallGeometry()];
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.InstancedMesh(geometries[i], this.material, capacity[i]);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity[i] * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  get lastBuildingCount(): number {
    return this.buildingCount;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.group.visible = v;
  }

  setBudget(n: number): void {
    this.budget = n;
  }

  /**
   * Builds a settlement's plan once and caches it.
   *
   * The layout is a function of the settlement's own seed, so it is stable across
   * sessions - the city you flew into yesterday has the same streets today.
   */
  private layoutFor(f: Feature): Layout {
    const cached = this.layouts.get(f.id);
    if (cached) return cached;

    const rng = new Rng((f.id * 2654435761) ^ 0x5bf03635);
    const region = this.regions[f.region];
    const culture = region ? this.cultures[region.culture] : this.cultures[0];
    const wall = culture.wallColor;
    const wr = ((wall >> 16) & 255) / 255;
    const wg = ((wall >> 8) & 255) / 255;
    const wb = (wall & 255) / 255;

    const pop = f.population ?? 400;
    const placements: Placement[] = [];

    // Radius in km from population, with a floor so a hamlet is still visible.
    const radius = clamp(Math.pow(pop, 0.36) * 0.055, 0.16, 3.2);
    // Building footprint scales gently with settlement size: cities build taller
    // and denser, villages build wide and low.
    const unit = clamp(radius * 0.09, 0.012, 0.05);
    const isCity = f.kind === 'capital' || f.kind === 'city';
    const isTown = f.kind === 'town';
    const fortified = (f.tags ?? []).includes('fortified');

    const push = (
      x: number,
      z: number,
      w: number,
      d: number,
      h: number,
      rot: number,
      proto: number,
      shade: number,
    ) => {
      placements.push({
        x,
        z,
        w,
        d,
        h,
        rot,
        proto,
        colorR: wr * shade,
        colorG: wg * shade,
        colorB: wb * shade,
      });
    };

    if (isCity) {
      // Radial street plan: buildings sit in the wedges between streets, with
      // density and height falling off from the centre.
      const streets = rng.int(7, 13);
      const rings = rng.int(5, 9);
      for (let ring = 1; ring <= rings; ring++) {
        const rr = (ring / rings) * radius * 0.92;
        // Blocks per ring grows with circumference, so density stays even.
        const perRing = Math.max(6, Math.round((rr * Math.PI * 2) / (unit * 2.1)));
        for (let b = 0; b < perRing; b++) {
          const a = (b / perRing) * Math.PI * 2 + rng.range(-0.03, 0.03);
          // Leave the street corridors clear.
          const streetPhase = Math.abs(((a / (Math.PI * 2)) * streets) % 1 - 0.5) * 2;
          if (streetPhase > 0.86) continue;
          if (rng.bool(0.14)) continue; // gaps, yards, courts
          const jitter = rng.range(-unit * 0.5, unit * 0.5);
          const x = Math.cos(a) * (rr + jitter);
          const z = Math.sin(a) * (rr + jitter);
          const falloff = 1 - (ring / rings) * 0.55;
          const h = unit * rng.range(1.1, 2.4) * falloff * (isCity ? 1.5 : 1);
          push(x, z, unit * rng.range(0.7, 1.3), unit * rng.range(0.7, 1.3), h, a, PROTO_HOUSE, rng.range(0.86, 1.1));
        }
      }
      // A keep, cathedral or palace at the centre.
      push(0, 0, unit * 3.2, unit * 3.2, unit * 7, rng.range(0, Math.PI), PROTO_TOWER, 1.05);
      // A few district landmarks.
      for (let i = 0; i < rng.int(2, 5); i++) {
        const a = rng.range(0, Math.PI * 2);
        const rr = rng.range(radius * 0.25, radius * 0.8);
        push(Math.cos(a) * rr, Math.sin(a) * rr, unit * 1.6, unit * 1.6, unit * 4.4, a, PROTO_TOWER, 1.02);
      }
    } else if (isTown) {
      // A main street with buildings either side, plus a market square.
      const axis = rng.range(0, Math.PI);
      const count = clamp(Math.round(pop / 260), 8, 90);
      for (let i = 0; i < count; i++) {
        const along = rng.range(-radius, radius);
        const side = rng.bool() ? 1 : -1;
        const across = side * rng.range(unit * 1.4, radius * 0.75);
        const x = Math.cos(axis) * along - Math.sin(axis) * across;
        const z = Math.sin(axis) * along + Math.cos(axis) * across;
        push(
          x,
          z,
          unit * rng.range(0.8, 1.4),
          unit * rng.range(0.8, 1.4),
          unit * rng.range(1, 1.9),
          axis + rng.range(-0.12, 0.12),
          PROTO_HOUSE,
          rng.range(0.85, 1.1),
        );
      }
      push(0, 0, unit * 1.8, unit * 1.8, unit * 4.2, axis, PROTO_TOWER, 1.04);
    } else {
      // Village: a short row along a lane, a church, and outbuildings.
      const axis = rng.range(0, Math.PI);
      const count = clamp(Math.round(pop / 90), 4, 26);
      for (let i = 0; i < count; i++) {
        const along = rng.range(-radius, radius);
        const across = rng.range(-radius * 0.5, radius * 0.5);
        const x = Math.cos(axis) * along - Math.sin(axis) * across;
        const z = Math.sin(axis) * along + Math.cos(axis) * across;
        push(
          x,
          z,
          unit * rng.range(0.9, 1.5),
          unit * rng.range(0.9, 1.5),
          unit * rng.range(0.9, 1.5),
          axis + rng.range(-0.3, 0.3),
          PROTO_HOUSE,
          rng.range(0.85, 1.08),
        );
      }
      if (rng.bool(0.55)) push(0, 0, unit * 1.2, unit * 1.2, unit * 3, axis, PROTO_TOWER, 1.02);
    }

    // Curtain wall: straight segments between towers around a slightly irregular ring.
    if (fortified) {
      const sides = rng.int(9, 15);
      const wallR = radius * 1.04;
      const segLen = (Math.PI * 2 * wallR) / sides;
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const aMid = a + Math.PI / sides;
        const wobble = 1 + rng.range(-0.05, 0.05);
        // A rotation of theta about +Y sends +X to (cos theta, -sin theta) in the
        // XZ plane. The tangent to the wall ring at angle aMid is
        // (-sin aMid, cos aMid), so the rotation needed is -(aMid + PI/2). Getting
        // this sign wrong mirrors every segment and turns the curtain wall into a
        // pinwheel of beams radiating out of the city.
        push(
          Math.cos(aMid) * wallR * wobble,
          Math.sin(aMid) * wallR * wobble,
          segLen * 1.06,
          unit * 0.55,
          unit * rng.range(2.1, 2.7),
          -(aMid + Math.PI / 2),
          PROTO_WALL,
          0.94,
        );
        push(
          Math.cos(a) * wallR,
          Math.sin(a) * wallR,
          unit * 1.15,
          unit * 1.15,
          unit * 3.4,
          a,
          PROTO_TOWER,
          0.96,
        );
      }
    }

    // Harbour: piers running out from the shore.
    if ((f.tags ?? []).includes('coastal') && (isCity || isTown)) {
      // Find the downhill direction; that is where the water is.
      let bestA = 0;
      let bestH = Infinity;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const h = this.heightAt(f.x + Math.cos(a) * radius * 1.6, f.z + Math.sin(a) * radius * 1.6);
        if (h < bestH) {
          bestH = h;
          bestA = a;
        }
      }
      if (bestH < 0.02) {
        const piers = rng.int(2, 5);
        for (let i = 0; i < piers; i++) {
          const spread = (i - (piers - 1) / 2) * unit * 4;
          const px = Math.cos(bestA) * radius * 1.15 - Math.sin(bestA) * spread;
          const pz = Math.sin(bestA) * radius * 1.15 + Math.cos(bestA) * spread;
          // Piers run out along the bearing to the water, hence -bestA.
          push(px, pz, radius * 0.55, unit * 0.7, unit * 0.35, -bestA, PROTO_WALL, 0.8);
        }
      }
    }

    const layout: Layout = { placements, radius: radius * 1.3 };
    this.layouts.set(f.id, layout);
    return layout;
  }

  /** Rebuilds the instance buffers for the settlements nearest the camera. */
  update(camX: number, camZ: number, camDistance: number): void {
    if (!this.enabled) return;

    // Built form only reads below the regional tier; above that the labels and
    // the settlement tint on the terrain carry the information.
    if (camDistance > 150) {
      if (this.buildingCount !== 0) {
        for (const m of this.meshes) m.count = 0;
        this.buildingCount = 0;
      }
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const fade = clamp(camDistance * 2.4 + 24, 30, 260);
    this.material.uniforms.uFadeStart.value = fade * 0.8;
    this.material.uniforms.uFadeEnd.value = fade;

    // Nearest settlements within the fade radius, largest first on ties.
    const candidates: Array<{ f: Feature; d: number }> = [];
    for (const f of this.settlements) {
      const dx = f.x - camX;
      const dz = f.z - camZ;
      const d = Math.hypot(dx, dz);
      if (d > fade) continue;
      candidates.push({ f, d });
    }
    candidates.sort((a, b) => a.d - b.d);
    const chosen = candidates.slice(0, this.budget);

    const ids = chosen.map((c) => c.f.id);
    const same =
      ids.length === this.activeIds.length && ids.every((v, i) => v === this.activeIds[i]);
    if (same) return;
    this.activeIds = ids;

    const counts = [0, 0, 0];
    const exag = this.exaggeration();

    for (const { f } of chosen) {
      const layout = this.layoutFor(f);
      for (const p of layout.placements) {
        const mesh = this.meshes[p.proto];
        const idx = counts[p.proto];
        if (idx >= mesh.instanceMatrix.count) continue;
        const wx = f.x + p.x;
        const wz = f.z + p.z;
        // Every element follows the ground beneath it. Anchoring the settlement
        // to a single height instead leaves the downhill half of a curtain wall
        // hanging in the air, which is the first thing the eye notices.
        const y = this.heightAt(wx, wz) * exag - 0.004;
        this.posVec.set(wx, y, wz);
        this.quat.setFromAxisAngle(UP, p.rot);
        this.scaleVec.set(p.w, p.h, p.d);
        this.matrix.compose(this.posVec, this.quat, this.scaleVec);
        mesh.setMatrixAt(idx, this.matrix);
        this.colorObj.setRGB(p.colorR, p.colorG, p.colorB);
        mesh.setColorAt(idx, this.colorObj);
        counts[p.proto] = idx + 1;
      }
    }

    this.buildingCount = counts[0] + counts[1] + counts[2];
    for (let i = 0; i < 3; i++) {
      this.meshes[i].count = counts[i];
      if (counts[i] > 0) {
        this.meshes[i].instanceMatrix.needsUpdate = true;
        if (this.meshes[i].instanceColor) this.meshes[i].instanceColor!.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.meshes.length = 0;
    this.material.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
