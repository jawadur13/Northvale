/**
 * The road network.
 *
 * Roads are pathfound, not drawn. Each route is an A* search over a cost surface
 * built from gradient, biome traversability and river crossings, so roads climb
 * valleys instead of ridges, hug coastlines, thread the passes and detour around
 * marsh. Two details do most of the work in making the result look like a real
 * network rather than a bundle of independent lines:
 *
 *  - **Route reuse.** Cells already carrying a road are discounted heavily, so
 *    later routes converge onto earlier ones and trunk roads emerge, complete
 *    with junction towns.
 *  - **Importance ordering.** Routes are pathed from the most important pair of
 *    settlements downward, so the trunk lines are laid before the lanes and the
 *    lanes are the ones that bend to meet them.
 *
 * Pathfinding runs on a half-resolution grid; road geometry is smoothed
 * afterwards, so the coarser grid costs nothing visually and saves roughly a
 * factor of four in search.
 */

import { MACRO, MACRO_CELL_KM, SEA_LEVEL, HALF_KM, WORLD_KM } from '../../core/config';
import { Field } from '../../util/grid';
import { MinHeap } from '../../util/heap';
import { clamp01 } from '../../util/math';
import { rngFor } from '../../util/rng';
import { BIOME_BY_ID, Biome } from './biomes';
import type { ClimateResult } from './climate';
import type { HydrologyResult } from './hydrology';
import type { Settlement } from './settlements';

/** Pathfinding grid resolution. */
const NAV = 512;
const NAV_CELL_KM = WORLD_KM / NAV;

export type RoadClass = 'highway' | 'road' | 'track' | 'caravan' | 'lane';

export interface RoadPath {
  /** Flattened world-space x,z pairs. */
  pts: Float32Array;
  klass: RoadClass;
  /** Settlement indices at each end. */
  a: number;
  b: number;
  lengthKm: number;
}

export interface BridgeSite {
  x: number;
  z: number;
  /** Drainage area of the river being crossed, km^2. */
  flow: number;
  /** Span in km, from the river's width. */
  spanKm: number;
}

export interface RoadResult {
  roads: RoadPath[];
  bridges: BridgeSite[];
  /** Traffic per nav cell, used for road width and for junction detection. */
  traffic: Float32Array;
  /** Nav-grid cells carrying a road, in world coordinates, for crossroads placement. */
  junctions: Array<{ x: number; z: number; degree: number }>;
}

function navToWorld(i: number): [number, number] {
  const x = i % NAV;
  const y = (i / NAV) | 0;
  return [(x / (NAV - 1)) * WORLD_KM - HALF_KM, (y / (NAV - 1)) * WORLD_KM - HALF_KM];
}

function worldToNav(x: number, z: number): number {
  const gx = Math.round(((x + HALF_KM) / WORLD_KM) * (NAV - 1));
  const gy = Math.round(((z + HALF_KM) / WORLD_KM) * (NAV - 1));
  const cx = gx < 0 ? 0 : gx > NAV - 1 ? NAV - 1 : gx;
  const cy = gy < 0 ? 0 : gy > NAV - 1 ? NAV - 1 : gy;
  return cy * NAV + cx;
}

/** Downsamples a macro field onto the nav grid by taking the mean. */
function downsample(field: Field): Float32Array {
  const out = new Float32Array(NAV * NAV);
  const ratio = MACRO / NAV;
  for (let y = 0; y < NAV; y++) {
    for (let x = 0; x < NAV; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = 0; dy < ratio; dy++) {
        for (let dx = 0; dx < ratio; dx++) {
          sum += field.at(x * ratio + dx, y * ratio + dy);
          count++;
        }
      }
      out[y * NAV + x] = sum / count;
    }
  }
  return out;
}

function downsampleMax(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(NAV * NAV);
  const ratio = MACRO / NAV;
  for (let y = 0; y < NAV; y++) {
    for (let x = 0; x < NAV; x++) {
      let m = 0;
      for (let dy = 0; dy < ratio; dy++) {
        for (let dx = 0; dx < ratio; dx++) {
          const v = data[(y * ratio + dy) * MACRO + (x * ratio + dx)];
          if (v > m) m = v;
        }
      }
      out[y * NAV + x] = m;
    }
  }
  return out;
}

function downsampleMode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(NAV * NAV);
  const ratio = MACRO / NAV;
  const tally = new Int32Array(64);
  for (let y = 0; y < NAV; y++) {
    for (let x = 0; x < NAV; x++) {
      tally.fill(0);
      for (let dy = 0; dy < ratio; dy++) {
        for (let dx = 0; dx < ratio; dx++) {
          tally[data[(y * ratio + dy) * MACRO + (x * ratio + dx)] & 63]++;
        }
      }
      let best = 0;
      let bestCount = -1;
      for (let b = 0; b < 64; b++) {
        if (tally[b] > bestCount) {
          bestCount = tally[b];
          best = b;
        }
      }
      out[y * NAV + x] = best;
    }
  }
  return out;
}

/**
 * A* over the nav grid, reusing its scratch buffers across calls via a run
 * stamp so no allocation or clearing happens per route.
 */
class RoadPathfinder {
  private g = new Float32Array(NAV * NAV);
  private from = new Int32Array(NAV * NAV);
  private stamp = new Int32Array(NAV * NAV);
  private closed = new Int32Array(NAV * NAV);
  private run = 0;
  private heap = new MinHeap(1 << 16);

  private readonly NX = [1, -1, 0, 0, 1, 1, -1, -1];
  private readonly NY = [0, 0, 1, -1, 1, -1, 1, -1];
  private readonly NL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

  constructor(
    private cost: Float32Array,
    /** Extra multiplier applied to cells that already carry a road. */
    private discount: Float32Array,
  ) {}

  /**
   * @param maxCost abandon the search past this accumulated cost
   * @param weight heuristic weight; >1 trades a little optimality for a lot of speed
   */
  find(start: number, goal: number, maxCost: number, weight = 1.45): Int32Array | null {
    this.run++;
    const run = this.run;
    const { g, from, stamp, closed, cost, discount } = this;
    const heap = this.heap;
    heap.clear();

    const gx = goal % NAV;
    const gy = (goal / NAV) | 0;
    const h = (i: number) => {
      const dx = (i % NAV) - gx;
      const dy = ((i / NAV) | 0) - gy;
      return Math.hypot(dx, dy) * weight;
    };

    g[start] = 0;
    from[start] = -1;
    stamp[start] = run;
    heap.push(h(start), start);

    let found = false;
    while (heap.size > 0) {
      const c = heap.pop();
      if (closed[c] === run) continue;
      closed[c] = run;
      if (c === goal) {
        found = true;
        break;
      }
      const gc = g[c];
      if (gc > maxCost) continue;
      const cx = c % NAV;
      const cy = (c / NAV) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + this.NX[k];
        const ny = cy + this.NY[k];
        if (nx < 0 || ny < 0 || nx >= NAV || ny >= NAV) continue;
        const ni = ny * NAV + nx;
        if (closed[ni] === run) continue;
        const step = cost[ni] * discount[ni] * this.NL[k];
        const ng = gc + step;
        if (stamp[ni] !== run || ng < g[ni]) {
          stamp[ni] = run;
          g[ni] = ng;
          from[ni] = c;
          heap.push(ng + h(ni), ni);
        }
      }
    }

    if (!found) return null;
    const path: number[] = [];
    let c = goal;
    while (c !== -1) {
      path.push(c);
      c = from[c];
      if (path.length > NAV * 4) break;
    }
    path.reverse();
    return Int32Array.from(path);
  }
}

/** Chaikin smoothing on a world-space polyline, keeping the endpoints fixed. */
function smoothRoad(pts: Float32Array, iterations: number): Float32Array {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const n = cur.length / 2;
    if (n < 3) return cur;
    const out = new Float32Array(n * 2);
    out[0] = cur[0];
    out[1] = cur[1];
    let w = 2;
    for (let i = 1; i < n - 1; i++) {
      out[w++] = cur[i * 2 - 2] * 0.22 + cur[i * 2] * 0.56 + cur[i * 2 + 2] * 0.22;
      out[w++] = cur[i * 2 - 1] * 0.22 + cur[i * 2 + 1] * 0.56 + cur[i * 2 + 3] * 0.22;
    }
    out[w++] = cur[(n - 1) * 2];
    out[w++] = cur[(n - 1) * 2 + 1];
    cur = out;
  }
  return cur;
}

export function generateRoads(
  height: Field,
  slope: Field,
  climate: ClimateResult,
  hydro: HydrologyResult,
  settlements: Settlement[],
  seed: number,
): RoadResult {
  const rng = rngFor(seed, 'roads');

  // --- Cost surface -------------------------------------------------------
  const navHeight = downsample(height);
  const navSlope = downsample(slope);
  const navRiver = downsampleMax(hydro.isRiver);
  const navBiome = downsampleMode(climate.biome);
  const navFlow = downsample(hydro.flow);
  const navLake = downsampleMax(Uint8Array.from(hydro.lakeId, (v) => (v >= 0 ? 1 : 0)));

  const n = NAV * NAV;
  const cost = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (navHeight[i] <= SEA_LEVEL) {
      // Effectively impassable: roads do not cross open water.
      cost[i] = 4000;
      continue;
    }
    const def = BIOME_BY_ID[navBiome[i]];
    // Gradient dominates: a road would rather go a long way round than climb.
    let c = 1 + navSlope[i] * navSlope[i] * 90 + navSlope[i] * 14;
    if (def) c *= 1 + def.traversal * 1.6;
    // Bridges are expensive, and more so on a big river.
    if (navRiver[i]) c += 6 + clamp01(navFlow[i] / 260_000) * 42;
    if (navLake[i]) c += 260;
    // Altitude costs breath as well as gradient.
    c *= 1 + clamp01((navHeight[i] - 1.2) / 3.4) * 1.5;
    cost[i] = c;
  }

  const discount = new Float32Array(n).fill(1);
  const traffic = new Float32Array(n);
  const finder = new RoadPathfinder(cost, discount);

  // --- Node set and candidate edges --------------------------------------
  const nodes: number[] = [];
  for (let i = 0; i < settlements.length; i++) {
    const t = settlements[i].tier;
    if (t === 'capital' || t === 'city' || t === 'town') nodes.push(i);
  }

  interface Edge {
    a: number;
    b: number;
    dist: number;
    weight: number;
  }
  const edges: Edge[] = [];
  const seen = new Set<number>();
  const K = 6;
  for (const a of nodes) {
    const sa = settlements[a];
    const near = nodes
      .filter((b) => b !== a)
      .map((b) => ({ b, d: Math.hypot(settlements[b].x - sa.x, settlements[b].z - sa.z) }))
      .filter((e) => e.d < 420)
      .sort((p, q) => p.d - q.d)
      .slice(0, K);
    for (const { b, d } of near) {
      const key = a < b ? a * 100000 + b : b * 100000 + a;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        a,
        b,
        dist: d,
        weight: settlements[a].population + settlements[b].population,
      });
    }
  }

  // Union-find, to guarantee the trunk network is connected per landmass.
  const parent = new Int32Array(settlements.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nx = parent[x];
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent[ra] = rb;
    return true;
  };

  // Spanning edges first (short ones), then the important extras.
  const mstEdges: Edge[] = [];
  const extra: Edge[] = [];
  for (const e of [...edges].sort((p, q) => p.dist - q.dist)) {
    if (union(e.a, e.b)) mstEdges.push(e);
    else if (e.dist < 240 && rng.bool(0.42)) extra.push(e);
  }

  // Path order: heaviest traffic first, so trunk roads are laid down first and
  // everything else converges onto them.
  const ordered = [...mstEdges, ...extra].sort((p, q) => q.weight - p.weight);

  const roads: RoadPath[] = [];
  const bridges: BridgeSite[] = [];
  const bridgeSeen = new Set<number>();

  const classify = (weight: number, biomeAtMid: number): RoadClass => {
    const def = BIOME_BY_ID[biomeAtMid];
    const arid = def && def.group === 'arid';
    if (weight > 160_000) return 'highway';
    if (weight > 40_000) return arid ? 'caravan' : 'road';
    if (arid) return 'caravan';
    return 'track';
  };

  const layPath = (a: number, b: number, weight: number, klass: RoadClass | null, maxCost: number) => {
    const sa = settlements[a];
    const sb = settlements[b];
    const start = worldToNav(sa.x, sa.z);
    const goal = worldToNav(sb.x, sb.z);
    if (start === goal) return;
    const cells = finder.find(start, goal, maxCost);
    if (!cells || cells.length < 2) return;

    // Record traffic and discount the route for later searches.
    for (const c of cells) {
      traffic[c] += weight;
      // Reuse discount saturates, so a hundredth road does not become free.
      discount[c] = Math.max(0.22, discount[c] * 0.62);
      if (navRiver[c] && !bridgeSeen.has(c)) {
        const flow = navFlow[c];
        if (flow > 8000) {
          bridgeSeen.add(c);
          const [wx, wz] = navToWorld(c);
          bridges.push({
            x: wx,
            z: wz,
            flow,
            spanKm: Math.min(2.4, 0.1 + Math.pow(flow / 1000, 0.4) * 0.09),
          });
        }
      }
    }

    // World-space polyline, with the exact settlement positions pinned on the ends.
    const raw = new Float32Array(cells.length * 2);
    for (let i = 0; i < cells.length; i++) {
      const [wx, wz] = navToWorld(cells[i]);
      raw[i * 2] = wx;
      raw[i * 2 + 1] = wz;
    }
    raw[0] = sa.x;
    raw[1] = sa.z;
    raw[raw.length - 2] = sb.x;
    raw[raw.length - 1] = sb.z;

    const pts = smoothRoad(raw, 3);
    let lengthKm = 0;
    for (let i = 1; i < pts.length / 2; i++) {
      lengthKm += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    }

    const midCell = cells[(cells.length / 2) | 0];
    roads.push({
      pts,
      klass: klass ?? classify(weight, navBiome[midCell]),
      a,
      b,
      lengthKm,
    });
  };

  for (const e of ordered) {
    layPath(e.a, e.b, e.weight, null, 30_000);
  }

  // --- Village lanes ------------------------------------------------------
  // Each small settlement gets one short link to the nearest larger place, which
  // is what fills the map between the towns with a believable web of tracks.
  const bigger = nodes.map((i) => ({ i, x: settlements[i].x, z: settlements[i].z }));
  for (let i = 0; i < settlements.length; i++) {
    const s = settlements[i];
    if (s.tier !== 'village' && s.tier !== 'hamlet') continue;
    let best = -1;
    let bestD = Infinity;
    for (const t of bigger) {
      const d = Math.hypot(t.x - s.x, t.z - s.z);
      if (d < bestD) {
        bestD = d;
        best = t.i;
      }
    }
    if (best < 0 || bestD > 85) continue;
    layPath(i, best, s.population, 'lane', 2600);
  }

  // --- Junctions ----------------------------------------------------------
  // A nav cell with three or more road neighbours is a fork; these become the
  // sites for wayside inns, bridges and crossroads hamlets.
  const hasRoad = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (traffic[i] > 0) hasRoad[i] = 1;
  const junctions: Array<{ x: number; z: number; degree: number }> = [];
  for (let y = 1; y < NAV - 1; y++) {
    for (let x = 1; x < NAV - 1; x++) {
      const i = y * NAV + x;
      if (!hasRoad[i]) continue;
      let degree = 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + [1, -1, 0, 0, 1, 1, -1, -1][k];
        const ny = y + [0, 0, 1, -1, 1, -1, 1, -1][k];
        if (hasRoad[ny * NAV + nx]) degree++;
      }
      if (degree >= 4) {
        const [wx, wz] = navToWorld(i);
        junctions.push({ x: wx, z: wz, degree });
      }
    }
  }

  void MACRO_CELL_KM;
  void NAV_CELL_KM;
  void Biome;
  return { roads, bridges, traffic, junctions };
}
