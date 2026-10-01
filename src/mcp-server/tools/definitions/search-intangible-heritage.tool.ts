/**
 * @fileoverview unesco_search_intangible_heritage — searches the Intangible
 * Cultural Heritage lists (Representative List, Urgent Safeguarding List,
 * Register of Good Safeguarding Practices) by keyword, country, list,
 * inscription years, multinational status, or linked World Heritage site, with
 * facet counts over the whole match and cursor paging.
 * @module mcp-server/tools/definitions/search-intangible-heritage.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  combinedFiltersFragment,
  composePageNotice,
  countOf,
  pageEnrichment,
  renderCounts,
  renderSources,
} from '@/mcp-server/shared/enrichment.js';
import {
  blankAsUnset,
  booleanInput,
  countryInput,
  cursorInput,
  foldToEnum,
  limitInput,
  optionalIdNoInput,
  queryInput,
  yearInput,
} from '@/mcp-server/shared/inputs.js';
import { inline } from '@/mcp-server/shared/markdown.js';
import { countryDisplayName, isAssignedAlpha2 } from '@/services/unesco-datahub/iso3166.js';
import {
  applyFilters,
  bestSingleRemoval,
  compareNumericId,
  compareText,
  countBoolean,
  countInto,
  fingerprint,
  makeCursor,
  matchTier,
  type NamedFilter,
  queryWords,
  readCursor,
  topCounts,
} from '@/services/unesco-datahub/search.js';
import type { IntangibleElement } from '@/services/unesco-datahub/types.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import {
  INTANGIBLE_LIST_ACRONYMS,
  INTANGIBLE_LISTS,
} from '@/services/unesco-datahub/vocabulary.js';

const SORTS = ['relevance', 'name', 'inscribed_newest', 'inscribed_oldest'] as const;

const MATCH_TIERS = ['name', 'concepts', 'description'] as const;

/** The year UNESCO incorporated its earlier proclamations into the Representative List. */
const INCORPORATION_YEAR = 2008;

const LIST_ALIASES = Object.fromEntries(
  INTANGIBLE_LISTS.map((name) => [INTANGIBLE_LIST_ACRONYMS[name], name]),
);

const ElementRow = z
  .object({
    ich_ref: z
      .string()
      .describe(
        'Intangible heritage element reference; pass to unesco_get_intangible_heritage_element for the full record.',
      ),
    name: z.string().describe('English name.'),
    list: z.enum(INTANGIBLE_LISTS).describe('The list the element is inscribed on.'),
    country_codes: z
      .array(z.string().describe('ISO 3166-1 alpha-2 code.'))
      .describe('ISO 3166-1 alpha-2 codes of the countries sharing the element.'),
    countries: z
      .array(z.string().describe('Country name.'))
      .describe('Country display names aligned with country_codes.'),
    multinational: z.boolean().describe('True when more than one country shares the element.'),
    inscribed_year: z.number().describe('Inscription year.'),
    concepts: z
      .array(z.string().describe('Concept term.'))
      .describe(
        'Every primary UNESCO concept term the element carries; empty when none are recorded. The concepts match tier also covers the secondary terms, which unesco_get_intangible_heritage_element returns.',
      ),
    world_heritage_sites: z
      .array(
        z
          .object({
            id_no: z.string().describe('World Heritage id_no; pass to unesco_get_site.'),
            name: z.string().describe('Site name as the element record carries it.'),
          })
          .describe('One linked World Heritage site.'),
      )
      .describe('World Heritage sites UNESCO links to the element; empty when none are linked.'),
    matched_in: z
      .enum(MATCH_TIERS)
      .optional()
      .describe(
        'The first field tier by which every query word had matched (present when query is set).',
      ),
  })
  .describe('One intangible heritage element (description omitted; fetch it with the get tool).');
type ElementRowT = z.infer<typeof ElementRow>;

const FacetsSchema = z
  .object({
    list: z.record(z.string(), z.number()).describe('Matching elements per list.'),
    multinational: z
      .object({
        true: z.number().describe('Matching elements shared by more than one country.'),
        false: z.number().describe('Matching single-country elements.'),
      })
      .describe('Matching elements by multinational status.'),
    top_countries: z
      .array(
        z
          .object({
            code: z.string().describe('ISO 3166-1 alpha-2 code.'),
            name: z.string().describe('Country name.'),
            count: z.number().describe('Matching elements the country shares.'),
          })
          .describe('One country count.'),
      )
      .describe('Top 10 countries; a multinational element counts once for each of its countries.'),
    top_concepts: z
      .array(
        z
          .object({
            term: z.string().describe('Primary concept term.'),
            count: z.number().describe('Matching elements carrying the term.'),
          })
          .describe('One concept count.'),
      )
      .describe('Top 10 primary concept terms across the match.'),
  })
  .describe('Facet counts over the whole match, not just this page.');
type Facets = z.infer<typeof FacetsSchema>;

const AppliedFiltersSchema = z
  .object({
    query: z.string().optional().describe('Keyword query as given.'),
    country: z
      .object({
        code: z.string().describe('ISO 3166-1 alpha-2 code the country input resolved to.'),
        name: z.string().describe('Country name.'),
      })
      .optional()
      .describe('Resolved country.'),
    list: z.enum(INTANGIBLE_LISTS).optional().describe('List filter.'),
    multinational: z.boolean().optional().describe('Multinational filter.'),
    world_heritage_site: z.string().optional().describe('Linked World Heritage id_no filter.'),
    inscribed_from: z.number().optional().describe('Earliest inscription year.'),
    inscribed_to: z.number().optional().describe('Latest inscription year.'),
    sort: z.enum(SORTS).describe('The sort applied (resolved default when none was given).'),
    limit: z.number().describe('Page size.'),
  })
  .describe('The filters and sort as the server applied them.');
type AppliedFilters = z.infer<typeof AppliedFiltersSchema>;

export const searchIntangibleHeritageTool = tool('unesco_search_intangible_heritage', {
  title: 'Search intangible heritage',
  description:
    "Search UNESCO's Intangible Cultural Heritage lists — the Representative List, the Urgent Safeguarding List, and the Register of Good Safeguarding Practices — by keyword, country, list, inscription year range, multinational status, or linked World Heritage site. Every keyword must appear at the start of a word in an element's English or French name, its UNESCO concept terms, or its description, and name matches rank first. A country is an ISO 3166-1 alpha-2 or alpha-3 code and matches every element it shares, multinational elements included. world_heritage_site takes a site's id_no and lists the elements UNESCO links to it. Rows omit the description; read it with unesco_get_intangible_heritage_element. Results page with next_cursor and carry facet counts over the whole match.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: queryInput(
      "Keywords; every word must match the start of a word in an element's English or French name, its UNESCO concept terms, or its description. Case, accents, and punctuation are ignored, so the query must contain at least one letter or digit; no phrases, operators, or fuzzy matching.",
    ),
    country: countryInput(
      'ISO 3166-1 alpha-2 or alpha-3 code, any case (FR, FRA). Matches every element the country shares, multinational elements included. For a country name, look up its code with unesco_list_reference (topic countries).',
    ),
    list: blankAsUnset(
      z.enum(INTANGIBLE_LISTS).optional(),
      foldToEnum(INTANGIBLE_LISTS, LIST_ALIASES),
    ).describe(
      'Intangible heritage list: Representative List, Urgent Safeguarding List, or Register of Good Safeguarding Practices (acronyms RL, USL, Art18 accepted).',
    ),
    multinational: booleanInput(
      'true: only elements shared by more than one country. false: only single-country elements.',
    ),
    world_heritage_site: optionalIdNoInput(
      "A World Heritage site's id_no (from unesco_search_sites or unesco_get_site); lists the elements UNESCO links to that site. A number, a digit string, or the site's whc.unesco.org/en/list/{id} page URL.",
    ),
    inscribed_from: yearInput('Earliest inscription year, inclusive.'),
    inscribed_to: yearInput('Latest inscription year, inclusive.'),
    sort: blankAsUnset(z.enum(SORTS).optional()).describe(
      'Result order. Default: relevance when query is set, else name. relevance needs query.',
    ),
    limit: limitInput,
    cursor: cursorInput,
  }),
  output: z.object({
    elements: z.array(ElementRow).describe('Matching elements on this page.'),
    next_cursor: z
      .string()
      .optional()
      .describe(
        'Pass as cursor, with the same filters and sort, to fetch the next page. Present when more results remain.',
      ),
  }),
  enrichment: {
    ...pageEnrichment,
    applied_filters: AppliedFiltersSchema,
    facets: FacetsSchema,
  },
  enrichmentTrailer: {
    sources: { render: renderSources },
    applied_filters: { render: renderAppliedFilters },
    facets: { render: renderFacets },
  },
  errors: [
    {
      reason: 'unknown_country',
      code: JsonRpcErrorCode.ValidationError,
      when: 'country is not a recognized ISO 3166-1 alpha-2 or alpha-3 code, such as a country name or an unassigned code',
      severity: 'notice',
      recovery:
        'Call unesco_list_reference with topic countries and filter set to the country name to find its ISO code, then call unesco_search_intangible_heritage again with that code.',
    },
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'inscribed_from is later than inscribed_to',
      severity: 'notice',
      recovery:
        'Set inscribed_from to a year at or before inscribed_to, then call unesco_search_intangible_heritage again.',
    },
    {
      reason: 'sort_needs_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sort relevance without query',
      severity: 'notice',
      recovery:
        'Add query for sort relevance, or call unesco_search_intangible_heritage with sort name, inscribed_newest, or inscribed_oldest.',
    },
    {
      reason: 'cursor_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'cursor was issued for different filters or sort, or for an earlier data snapshot',
      severity: 'notice',
      recovery:
        'Call unesco_search_intangible_heritage again with the same filters and no cursor, then page with the next_cursor it returns.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'cursor is malformed, or its offset or limit is not a non-negative whole number',
      severity: 'notice',
      thrownBy: 'service',
      recovery:
        'Call unesco_search_intangible_heritage without cursor to start from the first page, or pass the next_cursor from the previous response unchanged.',
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No intangible heritage snapshot has loaded yet and the Data Hub is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the Intangible Heritage List; wait until the next load attempt this error names (retryAfter, in seconds), then call unesco_search_intangible_heritage again.',
    },
  ],

  async handler(input, ctx) {
    if (
      input.inscribed_from !== undefined &&
      input.inscribed_to !== undefined &&
      input.inscribed_from > input.inscribed_to
    ) {
      throw ctx.fail(
        'invalid_year_range',
        `inscribed_from (${input.inscribed_from}) is later than inscribed_to (${input.inscribed_to}).`,
      );
    }
    const sort = input.sort ?? (input.query ? 'relevance' : 'name');
    if (sort === 'relevance' && !input.query) {
      throw ctx.fail('sort_needs_input', 'sort relevance needs query.');
    }

    const intangible = await getUnescoDataHubService().getIntangible(ctx);
    const { records, folded } = intangible;

    let country: { code: string; name: string } | undefined;
    if (input.country) {
      if (!isAssignedAlpha2(input.country) && !intangible.codes.has(input.country)) {
        throw ctx.fail(
          'unknown_country',
          `"${inline(input.country)}" is not an ISO 3166-1 alpha-2 or alpha-3 country code.`,
          { country: input.country },
        );
      }
      country = { code: input.country, name: countryDisplayName(input.country) };
    }

    const applied: AppliedFilters = {
      ...(input.query ? { query: input.query } : {}),
      ...(country ? { country } : {}),
      ...(input.list ? { list: input.list } : {}),
      ...(input.multinational !== undefined ? { multinational: input.multinational } : {}),
      ...(input.world_heritage_site ? { world_heritage_site: input.world_heritage_site } : {}),
      ...(input.inscribed_from !== undefined ? { inscribed_from: input.inscribed_from } : {}),
      ...(input.inscribed_to !== undefined ? { inscribed_to: input.inscribed_to } : {}),
      sort,
      limit: input.limit,
    };
    const { limit: _limit, ...fingerprinted } = applied;
    const fp = fingerprint(fingerprinted);

    let offset = 0;
    if (input.cursor) {
      const cursor = readCursor(input.cursor, ctx);
      if (cursor.fp !== fp || cursor.asOf !== intangible.asOf) {
        throw ctx.fail(
          'cursor_mismatch',
          'The cursor was issued for different filters or sort, or for an earlier data snapshot.',
        );
      }
      offset = cursor.offset;
    }

    ctx.enrich({ sources: [sourceOf(intangible)], applied_filters: applied });

    const words = input.query ? queryWords(input.query) : [];
    const tierOf = input.query ? folded.map((tiers) => matchTier(words, tiers)) : [];

    const filters: NamedFilter<IntangibleElement>[] = [];
    if (input.query) filters.push({ name: 'query', test: (_e, i) => tierOf[i] !== undefined });
    if (country) {
      const code = country.code;
      filters.push({ name: 'country', test: (e) => e.country_codes.includes(code) });
    }
    if (input.list) filters.push({ name: 'list', test: (e) => e.list === input.list });
    if (input.multinational !== undefined) {
      filters.push({ name: 'multinational', test: (e) => e.multinational === input.multinational });
    }
    const site = input.world_heritage_site;
    if (site) {
      filters.push({
        name: 'world_heritage_site',
        test: (e) => e.world_heritage_sites.some((s) => s.id_no === site),
      });
    }
    const from = input.inscribed_from;
    if (from !== undefined)
      filters.push({ name: 'inscribed_from', test: (e) => e.inscribed_year >= from });
    const to = input.inscribed_to;
    if (to !== undefined)
      filters.push({ name: 'inscribed_to', test: (e) => e.inscribed_year <= to });

    const matched = applyFilters(records, filters);
    const total = matched.length;
    ctx.enrich.total(total);
    ctx.enrich({ facets: elementFacets(matched.map((i) => records[i] as IntangibleElement)) });

    matched.sort(elementComparator(sort, records, tierOf));
    const page = matched
      .slice(offset, offset + input.limit)
      .map((i) => toRow(records[i] as IntangibleElement, tierOf[i]));
    ctx.enrich({ truncated: false, shown: page.length, cap: input.limit });

    const fragments: string[] = [];
    if (total === 0) {
      if (filters.length >= 2) {
        fragments.push(
          combinedFiltersFragment('element', filters.length, bestSingleRemoval(records, filters)),
        );
      }
      const alone = (name: string) => {
        const filter = filters.find((f) => f.name === name);
        return filter ? applyFilters(records, [filter]).length : undefined;
      };
      if (country && alone('country') === 0) {
        fragments.push(
          `No intangible heritage element lists ${country.code} (${country.name}) among its countries. unesco_list_reference with topic countries shows how many elements each country has.`,
        );
      }
      if (input.query && alone('query') === 0) {
        fragments.push(
          `No element's name, concept terms, or description contains every word of "${inline(input.query)}" (each word matches at the start of a word, and all are required). Try fewer or broader words.`,
        );
      }
      if (site && alone('world_heritage_site') === 0) {
        const linked = records.filter((e) => e.world_heritage_sites.length > 0).length;
        fragments.push(
          `No intangible heritage element links to World Heritage site ${site}; ${countOf(linked, 'element')} ${linked === 1 ? 'carries' : 'carry'} such a link. Confirm the id_no with unesco_get_site, or search by keyword instead.`,
        );
      }
    }
    if (input.cursor && total > 0 && offset >= total) {
      fragments.push(
        `The cursor is past the last of ${countOf(total, 'result')}. Call unesco_search_intangible_heritage without cursor to start over.`,
      );
    }
    if (
      (from !== undefined || to !== undefined) &&
      (from ?? INCORPORATION_YEAR) <= INCORPORATION_YEAR &&
      (to ?? INCORPORATION_YEAR) >= INCORPORATION_YEAR
    ) {
      const dated = records.filter((e) => e.inscribed_year === INCORPORATION_YEAR).length;
      const one = dated === 1;
      fragments.push(
        `The ${countOf(dated, 'element')} dated ${INCORPORATION_YEAR} ${one ? 'was' : 'were'} incorporated into the Representative List that year; UNESCO had proclaimed ${one ? 'it' : 'them'} earlier, and the data does not carry the proclamation year.`,
      );
    }

    const { more, notice } = composePageNotice({ fragments, offset, shown: page.length, total });
    let next_cursor: string | undefined;
    if (more) {
      ctx.enrich.truncated({ shown: page.length, cap: input.limit, guidance: notice });
      next_cursor = makeCursor({
        offset: offset + page.length,
        limit: input.limit,
        fp,
        asOf: intangible.asOf,
      });
    } else if (notice) {
      ctx.enrich.notice(notice);
    }

    ctx.log.info('Intangible heritage searched', { total, shown: page.length, offset, sort });
    return { elements: page, ...(next_cursor ? { next_cursor } : {}) };
  },

  format: (result) => {
    const lines = [
      `**${countOf(result.elements.length, 'intangible heritage element')} on this page**`,
    ];
    for (const e of result.elements) {
      const countries = e.country_codes.map((code, i) => {
        const name = e.countries[i];
        return name ? `${inline(name)} (${code})` : code;
      });
      const facts = [
        e.list,
        countries.join(', '),
        `Inscribed ${e.inscribed_year}`,
        ...(e.multinational ? ['Multinational'] : []),
        `Concepts: ${e.concepts.length > 0 ? e.concepts.map(inline).join(', ') : 'None recorded'}`,
        e.world_heritage_sites.length > 0
          ? `World Heritage sites: ${e.world_heritage_sites.map((s) => `${s.id_no} ${inline(s.name)}`).join('; ')}`
          : 'No linked World Heritage site',
        ...(e.matched_in ? [`Matched in: ${e.matched_in}`] : []),
      ];
      lines.push('', `### ${inline(e.name)} (ich_ref ${e.ich_ref})`, facts.join(' · '));
    }
    if (result.next_cursor) lines.push('', `Next cursor: ${result.next_cursor}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function toRow(element: IntangibleElement, tier: number | undefined): ElementRowT {
  return {
    ich_ref: element.ich_ref,
    name: element.name,
    list: element.list,
    country_codes: element.country_codes,
    countries: element.countries,
    multinational: element.multinational,
    inscribed_year: element.inscribed_year,
    concepts: element.concepts,
    world_heritage_sites: element.world_heritage_sites,
    ...(tier !== undefined ? { matched_in: MATCH_TIERS[tier] } : {}),
  };
}

function elementComparator(
  sort: (typeof SORTS)[number],
  records: readonly IntangibleElement[],
  tierOf: readonly (number | undefined)[],
): (a: number, b: number) => number {
  const element = (i: number) => records[i] as IntangibleElement;
  const byId = (a: number, b: number) => compareNumericId(element(a).ich_ref, element(b).ich_ref);
  const byName = (a: number, b: number) =>
    compareText(element(a).name, element(b).name) || byId(a, b);
  switch (sort) {
    case 'relevance':
      return (a, b) => (tierOf[a] ?? 0) - (tierOf[b] ?? 0) || byName(a, b);
    case 'name':
      return byName;
    case 'inscribed_newest':
      return (a, b) => element(b).inscribed_year - element(a).inscribed_year || byId(a, b);
    case 'inscribed_oldest':
      return (a, b) => element(a).inscribed_year - element(b).inscribed_year || byId(a, b);
  }
}

function elementFacets(elements: readonly IntangibleElement[]): Facets {
  return {
    list: countInto(
      INTANGIBLE_LISTS,
      elements.map((e) => e.list),
    ),
    multinational: countBoolean(elements.map((e) => e.multinational)),
    top_countries: topCounts(
      elements.flatMap((e) => [...new Set(e.country_codes)]),
      10,
    ).map(({ key, count }) => ({ code: key, name: countryDisplayName(key), count })),
    top_concepts: topCounts(
      elements.flatMap((e) => [...new Set(e.concepts)]),
      10,
    ).map(({ key, count }) => ({ term: key, count })),
  };
}

function renderFacets(f: Facets): string {
  return [
    '### Facets (whole match)',
    `- List: ${renderCounts(f.list)}`,
    `- Multinational: yes ${f.multinational.true} · no ${f.multinational.false}`,
    `- Top countries: ${
      f.top_countries.map((c) => `${inline(c.name)} (${c.code}) ${c.count}`).join(' · ') || 'none'
    }`,
    `- Top concepts: ${
      f.top_concepts.map((c) => `${inline(c.term)} ${c.count}`).join(' · ') || 'none'
    }`,
  ].join('\n');
}

function renderAppliedFilters(a: AppliedFilters): string {
  const lines = ['### Applied filters'];
  if (a.query !== undefined) lines.push(`- query: "${inline(a.query)}"`);
  if (a.country) lines.push(`- country: ${a.country.code} (${inline(a.country.name)})`);
  if (a.list) lines.push(`- list: ${a.list}`);
  if (a.multinational !== undefined) lines.push(`- multinational: ${a.multinational}`);
  if (a.world_heritage_site) lines.push(`- world_heritage_site: ${a.world_heritage_site}`);
  if (a.inscribed_from !== undefined) lines.push(`- inscribed_from: ${a.inscribed_from}`);
  if (a.inscribed_to !== undefined) lines.push(`- inscribed_to: ${a.inscribed_to}`);
  lines.push(`- sort: ${a.sort}`, `- limit: ${a.limit}`);
  return lines.join('\n');
}
