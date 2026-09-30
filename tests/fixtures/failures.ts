/**
 * @fileoverview Upstream failure scenarios for the Data Hub fake, shared by
 * the per-tool "failure classes" suites: non-2xx statuses, a rate limit with a
 * long Retry-After, a 200 with a non-JSON body, a metadata document of the
 * wrong shape, a timeout, and a row-count mismatch. Also runs a call under fake
 * timers so the loader's retry delays elapse instantly.
 * @module tests/fixtures/failures
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { vi } from 'vitest';
import type { DatasetId } from '@/services/unesco-datahub/vocabulary.js';
import { type HubOptions, httpFailure, metaDocument } from './hub.js';

type Intercept = NonNullable<HubOptions['intercept']>;

/** Labelled interceptors, each of which must surface as `snapshot_unavailable`. */
export function failureCases(dataset: DatasetId, rowCount: number): [string, Intercept][] {
  return [
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
          ? Response.json(metaDocument(dataset, { records_count: rowCount + 1 }))
          : undefined,
    ],
  ];
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
