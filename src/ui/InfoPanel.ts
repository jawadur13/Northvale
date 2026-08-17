/**
 * The location panel.
 *
 * Shows what the atlas knows about the selected place. Everything on it comes from
 * the generator, which means every number is a real measurement of the terrain you
 * are looking at rather than flavour text - the elevation is the heightfield's, the
 * discharge is the flow routing's, the population is what the settlement model
 * assigned and what the region's total is built from.
 *
 * The panel also carries the cross-references: the region a place sits in, the
 * continent above that, and for a region its capital and its neighbours. Those are
 * links, so the panel doubles as a way to explore the world by relationship rather
 * than by geography.
 */

import { formatElevation, formatNumber, formatPopulation, roundSignificant } from '../util/math';
import { BIOME_BY_ID } from '../world/gen/biomes';
import { climateLabel, rainfallMm } from '../world/gen/climate';
import { zToLatitude } from '../core/config';
import type { ContinentInfo, CultureInfo, Feature, RegionInfo } from '../world/types';
import { el, esc } from './dom';
import { kindLabel } from './Search';
import { LABEL_ICONS } from './Labels';

export interface InfoContext {
  regions: RegionInfo[];
  continents: ContinentInfo[];
  cultures: CultureInfo[];
  features: Feature[];
  /** Mean annual temperature in Celsius at a world position. */
  temperatureAt: (x: number, z: number) => number;
  /** Precipitation proxy 0..1 at a world position. */
  moistureAt: (x: number, z: number) => number;
  /** Biome id at a world position. */
  biomeAt: (x: number, z: number) => number;
}

export class InfoPanel {
  readonly root: HTMLDivElement;
  private body: HTMLDivElement;
  private ctx: InfoContext;
  private current: Feature | null = null;

  onFlyTo: ((f: Feature) => void) | null = null;
  onSelectId: ((id: number) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(ctx: InfoContext) {
    this.ctx = ctx;
    this.body = el('div', { class: 'info-body' });
    const close = el('button', { class: 'info-close', type: 'button', title: 'Close', html: '&times;' });
    close.addEventListener('click', () => {
      this.hide();
      this.onClose?.();
    });
    this.root = el('div', { class: 'info-panel', 'aria-live': 'polite' }, [close, this.body]);
    this.root.style.display = 'none';
  }

  get selected(): Feature | null {
    return this.current;
  }

  hide(): void {
    this.root.style.display = 'none';
    this.current = null;
  }

  show(f: Feature): void {
    this.current = f;
    this.root.style.display = '';
    this.root.scrollTop = 0;
    this.render(f);
  }

  private render(f: Feature): void {
    const ctx = this.ctx;
    const region = f.region >= 0 ? ctx.regions[f.region] : undefined;
    const continent = f.continent >= 0 ? ctx.continents[f.continent] : undefined;
    const culture = region ? ctx.cultures[region.culture] : undefined;

    const parts: Node[] = [];

    // --- Header ---
    parts.push(
      el('div', { class: 'info-head' }, [
        el('span', { class: 'info-icon', text: LABEL_ICONS[f.kind] ?? '•' }),
        el('div', {}, [
          el('h2', { class: 'info-name', text: f.name }),
          el('div', { class: 'info-kind', text: kindLabel(f.kind) }),
        ]),
      ]),
    );

    // --- Where it is ---
    const place: string[] = [];
    if (region) place.push(`<a data-region="${region.id}">${esc(region.name)}</a>`);
    if (continent) place.push(esc(continent.name));
    if (place.length) {
      parts.push(el('div', { class: 'info-breadcrumb', html: place.join(' <span>›</span> ') }));
    }

    // --- Description ---
    parts.push(el('p', { class: 'info-desc', text: f.description }));

    // --- Anomaly warning ---
    if (f.kind === 'anomaly') {
      parts.push(
        el('div', { class: 'info-anomaly' }, [
          el('strong', { text: 'Surveyed and confirmed.' }),
          el('span', { text: ' This feature is inconsistent with everything else in the world.' }),
        ]),
      );
    }

    // --- Facts ---
    const facts = [...f.facts];

    // Position and climate, computed live so they are true of the terrain as
    // rendered rather than copied at generation time.
    const lat = zToLatitude(f.z);
    const latStr = `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(f.x / 28.4).toFixed(1)}° ${f.x >= 0 ? 'E' : 'W'}`;
    facts.push(`Position ${latStr}, ${lonStr}`);

    if (f.kind !== 'ocean' && f.kind !== 'sea') {
      const t = ctx.temperatureAt(f.x, f.z);
      const m = ctx.moistureAt(f.x, f.z);
      facts.push(`Climate ${climateLabel(t, m)}, about ${formatNumber(rainfallMm(m))} mm a year`);
      const biome = BIOME_BY_ID[ctx.biomeAt(f.x, f.z)];
      if (biome && !facts.some((x) => x.toLowerCase().includes(biome.name.toLowerCase()))) {
        facts.push(`Ground cover: ${biome.name.toLowerCase()}`);
      }
    }

    parts.push(
      el(
        'ul',
        { class: 'info-facts' },
        facts.map((x) => el('li', { text: x })),
      ),
    );

    // --- Region detail ---
    if (f.kind === 'region' && region) {
      if (culture) {
        parts.push(
          el('div', { class: 'info-sub' }, [
            el('h3', { text: `The ${culture.adjective}` }),
            el('p', { text: culture.description }),
          ]),
        );
      }
      if (region.neighbours.length) {
        const links = region.neighbours
          .slice(0, 8)
          .map((id) => `<a data-region="${id}">${esc(ctx.regions[id]?.name ?? '')}</a>`)
          .join(', ');
        parts.push(el('div', { class: 'info-links', html: `<h3>Borders</h3><p>${links}</p>` }));
      }
      if (region.capital >= 0) {
        const cap = ctx.features[region.capital];
        if (cap) {
          parts.push(
            el('div', { class: 'info-links', html: `<h3>Seat</h3><p><a data-feature="${cap.id}">${esc(cap.name)}</a></p>` }),
          );
        }
      }
    }

    // --- Continent detail ---
    if (f.kind === 'continent' && continent) {
      const regionLinks = continent.regions
        .slice(0, 16)
        .map((id) => `<a data-region="${id}">${esc(ctx.regions[id]?.name ?? '')}</a>`)
        .join(', ');
      if (regionLinks) {
        parts.push(el('div', { class: 'info-links', html: `<h3>Regions</h3><p>${regionLinks}</p>` }));
      }
    }

    // --- Settlement extras ---
    if (f.population) {
      const share = region && region.population > 0 ? (f.population / region.population) * 100 : 0;
      if (share > 0.5) {
        parts.push(
          el('div', { class: 'info-note', text: `${share.toFixed(share > 10 ? 0 : 1)}% of ${region?.name}'s population lives here.` }),
        );
      }
    }

    // --- Actions ---
    const fly = el('button', { class: 'info-action', type: 'button', text: 'Fly here' });
    fly.addEventListener('click', () => this.onFlyTo?.(f));
    parts.push(el('div', { class: 'info-actions' }, [fly]));

    this.body.innerHTML = '';
    for (const p of parts) this.body.append(p);

    // Wire the cross-reference links.
    this.body.querySelectorAll('a[data-region]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const rid = Number((a as HTMLElement).dataset.region);
        const rf = ctx.features.find((x) => x.kind === 'region' && x.region === rid);
        if (rf) this.onSelectId?.(rf.id);
      });
    });
    this.body.querySelectorAll('a[data-feature]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        this.onSelectId?.(Number((a as HTMLElement).dataset.feature));
      });
    });
  }
}

/** A small floating readout that follows the cursor on hover. */
export class HoverTip {
  readonly root: HTMLDivElement;
  private visible = false;

  constructor() {
    this.root = el('div', { class: 'hover-tip' });
    this.root.style.display = 'none';
  }

  show(f: Feature, x: number, y: number, regionName?: string): void {
    const bits: string[] = [kindLabel(f.kind)];
    if (regionName) bits.push(regionName);
    if (f.population) bits.push(`pop. ${formatPopulation(f.population)}`);
    else if (f.elevation && Math.abs(f.elevation) > 40) bits.push(formatElevation(f.elevation));
    if (f.extent && f.extent > 30) bits.push(`~${formatNumber(roundSignificant(f.extent * 2, 2))} km across`);

    this.root.innerHTML = `<strong>${esc(f.name)}</strong><span>${esc(bits.join(' · '))}</span>`;
    this.root.style.display = '';
    this.visible = true;
    this.move(x, y);
  }

  move(x: number, y: number): void {
    if (!this.visible) return;
    // Flip to the other side of the cursor near the window edge.
    const w = this.root.offsetWidth || 200;
    const h = this.root.offsetHeight || 44;
    const px = x + w + 26 > window.innerWidth ? x - w - 16 : x + 16;
    const py = y + h + 26 > window.innerHeight ? y - h - 14 : y + 14;
    this.root.style.transform = `translate3d(${Math.round(px)}px, ${Math.round(py)}px, 0)`;
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.style.display = 'none';
  }
}
