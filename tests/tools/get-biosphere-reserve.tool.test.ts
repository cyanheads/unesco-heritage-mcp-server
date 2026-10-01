/**
 * @fileoverview Tests for unesco_get_biosphere_reserve: mab_id normalization
 * (case, diacritics, percent-escapes, Unicode forms) and validation, the full
 * record and its sparse shapes, as-recorded areas and populations, the declared
 * error contracts, upstream failure classes, format() parity with
 * structuredContent, and CR/LF in upstream text staying out of inline slots.
 * @module tests/tools/get-biosphere-reserve.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBiosphereReserveTool as tool } from '@/mcp-server/tools/definitions/get-biosphere-reserve.tool.js';
import { declaredRecovery } from '../fixtures/contract.js';
import { failureCases, settle, withFakeTimers } from '../fixtures/failures.js';
import { httpFailure } from '../fixtures/hub.js';
import { MAB_ROWS, mabRow } from '../fixtures/rows.js';
import {
  allText,
  disposeServiceAfterEach,
  errorOf,
  structured,
  textBlocks,
  useHub,
} from '../fixtures/tool.js';

type ReserveOutput = z.infer<typeof tool.output> & {
  sources: {
    attribution: string;
    data_as_of: string;
    dataset: string;
    license: string;
    title: string;
  }[];
};

const EURO_MAB = 'Europe and North America Biosphere Reserve Network (EuroMAB)';

disposeServiceAfterEach();

const get = async (input: Record<string, unknown>) => {
  const result = await runToolContract(tool, input as never);
  return { result, out: structured<ReserveOutput>(result), text: allText(result) };
};

describe('unesco_get_biosphere_reserve — record', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns the full record for a reserve with every optional field', async () => {
    const { out } = await get({ mab_id: 'FRAlder1998' });
    expect(out).toEqual({
      mab_id: 'FRAlder1998',
      name: 'Alderfen Marsh Reserve',
      country_code: 'FR',
      country: 'France',
      regions: ['Europe and North America'],
      regional_network: EURO_MAB,
      designation_year: 1998,
      extension_years: [2004, 2016],
      renaming_years: [2010],
      periodic_review_years: [2010, 2020, 2025],
      transboundary: false,
      sids: false,
      area_hectares: {
        total: 5000,
        terrestrial: { total: 5000, core: 1000, buffer: 2000, transition: 2000 },
        marine: { total: 0, core: 0, buffer: 0, transition: 0 },
      },
      population: { total: 1000, core: 0, buffer: 400, transition: 600 },
      latitude: 48.5,
      longitude: 2.5,
      introduction: 'A synthetic reserve used as test data.',
      ecological_characteristics: "Marsh 'core' habitat.",
      socio_economic_characteristics: 'Synthetic villages.',
      website: 'https://reserve.example.test/alderfen',
      url: 'https://www.unesco.org/en/mab/placeholder',
      sources: expect.any(Array),
    });
  });

  it('carries the source attribution', async () => {
    const { out } = await get({ mab_id: 'FRAlder1998' });
    expect(out.sources).toEqual([
      {
        dataset: 'mab001',
        title: 'Man and the Biosphere Programme',
        data_as_of: '2026-09-30T02:06:00+00:00',
        license: 'CC BY-SA 4.0',
        attribution:
          'UNESCO — Man and the Biosphere Programme (mab001), UNESCO Data Hub, CC BY-SA 4.0',
      },
    ]);
  });

  it('keeps a sparse reserve sparse and renders explicit unknowns', async () => {
    const { out, text } = await get({ mab_id: 'PEÑandu2001' });
    for (const key of [
      'regional_network',
      'ecological_characteristics',
      'socio_economic_characteristics',
      'website',
    ]) {
      expect(out, key).not.toHaveProperty(key);
    }
    expect(out).toMatchObject({
      extension_years: [],
      renaming_years: [],
      periodic_review_years: [],
      regions: ['Latin America and the Caribbean'],
      latitude: -10,
      longitude: -75,
    });
    expect(text).toContain('- **Regional network:** No regional network');
    expect(text).toContain('**Ecological characteristics:** Not available');
    expect(text).toContain('**Socio-economic characteristics:** Not available');
    expect(text).toContain('**Website:** Not available');
    expect(text).toContain('- **Extension years:** None');
    expect(text).toContain('- **Renaming years:** None');
    expect(text).toContain('- **Periodic review years:** None');
  });

  it('drops a website that is not an http(s) URL', async () => {
    const { out, text } = await get({ mab_id: 'DEBrin1993' });
    expect(out).not.toHaveProperty('website');
    expect(text).toContain('**Website:** Not available');
    expect(out.transboundary).toBe(true);
  });

  it('gives each participating country of a transboundary reserve its own record', async () => {
    const de = (await get({ mab_id: 'DEBrin1993' })).out;
    const pl = (await get({ mab_id: 'PLBrin1993' })).out;
    expect([de.country_code, pl.country_code]).toEqual(['DE', 'PL']);
    expect(de.name).toBe(pl.name);
    expect(de.mab_id).not.toBe(pl.mab_id);
  });

  it('passes areas and populations through as recorded, without computing totals', async () => {
    useHub({
      rows: {
        mab001: [
          mabRow({
            mab_id: 'ZZOdd2000',
            area_total: 100,
            area_total_terrestrial: 50,
            area_core_terrestrial: 10,
            area_buffer_terrestrial: 10,
            area_transition_terrestrial: 10,
            area_total_marine: 5,
            area_core_marine: 1,
            area_buffer_marine: 1,
            area_transition_marine: 1,
            population_total: 0,
            population_core: 5,
            population_buffer: 6,
            population_transition: 7,
          }),
        ],
      },
    });
    const { out, text } = await get({ mab_id: 'ZZOdd2000' });
    expect(out.area_hectares).toEqual({
      total: 100,
      terrestrial: { total: 50, core: 10, buffer: 10, transition: 10 },
      marine: { total: 5, core: 1, buffer: 1, transition: 1 },
    });
    expect(out.population).toEqual({ total: 0, core: 5, buffer: 6, transition: 7 });
    expect(text).toContain('| Core | 10 | 1 | 5 |');
    expect(text).toContain('| Buffer | 10 | 1 | 6 |');
    expect(text).toContain('| Transition | 10 | 1 | 7 |');
    expect(text).toContain('| Total | 50 | 5 | 0 |');
    expect(text).toContain('- **Total area:** 100 ha (as recorded)');
  });

  it('lists a reserve that spans two regions once per region, deduplicated', async () => {
    useHub({
      rows: {
        mab001: [mabRow({ mab_id: 'ZZTwo2000', regional_group: 'Africa,Arab States,Africa' })],
      },
    });
    const { out, text } = await get({ mab_id: 'ZZTwo2000' });
    expect(out.regions).toEqual(['Africa', 'Arab States']);
    expect(text).toContain('- **Regions:** Africa, Arab States');
  });
});

describe('unesco_get_biosphere_reserve — mab_id input', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['the exact id', 'FRAlder1998'],
    ['a lowercase id', 'fralder1998'],
    ['an uppercase id', 'FRALDER1998'],
    ['an id with surrounding whitespace', '  FRAlder1998\n'],
    ['a percent-encoded id', 'FR%41lder1998'],
  ])('resolves %s to the reserve', async (_label, mab_id) => {
    const { out } = await get({ mab_id });
    expect(out.mab_id).toBe('FRAlder1998');
  });

  it.each([
    ['the exact non-ASCII id', 'PEÑandu2001'],
    ['a percent-encoded non-ASCII id', 'PE%C3%91andu2001'],
    ['a lowercase percent-encoded id', 'pe%c3%b1andu2001'],
    ['a decomposed (NFD) id', 'PEÑandu2001'.normalize('NFD')],
    ['the id with the diacritic folded away', 'PENandu2001'],
    ['the id in lowercase with the diacritic folded away', 'penandu2001'],
    ['the id in lowercase with the diacritic kept', 'peñandu2001'],
  ])('resolves %s to the reserve', async (_label, mab_id) => {
    const { out } = await get({ mab_id });
    expect(out.mab_id).toBe('PEÑandu2001');
    expect(out.mab_id).toBe(out.mab_id.normalize('NFC'));
  });

  it.each([
    ['a blank string (required, never unset)', ''],
    ['whitespace', '   '],
    ['an id over 20 characters', 'FRAlder1998FRAlder199'],
    ['null', null],
    ['an object', { id: 'FRAlder1998' }],
  ])('rejects %s as invalid arguments', async (_label, mab_id) => {
    const error = errorOf(await runToolContract(tool, { mab_id } as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it('rejects a missing mab_id and names the field in the hint', async () => {
    const error = errorOf(await runToolContract(tool, {} as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.recovery?.hint).toContain('mab_id');
  });

  it('never resolves an id that percent-decodes to whitespace only', async () => {
    const error = errorOf(await runToolContract(tool, { mab_id: '%20%20' } as never));
    expect([JsonRpcErrorCode.InvalidParams, JsonRpcErrorCode.NotFound]).toContain(error.code);
  });

  it('accepts exactly 20 characters', async () => {
    useHub({ rows: { mab001: [mabRow({ mab_id: 'ZZ12345678901234567A' })] } });
    const { out } = await get({ mab_id: 'ZZ12345678901234567A' });
    expect(out.mab_id).toBe('ZZ12345678901234567A');
  });

  it('measures the length after percent-decoding, so a long encoded id still fits', async () => {
    const { out } = await get({ mab_id: 'PE%C3%91andu2001' });
    expect(out.mab_id).toBe('PEÑandu2001');
  });

  it.each([
    ['a malformed percent-escape', '%E0%A4%A'],
    ['a lone percent sign', '%'],
    ['an unknown id', 'ZZNone9999'],
    ['a number (arrives as a digit string that matches no id)', 1998],
  ])('reports %s as not found rather than throwing', async (_label, mab_id) => {
    const error = errorOf(await runToolContract(tool, { mab_id } as never));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('biosphere_reserve_not_found');
  });
});

describe('unesco_get_biosphere_reserve — declared errors', () => {
  it('biosphere_reserve_not_found: NotFound with reason, id, and the declared recovery', async () => {
    useHub();
    const result = await runToolContract(tool, { mab_id: 'ZZNone9999' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'biosphere_reserve_not_found',
      mab_id: 'ZZNone9999',
      recovery: { hint: declaredRecovery(tool.errors, 'biosphere_reserve_not_found') },
    });
    expect(error.data?.recovery?.hint).toContain('unesco_search_biosphere_reserves');
    expect(allText(result)).toContain('Recovery: Find the reserve');
    expect(allText(result)).toContain('(reason biosphere_reserve_not_found)');
  });

  it('biosphere_reserve_not_found via the handler directly carries the reason on the thrown error', async () => {
    useHub();
    await expect(
      tool.handler(
        tool.input.parse({ mab_id: 'ZZNone9999' }),
        createMockContext({ errors: tool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'biosphere_reserve_not_found' },
    });
  });

  it('reports the id as decoded and normalized in the not-found data', async () => {
    useHub();
    const error = errorOf(await runToolContract(tool, { mab_id: ' ZZ%C3%91one ' }));
    expect(error.data?.mab_id).toBe('ZZÑone');
  });

  it('biosphere_reserve_not_found on an empty dataset', async () => {
    useHub({ rows: { mab001: [] } });
    const error = errorOf(await runToolContract(tool, { mab_id: 'FRAlder1998' }));
    expect(error.data?.reason).toBe('biosphere_reserve_not_found');
  });

  it('snapshot_unavailable: ServiceUnavailable with dataset, retryAfter, and the declared recovery', async () => {
    useHub({ intercept: () => httpFailure(404) });
    const result = await runToolContract(tool, { mab_id: 'FRAlder1998' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'snapshot_unavailable',
      dataset: 'mab001',
      retryAfter: 60,
      recovery: { hint: declaredRecovery(tool.errors, 'snapshot_unavailable') },
    });
    expect(allText(result)).toContain('Recovery: The UNESCO Data Hub could not be reached');
  });

  it('fails fast on later calls during the backoff without touching the upstream', async () => {
    const hub = useHub({ intercept: () => httpFailure(404) });
    await runToolContract(tool, { mab_id: 'FRAlder1998' });
    const calls = hub.calls.length;
    const again = errorOf(await runToolContract(tool, { mab_id: 'FRAlder1998' }));
    expect(again.data?.reason).toBe('snapshot_unavailable');
    expect(hub.calls).toHaveLength(calls);
  });

  it('does not let an unreadable World Heritage or intangible dataset affect a reserve lookup', async () => {
    useHub({ intercept: (call) => (call.dataset === 'mab001' ? undefined : httpFailure(404)) });
    const { out } = await get({ mab_id: 'FRAlder1998' });
    expect(out.mab_id).toBe('FRAlder1998');
  });

  it('does not read the sibling datasets', async () => {
    const hub = useHub();
    await get({ mab_id: 'FRAlder1998' });
    expect(hub.callsFor('whc001')).toHaveLength(0);
    expect(hub.callsFor('ich001')).toHaveLength(0);
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
      tool,
      { mab_id: 'FRAlder1998' },
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(hub.callsFor('mab001', 'export')).toHaveLength(1));
    controller.abort(new Error('cancelled by caller'));
    const error = errorOf(await pending);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    release?.();
  });
});

describe('unesco_get_biosphere_reserve — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(failureCases('mab001', MAB_ROWS.length))(
    'reports %s as snapshot_unavailable',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const error = errorOf(await settle(runToolContract(tool, { mab_id: 'FRAlder1998' })));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'mab001' });
      expect(error.data?.recovery?.hint).toContain('unesco_get_biosphere_reserve');
    },
  );

  it('reports a license change as snapshot_unavailable', async () => {
    useHub({ metas: { mab001: { license: 'All rights reserved' } } });
    const error = errorOf(await runToolContract(tool, { mab_id: 'FRAlder1998' }));
    expect(error.data?.reason).toBe('snapshot_unavailable');
  });

  it.each([
    ['an unknown region', { regional_group: 'Atlantis' }],
    ['an unknown network', { regional_network: 'Nowhere MAB' }],
    ['a fused extension year outside 1970–2100', { extension: 1850.2016 }],
    ['a non-numeric population', { population_total: '12' }],
    ['two rows sharing one folded id', {}],
  ])('reports a row with %s as snapshot_unavailable', async (label, overrides) => {
    const rows =
      label === 'two rows sharing one folded id'
        ? [mabRow({ mab_id: 'PEÑandu2001' }), mabRow({ mab_id: 'PENANDU2001' })]
        : [mabRow(overrides)];
    useHub({ rows: { mab001: rows } });
    const error = errorOf(await runToolContract(tool, { mab_id: 'FRTest1990' }));
    expect(error.data?.reason).toBe('snapshot_unavailable');
  });
});

describe('unesco_get_biosphere_reserve — format() parity and text safety', () => {
  beforeEach(() => {
    useHub();
  });

  it('renders every structured field the model needs', async () => {
    const { result, out, text } = await get({ mab_id: 'FRAlder1998' });
    const body = textBlocks(result)[0] ?? '';
    for (const expected of [
      `${out.name} (${out.mab_id})`,
      `${out.country} (${out.country_code})`,
      ...out.regions,
      out.regional_network,
      String(out.designation_year),
      `${out.area_hectares.total} ha`,
      `${out.latitude}, ${out.longitude}`,
      '2004, 2016',
      '2010',
      '2010, 2020, 2025',
      out.introduction,
      out.ecological_characteristics,
      out.socio_economic_characteristics,
      out.website,
      out.url,
    ]) {
      expect(body, String(expected)).toContain(String(expected));
    }
    expect(text).toContain('- **Transboundary:** No');
    expect(text).toContain('- **SIDS (Small Island Developing State):** No');
    expect(text).toContain('| Core | 1000 | 0 | 0 |');
    expect(text).toContain('| Buffer | 2000 | 0 | 400 |');
    expect(text).toContain('| Transition | 2000 | 0 | 600 |');
    expect(text).toContain('| Total | 5000 | 0 | 1000 |');
    expect(text).toContain('Source: UNESCO — Man and the Biosphere Programme (mab001)');
  });

  it('renders transboundary and SIDS flags as Yes', async () => {
    useHub({ rows: { mab001: [mabRow({ mab_id: 'ZZIsle2000', tbr: 'True', sids: 'True' })] } });
    const { out, text } = await get({ mab_id: 'ZZIsle2000' });
    expect([out.transboundary, out.sids]).toEqual([true, true]);
    expect(text).toContain('- **Transboundary:** Yes');
    expect(text).toContain('- **SIDS (Small Island Developing State):** Yes');
  });

  it('quotes multi-paragraph free text line by line', async () => {
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
    const { text } = await get({ mab_id: 'ZZQuote2000' });
    expect(text).toContain('**Introduction:**\n> One.\n>\n> ## Not A Heading\n> - not a list');
    expect(text.split('\n').some((l) => l === '## Not A Heading')).toBe(false);
  });

  it('flattens CR/LF in inline upstream text and quotes it in free text', async () => {
    useHub({
      rows: {
        mab001: [
          mabRow({
            mab_id: 'AB\r\nC1',
            title_en: 'Evil\r\n# Injected Heading',
            country_title_en: 'Land\r\n## Injected',
            introduction_en: 'Intro line.\r\n# Not A Heading',
            ecological_characteristics_en: 'Eco\n## Not A Heading',
            socio_economic_characteristics_en: 'Socio\r\n- not a list',
          }),
        ],
      },
    });
    const { out, text } = await get({ mab_id: 'AB\r\nC1' });

    expect(out.name).toBe('Evil\r\n# Injected Heading');
    expect(out.mab_id).toBe('AB\r\nC1');

    const lines = text.split('\n');
    expect(lines).toContain('## Evil # Injected Heading (AB C1)');
    expect(lines).toContain('- **Country:** Land ## Injected (FR)');
    expect(lines.some((l) => l.startsWith('# Injected') || l.startsWith('## Injected'))).toBe(
      false,
    );
    expect(text).toContain('> Intro line.\n> # Not A Heading');
    expect(text).toContain('> Eco\n> ## Not A Heading');
    expect(text).toContain('> Socio\n> - not a list');
    expect(text).not.toContain('\r');
  });

  it('keeps a CR/LF inside a website or page URL out of the markdown line structure', async () => {
    useHub({
      rows: {
        mab001: [
          mabRow({
            mab_id: 'ZZUrl2000',
            website: 'https://reserve.example.test/x\n# Injected',
            url: 'https://www.unesco.org/en/mab/y\r\n## Injected',
          }),
        ],
      },
    });
    const { out, text } = await get({ mab_id: 'ZZUrl2000' });
    expect(text.split('\n').some((l) => l.startsWith('# Injected') || l.startsWith('## Inj'))).toBe(
      false,
    );
    expect(out.website).toBe('https://reserve.example.test/x#%20Injected');
    expect(out.url).toBe('https://www.unesco.org/en/mab/y##%20Injected');
  });

  it('prints a website and page URL carrying link syntax with their brackets percent-encoded, keeping the hrefs in structuredContent', async () => {
    const website = 'https://reserve.example.test/![x](https://example.test/t.gif)';
    const url = 'https://www.unesco.org/en/mab/p?ref=[y](https://example.test/a)';
    useHub({ rows: { mab001: [mabRow({ mab_id: 'ZZLink2000', website, url })] } });
    const { out, text } = await get({ mab_id: 'ZZLink2000' });

    expect(out.website).toBe(website);
    expect(out.url).toBe(url);
    expect(text).toContain(
      '**Website:** https://reserve.example.test/!%5Bx%5D(https://example.test/t.gif)',
    );
    expect(text).toContain(
      '**UNESCO page:** https://www.unesco.org/en/mab/p?ref=%5By%5D(https://example.test/a)',
    );
    expect(text).not.toMatch(/[[\]]/);
  });
});
