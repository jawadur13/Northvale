/**
 * Hydrology: where water goes, and what that does to the land.
 *
 * This is the module that makes the world believable. Rivers are not drawn on
 * top of the terrain - they are *derived from* it by actual flow routing, and
 * then they cut their own valleys back into it:
 *
 *  1. Priority-flood depression filling produces a surface with no interior
 *     sinks, and identifies every lake as a by-product.
 *  2. D8 steepest descent gives each land cell a downstream neighbour.
 *  3. Accumulating drainage area in reverse fill order (which is already sorted
 *     by elevation, so it costs nothing) yields discharge for every cell.
 *  4. Channels above a discharge threshold are traced into named river systems,
 *     each following its largest tributary upstream to a single headwater.
 *  5. The channels are carved back into the elevation, which is what produces
 *     dendritic valley networks, gorges and river gaps through ranges.
 *
 * Because step 5 changes the terrain, the whole thing runs twice.
 */

import { MACRO, MACRO_CELL_KM, SEA_LEVEL, macroToWorldX, macroToWorldZ } from '../../core/config';
import { Field } from '../../util/grid';
import { MinHeap } from '../../util/heap';
import { clamp, clamp01 } from '../../util/math';

const CELL_AREA = MACRO_CELL_KM * MACRO_CELL_KM;

/** Minimum drainage area (km^2) for a cell to be drawn as a river. */
export const RIVER_MIN_AREA = 780;
/** Minimum drainage area for a river system to be named in the gazetteer. */
export const RIVER_NAME_AREA = 9000;
/** Minimum lake area (km^2) to be treated as a lake rather than a puddle. */
export const LAKE_MIN_AREA = CELL_AREA * 3;

const N8X = [1, 1, 0, -1, -1, -1, 0, 1];
const N8Y = [0, 1, 1, 1, 0, -1, -1, -1];
const N8L = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

export interface LakeInfo {
  id: number;
  /** Water surface elevation in km. */
  level: number;
  area: number;
  cx: number;
  cz: number;
  maxDepth: number;
  cells: Int32Array;
  /** Outlet cell index, or -1 if endorheic (no outflow - a salt lake). */
  outlet: number;
  endorheic: boolean;
}

export interface RiverPath {
  /** Cell indices from headwater to mouth. */
  cells: Int32Array;
  /** Drainage area at each cell, km^2. */
  flow: Float32Array;
  /** Where it ends: the ocean, a lake, or a desert sink. */
  terminus: 'ocean' | 'lake' | 'sink';
  /** Lake id when terminus is a lake. */
  lakeId: number;
  /** Total length in km. */
  length: number;
  /** Index of the river this one flows into, or -1 for a trunk river. */
  parent: number;
  /** Strahler-ish rank: 0 for trunk rivers, 1 for their tributaries, etc. */
  depth: number;
}

export interface HydrologyResult {
  filled: Field;
  flow: Field;
  downstream: Int32Array;
  /** Cells in ascending filled-elevation order. */
  order: Int32Array;
  lakeId: Int32Array;
  lakes: LakeInfo[];
  /** Water surface elevation per cell; equals SEA_LEVEL over ocean, lake level in lakes, NaN on dry land. */
  waterSurface: Float32Array;
  rivers: RiverPath[];
  isRiver: Uint8Array;
  /** 0..1 proximity to standing or flowing water, used for wetland classification. */
  waterTable: Field;
}

/**
 * Priority-flood depression filling (Barnes et al.), seeded from the ocean and
 * the map border. Returns the filled surface plus the order cells were resolved
 * in, which doubles as a topological sort for flow accumulation.
 */
function fillDepressions(height: Field): { filled: Field; order: Int32Array } {
  const n = MACRO * MACRO;
  const filled = new Field(MACRO);
  const F = filled.data;
  const H = height.data;
  F.fill(Infinity);

  const closed = new Uint8Array(n);
  const heap = new MinHeap(1 << 18);
  const order = new Int32Array(n);
  let orderCount = 0;

  // Seed: every ocean cell, plus the map border so nothing drains off-world.
  for (let i = 0; i < n; i++) {
    const x = i % MACRO;
    const y = (i / MACRO) | 0;
    const isBorder = x === 0 || y === 0 || x === MACRO - 1 || y === MACRO - 1;
    if (H[i] <= SEA_LEVEL || isBorder) {
      F[i] = H[i];
      closed[i] = 1;
      heap.push(H[i], i);
    }
  }

  // Tiny per-step increment guarantees a strictly downhill path out of every basin.
  const EPS = 1e-6;

  while (heap.size > 0) {
    const c = heap.pop();
    order[orderCount++] = c;
    const cx = c % MACRO;
    const cy = (c / MACRO) | 0;
    const cf = F[c];
    for (let k = 0; k < 8; k++) {
      const nx = cx + N8X[k];
      const ny = cy + N8Y[k];
      if (nx < 0 || ny < 0 || nx >= MACRO || ny >= MACRO) continue;
      const ni = ny * MACRO + nx;
      if (closed[ni]) continue;
      closed[ni] = 1;
      const nh = H[ni];
      F[ni] = nh > cf + EPS ? nh : cf + EPS;
      heap.push(F[ni], ni);
    }
  }

  return { filled, order: orderCount === n ? order : order.slice(0, orderCount) };
}

/** D8 steepest descent on the filled surface. */
function routeFlow(filled: Field): Int32Array {
  const n = MACRO * MACRO;
  const down = new Int32Array(n).fill(-1);
  const F = filled.data;
  for (let y = 0; y < MACRO; y++) {
    for (let x = 0; x < MACRO; x++) {
      const i = y * MACRO + x;
      const h = F[i];
      let best = -1;
      let bestSlope = 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + N8X[k];
        const ny = y + N8Y[k];
        if (nx < 0 || ny < 0 || nx >= MACRO || ny >= MACRO) continue;
        const ni = ny * MACRO + nx;
        const slope = (h - F[ni]) / N8L[k];
        if (slope > bestSlope) {
          bestSlope = slope;
          best = ni;
        }
      }
      down[i] = best;
    }
  }
  return down;
}

/** Drainage area per cell, accumulated in reverse fill order. */
function accumulate(order: Int32Array, down: Int32Array): Field {
  const flow = new Field(MACRO).fill(CELL_AREA);
  const A = flow.data;
  for (let i = order.length - 1; i >= 0; i--) {
    const c = order[i];
    const d = down[c];
    if (d >= 0) A[d] += A[c];
  }
  return flow;
}

/** Groups cells whose fill raised them above the original terrain into lakes. */
function findLakes(height: Field, filled: Field, down: Int32Array): { lakes: LakeInfo[]; lakeId: Int32Array } {
  const n = MACRO * MACRO;
  const H = height.data;
  const F = filled.data;
  const lakeId = new Int32Array(n).fill(-1);
  const lakes: LakeInfo[] = [];
  const stack: number[] = [];
  const MIN_DEPTH = 0.004; // 4 m of standing water

  for (let start = 0; start < n; start++) {
    if (lakeId[start] !== -1) continue;
    if (H[start] <= SEA_LEVEL) continue;
    if (F[start] - H[start] < MIN_DEPTH) continue;

    const id = lakes.length;
    const cells: number[] = [];
    let levelSum = 0;
    let maxDepth = 0;
    let sx = 0;
    let sz = 0;
    stack.length = 0;
    stack.push(start);
    lakeId[start] = id;

    // Flood the connected pool. Cells belong together when their filled
    // surfaces agree to within a few metres - that is the lake's water plane.
    const refLevel = F[start];
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const depth = F[c] - H[c];
      if (depth > maxDepth) maxDepth = depth;
      levelSum += F[c];
      const cx = c % MACRO;
      const cy = (c / MACRO) | 0;
      sx += cx;
      sz += cy;
      for (let k = 0; k < 8; k++) {
        const nx = cx + N8X[k];
        const ny = cy + N8Y[k];
        if (nx < 0 || ny < 0 || nx >= MACRO || ny >= MACRO) continue;
        const ni = ny * MACRO + nx;
        if (lakeId[ni] !== -1) continue;
        if (H[ni] <= SEA_LEVEL) continue;
        if (F[ni] - H[ni] < MIN_DEPTH) continue;
        if (Math.abs(F[ni] - refLevel) > 0.02) continue;
        lakeId[ni] = id;
        stack.push(ni);
      }
    }

    const area = cells.length * CELL_AREA;
    if (area < LAKE_MIN_AREA) {
      for (const c of cells) lakeId[c] = -2; // too small: treated as marsh, not lake
      continue;
    }

    // The outlet is the lake cell that drains to a non-lake cell.
    let outlet = -1;
    for (const c of cells) {
      const d = down[c];
      if (d >= 0 && lakeId[d] !== id) {
        outlet = c;
        break;
      }
    }

    lakes.push({
      id,
      level: levelSum / cells.length,
      area,
      cx: macroToWorldX(sx / cells.length),
      cz: macroToWorldZ(sz / cells.length),
      maxDepth,
      cells: Int32Array.from(cells),
      outlet,
      endorheic: outlet === -1,
    });
  }

  // Reindex, since undersized pools were dropped.
  for (let i = 0; i < n; i++) if (lakeId[i] === -2) lakeId[i] = -1;
  return { lakes, lakeId };
}

/**
 * Traces the channel network into discrete river paths.
 *
 * Each path runs from a single headwater to a mouth, always following the
 * largest tributary upstream at a confluence. That means the longest, highest
 * discharge line through a basin becomes the main river and the smaller
 * branches become separately named tributaries - which is how real river
 * systems are actually named.
 */
function traceRivers(
  height: Field,
  flow: Field,
  down: Int32Array,
  lakeId: Int32Array,
): { rivers: RiverPath[]; isRiver: Uint8Array } {
  const n = MACRO * MACRO;
  const A = flow.data;
  const H = height.data;
  const isRiver = new Uint8Array(n);

  // Channel cells: enough discharge, above sea level, not inside a lake.
  const channel = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (A[i] >= RIVER_MIN_AREA && H[i] > SEA_LEVEL && lakeId[i] === -1) channel[i] = 1;
  }

  // Upstream adjacency, stored as head/next linked lists to avoid array-of-arrays.
  const head = new Int32Array(n).fill(-1);
  const next = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!channel[i]) continue;
    const d = down[i];
    if (d < 0) continue;
    next[i] = head[d];
    head[d] = i;
  }

  // Mouths: channel cells whose downstream is not a channel.
  const mouths: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!channel[i]) continue;
    const d = down[i];
    if (d < 0 || !channel[d]) mouths.push(i);
  }
  mouths.sort((a, b) => A[b] - A[a]);

  const claimed = new Uint8Array(n);
  // Which river owns each claimed cell, so confluence attribution is O(1).
  const owner = new Int32Array(n).fill(-1);
  const rivers: RiverPath[] = [];

  /** Walks upstream from `mouth`, always taking the biggest unclaimed feeder. */
  const walkUp = (mouth: number): number[] => {
    const path: number[] = [mouth];
    let cur = mouth;
    for (;;) {
      let best = -1;
      let bestFlow = 0;
      for (let u = head[cur]; u !== -1; u = next[u]) {
        if (claimed[u]) continue;
        if (A[u] > bestFlow) {
          bestFlow = A[u];
          best = u;
        }
      }
      if (best === -1) break;
      path.push(best);
      cur = best;
    }
    path.reverse(); // headwater -> mouth
    return path;
  };

  const makePath = (cells: number[], parent: number, depth: number): RiverPath | null => {
    if (cells.length < 3) return null;
    let length = 0;
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1];
      const b = cells[i];
      const dx = (b % MACRO) - (a % MACRO);
      const dy = ((b / MACRO) | 0) - ((a / MACRO) | 0);
      length += Math.hypot(dx, dy) * MACRO_CELL_KM;
    }
    const mouth = cells[cells.length - 1];
    const out = down[mouth];
    let terminus: RiverPath['terminus'] = 'sink';
    let lake = -1;
    if (out < 0) terminus = 'sink';
    else if (H[out] <= SEA_LEVEL) terminus = 'ocean';
    else if (lakeId[out] >= 0) {
      terminus = 'lake';
      lake = lakeId[out];
    }
    const fl = new Float32Array(cells.length);
    for (let i = 0; i < cells.length; i++) fl[i] = A[cells[i]];
    return { cells: Int32Array.from(cells), flow: fl, terminus, lakeId: lake, length, parent, depth };
  };

  // Trunk rivers first, from the largest mouth down.
  for (const m of mouths) {
    if (claimed[m]) continue;
    const path = walkUp(m);
    for (const c of path) claimed[c] = 1;
    const rp = makePath(path, -1, 0);
    if (rp) {
      const id = rivers.length;
      for (const c of path) owner[c] = id;
      rivers.push(rp);
    }
  }

  // Then tributaries, breadth-first by generation so naming reads sensibly.
  // A tributary starts at an unclaimed channel cell with no unclaimed feeders
  // above it and runs down until it meets an already-claimed channel.
  for (let generation = 1; generation < 7; generation++) {
    const candidates: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!channel[i] || claimed[i]) continue;
      let hasUnclaimedFeeder = false;
      for (let u = head[i]; u !== -1; u = next[u]) {
        if (!claimed[u]) {
          hasUnclaimedFeeder = true;
          break;
        }
      }
      if (!hasUnclaimedFeeder) candidates.push(i);
    }
    if (!candidates.length) break;
    // Biggest tributaries claim their course first.
    candidates.sort((a, b) => A[b] - A[a]);

    let added = 0;
    for (const start of candidates) {
      if (claimed[start]) continue;
      const path: number[] = [];
      let cur = start;
      let parentRiver = -1;
      while (cur >= 0 && channel[cur] && !claimed[cur]) {
        path.push(cur);
        claimed[cur] = 1;
        cur = down[cur];
      }
      if (cur >= 0 && claimed[cur] && channel[cur]) {
        parentRiver = owner[cur];
        path.push(cur); // include the junction so ribbons connect
      }
      const rp = makePath(path, parentRiver, generation);
      if (rp) {
        const id = rivers.length;
        for (const c of path) if (owner[c] === -1) owner[c] = id;
        rivers.push(rp);
        added++;
      }
    }
    if (!added) break;
  }

  for (let i = 0; i < n; i++) if (channel[i]) isRiver[i] = 1;
  return { rivers, isRiver };
}

/**
 * Cuts the channel network into the terrain.
 *
 * Depth scales with discharge, so headwater streams leave a notch and trunk
 * rivers open a broad valley. The carve field is blurred before subtraction,
 * which turns a one-cell-wide channel into a V-shaped valley with shoulders -
 * exactly the dendritic texture that reads as an eroded landscape.
 */
function carveValleys(height: Field, flow: Field, isRiver: Uint8Array, orogeny: Field, strength: number): void {
  const n = MACRO * MACRO;
  const H = height.data;
  const A = flow.data;
  const carve = new Field(MACRO);
  const C = carve.data;

  for (let i = 0; i < n; i++) {
    if (!isRiver[i]) continue;
    const h = H[i];
    if (h <= SEA_LEVEL) continue;
    // Larger basins cut deeper, but never below sea level.
    const q = Math.pow(A[i] / RIVER_MIN_AREA, 0.34);
    // Steep, high, freshly uplifted ground gives gorges; lowland gives broad floodplains.
    const gorge = 1 + orogeny.data[i] * 1.5 + clamp01(h / 2.2) * 0.6;
    C[i] = Math.min(h * 0.62, 0.028 * q * gorge * strength);
  }

  // Two blur passes at different radii: a tight inner channel and a wide valley.
  const wide = carve.clone().blur(3, 2);
  carve.blur(1, 1);

  for (let i = 0; i < n; i++) {
    const cut = C[i] * 0.75 + wide.data[i] * 1.9;
    if (cut <= 0) continue;
    const h = H[i];
    if (h <= SEA_LEVEL) continue;
    H[i] = Math.max(SEA_LEVEL + 0.0015, h - cut);
  }
}

/** Distance-weighted proximity to any water, used to place marshes and to score settlements. */
function buildWaterTable(height: Field, isRiver: Uint8Array, lakeId: Int32Array): Field {
  const n = MACRO * MACRO;
  const wt = new Field(MACRO);
  const W = wt.data;
  const H = height.data;
  for (let i = 0; i < n; i++) {
    if (H[i] <= SEA_LEVEL || isRiver[i] || lakeId[i] >= 0) W[i] = 1;
  }
  wt.blur(3, 2);
  for (let i = 0; i < n; i++) W[i] = clamp01(W[i] * 2.4);
  return wt;
}

export function generateHydrology(height: Field, orogeny: Field, iterations = 2): HydrologyResult {
  let filled!: Field;
  let order!: Int32Array;
  let down!: Int32Array;
  let flow!: Field;
  let lakes!: LakeInfo[];
  let lakeId!: Int32Array;
  let rivers!: RiverPath[];
  let isRiver!: Uint8Array;

  for (let pass = 0; pass < iterations; pass++) {
    const f = fillDepressions(height);
    filled = f.filled;
    order = f.order;
    down = routeFlow(filled);
    flow = accumulate(order, down);
    const l = findLakes(height, filled, down);
    lakes = l.lakes;
    lakeId = l.lakeId;
    const t = traceRivers(height, flow, down, lakeId);
    rivers = t.rivers;
    isRiver = t.isRiver;

    // Carve on every pass but the last, then re-derive from the eroded surface.
    if (pass < iterations - 1) {
      carveValleys(height, flow, isRiver, orogeny, pass === 0 ? 1 : 0.55);
    }
  }

  // Water surface: sea level over ocean, lake level inside lakes, NaN elsewhere.
  const n = MACRO * MACRO;
  const waterSurface = new Float32Array(n);
  const H = height.data;
  for (let i = 0; i < n; i++) {
    if (H[i] <= SEA_LEVEL) waterSurface[i] = SEA_LEVEL;
    else if (lakeId[i] >= 0) waterSurface[i] = lakes[lakeId[i]].level;
    else waterSurface[i] = NaN;
  }

  const waterTable = buildWaterTable(height, isRiver, lakeId);

  return { filled, flow, downstream: down, order, lakeId, lakes, waterSurface, rivers, isRiver, waterTable };
}

/** Channel half-width in km from drainage area, for ribbon geometry. */
export function riverHalfWidth(areaKm2: number): number {
  return clamp(0.055 * Math.pow(areaKm2 / 1000, 0.46), 0.09, 3.4);
}
