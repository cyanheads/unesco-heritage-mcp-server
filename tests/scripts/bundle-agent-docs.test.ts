/**
 * @fileoverview tests/scripts/bundle-agent-docs.test.ts — the bundle cleaner and
 * packaging lint keep executable dependency modules (the MCP SDK's
 * `dist/ext/skills/`, which the framework imports at startup) while stripping
 * package-root agent documentation (cyanheads/mcp-ts-core#794).
 * @module tests/scripts/bundle-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

// Loaded by URL so tsc skips the synced script's framework-repo-only fallback import (cyanheads/mcp-ts-core#797).
const { checkBundleEntries } = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);

describe('bundle agent documentation boundaries', () => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/runtime/dist/skills/index.js',
    'node_modules/@scope/skills/index.js',
    'skills/example-guide/SKILL.md',
  ])('preserves runtime or published entry %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(checkBundleEntries([entry], 'fixture.mcpb')).toEqual([]);
  });

  it.each([
    'node_modules/package/skills/guide/SKILL.md',
    'node_modules/@scope/package/framework-skills/guide/SKILL.md',
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/outer/node_modules/@scope/package/skills/guide/SKILL.md',
    'node_modules/outer/node_modules/package/.claude/settings.json',
    'node_modules/package/.agents/guide.md',
    'node_modules/package/docs/SKILL.md',
  ])('removes dependency agent documentation %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(checkBundleEntries([entry], 'fixture.mcpb')).toHaveLength(1);
  });
});
