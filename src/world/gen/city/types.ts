/**
 * The city plan data model.
 *
 * A plan is deliberately hierarchical — streets divide the town into
 * superblocks, superblocks divide into blocks, blocks divide into parcels —
 * because that hierarchy is also the level-of-detail chain. From four kilometres
 * up the renderer draws blocks; from one, parcels. Parcels are therefore
 * generated *lazily, per block*, and a city of sixty thousand plots costs nothing
 * until something actually looks at one.
 */

import type { BuildingSpec } from './buildings';
import type { Fortification } from './walls';
import type { FieldSystem } from '../rural/fields';
import type { Harbour } from './harbour';
import type { Poly } from './geometry2d';

export type DistrictKind =
  | 'plaza'
  | 'civic'
  | 'market'
  | 'temple'
  | 'artisan'
  | 'residential'
  | 'suburb'
  | 'docks'
  | 'warehouse'
  | 'garrison'
  | 'shanty'
  | 'orchard';

export type StreetClass = 'primary' | 'secondary' | 'lane';

export interface Parcel {
  poly: Poly;
  district: DistrictKind;
  /** Area in square kilometres. */
  area: number;
  /** Edge index that fronts a street, or -1 if landlocked. */
  frontage: number;
  /** Deterministic 0..1, reserved for per-building variation in A2. */
  variant: number;
}

export interface Block {
  poly: Poly;
  district: DistrictKind;
  /** Centroid in world km. */
  cx: number;
  cz: number;
  /** Area in square kilometres. */
  area: number;
  /** Distance from the city centre, normalised to the city radius. */
  t: number;
  /**
   * Multiplier on the district's target plot area.
   *
   * A village is not a small city. Its households hold a yard, a garden and
   * usually a byre, so its plots are several times a townsman's burgage even
   * though both are called residential. This carries the settlement tier down to
   * the subdivider, which sees only a block.
   */
  plotScale: number;
  /** Terrain height at the centroid, in km. */
  groundKm: number;
  /** True when the block lies inside the curtain wall. */
  walled: boolean;
  /** Parcels, subdivided on demand. Null until first requested. */
  parcels: Parcel[] | null;
  /** Buildings, generated on demand from the parcels. Null until requested. */
  buildings: BuildingSpec[] | null;
  /**
   * Cached geometry per detail tier, built on demand and reused whenever the
   * visible set changes. Rebuilding a whole city's geometry from scratch on every
   * camera move costs a visible hitch; copying cached typed arrays does not.
   */
  geom: { full: BlockGeometry | null; boxes: BlockGeometry | null; mass: BlockGeometry | null };
  /**
   * Cached ground surfacing for the same three cases: the plain plot colour laid
   * under the solid tiers, the parcel mosaic drawn in its place at middle
   * distance, and the single polygon that stands for the block far away.
   */
  flat: { built: FlatGeometry | null; plots: FlatGeometry | null; whole: FlatGeometry | null };
}

/**
 * A ground-hugging geometry slice: coloured polygons, no normals and no anchor,
 * because everything in it lies flat on the terrain and is lit by it.
 */
export interface FlatGeometry {
  pos: Float32Array;
  col: Float32Array;
  idx: Uint32Array;
}

/** A block's baked geometry at one detail tier. */
export interface BlockGeometry {
  /** x, localY, z - the height above the building base, not a world Y. */
  pos: Float32Array;
  nor: Float32Array;
  col: Float32Array;
  /** The ground-sample anchor for each vertex, so a building does not shear. */
  anchor: Float32Array;
  idx: Uint32Array;
}

export interface StreetSegment {
  /** Flat world x,z pairs along the centreline. */
  pts: Float32Array;
  klass: StreetClass;
  /** Full width in km. */
  widthKm: number;
}

export interface Gate {
  x: number;
  z: number;
  /** Outward bearing, radians. */
  bearing: number;
}

export interface CityPlan {
  featureId: number;
  name: string;
  cx: number;
  cz: number;
  /** Nominal radius in km. */
  radiusKm: number;
  form: 'radial' | 'grid';
  culture: number;
  streets: StreetSegment[];
  blocks: Block[];
  /** Curtain wall ring as flat x,z pairs, or null when unwalled. */
  wall: Float32Array | null;
  gates: Gate[];
  /** The wall as buildable pieces: panels, towers, gatehouses, ditch. */
  fort: Fortification | null;
  /** Quays, jetties, breakwater and moored hulls, or null inland. */
  harbour: Harbour | null;
  /** The worked land around the town: parcels, boundaries and farmsteads. */
  fields: FieldSystem;
  /** The fields, baked flat. Camera-independent, like the streets. */
  fieldGround: FlatGeometry | null;
  /** Farmstead buildings, baked. */
  fieldBuildings: BlockGeometry | null;
  /** The works, baked once. Camera-independent, like everything else here. */
  works: BlockGeometry | null;
  /**
   * Streets and wall, baked once. They do not depend on the camera, so paying for
   * them on every rebuild is pure waste in the frequent case.
   */
  ground: FlatGeometry | null;
  stats: {
    blocks: number;
    streetKm: number;
    /** Parcels actually materialised so far. */
    parcels: number;
  };
}

/** Everything the generator is allowed to read about the world. */
export interface CityContext {
  /** Terrain height in km at a world position. */
  heightAt: (x: number, z: number) => number;
  /** Approximate gradient magnitude, 0..1, at a world position. */
  slopeAt: (x: number, z: number) => number;
  /**
   * Biome id at a world position.
   *
   * The field system needs it: what a boundary is made of, and whether the ground
   * is worth ploughing at all, are both properties of the country rather than of
   * the town.
   */
  biomeAt: (x: number, z: number) => number;
  /** Bearings of roads arriving at this settlement, radians. */
  approaches: number[];
  /** Culture id, which selects the plan form and street proportions. */
  culture: number;
  /** Whether the settlement is walled. */
  walled: boolean;
  /** Whether the settlement is coastal. */
  coastal: boolean;
  population: number;
  tier: 'capital' | 'city' | 'town' | 'village' | 'hamlet';
}

/** Per-district appearance and subdivision rules. */
export interface DistrictRule {
  /** Packed RGB, used by the plan renderer and later as a base building tint. */
  color: number;
  /** Target parcel area in square metres. */
  parcelArea: number;
  /** Minimum street frontage in metres. */
  minFrontage: number;
  /** Fraction of the block left as yard or court, 0..1. */
  openness: number;
  label: string;
}

export const DISTRICTS: Record<DistrictKind, DistrictRule> = {
  // The open square itself: paved, and deliberately almost unbuilt.
  plaza: { color: 0xc9bfa4, parcelArea: 9000, minFrontage: 40, openness: 0.94, label: 'The square' },
  civic: { color: 0xd9cdae, parcelArea: 2600, minFrontage: 26, openness: 0.34, label: 'Civic' },
  market: { color: 0xd2b784, parcelArea: 900, minFrontage: 14, openness: 0.5, label: 'Market' },
  temple: { color: 0xcfc0d6, parcelArea: 3200, minFrontage: 30, openness: 0.44, label: 'Temple precinct' },
  artisan: { color: 0x8d6f52, parcelArea: 420, minFrontage: 9, openness: 0.14, label: 'Artisan quarter' },
  residential: { color: 0xab8a61, parcelArea: 520, minFrontage: 11, openness: 0.18, label: 'Residential' },
  suburb: { color: 0x9aa46c, parcelArea: 1250, minFrontage: 18, openness: 0.4, label: 'Suburb' },
  docks: { color: 0x6f8794, parcelArea: 1100, minFrontage: 20, openness: 0.22, label: 'Docks' },
  warehouse: { color: 0x8a8069, parcelArea: 1600, minFrontage: 24, openness: 0.12, label: 'Warehouses' },
  garrison: { color: 0x7d736c, parcelArea: 2200, minFrontage: 26, openness: 0.3, label: 'Garrison' },
  shanty: { color: 0x94814f, parcelArea: 180, minFrontage: 6, openness: 0.1, label: 'Outside the wall' },
  orchard: { color: 0x6f8b4a, parcelArea: 5200, minFrontage: 34, openness: 0.7, label: 'Orchards and gardens' },
};

/** Street widths in km, by class. Primary streets are wide enough for two carts to pass. */
export const STREET_WIDTH: Record<StreetClass, number> = {
  primary: 0.017,
  secondary: 0.010,
  lane: 0.0055,
};

/**
 * People per square kilometre, by settlement tier.
 *
 * These set the footprint. A pre-industrial city runs at roughly 15,000-25,000
 * per square kilometre inside its walls; villages are an order of magnitude
 * looser because every household has a yard and a garden.
 */
export const DENSITY: Record<CityContext['tier'], number> = {
  capital: 19000,
  city: 17000,
  town: 8500,
  village: 3200,
  hamlet: 1800,
};

/** Nominal city radius in km from population and tier. */
export function cityRadius(population: number, tier: CityContext['tier']): number {
  const areaKm2 = Math.max(0.02, population / DENSITY[tier]);
  return Math.sqrt(areaKm2 / Math.PI);
}
