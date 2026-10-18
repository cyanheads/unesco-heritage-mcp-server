/**
 * @fileoverview Tests for the shared enrichment fields: the sources schema and
 * trailer line, the page fields, the composed page notice with its leading
 * `limit` clamp fragment, and the get tools' description-language fragment.
 * @module tests/shared/enrichment.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  composePageNotice,
  descriptionLanguageFragment,
  pageEnrichment,
  renderSources,
  sourcesField,
  sourcesFieldOf,
} from '@/mcp-server/shared/enrichment.js';
import { clampBudget, LIMIT_BUDGET } from '@/mcp-server/shared/inputs.js';
import type { SourceEntry } from '@/services/unesco-datahub/types.js';
import { DATASET_IDS } from '@/services/unesco-datahub/vocabulary.js';

const entry = (overrides: Partial<SourceEntry> = {}): SourceEntry => ({
  dataset: 'whc001',
  title: 'World Heritage List',
  data_as_of: '2026-09-30T02:06:00+00:00',
  license: 'CC BY-SA 4.0',
  attribution: 'UNESCO — World Heritage List (whc001), UNESCO Data Hub, CC BY-SA 4.0',
  ...overrides,
});

describe('sourcesField', () => {
  it('accepts entries for the three datasets and an empty list', () => {
    expect(
      sourcesField.safeParse([entry(), entry({ dataset: 'ich001' }), entry({ dataset: 'mab001' })])
        .success,
    ).toBe(true);
    expect(sourcesField.safeParse([]).success).toBe(true);
  });

  it('rejects an unknown dataset and a missing field', () => {
    expect(sourcesField.safeParse([entry({ dataset: 'geo001' as 'whc001' })]).success).toBe(false);
    const { attribution: _omitted, ...partial } = entry();
    expect(sourcesField.safeParse([partial]).success).toBe(false);
  });

  it('keeps its advertised dataset enum at the three datasets those tools return', () => {
    expect(z.toJSONSchema(sourcesField)).toMatchObject({
      items: { properties: { dataset: { enum: ['whc001', 'ich001', 'mab001'] } } },
    });
    expect(sourcesField.safeParse([entry({ dataset: 'eg0001' })]).success).toBe(false);
  });
});

describe('sourcesFieldOf', () => {
  it('advertises exactly the datasets it is given', () => {
    const geoparks = sourcesFieldOf(['eg0001']);
    expect(z.toJSONSchema(geoparks)).toMatchObject({
      items: { properties: { dataset: { enum: ['eg0001'] } } },
    });
    expect(geoparks.safeParse([entry({ dataset: 'eg0001' })]).success).toBe(true);
    expect(geoparks.safeParse([entry()]).success).toBe(false);
  });

  it('accepts every dataset id when given them all', () => {
    const all = sourcesFieldOf(DATASET_IDS);
    expect(all.safeParse(DATASET_IDS.map((dataset) => entry({ dataset }))).success).toBe(true);
  });
});

describe('renderSources', () => {
  it('renders one trailer line per dataset with title, date, license, and license URL', () => {
    expect(renderSources([entry()])).toBe(
      'Source: UNESCO — World Heritage List (whc001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/',
    );
  });

  it('joins several datasets with newlines, in order', () => {
    const lines = renderSources([
      entry(),
      entry({ dataset: 'mab001', title: 'Man and the Biosphere Programme' }),
    ]).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('(whc001)');
    expect(lines[1]).toContain('Man and the Biosphere Programme (mab001)');
  });

  it('renders nothing for an empty list', () => {
    expect(renderSources([])).toBe('');
  });
});

describe('pageEnrichment', () => {
  const schema = z.object(pageEnrichment);
  const valid = { sources: [entry()], totalCount: 0, truncated: false, shown: 0, cap: 20 };

  it('requires sources, totalCount, truncated, shown, and cap', () => {
    expect(schema.safeParse(valid).success).toBe(true);
    for (const key of ['sources', 'totalCount', 'truncated', 'shown', 'cap'] as const) {
      const { [key]: _omitted, ...rest } = valid;
      expect(schema.safeParse(rest).success, key).toBe(false);
    }
  });

  it('treats notice as optional', () => {
    expect(schema.safeParse({ ...valid, notice: 'x' }).success).toBe(true);
  });
});

describe('descriptionLanguageFragment', () => {
  it('is undefined when the description is in the requested language', () => {
    expect(descriptionLanguageFragment('site', 'fr', 'fr')).toBeUndefined();
    expect(descriptionLanguageFragment('element', 'en', 'en')).toBeUndefined();
  });

  it.each([
    ['zh', 'Chinese'],
    ['fr', 'French'],
    ['es', 'Spanish'],
    ['ru', 'Russian'],
    ['ar', 'Arabic'],
  ] as const)('names %s in English when the record falls back to English', (code, name) => {
    expect(descriptionLanguageFragment('site', code, 'en')).toBe(
      `UNESCO publishes no ${name} description for this site; description is in English.`,
    );
  });

  it('names the requested language and English when the record carries no description', () => {
    expect(descriptionLanguageFragment('site', 'fr', undefined)).toBe(
      'UNESCO publishes no French or English description for this site.',
    );
    expect(descriptionLanguageFragment('site', 'en', undefined)).toBe(
      'UNESCO publishes no English description for this site.',
    );
  });

  it('uses the noun it is given', () => {
    expect(descriptionLanguageFragment('element', 'fr', 'en')).toBe(
      'UNESCO publishes no French description for this element; description is in English.',
    );
  });
});

describe('composePageNotice', () => {
  const limit = clampBudget(LIMIT_BUDGET, 20);

  it('joins the tool fragments with spaces when nothing remains', () => {
    expect(
      composePageNotice({ fragments: ['One.', 'Two.'], limit, offset: 0, shown: 5, total: 5 }),
    ).toEqual({
      more: false,
      notice: 'One. Two.',
    });
  });

  it('returns an empty notice when there are no fragments and no more results', () => {
    expect(composePageNotice({ fragments: [], limit, offset: 0, shown: 0, total: 0 })).toEqual({
      more: false,
      notice: '',
    });
  });

  it('appends the 1-based continuation range when more results remain', () => {
    expect(
      composePageNotice({ fragments: ['Frag.'], limit, offset: 20, shown: 20, total: 45 }),
    ).toEqual({
      more: true,
      notice: 'Frag. Showing results 21–40 of 45; pass next_cursor to continue.',
    });
  });

  it('carries only the continuation when there are no other fragments', () => {
    expect(
      composePageNotice({ fragments: [], limit, offset: 0, shown: 20, total: 21 }).notice,
    ).toBe('Showing results 1–20 of 21; pass next_cursor to continue.');
  });

  it('is not "more" when the page ends exactly at the total', () => {
    expect(composePageNotice({ fragments: [], limit, offset: 20, shown: 5, total: 25 }).more).toBe(
      false,
    );
  });

  it('is not "more" for a cursor past the end', () => {
    expect(composePageNotice({ fragments: [], limit, offset: 60, shown: 0, total: 45 }).more).toBe(
      false,
    );
  });

  const CLAMP = 'limit 51 is above the per-call cap of 50, so this page holds at most 50 results.';

  it.each([
    ['alone when nothing else applies', [], 0, 5, 5, false, CLAMP],
    [
      'before the continuation, as the truncation guidance',
      [],
      0,
      50,
      120,
      true,
      `${CLAMP} Showing results 1–50 of 120; pass next_cursor to continue.`,
    ],
    [
      'before the zero-hit fragments',
      ['No site matched all 2 filters.', 'Try fewer or broader words.'],
      0,
      0,
      0,
      false,
      `${CLAMP} No site matched all 2 filters. Try fewer or broader words.`,
    ],
    [
      'before a past-the-end fragment',
      ['The cursor is past the last of 45 results.'],
      60,
      0,
      45,
      false,
      `${CLAMP} The cursor is past the last of 45 results.`,
    ],
    [
      'before tool fragments and the continuation on a later page',
      ['Frag.'],
      50,
      50,
      120,
      true,
      `${CLAMP} Frag. Showing results 51–100 of 120; pass next_cursor to continue.`,
    ],
  ])('leads with a clamped limit %s', (_label, fragments, offset, shown, total, more, notice) => {
    expect(
      composePageNotice({
        fragments,
        limit: clampBudget(LIMIT_BUDGET, 51),
        offset,
        shown,
        total,
      }),
    ).toEqual({ more, notice });
  });
});
