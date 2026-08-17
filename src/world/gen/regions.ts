/**
 * Political geography.
 *
 * Regions are not Voronoi cells. They are grown outward from seed points by
 * cheapest-path expansion over a cost surface built from slope, elevation, river
 * crossings and biome traversability. The consequence is that borders settle
 * along watersheds, mountain crests and major rivers on their own - which is
 * where real borders end up, and why the political layer looks like it was drawn
 * by people who had to walk the ground.
 *
 * Cultures are assigned from a smaller set of culture cores, so neighbouring
 * regions share a language and an architecture instead of each being an island
 * of its own.
 */

import { MACRO, MACRO_CELL_KM, SEA_LEVEL, macroToWorldX, macroToWorldZ, worldToMacroX, worldToMacroZ } from '../../core/config';
import { labelBoundaries, simplifyPolyline, smoothPolyline, stitchSegments } from '../../util/contour';
import { Field } from '../../util/grid';
import { MinHeap } from '../../util/heap';
import { clamp01 } from '../../util/math';
import { Rng, rngFor } from '../../util/rng';
import type { CultureInfo, RegionInfo } from '../types';
import { BIOME_BY_ID, biomeCharacter } from './biomes';
import type { ClimateResult } from './climate';
import type { Landmass } from './landforms';
import { CULTURES, NameForge } from './names';

const CELL_AREA = MACRO_CELL_KM * MACRO_CELL_KM;

/** Where each culture is centred. Regions take the culture of the nearest core. */
const CULTURE_CORES: Array<{ culture: number; x: number; z: number; reach: number }> = [
  { culture: 2, x: -400, z: -1350, reach: 1.0 }, // Skarn - northern highlands
  { culture: 2, x: 400, z: -1700, reach: 0.9 }, // Skarn - polar coast
  { culture: 1, x: -700, z: -700, reach: 1.05 }, // Harrow - Amber Sea lowlands
  { culture: 1, x: -1000, z: -100, reach: 1.0 }, // Harrow - northern Kaerith
  { culture: 0, x: -1050, z: 380, reach: 1.1 }, // Valen - Kaerith heartland
  { culture: 0, x: -1350, z: 620, reach: 0.95 }, // Valen - southern Kaerith coast
  { culture: 3, x: 800, z: -250, reach: 1.15 }, // Sahvari - the deep desert
  { culture: 3, x: 1250, z: -600, reach: 1.0 }, // Sahvari - eastern desert
  { culture: 6, x: 1600, z: -900, reach: 1.0 }, // Ossuran - Ossuary Reach
  { culture: 4, x: 1500, z: 700, reach: 1.05 }, // Tolm - equatorial Tolmereth
  { culture: 4, x: 1150, z: 400, reach: 0.9 }, // Tolm - Verdant coast
  { culture: 5, x: 100, z: 1200, reach: 1.15 }, // Kethic - Veshanti
  { culture: 5, x: -700, z: 1500, reach: 1.0 }, // Kethic - southern reaches
  { culture: 6, x: 700, z: 1450, reach: 0.9 }, // Ossuran - south-east Veshanti
];

/** Distinct, desaturated political colours - an atlas palette, not a highlighter set. */
const REGION_PALETTE = [
  0xa8756a, 0x7f8f6a, 0x6f8496, 0xa89a6a, 0x8d7593, 0x6f9188, 0xb08a72, 0x77839d,
  0x9d8a6d, 0x8a9a7c, 0x9c7f85, 0x71918f, 0xa5926e, 0x82789b, 0x8f9a6f, 0xa1817b,
  0x6d8b7d, 0x9b8f7e, 0x7d8ba3, 0xab8878, 0x788f74, 0x94809a, 0x9aa079, 0x7b8e94,
];

export interface RegionResult {
  regions: RegionInfo[];
  cultures: CultureInfo[];
  /** Region id per cell, -1 for open ocean. */
  ownership: Int32Array;
  /** Flat x,z pairs of internal border segments. */
  borderSegments: Float32Array;
}

/** Cost of expanding a region into a cell. Higher means less likely to be claimed. */
function buildCostSurface(
  height: Field,
  slope: Field,
  climate: ClimateResult,
  isRiver: Uint8Array,
  lakeId: Int32Array,
): Float32Array {
  const n = MACRO * MACRO;
  const cost = new Float32Array(n);
  const H = height.data;
  for (let i = 0; i < n; i++) {
    const h = H[i];
    if (h <= SEA_LEVEL) {
      // Sea crossings are expensive but not forbidden, so small islands are
      // claimed by the nearest coast instead of being left stateless.
      cost[i] = 34;
      continue;
    }
    const def = BIOME_BY_ID[climate.biome[i]];
    let c = 1 + slope.data[i] * 9 + Math.max(0, h - 1) * 2.6 + (def ? def.traversal * 3 : 0);
    // Rivers are natural boundaries: crossing one costs something.
    if (isRiver[i]) c += 4;
    if (lakeId[i] >= 0) c += 12;
    cost[i] = c;
  }
  return cost;
}

/** Habitability score used to place region seeds where people actually settle. */
function habitability(
  height: Field,
  slope: Field,
  climate: ClimateResult,
  waterTable: Field,
): Float32Array {
  const n = MACRO * MACRO;
  const out = new Float32Array(n);
  const H = height.data;
  for (let i = 0; i < n; i++) {
    if (H[i] <= SEA_LEVEL) continue;
    const def = BIOME_BY_ID[climate.biome[i]];
    if (!def) continue;
    const flat = 1 - clamp01(slope.data[i] / 0.5);
    const warm = clamp01((climate.temperature.data[i] + 12) / 30);
    const low = 1 - clamp01(Math.max(0, H[i] - 0.4) / 3);
    const coast = 1 - clamp01(climate.coastDistance.data[i] / 700);
    out[i] = (def.fertility * 1.4 + waterTable.data[i] * 0.8 + coast * 0.5) * flat * warm * low;
  }
  return out;
}

export function generateRegions(
  height: Field,
  slope: Field,
  climate: ClimateResult,
  waterTable: Field,
  isRiver: Uint8Array,
  lakeId: Int32Array,
  landmasses: Landmass[],
  landOwner: Int32Array,
  forge: NameForge,
  seed: number,
  targetRegions = 54,
): RegionResult {
  const n = MACRO * MACRO;
  const H = height.data;
  const rng = rngFor(seed, 'regions');
  void rng;

  const cost = buildCostSurface(height, slope, climate, isRiver, lakeId);
  const hab = habitability(height, slope, climate, waterTable);

  // --- Seed placement ----------------------------------------------------
  // Seats of government are allocated per landmass in proportion to its area,
  // then placed on the most habitable ground within it. Purely global greedy
  // selection puts every seed on the single wettest continent and leaves whole
  // landmasses as one enormous region.
  const seeds: number[] = [];
  const eligible = landmasses.filter((lm) => lm.area >= 12_000);
  let totalArea = 0;
  for (const lm of eligible) totalArea += lm.area;

  for (const lm of eligible) {
    const share = Math.max(1, Math.round((lm.area / totalArea) * targetRegions));
    // Spacing derived from the area each region will end up covering.
    const spacingKm = Math.max(70, Math.sqrt(lm.area / share / Math.PI) * 1.25);
    const min2 = (spacingKm / MACRO_CELL_KM) ** 2;

    // Rank this landmass's cells by habitability, then take the spaced best.
    const cells = Array.from(lm.cells);
    cells.sort((a, b) => hab[b] - hab[a]);
    const placed: number[] = [];
    for (const i of cells) {
      if (placed.length >= share) break;
      const x = i % MACRO;
      const y = (i / MACRO) | 0;
      let clash = false;
      for (const p of placed) {
        const dx = (p % MACRO) - x;
        const dy = ((p / MACRO) | 0) - y;
        if (dx * dx + dy * dy < min2) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      placed.push(i);
    }
    // A landmass with nowhere habitable still gets one seat, at its best cell.
    if (!placed.length && cells.length) placed.push(cells[0]);
    for (const i of placed) seeds.push(i);
  }

  // --- Cheapest-path region growth ---------------------------------------
  const ownership = new Int32Array(n).fill(-1);
  const dist = new Float32Array(n).fill(Infinity);
  const heap = new MinHeap(1 << 17);
  for (let s = 0; s < seeds.length; s++) {
    ownership[seeds[s]] = s;
    dist[seeds[s]] = 0;
    heap.push(0, seeds[s]);
  }

  const NX = [1, -1, 0, 0, 1, 1, -1, -1];
  const NY = [0, 0, 1, -1, 1, -1, 1, -1];
  const NL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

  while (heap.size > 0) {
    const d = heap.peekPriority();
    const c = heap.pop();
    if (d > dist[c] + 1e-6) continue;
    const cx = c % MACRO;
    const cy = (c / MACRO) | 0;
    const owner = ownership[c];
    for (let k = 0; k < 8; k++) {
      const nx = cx + NX[k];
      const ny = cy + NY[k];
      if (nx < 0 || ny < 0 || nx >= MACRO || ny >= MACRO) continue;
      const ni = ny * MACRO + nx;
      const nd = d + cost[ni] * NL[k];
      // Regions stop growing once they get absurdly expensive: this leaves the
      // open ocean unclaimed rather than partitioning the entire planet.
      if (nd > 900) continue;
      if (nd < dist[ni]) {
        dist[ni] = nd;
        ownership[ni] = owner;
        heap.push(nd, ni);
      }
    }
  }

  // Ocean cells stay unowned - only land carries a flag.
  for (let i = 0; i < n; i++) if (H[i] <= SEA_LEVEL) ownership[i] = -1;

  // --- Region statistics -------------------------------------------------
  const count = seeds.length;
  const cellCount = new Int32Array(count);
  const sumX = new Float64Array(count);
  const sumZ = new Float64Array(count);
  const biomeTally: Int32Array[] = [];
  for (let i = 0; i < count; i++) biomeTally.push(new Int32Array(64));

  for (let i = 0; i < n; i++) {
    const r = ownership[i];
    if (r < 0) continue;
    cellCount[r]++;
    sumX[r] += i % MACRO;
    sumZ[r] += (i / MACRO) | 0;
    biomeTally[r][climate.biome[i] & 63]++;
  }

  // Adjacency, for colouring and for "neighbours" in the info panel.
  const neighbours: Set<number>[] = [];
  for (let i = 0; i < count; i++) neighbours.push(new Set<number>());
  for (let y = 0; y < MACRO; y++) {
    for (let x = 0; x < MACRO; x++) {
      const a = ownership[y * MACRO + x];
      if (a < 0) continue;
      if (x + 1 < MACRO) {
        const b = ownership[y * MACRO + x + 1];
        if (b >= 0 && b !== a) {
          neighbours[a].add(b);
          neighbours[b].add(a);
        }
      }
      if (y + 1 < MACRO) {
        const b = ownership[(y + 1) * MACRO + x];
        if (b >= 0 && b !== a) {
          neighbours[a].add(b);
          neighbours[b].add(a);
        }
      }
    }
  }

  // Greedy graph colouring so no two neighbours share a political colour.
  const colorIndex = new Int32Array(count).fill(-1);
  const order = Array.from({ length: count }, (_, i) => i).sort(
    (a, b) => neighbours[b].size - neighbours[a].size,
  );
  const BLOCK = 6;
  for (const r of order) {
    const taken = new Set<number>();
    for (const nb of neighbours[r]) if (colorIndex[nb] >= 0) taken.add(Math.floor(colorIndex[nb] / BLOCK));
    let klass = 0;
    while (taken.has(klass)) klass++;
    // Four colour classes of six shades each. Neighbours always land in
    // different blocks, and the within-block offset keeps distant regions from
    // all looking identical.
    colorIndex[r] = ((klass % 4) * BLOCK + (r % BLOCK)) % REGION_PALETTE.length;
  }

  // --- Assemble -----------------------------------------------------------
  const cultures: CultureInfo[] = CULTURES.map((c, id) => ({
    id,
    name: c.name,
    adjective: c.adjective,
    architecture: c.architecture,
    roofColor: c.roofColor,
    wallColor: c.wallColor,
    description: c.description,
  }));

  const regions: RegionInfo[] = [];
  for (let r = 0; r < count; r++) {
    if (cellCount[r] < 4) {
      // Degenerate region: fold it into a neighbour so no empty flags exist.
      const nb = neighbours[r].values().next();
      const target = nb.done ? -1 : nb.value;
      for (let i = 0; i < n; i++) if (ownership[i] === r) ownership[i] = target;
    }
  }

  // Re-index after folding.
  const remap = new Int32Array(count).fill(-1);
  let next = 0;
  for (let r = 0; r < count; r++) if (cellCount[r] >= 4) remap[r] = next++;
  for (let i = 0; i < n; i++) {
    const r = ownership[i];
    if (r >= 0) ownership[i] = remap[r];
  }

  for (let r = 0; r < count; r++) {
    const id = remap[r];
    if (id < 0) continue;
    const cx = macroToWorldX(sumX[r] / cellCount[r]);
    const cz = macroToWorldZ(sumZ[r] / cellCount[r]);

    // Culture from the nearest weighted culture core.
    let culture = 0;
    let bestScore = Infinity;
    for (const cc of CULTURE_CORES) {
      const d = Math.hypot(cc.x - cx, cc.z - cz) / cc.reach;
      if (d < bestScore) {
        bestScore = d;
        culture = cc.culture;
      }
    }

    let dominantBiome = 0;
    let bestCount = -1;
    for (let b = 0; b < 64; b++) {
      if (biomeTally[r][b] > bestCount) {
        bestCount = biomeTally[r][b];
        dominantBiome = b;
      }
    }

    const nbList: number[] = [];
    for (const nb of neighbours[r]) {
      const m = remap[nb];
      if (m >= 0 && m !== id) nbList.push(m);
    }

    regions.push({
      id,
      name: forge.region(culture),
      continent: landOwner[Math.round(worldToMacroZ(cz)) * MACRO + Math.round(worldToMacroX(cx))] ?? -1,
      culture,
      capital: -1,
      area: cellCount[r] * CELL_AREA,
      cx,
      cz,
      color: REGION_PALETTE[colorIndex[r]],
      dominantBiome,
      population: 0,
      description: '',
      borders: [],
      settlementCount: 0,
      neighbours: nbList,
      character: biomeCharacter(dominantBiome),
    });
  }

  // --- Border geometry ----------------------------------------------------
  const toWorld = (gx: number, gy: number, out: [number, number]) => {
    out[0] = macroToWorldX(gx);
    out[1] = macroToWorldZ(gy);
  };
  const rawBorders = labelBoundaries(ownership, MACRO, toWorld);
  const stitched = stitchSegments(rawBorders, 0.5);
  const polished: Float32Array[] = [];
  for (const pl of stitched) {
    if (pl.length < 8) continue;
    polished.push(simplifyPolyline(smoothPolyline(pl, 2), 1.2));
  }

  // Attribute each polyline to the regions it separates, for the info panel.
  for (const pl of polished) {
    const mx = pl[Math.floor(pl.length / 4) * 2];
    const mz = pl[Math.floor(pl.length / 4) * 2 + 1];
    const gx = Math.round(worldToMacroX(mx));
    const gz = Math.round(worldToMacroZ(mz));
    const seen = new Set<number>();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const r = ownership[Math.min(MACRO - 1, Math.max(0, gz + dy)) * MACRO + Math.min(MACRO - 1, Math.max(0, gx + dx))];
        if (r >= 0) seen.add(r);
      }
    }
    for (const r of seen) regions[r]?.borders.push(pl);
  }

  // Flatten to a single segment buffer for one-draw-call rendering.
  let segCount = 0;
  for (const pl of polished) segCount += pl.length / 2 - 1;
  const borderSegments = new Float32Array(segCount * 4);
  let w = 0;
  for (const pl of polished) {
    for (let i = 0; i < pl.length / 2 - 1; i++) {
      borderSegments[w++] = pl[i * 2];
      borderSegments[w++] = pl[i * 2 + 1];
      borderSegments[w++] = pl[i * 2 + 2];
      borderSegments[w++] = pl[i * 2 + 3];
    }
  }

  void rng;
  void Rng;
  return { regions, cultures, ownership, borderSegments };
}
