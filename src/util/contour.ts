/**
 * Marching-squares contour extraction.
 *
 * Used for two things the atlas needs as *lines* rather than as pixels: the
 * coastline (the iso-line of elevation at sea level) and political borders (the
 * boundary between differing region ids). Both are emitted as flat vertex pairs
 * ready to become a THREE.LineSegments buffer, which keeps the whole outline
 * layer to a single draw call.
 */

/**
 * Extracts the iso-line at `level` from a scalar grid, as line segments.
 *
 * @param data row-major grid values
 * @param size grid edge length
 * @param level iso value
 * @param toWorld converts a fractional grid coordinate to world coordinates
 * @returns flat [x0,z0, x1,z1, ...] segment endpoints
 */
export function marchingSquares(
  data: Float32Array,
  size: number,
  level: number,
  toWorld: (gx: number, gy: number, out: [number, number]) => void,
): Float32Array {
  const out: number[] = [];
  const p: [number, number] = [0, 0];
  const q: [number, number] = [0, 0];

  const push = (ax: number, ay: number, bx: number, by: number) => {
    toWorld(ax, ay, p);
    toWorld(bx, by, q);
    out.push(p[0], p[1], q[0], q[1]);
  };

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const i = y * size + x;
      const v00 = data[i];
      const v10 = data[i + 1];
      const v01 = data[i + size];
      const v11 = data[i + size + 1];

      let code = 0;
      if (v00 > level) code |= 1;
      if (v10 > level) code |= 2;
      if (v11 > level) code |= 4;
      if (v01 > level) code |= 8;
      if (code === 0 || code === 15) continue;

      // Linear interpolation along each crossed cell edge.
      const t = (a: number, b: number) => {
        const d = b - a;
        return Math.abs(d) < 1e-12 ? 0.5 : (level - a) / d;
      };
      // Edge midpoints: bottom (x0->x1 at y), right, top, left.
      const bx = x + t(v00, v10);
      const by = y;
      const rx = x + 1;
      const ry = y + t(v10, v11);
      const tx = x + t(v01, v11);
      const ty = y + 1;
      const lx = x;
      const ly = y + t(v00, v01);

      switch (code) {
        case 1:
        case 14:
          push(lx, ly, bx, by);
          break;
        case 2:
        case 13:
          push(bx, by, rx, ry);
          break;
        case 3:
        case 12:
          push(lx, ly, rx, ry);
          break;
        case 4:
        case 11:
          push(rx, ry, tx, ty);
          break;
        case 6:
        case 9:
          push(bx, by, tx, ty);
          break;
        case 7:
        case 8:
          push(lx, ly, tx, ty);
          break;
        // Saddles: emit both branches. Which pairing is "correct" is ambiguous;
        // emitting both keeps the outline closed, which is what matters visually.
        case 5:
          push(lx, ly, bx, by);
          push(rx, ry, tx, ty);
          break;
        case 10:
          push(bx, by, rx, ry);
          push(lx, ly, tx, ty);
          break;
      }
    }
  }
  return new Float32Array(out);
}

/**
 * Extracts boundaries between differing integer labels as line segments on the
 * dual grid. Only emits a segment when both sides are "real" (>= 0), so a
 * region's coast is not double-drawn over the coastline layer.
 */
export function labelBoundaries(
  labels: Int32Array,
  size: number,
  toWorld: (gx: number, gy: number, out: [number, number]) => void,
  filter?: (a: number, b: number) => boolean,
): Float32Array {
  const out: number[] = [];
  const p: [number, number] = [0, 0];
  const q: [number, number] = [0, 0];

  const push = (ax: number, ay: number, bx: number, by: number) => {
    toWorld(ax, ay, p);
    toWorld(bx, by, q);
    out.push(p[0], p[1], q[0], q[1]);
  };

  const keep = filter ?? ((a: number, b: number) => a >= 0 && b >= 0 && a !== b);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = labels[y * size + x];
      if (x + 1 < size) {
        const b = labels[y * size + x + 1];
        if (a !== b && keep(a, b)) push(x + 0.5, y - 0.5, x + 0.5, y + 0.5);
      }
      if (y + 1 < size) {
        const b = labels[(y + 1) * size + x];
        if (a !== b && keep(a, b)) push(x - 0.5, y + 0.5, x + 0.5, y + 0.5);
      }
    }
  }
  return new Float32Array(out);
}

/**
 * Joins unordered segments into polylines by welding endpoints on a spatial
 * hash. Needed for region borders, which must be smoothed as continuous lines
 * rather than left as a staircase of grid-aligned dashes.
 */
export function stitchSegments(segments: Float32Array, tolerance = 1e-3): Float32Array[] {
  const count = segments.length / 4;
  if (!count) return [];
  const inv = 1 / tolerance;
  const key = (x: number, y: number) => `${Math.round(x * inv)},${Math.round(y * inv)}`;

  // endpoint key -> list of segment indices touching it
  const map = new Map<string, number[]>();
  for (let s = 0; s < count; s++) {
    const k0 = key(segments[s * 4], segments[s * 4 + 1]);
    const k1 = key(segments[s * 4 + 2], segments[s * 4 + 3]);
    (map.get(k0) ?? map.set(k0, []).get(k0)!).push(s);
    (map.get(k1) ?? map.set(k1, []).get(k1)!).push(s);
  }

  const used = new Uint8Array(count);
  const polylines: Float32Array[] = [];

  for (let s = 0; s < count; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const pts: number[] = [
      segments[s * 4],
      segments[s * 4 + 1],
      segments[s * 4 + 2],
      segments[s * 4 + 3],
    ];

    // Extend forwards, then backwards.
    for (let dir = 0; dir < 2; dir++) {
      for (;;) {
        const n = pts.length;
        const ex = dir === 0 ? pts[n - 2] : pts[0];
        const ey = dir === 0 ? pts[n - 1] : pts[1];
        const candidates = map.get(key(ex, ey));
        if (!candidates) break;
        let nextSeg = -1;
        for (const c of candidates) {
          if (!used[c]) {
            nextSeg = c;
            break;
          }
        }
        if (nextSeg === -1) break;
        used[nextSeg] = 1;
        const ax = segments[nextSeg * 4];
        const ay = segments[nextSeg * 4 + 1];
        const bx = segments[nextSeg * 4 + 2];
        const by = segments[nextSeg * 4 + 3];
        const startMatches = Math.abs(ax - ex) < tolerance * 2 && Math.abs(ay - ey) < tolerance * 2;
        const nx = startMatches ? bx : ax;
        const ny = startMatches ? by : ay;
        if (dir === 0) pts.push(nx, ny);
        else pts.unshift(nx, ny);
      }
    }

    if (pts.length >= 6) polylines.push(new Float32Array(pts));
  }

  return polylines;
}

/** Chaikin corner-cutting: turns a grid staircase into a smooth line. */
export function smoothPolyline(pts: Float32Array, iterations = 2): Float32Array {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const n = cur.length / 2;
    if (n < 3) return cur;
    const out = new Float32Array((n - 1) * 4);
    let w = 0;
    for (let i = 0; i < n - 1; i++) {
      const x0 = cur[i * 2];
      const y0 = cur[i * 2 + 1];
      const x1 = cur[i * 2 + 2];
      const y1 = cur[i * 2 + 3];
      out[w++] = x0 * 0.75 + x1 * 0.25;
      out[w++] = y0 * 0.75 + y1 * 0.25;
      out[w++] = x0 * 0.25 + x1 * 0.75;
      out[w++] = y0 * 0.25 + y1 * 0.75;
    }
    cur = out;
  }
  return cur;
}

/** Drops collinear points to keep line buffers small. Distance in world units. */
export function simplifyPolyline(pts: Float32Array, tolerance: number): Float32Array {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = pts[a * 2];
    const ay = pts[a * 2 + 1];
    const bx = pts[b * 2];
    const by = pts[b * 2 + 1];
    const vx = bx - ax;
    const vy = by - ay;
    const len = Math.hypot(vx, vy) || 1;
    let worst = -1;
    let worstD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i * 2] - ax) * vy - (pts[i * 2 + 1] - ay) * vx) / len;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  }
  return new Float32Array(out);
}
