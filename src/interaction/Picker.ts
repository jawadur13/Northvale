/**
 * Picking.
 *
 * Two separate problems, solved separately because they want different answers.
 *
 * **Where is the cursor on the ground?** The terrain is displaced in a vertex
 * shader, so there is no CPU-side mesh to raycast against. Instead the ray is
 * marched against the CPU copy of the heightfield: coarse steps until the ray
 * passes below the surface, then a binary refinement on the bracketing interval.
 * That converges in about thirty samples for any ray in the world and needs no
 * acceleration structure at all.
 *
 * **Which feature did the user mean?** Not the nearest one in 3D - the nearest
 * one *on screen*, weighted by importance, because a capital city and the hamlet
 * beside it are one pixel apart at regional zoom and the user meant the capital.
 * Features are indexed in a coarse world-space grid so only the handful near the
 * cursor are projected.
 */

import * as THREE from 'three';
import { HALF_KM } from '../core/config';
import type { Feature } from '../world/types';

export interface GroundHit {
  x: number;
  z: number;
  /** Height in km at the hit. */
  h: number;
  /** Distance from the camera in km. */
  distance: number;
}

export class Picker {
  private heightAt: (x: number, z: number) => number;
  private exaggeration: () => number;

  /** Feature buckets, keyed by a coarse world grid. */
  private cellKm = 96;
  private buckets = new Map<number, Feature[]>();
  private projected = new THREE.Vector3();

  constructor(
    features: Feature[],
    heightAt: (x: number, z: number) => number,
    exaggeration: () => number,
  ) {
    this.heightAt = heightAt;
    this.exaggeration = exaggeration;
    for (const f of features) {
      // Extended features - oceans, continents, ranges, rivers - are found by
      // search and by their labels, not by clicking their notional centre.
      const key = this.key(f.x, f.z);
      const arr = this.buckets.get(key);
      if (arr) arr.push(f);
      else this.buckets.set(key, [f]);
    }
  }

  private key(x: number, z: number): number {
    return Math.floor(x / this.cellKm) * 100000 + Math.floor(z / this.cellKm);
  }

  /**
   * Marches a ray against the heightfield.
   *
   * Step size grows with distance travelled, because a ray that has already gone
   * a thousand kilometres is looking at terrain whose detail cannot matter yet.
   */
  raycastGround(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance = 20000): GroundHit | null {
    const exag = this.exaggeration();
    const dir = direction.clone().normalize();

    // A ray going up over the sea will never hit anything; reject it cheaply.
    if (dir.y >= 0 && origin.y > 9 * exag) return null;

    let t = 0.05;
    let prevT = 0;
    let prevAbove = origin.y - this.heightAt(origin.x, origin.z) * exag;
    if (prevAbove < 0) prevAbove = 0.001;

    // Start fine and coarsen, so near-camera picking is precise and far picking
    // is still bounded.
    let step = Math.max(0.08, origin.y * 0.01);

    for (let i = 0; i < 512 && t < maxDistance; i++) {
      const px = origin.x + dir.x * t;
      const pz = origin.z + dir.z * t;
      const py = origin.y + dir.y * t;

      // Outside the map, keep marching against sea level so the ocean is pickable.
      const inside = px >= -HALF_KM * 1.3 && px <= HALF_KM * 1.3 && pz >= -HALF_KM * 1.3 && pz <= HALF_KM * 1.3;
      const surface = inside ? this.heightAt(px, pz) * exag : 0;
      const above = py - surface;

      if (above <= 0) {
        // Bracketed: refine by bisection on [prevT, t].
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 26; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = origin.x + dir.x * mid;
          const mz = origin.z + dir.z * mid;
          const my = origin.y + dir.y * mid;
          const ms = this.heightAt(mx, mz) * exag;
          if (my - ms > 0) lo = mid;
          else hi = mid;
        }
        const ft = (lo + hi) * 0.5;
        const fx = origin.x + dir.x * ft;
        const fz = origin.z + dir.z * ft;
        return { x: fx, z: fz, h: this.heightAt(fx, fz), distance: ft };
      }

      prevT = t;
      prevAbove = above;
      // Step proportional to the clearance above the terrain: large when high
      // over the sea, small when skimming a ridge.
      step = Math.max(0.06, Math.min(above * 0.85, 60 + t * 0.05));
      t += step;
    }

    void prevAbove;
    return null;
  }

  /** Convenience: casts through a screen position. */
  pickGroundFromScreen(
    camera: THREE.PerspectiveCamera,
    ndcX: number,
    ndcY: number,
  ): GroundHit | null {
    const origin = camera.position.clone();
    const dir = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(origin).normalize();
    return this.raycastGround(origin, dir);
  }

  /**
   * Finds the feature the user most likely meant.
   *
   * @param radiusPx how close in screen pixels a feature has to be
   * @param visible filter matching the currently visible layers, so clicking does
   *   not select something the user cannot see
   */
  pickFeature(
    camera: THREE.PerspectiveCamera,
    screenX: number,
    screenY: number,
    width: number,
    height: number,
    radiusPx: number,
    visible: (f: Feature) => boolean,
  ): Feature | null {
    const exag = this.exaggeration();
    // Search a world-space neighbourhood scaled to how much ground a pixel covers.
    const groundPerPixel = this.estimateGroundPerPixel(camera, height);
    const searchKm = Math.max(this.cellKm, radiusPx * groundPerPixel * 2.2);
    const reach = Math.ceil(searchKm / this.cellKm);

    const centreHit = this.pickGroundFromScreen(
      camera,
      (screenX / width) * 2 - 1,
      -((screenY / height) * 2 - 1),
    );
    const cx = centreHit ? centreHit.x : camera.position.x;
    const cz = centreHit ? centreHit.z : camera.position.z;

    const bx = Math.floor(cx / this.cellKm);
    const bz = Math.floor(cz / this.cellKm);

    let best: Feature | null = null;
    let bestScore = -Infinity;
    const r2 = radiusPx * radiusPx;

    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const arr = this.buckets.get((bx + dx) * 100000 + (bz + dz));
        if (!arr) continue;
        for (const f of arr) {
          if (!visible(f)) continue;
          this.projected.set(f.x, this.heightAt(f.x, f.z) * exag, f.z);
          this.projected.project(camera);
          if (this.projected.z < -1 || this.projected.z > 1) continue;
          const sx = ((this.projected.x + 1) / 2) * width;
          const sy = ((1 - this.projected.y) / 2) * height;
          const ddx = sx - screenX;
          const ddy = sy - screenY;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 > r2) continue;
          // Prefer important features, then near ones. The importance weight is
          // large enough that a capital beats a hamlet twenty pixels closer.
          const score = f.importance * 3.2 - Math.sqrt(d2) / radiusPx;
          if (score > bestScore) {
            bestScore = score;
            best = f;
          }
        }
      }
    }

    return best;
  }

  /** Roughly how many kilometres of ground one screen pixel covers at the focus. */
  private estimateGroundPerPixel(camera: THREE.PerspectiveCamera, heightPx: number): number {
    const dist = camera.position.length() > 0 ? camera.position.y : 100;
    const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * Math.max(1, dist);
    return (halfHeight * 2) / Math.max(1, heightPx);
  }
}
