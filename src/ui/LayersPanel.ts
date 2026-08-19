/**
 * Layers, legend and settings.
 *
 * The default state is deliberately sparse - terrain, water, rivers, roads,
 * settlements, labels - because the point of the map is the world, not the
 * controls. Everything analytical is available and everything analytical is off:
 * political fill, borders, contour lines, the graticule, the hypsometric ramp, the
 * thematic biome map.
 *
 * The thematic layers behave as a radio group even though they are drawn as
 * checkboxes, because a hypsometric tint and a biome tint composited on top of one
 * another is not a map of anything.
 */

import { MAX_EXAGGERATION, MIN_EXAGGERATION, QUALITY_PRESETS, type QualityName } from '../core/config';
import { BIOMES } from '../world/gen/biomes';
import type { LayerState } from '../render/WorldView';
import { checkbox, el, section, segmented, slider } from './dom';

export interface LayerPanelHooks {
  setLayer: (key: keyof LayerState, value: boolean) => void;
  getLayers: () => Readonly<LayerState>;
  setExaggeration: (v: number) => void;
  getExaggeration: () => number;
  setReliefShading: (v: number) => void;
  getReliefShading: () => number;
  setQuality: (q: QualityName) => void;
  getQuality: () => QualityName;
  setTimeOfDay: (v: number) => void;
  getTimeOfDay: () => number;
  setSunAzimuth: (v: number) => void;
  getSunAzimuth: () => number;
  setRoadDetail: (maxClass: number) => void;
  setLabelDensity: (n: number) => void;
  regenerate: (seed: number) => void;
  currentSeed: () => number;
}

/** Thematic layers are exclusive: turning one on turns the others off. */
const THEMATIC: Array<keyof LayerState> = ['elevation', 'biomes', 'political'];

export class LayersPanel {
  readonly root: HTMLDivElement;
  private hooks: LayerPanelHooks;
  private checkboxes = new Map<keyof LayerState, HTMLInputElement>();
  private collapsed = false;
  private tabs: HTMLDivElement;
  private pages = new Map<string, HTMLDivElement>();

  constructor(hooks: LayerPanelHooks) {
    this.hooks = hooks;

    const toggle = el('button', { class: 'panel-toggle', type: 'button', title: 'Hide panel', html: '&#9776;' });
    toggle.addEventListener('click', () => this.setCollapsed(!this.collapsed));

    this.tabs = el('div', { class: 'panel-tabs' });
    const body = el('div', { class: 'panel-body' });

    const layersPage = this.buildLayersPage();
    const legendPage = this.buildLegendPage();
    const settingsPage = this.buildSettingsPage();
    this.pages.set('layers', layersPage);
    this.pages.set('legend', legendPage);
    this.pages.set('settings', settingsPage);
    body.append(layersPage, legendPage, settingsPage);

    for (const [id, label] of [
      ['layers', 'Layers'],
      ['legend', 'Legend'],
      ['settings', 'Settings'],
    ] as const) {
      const b = el('button', { type: 'button', text: label });
      b.addEventListener('click', () => this.showPage(id));
      this.tabs.append(b);
    }

    this.root = el('div', { class: 'layers-panel' }, [
      el('div', { class: 'panel-head' }, [
        el('span', { class: 'panel-title', text: 'Northvale' }),
        toggle,
      ]),
      this.tabs,
      body,
    ]);

    this.showPage('layers');
  }

  private showPage(id: string): void {
    for (const [key, page] of this.pages) page.style.display = key === id ? '' : 'none';
    this.tabs.querySelectorAll('button').forEach((b, i) => {
      b.classList.toggle('is-active', ['layers', 'legend', 'settings'][i] === id);
    });
  }

  setCollapsed(v: boolean): void {
    this.collapsed = v;
    this.root.classList.toggle('is-collapsed', v);
  }

  private addCheck(
    parent: HTMLElement,
    key: keyof LayerState,
    label: string,
    hint?: string,
  ): void {
    const layers = this.hooks.getLayers();
    const row = checkbox(label, layers[key], (v) => this.onCheck(key, v), hint);
    const input = row.querySelector('input') as HTMLInputElement;
    this.checkboxes.set(key, input);
    parent.append(row);
  }

  private onCheck(key: keyof LayerState, value: boolean): void {
    this.hooks.setLayer(key, value);
    if (value && THEMATIC.includes(key)) {
      // Exclusive: a hypsometric ramp under a biome tint is a map of nothing.
      for (const other of THEMATIC) {
        if (other === key) continue;
        const box = this.checkboxes.get(other);
        if (box?.checked) {
          box.checked = false;
          this.hooks.setLayer(other, false);
        }
      }
    }
  }

  private buildLayersPage(): HTMLDivElement {
    const page = el('div', { class: 'panel-page' });

    const physical = el('div', { class: 'ui-group' });
    this.addCheck(physical, 'terrain', 'Terrain', 'The relief surface itself');
    this.addCheck(physical, 'water', 'Oceans and lakes');
    this.addCheck(physical, 'rivers', 'Rivers', 'Channels derived from flow routing');
    this.addCheck(physical, 'vegetation', 'Vegetation', 'Instanced trees at close range');
    page.append(section('Physical', [physical]));

    const human = el('div', { class: 'ui-group' });
    this.addCheck(human, 'settlements', 'Towns and cities', 'Streets, plots and buildings');
    this.addCheck(human, 'roads', 'Roads', 'Pathfound between every settlement');
    const roadDetail = segmented(
      [
        { id: '1', label: 'Trunk', title: 'Highways only' },
        { id: '2', label: 'Major', title: 'Highways and roads' },
        { id: '4', label: 'All', title: 'Every track and lane' },
        { id: '5', label: 'Lanes', title: 'Including village lanes' },
      ],
      '5',
      (id) => this.hooks.setRoadDetail(Number(id)),
    );
    human.append(el('div', { class: 'ui-sublabel', text: 'Road detail' }), roadDetail);
    this.addCheck(human, 'landmarks', 'Landmarks', 'Castles, ruins, mines, mills');
    page.append(section('Civilisation', [human]));

    const political = el('div', { class: 'ui-group' });
    this.addCheck(political, 'political', 'Political regions', 'Tint land by region');
    this.addCheck(political, 'borders', 'Borders');
    this.addCheck(political, 'coastline', 'Coastline outline');
    page.append(section('Territory', [political]));

    const thematic = el('div', { class: 'ui-group' });
    this.addCheck(thematic, 'elevation', 'Hypsometric tint', 'Classic atlas elevation ramp');
    this.addCheck(thematic, 'biomes', 'Biomes', 'Thematic climate zones');
    this.addCheck(thematic, 'contours', 'Contour lines');
    this.addCheck(thematic, 'graticule', 'Grid', '256 km reference grid');
    page.append(section('Thematic', [thematic]));

    const labels = el('div', { class: 'ui-group' });
    this.addCheck(labels, 'labels', 'Place names');
    labels.append(
      slider('Label density', 40, 400, 10, 190, (v) => `${v}`, (v) => this.hooks.setLabelDensity(v)),
    );
    page.append(section('Labels', [labels]));

    return page;
  }

  private buildLegendPage(): HTMLDivElement {
    const page = el('div', { class: 'panel-page' });

    // Settlement hierarchy, which is what the symbols mostly encode.
    const symbols: Array<[string, string]> = [
      ['★', 'Capital city'],
      ['◉', 'City'],
      ['●', 'Town'],
      ['▪', 'Village'],
      ['·', 'Hamlet'],
      ['▲', 'Summit or volcano'],
      ['⌓', 'Pass'],
      ['♜', 'Castle'],
      ['⛨', 'Fortress'],
      ['⛏', 'Mine'],
      ['░', 'Ruins'],
      ['⚓', 'Port'],
      ['♨', 'Lighthouse'],
      ['≈', 'Waterfall'],
      ['⛩', 'Temple'],
      ['✝', 'Monastery'],
      ['✘', 'Anomaly'],
    ];
    const symbolList = el(
      'div',
      { class: 'legend-symbols' },
      symbols.map(([glyph, label]) =>
        el('div', { class: 'legend-row' }, [
          el('span', { class: 'legend-glyph', text: glyph }),
          el('span', { text: label }),
        ]),
      ),
    );
    page.append(section('Symbols', [symbolList]));

    // Biome swatches, grouped, using the same reference colours as the shader.
    const groups = new Map<string, typeof BIOMES>();
    for (const b of BIOMES) {
      if (b.group === 'water') continue;
      const arr = groups.get(b.group) ?? [];
      arr.push(b);
      groups.set(b.group, arr);
    }
    const biomeNodes: Node[] = [];
    for (const [group, list] of groups) {
      biomeNodes.push(el('div', { class: 'ui-sublabel', text: group }));
      const grid = el('div', { class: 'legend-biomes' });
      for (const b of list) {
        const sw = el('span', { class: 'legend-swatch', title: b.description });
        sw.style.background = `#${b.color.toString(16).padStart(6, '0')}`;
        grid.append(el('div', { class: 'legend-row', title: b.description }, [sw, el('span', { text: b.name })]));
      }
      biomeNodes.push(grid);
    }
    page.append(section('Land cover', biomeNodes, false));

    const elevationRamp = el('div', { class: 'legend-ramp' });
    elevationRamp.append(
      el('div', { class: 'legend-ramp-bar' }),
      el('div', { class: 'legend-ramp-scale' }, [
        el('span', { text: '−6 km' }),
        el('span', { text: '0' }),
        el('span', { text: '+8 km' }),
      ]),
    );
    page.append(section('Elevation', [elevationRamp], false));

    return page;
  }

  private buildSettingsPage(): HTMLDivElement {
    const page = el('div', { class: 'panel-page' });

    const view = el('div', { class: 'ui-group' });
    view.append(
      slider(
        'Vertical exaggeration',
        MIN_EXAGGERATION,
        MAX_EXAGGERATION,
        0.1,
        this.hooks.getExaggeration(),
        (v) => `${v.toFixed(1)}×`,
        (v) => this.hooks.setExaggeration(v),
      ),
    );
    view.append(
      slider(
        'Relief shading',
        1,
        5,
        0.1,
        this.hooks.getReliefShading(),
        (v) => `${v.toFixed(1)}×`,
        (v) => this.hooks.setReliefShading(v),
      ),
    );
    view.append(
      slider(
        'Time of day',
        0,
        1,
        0.005,
        this.hooks.getTimeOfDay(),
        (v) => formatClock(v),
        (v) => this.hooks.setTimeOfDay(v),
      ),
    );
    view.append(
      slider(
        'Sun bearing',
        -Math.PI,
        Math.PI,
        0.02,
        this.hooks.getSunAzimuth(),
        (v) => `${Math.round((((v * 180) / Math.PI + 360) % 360))}°`,
        (v) => this.hooks.setSunAzimuth(v),
      ),
    );
    page.append(section('View', [view]));

    const quality = el('div', { class: 'ui-group' });
    quality.append(
      segmented(
        (Object.keys(QUALITY_PRESETS) as QualityName[]).map((q) => ({
          id: q,
          label: q[0].toUpperCase() + q.slice(1),
          title: `${QUALITY_PRESETS[q].terrainSegments}² chunks, ${QUALITY_PRESETS[q].shadowSteps} shadow steps`,
        })),
        this.hooks.getQuality(),
        (id) => this.hooks.setQuality(id as QualityName),
      ),
    );
    quality.append(
      el('p', {
        class: 'ui-note',
        text: 'Quality controls chunk density, ray-marched shadow steps, vegetation budget and water detail.',
      }),
    );
    page.append(section('Quality', [quality]));

    const world = el('div', { class: 'ui-group' });
    const seedInput = el('input', {
      class: 'ui-text',
      type: 'text',
      value: `0x${(this.hooks.currentSeed() >>> 0).toString(16)}`,
      spellcheck: false,
    });
    const go = el('button', { class: 'ui-button', type: 'button', text: 'Generate' });
    go.addEventListener('click', () => {
      const raw = seedInput.value.trim();
      const parsed = raw.startsWith('0x') ? parseInt(raw.slice(2), 16) : Number(raw);
      const seed = Number.isFinite(parsed) ? parsed | 0 : hashString(raw);
      this.hooks.regenerate(seed);
    });
    const random = el('button', { class: 'ui-button', type: 'button', text: 'Random' });
    random.addEventListener('click', () => {
      const seed = (Math.random() * 0xffffffff) | 0;
      seedInput.value = `0x${(seed >>> 0).toString(16)}`;
      this.hooks.regenerate(seed);
    });
    world.append(
      el('div', { class: 'ui-sublabel', text: 'World seed' }),
      el('div', { class: 'ui-row' }, [seedInput, go, random]),
      el('p', {
        class: 'ui-note',
        text: 'The same seed always produces the same world. Regenerating discards the current one.',
      }),
    );
    page.append(section('World', [world], false));

    return page;
  }

  /** Reflects external layer changes, e.g. from a keyboard shortcut. */
  syncFromState(): void {
    const layers = this.hooks.getLayers();
    for (const [key, input] of this.checkboxes) {
      input.checked = layers[key];
    }
  }
}

function formatClock(t: number): string {
  const hours = t * 24;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}
