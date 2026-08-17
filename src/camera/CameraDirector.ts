/**
 * Scripted camera flights.
 *
 * Selecting a place should feel like travelling to it, not like cutting to it.
 * A flight interpolates focus, distance, azimuth and pitch together, with two
 * details that matter more than the easing curve:
 *
 *  - **The arc.** Long flights pull back before descending, following a raised
 *    parabola in distance. Sliding across the map at constant altitude reads as a
 *    smear; rising, crossing, and descending reads as travel, and it also keeps
 *    the terrain LOD from thrashing through every intermediate detail level.
 *  - **Duration from distance.** A 4,000 km hop and a 20 km hop cannot take the
 *    same time. Duration grows with the logarithm of the ground distance, so short
 *    moves are crisp and long ones are given room to breathe, and both stay inside
 *    a couple of seconds.
 *
 * A flight yields immediately to any user input, because a camera that fights the
 * mouse is worse than no animation at all.
 */

import { clamp, easeInOutQuint, lerp, shortestAngle, smootherstep } from '../util/math';
import type { MapControls } from './MapControls';

export interface FlightTarget {
  x: number;
  z: number;
  /** Final camera distance in km. */
  distance: number;
  /** Optional final azimuth; omitted keeps the current heading. */
  azimuth?: number;
  /** Optional final pitch. */
  polar?: number;
}

interface Flight {
  fromX: number;
  fromZ: number;
  fromDistance: number;
  fromAzimuth: number;
  fromPolar: number;
  toX: number;
  toZ: number;
  toDistance: number;
  toAzimuth: number;
  toPolar: number;
  /** Peak distance at the middle of the arc. */
  arcDistance: number;
  duration: number;
  elapsed: number;
}

export class CameraDirector {
  private controls: MapControls;
  private flight: Flight | null = null;
  private onArrive: (() => void) | null = null;

  constructor(controls: MapControls) {
    this.controls = controls;
    // Any manual input cancels the flight in progress.
    const previous = controls.onInteract;
    controls.onInteract = () => {
      previous?.();
      this.cancel();
    };
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  cancel(): void {
    if (this.flight) {
      this.flight = null;
      this.controls.scripted = false;
      this.onArrive = null;
    }
  }

  /**
   * Frames a feature: chooses a distance that fits its extent on screen, then
   * flies there.
   *
   * @param extentKm the feature's radius; the camera pulls back far enough to
   *   contain it with margin, floored so a single building is not approached to
   *   within ten metres.
   */
  flyToFeature(x: number, z: number, extentKm: number, onArrive?: () => void): void {
    // Fit the extent into roughly 55% of the vertical field of view.
    const fitted = Math.max(2.2, extentKm * 3.1);
    this.flyTo({ x, z, distance: clamp(fitted, 2.2, 5600) }, onArrive);
  }

  flyTo(target: FlightTarget, onArrive?: () => void): void {
    const s = this.controls.getState();
    const ground = Math.hypot(target.x - s.x, target.z - s.z);
    const toDistance = clamp(target.distance, 1.4, 7600);

    // Duration from the logarithm of how far we are going, in both senses:
    // across the ground, and up or down.
    const zoomRatio = Math.max(toDistance, s.distance) / Math.max(1, Math.min(toDistance, s.distance));
    const groundTerm = Math.log10(1 + ground / 12) * 0.42;
    const zoomTerm = Math.log10(1 + zoomRatio) * 0.34;
    const duration = clamp(0.75 + groundTerm + zoomTerm, 0.75, 2.9);

    // Arc height: enough altitude to see both ends of a long journey. Short hops
    // barely arc at all, which keeps a click-to-select from feeling swoopy.
    const needsArc = ground > s.distance * 0.6;
    const arcDistance = needsArc
      ? clamp(Math.max(s.distance, toDistance) * 1.15 + ground * 0.55, toDistance, 6800)
      : Math.max(s.distance, toDistance);

    const toAzimuth =
      target.azimuth !== undefined ? s.azimuth + shortestAngle(s.azimuth, target.azimuth) : s.azimuth;

    // Default the arrival pitch to something appropriate for the arrival altitude.
    const naturalPolar = lerp(0.1, 1.0, smootherstep(2400, 30, toDistance));
    const toPolar = target.polar !== undefined ? target.polar : naturalPolar;

    this.flight = {
      fromX: s.x,
      fromZ: s.z,
      fromDistance: s.distance,
      fromAzimuth: s.azimuth,
      fromPolar: s.polar,
      toX: target.x,
      toZ: target.z,
      toDistance,
      toAzimuth,
      toPolar,
      arcDistance,
      duration,
      elapsed: 0,
    };
    this.onArrive = onArrive ?? null;
    this.controls.scripted = true;
  }

  /** Snaps straight to a target with no animation. Used by the reset control. */
  jumpTo(target: FlightTarget): void {
    this.cancel();
    this.controls.setTarget(target.x, target.z, target.distance, target.azimuth, target.polar);
    this.controls.applyImmediate();
  }

  update(dt: number): void {
    const f = this.flight;
    if (!f) return;

    f.elapsed += dt;
    const raw = clamp(f.elapsed / f.duration, 0, 1);
    const t = easeInOutQuint(raw);

    const x = lerp(f.fromX, f.toX, t);
    const z = lerp(f.fromZ, f.toZ, t);

    // Distance follows a raised parabola through arcDistance at the midpoint.
    // Interpolating in log space keeps the perceived rate of zoom even, which is
    // what stops the middle of a long flight from feeling like it stalls.
    const logFrom = Math.log(f.fromDistance);
    const logTo = Math.log(f.toDistance);
    const logArc = Math.log(f.arcDistance);
    const base = lerp(logFrom, logTo, t);
    const bump = 4 * t * (1 - t) * (logArc - (logFrom + logTo) * 0.5);
    const distance = Math.exp(base + bump);

    const azimuth = lerp(f.fromAzimuth, f.toAzimuth, t);
    const polar = lerp(f.fromPolar, f.toPolar, t);

    this.controls.setTarget(x, z, distance, azimuth, polar);
    // The flight drives the *actual* camera state, not just the target, so the
    // damping in MapControls does not lag behind and undershoot the arrival.
    this.controls.applyImmediate();

    if (raw >= 1) {
      this.flight = null;
      this.controls.scripted = false;
      const cb = this.onArrive;
      this.onArrive = null;
      cb?.();
    }
  }
}
