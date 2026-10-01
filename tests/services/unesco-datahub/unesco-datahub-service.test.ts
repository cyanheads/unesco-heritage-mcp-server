/**
 * @fileoverview Tests for the snapshot lifecycle of UnescoDataHubService,
 * driven through its `get` and `now` seams: lazy load, request allowlist,
 * single-flight, TTL with stale-while-revalidate, failure backoff, strict row
 * validation, the row-count retry, the body budgets and text bounds, the
 * license check, and upstream failure classes (non-2xx, malformed body,
 * timeout, rate limit, network error).
 * @module tests/services/unesco-datahub/unesco-datahub-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WHC_FIELDS } from '@/services/unesco-datahub/rows.js';
import {
  getUnescoDataHubService,
  initUnescoDataHubService,
  sourceOf,
  UnescoDataHubService,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import {
  BASE_URL,
  createHub,
  DATA_AS_OF,
  type FakeHub,
  type HubOptions,
  httpFailure,
  metaDocument,
} from '../../fixtures/hub.js';
import { ICH_ROWS, MAB_ROWS, WHC_ROWS, whcRow } from '../../fixtures/rows.js';

const services: UnescoDataHubService[] = [];
let clock = 0;

function makeService(
  hubOptions: HubOptions = {},
  ttlMs?: number,
): { hub: FakeHub; service: UnescoDataHubService } {
  const hub = createHub(hubOptions);
  const service = new UnescoDataHubService({
    get: hub.get,
    now: () => clock,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
  services.push(service);
  return { hub, service };
}

const ctx = () => createMockContext();

/** Runs a rejecting call to completion under fake timers and returns what it rejected with. */
async function rejectionOf(promise: Promise<unknown>, advanceMs = 10_000): Promise<McpError> {
  const settled = promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  const error = await settled;
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

beforeEach(() => {
  clock = 1_000_000;
});

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('lazy load and snapshot contents', () => {
  it('fetches nothing until a dataset is first requested', async () => {
    const { hub, service } = makeService();
    expect(hub.calls).toHaveLength(0);
    await service.getHeritage(ctx());
    expect(hub.callsFor('whc001').map((c) => c.kind)).toEqual(['meta', 'export']);
    expect(hub.callsFor('ich001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
  });

  it('serves the loaded snapshot without further requests', async () => {
    const { hub, service } = makeService();
    const first = await service.getHeritage(ctx());
    const second = await service.getHeritage(ctx());
    expect(second).toBe(first);
    expect(hub.calls).toHaveLength(2);
  });

  it('builds the heritage snapshot: records, byId, codes, folded tiers, metadata, loadedAt', async () => {
    const { service } = makeService();
    const snapshot = await service.getHeritage(ctx());
    expect(snapshot.dataset).toBe('whc001');
    expect(snapshot.records).toHaveLength(WHC_ROWS.length);
    expect(snapshot.recordsCount).toBe(WHC_ROWS.length);
    expect(snapshot.asOf).toBe(DATA_AS_OF);
    expect(snapshot.license).toBe('CC BY-SA 4.0');
    expect(snapshot.loadedAt).toBe(clock);
    expect(snapshot.byId.get('101')?.name).toBe('Alderfen Old Town');
    expect(snapshot.byId.get('999')).toBeUndefined();
    expect([...snapshot.codes].sort()).toEqual(['DE', 'ET', 'FR', 'JP', 'PE', 'PL']);
    expect(snapshot.folded).toHaveLength(snapshot.records.length);
    for (const tiers of snapshot.folded) expect(tiers).toHaveLength(3);
  });

  it('folds site names of all six languages into tier 1, descriptions into 2, statements into 3', async () => {
    const { service } = makeService();
    const snapshot = await service.getHeritage(ctx());
    const index = snapshot.records.findIndex((s) => s.id_no === '101');
    const [names, description, justification] = snapshot.folded[index] ?? [];
    expect(names).toContain(' alderfen old town');
    expect(names).toContain(' vieille ville d alderfen');
    expect(names).toContain(' casco antiguo de alderfen');
    expect(names).toContain(' 奥德芬古城');
    expect(description).toContain(' a synthetic walled town');
    expect(justification).toContain(' criterion ii synthetic exchange of ideas');
  });

  it('keys intangible elements by ich_ref and folds name, concept, description tiers', async () => {
    const { service } = makeService();
    const snapshot = await service.getIntangible(ctx());
    expect(snapshot.records).toHaveLength(ICH_ROWS.length);
    expect(snapshot.byId.get('1001')?.name).toBe('Synthetic Weaving Rite');
    expect([...snapshot.codes].sort()).toEqual(['BE', 'ET', 'FR', 'JP']);
    const index = snapshot.records.findIndex((e) => e.ich_ref === '1001');
    const [names, concepts, description] = snapshot.folded[index] ?? [];
    expect(names).toContain(' rite de tissage synthetique');
    expect(concepts).toContain(' textile craft community ritual');
    expect(description).toContain(' first paragraph');
  });

  it('keys reserves by folded mab_id so lookups ignore case and diacritics', async () => {
    const { service } = makeService();
    const snapshot = await service.getBiosphere(ctx());
    expect(snapshot.records).toHaveLength(MAB_ROWS.length);
    expect(snapshot.byId.get('penandu2001')?.mab_id).toBe('PEÑandu2001');
    expect(snapshot.byId.get('fralder1998')?.name).toBe('Alderfen Marsh Reserve');
    expect([...snapshot.codes].sort()).toEqual(['DE', 'FR', 'PE', 'PL']);
  });

  it('loads an empty dataset into an empty snapshot', async () => {
    const { service } = makeService({ rows: { whc001: [] } });
    const snapshot = await service.getHeritage(ctx());
    expect(snapshot.records).toEqual([]);
    expect(snapshot.codes.size).toBe(0);
    expect(snapshot.recordsCount).toBe(0);
  });

  it('loads the three datasets independently and in parallel', async () => {
    const { hub, service } = makeService();
    const [heritage, intangible, biosphere] = await Promise.all([
      service.getHeritage(ctx()),
      service.getIntangible(ctx()),
      service.getBiosphere(ctx()),
    ]);
    expect(heritage.dataset).toBe('whc001');
    expect(intangible.dataset).toBe('ich001');
    expect(biosphere.dataset).toBe('mab001');
    expect(hub.calls).toHaveLength(6);
  });

  it('builds the attribution entry from server constants and the snapshot metadata', async () => {
    const { service } = makeService({
      metas: { whc001: { data_processed: '2026-01-02T03:04:05+00:00' } },
    });
    const snapshot = await service.getHeritage(ctx());
    expect(sourceOf(snapshot)).toEqual({
      dataset: 'whc001',
      title: 'World Heritage List',
      data_as_of: '2026-01-02T03:04:05+00:00',
      license: 'CC BY-SA 4.0',
      attribution: 'UNESCO — World Heritage List (whc001), UNESCO Data Hub, CC BY-SA 4.0',
    });
  });
});

describe('request shape', () => {
  it('sends the metadata GET with no parameters and the export GET with only the allowlisted select', async () => {
    const { hub, service } = makeService();
    await service.getHeritage(ctx());
    const [meta, exported] = hub.calls;
    expect(meta?.url).toBe(`${BASE_URL}/whc001`);
    expect(exported?.url).toBe(
      `${BASE_URL}/whc001/exports/json?select=${encodeURIComponent(WHC_FIELDS.join(','))}`,
    );
    const query = new URL(exported?.url ?? '').searchParams;
    expect([...query.keys()]).toEqual(['select']);
    expect(query.get('select')?.split(',')).toEqual([...WHC_FIELDS]);
  });

  it('asks for JSON and bounds every request at or under 30 s', async () => {
    const { hub, service } = makeService();
    await service.getHeritage(ctx());
    for (const call of hub.calls) {
      expect(call.headers.accept).toBe('application/json');
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(30_000);
    }
  });
});

describe('single-flight and cancellation', () => {
  it('shares one load between concurrent first callers', async () => {
    const { hub, service } = makeService();
    const [a, b, c] = await Promise.all([
      service.getHeritage(ctx()),
      service.getHeritage(ctx()),
      service.getHeritage(ctx()),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(hub.callsFor('whc001', 'export')).toHaveLength(1);
    expect(hub.callsFor('whc001', 'meta')).toHaveLength(1);
  });

  it('lets a cancelled caller stop waiting without aborting the shared load', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { hub, service } = makeService({
      intercept: async (call) => {
        if (call.kind === 'export') await gate;
        return;
      },
    });
    const controller = new AbortController();
    const cancelled = service.getHeritage(createMockContext({ signal: controller.signal }));
    const cancelledResult = cancelled.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(hub.callsFor('whc001', 'export')).toHaveLength(1));
    controller.abort(new Error('caller went away'));
    await expect(cancelledResult).resolves.toMatchObject({ message: 'caller went away' });

    release?.();
    const snapshot = await service.getHeritage(ctx());
    expect(snapshot.records).toHaveLength(WHC_ROWS.length);
    expect(hub.callsFor('whc001', 'export')).toHaveLength(1);
  });

  it('rejects an already-aborted caller immediately with the signal reason', async () => {
    const { service } = makeService();
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    await expect(
      service.getHeritage(createMockContext({ signal: controller.signal })),
    ).rejects.toThrow('already gone');
    await expect(service.getHeritage(ctx())).resolves.toBeDefined();
  });
});

describe('TTL and stale-while-revalidate', () => {
  const TTL = 10_000;

  it('serves a fresh snapshot without refreshing inside the TTL', async () => {
    const { hub, service } = makeService({}, TTL);
    await service.getHeritage(ctx());
    clock += TTL - 1;
    await service.getHeritage(ctx());
    expect(hub.callsFor('whc001', 'export')).toHaveLength(1);
  });

  it('serves the expired snapshot at once and refreshes once in the background', async () => {
    const metas: NonNullable<HubOptions['metas']> = {};
    const { hub, service } = makeService({ metas }, TTL);
    const first = await service.getHeritage(ctx());
    clock += TTL;
    metas.whc001 = { data_processed: '2027-01-01T00:00:00+00:00' };

    const stale = await service.getHeritage(ctx());
    expect(stale).toBe(first);
    await service.getHeritage(ctx());
    await service.getHeritage(ctx());
    await vi.waitFor(async () => {
      expect((await service.getHeritage(ctx())).asOf).toBe('2027-01-01T00:00:00+00:00');
    });
    expect(hub.callsFor('whc001', 'export')).toHaveLength(2);
    expect((await service.getHeritage(ctx())).loadedAt).toBe(clock);
  });

  it('keeps serving the previous snapshot and logs a warning when a refresh fails', async () => {
    const warning = vi.spyOn(logger, 'warning');
    let failing = false;
    const { service } = makeService(
      { intercept: () => (failing ? httpFailure(404) : undefined) },
      TTL,
    );
    const first = await service.getHeritage(ctx());
    failing = true;
    clock += TTL;
    expect(await service.getHeritage(ctx())).toBe(first);
    await vi.waitFor(() =>
      expect(
        warning.mock.calls.some((c) => String(c[0]).includes('serving the previous snapshot')),
      ).toBe(true),
    );
    expect(await service.getHeritage(ctx())).toBe(first);
  });

  it('waits out an exponential backoff between failed refreshes, then recovers', async () => {
    let failing = false;
    const { hub, service } = makeService(
      { intercept: () => (failing ? httpFailure(404) : undefined) },
      TTL,
    );
    const first = await service.getHeritage(ctx());
    const refreshes = () => hub.callsFor('whc001', 'meta').length - 1;
    const attempt = async () => {
      await service.getHeritage(ctx());
      await vi.waitFor(() => expect(refreshes()).toBeGreaterThanOrEqual(0));
      await new Promise((resolve) => setTimeout(resolve, 5));
    };

    failing = true;
    clock += TTL;
    await attempt();
    expect(refreshes()).toBe(1);

    clock += 59_999;
    await attempt();
    expect(refreshes()).toBe(1);

    clock += 1;
    await attempt();
    expect(refreshes()).toBe(2);

    clock += 119_999;
    await attempt();
    expect(refreshes()).toBe(2);

    failing = false;
    clock += 1;
    await attempt();
    await vi.waitFor(async () => {
      expect(await service.getHeritage(ctx())).not.toBe(first);
    });
    expect(refreshes()).toBe(3);
  });
});

describe('first-load failures', () => {
  it('throws ServiceUnavailable with reason, dataset, retryAfter, and the cause', async () => {
    const { service } = makeService({ intercept: () => httpFailure(404) });
    const error = await service.getHeritage(ctx()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    const mcp = error as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(mcp.data).toMatchObject({
      reason: 'snapshot_unavailable',
      dataset: 'whc001',
      retryAfter: 60,
    });
    expect(mcp.message).toContain('World Heritage List');
    expect(mcp.cause).toBeInstanceOf(McpError);
    expect((mcp.cause as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('fails fast without re-fetching until the backoff elapses, with a shrinking retryAfter', async () => {
    const { hub, service } = makeService({ intercept: () => httpFailure(404) });
    await service.getHeritage(ctx()).catch(() => undefined);
    const afterFirst = hub.calls.length;

    clock += 20_000;
    const early = (await service.getHeritage(ctx()).catch((e: unknown) => e)) as McpError;
    expect(early.data).toMatchObject({ reason: 'snapshot_unavailable', retryAfter: 40 });
    expect(hub.calls).toHaveLength(afterFirst);

    clock += 40_000;
    const second = (await service.getHeritage(ctx()).catch((e: unknown) => e)) as McpError;
    expect(hub.calls.length).toBeGreaterThan(afterFirst);
    expect(second.data).toMatchObject({ retryAfter: 120 });
  });

  it('doubles the wait per failure up to one hour', async () => {
    const { service } = makeService({ intercept: () => httpFailure(404) });
    const waits: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const error = (await service.getHeritage(ctx()).catch((e: unknown) => e)) as McpError;
      const retryAfter = (error.data as { retryAfter: number }).retryAfter;
      waits.push(retryAfter);
      clock += retryAfter * 1000;
    }
    expect(waits).toEqual([60, 120, 240, 480, 960, 1920, 3600, 3600, 3600]);
  });

  it('recovers on the first success after failures and resets the backoff', async () => {
    let failing = true;
    const { service } = makeService({ intercept: () => (failing ? httpFailure(404) : undefined) });
    await service.getHeritage(ctx()).catch(() => undefined);
    clock += 60_000;
    failing = false;
    await expect(service.getHeritage(ctx())).resolves.toMatchObject({ dataset: 'whc001' });
  });

  it('never lets one dataset outage block another dataset', async () => {
    const { service } = makeService({
      intercept: (call) => (call.dataset === 'whc001' ? httpFailure(404) : undefined),
    });
    await expect(service.getHeritage(ctx())).rejects.toMatchObject({
      data: { reason: 'snapshot_unavailable', dataset: 'whc001' },
    });
    await expect(service.getIntangible(ctx())).resolves.toMatchObject({ dataset: 'ich001' });
    await expect(service.getBiosphere(ctx())).resolves.toMatchObject({ dataset: 'mab001' });
  });

  it('shares one failure between concurrent first callers', async () => {
    const { hub, service } = makeService({ intercept: () => httpFailure(404) });
    const results = await Promise.allSettled([
      service.getHeritage(ctx()),
      service.getHeritage(ctx()),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(hub.callsFor('whc001', 'meta')).toHaveLength(1);
  });
});

describe('strict validation and integrity checks', () => {
  it('fails the load on one invalid row, non-retryably, naming the row and field', async () => {
    const rows = [...WHC_ROWS];
    rows[1] = whcRow({ id_no: '102', category: 'Hybrid' });
    const { hub, service } = makeService({ rows: { whc001: rows } });
    const error = (await service.getHeritage(ctx()).catch((e: unknown) => e)) as McpError;
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'whc001' });
    const cause = error.cause as McpError;
    expect(cause.message).toContain('row 1 failed validation');
    expect(cause.message).toContain('category');
    expect(cause.data).toMatchObject({ rowIndex: 1, retryable: false });
    expect(hub.callsFor('whc001', 'export')).toHaveLength(1);
  });

  it('fails the load when the export carries fields outside the allowlist (an ignored select)', async () => {
    const rows = WHC_ROWS.map((r) => ({ ...r, uuid: '00000000-0000-0000-0000-000000000000' }));
    const { service } = makeService({ rows: { whc001: rows } });
    const error = (await service.getHeritage(ctx()).catch((e: unknown) => e)) as McpError;
    expect((error.cause as McpError).message).toContain('row 0 failed validation');
  });

  it('fails the load when a row mapper throws, non-retryably', async () => {
    const rows = [{ ...MAB_ROWS[0], regional_group: 'Atlantis' }, ...MAB_ROWS.slice(1)];
    const { hub, service } = makeService({ rows: { mab001: rows } });
    const error = (await service.getBiosphere(ctx()).catch((e: unknown) => e)) as McpError;
    expect((error.cause as McpError).message).toContain('could not be mapped');
    expect(hub.callsFor('mab001', 'export')).toHaveLength(1);
  });

  it('fails the load on a duplicate record id', async () => {
    const rows = [...ICH_ROWS, ICH_ROWS[0]];
    const { service } = makeService({ rows: { ich001: rows } });
    const error = (await service.getIntangible(ctx()).catch((e: unknown) => e)) as McpError;
    expect((error.cause as McpError).message).toContain('duplicate record id 1001');
  });

  it('treats reserve ids that fold to the same key as duplicates', async () => {
    const rows = [MAB_ROWS[0], { ...MAB_ROWS[0], mab_id: 'FRALDER1998' }];
    const { service } = makeService({ rows: { mab001: rows } });
    await expect(service.getBiosphere(ctx())).rejects.toMatchObject({
      data: { reason: 'snapshot_unavailable', dataset: 'mab001' },
    });
  });

  it('keeps the previous snapshot when a refresh brings an invalid row', async () => {
    const TTL = 5_000;
    const hubOptions: HubOptions = {};
    const { service } = makeService(hubOptions, TTL);
    const first = await service.getHeritage(ctx());
    clock += TTL;
    hubOptions.rows = { whc001: [whcRow({ id_no: 'x' })] };
    const warning = vi.spyOn(logger, 'warning');
    expect(await service.getHeritage(ctx())).toBe(first);
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(await service.getHeritage(ctx())).toBe(first);
  });

  it('logs the unparsed-component count once per load', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const { service } = makeService();
    await service.getHeritage(ctx());
    const componentWarnings = warning.mock.calls.filter((c) => String(c[0]).startsWith('whc001:'));
    expect(componentWarnings).toHaveLength(1);
    expect(String(componentWarnings[0]?.[0])).toContain('1 component entries could not be parsed');
    expect(componentWarnings[0]?.[1]).toMatchObject({
      extra: { unparsedComponents: 1, componentCountMismatchSites: [] },
    });
  });

  it('names a site whose component count disagrees with the parsed parts, without failing the load', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const rows = [whcRow({ id_no: '777', components_count: 9 })];
    const { service } = makeService({ rows: { whc001: rows } });
    const snapshot = await service.getHeritage(ctx());
    expect(snapshot.byId.get('777')?.components_total).toBe(9);
    expect(warning.mock.calls.at(-1)?.[1]).toMatchObject({
      extra: { componentCountMismatchSites: ['777'] },
    });
  });

  it('does not warn when every component entry parses and counts agree', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const { service } = makeService({ rows: { whc001: [whcRow()] } });
    await service.getHeritage(ctx());
    expect(warning).not.toHaveBeenCalled();
  });
});

describe('body budgets and text bounds', () => {
  const MiB = 1_048_576;

  /**
   * A JSON document followed by `padMiB` MiB of whitespace, streamed one MiB
   * per pull. Valid JSON whatever its length, so only a budget can refuse it.
   */
  function paddedBody(document: unknown, padMiB: number) {
    const head = new TextEncoder().encode(JSON.stringify(document));
    const pad = new Uint8Array(MiB).fill(0x20);
    const stream = { pulls: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (stream.pulls > padMiB) controller.close();
        else controller.enqueue(stream.pulls === 0 ? head : pad);
        stream.pulls += 1;
      },
      cancel() {
        stream.cancelled = true;
      },
    });
    return {
      stream,
      response: new Response(body, { headers: { 'content-type': 'application/json' } }),
    };
  }

  it('fails the first load when the export exceeds its 64 MiB budget, without retrying, and stops reading', async () => {
    const padded = paddedBody(WHC_ROWS, 80);
    const { hub, service } = makeService({
      intercept: (call) => (call.kind === 'export' ? padded.response : undefined),
    });
    const error = (await service.getHeritage(ctx()).catch((e: unknown) => e)) as McpError;
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'whc001' });
    const cause = error.cause as McpError;
    expect(cause.message).toContain('64 MiB');
    expect(cause.data).toMatchObject({ dataset: 'whc001', retryable: false });
    expect(hub.callsFor('whc001', 'export')).toHaveLength(1);
    expect(padded.stream.pulls).toBeLessThan(70);
    expect(padded.stream.cancelled).toBe(true);
  });

  it('holds the intangible and biosphere exports to 16 MiB and the World Heritage export to 64 MiB', async () => {
    const { service } = makeService({
      intercept: (call) => {
        if (call.kind !== 'export') return;
        const rows = { whc001: WHC_ROWS, ich001: ICH_ROWS, mab001: MAB_ROWS }[call.dataset];
        return paddedBody(rows, 17).response;
      },
    });
    await expect(service.getHeritage(ctx())).resolves.toMatchObject({ dataset: 'whc001' });
    for (const load of [service.getIntangible(ctx()), service.getBiosphere(ctx())]) {
      const error = (await load.catch((e: unknown) => e)) as McpError;
      expect(error.data).toMatchObject({ reason: 'snapshot_unavailable' });
      expect((error.cause as McpError).message).toContain('16 MiB');
    }
  });

  it('fails the load when the metadata document exceeds 1 MiB, before fetching the export', async () => {
    const { hub, service } = makeService({
      intercept: (call) =>
        call.kind === 'meta' ? paddedBody(metaDocument('whc001'), 2).response : undefined,
    });
    const error = (await service.getHeritage(ctx()).catch((e: unknown) => e)) as McpError;
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'whc001' });
    expect((error.cause as McpError).message).toContain('1 MiB');
    expect(hub.callsFor('whc001', 'meta')).toHaveLength(1);
    expect(hub.callsFor('whc001', 'export')).toHaveLength(0);
  });

  it('keeps the previous snapshot and logs a warning when a refresh brings an over-budget export', async () => {
    const TTL = 5_000;
    let oversized = false;
    const { service } = makeService(
      {
        intercept: (call) =>
          oversized && call.kind === 'export' ? paddedBody(WHC_ROWS, 65).response : undefined,
      },
      TTL,
    );
    const first = await service.getHeritage(ctx());
    const warning = vi.spyOn(logger, 'warning');
    oversized = true;
    clock += TTL;
    expect(await service.getHeritage(ctx())).toBe(first);
    await vi.waitFor(() =>
      expect(
        warning.mock.calls.some(
          (c) =>
            String(c[0]).includes('serving the previous snapshot') &&
            String(c[0]).includes('64 MiB'),
        ),
      ).toBe(true),
    );
    expect(await service.getHeritage(ctx())).toBe(first);
  });

  it('fails the load on a field over its length bound, and keeps the previous snapshot on refresh', async () => {
    const TTL = 5_000;
    const overLong = {
      mab001: [MAB_ROWS[0], { ...MAB_ROWS[1], introduction_en: 'a'.repeat(65_537) }],
    };
    const failing = makeService({ rows: overLong });
    const error = (await failing.service.getBiosphere(ctx()).catch((e: unknown) => e)) as McpError;
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'mab001' });
    expect((error.cause as McpError).message).toContain('row 1 failed validation');
    expect((error.cause as McpError).message).toContain('introduction_en');

    const refreshing: HubOptions = {};
    const { service } = makeService(refreshing, TTL);
    const first = await service.getBiosphere(ctx());
    refreshing.rows = overLong;
    clock += TTL;
    const warning = vi.spyOn(logger, 'warning');
    expect(await service.getBiosphere(ctx())).toBe(first);
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(await service.getBiosphere(ctx())).toBe(first);
  });
});

describe('license check', () => {
  it('refuses a changed license without fetching the export, and logs at error level', async () => {
    const error = vi.spyOn(logger, 'error');
    const { hub, service } = makeService({ metas: { whc001: { license: 'CC BY 4.0' } } });
    const thrown = (await service.getHeritage(ctx()).catch((e: unknown) => e)) as McpError;
    expect(thrown.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'whc001' });
    expect((thrown.cause as McpError).data).toMatchObject({
      licenseChanged: true,
      license: 'CC BY 4.0',
    });
    expect(hub.callsFor('whc001', 'export')).toHaveLength(0);
    expect(hub.callsFor('whc001', 'meta')).toHaveLength(1);
    expect(error).toHaveBeenCalled();
  });

  it('keeps the previous snapshot on a refresh with a changed license, at error severity', async () => {
    const TTL = 5_000;
    const metas: NonNullable<HubOptions['metas']> = {};
    const { service } = makeService({ metas }, TTL);
    const first = await service.getHeritage(ctx());
    const error = vi.spyOn(logger, 'error');
    const warning = vi.spyOn(logger, 'warning');
    clock += TTL;
    metas.whc001 = { license: 'Proprietary' };
    expect(await service.getHeritage(ctx())).toBe(first);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(warning).not.toHaveBeenCalled();
    expect(await service.getHeritage(ctx())).toBe(first);
  });
});

describe('upstream failure classes (retry ladder under fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
  });

  it('retries a 5xx up to three attempts, then reports snapshot_unavailable', async () => {
    const { hub, service } = makeService({ intercept: () => httpFailure(503) });
    const error = await rejectionOf(service.getHeritage(ctx()));
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'whc001' });
    expect(hub.callsFor('whc001', 'meta')).toHaveLength(3);
    expect(hub.callsFor('whc001', 'export')).toHaveLength(0);
    expect((error.cause as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('recovers when a later attempt succeeds', async () => {
    let calls = 0;
    const { hub, service } = makeService({
      intercept: (call) => (call.kind === 'meta' && calls++ < 2 ? httpFailure(502) : undefined),
    });
    const settled = service.getHeritage(ctx());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(settled).resolves.toMatchObject({ dataset: 'whc001' });
    expect(hub.callsFor('whc001', 'meta')).toHaveLength(3);
    expect(hub.callsFor('whc001', 'export')).toHaveLength(1);
  });

  it('does not retry a 404', async () => {
    const { hub, service } = makeService({ intercept: () => httpFailure(404) });
    const error = await rejectionOf(service.getHeritage(ctx()), 100);
    expect(hub.calls).toHaveLength(1);
    expect((error.cause as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('does not retry a 400 (client error)', async () => {
    const { hub, service } = makeService({ intercept: () => httpFailure(400) });
    const error = await rejectionOf(service.getHeritage(ctx()), 100);
    expect(hub.calls).toHaveLength(1);
    expect((error.cause as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('fails fast on a rate limit whose Retry-After exceeds the retry budget', async () => {
    const { hub, service } = makeService({
      intercept: () => httpFailure(429, { 'retry-after': '3600' }),
    });
    const error = await rejectionOf(service.getHeritage(ctx()), 100);
    expect(hub.calls).toHaveLength(1);
    expect((error.cause as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', retryAfter: 3600 });
  });

  it('holds every dataset behind the rate-limit cooldown, past the 60 s backoff', async () => {
    const { hub, service } = makeService({
      intercept: (call) =>
        call.dataset === 'whc001' ? httpFailure(429, { 'retry-after': '3600' }) : undefined,
    });
    await rejectionOf(service.getHeritage(ctx()), 100);

    clock += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    const held = (await service.getHeritage(ctx()).catch((e: unknown) => e)) as McpError;
    expect(held.data).toMatchObject({ reason: 'snapshot_unavailable', retryAfter: 3540 });
    expect(hub.calls).toHaveLength(1);

    const other = await rejectionOf(service.getIntangible(ctx()), 100);
    expect(other.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'ich001' });
    expect((other.data as { retryAfter: number }).retryAfter).toBeGreaterThanOrEqual(3539);
    expect(hub.callsFor('ich001')).toHaveLength(0);
  });

  it('retries a malformed (non-JSON) 200 body as a transient failure', async () => {
    const { hub, service } = makeService({
      intercept: (call) =>
        call.kind === 'export'
          ? new Response('<html>Service temporarily unavailable</html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            })
          : undefined,
    });
    const error = await rejectionOf(service.getHeritage(ctx()));
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable' });
    expect(hub.callsFor('whc001', 'export')).toHaveLength(3);
    expect(hub.callsFor('whc001', 'meta')).toHaveLength(3);
  });

  it('retries a metadata document of the wrong shape', async () => {
    const { hub, service } = makeService({
      intercept: (call) => (call.kind === 'meta' ? Response.json({ unexpected: true }) : undefined),
    });
    const error = await rejectionOf(service.getHeritage(ctx()));
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable' });
    expect(hub.callsFor('whc001', 'meta')).toHaveLength(3);
    expect(hub.callsFor('whc001', 'export')).toHaveLength(0);
  });

  it('fails when the export is JSON but not an array', async () => {
    const { hub, service } = makeService({ rows: { whc001: { results: [] } as unknown } });
    const settled = service.getHeritage(ctx()).then(
      () => undefined,
      (e: unknown) => e as McpError,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const error = (await settled) as McpError;
    expect((error.cause as McpError).message).toContain('not a JSON array');
    expect(hub.callsFor('whc001', 'export')).toHaveLength(3);
  });

  it('retries a timeout', async () => {
    const { hub, service } = makeService({
      intercept: () => {
        throw new McpError(JsonRpcErrorCode.Timeout, 'The request timed out.');
      },
    });
    const error = await rejectionOf(service.getHeritage(ctx()));
    expect(hub.callsFor('whc001', 'meta')).toHaveLength(3);
    expect((error.cause as McpError).code).toBe(JsonRpcErrorCode.Timeout);
  });

  it('retries a network-level failure', async () => {
    const { hub, service } = makeService({
      intercept: () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = await rejectionOf(service.getHeritage(ctx()));
    expect(hub.callsFor('whc001', 'meta')).toHaveLength(3);
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable' });
  });

  it('re-fetches both documents when the export row count disagrees with the metadata, then succeeds', async () => {
    let metaCalls = 0;
    const { hub, service } = makeService({
      intercept: (call) =>
        call.kind === 'meta' && metaCalls++ === 0
          ? Response.json(metaDocument('whc001', { records_count: WHC_ROWS.length + 5 }))
          : undefined,
    });
    const settled = service.getHeritage(ctx());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(settled).resolves.toMatchObject({ recordsCount: WHC_ROWS.length });
    expect(hub.calls.map((c) => c.kind)).toEqual(['meta', 'export', 'meta', 'export']);
  });

  it('gives up after the retries when the count keeps disagreeing', async () => {
    const { hub, service } = makeService({ metas: { whc001: { records_count: 3 } } });
    const error = await rejectionOf(service.getHeritage(ctx()));
    expect((error.cause as McpError).message).toMatch(
      /exported \d+ rows but its metadata reports 3/,
    );
    expect(hub.callsFor('whc001', 'export')).toHaveLength(3);
  });

  it('stops at the total deadline when an attempt hangs', async () => {
    const service = new UnescoDataHubService({
      get: (_url, _timeoutMs, _context, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
      now: () => clock,
    });
    services.push(service);
    const error = await rejectionOf(service.getHeritage(ctx()), 60_000);
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'whc001' });
    expect((error.cause as McpError).data).toMatchObject({ reason: 'retry_deadline_exceeded' });
  });
});

describe('dispose and the accessor', () => {
  it('dispose is safe to call after use and more than once', async () => {
    const { service } = makeService();
    await service.getHeritage(ctx());
    expect(() => {
      service.dispose();
      service.dispose();
    }).not.toThrow();
  });

  it('getUnescoDataHubService throws before init and returns the instance after', async () => {
    vi.resetModules();
    const fresh = await import('@/services/unesco-datahub/unesco-datahub-service.js');
    expect(() => fresh.getUnescoDataHubService()).toThrow(/not initialized/);
    const hub = createHub();
    fresh.initUnescoDataHubService({ get: hub.get });
    const service = fresh.getUnescoDataHubService();
    expect(service).toBeInstanceOf(fresh.UnescoDataHubService);
    service.dispose();
  });

  it('initUnescoDataHubService replaces the instance', () => {
    const hub = createHub();
    initUnescoDataHubService({ get: hub.get });
    const first = getUnescoDataHubService();
    initUnescoDataHubService({ get: hub.get });
    const second = getUnescoDataHubService();
    expect(second).not.toBe(first);
    first.dispose();
    second.dispose();
  });
});
