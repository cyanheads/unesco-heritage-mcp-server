/**
 * @fileoverview Tests for unesco_get_site: input normalization and validation,
 * the full record, criteria (recorded and inferred), component capping and the
 * unreadable-component notice, sparse and code-less sites, declared error
 * contracts, upstream failure classes, format() parity with structuredContent,
 * and CR/LF in upstream text staying out of inline slots.
 * @module tests/tools/get-site.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSiteTool } from '@/mcp-server/tools/definitions/get-site.tool.js';
import { CRITERIA } from '@/services/unesco-datahub/vocabulary.js';
import { type HubOptions, httpFailure, metaDocument } from '../fixtures/hub.js';
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

  it('reads a blank max_components as the default', async () => {
    const { out } = await get({ id_no: '109', max_components: '' });
    expect(out.cap).toBe(20);
    expect(out.components).toHaveLength(20);
  });

  it.each([-1, 1001, 2.5, null, '10'])('rejects max_components %j', async (max_components) => {
    const error = errorOf(
      await runToolContract(getSiteTool, { id_no: '101', max_components } as never),
    );
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
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
    useHub({ intercept: () => httpFailure(404) });
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

  const cases: [string, NonNullable<Parameters<typeof useHub>[0]>['intercept']][] = [
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
    [
      'a row-count mismatch',
      (call) =>
        call.kind === 'meta'
          ? Response.json(metaDocument('whc001', { records_count: WHC_ROWS.length + 1 }))
          : undefined,
    ],
  ];

  it.each(cases)('reports %s as snapshot_unavailable', async (_label, intercept) => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    useHub({ intercept: intercept as NonNullable<HubOptions['intercept']> });
    const pending = runToolContract(getSiteTool, { id_no: 101 });
    await vi.advanceTimersByTimeAsync(10_000);
    const error = errorOf(await pending);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'whc001' });
    expect(error.data?.recovery?.hint).toContain('unesco_get_site');
  });

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

describe('unesco_get_site — sibling dataset independence', () => {
  it('does not read the intangible dataset when the site is looked up', async () => {
    const hub = useHub({ rows: { ich001: [ichRow()] } });
    await get({ id_no: '101' });
    expect(hub.callsFor('ich001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
  });
});
