/**
 * @fileoverview Error-contract policy across the tools. Log severity: a failure
 * the caller's input causes is declared at `notice`, keeping the error-level
 * log stream for upstream and server faults, while `snapshot_unavailable` keeps
 * the default `error` level. Cursor recovery: every search tool declares
 * `invalid_cursor`, and its declared recovery is what reaches both response
 * surfaces for every cursor the pager rejects.
 * @module tests/tools/error-severity.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { getBiosphereReserveTool } from '@/mcp-server/tools/definitions/get-biosphere-reserve.tool.js';
import { getGeoparkTool } from '@/mcp-server/tools/definitions/get-geopark.tool.js';
import { getIntangibleHeritageElementTool } from '@/mcp-server/tools/definitions/get-intangible-heritage-element.tool.js';
import { getSiteTool } from '@/mcp-server/tools/definitions/get-site.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchBiosphereReservesTool } from '@/mcp-server/tools/definitions/search-biosphere-reserves.tool.js';
import { searchGeoparksTool } from '@/mcp-server/tools/definitions/search-geoparks.tool.js';
import { searchIntangibleHeritageTool } from '@/mcp-server/tools/definitions/search-intangible-heritage.tool.js';
import { searchSitesTool } from '@/mcp-server/tools/definitions/search-sites.tool.js';
import { declaredRecovery } from '../fixtures/contract.js';
import { allText, disposeServiceAfterEach, errorOf, useHub } from '../fixtures/tool.js';

type ContractEntry = { code: number; reason: string; severity?: string };

const TOOLS = [
  searchSitesTool,
  getSiteTool,
  searchIntangibleHeritageTool,
  getIntangibleHeritageElementTool,
  searchBiosphereReservesTool,
  getBiosphereReserveTool,
  searchGeoparksTool,
  getGeoparkTool,
  listReferenceTool,
];

const SEARCH_TOOLS = [
  searchSitesTool,
  searchIntangibleHeritageTool,
  searchBiosphereReservesTool,
  searchGeoparksTool,
];

describe('error contract severity', () => {
  it.each(
    TOOLS.map((tool) => [tool.name, (tool.errors ?? []) as readonly ContractEntry[]] as const),
  )(
    '%s declares caller-input failures at notice and upstream failures at error',
    (_name, errors) => {
      expect(errors.length).toBeGreaterThan(0);
      for (const entry of errors) {
        if (entry.code === JsonRpcErrorCode.ServiceUnavailable) {
          expect(entry.severity, entry.reason).toBeUndefined();
        } else {
          expect(entry.severity, entry.reason).toBe('notice');
        }
      }
    },
  );

  it.each(SEARCH_TOOLS)('$name declares invalid_cursor', (tool) => {
    const reasons = (tool.errors as readonly ContractEntry[]).map((e) => e.reason);
    expect(reasons).toContain('invalid_cursor');
  });
});

describe('invalid_cursor recovery on the wire', () => {
  disposeServiceAfterEach();
  beforeEach(() => {
    useHub();
  });

  /** The framework decoder rejects the first four; the server's pager the fifth. */
  const REJECTED_CURSORS = [
    ['text that is not base64url JSON', 'bad'],
    ['truncated base64url', encodeCursor({ offset: 20, limit: 20 }).slice(0, 5)],
    ['JSON with no offset', Buffer.from('{"foo":1}').toString('base64url')],
    ['a negative offset', encodeCursor({ offset: -1, limit: 20, fp: 'x', asOf: 'y' })],
    ['a fractional offset', encodeCursor({ offset: 1.5, limit: 20, fp: 'x', asOf: 'y' })],
  ] as const;

  it.each(
    SEARCH_TOOLS.flatMap((tool) =>
      REJECTED_CURSORS.map(([label, cursor]) => [tool.name, label, tool, cursor] as const),
    ),
  )('%s carries its declared recovery for a cursor of %s', async (_name, _label, tool, cursor) => {
    const result = await runToolContract(tool as typeof searchSitesTool, { cursor } as never);
    const error = errorOf(result);
    const recovery = declaredRecovery(tool.errors, 'invalid_cursor');
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_cursor');
    expect(error.data?.recovery?.hint).toBe(recovery);
    const text = allText(result);
    expect(text).toContain(`Recovery: ${recovery}`);
    expect(text).toContain('(reason invalid_cursor');
    expect(JSON.stringify(result.structuredContent)).not.toContain('nextCursor');
    expect(text).not.toContain('nextCursor');
  });
});
