/**
 * @fileoverview Tests for the pure search helpers: folding, word-prefix and CJK
 * matching, cumulative tiers, filters and the single-removal probe, counting and
 * facet helpers, haversine, comparators, and the cursor fingerprint/round trip.
 * @module tests/services/unesco-datahub/search.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  bestSingleRemoval,
  compareNumericId,
  compareOptional,
  compareText,
  countBoolean,
  countInto,
  fingerprint,
  foldText,
  foldTier,
  haversineKm,
  makeCursor,
  matchesAllWords,
  matchTier,
  type NamedFilter,
  queryWords,
  readCursor,
  topCounts,
  wordMatches,
} from '@/services/unesco-datahub/search.js';

describe('foldText', () => {
  it('lowercases, strips accents, and turns punctuation into single spaces', () => {
    expect(foldText('Vieille  Ville-d’Alderfen, (Église)!')).toBe(
      'vieille ville d alderfen eglise',
    );
  });

  it('applies NFKD compatibility folding', () => {
    expect(foldText('ﬁne ①')).toBe('fine 1');
  });

  it('keeps non-Latin letters and digits', () => {
    expect(foldText('奥德芬古城 2')).toBe('奥德芬古城 2');
    expect(foldText('Москва')).toBe('москва');
  });

  it('returns an empty string for punctuation-only input', () => {
    expect(foldText(' -- ,, ')).toBe('');
  });
});

describe('foldTier / queryWords', () => {
  it('prefixes a space and skips absent parts', () => {
    expect(foldTier('Alpha Beta', undefined, '', 'Gamma')).toBe(' alpha beta gamma');
    expect(foldTier()).toBe(' ');
    expect(foldTier(undefined)).toBe(' ');
  });

  it('splits a query into folded words', () => {
    expect(queryWords('  Old-Town  église ')).toEqual(['old', 'town', 'eglise']);
    expect(queryWords('!!')).toEqual([]);
    expect(queryWords('')).toEqual([]);
  });
});

describe('wordMatches', () => {
  const tier = foldTier('Alderfen Old Town', '奥德芬古城');

  it('matches a prefix of any word, never a mid-word substring', () => {
    expect(wordMatches('alder', tier)).toBe(true);
    expect(wordMatches('town', tier)).toBe(true);
    expect(wordMatches('fen', tier)).toBe(false);
    expect(wordMatches('ownt', tier)).toBe(false);
  });

  it('matches a CJK word as a substring anywhere', () => {
    expect(wordMatches('德芬', tier)).toBe(true);
    expect(wordMatches('古城', tier)).toBe(true);
    expect(wordMatches('京都', tier)).toBe(false);
  });
});

describe('matchTier', () => {
  const tiers = [
    foldTier('Alder Town'),
    foldTier('a walled marsh'),
    foldTier('criterion synthetic'),
  ];

  it('returns the first tier when every word matches there', () => {
    expect(matchTier(['alder', 'town'], tiers)).toBe(0);
  });

  it('accumulates: words matching in different tiers report the deepest tier needed', () => {
    expect(matchTier(['alder', 'walled'], tiers)).toBe(1);
    expect(matchTier(['alder', 'walled', 'synthetic'], tiers)).toBe(2);
  });

  it('returns undefined when any word matches no tier', () => {
    expect(matchTier(['alder', 'missing'], tiers)).toBeUndefined();
  });

  it('returns tier 0 for no words (vacuous match)', () => {
    expect(matchTier([], tiers)).toBe(0);
  });
});

describe('matchesAllWords', () => {
  it('requires every filter word to prefix-match the union of the columns', () => {
    expect(matchesAllWords('fra', ['FR', 'FRA', 'France'])).toBe(true);
    expect(matchesAllWords('united kingdom', ['GB', undefined, 'United Kingdom'])).toBe(true);
    expect(matchesAllWords('united kingdom', ['GB', 'GBR', 'United States'])).toBe(false);
  });

  it('ignores case and accents', () => {
    expect(matchesAllWords('CÔTE', ['Cote d Ivoire'])).toBe(true);
  });
});

describe('haversineKm', () => {
  it('is 0 for identical points and rounds to 0.1 km', () => {
    expect(haversineKm(10, 20, 10, 20)).toBe(0);
    expect(haversineKm(0, 0, 0, 1)).toBe(111.2);
  });

  it('measures a known great-circle distance on the 6,371 km sphere', () => {
    expect(haversineKm(0, 0, 0, 180)).toBe(20015.1);
    expect(haversineKm(90, 0, -90, 0)).toBe(20015.1);
  });

  it('is symmetric', () => {
    expect(haversineKm(48, 2, 52.5, 14.5)).toBe(haversineKm(52.5, 14.5, 48, 2));
  });

  it('wraps across the antimeridian', () => {
    expect(haversineKm(0, 179.5, 0, -179.5)).toBe(111.2);
  });
});

describe('applyFilters / bestSingleRemoval', () => {
  const records = [
    { id: 1, color: 'red', size: 1 },
    { id: 2, color: 'red', size: 2 },
    { id: 3, color: 'blue', size: 2 },
    { id: 4, color: 'blue', size: 3 },
  ];
  const red: NamedFilter<(typeof records)[number]> = {
    name: 'color',
    test: (r) => r.color === 'red',
  };
  const big: NamedFilter<(typeof records)[number]> = { name: 'size', test: (r) => r.size >= 3 };
  const none: NamedFilter<(typeof records)[number]> = { name: 'id', test: (r) => r.id > 10 };

  it('returns indices passing every filter, and all indices for no filters', () => {
    expect(applyFilters(records, [red])).toEqual([0, 1]);
    expect(applyFilters(records, [red, big])).toEqual([]);
    expect(applyFilters(records, [])).toEqual([0, 1, 2, 3]);
  });

  it('passes the record index to a filter', () => {
    expect(applyFilters(records, [{ name: 'odd', test: (_r, i) => i % 2 === 1 }])).toEqual([1, 3]);
  });

  it('names the single filter whose removal matches the most records', () => {
    expect(bestSingleRemoval(records, [red, big])).toEqual({ name: 'size', count: 2 });
  });

  it('breaks ties toward the earlier-declared filter', () => {
    const a: NamedFilter<(typeof records)[number]> = { name: 'a', test: (r) => r.id <= 2 };
    const b: NamedFilter<(typeof records)[number]> = { name: 'b', test: (r) => r.id >= 3 };
    expect(bestSingleRemoval(records, [a, b])).toEqual({ name: 'a', count: 2 });
  });

  it('returns undefined when every single removal still matches nothing', () => {
    expect(
      bestSingleRemoval(records, [none, { name: 'never', test: () => false }]),
    ).toBeUndefined();
  });
});

describe('counting helpers', () => {
  it('countInto seeds every key with 0 and counts values, including unseeded ones', () => {
    expect(countInto(['a', 'b'], ['a', 'a', 'c'])).toEqual({ a: 2, b: 0, c: 1 });
    expect(countInto(['a', 'b'], [])).toEqual({ a: 0, b: 0 });
  });

  it('countBoolean counts true/false', () => {
    expect(countBoolean([true, false, true])).toEqual({ true: 2, false: 1 });
    expect(countBoolean([])).toEqual({ true: 0, false: 0 });
  });

  it('topCounts orders by count desc then key asc and caps at n', () => {
    expect(topCounts(['b', 'a', 'a', 'c', 'b', 'd'], 3)).toEqual([
      { key: 'a', count: 2 },
      { key: 'b', count: 2 },
      { key: 'c', count: 1 },
    ]);
    expect(topCounts([], 5)).toEqual([]);
  });
});

describe('comparators', () => {
  it('compareText ignores case and accents in ordering, with a deterministic tie-break', () => {
    expect(['b', 'é', 'A', 'a', 'e', 'c'].sort(compareText)).toEqual([
      'A',
      'a',
      'b',
      'c',
      'e',
      'é',
    ]);
    expect(compareText('a', 'a')).toBe(0);
  });

  it('compareNumericId compares digit strings numerically', () => {
    expect(['10', '9', '100'].sort(compareNumericId)).toEqual(['9', '10', '100']);
  });

  it('compareOptional puts absent values last in either direction', () => {
    expect([3, undefined, 1, 2].sort((a, b) => compareOptional(a, b, 'asc'))).toEqual([
      1,
      2,
      3,
      undefined,
    ]);
    expect([3, undefined, 1, 2].sort((a, b) => compareOptional(a, b, 'desc'))).toEqual([
      3,
      2,
      1,
      undefined,
    ]);
    expect(compareOptional(undefined, undefined, 'asc')).toBe(0);
    expect(compareOptional(2, 2, 'desc')).toBe(0);
  });
});

describe('fingerprint', () => {
  it('is stable and differs for different values', () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint({ a: 1, b: 2 })).not.toBe(fingerprint({ b: 2, a: 1 }));
  });

  it('returns a short base-36 string', () => {
    expect(fingerprint({ query: 'x' })).toMatch(/^[0-9a-z]{1,8}$/);
  });
});

describe('cursor round trip', () => {
  const context = { requestId: 'test', timestamp: new Date(0).toISOString(), operation: 'test' };

  it('decodes what makeCursor encodes', () => {
    const cursor = makeCursor({
      offset: 20,
      limit: 20,
      fp: 'abc',
      asOf: '2026-09-30T02:06:00+00:00',
    });
    expect(readCursor(cursor, context)).toEqual({
      offset: 20,
      fp: 'abc',
      asOf: '2026-09-30T02:06:00+00:00',
    });
  });

  it('decodes a well-formed cursor without fingerprint fields to empty strings that never match', () => {
    const cursor = encodeCursor({ offset: 5, limit: 10 });
    expect(readCursor(cursor, context)).toEqual({ offset: 5, fp: '', asOf: '' });
  });

  it.each([
    ['a fractional offset', encodeCursor({ offset: 1.5, limit: 20, fp: 'abc', asOf: 'x' })],
    ['a fractional limit', encodeCursor({ offset: 20, limit: 2.5, fp: 'abc', asOf: 'x' })],
    ['an infinite offset', Buffer.from('{"offset":1e999,"limit":20}').toString('base64url')],
    ['a negative offset', encodeCursor({ offset: -20, limit: 20 })],
  ])('rejects a cursor carrying %s as invalid_cursor', (_label, cursor) => {
    try {
      readCursor(cursor, context);
      expect.unreachable('expected an error');
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect((error as McpError).data).toMatchObject({ reason: 'invalid_cursor' });
    }
  });

  it('rejects a malformed cursor with the framework invalid_cursor error', () => {
    try {
      readCursor('not-a-cursor', context);
      expect.unreachable('expected an error');
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).data).toMatchObject({ reason: 'invalid_cursor' });
    }
  });
});
