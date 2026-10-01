/**
 * @fileoverview Log-severity policy across every tool's error contract: a
 * failure the caller's input causes is declared at `notice`, keeping the
 * error-level log stream for upstream and server faults, while
 * `snapshot_unavailable` keeps the default `error` level.
 * @module tests/tools/error-severity.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { getBiosphereReserveTool } from '@/mcp-server/tools/definitions/get-biosphere-reserve.tool.js';
import { getIntangibleHeritageElementTool } from '@/mcp-server/tools/definitions/get-intangible-heritage-element.tool.js';
import { getSiteTool } from '@/mcp-server/tools/definitions/get-site.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchBiosphereReservesTool } from '@/mcp-server/tools/definitions/search-biosphere-reserves.tool.js';
import { searchIntangibleHeritageTool } from '@/mcp-server/tools/definitions/search-intangible-heritage.tool.js';
import { searchSitesTool } from '@/mcp-server/tools/definitions/search-sites.tool.js';

type ContractEntry = { code: number; reason: string; severity?: string };

const TOOLS = [
  searchSitesTool,
  getSiteTool,
  searchIntangibleHeritageTool,
  getIntangibleHeritageElementTool,
  searchBiosphereReservesTool,
  getBiosphereReserveTool,
  listReferenceTool,
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

  it.each([searchSitesTool, searchIntangibleHeritageTool, searchBiosphereReservesTool])(
    '$name declares invalid_cursor',
    (tool) => {
      const reasons = (tool.errors as readonly ContractEntry[]).map((e) => e.reason);
      expect(reasons).toContain('invalid_cursor');
    },
  );
});
