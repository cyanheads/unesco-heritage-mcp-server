/**
 * @fileoverview Tests for the unesco://biosphere-reserve/{mab_id} resource:
 * URI matching with percent-encoded and raw non-ASCII ids, case and diacritic
 * folding, payload parity with unesco_get_biosphere_reserve, sources inside the
 * payload, declared errors, upstream failure classes, and JSON-serializability
 * of the record.
 * @module tests/resources/biosphere-reserve.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biosphereReserveResource as resource } from '@/mcp-server/resources/definitions/biosphere-reserve.resource.js';
import { getBiosphereReserveTool } from '@/mcp-server/tools/definitions/get-biosphere-reserve.tool.js';
import { declaredRecovery } from '../fixtures/contract.js';
import { failureCases, settle, withFakeTimers } from '../fixtures/failures.js';
import { httpFailure } from '../fixtures/hub.js';
import { matchUri, readResource } from '../fixtures/resource.js';
import { MAB_ROWS, mabRow } from '../fixtures/rows.js';
import { disposeServiceAfterEach, structured, useHub } from '../fixtures/tool.js';

interface ReserveResource {
  mab_id: string;
  name: string;
  sources: { dataset: string }[];
}

const RECORD_KEYS = [
  'area_hectares',
  'country',
  'country_code',
  'designation_year',
  'ecological_characteristics',
  'extension_years',
  'introduction',
  'latitude',
  'longitude',
  'mab_id',
  'name',
  'periodic_review_years',
  'population',
  'regional_network',
  'regions',
  'renaming_years',
  'sids',
  'socio_economic_characteristics',
  'sources',
  'transboundary',
  'url',
  'website',
];

disposeServiceAfterEach();

const read = (uri: string) => readResource<ReserveResource>(resource, uri);

describe('unesco://biosphere-reserve/{mab_id} — definition', () => {
  it('declares its identity, MIME type, cache hint, and no list()', () => {
    expect(resource.uriTemplate).toBe('unesco://biosphere-reserve/{mab_id}');
    expect(resource.name).toBe('unesco_biosphere_reserve');
    expect(resource.mimeType).toBe('application/json');
    expect(resource.cacheHint).toEqual({ ttlMs: 3_600_000, cacheScope: 'public' });
    expect(resource.list).toBeUndefined();
  });

  it('declares the same error reasons as the tool', () => {
    const reasons = (errors: readonly { reason: string }[] | undefined) =>
      (errors ?? []).map((e) => e.reason).sort();
    expect(reasons(resource.errors)).toEqual(reasons(getBiosphereReserveTool.errors));
  });

  it('captures a percent-encoded id as one undecoded segment', () => {
    expect(matchUri(resource.uriTemplate, 'unesco://biosphere-reserve/PE%C3%91andu2001')).toEqual({
      mab_id: 'PE%C3%91andu2001',
    });
  });
});

describe('unesco://biosphere-reserve/{mab_id} — record', () => {
  beforeEach(() => {
    useHub();
  });

  it('returns the unesco_get_biosphere_reserve payload plus sources', async () => {
    const record = await read('unesco://biosphere-reserve/FRAlder1998');
    const tool = structured<Record<string, unknown>>(
      await runToolContract(getBiosphereReserveTool, { mab_id: 'FRAlder1998' }),
    );
    expect(record).toEqual(tool);
    expect(record.sources).toEqual([
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

  it('carries exactly the record fields plus sources', async () => {
    const record = await read('unesco://biosphere-reserve/FRAlder1998');
    expect(Object.keys(record).sort()).toEqual(RECORD_KEYS);
  });

  it('omits the optional fields a sparse reserve lacks', async () => {
    const record = await read('unesco://biosphere-reserve/PE%C3%91andu2001');
    expect(Object.keys(record).sort()).toEqual(
      RECORD_KEYS.filter(
        (k) =>
          ![
            'regional_network',
            'ecological_characteristics',
            'socio_economic_characteristics',
            'website',
          ].includes(k),
      ),
    );
  });

  it.each([
    ['a percent-encoded id', 'unesco://biosphere-reserve/PE%C3%91andu2001'],
    ['a lowercase percent-encoded id', 'unesco://biosphere-reserve/pe%c3%b1andu2001'],
    ['a raw non-ASCII id', 'unesco://biosphere-reserve/PEÑandu2001'],
    ['a raw decomposed (NFD) id', `unesco://biosphere-reserve/${'PEÑandu2001'.normalize('NFD')}`],
    ['a percent-encoded decomposed id', 'unesco://biosphere-reserve/PEN%CC%83andu2001'],
    ['a lowercase raw id', 'unesco://biosphere-reserve/peñandu2001'],
    ['an id with the diacritic folded away', 'unesco://biosphere-reserve/PENandu2001'],
  ])('resolves %s to the reserve', async (_label, uri) => {
    const record = await read(uri);
    expect(record.mab_id).toBe('PEÑandu2001');
    expect(record.mab_id).toBe(record.mab_id.normalize('NFC'));
  });

  it.each([
    ['the exact id', 'unesco://biosphere-reserve/FRAlder1998'],
    ['a lowercase id', 'unesco://biosphere-reserve/fralder1998'],
    ['an uppercase id', 'unesco://biosphere-reserve/FRALDER1998'],
    ['a percent-escaped ASCII letter', 'unesco://biosphere-reserve/FR%41lder1998'],
  ])('resolves %s to the reserve', async (_label, uri) => {
    expect((await read(uri)).mab_id).toBe('FRAlder1998');
  });

  it('returns a value that survives a JSON round trip unchanged', async () => {
    const record = await read('unesco://biosphere-reserve/DEBrin1993');
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('does not read the sibling datasets', async () => {
    const hub = useHub();
    await read('unesco://biosphere-reserve/FRAlder1998');
    expect(hub.callsFor('whc001')).toHaveLength(0);
    expect(hub.callsFor('ich001')).toHaveLength(0);
  });
});

describe('unesco://biosphere-reserve/{mab_id} — errors', () => {
  it('rejects an id over 20 characters before the handler runs', async () => {
    const hub = useHub();
    await expect(read('unesco://biosphere-reserve/FRAlder1998FRAlder199')).rejects.toThrow();
    expect(hub.calls).toHaveLength(0);
  });

  it('rejects an id that percent-decodes to whitespace only', async () => {
    useHub();
    await expect(read('unesco://biosphere-reserve/%20%20')).rejects.toThrow();
  });

  it('rejects a URI that does not match the template', async () => {
    useHub();
    await expect(read('unesco://biosphere-reserve/')).rejects.toThrow('does not match');
    await expect(read('unesco://biosphere-reserve/FRAlder1998/x')).rejects.toThrow(
      'does not match',
    );
  });

  it.each([
    ['an unknown id', 'unesco://biosphere-reserve/ZZNone9999', 'ZZNone9999'],
    ['a malformed percent-escape', 'unesco://biosphere-reserve/%E0%A4%A', '%E0%A4%A'],
    ['a lone percent sign', 'unesco://biosphere-reserve/%25', '%'],
  ])(
    'biosphere_reserve_not_found for %s, reporting the id as normalized',
    async (_label, uri, id) => {
      useHub();
      await expect(read(uri)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'biosphere_reserve_not_found', mab_id: id },
      });
      expect(declaredRecovery(resource.errors, 'biosphere_reserve_not_found')).toContain(
        'unesco_search_biosphere_reserves',
      );
    },
  );

  it('biosphere_reserve_not_found on an empty dataset', async () => {
    useHub({ rows: { mab001: [] } });
    await expect(read('unesco://biosphere-reserve/FRAlder1998')).rejects.toMatchObject({
      data: { reason: 'biosphere_reserve_not_found' },
    });
  });

  it('snapshot_unavailable: ServiceUnavailable with dataset and retryAfter', async () => {
    useHub({ intercept: () => httpFailure(404) });
    await expect(read('unesco://biosphere-reserve/FRAlder1998')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'snapshot_unavailable', dataset: 'mab001', retryAfter: 60 },
    });
    expect(
      declaredRecovery(resource.errors, 'snapshot_unavailable').split(/\s+/).length,
    ).toBeGreaterThanOrEqual(5);
  });
});

describe('unesco://biosphere-reserve/{mab_id} — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(failureCases('mab001', MAB_ROWS.length))(
    'reports %s as snapshot_unavailable',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const pending = read('unesco://biosphere-reserve/FRAlder1998').catch((e: unknown) => e);
      expect(await settle(pending)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'snapshot_unavailable', dataset: 'mab001' },
      });
    },
  );

  it('reports a row with an unknown region as snapshot_unavailable', async () => {
    useHub({ rows: { mab001: [mabRow({ regional_group: 'Atlantis' })] } });
    await expect(read('unesco://biosphere-reserve/FRTest1990')).rejects.toMatchObject({
      data: { reason: 'snapshot_unavailable' },
    });
  });
});
