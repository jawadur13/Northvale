/**
 * Camera control.
 *
 * The camera orbits a focus point that slides across the terrain. Every input
 * feeds a *target* value and the actual value chases it with frame-rate
 * independent exponential damping, which is what gives the motion its weight -
 * nothing in the view ever moves in the same frame the input arrived.
 *
 * Two decisions do most of the work in making a 4,000 km world navigable:
 *
 *  - **Pan speed is proportional to camera distance.** Dragging moves the ground
 *    under the cursor by the same number of pixels whether you are looking at a
 *    continent or at a village street, so the gesture means "drag the map" at
 *    every scale rather than meaning a fixed number of kilometres.
 *  - **Pitch is coupled to zoom.** At world distance the view is nearly top-down,
 *    which is how you read a map; as you descend it tilts toward the oblique,
 *    which is how you read terrain. The user can override the tilt at any time and
 *    the coupling then yields to them.
 */

import * as THREE from 'three';
import {
  CAM_MAX_DISTANCE,
  CAM_MIN_DISTANCE,
  HALF_KM,
  TAU_SAFE,
} from './constants';
import { clamp, damp, dampAngle, lerp, smoothstep } from '../util/math';

export interface MapControlsOptions {
  /** Returns terrain height in km (unexaggerated) at a world position. */
  heightAt: (x: number, z: number) => number;
  /** Current vertical exaggeration. */
  exaggeration: () => number;
}

interface PointerState {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  button: number;
  moved: boolean;
  downTime: number;
}

export type DragMode = 'none' | 'pan' | 'orbit';

export class MapControls {
  readonly camera: THREE.PerspectiveCamera;

  /** Focus point on the ground, in world km. */
  readonly focus = new THREE.Vector3();
  private focusTarget = new THREE.Vector3();

  private distance = 5200;
  private distanceTarget = 5200;
  private azimuth = 0;
  private azimuthTarget = 0;
  private polar = 0.16;
  private polarTarget = 0.16;

  /** When true, the user has taken manual control of the tilt. */
  private manualPitch = false;
  private manualPitchUntil = 0;

  private pointers = new Map<number, PointerState>();
  private dragMode: DragMode = 'none';
  private element: HTMLElement;
  private opts: MapControlsOptions;

  private keys = new Set<string>();
  private enabledInput = true;
  private pinchStartDistance = 0;
  private pinchStartCamDistance = 0;
  private pinchStartAngle = 0;
  private pinchStartAzimuth = 0;
  private twoFingerCentroidY = 0;

  /** Set while a scripted flight is in progress, to suppress the pitch coupling. */
  scripted = false;

  onInteract: (() => void) | null = null;
  onClick: ((x: number, y: number) => void) | null = null;

  private tmpVec = new THREE.Vector3();
  private tmpVec2 = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, element: HTMLElement, opts: MapControlsOptions) {
    this.camera = camera;
    this.element = element;
    this.opts = opts;
    this.attach();
    this.applyImmediate();
  }

  // --- Public state -------------------------------------------------------

  get cameraDistance(): number {
    return this.distance;
  }

  get azimuthAngle(): number {
    return this.azimuth;
  }

  get polarAngle(): number {
    return this.polar;
  }

  setEnabled(v: boolean): void {
    this.enabledInput = v;
    if (!v) {
      this.pointers.clear();
      this.dragMode = 'none';
    }
  }

  /** Immediately places the camera without damping. Used on load and on reset. */
  applyImmediate(): void {
    this.focus.copy(this.focusTarget);
    this.distance = this.distanceTarget;
    this.azimuth = this.azimuthTarget;
    this.polar = this.polarTarget;
    this.updateCamera();
  }

  setTarget(x: number, z: number, distance: number, azimuth?: number, polar?: number): void {
    this.focusTarget.set(clamp(x, -HALF_KM, HALF_KM), 0, clamp(z, -HALF_KM, HALF_KM));
    this.distanceTarget = clamp(distance, CAM_MIN_DISTANCE, CAM_MAX_DISTANCE);
    if (azimuth !== undefined) this.azimuthTarget = azimuth;
    if (polar !== undefined) {
      this.polarTarget = polar;
      this.manualPitch = true;
      this.manualPitchUntil = performance.now() + 6000;
    }
  }

  /** Reads back the current target, for the flight director to interpolate from. */
  getState(): { x: number; z: number; distance: number; azimuth: number; polar: number } {
    return {
      x: this.focus.x,
      z: this.focus.z,
      distance: this.distance,
      azimuth: this.azimuth,
      polar: this.polar,
    };
  }

  // --- Input --------------------------------------------------------------

  private attach(): void {
    const el = this.element;
    el.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    el.addEventListener('pointermove', this.onPointerMove, { passive: false });
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  detach(): void {
    const el = this.element;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerUp);
    el.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabledInput) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      button: e.button,
      moved: false,
      downTime: performance.now(),
    });

    if (this.pointers.size === 1) {
      // Right button, middle button or a modifier orbits; plain left drag pans.
      const orbit = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey;
      this.dragMode = orbit ? 'orbit' : 'pan';
    } else if (this.pointers.size === 2) {
      this.beginPinch();
    }
    this.onInteract?.();
  };

  private beginPinch(): void {
    const [a, b] = [...this.pointers.values()];
    this.pinchStartDistance = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchStartCamDistance = this.distanceTarget;
    this.pinchStartAngle = Math.atan2(b.y - a.y, b.x - a.x);
    this.pinchStartAzimuth = this.azimuthTarget;
    this.twoFingerCentroidY = (a.y + b.y) / 2;
    this.dragMode = 'none';
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.enabledInput) return;
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 4) p.moved = true;

    if (this.pointers.size === 1) {
      if (this.dragMode === 'pan') this.pan(dx, dy);
      else if (this.dragMode === 'orbit') this.orbit(dx, dy);
      e.preventDefault();
      this.onInteract?.();
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const centroidY = (a.y + b.y) / 2;

      // Pinch: zoom. Twist: rotate. Two-finger vertical drag: tilt.
      if (this.pinchStartDistance > 4) {
        const ratio = this.pinchStartDistance / Math.max(4, dist);
        this.distanceTarget = clamp(
          this.pinchStartCamDistance * ratio,
          CAM_MIN_DISTANCE,
          CAM_MAX_DISTANCE,
        );
      }
      let twist = angle - this.pinchStartAngle;
      while (twist > Math.PI) twist -= TAU_SAFE;
      while (twist < -Math.PI) twist += TAU_SAFE;
      this.azimuthTarget = this.pinchStartAzimuth - twist;

      const tilt = (centroidY - this.twoFingerCentroidY) * 0.004;
      if (Math.abs(tilt) > 0.0001) {
        this.polarTarget = clamp(this.polarTarget + tilt, 0.02, 1.3);
        this.manualPitch = true;
        this.manualPitchUntil = performance.now() + 6000;
        this.twoFingerCentroidY = centroidY;
      }
      e.preventDefault();
      this.onInteract?.();
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) {
      this.pinchStartDistance = 0;
      if (this.pointers.size === 1) {
        const remaining = [...this.pointers.values()][0];
        remaining.startX = remaining.x;
        remaining.startY = remaining.y;
        this.dragMode = 'pan';
      } else {
        this.dragMode = 'none';
      }
    }
    // A tap that did not turn into a drag is a selection.
    if (p && !p.moved && performance.now() - p.downTime < 600 && p.button === 0) {
      this.onClick?.(e.clientX, e.clientY);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabledInput) return;
    e.preventDefault();
    // Normalise across the three wheel delta modes so a trackpad and a mouse
    // wheel feel comparable.
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 18;
    else if (e.deltaMode === 2) delta *= 400;

    const factor = Math.exp(clamp(delta, -240, 240) * 0.0016);
    const next = clamp(this.distanceTarget * factor, CAM_MIN_DISTANCE, CAM_MAX_DISTANCE);

    // Zoom toward the cursor: shift the focus so the ground under the pointer
    // stays roughly put. Without this, zooming in on a feature at the edge of the
    // screen loses it immediately.
    const rect = this.element.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const zoomingIn = next < this.distanceTarget;
    if (zoomingIn) {
      const shrink = 1 - next / this.distanceTarget;
      // How far the cursor is off-centre, in world km at the focus plane.
      const halfHeight = Math.tan((this.camera.fov * Math.PI) / 360) * this.distanceTarget;
      const halfWidth = halfHeight * this.camera.aspect;
      const offX = nx * halfWidth * shrink * 0.9;
      const offY = ny * halfHeight * shrink * 0.9;
      // Convert screen offsets to world, using the camera's own basis.
      this.camera.getWorldDirection(this.tmpVec);
      this.tmpVec2.set(0, 1, 0).cross(this.tmpVec).normalize().multiplyScalar(-offX);
      this.focusTarget.add(this.tmpVec2);
      // Screen-up projected onto the ground plane.
      this.tmpVec2
        .set(this.tmpVec.x, 0, this.tmpVec.z)
        .normalize()
        .multiplyScalar(offY / Math.max(0.2, Math.cos(this.polar)));
      this.focusTarget.add(this.tmpVec2);
      this.clampFocus();
    }

    this.distanceTarget = next;
    this.onInteract?.();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    this.keys.add(e.key.toLowerCase());
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  // --- Motion -------------------------------------------------------------

  /**
   * Drag-to-pan. The scale factor converts pixels to kilometres at the focus
   * plane, so the ground tracks the cursor one-to-one at any zoom level.
   */
  private pan(dxPixels: number, dyPixels: number): void {
    const rect = this.element.getBoundingClientRect();
    const halfHeight = Math.tan((this.camera.fov * Math.PI) / 360) * this.distance;
    const kmPerPixel = (halfHeight * 2) / Math.max(1, rect.height);

    // Screen right and screen "forward" projected onto the ground plane.
    const sinA = Math.sin(this.azimuth);
    const cosA = Math.cos(this.azimuth);
    const right = this.tmpVec.set(cosA, 0, sinA);
    const forward = this.tmpVec2.set(-sinA, 0, cosA);

    // Dragging down should pull the map toward the viewer; the 1/cos term
    // accounts for the ground being foreshortened at oblique pitch.
    const fore = dyPixels * kmPerPixel / Math.max(0.25, Math.cos(this.polar));

    this.focusTarget.addScaledVector(right, -dxPixels * kmPerPixel);
    this.focusTarget.addScaledVector(forward, -fore);
    this.clampFocus();
  }

  private orbit(dxPixels: number, dyPixels: number): void {
    this.azimuthTarget -= dxPixels * 0.005;
    this.polarTarget = clamp(this.polarTarget + dyPixels * 0.004, 0.02, 1.32);
    this.manualPitch = true;
    this.manualPitchUntil = performance.now() + 6000;
  }

  private clampFocus(): void {
    // A margin past the map edge, so the coast can be centred without the camera
    // refusing to look at the ocean beyond it.
    const limit = HALF_KM * 1.06;
    this.focusTarget.x = clamp(this.focusTarget.x, -limit, limit);
    this.focusTarget.z = clamp(this.focusTarget.z, -limit, limit);
  }

  /** Zooms by a multiplicative factor, for the on-screen buttons. */
  zoomBy(factor: number): void {
    this.distanceTarget = clamp(this.distanceTarget * factor, CAM_MIN_DISTANCE, CAM_MAX_DISTANCE);
  }

  rotateBy(radians: number): void {
    this.azimuthTarget += radians;
  }

  tiltBy(radians: number): void {
    this.polarTarget = clamp(this.polarTarget + radians, 0.02, 1.32);
    this.manualPitch = true;
    this.manualPitchUntil = performance.now() + 6000;
  }

  setNorthUp(): void {
    this.azimuthTarget = Math.round(this.azimuthTarget / TAU_SAFE) * TAU_SAFE;
  }

  /**
   * The pitch the current zoom level wants: nearly top-down at world scale,
   * oblique when close in.
   */
  private naturalPolar(): number {
    const t = smoothstep(2600, 40, this.distance);
    return lerp(0.1, 1.02, t);
  }

  update(dt: number): void {
    this.handleKeys(dt);

    if (!this.manualPitch && !this.scripted) {
      this.polarTarget = this.naturalPolar();
    } else if (this.manualPitch && performance.now() > this.manualPitchUntil) {
      // Hand the tilt back to the zoom coupling gradually rather than snapping.
      this.polarTarget = lerp(this.polarTarget, this.naturalPolar(), 0.02);
      if (Math.abs(this.polarTarget - this.naturalPolar()) < 0.01) this.manualPitch = false;
    }

    // Damping rates: position and zoom are heavy, rotation is lighter, so
    // orbiting feels responsive while panning feels like moving a physical model.
    this.focus.x = damp(this.focus.x, this.focusTarget.x, 9, dt);
    this.focus.z = damp(this.focus.z, this.focusTarget.z, 9, dt);
    this.distance = damp(this.distance, this.distanceTarget, 7.5, dt);
    this.azimuth = dampAngle(this.azimuth, this.azimuthTarget, 11, dt);
    this.polar = damp(this.polar, this.polarTarget, 8, dt);

    this.updateCamera();
  }

  private handleKeys(dt: number): void {
    if (!this.keys.size) return;
    const speed = this.distance * 0.7 * dt;
    const sinA = Math.sin(this.azimuth);
    const cosA = Math.cos(this.azimuth);
    let mx = 0;
    let mz = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) mz -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) mz += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
    if (mx !== 0 || mz !== 0) {
      const len = Math.hypot(mx, mz);
      mx /= len;
      mz /= len;
      this.focusTarget.x += (cosA * mx - sinA * mz) * speed;
      this.focusTarget.z += (sinA * mx + cosA * mz) * speed;
      this.clampFocus();
    }
    if (this.keys.has('q')) this.azimuthTarget -= dt * 1.1;
    if (this.keys.has('e')) this.azimuthTarget += dt * 1.1;
    if (this.keys.has('r')) this.tiltBy(-dt * 0.8);
    if (this.keys.has('f')) this.tiltBy(dt * 0.8);
    if (this.keys.has('+') || this.keys.has('=')) this.zoomBy(Math.exp(-dt * 1.4));
    if (this.keys.has('-') || this.keys.has('_')) this.zoomBy(Math.exp(dt * 1.4));
  }

  private updateCamera(): void {
    // The focus point sits on the terrain, so descending toward a mountain valley
    // keeps the valley floor in the middle of the screen rather than the sea level
    // plane far below it.
    const groundY = this.opts.heightAt(this.focus.x, this.focus.z) * this.opts.exaggeration();
    const focusY = Math.max(0, groundY);

    const cosP = Math.cos(this.polar);
    const sinP = Math.sin(this.polar);
    const horizontal = this.distance * sinP;

    this.camera.position.set(
      this.focus.x - Math.sin(this.azimuth) * horizontal,
      focusY + this.distance * cosP,
      this.focus.z + Math.cos(this.azimuth) * horizontal,
    );

    // Never let the camera end up underground when the pitch is very oblique.
    const camGround =
      this.opts.heightAt(this.camera.position.x, this.camera.position.z) * this.opts.exaggeration();
    const minY = camGround + Math.max(0.35, this.distance * 0.045);
    if (this.camera.position.y < minY) this.camera.position.y = minY;

    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.focus.x, focusY, this.focus.z);
    this.camera.updateMatrixWorld();
  }
}
