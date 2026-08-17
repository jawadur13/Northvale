/// <reference lib="webworker" />
/**
 * Generation worker.
 *
 * Everything expensive happens here so the loading screen keeps animating at 60
 * fps while a four-thousand-kilometre world is built. All the large typed arrays
 * are transferred rather than copied, so handing roughly 80 MB of textures and
 * geometry to the main thread costs nothing.
 */

import { generateWorld } from './generate';
import type { GenMessage } from './types';

interface StartMessage {
  type: 'generate';
  seed: number;
}

self.onmessage = (ev: MessageEvent<StartMessage>) => {
  if (ev.data?.type !== 'generate') return;

  const post = (msg: GenMessage, transfer?: Transferable[]) => {
    (self as unknown as Worker).postMessage(msg, transfer ?? []);
  };

  try {
    const result = generateWorld(ev.data.seed, (stage, detail, fraction) => {
      post({ type: 'progress', stage, detail, fraction });
    });

    const merged = Object.assign(result.payload, {
      overview: result.overview,
      overviewSize: result.overviewSize,
      riverPerp: result.riverGeometry.perp,
      roadPerp: result.roadGeometry.perp,
    });

    // Transfer every ArrayBuffer we own exactly once.
    const record = merged as unknown as Record<string, unknown>;
    const transfer: Transferable[] = [];
    const seen = new Set<ArrayBufferLike>();
    for (const key of Object.keys(record)) {
      const v = record[key];
      if (v && typeof v === 'object' && 'buffer' in (v as ArrayBufferView)) {
        const buf = (v as ArrayBufferView).buffer;
        if (!seen.has(buf)) {
          seen.add(buf);
          transfer.push(buf as ArrayBuffer);
        }
      }
    }

    post({ type: 'done', payload: merged }, transfer);
  } catch (err) {
    const e = err as Error;
    post({ type: 'error', message: e?.message ?? String(err), stack: e?.stack });
  }
};
