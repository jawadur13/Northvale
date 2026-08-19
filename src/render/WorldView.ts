/**
 * The 3D world.
 *
 * Owns the scene graph and every render layer, and exposes the small set of
 * controls the UI actually needs: layer visibility, exaggeration, quality, time
 * of day. Layer toggles are cheap because nothing is rebuilt - the terrain's
 * thematic layers are a uniform cross-fade, and the vector layers are visibility
 * flags on objects that already exist.
 *
 * Render order is explicit rather than left to depth sorting: sky, terrain, water,
 * lakes, rivers, roads, borders, coast, then instanced vegetation and buildings.
 * Getting this wrong shows up as rivers vanishing under the ocean plane or roads
 * z-fighting with the ground, both of which are far more visible than they sound.
 */

import * as THREE from 'three';
import {
  DEFAULT_EXAGGERATION,
  QUALITY_PRESETS,
  type QualityName,
  tierForDistance,
  ZoomTier,
} from '../core/config';
import { clamp } from '../util/math';
import type { WorldPayload } from '../world/types';
import { Atmosphere } from './Atmosphere';
import { CityMeshes } from './features/CityMeshes';
import { Ribbon, WorldLines } from './features/Ribbons';
import { Vegetation } from './features/Vegetation';
import { TerrainSurface } from './terrain/TerrainSurface';
import { Water } from './water/Water';
import { WorldResources } from './WorldResources';

export interface LayerState {
  terrain: boolean;
  water: boolean;
  rivers: boolean;
  roads: boolean;
  settlements: boolean;
  landmarks: boolean;
  vegetation: boolean;
  political: boolean;
  borders: boolean;
  coastline: boolean;
  elevation: boolean;
  biomes: boolean;
  contours: boolean;
  graticule: boolean;
  labels: boolean;
}

export const DEFAULT_LAYERS: LayerState = {
  terrain: true,
  water: true,
  rivers: true,
  roads: true,
  settlements: true,
  landmarks: true,
  vegetation: true,
  political: false,
  borders: false,
  coastline: false,
  elevation: false,
  biomes: false,
  contours: false,
  graticule: false,
  labels: true,
};

export interface FrameStats {
  chunks: number;
  triangles: number;
  maxDepth: number;
  plants: number;
  buildings: number;
  planCities: number;
  planBlocks: number;
  planParcels: number;
  /** Time the last city geometry reassembly took, in ms. */
  rebuildMs: number;
  /** False while the cities in view are still filling in from cold. */
  citiesSettled: boolean;
  tier: ZoomTier;
}

export class WorldView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly resources: WorldResources;
  readonly atmosphere: Atmosphere;
  readonly terrain: TerrainSurface;
  readonly water: Water;
  readonly rivers: Ribbon | null;
  readonly roads: Ribbon | null;
  readonly borders: WorldLines;
  readonly coastline: WorldLines;
  readonly vegetation: Vegetation;
  readonly cities: CityMeshes;

  private layers: LayerState = { ...DEFAULT_LAYERS };
  private quality: QualityName = 'high';
  private stats: FrameStats = {
    chunks: 0,
    triangles: 0,
    maxDepth: 0,
    plants: 0,
    buildings: 0,
    planCities: 0,
    planBlocks: 0,
    planParcels: 0,
    rebuildMs: 0,
    citiesSettled: true,
    tier: ZoomTier.World,
  };

  constructor(payload: WorldPayload, renderer: THREE.WebGLRenderer) {
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.15, 26000);
    this.camera.position.set(0, 4000, 3200);

    this.resources = new WorldResources(payload, renderer);
    const u = this.resources.uniforms;

    this.atmosphere = new Atmosphere(u);
    this.scene.add(this.atmosphere.mesh);

    const heightAt = (x: number, z: number) => this.resources.heightAt(x, z);
    const exag = () => u.uExaggeration.value;

    const preset = QUALITY_PRESETS[this.quality];
    this.terrain = new TerrainSurface(u, heightAt, preset.terrainSegments, preset.maxQuadtreeDepth);
    this.scene.add(this.terrain.group);

    const extra = payload as unknown as {
      lakeIndices?: Uint32Array;
      riverPerp?: Float32Array;
      roadPerp?: Float32Array;
    };

    this.water = new Water(
      u,
      payload.lakeQuads,
      extra.lakeIndices ?? new Uint32Array(0),
      this.atmosphere.horizonColor,
      this.camera.position,
    );
    this.scene.add(this.water.group);

    this.rivers =
      payload.riverVertices.length > 0 && extra.riverPerp
        ? new Ribbon(
            {
              positions: payload.riverVertices,
              perp: extra.riverPerp,
              params: payload.riverUVs,
              indices: payload.riverIndices,
            },
            u,
            'river',
            this.camera.position,
          )
        : null;
    if (this.rivers) this.scene.add(this.rivers.mesh);

    this.roads =
      payload.roadVertices.length > 0 && extra.roadPerp
        ? new Ribbon(
            {
              positions: payload.roadVertices,
              perp: extra.roadPerp,
              params: payload.roadUVs,
              indices: payload.roadIndices,
            },
            u,
            'road',
            this.camera.position,
          )
        : null;
    if (this.roads) this.scene.add(this.roads.mesh);

    this.borders = new WorldLines(
      payload.borderVertices,
      u,
      new THREE.Color(0.94, 0.86, 0.66),
      0.85,
      0.02,
    );
    this.scene.add(this.borders.object);

    this.coastline = new WorldLines(
      payload.coastVertices,
      u,
      new THREE.Color(0.9, 0.93, 0.96),
      0.6,
      0.015,
    );
    this.scene.add(this.coastline.object);

    this.vegetation = new Vegetation(
      u,
      payload.biomeIds,
      payload.climate,
      payload.surface,
      heightAt,
      exag,
      preset.vegetationBudget,
    );
    this.scene.add(this.vegetation.group);

    // Approximate gradient from four height samples, in the same 0..1 units the
    // simulation's slope field uses, so the city planner's thresholds transfer.
    const slopeAt = (x: number, z: number) => {
      const d = 0.08;
      const gx = (heightAt(x + d, z) - heightAt(x - d, z)) / (2 * d);
      const gz = (heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d);
      return Math.min(1, Math.hypot(gx, gz) / 0.45);
    };
    this.cities = new CityMeshes(
      u,
      payload.features,
      payload.regions,
      payload.cultures,
      heightAt,
      slopeAt,
      preset.cityVertexBudget,
    );
    this.scene.add(this.cities.group);

    this.applyLayers();
  }

  // --- Controls -----------------------------------------------------------

  setLayer<K extends keyof LayerState>(key: K, value: boolean): void {
    this.layers[key] = value;
    this.applyLayers();
  }

  getLayers(): Readonly<LayerState> {
    return this.layers;
  }

  private applyLayers(): void {
    const u = this.resources.uniforms;
    const l = this.layers;

    // The thematic layers are exclusive overlays on the terrain, blended by
    // weight rather than swapped, so toggling one cross-fades.
    this.resources.setLayerMix(1, l.elevation ? 1 : 0, l.biomes ? 1 : 0, l.political ? 0.75 : 0);
    u.uContourStrength.value = l.contours ? 0.8 : 0;
    u.uGraticule.value = l.graticule ? 1 : 0;

    this.terrain.group.visible = l.terrain;
    this.water.setVisible(l.water);
    this.rivers?.setVisible(l.rivers);
    this.roads?.setVisible(l.roads);
    this.borders.setVisible(l.borders || l.political);
    this.coastline.setVisible(l.coastline);
    this.vegetation.setEnabled(l.vegetation);
    this.cities.setEnabled(l.settlements);
  }

  setExaggeration(v: number): void {
    this.resources.uniforms.uExaggeration.value = clamp(v, 1, 8);
  }

  getExaggeration(): number {
    return this.resources.uniforms.uExaggeration.value;
  }

  setReliefShading(v: number): void {
    this.resources.uniforms.uReliefBoost.value = clamp(v, 1, 6);
  }

  getReliefShading(): number {
    return this.resources.uniforms.uReliefBoost.value;
  }

  setQuality(name: QualityName): void {
    this.quality = name;
    const p = QUALITY_PRESETS[name];
    this.terrain.setQuality(p.terrainSegments, p.maxQuadtreeDepth);
    this.resources.uniforms.uShadowSteps.value = p.shadowSteps;
    this.vegetation.setBudget(p.vegetationBudget);
    this.cities.setVertexBudget(p.cityVertexBudget);
    this.water.setDetail(p.waterDetail);
  }

  getQuality(): QualityName {
    return this.quality;
  }

  /** Trunk roads only (1) through to every lane (5). */
  setRoadDetail(maxClass: number): void {
    if (this.roads) this.roads.material.uniforms.uRoadFilter.value = maxClass;
  }

  setRibbonScale(v: number): void {
    if (this.rivers) this.rivers.material.uniforms.uWidthScale.value = v;
    if (this.roads) this.roads.material.uniforms.uWidthScale.value = v;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.terrain.setViewportHeight(height);
  }

  // --- Per-frame ----------------------------------------------------------

  update(
    dt: number,
    elapsed: number,
    focusX: number,
    focusZ: number,
    camDistance: number,
    /** How long the last frame took, in ms. Sets the city generation slice. */
    frameMs = 16,
  ): void {
    const u = this.resources.uniforms;
    u.uTime.value = elapsed;
    u.uCamDistance.value = camDistance;

    // Minimum on-screen ribbon width. Rivers and roads must stay legible at world
    // zoom without becoming absurd up close, so the floor tracks the camera
    // distance - which makes it a constant number of pixels.
    u.uMinRibbonKm.value = clamp(camDistance * 0.0011, 0.012, 3.4);

    // Surface detail noise is pointless once a texel is sub-pixel, and it costs
    // fill rate, so it fades out above the regional tier.
    u.uDetailStrength.value = camDistance < 1400 ? 1 : 0;

    // Atmospheric haze is expressed *relative to the camera distance* rather than
    // as an absolute density. A fixed density that reads as gentle haze from two
    // kilometres up buries the entire world in white from four thousand, and one
    // tuned for the world view is invisible everywhere else. Scaling it keeps the
    // horizon soft and the focus clear at every scale.
    const dayHaze = this.atmosphere.hazeStrength();
    u.uFogDensity.value = (0.115 * dayHaze) / Math.max(2, camDistance);
    // Haze pools in the valleys; the height scale has to track the exaggeration or
    // it lands in the wrong place the moment the slider moves.
    u.uFogHeight.value = 2.6 * u.uExaggeration.value + camDistance * 0.05;

    // Contour interval adapts so the lines never crowd into a solid mass.
    if (u.uContourStrength.value > 0) {
      u.uContourInterval.value =
        camDistance > 1600 ? 1.0 : camDistance > 500 ? 0.5 : camDistance > 120 ? 0.2 : 0.1;
    }

    this.atmosphere.follow(this.camera);
    this.water.follow(this.camera.position.x, this.camera.position.z);
    this.terrain.update(this.camera);
    this.vegetation.update(focusX, focusZ, camDistance);
    this.cities.update(focusX, focusZ, camDistance, frameMs);

    // Near plane tightens as the camera descends, which is what keeps depth
    // precision usable across a range from 1.4 km to 7,600 km.
    const near = clamp(camDistance * 0.0022, 0.06, 12);
    const far = clamp(camDistance * 9 + 3000, 4000, 34000);
    if (Math.abs(this.camera.near - near) > near * 0.12 || Math.abs(this.camera.far - far) > far * 0.1) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }

    const ts = this.terrain.lastStats;
    this.stats.chunks = ts.drawn;
    this.stats.triangles = ts.triangles;
    this.stats.maxDepth = ts.maxDepth;
    this.stats.plants = this.vegetation.lastInstanceCount;
    const cs = this.cities.lastStats;
    this.stats.buildings = cs.buildings;
    this.stats.planCities = cs.cities;
    this.stats.planBlocks = cs.blocks;
    this.stats.planParcels = cs.parcels;
    this.stats.rebuildMs = cs.rebuildMs;
    this.stats.citiesSettled = cs.settled;
    this.stats.tier = tierForDistance(camDistance);

    void dt;
  }

  get frameStats(): Readonly<FrameStats> {
    return this.stats;
  }

  dispose(): void {
    this.terrain.dispose();
    this.water.dispose();
    this.rivers?.dispose();
    this.roads?.dispose();
    this.borders.dispose();
    this.coastline.dispose();
    this.vegetation.dispose();
    this.cities.dispose();
    this.atmosphere.dispose();
    this.resources.dispose();
  }
}

void DEFAULT_EXAGGERATION;
