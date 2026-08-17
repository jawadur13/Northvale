/**
 * Deterministic pseudo-randomness.
 *
 * Every part of the world is derived from a single 32-bit seed, so the same
 * seed always produces byte-identical geography. Sub-systems derive their own
 * streams via `deriveSeed` so that adding a new generator does not shift the
 * output of the existing ones.
 */

/** Small, fast, well-distributed 32-bit PRNG. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    // Avoid the degenerate zero state.
    this.s = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.s += 0x6d2b79f5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Standard normal, Box–Muller. */
  gaussian(mean = 0, sd = 1): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * v);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Picks with per-entry weights. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const e of entries) total += e[1];
    let r = this.next() * total;
    for (const e of entries) {
      r -= e[1];
      if (r <= 0) return e[0];
    }
    return entries[entries.length - 1][0];
  }

  /** In-place Fisher–Yates. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** A fresh independent stream, tagged so unrelated systems never correlate. */
  fork(tag: string): Rng {
    return new Rng(deriveSeed(this.s, tag) ^ (this.int(0, 0x7fffffff) | 0));
  }
}

/** FNV-1a over the tag, mixed with the base seed. Stable across runs. */
export function deriveSeed(seed: number, tag: string): number {
  let h = 0x811c9dc5 ^ (seed | 0);
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export function rngFor(seed: number, tag: string): Rng {
  return new Rng(deriveSeed(seed, tag));
}

/** Stateless 2D integer hash → [0,1). Used for procedural scatter that must be re-derivable. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Stateless 3D integer hash → [0,1). */
export function hash3(x: number, y: number, z: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(z | 0, 0xc2b2ae35) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Stable string → 32-bit hash, for seeding from a user-typed world name. */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}
