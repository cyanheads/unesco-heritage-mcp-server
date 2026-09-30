/**
 * @fileoverview Tests for unesco_get_intangible_heritage_element: ich_ref
 * normalization and validation, the full record and its sparse shapes, the
 * declared error contracts, upstream failure classes, format() parity with
 * structuredContent, and CR/LF in upstream text staying out of inline slots.
 * @module tests/tools/get-intangible-heritage-element.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getIntangibleHeritageElementTool as tool } from '@/mcp-server/tools/definitions/get-intangible-heritage-element.tool.js';
import { declaredRecovery } from '../fixtures/contract.js';
import { failureCases, settle, withFakeTimers } from '../fixtures/failures.js';
import { httpFailure } from '../fixtures/hub.js';
import { ICH_ROWS, ichRow } from '../fixtures/rows.js';
import {
  allText,
  disposeServiceAfterEach,
  errorOf,
  structured,
  textBlocks,
  useHub,
} from '../fixtures/tool.js';

type ElementOutput = z.infer<typeof tool.output> & {
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
  return { result, out: structured<ElementOutput>(result), text: allText(result) };
};

describe('unesco_get_intangible_heritage_element — record', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns the full record for a multinational element with linked sites', async () => {
    const { out } = await get({ ich_ref: '1001' });
    expect(out).toMatchObject({
      ich_ref: '1001',
      name: 'Synthetic Weaving Rite',
      name_fr: 'Rite de Tissage Synthétique',
      list: 'Representative List',
      country_codes: ['FR', 'BE'],
      countries: ['France', 'Belgium'],
      multinational: true,
      inscribed_year: 2010,
      description: 'First paragraph.\n\nSecond paragraph.',
      concepts: ['Textile craft'],
      concepts_secondary: ['Community', 'Ritual'],
      url: 'https://ich.unesco.org/en/RL/09000',
      image: {
        url: 'https://ich.unesco.org/img/photo/thumb/9000.jpg',
        caption: 'A synthetic caption.',
        copyright: 'Synthetic Photo Agency',
        author: 'A. Tester',
      },
    });
    expect(out.world_heritage_sites).toEqual([
      { id_no: '101', name: 'Alderfen Old Town' },
      { id_no: '102', name: 'Brindle Frontier Forest' },
    ]);
  });

  it('carries the source attribution', async () => {
    const { out } = await get({ ich_ref: '1001' });
    expect(out.sources).toEqual([
      {
        dataset: 'ich001',
        title: 'Intangible Heritage List',
        data_as_of: '2026-09-30T02:06:00+00:00',
        license: 'CC BY-SA 4.0',
        attribution: 'UNESCO — Intangible Heritage List (ich001), UNESCO Data Hub, CC BY-SA 4.0',
      },
    ]);
  });

  it('keeps a sparse element sparse: empty concept lists, no linked sites, no caption or credit', async () => {
    const { out, text } = await get({ ich_ref: '1002' });
    expect(out).toMatchObject({
      list: 'Urgent Safeguarding List',
      country_codes: ['ET'],
      multinational: false,
      inscribed_year: 2008,
      concepts: [],
      concepts_secondary: [],
      world_heritage_sites: [],
      url: 'https://ich.unesco.org/en/USL/01002',
    });
    expect(text).toContain('**Concepts:** None recorded');
    expect(text).toContain('**Secondary concepts:** None recorded');
    expect(text).toContain('- None linked');
    expect(text).toContain('- **Multinational:** No');
  });

  it('omits caption, copyright, and author from the image when UNESCO records none', async () => {
    const { out, text } = await get({ ich_ref: '1003' });
    expect(out.image).toEqual({ url: 'https://ich.unesco.org/img/photo/thumb/9000.jpg' });
    expect(out.list).toBe('Register of Good Safeguarding Practices');
    expect(text).toContain('**Image:** https://ich.unesco.org/img/photo/thumb/9000.jpg');
    expect(text).not.toContain('Caption:');
    expect(text).not.toContain('©');
    expect(text).not.toContain('Photo:');
  });

  it('strips inline tags from linked site names at load', async () => {
    useHub({
      rows: {
        ich001: [
          ichRow({
            ich_public_ref: '1',
            whc_sites: JSON.stringify([{ ref: '7', name_en: 'A <em>Tagged</em> Site' }]),
          }),
        ],
      },
    });
    const { out } = await get({ ich_ref: 1 });
    expect(out.world_heritage_sites).toEqual([{ id_no: '7', name: 'A Tagged Site' }]);
  });
});

describe('unesco_get_intangible_heritage_element — ich_ref input', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['a number', 1001, '1001'],
    ['a digit string', '1001', '1001'],
    ['a padded string', ' 01001 ', '1001'],
    ['the element page URL', 'https://ich.unesco.org/en/RL/01001', '1001'],
    ['a localized Urgent Safeguarding URL without a scheme', 'ich.unesco.org/fr/USL/01002', '1002'],
    ['an Art18 page URL with a trailing slash', 'https://ich.unesco.org/en/Art18/01003/', '1003'],
  ])('accepts %s', async (_label, ich_ref, expected) => {
    const { out } = await get({ ich_ref });
    expect(out.ich_ref).toBe(expected);
  });

  it.each([
    ['a non-numeric string', 'abc'],
    ['a blank string (required, never unset)', ''],
    ['whitespace', '   '],
    ['zero', '0'],
    ['a six-digit ref', '100000'],
    ['a negative number', -3],
    ['a fractional number', 1.5],
    ['an unknown list segment in the URL', 'https://ich.unesco.org/en/XX/01001'],
    ['a World Heritage page URL', 'https://whc.unesco.org/en/list/101/'],
    ['null', null],
  ])('rejects %s as invalid arguments', async (_label, ich_ref) => {
    const error = errorOf(await runToolContract(tool, { ich_ref } as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it('rejects a missing ich_ref and names the field in the hint', async () => {
    const error = errorOf(await runToolContract(tool, {} as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.recovery?.hint).toContain('ich_ref');
  });
});

describe('unesco_get_intangible_heritage_element — declared errors', () => {
  it('element_not_found: NotFound with reason, ref, and the declared recovery', async () => {
    useHub();
    const result = await runToolContract(tool, { ich_ref: 9999 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'element_not_found',
      ich_ref: '9999',
      recovery: { hint: declaredRecovery(tool.errors, 'element_not_found') },
    });
    expect(error.data?.recovery?.hint).toContain('unesco_search_intangible_heritage');
    expect(allText(result)).toContain('Recovery: Find the element');
    expect(allText(result)).toContain('(reason element_not_found)');
  });

  it('element_not_found via the handler directly carries the reason on the thrown error', async () => {
    useHub();
    await expect(
      tool.handler(
        tool.input.parse({ ich_ref: '4242' }),
        createMockContext({ errors: tool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'element_not_found' },
    });
  });

  it('element_not_found on an empty dataset', async () => {
    useHub({ rows: { ich001: [] } });
    const error = errorOf(await runToolContract(tool, { ich_ref: 1001 }));
    expect(error.data?.reason).toBe('element_not_found');
  });

  it('a ref that only differs by padding is the same element, not a miss', async () => {
    useHub();
    const { out } = await get({ ich_ref: '00001001' });
    expect(out.ich_ref).toBe('1001');
  });

  it('snapshot_unavailable: ServiceUnavailable with dataset, retryAfter, and the declared recovery', async () => {
    useHub({ intercept: () => httpFailure(404) });
    const result = await runToolContract(tool, { ich_ref: 1001 });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'snapshot_unavailable',
      dataset: 'ich001',
      retryAfter: 60,
      recovery: { hint: declaredRecovery(tool.errors, 'snapshot_unavailable') },
    });
    expect(allText(result)).toContain('Recovery: The UNESCO Data Hub could not be reached');
  });

  it('fails fast on later calls during the backoff without touching the upstream', async () => {
    const hub = useHub({ intercept: () => httpFailure(404) });
    await runToolContract(tool, { ich_ref: 1001 });
    const calls = hub.calls.length;
    const again = errorOf(await runToolContract(tool, { ich_ref: 1001 }));
    expect(again.data?.reason).toBe('snapshot_unavailable');
    expect(hub.calls).toHaveLength(calls);
  });

  it('does not let an unreadable World Heritage or biosphere dataset affect an element lookup', async () => {
    useHub({ intercept: (call) => (call.dataset === 'ich001' ? undefined : httpFailure(404)) });
    const { out } = await get({ ich_ref: '1001' });
    expect(out.ich_ref).toBe('1001');
  });

  it('does not read the sibling datasets', async () => {
    const hub = useHub();
    await get({ ich_ref: '1001' });
    expect(hub.callsFor('whc001')).toHaveLength(0);
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
      { ich_ref: 1001 },
      { context: { signal: controller.signal } },
    );
    await vi.waitFor(() => expect(hub.callsFor('ich001', 'export')).toHaveLength(1));
    controller.abort(new Error('cancelled by caller'));
    const error = errorOf(await pending);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    release?.();
  });
});

describe('unesco_get_intangible_heritage_element — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(failureCases('ich001', ICH_ROWS.length))(
    'reports %s as snapshot_unavailable',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const error = errorOf(await settle(runToolContract(tool, { ich_ref: 1001 })));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'ich001' });
      expect(error.data?.recovery?.hint).toContain('unesco_get_intangible_heritage_element');
    },
  );

  it('reports a license change as snapshot_unavailable', async () => {
    useHub({ metas: { ich001: { license: 'All rights reserved' } } });
    const error = errorOf(await runToolContract(tool, { ich_ref: 1001 }));
    expect(error.data?.reason).toBe('snapshot_unavailable');
  });

  it.each([
    ['an unknown list', { type_of_element_en: 'Unlisted' }],
    ['a non-alpha-2 country', { countries: ['FRA'] }],
    ['a malformed whc_sites string', { whc_sites: '{not json' }],
    ['a missing description', { description_en: null }],
  ])('reports a row with %s as snapshot_unavailable', async (_label, overrides) => {
    useHub({ rows: { ich001: [ichRow(overrides)] } });
    const error = errorOf(await runToolContract(tool, { ich_ref: 9000 }));
    expect(error.data?.reason).toBe('snapshot_unavailable');
  });
});

describe('unesco_get_intangible_heritage_element — format() parity and text safety', () => {
  beforeEach(() => {
    useHub();
  });

  it('renders every structured field the model needs', async () => {
    const { result, out, text } = await get({ ich_ref: '1001' });
    const body = textBlocks(result)[0] ?? '';
    for (const expected of [
      out.name,
      `ich_ref ${out.ich_ref}`,
      out.name_fr,
      out.list,
      'France (FR), Belgium (BE)',
      String(out.inscribed_year),
      out.url,
      ...out.description.split(/\n+/),
      ...out.concepts,
      ...out.concepts_secondary,
      ...out.world_heritage_sites.map((s) => `${s.id_no} — ${s.name}`),
      out.image?.url,
      out.image?.caption,
      out.image?.copyright,
      out.image?.author,
    ]) {
      expect(body, String(expected)).toContain(String(expected));
    }
    expect(text).toContain('- **Multinational:** Yes');
    expect(text).toContain('Source: UNESCO — Intangible Heritage List (ich001)');
  });

  it('quotes a multi-paragraph description line by line', async () => {
    const { text } = await get({ ich_ref: '1001' });
    expect(text).toContain('**Description:**\n> First paragraph.\n>\n> Second paragraph.');
  });

  it('joins concept terms with commas on one line each', async () => {
    const { text } = await get({ ich_ref: '1001' });
    expect(text).toContain('**Concepts:** Textile craft');
    expect(text).toContain('**Secondary concepts:** Community, Ritual');
  });

  it('flattens CR/LF in inline upstream text and quotes it in the description', async () => {
    useHub({
      rows: {
        ich001: [
          ichRow({
            ich_public_ref: '77',
            title_en: 'Evil\r\n# Injected Heading',
            title_fr: 'Nom\nFrançais',
            description_en: 'First line.\n\n## Not A Heading\n- not a list\r\nTail',
            concepts_primary_names: ['Line\nOne', 'Two\r\n- item'],
            concepts_secondary_names: ['Sec\r\n# Heading'],
            whc_sites: JSON.stringify([{ ref: '5', name_en: 'Site\r\n## Name' }]),
            main_image_caption_en: 'Caption\nSecond',
            main_image_copyright: 'Owner\r\n**bold**',
            main_image_author: 'Author\nName',
          }),
        ],
      },
    });
    const { out, text } = await get({ ich_ref: '77' });

    expect(out.name).toBe('Evil\r\n# Injected Heading');
    expect(out.concepts[0]).toBe('Line\nOne');

    const lines = text.split('\n');
    expect(lines).toContain('## Evil # Injected Heading (ich_ref 77)');
    expect(lines).toContain('- **French name:** Nom Français');
    expect(text).toContain('**Concepts:** Line One, Two - item');
    expect(text).toContain('**Secondary concepts:** Sec # Heading');
    expect(text).toContain('- 5 — Site ## Name');
    expect(text).toContain('Caption: Caption Second');
    expect(text).toContain('© Owner **bold**');
    expect(text).toContain('Photo: Author Name');
    expect(lines.some((l) => l.startsWith('# Injected') || l.startsWith('## Name'))).toBe(false);

    const quoted = ['> First line.', '>', '> ## Not A Heading', '> - not a list', '> Tail'];
    const start = lines.indexOf(quoted[0] as string);
    expect(lines.slice(start, start + quoted.length)).toEqual(quoted);
    expect(lines.some((l) => l === '## Not A Heading' || l === '- not a list')).toBe(false);
    expect(text).not.toContain('\r');
  });
});
