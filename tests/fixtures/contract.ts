/**
 * @fileoverview Reads a definition's declared error contract so tests assert
 * that the declared recovery is what reaches the wire, without copying its text.
 * @module tests/fixtures/contract
 */

import { expect } from 'vitest';

/** The declared `recovery` for `reason`; fails the test when the contract has no such entry. */
export function declaredRecovery(
  errors: readonly { reason: string; recovery: string }[] | undefined,
  reason: string,
): string {
  const entry = errors?.find((e) => e.reason === reason);
  expect(entry, `contract entry ${reason}`).toBeDefined();
  return (entry as { recovery: string }).recovery;
}
