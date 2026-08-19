/**
 * Feature assembly.
 *
 * Takes the raw output of every analysis pass and turns it into the flat
 * `Feature[]` the atlas actually renders, labels, searches and describes.
 *
 * Two things happen here that matter:
 *
 *  - **Label tiers.** Every feature is assigned the zoom level at which its label
 *    is allowed to appear. This is the single most important decision for making
 *    a world this dense feel navigable rather than cluttered: at world view you
 *    see nine oceans and six continents, and each zoom step reveals a genuinely
 *    new stratum of the world.
 *  - **Cross-references.** Descriptions are written *after* the natural features
 *    exist, so a town can name the river it stands on and the range above it, and
 *    the names it uses are the names actually on the map.
 */

import {
  MACRO,
  MACRO_CELL_KM,
  SEA_LEVEL,
  macroToWorldX,
  macroToWorldZ,
  zToLatitude,
} from '../../core/config';
import { Field } from '../../util/grid';
import { clamp01, formatNumber, roundSignificant } from '../../util/math';
import { Rng, rngFor } from '../../util/rng';
import type { ContinentInfo, Feature, FeatureClass, FeatureKind, RegionInfo, CultureInfo } from '../types';
import { BIOME_BY_ID, Biome } from './biomes';
import type { ClimateResult } from './climate';
import { ANOMALIES, anomalyLabelTier } from './anomalies';
import type { HydrologyResult } from './hydrology';
import { RIVER_NAME_AREA } from './hydrology';
import type { Component, LandformSet } from './landforms';
import { findCapes, thin } from './landforms';
import type { LandmarkSite } from './landmarks';
import type { RoadResult } from './roads';
import { BELTS, CORES, WATER_BODIES, distToPolyline } from './layout';
import * as lore from './lore';
import { NameForge } from './names';
import type { Settlement } from './settlements';

/** Coarse spatial index for nearest-named-feature lookups. */
export class FeatureIndex {
  private cell = 64;
  private buckets = new Map<number, Feature[]>();

  add(f: Feature): void {
    const key = this.key(f.x, f.z);
    const arr = this.buckets.get(key);
    if (arr) arr.push(f);
    else this.buckets.set(key, [f]);
  }

  private key(x: number, z: number): number {
    return Math.floor(x / this.cell) * 100000 + Math.floor(z / this.cell);
  }

  nearest(x: number, z: number, maxKm: number, filter: (f: Feature) => boolean): Feature | null {
    const reach = Math.ceil(maxKm / this.cell);
    const bx = Math.floor(x / this.cell);
    const bz = Math.floor(z / this.cell);
    let best: Feature | null = null;
    let bestD = maxKm * maxKm;
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const arr = this.buckets.get((bx + dx) * 100000 + (bz + dz));
        if (!arr) continue;
        for (const f of arr) {
          if (!filter(f)) continue;
          const ddx = f.x - x;
          const ddz = f.z - z;
          const d = ddx * ddx + ddz * ddz;
          if (d < bestD) {
            bestD = d;
            best = f;
          }
        }
      }
    }
    return best;
  }
}

export interface AssemblyInput {
  seed: number;
  height: Field;
  orogeny: Field;
  climate: ClimateResult;
  hydro: HydrologyResult;
  landforms: LandformSet;
  ownership: Int32Array;
  regions: RegionInfo[];
  cultures: CultureInfo[];
  settlements: Settlement[];
  landmarks: LandmarkSite[];
  roads: RoadResult;
  riverPolylines: Float32Array[];
  forge: NameForge;
}

export interface AssemblyOutput {
  features: Feature[];
  continents: ContinentInfo[];
}

export function assembleFeatures(input: AssemblyInput): AssemblyOutput {
  const {
    seed,
    height,
    orogeny,
    climate,
    hydro,
    landforms,
    ownership,
    regions,
    cultures,
    settlements,
    landmarks,
    roads,
    riverPolylines,
    forge,
  } = input;

  const rng = rngFor(seed, 'features');
  const features: Feature[] = [];
  const index = new FeatureIndex();
  const H = height.data;

  let nextId = 0;
  const add = (f: Omit<Feature, 'id'>): Feature => {
    const full: Feature = { ...f, id: nextId++ };
    features.push(full);
    index.add(full);
    return full;
  };

  const regionAt = (x: number, z: number): number => {
    const gx = Math.round(((x + 2048) / 4096) * (MACRO - 1));
    const gz = Math.round(((z + 2048) / 4096) * (MACRO - 1));
    if (gx < 0 || gz < 0 || gx >= MACRO || gz >= MACRO) return -1;
    return ownership[gz * MACRO + gx];
  };

  const cultureAt = (x: number, z: number): number => {
    const r = regionAt(x, z);
    return r >= 0 ? regions[r].culture : 1;
  };

  const elevationAt = (x: number, z: number): number => {
    const gx = ((x + 2048) / 4096) * (MACRO - 1);
    const gz = ((z + 2048) / 4096) * (MACRO - 1);
    return height.sample(gx, gz) * 1000;
  };

  const biomeAt = (x: number, z: number): number => {
    const gx = Math.round(((x + 2048) / 4096) * (MACRO - 1));
    const gz = Math.round(((z + 2048) / 4096) * (MACRO - 1));
    if (gx < 0 || gz < 0 || gx >= MACRO || gz >= MACRO) return Biome.Ocean;
    return climate.biome[gz * MACRO + gx];
  };

  // ---------------------------------------------------------------- oceans
  // Authored, because the world ocean is topologically one body and naming it by
  // component would produce exactly one name.
  const waterFeatures: Feature[] = [];
  for (const wb of WATER_BODIES) {
    forge.reserve(wb.name);
    const kind = wb.kind as FeatureKind;
    const tier = wb.kind === 'ocean' ? 0 : wb.kind === 'sea' ? 1 : 2;
    const importance = wb.kind === 'ocean' ? 1 : wb.kind === 'sea' ? 0.8 : 0.55;
    const f = add({
      name: wb.name,
      kind,
      cls: 'water',
      x: wb.x,
      z: wb.z,
      elevation: 0,
      region: -1,
      continent: -1,
      importance,
      labelTier: tier,
      description: wb.description,
      facts: [
        `${wb.kind === 'ocean' ? 'Ocean' : wb.kind === 'sea' ? 'Sea' : 'Coastal water'} basin`,
        `Nominal extent ${formatNumber(wb.r * 2)} km across`,
      ],
      extent: wb.r,
      tags: ['water', wb.kind],
    });
    waterFeatures.push(f);
  }

  const nearestSea = (x: number, z: number): string | null => {
    let best: string | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < WATER_BODIES.length; i++) {
      const wb = WATER_BODIES[i];
      const d = Math.hypot(wb.x - x, wb.z - z) / wb.weight;
      if (d < bestScore) {
        bestScore = d;
        best = wb.name;
      }
    }
    return best;
  };

  // ------------------------------------------------------------ continents
  // Continents are named by convention, not by topology. A narrow isthmus or a
  // chain of volcanic islets should not fuse two continents into one name any
  // more than the Suez land bridge makes Africa part of Asia - so each land cell
  // is assigned to the nearest authored core, and cores that belong to the same
  // continent (a polar cap fused to its crown, say) share the label.
  const continents: ContinentInfo[] = [];
  const continentIdByName = new Map<string, number>();
  const continentOwner = new Int32Array(MACRO * MACRO).fill(-1);
  {
    const names: string[] = [];
    for (const core of CORES) {
      if (!continentIdByName.has(core.continent)) {
        continentIdByName.set(core.continent, names.length);
        names.push(core.continent);
      }
    }

    const cellCount = new Int32Array(names.length);
    const sumX = new Float64Array(names.length);
    const sumZ = new Float64Array(names.length);
    const highest = new Float64Array(names.length);
    const minX = new Float64Array(names.length).fill(Infinity);
    const minZ = new Float64Array(names.length).fill(Infinity);
    const maxX = new Float64Array(names.length).fill(-Infinity);
    const maxZ = new Float64Array(names.length).fill(-Infinity);

    for (let gy = 0; gy < MACRO; gy++) {
      const wz = macroToWorldZ(gy);
      for (let gx = 0; gx < MACRO; gx++) {
        const i = gy * MACRO + gx;
        if (H[i] <= SEA_LEVEL) continue;
        const wx = macroToWorldX(gx);
        // Nearest core in *elliptical* space, so a long thin core claims a long
        // thin continent rather than a disc.
        let best = -1;
        let bestD = Infinity;
        for (const core of CORES) {
          const dx = wx - core.x;
          const dz = wz - core.z;
          const cos = Math.cos(core.rot);
          const sin = Math.sin(core.rot);
          const ex = (dx * cos + dz * sin) / core.rx;
          const ez = (-dx * sin + dz * cos) / core.rz;
          const d = ex * ex + ez * ez;
          if (d < bestD) {
            bestD = d;
            best = continentIdByName.get(core.continent)!;
          }
        }
        if (best < 0) continue;
        continentOwner[i] = best;
        cellCount[best]++;
        sumX[best] += wx;
        sumZ[best] += wz;
        if (H[i] > highest[best]) highest[best] = H[i];
        if (wx < minX[best]) minX[best] = wx;
        if (wx > maxX[best]) maxX[best] = wx;
        if (wz < minZ[best]) minZ[best] = wz;
        if (wz > maxZ[best]) maxZ[best] = wz;
      }
    }

    for (let c = 0; c < names.length; c++) {
      if (cellCount[c] < 40) continue;
      const id = continents.length;
      // Re-point the owner grid at the compacted index.
      if (id !== c) {
        for (let i = 0; i < continentOwner.length; i++) if (continentOwner[i] === c) continentOwner[i] = id;
      }
      forge.reserve(names[c]);
      const cx = sumX[c] / cellCount[c];
      const cz = sumZ[c] / cellCount[c];
      continents.push({
        id,
        name: names[c],
        area: cellCount[c] * MACRO_CELL_KM * MACRO_CELL_KM,
        cx,
        cz,
        bounds: [minX[c], minZ[c], maxX[c], maxZ[c]],
        regions: [],
        description: '',
        highestPoint: highest[c] * 1000,
        population: 0,
      });
    }

    // Regions belong to whichever continent owns the cell under their centroid.
    for (const r of regions) {
      const gx = Math.round(((r.cx + 2048) / 4096) * (MACRO - 1));
      const gz = Math.round(((r.cz + 2048) / 4096) * (MACRO - 1));
      const owner = continentOwner[Math.min(MACRO - 1, Math.max(0, gz)) * MACRO + Math.min(MACRO - 1, Math.max(0, gx))];
      r.continent = owner;
      if (owner >= 0) continents[owner].regions.push(r.id);
    }
  }

  // ---------------------------------------------------------------- ranges
  // Authored belts first: they are the world's structural mountains and they
  // already have names that the layout was designed around.
  const rangeFeatures: Feature[] = [];
  for (const belt of BELTS) {
    if (belt.kind === 'rift') continue;
    // Measure the belt from the terrain rather than trusting the authored spec.
    let cells = 0;
    let highest = 0;
    let hx = belt.pts[0][0];
    let hz = belt.pts[0][1];
    let sumX = 0;
    let sumZ = 0;
    for (let gy = 0; gy < MACRO; gy += 2) {
      const wz = macroToWorldZ(gy);
      for (let gx = 0; gx < MACRO; gx += 2) {
        const wx = macroToWorldX(gx);
        const d2 = distToPolyline(wx, wz, belt.pts);
        if (d2 > belt.width * belt.width * 2.6) continue;
        const i = gy * MACRO + gx;
        if (H[i] < 0.7) continue;
        cells++;
        sumX += wx;
        sumZ += wz;
        if (H[i] > highest) {
          highest = H[i];
          hx = wx;
          hz = wz;
        }
      }
    }
    if (cells < 12) continue;

    let length = 0;
    for (let i = 1; i < belt.pts.length; i++) {
      length += Math.hypot(belt.pts[i][0] - belt.pts[i - 1][0], belt.pts[i][1] - belt.pts[i - 1][1]);
    }
    const area = cells * 4 * MACRO_CELL_KM * MACRO_CELL_KM;
    const isArc = belt.kind === 'arc';
    const name = isArc ? `The ${belt.name}` : belt.name;
    forge.reserve(name);
    const lo = lore.describeRange(area, highest, length, {
      rng,
      regions,
      cultures,
      nearestRiver: () => null,
      nearestRange: () => null,
      nearestSea,
      nearestTown: () => null,
      temperature: () => 0,
      moisture: () => 0,
    });
    const path = new Float32Array(belt.pts.length * 2);
    for (let i = 0; i < belt.pts.length; i++) {
      path[i * 2] = belt.pts[i][0];
      path[i * 2 + 1] = belt.pts[i][1];
    }
    const f = add({
      name,
      kind: isArc ? 'archipelago' : 'range',
      cls: isArc ? 'water' : 'relief',
      x: sumX / cells,
      z: sumZ / cells,
      elevation: highest * 1000,
      region: regionAt(sumX / cells, sumZ / cells),
      continent: -1,
      importance: clamp01(0.55 + highest / 12 + length / 4000),
      labelTier: highest > 4.2 || length > 900 ? 0 : 1,
      description: lo.description,
      facts: lo.facts,
      extent: length * 0.5,
      path,
      tags: ['relief', belt.kind],
    });
    rangeFeatures.push(f);
    // The belt's highest point is worth recording separately.
    void hx;
    void hz;
  }

  // Detected upland clusters that no authored belt covers.
  const beltCovered = (x: number, z: number): boolean => {
    for (const belt of BELTS) {
      if (distToPolyline(x, z, belt.pts) < belt.width * belt.width * 1.45) return true;
    }
    return false;
  };
  let extraRanges = 0;
  for (const comp of landforms.ranges) {
    if (extraRanges >= 34) break;
    if (comp.area < 3600) continue;
    if (beltCovered(comp.cx, comp.cz)) continue;
    const name = forge.range(cultureAt(comp.cx, comp.cz));
    const lo = lore.describeRange(comp.area, comp.peakValue, comp.spanKm, {
      rng,
      regions,
      cultures,
      nearestRiver: () => null,
      nearestRange: () => null,
      nearestSea,
      nearestTown: () => null,
      temperature: () => 0,
      moisture: () => 0,
    });
    const f = add({
      name,
      kind: 'range',
      cls: 'relief',
      x: comp.cx,
      z: comp.cz,
      elevation: comp.peakValue * 1000,
      region: regionAt(comp.cx, comp.cz),
      continent: -1,
      importance: clamp01(0.35 + comp.peakValue / 12),
      labelTier: comp.peakValue > 3.4 ? 1 : 2,
      description: lo.description,
      facts: lo.facts,
      extent: comp.spanKm * 0.5,
      tags: ['relief'],
    });
    rangeFeatures.push(f);
    extraRanges++;
  }

  const nearestRange = (x: number, z: number, maxKm: number): string | null => {
    const f = index.nearest(x, z, maxKm, (c) => c.kind === 'range');
    return f ? f.name : null;
  };

  // ---------------------------------------------------------------- rivers
  const riverFeatures: Feature[] = [];
  const named = hydro.rivers
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.flow[r.flow.length - 1] >= RIVER_NAME_AREA && r.length > 60)
    .sort((a, b) => b.r.flow[b.r.flow.length - 1] - a.r.flow[a.r.flow.length - 1]);

  for (const { r, i } of named.slice(0, 190)) {
    const mouth = r.cells[r.cells.length - 1];
    const source = r.cells[0];
    const mx = macroToWorldX(mouth % MACRO);
    const mz = macroToWorldZ((mouth / MACRO) | 0);
    const sx = macroToWorldX(source % MACRO);
    const sz = macroToWorldZ((source / MACRO) | 0);
    const discharge = r.flow[r.flow.length - 1];
    const major = discharge > 90_000;
    const name = forge.river(cultureAt(mx, mz), major);
    const mouthName = r.terminus === 'ocean' ? nearestSea(mx, mz) : null;
    const sourceName = nearestRange(sx, sz, 190);
    const lo = lore.describeRiver(r.length, discharge, r.terminus, mouthName, sourceName, {
      rng,
      regions,
      cultures,
      nearestRiver: () => null,
      nearestRange,
      nearestSea,
      nearestTown: () => null,
      temperature: () => 0,
      moisture: () => 0,
    });
    // Label the river at its midpoint, which is where a cartographer puts it.
    const midIdx = (r.cells.length / 2) | 0;
    const mid = r.cells[midIdx];
    const f = add({
      name,
      kind: 'river',
      cls: 'water',
      x: macroToWorldX(mid % MACRO),
      z: macroToWorldZ((mid / MACRO) | 0),
      elevation: H[mid] * 1000,
      region: regionAt(macroToWorldX(mid % MACRO), macroToWorldZ((mid / MACRO) | 0)),
      continent: -1,
      importance: clamp01(0.3 + Math.log10(discharge / 1000) / 4),
      labelTier: discharge > 320_000 ? 1 : discharge > 60_000 ? 2 : 3,
      description: lo.description,
      facts: lo.facts,
      extent: r.length * 0.35,
      path: riverPolylines[i],
      tags: ['water', 'river'],
    });
    riverFeatures.push(f);
  }

  const nearestRiver = (x: number, z: number, maxKm: number): string | null => {
    const f = index.nearest(x, z, maxKm, (c) => c.kind === 'river');
    return f ? f.name : null;
  };

  // ------------------------------------------------------------------ lakes
  const sortedLakes = [...hydro.lakes].sort((a, b) => b.area - a.area);
  for (const lake of sortedLakes.slice(0, 140)) {
    const big = lake.area > 900;
    const name = forge.lake(cultureAt(lake.cx, lake.cz), big);
    const lo = lore.describeLake(lake.area, lake.maxDepth * 1000, lake.level * 1000, lake.endorheic, {
      rng,
      regions,
      cultures,
      nearestRiver,
      nearestRange,
      nearestSea,
      nearestTown: () => null,
      temperature: () => 0,
      moisture: () => 0,
    });
    add({
      name,
      kind: 'lake',
      cls: 'water',
      x: lake.cx,
      z: lake.cz,
      elevation: lake.level * 1000,
      region: regionAt(lake.cx, lake.cz),
      continent: -1,
      importance: clamp01(0.25 + Math.log10(Math.max(20, lake.area)) / 6),
      labelTier: lake.area > 9000 ? 1 : lake.area > 700 ? 2 : 3,
      description: lo.description,
      facts: lo.facts,
      extent: Math.sqrt(lake.area / Math.PI),
      tags: ['water', 'lake', ...(lake.endorheic ? ['saline'] : [])],
    });
  }

  // ---------------------------------------------------------------- islands
  const islandFeatures: Feature[] = [];
  const islands = landforms.landmasses.filter(
    (lm) => lm.klass === 'major island' || lm.klass === 'island' || lm.klass === 'islet',
  );
  // Populated islands are always worth naming; then the largest of the rest.
  const populatedLandmasses = new Set<number>();
  for (const s of settlements) populatedLandmasses.add(landforms.landOwner[s.cell]);

  const islandBudget = 300;
  const ranked = islands.sort((a, b) => {
    const pa = populatedLandmasses.has(a.id) ? 1e9 : 0;
    const pb = populatedLandmasses.has(b.id) ? 1e9 : 0;
    return pb + b.area - (pa + a.area);
  });

  for (const lm of ranked.slice(0, islandBudget)) {
    if (lm.area < 40) continue;
    const big = lm.area > 2000;
    const populated = populatedLandmasses.has(lm.id);
    const name = forge.island(cultureAt(lm.cx, lm.cz), big);
    const lo = lore.describeIsland(lm.area, lm.highestKm, lm.coastKm, populated, biomeAt(lm.cx, lm.cz), {
      rng,
      regions,
      cultures,
      nearestRiver,
      nearestRange,
      nearestSea,
      nearestTown: () => null,
      temperature: () => 0,
      moisture: () => 0,
    });
    const f = add({
      name,
      kind: 'island',
      cls: 'relief',
      x: lm.cx,
      z: lm.cz,
      elevation: lm.highestKm * 1000,
      region: regionAt(lm.cx, lm.cz),
      continent: -1,
      importance: clamp01(0.2 + Math.log10(Math.max(10, lm.area)) / 6.5),
      labelTier: lm.area > 60_000 ? 1 : lm.area > 1200 ? 2 : 3,
      description: lo.description,
      facts: lo.facts,
      extent: Math.max(4, Math.sqrt(lm.area / Math.PI)),
      biome: biomeAt(lm.cx, lm.cz),
      tags: ['island', populated ? 'inhabited' : 'uninhabited'],
    });
    islandFeatures.push(f);
  }

  // Archipelagos: spatial clusters of small islands.
  const smallIslands = islandFeatures.filter((f) => (f.extent ?? 0) < 40);
  const claimed = new Set<number>();
  let archipelagoCount = 0;
  for (const seedIsle of smallIslands) {
    if (archipelagoCount >= 16) break;
    if (claimed.has(seedIsle.id)) continue;
    const group = smallIslands.filter(
      (o) => !claimed.has(o.id) && Math.hypot(o.x - seedIsle.x, o.z - seedIsle.z) < 210,
    );
    if (group.length < 5) continue;
    let cx = 0;
    let cz = 0;
    for (const g of group) {
      claimed.add(g.id);
      cx += g.x;
      cz += g.z;
    }
    cx /= group.length;
    cz /= group.length;
    const name = forge.archipelago(cultureAt(cx, cz));
    add({
      name,
      kind: 'archipelago',
      cls: 'water',
      x: cx,
      z: cz,
      elevation: 0,
      region: -1,
      continent: -1,
      importance: 0.5,
      labelTier: 1,
      description: `A scatter of ${group.length} named islands and a great many unnamed rocks. ${
        rng.bool(0.5)
          ? 'The passages between them are navigable with local knowledge and lethal without it.'
          : 'Every island is inhabited by somebody, and no two of them agree on whose water this is.'
      }`,
      facts: [
        `${group.length} named islands`,
        `Spread across roughly ${formatNumber(210 * 2)} km`,
        `Nearest mainland ${Math.round(Math.max(0, climate.coastDistance.sample(((cx + 2048) / 4096) * (MACRO - 1), ((cz + 2048) / 4096) * (MACRO - 1))))} km`,
      ],
      extent: 200,
      links: group.map((g) => g.id),
      tags: ['island', 'archipelago'],
    });
    archipelagoCount++;
  }

  // ------------------------------------------------------------------ peaks
  const peakBudget = 260;
  const chosenPeaks = thin(landforms.peaks, 34, peakBudget);
  for (const p of chosenPeaks) {
    const rangeName = p.belt >= 0 ? BELTS[p.belt].name : nearestRange(p.x, p.z, 130);
    const name = p.volcanic ? forge.landmark('volcano', cultureAt(p.x, p.z)) : forge.peak(cultureAt(p.x, p.z), false);
    const lo = lore.describePeak(name, p.elevationKm, p.prominence, p.volcanic, rangeName, {
      rng,
      regions,
      cultures,
      nearestRiver,
      nearestRange,
      nearestSea,
      nearestTown: () => null,
      temperature: () => 0,
      moisture: () => 0,
    });
    const importance = clamp01(0.2 + p.elevationKm / 9 + p.prominence / 6);
    add({
      name,
      kind: p.volcanic ? 'volcano' : 'peak',
      cls: 'relief',
      x: p.x,
      z: p.z,
      elevation: p.elevationKm * 1000,
      region: regionAt(p.x, p.z),
      continent: -1,
      importance,
      labelTier: p.elevationKm > 5.6 ? 1 : p.elevationKm > 3 ? 2 : 3,
      description: lo.description,
      facts: lo.facts,
      extent: 12,
      tags: ['relief', 'summit', ...(p.volcanic ? ['volcanic'] : [])],
    });
  }

  // ------------------------------------------------------------------ passes
  const chosenPasses = thin(landforms.saddles, 62, 90);
  for (const s of chosenPasses) {
    const name = forge.landmark('pass', cultureAt(s.x, s.z));
    const lo = lore.describeLandmark('pass', {
      rng,
      regions,
      cultures,
      nearestRiver,
      nearestRange,
      nearestSea,
      nearestTown: () => null,
      temperature: () => 0,
      moisture: () => 0,
    }, s.elevationKm * 1000, regions[regionAt(s.x, s.z)]?.name ?? null);
    lo.facts.unshift(`Crest ${formatNumber(s.elevationKm * 1000)} m`);
    lo.facts.push(`Flanking peaks stand ${formatNumber(s.relief * 1000)} m above the col`);
    add({
      name,
      kind: 'pass',
      cls: 'relief',
      x: s.x,
      z: s.z,
      elevation: s.elevationKm * 1000,
      region: regionAt(s.x, s.z),
      continent: -1,
      importance: clamp01(0.25 + s.relief / 4),
      labelTier: 2,
      description: lo.description,
      facts: lo.facts,
      extent: 8,
      tags: ['relief', 'pass'],
    });
  }

  // ------------------------------------------------- area landform features
  interface AreaSpec {
    comps: Component[];
    kind: FeatureKind;
    cls: FeatureClass;
    minArea: number;
    budget: number;
    nameKind: string;
    tierFor: (c: Component) => number;
  }

  const areaSpecs: AreaSpec[] = [
    { comps: landforms.forests, kind: 'forest', cls: 'vegetation', minArea: 2800, budget: 90, nameKind: 'forest', tierFor: (c) => (c.area > 160_000 ? 1 : 2) },
    { comps: landforms.duneFields, kind: 'dunes', cls: 'relief', minArea: 2600, budget: 34, nameKind: 'dunes', tierFor: (c) => (c.area > 120_000 ? 1 : 2) },
    { comps: landforms.plateaus, kind: 'plateau', cls: 'relief', minArea: 2200, budget: 46, nameKind: 'plateau', tierFor: (c) => (c.area > 90_000 ? 1 : 2) },
    { comps: landforms.valleys, kind: 'valley', cls: 'relief', minArea: 1100, budget: 60, nameKind: 'valley', tierFor: () => 2 },
    { comps: landforms.glaciers, kind: 'glacier', cls: 'relief', minArea: 1100, budget: 40, nameKind: 'glacier', tierFor: (c) => (c.area > 60_000 ? 1 : 2) },
    { comps: landforms.wetlands, kind: 'marsh', cls: 'water', minArea: 620, budget: 52, nameKind: 'marsh', tierFor: () => 2 },
    { comps: landforms.cliffs, kind: 'cliff', cls: 'relief', minArea: 110, budget: 70, nameKind: 'cliff', tierFor: () => 3 },
    { comps: landforms.badlands, kind: 'canyon', cls: 'relief', minArea: 600, budget: 26, nameKind: 'canyon', tierFor: () => 2 },
    { comps: landforms.saltFlats, kind: 'dunes', cls: 'relief', minArea: 900, budget: 18, nameKind: 'dunes', tierFor: () => 2 },
  ];

  const ctxFor = (): lore.LoreContext => ({
    rng,
    regions,
    cultures,
    nearestRiver,
    nearestRange,
    nearestSea,
    nearestTown: () => null,
    temperature: (x, z) => climate.temperature.sample(((x + 2048) / 4096) * (MACRO - 1), ((z + 2048) / 4096) * (MACRO - 1)),
    moisture: (x, z) => climate.moisture.sample(((x + 2048) / 4096) * (MACRO - 1), ((z + 2048) / 4096) * (MACRO - 1)),
  });

  for (const spec of areaSpecs) {
    let count = 0;
    for (const c of spec.comps) {
      if (count >= spec.budget) break;
      if (c.area < spec.minArea) continue;
      const culture = cultureAt(c.cx, c.cz);
      const name =
        spec.nameKind === 'forest' ? forge.forest(culture, c.area > 100_000) : forge.landmark(spec.nameKind, culture);
      const lo = lore.describeLandmark(spec.nameKind, ctxFor(), c.peakValue * 1000, regions[regionAt(c.cx, c.cz)]?.name ?? null);
      lo.facts.unshift(`Extent ${formatNumber(roundSignificant(c.area, 2))} km2`);
      add({
        name,
        kind: spec.kind,
        cls: spec.cls,
        x: c.cx,
        z: c.cz,
        elevation: elevationAt(c.cx, c.cz),
        region: regionAt(c.cx, c.cz),
        continent: -1,
        importance: clamp01(0.2 + Math.log10(Math.max(100, c.area)) / 7),
        labelTier: spec.tierFor(c),
        description: lo.description,
        facts: lo.facts,
        extent: Math.max(6, Math.sqrt(c.area / Math.PI)),
        biome: biomeAt(c.cx, c.cz),
        tags: [spec.cls],
      });
      count++;
    }
  }

  // ------------------------------------------------------------------ capes
  const capes = thin(findCapes(height, landforms.waterFraction, 0.62), 70, 60);
  for (const c of capes) {
    const name = forge.landmark('cape', cultureAt(c.x, c.z));
    add({
      name,
      kind: 'cape',
      cls: 'relief',
      x: c.x,
      z: c.z,
      elevation: c.elevationKm * 1000,
      region: regionAt(c.x, c.z),
      continent: -1,
      importance: 0.3,
      labelTier: 2,
      description: lore.describeLandmark('cape', ctxFor(), c.elevationKm * 1000, regions[regionAt(c.x, c.z)]?.name ?? null).description,
      facts: [`Elevation ${formatNumber(c.elevationKm * 1000)} m`, `On the ${(nearestSea(c.x, c.z) ?? 'open sea').replace(/^The /, '')}`],
      extent: 14,
      tags: ['coastal'],
    });
  }

  // ---------------------------------------------------------------- straits
  for (const st of thin(landforms.straits, 150, 24)) {
    // Prefer an authored name if one is nearby, otherwise generate.
    let name: string | null = null;
    for (const wb of WATER_BODIES) {
      if ((wb.kind === 'strait' || wb.kind === 'channel' || wb.kind === 'sound') && Math.hypot(wb.x - st.x, wb.z - st.z) < 220) {
        name = null; // already represented by the authored water body
        break;
      }
    }
    if (name === null && WATER_BODIES.some((wb) => (wb.kind === 'strait' || wb.kind === 'channel' || wb.kind === 'sound') && Math.hypot(wb.x - st.x, wb.z - st.z) < 220)) {
      continue;
    }
    const culture = cultureAt(st.x, st.z);
    const generated = `${forge.native(culture)} ${rng.pick(['Strait', 'Narrows', 'Passage', 'Gut', 'Race'])}`;
    add({
      name: forge.reserve(generated),
      kind: 'strait',
      cls: 'water',
      x: st.x,
      z: st.z,
      elevation: 0,
      region: -1,
      continent: -1,
      importance: clamp01(0.5 - st.widthKm / 200),
      labelTier: 2,
      description: `A narrows ${Math.round(st.widthKm)} km across. ${
        st.widthKm < 25 ? 'Close enough to see the far shore, and to be fought over because of it.' : 'The current runs hard through it on both tides.'
      }`,
      facts: [`Width ${Math.round(st.widthKm)} km`, `Open water ${Math.round(st.lengthKm)} km along the passage`],
      extent: Math.max(20, st.lengthKm * 0.4),
      tags: ['water', 'strait'],
    });
  }

  // ------------------------------------------------------------ waterfalls
  // A waterfall is a river cell with a large drop to its downstream neighbour.
  const fallCandidates: Array<{ x: number; z: number; dropM: number; flow: number; cell: number }> = [];
  for (let i = 0; i < MACRO * MACRO; i++) {
    if (!hydro.isRiver[i]) continue;
    const d = hydro.downstream[i];
    if (d < 0) continue;
    const drop = (H[i] - H[d]) * 1000;
    if (drop < 70) continue;
    if (hydro.flow.data[i] < 5000) continue;
    fallCandidates.push({
      x: macroToWorldX(i % MACRO),
      z: macroToWorldZ((i / MACRO) | 0),
      dropM: drop,
      flow: hydro.flow.data[i],
      cell: i,
    });
  }
  fallCandidates.sort((a, b) => b.dropM * Math.log10(b.flow) - a.dropM * Math.log10(a.flow));
  for (const f of thin(fallCandidates, 40, 60)) {
    const name = forge.landmark('waterfall', cultureAt(f.x, f.z));
    const river = nearestRiver(f.x, f.z, 12);
    add({
      name,
      kind: 'waterfall',
      cls: 'water',
      x: f.x,
      z: f.z,
      elevation: H[f.cell] * 1000,
      region: regionAt(f.x, f.z),
      continent: -1,
      importance: clamp01(0.24 + f.dropM / 900),
      labelTier: f.dropM > 260 ? 2 : 3,
      description: lore.describeLandmark('waterfall', ctxFor(), H[f.cell] * 1000, regions[regionAt(f.x, f.z)]?.name ?? null).description,
      facts: [
        `Total drop about ${formatNumber(Math.round(f.dropM / 5) * 5)} m`,
        river ? `On ${river}` : 'On an unnamed headwater',
        `Catchment ${formatNumber(roundSignificant(f.flow, 2))} km2`,
      ],
      extent: 6,
      tags: ['water', 'waterfall'],
    });
  }

  // ---------------------------------------------------------------- deltas
  for (const river of hydro.rivers) {
    if (river.terminus !== 'ocean') continue;
    const discharge = river.flow[river.flow.length - 1];
    if (discharge < 140_000) continue;
    const mouth = river.cells[river.cells.length - 1];
    const mx = macroToWorldX(mouth % MACRO);
    const mz = macroToWorldZ((mouth / MACRO) | 0);
    // A delta needs a shallow shelf, not a fjord.
    if (climate.slope.data[mouth] > 0.09) continue;
    const riverName = nearestRiver(mx, mz, 25);
    const name = forge.reserve(riverName ? `${riverName.replace(/^The /, '')} Delta` : `${forge.native(cultureAt(mx, mz))} Delta`);
    add({
      name,
      kind: 'delta',
      cls: 'water',
      x: mx,
      z: mz,
      elevation: 0,
      region: regionAt(mx, mz),
      continent: -1,
      importance: 0.42,
      labelTier: 2,
      description:
        'A fan of distributary channels, mudflats and reed islands. The main channel has moved twice within living memory and will move again.',
      facts: [
        `Discharge from a basin of ${formatNumber(roundSignificant(discharge, 2))} km2`,
        'Channels shift on a decadal timescale',
        `Opens into the ${(nearestSea(mx, mz) ?? 'open sea').replace(/^The /, '')}`,
      ],
      extent: 34,
      tags: ['water', 'delta'],
    });
  }

  // ------------------------------------------------------------- settlements
  const settlementFeatures: Feature[] = [];
  const settlementCoords: Array<{ x: number; z: number; name: string }> = [];
  const nearestTown = (x: number, z: number, excludeIdx: number): { name: string; km: number } | null => {
    let best: { name: string; km: number } | null = null;
    for (let i = 0; i < settlementCoords.length; i++) {
      if (i === excludeIdx) continue;
      const s = settlementCoords[i];
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < 1) continue;
      if (!best || d < best.km) best = { name: s.name, km: d };
    }
    return best;
  };

  const KIND_BY_TIER: Record<Settlement['tier'], FeatureKind> = {
    capital: 'capital',
    city: 'city',
    town: 'town',
    village: 'village',
    hamlet: 'hamlet',
  };
  const TIER_LABEL: Record<Settlement['tier'], number> = {
    capital: 1,
    city: 1,
    town: 2,
    village: 3,
    hamlet: 4,
  };
  const TIER_IMPORTANCE: Record<Settlement['tier'], number> = {
    capital: 0.92,
    city: 0.78,
    town: 0.5,
    village: 0.26,
    hamlet: 0.14,
  };

  // --- Road approaches ----------------------------------------------------
  // For each settlement, the bearing every road leaves on. Measured a short way
  // along the route rather than from the first vertex, because the first segment
  // is often a stub artefact of snapping the path to the settlement centre.
  const approachesBySettlement = new Map<number, number[]>();
  const pushApproach = (idx: number, bearing: number) => {
    const arr = approachesBySettlement.get(idx);
    if (arr) arr.push(bearing);
    else approachesBySettlement.set(idx, [bearing]);
  };
  for (const road of roads.roads) {
    const n = road.pts.length / 2;
    if (n < 2) continue;
    // Sample about 400 m along, or a quarter of the route for very short lanes.
    const step = Math.max(1, Math.min(n - 1, Math.round(n / 4)));
    pushApproach(
      road.a,
      Math.atan2(road.pts[step * 2 + 1] - road.pts[1], road.pts[step * 2] - road.pts[0]),
    );
    const e = n - 1;
    pushApproach(
      road.b,
      Math.atan2(
        road.pts[(e - step) * 2 + 1] - road.pts[e * 2 + 1],
        road.pts[(e - step) * 2] - road.pts[e * 2],
      ),
    );
  }
  // Merge bearings that arrive within about eight degrees of each other: two
  // roads leaving on the same side share one street out of town.
  const mergeBearings = (list: number[]): Float32Array => {
    const kept: number[] = [];
    for (const b of list) {
      const norm = Math.atan2(Math.sin(b), Math.cos(b));
      if (kept.some((k) => Math.abs(Math.atan2(Math.sin(k - norm), Math.cos(k - norm))) < 0.14)) continue;
      kept.push(norm);
    }
    return new Float32Array(kept);
  };

  // Names first, so descriptions can reference neighbours by name.
  const settlementNames = settlements.map((s) => forge.settlement(cultureAt(s.x, s.z), s.tier));
  for (let i = 0; i < settlements.length; i++) {
    settlementCoords.push({ x: settlements[i].x, z: settlements[i].z, name: settlementNames[i] });
  }

  const loreCtx: lore.LoreContext = {
    ...ctxFor(),
    nearestTown,
  };

  for (let i = 0; i < settlements.length; i++) {
    const s = settlements[i];
    const lo = lore.describeSettlement(s, loreCtx, i);
    const region = regions[s.region];
    const f = add({
      name: settlementNames[i],
      kind: KIND_BY_TIER[s.tier],
      cls: 'settlement',
      x: s.x,
      z: s.z,
      elevation: s.elevationKm * 1000,
      region: s.region,
      continent: -1,
      importance: clamp01(TIER_IMPORTANCE[s.tier] + Math.log10(Math.max(10, s.population)) / 40),
      labelTier: TIER_LABEL[s.tier],
      population: s.population,
      description: lo.description,
      facts: lo.facts,
      extent: Math.max(1.5, Math.pow(s.population, 0.33) * 0.16),
      biome: s.biome,
      tags: [
        'settlement',
        s.tier,
        ...(s.coastal ? ['coastal'] : []),
        ...(s.walled ? ['fortified'] : []),
        s.reason,
      ],
      approaches: mergeBearings(approachesBySettlement.get(i) ?? []),
    });
    settlementFeatures.push(f);
    if (region) {
      region.population += s.population;
      region.settlementCount++;
      if (s.tier === 'capital' && region.capital < 0) region.capital = f.id;
    }
  }

  // The largest settlement in the world is worth flagging at world zoom.
  let biggest = settlementFeatures[0];
  for (const f of settlementFeatures) if ((f.population ?? 0) > (biggest?.population ?? 0)) biggest = f;
  if (biggest) {
    biggest.labelTier = 0;
    biggest.importance = 1;
  }

  // --------------------------------------------------------------- landmarks
  for (const lm of landmarks) {
    const culture = cultureAt(lm.x, lm.z);
    const name = forge.landmark(lm.kind, culture);
    const regionName = regions[lm.region]?.name ?? null;
    const lo = lore.describeLandmark(lm.kind, loreCtx, lm.elevationKm * 1000, regionName);
    if (lm.meta?.flow) {
      lo.facts.push(`Spans a river draining ${formatNumber(roundSignificant(lm.meta.flow, 2))} km2`);
    }
    const river = lm.kind === 'bridge' || lm.kind === 'watermill' || lm.kind === 'ferry' ? nearestRiver(lm.x, lm.z, 16) : null;
    if (river) lo.facts.push(`On ${river}`);
    const town = nearestTown(lm.x, lm.z, -1);
    if (town && town.km < 120) lo.facts.push(`${Math.round(town.km)} km from ${town.name}`);

    add({
      name,
      kind: lm.kind,
      cls: lm.cls,
      x: lm.x,
      z: lm.z,
      elevation: lm.elevationKm * 1000,
      region: lm.region,
      continent: -1,
      importance: lm.importance,
      labelTier: lm.labelTier,
      description: lo.description,
      facts: lo.facts,
      extent: 4,
      biome: lm.biome,
      tags: [lm.cls, lm.kind],
      // A bridge's position and bearing are corrected after assembly, once the
      // river polylines exist — see `snapBridgesToRivers` in `generate.ts`.
      spanKm: lm.kind === 'bridge' && lm.meta ? lm.meta.spanKm : undefined,
    });
  }

  // --------------------------------------------------------------- anomalies
  for (const a of ANOMALIES) {
    forge.reserve(a.name);
    const region = regionAt(a.x, a.z);
    add({
      name: a.name,
      kind: 'anomaly',
      cls: 'anomaly',
      x: a.x,
      z: a.z,
      elevation: elevationAt(a.x, a.z),
      region,
      continent: -1,
      importance: a.subtlety === 'obvious' ? 0.85 : a.subtlety === 'moderate' ? 0.6 : 0.45,
      labelTier: anomalyLabelTier(a.subtlety),
      description: a.description,
      facts: [...a.facts, `Breaks: ${a.violates}`],
      extent: a.r,
      tags: ['anomaly', a.subtlety],
    });
  }

  // ------------------------------------------------- Northvale, the namesake
  // The world is named after a single valley. It should exist, and it should be
  // findable, so it is placed on the best real valley floor in northern Aurenhal.
  {
    let best: Component | null = null;
    let bestScore = -Infinity;
    for (const v of landforms.valleys) {
      if (v.area < 3000) continue;
      const d = Math.hypot(v.cx + 620, v.cz + 800);
      const score = -d + v.area / 400;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best) {
      const f = add({
        name: 'Northvale',
        kind: 'valley',
        cls: 'relief',
        x: best.cx,
        z: best.cz,
        elevation: elevationAt(best.cx, best.cz),
        region: regionAt(best.cx, best.cz),
        continent: -1,
        importance: 0.98,
        labelTier: 0,
        description:
          'The valley the world is named for. Eighty kilometres of flat floor between two walls of rock, with a river down the middle of it and a road down one side. Every survey of the world since the first one has been referenced from the stone at its northern end.',
        facts: [
          `Floor at ${formatNumber(elevationAt(best.cx, best.cz))} m`,
          `Valley floor area ${formatNumber(roundSignificant(best.area, 2))} km2`,
          'The origin point of every survey of Northvale',
          'Gives the world its name',
        ],
        extent: Math.max(40, Math.sqrt(best.area / Math.PI)),
        tags: ['relief', 'valley', 'namesake'],
      });
      forge.reserve(f.name);
    }
  }

  // --------------------------------------------- region and continent prose
  for (const region of regions) {
    const culture = cultures[region.culture];
    const capitalName = region.capital >= 0 ? features[region.capital]?.name ?? null : null;
    region.description = lore.describeRegion(region, culture, loreCtx, capitalName);
    add({
      name: region.name,
      kind: 'region',
      cls: 'territory',
      x: region.cx,
      z: region.cz,
      elevation: elevationAt(region.cx, region.cz),
      region: region.id,
      continent: -1,
      importance: clamp01(0.4 + Math.log10(Math.max(10, region.population)) / 14),
      labelTier: 2,
      description: region.description,
      facts: [
        `Area ${formatNumber(roundSignificant(region.area, 3))} km2`,
        `Population ${formatNumber(region.population)}`,
        `${region.settlementCount} settlements`,
        `Predominantly ${BIOME_BY_ID[region.dominantBiome]?.name.toLowerCase() ?? 'mixed'}`,
        capitalName ? `Capital: ${capitalName}` : 'No seat of government',
      ],
      extent: Math.sqrt(region.area / Math.PI),
      tags: ['territory', cultures[region.culture].name.toLowerCase()],
    });
  }

  for (const cont of continents) {
    let pop = 0;
    for (const rid of cont.regions) pop += regions[rid]?.population ?? 0;
    cont.population = pop;
    cont.description = lore.describeContinent(cont.name, cont.area, cont.highestPoint / 1000, cont.regions.length, pop, loreCtx);
    add({
      name: cont.name,
      kind: 'continent',
      cls: 'territory',
      x: cont.cx,
      z: cont.cz,
      elevation: elevationAt(cont.cx, cont.cz),
      region: -1,
      continent: cont.id,
      importance: 1,
      labelTier: 0,
      description: cont.description,
      facts: [
        `Area ${formatNumber(roundSignificant(cont.area, 3))} km2`,
        `Highest point ${formatNumber(cont.highestPoint)} m`,
        `${cont.regions.length} regions`,
        `Population ${formatPopulationShort(pop)}`,
        `Spans latitudes ${Math.round(zToLatitude(cont.bounds[3]))} to ${Math.round(zToLatitude(cont.bounds[1]))}`,
      ],
      extent: Math.max(cont.bounds[2] - cont.bounds[0], cont.bounds[3] - cont.bounds[1]) * 0.5,
      tags: ['territory', 'continent'],
    });
  }

  // Fill in continent ownership for every land feature.
  for (const f of features) {
    if (f.continent >= 0) continue;
    const gx = Math.round(((f.x + 2048) / 4096) * (MACRO - 1));
    const gz = Math.round(((f.z + 2048) / 4096) * (MACRO - 1));
    if (gx < 0 || gz < 0 || gx >= MACRO || gz >= MACRO) continue;
    f.continent = continentOwner[gz * MACRO + gx];
  }

  void Rng;
  void SEA_LEVEL;
  void orogeny;
  return { features, continents };
}

function formatPopulationShort(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} million`;
  return formatNumber(v);
}
