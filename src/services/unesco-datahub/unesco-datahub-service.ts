/**
 * @fileoverview Snapshot lifecycle for the three UNESCO Data Hub datasets
 * (`whc001`, `ich001`, `mab001`): lazy load on first use, single-flight, 24 h
 * TTL with stale-while-revalidate, failure backoff, and the resilient load
 * pipeline (pacer inside `withRetry` under a total deadline, byte-budgeted body
 * reads, strict row validation, row-count and license checks, index build).
 * @module services/unesco-datahub/unesco-datahub-service
 */

import type { Context, z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  fetchWithTimeout,
  logger,
  type Pacer,
  type RequestContext,
  type RetryAttempt,
  requestContextService,
  withExtra,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import {
  DatasetMetaSchema,
  ICH_FIELDS,
  IchRowSchema,
  MAB_FIELDS,
  MabRowSchema,
  toBiosphereReserve,
  toHeritageSite,
  toIntangibleElement,
  WHC_FIELDS,
  WhcRowSchema,
} from './rows.js';
import { foldText, foldTier } from './search.js';
import type {
  BiosphereSnapshot,
  HeritageSite,
  HeritageSnapshot,
  IntangibleSnapshot,
  Snapshot,
  SourceEntry,
} from './types.js';
import {
  DATASET_TITLES,
  type DatasetId,
  datasetAttribution,
  EXPECTED_LICENSE,
} from './vocabulary.js';

const BASE_URL = 'https://data.unesco.org/api/explore/v2.1/catalog/datasets';
const DEFAULT_TTL_MS = 86_400_000;
const LOAD_DEADLINE_MS = 45_000;
const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;

const EXPORT_FIELDS: Readonly<Record<DatasetId, readonly string[]>> = {
  whc001: WHC_FIELDS,
  ich001: ICH_FIELDS,
  mab001: MAB_FIELDS,
};

const MiB = 1_048_576;
/** Decoded-body budgets: a body past its budget fails the load as unreadable. */
const METADATA_MAX_BYTES = MiB;
const EXPORT_MAX_BYTES: Readonly<Record<DatasetId, number>> = {
  whc001: 64 * MiB,
  ich001: 16 * MiB,
  mab001: 16 * MiB,
};

/** Constructor seams for tests; production uses the defaults. */
export interface UnescoDataHubServiceOptions {
  /** HTTP seam with `fetchWithTimeout`'s signature. */
  get?: typeof fetchWithTimeout;
  /** Clock for TTL, backoff, and `loadedAt`. */
  now?: () => number;
  /** Snapshot time-to-live in ms. */
  ttlMs?: number;
}

/** Dataset metadata the snapshot keeps. */
interface DatasetMeta {
  asOf: string;
  license: string;
  recordsCount: number;
}

/** Which document a GET reads, and the most decoded bytes its body may hold. */
interface BodyBudget {
  dataset: DatasetId;
  document: 'metadata' | 'export';
  maxBytes: number;
}

type LoadOutcome<S> = { ok: true; snapshot: S } | { ok: false; error: unknown };

/** Lifecycle state for one dataset. */
interface Slot<S> {
  failures: number;
  inflight?: Promise<LoadOutcome<S>> | undefined;
  lastError?: unknown;
  nextAttemptAt: number;
  snapshot?: S | undefined;
}

type Builder<T> = (rows: unknown[], meta: DatasetMeta, logCtx: RequestContext) => Snapshot<T>;

/** Loads and serves in-memory snapshots of the UNESCO Data Hub datasets. */
export class UnescoDataHubService {
  private readonly get: typeof fetchWithTimeout;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly pacer: Pacer;
  private readonly heritage: Slot<HeritageSnapshot> = { failures: 0, nextAttemptAt: 0 };
  private readonly intangible: Slot<IntangibleSnapshot> = { failures: 0, nextAttemptAt: 0 };
  private readonly biosphere: Slot<BiosphereSnapshot> = { failures: 0, nextAttemptAt: 0 };

  constructor(options: UnescoDataHubServiceOptions = {}) {
    this.get = options.get ?? fetchWithTimeout;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.pacer = createPacer({
      name: 'unesco-datahub',
      maxConcurrent: 2,
      limits: [{ requests: 200, perMs: 86_400_000 }],
      cooldown: { baseMs: 60_000, maxMs: 3_600_000 },
    });
  }

  /** The World Heritage List snapshot, loading it on first use. */
  getHeritage(ctx: Context): Promise<HeritageSnapshot> {
    return this.acquire('whc001', this.heritage, ctx, (rows, meta, logCtx) =>
      this.buildHeritage(rows, meta, logCtx),
    );
  }

  /** The Intangible Heritage List snapshot, loading it on first use. */
  getIntangible(ctx: Context): Promise<IntangibleSnapshot> {
    return this.acquire('ich001', this.intangible, ctx, (rows, meta) =>
      this.buildIntangible(rows, meta),
    );
  }

  /** The Man and the Biosphere snapshot, loading it on first use. */
  getBiosphere(ctx: Context): Promise<BiosphereSnapshot> {
    return this.acquire('mab001', this.biosphere, ctx, (rows, meta) =>
      this.buildBiosphere(rows, meta),
    );
  }

  /** Releases the pacer's timer and queued waiters. */
  dispose(): void {
    this.pacer.dispose();
  }

  /* -------------------------------------------------------------- */
  /* Lifecycle                                                       */
  /* -------------------------------------------------------------- */

  private async acquire<T>(
    id: DatasetId,
    slot: Slot<Snapshot<T>>,
    ctx: Context,
    build: Builder<T>,
  ): Promise<Snapshot<T>> {
    const now = this.now();
    if (slot.snapshot) {
      const expired = now - slot.snapshot.loadedAt >= this.ttlMs;
      if (expired && !slot.inflight && now >= slot.nextAttemptAt) {
        void this.startLoad(id, slot, build);
      }
      return slot.snapshot;
    }
    let inflight = slot.inflight;
    if (!inflight) {
      if (now < slot.nextAttemptAt) throw this.unavailable(id, slot, slot.lastError);
      inflight = this.startLoad(id, slot, build);
    }
    const outcome = await raceSignal(inflight, ctx.signal);
    if (outcome.ok) return outcome.snapshot;
    throw this.unavailable(id, slot, outcome.error);
  }

  /**
   * Starts the one load for a dataset. The returned promise never rejects: it
   * settles to an outcome after the slot is updated, so a load every caller
   * stopped waiting for can never surface as an unhandled rejection.
   */
  private startLoad<T>(
    id: DatasetId,
    slot: Slot<Snapshot<T>>,
    build: Builder<T>,
  ): Promise<LoadOutcome<Snapshot<T>>> {
    const logCtx = requestContextService.createRequestContext({
      operation: 'unesco.loadDataset',
      additionalContext: { dataset: id },
    });
    const inflight = this.load(id, build, logCtx)
      .then(
        (snapshot): LoadOutcome<Snapshot<T>> => {
          slot.snapshot = snapshot;
          slot.failures = 0;
          slot.nextAttemptAt = 0;
          slot.lastError = undefined;
          logger.info(
            `Loaded ${id} snapshot`,
            withExtra(logCtx, { records: snapshot.records.length, asOf: snapshot.asOf }),
          );
          return { ok: true, snapshot };
        },
        (error: unknown): LoadOutcome<Snapshot<T>> => {
          slot.failures += 1;
          slot.lastError = error;
          // A 429's Retry-After can hold the pacer's gate closed longer than the backoff.
          const waitMs = Math.max(
            Math.min(BACKOFF_BASE_MS * 2 ** (slot.failures - 1), BACKOFF_MAX_MS),
            this.pacer.cooldown.remainingMs,
          );
          slot.nextAttemptAt = this.now() + waitMs;
          const detail = withExtra(logCtx, { failures: slot.failures, nextAttemptInMs: waitMs });
          const err = error instanceof Error ? error : new Error(String(error));
          if (isLicenseChange(error) || !slot.snapshot) {
            logger.error(`Failed to load ${id} snapshot`, err, detail);
          } else {
            logger.warning(
              `Refresh of ${id} failed; serving the previous snapshot. ${err.message}`,
              detail,
            );
          }
          return { ok: false, error };
        },
      )
      .finally(() => {
        slot.inflight = undefined;
      });
    slot.inflight = inflight;
    return inflight;
  }

  /**
   * The first-load failure every tool declares as `snapshot_unavailable`.
   * `retryable` rides in `data` because the framework copies a contract's
   * `retryable` onto the wire only for `ctx.fail`, never for a service throw.
   * `retryAfter` is the later of this dataset's backoff and the pacer's shared
   * cooldown gate, which a rate limit on any dataset can close.
   */
  private unavailable(id: DatasetId, slot: Slot<unknown>, cause: unknown) {
    const waitMs = Math.max(slot.nextAttemptAt - this.now(), this.pacer.cooldown.remainingMs);
    const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
    return serviceUnavailable(
      `The UNESCO Data Hub could not be reached to load the ${DATASET_TITLES[id]} (${id}); the next load attempt is allowed in ${retryAfter} s.`,
      { reason: 'snapshot_unavailable', retryable: true, dataset: id, retryAfter },
      { cause },
    );
  }

  /* -------------------------------------------------------------- */
  /* Load pipeline                                                   */
  /* -------------------------------------------------------------- */

  private load<T>(id: DatasetId, build: Builder<T>, logCtx: RequestContext): Promise<Snapshot<T>> {
    return withRetry(
      async (attempt) => {
        const meta = DatasetMetaSchema.parse(
          await this.fetchJson(
            `${BASE_URL}/${id}`,
            { dataset: id, document: 'metadata', maxBytes: METADATA_MAX_BYTES },
            attempt,
            logCtx,
          ),
        );
        const { data_processed, records_count, license } = meta.metas.default;
        if (license !== EXPECTED_LICENSE) {
          throw serviceUnavailable(
            `Dataset ${id} reports license "${license}", not ${EXPECTED_LICENSE}; refusing to serve it until the change is reviewed.`,
            { dataset: id, license, licenseChanged: true, retryable: false },
          );
        }
        const exportUrl = `${BASE_URL}/${id}/exports/json?select=${encodeURIComponent(EXPORT_FIELDS[id].join(','))}`;
        const rows = await this.fetchJson(
          exportUrl,
          { dataset: id, document: 'export', maxBytes: EXPORT_MAX_BYTES[id] },
          attempt,
          logCtx,
        );
        if (!Array.isArray(rows)) {
          throw serviceUnavailable(`Dataset ${id} export was not a JSON array.`, { dataset: id });
        }
        if (rows.length !== records_count) {
          throw serviceUnavailable(
            `Dataset ${id} exported ${rows.length} rows but its metadata reports ${records_count}.`,
            { dataset: id, exported: rows.length, expected: records_count },
          );
        }
        return build(rows, { asOf: data_processed, license, recordsCount: records_count }, logCtx);
      },
      {
        maxRetries: 2,
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        deadlineMs: LOAD_DEADLINE_MS,
        operation: 'unesco.loadDataset',
        context: logCtx,
      },
    );
  }

  private fetchJson(
    url: string,
    body: BodyBudget,
    attempt: RetryAttempt,
    logCtx: RequestContext,
  ): Promise<unknown> {
    return this.pacer.run(
      async (signal) => {
        const response = await this.get(
          url,
          Math.min(REQUEST_TIMEOUT_MS, attempt.remainingMs),
          logCtx,
          {
            signal,
            headers: { accept: 'application/json' },
          },
        );
        return readJson(response, body);
      },
      { signal: attempt.signal, maxWaitMs: attempt.remainingMs },
    );
  }

  /* -------------------------------------------------------------- */
  /* Snapshot builders                                               */
  /* -------------------------------------------------------------- */

  private buildHeritage(
    rows: unknown[],
    meta: DatasetMeta,
    logCtx: RequestContext,
  ): HeritageSnapshot {
    const records: HeritageSite[] = [];
    let unparsed = 0;
    const countMismatches: string[] = [];
    rows.forEach((raw, index) => {
      const { site, componentParts } = mapRow('whc001', index, () =>
        toHeritageSite(parseRow('whc001', WhcRowSchema, raw, index)),
      );
      unparsed += site.components_unparsed;
      if (componentParts !== site.components_total) countMismatches.push(site.id_no);
      records.push(site);
    });
    if (unparsed > 0 || countMismatches.length > 0) {
      logger.warning(
        `whc001: ${unparsed} component entries could not be parsed; ${countMismatches.length} sites list a different number of components than components_count.`,
        withExtra(logCtx, {
          unparsedComponents: unparsed,
          componentCountMismatchSites: countMismatches,
        }),
      );
    }
    return this.index('whc001', records, meta, {
      id: (s) => s.id_no,
      codes: (s) => s.country_codes,
      tiers: (s) => [
        foldTier(s.name, s.names.fr, s.names.es, s.names.ru, s.names.ar, s.names.zh),
        foldTier(s.description),
        foldTier(s.justification),
      ],
    });
  }

  private buildIntangible(rows: unknown[], meta: DatasetMeta): IntangibleSnapshot {
    const records = rows.map((raw, index) =>
      mapRow('ich001', index, () =>
        toIntangibleElement(parseRow('ich001', IchRowSchema, raw, index)),
      ),
    );
    return this.index('ich001', records, meta, {
      id: (e) => e.ich_ref,
      codes: (e) => e.country_codes,
      tiers: (e) => [
        foldTier(e.name, e.name_fr),
        foldTier(...e.concepts, ...e.concepts_secondary),
        foldTier(e.description),
      ],
    });
  }

  private buildBiosphere(rows: unknown[], meta: DatasetMeta): BiosphereSnapshot {
    const records = rows.map((raw, index) =>
      mapRow('mab001', index, () =>
        toBiosphereReserve(parseRow('mab001', MabRowSchema, raw, index)),
      ),
    );
    return this.index('mab001', records, meta, {
      id: (r) => foldText(r.mab_id),
      codes: (r) => [r.country_code],
      tiers: (r) => [
        foldTier(r.name),
        foldTier(r.introduction),
        foldTier(r.ecological_characteristics, r.socio_economic_characteristics),
      ],
    });
  }

  private index<T>(
    dataset: DatasetId,
    records: T[],
    meta: DatasetMeta,
    keys: { id(r: T): string; codes(r: T): readonly string[]; tiers(r: T): string[] },
  ): Snapshot<T> {
    const byId = new Map<string, T>();
    const codes = new Set<string>();
    for (const record of records) {
      const id = keys.id(record);
      if (byId.has(id)) {
        throw serviceUnavailable(`Dataset ${dataset} carries duplicate record id ${id}.`, {
          dataset,
          retryable: false,
        });
      }
      byId.set(id, record);
      for (const code of keys.codes(record)) codes.add(code);
    }
    return {
      dataset,
      records,
      byId,
      codes,
      folded: records.map(keys.tiers),
      asOf: meta.asOf,
      license: meta.license,
      recordsCount: meta.recordsCount,
      loadedAt: this.now(),
    };
  }
}

/** The attribution entry for a loaded snapshot. */
export function sourceOf(snapshot: Snapshot<unknown>): SourceEntry {
  return {
    dataset: snapshot.dataset,
    title: DATASET_TITLES[snapshot.dataset],
    data_as_of: snapshot.asOf,
    license: snapshot.license,
    attribution: datasetAttribution(snapshot.dataset),
  };
}

/**
 * Reads a JSON body chunk by chunk and fails the load, non-retryably, once the
 * decoded bytes pass the budget; leaving the loop cancels the stream. Counting
 * decoded bytes bounds memory whatever the transfer encoding.
 */
async function readJson(
  response: Response,
  { dataset, document, maxBytes }: BodyBudget,
): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw serviceUnavailable(
        `Dataset ${dataset} ${document} is larger than its ${maxBytes / MiB} MiB budget; the snapshot was not replaced.`,
        { dataset, document, maxBytes, retryable: false },
      );
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Validates one export row against its strict schema; any failure fails the refresh. */
function parseRow<T>(dataset: DatasetId, schema: z.ZodType<T>, raw: unknown, index: number): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(row)'}: ${issue.message}`);
  throw serviceUnavailable(
    `Dataset ${dataset} row ${index} failed validation (${issues.join('; ')}); the snapshot was not replaced.`,
    { dataset, rowIndex: index, issues, retryable: false },
  );
}

/** Runs a row mapper, converting a mapper throw into a non-retryable refresh failure. */
function mapRow<T>(dataset: DatasetId, index: number, map: () => T): T {
  try {
    return map();
  } catch (error) {
    throw serviceUnavailable(
      `Dataset ${dataset} row ${index} could not be mapped: ${error instanceof Error ? error.message : String(error)}`,
      { dataset, rowIndex: index, retryable: false },
      { cause: error },
    );
  }
}

function isLicenseChange(error: unknown): boolean {
  const data = (error as { data?: { licenseChanged?: unknown } } | undefined)?.data;
  return data?.licenseChanged === true;
}

/** Awaits a never-rejecting load, abandoning the wait (not the load) when `signal` aborts. */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Init/accessor                                                       */
/* ------------------------------------------------------------------ */

let _service: UnescoDataHubService | undefined;

/** Constructs the production service; call from `createApp`'s `setup()`. */
export function initUnescoDataHubService(options?: UnescoDataHubServiceOptions): void {
  _service = new UnescoDataHubService(options);
}

/** The initialized service. */
export function getUnescoDataHubService(): UnescoDataHubService {
  if (!_service) {
    throw new Error(
      'UnescoDataHubService not initialized — call initUnescoDataHubService() in setup()',
    );
  }
  return _service;
}
