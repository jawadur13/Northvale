/**
 * Vegetation.
 *
 * There is no attempt to model every tree in a 4,000 km world — there are on the
 * order of 10^12 of them. Instead the scatter is a *ring of real planting* around
 * the camera: inside it, plants stand at their true height and at the density the
 * biome actually supports; outside it, the terrain shader's own vegetation term
 * carries the forests at no per-instance cost. The ring is as large as the
 * instance budget allows, and the distance fade hides its edge.
 *
 * That is a change from what this did first, which was to hold the ring at the
 * camera's full view radius and scale each instance up to compensate — so that a
 * tree spaced 150 m from its neighbours was drawn 150 m tall to make the canopy
 * meet. It kept the budget and it read as cover, but the moment buildings arrived
 * at true scale the trees were revealed as monuments: a 130 m oak beside a 9 m
 * house. Cover is a matter of *how many*, not how large, and everything here now
 * follows from that.
 *
 * Two levels of detail. The nearest ring is full geometry — trunk, crown, limbs.
 * Beyond it every plant is its canopy alone, five to seven triangles, with the
 * same outline so nothing changes shape as it crosses the boundary. What a tree
 * looks like from a kilometre up is its canopy; the trunk is a pixel.
 *
 * Placement is a hash of the grid cell, so it is deterministic: rebuilding after
 * the camera moves produces the same trees in the same places rather than a new
 * forest.
 */

import * as THREE from 'three';
import { MACRO, WORLD_KM, HALF_KM } from '../../core/config';
import { hash2 } from '../../util/rng';
import { clamp } from '../../util/math';
import { Biome, BIOME_BY_ID, type Species } from '../../world/gen/biomes';
import { buildPlant, PLANT_KINDS, type PlantDetail } from './PlantLibrary';
import type { WorldUniforms } from '../WorldResources';

const PLANT_VERTEX = /* glsl */ `
precision highp float;

in vec3 position;
in vec3 normal;
in vec3 color;
in float aTintable;
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
  // Only foliage takes the species tint. Bark keeps the colour it was painted,
  // which is the whole reason a birch reads as a birch.
  vColor = color * mix(vec3(1.0), instanceColor, aTintable);
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
  vec3 col = vColor * (ambient + uSunColor * ndl);
  // Sky fill on the shaded side. A canopy with none reads as a black blob from
  // any angle where the sun is behind it, which at dawn and dusk is half of them.
  col += vColor * uSkyColor * (1.0 - ndl) * 0.3;

  float heightFactor = exp(-max(vWorld.y, 0.0) / uFogHeight);
  float fogAmount = clamp(1.0 - exp(-vViewDist * uFogDensity * heightFactor), 0.0, 0.95);
  col = mix(col, uFogColor, fogAmount);

  float alpha = 1.0 - smoothstep(uFadeStart, uFadeEnd, vViewDist);
  if (alpha < 0.01) discard;
  fragColor = vec4(col, alpha);
}
`;

/**
 * Spacing of a closed canopy, in km.
 *
 * A mature conifer carries a crown eight or nine metres across, so nine metres is
 * the grid on which one stand of them just closes over the ground. Broadleaves
 * are wider and overlap heavily at the same spacing, which is what a temperate
 * wood looks like.
 *
 * Everything about the budget follows from this number, and it is the number the
 * first attempt got wrong: at twenty-two metres the arithmetic worked and the
 * forest came out as a field of dots on lit ground, because a canopy that does
 * not touch is not a canopy. What makes forest read as forest from the air is
 * that it shadows itself.
 */
const CANOPY_SPACING_KM = 0.009;

/** Above this the terrain shader's vegetation term carries the forests alone. */
const SCATTER_RANGE_KM = 95;

/** Smooth value noise on a unit lattice, for clearings and stand structure. */
function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const tx = x - xi;
  const tz = z - zi;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

/** One instanced mesh and what it currently holds. */
interface Bucket {
  mesh: THREE.InstancedMesh;
  capacity: number;
  /** Consecutive rebuilds in which this bucket drew nothing. */
  idle: number;
}

/**
 * Rebuilds a bucket may draw nothing for before it is given back.
 *
 * Buckets are grown on demand and never shrink, so without this a session that
 * crosses a rainforest, a boreal forest and a desert ends up holding a
 * full-budget matrix buffer for every species it has ever seen — a couple of
 * hundred megabytes of instance data for three species actually on screen.
 * Four rebuilds of hysteresis is enough that a species flickering across the ring
 * edge does not thrash the allocator.
 */
const BUCKET_IDLE_LIMIT = 4;

/**
 * Total instance capacity allowed across all buckets, as a multiple of the budget.
 *
 * One rebuild never places more than the budget, so anything above this is stale
 * capacity held for species that have gone out of view. The ceiling matters
 * because instance data is 76 bytes an instance on the CPU and again on the GPU:
 * eight species each holding a full-budget buffer is a third of a gigabyte for a
 * view showing three of them.
 */
const CAPACITY_SLACK = 1.6;

export class Vegetation {
  readonly group = new THREE.Group();
  private material: THREE.RawShaderMaterial;
  /** Indexed by plant kind and detail tier. */
  private buckets = new Map<string, Bucket>();
  private geometry = new Map<string, THREE.BufferGeometry>();

  private budget: number;
  private biomeIds: Uint8Array;
  private climate: Uint8Array;
  private surface: Uint8Array;
  private heightAt: (x: number, z: number) => number;
  private exaggeration: () => number;

  /**
   * Accepted sites, filled by the first pass and drained by the second.
   *
   * Two passes, because an instanced mesh cannot be resized and allocating every
   * one of twenty-two buckets for the whole budget would be half a gigabyte of
   * matrices for a view that in practice holds three species. Counting first
   * means each bucket is grown only to what it actually needs.
   */
  private siteX = new Float32Array(0);
  private siteZ = new Float32Array(0);
  private siteY = new Float32Array(0);
  private siteScale = new Float32Array(0);
  private siteAngle = new Float32Array(0);
  private siteTint = new Float32Array(0);
  private siteBucket = new Uint8Array(0);
  private siteCount = 0;

  private lastCenterX = Infinity;
  private lastCenterZ = Infinity;
  private lastRadius = -1;
  private matrix = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private scaleVec = new THREE.Vector3();
  private posVec = new THREE.Vector3();
  private colorObj = new THREE.Color();
  private enabled = true;
  private instanceCount = 0;

  /** Bucket keys, in a fixed order, so a site can name one with a byte. */
  private keys: string[] = [];

  constructor(
    uniforms: WorldUniforms,
    biomeIds: Uint8Array,
    climate: Uint8Array,
    surface: Uint8Array,
    heightAt: (x: number, z: number) => number,
    exaggeration: () => number,
    budget: number,
  ) {
    this.biomeIds = biomeIds;
    this.climate = climate;
    this.surface = surface;
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

    for (const kind of PLANT_KINDS) {
      for (const detail of ['full', 'canopy'] as PlantDetail[]) {
        const key = `${kind}:${detail}`;
        this.keys.push(key);
        this.geometry.set(key, buildPlant(kind, detail));
      }
    }

    this.allocateSites(budget);
  }

  private allocateSites(budget: number): void {
    this.siteX = new Float32Array(budget);
    this.siteZ = new Float32Array(budget);
    this.siteY = new Float32Array(budget);
    this.siteScale = new Float32Array(budget);
    this.siteAngle = new Float32Array(budget);
    this.siteTint = new Float32Array(budget * 3);
    this.siteBucket = new Uint8Array(budget);
  }

  get lastInstanceCount(): number {
    return this.instanceCount;
  }

  setBudget(budget: number): void {
    if (budget === this.budget) return;
    this.budget = budget;
    this.allocateSites(budget);
    this.lastRadius = -1;
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

    if (camDistance > SCATTER_RANGE_KM) {
      if (this.instanceCount !== 0) {
        for (const b of this.buckets.values()) b.mesh.count = 0;
        this.instanceCount = 0;
        this.lastRadius = -1;
      }
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    // Spacing is true canopy spacing where the canopy can be resolved, and
    // loosens beyond it. At a kilometre and a half up a crown is seven pixels and
    // the gaps between trees are the texture of the forest; at five kilometres a
    // crown is one pixel and thinning the stand by half changes nothing anyone
    // can see — but it doubles the ground the same budget can reach, and a ring
    // of trees that stops short of the view is far more visible than a wood that
    // is a little sparse.
    const spacing = CANOPY_SPACING_KM * clamp(camDistance / 2, 1, 2.4);
    // How far real planting can reach on this budget at that spacing. Beyond it
    // the terrain shader carries the colour, which is what an aerial photograph
    // looks like anyway: individual trees near, forest colour far.
    const affordable = Math.sqrt((this.budget * spacing * spacing) / Math.PI);
    // And how far the camera can actually resolve a tree at all.
    const needed = clamp(camDistance * 1.5, 1.6, 26);
    const radius = Math.min(affordable, needed);

    // Full geometry only where a trunk is more than a pixel wide. Kept tight: a
    // trunk is forty triangles against the canopy's five, and at true density
    // even half a kilometre of it is twenty thousand trees.
    const fullRadius = clamp(camDistance * 0.22, 0.25, 0.9);

    const moved = Math.hypot(focusX - this.lastCenterX, focusZ - this.lastCenterZ);
    const zoomChanged = Math.abs(radius - this.lastRadius) / Math.max(radius, 1e-6) > 0.12;
    // The ring is a ground distance from the focus; the fade is a *view* distance
    // from the eye, and the two differ by the whole height of the camera. Fading
    // at the ring radius alone discards the entire scatter the moment the camera
    // climbs above it, which is a forest that vanishes when you pull back.
    // A long dissolve rather than a short one. The scatter has to hand over to
    // the terrain shader's own vegetation term, and a hard edge between the two
    // reads as a disc of texture lying on the landscape.
    this.material.uniforms.uFadeStart.value = camDistance + radius * 0.2;
    this.material.uniforms.uFadeEnd.value = camDistance + radius;
    if (moved < radius * 0.14 && !zoomChanged && this.lastRadius > 0) return;

    this.lastCenterX = focusX;
    this.lastCenterZ = focusZ;
    this.lastRadius = radius;

    this.collect(focusX, focusZ, radius, fullRadius, spacing);
    this.upload();
  }

  /**
   * First pass: decide what grows where.
   *
   * Everything that shapes a forest rather than a texture happens here — the
   * clearings, the thickened edges, the gallery woodland following the water —
   * and all of it is a multiplier on one number, the cover the climate model
   * already computed for this cell.
   */
  private collect(
    cx: number,
    cz: number,
    radius: number,
    fullRadius: number,
    spacing: number,
  ): void {
    const exag = this.exaggeration();
    const g0x = Math.floor((cx - radius) / spacing);
    const g1x = Math.ceil((cx + radius) / spacing);
    const g0z = Math.floor((cz - radius) / spacing);
    const g1z = Math.ceil((cz + radius) / spacing);
    const r2 = radius * radius;
    const fullR2 = fullRadius * fullRadius;
    const macroScale = (MACRO - 1) / WORLD_KM;
    const budget = this.budget;

    let n = 0;
    for (let gz = g0z; gz <= g1z && n < budget; gz++) {
      for (let gx = g0x; gx <= g1x && n < budget; gx++) {
        // Deterministic jitter inside the cell, so the same tree lands in the
        // same place every time the buffers are rebuilt.
        const jx = hash2(gx, gz, 0x51ed);
        const jz = hash2(gx, gz, 0x2f19);
        const x = (gx + jx) * spacing;
        const z = (gz + jz) * spacing;
        const dx = x - cx;
        const dz = z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        if (x < -HALF_KM || x > HALF_KM || z < -HALF_KM || z > HALF_KM) continue;

        const mx = Math.min(MACRO - 1, Math.max(0, Math.round((x + HALF_KM) * macroScale)));
        const mz = Math.min(MACRO - 1, Math.max(0, Math.round((z + HALF_KM) * macroScale)));
        const mi = mz * MACRO + mx;

        const biome = this.biomeIds[mi];
        const def = BIOME_BY_ID[biome];
        if (!def || def.mix.length === 0) continue;
        if (biome === Biome.Ocean || biome === Biome.DeepOcean || biome === Biome.Shelf || biome === Biome.Lake) {
          continue;
        }

        // The biome is the authority on what a place supports; the climate model's
        // vegetation channel modulates within it. Using the climate value alone —
        // which is what this did first — plants a boreal forest at a third of the
        // density the classifier just decided it has, and the result is a wood you
        // can see the ground through from a kilometre up.
        const climateCover = this.climate[mi * 4 + 2] / 255;
        let cover = def.cover * (0.75 + 0.45 * climateCover);

        // --- Gallery woodland ---------------------------------------------
        // Trees follow water, and they follow it hardest where there is least of
        // it: the line of green along a watercourse through dry country is one of
        // the most recognisable things in any aerial view of anywhere.
        const waterTable = this.surface[mi * 4 + 2] / 255;
        cover = Math.max(cover, Math.pow(waterTable, 1.7) * 0.8);

        // --- Clearings ------------------------------------------------------
        // Low-frequency noise, thresholded. Real forest is not a mat: it is
        // stands with gaps between them, and without this a biome boundary is the
        // only edge anything has.
        const clearing = valueNoise(x * 1.7, z * 1.7, 0x4c1d);
        cover *= 1 - Math.pow(clamp((clearing - 0.63) / 0.3, 0, 1), 1.3) * 0.85;

        // --- Edges ----------------------------------------------------------
        // A forest edge is denser than its interior, because light reaches the
        // side of it. Four taps at one macro cell out is enough to find one.
        if (cover > 0.3) {
          let open = 0;
          for (let k = 0; k < 4; k++) {
            const ox = k === 0 ? 1 : k === 1 ? -1 : 0;
            const oz = k === 2 ? 1 : k === 3 ? -1 : 0;
            const nx = Math.min(MACRO - 1, Math.max(0, mx + ox));
            const nz = Math.min(MACRO - 1, Math.max(0, mz + oz));
            const nd = BIOME_BY_ID[this.biomeIds[nz * MACRO + nx]];
            if (!nd || nd.group !== def.group) open++;
          }
          if (open > 0) cover = Math.min(1, cover * (1 + open * 0.11));
        }

        // --- Cleared ground ---------------------------------------------------
        // Built and cultivated ground is cleared ground. The falloff has to be
        // steep rather than linear: at 0.985 linear suppression a town centre
        // still keeps one tree in nine, which is enough to leave oaks standing in
        // the middle of the market square.
        const developed = this.surface[mi * 4] / 255;
        cover *= Math.pow(1 - developed, 2.2);
        if (cover < 0.02) continue;

        // Accept in proportion to cover, using an independent hash so the
        // acceptance pattern does not correlate with the jitter.
        if (hash2(gx, gz, 0x7a3d) > cover) continue;

        const h = this.heightAt(x, z);
        if (h <= 0.001) continue;

        const species = pickSpecies(def.mix, hash2(gx, gz, 0x2b19));
        const key = `${species.plant}:${d2 < fullR2 ? 'full' : 'canopy'}`;
        const bucket = this.keys.indexOf(key);
        if (bucket < 0) continue;

        // True height, in km, from the species' own range.
        const t = hash2(gx, gz, 0x1c4b);
        const heightKm = (species.heightM[0] + (species.heightM[1] - species.heightM[0]) * t) * 0.001;

        this.siteX[n] = x;
        this.siteZ[n] = z;
        this.siteY[n] = h * exag;
        this.siteScale[n] = heightKm;
        this.siteAngle[n] = hash2(gx, gz, 0x9d31) * Math.PI * 2;

        // Per-instance tint around the species base: a stand of identically
        // coloured trees looks like one object repeated, which is what it is.
        const shade = 0.82 + hash2(gx, gz, 0x60d7) * 0.34;
        const warm = 0.95 + hash2(gx, gz, 0x0b7f) * 0.12;
        this.siteTint[n * 3] = (((species.tint >> 16) & 255) / 255) * shade * warm;
        this.siteTint[n * 3 + 1] = (((species.tint >> 8) & 255) / 255) * shade;
        this.siteTint[n * 3 + 2] = ((species.tint & 255) / 255) * shade * (2 - warm);
        this.siteBucket[n] = bucket;
        n++;
      }
    }
    this.siteCount = n;
  }

  /** Second pass: size each bucket to what it holds, then fill it. */
  private upload(): void {
    const counts = new Uint32Array(this.keys.length);
    for (let i = 0; i < this.siteCount; i++) counts[this.siteBucket[i]]++;

    for (let k = 0; k < this.keys.length; k++) {
      if (counts[k] > 0) this.ensure(this.keys[k], counts[k], counts);
    }

    const cursor = new Uint32Array(this.keys.length);
    for (let i = 0; i < this.siteCount; i++) {
      const k = this.siteBucket[i];
      const bucket = this.buckets.get(this.keys[k]);
      if (!bucket) continue;
      const at = cursor[k]++;
      if (at >= bucket.capacity) continue;

      const s = this.siteScale[i];
      this.posVec.set(this.siteX[i], this.siteY[i], this.siteZ[i]);
      this.quat.setFromAxisAngle(UP, this.siteAngle[i]);
      // Width follows height, with a little independent variation so a stand does
      // not look like one tree photocopied.
      this.scaleVec.set(s, s, s);
      this.matrix.compose(this.posVec, this.quat, this.scaleVec);
      bucket.mesh.setMatrixAt(at, this.matrix);
      this.colorObj.setRGB(this.siteTint[i * 3], this.siteTint[i * 3 + 1], this.siteTint[i * 3 + 2]);
      bucket.mesh.setColorAt(at, this.colorObj);
    }

    let total = 0;
    for (let k = 0; k < this.keys.length; k++) {
      const bucket = this.buckets.get(this.keys[k]);
      if (!bucket) continue;
      const n = Math.min(cursor[k], bucket.capacity);
      bucket.mesh.count = n;
      total += n;
      if (n > 0) {
        bucket.idle = 0;
        bucket.mesh.instanceMatrix.needsUpdate = true;
        if (bucket.mesh.instanceColor) bucket.mesh.instanceColor.needsUpdate = true;
      } else if (++bucket.idle > BUCKET_IDLE_LIMIT) {
        this.group.remove(bucket.mesh);
        bucket.mesh.dispose();
        this.buckets.delete(this.keys[k]);
      }
    }
    this.instanceCount = total;
  }

  /**
   * Grows a bucket to hold at least `n` instances.
   *
   * An instanced mesh cannot be resized, so growing means building a new one.
   * Capacity doubles rather than tracking demand exactly, so crossing a biome
   * boundary costs a handful of reallocations and then nothing.
   */
  private ensure(key: string, n: number, needed: Uint32Array): void {
    const existing = this.buckets.get(key);
    if (existing && existing.capacity >= n) return;

    // Doubling, not fitting. A continuous zoom grows demand a little every frame,
    // and an instanced mesh cannot be resized — so sizing to fit means disposing
    // and rebuilding GPU buffers every frame for as long as the wheel turns,
    // which is enough to take the graphics driver down with it. Doubling means
    // seven reallocations between four thousand instances and the whole budget,
    // for the entire session.
    let capacity = Math.max(4096, existing ? existing.capacity : 4096);
    while (capacity < n) capacity *= 2;
    capacity = Math.min(capacity, this.budget);
    if (this.allocated() + capacity > this.budget * CAPACITY_SLACK) this.evictIdle(needed);

    if (existing) {
      this.group.remove(existing.mesh);
      existing.mesh.dispose();
    }
    const geo = this.geometry.get(key);
    if (!geo) return;
    const mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.buckets.set(key, { mesh, capacity, idle: 0 });
  }

  /** Instances currently allocated across every bucket. */
  private allocated(): number {
    let total = 0;
    for (const b of this.buckets.values()) total += b.capacity;
    return total;
  }

  /**
   * Gives back every bucket that drew nothing and is not wanted this rebuild.
   *
   * The second half of that matters: `mesh.count` describes the *previous*
   * rebuild, so a bucket created a moment ago by this one still reads as empty.
   * Evicting on count alone therefore throws away buckets the rebuild is in the
   * middle of filling, and the instances assigned to them vanish.
   */
  private evictIdle(needed: Uint32Array): void {
    for (const [key, bucket] of [...this.buckets]) {
      if (bucket.mesh.count > 0) continue;
      if (needed[this.keys.indexOf(key)] > 0) continue;
      this.group.remove(bucket.mesh);
      bucket.mesh.dispose();
      this.buckets.delete(key);
    }
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      bucket.mesh.dispose();
      this.group.remove(bucket.mesh);
    }
    this.buckets.clear();
    for (const geo of this.geometry.values()) geo.dispose();
    this.geometry.clear();
    this.material.dispose();
  }
}

/** Picks a species from a mix by weight, given a hash in [0, 1). */
function pickSpecies(mix: Species[], u: number): Species {
  let total = 0;
  for (const s of mix) total += s.weight;
  let pick = u * total;
  for (const s of mix) {
    pick -= s.weight;
    if (pick <= 0) return s;
  }
  return mix[mix.length - 1];
}

const UP = new THREE.Vector3(0, 1, 0);
