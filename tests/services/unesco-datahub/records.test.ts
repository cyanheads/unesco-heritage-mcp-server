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
    buildSiteRecord(source, 1);
    expect(source.components).toHaveLength(3);
    expect(source.criteria).toEqual(['ii', 'iv']);
  });
});
