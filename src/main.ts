/**
 * Entry point.
 *
 * Checks that WebGL2 is actually available before anything else, because the
 * terrain depends on float textures and vertex texture fetch, and a blank canvas
 * with a console error is a worse failure than an honest message.
 */

import './styles/app.css';
import { App } from './core/App';
import { DEFAULT_SEED } from './core/config';

function fail(message: string): void {
  const div = document.createElement('div');
  div.className = 'fatal';
  div.innerHTML = `<div><h1>Northvale cannot start</h1><p>${message}</p></div>`;
  document.body.append(div);
}

function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

const container = document.getElementById('app');
if (!container) {
  fail('The page is missing its container element.');
} else if (!hasWebGL2()) {
  fail(
    'This atlas needs WebGL 2, which this browser does not appear to support. ' +
      'Try a current version of Chrome, Edge, Firefox or Safari, and check that ' +
      'hardware acceleration is enabled.',
  );
} else {
  // A seed can be supplied in the URL, so a particular world can be shared.
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('seed');
  let seed = DEFAULT_SEED;
  if (raw) {
    const parsed = raw.startsWith('0x') ? parseInt(raw.slice(2), 16) : Number(raw);
    if (Number.isFinite(parsed)) seed = parsed | 0;
    else {
      let h = 0x811c9dc5;
      for (let i = 0; i < raw.length; i++) {
        h ^= raw.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      seed = h | 0;
    }
  }

  const app = new App(container);
  app.start(seed);
}
