/**
 * @fileoverview Tests for `normalizeMabId` and `mabIdInput`: trimming,
 * percent-decoding (malformed escapes kept), NFC composition, length bounds
 * measured after decoding, and a JSON Schema that carries no pattern.
 * @module tests/shared/mab-id-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { mabIdInput, normalizeMabId } from '@/mcp-server/shared/inputs.js';

const schema = z.object({ mab_id: mabIdInput('A reserve id.') });
const parse = (value: unknown) => schema.safeParse({ mab_id: value });

describe('normalizeMabId', () => {
  it('passes non-strings through untouched', () => {
    expect(normalizeMabId(42)).toBe(42);
    expect(normalizeMabId(null)).toBeNull();
    expect(normalizeMabId(undefined)).toBeUndefined();
    const object = { a: 1 };
    expect(normalizeMabId(object)).toBe(object);
  });

  it('trims surrounding whitespace, including line breaks', () => {
    expect(normalizeMabId('  FRAlder1998\r\n')).toBe('FRAlder1998');
  });

  it('decodes percent-escapes, upper or lower case', () => {
    expect(normalizeMabId('PE%C3%91andu2001')).toBe('PEÑandu2001');
    expect(normalizeMabId('pe%c3%b1andu2001')).toBe('peñandu2001');
    expect(normalizeMabId('FR%41lder1998')).toBe('FRAlder1998');
  });

  it('keeps a malformed escape as sent', () => {
    expect(normalizeMabId('%E0%A4%A')).toBe('%E0%A4%A');
    expect(normalizeMabId('50%')).toBe('50%');
  });

  it('decodes once only', () => {
    expect(normalizeMabId('%2541')).toBe('%41');
  });

  it('leaves a plus sign alone rather than reading it as a space', () => {
    expect(normalizeMabId('A+B')).toBe('A+B');
  });

  it('composes a decomposed accent to NFC, raw or percent-encoded', () => {
    const composed = 'PEÑandu2001';
    expect(normalizeMabId(composed.normalize('NFD'))).toBe(composed);
    expect(normalizeMabId('PEN%CC%83andu2001')).toBe(composed);
    expect(String(normalizeMabId(composed.normalize('NFD'))).length).toBe(composed.length);
  });

  it('leaves an already normalized id unchanged', () => {
    expect(normalizeMabId('FRAlder1998')).toBe('FRAlder1998');
  });
});

describe('mabIdInput', () => {
  it('yields the normalized string', () => {
    const result = parse(' PE%C3%91andu2001 ');
    expect(result.success && result.data.mab_id).toBe('PEÑandu2001');
  });

  it('trims whitespace that arrives percent-encoded', () => {
    const result = parse('%20FRAlder1998%0A');
    expect(result.success && result.data.mab_id).toBe('FRAlder1998');
  });

  it.each(['', '   ', '\n', '%20%20', ' %0A%09 '])('rejects a blank id %j', (value) => {
    expect(parse(value).success).toBe(false);
  });

  it('accepts 1 to 20 characters and rejects 21', () => {
    expect(parse('A').success).toBe(true);
    expect(parse('A'.repeat(20)).success).toBe(true);
    expect(parse('A'.repeat(21)).success).toBe(false);
  });

  it('measures the length after decoding, so an encoded id that decodes within 20 fits', () => {
    expect(parse('%41'.repeat(20)).success).toBe(true);
    expect(parse('%41'.repeat(21)).success).toBe(false);
  });

  it.each([42, null, undefined, true, ['FRAlder1998'], { id: 'x' }])(
    'rejects the non-string %j',
    (value) => {
      expect(parse(value).success).toBe(false);
    },
  );

  it('is required', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('advertises a bounded string with no pattern, so non-ASCII ids survive JSON Schema clients', () => {
    const json = z.toJSONSchema(schema, { io: 'input' }) as unknown as {
      properties: { mab_id: Record<string, unknown> };
      required?: string[];
    };
    expect(json.required).toEqual(['mab_id']);
    expect(json.properties.mab_id).toMatchObject({ type: 'string', minLength: 1, maxLength: 20 });
    expect(json.properties.mab_id).not.toHaveProperty('pattern');
    expect(json.properties.mab_id.description).toBe('A reserve id.');
  });
});
