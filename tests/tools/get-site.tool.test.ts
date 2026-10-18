/**
 * @fileoverview Tests for unesco_get_site: input normalization and validation,
 * the full record, criteria (recorded and inferred), component capping and the
 * unreadable-component notice, description_language with its English fallback
 * and notice, sparse and code-less sites, declared error contracts, upstream
 * failure classes, format() parity with structuredContent, and CR/LF in
 * upstream text staying out of inline slots.
 * @module tests/tools/get-site.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSiteTool } from '@/mcp-server/tools/definitions/get-site.tool.js';
import { CRITERIA } from '@/services/unesco-datahub/vocabulary.js';
import { declaredRecovery } from '../fixtures/contract.js';
import {
  contentFailureCases,
  expectContentFailure,
  settle,
  transportFailureCases,
  withFakeTimers,
} from '../fixtures/failures.js';
import { fieldsWithout, httpFailure, transientFailure, withoutKeys } from '../fixtures/hub.js';
import { componentsList, ichRow, WHC_ROWS, whcRow } from '../fixtures/rows.js';
import {
  allText,
  disposeServiceAfterEach,
  errorOf,
  structured,
  textBlocks,
  useHub,
} from '../fixtures/tool.js';

type SiteOutput = z.infer<typeof getSiteTool.output> & {
  cap: number;
  notice?: string;
  shown: number;
  sources: {
    attribution: string;
    data_as_of: string;
    dataset: string;
    license: string;
    title: string;
  }[];
  truncated: boolean;
};

disposeServiceAfterEach();

const get = async (input: Record<string, unknown>) => {
  const result = await runToolContract(getSiteTool, input as never);
  return { result, out: structured<SiteOutput>(result), text: allText(result) };
};

describe('unesco_get_site — record', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns the full record for a well-formed site', async () => {
    const { out } = await get({ id_no: '101' });
    expect(out).toMatchObject({
      id_no: '101',
      name: 'Alderfen Old Town',
      names: { fr: "Vieille Ville d'Alderfen", es: 'Casco Antiguo de Alderfen', zh: '奥德芬古城' },
      category: 'Cultural',
      states: ['France'],
      country_codes: ['FR'],
      region: 'Europe and North America',
      transboundary: false,
      inscribed_year: 1988,
      secondary_years: [2005, 2012],
      in_danger: false,
      area_hectares: 120.5,
      latitude: 48,
      longitude: 2,
      description: 'A synthetic walled town used as test data.',
      components_total: 3,
      components_unparsed: 0,
      image: {
        url: 'https://whc.unesco.org/document/101',
        copyright: 'Synthetic Photo Agency',
        author: 'A. Tester',
      },
      url: 'https://whc.unesco.org/en/list/101/',
    });
    expect(out.justification).toContain('Criterion (ii)');
    expect(out.criteria).toEqual([
      { code: 'ii', meaning: CRITERIA.ii.meaning, source: 'recorded' },
      { code: 'iv', meaning: CRITERIA.iv.meaning, source: 'recorded' },
    ]);
    expect(out.components.map((c) => c.ref)).toEqual(['101-001', '101-002', '101-003']);
    expect(out.components[0]?.name).toBe('North Gate, Upper Ward');
    expect(out).not.toHaveProperty('danger_listed_year');
  });

  it('carries the source attribution and the component-cap fields', async () => {
    const { out } = await get({ id_no: '101' });
    expect(out.sources).toEqual([
      {
        dataset: 'whc001',
        title: 'World Heritage List',
        data_as_of: '2026-09-30T02:06:00+00:00',
        license: 'CC BY-SA 4.0',
        attribution: 'UNESCO — World Heritage List (whc001), UNESCO Data Hub, CC BY-SA 4.0',
      },
    ]);
    expect(out).toMatchObject({ truncated: false, shown: 3, cap: 20 });
    expect(out.notice).toBeUndefined();
  });

  it('marks criterion (vi) as inferred when the statement names it and UNESCO omits it', async () => {
    const { out: onlyVi } = await get({ id_no: '103' });
    expect(onlyVi.criteria).toEqual([
      { code: 'vi', meaning: CRITERIA.vi.meaning, source: 'inferred' },
    ]);
    const { out: mixed } = await get({ id_no: '104' });
    expect(mixed.criteria.map((c) => `${c.code}:${c.source}`)).toEqual([
      'i:recorded',
      'iii:recorded',
      'vi:inferred',
    ]);
  });

  it('reports a transboundary Danger-list site with aligned states and codes', async () => {
    const { out, text } = await get({ id_no: '102' });
    expect(out).toMatchObject({
      states: ['Germany', 'Poland'],
      country_codes: ['DE', 'PL'],
      transboundary: true,
      in_danger: true,
      danger_listed_year: 2015,
      category: 'Natural',
      secondary_years: [2007],
    });
    expect(text).toContain('Germany (DE), Poland (PL)');
    expect(text).toContain('In Danger since 2015');
  });

  it('keeps a sparse site sparse and renders explicit unknowns instead of invented values', async () => {
    const { out, text } = await get({ id_no: '105' });
    for (const key of [
      'description',
      'justification',
      'image',
      'area_hectares',
      'latitude',
      'longitude',
    ]) {
      expect(out, key).not.toHaveProperty(key);
    }
    expect(out.components).toEqual([]);
    expect(out.components_total).toBe(0);
    expect(out.criteria.map((c) => c.code)).toEqual(['iii']);
    expect(text).toContain('**Description:** Not available');
    expect(text).toContain('**Statement of Outstanding Universal Value:** Not available');
    expect(text).toContain('**Area:** Not available');
    expect(text).toContain('**Coordinates:** Not available');
    expect(text).toContain('**Image:** Not available');
    expect(text).not.toContain('**Components**');
  });

  it('renders "Not recorded" for a site with no criteria at all', async () => {
    useHub({ rows: { whc001: [whcRow({ criteria_txt: null, justification_en: null })] } });
    const { out, text } = await get({ id_no: '900' });
    expect(out.criteria).toEqual([]);
    expect(text).toContain('- Not recorded');
  });

  it('lists a State Party without an ISO code by its UNESCO text, with no code suffix', async () => {
    const { out, text } = await get({ id_no: '106' });
    expect(out.country_codes).toEqual([]);
    expect(out.states).toEqual(['Synthetic Party Name']);
    expect(text).toContain('**States Parties:** Synthetic Party Name\n');
    expect(text).not.toContain('Synthetic Party Name (');
  });

  it('strips inline tags and decodes entities at load, so tags never reach either surface', async () => {
    const { out, text } = await get({ id_no: '107' });
    expect(out.name).toBe('Lantern Bridge Quarter');
    expect(out.names.fr).toBe('Quartier du Pont Lanterne');
    expect(out.description).toBe("Text with a 'quoted' word & more.\nSecond line here.");
    expect(out.components[0]?.name).toBe('Span One');
    expect(text).not.toMatch(/<\/?(?:em|i|br)\b/i);
  });
});

describe('unesco_get_site — id input', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['a number', 101],
    ['a digit string', '101'],
    ['a zero-padded string', ' 0101 '],
    ['the UNESCO page URL', 'https://whc.unesco.org/en/list/101/'],
    ['a localized URL without a scheme', 'whc.unesco.org/fr/list/0101'],
  ])('accepts %s', async (_label, id_no) => {
    const { out } = await get({ id_no });
    expect(out.id_no).toBe('101');
  });

  it.each([
    ['a non-numeric string', 'abc'],
    ['a blank string (required field, never unset)', ''],
    ['whitespace', '   '],
    ['zero', '0'],
    ['a six-digit id', '100000'],
    ['a negative number', -3],
    ['a fractional number', 1.5],
    ['an unrelated URL', 'https://example.test/en/list/101/'],
  ])('rejects %s as invalid arguments', async (_label, id_no) => {
    const result = await runToolContract(getSiteTool, { id_no } as never);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it('rejects a missing id_no', async () => {
    const error = errorOf(await runToolContract(getSiteTool, {} as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.recovery?.hint).toContain('id_no');
  });
});

describe('unesco_get_site — max_components', () => {
  beforeEach(() => {
    useHub();
  });

  it('lists every component under the default cap when the site has fewer', async () => {
    const { out } = await get({ id_no: '101' });
    expect(out.components).toHaveLength(3);
    expect(out.truncated).toBe(false);
  });

  it('caps at 20 by default and discloses the truncation with guidance', async () => {
    const { out, text } = await get({ id_no: '109' });
    expect(out.components).toHaveLength(20);
    expect(out.components_total).toBe(25);
    expect(out).toMatchObject({ truncated: true, shown: 20, cap: 20 });
    expect(out.notice).toBe(
      'Showing 20 of 25 components; call unesco_get_site with a higher max_components (up to 1000) to list more.',
    );
    expect(text).toContain('**Components** (20 of 25)');
    expect(text).toContain(out.notice as string);
  });

  it('honors an explicit cap and keeps upstream order', async () => {
    const { out } = await get({ id_no: '109', max_components: 5 });
    expect(out.components.map((c) => c.ref)).toEqual([
      '109-001',
      '109-002',
      '109-003',
      '109-004',
      '109-005',
    ]);
    expect(out).toMatchObject({ truncated: true, shown: 5, cap: 5 });
  });

  it('omits the list but keeps components_total for max_components 0', async () => {
    const { out, text } = await get({ id_no: '109', max_components: 0 });
    expect(out.components).toEqual([]);
    expect(out.components_total).toBe(25);
    expect(out).toMatchObject({ truncated: true, shown: 0, cap: 0 });
    expect(text).toContain('**Components** (0 of 25)');
  });

  it('is not truncated at 0 when the site has no components', async () => {
    const { out } = await get({ id_no: '105', max_components: 0 });
    expect(out).toMatchObject({ truncated: false, shown: 0, cap: 0 });
    expect(out.notice).toBeUndefined();
  });

  it('lists all 25 at the maximum cap without truncation', async () => {
    const { out } = await get({ id_no: '109', max_components: 1000 });
    expect(out.components).toHaveLength(25);
    expect(out).toMatchObject({ truncated: false, shown: 25, cap: 1000 });
  });

  it.each(['', null])('reads max_components %j as the default', async (max_components) => {
    const { out } = await get({ id_no: '109', max_components });
    expect(out.cap).toBe(20);
    expect(out.components).toHaveLength(20);
  });

  it.each([-1, 0.5, 2.5, 10_001, true, '10'])(
    'rejects max_components %j',
    async (max_components) => {
      const error = errorOf(
        await runToolContract(getSiteTool, { id_no: '101', max_components } as never),
      );
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    },
  );

  it('rejects max_components 10001, naming the 10000 ceiling', async () => {
    const error = errorOf(
      await runToolContract(getSiteTool, { id_no: '101', max_components: 10_001 } as never),
    );
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('10000');
  });

  it('serves max_components above 1000 at the cap, with the clamp as the notice', async () => {
    const { out, text } = await get({ id_no: '109', max_components: 1001 });
    expect(out.components).toHaveLength(25);
    expect(out).toMatchObject({ truncated: false, shown: 25, cap: 1000 });
    expect(out.notice).toBe(
      'max_components 1001 is above the per-call cap of 1000, so at most 1000 components are listed.',
    );
    expect(text).toContain(out.notice as string);
  });

  it('leads the unreadable-entry notice with the clamp', async () => {
    const { out } = await get({ id_no: '108', max_components: 10_000 });
    expect(out).toMatchObject({ truncated: false, shown: 4, cap: 1000 });
    expect(out.notice).toBe(
      "max_components 10000 is above the per-call cap of 1000, so at most 1000 components are listed. 1 of the site's 5 components could not be read from UNESCO's component list and are omitted.",
    );
  });

  it('discloses unreadable component entries on the untruncated path', async () => {
    const { out, text } = await get({ id_no: '108' });
    expect(out).toMatchObject({
      components_total: 5,
      components_unparsed: 1,
      truncated: false,
      shown: 4,
    });
    expect(out.notice).toBe(
      "1 of the site's 5 components could not be read from UNESCO's component list and are omitted.",
    );
    expect(text).toContain('**Components** (4 of 5, 1 unreadable)');
    expect(out.components.find((c) => c.ref === '108-003')).not.toHaveProperty('name');
    expect(text).toContain('108-003 — Name not available (12, 22)');
    expect(out.components.find((c) => c.ref === '108-004')).toBeDefined();
  });

  it('joins the truncation and unreadable-entry guidance in one notice', async () => {
    const { out } = await get({ id_no: '108', max_components: 2 });
    expect(out).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    expect(out.notice).toBe(
      "Showing 2 of 4 components; call unesco_get_site with a higher max_components (up to 1000) to list more. 1 of the site's 5 components could not be read from UNESCO's component list and are omitted.",
    );
  });
});

describe('unesco_get_site — a site with more components than one call lists', () => {
  const parts = Array.from({ length: 1001 }, (_, i) => ({
    name: `Part ${i + 1}`,
    ref: `950-${String(i + 1).padStart(4, '0')}`,
    latitude: 40,
    longitude: 10,
  }));

  beforeEach(() => {
    useHub({
      rows: {
        whc001: [
          whcRow({ id_no: '950', components_count: 1001, components_list: componentsList(parts) }),
        ],
      },
    });
  });

  it('lists 1000 at the cap and does not advise raising max_components', async () => {
    const { out } = await get({ id_no: '950', max_components: 1000 });
    expect(out).toMatchObject({ truncated: true, shown: 1000, cap: 1000, components_total: 1001 });
    expect(out.notice).toBe('Showing 1000 of 1001 components, the most one call lists.');
  });

  it('leads the truncation guidance with the clamp', async () => {
    const { out, text } = await get({ id_no: '950', max_components: 1500 });
    expect(out.components).toHaveLength(1000);
    expect(out).toMatchObject({ truncated: true, shown: 1000, cap: 1000 });
    expect(out.notice).toBe(
      'max_components 1500 is above the per-call cap of 1000, so at most 1000 components are listed. Showing 1000 of 1001 components, the most one call lists.',
    );
    expect(text).toContain(out.notice as string);
  });

  it('keeps the raise-max_components guidance below the cap', async () => {
    const { out } = await get({ id_no: '950', max_components: 999 });
    expect(out.notice).toBe(
      'Showing 999 of 1001 components; call unesco_get_site with a higher max_components (up to 1000) to list more.',
    );
  });
});

describe('unesco_get_site — declared errors', () => {
  it('site_not_found: NotFound with reason, id, and the declared recovery', async () => {
    useHub();
    const result = await runToolContract(getSiteTool, { id_no: 999 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'site_not_found',
      id_no: '999',
      recovery: {
        hint: "Find the site's id_no with unesco_search_sites (search by name), then call unesco_get_site again.",
      },
    });
    expect(allText(result)).toContain('Recovery: Find the site');
    expect(allText(result)).toContain('(reason site_not_found)');
  });

  it('site_not_found via the handler directly carries the reason on the thrown error', async () => {
    useHub();
    await expect(
      getSiteTool.handler(
        getSiteTool.input.parse({ id_no: '4242' }),
        createMockContext({ errors: getSiteTool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'site_not_found' },
    });
  });

  it('site_not_found on an empty dataset', async () => {
    useHub({ rows: { whc001: [] } });
    const error = errorOf(await runToolContract(getSiteTool, { id_no: 101 }));
    expect(error.data?.reason).toBe('site_not_found');
  });

  it('snapshot_unavailable: ServiceUnavailable with dataset, retryAfter, and the declared recovery', async () => {
    useHub({ intercept: () => transientFailure() });
    const result = await runToolContract(getSiteTool, { id_no: 101 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'snapshot_unavailable',
      dataset: 'whc001',
      retryAfter: 60,
      recovery: {
        hint: 'The UNESCO Data Hub could not be reached to load the World Heritage List; wait until the next load attempt this error names (retryAfter, in seconds), then call unesco_get_site again.',
      },
    });
    expect(allText(result)).toContain('Recovery: The UNESCO Data Hub could not be reached');
  });

  it('fails fast on later calls during the backoff without touching the upstream', async () => {
    const hub = useHub({ intercept: () => httpFailure(404) });
    await runToolContract(getSiteTool, { id_no: 101 });
    const calls = hub.calls.length;
    const again = errorOf(await runToolContract(getSiteTool, { id_no: 101 }));
    expect(again.data?.reason).toBe('snapshot_unavailable');
    expect(hub.calls).toHaveLength(calls);
  });

  it('does not let an unreadable intangible or biosphere dataset affect a site lookup', async () => {
    useHub({ intercept: (call) => (call.dataset === 'whc001' ? undefined : httpFailure(404)) });
    const { out } = await get({ id_no: '101' });
    expect(out.id_no).toBe('101');
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
      getSiteTool,
      { id_no: 101 },
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(hub.callsFor('whc001', 'export')).toHaveLength(1));
    controller.abort(new Error('cancelled by caller'));
    const error = errorOf(await pending);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    release?.();
  });
});

describe('unesco_get_site — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(transportFailureCases('whc001', WHC_ROWS.length))(
    'reports %s as retryable snapshot_unavailable with the declared recovery',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const error = errorOf(await settle(runToolContract(getSiteTool, { id_no: 101 })));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'snapshot_unavailable',
        retryable: true,
        dataset: 'whc001',
        recovery: { hint: declaredRecovery(getSiteTool.errors, 'snapshot_unavailable') },
      });
    },
  );

  it.each(contentFailureCases('whc001'))(
    'reports %s as non-retryable snapshot_unavailable with the service recovery',
    async (_label, hub) => {
      useHub(hub);
      const result = await runToolContract(getSiteTool, { id_no: 101 });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expectContentFailure(
        error,
        'whc001',
        declaredRecovery(getSiteTool.errors, 'snapshot_unavailable'),
      );
      expect(allText(result)).toContain(`Recovery: ${error.data?.recovery?.hint}`);
    },
  );

  it('reports a license change as snapshot_unavailable', async () => {
    useHub({ metas: { whc001: { license: 'All rights reserved' } } });
    const error = errorOf(await runToolContract(getSiteTool, { id_no: 101 }));
    expect(error.data?.reason).toBe('snapshot_unavailable');
  });

  it('reports a schema-invalid row as snapshot_unavailable', async () => {
    useHub({ rows: { whc001: [whcRow({ region: 'Atlantis' })] } });
    const error = errorOf(await runToolContract(getSiteTool, { id_no: 900 }));
    expect(error.data?.reason).toBe('snapshot_unavailable');
  });
});

describe('unesco_get_site — format() parity and text safety', () => {
  beforeEach(() => {
    useHub();
  });

  it('renders every structured field the model needs', async () => {
    const { result, out, text } = await get({ id_no: '101' });
    const body = textBlocks(result)[0] ?? '';
    for (const expected of [
      out.name,
      `id_no ${out.id_no}`,
      out.category,
      out.region,
      'France (FR)',
      String(out.inscribed_year),
      '2005, 2012',
      `${out.area_hectares} ha`,
      `${out.latitude}, ${out.longitude}`,
      out.url,
      out.description,
      ...(out.justification ?? '').split(/\n+/),
      out.names.fr,
      out.names.es,
      out.names.zh,
      out.image?.url,
      out.image?.copyright,
      out.image?.author,
      ...out.criteria.map((c) => `(${c.code}) ${c.meaning}`),
      ...out.components.map((c) => `${c.ref} — ${c.name}`),
    ]) {
      expect(body, String(expected)).toContain(String(expected));
    }
    expect(text).toContain('Source: UNESCO — World Heritage List (whc001)');
  });

  it('labels each criterion as recorded or inferred', async () => {
    const { text } = await get({ id_no: '104' });
    expect(text).toContain('(i) A masterpiece of human creative genius. (recorded)');
    expect(text).toContain('(inferred from the statement of Outstanding Universal Value)');
  });

  it('quotes multi-paragraph free text line by line', async () => {
    const { text } = await get({ id_no: '101' });
    expect(text).toContain(
      '**Statement of Outstanding Universal Value:**\n> Criterion (ii): synthetic exchange of ideas.\n>\n> Criterion (iv): synthetic ensemble.',
    );
  });

  it('shows a truncation notice to content-only clients', async () => {
    const { text } = await get({ id_no: '109' });
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('Showing 20 of 25 components');
  });

  it('flattens CR/LF in inline upstream text and quotes it in free text', async () => {
    const injected = whcRow({
      id_no: '910',
      name_en: 'Evil\r\n# Injected Heading',
      name_fr: 'Nom\nFrançais',
      states_names: ['State\r\nOne', 'State Two'],
      iso_codes: 'FR, DE',
      transboundary: 'True',
      short_description_en: 'First line.\n\n## Not A Heading\n- not a list',
      justification_en: 'Para one.\r\nPara two.',
      main_image_copyright: 'Owner\r\n**bold**',
      main_image_author: 'Author\nName',
      components_count: 2,
      components_list: componentsList([
        { name: 'Part\nOne', ref: 'p\n1', latitude: 1, longitude: 2 },
        { name: 'Part Two', ref: 'p2', latitude: 3, longitude: 4 },
      ]),
    });
    useHub({ rows: { whc001: [injected] } });
    const { out, text } = await get({ id_no: '910' });

    // structuredContent keeps the loader-cleaned value (only tags and entities are touched)
    expect(out.name).toBe('Evil\r\n# Injected Heading');
    expect(out.states[0]).toBe('State\r\nOne');

    const lines = text.split('\n');
    expect(lines).toContain('## Evil # Injected Heading (id_no 910)');
    expect(lines.some((l) => l.startsWith('# Injected'))).toBe(false);
    expect(text).toContain('**States Parties:** State One (FR), State Two (DE)');
    expect(text).toContain('- fr: Nom Français');
    expect(text).toContain('- p 1 — Part One (1, 2)');
    expect(text).toContain('© Owner **bold**');
    expect(text).toContain('Photo: Author Name');

    const description = ['> First line.', '>', '> ## Not A Heading', '> - not a list'];
    const start = lines.indexOf(description[0] as string);
    expect(lines.slice(start, start + 4)).toEqual(description);
    expect(lines.some((l) => l === '## Not A Heading' || l === '- not a list')).toBe(false);
    expect(text).toContain('> Para one.\n> Para two.');
  });

  it('never emits a raw carriage return outside quoted text', async () => {
    useHub({
      rows: { whc001: [whcRow({ id_no: '911', name_en: 'A\rB', main_image_author: 'X\r\nY' })] },
    });
    const { text } = await get({ id_no: '911' });
    expect(text).not.toContain('\r');
  });

  it('renders link, image, and HTML syntax as text in content[] and keeps it verbatim in structuredContent', async () => {
    const name = 'Synthetic ![x](https://example.test/t.gif) Site';
    const description = 'See [the page](https://example.test/a) or <img src=x onerror=y>.';
    const copyright = 'Owner <a href="https://example.test/b">link</a>';
    useHub({
      rows: {
        whc001: [
          whcRow({
            id_no: '912',
            name_en: name,
            short_description_en: description,
            main_image_copyright: copyright,
            components_list: componentsList([
              {
                name: 'Part [one](https://example.test/c)',
                ref: '912-001',
                latitude: 1,
                longitude: 2,
              },
            ]),
          }),
        ],
      },
    });
    const { out, text } = await get({ id_no: '912' });

    expect(out.name).toBe(name);
    expect(out.description).toBe(description);
    expect(out.image?.copyright).toBe(copyright);
    expect(out.components[0]?.name).toBe('Part [one](https://example.test/c)');

    expect(text).toContain('## Synthetic !\\[x\\](https://example.test/t.gif) Site (id_no 912)');
    expect(text).toContain(
      '> See \\[the page\\](https://example.test/a) or \\<img src=x onerror=y\\>.',
    );
    expect(text).toContain('© Owner \\<a href="https://example.test/b"\\>link\\</a\\>');
    expect(text).toContain('- 912-001 — Part \\[one\\](https://example.test/c) (1, 2)');
    expect(text).not.toMatch(/(^|[^\\])[[<]/m);
  });

  it('strips control and bidi characters from content[] and keeps them in structuredContent', async () => {
    const [nul, esc, rlo, pdi] = [0x00, 0x1b, 0x202e, 0x2069].map((cp) => String.fromCodePoint(cp));
    const name = `Mirror${rlo}Site${pdi} Name`;
    const justification = `Criterion (iv): a${nul} synthetic${esc} ensemble.\vSecond line.`;
    useHub({
      rows: { whc001: [whcRow({ id_no: '913', name_en: name, justification_en: justification })] },
    });
    const { out, text } = await get({ id_no: '913' });

    expect(out.name).toBe(name);
    expect(out.justification).toBe(justification);
    expect(text).toContain('## MirrorSite Name (id_no 913)');
    expect(text).toContain('> Criterion (iv): a synthetic ensemble.\n> Second line.');
    for (const ch of [nul, esc, rlo, pdi, '\v']) expect(text).not.toContain(ch);
  });

  it('prints an image URL carrying link syntax with its brackets percent-encoded, keeping the href in structuredContent', async () => {
    const href = 'https://example.test/img/![x](https://example.test/t.gif)';
    useHub({ rows: { whc001: [whcRow({ id_no: '914', main_image_url: href })] } });
    const { out, text } = await get({ id_no: '914' });

    expect(out.image?.url).toBe(href);
    expect(text).toContain(
      '**Image:** https://example.test/img/!%5Bx%5D(https://example.test/t.gif)',
    );
    expect(text).toContain('- **URL:** https://whc.unesco.org/en/list/914/');
    expect(text).not.toMatch(/[[\]]/);
  });
});

describe('unesco_get_site — description_language', () => {
  beforeEach(() => {
    useHub();
  });

  it('without description_language returns the English record, no description_language, and the same content[]', async () => {
    const { result, out } = await get({ id_no: '101' });
    expect(Object.keys(out)).toEqual([
      'id_no',
      'name',
      'names',
      'category',
      'states',
      'country_codes',
      'region',
      'transboundary',
      'inscribed_year',
      'secondary_years',
      'criteria',
      'in_danger',
      'area_hectares',
      'latitude',
      'longitude',
      'description',
      'justification',
      'components',
      'components_total',
      'components_unparsed',
      'image',
      'url',
      'sources',
      'truncated',
      'shown',
      'cap',
    ]);
    expect(out.description).toBe('A synthetic walled town used as test data.');
    expect(textBlocks(result)).toEqual([
      "## Alderfen Old Town (id_no 101)\n- **Category:** Cultural\n- **Region:** Europe and North America\n- **States Parties:** France (FR)\n- **Transboundary:** No\n- **Inscribed:** 1988\n- **Secondary years:** 2005, 2012\n- **Danger:** Not in Danger\n- **Area:** 120.5 ha\n- **Coordinates:** 48, 2\n- **URL:** https://whc.unesco.org/en/list/101/\n\n**Criteria:**\n- (ii) An important interchange of human values over time or within a cultural area, in architecture, technology, monumental arts, town planning, or landscape design. (recorded)\n- (iv) An outstanding example of a type of building, architectural or technological ensemble, or landscape illustrating significant stages in human history. (recorded)\n\n**Description:**\n> A synthetic walled town used as test data.\n\n**Statement of Outstanding Universal Value:**\n> Criterion (ii): synthetic exchange of ideas.\n>\n> Criterion (iv): synthetic ensemble.\n\n**Other names:**\n- fr: Vieille Ville d'Alderfen\n- es: Casco Antiguo de Alderfen\n- zh: 奥德芬古城\n\n**Components** (3 of 3):\n- 101-001 — North Gate, Upper Ward (48.01, 2.01)\n- 101-002 — Market Hall (48.02, 2.02)\n- 101-003 — Old Mill (48.03, 2.03)\n\n**Image:** https://whc.unesco.org/document/101\n© Synthetic Photo Agency\nPhoto: A. Tester",
      '\n\nSource: UNESCO — World Heritage List (whc001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/\n**truncated:** false\n**shown:** 3\n**cap:** 20',
    ]);
  });

  it.each(['', '   ', null])(
    'reads description_language %j as unset',
    async (description_language) => {
      const unset = await get({ id_no: '101' });
      const blank = await get({ id_no: '101', description_language });
      expect(blank.out).toEqual(unset.out);
      expect(textBlocks(blank.result)).toEqual(textBlocks(unset.result));
    },
  );

  it('returns the French description, names its language, and labels it in content[]', async () => {
    const { result, out, text } = await get({ id_no: '101', description_language: 'fr' });
    expect(out.description).toBe('Une ville fortifiée synthétique utilisée comme données de test.');
    expect(out.description_language).toBe('fr');
    expect(out.notice).toBeUndefined();
    expect(getSiteTool.output.parse(out)).toMatchObject({ description_language: 'fr' });
    expect(text).toContain(
      '**Description (fr):**\n> Une ville fortifiée synthétique utilisée comme données de test.',
    );
    expect(text).not.toContain('**Description:**');
    expect(text).not.toContain('A synthetic walled town');
    expect(textBlocks(result)[1]).not.toContain('UNESCO publishes no');
  });

  it.each([
    ['en', 'A synthetic walled town used as test data.'],
    ['es', 'Una ciudad amurallada sintética usada como datos de prueba.'],
    ['ru', 'Синтетический город-крепость для тестовых данных.'],
    ['ar', 'مدينة مسورة اصطناعية تستخدم كبيانات اختبار.'],
    ['zh', '用作测试数据的合成城墙小镇。'],
  ])('returns the %s description', async (language, description) => {
    const { out, text } = await get({ id_no: '101', description_language: language });
    expect(out).toMatchObject({ description, description_language: language });
    expect(text).toContain(`**Description (${language}):**\n> ${description}`);
  });

  it('folds the language code: FR reads as fr', async () => {
    const { out } = await get({ id_no: '101', description_language: ' FR ' });
    expect(out.description_language).toBe('fr');
  });

  it('keeps the statement of Outstanding Universal Value, the names, and the other fields as the English call returns them', async () => {
    const english = await get({ id_no: '101' });
    const french = await get({ id_no: '101', description_language: 'fr' });
    const { description: _fr, description_language: _language, ...frenchRest } = french.out;
    const { description: _en, ...englishRest } = english.out;
    expect(frenchRest).toEqual(englishRest);
    expect(french.text).toContain(
      '**Statement of Outstanding Universal Value:**\n> Criterion (ii): synthetic exchange of ideas.',
    );
  });

  it('falls back to the English description with description_language en and a notice naming the language', async () => {
    const { out, text } = await get({ id_no: '102', description_language: 'zh' });
    expect(out.description).toBe('A synthetic forest shared by two states.');
    expect(out.description_language).toBe('en');
    expect(out.notice).toBe(
      'UNESCO publishes no Chinese description for this site; description is in English.',
    );
    expect(text).toContain('**Description (en):**\n> A synthetic forest shared by two states.');
    expect(text).toContain(out.notice as string);
  });

  it('returns neither field, with the notice, for a site with no description in the language or English', async () => {
    const { out, text } = await get({ id_no: '105', description_language: 'fr' });
    expect(out).not.toHaveProperty('description');
    expect(out).not.toHaveProperty('description_language');
    expect(out.notice).toBe('UNESCO publishes no French or English description for this site.');
    expect(text).toContain('**Description:** Not available');
  });

  it('reads a translation column the metadata stopped listing as unpublished, never failing the load', async () => {
    const dropped = ['short_description_fr', 'short_description_es'];
    useHub({
      fields: { whc001: fieldsWithout('whc001', dropped) },
      rows: { whc001: withoutKeys(WHC_ROWS, dropped) },
    });
    const { out } = await get({ id_no: '101', description_language: 'fr' });
    expect(out).toMatchObject({
      description: 'A synthetic walled town used as test data.',
      description_language: 'en',
      notice: 'UNESCO publishes no French description for this site; description is in English.',
    });
    const { out: russian } = await get({ id_no: '101', description_language: 'ru' });
    expect(russian.description_language).toBe('ru');
  });

  it('places the language fragment after the clamp and before the component guidance in the one notice', async () => {
    const clamp =
      'max_components 10000 is above the per-call cap of 1000, so at most 1000 components are listed.';
    const fallback =
      'UNESCO publishes no Arabic description for this site; description is in English.';
    const unreadable =
      "1 of the site's 5 components could not be read from UNESCO's component list and are omitted.";
    const clamped = await get({ id_no: '108', max_components: 10_000, description_language: 'ar' });
    expect(clamped.out).toMatchObject({ truncated: false, cap: 1000, description_language: 'en' });
    expect(clamped.out.notice).toBe(`${clamp} ${fallback} ${unreadable}`);

    const truncated = await get({ id_no: '108', max_components: 2, description_language: 'ar' });
    expect(truncated.out).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    expect(truncated.out.notice).toBe(
      `${fallback} Showing 2 of 4 components; call unesco_get_site with a higher max_components (up to 1000) to list more. ${unreadable}`,
    );
    expect(truncated.text).toContain(truncated.out.notice as string);
  });

  it('renders a translated description through the quote helper, keeping structuredContent verbatim', async () => {
    const description = 'Voir [la page](https://example.test/a) <img src=x>\n## Pas un titre';
    useHub({
      rows: { whc001: [whcRow({ id_no: '915', short_description_fr: description })] },
    });
    const { out, text } = await get({ id_no: '915', description_language: 'fr' });
    expect(out.description).toBe(description);
    expect(text).toContain(
      '**Description (fr):**\n> Voir \\[la page\\](https://example.test/a) \\<img src=x\\>\n> ## Pas un titre',
    );
    expect(text.split('\n')).not.toContain('## Pas un titre');
  });

  it.each(['de', 'french', 'fr-FR', 1, true])(
    'rejects description_language %j as invalid arguments',
    async (description_language) => {
      const error = errorOf(
        await runToolContract(getSiteTool, { id_no: '101', description_language } as never),
      );
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
    },
  );
});

describe('unesco_get_site — sibling dataset independence', () => {
  it('does not read the intangible dataset when the site is looked up', async () => {
    const hub = useHub({ rows: { ich001: [ichRow()] } });
    await get({ id_no: '101' });
    expect(hub.callsFor('ich001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
  });
});
