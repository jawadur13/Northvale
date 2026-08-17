/**
 * Toponymy.
 *
 * A world with four thousand labelled places cannot have four thousand
 * hand-written names, but it must not read as though it has none. Two mechanisms
 * do the work:
 *
 *  1. **Cultures.** Each region belongs to a culture with its own syllable
 *     inventory and name shapes, so Skarn settlements sound Skarn and Sahvari
 *     settlements sound Sahvari - and neighbouring regions therefore feel
 *     related rather than randomly sampled.
 *  2. **Compound toponyms.** The atlas's own language builds names the way real
 *     English map names are built: a qualifier plus a landscape element
 *     (Blackfen, Coldharbour, Ravencrag). The element vocabulary is real
 *     topographic vocabulary, which is why the results read as places.
 *
 * A registry enforces uniqueness, falling back to genuine cartographic
 * disambiguators - Upper, Nether, Little, New - rather than numeric suffixes.
 */

import { Rng } from '../../util/rng';
import type { CultureInfo } from '../types';

export interface Phonology {
  onsets: string[];
  nuclei: string[];
  codas: string[];
  /** Word-final flourishes appended to a stem. */
  endings: string[];
  /** Optional honorific prefixes, e.g. 'Al-' for Sahvari. */
  prefixes: string[];
  /** Probability of using a prefix. */
  prefixChance: number;
  /** Preferred syllable count distribution. */
  syllables: [number, number][];
}

export const CULTURES: Array<Omit<CultureInfo, 'id'> & { phon: Phonology }> = [
  {
    name: 'Valen',
    adjective: 'Valen',
    architecture: 'marble',
    roofColor: 0xb8b0a4,
    wallColor: 0xe4ddcf,
    description:
      'An old republic of pale stone, aqueducts and colonnades. Valen cities are laid out on a grid whether the ground allows it or not.',
    phon: {
      onsets: ['V', 'C', 'S', 'T', 'M', 'L', 'R', 'Ver', 'Cor', 'Sal', 'Tal', 'Mar', 'Lu', 'Ost', 'Aur', 'Pell'],
      nuclei: ['a', 'e', 'i', 'o', 'au', 'ae', 'ia'],
      codas: ['l', 'r', 'n', 's', 'ss', 'th', 'v', 'm'],
      endings: ['on', 'eth', 'ia', 'us', 'ar', 'is', 'ora', 'ene', 'antis', 'ium'],
      prefixes: [],
      prefixChance: 0,
      syllables: [
        [2, 5],
        [3, 4],
      ],
    },
  },
  {
    name: 'Harrow',
    adjective: 'Harrow',
    architecture: 'timber',
    roofColor: 0x6b4a34,
    wallColor: 0xcbbfa6,
    description:
      'Farmers, millers and drovers. Harrow country is hedges, weirs and market towns a day apart, and its names say exactly what a place is.',
    phon: {
      onsets: ['H', 'B', 'W', 'Br', 'Th', 'Sh', 'Cr', 'D', 'G', 'K', 'Wr', 'Fl', 'St'],
      nuclei: ['a', 'e', 'i', 'o', 'u', 'ea', 'ou'],
      codas: ['ll', 'rn', 'sh', 'th', 'ck', 'nd', 'rt', 'ld'],
      endings: ['by', 'ham', 'wick', 'ton', 'stead', 'thorpe', 'well', 'field'],
      prefixes: [],
      prefixChance: 0,
      syllables: [
        [2, 6],
        [1, 2],
      ],
    },
  },
  {
    name: 'Skarn',
    adjective: 'Skarn',
    architecture: 'nordic',
    roofColor: 0x3c4247,
    wallColor: 0x8a7a63,
    description:
      'Highlanders and whalers. Skarn halls are built low against the wind with turf on the roof and the door facing away from the sea.',
    phon: {
      onsets: ['Sk', 'Bj', 'Hj', 'V', 'Th', 'Gr', 'Hr', 'Kn', 'Sn', 'Fr', 'Dr', 'Ulf', 'Sv'],
      nuclei: ['a', 'o', 'e', 'i', 'ja', 'au', 'y'],
      codas: ['rn', 'lk', 'rd', 'ng', 'st', 'kk', 'rr', 'ff'],
      endings: ['hold', 'dal', 'vik', 'nes', 'fjell', 'mark', 'rek', 'garth', 'skar'],
      prefixes: [],
      prefixChance: 0,
      syllables: [
        [2, 6],
        [3, 2],
      ],
    },
  },
  {
    name: 'Sahvari',
    adjective: 'Sahvari',
    architecture: 'adobe',
    roofColor: 0xc7a173,
    wallColor: 0xdcc39a,
    description:
      'Caravaners and hydrologists. Every Sahvari settlement is an argument with the desert about water, and the argument is usually won underground.',
    phon: {
      onsets: ['Z', 'Q', 'Kh', 'S', 'T', 'N', 'R', 'Sh', 'M', 'Dh', 'Th', 'H', 'Am', 'Ir'],
      nuclei: ['a', 'i', 'u', 'aa', 'ai', 'ee'],
      codas: ['r', 'm', 'n', 'kh', 'sh', 'z', 'd', 'th'],
      endings: ['im', 'ar', 'et', 'un', 'ir', 'akh', 'ash', 'ud', 'ain'],
      prefixes: ['Al-', 'El-', 'Um-', 'Beit-'],
      prefixChance: 0.26,
      syllables: [
        [2, 5],
        [3, 4],
      ],
    },
  },
  {
    name: 'Tolm',
    adjective: 'Tolmeri',
    architecture: 'reed',
    roofColor: 0x8e7a4a,
    wallColor: 0xb9a67c,
    description:
      'River people. Tolmeri towns are built on piles above the flood line and connected by causeway rather than by road.',
    phon: {
      onsets: ['T', 'K', 'Nj', 'S', 'L', 'M', 'B', 'Ndi', 'Ka', 'Se', 'Ta', 'Wo'],
      nuclei: ['a', 'i', 'u', 'e', 'ua', 'ia', 'oa'],
      codas: ['m', 'n', 'ng', 'l', 'v', 'j'],
      endings: ['vi', 'bai', 'reth', 'mba', 'lu', 'noa', 'ka', 'siwa'],
      prefixes: [],
      prefixChance: 0,
      syllables: [
        [3, 5],
        [2, 3],
      ],
    },
  },
  {
    name: 'Kethic',
    adjective: 'Kethic',
    architecture: 'terrace',
    roofColor: 0x7d5c4a,
    wallColor: 0xd2c4ab,
    description:
      'Terrace farmers of the southern uplands, who moved more stone building their fields than their cities.',
    phon: {
      onsets: ['K', 'Ond', 'Il', 'S', 'V', 'Dr', 'Ar', 'Th', 'Ph', 'Ny', 'Er'],
      nuclei: ['e', 'a', 'u', 'o', 'ai', 'ei'],
      codas: ['th', 'r', 'n', 'l', 'sk', 'v', 'm'],
      endings: ['run', 'vere', 'uma', 'aden', 'oss', 'ith', 'ael', 'ora'],
      prefixes: [],
      prefixChance: 0,
      syllables: [
        [2, 4],
        [3, 5],
      ],
    },
  },
  {
    name: 'Ossuran',
    adjective: 'Ossuran',
    architecture: 'stone',
    roofColor: 0x4a4a4f,
    wallColor: 0x9a938a,
    description:
      'Miners and stonecutters who build nothing they do not expect to outlive them. Ossuran towns have no wooden buildings at all.',
    phon: {
      onsets: ['Gr', 'Kr', 'Ith', 'Oss', 'D', 'M', 'B', 'Tr', 'Vr', 'Kh', 'Zh'],
      nuclei: ['e', 'a', 'o', 'u', 'i'],
      codas: ['rn', 'rk', 'st', 'ld', 'sk', 'th', 'gr'],
      endings: ['mark', 'kar', 'grath', 'un', 'ost', 'ker', 'dun', 'orn'],
      prefixes: [],
      prefixChance: 0,
      syllables: [
        [2, 6],
        [3, 3],
      ],
    },
  },
];

// --- Compound toponym vocabulary ----------------------------------------------

/** Qualifiers. Deliberately drawn from real English toponymic stock. */
const QUALIFIERS = [
  'Ash', 'Alder', 'Amber', 'Barrow', 'Bitter', 'Black', 'Bramble', 'Bright', 'Broad', 'Cinder',
  'Clay', 'Cold', 'Copper', 'Crooked', 'Dark', 'Deep', 'Dun', 'Dusk', 'Elder', 'Ember',
  'Fair', 'Far', 'Fern', 'Flint', 'Frost', 'Gall', 'Glass', 'Gold', 'Green', 'Grey',
  'Grim', 'Hart', 'Hazel', 'Heather', 'High', 'Hollow', 'Iron', 'Kestrel', 'Lark', 'Loam',
  'Long', 'Low', 'Marl', 'Moss', 'Nettle', 'North', 'Oaken', 'Old', 'Otter', 'Pale',
  'Quarry', 'Raven', 'Red', 'Rook', 'Rush', 'Sable', 'Sallow', 'Salt', 'Sedge', 'Shadow',
  'Shale', 'Sharp', 'Silver', 'Slate', 'Sleet', 'Sorrow', 'South', 'Still', 'Stone', 'Storm',
  'Tallow', 'Tar', 'Thorn', 'Three', 'Wan', 'Weir', 'Whin', 'White', 'Wild', 'Wind',
  'Winter', 'Wolf', 'Yew', 'Bell', 'Corn', 'Crow', 'Fallow', 'Harrow', 'Hind', 'Kiln',
  'Lime', 'Mire', 'Peat', 'Pike', 'Rye', 'Sparrow', 'Tern', 'Willow', 'Bracken', 'Gorse',
];

/** Habitative elements - the second half of a settlement name. */
const SETTLEMENT_ELEMENTS = [
  'bury', 'by', 'caster', 'cote', 'croft', 'don', 'field', 'ford', 'gate', 'garth',
  'hall', 'ham', 'haven', 'hithe', 'holt', 'hope', 'keep', 'lea', 'mill', 'moor',
  'mouth', 'ness', 'port', 'reach', 'rest', 'ridge', 'row', 'shaw', 'stead', 'stoke',
  'ton', 'vale', 'wall', 'watch', 'well', 'wick', 'worth', 'thorpe', 'stow', 'combe',
  'dale', 'holm', 'burn', 'brook', 'bourne', 'march', 'cross', 'bridge', 'quay', 'strand',
  'barrow', 'cairn', 'fell', 'gill', 'wold', 'warren', 'mote', 'knap', 'scar', 'spire',
];

/** Free-standing topographic nouns, used for natural features and "The X" forms. */
const RELIEF_NOUNS = ['Crag', 'Tor', 'Pike', 'Fell', 'Scar', 'Horn', 'Brow', 'Rise', 'Cap', 'Head', 'Spire', 'Fang', 'Tooth', 'Throne', 'Anvil', 'Beacon', 'Shoulder', 'Knuckle', 'Wedge', 'Cleaver'];
const RANGE_NOUNS = ['Range', 'Mountains', 'Spine', 'Teeth', 'Wall', 'Barrier', 'Reach', 'Fells', 'Heights', 'Ridge', 'Crown', 'Rampart', 'Divide', 'Backbone', 'Comb'];
const WATER_NOUNS = ['water', 'burn', 'brook', 'bourne', 'beck', 'run', 'race', 'flow', 'rill', 'dyke'];
const RIVER_NOUNS = ['Water', 'River', 'Flood', 'Race', 'Run', 'Course', 'Draught'];
const LAKE_NOUNS = ['mere', 'tarn', 'water', 'pool', 'loch', 'lough', 'flash', 'broad'];
const FOREST_NOUNS = ['wood', 'holt', 'shaw', 'weald', 'hurst', 'chase', 'frith', 'brake', 'copse', 'spinney'];
const FOREST_BIG = ['Forest', 'Wood', 'Weald', 'Wildwood', 'Greatwood', 'Timberland', 'Reach'];
const ISLAND_NOUNS = ['Isle', 'Holm', 'Ait', 'Eyot', 'Skerry', 'Rock', 'Stack', 'Key', 'Cay'];
const WETLAND_NOUNS = ['Fen', 'Mire', 'Marsh', 'Slough', 'Carr', 'Moss', 'Flow', 'Wash', 'Slake', 'Bog'];
const VALLEY_NOUNS = ['Vale', 'Dale', 'Combe', 'Hollow', 'Bottom', 'Gill', 'Chine', 'Glen', 'Cleave', 'Trough'];
const DESERT_NOUNS = ['Waste', 'Sands', 'Barrens', 'Erg', 'Pan', 'Reg', 'Flats', 'Expanse', 'Emptiness'];
const PLATEAU_NOUNS = ['Plateau', 'Tableland', 'Mesa', 'Shelf', 'Bench', 'Steppe', 'Upland', 'Terrace'];
const PASS_NOUNS = ['Pass', 'Gap', 'Saddle', 'Notch', 'Col', 'Gate', 'Neck', 'Stair', 'Breach'];
const CLIFF_NOUNS = ['Cliffs', 'Bluffs', 'Palisades', 'Scarp', 'Face', 'Drop', 'Precipice', 'Fall'];
const GLACIER_NOUNS = ['Glacier', 'Icefall', 'Snowfield', 'Ice', 'Tongue', 'Sheet'];
const CAPE_NOUNS = ['Cape', 'Point', 'Head', 'Ness', 'Foreland', 'Horn', 'Spit', 'Bill'];
const CANYON_NOUNS = ['Canyon', 'Gorge', 'Chasm', 'Cleft', 'Gully', 'Rift', 'Cut', 'Narrows'];

/** Poetic epithets for "The X of Y" constructions and for anomalies. */
const ABSTRACTS = [
  'Sorrow', 'Silence', 'Patience', 'Rumour', 'Reckoning', 'Consequence', 'Departure', 'Small Mercies',
  'Long Waiting', 'Unfinished Business', 'Second Thoughts', 'Better Judgement', 'Last Resort',
  'Rising Doubt', 'Quiet Argument', 'No Return', 'Late Arrival', 'Fair Warning', 'Old Debts',
];

const SAINTS = [
  'Aldreth', 'Bevan', 'Cordelia', 'Dorun', 'Elsemere', 'Fennick', 'Gethin', 'Halvard', 'Ivorel',
  'Joss', 'Kelwyn', 'Lorel', 'Merrow', 'Nessa', 'Orrin', 'Pellam', 'Quillon', 'Rowan', 'Sable',
  'Tarrow', 'Ulric', 'Verity', 'Wend', 'Yarrow', 'Ansel', 'Brida', 'Corvin', 'Delwyn',
];

// --- Generator ----------------------------------------------------------------

export class NameForge {
  private used = new Set<string>();
  private rng: Rng;

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  /** Builds a culture-flavoured stem from the culture's syllable inventory. */
  private stem(phon: Phonology): string {
    const r = this.rng;
    const count = r.weighted(phon.syllables);
    let s = '';
    for (let i = 0; i < count; i++) {
      const onset = i === 0 ? r.pick(phon.onsets) : r.pick(phon.onsets).toLowerCase();
      s += onset + r.pick(phon.nuclei);
      // Codas only mid-word, so the ending attaches cleanly.
      if (i < count - 1 && r.bool(0.45)) s += r.pick(phon.codas);
    }
    return s;
  }

  /** A full culture-native proper name. */
  native(cultureId: number): string {
    const c = CULTURES[cultureId % CULTURES.length];
    const r = this.rng;
    let s = this.stem(c.phon);
    if (r.bool(0.72)) s += r.pick(c.phon.endings);
    if (c.phon.prefixes.length && r.bool(c.phon.prefixChance)) s = r.pick(c.phon.prefixes) + s;
    // Tidy up the seams the syllable machine leaves behind.
    return tidy(s);
  }

  /** Qualifier + element compound, e.g. Blackfen, Ravenscross. */
  compound(elements: string[]): string {
    const r = this.rng;
    const q = r.pick(QUALIFIERS);
    let e = r.pick(elements);
    // Genitive linking -s reads more naturally on some pairings.
    if (r.bool(0.12) && !q.endsWith('s')) return tidy(`${q}s${e}`);
    if (r.bool(0.1)) return tidy(`${q} ${capitalise(e)}`);
    return tidy(q + e);
  }

  /** "The <Qualifier> <Noun>" form. */
  theForm(nouns: string[]): string {
    const r = this.rng;
    return `The ${r.pick(QUALIFIERS)} ${r.pick(nouns)}`;
  }

  /** "<Noun> of <Abstract>" form, used sparingly for the strangest places. */
  ofForm(nouns: string[]): string {
    const r = this.rng;
    return `${r.pick(nouns)} of ${r.pick(ABSTRACTS)}`;
  }

  saint(): string {
    return this.rng.pick(SAINTS);
  }

  // --- Type-specific entry points ------------------------------------------

  settlement(cultureId: number, size: 'capital' | 'city' | 'town' | 'village' | 'hamlet'): string {
    const r = this.rng;
    const nativeChance = size === 'capital' || size === 'city' ? 0.62 : size === 'town' ? 0.46 : 0.3;
    const make = () => {
      if (r.bool(nativeChance)) {
        const base = this.native(cultureId);
        if (size === 'capital' && r.bool(0.22)) return `${base} ${r.pick(['Prime', 'Major', 'the Elder'])}`;
        return base;
      }
      if (r.bool(0.08)) return `${r.pick(['Saint', 'St.'])} ${this.saint()}`;
      return this.compound(SETTLEMENT_ELEMENTS);
    };
    return this.unique(make, size === 'village' || size === 'hamlet');
  }

  peak(cultureId: number, volcanic: boolean): string {
    const r = this.rng;
    const make = () => {
      const roll = r.next();
      if (roll < 0.26) return `Mount ${this.native(cultureId)}`;
      if (roll < 0.44) return this.compound(RELIEF_NOUNS.map((n) => n.toLowerCase()));
      if (roll < 0.6) return this.theForm(RELIEF_NOUNS);
      if (roll < 0.74) return `${this.native(cultureId)} ${r.pick(RELIEF_NOUNS)}`;
      if (roll < 0.86) return `${r.pick(QUALIFIERS)} ${r.pick(RELIEF_NOUNS)}`;
      if (volcanic && roll < 0.94) return `${r.pick(['Cinder', 'Ash', 'Smoke', 'Ember', 'Kiln'])}${r.pick(['cone', 'crown', 'horn', 'mount'])}`;
      return this.compound(RELIEF_NOUNS.map((n) => n.toLowerCase()));
    };
    return this.unique(make, false);
  }

  range(cultureId: number): string {
    const r = this.rng;
    return this.unique(() => {
      const roll = r.next();
      if (roll < 0.34) return `The ${this.native(cultureId)} ${r.pick(RANGE_NOUNS)}`;
      if (roll < 0.58) return `The ${r.pick(QUALIFIERS)} ${r.pick(RANGE_NOUNS)}`;
      if (roll < 0.78) return `${this.native(cultureId)} ${r.pick(RANGE_NOUNS)}`;
      return `The ${r.pick(RANGE_NOUNS)} of ${r.pick(ABSTRACTS)}`;
    }, false);
  }

  river(cultureId: number, major: boolean): string {
    const r = this.rng;
    return this.unique(() => {
      const roll = r.next();
      if (major && roll < 0.3) return `The ${this.native(cultureId)}`;
      if (roll < 0.5) return this.compound(WATER_NOUNS);
      if (roll < 0.68) return `The ${r.pick(QUALIFIERS)} ${r.pick(RIVER_NOUNS)}`;
      if (roll < 0.84) return `${this.native(cultureId)} ${r.pick(RIVER_NOUNS)}`;
      return this.compound(WATER_NOUNS);
    }, !major);
  }

  lake(cultureId: number, big: boolean): string {
    const r = this.rng;
    return this.unique(() => {
      const roll = r.next();
      if (big && roll < 0.32) return `Lake ${this.native(cultureId)}`;
      if (roll < 0.56) return this.compound(LAKE_NOUNS);
      if (roll < 0.72) return `${this.native(cultureId)} ${r.pick(['Mere', 'Tarn', 'Water', 'Pool'])}`;
      return this.theForm(['Mere', 'Tarn', 'Pool', 'Mirror', 'Eye', 'Basin', 'Cup']);
    }, !big);
  }

  forest(cultureId: number, big: boolean): string {
    const r = this.rng;
    return this.unique(() => {
      const roll = r.next();
      if (big && roll < 0.3) return `The ${this.native(cultureId)} ${r.pick(FOREST_BIG)}`;
      if (roll < 0.54) return this.compound(FOREST_NOUNS);
      if (roll < 0.72) return `The ${r.pick(QUALIFIERS)} ${r.pick(FOREST_BIG)}`;
      return `${this.native(cultureId)} ${r.pick(FOREST_BIG)}`;
    }, !big);
  }

  island(cultureId: number, big: boolean): string {
    const r = this.rng;
    return this.unique(() => {
      const roll = r.next();
      if (big && roll < 0.36) return this.native(cultureId);
      if (roll < 0.54) return `${r.pick(QUALIFIERS)} ${r.pick(ISLAND_NOUNS)}`;
      if (roll < 0.7) return this.compound(ISLAND_NOUNS.map((n) => n.toLowerCase()));
      if (roll < 0.84) return `${this.native(cultureId)} ${r.pick(ISLAND_NOUNS)}`;
      return this.theForm(['Skerries', 'Stacks', 'Rocks', 'Teeth', 'Sisters', 'Brothers', 'Hands']);
    }, !big);
  }

  archipelago(cultureId: number): string {
    const r = this.rng;
    return this.unique(() => {
      const roll = r.next();
      if (roll < 0.4) return `The ${this.native(cultureId)} ${r.pick(['Isles', 'Islands', 'Archipelago', 'Chain', 'Scatter'])}`;
      if (roll < 0.7) return `The ${r.pick(QUALIFIERS)} ${r.pick(['Isles', 'Islands', 'Chain', 'Scatter', 'Ring'])}`;
      return `${r.pick(['Isles', 'Islands'])} of ${r.pick(ABSTRACTS)}`;
    }, false);
  }

  region(cultureId: number): string {
    const r = this.rng;
    return this.unique(() => {
      const roll = r.next();
      const suffix = r.pick(['march', 'reach', 'shire', 'weald', 'holt', 'moor', 'wold', 'fold', 'ward', 'downs', 'gates', 'wastes', 'coast', 'vale', 'heath']);
      if (roll < 0.32) return `The ${capitalise(this.native(cultureId))} ${capitalise(suffix)}`;
      if (roll < 0.56) return tidy(r.pick(QUALIFIERS) + suffix);
      if (roll < 0.76) return this.native(cultureId);
      return `The ${r.pick(QUALIFIERS)} ${capitalise(suffix)}`;
    }, false);
  }

  landmark(kind: string, cultureId: number): string {
    const r = this.rng;
    const make = (): string => {
      switch (kind) {
        case 'castle':
        case 'fortress':
          return r.bool(0.5)
            ? `${this.native(cultureId)} ${r.pick(['Keep', 'Castle', 'Hold', 'Bastion', 'Citadel', 'Redoubt'])}`
            : this.compound(['keep', 'hold', 'guard', 'wall', 'gate', 'watch', 'bastion']);
        case 'watchtower':
        case 'tower':
          return r.bool(0.45)
            ? `The ${r.pick(QUALIFIERS)} ${r.pick(['Tower', 'Spire', 'Watch', 'Beacon', 'Finger', 'Needle'])}`
            : `${this.native(cultureId)} ${r.pick(['Tower', 'Watch', 'Beacon'])}`;
        case 'temple':
        case 'shrine':
          return r.bool(0.5)
            ? `${r.pick(['Temple', 'Shrine', 'Sanctum', 'Chapel', 'Oratory'])} of ${r.bool(0.5) ? this.saint() : r.pick(ABSTRACTS)}`
            : `${this.native(cultureId)} ${r.pick(['Temple', 'Shrine', 'Sanctum'])}`;
        case 'monastery':
          return r.bool(0.55)
            ? `${r.pick(['Abbey', 'Priory', 'Cloister', 'Charterhouse'])} of ${this.saint()}`
            : this.compound(['abbey', 'minster', 'cloister']);
        case 'observatory':
          return `${r.pick(['The', 'Old'])} ${r.pick(QUALIFIERS)} Observatory`;
        case 'library':
          return `${r.pick(['Archive', 'Library', 'Repository', 'Scriptorium'])} of ${this.native(cultureId)}`;
        case 'mine':
          return r.bool(0.5)
            ? `${this.compound(['delve', 'shaft', 'pit', 'seam', 'lode', 'cut'])}`
            : `${this.native(cultureId)} ${r.pick(['Mine', 'Delve', 'Workings', 'Deeps'])}`;
        case 'quarry':
          return `${r.pick(QUALIFIERS)} ${r.pick(['Quarry', 'Cut', 'Pit', 'Diggings'])}`;
        case 'ruin':
          return r.bool(0.45)
            ? `Ruins of ${this.native(cultureId)}`
            : r.bool(0.5)
              ? `The ${r.pick(QUALIFIERS)} ${r.pick(['Ruin', 'Remnant', 'Shell', 'Husk', 'Stones', 'Foundation'])}`
              : `Old ${this.native(cultureId)}`;
        case 'monument':
        case 'standing_stones':
          return r.bool(0.5)
            ? `The ${r.pick(['Standing', 'Nine', 'Seven', 'Twelve', 'Grey', 'Weeping', 'Watching'])} ${r.pick(['Stones', 'Sisters', 'Sentinels', 'Kings', 'Pillars', 'Wardens'])}`
            : `${r.pick(QUALIFIERS)} ${r.pick(['Monument', 'Column', 'Obelisk', 'Cairn', 'Menhir'])}`;
        case 'tomb':
          return `${r.pick(['Tomb', 'Barrow', 'Cairn', 'Mausoleum', 'Crypt'])} of ${this.native(cultureId)}`;
        case 'battlefield':
          return `Field of ${r.pick(ABSTRACTS)}`;
        case 'lighthouse':
          return `${r.pick(QUALIFIERS)} ${r.pick(['Light', 'Lamp', 'Beacon', 'Lighthouse'])}`;
        case 'port':
        case 'harbour':
          return this.compound(['haven', 'quay', 'wharf', 'landing', 'strand', 'roads', 'anchorage']);
        case 'bridge':
          return r.bool(0.5)
            ? `${r.pick(QUALIFIERS)} ${r.pick(['Bridge', 'Span', 'Crossing', 'Ford'])}`
            : `${this.native(cultureId)} Bridge`;
        case 'oasis':
          return r.bool(0.5)
            ? `${this.native(cultureId)} ${r.pick(['Oasis', 'Well', 'Spring', 'Waters'])}`
            : `The ${r.pick(QUALIFIERS)} ${r.pick(['Well', 'Spring', 'Pool'])}`;
        case 'caravanserai':
          return `${this.native(cultureId)} ${r.pick(['Caravanserai', 'Waystation', 'Rest', 'Halt'])}`;
        case 'cave':
          return r.bool(0.5)
            ? `${this.compound(['cave', 'hole', 'delve', 'grotto', 'maw'])}`
            : `The ${r.pick(QUALIFIERS)} ${r.pick(['Cave', 'Cavern', 'Grotto', 'Hollow', 'Throat', 'Maw'])}`;
        case 'waterfall':
          return r.bool(0.5)
            ? `${r.pick(QUALIFIERS)} ${r.pick(['Force', 'Falls', 'Leap', 'Spout', 'Veil', 'Stair'])}`
            : `The ${r.pick(['Bridal', 'Thundering', 'Silver', 'Weeping', 'Hundred', 'Broken'])} ${r.pick(['Falls', 'Veil', 'Stair', 'Fall'])}`;
        case 'pass':
          return r.bool(0.5)
            ? `${r.pick(QUALIFIERS)} ${r.pick(PASS_NOUNS)}`
            : `${this.native(cultureId)} ${r.pick(PASS_NOUNS)}`;
        case 'canyon':
          return `${r.pick(QUALIFIERS)} ${r.pick(CANYON_NOUNS)}`;
        case 'cliff':
          return `${r.pick(QUALIFIERS)} ${r.pick(CLIFF_NOUNS)}`;
        case 'plateau':
          return r.bool(0.5) ? `The ${r.pick(QUALIFIERS)} ${r.pick(PLATEAU_NOUNS)}` : `${this.native(cultureId)} ${r.pick(PLATEAU_NOUNS)}`;
        case 'valley':
          return r.bool(0.5) ? this.compound(VALLEY_NOUNS.map((v) => v.toLowerCase())) : `${r.pick(QUALIFIERS)} ${r.pick(VALLEY_NOUNS)}`;
        case 'glacier':
          return `${r.pick(QUALIFIERS)} ${r.pick(GLACIER_NOUNS)}`;
        case 'dunes':
          return r.bool(0.5) ? `The ${r.pick(QUALIFIERS)} ${r.pick(DESERT_NOUNS)}` : `${this.native(cultureId)} ${r.pick(DESERT_NOUNS)}`;
        case 'marsh':
          return r.bool(0.5) ? this.compound(WETLAND_NOUNS.map((w) => w.toLowerCase())) : `The ${r.pick(QUALIFIERS)} ${r.pick(WETLAND_NOUNS)}`;
        case 'cape':
          return `${r.pick(CAPE_NOUNS)} ${r.bool(0.5) ? this.native(cultureId) : r.pick(QUALIFIERS)}`;
        case 'volcano':
          return `${r.pick(['Mount', 'Cinder', 'Ash'])} ${this.native(cultureId)}`;
        case 'farm':
        case 'ranch':
        case 'vineyard':
          return this.compound(['croft', 'grange', 'holding', 'acres', 'furlong', 'meadows', 'pasture', 'garth']);
        case 'watermill':
        case 'windmill':
        case 'sawmill':
          return this.compound(['mill', 'wheel', 'race', 'weir']);
        case 'inn':
          return `The ${r.pick(QUALIFIERS)} ${r.pick(['Anchor', 'Bell', 'Crown', 'Hart', 'Horse', 'Lantern', 'Plough', 'Rest', 'Wheel', 'Kettle'])}`;
        case 'outpost':
        case 'camp':
          return `${r.pick(QUALIFIERS)} ${r.pick(['Post', 'Camp', 'Station', 'Picket', 'Muster'])}`;
        case 'cabin':
          return `${r.pick(QUALIFIERS)} ${r.pick(['Cabin', 'Hut', 'Lodge', 'Shelter', 'Bothy'])}`;
        case 'shipwreck':
          return `Wreck of the ${r.pick(QUALIFIERS)} ${r.pick(['Maiden', 'Fortune', 'Compass', 'Gull', 'Promise', 'Errand'])}`;
        case 'geyser':
        case 'spring':
          return `${r.pick(QUALIFIERS)} ${r.pick(['Spring', 'Geyser', 'Well', 'Vent', 'Bath'])}`;
        case 'crater':
          return `The ${r.pick(QUALIFIERS)} ${r.pick(['Crater', 'Basin', 'Bowl', 'Wound', 'Ring'])}`;
        case 'arch':
          return `The ${r.pick(QUALIFIERS)} ${r.pick(['Arch', 'Gate', 'Window', 'Eye', 'Hoop'])}`;
        case 'saltworks':
          return `${r.pick(QUALIFIERS)} ${r.pick(['Salterns', 'Pans', 'Saltworks', 'Flats'])}`;
        default:
          return this.compound(SETTLEMENT_ELEMENTS);
      }
    };
    return this.unique(make, true);
  }

  /** Ensures uniqueness, using real cartographic disambiguators when needed. */
  private unique(make: () => string, allowVariants: boolean): string {
    for (let attempt = 0; attempt < 24; attempt++) {
      const n = make();
      if (!this.used.has(n)) {
        this.used.add(n);
        return n;
      }
    }
    const base = make();
    if (allowVariants) {
      const mods = ['Little ', 'Great ', 'Upper ', 'Nether ', 'New ', 'Old ', 'East ', 'West ', 'North ', 'South '];
      for (const m of mods) {
        const n = m + base;
        if (!this.used.has(n)) {
          this.used.add(n);
          return n;
        }
      }
      const suffixes = [' Minor', ' Major', ' Parva', ' Magna', ' Bridge', ' Cross', ' End', ' Green'];
      for (const s of suffixes) {
        const n = base + s;
        if (!this.used.has(n)) {
          this.used.add(n);
          return n;
        }
      }
    }
    // Last resort: a genuinely arbitrary but plausible distinguisher.
    let i = 2;
    while (this.used.has(`${base} ${roman(i)}`)) i++;
    const n = `${base} ${roman(i)}`;
    this.used.add(n);
    return n;
  }

  reserve(name: string): string {
    this.used.add(name);
    return name;
  }

  has(name: string): boolean {
    return this.used.has(name);
  }

  get count(): number {
    return this.used.size;
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Cleans up the artefacts a syllable machine produces: triples, awkward clusters. */
function tidy(s: string): string {
  let out = s
    .replace(/([a-z])\1\1+/gi, '$1$1')
    .replace(/([bcdfgjkpqtvz])\1/gi, '$1')
    .replace(/hh/gi, 'h')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > 2 && /[aeiou]/i.test(out) === false) out += 'a';
  return capitalise(out);
}

function roman(n: number): string {
  const table: Array<[number, string]> = [
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let out = '';
  let v = n;
  for (const [val, sym] of table) {
    while (v >= val) {
      out += sym;
      v -= val;
    }
  }
  return out || 'I';
}

export { QUALIFIERS, ABSTRACTS, SAINTS, RELIEF_NOUNS, CANYON_NOUNS, PASS_NOUNS };
