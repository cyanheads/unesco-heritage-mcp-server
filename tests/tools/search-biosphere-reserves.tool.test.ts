/**
 * @fileoverview Tests for unesco_search_biosphere_reserves: blank-as-unset
 * inputs, keyword tiers, country/region/network/transboundary/SIDS/year
 * filters, the periodic-review row field and filters, distance search,
 * sorting, pagination and cursors (limit served as requested up to the
 * ceiling), facets, zero-hit notices, the declared error contracts, the
 * required-enrichment contract on the zero-result and under-cap pages,
 * upstream failure classes, format() parity with structuredContent, and CR/LF
 * in upstream text staying out of inline slots.
 * @module tests/tools/search-biosphere-reserves.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchBiosphereReservesTool as tool } from '@/mcp-server/tools/definitions/search-biosphere-reserves.tool.js';
import { fingerprint, makeCursor, readCursor } from '@/services/unesco-datahub/search.js';
import { getUnescoDataHubService } from '@/services/unesco-datahub/unesco-datahub-service.js';
import { declaredRecovery } from '../fixtures/contract.js';
import {
  contentFailureCases,
  expectContentFailure,
  settle,
  transportFailureCases,
  withFakeTimers,
} from '../fixtures/failures.js';
import { httpFailure, transientFailure } from '../fixtures/hub.js';
import { manyMabRows } from '../fixtures/paging.js';
import { MAB_REVIEW_ROWS, MAB_ROWS, mabRow } from '../fixtures/rows.js';
import {
  allText,
  disposeServiceAfterEach,
  errorOf,
  structured,
  textBlocks,
  useHub,
} from '../fixtures/tool.js';

interface Reserve {
  area_marine_hectares: number;
  area_total_hectares: number;
  country: string;
  country_code: string;
  designation_year: number;
  distance_km?: number;
  introduction: string;
  last_periodic_review_year?: number;
  latitude: number;
  longitude: number;
  mab_id: string;
  matched_in?: string;
  name: string;
  population_total: number;
  regional_network?: string;
  regions: string[];
  sids: boolean;
  transboundary: boolean;
}

interface SearchOutput {
  applied_filters: Record<string, unknown> & { limit: number; sort: string };
  cap: number;
  facets: {
    regional_network: Record<string, number>;
    region: Record<string, number>;
    sids: { false: number; true: number };
    top_countries: { code: string; count: number; name: string }[];
    transboundary: { false: number; true: number };
  };
  next_cursor?: string;
  notice?: string;
  reserves: Reserve[];
  shown: number;
  sources: { dataset: string }[];
  totalCount: number;
  truncated: boolean;
}

const EURO_MAB = 'Europe and North America Biosphere Reserve Network (EuroMAB)';

disposeServiceAfterEach();

const search = async (input: Record<string, unknown> = {}) => {
  const result = await runToolContract(tool, input as never);
  return { result, out: structured<SearchOutput>(result), text: allText(result) };
};

const ids = (out: SearchOutput) => out.reserves.map((r) => r.mab_id);

/** More pages than any walk in this file takes; a walk still holding a cursor past it never ends. */
const MAX_WALK_PAGES = 50;

/** Every page of a walk, following next_cursor until it is absent; fails past MAX_WALK_PAGES. */
async function walk(input: Record<string, unknown>) {
  const pages: SearchOutput[] = [];
  let cursor: string | undefined;
  do {
    const { out } = await search({ ...input, ...(cursor ? { cursor } : {}) });
    pages.push(out);
    cursor = out.next_cursor;
  } while (cursor && pages.length < MAX_WALK_PAGES);
  expect(
    cursor,
    `next_cursor still set after ${MAX_WALK_PAGES} pages of ${JSON.stringify(input)}`,
  ).toBeUndefined();
  return pages;
}

describe('unesco_search_biosphere_reserves — basics', () => {
  beforeEach(() => {
    useHub();
  });

  it('lists every reserve by name when no filter is set, ties broken by mab_id', async () => {
    const { out } = await search();
    expect(ids(out)).toEqual(['FRAlder1998', 'DEBrin1993', 'PLBrin1993', 'PEÑandu2001']);
    expect(out.totalCount).toBe(4);
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 20, include_description: true });
    expect(out.sources).toEqual([expect.objectContaining({ dataset: 'mab001' })]);
    expect(out.reserves[0]).not.toHaveProperty('matched_in');
    expect(out.reserves[0]).not.toHaveProperty('distance_km');
  });

  it('returns each reserve row as recorded, with the network absent where there is none', async () => {
    const { out } = await search();
    expect(out.reserves[0]).toEqual({
      mab_id: 'FRAlder1998',
      name: 'Alderfen Marsh Reserve',
      country_code: 'FR',
      country: 'France',
      regions: ['Europe and North America'],
      regional_network: EURO_MAB,
      designation_year: 1998,
      last_periodic_review_year: 2025,
      transboundary: false,
      sids: false,
      area_total_hectares: 5000,
      area_marine_hectares: 0,
      population_total: 1000,
      latitude: 48.5,
      longitude: 2.5,
      introduction: 'A synthetic reserve used as test data.',
    });
    const peru = out.reserves.find((r) => r.mab_id === 'PEÑandu2001') as Reserve;
    expect(peru).not.toHaveProperty('regional_network');
    expect(peru).not.toHaveProperty('last_periodic_review_year');
    expect(peru).toMatchObject({ latitude: -10, longitude: -75, country_code: 'PE' });
  });

  it('reads blank strings on every optional input as unset', async () => {
    const { out } = await search({
      query: '',
      country: '  ',
      region: '',
      regional_network: ' ',
      transboundary: '',
      sids: '',
      designated_from: '',
      designated_to: '',
      reviewed_from: '',
      reviewed_to: ' ',
      reviewed: '',
      near: '',
      sort: '',
      limit: '',
      cursor: '',
    });
    expect(out.totalCount).toBe(4);
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 20, include_description: true });
  });

  it.each([
    ['limit 0', { limit: 0 }],
    ['limit 10001', { limit: 10_001 }],
    ['a string limit', { limit: '10' }],
    ['a country over 64 characters', { country: 'A'.repeat(65) }],
    ['an unknown region', { region: 'Nowhere' }],
    ['an unknown network', { regional_network: 'FooMAB' }],
    ['an unknown sort', { sort: 'popularity' }],
    ['a non-boolean transboundary', { transboundary: 'yes' }],
    ['a non-boolean sids', { sids: 1 }],
    ['a year below 1900', { designated_from: 1899 }],
    ['a year above 2100', { designated_to: 2101 }],
    ['a review year below 1900', { reviewed_from: 1899 }],
    ['a review year above 2100', { reviewed_to: 2101 }],
    ['a fractional review year', { reviewed_to: 2015.5 }],
    ['the string "false" for reviewed', { reviewed: 'false' }],
    ['a number for reviewed', { reviewed: 0 }],
    ['a query over 200 characters', { query: 'a'.repeat(201) }],
    ['a query of punctuation only', { query: '!!!' }],
    ['a cursor over 1024 characters', { cursor: 'a'.repeat(1025) }],
  ])('rejects %s as invalid arguments', async (_label, input) => {
    const error = errorOf(await runToolContract(tool, input as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });
});

describe('unesco_search_biosphere_reserves — keyword query', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['a name word', 'alderfen', ['FRAlder1998'], 'name'],
    ['a hyphenated name word', 'cross border', ['DEBrin1993', 'PLBrin1993'], 'name'],
    ['a word prefix', 'alder', ['FRAlder1998'], 'name'],
    [
      'a word in every name',
      'reserve',
      ['FRAlder1998', 'DEBrin1993', 'PLBrin1993', 'PEÑandu2001'],
      'name',
    ],
    ['a name word typed without its diacritic', 'nandu', ['PEÑandu2001'], 'name'],
    ['a name word typed with its diacritic', 'ÑANDU', ['PEÑandu2001'], 'name'],
    [
      'an introduction word',
      'synthetic',
      ['FRAlder1998', 'DEBrin1993', 'PLBrin1993', 'PEÑandu2001'],
      'introduction',
    ],
    [
      'an ecological-characteristics word',
      'wetlands',
      ['DEBrin1993', 'PLBrin1993'],
      'characteristics',
    ],
    [
      'a socio-economic word',
      'villages',
      ['FRAlder1998', 'DEBrin1993', 'PLBrin1993'],
      'characteristics',
    ],
    ['words matching in different tiers', 'marsh core', ['FRAlder1998'], 'characteristics'],
  ])('matches %s', async (_label, query, expected, tier) => {
    const { out } = await search({ query });
    expect(ids(out)).toEqual(expected);
    expect(new Set(out.reserves.map((r) => r.matched_in))).toEqual(new Set([tier]));
  });

  it('requires every word and only matches at the start of a word', async () => {
    expect((await search({ query: 'alderfen wetlands' })).out.totalCount).toBe(0);
    expect((await search({ query: 'derfen' })).out.totalCount).toBe(0);
  });

  it('echoes the query trimmed and resolves the default sort to relevance', async () => {
    const { out } = await search({ query: '  Alderfen  ' });
    expect(out.applied_filters).toMatchObject({ query: 'Alderfen', sort: 'relevance' });
  });

  it('ranks name matches before introduction and characteristics matches, then by name', async () => {
    useHub({
      rows: {
        mab001: [
          mabRow({ mab_id: 'AA1', title_en: 'Zeta Fen', introduction_en: 'Nothing.' }),
          mabRow({
            mab_id: 'AA2',
            title_en: 'Alpha Wood',
            introduction_en: 'A fen described here.',
          }),
          mabRow({
            mab_id: 'AA3',
            title_en: 'Beta Wood',
            introduction_en: 'Nothing.',
            ecological_characteristics_en: 'Fen land.',
          }),
          mabRow({
            mab_id: 'AA4',
            title_en: 'Gamma Wood',
            introduction_en: 'Nothing.',
            ecological_characteristics_en: null,
            socio_economic_characteristics_en: 'Fen farming.',
          }),
        ],
      },
    });
    const { out } = await search({ query: 'fen' });
    expect(out.reserves.map((r) => [r.mab_id, r.matched_in])).toEqual([
      ['AA1', 'name'],
      ['AA2', 'introduction'],
      ['AA3', 'characteristics'],
      ['AA4', 'characteristics'],
    ]);
  });

  it('matches a reserve that has no ecological or socio-economic text by its name and introduction only', async () => {
    const { out } = await search({ query: 'highland' });
    expect(ids(out)).toEqual(['PEÑandu2001']);
    expect((await search({ query: 'highland wetlands' })).out.totalCount).toBe(0);
  });
});

describe('unesco_search_biosphere_reserves — filters', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['an alpha-2 code', 'PL', ['PLBrin1993']],
    ['a lowercase code', 'pl', ['PLBrin1993']],
    ['an alpha-3 code', 'POL', ['PLBrin1993']],
    ['a padded lowercase alpha-3 code', ' fra ', ['FRAlder1998']],
    ['a code on the accented reserve', 'PE', ['PEÑandu2001']],
  ])('filters by country given as %s', async (_label, country, expected) => {
    expect(ids((await search({ country })).out)).toEqual(expected);
  });

  it('reports the resolved country and maps UK to GB', async () => {
    expect((await search({ country: 'pol' })).out.applied_filters.country).toEqual({
      code: 'PL',
      name: 'Poland',
    });
    expect((await search({ country: 'uk' })).out.applied_filters.country).toEqual({
      code: 'GB',
      name: 'United Kingdom',
    });
  });

  it.each([
    ['an unassigned code', 'ZZ'],
    ['a country name', 'Poland'],
    ['an unassigned alpha-3 code', 'ZZZ'],
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
    useHub({ rows: { mab001: [mabRow({ mab_id: 'XKOne2000', iso2: 'XK' })] } });
    expect(ids((await search({ country: 'xk' })).out)).toEqual(['XKOne2000']);
  });

  it.each([
    ['a region name', 'Latin America and the Caribbean', ['PEÑandu2001']],
    [
      'a lowercase region name',
      'europe and north america',
      ['FRAlder1998', 'DEBrin1993', 'PLBrin1993'],
    ],
    ['a region code', 'LAC', ['PEÑandu2001']],
    ['a lowercase region code', 'eur', ['FRAlder1998', 'DEBrin1993', 'PLBrin1993']],
  ])('filters by region given as %s', async (_label, region, expected) => {
    expect(ids((await search({ region })).out)).toEqual(expected);
  });

  it('matches a reserve on any of its regions and counts it in each region facet', async () => {
    useHub({
      rows: {
        mab001: [
          mabRow({ mab_id: 'ZZTwo2000', regional_group: 'Africa,Arab States' }),
          mabRow({ mab_id: 'ZZOne2000', regional_group: 'Africa' }),
        ],
      },
    });
    expect(ids((await search({ region: 'ARB' })).out)).toEqual(['ZZTwo2000']);
    const { out } = await search({ region: 'AFR' });
    expect(ids(out)).toEqual(['ZZOne2000', 'ZZTwo2000']);
    expect(out.facets.region).toMatchObject({ Africa: 2, 'Arab States': 1 });
    expect(out.reserves.find((r) => r.mab_id === 'ZZTwo2000')?.regions).toEqual([
      'Africa',
      'Arab States',
    ]);
  });

  it.each([
    ['the acronym', 'EuroMAB'],
    ['a lowercase acronym', 'euromab'],
    ['the full name', EURO_MAB],
    ['a padded lowercase full name', `  ${EURO_MAB.toLowerCase()} `],
  ])('filters by regional network given as %s', async (_label, regional_network) => {
    const { out } = await search({ regional_network });
    expect(ids(out)).toEqual(['FRAlder1998', 'DEBrin1993', 'PLBrin1993']);
    expect(out.applied_filters.regional_network).toBe(EURO_MAB);
  });

  it('returns an empty page without a notice for a valid network no reserve belongs to', async () => {
    const { out } = await search({ regional_network: 'IberoMAB' });
    expect(out).toMatchObject({ totalCount: 0, shown: 0, truncated: false });
    expect(out.notice).toBeUndefined();
  });

  it('filters by transboundary and SIDS status in both directions', async () => {
    useHub({
      rows: {
        mab001: [...MAB_ROWS, mabRow({ mab_id: 'ZZIsle2000', title_en: 'Zzz Isle', sids: 'True' })],
      },
    });
    expect(ids((await search({ transboundary: true })).out)).toEqual(['DEBrin1993', 'PLBrin1993']);
    expect(ids((await search({ transboundary: false })).out)).toEqual([
      'FRAlder1998',
      'PEÑandu2001',
      'ZZIsle2000',
    ]);
    expect(ids((await search({ sids: true })).out)).toEqual(['ZZIsle2000']);
    expect((await search({ sids: false })).out.totalCount).toBe(4);
    expect((await search({ sids: true })).out.reserves[0]?.sids).toBe(true);
  });

  it('filters by designation years, inclusive at both ends', async () => {
    expect(ids((await search({ designated_from: 1998 })).out)).toEqual([
      'FRAlder1998',
      'PEÑandu2001',
    ]);
    expect(ids((await search({ designated_to: 1993 })).out)).toEqual(['DEBrin1993', 'PLBrin1993']);
    expect(ids((await search({ designated_from: 1993, designated_to: 1998 })).out)).toEqual([
      'FRAlder1998',
      'DEBrin1993',
      'PLBrin1993',
    ]);
    expect(ids((await search({ designated_from: 2001, designated_to: 2001 })).out)).toEqual([
      'PEÑandu2001',
    ]);
  });

  it('rejects an inverted year range with the declared recovery', async () => {
    const result = await runToolContract(tool, { designated_from: 2001, designated_to: 1998 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_year_range',
      recovery: { hint: declaredRecovery(tool.errors, 'invalid_year_range') },
    });
  });

  it.each([
    [
      'designated',
      { designated_from: 2001, designated_to: 1998 },
      'designated_from (2001) is later than designated_to (1998).',
    ],
    [
      'reviewed',
      { reviewed_from: 2020, reviewed_to: 2010 },
      'reviewed_from (2020) is later than reviewed_to (2010).',
    ],
  ])(
    'names the inverted %s pair in the message and both pairs in the recovery, on both surfaces',
    async (_label, input, message) => {
      const hub = useHub();
      const result = await runToolContract(tool, input as never);
      const error = errorOf(result);
      const recovery = declaredRecovery(tool.errors, 'invalid_year_range');
      expect(error.data?.reason).toBe('invalid_year_range');
      expect(error.message).toBe(message);
      for (const field of ['designated_from', 'designated_to', 'reviewed_from', 'reviewed_to']) {
        expect(recovery).toContain(field);
      }
      expect(error.data?.recovery?.hint).toBe(recovery);
      expect(allText(result)).toContain(message);
      expect(allText(result)).toContain(`Recovery: ${recovery}`);
      expect(hub.calls).toHaveLength(0);
    },
  );

  it('combines filters with AND', async () => {
    expect(
      ids((await search({ region: 'EUR', transboundary: true, designated_from: 1990 })).out),
    ).toEqual(['DEBrin1993', 'PLBrin1993']);
    expect((await search({ region: 'LAC', transboundary: true })).out.totalCount).toBe(0);
  });
});

describe('unesco_search_biosphere_reserves — periodic review', () => {
  /**
   * Reserves built here, in name order, so the cases read `periodic_review`
   * shapes the loader parses the same way with or without follow-up-report
   * handling: an out-of-order pair (latest listed first), three reviews, a
   * semicolon pair, one review, and none.
   */
  const REVIEW_ROWS = [
    mabRow({
      mab_id: 'ZZOrder2002',
      title_en: 'Aa Order Reserve',
      date: '2002-01-01',
      periodic_review: '2017, 2016',
    }),
    mabRow({
      mab_id: 'ZZThrice1990',
      title_en: 'Bb Thrice Reserve',
      date: '1990-01-01',
      periodic_review: '2003, 2013, 2023',
    }),
    mabRow({
      mab_id: 'ZZPair1977',
      title_en: 'Cc Pair Reserve',
      date: '1977-01-01',
      periodic_review: '1998; 2020',
    }),
    mabRow({
      mab_id: 'ZZOnce2000',
      title_en: 'Dd Once Reserve',
      date: '2000-01-01',
      periodic_review: '2015',
    }),
    mabRow({ mab_id: 'ZZNever1980', title_en: 'Ee Never Reserve', date: '1980-01-01' }),
    mabRow({ mab_id: 'ZZNever2019', title_en: 'Ff Never Reserve', date: '2019-01-01' }),
  ];
  const REVIEWED = ['ZZOrder2002', 'ZZThrice1990', 'ZZPair1977', 'ZZOnce2000'];
  const UNREVIEWED = ['ZZNever1980', 'ZZNever2019'];

  /** The facts line under a reserve's `### {name} ({mab_id})` heading. */
  const factsOf = (text: string, mabId: string) => {
    const lines = text.split('\n');
    const heading = lines.findIndex((l) => l.startsWith('### ') && l.endsWith(`(${mabId})`));
    expect(heading, mabId).toBeGreaterThanOrEqual(0);
    return lines[heading + 1] ?? '';
  };

  beforeEach(() => {
    useHub({ rows: { mab001: REVIEW_ROWS } });
  });

  it('carries the highest review year, not the last listed, and leaves it out when none is recorded', async () => {
    const { out, text } = await search();
    const byId = new Map(out.reserves.map((r) => [r.mab_id, r]));
    expect(REVIEWED.map((id) => byId.get(id)?.last_periodic_review_year)).toEqual([
      2017, 2023, 2020, 2015,
    ]);
    for (const id of UNREVIEWED) {
      expect(byId.get(id)).not.toHaveProperty('last_periodic_review_year');
    }
    expect(factsOf(text, 'ZZOrder2002')).toContain(
      'Designated 2002 · Last periodic review 2017 · Transboundary: No',
    );
    expect(factsOf(text, 'ZZThrice1990')).toContain('Last periodic review 2023 ·');
    expect(factsOf(text, 'ZZNever1980')).toContain(
      'Designated 1980 · No periodic review recorded · Transboundary: No',
    );
    expect(text).not.toContain('Last periodic review 2016');
  });

  it('advertises last_periodic_review_year as an optional number', () => {
    const json = z.toJSONSchema(tool.output, { io: 'output' }) as unknown as {
      properties: {
        reserves: { items: { properties: Record<string, { type?: string }>; required: string[] } };
      };
    };
    const row = json.properties.reserves.items;
    expect(row.properties.last_periodic_review_year?.type).toBe('number');
    expect(row.required).not.toContain('last_periodic_review_year');
  });

  it('filters by whether a review is recorded, in both directions', async () => {
    const yes = await search({ reviewed: true });
    expect(ids(yes.out)).toEqual(REVIEWED);
    expect(yes.out.applied_filters).toEqual({
      reviewed: true,
      sort: 'name',
      limit: 20,
      include_description: true,
    });
    expect(yes.text.split('\n')).toContain('- reviewed: true');
    const no = await search({ reviewed: false });
    expect(ids(no.out)).toEqual(UNREVIEWED);
    expect(no.out.applied_filters.reviewed).toBe(false);
    expect(no.text.split('\n')).toContain('- reviewed: false');
    expect(no.text).not.toContain('Last periodic review');
  });

  it.each([
    ['reviewed_from 2020, inclusive', { reviewed_from: 2020 }, ['ZZThrice1990', 'ZZPair1977']],
    ['reviewed_to 2015, inclusive', { reviewed_to: 2015 }, ['ZZOnce2000']],
    ['reviewed_to 2016, below the latest of 2017, 2016', { reviewed_to: 2016 }, ['ZZOnce2000']],
    ['reviewed_to 2017', { reviewed_to: 2017 }, ['ZZOrder2002', 'ZZOnce2000']],
    ['a one-year range', { reviewed_from: 2017, reviewed_to: 2017 }, ['ZZOrder2002']],
    ['the widest bounds', { reviewed_from: 1900, reviewed_to: 2100 }, REVIEWED],
    [
      'reviewed true with a bound',
      { reviewed: true, reviewed_from: 2020 },
      ['ZZThrice1990', 'ZZPair1977'],
    ],
  ])('bounds the latest review year only: %s', async (_label, input, expected) => {
    const { out } = await search(input);
    expect(ids(out)).toEqual(expected);
    for (const id of UNREVIEWED) expect(ids(out)).not.toContain(id);
  });

  it('echoes set bounds in applied_filters and the trailer, and adds no key when unset', async () => {
    const { out, text } = await search({ reviewed_from: 2000, reviewed_to: 2030, reviewed: true });
    expect(out.applied_filters).toEqual({
      reviewed_from: 2000,
      reviewed_to: 2030,
      reviewed: true,
      sort: 'name',
      limit: 20,
      include_description: true,
    });
    const lines = text.split('\n');
    expect(lines).toContain('- reviewed_from: 2000');
    expect(lines).toContain('- reviewed_to: 2030');
    expect(lines).toContain('- reviewed: true');
    const plain = await search({ designated_to: 2000 });
    expect(Object.keys(plain.out.applied_filters).filter((k) => k.startsWith('reviewed'))).toEqual(
      [],
    );
    expect(plain.text).not.toContain('- reviewed');
  });

  it.each([
    ['reviewed_to', { reviewed: false, reviewed_to: 2015 }],
    ['reviewed_from', { reviewed: false, reviewed_from: 2000 }],
    ['both bounds', { reviewed: false, reviewed_from: 2000, reviewed_to: 2015 }],
    ['reversed bounds', { reviewed: false, reviewed_from: 2020, reviewed_to: 2010 }],
  ])(
    'rejects reviewed false with %s as review_filter_conflict before loading',
    async (_label, input) => {
      const hub = useHub({ rows: { mab001: REVIEW_ROWS } });
      const result = await runToolContract(tool, input as never);
      const error = errorOf(result);
      const recovery = declaredRecovery(tool.errors, 'review_filter_conflict');
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'review_filter_conflict',
        recovery: { hint: recovery },
      });
      expect(error.message).toBe(
        'reviewed false keeps only reserves with no recorded periodic review, so reviewed_from and reviewed_to cannot apply.',
      );
      for (const field of ['reviewed', 'reviewed_from', 'reviewed_to']) {
        expect(recovery).toContain(field);
      }
      const text = allText(result);
      expect(text).toContain(`Recovery: ${recovery}`);
      expect(text).toContain('(reason review_filter_conflict');
      expect(hub.calls).toHaveLength(0);
    },
  );

  it('gives a review bound that alone matches nothing no fragment of its own', async () => {
    const { result, out } = await search({ reviewed_from: 2024 });
    expect(result.isError).not.toBe(true);
    expect(out).toMatchObject({ totalCount: 0, shown: 0, truncated: false, cap: 20 });
    expect(out.reserves).toEqual([]);
    expect(out.notice).toBeUndefined();
  });

  it.each([
    [
      'reviewed_from',
      { region: 'EUR', reviewed_from: 2024 },
      'No reserve matched all 2 filters. Removing reviewed_from alone would match 6 reserves.',
    ],
    [
      'reviewed_to',
      { region: 'EUR', reviewed_to: 1999 },
      'No reserve matched all 2 filters. Removing reviewed_to alone would match 6 reserves.',
    ],
    [
      // Designated 1985–2005: ZZOrder2002, ZZThrice1990, ZZOnce2000, all reviewed.
      'reviewed',
      { designated_from: 1985, designated_to: 2005, reviewed: false },
      'No reserve matched all 3 filters. Removing reviewed alone would match 3 reserves.',
    ],
  ])(
    'names %s as the filter whose removal recovers the most reserves, on both surfaces',
    async (_label, input, notice) => {
      const { out, text } = await search(input);
      expect(out.notice).toBe(notice);
      expect(text).toContain(notice);
    },
  );

  it('keeps a follow-up report year out of the latest review year and the review bounds', async () => {
    useHub({ rows: { mab001: MAB_REVIEW_ROWS } });
    const { out, text } = await search();
    expect(out.reserves.map((r) => [r.mab_id, r.last_periodic_review_year])).toEqual([
      ['IDFoll1981', 2013],
      ['FRFoll1979', 2014],
      ['FROrder2002', 2017],
    ]);
    expect(factsOf(text, 'FRFoll1979')).toContain(
      'Designated 1979 · Last periodic review 2014 · Transboundary: No',
    );
    expect(ids((await search({ reviewed_to: 2015 })).out)).toEqual(['IDFoll1981', 'FRFoll1979']);
  });

  describe('with cursors', () => {
    /** 45 paging rows, the even-numbered ones reviewed in 2000–2019. */
    const PAGED_ROWS = manyMabRows(45).map((row, i) => ({
      ...row,
      periodic_review: i % 2 === 0 ? String(2000 + (i % 20)) : null,
    }));
    const rc = () => requestContextService.createRequestContext({ operation: 'test' });

    beforeEach(() => {
      useHub({ rows: { mab001: PAGED_ROWS } });
    });

    it('pages a review filter through the whole match and past its end', async () => {
      const pages = await walk({ reviewed: true, limit: 10 });
      expect(pages.map((p) => p.reserves.length)).toEqual([10, 10, 3]);
      const rows = pages.flatMap((p) => p.reserves);
      expect(new Set(rows.map((r) => r.mab_id)).size).toBe(23);
      expect(rows.every((r) => r.last_periodic_review_year !== undefined)).toBe(true);
      expect(pages[0]).toMatchObject({ totalCount: 23, truncated: true, cap: 10 });
      const state = readCursor(pages[0]?.next_cursor as string, rc());
      const past = await search({
        reviewed: true,
        limit: 10,
        cursor: makeCursor({ ...state, offset: 23, limit: 10 }),
      });
      expect(past.out.reserves).toEqual([]);
      expect(past.out.notice).toBe(
        'The cursor is past the last of 23 results. Call unesco_search_biosphere_reserves without cursor to start over.',
      );
    });

    it.each([
      ['a changed bound', { reviewed_to: 2031 }],
      ['an added reviewed', { reviewed_to: 2030, reviewed: true }],
      ['a dropped bound', {}],
    ])('rejects a review-filtered cursor used with %s as cursor_mismatch', async (_label, next) => {
      const first = (await search({ reviewed_to: 2030, limit: 10 })).out;
      expect(first.next_cursor).toBeDefined();
      const error = errorOf(
        await runToolContract(tool, { limit: 10, ...next, cursor: first.next_cursor } as never),
      );
      expect(error.data?.reason).toBe('cursor_mismatch');
      const same = (await search({ reviewed_to: 2030, limit: 10, cursor: first.next_cursor })).out;
      expect(same.notice).toBe('Showing results 11–20 of 23; pass next_cursor to continue.');
    });

    it.each([
      ['no filter', {}, { sort: 'name' }],
      [
        'region and a designation bound',
        { region: 'EUR', designated_to: 1995 },
        { region: 'Europe and North America', designated_to: 1995, sort: 'name' },
      ],
    ])(
      'continues a cursor whose fingerprint predates the review filters, with %s',
      async (_label, filters, fingerprinted) => {
        const whole = (await walk({ ...filters, limit: 5 })).flatMap(ids);
        const first = (await search({ ...filters, limit: 5 })).out;
        const { asOf } = readCursor(first.next_cursor as string, rc());
        const legacy = makeCursor({ offset: 5, limit: 5, fp: fingerprint(fingerprinted), asOf });
        const { out } = await search({ ...filters, limit: 5, cursor: legacy });
        expect(ids(out)).toEqual(whole.slice(5, 10));
      },
    );
  });
});

describe('unesco_search_biosphere_reserves — distance search', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns distance_km in kilometres to 0.1, latitude before longitude', async () => {
    const { out } = await search({ near: { latitude: 49.5, longitude: 2.5, radius_km: 200 } });
    expect(ids(out)).toEqual(['FRAlder1998']);
    expect(out.reserves[0]?.distance_km).toBe(111.2);
    expect(out.applied_filters.near).toEqual({ latitude: 49.5, longitude: 2.5, radius_km: 200 });
    expect(out.applied_filters.sort).toBe('distance');
  });

  it('defaults the radius to 100 km, excluding a reserve just beyond it', async () => {
    const { out } = await search({ near: { latitude: 49.5, longitude: 2.5 } });
    expect(out.totalCount).toBe(0);
    expect(out.applied_filters.near).toEqual({ latitude: 49.5, longitude: 2.5, radius_km: 100 });
  });

  it('reads a blank radius_km as the default', async () => {
    const { out } = await search({ near: { latitude: 48.5, longitude: 2.5, radius_km: '' } });
    expect(ids(out)).toEqual(['FRAlder1998']);
    expect(out.applied_filters.near).toMatchObject({ radius_km: 100 });
    expect(out.reserves[0]?.distance_km).toBe(0);
  });

  it('reads a near object whose every field is blank as unset', async () => {
    const { out } = await search({ near: { latitude: '', longitude: '', radius_km: '' } });
    expect(out.totalCount).toBe(4);
    expect(out.applied_filters).not.toHaveProperty('near');
    expect(out.applied_filters.sort).toBe('name');
    expect(out.reserves[0]).not.toHaveProperty('distance_km');
  });

  it('orders by distance and breaks ties on mab_id', async () => {
    const { out } = await search({ near: { latitude: 52.5, longitude: 14.5, radius_km: 100 } });
    expect(ids(out)).toEqual(['DEBrin1993', 'PLBrin1993']);
    for (const r of out.reserves) {
      expect(r.distance_km).toBeGreaterThan(6);
      expect(r.distance_km).toBeLessThan(7.5);
    }
  });

  it('leaves out a reserve whose distance only rounds into the radius', async () => {
    const point = { latitude: 48.5004, longitude: 2.5 }; // FRAlder1998 is 0.044 km away
    const inside = await search({ near: { ...point, radius_km: 0.05 } });
    expect(inside.out.reserves.map((r) => [r.mab_id, r.distance_km])).toEqual([['FRAlder1998', 0]]);
    const { out } = await search({ near: { ...point, radius_km: 0.001 } });
    expect(out.totalCount).toBe(0);
    expect(out.facets.top_countries).toEqual([]);
    expect(out.notice).toBe(
      'No biosphere reserve lies within 0.001 km of (48.5004, 2.5). Increase radius_km.',
    );
  });

  describe('at the radius edge', () => {
    /** 11.0861 km from (60, 5) for FRMid and FRNear, 11.1195 km for FRFar: all 11.1 rounded. */
    const at = (mab_id: string, lat: number) =>
      mabRow({ mab_id, title_en: `${mab_id} Reserve`, coordinates: { lon: 5, lat } });
    const EDGE_ROWS = [at('FRFar1990', 60.1), at('FRMid1990', 60.0997), at('FRNear1990', 60.0997)];
    beforeEach(() => {
      useHub({ rows: { mab001: EDGE_ROWS } });
    });
    const near = (radius_km: number) => ({ near: { latitude: 60, longitude: 5, radius_km } });

    it('matches on the unrounded distance and never shows a distance past radius_km', async () => {
      const { out, text } = await search(near(11.09));
      expect(out.totalCount).toBe(2);
      expect(out.reserves.map((r) => [r.mab_id, r.distance_km])).toEqual([
        ['FRMid1990', 11.09],
        ['FRNear1990', 11.09],
      ]);
      expect(text).toContain('Distance: 11.09 km');
    });

    it('leaves out the reserve just past the radius', async () => {
      const { out } = await search(near(11.1));
      expect(ids(out)).toEqual(['FRMid1990', 'FRNear1990']);
      expect(out.facets.top_countries).toEqual([{ code: 'FR', name: 'France', count: 2 }]);
    });

    it.each([
      ['in mab_id order', EDGE_ROWS],
      ['in reverse mab_id order', [...EDGE_ROWS].reverse()],
    ])(
      'orders by unrounded distance, with mab_id breaking exact ties only (rows %s)',
      async (_label, rows) => {
        useHub({ rows: { mab001: rows } });
        const { out } = await search(near(30));
        expect(out.reserves.map((r) => [r.mab_id, r.distance_km])).toEqual([
          ['FRMid1990', 11.1],
          ['FRNear1990', 11.1],
          ['FRFar1990', 11.1],
        ]);
      },
    );
  });

  it('keeps distance_km on rows when a query drives the sort', async () => {
    const { out } = await search({
      query: 'brindle',
      near: { latitude: 52.5, longitude: 14.5, radius_km: 100 },
    });
    expect(out.applied_filters.sort).toBe('relevance');
    expect(out.reserves.every((r) => typeof r.distance_km === 'number')).toBe(true);
  });

  it('sorts far to near over a wide radius with an explicit distance sort', async () => {
    useHub({ rows: { mab001: manyMabRows(12) } });
    const { out } = await search({
      near: { latitude: 48, longitude: 2, radius_km: 5000 },
      sort: 'distance',
    });
    expect(out.reserves.map((r) => r.name)).toEqual(
      Array.from({ length: 12 }, (_, i) => `Loomvale Reserve ${String(i + 1).padStart(2, '0')}`),
    );
    const distances = out.reserves.map((r) => r.distance_km as number);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it.each([
    ['a latitude above 90', { latitude: 91, longitude: 0 }],
    ['a latitude below -90', { latitude: -91, longitude: 0 }],
    ['a longitude above 180', { latitude: 0, longitude: 181 }],
    ['a missing longitude', { latitude: 10 }],
    ['a zero radius', { latitude: 10, longitude: 10, radius_km: 0 }],
    ['a negative radius', { latitude: 10, longitude: 10, radius_km: -5 }],
    ['a radius above 5000', { latitude: 10, longitude: 10, radius_km: 5001 }],
    ['an undeclared key', { latitude: 10, longitude: 10, radius: 5 }],
    ['a non-numeric string latitude', { latitude: '10N', longitude: 10 }],
  ])('rejects near with %s as invalid arguments', async (_label, near) => {
    const error = errorOf(await runToolContract(tool, { near } as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it('accepts the coordinate extremes', async () => {
    for (const near of [
      { latitude: 90, longitude: 180 },
      { latitude: -90, longitude: -180, radius_km: 5000 },
    ]) {
      expect((await search({ near })).out.totalCount).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('unesco_search_biosphere_reserves — sorting', () => {
  it('sorts by designation year and total area', async () => {
    useHub({
      rows: {
        mab001: [
          mabRow({ mab_id: 'AA10', title_en: 'Ten', date: '2001-01-01', area_total: 300 }),
          mabRow({ mab_id: 'AA9', title_en: 'Nine', date: '1990-01-01', area_total: 300 }),
          mabRow({ mab_id: 'AA100', title_en: 'Hundred', date: '2001-01-01', area_total: 100 }),
          mabRow({ mab_id: 'AA5', title_en: 'Five', date: '1995-01-01', area_total: 900 }),
        ],
      },
    });
    expect(ids((await search({ sort: 'designated_newest' })).out)).toEqual([
      'AA10',
      'AA100',
      'AA5',
      'AA9',
    ]);
    expect(ids((await search({ sort: 'designated_oldest' })).out)).toEqual([
      'AA9',
      'AA5',
      'AA10',
      'AA100',
    ]);
    expect(ids((await search({ sort: 'area_largest' })).out)).toEqual([
      'AA5',
      'AA10',
      'AA9',
      'AA100',
    ]);
    expect((await search({ sort: 'area_largest' })).out.reserves[0]?.area_total_hectares).toBe(900);
  });

  it('resolves the default sort: relevance with a query, else distance with near, else name', async () => {
    useHub();
    expect((await search({ query: 'alderfen' })).out.applied_filters.sort).toBe('relevance');
    expect(
      (await search({ near: { latitude: 0, longitude: 0, radius_km: 5000 } })).out.applied_filters
        .sort,
    ).toBe('distance');
    expect((await search()).out.applied_filters.sort).toBe('name');
    expect((await search({ query: 'alderfen', sort: 'name' })).out.applied_filters.sort).toBe(
      'name',
    );
  });

  it.each([
    ['sort relevance with no query', { sort: 'relevance' }],
    ['sort relevance with a blank query', { sort: 'relevance', query: '  ' }],
    ['sort distance with no near', { sort: 'distance' }],
    [
      'sort distance with a blank near',
      { sort: 'distance', near: { latitude: '', longitude: '' } },
    ],
  ])('rejects %s as sort_needs_input with the declared recovery', async (_label, input) => {
    useHub();
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

describe('unesco_search_biosphere_reserves — facets', () => {
  it('counts over the whole match with a "none" bucket for reserves outside every network', async () => {
    useHub();
    const { out } = await search();
    expect(out.facets.region).toEqual({
      Africa: 0,
      'Arab States': 0,
      'Asia and the Pacific': 0,
      'Europe and North America': 3,
      'Latin America and the Caribbean': 1,
    });
    expect(out.facets.regional_network[EURO_MAB]).toBe(3);
    expect(out.facets.regional_network.none).toBe(1);
    expect(Object.values(out.facets.regional_network).reduce((a, b) => a + b, 0)).toBe(4);
    expect(out.facets.transboundary).toEqual({ true: 2, false: 2 });
    expect(out.facets.sids).toEqual({ true: 0, false: 4 });
    expect(out.facets.top_countries).toEqual([
      { code: 'DE', name: 'Germany', count: 1 },
      { code: 'FR', name: 'France', count: 1 },
      { code: 'PE', name: 'Peru', count: 1 },
      { code: 'PL', name: 'Poland', count: 1 },
    ]);
  });

  it('counts across pages, not just the shown page', async () => {
    useHub({ rows: { mab001: manyMabRows(45) } });
    const { out } = await search({ limit: 10 });
    expect(out.reserves).toHaveLength(10);
    expect(out.facets.region).toMatchObject({
      'Europe and North America': 30,
      'Latin America and the Caribbean': 15,
    });
    expect(out.facets.regional_network[EURO_MAB]).toBe(30);
    expect(out.facets.regional_network.none).toBe(15);
    expect(out.facets.top_countries.map((c) => [c.code, c.count])).toEqual([
      ['DE', 15],
      ['FR', 15],
      ['PE', 15],
    ]);
  });

  it('caps top countries at ten', async () => {
    const codes = ['FR', 'DE', 'JP', 'ET', 'PE', 'PL', 'BE', 'IT', 'ES', 'PT', 'NL', 'AT'];
    useHub({
      rows: {
        mab001: codes.map((iso2, i) => mabRow({ mab_id: `${iso2}Cap${i}`, iso2 })),
      },
    });
    const { out } = await search();
    expect(out.facets.top_countries).toHaveLength(10);
    expect(out.totalCount).toBe(12);
  });
});

describe('unesco_search_biosphere_reserves — pagination and cursors', () => {
  beforeEach(() => {
    useHub({ rows: { mab001: manyMabRows(45) } });
  });

  it('pages through the whole match with stable order, no gaps, and no repeats', async () => {
    const pages = await walk({ limit: 10 });
    expect(pages.map((p) => p.reserves.length)).toEqual([10, 10, 10, 10, 5]);
    const all = pages.flatMap((p) => p.reserves.map((r) => r.name));
    expect(all).toEqual(
      Array.from({ length: 45 }, (_, i) => `Loomvale Reserve ${String(i + 1).padStart(2, '0')}`),
    );
    expect(new Set(pages.flatMap(ids)).size).toBe(45);
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
    const last = pages.at(-1) as SearchOutput;
    expect(last).toMatchObject({ truncated: false, shown: 5, cap: 10 });
    expect(last.notice).toBeUndefined();
    expect(last.next_cursor).toBeUndefined();
  });

  it('applies the default page size of 20 and serves limit 50 whole', async () => {
    expect((await search()).out).toMatchObject({ shown: 20, cap: 20, truncated: true });
    const wide = (await search({ limit: 50 })).out;
    expect(wide).toMatchObject({ shown: 45, cap: 50, truncated: false });
    expect(wide.next_cursor).toBeUndefined();
  });

  it('keeps pages stable for a sort with many ties', async () => {
    const paged = (await walk({ sort: 'designated_newest', limit: 7 })).flatMap(ids);
    const whole = ids((await search({ sort: 'designated_newest', limit: 50 })).out);
    expect(paged).toEqual(whole);
    expect(new Set(paged).size).toBe(45);
  });

  it('pages a distance search by distance', async () => {
    const near = { latitude: 48, longitude: 2, radius_km: 5000 };
    const paged = (await walk({ near, limit: 10 })).flatMap((p) =>
      p.reserves.map((r) => r.distance_km as number),
    );
    expect(paged).toHaveLength(45);
    expect(paged).toEqual([...paged].sort((a, b) => a - b));
  });

  it('honors the limit of the call that carries the cursor and reads a blank cursor as none', async () => {
    const first = (await search({ limit: 10 })).out;
    const { out } = await search({ limit: 20, cursor: first.next_cursor });
    expect(out.reserves).toHaveLength(20);
    expect(out.reserves[0]?.name).toBe('Loomvale Reserve 11');
    expect((await search({ limit: 10, cursor: '' })).out.reserves[0]?.name).toBe(
      'Loomvale Reserve 01',
    );
  });

  it.each([
    ['a different region', { region: 'EUR' }],
    ['a different sort', { sort: 'area_largest' }],
    ['an added query', { query: 'loomvale' }],
    ['an added country', { country: 'FR' }],
    ['an added year bound', { designated_from: 1995 }],
    ['an added network', { regional_network: 'EuroMAB' }],
    ['an added transboundary filter', { transboundary: false }],
    ['an added sids filter', { sids: false }],
    ['an added near', { near: { latitude: 48, longitude: 2, radius_km: 5000 } }],
    ['an added reviewed filter', { reviewed: false }],
    ['an added reviewed_from bound', { reviewed_from: 1995 }],
    ['an added reviewed_to bound', { reviewed_to: 2030 }],
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

  it('rejects a near cursor once the point moves', async () => {
    const near = { latitude: 48, longitude: 2, radius_km: 5000 };
    const first = (await search({ near, limit: 10 })).out;
    const moved = await runToolContract(tool, {
      near: { ...near, latitude: 49 },
      limit: 10,
      cursor: first.next_cursor,
    } as never);
    expect(errorOf(moved).data?.reason).toBe('cursor_mismatch');
  });

  it('accepts a cursor when only spelling variants of the same filters changed', async () => {
    const first = (await search({ region: 'eur', limit: 5 })).out;
    const { out } = await search({
      region: 'Europe and North America',
      limit: 5,
      cursor: first.next_cursor,
    });
    expect(out.reserves.length).toBeGreaterThan(0);
  });

  it('rejects a cursor issued for an earlier data snapshot', async () => {
    const first = (await search({ limit: 10 })).out;
    getUnescoDataHubService().dispose();
    useHub({
      rows: { mab001: manyMabRows(45) },
      metas: { mab001: { data_processed: '2027-01-01T00:00:00+00:00' } },
    });
    const error = errorOf(
      await runToolContract(tool, { limit: 10, cursor: first.next_cursor } as never),
    );
    expect(error.data?.reason).toBe('cursor_mismatch');
  });

  it.each([
    ['garbage', 'not-a-cursor'],
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
      const { out } = await search({
        limit: 10,
        cursor: makeCursor({ ...state, offset, limit: 10 }),
      });
      expect(out.reserves).toEqual([]);
      expect(out).toMatchObject({ totalCount: 45, shown: 0, truncated: false });
      expect(out.notice).toBe(
        'The cursor is past the last of 45 results. Call unesco_search_biosphere_reserves without cursor to start over.',
      );
      expect(out.next_cursor).toBeUndefined();
    }
  });
});

describe('unesco_search_biosphere_reserves — limit above 50', () => {
  beforeEach(() => {
    useHub({ rows: { mab001: manyMabRows(200) } });
  });

  /** The whole match in order, from a walk at limit 10, so no large page is assumed. */
  const wholeMatch = async () => (await walk({ limit: 10 })).flatMap(ids);

  it('serves limit 100 as 100 rows, with cap and applied_filters.limit at the request', async () => {
    const whole = await wholeMatch();
    const { out, text } = await search({ limit: 100 });
    expect(ids(out)).toEqual(whole.slice(0, 100));
    expect(out).toMatchObject({ totalCount: 200, shown: 100, cap: 100, truncated: true });
    expect(out.applied_filters.limit).toBe(100);
    expect(out.notice).toBe('Showing results 1–100 of 200; pass next_cursor to continue.');
    expect(text).toContain('- limit: 100');
    expect(text).toContain('**cap:** 100');
    expect(text).not.toContain('per-call cap');
  });

  it.each([200, 10_000])('serves the whole match on one page at limit %i', async (limit) => {
    const whole = await wholeMatch();
    const { out, text } = await search({ limit });
    expect(ids(out)).toEqual(whole);
    expect(out).toMatchObject({ totalCount: 200, shown: 200, cap: limit, truncated: false });
    expect(out.applied_filters.limit).toBe(limit);
    expect(out.next_cursor).toBeUndefined();
    expect(out.notice).toBeUndefined();
    expect(text).not.toContain('per-call cap');
    expect(text).not.toContain('Next cursor');
  });

  it('continues a limit-100 cursor under limit 60 from its offset: results 101–160, then 161–200', async () => {
    const whole = await wholeMatch();
    const first = (await search({ limit: 100 })).out;
    const second = (await search({ limit: 60, cursor: first.next_cursor })).out;
    expect(ids(second)).toEqual(whole.slice(100, 160));
    expect(second).toMatchObject({ shown: 60, cap: 60, truncated: true });
    expect(second.notice).toBe('Showing results 101–160 of 200; pass next_cursor to continue.');
    const third = (await search({ limit: 60, cursor: second.next_cursor })).out;
    expect(ids(third)).toEqual(whole.slice(160));
    expect(third).toMatchObject({ shown: 40, cap: 60, truncated: false });
    expect(third.next_cursor).toBeUndefined();
  });

  it('continues a cursor minted at limit 50 and offset 50 under limit 60: results 51–110', async () => {
    const whole = await wholeMatch();
    const state = readCursor(
      (await search({ limit: 50 })).out.next_cursor as string,
      requestContextService.createRequestContext({ operation: 'test' }),
    );
    expect(state.offset).toBe(50);
    const { out } = await search({ limit: 60, cursor: makeCursor({ ...state, limit: 50 }) });
    expect(ids(out)).toEqual(whole.slice(50, 110));
    expect(out.notice).toBe('Showing results 51–110 of 200; pass next_cursor to continue.');
  });

  it.each([
    ['a different region', { region: 'EUR' }],
    ['an added review bound', { reviewed_to: 2030 }],
  ])(
    'still rejects a large-limit cursor used with %s as cursor_mismatch',
    async (_label, change) => {
      const first = (await search({ limit: 100 })).out;
      const error = errorOf(
        await runToolContract(tool, { limit: 150, ...change, cursor: first.next_cursor } as never),
      );
      expect(error.data?.reason).toBe('cursor_mismatch');
    },
  );

  it('rejects limit 10001, naming the 10000 ceiling', async () => {
    const error = errorOf(await runToolContract(tool, { limit: 10_001 } as never));
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('10000');
  });
});

describe('unesco_search_biosphere_reserves — zero-result and under-cap pages (enrichment contract)', () => {
  beforeEach(() => {
    useHub();
  });

  it('zero-result page carries every required enrichment field, zeroed', async () => {
    const { result, out, text } = await search({ query: 'zzzz' });
    expect(result.isError).not.toBe(true);
    expect(out.reserves).toEqual([]);
    expect(out).toMatchObject({ totalCount: 0, truncated: false, shown: 0, cap: 20 });
    expect(out.sources).toHaveLength(1);
    expect(out.applied_filters).toEqual({
      query: 'zzzz',
      sort: 'relevance',
      limit: 20,
      include_description: true,
    });
    expect(out.facets).toEqual({
      region: {
        Africa: 0,
        'Arab States': 0,
        'Asia and the Pacific': 0,
        'Europe and North America': 0,
        'Latin America and the Caribbean': 0,
      },
      regional_network: {
        'African Biosphere Reserve Network (AfriMAB)': 0,
        'Arab States Biosphere Reserve Network (ArabMAB)': 0,
        'East Asian Biosphere Reserve Network (EABRN)': 0,
        [EURO_MAB]: 0,
        'Ibero-American MAB Network (IberoMAB)': 0,
        'South and Central Asia MAB Network (SACAM)': 0,
        'Southeast Asian Biosphere Reserve Network (SeaBRnet)': 0,
        none: 0,
      },
      transboundary: { true: 0, false: 0 },
      sids: { true: 0, false: 0 },
      top_countries: [],
    });
    expect(out.next_cursor).toBeUndefined();
    expect(text).toContain('**0 biosphere reserves on this page**');
    expect(text).toContain('### Applied filters');
    expect(text).toContain('- Top countries: none');
    expect(text).toContain('- Region: none');
    expect(text).toContain('Source: UNESCO — Man and the Biosphere Programme (mab001)');
  });

  it('zero-result page from an empty dataset is still a valid result', async () => {
    useHub({ rows: { mab001: [] } });
    const { out } = await search();
    expect(out).toMatchObject({ totalCount: 0, shown: 0, truncated: false, cap: 20 });
    expect(out.notice).toBeUndefined();
  });

  it('under-cap page carries every required enrichment field and no continuation', async () => {
    const { result, out, text } = await search({ limit: 10 });
    expect(result.isError).not.toBe(true);
    expect(out.reserves).toHaveLength(4);
    expect(out).toMatchObject({ totalCount: 4, truncated: false, shown: 4, cap: 10 });
    expect(out.notice).toBeUndefined();
    expect(out.next_cursor).toBeUndefined();
    expect(out.sources).toHaveLength(1);
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 10, include_description: true });
    expect(Object.keys(out.facets).sort()).toEqual([
      'region',
      'regional_network',
      'sids',
      'top_countries',
      'transboundary',
    ]);
    expect(text).toContain('### Facets (whole match)');
    expect(text).toContain('- Transboundary: yes 2 · no 2');
    expect(text).toContain('- SIDS: yes 0 · no 4');
    expect(text).not.toContain('Next cursor');
  });

  it('under-cap page from a distance search carries distance and the near echo', async () => {
    const { out, text } = await search({
      near: { latitude: 52.5, longitude: 14.5, radius_km: 100 },
      limit: 10,
    });
    expect(out).toMatchObject({ totalCount: 2, truncated: false, shown: 2, cap: 10 });
    expect(text).toContain('- near: 52.5, 14.5 within 100 km');
    expect(text).toMatch(/Distance: [\d.]+ km/);
  });
});

describe('unesco_search_biosphere_reserves — notices', () => {
  beforeEach(() => {
    useHub();
  });

  it('explains a keyword miss and points at habitat words', async () => {
    const { out } = await search({ query: 'zzzz' });
    expect(out.notice).toContain('contains every word of "zzzz"');
    expect(out.notice).toContain('There is no ecosystem-type field');
    expect(out.notice).toContain('mangrove');
  });

  it('explains a country with no reserves', async () => {
    const { out } = await search({ country: 'AD' });
    expect(out.notice).toContain('No biosphere reserve lists AD (Andorra) as its country.');
    expect(out.notice).toContain('unesco_list_reference with topic countries');
  });

  it('explains an empty search radius with the point and the radius', async () => {
    const { out } = await search({ near: { latitude: 0, longitude: 0, radius_km: 5 } });
    expect(out.totalCount).toBe(0);
    expect(out.notice).toContain('No biosphere reserve lies within 5 km of (0, 0).');
    expect(out.notice).toContain('Increase radius_km');
  });

  it('names the filter whose removal recovers the most reserves', async () => {
    const { out } = await search({ region: 'LAC', transboundary: true });
    expect(out.totalCount).toBe(0);
    expect(out.notice).toMatch(
      /^No reserve matched all 2 filters\. Removing region alone would match 2 reserves\.$/,
    );
  });

  it('reports no single removal when none would help, then each cause in order', async () => {
    const { out } = await search({ country: 'AD', query: 'zzzz' });
    const notice = out.notice ?? '';
    expect(notice.startsWith('No reserve matched all 2 filters. No biosphere reserve')).toBe(true);
    expect(notice).not.toContain('Removing');
    const country = notice.indexOf('lists AD (Andorra)');
    const query = notice.indexOf('contains every word of "zzzz"');
    expect(country).toBeGreaterThan(0);
    expect(query).toBeGreaterThan(country);
  });

  it('carries only the continuation notice on a truncated page of an unfiltered search', async () => {
    useHub({ rows: { mab001: manyMabRows(45) } });
    const { out } = await search({ limit: 10 });
    expect(out.notice).toBe('Showing results 1–10 of 45; pass next_cursor to continue.');
  });
});

describe('unesco_search_biosphere_reserves — include_description', () => {
  beforeEach(() => {
    useHub();
  });

  const reserveBlock = (id: string, facts: string) => [
    '',
    `### ${id}`,
    facts,
    '> A synthetic reserve used as test data.',
  ];
  const DEFAULT_BLOCK = [
    '**4 biosphere reserves on this page**',
    ...reserveBlock(
      'Alderfen Marsh Reserve (FRAlder1998)',
      `France (FR) · Europe and North America · ${EURO_MAB} · Designated 1998 · Last periodic review 2025 · Transboundary: No · SIDS: No · Area: 5000 ha (marine 0 ha) · Population: 1000 · Coordinates: 48.5, 2.5`,
    ),
    ...reserveBlock(
      'Brindle Cross-border Reserve (DEBrin1993)',
      `Germany (DE) · Europe and North America · ${EURO_MAB} · Designated 1993 · No periodic review recorded · Transboundary: Yes · SIDS: No · Area: 5000 ha (marine 0 ha) · Population: 1000 · Coordinates: 52.5, 14.4`,
    ),
    ...reserveBlock(
      'Brindle Cross-border Reserve (PLBrin1993)',
      `Poland (PL) · Europe and North America · ${EURO_MAB} · Designated 1993 · No periodic review recorded · Transboundary: Yes · SIDS: No · Area: 5000 ha (marine 0 ha) · Population: 1000 · Coordinates: 52.5, 14.6`,
    ),
    ...reserveBlock(
      'Ñandu Highland Reserve (PEÑandu2001)',
      'Peru (PE) · Latin America and the Caribbean · No regional network · Designated 2001 · No periodic review recorded · Transboundary: No · SIDS: No · Area: 5000 ha (marine 0 ha) · Population: 1000 · Coordinates: -10, -75',
    ),
  ].join('\n');
  const withoutQuotes = (block: string) =>
    block
      .split('\n')
      .filter((l) => !(l === '>' || l.startsWith('> ')))
      .join('\n');

  it('renders the default page with every fact line', async () => {
    const { result, out } = await search();
    expect(textBlocks(result)[0]).toBe(DEFAULT_BLOCK);
    expect(out.reserves.map((r) => r.introduction)).toEqual(
      Array(4).fill('A synthetic reserve used as test data.'),
    );
  });

  it.each([
    ['omitted', {}],
    ['blank', { include_description: ' ' }],
    ['true', { include_description: true }],
  ])('keeps rows and format() unchanged when %s, and echoes true', async (_label, option) => {
    const plain = await search();
    const { result, out, text } = await search(option);
    expect(textBlocks(result)[0]).toBe(DEFAULT_BLOCK);
    expect(out.reserves).toEqual(plain.out.reserves);
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 20, include_description: true });
    expect(text.split('\n')).toContain('- include_description: true');
  });

  it('drops every introduction and its blockquote when false, and echoes false', async () => {
    const plain = await search();
    const { result, out, text } = await search({ include_description: false });
    expect(out.reserves).toEqual(
      plain.out.reserves.map(({ introduction: _introduction, ...rest }) => rest),
    );
    expect(textBlocks(result)[0]).toBe(withoutQuotes(DEFAULT_BLOCK));
    expect(out.applied_filters.include_description).toBe(false);
    expect(text.split('\n')).toContain('- include_description: false');
  });

  it.each([
    ['the string "false"', 'false'],
    ['the number 0', 0],
  ])('rejects %s as an argument error naming the boolean', async (_label, value) => {
    const error = errorOf(await runToolContract(tool, { include_description: value } as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('include_description');
    expect(error.message).toMatch(/expected boolean/i);
  });

  it('reports the introduction tier in matched_in when the introduction is omitted', async () => {
    const { out, text } = await search({ query: 'synthetic', include_description: false });
    expect(out.reserves).toHaveLength(4);
    for (const r of out.reserves) {
      expect(r.matched_in).toBe('introduction');
      expect(r).not.toHaveProperty('introduction');
    }
    expect(text).toContain('Matched in: introduction');
  });

  it('advertises introduction as optional and validates against the output schema in both modes', async () => {
    const json = z.toJSONSchema(tool.output, { io: 'output' }) as unknown as {
      properties: { reserves: { items: { properties: object; required: string[] } } };
    };
    expect(json.properties.reserves.items.properties).toHaveProperty('introduction');
    expect(json.properties.reserves.items.required).not.toContain('introduction');
    for (const include_description of [true, false]) {
      const output = await tool.handler(
        tool.input.parse({ include_description }),
        createMockContext({ errors: tool.errors }),
      );
      expect(() => tool.output.parse(output)).not.toThrow();
      expect(output.reserves.every((r) => r.introduction !== undefined)).toBe(include_description);
    }
  });

  it('describes the option by the field it drops and the tool that returns it', () => {
    const description = tool.input.shape.include_description.description ?? '';
    expect(description).toContain('introduction');
    expect(description).toContain('unesco_get_biosphere_reserve');
  });

  describe('across pages', () => {
    beforeEach(() => {
      useHub({ rows: { mab001: manyMabRows(45) } });
    });

    it.each([
      [false, true],
      [true, false],
    ])(
      'continues a cursor minted under include_description %s on a %s call',
      async (minted, next) => {
        const first = (await search({ include_description: minted, limit: 10 })).out;
        const second = (
          await search({ include_description: next, limit: 10, cursor: first.next_cursor })
        ).out;
        const whole = (await search({ limit: 20 })).out;
        expect([...ids(first), ...ids(second)]).toEqual(ids(whole));
        expect(second.reserves.every((r) => 'introduction' in r === next)).toBe(true);
        expect(second.notice).toBe('Showing results 11–20 of 45; pass next_cursor to continue.');
      },
    );

    it.each([
      ['a filter', { region: 'EUR' }],
      ['the sort', { sort: 'area_largest' }],
    ])(
      'still rejects a cursor when %s changes alongside include_description',
      async (_label, change) => {
        const first = (await search({ include_description: false, limit: 10 })).out;
        const error = errorOf(
          await runToolContract(tool, {
            include_description: false,
            limit: 10,
            ...change,
            cursor: first.next_cursor,
          } as never),
        );
        expect(error.data?.reason).toBe('cursor_mismatch');
      },
    );

    it('keeps the past-the-end and zero-hit notices when false', async () => {
      const first = (await search({ limit: 10 })).out;
      const state = readCursor(
        first.next_cursor as string,
        requestContextService.createRequestContext({ operation: 'test' }),
      );
      const past = await search({
        include_description: false,
        cursor: makeCursor({ ...state, offset: 45, limit: 10 }),
      });
      expect(past.out.reserves).toEqual([]);
      expect(past.out.notice).toBe(
        'The cursor is past the last of 45 results. Call unesco_search_biosphere_reserves without cursor to start over.',
      );
      const empty = await search({ query: 'zzzz', include_description: false });
      expect(empty.out.reserves).toEqual([]);
      expect(empty.out.notice).toContain('zzzz');
    });
  });
});

describe('unesco_search_biosphere_reserves — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(transportFailureCases('mab001', MAB_ROWS.length))(
    'reports %s as retryable snapshot_unavailable with the declared recovery',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const error = errorOf(await settle(runToolContract(tool, {})));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'snapshot_unavailable',
        retryable: true,
        dataset: 'mab001',
        recovery: { hint: declaredRecovery(tool.errors, 'snapshot_unavailable') },
      });
    },
  );

  it.each(contentFailureCases('mab001'))(
    'reports %s as non-retryable snapshot_unavailable with the service recovery',
    async (_label, hub) => {
      useHub(hub);
      const result = await runToolContract(tool, {});
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expectContentFailure(error, 'mab001', declaredRecovery(tool.errors, 'snapshot_unavailable'));
      expect(allText(result)).toContain(`Recovery: ${error.data?.recovery?.hint}`);
    },
  );

  it('declares the recovery on the wire for a plain failure', async () => {
    useHub({ intercept: () => transientFailure() });
    const error = errorOf(await runToolContract(tool, {}));
    expect(error.data).toMatchObject({
      reason: 'snapshot_unavailable',
      retryAfter: 60,
      recovery: { hint: declaredRecovery(tool.errors, 'snapshot_unavailable') },
    });
  });

  it('validates input before touching the upstream', async () => {
    const hub = useHub({ intercept: () => httpFailure(404) });
    const error = errorOf(await runToolContract(tool, { sort: 'distance' }));
    expect(error.data?.reason).toBe('sort_needs_input');
    expect(hub.calls).toHaveLength(0);
  });

  it('does not read the sibling datasets', async () => {
    const hub = useHub();
    await search();
    expect(hub.callsFor('whc001')).toHaveLength(0);
    expect(hub.callsFor('ich001')).toHaveLength(0);
  });
});

describe('unesco_search_biosphere_reserves — format() parity and text safety', () => {
  beforeEach(() => {
    useHub();
  });

  it('renders every structured field of every reserve', async () => {
    const { result, out, text } = await search({
      near: { latitude: 52.5, longitude: 14.5, radius_km: 100 },
    });
    const body = textBlocks(result)[0] ?? '';
    expect(body).toContain('**2 biosphere reserves on this page**');
    for (const r of out.reserves) {
      expect(body).toContain(`### ${r.name} (${r.mab_id})`);
      expect(body).toContain(`${r.country} (${r.country_code})`);
      expect(body).toContain(r.regions.join(', '));
      expect(body).toContain(r.regional_network ?? 'No regional network');
      expect(body).toContain(`Designated ${r.designation_year}`);
      expect(body).toContain(
        r.last_periodic_review_year !== undefined
          ? `Last periodic review ${r.last_periodic_review_year}`
          : 'No periodic review recorded',
      );
      expect(body).toContain(`Transboundary: ${r.transboundary ? 'Yes' : 'No'}`);
      expect(body).toContain(`SIDS: ${r.sids ? 'Yes' : 'No'}`);
      expect(body).toContain(
        `Area: ${r.area_total_hectares} ha (marine ${r.area_marine_hectares} ha)`,
      );
      expect(body).toContain(`Population: ${r.population_total}`);
      expect(body).toContain(`Coordinates: ${r.latitude}, ${r.longitude}`);
      expect(body).toContain(`Distance: ${r.distance_km} km`);
      expect(body).toContain(`> ${r.introduction}`);
    }
    expect(text).toContain('Source: UNESCO — Man and the Biosphere Programme (mab001)');
  });

  it('says so for a reserve outside every network and shows the matched tier only with a query', async () => {
    expect((await search()).text).not.toContain('Matched in:');
    const { text } = await search({ query: 'nandu' });
    expect(text).toContain('No regional network');
    expect(text).toContain('Matched in: name');
  });

  it('carries the applied filters and facets to content-only clients', async () => {
    const { text } = await search({ region: 'eur', regional_network: 'euromab', query: 'brindle' });
    expect(text).toContain('- query: "brindle"');
    expect(text).toContain('- region: Europe and North America');
    expect(text).toContain(`- regional_network: ${EURO_MAB}`);
    expect(text).toContain('- sort: relevance');
    expect(text).toContain('- Region: Europe and North America 2');
    expect(text).toContain(`- Regional network: ${EURO_MAB} 2`);
    expect(text).toContain('- Top countries: Germany (DE) 1 · Poland (PL) 1');
  });

  it('closes a truncated page with the cursor and puts the same cursor in structuredContent', async () => {
    useHub({ rows: { mab001: manyMabRows(45) } });
    const { out, text } = await search({ limit: 10 });
    expect(text).toContain(`Next cursor: ${out.next_cursor}`);
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('Showing results 1–10 of 45; pass next_cursor to continue.');
  });

  it('quotes a multi-paragraph introduction line by line', async () => {
    useHub({
      rows: {
        mab001: [
          mabRow({
            mab_id: 'ZZQuote2000',
            introduction_en: 'One.\n\n## Not A Heading\n- not a list',
          }),
        ],
      },
    });
    const { text } = await search();
    expect(text).toContain('> One.\n>\n> ## Not A Heading\n> - not a list');
    expect(text.split('\n').some((l) => l === '## Not A Heading' || l === '- not a list')).toBe(
      false,
    );
  });

  it('flattens CR/LF in inline upstream text so it cannot start a markdown block', async () => {
    useHub({
      rows: {
        mab001: [
          mabRow({
            mab_id: 'AB\r\nC1',
            title_en: 'Evil\r\n# Injected Heading',
            country_title_en: 'Land\r\n## Injected',
            introduction_en: 'Intro line.\r\n# Not A Heading',
          }),
        ],
      },
    });
    const { out, text } = await search();
    expect(out.reserves[0]?.name).toBe('Evil\r\n# Injected Heading');
    const lines = text.split('\n');
    expect(lines).toContain('### Evil # Injected Heading (AB C1)');
    expect(text).toContain('Land ## Injected (FR)');
    expect(text).toContain('> Intro line.\n> # Not A Heading');
    expect(lines.some((l) => l.startsWith('# Injected') || l.startsWith('## Injected'))).toBe(
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
