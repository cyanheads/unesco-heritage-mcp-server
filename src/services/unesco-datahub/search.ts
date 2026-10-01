/**
 * @fileoverview Pure search helpers over snapshot records, shared by the three
 * search tools and the reference `filter`: text folding, word-prefix and CJK
 * matching with cumulative field tiers, named filters and the single-removal
 * probe, facet counting, haversine distance, sort comparators with id
 * tie-breaks, and the cursor fingerprint.
 * @module services/unesco-datahub/search
 */

import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';

const COMBINING_MARKS = /\p{M}+/gu;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** NFKD, strip combining marks, lowercase, non-alphanumerics to single spaces, trimmed. */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, ' ')
    .trim();
}

/**
 * Folds the given parts into one match string, prefixed with a space so a
 * word-prefix test is a plain `includes(' ' + word)`.
 */
export function foldTier(...parts: readonly (string | undefined)[]): string {
  const folded = parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map(foldText)
    .filter(Boolean)
    .join(' ');
  return ` ${folded}`;
}

/** Splits a query into folded words; empty when nothing searchable remains. */
export function queryWords(query: string): string[] {
  return foldText(query).split(' ').filter(Boolean);
}

/**
 * Whether one folded query word matches a folded tier string: a prefix of any
 * word in it, or — for a word containing CJK characters, which has no word
 * breaks — a substring anywhere in it.
 */
export function wordMatches(word: string, tier: string): boolean {
  return CJK.test(word) ? tier.includes(word) : tier.includes(` ${word}`);
}

/**
 * The first tier (0-based) by which every query word has matched, with tiers
 * accumulating: tier k covers the fields of tiers 0…k. Undefined when some word
 * matches no tier at all.
 */
export function matchTier(words: readonly string[], tiers: readonly string[]): number | undefined {
  let deepest = 0;
  for (const word of words) {
    const first = tiers.findIndex((tier) => wordMatches(word, tier));
    if (first === -1) return;
    if (first > deepest) deepest = first;
  }
  return deepest;
}

/** True when every word of `filter` word-prefix-matches the union of `columns`. */
export function matchesAllWords(filter: string, columns: readonly (string | undefined)[]): boolean {
  const words = queryWords(filter);
  const tier = foldTier(...columns);
  return words.every((word) => wordMatches(word, tier));
}

/** Great-circle distance in km on a 6,371 km sphere, rounded to 0.1 km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  return Math.round(km * 10) / 10;
}

/** A named record predicate; the name is what the zero-hit notice reports. */
export interface NamedFilter<T> {
  name: string;
  test(record: T, index: number): boolean;
}

/** Indices of the records passing every filter. */
export function applyFilters<T>(
  records: readonly T[],
  filters: readonly NamedFilter<T>[],
): number[] {
  const hits: number[] = [];
  records.forEach((record, index) => {
    if (filters.every((f) => f.test(record, index))) hits.push(index);
  });
  return hits;
}

/**
 * For a zero-hit search with two or more filters: the single filter whose
 * removal alone matches the most records. Undefined when every single removal
 * still matches nothing. Ties keep the earlier-declared filter.
 */
export function bestSingleRemoval<T>(
  records: readonly T[],
  filters: readonly NamedFilter<T>[],
): { name: string; count: number } | undefined {
  let best: { name: string; count: number } | undefined;
  for (const skipped of filters) {
    const rest = filters.filter((f) => f !== skipped);
    const count = applyFilters(records, rest).length;
    if (count > 0 && (!best || count > best.count)) best = { name: skipped.name, count };
  }
  return best;
}

/** Counts values into a plain object, seeding every key in `keys` with 0. */
export function countInto(
  keys: readonly string[],
  values: Iterable<string>,
): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

/** Counts `true`/`false` occurrences. */
export function countBoolean(values: Iterable<boolean>): { true: number; false: number } {
  const counts = { true: 0, false: 0 };
  for (const v of values) counts[v ? 'true' : 'false'] += 1;
  return counts;
}

/**
 * The `n` most frequent keys, count descending, then key ascending. Each
 * yielded key counts once per occurrence (a transboundary record yields each of
 * its countries).
 */
export function topCounts<K extends string>(
  keys: Iterable<K>,
  n: number,
): { key: K; count: number }[] {
  const counts = new Map<K, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || compareText(a.key, b.key))
    .slice(0, n);
}

/** Locale-stable text comparison for sorting by name. */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Numeric comparison of digit-string ids. */
export function compareNumericId(a: string, b: string): number {
  return Number(a) - Number(b);
}

/**
 * Compares optional numbers with absent values last, in the given direction.
 * Returns 0 when both are absent or equal.
 */
export function compareOptional(
  a: number | undefined,
  b: number | undefined,
  direction: 'asc' | 'desc',
): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return direction === 'asc' ? a - b : b - a;
}

/** Short FNV-1a hash of a JSON-serializable value — the cursor's filter fingerprint. */
export function fingerprint(value: unknown): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(value)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Pagination state carried in a search cursor. */
export interface SearchCursor {
  asOf: string;
  fp: string;
  offset: number;
}

/** Encodes the continuation cursor for the page after `offset`. */
export function makeCursor(state: SearchCursor & { limit: number }): string {
  return encodeCursor({ ...state });
}

/**
 * Decodes a search cursor. A malformed cursor throws the framework's
 * `InvalidParams` (`reason: 'invalid_cursor'`), and so does one whose `offset`
 * or `limit` is not a safe integer: the framework's decoder rejects negative
 * values but lets fractions and infinities through. A well-formed cursor
 * missing the fingerprint fields decodes with empty strings, which never match.
 */
export function readCursor(cursor: string, context: RequestContext): SearchCursor {
  const state = decodeCursor(cursor, context);
  if (!Number.isSafeInteger(state.offset) || !Number.isSafeInteger(state.limit)) {
    throw invalidParams(
      'Invalid pagination cursor: its offset and limit must be non-negative whole numbers.',
      { reason: 'invalid_cursor' },
    );
  }
  return {
    offset: state.offset,
    fp: typeof state.fp === 'string' ? state.fp : '',
    asOf: typeof state.asOf === 'string' ? state.asOf : '',
  };
}
