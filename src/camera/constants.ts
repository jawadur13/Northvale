/**
 * Camera limits, re-exported from the world config so the camera package has a
 * single import surface and no dependency on world-generation concerns.
 */
export { CAM_MAX_DISTANCE, CAM_MIN_DISTANCE, CAM_WORLD_DISTANCE, HALF_KM } from '../core/config';

/** A full turn. Named to avoid colliding with the maths helper of the same idea. */
export const TAU_SAFE = Math.PI * 2;
