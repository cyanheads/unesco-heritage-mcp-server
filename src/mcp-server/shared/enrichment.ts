/**
 * @fileoverview Shared enrichment fields and trailer renderers: the `sources`
 * attribution block every data response carries, the page fields every search
 * tool carries, the composed page notice and its combined-filters zero-hit
 * fragment, the count phrase notices and page headers use, and the facet-count
 * line the search trailers render.
 * @module mcp-server/shared/enrichment
 */

import { z } from '@cyanheads/mcp-ts-core';
import { inline } from '@/mcp-server/shared/markdown.js';
import type { SourceEntry } from '@/services/unesco-datahub/types.js';
import { type DatasetId, LICENSE_URL } from '@/services/unesco-datahub/vocabulary.js';

/** The `sources` field whose `dataset` enum names exactly `datasets`. */
export function sourcesFieldOf(datasets: readonly [DatasetId, ...DatasetId[]]) {
  return z
    .array(
      z
        .object({
          dataset: z.enum(datasets).describe('UNESCO Data Hub dataset id.'),
          title: z.string().describe('Dataset title.'),
          data_as_of: z
            .string()
            .describe("Dataset's data_processed timestamp (ISO 8601) from the loaded snapshot."),
          license: z
            .string()
            .describe("Dataset license from the dataset metadata ('CC BY-SA 4.0')."),
          attribution: z.string().describe('Credit line to reproduce with the data.'),
        })
        .describe('One source dataset.'),
    )
    .describe('Datasets this response was built from.');
}

/**
 * The `sources` field of the World Heritage, intangible heritage, and biosphere
 * reserve tools, naming those three datasets. A tool that can return `eg0001`
 * declares `sourcesFieldOf` with it instead.
 */
export const sourcesField = sourcesFieldOf(['whc001', 'ich001', 'mab001']);

/** One trailer line per dataset. */
export function renderSources(sources: readonly SourceEntry[]): string {
  return sources
    .map(
      (s) =>
        `Source: UNESCO — ${s.title} (${s.dataset}), data as of ${inline(s.data_as_of)}, ${s.license} · ${LICENSE_URL}`,
    )
    .join('\n');
}

/** Page fields every search tool declares, besides its own `applied_filters` and `facets`. */
export const pageEnrichment = {
  sources: sourcesField,
  totalCount: z.number().describe('Total matches across all pages.'),
  truncated: z.boolean().describe('True when more results remain beyond this page.'),
  shown: z.number().describe('Number of results on this page.'),
  cap: z.number().describe('The page size (limit) that was applied.'),
  notice: z
    .string()
    .optional()
    .describe('Guidance on the result: why nothing matched, caveats, or how to continue paging.'),
};

/** A count with its noun, pluralized with `s` unless the count is 1: `1 site`, `3 sites`. */
export function countOf(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** A facet's non-zero counts as `key n · key n`, or `none` when every count is 0. */
export function renderCounts(
  counts: Record<string, number>,
  label: (key: string) => string = (key) => key,
): string {
  return (
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([key, n]) => `${label(key)} ${n}`)
      .join(' · ') || 'none'
  );
}

/**
 * The zero-hit fragment for a search whose filters match nothing together,
 * naming the single filter whose removal alone matches the most records when
 * any removal matches (`bestSingleRemoval`).
 */
export function combinedFiltersFragment(
  noun: string,
  filterCount: number,
  best: { name: string; count: number } | undefined,
): string {
  const lead = `No ${noun} matched all ${filterCount} filters.`;
  return best
    ? `${lead} Removing ${best.name} alone would match ${countOf(best.count, noun)}.`
    : lead;
}

/**
 * Composes the page notice from the tool's fragments plus the continuation
 * fragment when more results remain. The caller passes `notice` to
 * `ctx.enrich.truncated` as `guidance` when `more`, else to `ctx.enrich.notice`
 * when non-empty.
 */
export function composePageNotice(args: {
  fragments: readonly string[];
  offset: number;
  shown: number;
  total: number;
}): { more: boolean; notice: string } {
  const more = args.offset + args.shown < args.total;
  const parts = [...args.fragments];
  if (more) {
    parts.push(
      `Showing results ${args.offset + 1}–${args.offset + args.shown} of ${args.total}; pass next_cursor to continue.`,
    );
  }
  return { more, notice: parts.join(' ') };
}
