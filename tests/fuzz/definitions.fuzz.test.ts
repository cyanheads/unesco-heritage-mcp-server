/**
 * @fileoverview Fuzzes every tool and resource with schema-derived valid
 * inputs and adversarial ones (wrong types, injection strings, polluting keys,
 * an aborted signal) over the synthetic fixture hub. Each definition must
 * answer with output that passes its schema and format(), or a well-formed MCP
 * error with no stack or path in its text, and leave Object.prototype intact.
 * @module tests/fuzz/definitions.fuzz.test
 */

import { type FuzzReport, fuzzResource, fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { biosphereReserveResource } from '@/mcp-server/resources/definitions/biosphere-reserve.resource.js';
import { intangibleHeritageElementResource } from '@/mcp-server/resources/definitions/intangible-heritage-element.resource.js';
import { siteResource } from '@/mcp-server/resources/definitions/site.resource.js';
import { getBiosphereReserveTool } from '@/mcp-server/tools/definitions/get-biosphere-reserve.tool.js';
import { getIntangibleHeritageElementTool } from '@/mcp-server/tools/definitions/get-intangible-heritage-element.tool.js';
import { getSiteTool } from '@/mcp-server/tools/definitions/get-site.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchBiosphereReservesTool } from '@/mcp-server/tools/definitions/search-biosphere-reserves.tool.js';
import { searchIntangibleHeritageTool } from '@/mcp-server/tools/definitions/search-intangible-heritage.tool.js';
import { searchSitesTool } from '@/mcp-server/tools/definitions/search-sites.tool.js';
import { getUnescoDataHubService } from '@/services/unesco-datahub/unesco-datahub-service.js';
import { initServiceWithHub } from '../fixtures/hub.js';

const TOOLS = [
  searchSitesTool,
  getSiteTool,
  searchIntangibleHeritageTool,
  getIntangibleHeritageElementTool,
  searchBiosphereReservesTool,
  getBiosphereReserveTool,
  listReferenceTool,
];
const RESOURCES = [siteResource, intangibleHeritageElementResource, biosphereReserveResource];

/** A clean report, with each crashing input and its error in the failure message. */
function expectClean(report: FuzzReport): void {
  const crashes = report.crashes.map(({ input, error }) => ({ input, error: String(error) }));
  expect(crashes, 'crashes').toEqual([]);
  expect(report.leaks, 'leaks').toEqual([]);
  expect(report.prototypePollution, 'prototype pollution').toBe(false);
  expect(report.totalRuns).toBeGreaterThan(0);
}

describe('fuzz — every definition over the fixture hub', () => {
  beforeAll(() => {
    initServiceWithHub();
  });

  afterAll(() => {
    getUnescoDataHubService().dispose();
  });

  it.each(TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s survives valid and adversarial input',
    async (_name, tool) => {
      expectClean(await fuzzTool(tool));
    },
  );

  it.each(RESOURCES.map((resource) => [resource.uriTemplate, resource] as const))(
    '%s survives valid and adversarial params',
    async (_uri, resource) => {
      expectClean(await fuzzResource(resource));
    },
  );
});
