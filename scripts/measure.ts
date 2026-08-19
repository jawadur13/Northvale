/**
 * Measures what the city generator actually builds, in metres.
 *
 * Screenshots are the wrong tool for asking "is this wall the right height" or
 * "is that quay in the water". A wall four times too tall and a wall correctly
 * proportioned look much the same from a kilometre up next to buildings you have
 * no independent scale for, and a shore rendered at the lowest quality preset puts
 * dry land under water. This prints the numbers instead.
 *
 *   npx tsx scripts/measure.ts
 */
import { generateWorld } from '../src/world/generate';
import { buildCityPlan } from '../src/world/gen/city/plan';
import { buildBuildings } from '../src/world/gen/city/buildings';
import { emitBridge, emitFortification, emitHarbour, newGeomBuilder } from '../src/world/gen/city/geometry3d';
import { polyArea, polyCentroid } from '../src/world/gen/city/geometry2d';
import { buildWorks } from '../src/world/gen/rural/works';
import { DEFAULT_SEED, FINE, HALF_KM, MACRO, WORLD_KM } from '../src/core/config';

const w = generateWorld(DEFAULT_SEED, () => {}).payload;

function heightAt(x: number, z: number): number {
  const u = ((x + HALF_KM) / WORLD_KM) * (FINE - 1);
  const v = ((z + HALF_KM) / WORLD_KM) * (FINE - 1);
  const cu = Math.min(Math.max(u, 0), FINE - 1.001);
  const cv = Math.min(Math.max(v, 0), FINE - 1.001);
  const x0 = cu | 0;
  const y0 = cv | 0;
  const tx = cu - x0;
  const ty = cv - y0;
  const d = w.height;
  const r0 = y0 * FINE;
  const r1 = r0 + FINE;
  const a = d[r0 + x0];
  const b = d[r0 + x0 + 1];
  const c = d[r1 + x0];
  const e = d[r1 + x0 + 1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
}
const biomeAt = (x: number, z: number): number => {
  const gx = Math.min(MACRO - 1, Math.max(0, Math.round(((x + HALF_KM) / WORLD_KM) * (MACRO - 1))));
  const gz = Math.min(MACRO - 1, Math.max(0, Math.round(((z + HALF_KM) / WORLD_KM) * (MACRO - 1))));
  return w.biomeIds[gz * MACRO + gx];
};
const slopeAt = (x: number, z: number): number => {
  const d = 0.5;
  const gx = (heightAt(x + d, z) - heightAt(x - d, z)) / (2 * d);
  const gz = (heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d);
  return Math.min(1, Math.hypot(gx, gz));
};

const coastal = w.features.filter((x) => (x.tags ?? []).includes('coastal') && ['capital','city','town'].includes(x.kind));
console.log('coastal settlements:', coastal.length);
const named = w.features.filter((x) => x.name === 'Flintsham');
for (const f of [...named, ...coastal.slice(0, 3)]) {
  const region = w.regions[f.region];
  const plan = buildCityPlan({ feature: f, culture: region ? region.culture : 1, heightAt, slopeAt, biomeAt });
  const h = plan.harbour;
  let nearest = Infinity;
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    for (let d = 0.02; d < 6; d += 0.02) {
      if (heightAt(f.x + Math.cos(a) * d, f.z + Math.sin(a) * d) <= 0) { nearest = Math.min(nearest, d); break; }
    }
  }
  console.log(`  ${f.name} (${f.kind}) r=${plan.radiusKm.toFixed(2)} centre h=${(heightAt(f.x, f.z)*1000).toFixed(0)} m  water ${nearest === Infinity ? '>6' : nearest.toFixed(2)} km  reach ${(plan.radiusKm*1.15+0.25).toFixed(2)} km  harbour=${h ? `quay ${h.quays[0].line.length/2} pts, arms ${h.arms.length}, hulls ${h.hulls.length}` : 'NONE'}`);
}

for (const kind of ['capital', 'town', 'village'] as const) {
  const f = w.features.find((x) => x.kind === kind && (x.tags ?? []).includes('fortified'));
  if (!f) { console.log(kind, 'none walled'); continue; }
  const region = w.regions[f.region];
  const plan = buildCityPlan({ feature: f, culture: region ? region.culture : 1, heightAt, slopeAt, biomeAt });
  const fort = plan.fort;
  console.log(`\n${kind} ${f.name}  radius ${plan.radiusKm.toFixed(2)} km  blocks ${plan.blocks.length}`);
  if (fort) {
    const hs = fort.panels.map((p) => p.heightKm);
    console.log(`  wall: ${fort.panels.length} panels, height ${(Math.min(...hs) * 1000).toFixed(1)}-${(Math.max(...hs) * 1000).toFixed(1)} m, thickness ${(fort.thicknessKm * 1000).toFixed(1)} m, panel len ${(fort.panels[0].lengthKm * 1000).toFixed(1)} m`);
    console.log(`  towers ${fort.towers.length}, gates ${fort.gates.length}`);
  } else console.log('  no fortification');
  const info = w.cultures[region ? region.culture : 1];
  let n = 0, hMax = 0, hSum = 0, aSum = 0;
  for (const b of plan.blocks.slice(0, 400)) {
    for (const s of buildBuildings(b, region ? region.culture : 1, info, plan.featureId)) {
      n++; hSum += s.height; hMax = Math.max(hMax, s.height + s.roofHeight); aSum += s.height + s.roofHeight;
    }
  }
  if (n) console.log(`  buildings sampled ${n}: eaves mean ${(hSum / n * 1000).toFixed(1)} m, ridge mean ${(aSum / n * 1000).toFixed(1)} m, tallest ${(hMax * 1000).toFixed(1)} m`);
  {
    const b = newGeomBuilder();
    if (plan.fort) emitFortification(b, plan.fort, [0.5, 0.5, 0.5], [0.7, 0.7, 0.7]);
    if (plan.harbour) emitHarbour(b, plan.harbour, { quay: [0.5,0.5,0.5], timber: [0.4,0.3,0.2], rubble: [0.4,0.4,0.4], hull: [0.3,0.2,0.2] });
    console.log(`  works geometry: ${b.vertex} vertices, ${b.idx.length / 3} triangles`);
  }
  if (plan.harbour) {
    const h = plan.harbour;
    console.log(`  harbour: quay pts ${h.quays[0].line.length / 2}, arms ${h.arms.length}, hulls ${h.hulls.length}`);
  } else console.log('  no harbour');
}

// --- The port: is everything it builds actually on land? ---------------------
{
  let best: typeof coastal[number] | null = null;
  let bestD = Infinity;
  for (const f of coastal) {
    if (f.kind !== 'capital' && f.kind !== 'city') continue;
    let d = Infinity;
    for (let i = 0; i < 12 && d === Infinity; i++) {
      const a = (i / 12) * Math.PI * 2;
      for (let r = 0.1; r < 5; r += 0.05) {
        if (heightAt(f.x + Math.cos(a) * r, f.z + Math.sin(a) * r) <= 0) { d = r; break; }
      }
    }
    if (d < bestD) { bestD = d; best = f; }
  }
  if (best) {
    const region = w.regions[best.region];
    const plan = buildCityPlan({ feature: best, culture: region ? region.culture : 1, heightAt, slopeAt, biomeAt });
    console.log(`
port check: ${best.name} (${best.kind}) water ${bestD.toFixed(2)} km`);
    if (plan.fort) {
      const hs = plan.fort.panels.map((p) => heightAt(p.cx, p.cz));
      const wet = hs.filter((h) => h <= 0).length;
      console.log(`  wall: ${plan.fort.panels.length} panels, ground ${(Math.min(...hs)*1000).toFixed(0)}..${(Math.max(...hs)*1000).toFixed(0)} m, ${wet} in water`);
      const ths = plan.fort.towers.map((t) => heightAt(t.cx, t.cz));
      console.log(`  towers: ${plan.fort.towers.length}, ${ths.filter((h) => h <= 0).length} in water`);
    } else console.log('  unwalled');
    const h = plan.harbour;
    if (h) {
      const q = h.quays[0].line;
      let far = 0, wet = 0, span = 0;
      for (let i = 0; i < q.length / 2; i++) {
        const d = Math.hypot(q[i*2] - best.x, q[i*2+1] - best.z);
        far = Math.max(far, d);
        if (heightAt(q[i*2], q[i*2+1]) <= 0) wet++;
        if (i) span += Math.hypot(q[i*2]-q[(i-1)*2], q[i*2+1]-q[(i-1)*2+1]);
      }
      console.log(`  quay: ${q.length/2} pts, ${(span*1000).toFixed(0)} m long, furthest ${far.toFixed(2)} km from centre, ${wet} points in water`);
      const armWet = h.arms.filter((a) => heightAt(a.x, a.z) <= 0).length;
      const hullWet = h.hulls.filter((x) => heightAt(x.ax, x.az) <= 0).length;
      console.log(`  arms ${h.arms.length} (${armWet} rooted in water), hulls ${h.hulls.length} (${hullWet} anchored in water)`);
      const tips = h.arms.map((a) => heightAt(a.x + a.dx * a.lengthKm, a.z + a.dz * a.lengthKm) <= 0);
      console.log(`  arm tips over water: ${tips.filter(Boolean).length}/${tips.length}`);
    } else console.log('  no harbour');
  }
}

// --- Bridges: were they put on their rivers? --------------------------------
//
// The snap runs against *every* drawn channel, but only the 96 largest rivers are
// named features with a polyline this script can see. So the distance below is to
// the nearest named river, which for a crossing of a minor stream is legitimately
// large — what matters is the bearing, which only exists if the snap found water.
{
  const bridges = w.features.filter((f) => f.kind === 'bridge');
  const snapped = bridges.filter((b) => b.approaches && b.approaches.length > 0);
  const rivers = w.features.filter((f) => f.kind === 'river' && f.path);
  let onNamed = 0;
  for (const b of snapped) {
    let best = Infinity;
    for (const r of rivers) {
      const p = r.path!;
      for (let i = 0; i < p.length / 2; i++) {
        const d = Math.hypot(p[i * 2] - b.x, p[i * 2 + 1] - b.z);
        if (d < best) best = d;
      }
    }
    if (best < 0.4) onNamed++;
  }
  console.log(`
bridges: ${bridges.length}`);
  console.log(`  snapped onto a channel: ${snapped.length}`);
  console.log(`  not snapped (no drawn channel within 14 km): ${bridges.length - snapped.length}`);
  console.log(`  of the snapped, on one of the ${rivers.length} named rivers: ${onNamed}`);
}

// --- One bridge, as geometry ------------------------------------------------
{
  const f = w.features.find((x) => x.kind === 'bridge' && x.approaches && x.approaches.length > 0);
  if (f) {
    const bearing = f.approaches![0];
    const dx = Math.cos(bearing);
    const dz = Math.sin(bearing);
    const spanKm = Math.min(2.4, Math.max(0.05, f.spanKm ?? 0.12));
    const half = spanKm * 0.5;
    const ah = heightAt(f.x + dx * half, f.z + dz * half);
    const bh = heightAt(f.x - dx * half, f.z - dz * half);
    const high = ah >= bh ? 1 : -1;
    const b = newGeomBuilder();
    emitBridge(
      b,
      {
        x: f.x,
        z: f.z,
        dx,
        dz,
        spanKm,
        widthKm: Math.min(0.011, Math.max(0.005, 0.005 + spanKm * 0.004)),
        riseKm: Math.min(0.005, Math.max(0.0015, 0.0015 + spanKm * 0.002)),
        ax: f.x + dx * half * high,
        az: f.z + dz * half * high,
      },
      [1, 1, 1],
    );
    let lo = Infinity;
    let hi = -Infinity;
    let yLo = Infinity;
    let yHi = -Infinity;
    for (let i = 0; i < b.vertex; i++) {
      const u = (b.pos[i * 3] - f.x) * dx + (b.pos[i * 3 + 2] - f.z) * dz;
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
      yLo = Math.min(yLo, b.pos[i * 3 + 1]);
      yHi = Math.max(yHi, b.pos[i * 3 + 1]);
    }
    console.log(`\n${f.name}: span ${(spanKm * 1000).toFixed(0)} m, abutments ${(ah * 1000).toFixed(0)}/${(bh * 1000).toFixed(0)} m`);
    console.log(`  geometry ${b.vertex} vertices, along-axis ${(lo * 1000).toFixed(0)}..${(hi * 1000).toFixed(0)} m, local y ${(yLo * 1000).toFixed(1)}..${(yHi * 1000).toFixed(1)} m`);
  }
}

// --- Fields: is the belt the right size, and is it on workable ground? -------
{
  for (const kind of ['city', 'town', 'village'] as const) {
    const f = w.features.find((x) => x.kind === kind);
    if (!f) continue;
    const region = w.regions[f.region];
    const plan = buildCityPlan({ feature: f, culture: region ? region.culture : 1, heightAt, slopeAt, biomeAt });
    const fs = plan.fields;
    let area = 0;
    let wet = 0;
    let steep = 0;
    let far = 0;
    for (const p of fs.parcels) {
      area += polyArea(p.poly);
      const c: [number, number] = [0, 0];
      polyCentroid(p.poly, c);
      if (heightAt(c[0], c[1]) <= 0) wet++;
      if (slopeAt(c[0], c[1]) > 0.34) steep++;
      far = Math.max(far, Math.hypot(c[0] - f.x, c[1] - f.z) / plan.radiusKm);
    }
    const townArea = Math.PI * plan.radiusKm * plan.radiusKm;
    console.log(
      `\n${kind} ${f.name}: radius ${plan.radiusKm.toFixed(2)} km, pop ${f.population?.toLocaleString('en-US')}`,
    );
    console.log(
      `  fields ${fs.parcels.length} parcels over ${area.toFixed(2)} km2 ` +
        `(${(area / townArea).toFixed(1)}x the town), mean ${(area / Math.max(1, fs.parcels.length) * 100).toFixed(1)} ha`,
    );
    console.log(`  reach ${far.toFixed(2)} town radii, ${wet} in water, ${steep} on ground too steep to plough`);
    console.log(`  farmsteads ${fs.farms.length}`);
  }
}

// --- Works: how many landmarks now have workings, and how big -----------------
{
  const kinds = ['mine', 'quarry', 'watermill', 'sawmill', 'windmill'];
  const found = w.features.filter((f) => kinds.includes(f.kind));
  const byKind = new Map<string, number>();
  let patches = 0;
  let widest = 0;
  let widestKind = '';
  for (const f of found) {
    byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    const works = buildWorks(f.kind, f.x, f.z, f.importance ?? 0.4, slopeAt(f.x, f.z), f.id);
    if (!works) continue;
    patches += works.patches.length;
    for (const p of works.patches) {
      if (p.radiusKm * 2 > widest) {
        widest = p.radiusKm * 2;
        widestKind = f.kind;
      }
    }
  }
  console.log(`\nworks: ${found.length} landmarks, ${patches} patches of disturbed ground`);
  console.log(`  ${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`  widest patch ${(widest * 1000).toFixed(0)} m (${widestKind})`);
}

// --- The ground under one quarry, since a view of it showed none -------------
{
  const q = w.features.find((f) => f.kind === 'quarry');
  if (q) {
    let lo = Infinity;
    let hi = -Infinity;
    let land = 0;
    let n = 0;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const h = heightAt(q.x + dx * 1.5, q.z + dz * 1.5);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
        if (h > 0) land++;
        n++;
      }
    }
    console.log(`\n${q.name} at ${q.x.toFixed(1)}, ${q.z.toFixed(1)}`);
    console.log(`  ground within 4.5 km: ${(lo * 1000).toFixed(0)}..${(hi * 1000).toFixed(0)} m, ${land}/${n} above sea level`);
  }
}
