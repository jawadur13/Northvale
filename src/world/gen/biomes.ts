/**
 * Biome classification.
 *
 * Classification is Whittaker-style: temperature (from latitude and elevation
 * lapse rate) against moisture (from the orographic rainfall pass). The discrete
 * ids exist for naming, legend and vegetation selection - the terrain shader
 * blends from the *continuous* climate values instead, so there are no visible
 * biome polygon edges anywhere on the map.
 */

export enum Biome {
  Ocean = 0,
  DeepOcean = 1,
  Shelf = 2,
  Lake = 3,
  River = 4,
  Beach = 5,
  RockyShore = 6,
  IceSheet = 7,
  Glacier = 8,
  Tundra = 9,
  SnowForest = 10,
  BorealForest = 11,
  ColdDesert = 12,
  Steppe = 13,
  Grassland = 14,
  Farmland = 15,
  Shrubland = 16,
  TemperateForest = 17,
  AncientForest = 18,
  PineForest = 19,
  Rainforest = 20,
  TropicalForest = 21,
  Savanna = 22,
  Desert = 23,
  DuneSea = 24,
  RockyDesert = 25,
  Badlands = 26,
  Marsh = 27,
  Swamp = 28,
  Mangrove = 29,
  AlpineMeadow = 30,
  BareRock = 31,
  Volcanic = 32,
  Salt = 33,
}

export const BIOME_COUNT = 34;

export type PlantKind =
  | 'none'
  | 'pine'
  | 'broadleaf'
  | 'palm'
  | 'cactus'
  | 'shrub'
  | 'snowpine'
  | 'reed'
  | 'baobab'
  | 'birch'
  | 'deadwood'
  | 'boulder';

/**
 * One species in a biome's mix.
 *
 * `heightM` is the real height range of a mature specimen, in metres, and is used
 * as such: plants are drawn at true scale beside buildings drawn at true scale.
 * Getting cover by making the trees bigger is the one thing that cannot be done
 * here, which is why cover is a matter of *how many*, not how large.
 */
export interface Species {
  plant: PlantKind;
  /** Relative frequency within the mix. */
  weight: number;
  /** Mature height range in metres. */
  heightM: [number, number];
  /** Base foliage colour, packed RGB. Per-instance jitter is applied on top. */
  tint: number;
}

export interface BiomeDef {
  id: Biome;
  name: string;
  /** Legend grouping. */
  group: 'water' | 'ice' | 'forest' | 'grass' | 'arid' | 'wetland' | 'alpine';
  /** Reference surface colour, packed RGB. Mirrored by the terrain shader. */
  color: number;
  /** 0..1 vegetation cover, drives instanced scatter density. */
  cover: number;
  /** Which instanced plant prototype dominates. Used by the legend. */
  plant: PlantKind;
  /**
   * What actually grows here, in proportion.
   *
   * A biome with an empty mix grows nothing — bare rock, ice, open water, moving
   * sand. Everything else gets at least two entries, because a stand of one
   * silhouette repeated reads as wallpaper from any height.
   */
  mix: Species[];
  /** Suitability for farming, 0..1. Feeds settlement scoring. */
  fertility: number;
  /** Difficulty of crossing, 0..1. Feeds road cost. */
  traversal: number;
  description: string;
}

/** Shorthand for one species: prototype, weight, height range in metres, tint. */
function sp(plant: PlantKind, weight: number, lo: number, hi: number, tint: number): Species {
  return { plant, weight, heightM: [lo, hi], tint };
}

function def(
  id: Biome,
  name: string,
  group: BiomeDef['group'],
  color: number,
  cover: number,
  plant: PlantKind,
  mix: Species[],
  fertility: number,
  traversal: number,
  description: string,
): BiomeDef {
  return { id, name, group, color, cover, plant, mix, fertility, traversal, description };
}

export const BIOMES: BiomeDef[] = [
  def(Biome.Ocean, 'Open Ocean', 'water', 0x1b3a56, 0, 'none',
    [], 0, 1,
    'Deep blue water beyond the continental shelf.'),
  def(Biome.DeepOcean, 'Abyssal Ocean', 'water', 0x102539, 0, 'none',
    [], 0, 1,
    'The unlit deep, kilometres below the surface.'),
  def(Biome.Shelf, 'Coastal Shelf', 'water', 0x2f6a86, 0, 'none',
    [], 0, 0.9,
    'Shallow, sunlit water over the drowned edge of the land.'),
  def(Biome.Lake, 'Lake', 'water', 0x2b5f7d, 0, 'none',
    [], 0, 0.95,
    'Standing fresh water held in a basin.'),
  def(Biome.River, 'River', 'water', 0x35708c, 0, 'reed',
    [sp('reed', 6, 1.5, 3, 0x6d7a3c), sp('broadleaf', 2, 9, 17, 0x3f5f30)], 0.9, 0.7,
    'Flowing fresh water cutting its own valley.'),
  def(Biome.Beach, 'Beach', 'arid', 0xd6c6a0, 0.05, 'shrub',
    [sp('shrub', 5, 0.8, 2, 0x6f7546), sp('palm', 1, 8, 15, 0x44603a)], 0.15, 0.1,
    'Sand and shingle where the sea meets the land.'),
  def(Biome.RockyShore, 'Rocky Shore', 'arid', 0x8d8578, 0.08, 'shrub',
    [sp('shrub', 4, 0.6, 1.6, 0x666c45), sp('boulder', 3, 0.8, 2.4, 0x7d766a)], 0.1, 0.35,
    'Wave-cut stone and tide pools.'),
  def(Biome.IceSheet, 'Ice Sheet', 'ice', 0xe6edf4, 0, 'none',
    [], 0, 0.8,
    'Permanent ice, hundreds of metres thick.'),
  def(Biome.Glacier, 'Glacier', 'ice', 0xd0e0ea, 0, 'none',
    [], 0, 0.9,
    'A river of ice grinding slowly downhill.'),
  def(Biome.Tundra, 'Tundra', 'ice', 0x8e9384, 0.18, 'shrub',
    [sp('shrub', 8, 0.4, 1.2, 0x5e6a48), sp('boulder', 3, 0.6, 1.8, 0x807a70), sp('deadwood', 1, 3, 6, 0x8a8175)], 0.12, 0.35,
    'Frozen ground, lichen and dwarf willow.'),
  def(Biome.SnowForest, 'Snow Forest', 'forest', 0x4e6157, 0.62, 'snowpine',
    [sp('snowpine', 7, 14, 26, 0x3d5348), sp('pine', 3, 12, 22, 0x2f4636), sp('deadwood', 1, 8, 15, 0x8d8478)], 0.22, 0.55,
    'Spruce and fir under a permanent snow load.'),
  def(Biome.BorealForest, 'Boreal Forest', 'forest', 0x3f5344, 0.78, 'pine',
    [sp('pine', 6, 15, 28, 0x2c4531), sp('birch', 3, 11, 20, 0x5f7440), sp('deadwood', 1, 9, 17, 0x8a8072)], 0.3, 0.6,
    'Endless conifer, peat and cold black water.'),
  def(Biome.ColdDesert, 'Cold Desert', 'arid', 0x9d9a8d, 0.05, 'shrub',
    [sp('shrub', 6, 0.4, 1.1, 0x6a6d4c), sp('boulder', 4, 0.7, 2.2, 0x86806f)], 0.05, 0.3,
    'Dry, wind-scoured ground too cold for trees.'),
  def(Biome.Steppe, 'Steppe', 'grass', 0xa39c69, 0.3, 'shrub',
    [sp('shrub', 9, 0.6, 1.6, 0x77794a), sp('broadleaf', 1, 7, 13, 0x4f6537)], 0.4, 0.15,
    'Dry grassland rolling to the horizon.'),
  def(Biome.Grassland, 'Grassland', 'grass', 0x86974f, 0.35, 'shrub',
    [sp('shrub', 7, 0.7, 1.8, 0x6f7c42), sp('broadleaf', 3, 10, 19, 0x44622f)], 0.72, 0.1,
    'Deep-rooted grass on good soil.'),
  def(Biome.Farmland, 'Farmland', 'grass', 0x93a055, 0.4, 'broadleaf',
    [sp('broadleaf', 5, 9, 16, 0x486a30), sp('shrub', 4, 0.8, 2, 0x6d7a43), sp('birch', 1, 8, 14, 0x627a44)], 1, 0.08,
    'Field systems, hedgerows and drove roads.'),
  def(Biome.Shrubland, 'Shrubland', 'grass', 0x8b8a55, 0.42, 'shrub',
    [sp('shrub', 8, 0.7, 2, 0x757646), sp('boulder', 2, 0.6, 1.6, 0x8a8372), sp('broadleaf', 1, 6, 11, 0x51602f)], 0.45, 0.25,
    'Aromatic scrub on thin, stony soil.'),
  def(Biome.TemperateForest, 'Temperate Forest', 'forest', 0x4a6b3d, 0.86, 'broadleaf',
    [sp('broadleaf', 6, 16, 30, 0x385a2a), sp('birch', 2, 13, 23, 0x5c7440), sp('pine', 2, 15, 27, 0x2f4a33), sp('deadwood', 1, 10, 18, 0x8b8274)], 0.6, 0.5,
    'Oak, beech and ash in a closed canopy.'),
  def(Biome.AncientForest, 'Ancient Forest', 'forest', 0x35502f, 0.95, 'broadleaf',
    [sp('broadleaf', 7, 24, 42, 0x2a4622), sp('pine', 2, 22, 38, 0x27402c), sp('deadwood', 2, 14, 26, 0x7f7669)], 0.5, 0.75,
    'Never cleared, never fully surveyed, and very dark.'),
  def(Biome.PineForest, 'Pine Forest', 'forest', 0x3c5741, 0.82, 'pine',
    [sp('pine', 8, 17, 30, 0x2f4a35), sp('birch', 1, 12, 21, 0x5d7241), sp('deadwood', 1, 10, 19, 0x8a8073)], 0.35, 0.55,
    'Straight trunks, needle floor, resin in the air.'),
  def(Biome.Rainforest, 'Rainforest', 'forest', 0x2c5330, 0.98, 'broadleaf',
    [sp('broadleaf', 6, 26, 45, 0x22461f), sp('palm', 3, 18, 32, 0x2c5426), sp('reed', 2, 2, 4, 0x4a6a2c)], 0.55, 0.9,
    'Rain almost every day and thirty metres of canopy.'),
  def(Biome.TropicalForest, 'Tropical Forest', 'forest', 0x3a6236, 0.9, 'palm',
    [sp('palm', 5, 15, 26, 0x336035), sp('broadleaf', 4, 18, 32, 0x2d5227), sp('reed', 1, 2, 4, 0x51702f)], 0.62, 0.7,
    'Warm broadleaf forest with a hard monsoon season.'),
  def(Biome.Savanna, 'Savanna', 'grass', 0xa39a5c, 0.28, 'baobab',
    [sp('shrub', 6, 0.8, 2.2, 0x7c7644), sp('baobab', 3, 9, 18, 0x5c6432), sp('deadwood', 1, 5, 9, 0x8d8471)], 0.45, 0.12,
    'Tall grass, scattered flat-topped trees, a long dry season.'),
  def(Biome.Desert, 'Desert', 'arid', 0xc9ab74, 0.03, 'cactus',
    [sp('cactus', 6, 1.5, 4, 0x53663a), sp('boulder', 4, 0.6, 1.8, 0x9a8b6c)], 0.03, 0.4,
    'Less than a hundred millimetres of rain in a year.'),
  def(Biome.DuneSea, 'Dune Sea', 'arid', 0xdcbc82, 0.01, 'none',
    [], 0.01, 0.85,
    'Moving sand in ranks a hundred metres high.'),
  def(Biome.RockyDesert, 'Rocky Desert', 'arid', 0xa8906c, 0.04, 'cactus',
    [sp('cactus', 4, 1.2, 3.2, 0x4f6238), sp('boulder', 6, 0.8, 2.6, 0x8f8168)], 0.04, 0.5,
    'Stone pavement swept clean of sand by the wind.'),
  def(Biome.Badlands, 'Badlands', 'arid', 0xa07a58, 0.06, 'shrub',
    [sp('shrub', 5, 0.5, 1.4, 0x6f6a44), sp('boulder', 5, 0.9, 3, 0x8d7357), sp('deadwood', 1, 4, 8, 0x8f8577)], 0.06, 0.7,
    'Soft rock cut into a maze by flash floods.'),
  def(Biome.Marsh, 'Marsh', 'wetland', 0x5c6b46, 0.5, 'reed',
    [sp('reed', 8, 1.6, 3.2, 0x62703a), sp('shrub', 2, 0.8, 2, 0x5f6c40)], 0.5, 0.8,
    'Reed beds and shifting channels, no firm ground anywhere.'),
  def(Biome.Swamp, 'Swamp', 'wetland', 0x445434, 0.8, 'broadleaf',
    [sp('broadleaf', 5, 14, 25, 0x33502a), sp('reed', 4, 1.8, 3.4, 0x5b6c36), sp('deadwood', 2, 8, 16, 0x7d7466)], 0.55, 0.9,
    'Standing water under a closed canopy.'),
  def(Biome.Mangrove, 'Mangrove', 'wetland', 0x415c3f, 0.85, 'broadleaf',
    [sp('broadleaf', 6, 8, 16, 0x36532f), sp('reed', 3, 1.6, 3, 0x566a34)], 0.4, 0.95,
    'Salt-tolerant forest walking out into the tide.'),
  def(Biome.AlpineMeadow, 'Alpine Meadow', 'alpine', 0x71804f, 0.3, 'shrub',
    [sp('shrub', 7, 0.4, 1.2, 0x64733f), sp('boulder', 3, 0.8, 2.4, 0x827b6f), sp('snowpine', 1, 6, 12, 0x3e5548)], 0.3, 0.5,
    'Short flowering turf above the treeline.'),
  def(Biome.BareRock, 'Bare Rock', 'alpine', 0x7c766e, 0.02, 'none',
    [sp('boulder', 10, 0.9, 3.4, 0x7d766e)], 0.02, 0.9,
    'Frost-shattered stone and scree.'),
  def(Biome.Volcanic, 'Volcanic Waste', 'alpine', 0x4a4340, 0.05, 'shrub',
    [sp('boulder', 7, 1, 3.6, 0x504944), sp('shrub', 3, 0.4, 1.2, 0x556040)], 0.25, 0.85,
    'Black ash and old lava, fertile once it weathers.'),
  def(Biome.Salt, 'Salt Flat', 'arid', 0xd9d6c8, 0.01, 'none',
    [], 0.02, 0.3,
    'A dry lake bed, blinding white at noon.'),
];

export const BIOME_BY_ID: BiomeDef[] = (() => {
  const out: BiomeDef[] = new Array(BIOME_COUNT);
  for (const b of BIOMES) out[b.id] = b;
  return out;
})();

export function biomeName(id: number): string {
  return BIOME_BY_ID[id]?.name ?? 'Unknown';
}

export function isWaterBiome(id: number): boolean {
  return id === Biome.Ocean || id === Biome.DeepOcean || id === Biome.Shelf || id === Biome.Lake;
}

/**
 * Classifies a land cell.
 *
 * @param tempC mean annual temperature in Celsius
 * @param moisture 0..1 from the rainfall pass
 * @param elevationKm height above sea level
 * @param slope terrain gradient, 0..1
 * @param waterTable 0..1 proximity to standing or flowing water
 * @param latitudeAbs absolute latitude in degrees
 */
export function classifyLand(
  tempC: number,
  moisture: number,
  elevationKm: number,
  slope: number,
  waterTable: number,
  latitudeAbs: number,
): Biome {
  // Permanent ice first - nothing else grows through it.
  if (tempC < -14) return elevationKm > 1.2 ? Biome.Glacier : Biome.IceSheet;
  if (tempC < -8 && elevationKm > 2.6) return Biome.Glacier;

  // Steep or very high ground holds no soil.
  if (elevationKm > 4.4 && tempC < 2) return Biome.BareRock;
  if (slope > 0.72 && elevationKm > 1.4) return Biome.BareRock;

  // Waterlogged ground overrides the climate envelope.
  if (waterTable > 0.78 && slope < 0.08 && elevationKm < 0.22) {
    if (tempC > 20) return Biome.Mangrove;
    if (moisture > 0.72) return Biome.Swamp;
    return Biome.Marsh;
  }

  if (tempC < -3) {
    return moisture > 0.45 ? Biome.SnowForest : Biome.Tundra;
  }

  if (tempC < 4) {
    if (moisture > 0.52) return Biome.BorealForest;
    if (moisture > 0.28) return Biome.Tundra;
    return Biome.ColdDesert;
  }

  // Above the treeline but not frozen.
  if (elevationKm > 3.1) {
    return moisture > 0.3 ? Biome.AlpineMeadow : Biome.BareRock;
  }

  if (tempC < 13) {
    if (moisture > 0.76) return elevationKm > 1.1 ? Biome.PineForest : Biome.AncientForest;
    if (moisture > 0.5) return Biome.TemperateForest;
    if (moisture > 0.34) return Biome.Grassland;
    if (moisture > 0.19) return Biome.Steppe;
    return Biome.ColdDesert;
  }

  if (tempC < 21) {
    if (moisture > 0.74) return Biome.TemperateForest;
    if (moisture > 0.5) return Biome.Farmland;
    if (moisture > 0.33) return Biome.Grassland;
    if (moisture > 0.2) return Biome.Shrubland;
    if (moisture > 0.11) return Biome.Steppe;
    return latitudeAbs < 38 ? Biome.Desert : Biome.RockyDesert;
  }

  // Hot.
  if (moisture > 0.8) return Biome.Rainforest;
  if (moisture > 0.6) return Biome.TropicalForest;
  if (moisture > 0.38) return Biome.Savanna;
  if (moisture > 0.22) return Biome.Shrubland;
  if (moisture > 0.1) return Biome.RockyDesert;
  return elevationKm > 0.9 ? Biome.RockyDesert : Biome.Desert;
}

/** Chooses the ocean biome for a submerged cell, by depth in km. */
export function classifyWater(depthKm: number): Biome {
  if (depthKm > 3.4) return Biome.DeepOcean;
  if (depthKm > 0.45) return Biome.Ocean;
  return Biome.Shelf;
}

/** Human-readable terrain character used in region descriptions. */
export function biomeCharacter(id: number): string {
  const d = BIOME_BY_ID[id];
  if (!d) return 'mixed';
  switch (d.group) {
    case 'ice':
      return 'subarctic';
    case 'forest':
      return 'forested';
    case 'grass':
      return 'open';
    case 'arid':
      return 'arid';
    case 'wetland':
      return 'waterlogged';
    case 'alpine':
      return 'alpine';
    default:
      return 'maritime';
  }
}
