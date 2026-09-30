/**
 * @fileoverview Tests for the shared enrichment fields: the sources schema and
 * trailer line, the page fields, and the composed page notice.
 * @module tests/shared/enrichment.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  composePageNotice,
  pageEnrichment,
  renderSources,
  sourcesField,
} from '@/mcp-server/shared/enrichment.js';
import type { SourceEntry } from '@/services/unesco-datahub/types.js';

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

describe('composePageNotice', () => {
  it('joins the tool fragments with spaces when nothing remains', () => {
    expect(
      composePageNotice({ fragments: ['One.', 'Two.'], offset: 0, shown: 5, total: 5 }),
    ).toEqual({
      more: false,
      notice: 'One. Two.',
    });
  });

  it('returns an empty notice when there are no fragments and no more results', () => {
    expect(composePageNotice({ fragments: [], offset: 0, shown: 0, total: 0 })).toEqual({
      more: false,
      notice: '',
    });
  });

  it('appends the 1-based continuation range when more results remain', () => {
    expect(composePageNotice({ fragments: ['Frag.'], offset: 20, shown: 20, total: 45 })).toEqual({
      more: true,
      notice: 'Frag. Showing results 21–40 of 45; pass next_cursor to continue.',
    });
  });

  it('carries only the continuation when there are no other fragments', () => {
    expect(composePageNotice({ fragments: [], offset: 0, shown: 20, total: 21 }).notice).toBe(
      'Showing results 1–20 of 21; pass next_cursor to continue.',
    );
  });

  it('is not "more" when the page ends exactly at the total', () => {
    expect(composePageNotice({ fragments: [], offset: 20, shown: 5, total: 25 }).more).toBe(false);
  });

  it('is not "more" for a cursor past the end', () => {
    expect(composePageNotice({ fragments: [], offset: 60, shown: 0, total: 45 }).more).toBe(false);
  });
});
