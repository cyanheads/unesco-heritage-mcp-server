/**
 * @fileoverview Tests for unesco_search_sites: blank-as-unset inputs, the
 * declared error contracts, paging and cursors, filters, `near`, keyword tiers,
 * zero-hit notices, facets, format() parity with structuredContent, CR/LF in
 * upstream text, upstream failure classes, and the enrichment contract on the
 * zero-result and under-cap pages.
 * @module tests/tools/search-sites.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchSitesTool } from '@/mcp-server/tools/definitions/search-sites.tool.js';
import { makeCursor, readCursor } from '@/services/unesco-datahub/search.js';
import { DATA_AS_OF, type HubOptions, httpFailure } from '../fixtures/hub.js';
import { WHC_ROWS, whcRow } from '../fixtures/rows.js';
import {
  allText,
  disposeServiceAfterEach,
  errorOf,
  structured,
  textBlocks,
  useHub,
} from '../fixtures/tool.js';

type SiteRow = z.infer<typeof searchSitesTool.output>['sites'][number];

type SearchOutput = z.infer<typeof searchSitesTool.output> & {
  applied_filters: Record<string, unknown>;
  cap: number;
  facets: {
    category: Record<string, number>;
    criteria: Record<string, number>;
    in_danger: { false: number; true: number };
    region: Record<string, number>;
    top_countries: { code?: string; count: number; name: string }[];
  };
  notice?: string;
  shown: number;
  sources: { dataset: string; license: string }[];
  totalCount: number;
  truncated: boolean;
};

disposeServiceAfterEach();

const search = async (input: Record<string, unknown> = {}) => {
  const result = await runToolContract(searchSitesTool, input as never);
  return { result, out: structured<SearchOutput>(result), text: allText(result) };
};

const ids = (out: SearchOutput) => out.sites.map((s) => s.id_no);
const withCodePoints = (...points: number[]) => String.fromCodePoint(...points);

/** The `fp` the tool computes for a filter set, read back from a real cursor. */
async function cursorFor(input: Record<string, unknown>) {
  const { out } = await search({ ...input, limit: 1 });
  const next = out.next_cursor;
  expect(next, 'expected a next_cursor to read the fingerprint from').toBeDefined();
  return readCursor(next as string, createMockContext() as never);
}

describe('unesco_search_sites — enrichment contract pages', () => {
  beforeEach(() => {
    useHub();
  });

  it('zero-result page: zeroed facets, no truncation, sources and applied filters present', async () => {
    const { out, text } = await search({ query: 'nomatchword' });
    expect(out.sites).toEqual([]);
    expect(out).toMatchObject({ totalCount: 0, shown: 0, cap: 20, truncated: false });
    expect(out.next_cursor).toBeUndefined();
    expect(out.facets).toEqual({
      category: { Cultural: 0, Natural: 0, Mixed: 0 },
      region: {
        Africa: 0,
        'Arab States': 0,
        'Asia and the Pacific': 0,
        'Europe and North America': 0,
        'Latin America and the Caribbean': 0,
      },
      in_danger: { true: 0, false: 0 },
      criteria: { i: 0, ii: 0, iii: 0, iv: 0, v: 0, vi: 0, vii: 0, viii: 0, ix: 0, x: 0 },
      top_countries: [],
    });
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]).toMatchObject({ dataset: 'whc001', license: 'CC BY-SA 4.0' });
    expect(out.applied_filters).toEqual({ query: 'nomatchword', sort: 'relevance', limit: 20 });
    expect(out.notice).toContain('nomatchword');
    expect(text).toContain('**0 World Heritage sites on this page**');
    expect(text).toContain('Top countries: none');
  });

  it('under-cap page: country DE lists its three sites with no cursor and no truncation', async () => {
    const { out } = await search({ country: 'DE' });
    expect(ids(out).sort()).toEqual(['102', '107', '108']);
    expect(out).toMatchObject({ totalCount: 3, shown: 3, cap: 20, truncated: false });
    expect(out.next_cursor).toBeUndefined();
    expect(out.notice).toBeUndefined();
    expect(out.applied_filters).toMatchObject({
      country: { code: 'DE', name: 'Germany' },
      sort: 'name',
    });
  });
});

describe('unesco_search_sites — blank inputs read as unset', () => {
  beforeEach(() => {
    useHub();
  });

  it('treats every blank optional field, an all-blank near, and an empty criteria list as no filters', async () => {
    const { out } = await search({
      query: '',
      country: '  ',
      category: '',
      region: '',
      criteria: [],
      in_danger: '',
      transboundary: '',
      inscribed_from: '',
      inscribed_to: '',
      near: { latitude: '', longitude: '', radius_km: '' },
      sort: '',
      limit: '',
      cursor: '',
    });
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 20 });
    expect(out.totalCount).toBe(WHC_ROWS.length);
    expect(out.sites).toHaveLength(20);
  });

  it('treats a blank criteria string and a blank near string as unset', async () => {
    const { out } = await search({ criteria: '', near: '' });
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 20 });
  });

  it('applies the near default radius of 100 km when radius_km is blank', async () => {
    const { out } = await search({ near: { latitude: 48, longitude: 2, radius_km: '' } });
    expect(out.applied_filters.near).toEqual({ latitude: 48, longitude: 2, radius_km: 100 });
  });
});

describe('unesco_search_sites — input normalization and validation', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['lowercase alpha-2', 'fr', 'FR'],
    ['alpha-3', 'FRA', 'FR'],
    ['lowercase alpha-3', 'deu', 'DE'],
    ['padded', ' de ', 'DE'],
  ])('resolves a %s country', async (_label, country, code) => {
    const { out } = await search({ country });
    expect((out.applied_filters.country as { code: string }).code).toBe(code);
  });

  it('folds category and region spellings and region codes', async () => {
    const { out } = await search({ category: ' natural ', region: 'eur' });
    expect(out.applied_filters).toMatchObject({
      category: 'Natural',
      region: 'Europe and North America',
    });
  });

  it('accepts criteria in numeral, parenthesized, numeric, and digit-string forms', async () => {
    const { out } = await search({ criteria: ['(IV)', 2, '9', ' ii '] });
    expect(out.applied_filters.criteria).toEqual(['ii', 'iv', 'ix']);
  });

  it.each([
    ['limit 0', { limit: 0 }],
    ['limit 51', { limit: 51 }],
    ['limit 2.5', { limit: 2.5 }],
    ['a non-numeric limit', { limit: 'ten' }],
    ['an unknown category', { category: 'Mythic' }],
    ['an unknown region', { region: 'Atlantis' }],
    ['an unknown sort', { sort: 'popularity' }],
    ['an unknown criterion', { criteria: ['xi'] }],
    ['a year below range', { inscribed_from: 1899 }],
    ['a year above range', { inscribed_to: 2101 }],
    ['a query over 200 characters', { query: 'a'.repeat(201) }],
    ['a country over 64 characters', { country: 'a'.repeat(65) }],
    ['a latitude out of range', { near: { latitude: 91, longitude: 0 } }],
    ['a longitude out of range', { near: { latitude: 0, longitude: 181 } }],
    ['a zero radius', { near: { latitude: 0, longitude: 0, radius_km: 0 } }],
    ['a radius over 5000', { near: { latitude: 0, longitude: 0, radius_km: 5001 } }],
    ['an unknown near key', { near: { latitude: 0, longitude: 0, unit: 'mi' } }],
    ['a cursor over 1024 characters', { cursor: 'a'.repeat(1025) }],
  ])('rejects %s as invalid arguments', async (_label, input) => {
    const error = errorOf(await runToolContract(searchSitesTool, input as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it.each([
    [1, 1],
    [20, 20],
    [50, 39],
  ])('accepts limit %i', async (limit, shown) => {
    const { out } = await search({ limit });
    expect(out.cap).toBe(limit);
    expect(out.sites).toHaveLength(shown);
  });
});

describe('unesco_search_sites — declared errors', () => {
  beforeEach(() => {
    useHub();
  });

  it.each(['ZZ', 'France'])('unknown_country for %s', async (country) => {
    const result = await runToolContract(searchSitesTool, { country });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unknown_country',
      country,
      recovery: { hint: expect.stringContaining('unesco_list_reference') },
    });
    expect(allText(result)).toContain('(reason unknown_country');
  });

  it('invalid_year_range when from is after to', async () => {
    const result = await runToolContract(searchSitesTool, {
      inscribed_from: 2010,
      inscribed_to: 2000,
    });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_year_range');
    expect(error.data?.recovery?.hint).toContain('inscribed_from');
    expect(allText(result)).toContain('inscribed_from (2010) is later than inscribed_to (2000)');
  });

  it('accepts equal year bounds', async () => {
    const { out } = await search({ inscribed_from: 2004, inscribed_to: 2004 });
    expect(ids(out)).toEqual(['103']);
  });

  it.each([
    ['relevance without a query', { sort: 'relevance' }],
    ['distance without near', { sort: 'distance' }],
    ['relevance with only a blank query', { sort: 'relevance', query: '  ' }],
  ])('sort_needs_input for %s', async (_label, input) => {
    const error = errorOf(await runToolContract(searchSitesTool, input as never));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('sort_needs_input');
    expect(error.data?.recovery?.hint).toContain('unesco_search_sites');
  });

  it('cursor_mismatch when the filters change', async () => {
    const cursor = await cursorFor({ country: 'FR' });
    const error = errorOf(
      await runToolContract(searchSitesTool, { country: 'DE', cursor: makeCursorFrom(cursor) }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('cursor_mismatch');
  });

  it('cursor_mismatch when the sort changes', async () => {
    const { out } = await search({ limit: 2 });
    const error = errorOf(
      await runToolContract(searchSitesTool, {
        sort: 'inscribed_newest',
        cursor: out.next_cursor,
      }),
    );
    expect(error.data?.reason).toBe('cursor_mismatch');
  });

  it('cursor_mismatch when the cursor was issued for a different data snapshot', async () => {
    const { fp } = await cursorFor({});
    const cursor = makeCursor({ offset: 1, limit: 20, fp, asOf: '2020-01-01T00:00:00+00:00' });
    const error = errorOf(await runToolContract(searchSitesTool, { cursor }));
    expect(error.data?.reason).toBe('cursor_mismatch');
  });

  it('cursor_mismatch for a cursor with no fingerprint', async () => {
    const cursor = encodeCursor({ offset: 5, limit: 20 });
    const error = errorOf(await runToolContract(searchSitesTool, { cursor }));
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('cursor_mismatch');
  });

  it('invalid_cursor for a malformed cursor (framework-owned)', async () => {
    const error = errorOf(await runToolContract(searchSitesTool, { cursor: 'garbage' }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_cursor');
  });

  it('carries the declared reason on a thrown error when the handler is called directly', async () => {
    await expect(
      searchSitesTool.handler(
        searchSitesTool.input.parse({ country: 'ZZ' }),
        createMockContext({ errors: searchSitesTool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'unknown_country' },
    });
  });

  it('accepts a code that no record carries and reports a zero-hit notice', async () => {
    const { out } = await search({ country: 'AQ' });
    expect(out.totalCount).toBe(0);
    expect(out.notice).toContain('No World Heritage site lists AQ (Antarctica)');
  });
});

/** Re-encodes a decoded cursor state so a test can hand it to a different filter set. */
function makeCursorFrom(state: { asOf: string; fp: string; offset: number }): string {
  return makeCursor({ ...state, limit: 20 });
}

describe('unesco_search_sites — paging', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns 20 of 39 with a next_cursor and a continuation notice on page 1', async () => {
    const { out, text } = await search();
    expect(out.sites).toHaveLength(20);
    expect(out).toMatchObject({ totalCount: 39, shown: 20, cap: 20, truncated: true });
    expect(out.next_cursor).toBeDefined();
    expect(out.notice).toBe('Showing results 1–20 of 39; pass next_cursor to continue.');
    expect(text).toContain(`Next cursor: ${out.next_cursor}`);
  });

  it('walks every page to 39 unique ids in name order', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { out } = await search({ cursor });
      seen.push(...ids(out));
      cursor = out.next_cursor;
      pages += 1;
      if (cursor) expect(out.truncated).toBe(true);
      else expect(out.truncated).toBe(false);
    } while (cursor && pages < 10);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(39);
    const gridwick = Array.from({ length: 30 }, (_, i) => String(201 + i));
    expect(seen).toEqual([
      '101', // Alderfen
      '102', // Brindle
      ...gridwick,
      '105', // Hollowmere
      '107', // Lantern
      '109', // Manyparts
      '106', // Orchard
      '108', // Reedhaven
      '103', // Tarnwick
      '104', // Vessel
    ]);
  });

  it('accepts a changed limit mid-walk and continues from the cursor offset', async () => {
    const first = await search({ limit: 5 });
    const second = await search({ limit: 10, cursor: first.out.next_cursor });
    expect(ids(second.out)).toHaveLength(10);
    expect(second.out.notice).toBe('Showing results 6–15 of 39; pass next_cursor to continue.');
    const all = await search({ limit: 15 });
    expect([...ids(first.out), ...ids(second.out)]).toEqual(ids(all.out));
  });

  it('ends the last page without a cursor or a continuation notice', async () => {
    const first = await search();
    const last = await search({ cursor: first.out.next_cursor });
    expect(last.out.sites).toHaveLength(19);
    expect(last.out).toMatchObject({ truncated: false, shown: 19, totalCount: 39 });
    expect(last.out.next_cursor).toBeUndefined();
    expect(last.out.notice).toBeUndefined();
  });

  it('reports a cursor past the end with the past-the-last notice', async () => {
    const { fp, asOf } = await cursorFor({});
    const cursor = makeCursor({ offset: 100, limit: 20, fp, asOf });
    const { out } = await search({ cursor });
    expect(out.sites).toEqual([]);
    expect(out).toMatchObject({ totalCount: 39, shown: 0, truncated: false });
    expect(out.notice).toBe(
      'The cursor is past the last of 39 results. Call unesco_search_sites without cursor to start over.',
    );
    expect(asOf).toBe(DATA_AS_OF);
  });

  it('shows a truncated page notice to content-only clients', async () => {
    const { text } = await search({ limit: 3 });
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('Showing results 1–3 of 39; pass next_cursor to continue.');
  });
});

describe('unesco_search_sites — filters', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['country FR', { country: 'FR' }, 32],
    ['country DE', { country: 'DE' }, 3],
    ['country PL (through the transboundary site)', { country: 'PL' }, 1],
    ['country by alpha-3', { country: 'POL' }, 1],
    ['category Natural', { category: 'Natural' }, 1],
    ['category Mixed', { category: 'Mixed' }, 1],
    ['category Cultural', { category: 'Cultural' }, 37],
    ['in_danger true', { in_danger: true }, 1],
    ['in_danger false', { in_danger: false }, 38],
    ['transboundary true', { transboundary: true }, 1],
    ['transboundary false', { transboundary: false }, 38],
    ['region Africa', { region: 'Africa' }, 1],
    ['region Europe and North America by code', { region: 'EUR' }, 35],
    ['criteria vi', { criteria: ['vi'] }, 2],
    ['criteria iv and ii', { criteria: ['iv', 'ii'] }, 1],
    ['criteria ii and vi (no site has both)', { criteria: ['ii', 'vi'] }, 0],
    ['years 2000–2010', { inscribed_from: 2000, inscribed_to: 2010 }, 5],
    ['years 2001–2003', { inscribed_from: 2001, inscribed_to: 2003 }, 2],
    ['from 2004 only', { inscribed_from: 2004 }, 3],
    ['to 1980 only', { inscribed_to: 1980 }, 2],
  ])('%s matches the expected number of sites', async (_label, input, total) => {
    const { out } = await search({ ...input, limit: 50 });
    expect(out.totalCount).toBe(total);
    expect(out.sites).toHaveLength(total);
  });

  it('identifies the sites behind the small filters', async () => {
    expect(ids((await search({ country: 'DE' })).out)).toEqual(['102', '107', '108']);
    expect(ids((await search({ country: 'PL' })).out)).toEqual(['102']);
    expect(ids((await search({ category: 'Mixed' })).out)).toEqual(['106']);
    expect(ids((await search({ in_danger: true })).out)).toEqual(['102']);
    expect(ids((await search({ criteria: ['iv', 'ii'] })).out)).toEqual(['101']);
    expect(ids((await search({ inscribed_from: 2001, inscribed_to: 2003 })).out)).toEqual([
      '108',
      '104',
    ]);
  });

  it('marks (vi) as inferred on the sites that carry it and lists it in criteria order', async () => {
    const { out } = await search({ criteria: ['vi'] });
    expect(ids(out).sort()).toEqual(['103', '104']);
    for (const site of out.sites) expect(site.criteria_inferred).toEqual(['vi']);
    const mixed = out.sites.find((s) => s.id_no === '104');
    expect(mixed?.criteria).toEqual(['i', 'iii', 'vi']);
  });

  it('adds the (vi) inference notice and a continuation on a truncated page', async () => {
    const { out } = await search({ criteria: ['vi'], limit: 1 });
    expect(out.totalCount).toBe(2);
    expect(out.notice).toContain('names it for 2 sites');
    expect(out.notice).toContain('Showing results 1–1 of 2; pass next_cursor to continue.');
    expect(out.truncated).toBe(true);
  });

  it('keeps the (vi) notice without a continuation when the page holds every hit', async () => {
    const { out } = await search({ criteria: ['vi'] });
    expect(out.notice).toContain('names it for 2 sites');
    expect(out.notice).not.toContain('pass next_cursor');
    expect(out.truncated).toBe(false);
  });

  it('omits danger_listed_year, area and coordinates from rows that lack them', async () => {
    const { out } = await search({ query: 'hollowmere' });
    const [site] = out.sites;
    expect(site).toMatchObject({ id_no: '105', in_danger: false });
    for (const key of ['danger_listed_year', 'area_hectares', 'latitude', 'longitude']) {
      expect(site, key).not.toHaveProperty(key);
    }
  });

  it('reports the Danger-list year for a listed site', async () => {
    const { out } = await search({ in_danger: true });
    expect(out.sites[0]).toMatchObject({ id_no: '102', danger_listed_year: 2015 });
  });
});

describe('unesco_search_sites — sort', () => {
  beforeEach(() => {
    useHub();
  });

  it('inscribed_newest orders by year descending and breaks ties on id', async () => {
    const { out } = await search({ sort: 'inscribed_newest', limit: 3 });
    expect(ids(out)).toEqual(['106', '109', '103']);
  });

  it('inscribed_oldest orders by year ascending and breaks ties on id', async () => {
    const { out } = await search({ sort: 'inscribed_oldest', limit: 3 });
    expect(ids(out)).toEqual(['201', '221', '202']);
  });

  it('area_largest puts sites without an area last', async () => {
    const { out } = await search({ sort: 'area_largest', limit: 50 });
    expect(ids(out).slice(0, 3)).toEqual(['102', '106', '101']);
    expect(ids(out).slice(-2)).toEqual(['103', '105']);
  });

  it('danger_listed_newest puts the listed site first and the rest by id', async () => {
    const { out } = await search({ sort: 'danger_listed_newest', limit: 3 });
    expect(ids(out)).toEqual(['102', '101', '103']);
  });

  it('echoes the resolved default sort in applied_filters', async () => {
    expect((await search()).out.applied_filters.sort).toBe('name');
    expect((await search({ query: 'alderfen' })).out.applied_filters.sort).toBe('relevance');
    expect((await search({ near: { latitude: 48, longitude: 2 } })).out.applied_filters.sort).toBe(
      'distance',
    );
    expect(
      (await search({ query: 'alderfen', near: { latitude: 48, longitude: 2 } })).out
        .applied_filters.sort,
    ).toBe('relevance');
  });

  it('honors an explicit sort over the default', async () => {
    const { out } = await search({ query: 'synthetic', sort: 'inscribed_newest', limit: 1 });
    expect(out.applied_filters.sort).toBe('inscribed_newest');
    expect(ids(out)).toEqual(['106']);
  });
});

describe('unesco_search_sites — near', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns sites within the radius, nearest first, with distances', async () => {
    const { out } = await search({
      near: { latitude: 48, longitude: 2, radius_km: 100 },
      limit: 50,
    });
    expect(out.totalCount).toBe(31);
    expect(out.sites[0]).toMatchObject({ id_no: '101', distance_km: 0 });
    const distances = out.sites.map((s) => s.distance_km as number);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(Math.max(...distances)).toBeLessThanOrEqual(100);
    expect(out.applied_filters.near).toEqual({ latitude: 48, longitude: 2, radius_km: 100 });
  });

  it('widens with the radius and never matches sites without coordinates', async () => {
    const { out } = await search({
      near: { latitude: 48, longitude: 2, radius_km: 5000 },
      limit: 50,
    });
    expect(out.totalCount).toBe(36);
    expect(ids(out)).not.toContain('103');
    expect(ids(out)).not.toContain('105');
  });

  it('applies the 100 km default radius', async () => {
    const { out } = await search({ near: { latitude: 48, longitude: 2 }, limit: 50 });
    expect(out.totalCount).toBe(31);
  });

  it('renders the distance in format()', async () => {
    const { text } = await search({ near: { latitude: 48, longitude: 2 }, limit: 1 });
    expect(text).toContain('Distance: 0 km');
    expect(text).toContain('- near: 48, 2 within 100 km');
  });

  it('carries the near point through the cursor fingerprint', async () => {
    const first = await search({ near: { latitude: 48, longitude: 2 }, limit: 2 });
    const error = errorOf(
      await runToolContract(searchSitesTool, {
        near: { latitude: 49, longitude: 2 },
        cursor: first.out.next_cursor,
      }),
    );
    expect(error.data?.reason).toBe('cursor_mismatch');
  });
});

describe('unesco_search_sites — keyword tiers', () => {
  beforeEach(() => {
    useHub();
  });

  it('matches a name word and reports the name tier', async () => {
    const { out } = await search({ query: 'alderfen' });
    expect(ids(out)).toEqual(['101']);
    expect(out.sites[0]?.matched_in).toBe('name');
  });

  it('matches a description word and reports the description tier', async () => {
    const { out } = await search({ query: 'walled' });
    expect(ids(out)).toEqual(['101']);
    expect(out.sites[0]?.matched_in).toBe('description');
  });

  it('matches a justification word and reports the justification tier', async () => {
    const { out } = await search({ query: 'exchange' });
    expect(ids(out)).toEqual(['101']);
    expect(out.sites[0]?.matched_in).toBe('justification');
  });

  it('accumulates words across tiers and reports the deepest tier needed', async () => {
    expect((await search({ query: 'alderfen walled' })).out.sites[0]?.matched_in).toBe(
      'description',
    );
    expect((await search({ query: 'alderfen walled exchange' })).out.sites[0]?.matched_in).toBe(
      'justification',
    );
    expect((await search({ query: 'exchange alderfen' })).out.sites[0]?.matched_in).toBe(
      'justification',
    );
  });

  it('requires every word: one unmatched word yields no hits', async () => {
    const { out } = await search({ query: 'alderfen nomatchword' });
    expect(out.totalCount).toBe(0);
  });

  it('matches a non-English name and folds accents and case', async () => {
    const { out } = await search({ query: 'VIEILLE' });
    expect(ids(out)).toEqual(['101']);
    const accented = await search({ query: 'foret frontaliere' });
    expect(ids(accented.out)).toEqual(['102']);
    const withAccents = await search({ query: 'Forêt Frontalière' });
    expect(ids(withAccents.out)).toEqual(['102']);
  });

  it('matches a CJK word as a substring', async () => {
    const { out } = await search({ query: withCodePoints(0x5fb7, 0x82ac) });
    expect(ids(out)).toEqual(['101']);
    expect(out.sites[0]?.matched_in).toBe('name');
  });

  it('does not match a fragment that is not the start of a word', async () => {
    expect((await search({ query: 'fen' })).out.totalCount).toBe(0);
    expect((await search({ query: 'alder' })).out.totalCount).toBe(1);
  });

  it('ranks by tier before name, whatever the alphabetical order', async () => {
    const rows = [
      whcRow({
        id_no: '301',
        name_en: 'Zephyr Point',
        short_description_en: 'Plain text.',
        justification_en: null,
      }),
      whcRow({
        id_no: '302',
        name_en: 'Aaa Site',
        short_description_en: 'Grounds near the zephyr coast.',
        justification_en: null,
      }),
      whcRow({
        id_no: '303',
        name_en: 'Bbb Site',
        short_description_en: 'Plain text.',
        justification_en: 'Criterion (iv): a zephyr ensemble.',
      }),
    ];
    useHub({ rows: { whc001: rows } });
    const { out } = await search({ query: 'zephyr' });
    expect(out.sites.map((s) => [s.id_no, s.matched_in])).toEqual([
      ['301', 'name'],
      ['302', 'description'],
      ['303', 'justification'],
    ]);
    const byName = await search({ query: 'zephyr', sort: 'name' });
    expect(ids(byName.out)).toEqual(['302', '303', '301']);
  });

  it('breaks a relevance tie on name, then id', async () => {
    useHub({
      rows: {
        whc001: [
          whcRow({ id_no: '312', name_en: 'Twin Ridge' }),
          whcRow({ id_no: '311', name_en: 'Twin Ridge' }),
          whcRow({ id_no: '310', name_en: 'Twin Alpha' }),
        ],
      },
    });
    const { out } = await search({ query: 'twin' });
    expect(ids(out)).toEqual(['310', '311', '312']);
  });

  it('carries the query into applied_filters as given', async () => {
    const { out } = await search({ query: '  Alderfen  ' });
    expect(out.applied_filters.query).toBe('Alderfen');
  });
});

describe('unesco_search_sites — zero-hit notices', () => {
  beforeEach(() => {
    useHub();
  });

  it('names the filter whose removal recovers the most sites when several filters are set', async () => {
    const { out } = await search({ category: 'Natural', country: 'FR' });
    expect(out.totalCount).toBe(0);
    expect(out.notice).toMatch(/No site matched all 2 filters\./);
    expect(out.notice).toMatch(/Removing category alone would match 32 sites\./);
  });

  it('omits the removal sentence when no single removal recovers anything', async () => {
    const { out } = await search({ query: 'nomatchword', country: 'AQ' });
    expect(out.notice).toMatch(/No site matched all 2 filters\./);
    expect(out.notice).not.toContain('Removing');
  });

  it('explains a country with no sites, using the code and its display name', async () => {
    const { out } = await search({ country: 'AQ' });
    expect(out.totalCount).toBe(0);
    expect(out.notice).toContain(
      'No World Heritage site lists AQ (Antarctica) among its States Parties.',
    );
    expect(out.notice).toContain('unesco_list_reference with topic countries');
  });

  it('resolves UK to GB and names the United Kingdom', async () => {
    const { out } = await search({ country: 'UK' });
    expect(out.applied_filters.country).toEqual({ code: 'GB', name: 'United Kingdom' });
    expect(out.notice).toContain('GB (United Kingdom)');
  });

  it('explains a query with no match and flattens line breaks in the echoed words', async () => {
    const { out } = await search({ query: 'nomatchword\nsecondword' });
    expect(out.notice).toContain('contains every word of "nomatchword secondword"');
    expect(out.notice).not.toMatch(/[\r\n]/);
  });

  it('explains a near search with nothing in range and counts the sites without coordinates', async () => {
    const { out } = await search({ near: { latitude: 0, longitude: -160, radius_km: 10 } });
    expect(out.totalCount).toBe(0);
    expect(out.notice).toContain('No site with coordinates lies within 10 km of (0, -160)');
    expect(out.notice).toContain('2 sites have no coordinates');
  });

  it('does not add a zero-hit notice to a search that has results', async () => {
    const { out } = await search({ country: 'DE' });
    expect(out.notice).toBeUndefined();
  });
});

describe('unesco_search_sites — facets', () => {
  beforeEach(() => {
    useHub();
  });

  it('computes facets over the whole match, not the page', async () => {
    const one = await search({ limit: 1 });
    const fifty = await search({ limit: 50 });
    expect(one.out.facets).toEqual(fifty.out.facets);
    expect(one.out.facets.category).toEqual({ Cultural: 37, Natural: 1, Mixed: 1 });
    expect(one.out.facets.in_danger).toEqual({ true: 1, false: 38 });
  });

  it('sums the category counts to totalCount under every filter', async () => {
    for (const input of [{}, { country: 'DE' }, { region: 'Africa' }, { query: 'synthetic' }]) {
      const { out } = await search(input);
      const sum = Object.values(out.facets.category).reduce((a, b) => a + b, 0);
      expect(sum, JSON.stringify(input)).toBe(out.totalCount);
    }
  });

  it('narrows the facets with each filter', async () => {
    const { out } = await search({ country: 'DE' });
    expect(out.facets.category).toEqual({ Cultural: 2, Natural: 1, Mixed: 0 });
    expect(out.facets.in_danger).toEqual({ true: 1, false: 2 });
    expect(out.facets.region['Europe and North America']).toBe(3);
    expect(out.facets.criteria).toMatchObject({ iv: 2, ix: 1, x: 1, ii: 0 });
  });

  it('counts a transboundary site once for each of its countries', async () => {
    const { out } = await search({ transboundary: true });
    expect(out.facets.top_countries).toEqual([
      { code: 'DE', name: 'Germany', count: 1 },
      { code: 'PL', name: 'Poland', count: 1 },
    ]);
  });

  it('lists the unfiltered top countries by count, keeping the code-less party as a code-free entry', async () => {
    const { out } = await search();
    expect(out.facets.top_countries.slice(0, 2)).toEqual([
      { code: 'FR', name: 'France', count: 32 },
      { code: 'DE', name: 'Germany', count: 3 },
    ]);
    expect(out.facets.top_countries).toHaveLength(7);
    const coded = out.facets.top_countries.filter((c) => c.code !== undefined);
    expect(coded.slice(2).map((c) => c.code)).toEqual(['ET', 'JP', 'PE', 'PL']);
    const codeless = out.facets.top_countries.filter((c) => c.code === undefined);
    expect(codeless).toEqual([{ name: 'Synthetic Party Name', count: 1 }]);
    expect(codeless[0]).not.toHaveProperty('code');
  });

  it('counts inferred (vi) in the criteria facet and labels it in the trailer', async () => {
    const { out, text } = await search();
    expect(out.facets.criteria.vi).toBe(2);
    expect(text).toContain('vi (inferred) 2');
  });

  it('caps top_countries at ten', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      whcRow({
        id_no: String(400 + i),
        name_en: `Spread Site ${i}`,
        states_names: [`State ${i}`],
        iso_codes: ['AD', 'AE', 'AF', 'AG', 'AL', 'AM', 'AO', 'AR', 'AT', 'AU', 'AZ', 'BA'][i],
      }),
    );
    useHub({ rows: { whc001: rows } });
    const { out } = await search({ limit: 50 });
    expect(out.facets.top_countries).toHaveLength(10);
  });
});

describe('unesco_search_sites — format() parity and text safety', () => {
  beforeEach(() => {
    useHub();
  });

  it('renders every structured field the model needs, per site and in the trailer', async () => {
    const { result, out, text } = await search({ country: 'DE', limit: 50 });
    const body = textBlocks(result)[0] ?? '';
    expect(body).toContain(`**${out.sites.length} World Heritage sites on this page**`);
    for (const s of out.sites) {
      for (const expected of [
        `### ${s.name} (id_no ${s.id_no})`,
        s.category,
        s.region,
        `Inscribed ${s.inscribed_year}`,
        `Transboundary: ${s.transboundary ? 'Yes' : 'No'}`,
        `Criteria: ${s.criteria.join(', ')}`,
        s.area_hectares === undefined ? 'Area: Not available' : `Area: ${s.area_hectares} ha`,
        s.description === undefined
          ? 'Description: Not available'
          : s.description
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n'),
        ...s.states.map((state, i) => `${state} (${s.country_codes[i]})`),
      ]) {
        expect(body, `${s.id_no}: ${expected}`).toContain(expected);
      }
    }
    expect(text).toContain('**3 total**');
    expect(text).toContain('### Facets (whole match)');
    expect(text).toContain('### Applied filters');
    expect(text).toContain('- country: DE (Germany)');
    expect(text).toContain('- sort: name');
    expect(text).toContain('- limit: 50');
    expect(text).toContain('Source: UNESCO — World Heritage List (whc001)');
    expect(text).toContain('Top countries: Germany (DE) 3 · Poland (PL) 1');
  });

  it('states the Danger-list year, the transboundary flag, and multiple states with codes', async () => {
    const { text } = await search({ in_danger: true });
    expect(text).toContain('In Danger since 2015');
    expect(text).toContain('Transboundary: Yes');
    expect(text).toContain('Germany (DE), Poland (PL)');
    expect(text).not.toContain('Not in Danger');
  });

  it('renders "Not in Danger" for a site that is not listed', async () => {
    const { text } = await search({ query: 'alderfen' });
    expect(text).toContain('Not in Danger');
    expect(text).not.toContain('In Danger since');
  });

  it('renders explicit unknowns for a sparse site', async () => {
    const { text } = await search({ query: 'hollowmere' });
    expect(text).toContain('Area: Not available');
    expect(text).toContain('Coordinates: Not available');
    expect(text).toContain('Description: Not available');
  });

  it('renders "none recorded" for a site with no criteria', async () => {
    useHub({
      rows: { whc001: [whcRow({ criteria_txt: null, justification_en: null })] },
    });
    const { out, text } = await search();
    expect(out.sites[0]?.criteria).toEqual([]);
    expect(text).toContain('Criteria: none recorded');
    expect(text).toContain('Criteria: none');
  });

  it('marks an inferred criterion in the site line', async () => {
    const { text } = await search({ query: 'harbour' });
    expect(text).toContain('Criteria: i, iii, vi (vi inferred)');
  });

  it('renders the matched tier and the distance only when present', async () => {
    const plain = await search({ country: 'DE' });
    expect(plain.text).not.toContain('Matched in:');
    expect(plain.text).not.toContain('Distance:');
    const queried = await search({ query: 'alderfen' });
    expect(queried.text).toContain('Matched in: name');
  });

  it('lists a State Party without an ISO code by name with no code suffix', async () => {
    const { out, text } = await search({ query: 'orchard' });
    expect(out.sites[0]?.country_codes).toEqual([]);
    expect(out.sites[0]?.states).toEqual(['Synthetic Party Name']);
    expect(text).toContain('· Synthetic Party Name ·');
    expect(text).not.toContain('Synthetic Party Name (');
    expect(text).toContain('Synthetic Party Name 1');
  });

  it('carries the cursor line only when more results remain', async () => {
    const paged = await search({ limit: 1 });
    expect(paged.text).toContain(`Next cursor: ${paged.out.next_cursor}`);
    const whole = await search({ country: 'DE' });
    expect(whole.text).not.toContain('Next cursor:');
  });

  it('strips inline tags at load so neither surface carries them', async () => {
    const { out, text } = await search({ query: 'lantern' });
    expect(out.sites[0]?.name).toBe('Lantern Bridge Quarter');
    expect(out.sites[0]?.description).toBe("Text with a 'quoted' word & more.\nSecond line here.");
    expect(text).not.toMatch(/<\/?(?:em|i|br)\b/i);
    expect(text).toContain('> Text with a');
    expect(text).toContain('> Second line here.');
  });

  it('flattens CR/LF in inline upstream text and quotes free text line by line', async () => {
    const injected = whcRow({
      id_no: '910',
      name_en: 'Evil\r\n# Injected Heading',
      states_names: ['State\r\nOne', 'State Two'],
      iso_codes: 'FR, DE',
      transboundary: 'True',
      short_description_en: 'First line.\n\n## Not A Heading\n- not a list',
    });
    useHub({ rows: { whc001: [injected] } });
    const { out, text } = await search();
    expect(out.sites[0]?.name).toBe('Evil\r\n# Injected Heading');
    const lines = text.split('\n');
    expect(lines).toContain('### Evil # Injected Heading (id_no 910)');
    expect(lines.some((l) => l.startsWith('# Injected'))).toBe(false);
    expect(text).toContain('State One (FR), State Two (DE)');
    const description = ['> First line.', '>', '> ## Not A Heading', '> - not a list'];
    const start = lines.indexOf(description[0] as string);
    expect(lines.slice(start, start + 4)).toEqual(description);
    expect(lines.some((l) => l === '## Not A Heading' || l === '- not a list')).toBe(false);
  });

  it('keeps a State Party name with line breaks out of the facets trailer lines', async () => {
    useHub({
      rows: {
        whc001: [
          whcRow({
            id_no: '911',
            states_names: ['Party\r\nName\r\n# Heading'],
            iso_codes: null,
          }),
        ],
      },
    });
    const { text } = await search();
    const lines = text.split('\n');
    expect(lines).toContain('- Top countries: Party Name # Heading 1');
    expect(lines.some((l) => l.startsWith('# Heading'))).toBe(false);
  });

  it('flattens line breaks in an echoed query inside the applied-filters trailer', async () => {
    const { text } = await search({ query: 'nomatch\n# Injected' });
    const lines = text.split('\n');
    expect(lines).toContain('- query: "nomatch # Injected"');
    expect(lines.some((l) => l.startsWith('# Injected'))).toBe(false);
  });

  it('never emits a raw carriage return or NEL outside quoted text', async () => {
    const nel = withCodePoints(0x85);
    const lineSep = withCodePoints(0x2028);
    useHub({
      rows: {
        whc001: [
          whcRow({
            id_no: '912',
            name_en: `A\rB${nel}C${lineSep}D`,
            states_names: [`X\r\nY${nel}Z`],
            iso_codes: null,
            short_description_en: `Para${nel}## H${lineSep}- item`,
          }),
        ],
      },
    });
    const { text } = await search();
    expect(text).not.toContain('\r');
    expect(text).not.toContain(nel);
    expect(text).not.toContain(lineSep);
    expect(text).toContain('### A B C D (id_no 912)');
    expect(text).toContain('> Para\n> ## H\n> - item');
  });

  it('renders format() output for a crafted result directly', () => {
    const format = searchSitesTool.format;
    expect(format).toBeDefined();
    const site = {
      id_no: '1',
      name: 'Line\nOne\r\n# Two',
      category: 'Cultural',
      states: ['S\nA', 'S B'],
      country_codes: ['AA'],
      region: 'Africa',
      transboundary: true,
      inscribed_year: 2000,
      criteria: ['vi'],
      criteria_inferred: ['vi'],
      in_danger: true,
      distance_km: 12.5,
      matched_in: 'name',
      description: 'd1\nd2',
    } satisfies SiteRow;
    const [block] = format?.({ sites: [site], next_cursor: 'abc' } as never) ?? [];
    const text = block?.type === 'text' ? block.text : '';
    const lines = text.split('\n');
    expect(lines).toContain('### Line One # Two (id_no 1)');
    expect(text).toContain('S A (AA), S B');
    expect(text).toContain('Criteria: vi (vi inferred)');
    expect(text).toContain('In Danger · Area: Not available');
    expect(text).toContain('Distance: 12.5 km');
    expect(text).toContain('Matched in: name');
    expect(text).toContain('> d1\n> d2');
    expect(lines.at(-1)).toBe('Next cursor: abc');
  });
});

describe('unesco_search_sites — upstream failures and lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('snapshot_unavailable: ServiceUnavailable with dataset, retryAfter, and the declared recovery', async () => {
    useHub({ intercept: () => httpFailure(404) });
    const result = await runToolContract(searchSitesTool, {});
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'snapshot_unavailable',
      dataset: 'whc001',
      retryAfter: 60,
      recovery: {
        hint: expect.stringContaining('could not be reached to load the World Heritage List'),
      },
    });
    expect(error.data?.recovery?.hint).toContain('call unesco_search_sites again');
    expect(allText(result)).toContain('Recovery: The UNESCO Data Hub could not be reached');
  });

  it('fails fast on later calls during the backoff without touching the upstream', async () => {
    const hub = useHub({ intercept: () => httpFailure(404) });
    await runToolContract(searchSitesTool, {});
    const calls = hub.calls.length;
    const again = errorOf(await runToolContract(searchSitesTool, { country: 'DE' }));
    expect(again.data?.reason).toBe('snapshot_unavailable');
    expect(hub.calls).toHaveLength(calls);
  });

  it('validates input before touching the upstream', async () => {
    const hub = useHub();
    await runToolContract(searchSitesTool, { inscribed_from: 2010, inscribed_to: 2000 });
    await runToolContract(searchSitesTool, { sort: 'distance' });
    expect(hub.calls).toHaveLength(0);
  });

  const cases: [string, NonNullable<HubOptions['intercept']>][] = [
    ['a 404', () => httpFailure(404)],
    ['a 429 with a long Retry-After', () => httpFailure(429, { 'retry-after': '3600' })],
    ['a 503', () => httpFailure(503)],
    [
      'an HTML body with a 200',
      (call) =>
        call.kind === 'export' ? new Response('<html>oops</html>', { status: 200 }) : undefined,
    ],
    [
      'a metadata document of the wrong shape',
      (call) => (call.kind === 'meta' ? Response.json({ nope: true }) : undefined),
    ],
    [
      'a timeout',
      () => {
        throw new McpError(JsonRpcErrorCode.Timeout, 'The request timed out.');
      },
    ],
  ];

  it.each(cases)('reports %s as snapshot_unavailable', async (_label, intercept) => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    useHub({ intercept });
    const pending = runToolContract(searchSitesTool, {});
    await vi.advanceTimersByTimeAsync(10_000);
    const error = errorOf(await pending);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'whc001' });
    expect(error.data?.recovery?.hint).toContain('unesco_search_sites');
  });

  it('reports a row-count mismatch as snapshot_unavailable', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    useHub({ metas: { whc001: { records_count: WHC_ROWS.length + 1 } } });
    const pending = runToolContract(searchSitesTool, {});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errorOf(await pending).data?.reason).toBe('snapshot_unavailable');
  });

  it('reports a license change as snapshot_unavailable', async () => {
    useHub({ metas: { whc001: { license: 'All rights reserved' } } });
    const error = errorOf(await runToolContract(searchSitesTool, {}));
    expect(error.data?.reason).toBe('snapshot_unavailable');
  });

  it('reports a schema-invalid row as snapshot_unavailable', async () => {
    useHub({ rows: { whc001: [whcRow({ region: 'Atlantis' })] } });
    const error = errorOf(await runToolContract(searchSitesTool, {}));
    expect(error.data?.reason).toBe('snapshot_unavailable');
  });

  it('does not let an unreadable intangible or biosphere dataset affect a site search', async () => {
    const hub = useHub({
      intercept: (call) => (call.dataset === 'whc001' ? undefined : httpFailure(404)),
    });
    const { out } = await search({ country: 'DE' });
    expect(out.totalCount).toBe(3);
    expect(hub.callsFor('ich001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
  });

  it('loads the snapshot once across repeated searches', async () => {
    const hub = useHub();
    await search();
    await search({ country: 'DE' });
    expect(hub.callsFor('whc001', 'export')).toHaveLength(1);
  });

  it('does not treat a cancelled request as an upstream failure', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hub = useHub({
      intercept: async (call) => {
        if (call.kind === 'export') await gate;
        return;
      },
    });
    const controller = new AbortController();
    const pending = runToolContract(
      searchSitesTool,
      {},
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(hub.callsFor('whc001', 'export')).toHaveLength(1));
    controller.abort(new Error('cancelled by caller'));
    const error = errorOf(await pending);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    release?.();
  });
});

describe('unesco_search_sites — empty dataset', () => {
  it('returns zero results with no notice and zeroed facets', async () => {
    useHub({ rows: { whc001: [] } });
    const { out } = await search();
    expect(out.sites).toEqual([]);
    expect(out).toMatchObject({ totalCount: 0, shown: 0, truncated: false });
    expect(out.notice).toBeUndefined();
    expect(out.facets.top_countries).toEqual([]);
    expect(out.facets.category).toEqual({ Cultural: 0, Natural: 0, Mixed: 0 });
  });

  it('rejects a country with no record as unknown only when it is not an assigned code', async () => {
    useHub({ rows: { whc001: [] } });
    const zz = errorOf(await runToolContract(searchSitesTool, { country: 'ZZ' }));
    expect(zz.data?.reason).toBe('unknown_country');
    const fr = await search({ country: 'FR' });
    expect(fr.out.totalCount).toBe(0);
  });
});
