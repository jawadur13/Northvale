/**
 * Plant prototypes, at two levels of detail.
 *
 * Every prototype is authored at **unit height**: it occupies y ∈ [0, 1] and is
 * scaled at instance time by the species' real height in metres. That is the
 * whole reason this file exists separately from the scatter — it makes "how tall
 * is a boreal spruce" a number in a biome table rather than a proportion baked
 * into a cone, and a tree that is the wrong height beside a nine-metre house is
 * the most obvious error this map can make.
 *
 * **Full** is trunk and crown, forty-odd triangles, for the nearest ring.
 *
 * **Canopy** is the crown alone — one open cone or dome, five to seven triangles
 * — for everything beyond it. Not a cross-billboard, which is the usual answer:
 * two crossed cards read as a literal X from overhead, and overhead is the only
 * angle this map is ever seen from. What a tree looks like from a kilometre up is
 * its canopy, so that is what the far tier draws. No trunk, no underside, no
 * alpha texture, no sorting.
 */

import * as THREE from 'three';
import type { PlantKind } from '../../world/gen/biomes';

/** Which prototype to build: full geometry, or the canopy alone. */
export type PlantDetail = 'full' | 'canopy';

export const PLANT_KINDS: PlantKind[] = [
  'pine',
  'snowpine',
  'broadleaf',
  'birch',
  'palm',
  'cactus',
  'shrub',
  'baobab',
  'reed',
  'deadwood',
  'boulder',
];

/**
 * Paints a flat colour onto every vertex, and marks whether it takes the
 * species tint.
 *
 * Foliage does; bark does not. Without the distinction the per-instance tint that
 * makes one spruce differ from the next also drags its trunk green, and a birch —
 * whose whole identity is pale bark — comes out the colour of its own leaves.
 */
function paint(
  geo: THREE.BufferGeometry,
  r: number,
  g: number,
  b: number,
  tintable = 1,
): THREE.BufferGeometry {
  const count = geo.attributes.position.count;
  const col = new Float32Array(count * 3);
  const tint = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    col[i * 3] = r;
    col[i * 3 + 1] = g;
    col[i * 3 + 2] = b;
    tint[i] = tintable;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aTintable', new THREE.BufferAttribute(tint, 1));
  return geo;
}

/**
 * An open dome: an apex, a ring below it, and no underside.
 *
 * `sides` triangles exactly, which is the point — the canopy tier is drawn a few
 * hundred thousand times and every triangle in it is paid for that many times.
 * The missing underside is free: nothing in this map is ever below a tree.
 */
function dome(
  sides: number,
  radius: number,
  baseY: number,
  topY: number,
  /** 0 gives a cone, 1 gives a rounded crown. */
  round: number,
): THREE.BufferGeometry {
  const pos: number[] = [0, topY, 0];
  const idx: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    // Rounding pushes the ring up toward the apex and out, which turns the
    // straight-sided cone of a conifer into the shouldered crown of a broadleaf.
    const y = baseY + (topY - baseY) * round * 0.34;
    pos.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
    idx.push(0, 1 + ((i + 1) % sides), 1 + i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Merges a list into one geometry carrying position, normal and colour. */
function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of list) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vertexCount * 3);
  const nor = new Float32Array(vertexCount * 3);
  const col = new Float32Array(vertexCount * 3);
  const tint = new Float32Array(vertexCount);
  const idx = new Uint16Array(indexCount);

  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.attributes.position.array as ArrayLike<number>;
    const n = (g.attributes.normal?.array ?? new Float32Array(p.length)) as ArrayLike<number>;
    const c = g.attributes.color.array as ArrayLike<number>;
    const t = g.attributes.aTintable.array as ArrayLike<number>;
    const count = g.attributes.position.count;
    for (let i = 0; i < count * 3; i++) {
      pos[vo * 3 + i] = p[i];
      nor[vo * 3 + i] = n[i];
      col[vo * 3 + i] = c[i];
    }
    for (let i = 0; i < count; i++) tint[vo + i] = t[i];
    if (g.index) {
      const gi = g.index.array as ArrayLike<number>;
      for (let i = 0; i < g.index.count; i++) idx[io + i] = vo + gi[i];
      io += g.index.count;
    } else {
      for (let i = 0; i < count; i++) idx[io + i] = vo + i;
      io += count;
    }
    vo += count;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('aTintable', new THREE.BufferAttribute(tint, 1));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/** Bark, dark enough to read against foliage without becoming a black line. */
const BARK = [0.3, 0.23, 0.17] as const;
const PALE_BARK = [0.72, 0.71, 0.66] as const;
/**
 * Foliage is left white here and tinted per instance from the species mix.
 *
 * One prototype geometry serves every species that shares its silhouette, which
 * is what keeps eleven prototypes covering thirty-four biomes' worth of planting.
 */
const FOLIAGE = [1, 1, 1] as const;

/**
 * Builds one prototype.
 *
 * Coordinates are in unit heights: the plant stands on y = 0 and its top is at
 * y = 1, whatever it is. Radii are in the same units, so a broadleaf crown at
 * 0.36 is a tree about seven tenths as wide as it is tall — which is what an oak
 * in the open is, and is why a closed canopy needs roughly two per crown width.
 */
export function buildPlant(kind: PlantKind, detail: PlantDetail): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const canopyOnly = detail === 'canopy';

  const trunk = (rTop: number, rBase: number, height: number, colour: readonly number[]): void => {
    if (canopyOnly) return;
    const g = new THREE.CylinderGeometry(rTop, rBase, height, 5);
    g.translate(0, height * 0.5, 0);
    paint(g, colour[0], colour[1], colour[2], 0);
    parts.push(g);
  };

  switch (kind) {
    case 'pine':
    case 'snowpine': {
      trunk(0.03, 0.045, 0.34, BARK);
      // Two stacked cones read as a conifer far more cheaply than a real one.
      if (canopyOnly) {
        // One cone spanning the union of the two, so the outline does not change
        // when a tree crosses the detail boundary. Only the trunk goes.
        parts.push(paint(dome(5, 0.23, 0.26, 1, 0), ...FOLIAGE));
      } else {
        parts.push(paint(dome(6, 0.23, 0.26, 0.74, 0), ...FOLIAGE));
        parts.push(paint(dome(6, 0.17, 0.52, 1, 0), ...FOLIAGE));
      }
      break;
    }
    case 'broadleaf': {
      trunk(0.035, 0.05, 0.42, BARK);
      parts.push(paint(dome(canopyOnly ? 6 : 7, 0.36, 0.36, 1, 1), ...FOLIAGE));
      break;
    }
    case 'birch': {
      // Slim, pale-barked and markedly upright: the silhouette that makes a
      // northern wood read as mixed rather than as a field of spruce.
      trunk(0.018, 0.026, 0.58, PALE_BARK);
      parts.push(paint(dome(canopyOnly ? 5 : 6, 0.2, 0.5, 1, 0.7), ...FOLIAGE));
      break;
    }
    case 'palm': {
      trunk(0.022, 0.034, 0.78, [0.4, 0.34, 0.24]);
      if (canopyOnly) {
        parts.push(paint(dome(5, 0.26, 0.74, 1, 0.9), ...FOLIAGE));
        break;
      }
      for (let i = 0; i < 5; i++) {
        const frond = new THREE.ConeGeometry(0.08, 0.42, 3);
        frond.scale(1, 1, 0.35);
        frond.rotateZ(Math.PI * 0.42);
        frond.rotateY((i / 5) * Math.PI * 2);
        frond.translate(0, 0.82, 0);
        paint(frond, ...FOLIAGE);
        parts.push(frond);
      }
      break;
    }
    case 'cactus': {
      const body = new THREE.CylinderGeometry(0.13, 0.16, 1, 6);
      body.translate(0, 0.5, 0);
      paint(body, ...FOLIAGE);
      parts.push(body);
      if (!canopyOnly) {
        const arm = new THREE.CylinderGeometry(0.075, 0.08, 0.4, 5);
        arm.translate(0.2, 0.66, 0);
        paint(arm, ...FOLIAGE);
        parts.push(arm);
      }
      break;
    }
    case 'shrub': {
      parts.push(paint(dome(canopyOnly ? 5 : 7, 0.62, 0, 1, 1), ...FOLIAGE));
      break;
    }
    case 'baobab': {
      // A bottle trunk under a flat crown: unmistakable from directly above,
      // which is the only place it is seen from.
      trunk(0.11, 0.24, 0.5, [0.44, 0.36, 0.26]);
      parts.push(paint(dome(canopyOnly ? 6 : 8, 0.58, 0.5, 1, 1), ...FOLIAGE));
      break;
    }
    case 'reed': {
      const blades = canopyOnly ? 2 : 3;
      for (let i = 0; i < blades; i++) {
        const blade = new THREE.ConeGeometry(0.07, 1, 3);
        blade.translate(0, 0.5, 0);
        blade.rotateZ((i - 1) * 0.22);
        blade.translate((i - 1) * 0.12, 0, 0);
        paint(blade, ...FOLIAGE);
        parts.push(blade);
      }
      break;
    }
    case 'deadwood': {
      // A standing dead trunk, no crown. Half of what makes an old forest read as
      // old is the timber still standing in it.
      trunk(0.02, 0.055, 1, [0.62, 0.58, 0.52]);
      if (canopyOnly) {
        const stump = new THREE.CylinderGeometry(0.02, 0.055, 1, 4);
        stump.translate(0, 0.5, 0);
        paint(stump, 0.62, 0.58, 0.52, 0);
        parts.push(stump);
      } else {
        const limb = new THREE.CylinderGeometry(0.012, 0.02, 0.34, 3);
        limb.rotateZ(0.9);
        limb.translate(0.1, 0.78, 0);
        paint(limb, 0.62, 0.58, 0.52, 0);
        parts.push(limb);
      }
      break;
    }
    case 'boulder': {
      const g = new THREE.IcosahedronGeometry(0.5, 0);
      g.scale(1.1, 0.78, 0.94);
      g.translate(0, 0.36, 0);
      paint(g, ...FOLIAGE);
      parts.push(g);
      break;
    }
    default: {
      const g = new THREE.IcosahedronGeometry(0.5, 0);
      g.translate(0, 0.5, 0);
      paint(g, ...FOLIAGE);
      parts.push(g);
    }
  }

  return merge(parts);
}
