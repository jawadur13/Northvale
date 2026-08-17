/**
 * Landform detection.
 *
 * Everything in here reads the finished terrain and finds the things a
 * cartographer would name: landmasses, summits, ranges, passes, plateaus,
 * valleys, cliffs, capes, bays, straits, glaciers, dune fields, forests and
 * wetlands. Nothing is placed by fiat - each feature is a measurable property of
 * the heightfield, which is why the labels end up agreeing with what you can see
 * under them.
 */

import { MACRO, MACRO_CELL_KM, SEA_LEVEL, macroToWorldX, macroToWorldZ } from '../../core/config';
import { Field } from '../../util/grid';
import { clamp01 } from '../../util/math';
import { Biome, BIOME_BY_ID } from './biomes';
import { BELTS, CORES, distToPolyline } from './layout';

const CELL_AREA = MACRO_CELL_KM * MACRO_CELL_KM;

export interface Component {
  id: number;
  cells: Int32Array;
  area: number;
  /** Centroid in world km. */
  cx: number;
  cz: number;
  /** minX, minZ, maxX, maxZ in world km. */
  bounds: [number, number, number, number];
  /** Extreme value of the driving field, and the cell it occurred at. */
  peakValue: number;
  peakCell: number;
  /** Longest axis in km, useful for telling a ridge from a blob. */
  spanKm: number;
}

/**
 * Flood-fills connected components of cells satisfying `test`.
 * 8-connected; components smaller than `minCells` are discarded.
 */
export function connectedComponents(
  test: (i: number) => boolean,
  value: (i: number) => number,
  minCells: number,
  maxComponents = 4000,
): Component[] {
  const n = MACRO * MACRO;
  const seen = new Uint8Array(n);
  const out: Component[] = [];
  const stack: number[] = [];

  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    seen[start] = 1;
    if (!test(start)) continue;

    const cells: number[] = [];
    let sx = 0;
    let sz = 0;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let peakValue = -Infinity;
    let peakCell = start;

    stack.length = 0;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const cx = c % MACRO;
      const cy = (c / MACRO) | 0;
      sx += cx;
      sz += cy;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minZ) minZ = cy;
      if (cy > maxZ) maxZ = cy;
      const v = value(c);
      if (v > peakValue) {
        peakValue = v;
        peakCell = c;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= MACRO) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= MACRO) continue;
          const ni = ny * MACRO + nx;
          if (seen[ni]) continue;
          seen[ni] = 1;
          if (test(ni)) stack.push(ni);
        }
      }
    }

    if (cells.length < minCells) continue;
    const wMinX = macroToWorldX(minX);
    const wMaxX = macroToWorldX(maxX);
    const wMinZ = macroToWorldZ(minZ);
    const wMaxZ = macroToWorldZ(maxZ);
    out.push({
      id: out.length,
      cells: Int32Array.from(cells),
      area: cells.length * CELL_AREA,
      cx: macroToWorldX(sx / cells.length),
      cz: macroToWorldZ(sz / cells.length),
      bounds: [wMinX, wMinZ, wMaxX, wMaxZ],
      peakValue,
      peakCell,
      spanKm: Math.hypot(wMaxX - wMinX, wMaxZ - wMinZ),
    });
    if (out.length >= maxComponents) break;
  }

  out.sort((a, b) => b.area - a.area);
  for (let i = 0; i < out.length; i++) out[i].id = i;
  return out;
}

export type LandmassClass = 'continent' | 'subcontinent' | 'major island' | 'island' | 'islet';

export interface Landmass extends Component {
  klass: LandmassClass;
  highestKm: number;
  /** Nearest authored core name, when the landmass is large enough to be a continent. */
  coreName: string | null;
  /** Length of its coastline in km. */
  coastKm: number;
}

export function findLandmasses(height: Field): { list: Landmass[]; owner: Int32Array } {
  const H = height.data;
  const comps = connectedComponents(
    (i) => H[i] > SEA_LEVEL,
    (i) => H[i],
    1,
    20000,
  );

  const owner = new Int32Array(MACRO * MACRO).fill(-1);
  const list: Landmass[] = [];

  for (const c of comps) {
    const area = c.area;
    let klass: LandmassClass;
    if (area > 900_000) klass = 'continent';
    else if (area > 260_000) klass = 'subcontinent';
    else if (area > 22_000) klass = 'major island';
    else if (area > 900) klass = 'island';
    else klass = 'islet';

    // Coastline length: count land cells adjacent to water, times cell edge.
    let coastCells = 0;
    for (let k = 0; k < c.cells.length; k++) {
      const i = c.cells[k];
      const x = i % MACRO;
      const y = (i / MACRO) | 0;
      if (
        height.at(x + 1, y) <= SEA_LEVEL ||
        height.at(x - 1, y) <= SEA_LEVEL ||
        height.at(x, y + 1) <= SEA_LEVEL ||
        height.at(x, y - 1) <= SEA_LEVEL
      ) {
        coastCells++;
      }
    }

    let coreName: string | null = null;
    if (klass === 'continent' || klass === 'subcontinent') {
      let best = Infinity;
      for (const core of CORES) {
        if (core.name === 'Neck') continue;
        const d = Math.hypot(core.x - c.cx, core.z - c.cz);
        if (d < best) {
          best = d;
          coreName = core.name;
        }
      }
    }

    const lm: Landmass = {
      ...c,
      id: list.length,
      klass,
      highestKm: c.peakValue,
      coreName,
      // The 1.35 factor accounts for the fractal detour a real coast takes
      // relative to the grid-aligned cell count.
      coastKm: coastCells * MACRO_CELL_KM * 1.35,
    };
    for (let k = 0; k < c.cells.length; k++) owner[c.cells[k]] = lm.id;
    list.push(lm);
  }

  return { list, owner };
}

export interface PeakCandidate {
  cell: number;
  x: number;
  z: number;
  elevationKm: number;
  /** Approximate topographic prominence in km. */
  prominence: number;
  /** Which authored belt it belongs to, or -1. */
  belt: number;
  volcanic: boolean;
}

/**
 * Finds summits as local maxima in a window, then estimates prominence by
 * comparing against the lowest point on the way to higher ground nearby.
 *
 * True prominence needs a full watershed walk; the windowed approximation ranks
 * summits correctly, which is all the label priority actually needs.
 */
export function findPeaks(
  height: Field,
  orogeny: Field,
  biome: Uint8Array,
  minElevationKm = 0.9,
  windowRadius = 4,
): PeakCandidate[] {
  const H = height.data;
  const out: PeakCandidate[] = [];

  for (let y = windowRadius; y < MACRO - windowRadius; y++) {
    for (let x = windowRadius; x < MACRO - windowRadius; x++) {
      const i = y * MACRO + x;
      const h = H[i];
      if (h < minElevationKm) continue;

      let isMax = true;
      for (let dy = -windowRadius; dy <= windowRadius && isMax; dy++) {
        for (let dx = -windowRadius; dx <= windowRadius; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nh = H[(y + dy) * MACRO + (x + dx)];
          // Strict on one side, loose on the other, so plateaus do not emit a
          // summit at every cell of a flat top.
          if (nh > h || (nh === h && (dy < 0 || (dy === 0 && dx < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;

      // Prominence proxy: drop to the lowest saddle within a broad ring.
      const R = 14;
      let lowest = h;
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2;
        const dx = Math.cos(ang);
        const dy = Math.sin(ang);
        let localMin = h;
        for (let r = 2; r <= R; r++) {
          const sx = Math.round(x + dx * r);
          const sy = Math.round(y + dy * r);
          if (sx < 0 || sy < 0 || sx >= MACRO || sy >= MACRO) break;
          const sh = H[sy * MACRO + sx];
          if (sh < localMin) localMin = sh;
          if (sh > h) break; // hit higher ground: this ray's saddle is found
        }
        if (localMin < lowest) lowest = localMin;
      }

      let belt = -1;
      let bestD = Infinity;
      const wx = macroToWorldX(x);
      const wz = macroToWorldZ(y);
      for (let b = 0; b < BELTS.length; b++) {
        const d = Math.sqrt(distToPolyline(wx, wz, BELTS[b].pts));
        if (d < BELTS[b].width * 2.4 && d < bestD) {
          bestD = d;
          belt = b;
        }
      }

      out.push({
        cell: i,
        x: wx,
        z: wz,
        elevationKm: h,
        prominence: h - lowest,
        belt,
        volcanic:
          biome[i] === Biome.Volcanic ||
          (belt >= 0 && BELTS[belt].kind === 'arc' && orogeny.data[i] > 0.2),
      });
    }
  }

  out.sort((a, b) => b.prominence * 0.6 + b.elevationKm - (a.prominence * 0.6 + a.elevationKm));
  return out;
}

export interface SaddleCandidate {
  cell: number;
  x: number;
  z: number;
  elevationKm: number;
  /** How much lower than the flanking summits, in km - a real gap scores high. */
  relief: number;
}

/**
 * Finds mountain passes: cells that are a minimum along the ridge and a maximum
 * across it. Detected by walking the 8-ring and counting sign alternations,
 * which is the standard discrete saddle test.
 */
export function findSaddles(height: Field, orogeny: Field, minElevationKm = 0.55): SaddleCandidate[] {
  const H = height.data;
  const RING_X = [1, 1, 0, -1, -1, -1, 0, 1];
  const RING_Y = [0, 1, 1, 1, 0, -1, -1, -1];
  const out: SaddleCandidate[] = [];

  for (let y = 2; y < MACRO - 2; y++) {
    for (let x = 2; x < MACRO - 2; x++) {
      const i = y * MACRO + x;
      const h = H[i];
      if (h < minElevationKm) continue;
      if (orogeny.data[i] < 0.12) continue;

      let alternations = 0;
      let prevHigher = H[(y + RING_Y[7]) * MACRO + (x + RING_X[7])] > h;
      for (let k = 0; k < 8; k++) {
        const higher = H[(y + RING_Y[k]) * MACRO + (x + RING_X[k])] > h;
        if (higher !== prevHigher) alternations++;
        prevHigher = higher;
      }
      // A simple summit or pit has 0 alternations; a slope has 2; a saddle has 4+.
      if (alternations < 4) continue;

      // Relief: how far below the flanking high ground this gap sits.
      let flankMax = h;
      for (let r = 2; r <= 8; r++) {
        for (let a = 0; a < 8; a++) {
          const sx = x + RING_X[a] * r;
          const sy = y + RING_Y[a] * r;
          if (sx < 0 || sy < 0 || sx >= MACRO || sy >= MACRO) continue;
          const sh = H[sy * MACRO + sx];
          if (sh > flankMax) flankMax = sh;
        }
      }
      const relief = flankMax - h;
      if (relief < 0.4) continue;

      out.push({ cell: i, x: macroToWorldX(x), z: macroToWorldZ(y), elevationKm: h, relief });
    }
  }

  out.sort((a, b) => b.relief - a.relief);
  return out;
}

/**
 * Fraction of cells within `radius` that are water. High values on land mark
 * capes and peninsulas; high land fractions in water mark bays and gulfs.
 */
export function waterSurroundField(height: Field, radius: number): Field {
  const H = height.data;
  const mask = new Field(MACRO);
  for (let i = 0; i < MACRO * MACRO; i++) mask.data[i] = H[i] <= SEA_LEVEL ? 1 : 0;
  // A box blur of the water mask *is* the local water fraction.
  mask.blur(radius, 2);
  return mask;
}

export interface StraitCandidate {
  cell: number;
  x: number;
  z: number;
  /** Width of the narrows in km. */
  widthKm: number;
  /** Open water length along the passage in km. */
  lengthKm: number;
}

/**
 * Finds narrow water passages: a water cell where land is close in two opposite
 * directions while the perpendicular axis stays open.
 */
export function findStraits(height: Field, maxWidthKm = 90): StraitCandidate[] {
  const H = height.data;
  const maxCells = Math.ceil(maxWidthKm / MACRO_CELL_KM);
  const openCells = Math.ceil(160 / MACRO_CELL_KM);
  const out: StraitCandidate[] = [];
  // Four axes: E-W, NE-SW, N-S, NW-SE.
  const AX = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];

  const rayToLand = (x: number, y: number, dx: number, dy: number, limit: number): number => {
    for (let r = 1; r <= limit; r++) {
      const sx = x + dx * r;
      const sy = y + dy * r;
      if (sx < 0 || sy < 0 || sx >= MACRO || sy >= MACRO) return limit + 1;
      if (H[sy * MACRO + sx] > SEA_LEVEL) return r;
    }
    return limit + 1;
  };

  // Step by 3 cells: straits are broad enough that a full scan is wasted work.
  for (let y = 4; y < MACRO - 4; y += 3) {
    for (let x = 4; x < MACRO - 4; x += 3) {
      const i = y * MACRO + x;
      if (H[i] > SEA_LEVEL) continue;

      let bestWidth = Infinity;
      let bestAxis = -1;
      for (let a = 0; a < 4; a++) {
        const [dx, dy] = AX[a];
        const w = rayToLand(x, y, dx, dy, maxCells) + rayToLand(x, y, -dx, -dy, maxCells);
        if (w < bestWidth) {
          bestWidth = w;
          bestAxis = a;
        }
      }
      if (bestAxis < 0 || bestWidth > maxCells) continue;

      // The perpendicular axis must be open, otherwise this is a cove not a strait.
      const perp = AX[(bestAxis + 2) % 4];
      const openA = rayToLand(x, y, perp[0], perp[1], openCells);
      const openB = rayToLand(x, y, -perp[0], -perp[1], openCells);
      const open = openA + openB;
      if (open < openCells * 1.4) continue;

      out.push({
        cell: i,
        x: macroToWorldX(x),
        z: macroToWorldZ(y),
        widthKm: bestWidth * MACRO_CELL_KM,
        lengthKm: open * MACRO_CELL_KM,
      });
    }
  }

  out.sort((a, b) => a.widthKm - b.widthKm);
  return out;
}

/** Spatial thinning: keeps the highest-priority candidates at least `minDist` km apart. */
export function thin<T extends { x: number; z: number }>(items: T[], minDist: number, limit: number): T[] {
  const kept: T[] = [];
  const cell = minDist;
  const buckets = new Map<string, T[]>();
  const key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const min2 = minDist * minDist;

  for (const it of items) {
    if (kept.length >= limit) break;
    const bx = Math.floor(it.x / cell);
    const bz = Math.floor(it.z / cell);
    let clash = false;
    for (let dz = -1; dz <= 1 && !clash; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = buckets.get(`${bx + dx},${bz + dz}`);
        if (!b) continue;
        for (const o of b) {
          const ddx = o.x - it.x;
          const ddz = o.z - it.z;
          if (ddx * ddx + ddz * ddz < min2) {
            clash = true;
            break;
          }
        }
        if (clash) break;
      }
    }
    if (clash) continue;
    kept.push(it);
    const k = key(it.x, it.z);
    const arr = buckets.get(k);
    if (arr) arr.push(it);
    else buckets.set(k, [it]);
  }
  return kept;
}

export interface LandformSet {
  landmasses: Landmass[];
  landOwner: Int32Array;
  peaks: PeakCandidate[];
  saddles: SaddleCandidate[];
  ranges: Component[];
  plateaus: Component[];
  valleys: Component[];
  cliffs: Component[];
  glaciers: Component[];
  duneFields: Component[];
  forests: Component[];
  wetlands: Component[];
  badlands: Component[];
  saltFlats: Component[];
  straits: StraitCandidate[];
  waterFraction: Field;
  landFraction: Field;
  /** Local relief: max minus min elevation in a 9-cell window, in km. */
  relief: Field;
}

export function analyseLandforms(
  height: Field,
  orogeny: Field,
  slope: Field,
  biome: Uint8Array,
  coastDistance: Field,
): LandformSet {
  const H = height.data;
  const n = MACRO * MACRO;

  const { list: landmasses, owner: landOwner } = findLandmasses(height);
  const peaks = findPeaks(height, orogeny, biome);
  const saddles = findSaddles(height, orogeny);

  // Local relief drives "is this rugged" decisions everywhere downstream.
  const relief = new Field(MACRO);
  for (let y = 0; y < MACRO; y++) {
    for (let x = 0; x < MACRO; x++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const v = height.at(x + dx, y + dy);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      relief.data[y * MACRO + x] = hi - lo;
    }
  }

  const ranges = connectedComponents(
    (i) => H[i] > 1.05 && orogeny.data[i] > 0.13,
    (i) => H[i],
    36,
    600,
  );

  const plateaus = connectedComponents(
    (i) => H[i] > 0.66 && slope.data[i] < 0.115 && relief.data[i] < 0.26,
    (i) => H[i],
    48,
    500,
  );

  // A valley cell sits low with high ground on at least two sides nearby.
  const valleyMask = new Uint8Array(n);
  for (let y = 6; y < MACRO - 6; y++) {
    for (let x = 6; x < MACRO - 6; x++) {
      const i = y * MACRO + x;
      const h = H[i];
      if (h <= SEA_LEVEL || h > 2.4) continue;
      if (slope.data[i] > 0.24) continue;
      let higherDirs = 0;
      let totalRise = 0;
      const DIRS = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ];
      for (const [dx, dy] of DIRS) {
        let maxRise = 0;
        for (let r = 2; r <= 6; r++) {
          const sh = height.at(x + dx * r, y + dy * r);
          if (sh - h > maxRise) maxRise = sh - h;
        }
        if (maxRise > 0.42) higherDirs++;
        totalRise += maxRise;
      }
      if (higherDirs >= 3 && totalRise > 1.7) valleyMask[i] = 1;
    }
  }
  const valleys = connectedComponents((i) => valleyMask[i] === 1, (i) => -H[i], 40, 500);

  const cliffs = connectedComponents(
    (i) => slope.data[i] > 0.54 && relief.data[i] > 0.44,
    (i) => relief.data[i],
    6,
    900,
  );

  const glaciers = connectedComponents(
    (i) => biome[i] === Biome.Glacier || biome[i] === Biome.IceSheet,
    (i) => H[i],
    24,
    300,
  );

  const duneFields = connectedComponents((i) => biome[i] === Biome.DuneSea, (i) => H[i], 30, 260);

  const forests = connectedComponents(
    (i) => {
      const d = BIOME_BY_ID[biome[i]];
      return !!d && d.group === 'forest';
    },
    (i) => H[i],
    120,
    600,
  );

  const wetlands = connectedComponents(
    (i) => biome[i] === Biome.Marsh || biome[i] === Biome.Swamp || biome[i] === Biome.Mangrove,
    (i) => -H[i],
    30,
    400,
  );

  const badlands = connectedComponents((i) => biome[i] === Biome.Badlands, (i) => relief.data[i], 40, 150);
  const saltFlats = connectedComponents((i) => biome[i] === Biome.Salt, (i) => -H[i], 25, 150);

  const waterFraction = waterSurroundField(height, 6);
  const landFraction = new Field(MACRO);
  for (let i = 0; i < n; i++) landFraction.data[i] = 1 - waterFraction.data[i];

  const straits = findStraits(height);
  void coastDistance;

  return {
    landmasses,
    landOwner,
    peaks,
    saddles,
    ranges,
    plateaus,
    valleys,
    cliffs,
    glaciers,
    duneFields,
    forests,
    wetlands,
    badlands,
    saltFlats,
    straits,
    waterFraction,
    landFraction,
    relief,
  };
}

/** Local water-surround maximum: the tip of a headland. */
export function findCapes(height: Field, waterFraction: Field, minFraction = 0.6): PeakCandidate[] {
  const H = height.data;
  const W = waterFraction.data;
  const out: PeakCandidate[] = [];
  for (let y = 5; y < MACRO - 5; y++) {
    for (let x = 5; x < MACRO - 5; x++) {
      const i = y * MACRO + x;
      if (H[i] <= SEA_LEVEL) continue;
      const w = W[i];
      if (w < minFraction) continue;
      let isMax = true;
      for (let dy = -4; dy <= 4 && isMax; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ni = (y + dy) * MACRO + (x + dx);
          if (H[ni] > SEA_LEVEL && W[ni] > w) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      out.push({
        cell: i,
        x: macroToWorldX(x),
        z: macroToWorldZ(y),
        elevationKm: H[i],
        prominence: clamp01(w),
        belt: -1,
        volcanic: false,
      });
    }
  }
  out.sort((a, b) => b.prominence - a.prominence);
  return out;
}
