/**
 * @fileoverview Tests for the element and reserve record builders behind
 * unesco_get_intangible_heritage_element, unesco_get_biosphere_reserve, and
 * their resources: explicit field lists, optional-field omission, as-recorded
 * areas and populations, and no mutation of the source records.
 * @module tests/services/unesco-datahub/records-element-reserve.test
 */

import { describe, expect, it } from 'vitest';
import { buildElementRecord, buildReserveRecord } from '@/services/unesco-datahub/records.js';
import {
  IchRowSchema,
  MabRowSchema,
  toBiosphereReserve,
  toIntangibleElement,
} from '@/services/unesco-datahub/rows.js';
import { ichRow, mabRow } from '../../fixtures/rows.js';

const element = (overrides: Record<string, unknown> = {}) =>
  toIntangibleElement(IchRowSchema.parse(ichRow(overrides)));
const reserve = (overrides: Record<string, unknown> = {}) =>
  toBiosphereReserve(MabRowSchema.parse(mabRow(overrides)));

describe('buildElementRecord', () => {
  it('names exactly the payload fields', () => {
    expect(Object.keys(buildElementRecord(element())).sort()).toEqual([
      'concepts',
      'concepts_secondary',
      'countries',
      'country_codes',
      'description',
      'ich_ref',
      'image',
      'inscribed_year',
      'list',
      'multinational',
      'name',
      'name_fr',
      'url',
      'world_heritage_sites',
    ]);
  });

  it('carries the loaded values through unchanged', () => {
    const source = element({
      ich_public_ref: '55',
      countries: ['FR', 'BE'],
      concepts_primary_names: ['A'],
      concepts_secondary_names: ['B', 'C'],
      whc_sites: JSON.stringify([{ ref: 7, name_en: 'Site' }]),
    });
    expect(buildElementRecord(source)).toEqual({
      ich_ref: '55',
      name: 'Placeholder Element',
      name_fr: 'Element Fictif',
      list: 'Representative List',
      country_codes: ['FR', 'BE'],
      countries: ['France', 'Belgium'],
      multinational: true,
      inscribed_year: 2012,
      description: 'A synthetic practice used as test data.',
      concepts: ['A'],
      concepts_secondary: ['B', 'C'],
      world_heritage_sites: [{ id_no: '7', name: 'Site' }],
      url: 'https://ich.unesco.org/en/RL/09000',
      image: {
        url: 'https://ich.unesco.org/img/photo/thumb/9000.jpg',
        caption: 'A synthetic caption.',
        copyright: 'Synthetic Photo Agency',
        author: 'A. Tester',
      },
    });
  });

  it('omits the image key when the element has none', () => {
    const { image: _image, ...withoutImage } = element();
    const record = buildElementRecord(withoutImage as ReturnType<typeof element>);
    expect(record).not.toHaveProperty('image');
  });

  it('keeps empty concept and site lists as empty arrays, not absent', () => {
    const record = buildElementRecord(
      element({ concepts_primary_names: null, concepts_secondary_names: null, whc_sites: null }),
    );
    expect(record).toMatchObject({
      concepts: [],
      concepts_secondary: [],
      world_heritage_sites: [],
    });
  });

  it('does not mutate the source element', () => {
    const source = element();
    const before = structuredClone(source);
    buildElementRecord(source);
    expect(source).toEqual(before);
  });
});

describe('buildReserveRecord', () => {
  it('names exactly the payload fields for a fully populated reserve', () => {
    const record = buildReserveRecord(
      reserve({ website: 'https://reserve.example.test/x', extension: 2004.0 }),
    );
    expect(Object.keys(record).sort()).toEqual([
      'area_hectares',
      'country',
      'country_code',
      'designation_year',
      'ecological_characteristics',
      'extension_years',
      'introduction',
      'latitude',
      'longitude',
      'mab_id',
      'name',
      'periodic_review_years',
      'population',
      'regional_network',
      'regions',
      'renaming_years',
      'sids',
      'socio_economic_characteristics',
      'transboundary',
      'url',
      'website',
    ]);
  });

  it('omits the optional fields a reserve lacks, and keeps the year lists as empty arrays', () => {
    const record = buildReserveRecord(
      reserve({
        regional_network: null,
        ecological_characteristics_en: null,
        socio_economic_characteristics_en: '',
        website: null,
      }),
    );
    for (const key of [
      'regional_network',
      'ecological_characteristics',
      'socio_economic_characteristics',
      'website',
    ]) {
      expect(record, key).not.toHaveProperty(key);
    }
    expect(record).toMatchObject({
      extension_years: [],
      renaming_years: [],
      periodic_review_years: [],
    });
  });

  it('passes areas and populations through as recorded, whatever the zone sums', () => {
    const record = buildReserveRecord(
      reserve({
        area_total: 1,
        area_total_terrestrial: 2,
        area_core_terrestrial: 30,
        area_total_marine: 4,
        population_total: 0,
        population_core: 9,
      }),
    );
    expect(record.area_hectares).toMatchObject({
      total: 1,
      terrestrial: { total: 2, core: 30 },
      marine: { total: 4 },
    });
    expect(record.population).toMatchObject({ total: 0, core: 9 });
  });

  it('decodes fused extension years and splits periodic-review years', () => {
    const record = buildReserveRecord(
      reserve({
        extension: 2004.2016,
        renaming: 2010.0,
        periodic_review: '2010; 2020, March 2025',
      }),
    );
    expect(record).toMatchObject({
      extension_years: [2004, 2016],
      renaming_years: [2010],
      periodic_review_years: [2010, 2020, 2025],
    });
  });

  it('does not mutate the source reserve', () => {
    const source = reserve();
    const before = structuredClone(source);
    buildReserveRecord(source);
    expect(source).toEqual(before);
  });
});
