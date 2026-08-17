/**
 * Map chrome: compass, scale bar, minimap, coordinate readout, zoom controls.
 *
 * All of it exists to answer the three questions a reader of any map asks
 * continuously - which way is north, how big is what I am looking at, and where am
 * I in the whole - and all of it is drawn to be ignorable until asked.
 *
 * The minimap is the generator's own overview image with a viewport rectangle over
 * it, so it is the same map at a different scale rather than a second rendering
 * with its own opinions. Clicking it flies there.
 */

import { HALF_KM, TIER_NAMES, WORLD_KM, ZoomTier, zToLatitude } from '../core/config';
import { formatNumber } from '../util/math';
import { el } from './dom';

export class Compass {
  readonly root: HTMLDivElement;
  private needle: HTMLDivElement;
  private ring: HTMLDivElement;
  private lastAzimuth = 0;
  private lastPolar = 0;

  onReset: (() => void) | null = null;

  constructor() {
    this.needle = el('div', { class: 'compass-needle' });
    this.ring = el('div', { class: 'compass-ring' }, [
      el('span', { class: 'compass-n', text: 'N' }),
      el('span', { class: 'compass-e', text: 'E' }),
      el('span', { class: 'compass-s', text: 'S' }),
      el('span', { class: 'compass-w', text: 'W' }),
      this.needle,
    ]);
    const button = el('button', {
      class: 'compass',
      type: 'button',
      title: 'Reset bearing to north (double-click to reset the whole view)',
      'aria-label': 'Compass',
    }, [this.ring]);
    button.addEventListener('click', () => this.onReset?.());
    this.root = button as unknown as HTMLDivElement;
  }

  update(azimuth: number, polar: number): void {
    if (Math.abs(azimuth - this.lastAzimuth) < 0.002 && Math.abs(polar - this.lastPolar) < 0.002) return;
    this.lastAzimuth = azimuth;
    this.lastPolar = polar;
    const deg = (azimuth * 180) / Math.PI;
    // Tilting the ring with the camera's pitch makes it read as part of the scene.
    this.ring.style.transform = `rotateX(${Math.min(58, (polar * 180) / Math.PI * 0.8)}deg) rotateZ(${deg}deg)`;
  }
}

export class ScaleBar {
  readonly root: HTMLDivElement;
  private bar: HTMLDivElement;
  private label: HTMLSpanElement;
  private lastText = '';

  constructor() {
    this.bar = el('div', { class: 'scale-bar-line' });
    this.label = el('span', { class: 'scale-bar-label', text: '' });
    this.root = el('div', { class: 'scale-bar' }, [this.bar, this.label]);
  }

  /**
   * Picks a round distance close to a target on-screen width, then sizes the bar
   * to match. Always a 1, 2 or 5 times a power of ten, as a scale bar should be.
   */
  update(kmPerPixel: number): void {
    const targetPx = 120;
    const rawKm = kmPerPixel * targetPx;
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1e-4, rawKm))));
    const candidates = [1, 2, 5, 10].map((m) => m * magnitude);
    let best = candidates[0];
    for (const c of candidates) {
      if (Math.abs(c / kmPerPixel - targetPx) < Math.abs(best / kmPerPixel - targetPx)) best = c;
    }
    const px = Math.round(best / kmPerPixel);
    const text = best >= 1 ? `${formatNumber(best)} km` : `${Math.round(best * 1000)} m`;
    if (text !== this.lastText) {
      this.label.textContent = text;
      this.lastText = text;
    }
    this.bar.style.width = `${Math.max(24, Math.min(260, px))}px`;
  }
}

export class Minimap {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private viewport: HTMLDivElement;
  private size: number;

  onNavigate: ((x: number, z: number) => void) | null = null;

  constructor(overview: Uint8Array, overviewSize: number, displaySize = 168) {
    this.size = displaySize;
    this.canvas = el('canvas', { class: 'minimap-canvas', width: overviewSize, height: overviewSize });
    const ctx = this.canvas.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(overviewSize, overviewSize);
      img.data.set(overview);
      ctx.putImageData(img, 0, 0);
    }
    this.viewport = el('div', { class: 'minimap-viewport' });

    this.root = el('div', { class: 'minimap', title: 'Click to travel' }, [this.canvas, this.viewport]);
    this.root.style.width = `${displaySize}px`;
    this.root.style.height = `${displaySize}px`;

    const navigate = (ev: PointerEvent) => {
      const rect = this.root.getBoundingClientRect();
      const u = (ev.clientX - rect.left) / rect.width;
      const v = (ev.clientY - rect.top) / rect.height;
      this.onNavigate?.(u * WORLD_KM - HALF_KM, v * WORLD_KM - HALF_KM);
    };
    this.root.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      navigate(e);
    });
  }

  /** Draws the current view footprint. */
  update(focusX: number, focusZ: number, camDistance: number, fovRad: number, aspect: number): void {
    const halfHeightKm = Math.tan(fovRad / 2) * camDistance;
    const halfWidthKm = halfHeightKm * aspect;
    const w = (halfWidthKm * 2 / WORLD_KM) * this.size;
    const h = (halfHeightKm * 2 / WORLD_KM) * this.size;
    const cx = ((focusX + HALF_KM) / WORLD_KM) * this.size;
    const cy = ((focusZ + HALF_KM) / WORLD_KM) * this.size;
    // Clamp so the marker stays visible even when the whole world is in frame.
    const cw = Math.max(6, Math.min(this.size, w));
    const ch = Math.max(6, Math.min(this.size, h));
    this.viewport.style.width = `${cw}px`;
    this.viewport.style.height = `${ch}px`;
    this.viewport.style.transform = `translate3d(${cx - cw / 2}px, ${cy - ch / 2}px, 0)`;
  }
}

export class Readout {
  readonly root: HTMLDivElement;
  private coords: HTMLSpanElement;
  private tier: HTMLSpanElement;
  private altitude: HTMLSpanElement;
  private diag: HTMLDivElement;
  private diagVisible = false;

  constructor() {
    this.coords = el('span', { class: 'readout-coords', text: '—' });
    this.tier = el('span', { class: 'readout-tier', text: '' });
    this.altitude = el('span', { class: 'readout-alt', text: '' });
    this.diag = el('div', { class: 'readout-diag' });
    this.diag.style.display = 'none';
    this.root = el('div', { class: 'readout' }, [
      el('div', { class: 'readout-line' }, [this.coords, this.tier, this.altitude]),
      this.diag,
    ]);
  }

  toggleDiagnostics(): void {
    this.diagVisible = !this.diagVisible;
    this.diag.style.display = this.diagVisible ? '' : 'none';
  }

  get showingDiagnostics(): boolean {
    return this.diagVisible;
  }

  update(x: number, z: number, groundKm: number | null, camDistance: number, tier: ZoomTier): void {
    const lat = zToLatitude(z);
    // Longitude is nominal: the world is a square map, so degrees east are just a
    // convenient way to say "how far across".
    const lon = x / 28.4;
    const latStr = `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lon).toFixed(2)}° ${x >= 0 ? 'E' : 'W'}`;
    const elev = groundKm === null ? '' : ` · ${formatNumber(groundKm * 1000)} m`;
    this.coords.textContent = `${latStr}  ${lonStr}${elev}`;
    this.tier.textContent = TIER_NAMES[tier];
    this.altitude.textContent =
      camDistance >= 100 ? `${formatNumber(camDistance)} km up` : `${camDistance.toFixed(1)} km up`;
  }

  updateDiagnostics(lines: string[]): void {
    if (!this.diagVisible) return;
    this.diag.innerHTML = lines.map((l) => `<span>${l}</span>`).join('');
  }
}

export class ZoomControls {
  readonly root: HTMLDivElement;

  constructor(hooks: {
    zoomIn: () => void;
    zoomOut: () => void;
    reset: () => void;
    fullscreen: () => void;
    tiltUp: () => void;
    tiltDown: () => void;
  }) {
    const make = (glyph: string, title: string, fn: () => void) => {
      const b = el('button', { class: 'ui-icon-btn', type: 'button', title, 'aria-label': title, html: glyph });
      b.addEventListener('click', fn);
      return b;
    };
    this.root = el('div', { class: 'zoom-controls' }, [
      make('&plus;', 'Zoom in', hooks.zoomIn),
      make('&minus;', 'Zoom out', hooks.zoomOut),
      make('&#9651;', 'Tilt up', hooks.tiltUp),
      make('&#9661;', 'Tilt down', hooks.tiltDown),
      make('&#9678;', 'Whole world', hooks.reset),
      make('&#9974;', 'Fullscreen', hooks.fullscreen),
    ]);
  }
}

/** The bar of curated destinations across the bottom. */
export class Bookmarks {
  readonly root: HTMLDivElement;

  constructor(entries: Array<{ label: string; title: string; onPick: () => void }>) {
    this.root = el('div', { class: 'bookmarks' });
    for (const e of entries) {
      const b = el('button', { class: 'bookmark', type: 'button', text: e.label, title: e.title });
      b.addEventListener('click', e.onPick);
      this.root.append(b);
    }
  }
}
