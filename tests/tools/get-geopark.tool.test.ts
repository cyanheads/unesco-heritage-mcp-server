/**
 * @fileoverview Tests for unesco_get_geopark: ugg_id normalization (trim and
 * uppercase) and validation, the full record and its sparse shape, a
 * transnational geopark's split countries, as-recorded area and population,
 * the declared error contracts, upstream failure classes, format() parity with
 * structuredContent, and markdown in upstream text rendered inert.
 * @module tests/tools/get-geopark.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGeoparkTool as tool } from '@/mcp-server/tools/definitions/get-geopark.tool.js';
import { declaredRecovery } from '../fixtures/contract.js';
import { failureCases, settle, withFakeTimers } from '../fixtures/failures.js';
import { httpFailure } from '../fixtures/hub.js';
import { EG_ROWS, egRow } from '../fixtures/rows.js';
import {
  allText,
  disposeServiceAfterEach,
  errorOf,
  structured,
  textBlocks,
  useHub,
} from '../fixtures/tool.js';

type GeoparkOutput = z.infer<typeof tool.output> & {
  sources: {
    attribution: string;
    data_as_of: string;
    dataset: string;
    license: string;
    title: string;
  }[];
};

disposeServiceAfterEach();

const get = async (input: Record<string, unknown>) => {
  const result = await runToolContract(tool, input as never);
  return { result, out: structured<GeoparkOutput>(result), text: allText(result) };
};

describe('unesco_get_geopark — record', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns the full record with its text cleaned of entities', async () => {
    const { out } = await get({ ugg_id: 'EUFR90' });
    expect(out).toEqual({
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
      description: 'Chalk cliffs and fossil beds. Synthetic sea stacks rise offshore.',
      sustaining_local_communities:
        'Fishing & farming villages share the coast. Synthetic markets sell local stone.',
      website: 'https://geopark.example.test/alderfen',
      url: 'https://www.unesco.org/en/iggp/alderfen-cliffs-unesco-global-geopark',
      sources: expect.any(Array),
    });
  });

  it('carries the geopark source attribution', async () => {
    const { out, text } = await get({ ugg_id: 'EUFR90' });
    expect(out.sources).toEqual([
      {
        dataset: 'eg0001',
        title: 'UNESCO Global Geoparks',
        data_as_of: '2026-09-30T02:06:00+00:00',
        license: 'CC BY-SA 4.0',
        attribution: 'UNESCO — UNESCO Global Geoparks (eg0001), UNESCO Data Hub, CC BY-SA 4.0',
      },
    ]);
    expect(text).toContain(
      'Source: UNESCO — UNESCO Global Geoparks (eg0001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0',
    );
  });

  it('keeps the sparse geopark sparse and renders explicit unknowns', async () => {
    const { out, text } = await get({ ugg_id: 'ASJP91' });
    expect(out).not.toHaveProperty('population');
    expect(out).not.toHaveProperty('website');
    expect(out).toMatchObject({ designation_year: 2015, area_hectares: 30_000 });
    expect(text).toContain('- **Population:** Not available');
    expect(text).toContain('**Website:** Not available');
  });

  it('splits a transnational geopark into both countries and passes a 0 population through', async () => {
    const { out, text } = await get({ ugg_id: 'EUA190' });
    expect(out).toMatchObject({
      country_codes: ['DE', 'PL'],
      countries: ['Germany', 'Poland'],
      transnational: true,
      population: 0,
      website: 'http://brindle.example.test/',
      url: 'https://www.unesco.org/en/iggp/brindle/karst-unesco-global-geopark',
    });
    expect(text).toContain('- **Countries:** Germany (DE), Poland (PL)');
    expect(text).toContain('- **Transnational:** Yes');
    expect(text).toContain('- **Population:** 0 (as recorded)');
  });

  it('passes an outsized area through as recorded', async () => {
    const { out, text } = await get({ ugg_id: 'LAPE93' });
    expect(out.area_hectares).toBe(2_500_000);
    expect(out.name).toBe('Ñandu Canyon UNESCO Global Geopark');
    expect(text).toContain('- **Area:** 2500000 ha (as recorded)');
  });

  it('keeps the lines of an introduction that was an entity-encoded list', async () => {
    const { out, text } = await get({ ugg_id: 'EUIT92' });
    expect(out.introduction).toBe('Explore the red earth mines.\nFollow the plateau trail.');
    expect(text).toContain(
      '**Introduction:**\n> Explore the red earth mines.\n> Follow the plateau trail.',
    );
  });

  it('drops a website that is not an http(s) URL', async () => {
    useHub({ rows: { eg0001: [egRow({ website: 'ftp://geopark.example.test/' })] } });
    const { out, text } = await get({ ugg_id: 'EUFR99' });
    expect(out).not.toHaveProperty('website');
    expect(text).toContain('**Website:** Not available');
  });
});

describe('unesco_get_geopark — ugg_id input', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['the exact id', 'EUFR90'],
    ['a lowercase id', 'eufr90'],
    ['a mixed-case id', 'EuFr90'],
    ['an id with surrounding whitespace', '  eufr90\n'],
  ])('resolves %s to the geopark', async (_label, ugg_id) => {
    const { out } = await get({ ugg_id });
    expect(out.ugg_id).toBe('EUFR90');
  });

  it('resolves an id longer than six characters', async () => {
    useHub({ rows: { eg0001: [egRow({ ugg_id: 'ASCN151' })] } });
    expect((await get({ ugg_id: 'ascn151' })).out.ugg_id).toBe('ASCN151');
  });

  it.each([
    ['a blank string (required, never unset)', ''],
    ['whitespace', '   '],
    ['an id over 20 characters', 'EUFR90EUFR90EUFR90EUF'],
    ['a UNESCO page URL', 'https://www.unesco.org/en/iggp/alderfen-cliffs-unesco-global-geopark'],
    ['an id with punctuation', 'EU-FR90'],
    ['an id with an inner space', 'EU FR90'],
    ['null', null],
    ['an object', { id: 'EUFR90' }],
  ])('rejects %s as invalid arguments', async (_label, ugg_id) => {
    const error = errorOf(await runToolContract(tool, { ugg_id } as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it('rejects a missing ugg_id and names the field in the hint', async () => {
    const error = errorOf(await runToolContract(tool, {} as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.recovery?.hint).toContain('ugg_id');
  });

  it.each([
    ['an unknown id', 'ZZ99'],
    ['a mab_id-shaped id', 'FRAlder1998'],
    ['a number (arrives as a digit string that matches no id)', 1998],
  ])('reports %s as not found rather than throwing', async (_label, ugg_id) => {
    const error = errorOf(await runToolContract(tool, { ugg_id } as never));
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('geopark_not_found');
  });
});

describe('unesco_get_geopark — declared errors', () => {
  it('geopark_not_found: NotFound with reason, id, and the declared recovery naming the search tool', async () => {
    useHub();
    const result = await runToolContract(tool, { ugg_id: 'zz99' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'geopark_not_found',
      ugg_id: 'ZZ99',
      recovery: { hint: declaredRecovery(tool.errors, 'geopark_not_found') },
    });
    expect(error.data?.recovery?.hint).toContain('unesco_search_geoparks');
    expect(error.message).toBe('No UNESCO Global Geopark has ugg_id "ZZ99".');
    expect(allText(result)).toContain(
      "Recovery: Find the geopark's ugg_id with unesco_search_geoparks",
    );
    expect(allText(result)).toContain('(reason geopark_not_found)');
  });

  it('geopark_not_found via the handler directly carries the reason on the thrown error', async () => {
    useHub();
    await expect(
      tool.handler(
        tool.input.parse({ ugg_id: 'ZZ99' }),
        createMockContext({ errors: tool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'geopark_not_found' },
    });
  });

  it('geopark_not_found on an empty dataset', async () => {
    useHub({ rows: { eg0001: [] } });
    const error = errorOf(await runToolContract(tool, { ugg_id: 'EUFR90' }));
    expect(error.data?.reason).toBe('geopark_not_found');
  });

  it('snapshot_unavailable: ServiceUnavailable with dataset, retryAfter, and the declared recovery', async () => {
    useHub({ intercept: () => httpFailure(404) });
    const result = await runToolContract(tool, { ugg_id: 'EUFR90' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'snapshot_unavailable',
      dataset: 'eg0001',
      retryAfter: 60,
      recovery: { hint: declaredRecovery(tool.errors, 'snapshot_unavailable') },
    });
    expect(allText(result)).toContain('Recovery: The UNESCO Data Hub could not be reached');
  });

  it('fails fast on later calls during the backoff without touching the upstream', async () => {
    const hub = useHub({ intercept: () => httpFailure(404) });
    await runToolContract(tool, { ugg_id: 'EUFR90' });
    const calls = hub.calls.length;
    const again = errorOf(await runToolContract(tool, { ugg_id: 'EUFR90' }));
    expect(again.data?.reason).toBe('snapshot_unavailable');
    expect(hub.calls).toHaveLength(calls);
  });

  it('does not let an unreadable sibling dataset affect a geopark lookup', async () => {
    useHub({ intercept: (call) => (call.dataset === 'eg0001' ? undefined : httpFailure(404)) });
    expect((await get({ ugg_id: 'EUFR90' })).out.ugg_id).toBe('EUFR90');
  });

  it('does not read the sibling datasets', async () => {
    const hub = useHub();
    await get({ ugg_id: 'EUFR90' });
    expect(hub.callsFor('whc001')).toHaveLength(0);
    expect(hub.callsFor('ich001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
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
      { ugg_id: 'EUFR90' },
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(hub.callsFor('eg0001', 'export')).toHaveLength(1));
    controller.abort(new Error('cancelled by caller'));
    const error = errorOf(await pending);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    release?.();
  });
});

describe('unesco_get_geopark — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(failureCases('eg0001', EG_ROWS.length))(
    'reports %s as snapshot_unavailable',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const error = errorOf(await settle(runToolContract(tool, { ugg_id: 'EUFR90' })));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'eg0001' });
      expect(error.data?.recovery?.hint).toContain('unesco_get_geopark');
    },
  );

  it.each([
    ['an area unit other than hectares', { area_unit: 'km2' }],
    ['a lowercase ugg_id', { ugg_id: 'eufr90' }],
    ['a country entry that is not alpha-2 codes', { countries: ['France'] }],
  ])('reports a row with %s as snapshot_unavailable', async (_label, overrides) => {
    useHub({ rows: { eg0001: [egRow(overrides)] } });
    const error = errorOf(await runToolContract(tool, { ugg_id: 'EUFR99' }));
    expect(error.data?.reason).toBe('snapshot_unavailable');
  });
});

describe('unesco_get_geopark — format() parity and text safety', () => {
  beforeEach(() => {
    useHub();
  });

  it('renders every structured field', async () => {
    const { result, out, text } = await get({ ugg_id: 'EUFR90' });
    expect(textBlocks(result)[0]).toBe(
      [
        '## Alderfen Cliffs UNESCO Global Geopark (EUFR90)',
        '- **Countries:** France (FR)',
        '- **Designated:** 2015',
        '- **Transnational:** No',
        '- **Area:** 120000 ha (as recorded)',
        '- **Population:** 52000 (as recorded)',
        '- **Coordinates:** 49.9, 1.5',
        '',
        '**Introduction:**',
        `> ${out.introduction}`,
        '',
        '**Description:**',
        `> ${out.description}`,
        '',
        '**Sustaining local communities:**',
        `> ${out.sustaining_local_communities}`,
        '',
        `**Website:** ${out.website}`,
        `**UNESCO page:** ${out.url}`,
      ].join('\n'),
    );
    expect(text).toContain('Source: UNESCO — UNESCO Global Geoparks (eg0001)');
  });

  it('renders markdown and HTML metacharacters in upstream text inert', async () => {
    useHub({
      rows: {
        eg0001: [
          egRow({
            title_en: 'Evil\r\n# Injected [link](https://evil.test) <script>',
            introduction_en: 'Intro.\r\n# Not A Heading',
            description: 'Rock ![img](https://evil.test/x.png)\n## Not A Heading',
            sustaining_local_communities_description: 'Towns\r\n- not a list <img src=x>',
          }),
        ],
      },
    });
    const { out, text } = await get({ ugg_id: 'EUFR99' });
    expect(out.name).toBe('Evil\r\n# Injected [link](https://evil.test) <script>');
    const lines = text.split('\n');
    expect(lines).toContain(
      '## Evil # Injected \\[link\\](https://evil.test) \\<script\\> (EUFR99)',
    );
    expect(text).toContain('> Intro.\n> # Not A Heading');
    expect(text).toContain('> Rock !\\[img\\](https://evil.test/x.png)\n> ## Not A Heading');
    expect(text).toContain('> Towns\n> - not a list \\<img src=x\\>');
    expect(
      lines.some(
        (l) => l.startsWith('# Injected') || l.startsWith('## Not') || l.startsWith('- not'),
      ),
    ).toBe(false);
    expect(text).not.toMatch(/\[(?:link|img)\]/);
    expect(text).not.toContain('\r');
  });

  it('prints a website and page URL carrying link syntax with their brackets percent-encoded, keeping the hrefs in structuredContent', async () => {
    const website = 'https://geopark.example.test/![x](https://example.test/t.gif)';
    const url = 'https://www.unesco.org/en/iggp/p?ref=[y](https://example.test/a)';
    useHub({ rows: { eg0001: [egRow({ website, url })] } });
    const { out, text } = await get({ ugg_id: 'EUFR99' });
    expect(out.website).toBe(website);
    expect(out.url).toBe(url);
    expect(text).toContain(
      '**Website:** https://geopark.example.test/!%5Bx%5D(https://example.test/t.gif)',
    );
    expect(text).toContain(
      '**UNESCO page:** https://www.unesco.org/en/iggp/p?ref=%5By%5D(https://example.test/a)',
    );
    expect(text).not.toMatch(/[[\]]/);
  });
});
