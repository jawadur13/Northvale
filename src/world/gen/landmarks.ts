/**
 * Landmarks: everything on the map that is not a settlement and not a landform.
 *
 * Each kind declares a scoring function over the terrain instead of a spawn
 * probability. A mine scores on ore-bearing uplift, a lighthouse on headlands
 * beside shipping water, a caravanserai on a desert road a day's travel from the
 * last one, a monastery on remoteness. Candidates are then thinned by a minimum
 * separation appropriate to the kind, which is what keeps a thousand landmarks
 * from clumping while still letting them cluster where the reason to build is
 * strongest.
 */

import { MACRO, MACRO_CELL_KM, SEA_LEVEL, macroToWorldX, macroToWorldZ } from '../../core/config';
import { Field } from '../../util/grid';
import { clamp01, lerp } from '../../util/math';
import { Rng, rngFor } from '../../util/rng';
import type { FeatureClass, FeatureKind } from '../types';
import { BIOME_BY_ID, Biome } from './biomes';
import type { ClimateResult } from './climate';
import type { HydrologyResult } from './hydrology';
import type { LandformSet } from './landforms';
import type { RoadResult } from './roads';
import type { Settlement } from './settlements';

export interface LandmarkSite {
  cell: number;
  x: number;
  z: number;
  kind: FeatureKind;
  cls: FeatureClass;
  elevationKm: number;
  region: number;
  biome: number;
  importance: number;
  labelTier: number;
  score: number;
  /** Extra numbers the description writer can use. */
  meta?: Record<string, number>;
}

/** Everything a scoring function is allowed to look at. */
export interface PlacementContext {
  height: Field;
  slope: Field;
  orogeny: Field;
  climate: ClimateResult;
  hydro: HydrologyResult;
  landforms: LandformSet;
  ownership: Int32Array;
  /** 0..1 road proximity. */
  roadNear: Field;
  /** 0..1 proximity to any settlement, scaled by size. */
  townNear: Field;
  /** 0..1 proximity to a political border. */
  borderNear: Field;
  /** 0..1 developed / cultivated ground. */
  developed: Field;
  /** 0..1 remoteness: the inverse of townNear, smoothed wide. */
  remote: Field;
  rng: Rng;
}

interface LandmarkSpec {
  kind: FeatureKind;
  cls: FeatureClass;
  count: number;
  minSepKm: number;
  importance: number;
  labelTier: number;
  /** Return 0 to reject the cell, otherwise a positive desirability. */
  score: (c: PlacementContext, i: number, x: number, y: number) => number;
}

/** Rasterises polylines into a proximity field. */
function proximityFromPolylines(paths: Array<Float32Array>, blurRadius: number): Field {
  const f = new Field(MACRO);
  for (const pts of paths) {
    for (let i = 0; i < pts.length; i += 2) {
      const gx = Math.round(((pts[i] + 2048) / 4096) * (MACRO - 1));
      const gy = Math.round(((pts[i + 1] + 2048) / 4096) * (MACRO - 1));
      if (gx < 0 || gy < 0 || gx >= MACRO || gy >= MACRO) continue;
      f.data[gy * MACRO + gx] = 1;
    }
  }
  f.blur(blurRadius, 2);
  for (let i = 0; i < f.data.length; i++) f.data[i] = clamp01(f.data[i] * 4);
  return f;
}

function buildContext(
  height: Field,
  slope: Field,
  orogeny: Field,
  climate: ClimateResult,
  hydro: HydrologyResult,
  landforms: LandformSet,
  ownership: Int32Array,
  settlements: Settlement[],
  roads: RoadResult,
  developed: Field,
  seed: number,
): PlacementContext {
  const roadNear = proximityFromPolylines(
    roads.roads.map((r) => r.pts),
    2,
  );

  const townNear = new Field(MACRO);
  for (const s of settlements) {
    const w = clamp01(Math.log10(Math.max(10, s.population)) / 5.6);
    const cur = townNear.data[s.cell];
    if (w > cur) townNear.data[s.cell] = w;
  }
  townNear.blur(3, 2);
  for (let i = 0; i < townNear.data.length; i++) townNear.data[i] = clamp01(townNear.data[i] * 6);

  const borderNear = new Field(MACRO);
  for (let y = 1; y < MACRO - 1; y++) {
    for (let x = 1; x < MACRO - 1; x++) {
      const i = y * MACRO + x;
      const a = ownership[i];
      if (a < 0) continue;
      if (
        ownership[i + 1] !== a ||
        ownership[i - 1] !== a ||
        ownership[i + MACRO] !== a ||
        ownership[i - MACRO] !== a
      ) {
        borderNear.data[i] = 1;
      }
    }
  }
  borderNear.blur(3, 2);
  for (let i = 0; i < borderNear.data.length; i++) borderNear.data[i] = clamp01(borderNear.data[i] * 5);

  const remote = new Field(MACRO);
  for (let i = 0; i < remote.data.length; i++) {
    remote.data[i] = height.data[i] > SEA_LEVEL ? 1 - clamp01(townNear.data[i] * 1.4 + roadNear.data[i] * 0.7) : 0;
  }

  return {
    height,
    slope,
    orogeny,
    climate,
    hydro,
    landforms,
    ownership,
    roadNear,
    townNear,
    borderNear,
    developed,
    remote,
    rng: rngFor(seed, 'landmarks'),
  };
}

/** Convenience: is this cell dry land with a sane gradient? */
function buildable(c: PlacementContext, i: number, maxSlope = 0.55): boolean {
  return c.height.data[i] > SEA_LEVEL && c.slope.data[i] < maxSlope;
}

function biomeGroup(c: PlacementContext, i: number): string {
  return BIOME_BY_ID[c.climate.biome[i]]?.group ?? 'water';
}

const SPECS: LandmarkSpec[] = [
  // --- Fortification ---
  {
    kind: 'castle',
    cls: 'structure',
    count: 78,
    minSepKm: 62,
    importance: 0.5,
    labelTier: 2,
    score: (c, i) => {
      if (!buildable(c, i, 0.5)) return 0;
      const rise = clamp01(c.landforms.relief.data[i] / 0.7);
      const near = c.townNear.data[i];
      const border = c.borderNear.data[i];
      if (near < 0.06 && border < 0.1) return 0;
      return rise * 1.4 + near * 0.9 + border * 1.5 + c.roadNear.data[i] * 0.6;
    },
  },
  {
    kind: 'fortress',
    cls: 'structure',
    count: 46,
    minSepKm: 95,
    importance: 0.56,
    labelTier: 2,
    score: (c, i) => {
      if (!buildable(c, i, 0.6)) return 0;
      const h = c.height.data[i];
      const strategic = c.borderNear.data[i] * 1.8 + clamp01(c.landforms.waterFraction.data[i] / 0.5) * 0.8;
      const high = clamp01((h - 0.4) / 2.2);
      if (strategic < 0.35) return 0;
      return strategic + high * 1.2 + c.roadNear.data[i] * 0.9;
    },
  },
  {
    kind: 'watchtower',
    cls: 'structure',
    count: 130,
    minSepKm: 34,
    importance: 0.24,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.62)) return 0;
      const vantage = clamp01(c.landforms.relief.data[i] / 0.55);
      const watch = Math.max(c.roadNear.data[i], c.landforms.waterFraction.data[i] * 0.8, c.borderNear.data[i]);
      if (watch < 0.12) return 0;
      return vantage * 1.3 + watch * 1.1;
    },
  },
  {
    kind: 'tower',
    cls: 'structure',
    count: 42,
    minSepKm: 72,
    importance: 0.28,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.5)) return 0;
      // Isolated towers: someone built this a long way from anywhere.
      return c.remote.data[i] * 1.6 + clamp01(c.landforms.relief.data[i] / 0.5) * 0.5;
    },
  },
  {
    kind: 'bridge',
    cls: 'structure',
    count: 0, // supplied directly from the road network
    minSepKm: 20,
    importance: 0.2,
    labelTier: 3,
    score: () => 0,
  },

  // --- Religious and scholarly ---
  {
    kind: 'temple',
    cls: 'structure',
    count: 62,
    minSepKm: 66,
    importance: 0.38,
    labelTier: 2,
    score: (c, i) => {
      if (!buildable(c, i, 0.5)) return 0;
      const h = clamp01(c.height.data[i] / 3);
      return c.townNear.data[i] * 1.2 + h * 1.1 + c.rng.next() * 0.4;
    },
  },
  {
    kind: 'monastery',
    cls: 'structure',
    count: 54,
    minSepKm: 78,
    importance: 0.34,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.58)) return 0;
      const remote = c.remote.data[i];
      if (remote < 0.4) return 0;
      const high = clamp01((c.height.data[i] - 0.6) / 2.6);
      const forest = biomeGroup(c, i) === 'forest' ? 0.5 : 0;
      return remote * 1.5 + high * 1.3 + forest;
    },
  },
  {
    kind: 'shrine',
    cls: 'structure',
    count: 96,
    minSepKm: 30,
    importance: 0.16,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.55)) return 0;
      return c.roadNear.data[i] * 1.4 + c.townNear.data[i] * 0.5;
    },
  },
  {
    kind: 'observatory',
    cls: 'structure',
    count: 12,
    minSepKm: 240,
    importance: 0.42,
    labelTier: 2,
    score: (c, i) => {
      if (!buildable(c, i, 0.4)) return 0;
      const high = clamp01((c.height.data[i] - 1.6) / 3);
      const dry = 1 - c.climate.moisture.data[i];
      if (high < 0.2) return 0;
      return high * 2 + dry * 1.2 + c.remote.data[i];
    },
  },

  // --- Industry ---
  {
    kind: 'mine',
    cls: 'structure',
    count: 118,
    minSepKm: 34,
    importance: 0.28,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.72)) return 0;
      const ore = clamp01(c.orogeny.data[i] * 1.4 + c.landforms.relief.data[i] * 0.6);
      if (ore < 0.28) return 0;
      // Mines need a way to get the ore out.
      return ore * 1.8 + c.roadNear.data[i] * 0.8 + c.townNear.data[i] * 0.4;
    },
  },
  {
    kind: 'quarry',
    cls: 'structure',
    count: 66,
    minSepKm: 40,
    importance: 0.18,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.75)) return 0;
      const steep = clamp01((c.slope.data[i] - 0.25) / 0.4);
      if (steep <= 0) return 0;
      return steep * 1.4 + c.townNear.data[i] * 1.3;
    },
  },
  {
    kind: 'farm',
    cls: 'structure',
    count: 190,
    minSepKm: 17,
    importance: 0.1,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.22)) return 0;
      const def = BIOME_BY_ID[c.climate.biome[i]];
      if (!def || def.fertility < 0.4) return 0;
      return def.fertility * 1.6 + c.developed.data[i] * 1.4;
    },
  },
  {
    kind: 'ranch',
    cls: 'structure',
    count: 62,
    minSepKm: 30,
    importance: 0.12,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.3)) return 0;
      const b = c.climate.biome[i];
      if (b !== Biome.Steppe && b !== Biome.Savanna && b !== Biome.Grassland && b !== Biome.Shrubland) return 0;
      return 1 + c.developed.data[i] * 0.8 + c.remote.data[i] * 0.5;
    },
  },
  {
    kind: 'vineyard',
    cls: 'structure',
    count: 44,
    minSepKm: 26,
    importance: 0.12,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.34)) return 0;
      const t = c.climate.temperature.data[i];
      const m = c.climate.moisture.data[i];
      if (t < 12 || t > 24 || m < 0.2 || m > 0.62) return 0;
      // South-facing slopes, which in this hemisphere convention means +Z downhill.
      const aspect = c.height.at((i % MACRO), ((i / MACRO) | 0) + 1) < c.height.data[i] ? 0.6 : 0;
      return 1 + aspect + c.developed.data[i] * 0.9;
    },
  },
  {
    kind: 'watermill',
    cls: 'structure',
    count: 92,
    minSepKm: 20,
    importance: 0.1,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.4)) return 0;
      let flow = 0;
      const x = i % MACRO;
      const y = (i / MACRO) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = (y + dy) * MACRO + (x + dx);
          if (ni >= 0 && ni < MACRO * MACRO && c.hydro.isRiver[ni]) flow = Math.max(flow, c.hydro.flow.data[ni]);
        }
      }
      if (flow < 3000) return 0;
      // A mill wants fall as well as flow.
      return clamp01(flow / 90_000) * 1.3 + clamp01(c.slope.data[i] / 0.25) * 0.8 + c.developed.data[i];
    },
  },
  {
    kind: 'windmill',
    cls: 'structure',
    count: 74,
    minSepKm: 22,
    importance: 0.1,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.26)) return 0;
      const exposed = clamp01(c.landforms.relief.data[i] / 0.35);
      const g = biomeGroup(c, i);
      if (g !== 'grass' && g !== 'arid') return 0;
      return exposed * 1.2 + c.developed.data[i] * 1.3;
    },
  },
  {
    kind: 'sawmill',
    cls: 'structure',
    count: 56,
    minSepKm: 28,
    importance: 0.1,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.4)) return 0;
      if (biomeGroup(c, i) !== 'forest') return 0;
      return 1 + c.hydro.waterTable.data[i] * 1.2 + c.roadNear.data[i] * 0.8;
    },
  },
  {
    kind: 'saltworks',
    cls: 'structure',
    count: 22,
    minSepKm: 60,
    importance: 0.16,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.12)) return 0;
      const b = c.climate.biome[i];
      const coastal = c.climate.coastDistance.data[i] < MACRO_CELL_KM * 2;
      if (b !== Biome.Salt && !(coastal && c.climate.moisture.data[i] < 0.3)) return 0;
      return 1.4 + c.townNear.data[i];
    },
  },

  // --- Maritime ---
  {
    kind: 'lighthouse',
    cls: 'structure',
    count: 68,
    minSepKm: 52,
    importance: 0.26,
    labelTier: 3,
    score: (c, i) => {
      if (c.height.data[i] <= SEA_LEVEL) return 0;
      if (c.climate.coastDistance.data[i] > MACRO_CELL_KM * 1.6) return 0;
      const exposure = clamp01(c.landforms.waterFraction.data[i] / 0.7);
      return exposure * 2 + c.townNear.data[i] * 0.7 + clamp01(c.height.data[i] / 0.4) * 0.5;
    },
  },
  {
    kind: 'port',
    cls: 'structure',
    count: 44,
    minSepKm: 58,
    importance: 0.34,
    labelTier: 3,
    score: (c, i) => {
      if (c.height.data[i] <= SEA_LEVEL) return 0;
      if (c.climate.coastDistance.data[i] > MACRO_CELL_KM * 1.4) return 0;
      const wf = c.landforms.waterFraction.data[i];
      const shelter = 1 - Math.abs(wf - 0.48) / 0.48;
      if (shelter <= 0) return 0;
      return shelter * 1.8 + c.townNear.data[i] * 1.4;
    },
  },
  {
    kind: 'shipwreck',
    cls: 'landmark',
    count: 52,
    minSepKm: 44,
    importance: 0.14,
    labelTier: 4,
    score: (c, i) => {
      const h = c.height.data[i];
      // Shallow water only, and near something to run aground on.
      if (h > SEA_LEVEL || h < -0.09) return 0;
      const land = 1 - c.landforms.waterFraction.data[i];
      if (land < 0.16) return 0;
      return land * 1.6 + c.rng.next() * 0.6;
    },
  },
  {
    kind: 'reef',
    cls: 'water',
    count: 40,
    minSepKm: 62,
    importance: 0.16,
    labelTier: 3,
    score: (c, i) => {
      const h = c.height.data[i];
      if (h > SEA_LEVEL || h < -0.06) return 0;
      if (c.climate.temperature.data[i] < 17) return 0;
      return 1 + (1 - c.landforms.waterFraction.data[i]) * 0.8;
    },
  },

  // --- Wayside ---
  {
    kind: 'outpost',
    cls: 'structure',
    count: 84,
    minSepKm: 44,
    importance: 0.16,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.5)) return 0;
      return c.remote.data[i] * 1.7 + c.borderNear.data[i] * 0.9;
    },
  },
  {
    kind: 'inn',
    cls: 'structure',
    count: 78,
    minSepKm: 26,
    importance: 0.12,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.4)) return 0;
      const road = c.roadNear.data[i];
      if (road < 0.3) return 0;
      // Halfway between towns is exactly where an inn pays.
      return road * 1.6 + (1 - Math.abs(c.townNear.data[i] - 0.3) / 0.7);
    },
  },
  {
    kind: 'cabin',
    cls: 'structure',
    count: 96,
    minSepKm: 24,
    importance: 0.08,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.56)) return 0;
      const g = biomeGroup(c, i);
      if (g !== 'forest' && g !== 'alpine' && g !== 'ice') return 0;
      return c.remote.data[i] * 1.8;
    },
  },
  {
    kind: 'camp',
    cls: 'structure',
    count: 62,
    minSepKm: 34,
    importance: 0.08,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.4)) return 0;
      const g = biomeGroup(c, i);
      if (g !== 'ice' && g !== 'arid' && g !== 'grass') return 0;
      return c.remote.data[i] * 1.4 + c.roadNear.data[i] * 0.5;
    },
  },
  {
    kind: 'caravanserai',
    cls: 'structure',
    count: 34,
    minSepKm: 68,
    importance: 0.24,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.3)) return 0;
      if (biomeGroup(c, i) !== 'arid') return 0;
      const road = c.roadNear.data[i];
      if (road < 0.22) return 0;
      return road * 1.8 + c.hydro.waterTable.data[i] * 1.6;
    },
  },
  {
    kind: 'oasis',
    cls: 'landmark',
    count: 42,
    minSepKm: 54,
    importance: 0.3,
    labelTier: 3,
    score: (c, i) => {
      if (c.height.data[i] <= SEA_LEVEL) return 0;
      if (c.climate.moisture.data[i] > 0.18) return 0;
      if (c.climate.temperature.data[i] < 12) return 0;
      const water = Math.max(c.hydro.waterTable.data[i], c.hydro.isRiver[i] ? 1 : 0);
      if (water < 0.3) return 0;
      return water * 2.2;
    },
  },

  // --- Ruin and monument ---
  {
    kind: 'ruin',
    cls: 'landmark',
    count: 148,
    minSepKm: 32,
    importance: 0.24,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.6)) return 0;
      // Ruins favour ground that was once good but is now empty: old fertility,
      // low present-day population.
      const def = BIOME_BY_ID[c.climate.biome[i]];
      const wasGood = def ? def.fertility * 0.8 + (def.group === 'forest' ? 0.5 : 0) + (def.group === 'arid' ? 0.55 : 0) : 0;
      return wasGood + c.remote.data[i] * 1.5 + c.rng.next() * 0.5;
    },
  },
  {
    kind: 'monument',
    cls: 'landmark',
    count: 44,
    minSepKm: 62,
    importance: 0.26,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.3)) return 0;
      return c.roadNear.data[i] * 1.4 + c.townNear.data[i] * 0.8 + c.borderNear.data[i] * 0.8;
    },
  },
  {
    kind: 'standing_stones',
    cls: 'landmark',
    count: 58,
    minSepKm: 46,
    importance: 0.22,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.3)) return 0;
      const g = biomeGroup(c, i);
      if (g !== 'grass' && g !== 'ice' && g !== 'alpine') return 0;
      return c.remote.data[i] * 1.5 + clamp01(c.landforms.relief.data[i] / 0.3) * 0.7;
    },
  },
  {
    kind: 'tomb',
    cls: 'landmark',
    count: 52,
    minSepKm: 44,
    importance: 0.2,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.5)) return 0;
      return clamp01(c.landforms.relief.data[i] / 0.4) * 1.2 + c.remote.data[i] + c.rng.next() * 0.4;
    },
  },
  {
    kind: 'battlefield',
    cls: 'landmark',
    count: 34,
    minSepKm: 78,
    importance: 0.22,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.24)) return 0;
      // Armies meet on open ground beside a road, near a contested border.
      return c.borderNear.data[i] * 2 + c.roadNear.data[i] * 1.2 - c.slope.data[i] * 2;
    },
  },

  // --- Natural point features ---
  {
    kind: 'cave',
    cls: 'landmark',
    count: 88,
    minSepKm: 30,
    importance: 0.18,
    labelTier: 4,
    score: (c, i) => {
      if (c.height.data[i] <= SEA_LEVEL) return 0;
      const steep = clamp01((c.slope.data[i] - 0.3) / 0.5);
      if (steep <= 0) return 0;
      return steep * 1.6 + clamp01(c.landforms.relief.data[i] / 0.6);
    },
  },
  {
    kind: 'geyser',
    cls: 'landmark',
    count: 20,
    minSepKm: 46,
    importance: 0.24,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.4)) return 0;
      if (c.orogeny.data[i] < 0.3) return 0;
      const volcanic = c.climate.biome[i] === Biome.Volcanic ? 1 : 0;
      return c.orogeny.data[i] * 1.4 + volcanic * 1.6 + c.hydro.waterTable.data[i] * 0.8;
    },
  },
  {
    kind: 'crater',
    cls: 'landmark',
    count: 16,
    minSepKm: 140,
    importance: 0.3,
    labelTier: 2,
    score: (c, i) => {
      if (!buildable(c, i, 0.45)) return 0;
      return c.remote.data[i] * 1.4 + c.orogeny.data[i] * 0.9 + c.rng.next() * 0.7;
    },
  },
  {
    kind: 'arch',
    cls: 'landmark',
    count: 26,
    minSepKm: 60,
    importance: 0.24,
    labelTier: 3,
    score: (c, i) => {
      if (!buildable(c, i, 0.7)) return 0;
      const g = biomeGroup(c, i);
      if (g !== 'arid') return 0;
      return clamp01(c.slope.data[i] / 0.5) * 1.4 + clamp01(c.landforms.relief.data[i] / 0.5);
    },
  },
  {
    kind: 'sinkhole',
    cls: 'landmark',
    count: 22,
    minSepKm: 52,
    importance: 0.2,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.16)) return 0;
      const h = c.height.data[i];
      if (h < 0.5) return 0;
      return clamp01(c.climate.moisture.data[i] * 1.4) + c.remote.data[i] * 0.8;
    },
  },
  {
    kind: 'spring',
    cls: 'landmark',
    count: 64,
    minSepKm: 30,
    importance: 0.12,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.6)) return 0;
      const h = c.height.data[i];
      if (h < 0.25) return 0;
      return clamp01(c.slope.data[i] / 0.4) + c.climate.moisture.data[i] * 1.2;
    },
  },
  {
    kind: 'grove',
    cls: 'vegetation',
    count: 48,
    minSepKm: 40,
    importance: 0.14,
    labelTier: 4,
    score: (c, i) => {
      if (!buildable(c, i, 0.4)) return 0;
      const g = biomeGroup(c, i);
      if (g === 'forest') return 0.4 + c.remote.data[i];
      // A stand of trees somewhere it has no business being is more interesting.
      if (g === 'grass' || g === 'arid') return c.hydro.waterTable.data[i] * 2;
      return 0;
    },
  },
];

/** Spatial thinning against a shared occupancy map so kinds do not overlap either. */
function thinAndTake(
  candidates: LandmarkSite[],
  minSepKm: number,
  limit: number,
  global: Map<number, number[]>,
  bucketKm: number,
): LandmarkSite[] {
  const kept: LandmarkSite[] = [];
  const min2 = minSepKm * minSepKm;
  const reach = Math.max(1, Math.ceil(minSepKm / bucketKm));
  const localBuckets = new Map<number, number[]>();

  for (const cand of candidates) {
    if (kept.length >= limit) break;
    const bx = Math.floor(cand.x / bucketKm);
    const bz = Math.floor(cand.z / bucketKm);
    let clash = false;
    // Same-kind separation.
    for (let dz = -reach; dz <= reach && !clash; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const arr = localBuckets.get((bx + dx) * 100000 + (bz + dz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k += 2) {
          const ddx = arr[k] - cand.x;
          const ddz = arr[k + 1] - cand.z;
          if (ddx * ddx + ddz * ddz < min2) {
            clash = true;
            break;
          }
        }
        if (clash) break;
      }
    }
    if (clash) continue;
    // A small global exclusion, so two different landmarks never share a spot.
    const gkey = Math.floor(cand.x / 3) * 100000 + Math.floor(cand.z / 3);
    if (global.has(gkey)) continue;
    global.set(gkey, [cand.x, cand.z]);

    kept.push(cand);
    const key = bx * 100000 + bz;
    const arr = localBuckets.get(key);
    if (arr) arr.push(cand.x, cand.z);
    else localBuckets.set(key, [cand.x, cand.z]);
  }
  return kept;
}

export function generateLandmarks(
  height: Field,
  slope: Field,
  orogeny: Field,
  climate: ClimateResult,
  hydro: HydrologyResult,
  landforms: LandformSet,
  ownership: Int32Array,
  settlements: Settlement[],
  roads: RoadResult,
  developed: Field,
  seed: number,
): LandmarkSite[] {
  const ctx = buildContext(
    height,
    slope,
    orogeny,
    climate,
    hydro,
    landforms,
    ownership,
    settlements,
    roads,
    developed,
    seed,
  );

  const global = new Map<number, number[]>();
  // Reserve the settlements themselves so no landmark lands on a town centre.
  for (const s of settlements) {
    global.set(Math.floor(s.x / 3) * 100000 + Math.floor(s.z / 3), [s.x, s.z]);
  }

  const out: LandmarkSite[] = [];

  for (const spec of SPECS) {
    if (spec.count <= 0) continue;
    const candidates: LandmarkSite[] = [];
    // Stride the scan: at 4 km per cell, sampling every second cell still gives
    // far more candidates than any kind needs, and halves the work.
    const stride = spec.count > 100 ? 1 : 2;
    for (let y = 2; y < MACRO - 2; y += stride) {
      for (let x = 2; x < MACRO - 2; x += stride) {
        const i = y * MACRO + x;
        const s = spec.score(ctx, i, x, y);
        if (s <= 0) continue;
        candidates.push({
          cell: i,
          x: macroToWorldX(x),
          z: macroToWorldZ(y),
          kind: spec.kind,
          cls: spec.cls,
          elevationKm: height.data[i],
          region: ownership[i],
          biome: climate.biome[i],
          importance: spec.importance,
          labelTier: spec.labelTier,
          score: s,
        });
      }
    }
    // Jitter the ordering slightly so the same terrain does not always win.
    for (const c of candidates) c.score *= 0.86 + ctx.rng.next() * 0.28;
    candidates.sort((a, b) => b.score - a.score);
    const kept = thinAndTake(candidates, spec.minSepKm, spec.count, global, Math.max(8, spec.minSepKm / 2));
    for (const k of kept) {
      // Importance rises a little with how strongly the site scored.
      k.importance = clamp01(k.importance * lerp(0.85, 1.3, clamp01(k.score / 4)));
      out.push(k);
    }
  }

  // --- Bridges, straight from the road network ---------------------------
  const bridgeGlobal = new Map<number, number[]>();
  const bridgeCandidates: LandmarkSite[] = roads.bridges
    .map((b) => {
      const gx = Math.round(((b.x + 2048) / 4096) * (MACRO - 1));
      const gy = Math.round(((b.z + 2048) / 4096) * (MACRO - 1));
      const i = gy * MACRO + gx;
      return {
        cell: i,
        x: b.x,
        z: b.z,
        kind: 'bridge' as FeatureKind,
        cls: 'structure' as FeatureClass,
        elevationKm: height.data[i],
        region: ownership[i],
        biome: climate.biome[i],
        importance: clamp01(0.18 + Math.log10(Math.max(10, b.flow)) / 14),
        labelTier: 3,
        score: b.flow,
        meta: { flow: b.flow, spanKm: b.spanKm },
      };
    })
    .sort((a, b) => b.score - a.score);
  for (const b of thinAndTake(bridgeCandidates, 22, 110, bridgeGlobal, 12)) out.push(b);

  // --- Wayside inns at true crossroads ----------------------------------
  const junctionCandidates: LandmarkSite[] = roads.junctions
    .map((j) => {
      const gx = Math.round(((j.x + 2048) / 4096) * (MACRO - 1));
      const gy = Math.round(((j.z + 2048) / 4096) * (MACRO - 1));
      const i = gy * MACRO + gx;
      return {
        cell: i,
        x: j.x,
        z: j.z,
        kind: 'ferry' as FeatureKind,
        cls: 'structure' as FeatureClass,
        elevationKm: height.data[i],
        region: ownership[i],
        biome: climate.biome[i],
        importance: 0.14,
        labelTier: 4,
        score: j.degree + ctx.rng.next(),
      };
    })
    .filter((j) => height.data[j.cell] > SEA_LEVEL && hydro.isRiver[j.cell] === 1)
    .sort((a, b) => b.score - a.score);
  for (const j of thinAndTake(junctionCandidates, 90, 18, global, 45)) out.push(j);

  void Rng;
  return out;
}
