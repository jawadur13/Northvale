/**
 * The loading screen.
 *
 * Building the world takes several seconds of real computation, and it happens in
 * a worker so this screen stays at full frame rate. It is used to say what is
 * actually being done - filling depressions, marching moisture across the winds,
 * pathfinding between every settlement - because the honest answer is more
 * interesting than a spinner, and because it sets the expectation that the world
 * about to appear was built rather than drawn.
 */

import { el } from './dom';

export class LoadingScreen {
  readonly root: HTMLDivElement;
  private bar: HTMLDivElement;
  private stage: HTMLDivElement;
  private detail: HTMLDivElement;
  private log: HTMLDivElement;
  private lastStage = '';
  private seen = new Set<string>();

  constructor() {
    this.bar = el('div', { class: 'load-bar-fill' });
    this.stage = el('div', { class: 'load-stage', text: 'Preparing' });
    this.detail = el('div', { class: 'load-detail', text: '' });
    this.log = el('div', { class: 'load-log' });

    this.root = el('div', { class: 'loading' }, [
      el('div', { class: 'load-inner' }, [
        el('div', { class: 'load-title' }, [
          el('h1', { text: 'NORTHVALE' }),
          el('p', { text: 'An interactive atlas of a world that does not exist' }),
        ]),
        el('div', { class: 'load-bar' }, [this.bar]),
        this.stage,
        this.detail,
        this.log,
      ]),
    ]);
  }

  setProgress(stage: string, detail: string, fraction: number): void {
    this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    this.stage.textContent = stage;
    this.detail.textContent = detail;
    // One line per distinct stage, so the log reads as a build record rather than
    // as a scrolling wall.
    if (stage !== this.lastStage && !this.seen.has(stage)) {
      this.seen.add(stage);
      this.lastStage = stage;
      this.log.append(el('div', { class: 'load-log-line', text: stage }));
      while (this.log.childElementCount > 9) this.log.firstElementChild?.remove();
    }
  }

  setError(message: string, stack?: string): void {
    this.stage.textContent = 'Generation failed';
    this.detail.textContent = message;
    this.bar.style.background = '#a3473c';
    if (stack) {
      this.log.innerHTML = '';
      this.log.append(el('pre', { class: 'load-stack', text: stack.split('\n').slice(0, 8).join('\n') }));
    }
  }

  /** Fades out and removes itself. */
  finish(): void {
    this.root.classList.add('is-done');
    window.setTimeout(() => this.root.remove(), 900);
  }
}

/** A small toast for transient messages, e.g. a copied link or a failed action. */
export class Toast {
  readonly root: HTMLDivElement;
  private timer = 0;

  constructor() {
    this.root = el('div', { class: 'toast' });
    this.root.style.display = 'none';
  }

  show(message: string, ms = 2600): void {
    this.root.textContent = message;
    this.root.style.display = '';
    this.root.classList.add('is-visible');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.root.classList.remove('is-visible');
      window.setTimeout(() => {
        this.root.style.display = 'none';
      }, 300);
    }, ms);
  }
}
