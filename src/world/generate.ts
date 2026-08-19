/**
 * World generation pipeline.
 *
 * Runs the whole thing, in dependency order, reporting progress as it goes. The
 * ordering is not arbitrary - each stage consumes the previous one:
 *
 *   elevation -> anomalies -> hydrology -> climate -> landforms
 *             -> regions -> settlements -> roads -> landmarks
 *             -> features -> textures -> geometry
 *
 * Hydrology runs before climate because the moisture march needs to know where
 * the water is, and landforms run after climate because biome membership is what
 * defines a forest or a dune field. Roads run after settlements because a road
 * exists to connect two places, and landmarks run after roads because half of
 * them exist because of a road.
 *
 * Designed to run inside a Worker, but it has no DOM dependencies at all, so the
 * smoke test drives it directly from Node.
 */

import { DEFAULT_EXAGGERATION, FINE, HALF_KM, MACRO, WORLD_KM } from '../core/config';
import { Field } from '../util/grid';
import { NameForge } from './gen/names';
import { deriveSeed } from '../util/rng';
import { stampAnomalies } from './gen/anomalies';
import { generateClimate } from './gen/climate';
import { generateElevation } from './gen/elevation';
import { assembleFeatures } from './gen/features';
import {
  buildBorderGeometry,
  buildCoastline,
  buildLakeGeometry,
  buildRiverGeometry,
  buildRoadGeometry,
} from './gen/geometry';
import { generateHydrology } from './gen/hydrology';
import { analyseLandforms } from './gen/landforms';
import { generateLandmarks } from './gen/landmarks';
import { generateRegions } from './gen/regions';
import { generateRoads } from './gen/roads';
import { generateSettlements } from './gen/settlements';
import {
  buildAmbientOcclusion,
  buildClimateTexture,
  buildFineHeight,
  buildOverviewImage,
  buildRegionTexture,
  buildSurfaceTexture,
} from './gen/textures';
import type { Feature, WorldPayload, WorldStats } from './types';

export type ProgressFn = (stage: string, detail: string, fraction: number) => void;

/** Extra products the renderer needs that are not part of the serialised payload shape. */
export interface GenerateResult {
  payload: WorldPayload;
  overview: Uint8Array;
  overviewSize: number;
  riverGeometry: ReturnType<typeof buildRiverGeometry>['geometry'];
  roadGeometry: ReturnType<typeof buildRoadGeometry>['geometry'];
}

const OVERVIEW_SIZE = 384;

export function generateWorld(seed: number, onProgress: ProgressFn = () => {}): GenerateResult {
  const t0 = Date.now();
  const forge = new NameForge(deriveSeed(seed, 'names'));

  onProgress('Raising the land', 'Continental cores and orogenic belts', 0.02);
  const elev = generateElevation(seed);
  const height: Field = elev.height;

  onProgress('Raising the land', 'Applying border falloff', 0.12);
  applyBorderFalloff(height);

  onProgress('Breaking the rules', 'Stamping fourteen impossible places', 0.14);
  stampAnomalies(height, seed);

  onProgress('Routing the water', 'Filling depressions and tracing channels', 0.17);
  const hydro = generateHydrology(height, elev.orogeny, 2);

  onProgress('Setting the climate', 'Marching moisture across the winds', 0.34);
  const climate = generateClimate(height, elev.orogeny, hydro.waterTable, seed);

  onProgress('Reading the terrain', 'Summits, ranges, passes, coasts and islands', 0.42);
  const landforms = analyseLandforms(height, elev.orogeny, climate.slope, climate.biome, climate.coastDistance);

  onProgress('Drawing the borders', 'Growing regions along the watersheds', 0.52);
  const regionResult = generateRegions(
    height,
    climate.slope,
    climate,
    hydro.waterTable,
    hydro.isRiver,
    hydro.lakeId,
    landforms.landmasses,
    landforms.landOwner,
    forge,
    seed,
  );

  onProgress('Founding settlements', 'Scoring every site in the world', 0.58);
  const settlementResult = generateSettlements(
    height,
    climate.slope,
    climate,
    hydro,
    landforms,
    elev.orogeny,
    regionResult.ownership,
    regionResult.regions.length,
    seed,
  );

  onProgress('Building the roads', 'Pathfinding between every settlement', 0.66);
  const roadResult = generateRoads(
    height,
    climate.slope,
    climate,
    hydro,
    settlementResult.settlements,
    seed,
  );

  onProgress('Placing landmarks', 'Castles, ruins, mines, mills and lighthouses', 0.73);
  const landmarks = generateLandmarks(
    height,
    climate.slope,
    elev.orogeny,
    climate,
    hydro,
    landforms,
    regionResult.ownership,
    settlementResult.settlements,
    roadResult,
    settlementResult.developed,
    seed,
  );

  onProgress('Naming the world', 'Writing the gazetteer', 0.79);
  const assembly = assembleFeatures({
    seed,
    height,
    orogeny: elev.orogeny,
    climate,
    hydro,
    landforms,
    ownership: regionResult.ownership,
    regions: regionResult.regions,
    cultures: regionResult.cultures,
    settlements: settlementResult.settlements,
    landmarks,
    roads: roadResult,
    riverPolylines: [],
    forge,
  });

  onProgress('Baking the relief', 'Upsampling to the render heightfield', 0.85);
  const fineHeight = buildFineHeight(height, elev.orogeny, seed);

  onProgress('Baking the relief', 'Ambient occlusion', 0.89);
  const ao = buildAmbientOcclusion(height);

  onProgress('Cutting the channels', 'River and road ribbons', 0.93);
  const riverGeo = buildRiverGeometry(hydro.rivers, fineHeight);
  const roadGeo = buildRoadGeometry(roadResult.roads, fineHeight);
  const lakeGeo = buildLakeGeometry(hydro);
  const coast = buildCoastline(height);
  const borderVertices = buildBorderGeometry(regionResult.borderSegments, fineHeight);

  // Attach the river polylines now that they exist, so the info panel can frame them.
  {
    const riverFeatures = assembly.features.filter((f) => f.kind === 'river');
    for (let i = 0; i < riverFeatures.length && i < riverGeo.polylines.length; i++) {
      riverFeatures[i].path = riverGeo.polylines[i];
    }
    // Every channel, not only the named ones: most road crossings are of a river
    // too small to have a name, and all of them have to end up on the water.
    snapBridgesToRivers(assembly.features, riverGeo.polylines, riverFeatures, height.data);
  }

  onProgress('Drawing the map', 'Climate, political and overview textures', 0.96);
  const climateTex = buildClimateTexture(climate, ao);
  const surfaceTex = buildSurfaceTexture(
    settlementResult.developed,
    elev.orogeny,
    hydro.waterTable,
    climate.coastDistance,
  );
  const regionTex = buildRegionTexture(
    regionResult.ownership,
    regionResult.regions.map((r) => r.color),
  );
  const overview = buildOverviewImage(
    OVERVIEW_SIZE,
    fineHeight,
    climate,
    ao,
    settlementResult.developed,
    elev.orogeny,
    DEFAULT_EXAGGERATION,
  );

  // ------------------------------------------------------------------ stats
  const counts: Record<string, number> = {};
  for (const f of assembly.features) counts[f.kind] = (counts[f.kind] ?? 0) + 1;

  let highest = -Infinity;
  let deepest = Infinity;
  for (let i = 0; i < fineHeight.length; i++) {
    if (fineHeight[i] > highest) highest = fineHeight[i];
    if (fineHeight[i] < deepest) deepest = fineHeight[i];
  }
  let totalPopulation = 0;
  for (const s of settlementResult.settlements) totalPopulation += s.population;

  let landCells = 0;
  for (let i = 0; i < height.data.length; i++) if (height.data[i] > 0) landCells++;

  const stats: WorldStats = {
    landFraction: landCells / (MACRO * MACRO),
    highestPeak: highest * 1000,
    deepestPoint: deepest * 1000,
    totalPopulation,
    counts,
    riverLengthKm: riverGeo.totalLengthKm,
    roadLengthKm: roadGeo.totalLengthKm,
    coastlineKm: coast.lengthKm,
    generationMs: Date.now() - t0,
  };

  const payload: WorldPayload = {
    seed,
    name: 'Northvale',
    height: fineHeight,
    climate: climateTex,
    surface: surfaceTex,
    regionMap: regionTex,
    biomeIds: climate.biome,
    waterLevel: hydro.waterSurface,
    features: assembly.features,
    regions: regionResult.regions,
    continents: assembly.continents,
    cultures: regionResult.cultures,
    lakeQuads: lakeGeo.positions,
    riverVertices: riverGeo.geometry.positions,
    riverIndices: riverGeo.geometry.indices,
    riverUVs: riverGeo.geometry.params,
    roadVertices: roadGeo.geometry.positions,
    roadIndices: roadGeo.geometry.indices,
    roadUVs: roadGeo.geometry.params,
    borderVertices,
    coastVertices: coast.vertices,
    stats,
  };

  // Lake indices and ribbon perpendiculars ride along on the same message.
  (payload as WorldPayload & { lakeIndices: Uint32Array }).lakeIndices = lakeGeo.indices;
  (payload as WorldPayload & { riverPerp: Float32Array }).riverPerp = riverGeo.geometry.perp;
  (payload as WorldPayload & { roadPerp: Float32Array }).roadPerp = roadGeo.geometry.perp;

  onProgress('Ready', `${assembly.features.length} named places`, 1);

  return {
    payload,
    overview,
    overviewSize: OVERVIEW_SIZE,
    riverGeometry: riverGeo.geometry,
    roadGeometry: roadGeo.geometry,
  };
}

/**
 * Pulls the outer frame of the world down below sea level.
 *
 * Without this, a continent that happens to reach the edge of the grid would be
 * cut off by a straight line, and the depression filler would drain half a
 * continent off the side of the map.
 */
function applyBorderFalloff(height: Field): void {
  const MARGIN = 42; // cells
  for (let y = 0; y < MACRO; y++) {
    for (let x = 0; x < MACRO; x++) {
      const d = Math.min(x, y, MACRO - 1 - x, MACRO - 1 - y);
      if (d >= MARGIN) continue;
      const t = d / MARGIN;
      // Smooth ramp into deep water at the very edge.
      const factor = t * t * (3 - 2 * t);
      const i = y * MACRO + x;
      const target = -3.4 - (1 - factor) * 1.6;
      height.data[i] = height.data[i] * factor + target * (1 - factor);
    }
  }
}

void FINE;

/**
 * Puts every bridge on its river.
 *
 * A bridge's position comes from the road search grid, which is 512 cells across
 * the world — eight kilometres a cell. That is enough to record that a road
 * crosses a river somewhere around here, which is all it was ever used for, and
 * useless for building anything: the recorded point can be four kilometres from
 * the water, on a hillside.
 *
 * So each one is moved to the nearest point on an actual river polyline and given
 * the bearing square across the flow — a bridge is perpendicular to its river by
 * definition — and its elevation and its "On the Such-and-such" fact are corrected
 * to match, because a feature whose stated river and actual position disagree is
 * worse than one that is merely imprecise.
 *
 * This has to happen here rather than during assembly: the polylines are built
 * from the render heightfield, which does not exist until after the gazetteer.
 */
function snapBridgesToRivers(
  features: Feature[],
  channels: Float32Array[],
  named: Feature[],
  height: Float32Array,
): void {
  /** Nearest point on a set of polylines, with the direction of flow there. */
  const nearest = (
    x: number,
    z: number,
    maxKm: number,
    paths: Float32Array[],
  ): { x: number; z: number; tx: number; tz: number; which: number } | null => {
    let bestD = maxKm * maxKm;
    let out: { x: number; z: number; tx: number; tz: number; which: number } | null = null;
    for (let p = 0; p < paths.length; p++) {
      const path = paths[p];
      const n = path.length / 2;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) {
        const px = path[i * 2];
        const pz = path[i * 2 + 1];
        const d = (px - x) * (px - x) + (pz - z) * (pz - z);
        if (d >= bestD) continue;
        const a = i === 0 ? 0 : i - 1;
        const c = i === n - 1 ? n - 1 : i + 1;
        const ex = path[c * 2] - path[a * 2];
        const ez = path[c * 2 + 1] - path[a * 2 + 1];
        if (ex === 0 && ez === 0) continue;
        bestD = d;
        out = { x: px, z: pz, tx: ex, tz: ez, which: p };
      }
    }
    return out;
  };

  const namedPaths = named.map((r) => r.path).filter((p): p is Float32Array => p !== undefined);

  for (const b of features) {
    if (b.kind !== 'bridge') continue;

    const hit = nearest(b.x, b.z, 14, channels);
    if (!hit) continue;

    b.x = hit.x;
    b.z = hit.z;
    // Square across the flow: a bridge is perpendicular to its river by definition.
    b.approaches = Float32Array.of(Math.atan2(-hit.tx, hit.tz));

    const gx = Math.round(((b.x + HALF_KM) / WORLD_KM) * (MACRO - 1));
    const gz = Math.round(((b.z + HALF_KM) / WORLD_KM) * (MACRO - 1));
    if (gx >= 0 && gz >= 0 && gx < MACRO && gz < MACRO) {
      b.elevation = height[gz * MACRO + gx] * 1000;
    }

    // Then correct the river it claims to be on, which was named from the old
    // point. Only a *named* river can be claimed, and only if it is genuinely the
    // one being crossed rather than the nearest big one some way off.
    const onNamed = nearest(b.x, b.z, 1.5, namedPaths);
    const at = b.facts.findIndex((f: string) => f.startsWith('On '));
    if (onNamed) {
      const on = `On ${named[onNamed.which].name}`;
      if (at >= 0) b.facts[at] = on;
      else b.facts.push(on);
    } else if (at >= 0) {
      b.facts.splice(at, 1);
    }
  }
}
