/**
 * @fileoverview Tests for the full-record builder behind unesco_get_site and
 * the site resource.
 * @module tests/services/unesco-datahub/records.test
 */

import { describe, expect, it } from 'vitest';
import { buildSiteRecord, sitePageUrl } from '@/services/unesco-datahub/records.js';
import { toHeritageSite, WhcRowSchema } from '@/services/unesco-datahub/rows.js';
import { CRITERIA } from '@/services/unesco-datahub/vocabulary.js';
import { WHC_ROWS, whcRow } from '../../fixtures/rows.js';

const site = (id: string) => {
  const row = WHC_ROWS.find((r) => r.id_no === id) ?? whcRow();
  return toHeritageSite(WhcRowSchema.parse(row)).site;
};

describe('sitePageUrl', () => {
  it('builds the English UNESCO page URL with a trailing slash', () => {
    expect(sitePageUrl('101')).toBe('https://whc.unesco.org/en/list/101/');
  });
});

describe('buildSiteRecord', () => {
  it('turns criteria into code/meaning/source triples in numeral order', () => {
    const record = buildSiteRecord(site('104'), 20);
    expect(record.criteria).toEqual([
      { code: 'i', meaning: CRITERIA.i.meaning, source: 'recorded' },
      { code: 'iii', meaning: CRITERIA.iii.meaning, source: 'recorded' },
      { code: 'vi', meaning: CRITERIA.vi.meaning, source: 'inferred' },
    ]);
  });

  it('marks an all-inferred criteria list', () => {
    const record = buildSiteRecord(site('103'), 20);
    expect(record.criteria).toEqual([
      { code: 'vi', meaning: CRITERIA.vi.meaning, source: 'inferred' },
    ]);
  });

  it('yields an empty criteria list for a site with none', () => {
    const record = buildSiteRecord(
      toHeritageSite(WhcRowSchema.parse(whcRow({ criteria_txt: null, justification_en: null })))
        .site,
      20,
    );
    expect(record.criteria).toEqual([]);
  });

  it('names exactly the payload fields, in the order the resource serializes them', () => {
    expect(Object.keys(buildSiteRecord(site('101'), 20))).toEqual([
      'id_no',
      'name',
      'names',
      'category',
      'states',
      'country_codes',
      'region',
      'transboundary',
      'inscribed_year',
      'secondary_years',
      'in_danger',
      'area_hectares',
      'latitude',
      'longitude',
      'description',
      'justification',
      'components_total',
      'components_unparsed',
      'image',
      'criteria',
      'components',
      'url',
    ]);
  });

  it('carries the page URL and drops the internal criteria_inferred field', () => {
    const record = buildSiteRecord(site('101'), 20);
    expect(record.url).toBe('https://whc.unesco.org/en/list/101/');
    expect(record).not.toHaveProperty('criteria_inferred');
  });

  it.each([
    [0, 0],
    [2, 2],
    [3, 3],
    [1000, 3],
  ])('lists at most max_components=%d components (%d of 3 here)', (max, expected) => {
    const record = buildSiteRecord(site('101'), max);
    expect(record.components).toHaveLength(expected);
    expect(record.components_total).toBe(3);
  });

  it('keeps upstream component order when capping', () => {
    const record = buildSiteRecord(site('101'), 2);
    expect(record.components.map((c) => c.ref)).toEqual(['101-001', '101-002']);
  });

  it('passes the parsed-component gap through as components_unparsed', () => {
    const record = buildSiteRecord(site('108'), 20);
    expect(record.components_unparsed).toBe(1);
    expect(record.components_total).toBe(5);
    expect(record.components).toHaveLength(4);
  });

  it('does not mutate the source site', () => {
    const source = site('101');
    buildSiteRecord(source, 1, 'fr');
    expect(source.components).toHaveLength(3);
    expect(source.criteria).toEqual(['ii', 'iv']);
    expect(source.description).toBe('A synthetic walled town used as test data.');
  });
});

describe('buildSiteRecord — description language', () => {
  const fromRow = (overrides: Record<string, unknown>) =>
    toHeritageSite(WhcRowSchema.parse(whcRow(overrides))).site;

  it.each([
    ['en', 'A synthetic walled town used as test data.'],
    ['fr', 'Une ville fortifiée synthétique utilisée comme données de test.'],
    ['es', 'Una ciudad amurallada sintética usada como datos de prueba.'],
    ['ru', 'Синтетический город-крепость для тестовых данных.'],
    ['ar', 'مدينة مسورة اصطناعية تستخدم كبيانات اختبار.'],
    ['zh', '用作测试数据的合成城墙小镇。'],
  ] as const)('returns the %s description and names its language', (language, text) => {
    const record = buildSiteRecord(site('101'), 20, language);
    expect(record.description).toBe(text);
    expect(record.description_language).toBe(language);
  });

  it('falls back to the English description, labelled en, when the language is unpublished', () => {
    const record = buildSiteRecord(site('102'), 20, 'zh');
    expect(record.description).toBe('A synthetic forest shared by two states.');
    expect(record.description_language).toBe('en');
  });

  it('returns neither field when there is no text in the language or in English', () => {
    for (const language of ['fr', 'en'] as const) {
      const record = buildSiteRecord(site('105'), 20, language);
      expect(record).not.toHaveProperty('description');
      expect(record).not.toHaveProperty('description_language');
    }
  });

  it('returns a published translation when the English text is missing, and neither field for an unpublished one', () => {
    const translatedOnly = fromRow({ short_description_en: null, short_description_es: 'Sólo.' });
    expect(buildSiteRecord(translatedOnly, 20, 'es')).toMatchObject({
      description: 'Sólo.',
      description_language: 'es',
    });
    const none = buildSiteRecord(translatedOnly, 20, 'ru');
    expect(none).not.toHaveProperty('description');
    expect(none).not.toHaveProperty('description_language');
  });

  it('never carries the loaded translations, with or without a language', () => {
    for (const language of [undefined, 'fr'] as const) {
      expect(buildSiteRecord(site('101'), 20, language)).not.toHaveProperty(
        'description_translations',
      );
    }
  });

  it('leaves every other field as the English call builds it', () => {
    const { description: _en, ...english } = buildSiteRecord(site('101'), 20);
    const {
      description: _fr,
      description_language: _language,
      ...french
    } = buildSiteRecord(site('101'), 20, 'fr');
    expect(french).toEqual(english);
  });
});
