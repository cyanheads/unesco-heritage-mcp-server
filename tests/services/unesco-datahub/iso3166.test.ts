/**
 * @fileoverview Tests for the bundled ISO 3166-1 table and the country
 * normalizer/validity/display helpers.
 * @module tests/services/unesco-datahub/iso3166.test
 */

import { describe, expect, it } from 'vitest';
import {
  alpha3Of,
  countryDisplayName,
  ISO_3166_PAIRS,
  isAssignedAlpha2,
  normalizeCountry,
} from '@/services/unesco-datahub/iso3166.js';
import { ICH_ROWS, MAB_ROWS, WHC_ROWS } from '../../fixtures/rows.js';

describe('ISO_3166_PAIRS', () => {
  it('bundles the 249 assigned pairs', () => {
    expect(ISO_3166_PAIRS).toHaveLength(249);
  });

  it('has unique, well-formed alpha-2 and alpha-3 codes', () => {
    const a2 = ISO_3166_PAIRS.map(([a]) => a);
    const a3 = ISO_3166_PAIRS.map(([, b]) => b);
    expect(new Set(a2).size).toBe(249);
    expect(new Set(a3).size).toBe(249);
    for (const code of a2) expect(code).toMatch(/^[A-Z]{2}$/);
    for (const code of a3) expect(code).toMatch(/^[A-Z]{3}$/);
  });

  it('maps every alpha-3 back to its alpha-2 through the normalizer', () => {
    for (const [a2, a3] of ISO_3166_PAIRS) {
      expect(normalizeCountry(a3)).toBe(a2);
      expect(alpha3Of(a2)).toBe(a3);
      expect(isAssignedAlpha2(a2)).toBe(true);
    }
  });

  it('carries every code the synthetic fixtures use', () => {
    const codes = new Set<string>();
    for (const row of WHC_ROWS) {
      const iso = row.iso_codes as string | null;
      for (const c of iso?.split(',') ?? []) codes.add(c.trim());
    }
    for (const row of ICH_ROWS) for (const c of row.countries as string[]) codes.add(c);
    for (const row of MAB_ROWS) codes.add(row.iso2 as string);
    expect(codes.size).toBeGreaterThan(5);
    for (const code of codes) expect(isAssignedAlpha2(code), code).toBe(true);
  });
});

describe('normalizeCountry', () => {
  it.each([
    ['fr', 'FR'],
    ['FR', 'FR'],
    ['  fr  ', 'FR'],
    ['fra', 'FR'],
    ['FRA', 'FR'],
    ['Deu', 'DE'],
    ['UK', 'GB'],
    ['uk', 'GB'],
    ['GBR', 'GB'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeCountry(input)).toBe(expected);
  });

  it('uppercases an unassigned three-letter value without mapping it', () => {
    expect(normalizeCountry('zzz')).toBe('ZZZ');
  });

  it('leaves names and other shapes unchanged apart from trimming', () => {
    expect(normalizeCountry(' France ')).toBe('France');
    expect(normalizeCountry('F1')).toBe('F1');
    expect(normalizeCountry('FRAN')).toBe('FRAN');
    expect(normalizeCountry('')).toBe('');
  });

  it('passes non-strings through untouched', () => {
    expect(normalizeCountry(undefined)).toBeUndefined();
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(33)).toBe(33);
  });
});

describe('isAssignedAlpha2', () => {
  it('accepts assigned codes and rejects everything else', () => {
    expect(isAssignedAlpha2('FR')).toBe(true);
    expect(isAssignedAlpha2('ZZ')).toBe(false);
    expect(isAssignedAlpha2('fr')).toBe(false);
    expect(isAssignedAlpha2('FRA')).toBe(false);
    expect(isAssignedAlpha2('')).toBe(false);
  });

  it('does not treat UK as assigned (the normalizer maps it to GB)', () => {
    expect(isAssignedAlpha2('UK')).toBe(false);
    expect(isAssignedAlpha2('GB')).toBe(true);
  });
});

describe('alpha3Of', () => {
  it('returns the alpha-3 for an assigned alpha-2 and undefined otherwise', () => {
    expect(alpha3Of('FR')).toBe('FRA');
    expect(alpha3Of('ZZ')).toBeUndefined();
  });
});

describe('countryDisplayName', () => {
  it('names assigned codes in English', () => {
    expect(countryDisplayName('FR')).toBe('France');
    expect(countryDisplayName('DE')).toBe('Germany');
  });

  it('returns a non-empty string for every bundled code', () => {
    for (const [a2] of ISO_3166_PAIRS) expect(countryDisplayName(a2).length).toBeGreaterThan(0);
  });
});
