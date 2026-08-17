/**
 * The gazetteer search.
 *
 * Searching an atlas of four thousand places is not a text-search problem, it is a
 * ranking problem: "val" should surface Valeron the capital before Valeron Cross
 * the hamlet, and "sea" should surface the Amber Sea before a random shipwreck.
 * So the score combines match quality with the feature's own importance, and the
 * result rows show the kind and the region, because the name alone often is not
 * enough to tell two places apart.
 *
 * The whole index is a flat array. With four thousand entries and a scorer that
 * bails out early, a full scan per keystroke costs well under a millisecond -
 * cheaper than maintaining a trie and far easier to rank well.
 */

import { formatNumber, formatPopulation } from '../util/math';
import { highlight, scoreMatch } from '../util/fuzzy';
import type { Feature, RegionInfo } from '../world/types';
import { el } from './dom';
import { LABEL_ICONS } from './Labels';

/** Human-readable name for each feature kind, shown in result rows. */
const KIND_LABEL: Record<string, string> = {
  capital: 'Capital city',
  city: 'City',
  town: 'Town',
  village: 'Village',
  hamlet: 'Hamlet',
  continent: 'Continent',
  region: 'Region',
  ocean: 'Ocean',
  sea: 'Sea',
  gulf: 'Gulf',
  bay: 'Bay',
  strait: 'Strait',
  channel: 'Channel',
  sound: 'Sound',
  river: 'River',
  lake: 'Lake',
  marsh: 'Wetland',
  waterfall: 'Waterfall',
  delta: 'Delta',
  reef: 'Reef',
  range: 'Mountain range',
  peak: 'Summit',
  volcano: 'Volcano',
  pass: 'Pass',
  plateau: 'Plateau',
  valley: 'Valley',
  canyon: 'Canyon',
  cliff: 'Cliffs',
  glacier: 'Glacier',
  dunes: 'Sand sea',
  island: 'Island',
  archipelago: 'Archipelago',
  cape: 'Cape',
  forest: 'Forest',
  grove: 'Grove',
  anomaly: 'Anomaly',
  castle: 'Castle',
  fortress: 'Fortress',
  watchtower: 'Watchtower',
  tower: 'Tower',
  temple: 'Temple',
  monastery: 'Monastery',
  shrine: 'Shrine',
  observatory: 'Observatory',
  mine: 'Mine',
  quarry: 'Quarry',
  farm: 'Farm',
  ranch: 'Ranch',
  vineyard: 'Vineyard',
  watermill: 'Watermill',
  windmill: 'Windmill',
  sawmill: 'Sawmill',
  saltworks: 'Saltworks',
  port: 'Port',
  lighthouse: 'Lighthouse',
  shipwreck: 'Wreck',
  ferry: 'Ferry',
  outpost: 'Outpost',
  inn: 'Inn',
  cabin: 'Cabin',
  camp: 'Camp',
  caravanserai: 'Caravanserai',
  oasis: 'Oasis',
  ruin: 'Ruins',
  monument: 'Monument',
  standing_stones: 'Standing stones',
  tomb: 'Tomb',
  battlefield: 'Battlefield',
  cave: 'Cave',
  geyser: 'Geyser',
  crater: 'Crater',
  arch: 'Natural arch',
  sinkhole: 'Sinkhole',
  spring: 'Spring',
  bridge: 'Bridge',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/_/g, ' ');
}

interface Scored {
  feature: Feature;
  score: number;
  ranges: Array<[number, number]>;
}

export class SearchPanel {
  readonly root: HTMLDivElement;
  private input: HTMLInputElement;
  private results: HTMLDivElement;
  private features: Feature[];
  private regions: RegionInfo[];
  private current: Scored[] = [];
  private highlighted = -1;
  private open = false;

  onPick: ((f: Feature) => void) | null = null;
  onPreview: ((f: Feature | null) => void) | null = null;

  constructor(features: Feature[], regions: RegionInfo[]) {
    this.features = features;
    this.regions = regions;

    this.input = el('input', {
      class: 'search-input',
      type: 'search',
      placeholder: 'Search 5,000 places',
      autocomplete: 'off',
      spellcheck: false,
      'aria-label': 'Search the gazetteer',
    });
    this.results = el('div', { class: 'search-results', role: 'listbox' });

    this.root = el('div', { class: 'search-panel' }, [
      el('div', { class: 'search-field' }, [
        el('span', { class: 'search-icon', html: '&#9906;' }),
        this.input,
        el('kbd', { class: 'search-hint', text: '/' }),
      ]),
      this.results,
    ]);

    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('focus', () => {
      if (this.input.value) this.run();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => {
      // A short delay so a click on a result still registers.
      window.setTimeout(() => this.close(), 140);
    });

    // "/" focuses search from anywhere, which is the convention users expect.
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '/') {
        e.preventDefault();
        this.focus();
      }
    });
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  /** Puts a name in the box and shows its matches, without stealing focus. */
  setQuery(q: string): void {
    this.input.value = q;
    this.run();
  }

  private close(): void {
    this.open = false;
    this.results.classList.remove('is-open');
    this.highlighted = -1;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.input.value = '';
      this.close();
      this.input.blur();
      return;
    }
    if (!this.open || !this.current.length) {
      if (e.key === 'Enter') this.run();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.moveHighlight(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.moveHighlight(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = this.current[Math.max(0, this.highlighted)];
      if (pick) {
        this.onPick?.(pick.feature);
        this.close();
        this.input.blur();
      }
    }
  }

  private moveHighlight(delta: number): void {
    this.highlighted = Math.max(0, Math.min(this.current.length - 1, this.highlighted + delta));
    const rows = this.results.querySelectorAll('.search-row');
    rows.forEach((r, i) => r.classList.toggle('is-active', i === this.highlighted));
    const active = rows[this.highlighted] as HTMLElement | undefined;
    active?.scrollIntoView({ block: 'nearest' });
    const f = this.current[this.highlighted]?.feature;
    if (f) this.onPreview?.(f);
  }

  private run(): void {
    const q = this.input.value.trim();
    if (q.length === 0) {
      this.current = [];
      this.results.innerHTML = '';
      this.close();
      return;
    }

    const scored: Scored[] = [];
    for (const f of this.features) {
      const m = scoreMatch(f.name, q);
      if (!m) continue;
      // Importance breaks ties between equally good textual matches, which is what
      // puts a capital above a hamlet that happens to share a syllable.
      scored.push({ feature: f, score: m.score + f.importance * 90, ranges: m.ranges });
    }

    // Also match on the kind, so "waterfall" or "castle" lists them.
    if (scored.length < 8) {
      const lower = q.toLowerCase();
      for (const f of this.features) {
        if (scored.some((s) => s.feature.id === f.id)) continue;
        const label = kindLabel(f.kind).toLowerCase();
        if (label.startsWith(lower) || f.kind.startsWith(lower)) {
          scored.push({ feature: f, score: 90 + f.importance * 120, ranges: [] });
        }
        if (scored.length > 400) break;
      }
    }

    scored.sort((a, b) => b.score - a.score);
    this.current = scored.slice(0, 60);
    this.render(q);
  }

  private render(query: string): void {
    this.results.innerHTML = '';
    if (!this.current.length) {
      this.results.append(el('div', { class: 'search-empty', text: `Nothing named like "${query}"` }));
      this.results.classList.add('is-open');
      this.open = true;
      return;
    }

    for (let i = 0; i < this.current.length; i++) {
      const { feature, ranges } = this.current[i];
      const region = feature.region >= 0 ? this.regions[feature.region] : undefined;
      const meta: string[] = [kindLabel(feature.kind)];
      if (region) meta.push(region.name);
      if (feature.population) meta.push(`pop. ${formatPopulation(feature.population)}`);
      else if (feature.kind === 'peak' || feature.kind === 'volcano') {
        meta.push(`${formatNumber(feature.elevation)} m`);
      }

      const row = el('div', {
        class: 'search-row',
        role: 'option',
        'data-kind': feature.kind,
      }, [
        el('span', { class: 'search-row-icon', text: LABEL_ICONS[feature.kind] ?? '•' }),
        el('span', { class: 'search-row-body' }, [
          el('span', { class: 'search-row-name', html: highlight(feature.name, ranges) }),
          el('span', { class: 'search-row-meta', text: meta.join(' · ') }),
        ]),
      ]);
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.onPick?.(feature);
        this.close();
        this.input.blur();
      });
      row.addEventListener('pointerenter', () => {
        this.highlighted = i;
        this.results.querySelectorAll('.search-row').forEach((r, k) => r.classList.toggle('is-active', k === i));
      });
      this.results.append(row);
    }

    this.results.classList.add('is-open');
    this.open = true;
    this.highlighted = 0;
    (this.results.firstElementChild as HTMLElement | null)?.classList.add('is-active');
  }
}
