/**
 * @fileoverview Tests for unesco_search_intangible_heritage: blank-as-unset
 * inputs, keyword tiers, country/list/multinational/linked-site/year filters,
 * sorting, pagination and cursors, facets, zero-hit notices, the declared
 * error contracts, the required-enrichment contract on the zero-result and
 * under-cap pages, upstream failure classes, format() parity with
 * structuredContent, and CR/LF in upstream text staying out of inline slots.
 * @module tests/tools/search-intangible-heritage.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchIntangibleHeritageTool as tool } from '@/mcp-server/tools/definitions/search-intangible-heritage.tool.js';
import { makeCursor, readCursor } from '@/services/unesco-datahub/search.js';
import { getUnescoDataHubService } from '@/services/unesco-datahub/unesco-datahub-service.js';
import { declaredRecovery } from '../fixtures/contract.js';
import { failureCases, settle, withFakeTimers } from '../fixtures/failures.js';
import { httpFailure } from '../fixtures/hub.js';
import { manyIchRows } from '../fixtures/paging.js';
import { ICH_ROWS, ichRow } from '../fixtures/rows.js';
import {
  allText,
  disposeServiceAfterEach,
  errorOf,
  structured,
  textBlocks,
  useHub,
} from '../fixtures/tool.js';

interface Element {
  concepts: string[];
  countries: string[];
  country_codes: string[];
  ich_ref: string;
  inscribed_year: number;
  list: string;
  matched_in?: string;
  multinational: boolean;
  name: string;
  world_heritage_sites: { id_no: string; name: string }[];
}

interface SearchOutput {
  applied_filters: Record<string, unknown> & { limit: number; sort: string };
  cap: number;
  elements: Element[];
  facets: {
    list: Record<string, number>;
    multinational: { false: number; true: number };
    top_concepts: { count: number; term: string }[];
    top_countries: { code: string; count: number; name: string }[];
  };
  next_cursor?: string;
  notice?: string;
  shown: number;
  sources: { dataset: string }[];
  totalCount: number;
  truncated: boolean;
}

disposeServiceAfterEach();

const search = async (input: Record<string, unknown> = {}) => {
  const result = await runToolContract(tool, input as never);
  return { result, out: structured<SearchOutput>(result), text: allText(result) };
};

const refs = (out: SearchOutput) => out.elements.map((e) => e.ich_ref);

/** Every page of a walk, following next_cursor until it is absent. */
async function walk(input: Record<string, unknown>) {
  const pages: SearchOutput[] = [];
  let cursor: string | undefined;
  do {
    const { out } = await search({ ...input, ...(cursor ? { cursor } : {}) });
    pages.push(out);
    cursor = out.next_cursor;
  } while (cursor);
  return pages;
}

describe('unesco_search_intangible_heritage — basics', () => {
  beforeEach(() => {
    useHub();
  });

  it('lists every element by name when no filter is set', async () => {
    const { out } = await search();
    expect(refs(out)).toEqual(['1003', '1002', '1001']);
    expect(out.totalCount).toBe(3);
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 20 });
    expect(out.sources).toEqual([expect.objectContaining({ dataset: 'ich001' })]);
    expect(out.elements[0]).not.toHaveProperty('matched_in');
    expect(out.elements[0]).not.toHaveProperty('description');
  });

  it('returns each element row with aligned codes, names, concepts, and linked sites', async () => {
    const { out } = await search({ query: 'weaving' });
    expect(out.elements).toEqual([
      {
        ich_ref: '1001',
        name: 'Synthetic Weaving Rite',
        list: 'Representative List',
        country_codes: ['FR', 'BE'],
        countries: ['France', 'Belgium'],
        multinational: true,
        inscribed_year: 2010,
        concepts: ['Textile craft'],
        world_heritage_sites: [
          { id_no: '101', name: 'Alderfen Old Town' },
          { id_no: '102', name: 'Brindle Frontier Forest' },
        ],
        matched_in: 'name',
      },
    ]);
  });

  it('reads blank strings on every optional input as unset', async () => {
    const { out } = await search({
      query: '',
      country: '  ',
      list: '',
      multinational: '',
      world_heritage_site: ' ',
      inscribed_from: '',
      inscribed_to: '',
      sort: '',
      limit: '',
      cursor: '',
    });
    expect(out.totalCount).toBe(3);
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 20 });
    expect(out.next_cursor).toBeUndefined();
  });

  it.each([
    ['limit 0', { limit: 0 }],
    ['limit 51', { limit: 51 }],
    ['a fractional limit', { limit: 2.5 }],
    ['a string limit', { limit: '10' }],
    ['a country over 64 characters', { country: 'A'.repeat(65) }],
    ['an unknown list', { list: 'Unlisted' }],
    ['an unknown sort', { sort: 'popularity' }],
    ['a non-boolean multinational', { multinational: 'yes' }],
    ['a non-numeric world_heritage_site', { world_heritage_site: 'abc' }],
    ['a year below 1900', { inscribed_from: 1899 }],
    ['a year above 2100', { inscribed_to: 2101 }],
    ['a fractional year', { inscribed_from: 2010.5 }],
    ['a query over 200 characters', { query: 'a'.repeat(201) }],
    ['a cursor over 1024 characters', { cursor: 'a'.repeat(1025) }],
  ])('rejects %s as invalid arguments', async (_label, input) => {
    const error = errorOf(await runToolContract(tool, input as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });
});

describe('unesco_search_intangible_heritage — keyword query', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['an English name word', 'weaving', ['1001'], 'name'],
    ['a word prefix', 'weav', ['1001'], 'name'],
    ['a French name word', 'tissage', ['1001'], 'name'],
    ['an accented word typed without its accent', 'synthetique', ['1003', '1002', '1001'], 'name'],
    ['a concept term', 'textile', ['1001'], 'concepts'],
    ['a secondary concept term', 'ritual', ['1001'], 'concepts'],
    ['a description word', 'paragraph', ['1001'], 'description'],
    ['words matching in different tiers', 'weaving textile', ['1001'], 'concepts'],
    ['a name word and a description word', 'weaving paragraph', ['1001'], 'description'],
  ])('matches %s', async (_label, query, expected, tier) => {
    const { out } = await search({ query });
    expect(refs(out)).toEqual(expected);
    expect(new Set(out.elements.map((e) => e.matched_in))).toEqual(
      new Set(expected.length === 3 ? ['name'] : [tier]),
    );
  });

  it('requires every word to match and matches only at the start of a word', async () => {
    expect(refs((await search({ query: 'weaving practice' })).out)).toEqual([]);
    expect(refs((await search({ query: 'eaving' })).out)).toEqual([]);
    expect(refs((await search({ query: 'craft' })).out)).toEqual(['1003', '1001']);
  });

  it('ignores case, surrounding whitespace, and punctuation in the query', async () => {
    const { out } = await search({ query: '  WEAVING, Rite!  ' });
    expect(refs(out)).toEqual(['1001']);
    expect(out.applied_filters.query).toBe('WEAVING, Rite!');
  });

  it('ranks name matches before concept and description matches, then by name', async () => {
    useHub({
      rows: {
        ich001: [
          ichRow({ ich_public_ref: '1', title_en: 'Zeta Practice', title_fr: 'Zeta' }),
          ichRow({
            ich_public_ref: '2',
            title_en: 'Beta Rite',
            title_fr: 'Beta',
            concepts_primary_names: ['Practice lore'],
            description_en: 'Nothing.',
          }),
          ichRow({
            ich_public_ref: '3',
            title_en: 'Alpha Rite',
            title_fr: 'Alpha',
            concepts_primary_names: null,
            description_en: 'A practice described.',
          }),
          ichRow({
            ich_public_ref: '4',
            title_en: 'Gamma Rite',
            title_fr: 'Gamma',
            concepts_primary_names: null,
            description_en: 'Plain practice text.',
          }),
        ],
      },
    });
    const { out } = await search({ query: 'practice' });
    expect(out.elements.map((e) => [e.ich_ref, e.matched_in])).toEqual([
      ['1', 'name'],
      ['2', 'concepts'],
      ['3', 'description'],
      ['4', 'description'],
    ]);
    expect(out.applied_filters.sort).toBe('relevance');
  });

  it('matches a CJK word as a substring', async () => {
    useHub({
      rows: {
        ich001: [
          ichRow({ ich_public_ref: '5', title_en: '織物の儀式', title_fr: 'Tissage' }),
          ichRow({ ich_public_ref: '6', title_en: 'Other', title_fr: 'Autre' }),
        ],
      },
    });
    expect(refs((await search({ query: '物の' })).out)).toEqual(['5']);
  });

  it.each([
    ['punctuation only', '!!! ???'],
    ['a combining mark only', String.fromCharCode(0x301)],
  ])('rejects a query of %s rather than reading it as unset', async (_label, query) => {
    const error = errorOf(await runToolContract(tool, { query } as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(allText(await runToolContract(tool, { query } as never))).toContain('letter or digit');
  });
});

describe('unesco_search_intangible_heritage — filters', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['an alpha-2 code', 'FR', ['1001']],
    ['a lowercase code', 'fr', ['1001']],
    ['an alpha-3 code', 'FRA', ['1001']],
    ['a padded code', ' fra ', ['1001']],
    ['a code the element shares (not its first country)', 'BE', ['1001']],
    ['a single-country code', 'JP', ['1003']],
  ])('filters by country given as %s', async (_label, country, expected) => {
    const { out } = await search({ country });
    expect(refs(out)).toEqual(expected);
  });

  it('reports the resolved country in the applied filters', async () => {
    const { out } = await search({ country: 'fra' });
    expect(out.applied_filters.country).toEqual({ code: 'FR', name: 'France' });
  });

  it('maps UK to GB', async () => {
    const { out } = await search({ country: 'uk' });
    expect(out.applied_filters.country).toEqual({ code: 'GB', name: 'United Kingdom' });
    expect(out.totalCount).toBe(0);
  });

  it.each([
    ['an unassigned code', 'ZZ'],
    ['a country name', 'Atlantis'],
    ['an unassigned alpha-3 code', 'ZZZ'],
    ['a digit string', '250'],
  ])('rejects %s as unknown_country with the declared recovery', async (_label, country) => {
    const result = await runToolContract(tool, { country } as never);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unknown_country',
      recovery: { hint: declaredRecovery(tool.errors, 'unknown_country') },
    });
    expect(allText(result)).toContain('Recovery: Call unesco_list_reference');
  });

  it('accepts an unassigned code that a loaded record carries', async () => {
    useHub({ rows: { ich001: [ichRow({ ich_public_ref: '8', countries: ['XK'] })] } });
    const { out } = await search({ country: 'xk' });
    expect(refs(out)).toEqual(['8']);
    expect(out.elements[0]?.country_codes).toEqual(['XK']);
  });

  it.each([
    ['the full name', 'Urgent Safeguarding List', ['1002']],
    ['a lowercase name', 'representative list', ['1001']],
    ['the RL acronym', 'RL', ['1001']],
    ['a lowercase USL acronym', 'usl', ['1002']],
    ['a mixed-case Art18 acronym', 'aRt18', ['1003']],
    ['a padded name', '  Register of Good Safeguarding Practices ', ['1003']],
  ])('filters by list given as %s', async (_label, list, expected) => {
    const { out } = await search({ list });
    expect(refs(out)).toEqual(expected);
    expect(out.applied_filters.list).toBe(out.elements[0]?.list);
  });

  it('filters by multinational status in both directions', async () => {
    expect(refs((await search({ multinational: true })).out)).toEqual(['1001']);
    expect(refs((await search({ multinational: false })).out)).toEqual(['1003', '1002']);
  });

  it.each([
    ['a number', 101],
    ['a digit string', '101'],
    ['a padded string', '0101'],
    ['the site page URL', 'https://whc.unesco.org/en/list/101/'],
    ['a localized page URL without a scheme', 'whc.unesco.org/fr/list/0101'],
  ])('filters by linked World Heritage site given as %s', async (_label, world_heritage_site) => {
    const { out } = await search({ world_heritage_site });
    expect(refs(out)).toEqual(['1001']);
    expect(out.applied_filters.world_heritage_site).toBe('101');
  });

  it('matches a linked site whose ref the upstream wrote as a number', async () => {
    const { out } = await search({ world_heritage_site: '102' });
    expect(refs(out)).toEqual(['1001']);
  });

  it('filters by inscription years, inclusive at both ends', async () => {
    expect(refs((await search({ inscribed_from: 2010 })).out)).toEqual(['1003', '1001']);
    expect(refs((await search({ inscribed_to: 2010 })).out)).toEqual(['1002', '1001']);
    expect(refs((await search({ inscribed_from: 2010, inscribed_to: 2010 })).out)).toEqual([
      '1001',
    ]);
    expect(refs((await search({ inscribed_from: 2008, inscribed_to: 2015 })).out)).toHaveLength(3);
  });

  it('rejects an inverted year range with the declared recovery', async () => {
    const result = await runToolContract(tool, { inscribed_from: 2015, inscribed_to: 2010 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_year_range',
      recovery: { hint: declaredRecovery(tool.errors, 'invalid_year_range') },
    });
  });

  it('combines filters with AND', async () => {
    expect(refs((await search({ country: 'FR', list: 'RL', multinational: true })).out)).toEqual([
      '1001',
    ]);
    expect((await search({ country: 'FR', list: 'USL' })).out.totalCount).toBe(0);
  });
});

describe('unesco_search_intangible_heritage — sorting', () => {
  beforeEach(() => {
    useHub();
  });

  it('sorts by inscription year, newest and oldest first', async () => {
    expect(refs((await search({ sort: 'inscribed_newest' })).out)).toEqual([
      '1003',
      '1001',
      '1002',
    ]);
    expect(refs((await search({ sort: 'inscribed_oldest' })).out)).toEqual([
      '1002',
      '1001',
      '1003',
    ]);
  });

  it('resolves the default sort to relevance with a query and to name without one', async () => {
    expect((await search({ query: 'synthetic' })).out.applied_filters.sort).toBe('relevance');
    expect((await search()).out.applied_filters.sort).toBe('name');
    expect((await search({ query: 'synthetic', sort: 'name' })).out.applied_filters.sort).toBe(
      'name',
    );
  });

  it('breaks ties on the numeric ref, not the text of it', async () => {
    useHub({
      rows: {
        ich001: [
          ichRow({
            ich_public_ref: '10',
            title_en: 'Same Name',
            title_fr: 'A',
            inscription_year: '2012',
          }),
          ichRow({
            ich_public_ref: '9',
            title_en: 'Same Name',
            title_fr: 'B',
            inscription_year: '2012',
          }),
          ichRow({
            ich_public_ref: '100',
            title_en: 'Same Name',
            title_fr: 'C',
            inscription_year: '2012',
          }),
        ],
      },
    });
    expect(refs((await search()).out)).toEqual(['9', '10', '100']);
    expect(refs((await search({ sort: 'inscribed_newest' })).out)).toEqual(['9', '10', '100']);
    expect(refs((await search({ sort: 'inscribed_oldest' })).out)).toEqual(['9', '10', '100']);
  });

  it.each([
    ['sort relevance with no query', { sort: 'relevance' }],
    ['sort relevance with a blank query', { sort: 'relevance', query: '   ' }],
  ])('rejects %s as sort_needs_input with the declared recovery', async (_label, input) => {
    const result = await runToolContract(tool, input as never);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'sort_needs_input',
      recovery: { hint: declaredRecovery(tool.errors, 'sort_needs_input') },
    });
    expect(allText(result)).toContain('(reason sort_needs_input)');
  });
});

describe('unesco_search_intangible_heritage — facets', () => {
  it('counts over the whole match, with a multinational element counted once per country', async () => {
    useHub();
    const { out } = await search();
    expect(out.facets).toEqual({
      list: {
        'Representative List': 1,
        'Urgent Safeguarding List': 1,
        'Register of Good Safeguarding Practices': 1,
      },
      multinational: { true: 1, false: 2 },
      top_countries: [
        { code: 'BE', name: 'Belgium', count: 1 },
        { code: 'ET', name: 'Ethiopia', count: 1 },
        { code: 'FR', name: 'France', count: 1 },
        { code: 'JP', name: 'Japan', count: 1 },
      ],
      top_concepts: [
        { term: 'Craft', count: 1 },
        { term: 'Textile craft', count: 1 },
      ],
    });
  });

  it('counts across pages, not just the shown page, and orders by count then code', async () => {
    useHub({ rows: { ich001: manyIchRows(45) } });
    const { out } = await search({ limit: 10 });
    expect(out.elements).toHaveLength(10);
    expect(Object.values(out.facets.list).reduce((a, b) => a + b, 0)).toBe(45);
    expect(out.facets.multinational).toEqual({ true: 9, false: 36 });
    expect(out.facets.top_countries.map((c) => [c.code, c.count])).toEqual([
      ['DE', 15],
      ['FR', 15],
      ['JP', 15],
      ['BE', 9],
    ]);
    expect(out.facets.top_concepts).toEqual([
      { term: 'Weaving', count: 23 },
      { term: 'Chanting', count: 22 },
    ]);
  });

  it('caps top countries and top concepts at ten', async () => {
    const codes = ['FR', 'DE', 'JP', 'ET', 'PE', 'PL', 'BE', 'IT', 'ES', 'PT', 'NL', 'AT'];
    useHub({
      rows: {
        ich001: codes.map((code, i) =>
          ichRow({
            ich_public_ref: String(i + 1),
            title_en: `Rite ${i}`,
            countries: [code],
            concepts_primary_names: [`Concept ${String(i).padStart(2, '0')}`],
          }),
        ),
      },
    });
    const { out } = await search();
    expect(out.facets.top_countries).toHaveLength(10);
    expect(out.facets.top_concepts).toHaveLength(10);
    expect(out.totalCount).toBe(12);
  });

  it('counts a concept once per element even when the element lists it twice', async () => {
    useHub({
      rows: {
        ich001: [ichRow({ ich_public_ref: '1', concepts_primary_names: ['Dup', 'Dup'] })],
      },
    });
    const { out } = await search();
    expect(out.facets.top_concepts).toEqual([{ term: 'Dup', count: 1 }]);
  });

  it('returns every primary concept term on the row, uncapped', async () => {
    const terms = Array.from({ length: 7 }, (_, i) => `Term ${i + 1}`);
    useHub({ rows: { ich001: [ichRow({ ich_public_ref: '1', concepts_primary_names: terms })] } });
    const { out, text } = await search();
    expect(out.elements[0]?.concepts).toEqual(terms);
    expect(text).toContain(`Concepts: ${terms.join(', ')}`);
  });
});

describe('unesco_search_intangible_heritage — pagination and cursors', () => {
  beforeEach(() => {
    useHub({ rows: { ich001: manyIchRows(45) } });
  });

  it('pages through the whole match with stable order, no gaps, and no repeats', async () => {
    const pages = await walk({ limit: 10 });
    expect(pages.map((p) => p.elements.length)).toEqual([10, 10, 10, 10, 5]);
    const all = pages.flatMap(refs);
    expect(new Set(all).size).toBe(45);
    expect(all).toEqual(Array.from({ length: 45 }, (_, i) => String(2001 + i)));
    expect(pages.every((p) => p.totalCount === 45)).toBe(true);
  });

  it('discloses truncation with the continuation notice on every page but the last', async () => {
    const pages = await walk({ limit: 10 });
    expect(pages[0]).toMatchObject({
      truncated: true,
      shown: 10,
      cap: 10,
      notice: 'Showing results 1–10 of 45; pass next_cursor to continue.',
    });
    expect(pages[1]?.notice).toBe('Showing results 11–20 of 45; pass next_cursor to continue.');
    const last = pages.at(-1) as SearchOutput;
    expect(last).toMatchObject({ truncated: false, shown: 5, cap: 10 });
    expect(last.notice).toBeUndefined();
    expect(last.next_cursor).toBeUndefined();
  });

  it('applies the default page size of 20', async () => {
    const { out } = await search();
    expect(out).toMatchObject({ shown: 20, cap: 20, truncated: true });
    expect(out.applied_filters.limit).toBe(20);
  });

  it('caps at 50 and ends without a cursor when everything fits', async () => {
    const { out } = await search({ limit: 50 });
    expect(out).toMatchObject({ shown: 45, cap: 50, truncated: false });
    expect(out.next_cursor).toBeUndefined();
  });

  it('ends without a cursor when the match is exactly one page', async () => {
    const { out } = await search({ limit: 45 });
    expect(out).toMatchObject({ shown: 45, truncated: false });
    expect(out.next_cursor).toBeUndefined();
  });

  it('keeps pages stable for a sort with many ties', async () => {
    const pages = await walk({ sort: 'inscribed_newest', limit: 7 });
    const paged = pages.flatMap(refs);
    const whole = refs((await search({ sort: 'inscribed_newest', limit: 50 })).out);
    expect(paged).toEqual(whole);
    expect(new Set(paged).size).toBe(45);
  });

  it('honors the limit of the call that carries the cursor', async () => {
    const first = (await search({ limit: 10 })).out;
    const { out } = await search({ limit: 20, cursor: first.next_cursor });
    expect(out.elements).toHaveLength(20);
    expect(refs(out)[0]).toBe('2011');
  });

  it('reads a blank cursor as no cursor', async () => {
    const { out } = await search({ limit: 10, cursor: '' });
    expect(refs(out)[0]).toBe('2001');
  });

  it.each([
    ['a different list', { list: 'RL' }],
    ['a different sort', { sort: 'inscribed_oldest' }],
    ['an added query', { query: 'loomvale' }],
    ['an added country', { country: 'FR' }],
    ['an added year bound', { inscribed_from: 2010 }],
    ['an added world_heritage_site', { world_heritage_site: '101' }],
    ['an added multinational filter', { multinational: true }],
  ])('rejects a cursor used with %s as cursor_mismatch', async (_label, change) => {
    const first = (await search({ limit: 10 })).out;
    const result = await runToolContract(tool, {
      limit: 10,
      ...change,
      cursor: first.next_cursor,
    } as never);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'cursor_mismatch',
      recovery: { hint: declaredRecovery(tool.errors, 'cursor_mismatch') },
    });
    expect(allText(result)).toContain('(reason cursor_mismatch)');
  });

  it('accepts a cursor when only spelling variants of the same filters changed', async () => {
    const first = (await search({ country: 'fr', list: 'rl', limit: 5 })).out;
    const { out } = await search({
      country: 'FRA',
      list: 'Representative List',
      limit: 5,
      cursor: first.next_cursor,
    });
    expect(out.elements.length).toBeGreaterThan(0);
  });

  it('rejects a cursor issued for an earlier data snapshot', async () => {
    const first = (await search({ limit: 10 })).out;
    getUnescoDataHubService().dispose();
    useHub({
      rows: { ich001: manyIchRows(45) },
      metas: { ich001: { data_processed: '2027-01-01T00:00:00+00:00' } },
    });
    const error = errorOf(
      await runToolContract(tool, { limit: 10, cursor: first.next_cursor } as never),
    );
    expect(error.data?.reason).toBe('cursor_mismatch');
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['an empty-looking token', '..'],
    ['valid base64 of a non-cursor', Buffer.from('{"x":1}').toString('base64url')],
  ])('rejects a malformed cursor (%s) as invalid_cursor', async (_label, cursor) => {
    const error = errorOf(await runToolContract(tool, { cursor } as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_cursor');
  });

  it('answers a cursor past the last result with an empty page and a restart notice', async () => {
    const first = (await search({ limit: 10 })).out;
    const state = readCursor(
      first.next_cursor as string,
      requestContextService.createRequestContext({ operation: 'test' }),
    );
    for (const offset of [45, 999]) {
      const cursor = makeCursor({ ...state, offset, limit: 10 });
      const { out } = await search({ limit: 10, cursor });
      expect(out.elements).toEqual([]);
      expect(out).toMatchObject({ totalCount: 45, shown: 0, truncated: false });
      expect(out.notice).toBe(
        'The cursor is past the last of 45 results. Call unesco_search_intangible_heritage without cursor to start over.',
      );
      expect(out.next_cursor).toBeUndefined();
    }
  });
});

describe('unesco_search_intangible_heritage — zero-result and under-cap pages (enrichment contract)', () => {
  beforeEach(() => {
    useHub();
  });

  it('zero-result page carries every required enrichment field, zeroed', async () => {
    const { result, out, text } = await search({ query: 'zzzz' });
    expect(result.isError).not.toBe(true);
    expect(out.elements).toEqual([]);
    expect(out).toMatchObject({ totalCount: 0, truncated: false, shown: 0, cap: 20 });
    expect(out.sources).toHaveLength(1);
    expect(out.applied_filters).toEqual({ query: 'zzzz', sort: 'relevance', limit: 20 });
    expect(out.facets).toEqual({
      list: {
        'Representative List': 0,
        'Urgent Safeguarding List': 0,
        'Register of Good Safeguarding Practices': 0,
      },
      multinational: { true: 0, false: 0 },
      top_countries: [],
      top_concepts: [],
    });
    expect(out.next_cursor).toBeUndefined();
    expect(text).toContain('**0 intangible heritage elements on this page**');
    expect(text).toContain('### Applied filters');
    expect(text).toContain('- Top countries: none');
    expect(text).toContain('Source: UNESCO — Intangible Heritage List (ich001)');
  });

  it('zero-result page with no filters at all (empty dataset) is still a valid result', async () => {
    useHub({ rows: { ich001: [] } });
    const { out } = await search();
    expect(out).toMatchObject({ totalCount: 0, shown: 0, truncated: false, cap: 20 });
    expect(out.notice).toBeUndefined();
    expect(out.facets.top_countries).toEqual([]);
  });

  it('under-cap page carries every required enrichment field and no continuation', async () => {
    const { result, out, text } = await search({ limit: 10 });
    expect(result.isError).not.toBe(true);
    expect(out.elements).toHaveLength(3);
    expect(out).toMatchObject({ totalCount: 3, truncated: false, shown: 3, cap: 10 });
    expect(out.notice).toBeUndefined();
    expect(out.next_cursor).toBeUndefined();
    expect(out.sources).toHaveLength(1);
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 10 });
    expect(Object.keys(out.facets).sort()).toEqual([
      'list',
      'multinational',
      'top_concepts',
      'top_countries',
    ]);
    expect(text).toContain('### Facets (whole match)');
    expect(text).toContain('- Multinational: yes 1 · no 2');
    expect(text).not.toContain('Next cursor');
  });

  it('under-cap page keeps notices that are not about paging', async () => {
    const { out } = await search({ inscribed_from: 2008, limit: 10 });
    expect(out).toMatchObject({ totalCount: 3, truncated: false, shown: 3 });
    expect(out.notice).toContain('dated 2008');
  });
});

describe('unesco_search_intangible_heritage — notices', () => {
  beforeEach(() => {
    useHub();
  });

  it('explains a keyword miss', async () => {
    const { out } = await search({ query: 'zzzz' });
    expect(out.notice).toBe(
      'No element\'s name, concept terms, or description contains every word of "zzzz" (each word matches at the start of a word, and all are required). Try fewer or broader words.',
    );
  });

  it('explains a country with no elements', async () => {
    const { out } = await search({ country: 'GB' });
    expect(out.notice).toContain(
      'No intangible heritage element lists GB (United Kingdom) among its countries.',
    );
    expect(out.notice).toContain('unesco_list_reference with topic countries');
  });

  it('explains a linked-site miss with the count of linked elements', async () => {
    const { out } = await search({ world_heritage_site: 999 });
    expect(out.notice).toMatch(
      /^No intangible heritage element links to World Heritage site 999; 1 elements? (?:carry|carries) such a link\. Confirm the id_no with unesco_get_site, or search by keyword instead\.$/,
    );
  });

  it('names the filter whose removal recovers the most elements', async () => {
    const { out } = await search({ country: 'BE', list: 'USL' });
    expect(out.totalCount).toBe(0);
    expect(out.notice).toMatch(
      /^No element matched all 2 filters\. Removing country alone would match 1 elements?\.$/,
    );
  });

  it('reports no single removal when none would help, then each cause in order', async () => {
    const { out } = await search({ country: 'GB', query: 'zzzz' });
    const notice = out.notice ?? '';
    expect(notice.startsWith('No element matched all 2 filters. No intangible heritage')).toBe(
      true,
    );
    expect(notice).not.toContain('Removing');
    const country = notice.indexOf('lists GB (United Kingdom)');
    const query = notice.indexOf('contains every word of "zzzz"');
    expect(country).toBeGreaterThan(0);
    expect(query).toBeGreaterThan(country);
  });

  it('recommends the year filter to drop when the range alone empties the match', async () => {
    const { out } = await search({ inscribed_from: 2005, inscribed_to: 2007 });
    expect(out.totalCount).toBe(0);
    expect(out.notice).toMatch(
      /^No element matched all 2 filters\. Removing inscribed_to alone would match 3 elements\.$/,
    );
  });

  it.each([
    ['from before 2008 up to it', { inscribed_from: 2000, inscribed_to: 2008 }, true],
    ['an open upper bound reaching past 2008', { inscribed_from: 2005 }, true],
    ['an open lower bound reaching 2008', { inscribed_to: 2012 }, true],
    ['exactly 2008', { inscribed_from: 2008, inscribed_to: 2008 }, true],
    ['starting after 2008', { inscribed_from: 2009 }, false],
    ['ending before 2008', { inscribed_to: 2007 }, false],
    ['a range wholly after 2008', { inscribed_from: 2009, inscribed_to: 2020 }, false],
    ['no year bound at all', {}, false],
  ])('the 2008 notice for %s: present=%s', async (_label, input, present) => {
    const { out } = await search(input);
    const notice = out.notice ?? '';
    if (present) {
      expect(notice).toContain(
        'The 1 element dated 2008 was incorporated into the Representative List that year; UNESCO had proclaimed it earlier, and the data does not carry the proclamation year.',
      );
    } else {
      expect(notice).not.toContain('2008');
    }
  });

  it('joins the 2008 notice with the continuation notice on a truncated page', async () => {
    useHub({ rows: { ich001: manyIchRows(45) } });
    const { out } = await search({ inscribed_from: 2005, limit: 10 });
    expect(out.notice).toContain('incorporated into the Representative List');
    expect(out.notice?.endsWith('pass next_cursor to continue.')).toBe(true);
    expect(out.truncated).toBe(true);
  });
});

describe('unesco_search_intangible_heritage — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(failureCases('ich001', ICH_ROWS.length))(
    'reports %s as snapshot_unavailable',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const result = await settle(runToolContract(tool, {}));
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'ich001' });
      expect(error.data?.recovery?.hint).toContain('unesco_search_intangible_heritage');
    },
  );

  it('declares the recovery on the wire for a plain failure', async () => {
    useHub({ intercept: () => httpFailure(404) });
    const result = await runToolContract(tool, {});
    const error = errorOf(result);
    expect(error.data).toMatchObject({
      reason: 'snapshot_unavailable',
      retryAfter: 60,
      recovery: { hint: declaredRecovery(tool.errors, 'snapshot_unavailable') },
    });
  });

  it('validates input before touching the upstream', async () => {
    const hub = useHub({ intercept: () => httpFailure(404) });
    const error = errorOf(
      await runToolContract(tool, { inscribed_from: 2015, inscribed_to: 2010 }),
    );
    expect(error.data?.reason).toBe('invalid_year_range');
    expect(hub.calls).toHaveLength(0);
  });

  it('does not read the sibling datasets', async () => {
    const hub = useHub();
    await search();
    expect(hub.callsFor('whc001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
  });
});

describe('unesco_search_intangible_heritage — format() parity and text safety', () => {
  beforeEach(() => {
    useHub();
  });

  it('renders every structured field of every element', async () => {
    const { result, out, text } = await search();
    const body = textBlocks(result)[0] ?? '';
    expect(body).toContain('**3 intangible heritage elements on this page**');
    for (const e of out.elements) {
      expect(body).toContain(`### ${e.name} (ich_ref ${e.ich_ref})`);
      expect(body).toContain(e.list);
      expect(body).toContain(`Inscribed ${e.inscribed_year}`);
      e.country_codes.forEach((code, i) => {
        expect(body).toContain(`${e.countries[i]} (${code})`);
      });
      for (const concept of e.concepts) expect(body).toContain(concept);
      for (const s of e.world_heritage_sites) expect(body).toContain(`${s.id_no} ${s.name}`);
    }
    expect(body).toContain('Multinational');
    expect(body).toContain('Concepts: None recorded');
    expect(body).toContain('No linked World Heritage site');
    expect(text).toContain('Source: UNESCO — Intangible Heritage List (ich001)');
  });

  it('shows the matched tier only when a query is set', async () => {
    expect((await search()).text).not.toContain('Matched in:');
    expect((await search({ query: 'textile' })).text).toContain('Matched in: concepts');
  });

  it('carries the applied filters and facets to content-only clients', async () => {
    const { text } = await search({ country: 'fr', query: 'weaving' });
    expect(text).toContain('- query: "weaving"');
    expect(text).toContain('- country: FR (France)');
    expect(text).toContain('- sort: relevance');
    expect(text).toContain('- List: Representative List 1');
    expect(text).toContain('- Top countries: Belgium (BE) 1 · France (FR) 1');
    expect(text).toContain('- Top concepts: Textile craft 1');
  });

  it('closes a truncated page with the cursor and puts the same cursor in structuredContent', async () => {
    useHub({ rows: { ich001: manyIchRows(45) } });
    const { out, text } = await search({ limit: 10 });
    expect(text).toContain(`Next cursor: ${out.next_cursor}`);
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('Showing results 1–10 of 45; pass next_cursor to continue.');
  });

  it('flattens CR/LF in inline upstream text so it cannot start a markdown block', async () => {
    useHub({
      rows: {
        ich001: [
          ichRow({
            ich_public_ref: '77',
            title_en: 'Evil\r\n# Injected Heading',
            concepts_primary_names: ['Line\nOne', 'Two\r\n- item'],
            whc_sites: JSON.stringify([{ ref: '5', name_en: 'Site\r\n## Name' }]),
          }),
        ],
      },
    });
    const { out, text } = await search();
    expect(out.elements[0]?.name).toBe('Evil\r\n# Injected Heading');
    const lines = text.split('\n');
    expect(lines).toContain('### Evil # Injected Heading (ich_ref 77)');
    expect(text).toContain('Concepts: Line One, Two - item');
    expect(text).toContain('World Heritage sites: 5 Site ## Name');
    expect(text).toContain('- Top concepts: Line One 1 · Two - item 1');
    expect(lines.some((l) => /^#{1,2} (Injected|Name)/.test(l) || l.startsWith('- item'))).toBe(
      false,
    );
    expect(text).not.toContain('\r');
  });

  it('flattens CR/LF in the echoed query in the notice and the applied-filters trailer', async () => {
    const { out, text } = await search({ query: 'zzzz\r\n# Injected' });
    expect(out.notice).toContain('every word of "zzzz # Injected"');
    expect(out.applied_filters.query).toBe('zzzz\r\n# Injected');
    expect(text).toContain('- query: "zzzz # Injected"');
    expect(text.split('\n').some((l) => l.startsWith('# Injected'))).toBe(false);
    expect(text).not.toContain('\r');
  });
});
