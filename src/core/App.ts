/**
 * The application.
 *
 * Owns the renderer, the world, the camera, the UI, and the frame loop, and wires
 * them to each other. Everything substantial lives elsewhere; this file is the
 * assembly and the interaction policy - what a click means, what the layer toggles
 * reach, what happens when the camera crosses a zoom tier.
 *
 * Two policies here are worth stating because they are what make the atlas feel
 * responsive rather than busy:
 *
 *  - **The frame loop is unconditional but the work in it is not.** Terrain LOD,
 *    labels and instanced scatter each decide for themselves whether anything has
 *    changed enough to justify recomputing. A still camera costs almost nothing.
 *  - **Selection and hover are separate.** Hovering shows a one-line tip and
 *    nothing else moves. Selecting opens the panel and flies the camera. Conflating
 *    them makes a dense map unusable, because the cursor is always over something.
 */

import * as THREE from 'three';
import {
  CAM_WORLD_DISTANCE,
  DEFAULT_SEED,
  QUALITY_PRESETS,
  type QualityName,
  tierForDistance,
  ZoomTier,
} from './config';
import { CameraDirector } from '../camera/CameraDirector';
import { MapControls } from '../camera/MapControls';
import { Picker } from '../interaction/Picker';
import { DEFAULT_LAYERS, WorldView, type LayerState } from '../render/WorldView';
import { MACRO } from './config';
import { Biome, BIOMES } from '../world/gen/biomes';
import type { Feature, GenMessage, WorldPayload } from '../world/types';
import { Bookmarks, Compass, Minimap, Readout, ScaleBar, ZoomControls } from '../ui/Chrome';
import { HoverTip, InfoPanel } from '../ui/InfoPanel';
import { LabelLayer } from '../ui/Labels';
import { LayersPanel } from '../ui/LayersPanel';
import { LoadingScreen, Toast } from '../ui/Loading';
import { SearchPanel } from '../ui/Search';

/** Which feature classes each layer toggle governs, for label and pick filtering. */
function featureVisible(f: Feature, layers: Readonly<LayerState>): boolean {
  switch (f.cls) {
    case 'settlement':
      return layers.settlements;
    case 'structure':
    case 'landmark':
      return layers.landmarks;
    case 'water':
      return layers.water || layers.rivers;
    case 'route':
      return layers.roads;
    case 'territory':
      return true;
    case 'vegetation':
      return layers.vegetation || layers.terrain;
    case 'relief':
    case 'anomaly':
      return true;
    default:
      return true;
  }
}

export class App {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private view: WorldView | null = null;
  private controls: MapControls | null = null;
  private director: CameraDirector | null = null;
  private picker: Picker | null = null;
  private labels: LabelLayer | null = null;
  private payload: WorldPayload | null = null;

  private loading: LoadingScreen;
  private toast = new Toast();
  private search: SearchPanel | null = null;
  private info: InfoPanel | null = null;
  private panel: LayersPanel | null = null;
  private compass = new Compass();
  private scaleBar = new ScaleBar();
  private minimap: Minimap | null = null;
  private readout = new Readout();
  private hoverTip = new HoverTip();
  private zoomControls: ZoomControls | null = null;
  private bookmarks: Bookmarks | null = null;
  private hud: HTMLDivElement;

  private worker: Worker | null = null;
  private seed = DEFAULT_SEED;
  private clock = new THREE.Clock();
  private elapsed = 0;
  private running = false;
  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;
  private lastHoverCheck = 0;
  private hoveredFeature: Feature | null = null;
  private selected: Feature | null = null;
  private frameTimes: number[] = [];
  private lastTier: ZoomTier = ZoomTier.World;
  private lastExclusionSync = -1;
  private autoQuality = true;
  /** The last frame's wall-clock cost, in ms. Read by the city layer next frame. */
  private lastFrameMs = 16;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      // A logarithmic depth buffer is what makes a scene spanning 1.4 km to
      // 7,600 km of camera distance workable without z-fighting on the terrain.
      logarithmicDepthBuffer: true,
      stencil: false,
    });
    this.renderer.setClearColor(0x0b1017, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.94;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'map-canvas';
    container.append(this.renderer.domElement);

    this.hud = document.createElement('div');
    this.hud.className = 'hud';
    container.append(this.hud);

    this.loading = new LoadingScreen();
    container.append(this.loading.root);
    container.append(this.toast.root);
    container.append(this.hoverTip.root);

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      // Reset the clock on return so a backgrounded tab does not produce one
      // enormous delta that teleports the camera.
      if (!document.hidden) this.clock.getDelta();
    });
  }

  // --- Lifecycle ----------------------------------------------------------

  start(seed = DEFAULT_SEED): void {
    this.seed = seed;
    this.generate(seed);
  }

  private generate(seed: number): void {
    this.worker?.terminate();
    this.worker = new Worker(new URL('../world/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<GenMessage>) => {
      const msg = ev.data;
      if (msg.type === 'progress') {
        this.loading.setProgress(msg.stage, msg.detail, msg.fraction);
      } else if (msg.type === 'done') {
        this.onWorldReady(msg.payload);
      } else if (msg.type === 'error') {
        this.loading.setError(msg.message, msg.stack);
        // eslint-disable-next-line no-console
        console.error('World generation failed:', msg.message, msg.stack);
      }
    };
    this.worker.onerror = (e) => {
      this.loading.setError(e.message || 'Worker failed to start');
    };
    this.worker.postMessage({ type: 'generate', seed });
  }

  private onWorldReady(payload: WorldPayload): void {
    this.teardownWorld();
    this.payload = payload;

    const view = new WorldView(payload, this.renderer);
    this.view = view;

    const controls = new MapControls(view.camera, this.renderer.domElement, {
      heightAt: (x, z) => view.resources.heightAt(x, z),
      exaggeration: () => view.getExaggeration(),
    });
    this.controls = controls;
    this.director = new CameraDirector(controls);

    this.picker = new Picker(
      payload.features,
      (x, z) => view.resources.heightAt(x, z),
      () => view.getExaggeration(),
    );

    this.labels = new LabelLayer(
      this.hud,
      payload.features,
      (x, z) => view.resources.heightAt(x, z),
      () => view.getExaggeration(),
    );
    this.labels.onSelect = (f) => this.select(f, true);
    this.labels.onHover = (f) => {
      if (f) this.showHover(f);
      else this.clearHover();
    };

    this.buildUi(payload);

    // Open on the whole world, tilted just enough to read as a physical model.
    controls.setTarget(-120, -60, CAM_WORLD_DISTANCE, -0.35, 0.2);
    controls.applyImmediate();
    controls.onClick = (x, y) => this.onCanvasClick(x, y);

    this.resize();
    this.loading.finish();
    this.pickAutoQuality();

    if (!this.running) {
      this.running = true;
      this.clock.start();
      this.renderer.setAnimationLoop(() => this.frame());
    }

    this.installDebugHandle(payload);

    const s = payload.stats;
    this.toast.show(
      `Northvale: ${payload.features.length.toLocaleString('en-US')} named places, ` +
        `${payload.continents.length} continents, ` +
        `${Math.round(s.coastlineKm).toLocaleString('en-US')} km of coast. Built in ${(s.generationMs / 1000).toFixed(1)}s.`,
      6200,
    );
  }

  /**
   * Exposes a small scripting surface on `window.__nv`.
   *
   * It exists for the visual-regression harness, which has to fly the camera to
   * specific viewpoints and read back frame statistics, and it is genuinely useful
   * from the browser console - `__nv.flyToNamed('The Ouroboros')` is a faster way
   * to check a place than searching for it.
   */
  private installDebugHandle(payload: WorldPayload): void {
    const view = this.view!;
    const director = this.director!;
    const byName = new Map(payload.features.map((f) => [f.name.toLowerCase(), f]));

    const handle = {
      ready: true,
      info: () => ({
        features: payload.features.length,
        continents: payload.continents.length,
        regions: payload.regions.length,
        generationMs: payload.stats.generationMs,
        quality: view.getQuality(),
        floatLinear: view.resources.floatLinear,
      }),
      stats: () => ({
        ...view.frameStats,
        labels: this.labels?.onScreen.length ?? 0,
        distance: Math.round(this.controls?.cameraDistance ?? 0),
      }),
      resetView: () => this.resetView(),
      flyTo: (x: number, z: number, distance: number, azimuth?: number, polar?: number) =>
        director.flyTo({ x, z, distance, azimuth, polar }),
      /** Places the camera with no animation. Used by the visual harness. */
      jumpTo: (x: number, z: number, distance: number, azimuth?: number, polar?: number) =>
        director.jumpTo({ x, z, distance, azimuth, polar }),
      jumpToNamed: (name: string, distance?: number, polar?: number) => {
        const f = byName.get(name.toLowerCase());
        if (!f) return false;
        this.selected = f;
        this.labels?.setSelected(f);
        this.info?.show(f);
        const extent = f.extent ?? 2;
        director.jumpTo({
          x: f.x,
          z: f.z,
          distance: distance ?? Math.max(2.4, extent * 3.1),
          polar: polar ?? 0.8,
        });
        return true;
      },
      jumpToPort: (distance = 14) => {
        // The settlement actually *on* the water, not merely tagged coastal. Half
        // the places tagged coastal are four kilometres inland and up a hill, and
        // the point of this view is the quays.
        const waterDistance = (x: number, z: number): number => {
          for (let d = 0.1; d < 5; d *= 1.4) {
            for (let i = 0; i < 12; i++) {
              const a = (i / 12) * Math.PI * 2;
              if (view.resources.heightAt(x + Math.cos(a) * d, z + Math.sin(a) * d) <= 0) return d;
            }
          }
          return Infinity;
        };
        let best: Feature | null = null;
        let bestD = Infinity;
        for (const x of payload.features) {
          if (x.kind !== 'capital' && x.kind !== 'city') continue;
          if (!(x.tags?.includes('coastal') ?? false)) continue;
          const d = waterDistance(x.x, x.z);
          if (d < bestD) {
            bestD = d;
            best = x;
          }
        }
        const f = best ?? payload.features.find((x) => x.tags?.includes('coastal'));
        if (!f) return false;
        director.jumpTo({ x: f.x, z: f.z, distance, polar: 1.05 });
        return true;
      },
      /** Nearest settlement of a given culture, for comparing plan forms. */
      jumpToCultureCity: (culture: number, distance = 6) => {
        const f = payload.features
          .filter(
            (x) =>
              (x.kind === 'capital' || x.kind === 'city') &&
              x.region >= 0 &&
              payload.regions[x.region]?.culture === culture,
          )
          .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
        if (!f) return false;
        this.selected = f;
        this.labels?.setSelected(f);
        this.info?.show(f);
        director.jumpTo({ x: f.x, z: f.z, distance, polar: 0.72 });
        return true;
      },
      /** Largest settlement of a given tier. */
      jumpToTier: (kind: string, distance = 3) => {
        const f = payload.features
          .filter((x) => x.kind === kind)
          .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
        if (!f) return false;
        this.selected = f;
        this.labels?.setSelected(f);
        this.info?.show(f);
        director.jumpTo({ x: f.x, z: f.z, distance, polar: 0.7 });
        return true;
      },
      /**
       * A landmark of one kind, standing on open land rather than on a cliff.
       *
       * Picking the first of a kind found one quarry perched over deep water with
       * half the view below sea level, and the next on a 2,400 m cliff where the
       * terrain mesh has vertices two hundred metres apart and nothing the size of
       * a quarry can sit on it convincingly. Scoring for dry, *gentle* ground costs
       * a few dozen samples and makes a landmark view mean something.
       */
      jumpToKind: (kind: string, distance = 3) => {
        let best: Feature | null = null;
        let bestScore = -1;
        for (const f of payload.features) {
          if (f.kind !== kind) continue;
          let score = 0;
          for (let dz = -2; dz <= 2; dz++) {
            for (let dx = -2; dx <= 2; dx++) {
              if (view.resources.heightAt(f.x + dx * 1.2, f.z + dz * 1.2) > 0.02) score++;
            }
          }
          const d = 0.4;
          const gx = view.resources.heightAt(f.x + d, f.z) - view.resources.heightAt(f.x - d, f.z);
          const gz = view.resources.heightAt(f.x, f.z + d) - view.resources.heightAt(f.x, f.z - d);
          score -= Math.hypot(gx, gz) * 40;
          // And prefer somewhere people live. Scoring for flat dry ground alone
          // found a quarry on an ice sheet, which proves the geometry and shows
          // nothing else.
          score -= Math.max(0, (f.elevation ?? 0) - 900) * 0.004;
          if (score > bestScore) {
            bestScore = score;
            best = f;
          }
        }
        if (!best) return false;
        this.selected = best;
        this.labels?.setSelected(best);
        this.info?.show(best);
        director.jumpTo({ x: best.x, z: best.z, distance, polar: 0.68 });
        return true;
      },
      /**
       * The largest continuous stretch of one biome, for looking at vegetation.
       *
       * Sampled on a coarse lattice and scored by how much of the neighbourhood
       * agrees, so this finds the *middle* of a forest rather than the first
       * cell of one, which is usually a ragged edge two hundred metres wide.
       */
      jumpToBiome: (name: string, distance = 4) => {
        const target = BIOMES.find((b) => Biome[b.id] === name);
        if (!target) return false;
        let bestScore = -1;
        let bx = 0;
        let bz = 0;
        for (let gz = 4; gz < MACRO - 4; gz += 3) {
          for (let gx = 4; gx < MACRO - 4; gx += 3) {
            if (payload.biomeIds[gz * MACRO + gx] !== target.id) continue;
            let score = 0;
            for (let oz = -3; oz <= 3; oz++) {
              for (let ox = -3; ox <= 3; ox++) {
                if (payload.biomeIds[(gz + oz) * MACRO + gx + ox] === target.id) score++;
              }
            }
            if (score > bestScore) {
              bestScore = score;
              bx = (gx / (MACRO - 1)) * 4096 - 2048;
              bz = (gz / (MACRO - 1)) * 4096 - 2048;
            }
          }
        }
        if (bestScore < 0) return false;
        director.jumpTo({ x: bx, z: bz, distance, polar: 0.72 });
        return true;
      },
      jumpToBiggestCity: (distance = 9) => {
        const f = payload.features
          .filter((x) => x.kind === 'capital' || x.kind === 'city')
          .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
        if (!f) return false;
        this.selected = f;
        this.labels?.setSelected(f);
        this.info?.show(f);
        director.jumpTo({ x: f.x, z: f.z, distance, polar: 0.78 });
        return true;
      },
      flyToNamed: (name: string) => {
        const f = byName.get(name.toLowerCase());
        if (f) this.select(f, true);
        return !!f;
      },
      flyToKind: (kind: string, distance: number) => {
        const f = payload.features.find((x) => x.kind === kind);
        if (f) director.flyTo({ x: f.x, z: f.z, distance, polar: 0.85 });
        return !!f;
      },
      flyToBiggestCity: () => {
        const f = payload.features
          .filter((x) => x.kind === 'capital' || x.kind === 'city')
          .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
        if (f) director.flyTo({ x: f.x, z: f.z, distance: 9, polar: 0.95 });
        return !!f;
      },
      setLayer: (key: string, value: boolean) => {
        view.setLayer(key as keyof LayerState, value);
        if (key === 'labels') this.labels?.setEnabled(value);
        this.panel?.syncFromState();
      },
      setTimeOfDay: (v: number) => view.atmosphere.setTimeOfDay(v),
      setExaggeration: (v: number) => view.setExaggeration(v),
      setReliefShading: (v: number) => view.setReliefShading(v),
      setQuality: (q: string) => {
        this.autoQuality = false;
        view.setQuality(q as QualityName);
      },
      features: () => payload.features,
    };

    (window as unknown as Record<string, unknown>).__nv = handle;
  }

  private teardownWorld(): void {
    this.labels?.dispose();
    this.controls?.detach();
    this.view?.dispose();
    this.hud.innerHTML = '';
    this.view = null;
    this.controls = null;
    this.director = null;
    this.picker = null;
    this.labels = null;
    this.info = null;
    this.search = null;
    this.panel = null;
    this.minimap = null;
    this.selected = null;
  }

  // --- UI -----------------------------------------------------------------

  private buildUi(payload: WorldPayload): void {
    const view = this.view!;
    const controls = this.controls!;
    const director = this.director!;

    this.search = new SearchPanel(payload.features, payload.regions);
    this.search.onPick = (f) => this.select(f, true);

    this.info = new InfoPanel({
      regions: payload.regions,
      continents: payload.continents,
      cultures: payload.cultures,
      features: payload.features,
      temperatureAt: (x, z) => this.sampleClimate(x, z, 0) * 80 - 40,
      moistureAt: (x, z) => this.sampleClimate(x, z, 1),
      biomeAt: (x, z) => this.sampleBiome(x, z),
    });
    this.info.onFlyTo = (f) => this.flyToFeature(f);
    this.info.onSelectId = (id) => {
      const f = payload.features[id];
      if (f) this.select(f, true);
    };
    this.info.onClose = () => {
      this.selected = null;
      this.labels?.setSelected(null);
    };

    this.panel = new LayersPanel({
      setLayer: (k, v) => {
        view.setLayer(k, v);
        if (k === 'labels') this.labels?.setEnabled(v);
      },
      getLayers: () => view.getLayers(),
      setExaggeration: (v) => view.setExaggeration(v),
      getExaggeration: () => view.getExaggeration(),
      setReliefShading: (v) => view.setReliefShading(v),
      getReliefShading: () => view.getReliefShading(),
      setQuality: (q) => {
        this.autoQuality = false;
        view.setQuality(q);
      },
      getQuality: () => view.getQuality(),
      setTimeOfDay: (v) => view.atmosphere.setTimeOfDay(v),
      getTimeOfDay: () => view.atmosphere.getTimeOfDay(),
      setSunAzimuth: (v) => view.atmosphere.setAzimuth(v),
      getSunAzimuth: () => view.atmosphere.getAzimuth(),
      setRoadDetail: (v) => view.setRoadDetail(v),
      setLabelDensity: (n) => this.labels?.setMaxLabels(n),
      regenerate: (seed) => {
        this.seed = seed;
        this.container.append(this.loading.root);
        this.loading.root.classList.remove('is-done');
        this.generate(seed);
      },
      currentSeed: () => this.seed,
    });

    this.compass.onReset = () => {
      controls.setNorthUp();
    };
    this.compass.root.addEventListener('dblclick', () => this.resetView());

    this.zoomControls = new ZoomControls({
      zoomIn: () => controls.zoomBy(0.62),
      zoomOut: () => controls.zoomBy(1.62),
      reset: () => this.resetView(),
      fullscreen: () => this.toggleFullscreen(),
      tiltUp: () => controls.tiltBy(-0.16),
      tiltDown: () => controls.tiltBy(0.16),
    });

    const extra = payload as unknown as { overview?: Uint8Array; overviewSize?: number };
    if (extra.overview && extra.overviewSize) {
      this.minimap = new Minimap(extra.overview, extra.overviewSize);
      this.minimap.onNavigate = (x, z) => {
        director.flyTo({ x, z, distance: Math.min(controls.cameraDistance, 900) });
      };
    }

    // Curated destinations: the namesake valley, the largest city, the strangest
    // places. This is the first thing many people will click, so it is chosen
    // rather than generated.
    const find = (pred: (f: Feature) => boolean) => payload.features.find(pred);
    const biggestCity = payload.features
      .filter((f) => f.kind === 'capital' || f.kind === 'city')
      .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
    const highest = payload.features
      .filter((f) => f.kind === 'peak' || f.kind === 'volcano')
      .sort((a, b) => b.elevation - a.elevation)[0];
    const bookmarkDefs: Array<{ label: string; title: string; feature?: Feature }> = [
      { label: 'Whole world', title: 'Return to the world view' },
      { label: 'Northvale', title: 'The valley the world is named for', feature: find((f) => f.name === 'Northvale') },
      { label: biggestCity?.name ?? 'Largest city', title: 'The largest city in the world', feature: biggestCity },
      { label: highest?.name ?? 'Highest peak', title: 'The highest ground in the world', feature: highest },
      { label: 'Vantage', title: 'A spire that should not be standing', feature: find((f) => f.name === 'Vantage') },
      { label: 'The Tessellation', title: 'Eleven thousand square kilometres of hexagons', feature: find((f) => f.name === 'The Tessellation') },
      { label: 'The Ouroboros', title: 'A river that flows in a closed loop', feature: find((f) => f.name === 'The Ouroboros') },
      { label: 'The Sundering', title: 'A cleft with parallel walls for 206 km', feature: find((f) => f.name === 'The Sundering') },
    ];
    this.bookmarks = new Bookmarks(
      bookmarkDefs
        .filter((b, i) => i === 0 || b.feature)
        .map((b) => ({
          label: b.label,
          title: b.title,
          onPick: () => {
            if (!b.feature) this.resetView();
            else this.select(b.feature, true);
          },
        })),
    );

    this.hud.append(
      this.search.root,
      this.panel.root,
      this.info.root,
      this.labels!.root,
      el2('div', 'hud-bottom-left', [this.scaleBar.root, this.readout.root]),
      el2('div', 'hud-bottom-right', [this.minimap?.root, this.zoomControls.root].filter(Boolean) as HTMLElement[]),
      el2('div', 'hud-top-right', [this.compass.root]),
      this.bookmarks.root,
    );

    this.attachKeyboard();

    // Pointer tracking for the hover tip and for picking.
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      this.pointerInside = true;
      this.hoverTip.move(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this.clearHover();
    });
  }

  private attachKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const view = this.view;
      if (!view) return;

      switch (e.key.toLowerCase()) {
        case 'l':
          this.toggleLayer('labels');
          break;
        case 'p':
          this.toggleLayer('political');
          break;
        case 'c':
          this.toggleLayer('contours');
          break;
        case 'b':
          this.toggleLayer('borders');
          break;
        case 'v':
          this.toggleLayer('vegetation');
          break;
        case 'h':
          this.toggleLayer('elevation');
          break;
        case 'g':
          this.toggleLayer('graticule');
          break;
        case 'home':
          this.resetView();
          break;
        case 'f':
          if (e.shiftKey) this.toggleFullscreen();
          break;
        case '?':
          this.readout.toggleDiagnostics();
          break;
        case 'escape':
          this.info?.hide();
          this.selected = null;
          this.labels?.setSelected(null);
          break;
      }
    });
  }

  private toggleLayer(key: keyof LayerState): void {
    const view = this.view;
    if (!view) return;
    const next = !view.getLayers()[key];
    view.setLayer(key, next);
    if (key === 'labels') this.labels?.setEnabled(next);
    this.panel?.syncFromState();
  }

  // --- Interaction --------------------------------------------------------

  private onCanvasClick(screenX: number, screenY: number): void {
    const view = this.view;
    const picker = this.picker;
    if (!view || !picker) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const layers = view.getLayers();
    const f = picker.pickFeature(
      view.camera,
      screenX - rect.left,
      screenY - rect.top,
      rect.width,
      rect.height,
      // A generous radius on touch, tighter with a mouse.
      window.matchMedia('(pointer: coarse)').matches ? 34 : 22,
      (feat) => featureVisible(feat, layers),
    );
    if (f) {
      this.select(f, false);
    } else {
      this.info?.hide();
      this.selected = null;
      this.labels?.setSelected(null);
    }
  }

  private select(f: Feature, fly: boolean): void {
    this.selected = f;
    this.labels?.setSelected(f);
    this.info?.show(f);
    if (fly) this.flyToFeature(f);
  }

  private flyToFeature(f: Feature): void {
    const director = this.director;
    if (!director) return;
    // Frame extended features by their extent; frame points by their kind.
    const extent =
      f.extent ??
      (f.kind === 'capital' || f.kind === 'city' ? 6 : f.kind === 'town' ? 3 : 1.4);
    director.flyToFeature(f.x, f.z, extent);
  }

  private resetView(): void {
    this.director?.flyTo({ x: -120, z: -60, distance: CAM_WORLD_DISTANCE, azimuth: -0.35, polar: 0.2 });
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void this.container.requestFullscreen?.().catch(() => {
        this.toast.show('Fullscreen was refused by the browser.');
      });
    }
  }

  private showHover(f: Feature): void {
    if (this.hoveredFeature === f) return;
    this.hoveredFeature = f;
    const region = f.region >= 0 ? this.payload?.regions[f.region]?.name : undefined;
    this.hoverTip.show(f, this.pointerX, this.pointerY, region);
    this.renderer.domElement.style.cursor = 'pointer';
  }

  private clearHover(): void {
    if (!this.hoveredFeature) return;
    this.hoveredFeature = null;
    this.hoverTip.hide();
    this.renderer.domElement.style.cursor = '';
  }

  /** Screen rectangles currently covered by interface panels. */
  private panelRects(): Array<{ x: number; y: number; w: number; h: number }> {
    const out: Array<{ x: number; y: number; w: number; h: number }> = [];
    const add = (elem: HTMLElement | undefined | null) => {
      if (!elem || elem.offsetParent === null) return;
      const r = elem.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      // A small margin, so a label never sits tight against a panel edge.
      out.push({ x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 });
    };
    add(this.panel?.root);
    add(this.search?.root);
    add(this.info?.root.style.display === 'none' ? null : this.info?.root);
    add(this.bookmarks?.root);
    add(this.minimap?.root);
    return out;
  }

  // --- Sampling helpers ---------------------------------------------------

  private sampleClimate(x: number, z: number, channel: number): number {
    const p = this.payload;
    if (!p) return 0;
    const gx = Math.round(((x + 2048) / 4096) * (MACRO - 1));
    const gz = Math.round(((z + 2048) / 4096) * (MACRO - 1));
    const cx = Math.min(MACRO - 1, Math.max(0, gx));
    const cz = Math.min(MACRO - 1, Math.max(0, gz));
    return p.climate[(cz * MACRO + cx) * 4 + channel] / 255;
  }

  private sampleBiome(x: number, z: number): number {
    const p = this.payload;
    if (!p) return 0;
    const gx = Math.min(MACRO - 1, Math.max(0, Math.round(((x + 2048) / 4096) * (MACRO - 1))));
    const gz = Math.min(MACRO - 1, Math.max(0, Math.round(((z + 2048) / 4096) * (MACRO - 1))));
    return p.biomeIds[gz * MACRO + gx];
  }

  // --- Quality ------------------------------------------------------------

  private pickAutoQuality(): void {
    const view = this.view;
    if (!view) return;
    const dpr = window.devicePixelRatio || 1;
    const px = window.innerWidth * window.innerHeight * dpr * dpr;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    // A conservative first guess; the frame-time governor refines it.
    let q: QualityName = 'high';
    if (coarse || px > 6_000_000) q = 'medium';
    if (coarse && px > 3_000_000) q = 'low';
    view.setQuality(q);
    this.applyPixelRatio(q);
  }

  private applyPixelRatio(q: QualityName): void {
    const cap = QUALITY_PRESETS[q].pixelRatioCap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
  }

  /**
   * Drops quality if the frame budget is being missed consistently.
   *
   * Deliberately one-directional: a world that quietly ratchets its own quality up
   * and down produces visible pulsing, which is worse than being one tier low.
   */
  private governQuality(frameMs: number): void {
    if (!this.autoQuality || !this.view) return;
    this.frameTimes.push(frameMs);
    if (this.frameTimes.length < 90) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.frameTimes.length = 0;

    const order: QualityName[] = ['low', 'medium', 'high', 'ultra'];
    const current = order.indexOf(this.view.getQuality());
    if (median > 30 && current > 0) {
      const next = order[current - 1];
      this.view.setQuality(next);
      this.applyPixelRatio(next);
      this.panel?.syncFromState();
    }
  }

  // --- Frame --------------------------------------------------------------

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.view?.resize(w, h);
    this.labels?.resize(w, h);
  }

  private frame(): void {
    const t0 = performance.now();
    const dt = Math.min(0.1, this.clock.getDelta());
    this.elapsed += dt;

    const view = this.view;
    const controls = this.controls;
    if (!view || !controls) return;

    this.director?.update(dt);
    controls.update(dt);

    const focus = controls.focus;
    const camDistance = controls.cameraDistance;
    // The previous frame's cost, which is what the city layer sizes its
    // generation slice against — see `GENERATION_FRACTION`.
    view.update(dt, this.elapsed, focus.x, focus.z, camDistance, this.lastFrameMs);

    // Labels, filtered by the layers that are actually on, and kept clear of the
    // interface panels.
    const layers = view.getLayers();
    if (this.elapsed - this.lastExclusionSync > 0.4) {
      this.lastExclusionSync = this.elapsed;
      this.labels?.setExclusions(this.panelRects());
    }
    this.labels?.update(view.camera, camDistance, (f) => featureVisible(f, layers));

    // If a layer toggle hid whatever is selected, close the panel rather than
    // leaving a description of something no longer on the map.
    if (this.selected && !featureVisible(this.selected, layers)) {
      this.info?.hide();
      this.labels?.setSelected(null);
      this.selected = null;
    }

    // Chrome.
    this.compass.update(controls.azimuthAngle, controls.polarAngle);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const halfHeightKm = Math.tan((view.camera.fov * Math.PI) / 360) * camDistance;
    const kmPerPixel = (halfHeightKm * 2) / Math.max(1, rect.height);
    this.scaleBar.update(kmPerPixel);
    this.minimap?.update(focus.x, focus.z, camDistance, (view.camera.fov * Math.PI) / 180, view.camera.aspect);

    const groundKm = view.resources.heightAt(focus.x, focus.z);
    this.readout.update(focus.x, focus.z, groundKm, camDistance, tierForDistance(camDistance));

    // Hover picking, throttled: it raymarches the heightfield and there is no
    // point doing that at 120 Hz.
    if (this.pointerInside && this.elapsed - this.lastHoverCheck > 0.06) {
      this.lastHoverCheck = this.elapsed;
      const picked = this.picker?.pickFeature(
        view.camera,
        this.pointerX - rect.left,
        this.pointerY - rect.top,
        rect.width,
        rect.height,
        18,
        (f) => featureVisible(f, layers),
      );
      if (picked) this.showHover(picked);
      else this.clearHover();
    }

    // Crossing a zoom tier is worth announcing once: it is the moment new
    // information appears on the map, and it is easy to miss.
    const tier = tierForDistance(camDistance);
    if (tier !== this.lastTier) {
      this.lastTier = tier;
    }

    this.renderer.render(view.scene, view.camera);

    const frameMs = performance.now() - t0;
    this.lastFrameMs = frameMs;
    this.governQuality(frameMs);
    if (this.readout.showingDiagnostics) {
      const s = view.frameStats;
      this.readout.updateDiagnostics([
        `${(1000 / Math.max(0.1, frameMs)).toFixed(0)} fps (${frameMs.toFixed(1)} ms)`,
        `${s.chunks} chunks · depth ${s.maxDepth} · ${(s.triangles / 1000).toFixed(0)}k tris`,
        `${s.plants.toLocaleString('en-US')} plants · ${s.buildings.toLocaleString('en-US')} buildings`,
        `${s.planCities} towns · ${s.planBlocks.toLocaleString('en-US')} blocks · ${s.planParcels.toLocaleString('en-US')} plots · rebuild ${s.rebuildMs} ms`,
        `quality ${view.getQuality()} · dpr ${this.renderer.getPixelRatio().toFixed(2)}`,
        `labels ${this.labels?.onScreen.length ?? 0}`,
      ]);
    }
  }
}

/** Local helper: a div with a class and children. Avoids importing the UI helper here. */
function el2(tag: string, className: string, children: Array<HTMLElement | undefined>): HTMLDivElement {
  const n = document.createElement(tag) as HTMLDivElement;
  n.className = className;
  for (const c of children) if (c) n.append(c);
  return n;
}

void DEFAULT_LAYERS;
