/**
 * The world's data model.
 *
 * Everything the atlas can name, search, label, describe or fly to is a
 * `Feature`. Keeping them in one flat array with a discriminating `kind` is what
 * makes the gazetteer, the label layer and the search index trivial - a new
 * feature type only needs a kind, an icon and a label tier.
 */

export type FeatureKind =
  // Settlements
  | 'capital'
  | 'city'
  | 'town'
  | 'village'
  | 'hamlet'
  // Fortification and works
  | 'castle'
  | 'fortress'
  | 'watchtower'
  | 'tower'
  | 'wall'
  | 'bridge'
  // Religious and scholarly
  | 'temple'
  | 'monastery'
  | 'shrine'
  | 'observatory'
  | 'library'
  // Industry
  | 'mine'
  | 'quarry'
  | 'farm'
  | 'ranch'
  | 'vineyard'
  | 'watermill'
  | 'windmill'
  | 'sawmill'
  | 'saltworks'
  // Maritime
  | 'port'
  | 'harbour'
  | 'lighthouse'
  | 'shipwreck'
  | 'ferry'
  // Wayside
  | 'outpost'
  | 'inn'
  | 'cabin'
  | 'camp'
  | 'caravanserai'
  | 'oasis'
  // Ruin and monument
  | 'ruin'
  | 'monument'
  | 'standing_stones'
  | 'tomb'
  | 'battlefield'
  // Natural point features
  | 'peak'
  | 'volcano'
  | 'pass'
  | 'cave'
  | 'waterfall'
  | 'geyser'
  | 'canyon'
  | 'cliff'
  | 'plateau'
  | 'valley'
  | 'glacier'
  | 'dunes'
  | 'forest'
  | 'grove'
  | 'marsh'
  | 'spring'
  | 'crater'
  | 'arch'
  | 'delta'
  | 'sinkhole'
  // Extended features (have geometry)
  | 'range'
  | 'river'
  | 'lake'
  | 'island'
  | 'archipelago'
  | 'sea'
  | 'ocean'
  | 'bay'
  | 'gulf'
  | 'strait'
  | 'channel'
  | 'sound'
  | 'cape'
  | 'peninsula'
  | 'isthmus'
  | 'reef'
  | 'road'
  | 'region'
  | 'continent'
  | 'anomaly';

/** Broad grouping used by layer toggles and the legend. */
export type FeatureClass =
  | 'settlement'
  | 'structure'
  | 'landmark'
  | 'relief'
  | 'water'
  | 'vegetation'
  | 'route'
  | 'territory'
  | 'anomaly';

export interface Feature {
  id: number;
  name: string;
  kind: FeatureKind;
  cls: FeatureClass;
  /** World position in kilometres (x east, z south). */
  x: number;
  z: number;
  /** Terrain elevation in metres at the feature's position. */
  elevation: number;
  /** Owning region id, or -1 for open ocean features. */
  region: number;
  /** Owning continent id, or -1. */
  continent: number;
  /** 0..1 - drives label priority, icon size and zoom tier. */
  importance: number;
  /** Lowest zoom tier at which the label may appear (0 = visible at world view). */
  labelTier: number;
  population?: number;
  /** Free-form authored prose. */
  description: string;
  /** Short bullet facts shown in the info panel. */
  facts: string[];
  /** Approximate radius in km for extended features, used for framing the camera. */
  extent?: number;
  /** Polyline in world km for rivers, roads and coastal features. */
  path?: Float32Array;
  /** Ring polygon in world km for lakes, islands, regions. */
  outline?: Float32Array;
  /** Biome id at the feature's location. */
  biome?: number;
  /** Cross-references to other feature ids, e.g. a river's mouth city. */
  links?: number[];
  /** Tags for filtering and flavour: 'coastal', 'fortified', 'ancient'... */
  tags?: string[];
}

export interface RegionInfo {
  id: number;
  name: string;
  continent: number;
  /** Dominant culture id, drives naming and architecture. */
  culture: number;
  /** Seat of government - feature id of the capital, or -1. */
  capital: number;
  /** Area in square kilometres. */
  area: number;
  cx: number;
  cz: number;
  /** Packed RGB colour for the political layer. */
  color: number;
  dominantBiome: number;
  population: number;
  description: string;
  /** Border polylines in world km. */
  borders: Float32Array[];
  settlementCount: number;
  /** Adjacent region ids. */
  neighbours: number[];
  /** Terrain summary, e.g. "alpine", "littoral". */
  character: string;
}

export interface ContinentInfo {
  id: number;
  name: string;
  area: number;
  cx: number;
  cz: number;
  /** Bounding box in world km: minX, minZ, maxX, maxZ. */
  bounds: [number, number, number, number];
  regions: number[];
  description: string;
  highestPoint: number;
  population: number;
}

export interface CultureInfo {
  id: number;
  name: string;
  adjective: string;
  /** Architectural palette key used by the city builder. */
  architecture: 'stone' | 'timber' | 'adobe' | 'marble' | 'nordic' | 'terrace' | 'reed';
  /** Packed RGB roof colour. */
  roofColor: number;
  wallColor: number;
  description: string;
}

export interface RiverNode {
  x: number;
  z: number;
  /** Discharge proxy: contributing cell count. */
  flow: number;
  width: number;
  elevation: number;
}

/** Serialisable bundle handed from the generator worker to the renderer. */
export interface WorldPayload {
  seed: number;
  name: string;
  /** FINE x FINE elevation in km. */
  height: Float32Array;
  /** MACRO x MACRO RGBA: temperature, moisture, vegetation density, ambient occlusion. */
  climate: Uint8Array;
  /** MACRO x MACRO RGBA: cultivation, orogenic history, water table. */
  surface: Uint8Array;
  /** MACRO x MACRO RGBA: region colour + land mask in alpha. */
  regionMap: Uint8Array;
  /** MACRO x MACRO discrete biome ids. */
  biomeIds: Uint8Array;
  /** MACRO x MACRO water surface elevation in km (sea level for ocean). */
  waterLevel: Float32Array;
  features: Feature[];
  regions: RegionInfo[];
  continents: ContinentInfo[];
  cultures: CultureInfo[];
  /** Lake surface quads, flattened as x,z,y triplets per corner. */
  lakeQuads: Float32Array;
  /** River ribbon geometry, prebuilt in the worker. */
  riverVertices: Float32Array;
  riverIndices: Uint32Array;
  riverUVs: Float32Array;
  /** Road ribbon geometry. */
  roadVertices: Float32Array;
  roadIndices: Uint32Array;
  roadUVs: Float32Array;
  /** Political border line segments, flattened x,y,z pairs. */
  borderVertices: Float32Array;
  /** Coastline line segments for the cartographic outline layer. */
  coastVertices: Float32Array;
  stats: WorldStats;
}

export interface WorldStats {
  landFraction: number;
  highestPeak: number;
  deepestPoint: number;
  totalPopulation: number;
  counts: Record<string, number>;
  riverLengthKm: number;
  roadLengthKm: number;
  coastlineKm: number;
  generationMs: number;
}

export interface GenProgress {
  type: 'progress';
  stage: string;
  detail: string;
  fraction: number;
}

export interface GenDone {
  type: 'done';
  payload: WorldPayload;
}

export interface GenError {
  type: 'error';
  message: string;
  stack?: string;
}

export type GenMessage = GenProgress | GenDone | GenError;
