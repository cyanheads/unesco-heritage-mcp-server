/**
 * @fileoverview Tests for the unesco://intangible-heritage/{ich_ref} resource:
 * URI matching and ref normalization, payload parity with
 * unesco_get_intangible_heritage_element, sources inside the payload, declared
 * errors, upstream failure classes, and JSON-serializability of the record.
 * @module tests/resources/intangible-heritage-element.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intangibleHeritageElementResource as resource } from '@/mcp-server/resources/definitions/intangible-heritage-element.resource.js';
import { getIntangibleHeritageElementTool } from '@/mcp-server/tools/definitions/get-intangible-heritage-element.tool.js';
import { declaredRecovery } from '../fixtures/contract.js';
import { failureCases, settle, withFakeTimers } from '../fixtures/failures.js';
import { httpFailure } from '../fixtures/hub.js';
import { readResource } from '../fixtures/resource.js';
import { ICH_ROWS, ichRow } from '../fixtures/rows.js';
import { disposeServiceAfterEach, structured, useHub } from '../fixtures/tool.js';

interface ElementResource {
  ich_ref: string;
  image?: Record<string, string>;
  name: string;
  sources: { dataset: string }[];
  world_heritage_sites: { id_no: string; name: string }[];
}

const RECORD_KEYS = [
  'concepts',
  'concepts_secondary',
  'countries',
  'country_codes',
  'description',
  'ich_ref',
  'image',
  'inscribed_year',
  'list',
  'multinational',
  'name',
  'name_fr',
  'sources',
  'url',
  'world_heritage_sites',
];

disposeServiceAfterEach();

const read = (uri: string) => readResource<ElementResource>(resource, uri);

describe('unesco://intangible-heritage/{ich_ref} — definition', () => {
  it('declares its identity, MIME type, cache hint, and no list()', () => {
    expect(resource.uriTemplate).toBe('unesco://intangible-heritage/{ich_ref}');
    expect(resource.name).toBe('unesco_intangible_heritage_element');
    expect(resource.mimeType).toBe('application/json');
    expect(resource.cacheHint).toEqual({ ttlMs: 3_600_000, cacheScope: 'public' });
    expect(resource.list).toBeUndefined();
  });

  it('declares the same error reasons as the tool', () => {
    const reasons = (errors: readonly { reason: string }[] | undefined) =>
      (errors ?? []).map((e) => e.reason).sort();
    expect(reasons(resource.errors)).toEqual(reasons(getIntangibleHeritageElementTool.errors));
  });
});

describe('unesco://intangible-heritage/{ich_ref} — record', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns the unesco_get_intangible_heritage_element payload plus sources', async () => {
    const record = await read('unesco://intangible-heritage/1001');
    const tool = structured<Record<string, unknown>>(
      await runToolContract(getIntangibleHeritageElementTool, { ich_ref: '1001' }),
    );
    expect(record).toEqual(tool);
    expect(record.sources).toEqual([
      {
        dataset: 'ich001',
        title: 'Intangible Heritage List',
        data_as_of: '2026-09-30T02:06:00+00:00',
        license: 'CC BY-SA 4.0',
        attribution: 'UNESCO — Intangible Heritage List (ich001), UNESCO Data Hub, CC BY-SA 4.0',
      },
    ]);
  });

  it('carries exactly the record fields plus sources, with no loader-internal fields', async () => {
    const record = await read('unesco://intangible-heritage/1001');
    expect(Object.keys(record).sort()).toEqual(RECORD_KEYS);
  });

  it('keeps a sparse element sparse', async () => {
    const record = await read('unesco://intangible-heritage/1002');
    expect(record).toMatchObject({
      concepts: [],
      concepts_secondary: [],
      world_heritage_sites: [],
    });
  });

  it('strips inline tags from linked site names', async () => {
    const record = await read('unesco://intangible-heritage/1001');
    expect(record.world_heritage_sites[0]).toEqual({ id_no: '101', name: 'Alderfen Old Town' });
  });

  it.each([
    ['a zero-padded ref', 'unesco://intangible-heritage/01001'],
    ['a long padded ref', 'unesco://intangible-heritage/0001001'],
  ])('resolves %s to the same element', async (_label, uri) => {
    expect((await read(uri)).ich_ref).toBe('1001');
  });

  it('returns a value that survives a JSON round trip unchanged', async () => {
    const record = await read('unesco://intangible-heritage/1003');
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('does not read the sibling datasets', async () => {
    const hub = useHub();
    await read('unesco://intangible-heritage/1001');
    expect(hub.callsFor('whc001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
  });
});

describe('unesco://intangible-heritage/{ich_ref} — errors', () => {
  it.each([
    ['a non-numeric ref', 'unesco://intangible-heritage/abc'],
    ['zero', 'unesco://intangible-heritage/0'],
    ['a six-digit ref', 'unesco://intangible-heritage/100000'],
    ['a negative ref', 'unesco://intangible-heritage/-3'],
  ])('rejects %s before the handler runs', async (_label, uri) => {
    const hub = useHub();
    await expect(read(uri)).rejects.toThrow();
    expect(hub.calls).toHaveLength(0);
  });

  it('rejects a URI that does not match the template', async () => {
    useHub();
    await expect(read('unesco://intangible-heritage/')).rejects.toThrow('does not match');
    await expect(read('unesco://intangible-heritage/1001/x')).rejects.toThrow('does not match');
  });

  it('element_not_found: NotFound with reason, ref, and the declared recovery entry', async () => {
    useHub();
    await expect(read('unesco://intangible-heritage/9999')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'element_not_found', ich_ref: '9999' },
    });
    expect(declaredRecovery(resource.errors, 'element_not_found')).toContain(
      'unesco_search_intangible_heritage',
    );
  });

  it('element_not_found on an empty dataset', async () => {
    useHub({ rows: { ich001: [] } });
    await expect(read('unesco://intangible-heritage/1001')).rejects.toMatchObject({
      data: { reason: 'element_not_found' },
    });
  });

  it('snapshot_unavailable: ServiceUnavailable with dataset and retryAfter', async () => {
    useHub({ intercept: () => httpFailure(404) });
    await expect(read('unesco://intangible-heritage/1001')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'snapshot_unavailable', dataset: 'ich001', retryAfter: 60 },
    });
    expect(
      declaredRecovery(resource.errors, 'snapshot_unavailable').split(/\s+/).length,
    ).toBeGreaterThanOrEqual(5);
  });
});

describe('unesco://intangible-heritage/{ich_ref} — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(failureCases('ich001', ICH_ROWS.length))(
    'reports %s as snapshot_unavailable',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const pending = read('unesco://intangible-heritage/1001').catch((e: unknown) => e);
      expect(await settle(pending)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'snapshot_unavailable', dataset: 'ich001' },
      });
    },
  );

  it('reports a schema-invalid row as snapshot_unavailable', async () => {
    useHub({ rows: { ich001: [ichRow({ type_of_element_en: 'Unlisted' })] } });
    await expect(read('unesco://intangible-heritage/9000')).rejects.toMatchObject({
      data: { reason: 'snapshot_unavailable' },
    });
  });
});
