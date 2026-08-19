/**
 * Convex polygon algebra for city plans.
 *
 * Every polygon in the city generator is convex, and that is a deliberate
 * invariant rather than a coincidence: the plan starts as a convex boundary and
 * is only ever divided by straight full-width cuts, which cannot produce a
 * concave result. Holding that invariant buys a great deal — splitting is a
 * single clip pass, insetting is edge-offset plus intersection with no
 * self-intersection cases, and point containment is a sign test. The alternative,
 * a general polygon library with robust boolean operations, is an order of
 * magnitude more code and the plan does not need it.
 *
 * Polygons carry a per-edge flag saying whether that edge fronts a street. That
 * flag is what makes the parcels look right: real plots are long and thin
 * *perpendicular to the street they front*, because frontage is the scarce thing.
 * Without tracking which edge is the street, subdivision produces squares, and
 * squares read as a housing estate rather than as a town.
 */

/** Convex polygon in world kilometres, vertices in counter-clockwise order. */
export interface Poly {
  /** Flat x,z pairs. */
  pts: Float32Array;
  /** Per-edge flag; edge `i` runs from vertex `i` to vertex `i+1`. 1 = fronts a street. */
  street: Uint8Array;
}

export function makePoly(pts: number[], street?: number[]): Poly {
  const n = pts.length / 2;
  return {
    pts: new Float32Array(pts),
    street: street ? Uint8Array.from(street) : new Uint8Array(n),
  };
}

export function vertexCount(p: Poly): number {
  return p.pts.length / 2;
}

export function polyArea(p: Poly): number {
  const n = vertexCount(p);
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p.pts[i * 2] * p.pts[j * 2 + 1] - p.pts[j * 2] * p.pts[i * 2 + 1];
  }
  return Math.abs(a) * 0.5;
}

export function polyCentroid(p: Poly, out: [number, number] = [0, 0]): [number, number] {
  const n = vertexCount(p);
  let cx = 0;
  let cz = 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = p.pts[i * 2];
    const z0 = p.pts[i * 2 + 1];
    const x1 = p.pts[j * 2];
    const z1 = p.pts[j * 2 + 1];
    const cross = x0 * z1 - x1 * z0;
    a += cross;
    cx += (x0 + x1) * cross;
    cz += (z0 + z1) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    // Degenerate: fall back to the vertex mean.
    let mx = 0;
    let mz = 0;
    for (let i = 0; i < n; i++) {
      mx += p.pts[i * 2];
      mz += p.pts[i * 2 + 1];
    }
    out[0] = mx / n;
    out[1] = mz / n;
    return out;
  }
  a *= 0.5;
  out[0] = cx / (6 * a);
  out[1] = cz / (6 * a);
  return out;
}

/** Signed perpendicular distance from the line through (ox,oz) along (dx,dz). */
function side(px: number, pz: number, ox: number, oz: number, dx: number, dz: number): number {
  return (px - ox) * dz - (pz - oz) * dx;
}

export interface SplitResult {
  left: Poly | null;
  right: Poly | null;
}

/**
 * Cuts a convex polygon with an infinite line.
 *
 * @param cutIsStreet whether the new edge created by the cut fronts a street.
 *   A street cut makes both halves front it; a lot boundary does not.
 */
export function splitConvex(
  p: Poly,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  cutIsStreet: boolean,
): SplitResult {
  const n = vertexCount(p);
  if (n < 3) return { left: null, right: null };

  const leftPts: number[] = [];
  const leftEdge: number[] = [];
  const rightPts: number[] = [];
  const rightEdge: number[] = [];
  const EPS = 1e-7;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p.pts[i * 2];
    const az = p.pts[i * 2 + 1];
    const bx = p.pts[j * 2];
    const bz = p.pts[j * 2 + 1];
    const sa = side(ax, az, ox, oz, dx, dz);
    const sb = side(bx, bz, ox, oz, dx, dz);
    const edgeFlag = p.street[i];

    if (sa >= -EPS) {
      leftPts.push(ax, az);
      leftEdge.push(edgeFlag);
    }
    if (sa <= EPS) {
      rightPts.push(ax, az);
      rightEdge.push(edgeFlag);
    }

    // Does this edge cross the line?
    if ((sa > EPS && sb < -EPS) || (sa < -EPS && sb > EPS)) {
      const t = sa / (sa - sb);
      const ix = ax + (bx - ax) * t;
      const iz = az + (bz - az) * t;
      // The crossing point ends both runs. The edge leaving it on each side is
      // the cut itself for the side we are entering, and the original edge for
      // the side we are leaving.
      leftPts.push(ix, iz);
      rightPts.push(ix, iz);
      if (sa > 0) {
        // Leaving the left half here: the next left edge is the cut.
        leftEdge.push(cutIsStreet ? 1 : 0);
        rightEdge.push(edgeFlag);
      } else {
        rightEdge.push(cutIsStreet ? 1 : 0);
        leftEdge.push(edgeFlag);
      }
    }
  }

  const build = (pts: number[], edges: number[]): Poly | null => {
    if (pts.length < 6) return null;
    const poly = makePoly(pts, edges);
    return polyArea(poly) > 1e-9 ? poly : null;
  };

  return { left: build(leftPts, leftEdge), right: build(rightPts, rightEdge) };
}

/**
 * Moves every edge inward by `d` and re-intersects.
 *
 * Convex-only. Returns null when the inset consumes the polygon, which is the
 * common and expected outcome for a block too narrow to hold a plot.
 */
export function insetConvex(p: Poly, d: number): Poly | null {
  const n = vertexCount(p);
  if (n < 3 || d <= 0) return p;

  // Clip successively by each edge pushed inward. Slower than the analytic
  // offset but immune to the ordering problems that produce inverted polygons.
  let cur: Poly | null = p;
  for (let i = 0; i < n && cur; i++) {
    const j = (i + 1) % n;
    const ax = p.pts[i * 2];
    const az = p.pts[i * 2 + 1];
    const bx = p.pts[j * 2];
    const bz = p.pts[j * 2 + 1];
    let ex = bx - ax;
    let ez = bz - az;
    const len = Math.hypot(ex, ez);
    if (len < 1e-9) continue;
    ex /= len;
    ez /= len;
    // Inward normal for a CCW polygon.
    const nx = -ez;
    const nz = ex;
    const res = splitConvex(cur, ax + nx * d, az + nz * d, ex, ez, false);
    // `splitConvex` puts points with a positive signed side into `left`, and for
    // this winding convention the interior of the polygon lies on the *negative*
    // side of each directed edge. So the piece to keep is `right`. Keeping the
    // other one insets outward and returns a sliver, which reads downstream as
    // "this block is too small for a plot" and silently produces no parcels.
    cur = res.right ?? null;
    if (cur && polyArea(cur) < 1e-9) cur = null;
  }
  return cur;
}

/** Ensures counter-clockwise winding, reversing in place if needed. */
export function ensureCCW(p: Poly): Poly {
  const n = vertexCount(p);
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p.pts[i * 2] * p.pts[j * 2 + 1] - p.pts[j * 2] * p.pts[i * 2 + 1];
  }
  if (a >= 0) return p;

  const pts = new Float32Array(n * 2);
  const street = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const src = n - 1 - i;
    pts[i * 2] = p.pts[src * 2];
    pts[i * 2 + 1] = p.pts[src * 2 + 1];
    // Reversing a ring shifts edge ownership by one.
    street[i] = p.street[(src - 1 + n) % n];
  }
  return { pts, street };
}

export interface EdgeInfo {
  index: number;
  length: number;
  /** Unit direction along the edge. */
  dx: number;
  dz: number;
  /** Midpoint. */
  mx: number;
  mz: number;
}

/** The longest edge matching a predicate, or null. */
export function longestEdge(p: Poly, predicate?: (i: number) => boolean): EdgeInfo | null {
  const n = vertexCount(p);
  let best: EdgeInfo | null = null;
  for (let i = 0; i < n; i++) {
    if (predicate && !predicate(i)) continue;
    const j = (i + 1) % n;
    const ax = p.pts[i * 2];
    const az = p.pts[i * 2 + 1];
    const bx = p.pts[j * 2];
    const bz = p.pts[j * 2 + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (!best || len > best.length) {
      best = { index: i, length: len, dx: dx / (len || 1), dz: dz / (len || 1), mx: (ax + bx) / 2, mz: (az + bz) / 2 };
    }
  }
  return best;
}

/** Extent of the polygon along a direction: [min, max] projected distance. */
export function extentAlong(p: Poly, dx: number, dz: number): [number, number] {
  const n = vertexCount(p);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = p.pts[i * 2] * dx + p.pts[i * 2 + 1] * dz;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return [lo, hi];
}

export function boundingRadius(p: Poly, cx: number, cz: number): number {
  const n = vertexCount(p);
  let r = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(p.pts[i * 2] - cx, p.pts[i * 2 + 1] - cz);
    if (d > r) r = d;
  }
  return r;
}

/**
 * Clips an infinite line against a convex polygon.
 *
 * Returns the parameter range `[tMin, tMax]` along `(ox,oz) + t*(dx,dz)` that
 * lies inside, or null if the line misses. A convex polygon admits at most one
 * such interval, which is what makes this a simple half-plane intersection
 * rather than a general clipping problem.
 */
export function clipLineToConvex(
  p: Poly,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
): [number, number] | null {
  const n = vertexCount(p);
  let tMin = -Infinity;
  let tMax = Infinity;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p.pts[i * 2];
    const az = p.pts[i * 2 + 1];
    const bx = p.pts[j * 2];
    const bz = p.pts[j * 2 + 1];
    const ex = bx - ax;
    const ez = bz - az;
    // Interior lies on the negative side of each directed edge for this winding.
    const denom = dx * ez - dz * ex;
    const num = (ox - ax) * ez - (oz - az) * ex;
    if (Math.abs(denom) < 1e-12) {
      // Parallel to this edge: reject outright if outside it.
      if (num > 0) return null;
      continue;
    }
    const t = -num / denom;
    if (denom > 0) {
      if (t < tMax) tMax = t;
    } else if (t > tMin) {
      tMin = t;
    }
    if (tMin >= tMax) return null;
  }
  return tMin < tMax ? [tMin, tMax] : null;
}

/** Convex point containment. */
export function containsPoint(p: Poly, px: number, pz: number): boolean {
  const n = vertexCount(p);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p.pts[i * 2];
    const az = p.pts[i * 2 + 1];
    const bx = p.pts[j * 2];
    const bz = p.pts[j * 2 + 1];
    if (side(px, pz, ax, az, bx - ax, bz - az) < -1e-7) return false;
  }
  return true;
}

/** Fan triangulation. Valid for convex polygons; returns index triples. */
export function triangulateConvex(p: Poly, baseIndex: number, out: number[]): void {
  const n = vertexCount(p);
  for (let i = 1; i < n - 1; i++) {
    out.push(baseIndex, baseIndex + i, baseIndex + i + 1);
  }
}

/** A regular n-gon, optionally perturbed per vertex by `jitter(i)` in the radial direction. */
export function regularPolygon(
  cx: number,
  cz: number,
  radius: number,
  sides: number,
  jitter?: (i: number, angle: number) => number,
  rotation = 0,
): Poly {
  const pts: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    const r = radius * (jitter ? jitter(i, a) : 1);
    pts.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
  }
  return ensureCCW(makePoly(pts));
}

/**
 * Clips one convex polygon to another.
 *
 * Sutherland-Hodgman narrowed to convex clip windows, which is all this module
 * ever needs: every polygon it handles is convex by construction. Returns null
 * when the two do not overlap.
 */
export function clipToConvex(subject: Poly, clip: Poly): Poly | null {
  let out: Poly | null = subject;
  const n = vertexCount(clip);
  for (let i = 0; i < n && out; i++) {
    const j = (i + 1) % n;
    const ax = clip.pts[i * 2];
    const az = clip.pts[i * 2 + 1];
    // The interior of a counter-clockwise polygon lies on the negative side of
    // each of its edges, which is the half `splitConvex` calls `right`.
    out = splitConvex(out, ax, az, clip.pts[j * 2] - ax, clip.pts[j * 2 + 1] - az, false).right;
  }
  return out;
}

/** An axis-aligned-in-local-space rectangle, rotated by `angle`. */
export function rectanglePolygon(
  cx: number,
  cz: number,
  halfW: number,
  halfH: number,
  angle: number,
): Poly {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const corner = (u: number, v: number): [number, number] => [
    cx + u * halfW * c - v * halfH * s,
    cz + u * halfW * s + v * halfH * c,
  ];
  const a = corner(-1, -1);
  const b = corner(1, -1);
  const d = corner(1, 1);
  const e = corner(-1, 1);
  return ensureCCW(makePoly([a[0], a[1], b[0], b[1], d[0], d[1], e[0], e[1]]));
}
