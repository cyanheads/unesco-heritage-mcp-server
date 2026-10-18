/**
 * @fileoverview Upstream failure scenarios for the Data Hub fake, shared by
 * the per-tool "failure classes" suites, in two classes. Transport failures
 * (a rate limit with a long Retry-After, a 503, a 200 with a non-JSON body, a
 * metadata document of the wrong shape, a timeout, a row-count mismatch) are
 * retryable and carry the definition's declared recovery. Content failures (a
 * 404, a 400, metadata that no longer lists a required field) are not
 * retryable and carry the service's own recovery. Also runs a call under fake
 * timers so the loader's retry delays elapse instantly, and returns the
 * `McpError` a call must reject with.
 * @module tests/fixtures/failures
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { expect, vi } from 'vitest';
import type { DatasetId } from '@/services/unesco-datahub/vocabulary.js';
import { DEFAULT_FIELDS, type HubOptions, httpFailure, metaDocument } from './hub.js';

type Intercept = NonNullable<HubOptions['intercept']>;

/** Labelled interceptors, each of which must surface as retryable `snapshot_unavailable`. */
export function transportFailureCases(dataset: DatasetId, rowCount: number): [string, Intercept][] {
  return [
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
          ? Response.json(metaDocument(dataset, { records_count: rowCount + 1 }))
          : undefined,
    ],
  ];
}

/** Each dataset's record key, a field no load can do without. */
const KEY_FIELD: Readonly<Record<DatasetId, string>> = {
  whc001: 'id_no',
  ich001: 'ich_public_ref',
  mab001: 'mab_id',
  eg0001: 'ugg_id',
};

/** Labelled hub setups, each of which must surface as non-retryable `snapshot_unavailable`. */
export function contentFailureCases(dataset: DatasetId): [string, HubOptions][] {
  return [
    ['a 404', { intercept: () => httpFailure(404) }],
    ['a 400 rejecting the request', { intercept: () => httpFailure(400) }],
    [
      'metadata that no longer lists a required field',
      {
        fields: { [dataset]: DEFAULT_FIELDS[dataset].filter((f) => f !== KEY_FIELD[dataset]) },
      },
    ],
  ];
}

/**
 * Asserts the non-retryable `snapshot_unavailable` shape: no `retryAfter`, no
 * "could not be reached", and a service recovery that is not `declared` (the
 * definition's own recovery) and does not say to wait.
 */
export function expectContentFailure(
  error: { message: string; data?: Record<string, unknown> },
  dataset: DatasetId,
  declared: string,
): void {
  expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', retryable: false, dataset });
  expect(error.data).not.toHaveProperty('retryAfter');
  expect(error.message).not.toContain('could not be reached');
  const hint = (error.data?.recovery as { hint?: string } | undefined)?.hint;
  expect(hint).toEqual(expect.any(String));
  expect(hint).not.toBe(declared);
  expect(hint).not.toMatch(/\bwait\b/i);
}

/**
 * Runs `start` under fake timers (timers and `Date` only) and advances them
 * past the loader's retry delays. Pair with `vi.useRealTimers()` in `afterEach`.
 * Call before `useHub`, so the service reads the faked clock.
 */
export function withFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
}

/** Awaits `pending` while advancing the fake clock past the retry delays. */
export async function settle<T>(pending: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(10_000);
  return pending;
}

/** Awaits a call that must reject with an `McpError`, failing the test when it resolves; returns the error. */
export async function rejectionFrom(call: Promise<unknown>): Promise<McpError> {
  await expect(call).rejects.toBeInstanceOf(McpError);
  return (await call.catch((error: unknown) => error)) as McpError;
}

/** `rejectionFrom` under fake timers: advances the clock past the retry delays while `pending` settles. */
export async function settleRejection(pending: Promise<unknown>): Promise<McpError> {
  const rejected = expect(pending).rejects.toBeInstanceOf(McpError);
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  return (await pending.catch((error: unknown) => error)) as McpError;
}
