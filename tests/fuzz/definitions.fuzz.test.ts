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
import { geoparkResource } from '@/mcp-server/resources/definitions/geopark.resource.js';
import { intangibleHeritageElementResource } from '@/mcp-server/resources/definitions/intangible-heritage-element.resource.js';
import { siteResource } from '@/mcp-server/resources/definitions/site.resource.js';
import { inline } from '@/mcp-server/shared/markdown.js';
import { getBiosphereReserveTool } from '@/mcp-server/tools/definitions/get-biosphere-reserve.tool.js';
import { getGeoparkTool } from '@/mcp-server/tools/definitions/get-geopark.tool.js';
import { getIntangibleHeritageElementTool } from '@/mcp-server/tools/definitions/get-intangible-heritage-element.tool.js';
import { getSiteTool } from '@/mcp-server/tools/definitions/get-site.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchBiosphereReservesTool } from '@/mcp-server/tools/definitions/search-biosphere-reserves.tool.js';
import { searchGeoparksTool } from '@/mcp-server/tools/definitions/search-geoparks.tool.js';
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
  searchGeoparksTool,
  getGeoparkTool,
  listReferenceTool,
];
const RESOURCES = [
  siteResource,
  intangibleHeritageElementResource,
  biosphereReserveResource,
  geoparkResource,
];

/** The patterns of the framework's leak check (`checkErrorLeaks` in `@cyanheads/mcp-ts-core/testing/fuzz`). */
const LEAK_PATTERNS = [
  /\bat\s+\S+\s+\(/,
  /node_modules/,
  /process\.env/,
  /\/Users\//,
  /\/home\//,
  /[A-Za-z]:\\/,
];

/** Every string an input carries, object keys included. */
function inputStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(inputStrings);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [key, ...inputStrings(item)]);
  }
  return [];
}

/**
 * The leaks left once the input's own strings are removed from the error text
 * in every form a message can echo them: raw, `inline()`-escaped, and each of
 * those JSON-encoded. The framework strips only the raw and JSON-encoded forms,
 * so the escaped echo in a not-found or unknown-country message (`U:<x` →
 * `U:\<x`) reads as a drive path (cyanheads/mcp-ts-core#754).
 */
function leaksBeyondEcho(leaks: FuzzReport['leaks']): FuzzReport['leaks'] {
  return leaks.filter(({ input, errorText }) => {
    const needles = new Set(
      inputStrings(input)
        .flatMap((s) => [s, inline(s)])
        .flatMap((s) => [s, JSON.stringify(s).slice(1, -1)])
        .filter((s) => s.length >= 2),
    );
    let text = errorText;
    for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
      text = text.split(needle).join('');
    }
    return LEAK_PATTERNS.some((pattern) => pattern.test(text));
  });
}

/** A clean report, with each crashing input and its error in the failure message. */
function expectClean(report: FuzzReport): void {
  const crashes = report.crashes.map(({ input, error }) => ({ input, error: String(error) }));
  expect(crashes, 'crashes').toEqual([]);
  expect(leaksBeyondEcho(report.leaks), 'leaks').toEqual([]);
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

describe('leaksBeyondEcho', () => {
  const input = { mab_id: 'U:<idZ#,F?' };
  const errorText = (message: string) => JSON.stringify({ code: -32001, message });
  const notFound = `No biosphere reserve has mab_id "${inline(input.mab_id)}".`;

  it('drops a leak whose only path match is the escaped echo of the input', () => {
    const leak = { input, errorText: errorText(notFound) };
    expect(LEAK_PATTERNS.some((pattern) => pattern.test(leak.errorText))).toBe(true);
    expect(leaksBeyondEcho([leak])).toEqual([]);
  });

  it('keeps a path or stack the input did not carry', () => {
    const leaks = [
      { input, errorText: errorText(`${notFound} Read from C:\\srv\\data.json.`) },
      { input, errorText: errorText(`${notFound} Read from /Users/someone/data.json.`) },
      { input, errorText: errorText(`${notFound} at load (/srv/app/dist/index.js:1:1)`) },
    ];
    expect(leaksBeyondEcho(leaks)).toEqual(leaks);
  });
});
