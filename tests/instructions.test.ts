/**
 * @fileoverview Tests for the server instructions: under the 2,048-character
 * budget, and naming every tool defined in `src/mcp-server/tools/definitions/`,
 * so a tool added without an instructions update fails here.
 * @module tests/instructions.test
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '@/mcp-server/instructions.js';

const DEFINITIONS = new URL('../src/mcp-server/tools/definitions/', import.meta.url);
const TOOL_FILES = readdirSync(DEFINITIONS).filter((file) => file.endsWith('.tool.ts'));
/** Every `tool('…'` call in a file, including one Biome wraps onto the next line. */
const toolNamesIn = (file: string) =>
  [...readFileSync(new URL(file, DEFINITIONS), 'utf8').matchAll(/\btool\(\s*'(\w+)'/g)].map(
    (match) => match[1] as string,
  );

describe('SERVER_INSTRUCTIONS', () => {
  it('stays under 2,048 characters', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2048);
  });

  it('finds a tool name in every definition file', () => {
    expect(TOOL_FILES.length).toBeGreaterThan(0);
    for (const file of TOOL_FILES) {
      const names = toolNamesIn(file);
      expect(names, file).not.toHaveLength(0);
      for (const name of names) expect(name, file).toMatch(/^unesco_/);
    }
  });

  it.each(TOOL_FILES)('names every tool defined in %s as a whole word', (file) => {
    for (const name of toolNamesIn(file)) {
      expect(SERVER_INSTRUCTIONS).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('describes four datasets, geoparks keyed by ugg_id, and near across the three point datasets', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/^Four UNESCO datasets /);
    expect(SERVER_INSTRUCTIONS).toContain('the UNESCO Global Geoparks (geoparks keyed by ugg_id)');
    expect(SERVER_INSTRUCTIONS).toContain('transnational geopark');
    expect(SERVER_INSTRUCTIONS).toContain(
      "A site's, reserve's, or geopark's coordinates work as near",
    );
  });
});
