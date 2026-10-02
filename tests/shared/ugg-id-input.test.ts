/**
 * @fileoverview Tests for `normalizeUggId` and `uggIdInput`: trimming and
 * uppercasing, the letters-and-digits pattern with no fixed length, the length
 * bound, no page-URL form, and the advertised JSON Schema.
 * @module tests/shared/ugg-id-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { normalizeUggId, uggIdInput } from '@/mcp-server/shared/inputs.js';

const schema = z.object({ ugg_id: uggIdInput('A geopark id.') });
const parse = (value: unknown) => schema.safeParse({ ugg_id: value });

describe('normalizeUggId', () => {
  it('passes non-strings through untouched', () => {
    expect(normalizeUggId(42)).toBe(42);
    expect(normalizeUggId(null)).toBeNull();
    expect(normalizeUggId(undefined)).toBeUndefined();
    const object = { a: 1 };
    expect(normalizeUggId(object)).toBe(object);
  });

  it('trims surrounding whitespace, including line breaks, then uppercases', () => {
    expect(normalizeUggId('  eufr10\r\n')).toBe('EUFR10');
    expect(normalizeUggId('EuA101')).toBe('EUA101');
  });

  it('leaves an already normalized id unchanged', () => {
    expect(normalizeUggId('ASCN51')).toBe('ASCN51');
  });
});

describe('uggIdInput', () => {
  it.each([
    ['a lowercase id', 'eufr10', 'EUFR10'],
    ['a padded id', ' EUFR10 ', 'EUFR10'],
    ['a transnational id', 'eua101', 'EUA101'],
    ['a longer id', 'ascn151', 'ASCN151'],
    ['a one-character id', 'a', 'A'],
  ])('yields %s normalized', (_label, value, expected) => {
    const result = parse(value);
    expect(result.success && result.data.ugg_id).toBe(expected);
  });

  it.each(['', '   ', '\n'])('rejects a blank id %j', (value) => {
    expect(parse(value).success).toBe(false);
  });

  it.each([
    ['a hyphen', 'EU-FR10'],
    ['an inner space', 'EU FR10'],
    ['a UNESCO page URL', 'https://www.unesco.org/en/iggp/arouca-unesco-global-geopark'],
    ['a percent-escape', 'EUFR%3110'],
    ['a non-ASCII letter', 'EUFRÉ10'],
  ])('rejects an id with %s', (_label, value) => {
    expect(parse(value).success).toBe(false);
  });

  it('accepts up to 20 characters and rejects 21', () => {
    expect(parse('A'.repeat(20)).success).toBe(true);
    expect(parse('A'.repeat(21)).success).toBe(false);
  });

  it.each([42, null, undefined, true, ['EUFR10'], { id: 'x' }])(
    'rejects the non-string %j',
    (value) => {
      expect(parse(value).success).toBe(false);
    },
  );

  it('is required', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('advertises a bounded letters-and-digits string that accepts either case', () => {
    const json = z.toJSONSchema(schema, { io: 'input' }) as unknown as {
      properties: { ugg_id: { pattern: string } & Record<string, unknown> };
      required?: string[];
    };
    expect(json.required).toEqual(['ugg_id']);
    expect(json.properties.ugg_id).toMatchObject({ type: 'string', maxLength: 20 });
    expect(json.properties.ugg_id.description).toBe('A geopark id.');
    const pattern = new RegExp(json.properties.ugg_id.pattern);
    expect(pattern.test('eufr10')).toBe(true);
    expect(pattern.test('EUFR10')).toBe(true);
    expect(pattern.test('EU-FR10')).toBe(false);
  });
});
