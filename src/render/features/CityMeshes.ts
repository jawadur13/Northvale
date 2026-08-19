/**
 * The built city.
 *
 * Five levels of detail, chosen **per block** rather than per city, so a town you
 * are standing over is not all-or-nothing with the town on the horizon:
 *
 *  1. **Buildings** — extruded footprints with roofs, towers and spires.
 *  2. **Massing** — the same footprints capped flat at mid-roof height. Half the
 *     vertices, and because the cap is at the *average* of eaves and ridge the
 *     skyline does not visibly drop as a block crosses the boundary.
 *  3. **Block mass** — one prism for the entire block at the mean roof height of
 *     what stands on it. A tenth of the vertices again, and from above a dense
 *     quarter of party-wall houses genuinely is one solid mass.
 *  4. **Plots** — flat coloured parcels. The A1 tier, still the right answer once
 *     a building is two pixels tall.
 *  5. **Blocks** — one polygon per block, for the rest of the region.
 *
 * Geometry is **cached per block and per tier**, so the frequent operation — the
 * visible set changing as the camera moves — is a run of typed-array copies rather
 * than a regeneration. Rebuilding a city's geometry from scratch on every camera
 * move costs a visible hitch; memcpy does not.
 *
 * Buildings are drawn at **true scale**, unexaggerated, while the terrain beneath
 * them is exaggerated. That is deliberate: a ten-metre house multiplied by the
 * relief factor would be a forty-metre house, and the town would read as a city of
 * towers. The relief exaggeration is a cartographic device for landforms; it has
 * no business being applied to things whose real size the viewer knows.
 */

import * as THREE from 'three';
import { clamp } from '../../util/math';
import { buildCityPlan } from '../../world/gen/city/plan';
import { buildParcels } from '../../world/gen/city/parcels';
import { buildBuildings, estimateBlockMass } from '../../world/gen/city/buildings';
import {
  emitBlockMass,
  emitBridge,
  emitBuilding,
  emitBuildingBox,
  emitFortification,
  emitHarbour,
  freezeGeometry,
  newGeomBuilder,
  type HarbourPalette,
} from '../../world/gen/city/geometry3d';
import { boundingRadius, insetConvex, vertexCount, type Poly } from '../../world/gen/city/geometry2d';
import {
  DISTRICTS,
  type Block,
  type BlockGeometry,
  type CityPlan,
  type FlatGeometry,
} from '../../world/gen/city/types';
import type { CultureInfo, Feature, RegionInfo } from '../../world/types';
import type { WorldUniforms } from '../WorldResources';
import { NOISE_GLSL, TERRAIN_DETAIL_GLSL } from '../terrain/terrainShaders';

/** Ground-height evaluation, shared by both shaders in this module. */
const GROUND_GLSL = /* glsl */ `
float nvGroundKm(vec2 worldXZ) {
  vec2 uv = (worldXZ + uHalfWorld) / uWorldSize;
  float h = texture(uHeightTex, uv).r;
  vec4 surf = texture(uSurfaceTex, uv);
  float land = smoothstep(0.0, 0.05, h);
  float levelled = 1.0 - surf.r * surf.r * 0.82;
  float roughness = (0.45 + surf.g * 1.9) * land * levelled;
  return h + nvTerrainDetail(worldXZ, roughness, 1.0);
}
`;

const BUILDING_VERTEX = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec3 position;   // world x, LOCAL height above the building base, world z
in vec3 normal;
in vec3 color;
in vec2 aAnchor;    // where this building samples the ground

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;

uniform sampler2D uHeightTex;
uniform sampler2D uSurfaceTex;
uniform float uExaggeration;
uniform float uWorldSize;
uniform float uHalfWorld;

out vec3 vColor;
out vec3 vNormal;
out float vViewDist;
out vec3 vWorld;

${NOISE_GLSL}
${TERRAIN_DETAIL_GLSL}
${GROUND_GLSL}

void main() {
  // One ground sample per building, taken at the shared anchor. Sampling at each
  // vertex instead would shear a building standing on a slope and warp its roof.
  float baseY = nvGroundKm(aAnchor) * uExaggeration;
  // The local height is NOT exaggerated: relief exaggeration is for landforms.
  vec3 world = vec3(position.x, baseY + position.y, position.z);

  vColor = color;
  vNormal = normal;
  vWorld = world;
  vViewDist = length(world - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

/**
 * The works: the same shader, with the ground clamped at sea level.
 *
 * A wall on a hill is unaffected — its ground is well above zero. A quay, a jetty
 * or a moored hull anchors within metres of the waterline, where the difference
 * between the CPU's height and the shader's, multiplied by the relief
 * exaggeration, is the difference between standing on the shore and lying on the
 * seabed.
 */
const WORKS_VERTEX = BUILDING_VERTEX.replace(
  'float baseY = nvGroundKm(aAnchor) * uExaggeration;',
  'float baseY = max(nvGroundKm(aAnchor), 0.0) * uExaggeration;',
);

const BUILDING_FRAGMENT = /* glsl */ `
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
  // Sky fill on the shaded sides, matching the terrain's treatment, so a north
  // wall or a roof slope turned away from the sun reads as a surface with a
  // colour rather than as a silhouette. Steep roofs need a good deal of it: half
  // of every gable in a town faces away from the sun.
  col += vColor * uSkyColor * (1.0 - ndl) * 0.34;

  float heightFactor = exp(-max(vWorld.y, 0.0) / uFogHeight);
  float fogAmount = clamp(1.0 - exp(-vViewDist * uFogDensity * heightFactor), 0.0, 0.95);
  col = mix(col, uFogColor, fogAmount);

  float alpha = 1.0 - smoothstep(uFadeStart, uFadeEnd, vViewDist);
  if (alpha < 0.01) discard;
  fragColor = vec4(col, alpha);
}
`;

const FLAT_VERTEX = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec3 position;   // world x, lift tier, world z
in vec3 color;

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;

uniform sampler2D uHeightTex;
uniform sampler2D uSurfaceTex;
uniform float uExaggeration;
uniform float uWorldSize;
uniform float uHalfWorld;
uniform float uLift;

out vec3 vColor;
out float vViewDist;
out vec3 vWorld;

${NOISE_GLSL}
${TERRAIN_DETAIL_GLSL}
${GROUND_GLSL}

void main() {
  vec2 worldXZ = position.xz;
  float y = nvGroundKm(worldXZ) * uExaggeration + uLift * uExaggeration * position.y;
  vec3 world = vec3(worldXZ.x, y, worldXZ.y);
  vColor = color;
  vWorld = world;
  vViewDist = length(world - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FLAT_FRAGMENT = /* glsl */ `
precision highp float;

in vec3 vColor;
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
  float ndl = max(uSunDir.y, 0.0);
  vec3 ambient = uSkyColor * uAmbient;
  vec3 col = vColor * (ambient + uSunColor * ndl);

  float heightFactor = exp(-max(vWorld.y, 0.0) / uFogHeight);
  float fogAmount = clamp(1.0 - exp(-vViewDist * uFogDensity * heightFactor), 0.0, 0.95);
  col = mix(col, uFogColor, fogAmount);

  float alpha = 1.0 - smoothstep(uFadeStart, uFadeEnd, vViewDist);
  if (alpha < 0.01) discard;
  fragColor = vec4(col, alpha);
}
`;

/** Camera distance beyond which the city layer stops drawing entirely. */
const CITY_RANGE = 150;

/** buildings, boxed buildings, block mass, flat plots, flat blocks */
type Tier = 0 | 1 | 2 | 3 | 4;

/**
 * How long one rebuild may spend *generating* new geometry, as a fraction of the
 * frame that just went by, with a floor and a ceiling.
 *
 * Raising a large city's buildings from cold is the better part of a second of
 * work. Doing it in one rebuild is a visible freeze on first approach; spreading
 * it over successive frames is not, and in the meantime those blocks simply draw
 * at a coarser tier. The cache means each block pays this once.
 *
 * A wall-clock slice rather than a block count, because the two are only loosely
 * related — a cathedral close and a shanty block differ by two orders of
 * magnitude. And a slice *proportional to the frame*, because a fixed ten
 * milliseconds is a fifth of a frame on a fast machine and a hundredth of one on a
 * slow machine — so the machine that most needs the city to finish filling is the
 * one that never does, and it goes on paying for the coarse tier for as long as it
 * does not.
 */
const GENERATION_FRACTION = 0.6;
const GENERATION_MS_MIN = 8;
const GENERATION_MS_MAX = 140;

/**
 * How many city layouts to keep. Comfortably more than the number that can be
 * drawn at once, so a city bobbing in and out of range is not re-laid-out.
 */
const PLAN_CACHE = 64;

interface FlatBuilder {
  pos: number[];
  col: number[];
  idx: number[];
  vertex: number;
}

/** A stable hash of a world position, for decisions that must not flicker. */
function hash2(x: number, z: number): number {
  return Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
}

/** Garden green, mixed into the ground of blocks whose plots are mostly yard. */
const GARDEN: [number, number, number] = [0.3, 0.36, 0.2];

/** Dug earth, for the ditch on the field side of a wall. */
const DITCH_COLOR: [number, number, number] = [0.32, 0.28, 0.22];
/** Paving, for the apron behind a quay. */
const APRON_COLOR: [number, number, number] = [0.44, 0.43, 0.41];

/**
 * Fortification masonry, derived from the culture's own building stone.
 *
 * A curtain wall is the local rock, like everything else, but it is coursed rubble
 * rather than dressed and rendered ashlar — so it reads darker and greyer than the
 * houses behind it, which is exactly the contrast that makes a wall legible from
 * the air.
 */
function stoneFor(wallColor: number): {
  stone: [number, number, number];
  coping: [number, number, number];
} {
  const r = ((wallColor >> 16) & 255) / 255;
  const g = ((wallColor >> 8) & 255) / 255;
  const b = (wallColor & 255) / 255;
  const grey = (r + g + b) / 3;
  const mix = (k: number, v: number): number => (v * 0.45 + grey * 0.55) * k;
  return {
    stone: [mix(0.7, r), mix(0.71, g), mix(0.74, b)],
    coping: [mix(0.95, r), mix(0.96, g), mix(0.98, b)],
  };
}

/** Bridge masonry: paler than a curtain wall, because a bridge is dressed stone. */
const BRIDGE_STONE: [number, number, number] = [0.52, 0.5, 0.47];

const HARBOUR_PALETTE: HarbourPalette = {
  quay: [0.47, 0.46, 0.43],
  timber: [0.35, 0.28, 0.2],
  rubble: [0.41, 0.4, 0.37],
  hull: [0.24, 0.2, 0.16],
};

/**
 * The extent a block paints as developed ground.
 *
 * Full inside the town; short of its own edges near the boundary, and null for
 * some outer blocks entirely. The plan boundary has to be convex, so without
 * this the town ends along a visible straight chord — a nine-sided settlement
 * with a hard rim, which is the one thing no real place looks like.
 */
function groundPoly(block: Block): Poly | null {
  if (block.t < 0.52) return block.poly;

  // A deterministic per-block draw, so the ragged edge is stable as the camera
  // moves and identical between sessions.
  if (hash2(block.cx, block.cz) < (block.t - 0.52) * 0.9) return null;

  const shrink = Math.min(0.36, (block.t - 0.52) * 0.55);
  const c: [number, number] = [block.cx, block.cz];
  return insetConvex(block.poly, boundingRadius(block.poly, c[0], c[1]) * shrink);
}

/** Unpacks a packed RGB district colour and dims it. */
function scaled(color: number, v: number): [number, number, number] {
  return [(((color >> 16) & 255) / 255) * v, (((color >> 8) & 255) / 255) * v, ((color & 255) / 255) * v];
}

/**
 * The colour one block's developed ground takes.
 *
 * The district sets the hue, then two things move it: a per-block shade, because
 * no two blocks are beaten to the same colour, and a mix toward garden green in
 * proportion to how large the plots are. That second term is why a village reads
 * green and a city quarter reads brown — in a village most of every plot is
 * garden, and from the air that is the whole difference.
 */
function blockColor(block: Block, v: number): [number, number, number] {
  const base = scaled(DISTRICTS[block.district].color, 1);
  const green = clamp((block.plotScale - 1) * 0.15 + hash2(block.cz * 1.7, block.cx * 0.9) * 0.2, 0, 0.5);
  const k = v * (0.9 + hash2(block.cx * 0.6, block.cz * 2.1) * 0.2);
  return [
    (base[0] * (1 - green) + GARDEN[0] * green) * k,
    (base[1] * (1 - green) + GARDEN[1] * green) * k,
    (base[2] * (1 - green) + GARDEN[2] * green) * k,
  ];
}

function newFlat(): FlatBuilder {
  return { pos: [], col: [], idx: [], vertex: 0 };
}

function addFlatPoly(b: FlatBuilder, poly: Poly, r: number, g: number, bl: number, lift: number): void {
  const n = vertexCount(poly);
  if (n < 3) return;
  const base = b.vertex;
  for (let i = 0; i < n; i++) {
    b.pos.push(poly.pts[i * 2], lift, poly.pts[i * 2 + 1]);
    b.col.push(r, g, bl);
    b.vertex++;
  }
  for (let i = 1; i < n - 1; i++) b.idx.push(base, base + i, base + i + 1);
}

function addFlatRibbon(
  b: FlatBuilder,
  pts: Float32Array,
  widthKm: number,
  r: number,
  g: number,
  bl: number,
  lift: number,
): void {
  const n = pts.length / 2;
  if (n < 2) return;
  const half = widthKm * 0.5;
  const start = b.vertex;
  for (let i = 0; i < n; i++) {
    const px = pts[Math.max(0, i - 1) * 2];
    const pz = pts[Math.max(0, i - 1) * 2 + 1];
    const nx = pts[Math.min(n - 1, i + 1) * 2];
    const nz = pts[Math.min(n - 1, i + 1) * 2 + 1];
    let tx = nx - px;
    let tz = nz - pz;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const ox = -tz * half;
    const oz = tx * half;
    for (const s of [-1, 1]) {
      b.pos.push(pts[i * 2] + ox * s, lift, pts[i * 2 + 1] + oz * s);
      b.col.push(r, g, bl);
      b.vertex++;
    }
    if (i > 0) {
      const a = start + (i - 1) * 2;
      b.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
}

/** Merges cached solid slices into one buffer geometry. */
function mergeSolid(slices: BlockGeometry[]): THREE.BufferGeometry {
  let vertices = 0;
  let indices = 0;
  for (const g of slices) {
    vertices += g.pos.length / 3;
    indices += g.idx.length;
  }
  const pos = new Float32Array(vertices * 3);
  const nor = new Float32Array(vertices * 3);
  const col = new Float32Array(vertices * 3);
  const anchor = new Float32Array(vertices * 2);
  const idx = new Uint32Array(indices);
  let vo = 0;
  let io = 0;
  for (const g of slices) {
    const count = g.pos.length / 3;
    pos.set(g.pos, vo * 3);
    nor.set(g.nor, vo * 3);
    col.set(g.col, vo * 3);
    anchor.set(g.anchor, vo * 2);
    for (let i = 0; i < g.idx.length; i++) idx[io + i] = g.idx[i] + vo;
    vo += count;
    io += g.idx.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aAnchor', new THREE.BufferAttribute(anchor, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 6000);
  return geo;
}

/** Converts a builder into typed arrays that can be cached and copied. */
function freezeFlat(b: FlatBuilder): FlatGeometry {
  return {
    pos: new Float32Array(b.pos),
    col: new Float32Array(b.col),
    idx: new Uint32Array(b.idx),
  };
}

const STREET_COLOR: [number, number, number] = [0.55, 0.51, 0.44];
/**
 * The mural lane: the strip kept clear inside a curtain wall.
 *
 * Beaten earth, because it is walked and carted and never built on — a town that
 * lets its wall lane fill up with sheds cannot defend or repair the wall. From the
 * air it is the pale ring just inside the masonry, and it is most of what makes a
 * walled town read as walled even when the wall itself is only a few pixels.
 */
const MURAL_LANE: [number, number, number] = [0.52, 0.49, 0.43];

export interface CityStats {
  cities: number;
  /**
   * True when the last rebuild deferred no work — every block in range is drawn
   * at the tier its distance calls for. False while a city is still filling in.
   */
  settled: boolean;
  blocks: number;
  buildings: number;
  parcels: number;
  vertices: number;
  rebuildMs: number;
}

export class CityMeshes {
  readonly group = new THREE.Group();
  readonly buildingMaterial: THREE.RawShaderMaterial;
  readonly worksMaterial: THREE.RawShaderMaterial;
  readonly flatMaterial: THREE.RawShaderMaterial;

  private buildingMesh: THREE.Mesh;
  private worksMesh: THREE.Mesh;
  private flatMesh: THREE.Mesh;
  private buildingGeo = new THREE.BufferGeometry();
  private worksGeo = new THREE.BufferGeometry();
  private flatGeo = new THREE.BufferGeometry();

  private plans = new Map<number, CityPlan>();
  private bridges: Feature[];
  private bridgeGeom = new Map<number, BlockGeometry>();
  private settlements: Feature[];
  private regions: RegionInfo[];
  private cultures: CultureInfo[];
  private heightAt: (x: number, z: number) => number;
  private slopeAt: (x: number, z: number) => number;

  private enabled = true;
  private lastKey = '';
  /** The last frame's duration, which sets how much generating a rebuild may do. */
  private frameMs = 16;
  private stats: CityStats = {
    cities: 0,
    settled: true,
    blocks: 0,
    buildings: 0,
    parcels: 0,
    vertices: 0,
    rebuildMs: 0,
  };
  private vertexBudget: number;

  constructor(
    uniforms: WorldUniforms,
    features: Feature[],
    regions: RegionInfo[],
    cultures: CultureInfo[],
    heightAt: (x: number, z: number) => number,
    slopeAt: (x: number, z: number) => number,
    vertexBudget = 1_500_000,
  ) {
    this.settlements = features.filter(
      (f) =>
        f.kind === 'capital' ||
        f.kind === 'city' ||
        f.kind === 'town' ||
        f.kind === 'village' ||
        f.kind === 'hamlet',
    );
    // Bridges the generator recorded a bearing for. One without a bearing cannot
    // be laid: a deck at the wrong angle is a wall across a river.
    this.bridges = features.filter(
      (f) => f.kind === 'bridge' && f.approaches !== undefined && f.approaches.length > 0,
    );
    this.regions = regions;
    this.cultures = cultures;
    this.heightAt = heightAt;
    this.slopeAt = slopeAt;
    this.vertexBudget = vertexBudget;

    const shared = uniforms as unknown as Record<string, THREE.IUniform>;

    this.buildingMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...shared, uFadeStart: { value: 100 }, uFadeEnd: { value: 130 } },
      vertexShader: BUILDING_VERTEX,
      fragmentShader: BUILDING_FRAGMENT,
      transparent: true,
      side: THREE.FrontSide,
    });

    this.worksMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...shared, uFadeStart: { value: 100 }, uFadeEnd: { value: 130 } },
      vertexShader: WORKS_VERTEX,
      fragmentShader: BUILDING_FRAGMENT,
      transparent: true,
      side: THREE.FrontSide,
    });

    this.flatMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...shared,
        uLift: { value: 0.0011 },
        uFadeStart: { value: 100 },
        uFadeEnd: { value: 130 },
      },
      vertexShader: FLAT_VERTEX,
      fragmentShader: FLAT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.flatMesh = new THREE.Mesh(this.flatGeo, this.flatMaterial);
    this.flatMesh.frustumCulled = false;
    this.flatMesh.renderOrder = 7;
    this.group.add(this.flatMesh);

    this.buildingMesh = new THREE.Mesh(this.buildingGeo, this.buildingMaterial);
    this.buildingMesh.frustumCulled = false;
    this.buildingMesh.renderOrder = 8;
    this.group.add(this.buildingMesh);

    this.worksMesh = new THREE.Mesh(this.worksGeo, this.worksMaterial);
    this.worksMesh.frustumCulled = false;
    this.worksMesh.renderOrder = 9;
    this.group.add(this.worksMesh);
  }

  get lastStats(): Readonly<CityStats> {
    return this.stats;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.group.visible = v;
  }

  get active(): boolean {
    return this.enabled && this.group.visible;
  }

  private planFor(f: Feature): CityPlan {
    const cached = this.plans.get(f.id);
    if (cached) return cached;
    const region = this.regions[f.region];
    const culture = region ? region.culture : 1;
    const plan = buildCityPlan({
      feature: f,
      culture,
      heightAt: this.heightAt,
      slopeAt: this.slopeAt,
    });
    this.plans.set(f.id, plan);
    return plan;
  }

  /** The plain plot colour laid under the solid tiers. Camera-independent, so cached. */
  private flatBuilt(block: Block): FlatGeometry {
    if (block.flat.built) return block.flat.built;
    const b = newFlat();
    const poly = groundPoly(block);
    if (poly) addFlatPoly(b, poly, ...blockColor(block, 0.74), 1);
    block.flat.built = freezeFlat(b);
    return block.flat.built;
  }

  /** One polygon for the whole block, for the far tier. */
  private flatWhole(block: Block): FlatGeometry {
    if (block.flat.whole) return block.flat.whole;
    const b = newFlat();
    const poly = groundPoly(block);
    if (poly) addFlatPoly(b, poly, ...blockColor(block, 0.82), 1);
    block.flat.whole = freezeFlat(b);
    return block.flat.whole;
  }

  /** The parcel mosaic. Null when the plots are not subdivided and may not be. */
  private flatPlots(block: Block, culture: number, seed: number, mayBuild: boolean): FlatGeometry | null {
    if (block.flat.plots) return block.flat.plots;
    if (!block.parcels && !mayBuild) return null;
    const color = DISTRICTS[block.district].color;
    const b = newFlat();
    for (const parcel of buildParcels(block, culture, seed)) {
      addFlatPoly(b, parcel.poly, ...scaled(color, 0.86 + parcel.variant * 0.3), 1);
    }
    block.flat.plots = freezeFlat(b);
    return block.flat.plots;
  }

  /** Streets, ditch and quay apron for one city, baked once. */
  private flatGround(plan: CityPlan): FlatGeometry {
    if (plan.ground) return plan.ground;
    const b = newFlat();
    for (const street of plan.streets) {
      const [r, g, bl] = STREET_COLOR;
      addFlatRibbon(b, street.pts, street.widthKm, r, g, bl, 2);
    }
    if (plan.fort) {
      // The ditch, on the field side. The terrain cannot be cut — the heightfield
      // is baked long before anything knows a town is here — so it is a band of
      // dug earth, which is what a ditch looks like from a kilometre up anyway.
      const d = plan.fort.ditch;
      const n = d.length / 2;
      const closed = new Float32Array((n + 1) * 2);
      closed.set(d);
      closed[n * 2] = d[0];
      closed[n * 2 + 1] = d[1];
      const [r, g, bl] = DITCH_COLOR;
      addFlatRibbon(b, closed, 0.012, r, g, bl, 1);
      // The mural lane, kept clear inside the wall.
      const lane = plan.fort.lane;
      const m = lane.length / 2;
      const ring = new Float32Array((m + 1) * 2);
      ring.set(lane);
      ring[m * 2] = lane[0];
      ring[m * 2 + 1] = lane[1];
      const [wr, wg, wb] = MURAL_LANE;
      addFlatRibbon(b, ring, 0.016, wr, wg, wb, 2);
    }
    if (plan.harbour) {
      for (const q of plan.harbour.quays) {
        const [r, g, bl] = APRON_COLOR;
        addFlatRibbon(b, q.line, q.apronKm, r, g, bl, 3);
      }
    }
    plan.ground = freezeFlat(b);
    return plan.ground;
  }

  /**
   * One bridge's geometry, baked once.
   *
   * The anchor is the *higher* of the two abutments. A deck anchored mid-span
   * would take its ground from the riverbed and sit in the water; anchored at the
   * lower bank it would clear one side and not the other. Roads climb a little
   * onto a bridge in any case, which is what the higher abutment represents.
   */
  private bridgeGeometry(f: Feature): BlockGeometry {
    const cached = this.bridgeGeom.get(f.id);
    if (cached) return cached;

    const bearing = f.approaches ? f.approaches[0] : 0;
    const dx = Math.cos(bearing);
    const dz = Math.sin(bearing);
    const spanKm = clamp(f.spanKm ?? 0.12, 0.05, 2.4);
    const halfKm = spanKm * 0.5;

    const ah = this.heightAt(f.x + dx * halfKm, f.z + dz * halfKm);
    const bh = this.heightAt(f.x - dx * halfKm, f.z - dz * halfKm);
    const high = ah >= bh ? 1 : -1;

    const b = newGeomBuilder();
    emitBridge(
      b,
      {
        x: f.x,
        z: f.z,
        dx,
        dz,
        spanKm,
        widthKm: clamp(0.005 + spanKm * 0.004, 0.005, 0.011),
        // Above the abutment, not above the water: the bank is already clear of
        // the river, and a road that climbed twelve metres onto a bridge would
        // need a ramp longer than the bridge.
        riseKm: clamp(0.0015 + spanKm * 0.002, 0.0015, 0.005),
        ax: f.x + dx * halfKm * high,
        az: f.z + dz * halfKm * high,
      },
      BRIDGE_STONE,
    );
    const frozen = freezeGeometry(b);
    this.bridgeGeom.set(f.id, frozen);
    return frozen;
  }

  /**
   * The works: curtain wall and harbour, baked once per city.
   *
   * Neither depends on the camera, and both are small — a capital's wall is a few
   * thousand vertices against thirty thousand buildings — so they are built the
   * first time the city is drawn solid and copied thereafter.
   */
  private worksGeometry(plan: CityPlan, culture: number): BlockGeometry {
    if (plan.works) return plan.works;
    const info = this.cultures[culture] ?? this.cultures[0];
    const b = newGeomBuilder();
    if (plan.fort) {
      const { stone, coping } = stoneFor(info ? info.wallColor : 0x9a958c);
      emitFortification(b, plan.fort, stone, coping);
    }
    if (plan.harbour) emitHarbour(b, plan.harbour, HARBOUR_PALETTE);
    plan.works = freezeGeometry(b);
    return plan.works;
  }

  /** A block's cached geometry at a tier, or null if it has not been built yet. */
  private cachedGeometry(block: Block, tier: Tier): BlockGeometry | null {
    if (tier === 0) return block.geom.full;
    if (tier === 1) return block.geom.boxes;
    if (tier === 2) return block.geom.mass;
    return null;
  }

  /** Builds and caches a block's geometry at one tier. */
  private generate(block: Block, tier: Tier, culture: number, seed: number): BlockGeometry {
    const info = this.cultures[culture] ?? this.cultures[0];
    const b = newGeomBuilder();

    if (tier === 2) {
      // One prism for the whole block, estimated rather than measured. Inset by
      // the street setback so the mass does not pave over its own streets.
      const mass = estimateBlockMass(block, info);
      const inner = mass ? insetConvex(block.poly, culture === 3 ? 0.0035 : 0.0055) : null;
      if (mass && inner) emitBlockMass(b, inner, mass.height, mass.wall, mass.roof);
      block.geom.mass = freezeGeometry(b);
      return block.geom.mass;
    }

    for (const spec of buildBuildings(block, culture, info, seed)) {
      if (tier === 0) emitBuilding(b, spec);
      else emitBuildingBox(b, spec);
    }
    const frozen = freezeGeometry(b);
    block.geom[tier === 0 ? 'full' : 'boxes'] = frozen;
    return frozen;
  }

  update(focusX: number, focusZ: number, camDistance: number, frameMs = 16): void {
    if (!this.enabled) return;
    this.frameMs = frameMs;

    if (camDistance > CITY_RANGE) {
      if (this.stats.vertices !== 0) this.clear();
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const fade = clamp(camDistance * 2.6 + 26, 30, CITY_RANGE);
    for (const m of [this.buildingMaterial, this.worksMaterial, this.flatMaterial]) {
      m.uniforms.uFadeStart.value = fade * 0.8;
      m.uniforms.uFadeEnd.value = fade;
    }

    // Tier radii, measured from the camera focus, and scaled with camera distance
    // so that what fills the frame is what gets the detail. Roughly: r0 covers
    // what you are looking at, r1 its surroundings, and the block-mass tier
    // carries the rest of the region in solid form for a tenth of the vertices.
    const r0 = clamp(camDistance * 0.9, 0.6, 2.2);
    const r1 = clamp(camDistance * 1.8, 1.2, 4.5);
    const r2 = clamp(camDistance * 3.4, 2.6, 14);
    const r3 = clamp(camDistance * 5.0, 4, 26);

    const near: Array<{ f: Feature; d: number }> = [];
    for (const f of this.settlements) {
      const d = Math.hypot(f.x - focusX, f.z - focusZ);
      if (d > fade) continue;
      near.push({ f, d });
    }
    near.sort((a, b) => a.d - b.d);
    const chosen = near.slice(0, 48);

    // Quantise the focus so the rebuild fires on meaningful movement, not on
    // every pixel of camera drift.
    const q = Math.max(0.12, r0 * 0.3);
    const key = `${chosen.map((c) => c.f.id).join(',')}|${Math.round(focusX / q)},${Math.round(
      focusZ / q,
    )}|${Math.round(r0 * 20)},${Math.round(r1 * 8)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    // Retire plans for cities that have dropped out of range. Evicting in
    // insertion order would sometimes discard a city still on screen and pay to
    // lay it out again on the very next frame.
    if (this.plans.size > PLAN_CACHE) {
      const keep = new Set(chosen.map((c) => c.f.id));
      for (const id of [...this.plans.keys()]) {
        if (this.plans.size <= PLAN_CACHE) break;
        if (!keep.has(id)) this.plans.delete(id);
      }
    }

    const complete = this.rebuild(chosen.map((c) => c.f), focusX, focusZ, r0, r1, r2, r3);
    // If the generation slice ran out, ask for another pass next frame so the
    // city fills in progressively rather than all at once.
    if (!complete) this.lastKey = '';
  }

  private rebuild(
    features: Feature[],
    focusX: number,
    focusZ: number,
    r0: number,
    r1: number,
    r2: number,
    r3: number,
  ): boolean {
    const t0 = performance.now();

    // First pass: collect the cached geometry slices, so the merged buffers can
    // be sized exactly and filled with typed-array copies.
    const slices: BlockGeometry[] = [];
    const works: BlockGeometry[] = [];
    const flats: FlatGeometry[] = [];
    let vertexTotal = 0;
    let flatVertex = 0;
    let flatIndex = 0;
    let blockCount = 0;
    let buildingCount = 0;
    let parcelCount = 0;
    let generated = 0;
    let parcelled = 0;
    let planned = 0;
    let deferred = false;
    const deadline =
      t0 + clamp(this.frameMs * GENERATION_FRACTION, GENERATION_MS_MIN, GENERATION_MS_MAX);

    /** One visible block, with what it needs to be built and how far away it is. */
    interface Candidate {
      block: Block;
      culture: number;
      seed: number;
      d: number;
    }

    const addFlat = (g: FlatGeometry): void => {
      if (!g.pos.length) return;
      flats.push(g);
      flatVertex += g.pos.length / 3;
      flatIndex += g.idx.length;
    };

    // Bridges first: they belong to the road network rather than to any town, so
    // they are drawn whenever one is in view, city or no city.
    for (const f of this.bridges) {
      if (Math.hypot(f.x - focusX, f.z - focusZ) > r2) continue;
      const g = this.bridgeGeometry(f);
      if (g.pos.length) works.push(g);
    }

    const candidates: Candidate[] = [];

    for (const f of features) {
      // Laying out a large city — streets, blocks, districts — is half a second
      // of work, and approaching a cluster can bring several into range at once.
      // Building one per rebuild keeps that off any single frame; because the
      // features arrive nearest-first, the one you are looking at is the one that
      // gets built.
      let plan = this.plans.get(f.id);
      if (!plan) {
        if (planned > 0) {
          deferred = true;
          continue;
        }
        plan = this.planFor(f);
        planned++;
      }
      const region = this.regions[f.region];
      const culture = region ? region.culture : 1;
      addFlat(this.flatGround(plan));

      // The works are drawn wherever the city is close enough to read as solid at
      // all. A walled city seen from ten kilometres should read as walled — that
      // is the entire reason for building the wall as geometry.
      const cityD = Math.hypot(plan.cx - focusX, plan.cz - focusZ);
      if (cityD < r2 + plan.radiusKm) {
        const g = this.worksGeometry(plan, culture);
        if (g.pos.length) works.push(g);
      }

      for (const block of plan.blocks) {
        blockCount++;
        candidates.push({
          block,
          culture,
          seed: plan.featureId,
          d: Math.hypot(block.cx - focusX, block.cz - focusZ),
        });
      }
    }

    // Nearest first, so both budgets are spent on what the camera is looking at.
    // Visiting blocks in plan order instead leaves thin patches in the middle of
    // the frame and dense ones at its edge, according to nothing the viewer can
    // see.
    candidates.sort((a, b) => a.d - b.d);

    for (const { block, culture, seed, d } of candidates) {
      let tier: Tier = d < r0 ? 0 : d < r1 ? 1 : d < r2 ? 2 : d < r3 ? 3 : 4;
      // Over budget, step down one tier at a time. Dropping straight to flat
      // plots is the one fallback that stops reading as built; a boxed building,
      // and even a block prism, still reads as a building.
      if (tier === 0 && vertexTotal >= this.vertexBudget * 0.7) tier = 1;
      if (tier <= 1 && vertexTotal >= this.vertexBudget) tier = 2;

      // A solid tier that is neither cached nor affordable this pass drops to
      // flat plots until a later frame can afford to build it.
      if (tier <= 2) {
        let geo = this.cachedGeometry(block, tier);
        if (!geo) {
          if (performance.now() < deadline) {
            geo = this.generate(block, tier, culture, seed);
            generated++;
          } else {
            deferred = true;
            tier = 3;
          }
        }
        if (geo) {
          if (geo.pos.length) {
            slices.push(geo);
            vertexTotal += geo.pos.length / 3;
            buildingCount += block.buildings?.length ?? 0;
          }
          // The ground under the buildings still needs its plot colour, or the
          // town sits on bare terrain between its houses.
          addFlat(this.flatBuilt(block));
        }
      }

      if (tier === 3) {
        const cold = !block.flat.plots;
        const plots = this.flatPlots(block, culture, seed, performance.now() < deadline);
        if (plots) {
          if (cold) parcelled++;
          parcelCount += block.parcels?.length ?? 0;
          addFlat(plots);
        } else {
          deferred = true;
          tier = 4;
        }
      }

      if (tier === 4) addFlat(this.flatWhole(block));
    }

    // Second pass: one allocation per mesh, then copies.
    this.buildingGeo.dispose();
    this.buildingGeo = mergeSolid(slices);
    this.buildingMesh.geometry = this.buildingGeo;

    this.worksGeo.dispose();
    this.worksGeo = mergeSolid(works);
    this.worksMesh.geometry = this.worksGeo;
    for (const g of works) vertexTotal += g.pos.length / 3;

    const fpos = new Float32Array(flatVertex * 3);
    const fcol = new Float32Array(flatVertex * 3);
    const fidx = new Uint32Array(flatIndex);
    let fvo = 0;
    let fio = 0;
    for (const g of flats) {
      const count = g.pos.length / 3;
      fpos.set(g.pos, fvo * 3);
      fcol.set(g.col, fvo * 3);
      for (let i = 0; i < g.idx.length; i++) fidx[fio + i] = g.idx[i] + fvo;
      fvo += count;
      fio += g.idx.length;
    }

    this.flatGeo.dispose();
    this.flatGeo = new THREE.BufferGeometry();
    this.flatGeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
    this.flatGeo.setAttribute('color', new THREE.BufferAttribute(fcol, 3));
    this.flatGeo.setIndex(new THREE.BufferAttribute(fidx, 1));
    this.flatGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 6000);
    this.flatMesh.geometry = this.flatGeo;

    this.stats = {
      cities: features.length,
      settled: !deferred,
      blocks: blockCount,
      buildings: buildingCount,
      parcels: parcelCount,
      vertices: vertexTotal + flatVertex,
      rebuildMs: Math.round(performance.now() - t0),
    };
    return !deferred;
  }

  private clear(): void {
    this.buildingGeo.dispose();
    this.worksGeo.dispose();
    this.flatGeo.dispose();
    this.buildingGeo = new THREE.BufferGeometry();
    this.worksGeo = new THREE.BufferGeometry();
    this.flatGeo = new THREE.BufferGeometry();
    this.buildingMesh.geometry = this.buildingGeo;
    this.worksMesh.geometry = this.worksGeo;
    this.flatMesh.geometry = this.flatGeo;
    this.stats = {
      cities: 0,
      settled: true,
      blocks: 0,
      buildings: 0,
      parcels: 0,
      vertices: 0,
      rebuildMs: 0,
    };
    this.lastKey = '';
  }

  /** Raises or lowers how much built geometry may be resident, on a quality change. */
  setVertexBudget(vertices: number): void {
    if (vertices === this.vertexBudget) return;
    this.vertexBudget = vertices;
    this.lastKey = '';
  }

  planForFeature(f: Feature): CityPlan {
    return this.planFor(f);
  }

  dispose(): void {
    this.buildingGeo.dispose();
    this.worksGeo.dispose();
    this.flatGeo.dispose();
    this.buildingMaterial.dispose();
    this.worksMaterial.dispose();
    this.flatMaterial.dispose();
    this.group.remove(this.buildingMesh, this.worksMesh, this.flatMesh);
    this.plans.clear();
    this.bridgeGeom.clear();
  }
}
