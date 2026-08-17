/**
 * Headless generation test.
 *
 * Runs the full pipeline in Node and asserts the world is actually a world:
 * plausible land fraction, no non-finite elevations, settlements on dry land,
 * unique names, prose on every feature, and a label tier population that means
 * zooming in actually reveals something.
 *
 *   npm run smoke            # default seed
 *   npm run smoke -- 12345   # any other seed
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { generateWorld } from '../src/world/generate';
import { MACRO, FINE, SEA_LEVEL, DEFAULT_SEED } from '../src/core/config';
import { BIOME_BY_ID } from '../src/world/gen/biomes';
import { encodePNG } from './png';
import { renderDiagnostics } from './diagnostics';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` - ${detail}` : ''}`);
}

const seed = Number(process.argv[2]) || DEFAULT_SEED;
console.log(`\nGenerating Northvale (seed 0x${(seed >>> 0).toString(16)})\n`);

const t0 = Date.now();
const result = generateWorld(seed, (stage, detail, frac) => {
  console.log(`  ${String(Math.round(frac * 100)).padStart(3)}%  ${stage} - ${detail}`);
});
const elapsed = Date.now() - t0;
const p = result.payload;

console.log(`\nGenerated in ${elapsed} ms\n`);

console.log('Buffers:');
check('height buffer is the render resolution', p.height.length === FINE * FINE, `${p.height.length}`);
check('climate buffer is the simulation resolution', p.climate.length === MACRO * MACRO * 4);
check('surface buffer is the simulation resolution', p.surface.length === MACRO * MACRO * 4);

let nan = 0;
let hi = -Infinity;
let lo = Infinity;
for (let i = 0; i < p.height.length; i++) {
  const v = p.height[i];
  if (!Number.isFinite(v)) nan++;
  if (v > hi) hi = v;
  if (v < lo) lo = v;
}
check('no non-finite elevations', nan === 0, `${nan} bad`);
check('highest peak is plausible', hi > 4 && hi < 12, `${(hi * 1000).toFixed(0)} m`);
check('deepest point is plausible', lo < -2 && lo > -9, `${(lo * 1000).toFixed(0)} m`);

console.log('\nGeography:');
check(
  'land fraction is plausible',
  p.stats.landFraction > 0.18 && p.stats.landFraction < 0.45,
  `${(p.stats.landFraction * 100).toFixed(1)}%`,
);
check('coastline is long', p.stats.coastlineKm > 20000, `${Math.round(p.stats.coastlineKm)} km`);
check('rivers exist', p.stats.riverLengthKm > 20000, `${Math.round(p.stats.riverLengthKm)} km`);
check('roads exist', p.stats.roadLengthKm > 10000, `${Math.round(p.stats.roadLengthKm)} km`);
check('continents were found', p.continents.length >= 4, `${p.continents.length}`);
console.log('  landmasses classed as continent or subcontinent:');
for (const c of p.continents) {
  console.log(`    ${c.name.padEnd(12)} ${Math.round(c.area).toLocaleString('en-US').padStart(11)} km2   highest ${Math.round(c.highestPoint)} m`);
}
check('regions were grown', p.regions.length >= 30, `${p.regions.length}`);

// Land-cover census. A world whose land is ninety percent desert has a broken
// rainfall model, and no structural assertion would ever notice.
{
  const tally = new Map<number, number>();
  let landCells = 0;
  for (let i = 0; i < p.biomeIds.length; i++) {
    if (!Number.isNaN(p.waterLevel[i])) continue; // a water surface: not dry land
    landCells++;
    tally.set(p.biomeIds[i], (tally.get(p.biomeIds[i]) ?? 0) + 1);
  }
  const groups = new Map<string, number>();
  for (const [id, count] of tally) {
    const g = BIOME_BY_ID[id]?.group ?? 'other';
    groups.set(g, (groups.get(g) ?? 0) + count);
  }
  console.log('\nLand cover:');
  for (const [g, c] of [...groups].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(((c / landCells) * 100).toFixed(1) + '%').padStart(7)}  ${g}`);
  }
  const arid = (groups.get('arid') ?? 0) / landCells;
  const forest = (groups.get('forest') ?? 0) / landCells;
  const grass = (groups.get('grass') ?? 0) / landCells;
  check('not a desert planet', arid < 0.42, `${(arid * 100).toFixed(1)}% arid`);
  check('substantial forest', forest > 0.14, `${(forest * 100).toFixed(1)}%`);
  check('substantial grassland', grass > 0.1, `${(grass * 100).toFixed(1)}%`);

  let mSum = 0;
  let mCount = 0;
  for (let c = 0; c < p.biomeIds.length; c++) {
    if (!Number.isNaN(p.waterLevel[c])) continue;
    mSum += p.climate[c * 4 + 1] / 255;
    mCount++;
  }
  check('mean land moisture is mid-range', mSum / mCount > 0.24, `${(mSum / mCount).toFixed(3)}`);

  const biomeNames = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('Most common biomes:');
  for (const [id, c] of biomeNames) {
    console.log(`  ${(((c / landCells) * 100).toFixed(1) + '%').padStart(7)}  ${BIOME_BY_ID[id]?.name ?? id}`);
  }
}

console.log('\nCensus:');
const counts = p.stats.counts;
for (const k of Object.keys(counts).sort((a, b) => counts[b] - counts[a])) {
  console.log(`  ${String(counts[k]).padStart(5)}  ${k}`);
}
check('total features', p.features.length > 2500, `${p.features.length}`);
check('has capitals', (counts.capital ?? 0) >= 20, `${counts.capital ?? 0}`);
check('has cities', (counts.city ?? 0) >= 20, `${counts.city ?? 0}`);
check('has many villages', (counts.village ?? 0) >= 500, `${counts.village ?? 0}`);
check('has named rivers', (counts.river ?? 0) >= 40, `${counts.river ?? 0}`);
check('has named islands', (counts.island ?? 0) >= 50, `${counts.island ?? 0}`);
check('has named peaks', (counts.peak ?? 0) >= 80, `${counts.peak ?? 0}`);
check('has all 14 anomalies', (counts.anomaly ?? 0) === 14, `${counts.anomaly ?? 0}`);
check('has oceans and seas', (counts.ocean ?? 0) >= 4 && (counts.sea ?? 0) >= 3);

console.log('\nIntegrity:');
const names = new Set<string>();
let dupes = 0;
for (const f of p.features) {
  if (names.has(f.name)) dupes++;
  names.add(f.name);
}
check('all names unique', dupes === 0, `${dupes} duplicates`);

let placeholder = 0;
for (const f of p.features) if (/(^|\s)(\d+|Unnamed|Untitled)$/.test(f.name)) placeholder++;
check('no numeric placeholder names', placeholder === 0, `${placeholder}`);

let noDesc = 0;
let noFacts = 0;
for (const f of p.features) {
  if (!f.description || f.description.length < 12) noDesc++;
  if (!f.facts || f.facts.length === 0) noFacts++;
}
check('every feature is described', noDesc === 0, `${noDesc} missing`);
check('every feature has facts', noFacts === 0, `${noFacts} missing`);

const fineAt = (x: number, z: number): number => {
  const u = Math.round(((x + 2048) / 4096) * (FINE - 1));
  const v = Math.round(((z + 2048) / 4096) * (FINE - 1));
  return p.height[Math.min(FINE - 1, Math.max(0, v)) * FINE + Math.min(FINE - 1, Math.max(0, u))];
};
const settlementKinds = new Set(['capital', 'city', 'town', 'village', 'hamlet']);
let wet = 0;
for (const f of p.features) {
  if (!settlementKinds.has(f.kind)) continue;
  if (fineAt(f.x, f.z) <= SEA_LEVEL) wet++;
}
check('no settlement is underwater', wet === 0, `${wet} submerged`);

const tiers = [0, 0, 0, 0, 0];
for (const f of p.features) tiers[Math.min(4, f.labelTier)]++;
check('world-tier labels are few', tiers[0] > 4 && tiers[0] < 80, `${tiers[0]}`);
check('every tier has content', tiers.every((t) => t > 0), tiers.join(' / '));

console.log('\nGeometry:');
check('river ribbons built', p.riverVertices.length > 30000, `${p.riverVertices.length / 3} verts`);
check('road ribbons built', p.roadVertices.length > 30000, `${p.roadVertices.length / 3} verts`);
check('lake surfaces built', p.lakeQuads.length > 0, `${p.lakeQuads.length / 3} verts`);
check('borders built', p.borderVertices.length > 0, `${p.borderVertices.length / 6} segments`);
check('overview image built', result.overview.length === result.overviewSize ** 2 * 4);

console.log('\nSample gazetteer:');
for (const kind of ['continent', 'ocean', 'sea', 'capital', 'city', 'range', 'peak', 'river', 'lake', 'island', 'region', 'anomaly', 'village', 'ruin', 'castle', 'mine']) {
  const f = p.features.find((x) => x.kind === kind);
  if (f) console.log(`  ${kind.padEnd(10)} ${f.name}`);
}

console.log('\nA sample entry in full:');
const sample = p.features.find((f) => f.kind === 'city') ?? p.features[0];
console.log(`  ${sample.name} (${sample.kind})`);
console.log(`  ${sample.description}`);
for (const fact of sample.facts) console.log(`   - ${fact}`);

// Write inspection images. Looking at the world is the only way to catch the
// class of problem no assertion describes: ugly coasts, ranges in the wrong
// place, deserts on the windward side of a mountain.
mkdirSync('out', { recursive: true });
writeFileSync('out/overview.png', encodePNG(result.overview, result.overviewSize, result.overviewSize));
console.log(`\nWrote out/overview.png (${result.overviewSize}x${result.overviewSize})`);
for (const [name, img, size] of renderDiagnostics(p)) {
  writeFileSync(`out/${name}.png`, encodePNG(img, size, size));
  console.log(`Wrote out/${name}.png`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
