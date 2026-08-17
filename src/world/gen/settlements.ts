/**
 * Where people live.
 *
 * Every settlement is placed by scoring the terrain rather than by scattering
 * points. The score is a sum of the reasons a real settlement exists - fresh
 * water, a crossing point, a sheltered anchorage, flat arable ground, a
 * defensible rise, ore in the hills, a gap through a range, a spring in the
 * desert - and the *dominant* term is recorded as the settlement's site reason,
 * which is then what its description talks about.
 *
 * Placement runs largest-first with a minimum separation per tier, so cities do
 * not stack on top of each other and villages fill the gaps between them.
 */

import {
  MACRO,
  MACRO_CELL_KM,
  SEA_LEVEL,
  macroToWorldX,
  macroToWorldZ,
} from '../../core/config';
import { Field } from '../../util/grid';
import { clamp, clamp01, lerp } from '../../util/math';
import { rngFor } from '../../util/rng';
import { BIOME_BY_ID, Biome } from './biomes';
import type { ClimateResult } from './climate';
import type { HydrologyResult } from './hydrology';
import type { LandformSet } from './landforms';

export type SiteReason =
  | 'harbour'
  | 'river'
  | 'confluence'
  | 'ford'
  | 'delta'
  | 'lakeshore'
  | 'farmland'
  | 'hilltop'
  | 'pass'
  | 'mining'
  | 'oasis'
  | 'crossroads'
  | 'island'
  | 'frontier'
  | 'timber'
  | 'coast';

export type SettlementTier = 'capital' | 'city' | 'town' | 'village' | 'hamlet';

export interface Settlement {
  cell: number;
  x: number;
  z: number;
  tier: SettlementTier;
  elevationKm: number;
  region: number;
  biome: number;
  population: number;
  reason: SiteReason;
  /** Full score breakdown, used to pick secondary facts. */
  scores: Partial<Record<SiteReason, number>>;
  /** Discharge of the adjacent river in km^2 of drainage, 0 if none. */
  riverFlow: number;
  /** True when the site is on the coast. */
  coastal: boolean;
  /** Walled settlements get ramparts in the 3D city builder. */
  walled: boolean;
  /** Deterministic per-settlement seed for the city layout. */
  seed: number;
}

export interface SettlementResult {
  settlements: Settlement[];
  /** 0..1 field marking cultivated and built-up ground, for the terrain shader. */
  developed: Field;
}

interface Scored {
  cell: number;
  score: number;
  reason: SiteReason;
  scores: Partial<Record<SiteReason, number>>;
  riverFlow: number;
  coastal: boolean;
}

const TIER_CONFIG: Record<SettlementTier, { separationKm: number; walledChance: number }> = {
  capital: { separationKm: 150, walledChance: 0.95 },
  city: { separationKm: 105, walledChance: 0.72 },
  town: { separationKm: 46, walledChance: 0.3 },
  village: { separationKm: 15.5, walledChance: 0.04 },
  hamlet: { separationKm: 9, walledChance: 0 },
};

/**
 * Scores every land cell as a settlement site and records why.
 */
function scoreSites(
  height: Field,
  slope: Field,
  climate: ClimateResult,
  hydro: HydrologyResult,
  landforms: LandformSet,
  orogeny: Field,
): Scored[] {
  const H = height.data;
  const flow = hydro.flow.data;
  const out: Scored[] = [];

  // Pass proximity: cells near a detected saddle can host a gate town.
  const passNear = new Field(MACRO);
  for (const s of landforms.saddles.slice(0, 900)) passNear.data[s.cell] = 1;
  passNear.blur(2, 1);

  // Ore potential: uplifted, high-relief ground.
  const ore = new Field(MACRO);
  for (let i = 0; i < MACRO * MACRO; i++) {
    ore.data[i] = clamp01(orogeny.data[i] * 1.3 + landforms.relief.data[i] * 0.55);
  }

  for (let y = 2; y < MACRO - 2; y++) {
    for (let x = 2; x < MACRO - 2; x++) {
      const i = y * MACRO + x;
      const h = H[i];
      if (h <= SEA_LEVEL) continue;
      // Nobody founds a town on a 40-degree slope or on an icecap.
      const sl = slope.data[i];
      if (sl > 0.62) continue;
      const temp = climate.temperature.data[i];
      if (temp < -13) continue;
      const b = climate.biome[i];
      if (b === Biome.Glacier || b === Biome.IceSheet) continue;

      const def = BIOME_BY_ID[b];
      const flat = 1 - clamp01(sl / 0.45);
      const moisture = climate.moisture.data[i];
      const scores: Partial<Record<SiteReason, number>> = {};

      // --- Fresh water and crossings ---
      let bestRiver = 0;
      let riverNeighbours = 0;
      let distinctChannels = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = (y + dy) * MACRO + (x + dx);
          if (!hydro.isRiver[ni]) continue;
          riverNeighbours++;
          if (flow[ni] > bestRiver) bestRiver = flow[ni];
        }
      }
      // A confluence shows up as river cells arriving from more than one side.
      if (riverNeighbours >= 2) {
        const dirs = [
          hydro.isRiver[i - 1] || hydro.isRiver[i - MACRO - 1] || hydro.isRiver[i + MACRO - 1],
          hydro.isRiver[i + 1] || hydro.isRiver[i - MACRO + 1] || hydro.isRiver[i + MACRO + 1],
          hydro.isRiver[i - MACRO] || hydro.isRiver[i - MACRO - 1] || hydro.isRiver[i - MACRO + 1],
          hydro.isRiver[i + MACRO] || hydro.isRiver[i + MACRO - 1] || hydro.isRiver[i + MACRO + 1],
        ];
        distinctChannels = dirs.filter(Boolean).length;
      }

      if (bestRiver > 0) {
        const mag = clamp01(Math.log10(bestRiver / 800) / 2.4);
        scores.river = 0.5 + mag * 1.7;
        if (distinctChannels >= 3) scores.confluence = 1.1 + mag * 1.5;
        // A ford wants a big river and *low* local flow depth: shallow, wide, flat.
        if (mag > 0.25 && sl < 0.14) scores.ford = 0.7 + mag * 0.9;
      }

      // --- Coast and harbours ---
      const coastDist = climate.coastDistance.data[i];
      const coastal = coastDist <= MACRO_CELL_KM * 1.6;
      if (coastal) {
        scores.coast = 0.55;
        // A harbour needs water nearby but land wrapped around it: the local
        // water fraction sits in a middle band exactly at sheltered inlets.
        const wf = landforms.waterFraction.data[i];
        const shelter = 1 - Math.abs(wf - 0.45) / 0.45;
        if (shelter > 0) scores.harbour = shelter * 1.9 * lerp(0.5, 1, flat);
        if (bestRiver > 26000) scores.delta = 1.3;
      }

      // --- Lakes ---
      for (let dy = -2; dy <= 2 && scores.lakeshore === undefined; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (hydro.lakeId[(y + dy) * MACRO + (x + dx)] >= 0) {
            scores.lakeshore = 1.0;
            break;
          }
        }
      }

      // --- Arable ground ---
      if (def) {
        scores.farmland = def.fertility * 1.5 * flat * clamp01((temp + 4) / 20);
      }

      // --- Defensible rises ---
      const relief = landforms.relief.data[i];
      let higherAround = 0;
      for (let a = 0; a < 8; a++) {
        const ax = x + [2, 2, 0, -2, -2, -2, 0, 2][a];
        const ay = y + [0, 2, 2, 2, 0, -2, -2, -2][a];
        if (H[ay * MACRO + ax] < h - 0.04) higherAround++;
      }
      if (higherAround >= 6 && relief > 0.1 && sl < 0.4) {
        scores.hilltop = 0.8 + clamp01(relief / 0.6) * 0.8;
      }

      // --- Passes ---
      if (passNear.data[i] > 0.12 && h > 0.5) {
        scores.pass = 0.9 + passNear.data[i] * 1.1;
      }

      // --- Ore ---
      if (ore.data[i] > 0.35 && h > 0.55) {
        scores.mining = ore.data[i] * 1.5;
      }

      // --- Desert water ---
      if (moisture < 0.16 && (bestRiver > 0 || (scores.lakeshore ?? 0) > 0 || hydro.waterTable.data[i] > 0.35)) {
        scores.oasis = 1.8;
      }

      // --- Timber ---
      if (def && def.group === 'forest' && def.cover > 0.6) {
        scores.timber = 0.55;
      }

      // --- Islands ---
      const lmId = landforms.landOwner[i];
      if (lmId >= 0) {
        const lm = landforms.landmasses[lmId];
        if (lm && lm.area < 26_000) scores.island = 0.8;
      }

      // --- Sheer remoteness: someone always builds out here ---
      scores.frontier = 0.12;

      // Total, with a mild penalty for extreme climates and altitude.
      let total = 0;
      let reason: SiteReason = 'frontier';
      let bestVal = -1;
      for (const k in scores) {
        const v = scores[k as SiteReason]!;
        total += v;
        if (v > bestVal) {
          bestVal = v;
          reason = k as SiteReason;
        }
      }
      const altitudePenalty = 1 - clamp01((h - 1.6) / 3.2) * 0.72;
      const coldPenalty = clamp01((temp + 11) / 14);
      const aridPenalty = moisture < 0.06 && !scores.oasis ? 0.25 : 1;
      total *= altitudePenalty * coldPenalty * aridPenalty * lerp(0.55, 1, flat);

      if (total < 0.35) continue;
      out.push({ cell: i, score: total, reason, scores, riverFlow: bestRiver, coastal });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Greedy selection with a minimum separation, using a coarse bucket grid. */
function selectSpaced(
  candidates: Scored[],
  taken: Map<number, number[]>,
  bucketKm: number,
  minKm: number,
  limit: number,
  accept?: (s: Scored) => boolean,
): Scored[] {
  const chosen: Scored[] = [];
  const min2 = minKm * minKm;
  const reach = Math.ceil(minKm / bucketKm);

  for (const c of candidates) {
    if (chosen.length >= limit) break;
    if (accept && !accept(c)) continue;
    const x = macroToWorldX(c.cell % MACRO);
    const z = macroToWorldZ((c.cell / MACRO) | 0);
    const bx = Math.floor(x / bucketKm);
    const bz = Math.floor(z / bucketKm);
    let clash = false;
    for (let dz = -reach; dz <= reach && !clash; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const arr = taken.get((bx + dx) * 100000 + (bz + dz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k += 2) {
          const ddx = arr[k] - x;
          const ddz = arr[k + 1] - z;
          if (ddx * ddx + ddz * ddz < min2) {
            clash = true;
            break;
          }
        }
        if (clash) break;
      }
    }
    if (clash) continue;
    chosen.push(c);
    const key = bx * 100000 + bz;
    const arr = taken.get(key);
    if (arr) arr.push(x, z);
    else taken.set(key, [x, z]);
  }
  return chosen;
}

export function generateSettlements(
  height: Field,
  slope: Field,
  climate: ClimateResult,
  hydro: HydrologyResult,
  landforms: LandformSet,
  orogeny: Field,
  ownership: Int32Array,
  regionCount: number,
  seed: number,
  budget = { cities: 34, towns: 200, villages: 900, hamlets: 460 },
): SettlementResult {
  const rng = rngFor(seed, 'settlements');
  const candidates = scoreSites(height, slope, climate, hydro, landforms, orogeny);
  const H = height.data;

  // Shared occupancy grid across all tiers, so a village never lands inside a city.
  const taken = new Map<number, number[]>();
  const settlements: Settlement[] = [];

  const push = (c: Scored, tier: SettlementTier) => {
    const x = macroToWorldX(c.cell % MACRO);
    const z = macroToWorldZ((c.cell / MACRO) | 0);
    const cfg = TIER_CONFIG[tier];
    const base: Record<SettlementTier, [number, number]> = {
      capital: [70_000, 520_000],
      city: [24_000, 190_000],
      town: [2_800, 24_000],
      village: [140, 2_400],
      hamlet: [25, 150],
    };
    const [lo, hi] = base[tier];
    // Population follows the site score, with a long tail so a few places are huge.
    const t = clamp01((c.score - 0.6) / 4.2);
    const pop = Math.round(lerp(lo, hi, Math.pow(t, 1.5) * 0.75 + rng.next() * 0.35));
    settlements.push({
      cell: c.cell,
      x,
      z,
      tier,
      elevationKm: H[c.cell],
      region: ownership[c.cell],
      biome: climate.biome[c.cell],
      population: Math.max(lo, pop),
      reason: c.reason,
      scores: c.scores,
      riverFlow: c.riverFlow,
      coastal: c.coastal,
      walled: rng.bool(cfg.walledChance),
      seed: (c.cell * 2654435761) | 0,
    });
  };

  // --- Capitals: the best site in each region ----------------------------
  const bestPerRegion = new Map<number, Scored>();
  for (const c of candidates) {
    const r = ownership[c.cell];
    if (r < 0) continue;
    const cur = bestPerRegion.get(r);
    if (!cur || c.score > cur.score) bestPerRegion.set(r, c);
  }
  const capitalCandidates = Array.from(bestPerRegion.values()).sort((a, b) => b.score - a.score);
  for (const c of selectSpaced(capitalCandidates, taken, 40, 90, regionCount)) push(c, 'capital');

  // --- Cities, towns, villages, hamlets ----------------------------------
  for (const c of selectSpaced(candidates, taken, 40, TIER_CONFIG.city.separationKm, budget.cities)) {
    push(c, 'city');
  }
  for (const c of selectSpaced(candidates, taken, 24, TIER_CONFIG.town.separationKm, budget.towns)) {
    push(c, 'town');
  }
  for (const c of selectSpaced(candidates, taken, 10, TIER_CONFIG.village.separationKm, budget.villages)) {
    push(c, 'village');
  }
  // Hamlets are allowed on weaker sites, which is what puts a few buildings out
  // on the tundra edge and in the deep forest.
  for (const c of selectSpaced(candidates, taken, 7, TIER_CONFIG.hamlet.separationKm, budget.hamlets)) {
    push(c, 'hamlet');
  }

  // --- Developed-ground field --------------------------------------------
  // Cultivation radiates from every settlement, scaled by population. The
  // terrain shader reads this to add field texture and to warm the ground colour.
  const developed = new Field(MACRO);
  for (const s of settlements) {
    const radiusKm = clamp(Math.pow(s.population, 0.34) * 0.62, 2, 46);
    const rCells = Math.ceil(radiusKm / MACRO_CELL_KM);
    const cx = s.cell % MACRO;
    const cy = (s.cell / MACRO) | 0;
    for (let dy = -rCells; dy <= rCells; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= MACRO) continue;
      for (let dx = -rCells; dx <= rCells; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= MACRO) continue;
        const i = y * MACRO + x;
        if (H[i] <= SEA_LEVEL) continue;
        const d = Math.hypot(dx, dy) / Math.max(1, rCells);
        if (d > 1) continue;
        // Cultivation avoids steep ground - terraces are the exception, not the rule.
        const fit = 1 - clamp01(slope.data[i] / 0.45);
        const v = (1 - d) * (1 - d) * fit;
        if (v > developed.data[i]) developed.data[i] = v;
      }
    }
  }
  developed.blur(1, 1);

  return { settlements, developed };
}
