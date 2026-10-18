/**
 * @fileoverview Tests for the snapshot lifecycle of UnescoDataHubService,
 * driven through its `get` and `now` seams: lazy load, request allowlist and
 * its intersection with the metadata `fields`, single-flight, TTL with
 * stale-while-revalidate, failure backoff, strict row validation, the
 * row-count retry, the body budgets and text bounds, the license check, and
 * upstream failure classes (retryable transport failures; non-retryable
 * rejections and unusable exports).
 * @module tests/services/unesco-datahub/unesco-datahub-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EG_FIELDS, ICH_FIELDS, MAB_FIELDS, WHC_FIELDS } from '@/services/unesco-datahub/rows.js';
import {
  getUnescoDataHubService,
  initUnescoDataHubService,
  sourceOf,
  UnescoDataHubService,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import type { DatasetId } from '@/services/unesco-datahub/vocabulary.js';
import { rejectionFrom } from '../../fixtures/failures.js';
import {
  BASE_URL,
  createHub,
  DATA_AS_OF,
  DEFAULT_FIELDS,
  type FakeHub,
  fieldsWithout,
  type HubOptions,
  httpFailure,
  metaDocument,
  transientFailure,
  withoutKeys,
} from '../../fixtures/hub.js';
import {
  EG_ROWS,
  egRow,
  ICH_ROWS,
  MAB_ROWS,
  mabRow,
  WHC_ROWS,
  whcRow,
} from '../../fixtures/rows.js';

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

/** Loads one dataset's snapshot through its public getter. */
function load(service: UnescoDataHubService, dataset: DatasetId): Promise<unknown> {
  const getters = {
    whc001: () => service.getHeritage(ctx()),
    ich001: () => service.getIntangible(ctx()),
    mab001: () => service.getBiosphere(ctx()),
    eg0001: () => service.getGeoparks(ctx()),
  };
  return getters[dataset]();
}

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
  it('throws ServiceUnavailable with reason, retryable, dataset, retryAfter, and the cause', async () => {
    const { service } = makeService({ intercept: () => transientFailure() });
    const mcp = await rejectionFrom(service.getHeritage(ctx()));
    expect(mcp.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(mcp.data).toEqual({
      reason: 'snapshot_unavailable',
      retryable: true,
      dataset: 'whc001',
      retryAfter: 60,
    });
    expect(mcp.message).toBe(
      'The UNESCO Data Hub could not be reached to load the World Heritage List (whc001); the next load attempt is allowed in 60 s.',
    );
    expect(mcp.cause).toBeInstanceOf(McpError);
    expect((mcp.cause as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('fails fast without re-fetching until the backoff elapses, with a shrinking retryAfter', async () => {
    const { hub, service } = makeService({ intercept: () => transientFailure() });
    await rejectionFrom(service.getHeritage(ctx()));
    const afterFirst = hub.calls.length;

    clock += 20_000;
    const early = await rejectionFrom(service.getHeritage(ctx()));
    expect(early.data).toMatchObject({ reason: 'snapshot_unavailable', retryAfter: 40 });
    expect(hub.calls).toHaveLength(afterFirst);

    clock += 40_000;
    const second = await rejectionFrom(service.getHeritage(ctx()));
    expect(hub.calls.length).toBeGreaterThan(afterFirst);
    expect(second.data).toMatchObject({ retryAfter: 120 });
  });

  it('doubles the wait per failure up to one hour', async () => {
    const { service } = makeService({ intercept: () => transientFailure() });
    const waits: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const error = await rejectionFrom(service.getHeritage(ctx()));
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

const TITLES: Readonly<Record<DatasetId, string>> = {
  whc001: 'World Heritage List',
  ich001: 'Intangible Heritage List',
  mab001: 'Man and the Biosphere Programme',
  eg0001: 'UNESCO Global Geoparks',
};

/**
 * Asserts the non-retryable `snapshot_unavailable` envelope: no `retryAfter`,
 * a message that names the dataset without "could not be reached", and the
 * service's own recovery, which does not say to wait.
 */
function expectRejectedLoad(error: McpError, dataset: DatasetId): void {
  expect(error).toBeInstanceOf(McpError);
  expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', retryable: false, dataset });
  expect(error.data).not.toHaveProperty('retryAfter');
  expect(
    error.message.startsWith(
      `The ${TITLES[dataset]} (${dataset}) could not be loaded from the UNESCO Data Hub: `,
    ),
  ).toBe(true);
  expect(error.message).not.toContain('could not be reached');
  const hint = (error.data as { recovery?: { hint?: unknown } }).recovery?.hint;
  expect(hint).toEqual(expect.any(String));
  expect(hint).toContain(TITLES[dataset]);
  expect(hint).not.toMatch(/\bwait\b/i);
}

/** The whole message of a non-retryable `snapshot_unavailable`, ending in `detail`. */
const rejectedMessage = (dataset: DatasetId, detail: string) =>
  `The ${TITLES[dataset]} (${dataset}) could not be loaded from the UNESCO Data Hub: ${detail}.`;

const CHECKS_FAILED = "the data failed one of this server's checks (license, size, or row format)";

describe('first-load failure classes', () => {
  it.each<[string, DatasetId, HubOptions, string]>([
    ['a 400', 'mab001', { intercept: () => httpFailure(400) }, 'the Data Hub answered HTTP 400'],
    ['a 403', 'whc001', { intercept: () => httpFailure(403) }, 'the Data Hub answered HTTP 403'],
    [
      'a 404 on the export',
      'whc001',
      { intercept: (call) => (call.kind === 'export' ? httpFailure(404) : undefined) },
      'the Data Hub answered HTTP 404',
    ],
    ['a 410', 'ich001', { intercept: () => httpFailure(410) }, 'the Data Hub answered HTTP 410'],
    ['a 422', 'eg0001', { intercept: () => httpFailure(422) }, 'the Data Hub answered HTTP 422'],
    ['a 501', 'whc001', { intercept: () => httpFailure(501) }, 'the Data Hub answered HTTP 501'],
    [
      'a row that fails its schema',
      'whc001',
      { rows: { whc001: [whcRow({ category: 'Hybrid' })] } },
      CHECKS_FAILED,
    ],
    [
      'a row its mapper refuses',
      'mab001',
      { rows: { mab001: [mabRow({ regional_group: 'Atlantis' })] } },
      CHECKS_FAILED,
    ],
    [
      'a duplicate record id',
      'ich001',
      { rows: { ich001: [...ICH_ROWS, ICH_ROWS[0]] } },
      CHECKS_FAILED,
    ],
    [
      'a changed license',
      'eg0001',
      { metas: { eg0001: { license: 'Proprietary Terms' } } },
      CHECKS_FAILED,
    ],
    [
      'metadata that no longer lists a required field',
      'whc001',
      { fields: { whc001: fieldsWithout('whc001', ['name_en']) } },
      'the dataset no longer has the field name_en this server requires',
    ],
  ])(
    'reports %s as non-retryable, naming what failed without upstream text',
    async (_label, dataset, hubOptions, detail) => {
      const { hub, service } = makeService(hubOptions);
      const error = await rejectionFrom(load(service, dataset));
      expectRejectedLoad(error, dataset);
      expect(error.message).toBe(rejectedMessage(dataset, detail));
      expect(error.cause).toBeInstanceOf(McpError);
      expect(hub.callsFor(dataset, 'meta')).toHaveLength(1);
    },
  );

  describe('transport failures (retry ladder under fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
    });

    it.each<[string, NonNullable<HubOptions['intercept']>]>([
      [
        'a network error',
        () => {
          throw new TypeError('fetch failed');
        },
      ],
      [
        'a timeout',
        () => {
          throw new McpError(JsonRpcErrorCode.Timeout, 'The request timed out.');
        },
      ],
      ...[408, 425, 429, 500, 502, 503, 504].map(
        (status): [string, NonNullable<HubOptions['intercept']>] => [
          `a ${status}`,
          () => httpFailure(status),
        ],
      ),
      ['a 503 with a long Retry-After', () => transientFailure()],
      [
        'a non-JSON 200',
        (call) => (call.kind === 'export' ? new Response('<html>busy</html>') : undefined),
      ],
      [
        'metadata of the wrong shape',
        (call) => (call.kind === 'meta' ? Response.json({ nope: true }) : undefined),
      ],
      [
        'metadata with no fields list',
        (call) =>
          call.kind === 'meta'
            ? Response.json({ ...(metaDocument('whc001') as object), fields: undefined })
            : undefined,
      ],
    ])(
      'keeps %s retryable, with retryAfter and the unreachable message',
      async (_label, intercept) => {
        const { service } = makeService({ intercept });
        const error = await rejectionOf(service.getHeritage(ctx()), 60_000);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toEqual({
          reason: 'snapshot_unavailable',
          retryable: true,
          dataset: 'whc001',
          retryAfter: expect.any(Number),
        });
        expect(error.message).toMatch(
          /^The UNESCO Data Hub could not be reached to load the World Heritage List \(whc001\); the next load attempt is allowed in \d+ s\.$/,
        );
      },
    );
  });

  it('keeps the reload backoff for a rejected load, then recovers once the Data Hub accepts the request', async () => {
    let rejecting = true;
    const { hub, service } = makeService({
      intercept: () => (rejecting ? httpFailure(404) : undefined),
    });
    const metaCalls = () => hub.callsFor('whc001', 'meta').length;
    const rejected = async () =>
      expectRejectedLoad(await rejectionFrom(service.getHeritage(ctx())), 'whc001');

    await rejected();
    expect(metaCalls()).toBe(1);
    clock += 59_999;
    await rejected();
    expect(metaCalls()).toBe(1);
    clock += 1;
    await rejected();
    expect(metaCalls()).toBe(2);
    clock += 119_999;
    await rejected();
    expect(metaCalls()).toBe(2);

    rejecting = false;
    clock += 1;
    await expect(service.getHeritage(ctx())).resolves.toMatchObject({ dataset: 'whc001' });
    expect(metaCalls()).toBe(3);
  });
});

describe('metadata fields and the export select', () => {
  const selectOf = (hub: FakeHub, dataset: DatasetId) =>
    new URL(hub.callsFor(dataset, 'export')[0]?.url ?? '').searchParams.get('select')?.split(',');
  const warningsNaming = (warning: { mock: { calls: unknown[][] } }, field: string) =>
    warning.mock.calls.filter((c) => String(c[0]).includes(field));

  it.each<[string, (fields: readonly string[]) => readonly string[]]>([
    ['in allowlist order', (fields) => fields],
    ['in reverse order', (fields) => [...fields].reverse()],
  ])(
    'selects every allowlisted field the metadata lists, in allowlist order and no other, from metadata %s',
    async (_label, order) => {
      const warning = vi.spyOn(logger, 'warning');
      const { hub, service } = makeService({
        fields: {
          whc001: order(DEFAULT_FIELDS.whc001),
          ich001: order(DEFAULT_FIELDS.ich001),
          mab001: order(DEFAULT_FIELDS.mab001),
          eg0001: order(DEFAULT_FIELDS.eg0001),
        },
      });
      await Promise.all([
        service.getHeritage(ctx()),
        service.getIntangible(ctx()),
        service.getBiosphere(ctx()),
        service.getGeoparks(ctx()),
      ]);
      expect(selectOf(hub, 'whc001')).toEqual([...WHC_FIELDS]);
      expect(selectOf(hub, 'ich001')).toEqual([...ICH_FIELDS]);
      expect(selectOf(hub, 'mab001')).toEqual([...MAB_FIELDS]);
      expect(selectOf(hub, 'eg0001')).toEqual([...EG_FIELDS]);
      expect(warningsNaming(warning, 'no longer lists')).toHaveLength(0);
      expect(hub.calls).toHaveLength(8);
    },
  );

  it.each<['mab001' | 'eg0001', readonly string[]]>([
    ['mab001', MAB_FIELDS],
    ['eg0001', EG_FIELDS],
  ])(
    '%s leaves out a dropped website, reads it as absent, and logs one warning naming it',
    async (dataset, fields) => {
      const warning = vi.spyOn(logger, 'warning');
      const rows = dataset === 'mab001' ? MAB_ROWS : EG_ROWS;
      const { hub, service } = makeService({
        fields: { [dataset]: fieldsWithout(dataset, ['website']) },
        rows: { [dataset]: withoutKeys(rows, ['website']) },
      });
      const snapshot = (await load(service, dataset)) as { records: object[] };
      expect(selectOf(hub, dataset)).toEqual(fields.filter((f) => f !== 'website'));
      expect(snapshot.records).toHaveLength(rows.length);
      for (const record of snapshot.records) expect(record).not.toHaveProperty('website');
      const named = warningsNaming(warning, 'website');
      expect(named).toHaveLength(1);
      expect(String(named[0]?.[0])).toContain(dataset);
      expect(named[0]?.[1]).toMatchObject({ extra: { omittedFields: ['website'] } });
    },
  );

  it('serves no site image without a credit field, and serves them again when the field returns', async () => {
    const TTL = 5_000;
    const hubOptions: HubOptions = {
      fields: { whc001: fieldsWithout('whc001', ['main_image_author']) },
      rows: { whc001: withoutKeys(WHC_ROWS, ['main_image_author']) },
    };
    const { hub, service } = makeService(hubOptions, TTL);
    const snapshot = await service.getHeritage(ctx());
    expect(selectOf(hub, 'whc001')).not.toContain('main_image_author');
    expect(selectOf(hub, 'whc001')).toContain('main_image_copyright');
    expect(snapshot.records).toHaveLength(WHC_ROWS.length);
    for (const site of snapshot.records) expect(site).not.toHaveProperty('image');

    hubOptions.fields = {};
    hubOptions.rows = {};
    clock += TTL;
    expect(await service.getHeritage(ctx())).toBe(snapshot);
    await vi.waitFor(async () =>
      expect((await service.getHeritage(ctx())).byId.get('101')?.image).toMatchObject({
        author: expect.any(String),
      }),
    );
    expect(hub.callsFor('whc001', 'export')).toHaveLength(2);
  });

  it('loads the intangible list without images when its caption and credit fields are dropped', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const dropped = ['main_image_caption_en', 'main_image_copyright', 'main_image_author'];
    const { hub, service } = makeService({
      fields: { ich001: fieldsWithout('ich001', dropped) },
      rows: { ich001: withoutKeys(ICH_ROWS, dropped) },
    });
    const snapshot = await service.getIntangible(ctx());
    expect(selectOf(hub, 'ich001')).toEqual(ICH_FIELDS.filter((f) => !dropped.includes(f)));
    expect(snapshot.records).toHaveLength(ICH_ROWS.length);
    for (const element of snapshot.records) expect(element).not.toHaveProperty('image');
    const named = warningsNaming(warning, 'main_image_caption_en');
    expect(named).toHaveLength(1);
    expect(named[0]?.[1]).toMatchObject({ extra: { omittedFields: dropped } });
  });

  it('serves credited, uncaptioned images when only the caption field is dropped', async () => {
    const full = (await makeService().service.getIntangible(ctx())).byId.get('1001')?.image;
    expect(full).toHaveProperty('caption');
    const { service } = makeService({
      fields: { ich001: fieldsWithout('ich001', ['main_image_caption_en']) },
      rows: { ich001: withoutKeys(ICH_ROWS, ['main_image_caption_en']) },
    });
    const { caption: _caption, ...uncaptioned } = full ?? {};
    expect((await service.getIntangible(ctx())).byId.get('1001')?.image).toEqual(uncaptioned);
  });

  it('loads the sites with every translation unpublished when the metadata drops the translation columns', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const dropped = [
      'short_description_fr',
      'short_description_es',
      'short_description_ru',
      'short_description_ar',
      'short_description_zh',
    ];
    const full = (await makeService().service.getHeritage(ctx())).byId.get('101');
    expect(Object.keys(full?.description_translations ?? {})).toEqual([
      'fr',
      'es',
      'ru',
      'ar',
      'zh',
    ]);

    const { hub, service } = makeService({
      fields: { whc001: fieldsWithout('whc001', dropped) },
      rows: { whc001: withoutKeys(WHC_ROWS, dropped) },
    });
    const snapshot = await service.getHeritage(ctx());
    expect(selectOf(hub, 'whc001')).toEqual(WHC_FIELDS.filter((f) => !dropped.includes(f)));
    expect(snapshot.records).toHaveLength(WHC_ROWS.length);
    for (const site of snapshot.records) expect(site.description_translations).toEqual({});
    expect(snapshot.byId.get('101')?.description).toBe(full?.description);
    const named = warningsNaming(warning, 'short_description_fr');
    expect(named).toHaveLength(1);
    expect(named[0]?.[1]).toMatchObject({ extra: { omittedFields: dropped } });
  });

  it('loads the intangible list with French unpublished when the metadata drops description_fr', async () => {
    const { hub, service } = makeService({
      fields: { ich001: fieldsWithout('ich001', ['description_fr']) },
      rows: { ich001: withoutKeys(ICH_ROWS, ['description_fr']) },
    });
    const snapshot = await service.getIntangible(ctx());
    expect(selectOf(hub, 'ich001')).toEqual(ICH_FIELDS.filter((f) => f !== 'description_fr'));
    expect(snapshot.records).toHaveLength(ICH_ROWS.length);
    for (const element of snapshot.records) expect(element.description_translations).toEqual({});
    expect(snapshot.byId.get('1001')?.description).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('keeps translations out of the keyword index', async () => {
    const { service } = makeService();
    const [heritage, intangible] = await Promise.all([
      service.getHeritage(ctx()),
      service.getIntangible(ctx()),
    ]);
    const index = (folded: readonly (readonly string[])[]) => folded.flat().join(' ');
    expect(index(heritage.folded)).toContain(' walled');
    expect(index(heritage.folded)).not.toContain('fortifiee');
    expect(index(heritage.folded)).not.toContain('城墙');
    expect(index(intangible.folded)).not.toContain('premier');
  });

  it('fails before the export GET when a required field is gone, naming it and not the optional one', async () => {
    const { hub, service } = makeService({
      fields: { mab001: fieldsWithout('mab001', ['url', 'website']) },
    });
    const error = await rejectionFrom(service.getBiosphere(ctx()));
    expectRejectedLoad(error, 'mab001');
    expect(error.message).toBe(
      rejectedMessage('mab001', 'the dataset no longer has the field url this server requires'),
    );
    expect((error.cause as McpError).data).toMatchObject({
      dataset: 'mab001',
      missingFields: ['url'],
      retryable: false,
    });
    expect(hub.callsFor('mab001', 'meta')).toHaveLength(1);
    expect(hub.callsFor('mab001', 'export')).toHaveLength(0);
  });

  it('names every missing required field', async () => {
    const { service } = makeService({
      fields: { whc001: fieldsWithout('whc001', ['name_en', 'id_no', 'main_image_url']) },
    });
    const error = await rejectionFrom(service.getHeritage(ctx()));
    expectRejectedLoad(error, 'whc001');
    expect((error.cause as McpError).data).toMatchObject({ missingFields: ['id_no', 'name_en'] });
    expect(error.message).toBe(
      rejectedMessage(
        'whc001',
        'the dataset no longer has the fields id_no, name_en this server requires',
      ),
    );
  });

  it('still fails the strict row schema when the export carries a field the select left out', async () => {
    const { service } = makeService({
      fields: { mab001: fieldsWithout('mab001', ['website']) },
    });
    const error = await rejectionFrom(service.getBiosphere(ctx()));
    expectRejectedLoad(error, 'mab001');
    expect((error.cause as McpError).message).toContain('row 0 failed validation');
  });

  it('re-attempts after the backoff and loads once the metadata lists the field again', async () => {
    const hubOptions: HubOptions = { fields: { mab001: fieldsWithout('mab001', ['url']) } };
    const { hub, service } = makeService(hubOptions);
    expectRejectedLoad(await rejectionFrom(service.getBiosphere(ctx())), 'mab001');
    hubOptions.fields = {};
    clock += 60_000;
    await expect(service.getBiosphere(ctx())).resolves.toMatchObject({
      dataset: 'mab001',
      recordsCount: MAB_ROWS.length,
    });
    expect(selectOf(hub, 'mab001')).toEqual([...MAB_FIELDS]);
  });

  it('keeps the previous snapshot when a refresh finds a required field gone', async () => {
    const TTL = 5_000;
    const hubOptions: HubOptions = {};
    const { hub, service } = makeService(hubOptions, TTL);
    const first = await service.getBiosphere(ctx());
    const warning = vi.spyOn(logger, 'warning');
    hubOptions.fields = { mab001: fieldsWithout('mab001', ['url']) };
    clock += TTL;
    expect(await service.getBiosphere(ctx())).toBe(first);
    await vi.waitFor(() =>
      expect(warningsNaming(warning, 'serving the previous snapshot')).toHaveLength(1),
    );
    expect(await service.getBiosphere(ctx())).toBe(first);
    expect(hub.callsFor('mab001', 'meta')).toHaveLength(2);
    expect(hub.callsFor('mab001', 'export')).toHaveLength(1);
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
    const error = await rejectionFrom(service.getHeritage(ctx()));
    expectRejectedLoad(error, 'whc001');
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
        const rows = { whc001: WHC_ROWS, ich001: ICH_ROWS, mab001: MAB_ROWS, eg0001: EG_ROWS }[
          call.dataset
        ];
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

  it('holds the geopark export to 8 MiB, non-retryably, and loads one under it', async () => {
    const over = makeService({
      intercept: (call) => (call.kind === 'export' ? paddedBody(EG_ROWS, 9).response : undefined),
    });
    const error = (await over.service.getGeoparks(ctx()).catch((e: unknown) => e)) as McpError;
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'eg0001' });
    expect((error.cause as McpError).message).toContain('8 MiB');
    expect((error.cause as McpError).data).toMatchObject({ dataset: 'eg0001', retryable: false });
    expect(over.hub.callsFor('eg0001', 'export')).toHaveLength(1);

    const under = makeService({
      intercept: (call) => (call.kind === 'export' ? paddedBody(EG_ROWS, 7).response : undefined),
    });
    await expect(under.service.getGeoparks(ctx())).resolves.toMatchObject({
      dataset: 'eg0001',
      recordsCount: EG_ROWS.length,
    });
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
    const held = await rejectionFrom(service.getHeritage(ctx()));
    expect(held.data).toMatchObject({
      reason: 'snapshot_unavailable',
      retryable: true,
      retryAfter: 3540,
    });
    expect(hub.calls).toHaveLength(1);

    const other = await rejectionOf(service.getIntangible(ctx()), 100);
    expect(other.data).toMatchObject({
      reason: 'snapshot_unavailable',
      retryable: true,
      dataset: 'ich001',
    });
    expect(other.message).toContain('could not be reached');
    expect((other.cause as McpError).data).toMatchObject({ reason: 'pacer_shed' });
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

describe('UNESCO Global Geoparks (eg0001)', () => {
  it('loads only its own two documents on first use, with the allowlisted select', async () => {
    const { hub, service } = makeService();
    const snapshot = await service.getGeoparks(ctx());
    expect(snapshot.dataset).toBe('eg0001');
    expect(hub.calls.map((c) => `${c.dataset} ${c.kind}`)).toEqual([
      'eg0001 meta',
      'eg0001 export',
    ]);
    const [meta, exported] = hub.calls;
    expect(meta?.url).toBe(`${BASE_URL}/eg0001`);
    const query = new URL(exported?.url ?? '').searchParams;
    expect([...query.keys()]).toEqual(['select']);
    expect(query.get('select')?.split(',')).toEqual([...EG_FIELDS]);
    expect(await service.getGeoparks(ctx())).toBe(snapshot);
    expect(hub.calls).toHaveLength(2);
  });

  it('keys geoparks by ugg_id, collects the split country codes, and folds three tiers', async () => {
    const { service } = makeService();
    const snapshot = await service.getGeoparks(ctx());
    expect(snapshot.records).toHaveLength(EG_ROWS.length);
    expect(snapshot.recordsCount).toBe(EG_ROWS.length);
    expect(snapshot.asOf).toBe(DATA_AS_OF);
    expect(snapshot.license).toBe('CC BY-SA 4.0');
    expect(snapshot.loadedAt).toBe(clock);
    expect(snapshot.byId.get('EUA190')?.name).toBe('Brindle Karst UNESCO Global Geopark');
    expect(snapshot.byId.get('ASJP91')?.ugg_id).toBe('ASJP91');
    expect(snapshot.byId.get('eua190')).toBeUndefined();
    expect([...snapshot.codes].sort()).toEqual(['DE', 'FR', 'IT', 'JP', 'PE', 'PL']);
    const index = snapshot.records.findIndex((g) => g.ugg_id === 'EUFR90');
    const [name, introduction, narratives] = snapshot.folded[index] ?? [];
    expect(name).toBe(' alderfen cliffs unesco global geopark');
    expect(introduction).toContain(' the alderfen cliffs record 300 million years');
    expect(narratives).toContain(' chalk cliffs and fossil beds');
    expect(narratives).toContain(' fishing farming villages share the coast');
    for (const tiers of snapshot.folded) expect(tiers).toHaveLength(3);
  });

  it('serves loaded text with no &nbsp;, &quot;, &#39;, <ul>, or <li> left in it', async () => {
    const { service } = makeService();
    const snapshot = await service.getGeoparks(ctx());
    const texts = snapshot.records.flatMap((g) => [
      g.name,
      g.introduction,
      g.description,
      g.sustaining_local_communities,
    ]);
    for (const text of texts) expect(text).not.toMatch(/&nbsp;|&quot;|&#39;|<\/?(?:ul|li)>/i);
    expect(snapshot.byId.get('EUIT92')?.introduction).toBe(
      'Explore the red earth mines.\nFollow the plateau trail.',
    );
  });

  it('lets the 2015-dated count be read from the loaded records', async () => {
    const dated = (records: readonly { designation_year: number }[]) =>
      records.filter((g) => g.designation_year === 2015).length;
    expect(dated((await makeService().service.getGeoparks(ctx())).records)).toBe(2);
    const rows = [
      egRow({ ugg_id: 'EUA1', date: '2015-01-01' }),
      egRow({ ugg_id: 'EUA2', date: '2016-01-01' }),
    ];
    expect(
      dated((await makeService({ rows: { eg0001: rows } }).service.getGeoparks(ctx())).records),
    ).toBe(1);
  });

  it('builds the attribution entry from the server constant title', async () => {
    const { service } = makeService();
    expect(sourceOf(await service.getGeoparks(ctx()))).toEqual({
      dataset: 'eg0001',
      title: 'UNESCO Global Geoparks',
      data_as_of: DATA_AS_OF,
      license: 'CC BY-SA 4.0',
      attribution: 'UNESCO — UNESCO Global Geoparks (eg0001), UNESCO Data Hub, CC BY-SA 4.0',
    });
  });

  it('fails the load on a row whose area_unit is not ha, non-retryably, naming the field', async () => {
    const rows = [EG_ROWS[0], { ...EG_ROWS[1], area_unit: 'km2' }, ...EG_ROWS.slice(2)];
    const { hub, service } = makeService({ rows: { eg0001: rows } });
    const error = (await service.getGeoparks(ctx()).catch((e: unknown) => e)) as McpError;
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'eg0001' });
    const cause = error.cause as McpError;
    expect(cause.message).toContain('row 1 failed validation');
    expect(cause.message).toContain('area_unit');
    expect(cause.data).toMatchObject({ rowIndex: 1, retryable: false });
    expect(hub.callsFor('eg0001', 'export')).toHaveLength(1);
  });

  it('fails the load on a duplicate ugg_id', async () => {
    const { service } = makeService({ rows: { eg0001: [...EG_ROWS, EG_ROWS[2]] } });
    const error = (await service.getGeoparks(ctx()).catch((e: unknown) => e)) as McpError;
    expect((error.cause as McpError).message).toContain('duplicate record id ASJP91');
  });

  it('reports a rejected first load as non-retryable snapshot_unavailable naming the dataset', async () => {
    const { service } = makeService({
      intercept: (call) => (call.dataset === 'eg0001' ? httpFailure(404) : undefined),
    });
    const error = await rejectionFrom(service.getGeoparks(ctx()));
    expectRejectedLoad(error, 'eg0001');
    expect(error.message).toBe(rejectedMessage('eg0001', 'the Data Hub answered HTTP 404'));
    expect((error.cause as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    await expect(service.getHeritage(ctx())).resolves.toMatchObject({ dataset: 'whc001' });
    await expect(service.getIntangible(ctx())).resolves.toMatchObject({ dataset: 'ich001' });
    await expect(service.getBiosphere(ctx())).resolves.toMatchObject({ dataset: 'mab001' });
  });

  it('loads while another dataset is down', async () => {
    const { service } = makeService({
      intercept: (call) => (call.dataset === 'eg0001' ? undefined : httpFailure(404)),
    });
    await expect(service.getBiosphere(ctx())).rejects.toMatchObject({
      data: { reason: 'snapshot_unavailable', dataset: 'mab001' },
    });
    await expect(service.getGeoparks(ctx())).resolves.toMatchObject({ dataset: 'eg0001' });
  });

  it('refuses a changed license without fetching the export', async () => {
    const { hub, service } = makeService({ metas: { eg0001: { license: 'CC BY 4.0' } } });
    const error = (await service.getGeoparks(ctx()).catch((e: unknown) => e)) as McpError;
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'eg0001' });
    expect((error.cause as McpError).data).toMatchObject({
      licenseChanged: true,
      license: 'CC BY 4.0',
    });
    expect(hub.callsFor('eg0001', 'meta')).toHaveLength(1);
    expect(hub.callsFor('eg0001', 'export')).toHaveLength(0);
  });

  it('keeps the previous snapshot when a refresh brings a row whose area_unit is not ha', async () => {
    const TTL = 5_000;
    const hubOptions: HubOptions = {};
    const { service } = makeService(hubOptions, TTL);
    const first = await service.getGeoparks(ctx());
    clock += TTL;
    hubOptions.rows = { eg0001: [egRow({ area_unit: 'acres' })] };
    const warning = vi.spyOn(logger, 'warning');
    expect(await service.getGeoparks(ctx())).toBe(first);
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(await service.getGeoparks(ctx())).toBe(first);
  });

  describe('row-count check (retry ladder under fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
    });

    it('re-fetches both documents when the export row count disagrees, then succeeds', async () => {
      let metaCalls = 0;
      const { hub, service } = makeService({
        intercept: (call) =>
          call.kind === 'meta' && metaCalls++ === 0
            ? Response.json(metaDocument('eg0001', { records_count: EG_ROWS.length + 1 }))
            : undefined,
      });
      const settled = service.getGeoparks(ctx());
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(settled).resolves.toMatchObject({ recordsCount: EG_ROWS.length });
      expect(hub.calls.map((c) => c.kind)).toEqual(['meta', 'export', 'meta', 'export']);
    });

    it('gives up after the retries when the count keeps disagreeing', async () => {
      const { hub, service } = makeService({ metas: { eg0001: { records_count: 241 } } });
      const error = await rejectionOf(service.getGeoparks(ctx()));
      expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'eg0001' });
      expect((error.cause as McpError).message).toContain(
        `exported ${EG_ROWS.length} rows but its metadata reports 241`,
      );
      expect(hub.callsFor('eg0001', 'export')).toHaveLength(3);
    });
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
