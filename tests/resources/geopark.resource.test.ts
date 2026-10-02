/**
 * @fileoverview Tests for the unesco://geopark/{ugg_id} resource: URI matching,
 * case-insensitive ids, payload parity with unesco_get_geopark, sources inside
 * the payload, the sparse record, declared errors, upstream failure classes,
 * and JSON-serializability of the record.
 * @module tests/resources/geopark.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { geoparkResource as resource } from '@/mcp-server/resources/definitions/geopark.resource.js';
import { getGeoparkTool } from '@/mcp-server/tools/definitions/get-geopark.tool.js';
import { declaredRecovery } from '../fixtures/contract.js';
import { failureCases, settle, withFakeTimers } from '../fixtures/failures.js';
import { httpFailure } from '../fixtures/hub.js';
import { matchUri, readResource } from '../fixtures/resource.js';
import { EG_ROWS, egRow } from '../fixtures/rows.js';
import { disposeServiceAfterEach, structured, useHub } from '../fixtures/tool.js';

interface GeoparkResource {
  population?: number;
  sources: { dataset: string }[];
  ugg_id: string;
  website?: string;
}

const RECORD_KEYS = [
  'area_hectares',
  'countries',
  'country_codes',
  'description',
  'designation_year',
  'introduction',
  'latitude',
  'longitude',
  'name',
  'population',
  'sources',
  'sustaining_local_communities',
  'transnational',
  'ugg_id',
  'url',
  'website',
];

disposeServiceAfterEach();

const read = (uri: string) => readResource<GeoparkResource>(resource, uri);

describe('unesco://geopark/{ugg_id} — definition', () => {
  it('declares its identity, MIME type, cache hint, and no list()', () => {
    expect(resource.uriTemplate).toBe('unesco://geopark/{ugg_id}');
    expect(resource.name).toBe('unesco_geopark');
    expect(resource.mimeType).toBe('application/json');
    expect(resource.cacheHint).toEqual({ ttlMs: 3_600_000, cacheScope: 'public' });
    expect(resource.list).toBeUndefined();
  });

  it('declares the same error reasons as the tool, without the tool severity', () => {
    const reasons = (errors: readonly { reason: string }[] | undefined) =>
      (errors ?? []).map((e) => e.reason).sort();
    expect(reasons(resource.errors)).toEqual(reasons(getGeoparkTool.errors));
    expect(reasons(resource.errors)).toEqual(['geopark_not_found', 'snapshot_unavailable']);
    for (const entry of resource.errors ?? []) {
      expect(entry, entry.reason).not.toHaveProperty('severity');
    }
  });

  it('captures the id as one segment', () => {
    expect(matchUri(resource.uriTemplate, 'unesco://geopark/eufr90')).toEqual({ ugg_id: 'eufr90' });
  });
});

describe('unesco://geopark/{ugg_id} — record', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns the unesco_get_geopark payload plus sources', async () => {
    const record = await read('unesco://geopark/EUFR90');
    const tool = structured<Record<string, unknown>>(
      await runToolContract(getGeoparkTool, { ugg_id: 'EUFR90' }),
    );
    expect(record).toEqual(tool);
    expect(record.sources).toEqual([
      {
        dataset: 'eg0001',
        title: 'UNESCO Global Geoparks',
        data_as_of: '2026-09-30T02:06:00+00:00',
        license: 'CC BY-SA 4.0',
        attribution: 'UNESCO — UNESCO Global Geoparks (eg0001), UNESCO Data Hub, CC BY-SA 4.0',
      },
    ]);
  });

  it('carries exactly the record fields plus sources', async () => {
    const record = await read('unesco://geopark/EUFR90');
    expect(Object.keys(record).sort()).toEqual(RECORD_KEYS);
  });

  it('omits population and website for the sparse geopark, matching the tool', async () => {
    const record = await read('unesco://geopark/ASJP91');
    expect(Object.keys(record).sort()).toEqual(
      RECORD_KEYS.filter((k) => !['population', 'website'].includes(k)),
    );
    const tool = structured<Record<string, unknown>>(
      await runToolContract(getGeoparkTool, { ugg_id: 'asjp91' }),
    );
    expect(record).toEqual(tool);
  });

  it('keeps a 0 population as recorded on the transnational geopark', async () => {
    const record = await read('unesco://geopark/EUA190');
    expect(record).toMatchObject({
      ugg_id: 'EUA190',
      population: 0,
      country_codes: ['DE', 'PL'],
      transnational: true,
    });
  });

  it.each([
    ['the exact id', 'unesco://geopark/EUFR90'],
    ['a lowercase id', 'unesco://geopark/eufr90'],
    ['a mixed-case id', 'unesco://geopark/EuFr90'],
  ])('resolves %s to the geopark', async (_label, uri) => {
    expect((await read(uri)).ugg_id).toBe('EUFR90');
  });

  it('returns a value that survives a JSON round trip unchanged', async () => {
    const record = await read('unesco://geopark/EUFR90');
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('does not read the sibling datasets', async () => {
    const hub = useHub();
    await read('unesco://geopark/EUFR90');
    expect(hub.callsFor('whc001')).toHaveLength(0);
    expect(hub.callsFor('ich001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
  });
});

describe('unesco://geopark/{ugg_id} — errors', () => {
  it.each([
    ['an id over 20 characters', 'unesco://geopark/EUFR90EUFR90EUFR90EUF'],
    ['an id with punctuation', 'unesco://geopark/EU-FR90'],
    ['a percent-escaped id', 'unesco://geopark/EUFR%3990'],
  ])('rejects %s before the handler runs', async (_label, uri) => {
    const hub = useHub();
    await expect(read(uri)).rejects.toThrow();
    expect(hub.calls).toHaveLength(0);
  });

  it('rejects a URI that does not match the template', async () => {
    useHub();
    await expect(read('unesco://geopark/')).rejects.toThrow('does not match');
    await expect(read('unesco://geopark/EUFR90/x')).rejects.toThrow('does not match');
  });

  it('geopark_not_found for an unknown id, reporting the id as normalized', async () => {
    useHub();
    await expect(read('unesco://geopark/zz99')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'No UNESCO Global Geopark has ugg_id "ZZ99".',
      data: { reason: 'geopark_not_found', ugg_id: 'ZZ99' },
    });
    expect(declaredRecovery(resource.errors, 'geopark_not_found')).toContain(
      'unesco_search_geoparks',
    );
  });

  it('geopark_not_found on an empty dataset', async () => {
    useHub({ rows: { eg0001: [] } });
    await expect(read('unesco://geopark/EUFR90')).rejects.toMatchObject({
      data: { reason: 'geopark_not_found' },
    });
  });

  it('snapshot_unavailable: ServiceUnavailable with dataset and retryAfter', async () => {
    useHub({ intercept: () => httpFailure(404) });
    await expect(read('unesco://geopark/EUFR90')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'snapshot_unavailable', dataset: 'eg0001', retryAfter: 60 },
    });
    expect(declaredRecovery(resource.errors, 'snapshot_unavailable')).toContain(
      'read the resource again',
    );
  });
});

describe('unesco://geopark/{ugg_id} — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(failureCases('eg0001', EG_ROWS.length))(
    'reports %s as snapshot_unavailable',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const pending = read('unesco://geopark/EUFR90').catch((e: unknown) => e);
      expect(await settle(pending)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'snapshot_unavailable', dataset: 'eg0001' },
      });
    },
  );

  it('reports a row with an area unit other than hectares as snapshot_unavailable', async () => {
    useHub({ rows: { eg0001: [egRow({ area_unit: 'acres' })] } });
    await expect(read('unesco://geopark/EUFR99')).rejects.toMatchObject({
      data: { reason: 'snapshot_unavailable' },
    });
  });
});
