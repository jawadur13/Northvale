import { clamp } from './math';

const SAMPLE_TMP = new Float32Array(4);

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const a = 2 * p1;
  const b = p2 - p0;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = -p0 + 3 * p1 - 3 * p2 + p3;
  return 0.5 * (a + b * t + c * t * t + d * t * t * t);
}

/**
 * A square scalar field with bilinear and bicubic sampling.
 *
 * Everything the generator produces - elevation, temperature, moisture, flow
 * accumulation - lives in one of these, so resampling between the simulation
 * grid and the render grid is uniform and cheap.
 */
export class Field {
  readonly size: number;
  readonly data: Float32Array;

  constructor(size: number, data?: Float32Array) {
    this.size = size;
    this.data = data ?? new Float32Array(size * size);
  }

  idx(x: number, y: number): number {
    return y * this.size + x;
  }

  /** Edge-clamped integer read. */
  at(x: number, y: number): number {
    const s = this.size;
    const cx = x < 0 ? 0 : x >= s ? s - 1 : x;
    const cy = y < 0 ? 0 : y >= s ? s - 1 : y;
    return this.data[cy * s + cx];
  }

  set(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.data[y * this.size + x] = v;
  }

  add(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.data[y * this.size + x] += v;
  }

  /** Bilinear read in continuous grid space. */
  sample(x: number, y: number): number {
    const s = this.size;
    const fx = clamp(x, 0, s - 1.0001);
    const fy = clamp(y, 0, s - 1.0001);
    const x0 = fx | 0;
    const y0 = fy | 0;
    const tx = fx - x0;
    const ty = fy - y0;
    const d = this.data;
    const r0 = y0 * s;
    const r1 = r0 + s;
    const a = d[r0 + x0];
    const b = d[r0 + x0 + 1];
    const c = d[r1 + x0];
    const e = d[r1 + x0 + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
  }

  /** Bilinear read in normalised [0,1] space. */
  sampleUV(u: number, v: number): number {
    return this.sample(u * (this.size - 1), v * (this.size - 1));
  }

  /** Catmull-Rom bicubic sample. Smoother than bilinear when magnifying heavily. */
  sampleCubic(x: number, y: number): number {
    const s = this.size;
    const fx = clamp(x, 0, s - 1);
    const fy = clamp(y, 0, s - 1);
    const x1 = Math.floor(fx);
    const y1 = Math.floor(fy);
    const tx = fx - x1;
    const ty = fy - y1;
    const col = SAMPLE_TMP;
    for (let m = -1; m <= 2; m++) {
      const yy = clamp(y1 + m, 0, s - 1);
      const row = yy * s;
      const p0 = this.data[row + clamp(x1 - 1, 0, s - 1)];
      const p1 = this.data[row + clamp(x1, 0, s - 1)];
      const p2 = this.data[row + clamp(x1 + 1, 0, s - 1)];
      const p3 = this.data[row + clamp(x1 + 2, 0, s - 1)];
      col[m + 1] = catmull(p0, p1, p2, p3, tx);
    }
    return catmull(col[0], col[1], col[2], col[3], ty);
  }

  min(): number {
    let m = Infinity;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] < m) m = this.data[i];
    return m;
  }

  max(): number {
    let m = -Infinity;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] > m) m = this.data[i];
    return m;
  }

  fill(v: number): this {
    this.data.fill(v);
    return this;
  }

  clone(): Field {
    return new Field(this.size, this.data.slice());
  }

  /** Separable box blur; `passes` repetitions approximate a Gaussian. */
  blur(radius: number, passes = 2): this {
    if (radius < 1) return this;
    const s = this.size;
    const tmp = new Float32Array(s * s);
    const d = this.data;
    const w = radius * 2 + 1;
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < s; y++) {
        const row = y * s;
        let sum = 0;
        for (let i = -radius; i <= radius; i++) sum += d[row + clamp(i, 0, s - 1)];
        for (let x = 0; x < s; x++) {
          tmp[row + x] = sum / w;
          sum += d[row + clamp(x + radius + 1, 0, s - 1)] - d[row + clamp(x - radius, 0, s - 1)];
        }
      }
      for (let x = 0; x < s; x++) {
        let sum = 0;
        for (let i = -radius; i <= radius; i++) sum += tmp[clamp(i, 0, s - 1) * s + x];
        for (let y = 0; y < s; y++) {
          d[y * s + x] = sum / w;
          sum +=
            tmp[clamp(y + radius + 1, 0, s - 1) * s + x] - tmp[clamp(y - radius, 0, s - 1) * s + x];
        }
      }
    }
    return this;
  }

  /** Bicubic upsample / downsample into a new field of the given size. */
  resampleTo(size: number): Field {
    const out = new Field(size);
    const scale = (this.size - 1) / (size - 1);
    for (let y = 0; y < size; y++) {
      const sy = y * scale;
      for (let x = 0; x < size; x++) {
        out.data[y * size + x] = this.sampleCubic(x * scale, sy);
      }
    }
    return out;
  }

  /** Central-difference gradient magnitude in units per cell. */
  slopeAt(x: number, y: number): number {
    const dx = (this.at(x + 1, y) - this.at(x - 1, y)) * 0.5;
    const dy = (this.at(x, y + 1) - this.at(x, y - 1)) * 0.5;
    return Math.hypot(dx, dy);
  }
}

/** Integer-labelled companion to Field, for plate / region / basin / island ids. */
export class LabelGrid {
  readonly size: number;
  readonly data: Int32Array;

  constructor(size: number, fillValue = -1) {
    this.size = size;
    this.data = new Int32Array(size * size);
    if (fillValue !== 0) this.data.fill(fillValue);
  }

  at(x: number, y: number): number {
    const s = this.size;
    if (x < 0 || y < 0 || x >= s || y >= s) return -1;
    return this.data[y * s + x];
  }

  set(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.data[y * this.size + x] = v;
  }
}

/** 4-connected neighbour offsets. */
export const N4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** 8-connected neighbour offsets, clockwise from east. */
export const N8: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/** Distance factor per N8 neighbour (diagonals are longer). */
export const N8_DIST: ReadonlyArray<number> = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];
