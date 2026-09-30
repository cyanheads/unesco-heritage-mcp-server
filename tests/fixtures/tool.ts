/**
 * @fileoverview Helpers for driving tool definitions through `runToolContract`
 * and reading its dual-surface result: structured content, text blocks, and the
 * error envelope. Also a per-test service lifecycle helper.
 * @module tests/fixtures/tool
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect } from 'vitest';
import { getUnescoDataHubService } from '@/services/unesco-datahub/unesco-datahub-service.js';
import { type FakeHub, type HubOptions, initServiceWithHub } from './hub.js';

export type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

/** The error envelope `structuredContent.error` carries. */
export interface ErrorEnvelope {
  code: number;
  data?: Record<string, unknown> & { reason?: string; recovery?: { hint?: string } };
  message: string;
}

/** Every text block of the result's `content[]`, in order. */
export function textBlocks(result: ContractResult): string[] {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

/** All text blocks joined by a newline. */
export function allText(result: ContractResult): string {
  return textBlocks(result).join('\n');
}

/** The structured content of a successful result, typed by the caller. */
export function structured<T>(result: ContractResult): T {
  expect(result.isError, allText(result)).not.toBe(true);
  return result.structuredContent as T;
}

/** The error envelope of a failed result. */
export function errorOf(result: ContractResult): ErrorEnvelope {
  expect(result.isError, 'expected an error result').toBe(true);
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

/**
 * Registers per-test service setup over a fake hub: call inside a test or
 * `beforeEach`; the service is disposed after each test.
 */
export function useHub(options: HubOptions = {}): FakeHub {
  const { hub } = initServiceWithHub(options);
  return hub;
}

/** Disposes the accessor's service after every test in the file. */
export function disposeServiceAfterEach(): void {
  afterEach(() => {
    try {
      getUnescoDataHubService().dispose();
    } catch {
      // service was never initialized in this test
    }
  });
}
