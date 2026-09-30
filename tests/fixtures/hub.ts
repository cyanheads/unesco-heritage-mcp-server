/**
 * @fileoverview A fake UNESCO Data Hub behind the service's `get` seam
 * (`fetchWithTimeout`'s signature). Serves the synthetic fixtures for the
 * metadata and `exports/json` endpoints, records every call, and turns
 * non-2xx responses into the framework's own error via `httpErrorFromResponse`,
 * as the real helper does.
 * @module tests/fixtures/hub
 */

import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import {
  getUnescoDataHubService,
  initUnescoDataHubService,
  type UnescoDataHubService,
  type UnescoDataHubServiceOptions,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import type { DatasetId } from '@/services/unesco-datahub/vocabulary.js';
import { ICH_ROWS, MAB_ROWS, WHC_ROWS } from './rows.js';

export const BASE_URL = 'https://data.unesco.org/api/explore/v2.1/catalog/datasets';
export const DATA_AS_OF = '2026-09-30T02:06:00+00:00';

type Get = NonNullable<UnescoDataHubServiceOptions['get']>;

/** One recorded upstream call. */
export interface HubCall {
  dataset: DatasetId;
  headers: Record<string, string>;
  kind: 'export' | 'meta';
  timeoutMs: number;
  url: string;
}

/** Overrides for a fake hub. */
export interface HubOptions {
  /** Intercepts a call before the fixtures answer; return `undefined` to fall through. */
  intercept?: (
    call: HubCall,
    index: number,
  ) => Promise<Response | undefined> | Response | undefined;
  /** Metadata `metas.default` overrides per dataset. */
  metas?: Partial<
    Record<DatasetId, { data_processed?: string; license?: string; records_count?: number }>
  >;
  /** Export rows per dataset; defaults to the synthetic fixtures. */
  rows?: Partial<Record<DatasetId, unknown>>;
}

export interface FakeHub {
  /** Every call in order. */
  calls: HubCall[];
  /** Calls made for one dataset and kind. */
  callsFor(dataset: DatasetId, kind?: HubCall['kind']): HubCall[];
  /** The `get` seam to hand to the service. */
  get: Get;
}

const DEFAULT_ROWS: Record<DatasetId, unknown[]> = {
  whc001: WHC_ROWS,
  ich001: ICH_ROWS,
  mab001: MAB_ROWS,
};

/** A metadata document in the shape the loader reads. */
export function metaDocument(
  dataset: DatasetId,
  overrides: { data_processed?: string; license?: string; records_count?: number } = {},
  rows: unknown = DEFAULT_ROWS[dataset],
): unknown {
  return {
    dataset_id: dataset,
    metas: {
      default: {
        data_processed: DATA_AS_OF,
        license: 'CC BY-SA 4.0',
        records_count: Array.isArray(rows) ? rows.length : 0,
        title: 'Synthetic metadata',
        ...overrides,
      },
    },
  };
}

/** A non-2xx response the `get` fake turns into the framework's HTTP error. */
export function httpFailure(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error_code: 'Synthetic', message: 'synthetic failure' }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Creates a fake hub. */
export function createHub(options: HubOptions = {}): FakeHub {
  const calls: HubCall[] = [];
  const get: Get = async (url, timeoutMs, _context, init) => {
    const href = String(url);
    const match = new RegExp(`^${BASE_URL}/(whc001|ich001|mab001)(/exports/json\\?.*)?$`).exec(
      href,
    );
    if (!match) throw new Error(`Unexpected upstream URL: ${href}`);
    const dataset = match[1] as DatasetId;
    const kind: HubCall['kind'] = match[2] ? 'export' : 'meta';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: HubCall = { url: href, dataset, kind, timeoutMs, headers };
    const index = calls.push(call) - 1;

    const intercepted = await options.intercept?.(call, index);
    const response =
      intercepted ??
      Response.json(
        kind === 'meta'
          ? metaDocument(
              dataset,
              options.metas?.[dataset],
              options.rows?.[dataset] ?? DEFAULT_ROWS[dataset],
            )
          : (options.rows?.[dataset] ?? DEFAULT_ROWS[dataset]),
      );
    if (!response.ok) throw await httpErrorFromResponse(response);
    return response;
  };
  return {
    calls,
    get,
    callsFor: (dataset, kind) =>
      calls.filter((c) => c.dataset === dataset && (kind === undefined || c.kind === kind)),
  };
}

/** Initializes the production service accessor over a fake hub; returns both. */
export function initServiceWithHub(
  hubOptions: HubOptions = {},
  serviceOptions: Omit<UnescoDataHubServiceOptions, 'get'> = {},
): { hub: FakeHub; service: UnescoDataHubService } {
  const hub = createHub(hubOptions);
  initUnescoDataHubService({ get: hub.get, ...serviceOptions });
  return { hub, service: getUnescoDataHubService() };
}
