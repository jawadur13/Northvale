/**
 * Visual regression harness.
 *
 * Drives the built atlas in a real browser, waits for the world to finish
 * generating, then flies the camera to a series of viewpoints and captures each
 * one. Console errors, page errors and WebGL warnings are collected and reported,
 * because a shader that fails to compile produces a black screen and no exception
 * anywhere a unit test would look.
 *
 *   npx tsx scripts/visual.ts            # against http://localhost:4173
 *   npx tsx scripts/visual.ts <baseUrl>
 *
 * Requires a locally installed Chrome or Edge; it does not download a browser.
 */

import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Serves the production build. The harness runs its own server rather than
 * depending on a separately started `vite preview`, so the whole check is one
 * command and cannot silently test a stale or absent build.
 */
function serve(root: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const rel = url === '/' ? 'index.html' : decodeURIComponent(url).replace(/^\/+/, '');
    const file = join(root, normalize(rel).replace(/^(\.\.[\/])+/, ''));
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser(): string {
  for (const c of CANDIDATES) if (existsSync(c)) return c;
  throw new Error('No Chrome or Edge installation found.');
}

interface Shot {
  name: string;
  /** Runs in the page to set up the view. Returns when the camera is placed. */
  setup: string;
  /** Extra settle time in ms after setup. */
  settle: number;
}

const SHOTS: Shot[] = [
  {
    name: '01-world',
    setup: 'window.__nv.jumpTo(-120, -60, 4500, -0.35, 0.2)',
    settle: 2600,
  },
  {
    name: '02-continent',
    setup: 'window.__nv.jumpTo(-620, -1120, 1500, -0.3, 0.42)',
    settle: 3200,
  },
  {
    name: '03-regional-mountains',
    setup: 'window.__nv.jumpTo(-1080, -1080, 300, 0.5, 0.8)',
    settle: 3200,
  },
  {
    name: '04-local-city',
    setup: 'window.__nv.jumpToBiggestCity(7)',
    settle: 3600,
  },
  {
    name: '05-coast-close',
    setup: 'window.__nv.jumpToPort()',
    settle: 3600,
  },
  {
    name: '06-anomaly-tessellation',
    setup: 'window.__nv.jumpToNamed("The Tessellation")',
    settle: 3600,
  },
  {
    name: '07-anomaly-vantage',
    setup: 'window.__nv.jumpToNamed("Vantage")',
    settle: 3600,
  },
  {
    name: '08-political-layer',
    setup: 'window.__nv.jumpTo(-620, -1120, 1500, -0.3, 0.42); window.__nv.setLayer("political", true); window.__nv.setLayer("borders", true)',
    settle: 3000,
  },
  {
    name: '09-hypsometric-contours',
    setup:
      'window.__nv.setLayer("political", false); window.__nv.setLayer("elevation", true); window.__nv.setLayer("contours", true); window.__nv.jumpTo(-1080, -1080, 620, 0.4, 0.55)',
    settle: 3200,
  },
  {
    name: '10-dusk',
    setup:
      'window.__nv.setLayer("elevation", false); window.__nv.setLayer("contours", false); window.__nv.setTimeOfDay(0.735); window.__nv.jumpTo(-900, -1000, 260, 1.1, 0.92)',
    settle: 3200,
  },
];

async function main(): Promise<void> {
  mkdirSync('out/shots', { recursive: true });
  if (!existsSync('dist/index.html')) {
    throw new Error('No production build found. Run `npm run build` first.');
  }
  const port = 4288;
  const server = await serve('dist', port);
  const base = process.argv[2] ?? `http://localhost:${port}/`;

  const browser: Browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: [
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--window-size=1600,1000',
      '--mute-audio',
    ],
    defaultViewport: { width: 1600, height: 1000 },
  });

  const page: Page = await browser.newPage();
  const errors: string[] = [];
  const warnings: string[] = [];

  page.on('console', (m) => {
    const t = m.type();
    const text = m.text();
    if (t === 'error') errors.push(text);
    else if (t === 'warn' || t === 'verbose') warnings.push(text);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${(e as Error).message}`));
  page.on('requestfailed', (r) => {
    errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`);
  });

  console.log(`Opening ${base}`);
  await page.goto(base, { waitUntil: 'load', timeout: 60000 });

  console.log('Waiting for the world to finish generating (software WebGL, so this is slow)...');
  await page.waitForFunction('window.__nv && window.__nv.ready === true', {
    timeout: 300000,
    polling: 500,
  });
  const genInfo = (await page.evaluate('window.__nv.info()')) as Record<string, unknown>;
  console.log('World ready:', JSON.stringify(genInfo));

  // Let the first frames settle so the terrain quadtree and labels are populated.
  await sleep(4000);

  for (const shot of SHOTS) {
    await page.evaluate(shot.setup);
    await sleep(shot.settle);
    const path = `out/shots/${shot.name}.png` as const;
    await page.screenshot({ path });
    const stats = (await page.evaluate('window.__nv.stats()')) as Record<string, unknown>;
    console.log(`  ${shot.name}  ${JSON.stringify(stats)}`);
  }

  // A brief interaction sanity check: drag, wheel, and a click.
  await page.mouse.move(800, 500);
  await page.mouse.down();
  await page.mouse.move(700, 460, { steps: 8 });
  await page.mouse.up();
  await sleep(600);
  await page.mouse.wheel({ deltaY: -600 });
  await sleep(900);
  await page.screenshot({ path: 'out/shots/11-after-interaction.png' });

  // Search behaviour.
  await page.click('.search-input');
  await page.type('.search-input', 'Vale', { delay: 24 });
  await sleep(700);
  const results = await page.$$eval('.search-row-name', (els) => els.slice(0, 6).map((e) => e.textContent ?? ''));
  console.log('  search "Vale" ->', results.join(' | '));
  await page.screenshot({ path: 'out/shots/12-search.png' });

  console.log(`\nConsole errors: ${errors.length}`);
  for (const e of [...new Set(errors)].slice(0, 25)) console.log(`  ERROR ${e}`);
  const interesting = [...new Set(warnings)].filter(
    (w) => /shader|program|gl_|webgl|texture|attribute|uniform/i.test(w),
  );
  console.log(`Graphics warnings: ${interesting.length}`);
  for (const w of interesting.slice(0, 20)) console.log(`  WARN ${w}`);

  await browser.close();
  server.close();
  process.exit(errors.length ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
