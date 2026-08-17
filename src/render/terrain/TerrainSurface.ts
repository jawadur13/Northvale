/**
 * Quadtree terrain.
 *
 * The world is 4,096 km across and must be legible both as a whole and from two
 * kilometres up. That is handled by a screen-space-error quadtree: the root
 * covers the entire world, and a node subdivides when its projected size on
 * screen exceeds a threshold. Every visible node draws the *same* geometry - a
 * unit grid with a skirt - displaced in the vertex shader from the height
 * texture, so a node is nothing but a pair of uniforms.
 *
 * Consequences worth stating, because they are the reason this approach was
 * chosen over per-chunk meshes:
 *
 *  - Subdividing costs no geometry work, so the LOD can react instantly to a fast
 *    zoom without a hitch or a pop-in queue.
 *  - Memory is constant regardless of how far in the camera goes.
 *  - Chunks cannot disagree about elevation, because they read one texture.
 *
 * LOD seams are covered by skirts: a ring of vertices around each node's border
 * that hangs below the surface, hiding the gap where a coarse neighbour's
 * straight edge departs from a fine node's curve.
 */

import * as THREE from 'three';
import { HALF_KM, WORLD_KM } from '../../core/config';
import type { WorldUniforms } from '../WorldResources';
import { TERRAIN_FRAGMENT, TERRAIN_VERTEX } from './terrainShaders';

interface Node {
  /** World-space origin (minimum corner) in km. */
  x: number;
  z: number;
  /** Edge length in km. */
  size: number;
  depth: number;
  /** Cached vertical bounds in km, for frustum culling and error estimation. */
  minH: number;
  maxH: number;
  children: Node[] | null;
}

export interface TerrainStats {
  drawn: number;
  tested: number;
  maxDepth: number;
  triangles: number;
}

export class TerrainSurface {
  readonly group = new THREE.Group();
  readonly material: THREE.RawShaderMaterial;

  private geometry: THREE.BufferGeometry;
  /** One reusable mesh per visible node, grown on demand and never shrunk. */
  private pool: THREE.Mesh[] = [];
  private root: Node;
  private segments: number;
  private maxDepth: number;
  /** Target screen-space size of a node's edge, in pixels, before it subdivides. */
  private pixelError = 260;
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private box = new THREE.Box3();
  private stats: TerrainStats = { drawn: 0, tested: 0, maxDepth: 0, triangles: 0 };
  private heightSampler: (x: number, z: number) => number;
  private viewportHeight = 1080;

  constructor(
    uniforms: WorldUniforms,
    heightSampler: (x: number, z: number) => number,
    segments = 64,
    maxDepth = 7,
  ) {
    this.segments = segments;
    this.maxDepth = maxDepth;
    this.heightSampler = heightSampler;
    this.geometry = buildGridWithSkirt(segments);

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...(uniforms as unknown as Record<string, THREE.IUniform>),
        uSkirtDepth: { value: 0.9 },
        uSegments: { value: segments },
      },
      vertexShader: TERRAIN_VERTEX,
      fragmentShader: TERRAIN_FRAGMENT,
      side: THREE.FrontSide,
    });

    this.root = {
      x: -HALF_KM,
      z: -HALF_KM,
      size: WORLD_KM,
      depth: 0,
      minH: -7,
      maxH: 9,
      children: null,
    };
    this.group.frustumCulled = false;
  }

  setQuality(segments: number, maxDepth: number): void {
    if (segments !== this.segments) {
      this.segments = segments;
      this.geometry.dispose();
      this.geometry = buildGridWithSkirt(segments);
      this.material.uniforms.uSegments.value = segments;
      for (const mesh of this.pool) mesh.geometry = this.geometry;
    }
    this.maxDepth = maxDepth;
  }

  setViewportHeight(px: number): void {
    this.viewportHeight = Math.max(200, px);
  }

  get lastStats(): TerrainStats {
    return this.stats;
  }

  /**
   * Rebuilds the visible node set for this frame.
   *
   * Called every frame; the traversal is a few hundred nodes at worst, which is
   * far cheaper than the alternative of caching and invalidating.
   */
  update(camera: THREE.PerspectiveCamera): void {
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    const exaggeration = (this.material.uniforms.uExaggeration.value as number) ?? 1;
    // Vertical FOV in radians, used to convert world size to screen pixels.
    const fovScale = this.viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));

    this.stats.drawn = 0;
    this.stats.tested = 0;
    this.stats.maxDepth = 0;

    const visible: Node[] = [];
    this.collect(this.root, camera, exaggeration, fovScale, visible);

    // Assign nodes to pooled meshes. The pool only ever grows, so a fast zoom
    // never allocates in a later frame.
    while (this.pool.length < visible.length) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      // Culling is done by the quadtree traversal, which knows the real vertical
      // extent; Three's own test would use the meaningless unit-grid bounds.
      mesh.frustumCulled = false;
      this.pool.push(mesh);
      this.group.add(mesh);
    }

    for (let i = 0; i < this.pool.length; i++) {
      const mesh = this.pool[i];
      if (i >= visible.length) {
        mesh.visible = false;
        continue;
      }
      const node = visible[i];
      mesh.visible = true;
      mesh.position.set(node.x, 0, node.z);
      mesh.scale.set(node.size, 1, node.size);
      mesh.userData.node = node;
    }

    this.stats.drawn = visible.length;
    this.stats.triangles = visible.length * this.segments * this.segments * 2;
  }

  /** Recursive traversal: cull, then either subdivide or emit. */
  private collect(
    node: Node,
    camera: THREE.PerspectiveCamera,
    exaggeration: number,
    fovScale: number,
    out: Node[],
  ): void {
    this.stats.tested++;

    // Sample the node's vertical extent once, lazily. Nine samples is enough to
    // bound a node for culling purposes given the skirt covers the slack.
    if (node.depth > 0 && node.minH === -7 && node.maxH === 9) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i <= 2; i++) {
        for (let j = 0; j <= 2; j++) {
          const h = this.heightSampler(node.x + (node.size * i) / 2, node.z + (node.size * j) / 2);
          if (h < lo) lo = h;
          if (h > hi) hi = h;
        }
      }
      // Pad generously: three samples per axis can miss a peak between them.
      node.minH = lo - 1.2;
      node.maxH = hi + 1.6;
    }

    this.box.min.set(node.x, node.minH * exaggeration - 1, node.z);
    this.box.max.set(node.x + node.size, node.maxH * exaggeration + 1, node.z + node.size);
    if (!this.frustum.intersectsBox(this.box)) return;

    if (node.depth >= this.maxDepth) {
      out.push(node);
      this.stats.maxDepth = Math.max(this.stats.maxDepth, node.depth);
      return;
    }

    // Screen-space error: how many pixels the node's edge spans.
    const cx = node.x + node.size * 0.5;
    const cz = node.z + node.size * 0.5;
    const cy = ((node.minH + node.maxH) * 0.5) * exaggeration;
    const dx = camera.position.x - cx;
    const dy = camera.position.y - cy;
    const dz = camera.position.z - cz;
    // Distance to the node's nearest face, not its centre, or a node the camera
    // is sitting inside never subdivides.
    const dist = Math.max(
      1,
      Math.sqrt(dx * dx + dy * dy + dz * dz) - node.size * 0.7,
    );
    const projected = (node.size / dist) * fovScale;

    if (projected > this.pixelError) {
      if (!node.children) {
        const half = node.size / 2;
        node.children = [
          { x: node.x, z: node.z, size: half, depth: node.depth + 1, minH: -7, maxH: 9, children: null },
          { x: node.x + half, z: node.z, size: half, depth: node.depth + 1, minH: -7, maxH: 9, children: null },
          { x: node.x, z: node.z + half, size: half, depth: node.depth + 1, minH: -7, maxH: 9, children: null },
          { x: node.x + half, z: node.z + half, size: half, depth: node.depth + 1, minH: -7, maxH: 9, children: null },
        ];
      }
      for (const child of node.children) {
        this.collect(child, camera, exaggeration, fovScale, out);
      }
      return;
    }

    out.push(node);
    this.stats.maxDepth = Math.max(this.stats.maxDepth, node.depth);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    for (const m of this.pool) this.group.remove(m);
    this.pool.length = 0;
  }
}

/**
 * Builds the shared chunk geometry: an `n` by `n` quad grid over the unit square
 * in XZ, plus a skirt ring around the border.
 *
 * The skirt vertices sit at the same XZ as the border vertices but are flagged so
 * the vertex shader drops them below the surface. That covers the wedge-shaped gap
 * that appears wherever a node meets a neighbour at a coarser LOD.
 */
function buildGridWithSkirt(n: number): THREE.BufferGeometry {
  const side = n + 1;
  const interior = side * side;
  const skirtCount = side * 4;
  const total = interior + skirtCount;

  const positions = new Float32Array(total * 3);
  const skirt = new Float32Array(total);

  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      const i = y * side + x;
      positions[i * 3] = x / n;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = y / n;
    }
  }

  // Skirt ring: one duplicate per border vertex, in four runs.
  let s = interior;
  const skirtIndexOf: number[] = [];
  const pushSkirt = (gx: number, gy: number) => {
    positions[s * 3] = gx / n;
    positions[s * 3 + 1] = 0;
    positions[s * 3 + 2] = gy / n;
    skirt[s] = 1;
    skirtIndexOf.push(s);
    s++;
  };
  for (let x = 0; x <= n; x++) pushSkirt(x, 0); // north edge
  for (let x = 0; x <= n; x++) pushSkirt(x, n); // south edge
  for (let y = 0; y <= n; y++) pushSkirt(0, y); // west edge
  for (let y = 0; y <= n; y++) pushSkirt(n, y); // east edge

  const indices: number[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = y * side + x;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // Stitch each skirt run to its border row.
  const stitch = (skirtBase: number, borderOf: (i: number) => number, flip: boolean) => {
    for (let i = 0; i < n; i++) {
      const s0 = interior + skirtBase + i;
      const s1 = s0 + 1;
      const b0 = borderOf(i);
      const b1 = borderOf(i + 1);
      if (flip) indices.push(b0, s0, b1, b1, s0, s1);
      else indices.push(b0, b1, s0, b1, s1, s0);
    }
  };
  stitch(0, (i) => i, false); // north
  stitch(side, (i) => n * side + i, true); // south
  stitch(side * 2, (i) => i * side, true); // west
  stitch(side * 3, (i) => i * side + n, false); // east

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSkirt', new THREE.BufferAttribute(skirt, 1));
  geo.setIndex(indices);
  // Bounds are meaningless here: the real extent comes from the vertex shader.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0, 0.5), 100);
  return geo;
}
