/**
 * Diagnostic renderings of the generated world.
 *
 * These are the images that catch the failures assertions cannot describe:
 * a desert on the windward side of a range, a river network that does not
 * branch, borders that ignore the terrain, settlements clustered in one corner.
 */

import { FINE, MACRO, SEA_LEVEL } from '../src/core/config';
import type { WorldPayload } from '../src/world/types';

type Image = [name: string, data: Uint8Array, size: number];

const SIZE = 512;

function put(img: Uint8Array, i: number, r: number, g: number, b: number): void {
  img[i * 4] = Math.max(0, Math.min(255, r));
  img[i * 4 + 1] = Math.max(0, Math.min(255, g));
  img[i * 4 + 2] = Math.max(0, Math.min(255, b));
  img[i * 4 + 3] = 255;
}

export function renderDiagnostics(p: WorldPayload): Image[] {
  const out: Image[] = [];
  const scaleF = (FINE - 1) / (SIZE - 1);
  const scaleM = (MACRO - 1) / (SIZE - 1);

  // --- Elevation, as a hypsometric tint with a hillshade ---
  {
    const img = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const fx = Math.round(x * scaleF);
        const fy = Math.round(y * scaleF);
        const h = p.height[fy * FINE + fx];
        const i = y * SIZE + x;
        if (h <= SEA_LEVEL) {
          const t = Math.min(1, -h / 5);
          put(img, i, 20 + (1 - t) * 40, 60 + (1 - t) * 60, 110 + (1 - t) * 60);
        } else {
          const t = Math.min(1, h / 6);
          put(img, i, 60 + t * 195, 110 + t * 130, 60 + t * 190);
        }
      }
    }
    out.push(['diag-elevation', img, SIZE]);
  }

  // --- Climate: temperature as red, moisture as blue ---
  {
    const img = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const mx = Math.round(x * scaleM);
        const my = Math.round(y * scaleM);
        const c = (my * MACRO + mx) * 4;
        const i = y * SIZE + x;
        const fx = Math.round(x * scaleF);
        const fy = Math.round(y * scaleF);
        if (p.height[Math.round(y * scaleF) * FINE + fx] <= SEA_LEVEL) {
          put(img, i, 24, 30, 44);
          continue;
        }
        void fy;
        put(img, i, p.climate[c], p.climate[c + 2], p.climate[c + 1]);
      }
    }
    out.push(['diag-climate', img, SIZE]);
  }

  // --- Political regions ---
  {
    const img = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const mx = Math.round(x * scaleM);
        const my = Math.round(y * scaleM);
        const c = (my * MACRO + mx) * 4;
        const i = y * SIZE + x;
        if (p.regionMap[c + 3] === 0) put(img, i, 18, 26, 38);
        else put(img, i, p.regionMap[c], p.regionMap[c + 1], p.regionMap[c + 2]);
      }
    }
    out.push(['diag-regions', img, SIZE]);
  }

  // --- Network: coast, rivers, roads, settlements ---
  {
    const img = new Uint8Array(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const fx = Math.round(x * scaleF);
        const fy = Math.round(y * scaleF);
        const h = p.height[fy * FINE + fx];
        const i = y * SIZE + x;
        if (h <= SEA_LEVEL) put(img, i, 16, 22, 34);
        else put(img, i, 44, 44, 40);
      }
    }
    const toPx = (wx: number, wz: number): number => {
      const x = Math.round(((wx + 2048) / 4096) * (SIZE - 1));
      const y = Math.round(((wz + 2048) / 4096) * (SIZE - 1));
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return -1;
      return y * SIZE + x;
    };
    // Roads first, rivers over them.
    for (let v = 0; v < p.roadVertices.length; v += 3) {
      const i = toPx(p.roadVertices[v], p.roadVertices[v + 2]);
      if (i >= 0) put(img, i, 150, 120, 80);
    }
    for (let v = 0; v < p.riverVertices.length; v += 3) {
      const i = toPx(p.riverVertices[v], p.riverVertices[v + 2]);
      if (i >= 0) put(img, i, 90, 160, 220);
    }
    for (const f of p.features) {
      if (f.kind === 'capital' || f.kind === 'city') {
        const i = toPx(f.x, f.z);
        if (i >= 0) {
          put(img, i, 255, 210, 120);
          if (i + 1 < SIZE * SIZE) put(img, i + 1, 255, 210, 120);
          if (i + SIZE < SIZE * SIZE) put(img, i + SIZE, 255, 210, 120);
        }
      } else if (f.kind === 'town') {
        const i = toPx(f.x, f.z);
        if (i >= 0) put(img, i, 230, 170, 90);
      } else if (f.kind === 'village' || f.kind === 'hamlet') {
        const i = toPx(f.x, f.z);
        if (i >= 0) put(img, i, 170, 140, 100);
      } else if (f.kind === 'anomaly') {
        const i = toPx(f.x, f.z);
        if (i >= 0) {
          put(img, i, 255, 80, 200);
          if (i + 1 < SIZE * SIZE) put(img, i + 1, 255, 80, 200);
          if (i - 1 >= 0) put(img, i - 1, 255, 80, 200);
          if (i + SIZE < SIZE * SIZE) put(img, i + SIZE, 255, 80, 200);
          if (i - SIZE >= 0) put(img, i - SIZE, 255, 80, 200);
        }
      }
    }
    out.push(['diag-network', img, SIZE]);
  }

  return out;
}
