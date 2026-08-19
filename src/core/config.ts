/**
 * Global constants. One kilometre of Northvale is one unit in the render scene,
 * so camera distances, fog ranges and elevation numbers all read in real units.
 */

/** Edge length of the world square, in kilometres. */
export const WORLD_KM = 4096;
export const HALF_KM = WORLD_KM / 2;

/** Simulation grid: elevation, climate, hydrology, region ownership. 4 km / cell. */
export const MACRO = 1024;

/** Render height texture. 2 km / texel, with shader detail below that. */
export const FINE = 2048;

/** Metres per macro cell, handy for slope-to-degrees conversions. */
export const MACRO_CELL_KM = WORLD_KM / MACRO;
export const FINE_CELL_KM = WORLD_KM / FINE;

/** Sea level sits at y = 0. Elevations are stored in kilometres. */
export const SEA_LEVEL = 0;
export const MAX_ELEVATION_KM = 7.9;
export const MAX_DEPTH_KM = 6.4;

/** Default vertical exaggeration - a relief model, not a globe. User-adjustable. */
export const DEFAULT_EXAGGERATION = 4.2;
export const MIN_EXAGGERATION = 1;
export const MAX_EXAGGERATION = 8;

/** Latitude mapping: north is -Z, so the map reads north-up from the default camera. */
export const MAX_LATITUDE = 74;
export function zToLatitude(z: number): number {
  return (-z / HALF_KM) * MAX_LATITUDE;
}
export function latitudeToZ(lat: number): number {
  return (-lat / MAX_LATITUDE) * HALF_KM;
}

/** Camera envelope, in kilometres of distance from the focus point. */
export const CAM_MIN_DISTANCE = 1.4;
export const CAM_MAX_DISTANCE = 7600;
/**
 * The opening distance. Chosen so the 4,096 km world very nearly fills the
 * vertical field of view - the first impression is meant to be the scale of the
 * thing, and a world floating in a wide margin of ocean undersells it.
 */
export const CAM_WORLD_DISTANCE = 4500;

/** Zoom tiers drive label density, vegetation, city geometry and shader detail. */
export enum ZoomTier {
  World = 0,
  Continental = 1,
  Regional = 2,
  Local = 3,
  Close = 4,
}

/** Distance thresholds (km) at which each tier begins, from closest to furthest. */
export const TIER_DISTANCE: Record<ZoomTier, number> = {
  [ZoomTier.Close]: 0,
  [ZoomTier.Local]: 90,
  [ZoomTier.Regional]: 380,
  [ZoomTier.Continental]: 1250,
  [ZoomTier.World]: 3000,
};

export function tierForDistance(d: number): ZoomTier {
  if (d >= TIER_DISTANCE[ZoomTier.World]) return ZoomTier.World;
  if (d >= TIER_DISTANCE[ZoomTier.Continental]) return ZoomTier.Continental;
  if (d >= TIER_DISTANCE[ZoomTier.Regional]) return ZoomTier.Regional;
  if (d >= TIER_DISTANCE[ZoomTier.Local]) return ZoomTier.Local;
  return ZoomTier.Close;
}

export const TIER_NAMES: Record<ZoomTier, string> = {
  [ZoomTier.World]: 'World',
  [ZoomTier.Continental]: 'Continental',
  [ZoomTier.Regional]: 'Regional',
  [ZoomTier.Local]: 'Local',
  [ZoomTier.Close]: 'Detail',
};

/** The default world. A different seed produces an entirely different Northvale. */
export const DEFAULT_SEED = 0x4e56_414c;

/** Quality presets, chosen from device capability then adjustable in settings. */
export interface QualitySettings {
  terrainSegments: number;
  maxQuadtreeDepth: number;
  shadowSteps: number;
  vegetationBudget: number;
  /**
   * Vertices of built geometry the city layer may hold at once.
   *
   * Detail is chosen per block from its distance to the camera, so this does not
   * decide *what* is drawn so much as how far out the detailed tiers reach before
   * blocks start stepping down. A capital at full detail is about 1.3 million.
   */
  cityVertexBudget: number;
  pixelRatioCap: number;
  waterDetail: number;
}

export const QUALITY_PRESETS: Record<'low' | 'medium' | 'high' | 'ultra', QualitySettings> = {
  low: {
    terrainSegments: 32,
    maxQuadtreeDepth: 5,
    shadowSteps: 0,
    vegetationBudget: 9000,
    cityVertexBudget: 260_000,
    pixelRatioCap: 1,
    waterDetail: 0,
  },
  medium: {
    terrainSegments: 48,
    maxQuadtreeDepth: 6,
    shadowSteps: 12,
    vegetationBudget: 28000,
    cityVertexBudget: 650_000,
    pixelRatioCap: 1.35,
    waterDetail: 1,
  },
  high: {
    terrainSegments: 64,
    maxQuadtreeDepth: 7,
    shadowSteps: 20,
    vegetationBudget: 60000,
    cityVertexBudget: 1_500_000,
    pixelRatioCap: 1.75,
    waterDetail: 2,
  },
  ultra: {
    terrainSegments: 80,
    maxQuadtreeDepth: 8,
    shadowSteps: 28,
    vegetationBudget: 110000,
    cityVertexBudget: 2_600_000,
    pixelRatioCap: 2,
    waterDetail: 2,
  },
};

export type QualityName = keyof typeof QUALITY_PRESETS;

/** Converts a macro grid coordinate to world kilometres (cell centre). */
export function macroToWorldX(gx: number): number {
  return (gx / (MACRO - 1)) * WORLD_KM - HALF_KM;
}
export function macroToWorldZ(gy: number): number {
  return (gy / (MACRO - 1)) * WORLD_KM - HALF_KM;
}
export function worldToMacroX(x: number): number {
  return ((x + HALF_KM) / WORLD_KM) * (MACRO - 1);
}
export function worldToMacroZ(z: number): number {
  return ((z + HALF_KM) / WORLD_KM) * (MACRO - 1);
}
