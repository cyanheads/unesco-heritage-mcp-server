/**
 * @fileoverview Tests for the unesco://site/{id_no} resource: URI matching and
 * id normalization, payload parity with unesco_get_site (component cap of 20,
 * sources inside the payload), declared errors, upstream failure classes, and
 * JSON-serializability of the record.
 * @module tests/resources/site.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { siteResource } from '@/mcp-server/resources/definitions/site.resource.js';
import { getSiteTool } from '@/mcp-server/tools/definitions/get-site.tool.js';
import { declaredRecovery } from '../fixtures/contract.js';
import { failureCases, settle, withFakeTimers } from '../fixtures/failures.js';
import { httpFailure } from '../fixtures/hub.js';
import { readResource } from '../fixtures/resource.js';
import { WHC_ROWS, whcRow } from '../fixtures/rows.js';
import { disposeServiceAfterEach, structured, useHub } from '../fixtures/tool.js';

interface SiteResource {
  components: { ref: string }[];
  components_total: number;
  criteria: { code: string; source: string }[];
  id_no: string;
  name: string;
  sources: {
    attribution: string;
    data_as_of: string;
    dataset: string;
    license: string;
    title: string;
  }[];
  url: string;
}

const ENRICHMENT_KEYS = ['sources', 'truncated', 'shown', 'cap', 'notice'];

disposeServiceAfterEach();

const read = (uri: string) => readResource<SiteResource>(siteResource, uri);

describe('unesco://site/{id_no} — definition', () => {
  it('declares its identity, MIME type, cache hint, and no list()', () => {
    expect(siteResource.uriTemplate).toBe('unesco://site/{id_no}');
    expect(siteResource.name).toBe('unesco_site');
    expect(siteResource.mimeType).toBe('application/json');
    expect(siteResource.cacheHint).toEqual({ ttlMs: 3_600_000, cacheScope: 'public' });
    expect(siteResource.list).toBeUndefined();
  });

  it('declares the same error reasons as the tool', () => {
    const reasons = (errors: readonly { reason: string }[] | undefined) =>
      (errors ?? []).map((e) => e.reason).sort();
    expect(reasons(siteResource.errors)).toEqual(reasons(getSiteTool.errors));
  });
});

describe('unesco://site/{id_no} — record', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns the unesco_get_site payload plus sources', async () => {
    const record = await read('unesco://site/101');
    const tool = structured<Record<string, unknown>>(
      await runToolContract(getSiteTool, { id_no: '101' }),
    );
    const expected = Object.fromEntries(
      Object.entries(tool).filter(([key]) => !ENRICHMENT_KEYS.includes(key)),
    );
    const { sources, ...payload } = record;
    expect(payload).toEqual(expected);
    expect(sources).toEqual([
      {
        dataset: 'whc001',
        title: 'World Heritage List',
        data_as_of: '2026-09-30T02:06:00+00:00',
        license: 'CC BY-SA 4.0',
        attribution: 'UNESCO — World Heritage List (whc001), UNESCO Data Hub, CC BY-SA 4.0',
      },
    ]);
  });

  it('carries no enrichment fields beyond sources, since a resource has no enrichment block', async () => {
    const record = await read('unesco://site/101');
    for (const key of ENRICHMENT_KEYS.filter((k) => k !== 'sources')) {
      expect(record, key).not.toHaveProperty(key);
    }
    expect(record).not.toHaveProperty('criteria_inferred');
  });

  it('lists at most 20 components and reports the full count', async () => {
    const record = await read('unesco://site/109');
    expect(record.components).toHaveLength(20);
    expect(record.components_total).toBe(25);
    expect(record.components[0]?.ref).toBe('109-001');
  });

  it('marks an inferred criterion (vi) as inferred', async () => {
    const record = await read('unesco://site/103');
    expect(record.criteria).toEqual([expect.objectContaining({ code: 'vi', source: 'inferred' })]);
  });

  it.each([
    ['a zero-padded id', 'unesco://site/0101'],
    ['a long padded id', 'unesco://site/00101'],
  ])('resolves %s to the same site', async (_label, uri) => {
    expect((await read(uri)).id_no).toBe('101');
  });

  it('returns a value that survives a JSON round trip unchanged', async () => {
    const record = await read('unesco://site/102');
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('returns equal records on repeated reads', async () => {
    expect(await read('unesco://site/101')).toEqual(await read('unesco://site/101'));
  });

  it('does not read the sibling datasets', async () => {
    const hub = useHub();
    await read('unesco://site/101');
    expect(hub.callsFor('ich001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
  });
});

describe('unesco://site/{id_no} — errors', () => {
  it.each([
    ['a non-numeric id', 'unesco://site/abc'],
    ['zero', 'unesco://site/0'],
    ['a six-digit id', 'unesco://site/100000'],
    ['a negative id', 'unesco://site/-3'],
    ['a fractional id', 'unesco://site/1.5'],
  ])('rejects %s before the handler runs', async (_label, uri) => {
    const hub = useHub();
    await expect(read(uri)).rejects.toThrow();
    expect(hub.calls).toHaveLength(0);
  });

  it('rejects a URI that does not match the template', async () => {
    useHub();
    await expect(read('unesco://site/')).rejects.toThrow('does not match');
    await expect(read('unesco://site/101/extra')).rejects.toThrow('does not match');
  });

  it('site_not_found: NotFound with reason, id, and the declared recovery entry', async () => {
    useHub();
    await expect(read('unesco://site/999')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'site_not_found', id_no: '999' },
    });
    expect(declaredRecovery(siteResource.errors, 'site_not_found')).toContain('unesco_get_site');
  });

  it('site_not_found on an empty dataset', async () => {
    useHub({ rows: { whc001: [] } });
    await expect(read('unesco://site/101')).rejects.toMatchObject({
      data: { reason: 'site_not_found' },
    });
  });

  it('snapshot_unavailable: ServiceUnavailable with dataset and retryAfter', async () => {
    useHub({ intercept: () => httpFailure(404) });
    await expect(read('unesco://site/101')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'snapshot_unavailable', dataset: 'whc001', retryAfter: 60 },
    });
    expect(
      declaredRecovery(siteResource.errors, 'snapshot_unavailable').split(/\s+/).length,
    ).toBeGreaterThanOrEqual(5);
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
    const cancelled = readResource(siteResource, 'unesco://site/101', {
      signal: controller.signal,
    }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(hub.callsFor('whc001', 'export')).toHaveLength(1));
    controller.abort(new Error('cancelled by caller'));
    const error = await cancelled;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ data: { reason: 'snapshot_unavailable' } });
    release?.();
  });
});

describe('unesco://site/{id_no} — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(failureCases('whc001', WHC_ROWS.length))(
    'reports %s as snapshot_unavailable',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const pending = read('unesco://site/101').catch((e: unknown) => e);
      expect(await settle(pending)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'snapshot_unavailable', dataset: 'whc001' },
      });
    },
  );

  it('reports a schema-invalid row as snapshot_unavailable', async () => {
    useHub({ rows: { whc001: [whcRow({ region: 'Atlantis' })] } });
    await expect(read('unesco://site/900')).rejects.toMatchObject({
      data: { reason: 'snapshot_unavailable' },
    });
  });
});
