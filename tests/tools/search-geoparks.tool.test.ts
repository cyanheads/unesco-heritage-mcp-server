/**
 * @fileoverview Tests for unesco_search_geoparks: blank-as-unset inputs,
 * keyword tiers, country/transnational/year filters, distance search over each
 * geopark's one point, sorting, pagination and cursors, facets, zero-hit
 * notices, the 2015 designation-date notice, include_description, the declared
 * error contracts, the required-enrichment contract on the zero-result and
 * under-cap pages, upstream failure classes, format() parity with
 * structuredContent, and markdown in upstream text rendered inert.
 * @module tests/tools/search-geoparks.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchGeoparksTool as tool } from '@/mcp-server/tools/definitions/search-geoparks.tool.js';
import { makeCursor, readCursor } from '@/services/unesco-datahub/search.js';
import { getUnescoDataHubService } from '@/services/unesco-datahub/unesco-datahub-service.js';
import { declaredRecovery } from '../fixtures/contract.js';
import { failureCases, settle, withFakeTimers } from '../fixtures/failures.js';
import { httpFailure } from '../fixtures/hub.js';
import { manyEgRows } from '../fixtures/paging.js';
import { EG_ROWS, egRow } from '../fixtures/rows.js';
import {
  allText,
  disposeServiceAfterEach,
  errorOf,
  structured,
  textBlocks,
  useHub,
} from '../fixtures/tool.js';

interface GeoparkRow {
  area_hectares: number;
  countries: string[];
  country_codes: string[];
  designation_year: number;
  distance_km?: number;
  introduction?: string;
  latitude: number;
  longitude: number;
  matched_in?: string;
  name: string;
  population?: number;
  transnational: boolean;
  ugg_id: string;
}

interface SearchOutput {
  applied_filters: Record<string, unknown> & { limit: number; sort: string };
  cap: number;
  facets: {
    top_countries: { code: string; count: number; name: string }[];
    transnational: { false: number; true: number };
  };
  geoparks: GeoparkRow[];
  next_cursor?: string;
  notice?: string;
  shown: number;
  sources: { dataset: string }[];
  totalCount: number;
  truncated: boolean;
}

/** The fixture geoparks in name order. */
const BY_NAME = ['EUFR90', 'EUA190', 'ASJP91', 'EUIT92', 'LAPE93'];

const NOTICE_2015 = (count: number) =>
  `The ${count} geoparks dated 2015 carry the year UNESCO created the UNESCO Global Geopark designation, not the year each joined the Global Geoparks Network, which the data does not record.`;

disposeServiceAfterEach();

const search = async (input: Record<string, unknown> = {}) => {
  const result = await runToolContract(tool, input as never);
  return { result, out: structured<SearchOutput>(result), text: allText(result) };
};

const ids = (out: SearchOutput) => out.geoparks.map((g) => g.ugg_id);

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

const loomvale = (n: number) =>
  Array.from({ length: n }, (_, i) => `Loomvale Geopark ${String(i + 1).padStart(2, '0')}`);

describe('unesco_search_geoparks — basics', () => {
  beforeEach(() => {
    useHub();
  });

  it('lists every geopark by name when no filter is set', async () => {
    const { out } = await search();
    expect(ids(out)).toEqual(BY_NAME);
    expect(out.totalCount).toBe(5);
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 20, include_description: true });
    expect(out.sources).toEqual([expect.objectContaining({ dataset: 'eg0001' })]);
    expect(out.geoparks[0]).not.toHaveProperty('matched_in');
    expect(out.geoparks[0]).not.toHaveProperty('distance_km');
  });

  it('returns each geopark row as recorded, with its text cleaned', async () => {
    const { out } = await search();
    expect(out.geoparks[0]).toEqual({
      ugg_id: 'EUFR90',
      name: 'Alderfen Cliffs UNESCO Global Geopark',
      country_codes: ['FR'],
      countries: ['France'],
      transnational: false,
      designation_year: 2015,
      area_hectares: 120_000,
      population: 52_000,
      latitude: 49.9,
      longitude: 1.5,
      introduction: 'The "Alderfen" cliffs record 300 million years of the coast\'s history.',
    });
  });

  it('splits a transnational geopark into both codes with a 0 population passed through', async () => {
    const { out } = await search();
    expect(out.geoparks.find((g) => g.ugg_id === 'EUA190')).toMatchObject({
      country_codes: ['DE', 'PL'],
      countries: ['Germany', 'Poland'],
      transnational: true,
      population: 0,
    });
  });

  it('keeps the sparse row sparse: no population, never 0-filled', async () => {
    const { out, text } = await search();
    const sparse = out.geoparks.find((g) => g.ugg_id === 'ASJP91') as GeoparkRow;
    expect(sparse).not.toHaveProperty('population');
    expect(text).toContain(
      'Japan (JP) · Designated 2015 · Transnational: No · Area: 30000 ha · Population: Not available',
    );
  });

  it('reads blank strings on every optional input as unset', async () => {
    const { out } = await search({
      query: '',
      country: '  ',
      transnational: '',
      designated_from: '',
      designated_to: '',
      near: '',
      sort: '',
      include_description: '',
      limit: '',
      cursor: '',
    });
    expect(out.totalCount).toBe(5);
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 20, include_description: true });
  });

  it.each([
    ['limit 0', { limit: 0 }],
    ['limit 51', { limit: 51 }],
    ['a string limit', { limit: '10' }],
    ['a country over 64 characters', { country: 'A'.repeat(65) }],
    ['an unknown sort', { sort: 'popularity' }],
    ['a non-boolean transnational', { transnational: 'yes' }],
    ['a year below 1900', { designated_from: 1899 }],
    ['a year above 2100', { designated_to: 2101 }],
    ['a query over 200 characters', { query: 'a'.repeat(201) }],
    ['a query of punctuation only', { query: '!!!' }],
    ['a cursor over 1024 characters', { cursor: 'a'.repeat(1025) }],
    ['a region, which geoparks do not take', { region: 'EUR' }],
    ['a transboundary key instead of transnational', { transboundary: true }],
  ])('rejects %s as invalid arguments', async (_label, input) => {
    const error = errorOf(await runToolContract(tool, input as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });
});

describe('unesco_search_geoparks — keyword query', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['a name word', 'karst', ['EUA190'], 'name'],
    ['a word prefix', 'alder', ['EUFR90'], 'name'],
    ['a word in every name', 'geopark', BY_NAME, 'name'],
    ['a name word typed without its diacritic', 'nandu', ['LAPE93'], 'name'],
    ['a name word typed with its diacritic', 'ÑANDU', ['LAPE93'], 'name'],
    ['an introduction word', 'springs', ['ASJP91'], 'introduction'],
    ['a word from an entity-decoded introduction', 'coast', ['EUFR90'], 'introduction'],
    ['a word from a list-markup introduction', 'mines', ['EUIT92'], 'introduction'],
    ['a description word', 'chalk', ['EUFR90'], 'description'],
    ['a sustaining-local-communities word', 'fishing', ['EUFR90'], 'description'],
    ['a word every default account carries', 'geotourism', BY_NAME.slice(1), 'description'],
    ['words matching in name and introduction', 'plateau trail', ['EUIT92'], 'introduction'],
    ['words matching in name and description', 'cliffs farming', ['EUFR90'], 'description'],
  ])('matches %s', async (_label, query, expected, tier) => {
    const { out } = await search({ query });
    expect(ids(out)).toEqual(expected);
    expect(new Set(out.geoparks.map((g) => g.matched_in))).toEqual(new Set([tier]));
  });

  it('requires every word and only matches at the start of a word', async () => {
    expect((await search({ query: 'karst chalk' })).out.totalCount).toBe(0);
    expect((await search({ query: 'arst' })).out.totalCount).toBe(0);
    expect((await search({ query: 'volcano' })).out.totalCount).toBe(0);
    expect(ids((await search({ query: 'volcan' })).out)).toEqual(['LAPE93']);
  });

  it('echoes the query trimmed and resolves the default sort to relevance', async () => {
    const { out } = await search({ query: '  Karst  ' });
    expect(out.applied_filters).toMatchObject({ query: 'Karst', sort: 'relevance' });
  });

  it('ranks name matches before introduction and description matches, then by name', async () => {
    useHub({
      rows: {
        eg0001: [
          egRow({ ugg_id: 'GP1', title_en: 'Zeta Fen' }),
          egRow({ ugg_id: 'GP2', title_en: 'Alpha Wood', introduction_en: 'A fen lies here.' }),
          egRow({ ugg_id: 'GP3', title_en: 'Beta Wood', description: 'Fen peat beds.' }),
          egRow({
            ugg_id: 'GP4',
            title_en: 'Gamma Wood',
            sustaining_local_communities_description: 'Fen farming.',
          }),
        ],
      },
    });
    const { out } = await search({ query: 'fen' });
    expect(out.geoparks.map((g) => [g.ugg_id, g.matched_in])).toEqual([
      ['GP1', 'name'],
      ['GP2', 'introduction'],
      ['GP3', 'description'],
      ['GP4', 'description'],
    ]);
  });
});

describe('unesco_search_geoparks — filters', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['an alpha-2 code', 'FR', ['EUFR90']],
    ['a lowercase code', 'fr', ['EUFR90']],
    ['an alpha-3 code', 'FRA', ['EUFR90']],
    ['a padded lowercase alpha-3 code', ' jpn ', ['ASJP91']],
    ['a code on the accented geopark', 'PE', ['LAPE93']],
  ])('filters by country given as %s', async (_label, country, expected) => {
    expect(ids((await search({ country })).out)).toEqual(expected);
  });

  it.each([
    ['its first code', 'DE'],
    ['its second code', 'PL'],
    ['its second code as alpha-3', 'POL'],
  ])('matches a transnational geopark on %s', async (_label, country) => {
    const { out } = await search({ country });
    expect(ids(out)).toEqual(['EUA190']);
    expect(out.geoparks[0]?.country_codes).toEqual(['DE', 'PL']);
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
    expect(allText(result)).toContain('unesco_search_geoparks');
  });

  it('accepts an unassigned code that a loaded record carries', async () => {
    useHub({ rows: { eg0001: [egRow({ ugg_id: 'EUXK01', countries: ['XK'] })] } });
    expect(ids((await search({ country: 'xk' })).out)).toEqual(['EUXK01']);
  });

  it('filters by transnational status in both directions', async () => {
    const yes = (await search({ transnational: true })).out;
    expect(ids(yes)).toEqual(['EUA190']);
    expect(yes.geoparks[0]?.transnational).toBe(true);
    expect(ids((await search({ transnational: false })).out)).toEqual(
      BY_NAME.filter((id) => id !== 'EUA190'),
    );
  });

  it('filters by designation years, inclusive at both ends', async () => {
    expect(ids((await search({ designated_from: 2018 })).out)).toEqual([
      'EUA190',
      'EUIT92',
      'LAPE93',
    ]);
    expect(ids((await search({ designated_to: 2015 })).out)).toEqual(['EUFR90', 'ASJP91']);
    expect(ids((await search({ designated_from: 2018, designated_to: 2023 })).out)).toEqual([
      'EUA190',
      'EUIT92',
    ]);
    expect(ids((await search({ designated_from: 2024, designated_to: 2024 })).out)).toEqual([
      'LAPE93',
    ]);
  });

  it('rejects an inverted year range with the declared recovery', async () => {
    const result = await runToolContract(tool, { designated_from: 2024, designated_to: 2018 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_year_range',
      recovery: { hint: declaredRecovery(tool.errors, 'invalid_year_range') },
    });
  });

  it('combines every filter with AND', async () => {
    expect(
      ids(
        (
          await search({
            query: 'karst',
            country: 'PL',
            transnational: true,
            designated_from: 2018,
            designated_to: 2018,
            near: { latitude: 51.5, longitude: 14.7, radius_km: 10 },
          })
        ).out,
      ),
    ).toEqual(['EUA190']);
    expect((await search({ country: 'FR', transnational: true })).out.totalCount).toBe(0);
    expect((await search({ country: 'JP', designated_from: 2016 })).out.totalCount).toBe(0);
    expect((await search({ query: 'karst', transnational: false })).out.totalCount).toBe(0);
  });
});

describe('unesco_search_geoparks — distance search', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns distance_km in kilometres to 0.1, latitude before longitude', async () => {
    const { out } = await search({ near: { latitude: 50.9, longitude: 1.5, radius_km: 200 } });
    expect(ids(out)).toEqual(['EUFR90']);
    expect(out.geoparks[0]?.distance_km).toBe(111.2);
    expect(out.applied_filters.near).toEqual({ latitude: 50.9, longitude: 1.5, radius_km: 200 });
    expect(out.applied_filters.sort).toBe('distance');
  });

  it('measures a transnational geopark at its one point, with no per-country components', async () => {
    const { out } = await search({ near: { latitude: 51.5, longitude: 14.7, radius_km: 1 } });
    expect(ids(out)).toEqual(['EUA190']);
    expect(out.geoparks[0]?.distance_km).toBe(0);
  });

  it('defaults the radius to 100 km, excluding a geopark just beyond it', async () => {
    const { out } = await search({ near: { latitude: 50.9, longitude: 1.5 } });
    expect(out.totalCount).toBe(0);
    expect(out.applied_filters.near).toEqual({ latitude: 50.9, longitude: 1.5, radius_km: 100 });
  });

  it('reads a blank radius_km as the default', async () => {
    const { out } = await search({ near: { latitude: 49.9, longitude: 1.5, radius_km: '' } });
    expect(ids(out)).toEqual(['EUFR90']);
    expect(out.applied_filters.near).toMatchObject({ radius_km: 100 });
    expect(out.geoparks[0]?.distance_km).toBe(0);
  });

  it('reads a near object whose every field is blank as unset', async () => {
    const { out } = await search({ near: { latitude: '', longitude: '', radius_km: '' } });
    expect(out.totalCount).toBe(5);
    expect(out.applied_filters).not.toHaveProperty('near');
    expect(out.applied_filters.sort).toBe('name');
    expect(out.geoparks[0]).not.toHaveProperty('distance_km');
  });

  it('orders by distance and breaks ties on ugg_id', async () => {
    useHub({
      rows: {
        eg0001: [
          egRow({ ugg_id: 'ZZ02', title_en: 'A East', coordinates: { lon: 10.1, lat: 10 } }),
          egRow({ ugg_id: 'ZZ01', title_en: 'B West', coordinates: { lon: 9.9, lat: 10 } }),
          egRow({ ugg_id: 'ZZ00', title_en: 'C Far', coordinates: { lon: 10.5, lat: 10 } }),
        ],
      },
    });
    const { out } = await search({ near: { latitude: 10, longitude: 10, radius_km: 100 } });
    expect(ids(out)).toEqual(['ZZ01', 'ZZ02', 'ZZ00']);
    expect(out.geoparks[0]?.distance_km).toBe(out.geoparks[1]?.distance_km);
  });

  it('keeps distance_km on rows when a query drives the sort', async () => {
    const { out } = await search({
      query: 'geopark',
      near: { latitude: 48, longitude: 8, radius_km: 800 },
    });
    expect(out.applied_filters.sort).toBe('relevance');
    expect(ids(out)).toEqual(['EUFR90', 'EUA190']);
    expect(out.geoparks.every((g) => typeof g.distance_km === 'number')).toBe(true);
  });

  it('sorts near to far over a wide radius with an explicit distance sort', async () => {
    useHub({ rows: { eg0001: manyEgRows(12) } });
    const { out } = await search({
      near: { latitude: 48, longitude: 2, radius_km: 5000 },
      sort: 'distance',
    });
    expect(out.geoparks.map((g) => g.name)).toEqual(loomvale(12));
    const distances = out.geoparks.map((g) => g.distance_km as number);
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
    ['a string latitude', { latitude: '10', longitude: 10 }],
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
      expect((await search({ near })).out.totalCount).toBe(0);
    }
  });
});

describe('unesco_search_geoparks — sorting', () => {
  it('sorts by designation year and area, ties broken by ugg_id', async () => {
    useHub({
      rows: {
        eg0001: [
          egRow({ ugg_id: 'AA10', title_en: 'Ten', date: '2021-01-01', area_total: 300 }),
          egRow({ ugg_id: 'AA09', title_en: 'Nine', date: '2015-01-01', area_total: 300 }),
          egRow({ ugg_id: 'AA11', title_en: 'Eleven', date: '2021-01-01', area_total: 100 }),
          egRow({ ugg_id: 'AA05', title_en: 'Five', date: '2018-01-01', area_total: 900 }),
        ],
      },
    });
    expect(ids((await search({ sort: 'designated_newest' })).out)).toEqual([
      'AA10',
      'AA11',
      'AA05',
      'AA09',
    ]);
    expect(ids((await search({ sort: 'designated_oldest' })).out)).toEqual([
      'AA09',
      'AA05',
      'AA10',
      'AA11',
    ]);
    const largest = (await search({ sort: 'area_largest' })).out;
    expect(ids(largest)).toEqual(['AA05', 'AA09', 'AA10', 'AA11']);
    expect(largest.geoparks[0]?.area_hectares).toBe(900);
    expect(ids((await search({ sort: 'name' })).out)).toEqual(['AA11', 'AA05', 'AA09', 'AA10']);
  });

  it('resolves the default sort: relevance with a query, else distance with near, else name', async () => {
    useHub();
    expect((await search({ query: 'karst' })).out.applied_filters.sort).toBe('relevance');
    expect(
      (await search({ near: { latitude: 0, longitude: 0, radius_km: 5000 } })).out.applied_filters
        .sort,
    ).toBe('distance');
    expect((await search()).out.applied_filters.sort).toBe('name');
    expect((await search({ query: 'karst', sort: 'name' })).out.applied_filters.sort).toBe('name');
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

describe('unesco_search_geoparks — facets', () => {
  it('counts over the whole match, a transnational geopark once for each of its countries', async () => {
    useHub();
    const { out } = await search();
    expect(out.facets.transnational).toEqual({ true: 1, false: 4 });
    expect(out.facets.top_countries).toEqual([
      { code: 'DE', name: 'Germany', count: 1 },
      { code: 'FR', name: 'France', count: 1 },
      { code: 'IT', name: 'Italy', count: 1 },
      { code: 'JP', name: 'Japan', count: 1 },
      { code: 'PE', name: 'Peru', count: 1 },
      { code: 'PL', name: 'Poland', count: 1 },
    ]);
    const filtered = (await search({ country: 'PL' })).out;
    expect(filtered.facets.top_countries.map((c) => c.code)).toEqual(['DE', 'PL']);
  });

  it('counts across pages, not just the shown page', async () => {
    useHub({ rows: { eg0001: manyEgRows(45) } });
    const { out } = await search({ limit: 10 });
    expect(out.geoparks).toHaveLength(10);
    expect(out.facets.transnational).toEqual({ true: 9, false: 36 });
    expect(out.facets.top_countries.map((c) => [c.code, c.count])).toEqual([
      ['DE', 15],
      ['FR', 15],
      ['JP', 15],
      ['BE', 9],
    ]);
  });

  it('caps top countries at ten', async () => {
    const codes = ['FR', 'DE', 'JP', 'ET', 'PE', 'PL', 'BE', 'IT', 'ES', 'PT', 'NL', 'AT'];
    useHub({
      rows: {
        eg0001: codes.map((code, i) => egRow({ ugg_id: `CAP${i}`, countries: [code] })),
      },
    });
    const { out } = await search();
    expect(out.facets.top_countries).toHaveLength(10);
    expect(out.totalCount).toBe(12);
  });
});

describe('unesco_search_geoparks — pagination and cursors', () => {
  beforeEach(() => {
    useHub({ rows: { eg0001: manyEgRows(45) } });
  });

  it('pages through the whole match with stable order, no gaps, and no repeats', async () => {
    const pages = await walk({ limit: 10 });
    expect(pages.map((p) => p.geoparks.length)).toEqual([10, 10, 10, 10, 5]);
    expect(pages.flatMap((p) => p.geoparks.map((g) => g.name))).toEqual(loomvale(45));
    expect(new Set(pages.flatMap(ids)).size).toBe(45);
    expect(pages.every((p) => p.totalCount === 45)).toBe(true);
  });

  it('discloses truncation with the continuation notice on every page but the last', async () => {
    const pages = await walk({ limit: 15 });
    expect(pages).toHaveLength(3);
    expect(pages[0]).toMatchObject({
      truncated: true,
      shown: 15,
      cap: 15,
      notice: 'Showing results 1–15 of 45; pass next_cursor to continue.',
    });
    expect(pages[1]?.notice).toBe('Showing results 16–30 of 45; pass next_cursor to continue.');
    const last = pages.at(-1) as SearchOutput;
    expect(last).toMatchObject({ truncated: false, shown: 15, cap: 15 });
    expect(last.notice).toBeUndefined();
    expect(last.next_cursor).toBeUndefined();
  });

  it('applies the default page size of 20 and caps at 50', async () => {
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
      p.geoparks.map((g) => g.distance_km as number),
    );
    expect(paged).toHaveLength(45);
    expect(paged).toEqual([...paged].sort((a, b) => a - b));
  });

  it('honors the limit of the call that carries the cursor and reads a blank cursor as none', async () => {
    const first = (await search({ limit: 10 })).out;
    const { out } = await search({ limit: 20, cursor: first.next_cursor });
    expect(out.geoparks).toHaveLength(20);
    expect(out.geoparks[0]?.name).toBe('Loomvale Geopark 11');
    expect((await search({ limit: 10, cursor: '' })).out.geoparks[0]?.name).toBe(
      'Loomvale Geopark 01',
    );
  });

  it.each([
    ['a different sort', { sort: 'area_largest' }],
    ['an added query', { query: 'loomvale' }],
    ['an added country', { country: 'FR' }],
    ['an added year bound', { designated_from: 2016 }],
    ['an added transnational filter', { transnational: false }],
    ['an added near', { near: { latitude: 48, longitude: 2, radius_km: 5000 } }],
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
    const first = (await search({ country: 'fr', limit: 5 })).out;
    const { out } = await search({ country: 'FRA', limit: 5, cursor: first.next_cursor });
    expect(out.geoparks[0]?.name).toBe('Loomvale Geopark 16');
  });

  it('rejects a cursor issued for an earlier data snapshot', async () => {
    const first = (await search({ limit: 10 })).out;
    getUnescoDataHubService().dispose();
    useHub({
      rows: { eg0001: manyEgRows(45) },
      metas: { eg0001: { data_processed: '2027-01-01T00:00:00+00:00' } },
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
      expect(out.geoparks).toEqual([]);
      expect(out).toMatchObject({ totalCount: 45, shown: 0, truncated: false });
      expect(out.notice).toBe(
        'The cursor is past the last of 45 results. Call unesco_search_geoparks without cursor to start over.',
      );
      expect(out.next_cursor).toBeUndefined();
    }
  });
});

describe('unesco_search_geoparks — zero-result and under-cap pages (enrichment contract)', () => {
  beforeEach(() => {
    useHub();
  });

  it('zero-result page carries every required enrichment field, zeroed', async () => {
    const { result, out, text } = await search({ query: 'zzzz' });
    expect(result.isError).not.toBe(true);
    expect(out.geoparks).toEqual([]);
    expect(out).toMatchObject({ totalCount: 0, truncated: false, shown: 0, cap: 20 });
    expect(out.sources).toHaveLength(1);
    expect(out.applied_filters).toEqual({
      query: 'zzzz',
      sort: 'relevance',
      limit: 20,
      include_description: true,
    });
    expect(out.facets).toEqual({ transnational: { true: 0, false: 0 }, top_countries: [] });
    expect(out.next_cursor).toBeUndefined();
    expect(text).toContain('**0 geoparks on this page**');
    expect(text).toContain('### Applied filters');
    expect(text).toContain('- Top countries: none');
    expect(text).toContain('- Transnational: yes 0 · no 0');
    expect(text).toContain('Source: UNESCO — UNESCO Global Geoparks (eg0001)');
  });

  it('zero-result page from an empty dataset is still a valid result', async () => {
    useHub({ rows: { eg0001: [] } });
    const { out } = await search();
    expect(out).toMatchObject({ totalCount: 0, shown: 0, truncated: false, cap: 20 });
    expect(out.notice).toBeUndefined();
  });

  it('under-cap page carries every required enrichment field and no continuation', async () => {
    const { result, out, text } = await search({ limit: 10 });
    expect(result.isError).not.toBe(true);
    expect(out.geoparks).toHaveLength(5);
    expect(out).toMatchObject({ totalCount: 5, truncated: false, shown: 5, cap: 10 });
    expect(out.notice).toBeUndefined();
    expect(out.next_cursor).toBeUndefined();
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 10, include_description: true });
    expect(Object.keys(out.facets).sort()).toEqual(['top_countries', 'transnational']);
    expect(text).toContain('### Facets (whole match)');
    expect(text).toContain('- Transnational: yes 1 · no 4');
    expect(text).not.toContain('Next cursor');
  });
});

describe('unesco_search_geoparks — zero-hit notices', () => {
  beforeEach(() => {
    useHub();
  });

  it('explains a keyword miss', async () => {
    const { out } = await search({ query: 'zzzz' });
    expect(out.notice).toBe(
      'No geopark\'s name, introduction, description, or account of sustaining local communities contains every word of "zzzz" (each word matches at the start of a word, and all are required). Try fewer or broader words.',
    );
  });

  it('explains a country with no geoparks and points at the country reference', async () => {
    const { out } = await search({ country: 'AD' });
    expect(out.notice).toBe(
      'No UNESCO Global Geopark lists AD (Andorra) among its countries. unesco_list_reference with topic countries shows how many geoparks each country has.',
    );
  });

  it('explains an empty search radius with the point and the radius, and no missing-coordinates clause', async () => {
    const { out } = await search({ near: { latitude: 0, longitude: 0, radius_km: 5 } });
    expect(out.totalCount).toBe(0);
    expect(out.notice).toBe(
      'No UNESCO Global Geopark lies within 5 km of (0, 0). Increase radius_km.',
    );
  });

  it('names the filter whose removal recovers the most geoparks', async () => {
    const { out } = await search({ country: 'JP', designated_from: 2016, transnational: false });
    expect(out.totalCount).toBe(0);
    expect(out.notice).toBe(
      'No geopark matched all 3 filters. Removing country alone would match 2 geoparks.',
    );
  });

  it('reports no single removal when none would help, then each cause in order', async () => {
    const { out } = await search({ country: 'AD', query: 'zzzz' });
    const notice = out.notice ?? '';
    expect(notice.startsWith('No geopark matched all 2 filters. No UNESCO Global Geopark')).toBe(
      true,
    );
    expect(notice).not.toContain('Removing');
    const country = notice.indexOf('lists AD (Andorra)');
    const query = notice.indexOf('contains every word of "zzzz"');
    expect(country).toBeGreaterThan(0);
    expect(query).toBeGreaterThan(country);
  });

  it.each([
    ['a transnational filter', [EG_ROWS[0]], { transnational: true }],
    ['a year bound clear of 2015', EG_ROWS, { designated_from: 2025 }],
  ])('returns an empty page without a notice for %s alone', async (_label, rows, input) => {
    useHub({ rows: { eg0001: rows } });
    const { out } = await search(input);
    expect(out).toMatchObject({ totalCount: 0, shown: 0, truncated: false });
    expect(out.notice).toBeUndefined();
  });

  it('carries only the continuation notice on a truncated page of an unfiltered search', async () => {
    useHub({ rows: { eg0001: manyEgRows(45) } });
    const { out } = await search({ limit: 10 });
    expect(out.notice).toBe('Showing results 1–10 of 45; pass next_cursor to continue.');
  });
});

describe('unesco_search_geoparks — the 2015 designation-date notice', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['a range of exactly 2015', { designated_from: 2015, designated_to: 2015 }],
    ['an upper bound after 2015 alone', { designated_to: 2016 }],
    ['an upper bound of 2015 alone', { designated_to: 2015 }],
    ['a lower bound before 2015 alone', { designated_from: 2010 }],
    ['a lower bound of 2015 alone', { designated_from: 2015 }],
    ['a range spanning 2015', { designated_from: 2000, designated_to: 2030 }],
    ['an upper bound before 2015 alone', { designated_to: 2014 }],
  ])('fires for %s, counting the geoparks dated 2015', async (_label, range) => {
    const { out, text } = await search(range);
    expect(out.notice).toBe(NOTICE_2015(2));
    expect(text).toContain(NOTICE_2015(2));
  });

  it.each([
    ['no range, though the page holds 2015-dated geoparks', {}],
    ['a lower bound after 2015', { designated_from: 2016 }],
    ['a range clear of 2015', { designated_from: 2018, designated_to: 2023 }],
  ])('stays silent for %s', async (_label, range) => {
    const { out } = await search(range);
    expect(out.notice).toBeUndefined();
  });

  it('explains the empty match of a range that ends before 2015', async () => {
    const { out } = await search({ designated_from: 2004, designated_to: 2004 });
    expect(out.totalCount).toBe(0);
    expect(out.notice).toBe(
      `No geopark matched all 2 filters. Removing designated_to alone would match 5 geoparks. ${NOTICE_2015(2)}`,
    );
  });

  it('counts the 2015-dated geoparks in the whole snapshot, not the match', async () => {
    const { out } = await search({ country: 'JP', designated_from: 2015, designated_to: 2015 });
    expect(ids(out)).toEqual(['ASJP91']);
    expect(out.notice).toBe(NOTICE_2015(2));
  });

  it('uses the singular for one 2015-dated geopark', async () => {
    useHub({ rows: { eg0001: [EG_ROWS[0], EG_ROWS[3]] } });
    const { out } = await search({ designated_to: 2020 });
    expect(out.notice).toBe(
      'The 1 geopark dated 2015 carries the year UNESCO created the UNESCO Global Geopark designation, not the year it joined the Global Geoparks Network, which the data does not record.',
    );
  });

  it('follows a zero-hit fragment and precedes the continuation fragment', async () => {
    const empty = (await search({ country: 'AD', designated_to: 2015 })).out;
    expect(empty.notice).toBe(
      `No geopark matched all 2 filters. Removing country alone would match 2 geoparks. No UNESCO Global Geopark lists AD (Andorra) among its countries. unesco_list_reference with topic countries shows how many geoparks each country has. ${NOTICE_2015(2)}`,
    );
    useHub({ rows: { eg0001: manyEgRows(45) } });
    const { out } = await search({ designated_from: 2015, limit: 10 });
    expect(out.notice).toBe(
      `${NOTICE_2015(5)} Showing results 1–10 of 45; pass next_cursor to continue.`,
    );
  });
});

describe('unesco_search_geoparks — include_description', () => {
  beforeEach(() => {
    useHub();
  });

  const DEFAULT_BLOCK = [
    '**5 geoparks on this page**',
    '',
    '### Alderfen Cliffs UNESCO Global Geopark (EUFR90)',
    'France (FR) · Designated 2015 · Transnational: No · Area: 120000 ha · Population: 52000 · Coordinates: 49.9, 1.5',
    '> The "Alderfen" cliffs record 300 million years of the coast\'s history.',
    '',
    '### Brindle Karst UNESCO Global Geopark (EUA190)',
    'Germany (DE), Poland (PL) · Designated 2018 · Transnational: Yes · Area: 75000 ha · Population: 0 · Coordinates: 51.5, 14.7',
    '> A synthetic karst landscape spanning a river border.',
    '',
    '### Kestrel Caldera UNESCO Global Geopark (ASJP91)',
    'Japan (JP) · Designated 2015 · Transnational: No · Area: 30000 ha · Population: Not available · Coordinates: 38.2, 140.1',
    '> A synthetic caldera lake ringed by hot springs.',
    '',
    '### Murrow Plateau UNESCO Global Geopark (EUIT92)',
    'Italy (IT) · Designated 2023 · Transnational: No · Area: 250000 ha · Population: 410000 · Coordinates: 41, 16.3',
    '> Explore the red earth mines.',
    '> Follow the plateau trail.',
    '',
    '### Ñandu Canyon UNESCO Global Geopark (LAPE93)',
    'Peru (PE) · Designated 2024 · Transnational: No · Area: 2500000 ha · Population: 8000 · Coordinates: -15.3, -73.9',
    '> A synthetic canyon cut through volcanic tuff.',
  ].join('\n');
  const withoutQuotes = (block: string) =>
    block
      .split('\n')
      .filter((l) => !(l === '>' || l.startsWith('> ')))
      .join('\n');

  it('renders the default page with each introduction quoted, list lines kept apart', async () => {
    const { result, out } = await search();
    expect(textBlocks(result)[0]).toBe(DEFAULT_BLOCK);
    expect(out.geoparks.find((g) => g.ugg_id === 'EUIT92')?.introduction).toBe(
      'Explore the red earth mines.\nFollow the plateau trail.',
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
    expect(out.geoparks).toEqual(plain.out.geoparks);
    expect(out.applied_filters).toEqual({ sort: 'name', limit: 20, include_description: true });
    expect(text.split('\n')).toContain('- include_description: true');
  });

  it('drops every introduction and its blockquote when false, and echoes false', async () => {
    const plain = await search();
    const { result, out, text } = await search({ include_description: false });
    expect(out.geoparks).toEqual(
      plain.out.geoparks.map(({ introduction: _introduction, ...rest }) => rest),
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
    const { out, text } = await search({ query: 'springs', include_description: false });
    expect(out.geoparks).toHaveLength(1);
    expect(out.geoparks[0]?.matched_in).toBe('introduction');
    expect(out.geoparks[0]).not.toHaveProperty('introduction');
    expect(text).toContain('Matched in: introduction');
  });

  it('advertises introduction as optional and validates against the output schema in both modes', async () => {
    const json = z.toJSONSchema(tool.output, { io: 'output' }) as unknown as {
      properties: { geoparks: { items: { properties: object; required: string[] } } };
    };
    expect(json.properties.geoparks.items.properties).toHaveProperty('introduction');
    expect(json.properties.geoparks.items.required).not.toContain('introduction');
    expect(json.properties.geoparks.items.required).not.toContain('population');
    for (const include_description of [true, false]) {
      const output = await tool.handler(
        tool.input.parse({ include_description }),
        createMockContext({ errors: tool.errors }),
      );
      expect(() => tool.output.parse(output)).not.toThrow();
      expect(output.geoparks.every((g) => g.introduction !== undefined)).toBe(include_description);
    }
  });

  it('describes the option by the field it drops and the tool that returns it', () => {
    const description = tool.input.shape.include_description.description ?? '';
    expect(description).toContain('introduction');
    expect(description).toContain('unesco_get_geopark');
  });

  describe('across pages', () => {
    beforeEach(() => {
      useHub({ rows: { eg0001: manyEgRows(45) } });
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
        const third = (
          await search({ include_description: minted, limit: 10, cursor: second.next_cursor })
        ).out;
        const whole = (await search({ limit: 30 })).out;
        expect([...ids(first), ...ids(second), ...ids(third)]).toEqual(ids(whole));
        expect(second.geoparks.every((g) => 'introduction' in g === next)).toBe(true);
        expect(third.geoparks.every((g) => 'introduction' in g === minted)).toBe(true);
        expect(second.notice).toBe('Showing results 11–20 of 45; pass next_cursor to continue.');
      },
    );

    it.each([
      ['a filter', { country: 'FR' }],
      ['the sort', { sort: 'area_largest' }],
    ])(
      'still rejects a cursor when %s changes alongside include_description',
      async (_label, change) => {
        const first = (await search({ include_description: false, limit: 10 })).out;
        const error = errorOf(
          await runToolContract(tool, {
            include_description: true,
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
      expect(past.out.geoparks).toEqual([]);
      expect(past.out.notice).toBe(
        'The cursor is past the last of 45 results. Call unesco_search_geoparks without cursor to start over.',
      );
      const empty = await search({ query: 'zzzz', include_description: false });
      expect(empty.out.geoparks).toEqual([]);
      expect(empty.out.notice).toContain('zzzz');
    });
  });
});

describe('unesco_search_geoparks — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(failureCases('eg0001', EG_ROWS.length))(
    'reports %s as snapshot_unavailable',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const error = errorOf(await settle(runToolContract(tool, {})));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'eg0001' });
      expect(error.data?.recovery?.hint).toContain('unesco_search_geoparks');
    },
  );

  it('declares the recovery on the wire for a plain failure', async () => {
    useHub({ intercept: () => httpFailure(404) });
    const result = await runToolContract(tool, {});
    expect(errorOf(result).data).toMatchObject({
      reason: 'snapshot_unavailable',
      retryAfter: 60,
      recovery: { hint: declaredRecovery(tool.errors, 'snapshot_unavailable') },
    });
    expect(allText(result)).toContain('Recovery: The UNESCO Data Hub could not be reached');
  });

  it('validates input before touching the upstream', async () => {
    const hub = useHub({ intercept: () => httpFailure(404) });
    expect(errorOf(await runToolContract(tool, { sort: 'distance' })).data?.reason).toBe(
      'sort_needs_input',
    );
    expect(
      errorOf(await runToolContract(tool, { designated_from: 2020, designated_to: 2019 })).data
        ?.reason,
    ).toBe('invalid_year_range');
    expect(hub.calls).toHaveLength(0);
  });

  it('does not read the sibling datasets', async () => {
    const hub = useHub();
    await search();
    expect(hub.callsFor('whc001')).toHaveLength(0);
    expect(hub.callsFor('ich001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
  });

  it('answers from the geopark snapshot when every sibling dataset is unreachable', async () => {
    useHub({ intercept: (call) => (call.dataset === 'eg0001' ? undefined : httpFailure(404)) });
    expect((await search()).out.totalCount).toBe(5);
  });
});

describe('unesco_search_geoparks — format() parity and text safety', () => {
  beforeEach(() => {
    useHub();
  });

  it('renders every structured field of every geopark', async () => {
    const { result, out, text } = await search({ query: 'geopark' });
    const body = textBlocks(result)[0] ?? '';
    expect(body).toContain('**5 geoparks on this page**');
    for (const g of out.geoparks) {
      const countries = g.country_codes.map((code, i) => `${g.countries[i]} (${code})`).join(', ');
      expect(body).toContain(`### ${g.name} (${g.ugg_id})`);
      expect(body).toContain(
        `${countries} · Designated ${g.designation_year} · Transnational: ${g.transnational ? 'Yes' : 'No'} · Area: ${g.area_hectares} ha · Population: ${g.population ?? 'Not available'} · Coordinates: ${g.latitude}, ${g.longitude} · Matched in: ${g.matched_in}`,
      );
      for (const line of (g.introduction ?? '').split('\n')) expect(body).toContain(`> ${line}`);
    }
    expect(text).toContain('Source: UNESCO — UNESCO Global Geoparks (eg0001)');
  });

  it('renders the distance of every row on a distance search', async () => {
    const { result, out } = await search({ near: { latitude: 48, longitude: 8, radius_km: 800 } });
    const body = textBlocks(result)[0] ?? '';
    expect(out.geoparks.length).toBeGreaterThan(1);
    for (const g of out.geoparks) {
      expect(body).toContain(
        `Coordinates: ${g.latitude}, ${g.longitude} · Distance: ${g.distance_km} km`,
      );
    }
  });

  it('carries the applied filters and facets to content-only clients', async () => {
    const { text } = await search({
      query: 'karst',
      country: 'pol',
      transnational: true,
      designated_from: 2016,
      designated_to: 2020,
      near: { latitude: 51.5, longitude: 14.7, radius_km: 50 },
    });
    for (const line of [
      '- query: "karst"',
      '- country: PL (Poland)',
      '- transnational: true',
      '- designated_from: 2016',
      '- designated_to: 2020',
      '- near: 51.5, 14.7 within 50 km',
      '- sort: relevance',
      '- limit: 20',
      '- include_description: true',
      '- Transnational: yes 1 · no 0',
      '- Top countries: Germany (DE) 1 · Poland (PL) 1',
    ]) {
      expect(text.split('\n'), line).toContain(line);
    }
  });

  it('closes a truncated page with the cursor and puts the same cursor in structuredContent', async () => {
    useHub({ rows: { eg0001: manyEgRows(45) } });
    const { out, text } = await search({ limit: 10 });
    expect(text).toContain(`Next cursor: ${out.next_cursor}`);
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('Showing results 1–10 of 45; pass next_cursor to continue.');
  });

  it('quotes a multi-paragraph introduction line by line', async () => {
    useHub({
      rows: {
        eg0001: [egRow({ introduction_en: 'One.\n\n## Not A Heading\n- not a list' })],
      },
    });
    const { text } = await search();
    expect(text).toContain('> One.\n>\n> ## Not A Heading\n> - not a list');
    expect(text.split('\n').some((l) => l === '## Not A Heading' || l === '- not a list')).toBe(
      false,
    );
  });

  it('renders markdown and HTML metacharacters in upstream text inert', async () => {
    useHub({
      rows: {
        eg0001: [
          egRow({
            title_en: 'Evil\r\n# Injected [link](https://evil.test) <script>',
            introduction_en:
              'Intro.\r\n# Not A Heading ![img](https://evil.test/x.png) <img src=x>',
          }),
        ],
      },
    });
    const { out, text } = await search();
    expect(out.geoparks[0]?.name).toBe('Evil\r\n# Injected [link](https://evil.test) <script>');
    const lines = text.split('\n');
    expect(lines).toContain(
      '### Evil # Injected \\[link\\](https://evil.test) \\<script\\> (EUFR99)',
    );
    expect(text).toContain(
      '> Intro.\n> # Not A Heading !\\[img\\](https://evil.test/x.png) \\<img src=x\\>',
    );
    expect(lines.some((l) => l.startsWith('# Injected') || l.startsWith('# Not'))).toBe(false);
    expect(text).not.toMatch(/\[(?:link|img)\]/);
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
