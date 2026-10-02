/**
 * @fileoverview Tests for unesco_list_reference: every topic's rows and counts
 * over the synthetic fixtures, the blank-as-unset `filter` and its word-prefix
 * matching, zero-match notices, the enrichment contract, per-topic dataset
 * independence, upstream failure classes, and format() parity with
 * structuredContent including pipe and line-break escaping in table cells.
 * @module tests/tools/list-reference.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { CRITERIA, DATASET_IDS } from '@/services/unesco-datahub/vocabulary.js';
import { DATA_AS_OF, type HubOptions, httpFailure } from '../fixtures/hub.js';
import { EG_ROWS, egRow, ICH_ROWS, ichRow, WHC_ROWS, whcRow } from '../fixtures/rows.js';
import {
  allText,
  disposeServiceAfterEach,
  errorOf,
  structured,
  textBlocks,
  useHub,
} from '../fixtures/tool.js';

type ReferenceOutput = z.infer<typeof listReferenceTool.output> & {
  notice?: string;
  sources: { dataset: string; license: string; data_as_of: string }[];
};

disposeServiceAfterEach();

const list = async (input: Record<string, unknown>) => {
  const result = await runToolContract(listReferenceTool, input as never);
  return { result, out: structured<ReferenceOutput>(result), text: allText(result) };
};

const NO_ICH: HubOptions = {
  intercept: (call) => (call.dataset === 'ich001' ? httpFailure(404) : undefined),
};

const NO_EG: HubOptions = {
  intercept: (call) => (call.dataset === 'eg0001' ? httpFailure(404) : undefined),
};

describe('unesco_list_reference — criteria', () => {
  beforeEach(() => {
    useHub();
  });

  it('lists the ten criteria in order with meanings, groups, and site counts', async () => {
    const { out } = await list({ topic: 'criteria' });
    expect(out.topic).toBe('criteria');
    expect(out.criteria?.map((c) => c.code)).toEqual([
      'i',
      'ii',
      'iii',
      'iv',
      'v',
      'vi',
      'vii',
      'viii',
      'ix',
      'x',
    ]);
    const counts = Object.fromEntries((out.criteria ?? []).map((c) => [c.code, c.site_count]));
    expect(counts).toEqual({
      i: 1,
      ii: 1,
      iii: 3,
      iv: 34,
      v: 0,
      vi: 2,
      vii: 1,
      viii: 0,
      ix: 1,
      x: 1,
    });
    expect(out.criteria?.find((c) => c.code === 'vi')).toMatchObject({
      inferred_count: 2,
      group: 'cultural',
      meaning: CRITERIA.vi.meaning,
    });
    expect(out.criteria?.filter((c) => c.inferred_count > 0)).toHaveLength(1);
    expect(out.criteria?.find((c) => c.code === 'ix')?.group).toBe('natural');
  });

  it('attributes only the World Heritage List and never reads the other datasets', async () => {
    const hub = useHub();
    const { out } = await list({ topic: 'criteria' });
    expect(out.sources.map((s) => s.dataset)).toEqual(['whc001']);
    expect(hub.callsFor('ich001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
  });

  it('counts zero everywhere over an empty World Heritage dataset', async () => {
    useHub({ rows: { whc001: [] } });
    const { out } = await list({ topic: 'criteria' });
    expect(out.criteria).toHaveLength(10);
    expect(out.criteria?.every((c) => c.site_count === 0 && c.inferred_count === 0)).toBe(true);
    expect(out.notice).toBeUndefined();
  });
});

describe('unesco_list_reference — countries', () => {
  beforeEach(() => {
    useHub();
  });

  it('lists every country in any dataset, sorted by name, with the code-less party last here', async () => {
    const { out } = await list({ topic: 'countries' });
    expect(out.countries).toHaveLength(9);
    expect(out.countries?.map((c) => c.name)).toEqual([
      'Belgium',
      'Ethiopia',
      'France',
      'Germany',
      'Italy',
      'Japan',
      'Peru',
      'Poland',
      'Synthetic Party Name',
    ]);
  });

  it('counts each dataset per country and carries the alpha-3 code', async () => {
    const { out } = await list({ topic: 'countries' });
    const byCode = Object.fromEntries((out.countries ?? []).map((c) => [c.code ?? 'none', c]));
    expect(byCode.FR).toMatchObject({
      alpha3: 'FRA',
      name: 'France',
      unesco_name: 'France',
      heritage_site_count: 32,
      intangible_element_count: 1,
      biosphere_reserve_count: 1,
      geopark_count: 1,
    });
    expect(byCode.DE).toMatchObject({
      alpha3: 'DEU',
      heritage_site_count: 3,
      intangible_element_count: 0,
      biosphere_reserve_count: 1,
      geopark_count: 1,
    });
    expect(byCode.PL).toMatchObject({
      heritage_site_count: 1,
      biosphere_reserve_count: 1,
      geopark_count: 1,
    });
    expect(byCode.ET).toMatchObject({
      heritage_site_count: 1,
      intangible_element_count: 1,
      geopark_count: 0,
    });
    expect(byCode.JP).toMatchObject({
      heritage_site_count: 1,
      intangible_element_count: 1,
      geopark_count: 1,
    });
    expect(byCode.PE).toMatchObject({
      heritage_site_count: 1,
      biosphere_reserve_count: 1,
      geopark_count: 1,
    });
  });

  it('lists a country that only a geopark carries, with no UNESCO spelling', async () => {
    const { out } = await list({ topic: 'countries' });
    const italy = out.countries?.find((c) => c.code === 'IT');
    expect(italy).toEqual({
      code: 'IT',
      alpha3: 'ITA',
      name: 'Italy',
      heritage_site_count: 0,
      intangible_element_count: 0,
      biosphere_reserve_count: 0,
      geopark_count: 1,
    });
  });

  it('counts a transnational geopark once for each of its countries', async () => {
    useHub({
      rows: {
        eg0001: [
          egRow({ ugg_id: 'EUA301', countries: ['HU,SK'], transnational: 'True' }),
          egRow({ ugg_id: 'EUSK02', countries: ['SK'] }),
          egRow({ ugg_id: 'EUFR03', countries: ['FR'] }),
        ],
      },
    });
    const { out } = await list({ topic: 'countries' });
    const byCode = Object.fromEntries((out.countries ?? []).map((c) => [c.code ?? 'none', c]));
    expect(byCode.SK).toEqual({
      code: 'SK',
      alpha3: 'SVK',
      name: 'Slovakia',
      heritage_site_count: 0,
      intangible_element_count: 0,
      biosphere_reserve_count: 0,
      geopark_count: 2,
    });
    expect(byCode.HU).toMatchObject({ geopark_count: 1, heritage_site_count: 0 });
    expect(byCode.FR?.geopark_count).toBe(1);
    expect(byCode.DE?.geopark_count).toBe(0);
    const total = (out.countries ?? []).reduce((sum, c) => sum + c.geopark_count, 0);
    expect(total).toBe(4);
  });

  it('counts zero geoparks everywhere over an empty geopark dataset', async () => {
    useHub({ rows: { eg0001: [] } });
    const { out } = await list({ topic: 'countries' });
    expect(out.countries?.map((c) => c.code)).not.toContain('IT');
    expect(out.countries).toHaveLength(8);
    expect(out.countries?.every((c) => c.geopark_count === 0)).toBe(true);
  });

  it('gives a country only an intangible element lists no UNESCO spelling', async () => {
    const { out } = await list({ topic: 'countries' });
    const be = out.countries?.find((c) => c.code === 'BE');
    expect(be).toMatchObject({
      alpha3: 'BEL',
      name: 'Belgium',
      heritage_site_count: 0,
      intangible_element_count: 1,
      biosphere_reserve_count: 0,
    });
    expect(be).not.toHaveProperty('unesco_name');
  });

  it('lists the code-less State Party by its UNESCO text with no code or alpha-3', async () => {
    const { out } = await list({ topic: 'countries' });
    const codeless = out.countries?.find((c) => c.code === undefined);
    expect(codeless).toEqual({
      name: 'Synthetic Party Name',
      unesco_name: 'Synthetic Party Name',
      heritage_site_count: 1,
      intangible_element_count: 0,
      biosphere_reserve_count: 0,
      geopark_count: 0,
    });
  });

  it('attributes all four datasets', async () => {
    const hub = useHub();
    const { out } = await list({ topic: 'countries' });
    expect(out.sources.map((s) => s.dataset)).toEqual(['whc001', 'ich001', 'mab001', 'eg0001']);
    expect(out.sources.every((s) => s.data_as_of === DATA_AS_OF)).toBe(true);
    expect(hub.callsFor('eg0001', 'export')).toHaveLength(1);
  });

  it('still lists countries from the other datasets when the World Heritage dataset is empty', async () => {
    useHub({ rows: { whc001: [] } });
    const { out } = await list({ topic: 'countries' });
    const codes = out.countries?.map((c) => c.code);
    expect(codes).toContain('FR');
    expect(out.countries?.find((c) => c.code === 'FR')?.heritage_site_count).toBe(0);
    expect(out.countries?.some((c) => c.code === undefined)).toBe(false);
  });
});

describe('unesco_list_reference — regions, lists, networks, datasets', () => {
  beforeEach(() => {
    useHub();
  });

  it('counts sites and reserves per region with the region codes', async () => {
    const { out } = await list({ topic: 'regions' });
    expect(out.regions).toEqual([
      { name: 'Africa', code: 'AFR', heritage_site_count: 1, biosphere_reserve_count: 0 },
      { name: 'Arab States', code: 'ARB', heritage_site_count: 1, biosphere_reserve_count: 0 },
      {
        name: 'Asia and the Pacific',
        code: 'APA',
        heritage_site_count: 1,
        biosphere_reserve_count: 0,
      },
      {
        name: 'Europe and North America',
        code: 'EUR',
        heritage_site_count: 35,
        biosphere_reserve_count: 3,
      },
      {
        name: 'Latin America and the Caribbean',
        code: 'LAC',
        heritage_site_count: 1,
        biosphere_reserve_count: 1,
      },
    ]);
  });

  it('attributes the World Heritage and biosphere datasets for regions, and not the intangible one', async () => {
    const hub = useHub();
    const { out } = await list({ topic: 'regions' });
    expect(out.sources.map((s) => s.dataset)).toEqual(['whc001', 'mab001']);
    expect(hub.callsFor('ich001')).toHaveLength(0);
  });

  it('counts the elements on each intangible list with its acronym', async () => {
    const { out } = await list({ topic: 'intangible_lists' });
    expect(out.intangible_lists).toEqual([
      { name: 'Representative List', acronym: 'RL', element_count: 1 },
      { name: 'Urgent Safeguarding List', acronym: 'USL', element_count: 1 },
      { name: 'Register of Good Safeguarding Practices', acronym: 'Art18', element_count: 1 },
    ]);
    expect(out.sources.map((s) => s.dataset)).toEqual(['ich001']);
  });

  it('counts reserves per MAB network and adds the no-network row without an acronym', async () => {
    const { out } = await list({ topic: 'biosphere_networks' });
    expect(out.biosphere_networks).toHaveLength(8);
    const euro = out.biosphere_networks?.find((n) => n.acronym === 'EuroMAB');
    expect(euro).toMatchObject({
      name: 'Europe and North America Biosphere Reserve Network (EuroMAB)',
      reserve_count: 3,
    });
    const none = out.biosphere_networks?.at(-1);
    expect(none).toEqual({ name: 'No regional network', reserve_count: 1 });
    expect(none).not.toHaveProperty('acronym');
    const others = out.biosphere_networks?.filter(
      (n) => n.acronym !== 'EuroMAB' && n.acronym !== undefined,
    );
    expect(others?.every((n) => n.reserve_count === 0)).toBe(true);
    expect(out.sources.map((s) => s.dataset)).toEqual(['mab001']);
  });

  it('reports each dataset with its record count, license, date, attribution, and notes', async () => {
    const { out } = await list({ topic: 'datasets' });
    expect(out.datasets?.map((d) => [d.dataset, d.records])).toEqual([
      ['whc001', 39],
      ['ich001', 3],
      ['mab001', 4],
      ['eg0001', EG_ROWS.length],
    ]);
    for (const d of out.datasets ?? []) {
      expect(d).toMatchObject({
        license: 'CC BY-SA 4.0',
        license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
        data_as_of: DATA_AS_OF,
      });
      expect(d.attribution).toContain(d.dataset);
      expect(d.coverage_notes.length).toBeGreaterThan(0);
    }
    const [whc, ich] = out.datasets ?? [];
    expect(whc?.coverage_notes[0]).toContain('(2 sites)');
    expect(ich?.coverage_notes[0]).toBe(
      'The 1 element dated 2008 carries the year of incorporation into the Representative List, not the earlier proclamation.',
    );
  });

  it('reports the geopark dataset with its title, attribution, and coverage notes', async () => {
    const { out } = await list({ topic: 'datasets' });
    const eg = out.datasets?.find((d) => d.dataset === 'eg0001');
    expect(eg).toEqual({
      dataset: 'eg0001',
      title: 'UNESCO Global Geoparks',
      records: 5,
      data_as_of: DATA_AS_OF,
      license: 'CC BY-SA 4.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      attribution: 'UNESCO — UNESCO Global Geoparks (eg0001), UNESCO Data Hub, CC BY-SA 4.0',
      coverage_notes: [
        'The 2 geoparks dated 2015 carry the year UNESCO created the UNESCO Global Geopark designation, not the year each joined the Global Geoparks Network, which the data does not record.',
        'Areas and populations are passed through as recorded; population is absent where UNESCO records no figure, and 0 can mean unreported.',
        'Images are omitted, because the dataset records no image credit.',
      ],
    });
    expect(out.sources.map((s) => s.dataset)).toEqual(['whc001', 'ich001', 'mab001', 'eg0001']);
  });

  it('counts the 2015-dated geoparks from the loaded snapshot, singular for one', async () => {
    useHub({
      rows: {
        eg0001: [
          egRow({ ugg_id: 'EUFR01', date: '2015-01-01' }),
          egRow({ ugg_id: 'EUFR02', date: '2016-01-01' }),
        ],
      },
    });
    const { out } = await list({ topic: 'datasets' });
    const eg = out.datasets?.find((d) => d.dataset === 'eg0001');
    expect(eg?.records).toBe(2);
    expect(eg?.coverage_notes[0]).toBe(
      'The 1 geopark dated 2015 carries the year UNESCO created the UNESCO Global Geopark designation, not the year it joined the Global Geoparks Network, which the data does not record.',
    );
  });

  it('reports an empty geopark dataset as zero records with its notes', async () => {
    useHub({ rows: { eg0001: [] } });
    const { out } = await list({ topic: 'datasets' });
    const eg = out.datasets?.find((d) => d.dataset === 'eg0001');
    expect(eg?.records).toBe(0);
    expect(eg?.coverage_notes[0]).toMatch(/^The 0 geoparks dated 2015 carry /);
  });
});

describe('unesco_list_reference — filter', () => {
  beforeEach(() => {
    useHub();
  });

  it('keeps entries containing a matching word', async () => {
    const { out } = await list({ topic: 'countries', filter: 'germany' });
    expect(out.countries?.map((c) => c.code)).toEqual(['DE']);
  });

  it('matches a word prefix, ignoring case and accents', async () => {
    const { out } = await list({ topic: 'countries', filter: 'GERM' });
    expect(out.countries?.map((c) => c.code)).toEqual(['DE']);
    const accented = await list({ topic: 'criteria', filter: 'MASTERPIÉCE' });
    expect(accented.out.criteria?.map((c) => c.code)).toEqual(['i']);
    const plain = await list({ topic: 'criteria', filter: 'Masterpiece' });
    expect(plain.out.criteria?.map((c) => c.code)).toEqual(['i']);
  });

  it('matches across columns: the ISO code, the alpha-3, and the name together', async () => {
    const { out } = await list({ topic: 'countries', filter: 'fr fra france' });
    expect(out.countries?.map((c) => c.code)).toEqual(['FR']);
    const byAlpha3 = await list({ topic: 'countries', filter: 'deu' });
    expect(byAlpha3.out.countries?.map((c) => c.code)).toEqual(['DE']);
  });

  it('requires every word to match', async () => {
    const { out } = await list({ topic: 'countries', filter: 'germany france' });
    expect(out.countries).toEqual([]);
  });

  it('filters the other topics by name and code', async () => {
    expect(
      (await list({ topic: 'regions', filter: 'eur' })).out.regions?.map((r) => r.code),
    ).toEqual(['EUR']);
    expect(
      (await list({ topic: 'intangible_lists', filter: 'urgent' })).out.intangible_lists?.map(
        (l) => l.acronym,
      ),
    ).toEqual(['USL']);
    expect(
      (await list({ topic: 'biosphere_networks', filter: 'euromab' })).out.biosphere_networks?.map(
        (n) => n.acronym,
      ),
    ).toEqual(['EuroMAB']);
    expect(
      (await list({ topic: 'datasets', filter: 'whc001' })).out.datasets?.map((d) => d.dataset),
    ).toEqual(['whc001']);
    expect(
      (await list({ topic: 'datasets', filter: 'geoparks' })).out.datasets?.map((d) => d.dataset),
    ).toEqual(['eg0001']);
    expect(
      (await list({ topic: 'countries', filter: 'italy' })).out.countries?.map((c) => [
        c.code,
        c.geopark_count,
      ]),
    ).toEqual([['IT', 1]]);
  });

  it.each(['', '   '])('reads a blank filter %j as unset', async (filter) => {
    const { out } = await list({ topic: 'criteria', filter });
    expect(out.criteria).toHaveLength(10);
    expect(out.notice).toBeUndefined();
  });

  it('trims the filter', async () => {
    const { out } = await list({ topic: 'countries', filter: '  germany  ' });
    expect(out.countries).toHaveLength(1);
  });

  it('reports a notice and an empty list when nothing matches, on the zero-result page', async () => {
    const { out, text } = await list({ topic: 'countries', filter: 'nomatchword' });
    expect(out.countries).toEqual([]);
    expect(out.notice).toBe(
      'No countries entry contains every word of "nomatchword". Call unesco_list_reference with topic countries and no filter to see every entry.',
    );
    expect(out.sources).toHaveLength(4);
    expect(text).toContain('_No entries._');
    expect(text).toContain(out.notice as string);
  });

  it('flattens line breaks in the echoed filter', async () => {
    const { out } = await list({ topic: 'regions', filter: 'no\nmatch' });
    expect(out.notice).toContain('every word of "no match"');
    expect(out.notice).not.toMatch(/[\r\n]/);
  });

  it('returns a partial page with no notice when the filter matches some entries', async () => {
    const { out } = await list({ topic: 'countries', filter: 'p' });
    expect(out.countries?.length).toBeGreaterThan(0);
    expect(out.countries?.length).toBeLessThan(9);
    expect(out.notice).toBeUndefined();
    expect(out.sources).toHaveLength(4);
  });

  it('gives each topic its own notice wording', async () => {
    for (const topic of [
      'criteria',
      'regions',
      'intangible_lists',
      'biosphere_networks',
      'datasets',
    ]) {
      const { out } = await list({ topic, filter: 'nomatchword' });
      expect(out.notice, topic).toContain(`No ${topic} entry contains every word`);
      expect(out.notice, topic).toContain(`topic ${topic} and no filter`);
    }
  });
});

describe('unesco_list_reference — countries filter: codes and alternate names', () => {
  const EXTRA_CODES = ['UA', 'GB', 'TR', 'CZ', 'CI', 'SZ', 'TL', 'NL', 'CD', 'CG'];

  beforeEach(() => {
    useHub({
      rows: {
        ich001: [
          ...ICH_ROWS,
          ...EXTRA_CODES.map((code, i) =>
            ichRow({
              ich_public_ref: String(5001 + i),
              countries: [code],
              http_url_en: `https://ich.unesco.org/en/RL/0${5001 + i}`,
            }),
          ),
        ],
      },
    });
  });

  it.each([
    ['UK', 'GB'],
    ['uk', 'GB'],
    [' Uk ', 'GB'],
    ['gbr', 'GB'],
    ['GB', 'GB'],
    ['UA', 'UA'],
    ['ukr', 'UA'],
    ['fra', 'FR'],
  ])(
    'reads the code-shaped filter %j exactly as a country input reads it (%s)',
    async (filter, code) => {
      const { out } = await list({ topic: 'countries', filter });
      expect(out.countries?.map((c) => c.code)).toEqual([code]);
    },
  );

  it('says an assigned code that no dataset lists is a real code with no records', async () => {
    const { out } = await list({ topic: 'countries', filter: 'aq' });
    expect(out.countries).toEqual([]);
    expect(out.notice).toBe(
      'AQ (Antarctica) is an assigned ISO 3166-1 code, but no UNESCO dataset lists that country.',
    );
  });

  it('keeps a code that only a transnational geopark carries', async () => {
    useHub({
      rows: {
        eg0001: [egRow({ ugg_id: 'EUA301', countries: ['HU,SK'], transnational: 'True' })],
      },
    });
    const { out } = await list({ topic: 'countries', filter: 'svk' });
    expect(out.countries).toEqual([
      expect.objectContaining({ code: 'SK', heritage_site_count: 0, geopark_count: 1 }),
    ]);
    expect(out.notice).toBeUndefined();
  });

  it('keeps word-prefix matching for a short filter that is not an assigned code', async () => {
    const { out } = await list({ topic: 'countries', filter: 'ger' });
    expect(out.countries?.map((c) => c.code)).toEqual(['DE']);
  });

  it.each([
    ['Turkey', 'TR'],
    ['Czech Republic', 'CZ'],
    ['Ivory Coast', 'CI'],
    ['Swaziland', 'SZ'],
    ['East Timor', 'TL'],
    ['Holland', 'NL'],
    ['DR Congo', 'CD'],
    ['Republic of the Congo', 'CG'],
    ['england', 'GB'],
  ])('resolves the former or everyday name %j to %s', async (filter, code) => {
    const { out } = await list({ topic: 'countries', filter });
    expect(out.countries?.map((c) => c.code)).toEqual([code]);
  });
});

describe('unesco_list_reference — input validation', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['an unknown topic', { topic: 'sites' }],
    ['a missing topic', {}],
    ['a blank topic', { topic: '' }],
    ['a filter over 100 characters', { topic: 'criteria', filter: 'a'.repeat(101) }],
    ['a filter object', { topic: 'criteria', filter: { text: 'x' } }],
  ])('rejects %s as invalid arguments', async (_label, input) => {
    const error = errorOf(await runToolContract(listReferenceTool, input as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it('accepts a filter of exactly 100 characters', async () => {
    const { out } = await list({ topic: 'criteria', filter: 'a'.repeat(100) });
    expect(out.criteria).toEqual([]);
    expect(out.notice).toBeDefined();
  });
});

describe('unesco_list_reference — declared errors and dataset independence', () => {
  it('snapshot_unavailable with the declared recovery when one dataset fails', async () => {
    useHub(NO_ICH);
    const result = await runToolContract(listReferenceTool, { topic: 'countries' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'snapshot_unavailable',
      dataset: 'ich001',
      retryAfter: 60,
      recovery: { hint: expect.stringContaining('unesco_list_reference') },
    });
    expect(allText(result)).toContain('Recovery: The UNESCO Data Hub could not be reached');
  });

  it.each(['countries', 'datasets', 'intangible_lists'])(
    'fails topic %s when the intangible dataset is down',
    async (topic) => {
      useHub(NO_ICH);
      const error = errorOf(await runToolContract(listReferenceTool, { topic } as never));
      expect(error.data?.reason).toBe('snapshot_unavailable');
    },
  );

  it.each(['criteria', 'regions', 'biosphere_networks'])(
    'still serves topic %s when the intangible dataset is down',
    async (topic) => {
      useHub(NO_ICH);
      const { out } = await list({ topic });
      expect(out.topic).toBe(topic);
      expect(out.sources.every((s) => s.dataset !== 'ich001')).toBe(true);
    },
  );

  it.each(['countries', 'datasets'])(
    'fails topic %s as a whole with the geopark dataset named when it cannot load',
    async (topic) => {
      useHub(NO_EG);
      const result = await runToolContract(listReferenceTool, { topic } as never);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'snapshot_unavailable',
        dataset: 'eg0001',
        retryable: true,
        retryAfter: 60,
        recovery: { hint: expect.stringContaining('unesco_list_reference') },
      });
      expect(result.structuredContent).not.toHaveProperty(topic);
      expect(allText(result)).toContain('UNESCO Global Geoparks (eg0001)');
    },
  );

  it.each(['criteria', 'regions', 'intangible_lists', 'biosphere_networks'])(
    'serves topic %s without reading the geopark dataset, even while it is down',
    async (topic) => {
      const hub = useHub(NO_EG);
      const { out } = await list({ topic });
      expect(out.topic).toBe(topic);
      expect(out.sources.every((s) => s.dataset !== 'eg0001')).toBe(true);
      expect(hub.callsFor('eg0001')).toHaveLength(0);
    },
  );

  it('names the failing dataset when the World Heritage dataset is down', async () => {
    useHub({ intercept: (call) => (call.dataset === 'whc001' ? httpFailure(404) : undefined) });
    const error = errorOf(await runToolContract(listReferenceTool, { topic: 'criteria' }));
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'whc001' });
  });

  it('carries the declared reason on a thrown error when the handler is called directly', async () => {
    useHub(NO_ICH);
    await expect(
      listReferenceTool.handler(
        listReferenceTool.input.parse({ topic: 'datasets' }),
        createMockContext({ errors: listReferenceTool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'snapshot_unavailable' },
    });
  });
});

describe('unesco_list_reference — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
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
    const pending = runToolContract(listReferenceTool, { topic: 'criteria' });
    await vi.advanceTimersByTimeAsync(10_000);
    const error = errorOf(await pending);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'whc001' });
  });

  it('reports a license change as snapshot_unavailable', async () => {
    useHub({ metas: { ich001: { license: 'All rights reserved' } } });
    const error = errorOf(await runToolContract(listReferenceTool, { topic: 'datasets' }));
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'ich001' });
  });

  it('reports a schema-invalid row as snapshot_unavailable', async () => {
    useHub({ rows: { whc001: [whcRow({ region: 'Atlantis' })] } });
    const error = errorOf(await runToolContract(listReferenceTool, { topic: 'regions' }));
    expect(error.data?.reason).toBe('snapshot_unavailable');
  });
});

describe('unesco_list_reference — format() parity and text safety', () => {
  beforeEach(() => {
    useHub();
  });

  it('renders a criteria table carrying every structured field', async () => {
    const { result, out } = await list({ topic: 'criteria' });
    const body = textBlocks(result)[0] ?? '';
    expect(body).toContain('## UNESCO reference: criteria');
    expect(body).toContain('| Code | Group | Meaning | Sites | Inferred |');
    for (const c of out.criteria ?? []) {
      expect(body).toContain(
        `| (${c.code}) | ${c.group} | ${c.meaning} | ${c.site_count} | ${c.inferred_count} |`,
      );
    }
  });

  it('renders every country row, with the no-code and no-spelling fallbacks', async () => {
    const { result, out } = await list({ topic: 'countries' });
    const body = textBlocks(result)[0] ?? '';
    expect(body).toContain(
      '| Code | Alpha-3 | Name | UNESCO name | World Heritage sites | Intangible elements | Biosphere reserves | Geoparks |',
    );
    for (const c of out.countries ?? []) {
      expect(body).toContain(
        `| ${c.code ?? 'No ISO code'} | ${c.alpha3 ?? '—'} | ${c.name} | ${c.unesco_name ?? '—'} | ${c.heritage_site_count} | ${c.intangible_element_count} | ${c.biosphere_reserve_count} | ${c.geopark_count} |`,
      );
    }
    expect(body).toContain('| BE | BEL | Belgium | — | 0 | 1 | 0 | 0 |');
    expect(body).toContain('| IT | ITA | Italy | — | 0 | 0 | 0 | 1 |');
    expect(body).toContain(
      '| No ISO code | — | Synthetic Party Name | Synthetic Party Name | 1 | 0 | 0 | 0 |',
    );
  });

  it('renders regions, lists, and networks with their codes and counts', async () => {
    const regions = (await list({ topic: 'regions' })).text;
    expect(regions).toContain('| Europe and North America | EUR | 35 | 3 |');
    const lists = (await list({ topic: 'intangible_lists' })).text;
    expect(lists).toContain('| Urgent Safeguarding List | USL | 1 |');
    const networks = (await list({ topic: 'biosphere_networks' })).text;
    expect(networks).toContain(
      '| Europe and North America Biosphere Reserve Network (EuroMAB) | EuroMAB | 3 |',
    );
    expect(networks).toContain('| No regional network | — | 1 |');
  });

  it('renders the dataset table and every coverage note', async () => {
    const { out, text } = await list({ topic: 'datasets' });
    for (const d of out.datasets ?? []) {
      expect(text).toContain(`| ${d.dataset} | ${d.title} | ${d.records} | ${d.data_as_of} |`);
      expect(text).toContain(`**Coverage notes — ${d.dataset}:**`);
      for (const note of d.coverage_notes) expect(text).toContain(`- ${note}`);
    }
  });

  it('closes with one source line per attributed dataset', async () => {
    const { text } = await list({ topic: 'countries' });
    for (const dataset of ['whc001', 'ich001', 'mab001', 'eg0001']) {
      expect(text).toContain(`(${dataset}), data as of ${DATA_AS_OF}, CC BY-SA 4.0`);
    }
    expect(text).toContain(
      `Source: UNESCO — UNESCO Global Geoparks (eg0001), data as of ${DATA_AS_OF}, CC BY-SA 4.0`,
    );
  });

  it('advertises every dataset id in the sources enum', () => {
    const sources = listReferenceTool.enrichment?.sources;
    expect(sources).toBeDefined();
    expect(z.toJSONSchema(sources as z.ZodType)).toMatchObject({
      items: { properties: { dataset: { enum: [...DATASET_IDS] } } },
    });
    expect(DATASET_IDS).toContain('eg0001');
  });

  it('keeps a code-less State Party name with a pipe and line breaks inside one table cell', async () => {
    useHub({
      rows: {
        whc001: [
          whcRow({
            id_no: '920',
            states_names: ['Party | One\r\n# Two\\Three'],
            iso_codes: null,
          }),
        ],
      },
    });
    const { text } = await list({ topic: 'countries' });
    const rows = text.split('\n').filter((line) => line.includes('Party'));
    expect(rows).toHaveLength(1);
    const row = rows[0] as string;
    expect(row).toContain('Party \\| One # Two\\\\Three');
    const cells = row.split(/(?<!\\)\|/);
    expect(cells).toHaveLength(10);
    expect(text.split('\n').some((l) => l.startsWith('# Two'))).toBe(false);
  });

  it('never emits raw line-break characters inside a table row', async () => {
    const nel = String.fromCodePoint(0x85);
    const lineSep = String.fromCodePoint(0x2028);
    useHub({
      rows: {
        whc001: [
          whcRow({
            id_no: '921',
            states_names: [`Row${nel}Break${lineSep}Name`],
            iso_codes: null,
          }),
        ],
      },
    });
    const { text } = await list({ topic: 'countries' });
    expect(text).not.toContain(nel);
    expect(text).not.toContain(lineSep);
    expect(text).toContain('| Row Break Name |');
  });

  it('renders _No entries._ for an empty topic table', async () => {
    const { text } = await list({ topic: 'criteria', filter: 'nomatchword' });
    expect(text).toContain('## UNESCO reference: criteria\n\n_No entries._');
  });

  it('serves the same data on the default fixture set as the structured rows', async () => {
    const { out, text } = await list({ topic: 'countries' });
    expect((out.countries ?? []).length).toBe(
      text.split('\n').filter((l) => /^\| .* \|$/.test(l)).length - 2,
    );
    expect(WHC_ROWS.length).toBe(39);
  });
});
