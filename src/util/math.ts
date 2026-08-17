/** Small, allocation-free math helpers used across generation and rendering. */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

/** Maps v from [a,b] into [0,1], clamped. */
export function remap01(a: number, b: number, v: number): number {
  return clamp01(invLerp(a, b, v));
}

export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = remap01(edge0, edge1, v);
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, v: number): number {
  const t = remap01(edge0, edge1, v);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Frame-rate independent exponential approach. `rate` ≈ how much of the gap closes per second. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  return current + shortestAngle(current, target) * (1 - Math.exp(-rate * dt));
}

/** Signed smallest delta to rotate from a to b. */
export function shortestAngle(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function easeInOutQuint(t: number): number {
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

/** Rounds to a "nice" human number: 1 200 → 1 200, 12 480 → 12 000, 1 248 000 → 1 250 000. */
export function roundSignificant(v: number, digits = 3): number {
  if (v === 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - (digits - 1));
  return Math.round(v / mag) * mag;
}

export function formatNumber(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}

/** 12 480 → "12,480"; 1 248 000 → "1.25 million" */
export function formatPopulation(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, '')} million`;
  return formatNumber(v);
}

export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${formatNumber(km)} km`;
}

export function formatElevation(metres: number): string {
  const m = Math.round(metres);
  return `${formatNumber(Math.abs(m))} m${m < 0 ? ' below sea level' : ''}`;
}
