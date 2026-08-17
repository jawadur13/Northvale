/**
 * The label layer.
 *
 * Four thousand named places cannot all be labelled at once, and the choice of
 * which to show is the difference between an atlas and a mess. Three mechanisms,
 * applied in order:
 *
 *  1. **Zoom tiers.** Every feature carries the coarsest zoom at which its label
 *     may appear. At world view you see oceans and continents; each step in
 *     reveals a stratum that was not there before. This is authored in the
 *     generator, not derived here, because it is a cartographic decision.
 *  2. **Importance ordering.** Within a tier, candidates are sorted by importance
 *     so that when space runs out it is the hamlets that lose, never the capitals.
 *  3. **Collision rejection on a screen-space grid.** Each accepted label stamps
 *     its box into a uniform grid; a later candidate that overlaps an occupied
 *     cell is dropped. This is O(labels), not O(labels squared), which matters
 *     because it runs every frame.
 *
 * Labels are DOM elements rather than sprites: text rendering, font hinting and
 * accessibility all come free, and a few hundred absolutely-positioned spans are
 * cheap as long as only the transform is touched per frame.
 */

import * as THREE from 'three';
import { tierForDistance, ZoomTier } from '../core/config';
import type { Feature, FeatureKind } from '../world/types';

/** Which glyph marks each kind of place. */
const ICONS: Partial<Record<FeatureKind, string>> = {
  capital: '★',
  city: '◉',
  town: '●',
  village: '▪',
  hamlet: '·',
  castle: '♜',
  fortress: '⛨',
  watchtower: '╤',
  tower: '║',
  temple: '⛩',
  monastery: '✝',
  shrine: '†',
  observatory: '◔',
  mine: '⛏',
  quarry: '◢',
  farm: '⚘',
  ranch: '≋',
  vineyard: '♓',
  watermill: '⚙',
  windmill: '✵',
  sawmill: '⚒',
  saltworks: '▦',
  port: '⚓',
  harbour: '⚓',
  lighthouse: '♨',
  shipwreck: '†',
  ferry: '⇄',
  outpost: '△',
  inn: '☗',
  cabin: '⌂',
  camp: '⛺',
  caravanserai: '☷',
  oasis: '❀',
  ruin: '░',
  monument: '⬛',
  standing_stones: '⸺',
  tomb: '⛬',
  battlefield: '⚔',
  peak: '▲',
  volcano: '▲',
  pass: '⌓',
  cave: '◑',
  waterfall: '≈',
  geyser: '↑',
  canyon: '⌵',
  cliff: '▁',
  plateau: '▬',
  valley: '⌣',
  glacier: '❄',
  dunes: '≋',
  forest: '♣',
  grove: '♣',
  marsh: '░',
  spring: '○',
  crater: '◌',
  arch: '∩',
  delta: '▽',
  sinkhole: '⊖',
  reef: '≈',
  bridge: '⌷',
  anomaly: '✘',
};

/** Style class per feature class, so the CSS carries the visual hierarchy. */
const CLASS_FOR_KIND = (f: Feature): string => {
  switch (f.kind) {
    case 'ocean':
    case 'sea':
      return 'lbl-ocean';
    case 'gulf':
    case 'bay':
    case 'strait':
    case 'channel':
    case 'sound':
      return 'lbl-water-major';
    case 'river':
    case 'lake':
    case 'marsh':
    case 'waterfall':
    case 'delta':
    case 'reef':
      return 'lbl-water';
    case 'continent':
      return 'lbl-continent';
    case 'region':
      return 'lbl-region';
    case 'capital':
      return 'lbl-capital';
    case 'city':
      return 'lbl-city';
    case 'town':
      return 'lbl-town';
    case 'village':
    case 'hamlet':
      return 'lbl-village';
    case 'range':
    case 'peak':
    case 'volcano':
    case 'plateau':
    case 'valley':
    case 'pass':
    case 'canyon':
    case 'cliff':
    case 'glacier':
    case 'dunes':
      return 'lbl-relief';
    case 'island':
    case 'archipelago':
    case 'cape':
      return 'lbl-island';
    case 'forest':
    case 'grove':
      return 'lbl-vegetation';
    case 'anomaly':
      return 'lbl-anomaly';
    default:
      return 'lbl-landmark';
  }
};

interface Slot {
  el: HTMLDivElement;
  feature: Feature | null;
}

export interface LabelFilter {
  (f: Feature): boolean;
}

export class LabelLayer {
  readonly root: HTMLDivElement;
  private slots: Slot[] = [];
  private features: Feature[];
  /** Features bucketed by label tier, pre-sorted by importance. */
  private byTier: Feature[][] = [[], [], [], [], []];
  private grid: Int32Array;
  private gridW = 1;
  private gridH = 1;
  private gridCell = 34;
  private stamp = 0;
  private projected = new THREE.Vector3();
  private maxLabels = 190;
  private width = 1;
  private height = 1;
  private heightAt: (x: number, z: number) => number;
  private exaggeration: () => number;
  private hovered: Feature | null = null;
  private selected: Feature | null = null;
  private visibleFeatures: Feature[] = [];
  private enabled = true;
  /** Screen rectangles the labels must avoid, in CSS pixels. */
  private exclusions: Array<{ x: number; y: number; w: number; h: number }> = [];

  onSelect: ((f: Feature) => void) | null = null;
  onHover: ((f: Feature | null) => void) | null = null;

  constructor(
    container: HTMLElement,
    features: Feature[],
    heightAt: (x: number, z: number) => number,
    exaggeration: () => number,
  ) {
    this.features = features;
    this.heightAt = heightAt;
    this.exaggeration = exaggeration;

    this.root = document.createElement('div');
    this.root.className = 'label-layer';
    container.appendChild(this.root);

    for (const f of features) {
      const tier = Math.max(0, Math.min(4, f.labelTier));
      this.byTier[tier].push(f);
    }
    for (const arr of this.byTier) arr.sort((a, b) => b.importance - a.importance);

    this.grid = new Int32Array(1);
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.root.style.display = v ? '' : 'none';
  }

  setMaxLabels(n: number): void {
    this.maxLabels = n;
  }

  /**
   * Marks regions of the screen as unavailable, so labels are not spent behind
   * the panels. Without this a third of the label budget lands under the layers
   * panel and the map looks emptier than it is.
   */
  setExclusions(rects: Array<{ x: number; y: number; w: number; h: number }>): void {
    this.exclusions = rects;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.gridW = Math.max(1, Math.ceil(width / this.gridCell));
    this.gridH = Math.max(1, Math.ceil(height / this.gridCell));
    this.grid = new Int32Array(this.gridW * this.gridH);
    this.stamp = 0;
  }

  setSelected(f: Feature | null): void {
    this.selected = f;
  }

  /** Features whose labels are currently on screen, for the picker's visibility test. */
  get onScreen(): readonly Feature[] {
    return this.visibleFeatures;
  }

  /**
   * Places labels for this frame.
   *
   * @param filter excludes features whose layer is switched off
   */
  update(camera: THREE.PerspectiveCamera, camDistance: number, filter: LabelFilter): void {
    if (!this.enabled) {
      this.visibleFeatures.length = 0;
      return;
    }

    const tier = tierForDistance(camDistance);
    // Which label tiers are permitted at this zoom. Tier n appears once the
    // camera has descended to zoom tier n, and everything coarser stays.
    const maxTier = tier === ZoomTier.World ? 0 : tier === ZoomTier.Continental ? 1 : tier === ZoomTier.Regional ? 2 : tier === ZoomTier.Local ? 3 : 4;

    this.stamp++;
    const stamp = this.stamp;

    // Stamp the panel rectangles into the collision grid before any label is
    // placed, so they simply read as occupied space.
    for (const r of this.exclusions) {
      const gx0 = Math.max(0, Math.floor(r.x / this.gridCell));
      const gx1 = Math.min(this.gridW - 1, Math.ceil((r.x + r.w) / this.gridCell));
      const gy0 = Math.max(0, Math.floor(r.y / this.gridCell));
      const gy1 = Math.min(this.gridH - 1, Math.ceil((r.y + r.h) / this.gridCell));
      for (let cy = gy0; cy <= gy1; cy++) {
        for (let cx = gx0; cx <= gx1; cx++) this.grid[cy * this.gridW + cx] = stamp;
      }
    }
    const exag = this.exaggeration();
    let used = 0;
    this.visibleFeatures.length = 0;

    // Candidates: every permitted tier, coarsest first, so a continent's label
    // always wins the space over a village's.
    for (let t = 0; t <= maxTier && used < this.maxLabels; t++) {
      const bucket = this.byTier[t];
      for (let i = 0; i < bucket.length; i++) {
        if (used >= this.maxLabels) break;
        const f = bucket[i];
        if (!filter(f)) continue;

        this.projected.set(f.x, this.heightAt(f.x, f.z) * exag, f.z);
        this.projected.project(camera);
        if (this.projected.z <= -1 || this.projected.z >= 1) continue;
        const sx = ((this.projected.x + 1) / 2) * this.width;
        const sy = ((1 - this.projected.y) / 2) * this.height;
        // A margin keeps labels from being half off the edge.
        if (sx < -40 || sy < -20 || sx > this.width + 40 || sy > this.height + 20) continue;

        // Extended features (an ocean, a range) should not be labelled when the
        // camera is far inside them - their centre may be off screen and the label
        // would sit meaninglessly at the edge.
        if (f.extent !== undefined && f.extent > 40 && camDistance < f.extent * 0.55) continue;

        // Estimated label box, in grid cells.
        const isSelected = f === this.selected;
        const wide = Math.max(2, Math.ceil((f.name.length * 6.4 + 26) / this.gridCell));
        const tall = 1;
        const gx = Math.floor(sx / this.gridCell);
        const gy = Math.floor(sy / this.gridCell);

        let clash = false;
        if (!isSelected) {
          for (let cy = gy; cy <= gy + tall && !clash; cy++) {
            if (cy < 0 || cy >= this.gridH) continue;
            for (let cx = gx - 1; cx <= gx + wide; cx++) {
              if (cx < 0 || cx >= this.gridW) continue;
              if (this.grid[cy * this.gridW + cx] === stamp) {
                clash = true;
                break;
              }
            }
          }
        }
        if (clash) continue;

        for (let cy = gy; cy <= gy + tall; cy++) {
          if (cy < 0 || cy >= this.gridH) continue;
          for (let cx = gx - 1; cx <= gx + wide; cx++) {
            if (cx < 0 || cx >= this.gridW) continue;
            this.grid[cy * this.gridW + cx] = stamp;
          }
        }

        const slot = this.slotAt(used);
        this.applySlot(slot, f, sx, sy, isSelected, f === this.hovered);
        this.visibleFeatures.push(f);
        used++;
      }
    }

    // Hide the tail of the pool.
    for (let i = used; i < this.slots.length; i++) {
      if (this.slots[i].feature !== null) {
        this.slots[i].el.style.display = 'none';
        this.slots[i].feature = null;
      }
    }
  }

  private slotAt(i: number): Slot {
    while (this.slots.length <= i) {
      const el = document.createElement('div');
      el.className = 'map-label';
      el.style.display = 'none';
      // Pointer events on the label itself, so a name is clickable even when the
      // marker underneath it is a single pixel.
      el.addEventListener('pointerenter', () => {
        const s = this.slots.find((x) => x.el === el);
        if (s?.feature) {
          this.hovered = s.feature;
          this.onHover?.(s.feature);
        }
      });
      el.addEventListener('pointerleave', () => {
        this.hovered = null;
        this.onHover?.(null);
      });
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const s = this.slots.find((x) => x.el === el);
        if (s?.feature) this.onSelect?.(s.feature);
      });
      this.root.appendChild(el);
      this.slots.push({ el, feature: null });
    }
    return this.slots[i];
  }

  private applySlot(
    slot: Slot,
    f: Feature,
    sx: number,
    sy: number,
    selected: boolean,
    hovered: boolean,
  ): void {
    const el = slot.el;
    if (slot.feature !== f) {
      slot.feature = f;
      const icon = ICONS[f.kind];
      el.innerHTML = icon
        ? `<span class="lbl-icon">${icon}</span><span class="lbl-text"></span>`
        : `<span class="lbl-text"></span>`;
      const text = el.querySelector('.lbl-text') as HTMLElement;
      text.textContent = f.name;
      el.className = `map-label ${CLASS_FOR_KIND(f)}`;
      el.dataset.id = String(f.id);
    }
    el.style.display = '';
    el.style.transform = `translate3d(${Math.round(sx)}px, ${Math.round(sy)}px, 0)`;
    el.classList.toggle('is-selected', selected);
    el.classList.toggle('is-hovered', hovered);
  }

  dispose(): void {
    this.root.remove();
    this.slots.length = 0;
    void this.features;
  }
}

export { ICONS as LABEL_ICONS };
