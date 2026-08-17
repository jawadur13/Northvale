/**
 * The authored skeleton of Northvale.
 *
 * Pure noise produces plausible *texture* but never a plausible *world* - you
 * get no guarantee of a polar landmass, no guarantee that the equator is not all
 * water, and mountain ranges that run along whatever axis the noise happens to
 * favour. So the large structures are placed by hand here, and noise is used
 * only to give them natural edges.
 *
 * Coordinates are world kilometres: x runs east, z runs south, and the world
 * spans -2048..2048 on both axes. North is -Z, so latitude falls as z rises.
 */

/** A continental core - a broad elliptical rise that noise then erodes into a coast. */
export interface Core {
  name: string;
  /**
   * Which named continent this core belongs to. Several cores can share one, so
   * a polar cap fused to a continent's crown is part of that continent rather
   * than a separate one - and, conversely, two continents joined by an accident
   * of the noise keep their separate names, exactly as Europe and Asia do.
   */
  continent: string;
  x: number;
  z: number;
  /** Semi-axes in km. */
  rx: number;
  rz: number;
  /** Rotation in radians, so continents are not all axis-aligned. */
  rot: number;
  /** Peak contribution to the continental potential field. */
  strength: number;
  /** Falloff sharpness: higher gives more abrupt continental shelves. */
  falloff: number;
}

/**
 * Six major landmasses plus two land bridges. The layout deliberately spreads
 * cores across all latitudes so the finished world contains polar ice, boreal
 * forest, temperate belts, subtropical desert and equatorial rainforest.
 */
export const CORES: Core[] = [
  // Aurenhal - the great northern continent. Cold, mountainous, heavily forested.
  { name: 'Aurenhal', continent: 'Aurenhal', x: -620, z: -1120, rx: 1150, rz: 770, rot: -0.2, strength: 1.06, falloff: 1.5 },
  // Hjalmark - the northern polar cap, fused to Aurenhal's north-eastern crown.
  { name: 'Hjalmark', continent: 'Aurenhal', x: 150, z: -1760, rx: 790, rz: 410, rot: 0.1, strength: 0.94, falloff: 1.9 },
  // Kaerith - the temperate heartland, and the most densely settled continent.
  // Separated from Aurenhal by the Sundering Strait rather than joined to it.
  { name: 'Kaerith', continent: 'Kaerith', x: -1250, z: 150, rx: 700, rz: 830, rot: 0.3, strength: 1.04, falloff: 1.6 },
  // Sahvarem - the great desert continent, straddling the subtropics.
  { name: 'Sahvarem', continent: 'Sahvarem', x: 1050, z: -320, rx: 950, rz: 820, rot: 0.15, strength: 1.02, falloff: 1.45 },
  // Ossuary Reach - a long thin subcontinent north-east of Sahvarem.
  { name: 'Ossuary', continent: 'Ossuary Reach', x: 1700, z: -1060, rx: 290, rz: 560, rot: 0.5, strength: 0.8, falloff: 2.1 },
  // Tolmereth - equatorial, drowned in rainforest.
  { name: 'Tolmereth', continent: 'Tolmereth', x: 1520, z: 740, rx: 600, rz: 540, rot: -0.3, strength: 0.98, falloff: 1.7 },
  // Veshanti - the southern continent, temperate turning subantarctic.
  { name: 'Veshanti', continent: 'Veshanti', x: 100, z: 1240, rx: 1080, rz: 700, rot: 0.1, strength: 1.0, falloff: 1.55 },
  // Kethrun - the southern polar shelf, across a strait from Veshanti.
  { name: 'Kethrun', continent: 'Kethrun', x: -1150, z: 1880, rx: 650, rz: 380, rot: -0.14, strength: 0.88, falloff: 2.0 },
];

export type BeltKind = 'collision' | 'coastal' | 'arc' | 'rift' | 'dome';

/**
 * Orogenic belts - where the world builds mountains.
 *
 * `collision` belts are the enormous interior ranges thrown up where two cores
 * meet. `coastal` belts hug a continental margin, giving the classic
 * high-mountains-then-immediate-sea profile. `arc` belts sit in open water and
 * surface as volcanic island chains. `rift` belts drop the crust to form
 * inland seas and deep valleys. `dome` belts raise broad plateaus.
 */
export interface Belt {
  name: string;
  kind: BeltKind;
  /** Polyline in world km. */
  pts: Array<[number, number]>;
  /** Half-width of the belt in km. */
  width: number;
  /** 0..1.4 uplift strength. */
  strength: number;
  /** Extra sharpness for the ridged noise along this belt. */
  ruggedness: number;
}

export const BELTS: Belt[] = [
  // The world's longest range, running the length of Aurenhal.
  {
    name: 'Skarnhold Spine',
    kind: 'collision',
    pts: [
      [-1480, -980],
      [-1080, -1080],
      [-620, -1160],
      [-180, -1250],
      [260, -1340],
    ],
    width: 200,
    strength: 1.34,
    ruggedness: 1.25,
  },
  // Coastal wall: high mountains straight into the Hollow Ocean.
  {
    name: 'Aurenhal West Wall',
    kind: 'coastal',
    pts: [
      [-1580, -1300],
      [-1690, -1060],
      [-1650, -820],
      [-1430, -600],
    ],
    width: 130,
    strength: 1.12,
    ruggedness: 1.35,
  },
  // Interior collision belt, running south toward the Amber Sea.
  {
    name: 'Emberfang Range',
    kind: 'collision',
    pts: [
      [-700, -1350],
      [-500, -1060],
      [-380, -790],
      [-420, -510],
    ],
    width: 150,
    strength: 1.0,
    ruggedness: 1.1,
  },
  // Kaerith's weather wall - everything east of it is in rain shadow.
  {
    name: 'Kaerith Shieldwall',
    kind: 'coastal',
    pts: [
      [-1700, -300],
      [-1790, 20],
      [-1740, 330],
      [-1560, 600],
    ],
    width: 145,
    strength: 1.18,
    ruggedness: 1.3,
  },
  // A broad dome rather than a ridge: rolling upland, not a barrier.
  {
    name: 'Hallowmere Highlands',
    kind: 'dome',
    pts: [
      [-1200, 140],
      [-1000, 330],
    ],
    width: 380,
    strength: 0.6,
    ruggedness: 0.55,
  },
  // Terraced collision belt through the Kaerith interior.
  {
    name: 'Thousand Steps',
    kind: 'collision',
    pts: [
      [-1150, -450],
      [-1000, -140],
      [-1060, 200],
      [-1210, 500],
    ],
    width: 120,
    strength: 0.96,
    ruggedness: 1.2,
  },
  // Traps the monsoon and makes the desert behind it.
  {
    name: 'Sahvarem Rim',
    kind: 'coastal',
    pts: [
      [330, -690],
      [230, -420],
      [280, -120],
      [400, 180],
    ],
    width: 155,
    strength: 1.08,
    ruggedness: 1.15,
  },
  // The tableland that the Sundering is cut through.
  {
    name: 'Zerrakhan Uplift',
    kind: 'dome',
    pts: [
      [1000, -450],
      [1300, -320],
    ],
    width: 470,
    strength: 0.72,
    ruggedness: 0.4,
  },
  // A knife-edge spine down the length of the Ossuary Reach.
  {
    name: 'Ossuary Ridge',
    kind: 'collision',
    pts: [
      [1900, -1440],
      [1780, -1180],
      [1650, -920],
      [1520, -690],
    ],
    width: 105,
    strength: 1.0,
    ruggedness: 1.3,
  },
  // Equatorial range; rainforest to the treeline.
  {
    name: 'Tolmereth Crown',
    kind: 'collision',
    pts: [
      [1180, 850],
      [1450, 770],
      [1720, 690],
    ],
    width: 130,
    strength: 0.98,
    ruggedness: 1.15,
  },
  // The southern continent's watershed, and its political spine.
  {
    name: 'Veshanti Divide',
    kind: 'collision',
    pts: [
      [-800, 1330],
      [-400, 1300],
      [0, 1250],
      [420, 1200],
      [820, 1160],
    ],
    width: 190,
    strength: 1.22,
    ruggedness: 1.2,
  },
  // Glaciated coastal range on the polar shelf.
  {
    name: 'Cairnfrost Barrier',
    kind: 'coastal',
    pts: [
      [-1650, 1960],
      [-1300, 1930],
      [-950, 1870],
      [-620, 1810],
    ],
    width: 140,
    strength: 1.04,
    ruggedness: 1.25,
  },
  // Volcanic island arc, still active.
  {
    name: 'Ashling Arc',
    kind: 'arc',
    pts: [
      [600, 170],
      [700, 380],
      [750, 590],
    ],
    width: 70,
    strength: 0.92,
    ruggedness: 1.4,
  },
  // A chain of young volcanic islets in the south-west.
  {
    name: 'Cinderchain',
    kind: 'arc',
    pts: [
      [-1820, 860],
      [-1680, 1080],
      [-1500, 1270],
    ],
    width: 62,
    strength: 0.86,
    ruggedness: 1.45,
  },
  // Eastern island arc, sheltering the Mirrowhal Sound behind it.
  {
    name: 'Mirrowhal Arc',
    kind: 'arc',
    pts: [
      [1900, 60],
      [1960, 300],
      [1920, 540],
    ],
    width: 58,
    strength: 0.8,
    ruggedness: 1.4,
  },
  // A mostly drowned arc - a line of shoals and a few rocks.
  {
    name: 'Sunken Trace',
    kind: 'arc',
    pts: [
      [-300, -600],
      [-60, -680],
      [180, -740],
    ],
    width: 52,
    strength: 0.48,
    ruggedness: 1.3,
  },
  // A rift that flooded, forming the deep Sea of Thessaly.
  {
    name: 'Thessaly Rift',
    kind: 'rift',
    pts: [
      [640, -980],
      [720, -720],
      [680, -470],
    ],
    width: 120,
    strength: 0.9,
    ruggedness: 0.6,
  },
  // A rift valley that never quite flooded.
  {
    name: 'Graven Trough',
    kind: 'rift',
    pts: [
      [-1300, 600],
      [-1150, 780],
      [-1060, 960],
    ],
    width: 95,
    strength: 0.78,
    ruggedness: 0.5,
  },
];
/** Broad regions where the crust is stepped rather than smooth: mesas, canyons, badlands. */
export interface StepZone {
  x: number;
  z: number;
  r: number;
  /** Vertical step size in km. */
  step: number;
  strength: number;
}

export const STEP_ZONES: StepZone[] = [
  { x: 620, z: -180, r: 520, step: 0.115, strength: 0.85 },
  { x: 980, z: 60, r: 430, step: 0.095, strength: 0.7 },
  { x: 1500, z: -720, r: 300, step: 0.13, strength: 0.75 },
  { x: -260, z: 480, r: 340, step: 0.085, strength: 0.6 },
  { x: 300, z: 1560, r: 380, step: 0.1, strength: 0.55 },
  { x: -1380, z: -820, r: 260, step: 0.12, strength: 0.65 },
];

/** Named shallow platforms that become archipelagos and reefs. */
export interface Shoal {
  x: number;
  z: number;
  r: number;
  /** How far above the ocean floor the platform rises, in km. */
  rise: number;
  /** Density of emergent islands, 0..1. */
  density: number;
}

export const SHOALS: Shoal[] = [
  { x: -300, z: 780, r: 460, rise: 3.5, density: 0.62 },
  { x: 520, z: 980, r: 400, rise: 3.3, density: 0.58 },
  { x: 1180, z: -1350, r: 380, rise: 3.2, density: 0.5 },
  { x: -1700, z: -320, r: 300, rise: 3.0, density: 0.45 },
  { x: 1700, z: 1400, r: 420, rise: 3.4, density: 0.55 },
  { x: -1500, z: 1500, r: 330, rise: 3.1, density: 0.48 },
  { x: 60, z: -1560, r: 280, rise: 2.9, density: 0.4 },
  { x: 1350, z: 250, r: 250, rise: 3.0, density: 0.44 },
  { x: -520, z: -60, r: 210, rise: 2.8, density: 0.38 },
  // Shoal under the Sundering Strait: shallow, reef-strewn, and the reason a
  // pilot is worth what a pilot charges.
  { x: -1160, z: -420, r: 260, rise: 1.7, density: 0.05 },
  // Kethrun Passage shelf.
  { x: -560, z: 1700, r: 220, rise: 1.9, density: 0.08 },
  { x: 1900, z: -1750, r: 260, rise: 3.0, density: 0.42 },
];

/** Squared distance from a point to a polyline, in km^2. */
export function distToPolyline(px: number, pz: number, pts: Array<[number, number]>): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const vx = bx - ax;
    const vz = bz - az;
    const wx = px - ax;
    const wz = pz - az;
    const len2 = vx * vx + vz * vz;
    let t = len2 > 0 ? (wx * vx + wz * vz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - vx * t;
    const dz = wz - vz * t;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return best;
}

/** Elliptical, rotated falloff for a continental core. Returns 0..1. */
export function coreInfluence(px: number, pz: number, c: Core): number {
  const dx = px - c.x;
  const dz = pz - c.z;
  const cos = Math.cos(c.rot);
  const sin = Math.sin(c.rot);
  const ex = (dx * cos + dz * sin) / c.rx;
  const ez = (-dx * sin + dz * cos) / c.rz;
  const d2 = ex * ex + ez * ez;
  // Gaussian-ish: flat interior, quick shelf, long tail.
  return Math.exp(-d2 * c.falloff);
}

/**
 * Named bodies of water.
 *
 * Oceans are named by convention rather than by topology - the world ocean is
 * topologically one connected body, so a Voronoi assignment from authored
 * centres is both cheaper and more cartographically honest than trying to
 * detect basins. `weight` biases the assignment so a small named gulf does not
 * swallow half an ocean.
 */
export interface WaterBody {
  name: string;
  kind: 'ocean' | 'sea' | 'gulf' | 'bay' | 'strait' | 'channel' | 'sound';
  x: number;
  z: number;
  /** Nominal radius in km, used both for weighting and for camera framing. */
  r: number;
  weight: number;
  description: string;
}

export const WATER_BODIES: WaterBody[] = [
  {
    name: 'The Hollow Ocean',
    kind: 'ocean',
    x: -1780,
    z: -300,
    r: 1500,
    weight: 1,
    description:
      'The western deep. Cold, storm-ridden and almost never crossed directly - ships hug the Kaerith shelf instead.',
  },
  {
    name: 'Meridian Ocean',
    kind: 'ocean',
    x: 60,
    z: 60,
    r: 1300,
    weight: 0.95,
    description:
      'The warm equatorial belt of open water that separates the northern continents from Veshanti.',
  },
  {
    name: 'The Sunder',
    kind: 'ocean',
    x: 1880,
    z: 1250,
    r: 1300,
    weight: 0.95,
    description: 'The eastern ocean. Beyond the last charted reef the maps simply stop.',
  },
  {
    name: 'Boreal Ocean',
    kind: 'ocean',
    x: -1200,
    z: -1900,
    r: 1100,
    weight: 0.9,
    description: 'Half-frozen for eight months of the year, and pack ice for the other four.',
  },
  {
    name: 'The Long Cold',
    kind: 'ocean',
    x: 1100,
    z: 1900,
    r: 1200,
    weight: 0.9,
    description: 'The southern ocean, circling Kethrun without ever quite touching it.',
  },
  {
    name: 'Sea of Thessaly',
    kind: 'sea',
    x: 660,
    z: -700,
    r: 430,
    weight: 1.6,
    description:
      'A drowned rift valley. Deeper than the ocean that feeds it, and warmer than it has any right to be.',
  },
  {
    name: 'Amber Sea',
    kind: 'sea',
    x: -600,
    z: -430,
    r: 400,
    weight: 1.55,
    description:
      'Shallow, sheltered, and the busiest water in the world - every port on both shores trades across it.',
  },
  {
    name: 'Sea of Glass',
    kind: 'sea',
    x: -1020,
    z: 830,
    r: 340,
    weight: 1.6,
    description: 'Almost tideless. On a still morning the whole basin mirrors the sky.',
  },
  {
    name: 'Verdant Sea',
    kind: 'sea',
    x: 1120,
    z: 620,
    r: 360,
    weight: 1.55,
    description: 'Warm, green with algal bloom, and thick with reefs no chart has ever fully mapped.',
  },
  {
    name: 'Gulf of Ashlings',
    kind: 'gulf',
    x: 700,
    z: 830,
    r: 250,
    weight: 1.9,
    description: 'Ringed by the smoking cones of the Ashling Arc; the water tastes faintly of sulphur.',
  },
  {
    name: 'Gulf of Halvard',
    kind: 'gulf',
    x: 190,
    z: -1490,
    r: 260,
    weight: 1.85,
    description: 'Ice-choked in winter, and the only sheltered water on the northern coast.',
  },
  {
    name: 'Gulf of Zerrakh',
    kind: 'gulf',
    x: 1240,
    z: -80,
    r: 230,
    weight: 1.9,
    description: 'The desert meets the sea here with no coastal plain at all.',
  },
  {
    name: 'Bay of Cormorants',
    kind: 'bay',
    x: -1400,
    z: 420,
    r: 170,
    weight: 2.3,
    description: 'A drowned river mouth, sheltered enough to anchor a fleet.',
  },
  {
    name: 'Sorrowmouth Bay',
    kind: 'bay',
    x: -260,
    z: 1000,
    r: 180,
    weight: 2.3,
    description: 'Named for the sound the wind makes in the sea caves along its southern head.',
  },
  {
    name: 'Bay of Kethrun',
    kind: 'bay',
    x: -700,
    z: 1620,
    r: 190,
    weight: 2.2,
    description: 'Frozen solid from the first frost until well after the spring thaw inland.',
  },
  {
    name: 'The Sundering Strait',
    kind: 'strait',
    x: -1180,
    z: -300,
    r: 130,
    weight: 2.6,
    description:
      'Forty kilometres of hard current between two continents. Every ship that can afford the pilot takes one.',
  },
  {
    name: 'Ossuary Channel',
    kind: 'channel',
    x: 1290,
    z: -730,
    r: 140,
    weight: 2.5,
    description: 'Shallow, reef-toothed, and littered with the ribs of the ships that named it.',
  },
  {
    name: 'Mirrowhal Sound',
    kind: 'sound',
    x: 1790,
    z: 300,
    r: 150,
    weight: 2.4,
    description: 'A long inner passage behind the Mirrowhal islands, calm in any weather.',
  },
  {
    name: 'Cinderchain Passage',
    kind: 'channel',
    x: -1560,
    z: 1120,
    r: 150,
    weight: 2.4,
    description: 'Threads between volcanic islets, and the chart is redrawn after every eruption.',
  },
];
