/**
 * Descriptive text.
 *
 * The rule here is that every sentence has to be *true of the simulation*. A
 * town's description talks about the river it was actually placed on, at the
 * discharge the flow routing actually computed; a pass quotes the elevation the
 * saddle detector actually found; a region's summary names the biome that
 * actually dominates its cells. Template variety supplies the voice, but the
 * facts come from the world, which is why zooming in on a claim tends to confirm
 * it rather than contradict it.
 */

import { Rng } from '../../util/rng';
import { formatNumber, formatPopulation, roundSignificant } from '../../util/math';
import { BIOME_BY_ID, Biome } from './biomes';
import { climateLabel, rainfallMm } from './climate';
import type { SiteReason, Settlement } from './settlements';
import type { CultureInfo, RegionInfo } from '../types';

export interface LoreContext {
  rng: Rng;
  regions: RegionInfo[];
  cultures: CultureInfo[];
  /** Nearest named river to a point, if any. */
  nearestRiver: (x: number, z: number, maxKm: number) => string | null;
  /** Nearest named range to a point, if any. */
  nearestRange: (x: number, z: number, maxKm: number) => string | null;
  /** Nearest named water body. */
  nearestSea: (x: number, z: number) => string | null;
  /** Nearest settlement name and distance. */
  nearestTown: (x: number, z: number, excludeSelf: number) => { name: string; km: number } | null;
  temperature: (x: number, z: number) => number;
  moisture: (x: number, z: number) => number;
}

// --- Settlements --------------------------------------------------------------

const REASON_OPENERS: Record<SiteReason, string[]> = {
  harbour: [
    'Built around a natural harbour that stays workable in almost any weather.',
    'The anchorage is the reason the place exists; the town grew backwards from the quays.',
    'A deep, sheltered inlet with a shingle bar across its mouth that breaks the worst of the swell.',
  ],
  river: [
    'Strung along the riverbank, with the wharves on the inside of the bend where the current is slowest.',
    'The river does the work here - mills, barges, and a fishery that has been argued over for generations.',
    'Everything faces the water. The landward side of town was an afterthought and still looks like one.',
  ],
  confluence: [
    'Sited where two rivers meet, which makes it a place everything passes through whether it means to or not.',
    'Two valleys and two rivers converge here, and so does most of the traffic in the district.',
    'The confluence gave the town its trade, its floods, and its long-running dispute over water rights.',
  ],
  ford: [
    'Grew up at the only reliable crossing for a long way in either direction.',
    'A gravel shelf lets carts across in low water. In high water they wait, and the inns do well.',
    'The ford is shallow, wide and slow, and the whole settlement is arranged around getting to it.',
  ],
  delta: [
    'Built on the firm ground between distributary channels, on piles where the ground is not firm.',
    'The delta shifts every few decades. So, gradually, does the town.',
    'Silt, reeds and shipping. The channel has to be dredged, and dredging it is the largest employer.',
  ],
  lakeshore: [
    'Set back from the shore on the only ground that does not flood in spring.',
    'The lake supplies fish, transport and, in hard winters, a road across the ice.',
    'A crescent of houses facing the water, with the boat sheds built out over it.',
  ],
  farmland: [
    'A market settlement in good arable country, laid out around a square that is empty six days a week.',
    'Surrounded by field systems old enough that the hedges are considered landmarks.',
    'Grain, hedges and drove roads. The buildings are unremarkable and the barns are not.',
  ],
  hilltop: [
    'Occupies a defensible rise with clear ground on every approach.',
    'Built on the high point, which is inconvenient for water and excellent for everything else.',
    'The site was chosen for the view, and the view was chosen for what it lets you see coming.',
  ],
  pass: [
    'Controls a pass, and charges for the privilege.',
    'The only settlement in the gap, which makes it a waystation whether it wants to be or not.',
    'Wedged into the col with the road running straight through the middle of it.',
  ],
  mining: [
    'A working town. The spoil heaps are older than the houses.',
    'Grew around the workings and has never pretended to be anything else.',
    'Ore comes down the hill, timber goes up it, and the town sits in the middle of the exchange.',
  ],
  oasis: [
    'A green disc in a great deal of nothing, and the reason the road bends here.',
    'Built over the water, not beside it - the wells are inside the walls.',
    'Palms, mudbrick and shade. In summer the town moves underground for the middle of the day.',
  ],
  crossroads: [
    'Four roads meet here, and the settlement is essentially the argument between them.',
    'A crossroads town: stables, warehouses, and more inns than the population justifies.',
    'Nothing is made here. Everything passes through.',
  ],
  island: [
    'An island settlement, dependent on the sea for everything including its news.',
    'Tucked into the lee of the island where the wind is survivable.',
    'Stone houses with the gable ends to the weather, and no trees at all.',
  ],
  frontier: [
    'About as far out as anyone has bothered to build.',
    'A last settlement, in the sense that there is nothing organised beyond it.',
    'Remote enough that the map is vague and the people are specific.',
  ],
  timber: [
    'A timber town. The sawmill is the largest structure and sets the working day.',
    'Cut into the forest edge, with the felling coupes visible as pale scars from the ridge above.',
    'Log rafts, resin and long winters.',
  ],
  coast: [
    'A coastal settlement built on the landward side of the dune ridge, out of the salt wind.',
    'Faces the sea without much shelter from it, which shows in the architecture.',
    'Fishing, salvage and a little trade. The beach is the high street.',
  ],
};

const CULTURE_NOTES: Record<string, string[]> = {
  marble: [
    'The public buildings are faced in pale stone and the street grid is imposed regardless of the contours.',
    'There is a forum, there are colonnades, and there is a water supply that works.',
  ],
  timber: [
    'Timber-framed, with jettied upper floors leaning over the lanes.',
    'Thatch, oak frames and a market cross that everything is measured from.',
  ],
  nordic: [
    'Low turf-roofed halls set gable-on to the prevailing wind.',
    'Everything is built heavy, low and windproof, and the doors face inland.',
  ],
  adobe: [
    'Mudbrick, flat roofs and courtyards - the streets are narrow to keep them in shadow.',
    'Windcatchers on every roofline, and cisterns beneath every courtyard.',
  ],
  reed: [
    'Built on piles above the flood line, connected by plank causeways rather than streets.',
    'Reed thatch, raised floors, and boats tied to the doorposts.',
  ],
  terrace: [
    'Stepped up the hillside in terraces, with the fields continuing the same stair above the roofs.',
    'Stone-walled terraces do double duty as field boundaries and as the street plan.',
  ],
  stone: [
    'Built entirely in stone, including the roofs. Nothing here is expected to burn or to rot.',
    'Squat, thick-walled and dour, with deep window reveals against the weather.',
  ],
};

export function describeSettlement(s: Settlement, ctx: LoreContext, index: number): { description: string; facts: string[] } {
  const r = ctx.rng;
  const region = ctx.regions[s.region];
  const culture = region ? ctx.cultures[region.culture] : ctx.cultures[0];
  const biome = BIOME_BY_ID[s.biome];

  const parts: string[] = [];
  parts.push(r.pick(REASON_OPENERS[s.reason] ?? REASON_OPENERS.frontier));

  if (s.tier === 'capital' && region) {
    parts.push(`It is the seat of ${region.name}.`);
  } else if (region && r.bool(0.5)) {
    parts.push(`It lies in ${region.name}.`);
  }

  if (culture && r.bool(0.62)) {
    parts.push(r.pick(CULTURE_NOTES[culture.architecture] ?? CULTURE_NOTES.stone));
  }

  // A grounded environmental sentence.
  if (biome && r.bool(0.55)) {
    const t = ctx.temperature(s.x, s.z);
    if (t < -2) parts.push('The ground is frozen for more than half the year.');
    else if (t > 27) parts.push('Work stops in the middle of the day from late spring onward.');
    else if (biome.group === 'forest') parts.push('The forest comes right up to the last houses.');
    else if (biome.group === 'wetland') parts.push('Every road out of it is a causeway.');
    else if (biome.group === 'arid') parts.push('Water is metered, and the meter is taken seriously.');
  }

  const facts: string[] = [];
  facts.push(`Population ${formatPopulation(s.population)}`);
  facts.push(`Elevation ${formatNumber(s.elevationKm * 1000)} m`);
  if (biome) facts.push(`Surrounding country: ${biome.name.toLowerCase()}`);

  const river = ctx.nearestRiver(s.x, s.z, 12);
  if (river) {
    if (s.riverFlow > 1000) {
      facts.push(`On ${river}, draining ${formatNumber(roundSignificant(s.riverFlow, 2))} km2`);
    } else {
      facts.push(`Near ${river}`);
    }
  }
  if (s.coastal) {
    const sea = ctx.nearestSea(s.x, s.z);
    if (sea) facts.push(`On the ${sea.replace(/^The /, '')}`);
  }
  const range = ctx.nearestRange(s.x, s.z, 160);
  if (range) facts.push(`Under ${range}`);
  const neighbour = ctx.nearestTown(s.x, s.z, index);
  if (neighbour) facts.push(`${Math.round(neighbour.km)} km from ${neighbour.name}`);
  if (s.walled) facts.push('Walled');

  const secondary = Object.entries(s.scores)
    .filter(([k]) => k !== s.reason)
    .sort((a, b) => (b[1] as number) - (a[1] as number))[0];
  if (secondary && (secondary[1] as number) > 0.8) {
    const note: Record<string, string> = {
      harbour: 'sheltered anchorage',
      river: 'river frontage',
      confluence: 'river confluence',
      ford: 'a usable ford',
      delta: 'delta channels',
      lakeshore: 'lake frontage',
      farmland: 'good arable land',
      hilltop: 'a defensible site',
      pass: 'control of a pass',
      mining: 'ore in the hills above',
      oasis: 'reliable groundwater',
      crossroads: 'a road junction',
      island: 'an island position',
      timber: 'standing timber',
      coast: 'a coastal position',
      frontier: 'nothing much at all',
    };
    const n = note[secondary[0]];
    if (n) facts.push(`Also notable for ${n}`);
  }

  return { description: parts.join(' '), facts };
}

// --- Natural features ---------------------------------------------------------

export function describePeak(
  name: string,
  elevationKm: number,
  prominenceKm: number,
  volcanic: boolean,
  rangeName: string | null,
  ctx: LoreContext,
): { description: string; facts: string[] } {
  const r = ctx.rng;
  const m = elevationKm * 1000;
  const parts: string[] = [];

  if (volcanic) {
    parts.push(
      r.pick([
        'A young cone, still shedding ash on the leeward side.',
        'Volcanic, and not comfortably extinct - the summit crater vents in cold weather.',
        'Built of its own debris, and steep enough that the debris keeps moving.',
      ]),
    );
  } else if (m > 6000) {
    parts.push(
      r.pick([
        'One of the great summits, high enough that the weather at the top has little to do with the weather at the bottom.',
        'A giant. The last two thousand metres are ice and the ice is moving.',
        'Visible from three hundred kilometres away on a clear day, which is not often.',
      ]),
    );
  } else if (m > 3200) {
    parts.push(
      r.pick([
        'A serious mountain with a permanent snowfield on the northern side.',
        'Steep, high and reliably unpleasant above the treeline.',
        'The summit ridge is exposed on both flanks and there is no easy line up it.',
      ]),
    );
  } else if (m > 1400) {
    parts.push(
      r.pick([
        'A high hill by any reasonable measure, and locally regarded as a mountain.',
        'Rounded, heather-covered and much larger than it looks from the valley.',
        'A long walk rather than a climb, but a long walk with real weather on it.',
      ]),
    );
  } else {
    parts.push(
      r.pick([
        'A prominent rise, conspicuous mainly because everything around it is flat.',
        'Low, but it is the highest thing for a long way and it is used as a mark.',
        'More of a landmark than a summit.',
      ]),
    );
  }

  if (prominenceKm > 1.5 && r.bool(0.7)) {
    parts.push('It stands well clear of everything around it.');
  } else if (prominenceKm < 0.35 && r.bool(0.6)) {
    parts.push('It is a subsidiary top rather than an independent peak.');
  }

  const facts = [
    `Summit ${formatNumber(m)} m`,
    `Prominence ${formatNumber(prominenceKm * 1000)} m`,
  ];
  if (rangeName) facts.push(`Part of ${rangeName}`);
  if (volcanic) facts.push('Volcanic');
  void name;
  return { description: parts.join(' '), facts };
}

export function describeRiver(
  lengthKm: number,
  dischargeKm2: number,
  terminus: string,
  mouthName: string | null,
  sourceName: string | null,
  ctx: LoreContext,
): { description: string; facts: string[] } {
  const r = ctx.rng;
  const parts: string[] = [];

  if (dischargeKm2 > 400_000) {
    parts.push(
      r.pick([
        'One of the great rivers. Its basin covers a substantial fraction of the continent it drains.',
        'Enormous, slow and braided for most of its lower course.',
        'Navigable for a very long way inland, which has determined the position of every city on it.',
      ]),
    );
  } else if (dischargeKm2 > 80_000) {
    parts.push(
      r.pick([
        'A major river, navigable in its lower reaches and bridged only where it has to be.',
        'Broad, steady and heavily used.',
        'Carries barge traffic, spring floods and a good deal of silt.',
      ]),
    );
  } else if (dischargeKm2 > 14_000) {
    parts.push(
      r.pick([
        'A working river: mills, weirs, and a towpath on the inside bank.',
        'Fordable in places, bridged in others, and prone to a violent spring.',
        'Cuts a well-defined valley and the road follows it.',
      ]),
    );
  } else {
    parts.push(
      r.pick([
        'A modest river, more of a beck for its upper half.',
        'Small, fast and clear, with a bed of loose stone.',
        'Little more than a stream except after rain, when it is briefly formidable.',
      ]),
    );
  }

  if (terminus === 'lake') parts.push('It drains into a lake rather than to the sea.');
  else if (terminus === 'sink') parts.push('It never reaches the sea - the lower course simply runs out into the ground.');

  const facts = [
    `Length ${formatNumber(lengthKm)} km`,
    `Drainage basin ${formatNumber(roundSignificant(dischargeKm2, 2))} km2`,
  ];
  if (sourceName) facts.push(`Rises in ${sourceName}`);
  if (mouthName) facts.push(`Enters ${mouthName}`);
  return { description: parts.join(' '), facts };
}

export function describeLake(
  areaKm2: number,
  maxDepthM: number,
  levelM: number,
  endorheic: boolean,
  ctx: LoreContext,
): { description: string; facts: string[] } {
  const r = ctx.rng;
  const parts: string[] = [];
  if (areaKm2 > 8000) {
    parts.push(r.pick([
      'An inland sea in everything but name, with its own weather and its own shipping.',
      'Large enough that you cannot see across it, and rough enough that people drown in it.',
    ]));
  } else if (areaKm2 > 700) {
    parts.push(r.pick([
      'A substantial lake with settlements on most of its shore.',
      'Deep, cold and fished commercially.',
    ]));
  } else {
    parts.push(r.pick([
      'A quiet upland water, reed-fringed at the shallow end.',
      'Small and clear, fed by snowmelt and losing most of it again in summer.',
      'Steep-sided and deeper than its size suggests.',
    ]));
  }
  if (endorheic) {
    parts.push('It has no outflow. What comes in leaves as vapour, and what the vapour leaves behind stays.');
  }
  const facts = [
    `Area ${formatNumber(roundSignificant(areaKm2, 3))} km2`,
    `Maximum depth ${formatNumber(maxDepthM)} m`,
    `Surface at ${formatNumber(levelM)} m`,
  ];
  if (endorheic) facts.push('Endorheic - no outflow, and saline');
  return { description: parts.join(' '), facts };
}

export function describeRange(
  areaKm2: number,
  highestKm: number,
  spanKm: number,
  ctx: LoreContext,
): { description: string; facts: string[] } {
  const r = ctx.rng;
  const parts: string[] = [];
  if (highestKm > 5.5) {
    parts.push(r.pick([
      'A first-order range. It divides climates, not just territories.',
      'High enough to have its own glaciation and to cast a rain shadow hundreds of kilometres long.',
    ]));
  } else if (highestKm > 3) {
    parts.push(r.pick([
      'A serious barrier, crossed at a handful of passes and avoided the rest of the year.',
      'Snow-capped for most of the year, with the treeline well down the flanks.',
    ]));
  } else {
    parts.push(r.pick([
      'Old, worn-down uplands - more of a long obstacle than a wall.',
      'Rounded summits, deep glens, and a good deal of standing water on the tops.',
    ]));
  }
  parts.push(r.pick([
    'The rivers on either side of it flow in opposite directions, which is the practical definition of a divide.',
    'Every road that crosses it does so unwillingly.',
    'The settlements sit in the valleys and the valleys do not connect.',
  ]));
  return {
    description: parts.join(' '),
    facts: [
      `Highest summit ${formatNumber(highestKm * 1000)} m`,
      `Extent about ${formatNumber(spanKm)} km`,
      `Upland area ${formatNumber(roundSignificant(areaKm2, 2))} km2`,
    ],
  };
}

export function describeIsland(
  areaKm2: number,
  highestKm: number,
  coastKm: number,
  populated: boolean,
  biomeId: number,
  ctx: LoreContext,
): { description: string; facts: string[] } {
  const r = ctx.rng;
  const b = BIOME_BY_ID[biomeId];
  const parts: string[] = [];
  if (areaKm2 > 60_000) {
    parts.push('Large enough to have an interior, and an interior climate to go with it.');
  } else if (areaKm2 > 2000) {
    parts.push(r.pick([
      'A substantial island with a windward side and a leeward side that barely resemble each other.',
      'Big enough for rivers, and there are three of them.',
    ]));
  } else if (areaKm2 > 90) {
    parts.push(r.pick([
      'A single ridge of rock with a beach at one end.',
      'Steep-sided, flat-topped and grazed to the bone.',
      'Sheltered on the inner shore, and not on the outer one.',
    ]));
  } else {
    parts.push(r.pick([
      'Barely more than a rock, but it has a name and it is on the charts.',
      'Small, exposed, and covered in birds.',
      'A skerry rather than an island, awash in a heavy sea.',
    ]));
  }
  if (b && b.group === 'forest') parts.push('Wooded to the waterline.');
  else if (b && b.group === 'arid') parts.push('Dry, and dependent on what rain the winter brings.');
  else if (highestKm > 1.4) parts.push('Mountainous, with the summit usually in cloud.');
  parts.push(populated ? 'It is inhabited.' : 'Nobody lives there.');

  return {
    description: parts.join(' '),
    facts: [
      `Area ${formatNumber(roundSignificant(areaKm2, 3))} km2`,
      `Highest point ${formatNumber(highestKm * 1000)} m`,
      `Coastline about ${formatNumber(roundSignificant(coastKm, 2))} km`,
      populated ? 'Inhabited' : 'Uninhabited',
    ],
  };
}

export function describeRegion(region: RegionInfo, culture: CultureInfo, ctx: LoreContext, capitalName: string | null): string {
  const r = ctx.rng;
  const b = BIOME_BY_ID[region.dominantBiome];
  const parts: string[] = [];
  parts.push(
    r.pick([
      `${region.name} is ${b ? 'largely ' + b.name.toLowerCase() : 'mixed country'}, and its politics follow its drainage.`,
      `Predominantly ${b ? b.name.toLowerCase() : 'mixed country'}. The borders sit on the watersheds, as they generally do.`,
      `${b ? capitaliseFirst(b.name) : 'Mixed country'} across most of its extent, with the population concentrated where the water is.`,
    ]),
  );
  if (capitalName) parts.push(`Administered from ${capitalName}.`);
  parts.push(
    r.pick([
      `Its people are ${culture.adjective}. ${culture.description}`,
      `${culture.adjective} in language and in building. ${culture.description}`,
    ]),
  );
  const t = ctx.temperature(region.cx, region.cz);
  const m = ctx.moisture(region.cx, region.cz);
  parts.push(`The climate is ${climateLabel(t, m)}, with roughly ${formatNumber(rainfallMm(m))} mm of rain a year.`);
  return parts.join(' ');
}

export function describeContinent(name: string, areaKm2: number, highestKm: number, regionCount: number, population: number, ctx: LoreContext): string {
  const r = ctx.rng;
  const scale = areaKm2 > 4_000_000 ? 'One of the great landmasses' : areaKm2 > 1_200_000 ? 'A full continent' : 'A subcontinent';
  return [
    `${scale}, ${formatNumber(roundSignificant(areaKm2, 3))} square kilometres of it.`,
    r.pick([
      'Its interior is a long way from any coast, and it behaves like it.',
      'The coast is where nearly everyone lives, and the interior is where nearly everything is.',
      'It is crossed by one range and drained by two river systems, and that fact explains most of its history.',
    ]),
    `${regionCount} region${regionCount === 1 ? '' : 's'}, and something in the order of ${formatPopulation(population)} people.`,
    `The highest ground on ${name} reaches ${formatNumber(highestKm * 1000)} m.`,
  ].join(' ');
}

// --- Landmarks ----------------------------------------------------------------

const LANDMARK_LINES: Partial<Record<string, string[]>> = {
  castle: [
    'A curtain wall, a keep and a gatehouse that has been rebuilt at least twice.',
    'Still garrisoned, still leaking, and still the largest building for fifty kilometres.',
    'Built to hold a valley, and it does, in the sense that nothing has taken it.',
  ],
  fortress: [
    'Purpose-built to close a route, with fields of fire that make the intent obvious.',
    'Low, thick and unlovely. Everything about it is about angles of approach.',
    'A garrison fort with cisterns for a year and magazines for rather less.',
  ],
  watchtower: [
    'One of a chain. From the top you can see the next two.',
    'A single stone tower with a beacon basket on the roof and no door at ground level.',
    'Manned in season, and used by shepherds out of it.',
  ],
  tower: [
    'Nobody has satisfactorily explained who built it or why it is here.',
    'A tower on its own, with no wall, no well and no road to it.',
    'Older than the settlements around it, and made of stone that does not occur locally.',
  ],
  temple: [
    'Colonnaded, oriented and maintained by an endowment that has outlasted three governments.',
    'The precinct is larger than the sanctuary, and the market outside is larger than both.',
    'A working temple with a resident order and a great deal of accumulated silver.',
  ],
  monastery: [
    'Remote by design. The library is the reason anyone makes the journey.',
    'Self-sufficient in food, water and argument.',
    'Reached by a stair cut into the rock, and closed by snow for four months.',
  ],
  shrine: [
    'A roadside shrine, kept clean by whoever passes.',
    'A niche, a figure and a shelf of small offerings.',
    'Marks the spot where the road becomes safe, or stops being safe, depending on direction.',
  ],
  observatory: [
    'Sited high and dry for the seeing. The instruments are better than the building.',
    'A meridian circle, a long roof that opens, and two hundred years of records.',
    'The air is thin, the nights are clear, and there is nothing else here at all.',
  ],
  mine: [
    'Adits, spoil and a horse-whim over the main shaft.',
    'Worked out at the upper levels and still productive below the water table, which is the problem.',
    'The workings go a long way in and the maps of them are not complete.',
  ],
  quarry: [
    'Cut into the hillside in benches. Half the district is built out of it.',
    'A working face, a crane and a great deal of waste stone.',
  ],
  ruin: [
    'Foundations, a few standing courses, and a plan you can still read from the air.',
    'Substantial enough that people have stopped pretending it was a farm.',
    'Overgrown, robbed for building stone, and older than the local records go.',
    'Whatever happened here, it happened quickly - the ovens were still full.',
  ],
  monument: [
    'Raised to commemorate something the inscription no longer makes clear.',
    'A column on a plinth, visible from the road for a long way in both directions.',
  ],
  standing_stones: [
    'A ring, an avenue and two outliers, aligned on something that no longer rises where it did.',
    'Set upright by people who left nothing else at all.',
  ],
  tomb: [
    'A chambered mound with a stone-lined passage, robbed at least once.',
    'Cut into the hillside, sealed, and then unsealed by someone in a hurry.',
  ],
  battlefield: [
    'Open ground, a stream, and a low ridge - which is to say, exactly the sort of place armies choose.',
    'The ploughing still turns up metal.',
  ],
  cave: [
    'A wide entrance, a narrow continuation, and a draught that suggests a long way further.',
    'Surveyed for two kilometres. Not surveyed beyond that.',
    'Dry, high-roofed, and used as a shelter for as long as anyone has been here.',
  ],
  waterfall: [
    'The whole river goes over in one drop, into a plunge pool of unknown depth.',
    'Three falls in quick succession, with a path behind the second.',
    'Loud enough to be heard before it is seen, and frozen solid for part of the winter.',
  ],
  lighthouse: [
    'Marks the reef. It has been rebuilt after the reef proved the point.',
    'A tower, a keeper and a light visible for thirty kilometres.',
  ],
  port: [
    'Deep-water berths, a customs house and a mole that took forty years to finish.',
    'A working port: cranes, warehouses and a permanent smell of tar.',
  ],
  bridge: [
    'A multi-span stone bridge with cutwaters, and a chapel at the midpoint.',
    'The only crossing for a considerable distance, and tolled accordingly.',
    'Rebuilt in stone after the timber one was taken by a flood.',
  ],
  oasis: [
    'Springs, palms and enough shade to matter. The wells are the whole point.',
    'A single deep spring feeding a grove, and a very old set of rules about who draws when.',
  ],
  caravanserai: [
    'A walled courtyard with stalls on three sides and a cistern in the middle.',
    'One day’s march from the last one and one from the next, which is the entire design brief.',
  ],
  windmill: ['A tower mill on the exposed shoulder of the hill, working whenever the wind allows.'],
  watermill: ['An undershot wheel, a millpond and a leat that is somebody’s full-time job.'],
  sawmill: ['A water-driven frame saw, a log pond and a great deal of sawdust.'],
  farm: ['A steading, a yard and the field system that goes with it.'],
  ranch: ['Open grazing, a home paddock and a very long ride to the boundary.'],
  vineyard: ['Terraced rows on a sun-facing slope, with dry-stone walls holding the soil on.'],
  inn: ['Stabling for twenty, beds for rather fewer, and a reputation that varies by season.'],
  cabin: ['One room, a stove and a woodpile. It is left unlocked on purpose.'],
  camp: ['A seasonal camp - stone rings, a windbreak and old ash.'],
  outpost: ['A palisade, a well and a flag. The nearest relief is a long way off.'],
  shipwreck: ['Ribs and a stub of mast showing at low water. She went on in fog.'],
  reef: ['Shallow coral, breaking in any swell, and marked on charts with more emphasis than usual.'],
  geyser: ['Erupts on a rough schedule to about twenty metres, and the ground around it is warm.'],
  crater: ['A circular depression with a raised rim and a small lake in the middle.'],
  arch: ['A natural span of sandstone, and the reason a road bends fifteen kilometres out of its way.'],
  sinkhole: ['A vertical shaft in the limestone, opening into something with a river in it.'],
  spring: ['Cold, constant and considered medicinal, on no particular evidence.'],
  grove: ['A stand of old trees kept for reasons nobody will state plainly.'],
  quarrySite: ['Benches, waste heaps and a crane.'],
  saltworks: ['Evaporation pans, rakes and a great deal of glare.'],
  ferry: ['A cable ferry where the road meets the river. It runs when the ferryman is there.'],
  pass: ['The road over the top is open perhaps eight months of the year, and cairned for the rest.'],
  cliff: ['A vertical face with a seabird colony on the ledges and a fulmar problem at the top.'],
  canyon: ['Sheer walls, a river a long way down, and no way across for a considerable distance.'],
  plateau: ['A flat, high, exposed tableland with the drainage cut deep into it.'],
  valley: ['A broad glaciated trough with a flat floor and a river wandering across it.'],
  glacier: ['A dirty white tongue of ice with a terminal moraine and a milky meltwater stream.'],
  dunes: ['Transverse dunes in ranks, moving slowly downwind, burying whatever does not move.'],
  marsh: ['Reed beds, sedge and open water in about equal measure, and no dry route across.'],
  cape: ['A headland with a tide race off the end of it that has to be respected.'],
  volcano: ['An active cone with a summit crater, a sulphur smell and a nervous local population.'],
  monastery2: [],
};

export function describeLandmark(kind: string, ctx: LoreContext, elevationM: number, regionName: string | null): { description: string; facts: string[] } {
  const r = ctx.rng;
  const lines = LANDMARK_LINES[kind];
  const description = lines && lines.length ? r.pick(lines) : 'Marked on the survey, and not much visited.';
  const facts: string[] = [];
  facts.push(`Elevation ${formatNumber(elevationM)} m`);
  if (regionName) facts.push(`In ${regionName}`);
  return { description, facts };
}

function capitaliseFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Simple label for the biome group, used in one-line summaries. */
export function terrainWord(biomeId: number): string {
  const b = BIOME_BY_ID[biomeId];
  if (!b) return 'unknown ground';
  if (b.id === Biome.DuneSea) return 'sand sea';
  return b.name.toLowerCase();
}
