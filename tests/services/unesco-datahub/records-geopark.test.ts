/**
 * @fileoverview Tests for the geopark record builder behind unesco_get_geopark
 * and its resource: the explicit field list, optional-field omission, area and
 * population passed through as recorded, and no mutation of the source record.
 * @module tests/services/unesco-datahub/records-geopark.test
 */

import { describe, expect, it } from 'vitest';
import { buildGeoparkRecord } from '@/services/unesco-datahub/records.js';
import { EgRowSchema, toGeopark } from '@/services/unesco-datahub/rows.js';
import { EG_ROWS, egRow } from '../../fixtures/rows.js';

const geopark = (overrides: Record<string, unknown> = {}) =>
  toGeopark(EgRowSchema.parse(egRow(overrides)));

describe('buildGeoparkRecord', () => {
  it('names exactly the payload fields for a fully populated geopark', () => {
    expect(Object.keys(buildGeoparkRecord(geopark())).sort()).toEqual([
      'area_hectares',
      'countries',
      'country_codes',
      'description',
      'designation_year',
      'introduction',
      'latitude',
      'longitude',
      'name',
      'population',
      'sustaining_local_communities',
      'transnational',
      'ugg_id',
      'url',
      'website',
    ]);
  });

  it('carries the loaded values through unchanged', () => {
    const source = geopark({ ugg_id: 'EUA301', countries: ['HU,SK'], transnational: 'True' });
    expect(buildGeoparkRecord(source)).toEqual({
      ugg_id: 'EUA301',
      name: 'Placeholder UNESCO Global Geopark',
      country_codes: ['HU', 'SK'],
      countries: ['Hungary', 'Slovakia'],
      transnational: true,
      designation_year: 2019,
      area_hectares: 50_000,
      population: 20_000,
      latitude: 45,
      longitude: 3,
      introduction: 'A synthetic geopark used as test data.',
      description: 'Synthetic limestone and fossil beds.',
      sustaining_local_communities: 'Synthetic villages run guided geotourism.',
      website: 'https://geopark.example.test/placeholder',
      url: 'https://www.unesco.org/en/iggp/placeholder-unesco-global-geopark',
    });
  });

  it('omits population and website for the sparse row', () => {
    const sparse = EG_ROWS.find((r) => r.ugg_id === 'ASJP91');
    const record = buildGeoparkRecord(toGeopark(EgRowSchema.parse(sparse)));
    expect(record).not.toHaveProperty('population');
    expect(record).not.toHaveProperty('website');
  });

  it('keeps a zero population and an outsized area as recorded', () => {
    expect(buildGeoparkRecord(geopark({ population: 0, area_total: 27_000_000 }))).toMatchObject({
      population: 0,
      area_hectares: 27_000_000,
    });
  });

  it('copies no field outside the payload list', () => {
    const source = { ...geopark(), folded: 'internal' } as ReturnType<typeof geopark>;
    expect(buildGeoparkRecord(source)).not.toHaveProperty('folded');
  });

  it('does not mutate the source geopark', () => {
    const source = geopark();
    const before = structuredClone(source);
    buildGeoparkRecord(source);
    expect(source).toEqual(before);
  });
});
