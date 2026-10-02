/**
 * @fileoverview Tests for the shared input schemas: blank-as-unset wrapping,
 * enum folding, country/region/year/query/pagination/boolean inputs, the `near`
 * point, and the record-id normalizers.
 * @module tests/shared/inputs.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  blankAsUnset,
  booleanInput,
  countryInput,
  cursorInput,
  foldToEnum,
  ichRefInput,
  idNoInput,
  includeDescriptionInput,
  isBlank,
  limitInput,
  nearInput,
  normalizeIchRef,
  normalizeWhcId,
  optionalIdNoInput,
  queryInput,
  regionInput,
  yearInput,
} from '@/mcp-server/shared/inputs.js';

/** Parses a single value through a schema wrapped in an object, as a tool input does. */
function parseField(schema: z.ZodType, value: unknown) {
  const wrapper = z.object({ v: schema });
  return wrapper.safeParse(value === undefined ? {} : { v: value });
}

const parsed = (schema: z.ZodType, value: unknown) => {
  const result = parseField(schema, value);
  if (!result.success) throw new Error(`expected success: ${result.error.message}`);
  return (result.data as { v: unknown }).v;
};

const rejects = (schema: z.ZodType, value: unknown) => parseField(schema, value).success === false;

describe('isBlank', () => {
  it('is true only for empty or whitespace-only strings', () => {
    expect(isBlank('')).toBe(true);
    expect(isBlank('  \t\n')).toBe(true);
    expect(isBlank('x')).toBe(false);
    expect(isBlank(0)).toBe(false);
    expect(isBlank(null)).toBe(false);
    expect(isBlank(undefined)).toBe(false);
    expect(isBlank([])).toBe(false);
  });
});

describe('blankAsUnset', () => {
  it('turns blank strings into unset for an optional schema', () => {
    const schema = blankAsUnset(z.string().optional());
    expect(parsed(schema, '')).toBeUndefined();
    expect(parsed(schema, '   ')).toBeUndefined();
    expect(parsed(schema, 'x')).toBe('x');
    expect(parsed(schema, undefined)).toBeUndefined();
  });

  it('lets a default apply when the value is blank', () => {
    const schema = blankAsUnset(z.number().int().default(7));
    expect(parsed(schema, '')).toBe(7);
    expect(parsed(schema, undefined)).toBe(7);
    expect(parsed(schema, 3)).toBe(3);
  });

  it('keeps the wrapped key out of the required list of the advertised JSON schema', () => {
    const json = z.toJSONSchema(
      z.object({ a: blankAsUnset(z.string().optional()), b: blankAsUnset(z.number().default(1)) }),
      {
        io: 'input',
      },
    ) as { required?: string[] };
    expect(json.required ?? []).toEqual([]);
  });

  it('runs the normalizer only for non-blank values', () => {
    const seen: unknown[] = [];
    const schema = blankAsUnset(z.string().optional(), (v) => {
      seen.push(v);
      return String(v).toUpperCase();
    });
    expect(parsed(schema, 'ab')).toBe('AB');
    expect(parsed(schema, '')).toBeUndefined();
    expect(seen).toEqual(['ab']);
  });

  it('does not coerce non-string values', () => {
    expect(rejects(blankAsUnset(z.number().optional()), '5')).toBe(true);
  });
});

describe('foldToEnum', () => {
  const fold = foldToEnum(['Cultural', 'Natural'], { c: 'Cultural' });

  it('folds case and trims to the enum spelling', () => {
    expect(fold(' cultural ')).toBe('Cultural');
    expect(fold('NATURAL')).toBe('Natural');
  });

  it('maps aliases case-insensitively', () => {
    expect(fold('C')).toBe('Cultural');
  });

  it('passes unknown strings (trimmed) and non-strings through', () => {
    expect(fold(' Hybrid ')).toBe('Hybrid');
    expect(fold(7)).toBe(7);
    expect(fold(undefined)).toBeUndefined();
  });
});

describe('regionInput', () => {
  const schema = regionInput('A region.');

  it.each([
    ['Africa', 'Africa'],
    ['africa', 'Africa'],
    ['  ARAB STATES ', 'Arab States'],
    ['AFR', 'Africa'],
    ['arb', 'Arab States'],
    ['Apa', 'Asia and the Pacific'],
    ['EUR', 'Europe and North America'],
    ['lac', 'Latin America and the Caribbean'],
    ['europe and north america', 'Europe and North America'],
  ])('maps %j to %j', (input, expected) => {
    expect(parsed(schema, input)).toBe(expected);
  });

  it('reads blank as unset and rejects an unknown region', () => {
    expect(parsed(schema, '')).toBeUndefined();
    expect(parsed(schema, '   ')).toBeUndefined();
    expect(parsed(schema, undefined)).toBeUndefined();
    expect(rejects(schema, 'Atlantis')).toBe(true);
    expect(rejects(schema, 'Europe')).toBe(true);
  });
});

describe('countryInput', () => {
  const schema = countryInput('A country.');

  it('normalizes alpha-3 and mixed case to alpha-2', () => {
    expect(parsed(schema, 'fra')).toBe('FR');
    expect(parsed(schema, ' De ')).toBe('DE');
    expect(parsed(schema, 'uk')).toBe('GB');
  });

  it('passes a name through for the handler to reject with its recovery hint', () => {
    expect(parsed(schema, 'France')).toBe('France');
  });

  it('reads blank as unset', () => {
    expect(parsed(schema, '')).toBeUndefined();
    expect(parsed(schema, '  ')).toBeUndefined();
  });

  it('rejects a value over 64 characters and a non-string', () => {
    expect(rejects(schema, 'x'.repeat(65))).toBe(true);
    expect(parsed(schema, 'x'.repeat(64))).toBe('x'.repeat(64));
    expect(rejects(schema, 33)).toBe(true);
  });
});

describe('yearInput', () => {
  const schema = yearInput('A year.');

  it('accepts the 1900–2100 bounds and unset', () => {
    expect(parsed(schema, 1900)).toBe(1900);
    expect(parsed(schema, 2100)).toBe(2100);
    expect(parsed(schema, '')).toBeUndefined();
    expect(parsed(schema, undefined)).toBeUndefined();
  });

  it.each([1899, 2101, 1990.5, -1, Number.NaN])('rejects %s', (value) => {
    expect(rejects(schema, value)).toBe(true);
  });
});

describe('queryInput', () => {
  const schema = queryInput('A query.');

  it('trims, reads blank as unset, and enforces 200 characters', () => {
    expect(parsed(schema, '  old town  ')).toBe('old town');
    expect(parsed(schema, '')).toBeUndefined();
    expect(parsed(schema, '   ')).toBeUndefined();
    expect(parsed(schema, 'x'.repeat(200))).toBe('x'.repeat(200));
    expect(rejects(schema, 'x'.repeat(201))).toBe(true);
  });

  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  /** ⑴ … (U+2474 onward): each folds to a parenthesized number, one distinct word per character. */
  const parenthesizedNumbers = (n: number) =>
    String.fromCodePoint(...Array.from({ length: n }, (_, i) => 0x2474 + i));

  it('accepts 16 distinct words and rejects 17 with a message saying to use fewer', () => {
    expect(parsed(schema, words(16))).toBe(words(16));
    const result = parseField(schema, words(17));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message).join(' ')).toContain(
      'at most 16 distinct words',
    );
  });

  it('counts a repeated word once, however it is spelled or repeated', () => {
    const repeated = Array.from({ length: 100 }, () => 'x').join(' ');
    expect(parsed(schema, repeated)).toBe(repeated);
    expect(parsed(schema, 'Town TOWN town Tówn')).toBe('Town TOWN town Tówn');
    const folded = String.fromCodePoint(0x24b3).repeat(200);
    expect(parsed(schema, folded)).toBe(folded);
  });

  it('counts words after folding, so a character that expands into a word counts as one', () => {
    expect(parsed(schema, parenthesizedNumbers(16))).toBe(parenthesizedNumbers(16));
    expect(rejects(schema, parenthesizedNumbers(17))).toBe(true);
  });

  it('applies the same cap to a shorter filter', () => {
    const filter = queryInput('A filter.', 100);
    expect(parsed(filter, words(16))).toBe(words(16));
    expect(rejects(filter, words(17))).toBe(true);
  });
});

describe('limitInput / cursorInput', () => {
  it('defaults limit to 20 for unset and blank', () => {
    expect(parsed(limitInput, undefined)).toBe(20);
    expect(parsed(limitInput, '')).toBe(20);
    expect(parsed(limitInput, '  ')).toBe(20);
  });

  it('accepts 1–50 and rejects everything else', () => {
    expect(parsed(limitInput, 1)).toBe(1);
    expect(parsed(limitInput, 50)).toBe(50);
    for (const bad of [0, 51, -3, 2.5, null, '10'])
      expect(rejects(limitInput, bad), String(bad)).toBe(true);
  });

  it('reads a blank cursor as unset and caps it at 1024 characters', () => {
    expect(parsed(cursorInput, '')).toBeUndefined();
    expect(parsed(cursorInput, ' ')).toBeUndefined();
    expect(parsed(cursorInput, 'abc')).toBe('abc');
    expect(parsed(cursorInput, 'x'.repeat(1024))).toBe('x'.repeat(1024));
    expect(rejects(cursorInput, 'x'.repeat(1025))).toBe(true);
  });
});

describe('booleanInput', () => {
  const schema = booleanInput('A flag.');

  it('accepts real booleans and reads blank as unset', () => {
    expect(parsed(schema, true)).toBe(true);
    expect(parsed(schema, false)).toBe(false);
    expect(parsed(schema, '')).toBeUndefined();
    expect(parsed(schema, undefined)).toBeUndefined();
  });

  it('does not coerce strings', () => {
    expect(rejects(schema, 'true')).toBe(true);
    expect(rejects(schema, 1)).toBe(true);
  });
});

describe('includeDescriptionInput', () => {
  const schema = includeDescriptionInput('Rows omit the text when false.');

  it('defaults to true when unset or blank and keeps an explicit boolean', () => {
    expect(parsed(schema, undefined)).toBe(true);
    expect(parsed(schema, '')).toBe(true);
    expect(parsed(schema, '  ')).toBe(true);
    expect(parsed(schema, true)).toBe(true);
    expect(parsed(schema, false)).toBe(false);
  });

  it('rejects a non-boolean without coercing it', () => {
    for (const value of ['false', 'true', 0, 1, null]) expect(rejects(schema, value)).toBe(true);
  });

  it('advertises a boolean defaulting to true, out of the required list, with the given description', () => {
    const json = z.toJSONSchema(z.object({ v: schema }), { io: 'input' }) as unknown as {
      properties: { v: { default?: unknown; description?: string; type?: string } };
      required?: string[];
    };
    expect(json.required ?? []).toEqual([]);
    expect(json.properties.v).toMatchObject({
      type: 'boolean',
      default: true,
      description: 'Rows omit the text when false.',
    });
  });
});

describe('nearInput', () => {
  const schema = nearInput('A point.');

  it('reads undefined and blank shapes as unset', () => {
    expect(parsed(schema, undefined)).toBeUndefined();
    expect(parsed(schema, '')).toBeUndefined();
    expect(parsed(schema, {})).toBeUndefined();
    expect(parsed(schema, { latitude: '', longitude: '', radius_km: '' })).toBeUndefined();
    expect(
      parsed(schema, { latitude: ' ', longitude: null, radius_km: undefined }),
    ).toBeUndefined();
  });

  it('defaults the radius to 100 km, including when the radius is blank', () => {
    expect(parsed(schema, { latitude: 10, longitude: 20 })).toEqual({
      latitude: 10,
      longitude: 20,
      radius_km: 100,
    });
    expect(parsed(schema, { latitude: 10, longitude: 20, radius_km: '' })).toEqual({
      latitude: 10,
      longitude: 20,
      radius_km: 100,
    });
  });

  it('keeps an explicit radius and the coordinate bounds', () => {
    expect(parsed(schema, { latitude: -90, longitude: 180, radius_km: 5000 })).toEqual({
      latitude: -90,
      longitude: 180,
      radius_km: 5000,
    });
  });

  it.each([
    ['latitude above 90', { latitude: 90.1, longitude: 0 }],
    ['latitude below -90', { latitude: -91, longitude: 0 }],
    ['longitude above 180', { latitude: 0, longitude: 181 }],
    ['longitude below -180', { latitude: 0, longitude: -180.5 }],
    ['zero radius', { latitude: 0, longitude: 0, radius_km: 0 }],
    ['negative radius', { latitude: 0, longitude: 0, radius_km: -1 }],
    ['radius above 5000', { latitude: 0, longitude: 0, radius_km: 5001 }],
    ['a partly blank object (longitude missing)', { latitude: 10, longitude: '' }],
    ['a partly blank object (latitude missing)', { latitude: '', longitude: 10 }],
    ['an unknown key', { latitude: 0, longitude: 0, radius: 5 }],
    ['string coordinates', { latitude: '10', longitude: '20' }],
    ['null', null],
    ['an array', []],
  ])('rejects %s', (_label, value) => {
    expect(rejects(schema, value)).toBe(true);
  });
});

describe('record id normalizers', () => {
  it.each([
    [101, '101'],
    [' 0101 ', '101'],
    ['000', '0'],
    ['0', '0'],
    ['https://whc.unesco.org/en/list/101/', '101'],
    ['http://www.whc.unesco.org/fr/list/0101', '101'],
    ['whc.unesco.org/en/list/101', '101'],
    ['https://whc.unesco.org/en/list/101/?x=1', '101'],
    ['https://whc.unesco.org/en/list/101#anchor', '101'],
    ['HTTPS://WHC.UNESCO.ORG/EN/LIST/101/', '101'],
    ['https://whc.unesco.org/zh-cn/list/12', '12'],
    ['https://whc.unesco.org/en/list/162/gallery/', '162'],
    ['https://whc.unesco.org/en/list/162/documents/', '162'],
    ['whc.unesco.org/fr/list/162/maps', '162'],
    ['https://whc.unesco.org/en/list/162/gallery/?index=2#top', '162'],
  ])('normalizeWhcId(%j) = %j', (input, expected) => {
    expect(normalizeWhcId(input)).toBe(expected);
  });

  it.each([
    ['https://example.test/en/list/101/', 'https://example.test/en/list/101/'],
    [
      'https://whc.unesco.org.evil.test/en/list/101/',
      'https://whc.unesco.org.evil.test/en/list/101/',
    ],
    ['abc', 'abc'],
    ['10 1', '10 1'],
    ['https://whc.unesco.org/en/list/162abc/', 'https://whc.unesco.org/en/list/162abc/'],
    ['https://whc.unesco.org/en/list/', 'https://whc.unesco.org/en/list/'],
    ['https://whc.unesco.org/en/list/gallery/162/', 'https://whc.unesco.org/en/list/gallery/162/'],
  ])('normalizeWhcId leaves %j unrecognized', (input, expected) => {
    expect(normalizeWhcId(input)).toBe(expected);
  });

  it('passes a non-integer number and other types through', () => {
    expect(normalizeWhcId(1.5)).toBe(1.5);
    expect(normalizeWhcId(undefined)).toBeUndefined();
    expect(normalizeWhcId(null)).toBeNull();
  });

  it.each([
    [1003, '1003'],
    ['https://ich.unesco.org/en/RL/09000', '9000'],
    ['https://ich.unesco.org/fr/USL/00123', '123'],
    ['ich.unesco.org/en/Art18/01003/', '1003'],
    ['https://ich.unesco.org/en/rl/00042', '42'],
    [' 0042 ', '42'],
    ['https://ich.unesco.org/en/RL/example-element-name-01964', '1964'],
    ['https://ich.unesco.org/fr/USL/une-pratique-de-2-villages-00123/', '123'],
    ['ich.unesco.org/en/Art18/register-of-practices-01003?lg=en', '1003'],
  ])('normalizeIchRef(%j) = %j', (input, expected) => {
    expect(normalizeIchRef(input)).toBe(expected);
  });

  it.each([
    'https://ich.unesco.org/en/RL/example-element-name',
    'https://ich.unesco.org/en/RL/example-element-name-01964/extra',
    'https://ich.unesco.org/en/RL/01964abc',
  ])('normalizeIchRef leaves %j unrecognized', (input) => {
    expect(normalizeIchRef(input)).toBe(input);
  });

  it('does not treat a World Heritage page URL as an element URL, or the reverse', () => {
    expect(normalizeIchRef('https://whc.unesco.org/en/list/101/')).toBe(
      'https://whc.unesco.org/en/list/101/',
    );
    expect(normalizeWhcId('https://ich.unesco.org/en/RL/09000')).toBe(
      'https://ich.unesco.org/en/RL/09000',
    );
  });
});

describe('idNoInput / ichRefInput / optionalIdNoInput', () => {
  const idNo = idNoInput('An id.');
  const ichRef = ichRefInput('A ref.');
  const optional = optionalIdNoInput('An optional id.');

  it('requires the value: absent and blank are rejected', () => {
    expect(rejects(idNo, undefined)).toBe(true);
    expect(rejects(idNo, '')).toBe(true);
    expect(rejects(ichRef, undefined)).toBe(true);
    expect(rejects(ichRef, '  ')).toBe(true);
  });

  it('accepts numbers, digit strings, and page URLs', () => {
    expect(parsed(idNo, 101)).toBe('101');
    expect(parsed(idNo, '0101')).toBe('101');
    expect(parsed(idNo, 'https://whc.unesco.org/en/list/1810/')).toBe('1810');
    expect(parsed(ichRef, 2474)).toBe('2474');
    expect(parsed(ichRef, 'https://ich.unesco.org/en/RL/00042')).toBe('42');
  });

  it('accepts an element page URL with its title slug and a site sub-page URL', () => {
    expect(parsed(ichRef, 'https://ich.unesco.org/en/RL/example-element-name-01964')).toBe('1964');
    expect(parsed(idNo, 'https://whc.unesco.org/en/list/162/gallery/')).toBe('162');
    expect(parsed(optional, 'https://whc.unesco.org/en/list/162/documents/')).toBe('162');
  });

  it('enforces one to five digits without a leading zero', () => {
    expect(parsed(idNo, '99999')).toBe('99999');
    for (const bad of ['100000', '0', '000', 'abc', '1e3', '-5', '1.5', '10 1', 0, -1, 1.5]) {
      expect(rejects(idNo, bad), String(bad)).toBe(true);
    }
    expect(rejects(ichRef, '123456')).toBe(true);
  });

  it('reads a blank optional id as unset and still validates a real one', () => {
    expect(parsed(optional, '')).toBeUndefined();
    expect(parsed(optional, undefined)).toBeUndefined();
    expect(parsed(optional, 'https://whc.unesco.org/en/list/101')).toBe('101');
    expect(rejects(optional, 'abc')).toBe(true);
  });
});
