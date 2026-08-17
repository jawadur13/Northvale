/**
 * Noise primitives for terrain synthesis.
 *
 * Simplex is used for everything continuous (continents, climate, detail).
 * The ridged variant produces the sharp crestlines that read as mountain
 * ranges, and `warp` bends the domain so ranges curve instead of running in
 * straight noise-aligned bands.
 */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

const GRAD2 = new Float32Array([
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 1, 0, -1, 0,
  0, 1, 0, -1, 0, 1, 0, -1,
]);

/** Seeded 2D simplex noise, output roughly in [-1, 1]. */
export class Simplex {
  private perm = new Uint8Array(512);
  private permMod12 = new Uint8Array(512);

  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Deterministic shuffle driven by the seed.
    let s = (seed | 0) === 0 ? 1 : seed | 0;
    for (let i = 255; i > 0; i--) {
      s = Math.imul(s ^ (s >>> 15), 0x2545f491);
      s ^= s >>> 13;
      const j = (s >>> 0) % (i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise2(xin: number, yin: number): number {
    const perm = this.perm;
    const permMod12 = this.permMod12;

    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    let i1: number, j1: number;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = permMod12[perm[ii + perm[jj]]] * 2;
      t0 *= t0;
      n += t0 * t0 * (GRAD2[g] * x0 + GRAD2[g + 1] * y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = permMod12[perm[ii + i1 + perm[jj + j1]]] * 2;
      t1 *= t1;
      n += t1 * t1 * (GRAD2[g] * x1 + GRAD2[g + 1] * y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = permMod12[perm[ii + 1 + perm[jj + 1]]] * 2;
      t2 *= t2;
      n += t2 * t2 * (GRAD2[g] * x2 + GRAD2[g + 1] * y2);
    }

    return 70 * n;
  }
}

export interface FbmOptions {
  octaves?: number;
  frequency?: number;
  lacunarity?: number;
  gain?: number;
}

/** Classic fractional Brownian motion. Result normalised to about [-1, 1]. */
export function fbm(n: Simplex, x: number, y: number, opts: FbmOptions = {}): number {
  const octaves = opts.octaves ?? 5;
  const lacunarity = opts.lacunarity ?? 2.03;
  const gain = opts.gain ?? 0.5;
  let freq = opts.frequency ?? 1;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += n.noise2(x * freq, y * freq) * amp;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Ridged multifractal - sharp crests, smooth troughs. Output in [0, 1]. */
export function ridged(n: Simplex, x: number, y: number, opts: FbmOptions = {}): number {
  const octaves = opts.octaves ?? 5;
  const lacunarity = opts.lacunarity ?? 2.07;
  const gain = opts.gain ?? 0.5;
  let freq = opts.frequency ?? 1;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let prev = 1;
  for (let o = 0; o < octaves; o++) {
    let v = 1 - Math.abs(n.noise2(x * freq, y * freq));
    v *= v;
    // Weighting by the previous octave keeps crests continuous instead of noisy.
    sum += v * amp * prev;
    norm += amp;
    prev = v;
    freq *= lacunarity;
    amp *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Billowed noise - rounded lumps, good for dunes and rolling hills. Output in [0, 1]. */
export function billow(n: Simplex, x: number, y: number, opts: FbmOptions = {}): number {
  const octaves = opts.octaves ?? 4;
  const lacunarity = opts.lacunarity ?? 2.02;
  const gain = opts.gain ?? 0.5;
  let freq = opts.frequency ?? 1;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += Math.abs(n.noise2(x * freq, y * freq)) * amp;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

const warpOut = { x: 0, y: 0 };

/**
 * Domain warp: offsets the sample point by two more noise fields. This is what
 * stops coastlines and ranges from looking like obvious noise contours.
 * Returns a shared object - read it immediately, do not retain it.
 */
export function warp(
  a: Simplex,
  b: Simplex,
  x: number,
  y: number,
  frequency: number,
  amplitude: number,
  octaves = 3,
): { x: number; y: number } {
  const wx = fbm(a, x, y, { octaves, frequency });
  const wy = fbm(b, x + 131.7, y - 47.3, { octaves, frequency });
  warpOut.x = x + wx * amplitude;
  warpOut.y = y + wy * amplitude;
  return warpOut;
}

export interface CellResult {
  f1: number;
  f2: number;
  id: number;
  px: number;
  py: number;
}

const cellOut: CellResult = { f1: 0, f2: 0, id: 0, px: 0, py: 0 };

/**
 * Cellular / Worley noise returning distance to the nearest and second-nearest
 * feature point plus the nearest cell id. Used for tectonic plates.
 */
export function cellular(x: number, y: number, seed: number, jitter = 1): CellResult {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = Infinity;
  let f2 = Infinity;
  let id = 0;
  let px = 0;
  let py = 0;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      let h = Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cy | 0, 0x85ebca6b) ^ (seed | 0);
      h = Math.imul(h ^ (h >>> 15), 0x2545f491);
      h ^= h >>> 13;
      const r1 = ((h >>> 0) % 65536) / 65536;
      const r2 = (((h >>> 8) >>> 0) % 65536) / 65536;
      const fx = cx + 0.5 + (r1 - 0.5) * jitter;
      const fy = cy + 0.5 + (r2 - 0.5) * jitter;
      const d = Math.hypot(fx - x, fy - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = (h >>> 0) & 0x7fffffff;
        px = fx;
        py = fy;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }

  cellOut.f1 = f1;
  cellOut.f2 = f2;
  cellOut.id = id;
  cellOut.px = px;
  cellOut.py = py;
  return cellOut;
}
