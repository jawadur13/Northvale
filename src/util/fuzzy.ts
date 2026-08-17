/**
 * Ranked substring / initials matching for the gazetteer search box.
 *
 * Deliberately not a full fuzzy matcher: place names are short and users type
 * prefixes, so exact-prefix and word-boundary hits are weighted far above
 * scattered character matches, which keeps results predictable.
 */

export interface ScoredMatch {
  score: number;
  /** Index ranges in the haystack that matched, for highlighting. */
  ranges: Array<[number, number]>;
}

const EMPTY_RANGES: Array<[number, number]> = [];

export function scoreMatch(haystack: string, needle: string): ScoredMatch | null {
  if (!needle) return { score: 0, ranges: EMPTY_RANGES };
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();

  if (h === n) return { score: 1000, ranges: [[0, n.length]] };

  const direct = h.indexOf(n);
  if (direct === 0) return { score: 700 - h.length * 0.2, ranges: [[0, n.length]] };
  if (direct > 0) {
    // Word-boundary hits beat mid-word hits.
    const boundary = direct === 0 || h[direct - 1] === ' ' || h[direct - 1] === '-';
    return {
      score: (boundary ? 520 : 380) - direct * 1.5 - h.length * 0.2,
      ranges: [[direct, direct + n.length]],
    };
  }

  // Initials: "gs" matches "Gilded Spire".
  const words = h.split(/[\s'-]+/);
  if (n.length >= 2 && n.length <= words.length) {
    let ok = true;
    for (let i = 0; i < n.length; i++) {
      if (!words[i] || words[i][0] !== n[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { score: 460, ranges: [] };
  }

  // Scattered subsequence, scored by how tightly grouped the hits are.
  let hi = 0;
  let ni = 0;
  let gaps = 0;
  let last = -2;
  const ranges: Array<[number, number]> = [];
  while (hi < h.length && ni < n.length) {
    if (h[hi] === n[ni]) {
      if (hi !== last + 1) gaps++;
      if (ranges.length && ranges[ranges.length - 1][1] === hi) ranges[ranges.length - 1][1] = hi + 1;
      else ranges.push([hi, hi + 1]);
      last = hi;
      ni++;
    }
    hi++;
  }
  if (ni < n.length) return null;
  return { score: Math.max(1, 200 - gaps * 24 - h.length * 0.4), ranges };
}

/** Wraps matched ranges in <mark> for display. Input is escaped first. */
export function highlight(text: string, ranges: Array<[number, number]>): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!ranges.length) return esc(text);
  let out = '';
  let cursor = 0;
  for (const [a, b] of ranges) {
    if (a < cursor) continue;
    out += esc(text.slice(cursor, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
    cursor = b;
  }
  out += esc(text.slice(cursor));
  return out;
}
