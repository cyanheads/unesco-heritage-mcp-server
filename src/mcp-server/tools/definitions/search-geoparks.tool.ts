/**
 * @fileoverview unesco_search_geoparks — searches UNESCO Global Geoparks by
 * keyword, country, designation years, transnational status, or distance from
 * a point, with facet counts over the whole match and cursor paging.
 * @module mcp-server/tools/definitions/search-geoparks.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  combinedFiltersFragment,
  composePageNotice,
  countOf,
  pageEnrichment,
  renderSources,
  sourcesFieldOf,
} from '@/mcp-server/shared/enrichment.js';
import {
  blankAsUnset,
  booleanInput,
  countryInput,
  cursorInput,
  includeDescriptionInput,
  limitInput,
  MAX_QUERY_WORDS,
  nearInput,
  queryInput,
  yearInput,
} from '@/mcp-server/shared/inputs.js';
import { inline, quote } from '@/mcp-server/shared/markdown.js';
import { countryDisplayName, isAssignedAlpha2 } from '@/services/unesco-datahub/iso3166.js';
import {
  applyFilters,
  bestSingleRemoval,
  compareText,
  countBoolean,
  fingerprint,
  haversineKm,
  makeCursor,
  matchTier,
  type NamedFilter,
  queryWords,
  readCursor,
  topCounts,
} from '@/services/unesco-datahub/search.js';
import type { Geopark } from '@/services/unesco-datahub/types.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';

const SORTS = [
  'relevance',
  'name',
  'designated_newest',
  'designated_oldest',
  'area_largest',
  'distance',
] as const;

const MATCH_TIERS = ['name', 'introduction', 'description'] as const;

/** The year UNESCO created the Global Geopark label; geoparks designated earlier carry it. */
const LABEL_YEAR = 2015;

const GeoparkRow = z
  .object({
    ugg_id: z
      .string()
      .describe('UNESCO Global Geopark id; pass to unesco_get_geopark for the full record.'),
    name: z.string().describe('English name.'),
    country_codes: z
      .array(z.string().describe('ISO 3166-1 alpha-2 code.'))
      .describe(
        "ISO 3166-1 alpha-2 codes of the geopark's countries; a transnational geopark lists each.",
      ),
    countries: z
      .array(z.string().describe('Country name.'))
      .describe('Country display names aligned with country_codes.'),
    transnational: z.boolean().describe('True when the geopark spans more than one country.'),
    designation_year: z
      .number()
      .describe(
        `Designation year; geoparks UNESCO recognized before the Global Geopark label existed are dated ${LABEL_YEAR}, the year it was created.`,
      ),
    area_hectares: z.number().describe('Area in hectares, as recorded.'),
    population: z
      .number()
      .optional()
      .describe(
        'Resident population, as recorded; absent when UNESCO records none, and 0 can mean unreported.',
      ),
    latitude: z.number().describe("Latitude of the geopark's point."),
    longitude: z.number().describe("Longitude of the geopark's point."),
    distance_km: z
      .number()
      .optional()
      .describe('Distance from the near point in km (present when near is set).'),
    matched_in: z
      .enum(MATCH_TIERS)
      .optional()
      .describe(
        'The first field tier by which every query word had matched (present when query is set); description covers the description and the account of sustaining local communities.',
      ),
    introduction: z
      .string()
      .optional()
      .describe(
        "UNESCO's introduction to the geopark; omitted from every row when include_description is false.",
      ),
  })
  .describe('One UNESCO Global Geopark.');
type GeoparkRowT = z.infer<typeof GeoparkRow>;

const FacetsSchema = z
  .object({
    transnational: z
      .object({
        true: z.number().describe('Matching transnational geoparks.'),
        false: z.number().describe('Matching single-country geoparks.'),
      })
      .describe('Matching geoparks by transnational status.'),
    top_countries: z
      .array(
        z
          .object({
            code: z.string().describe('ISO 3166-1 alpha-2 code.'),
            name: z.string().describe('Country name.'),
            count: z.number().describe('Matching geoparks the country takes part in.'),
          })
          .describe('One country count.'),
      )
      .describe('Top 10 countries; a transnational geopark counts for each of its countries.'),
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
    transnational: z.boolean().optional().describe('Transnational filter.'),
    designated_from: z.number().optional().describe('Earliest designation year.'),
    designated_to: z.number().optional().describe('Latest designation year.'),
    near: z
      .object({
        latitude: z.number().describe('Latitude.'),
        longitude: z.number().describe('Longitude.'),
        radius_km: z.number().describe('Radius in km.'),
      })
      .optional()
      .describe('Distance filter.'),
    sort: z.enum(SORTS).describe('The sort applied (resolved default when none was given).'),
    limit: z.number().describe('Page size.'),
    include_description: z.boolean().describe('Whether rows carry their introduction.'),
  })
  .describe('The filters and sort as the server applied them.');
type AppliedFilters = z.infer<typeof AppliedFiltersSchema>;

export const searchGeoparksTool = tool('unesco_search_geoparks', {
  title: 'Search UNESCO Global Geoparks',
  description: `Search UNESCO Global Geoparks by keyword, country, designation year range, transnational status, or distance from a point. Every keyword must appear at the start of a word in the geopark's name, introduction, description, or account of how it sustains local communities, and name matches rank first. A country is an ISO 3166-1 alpha-2 or alpha-3 code and matches every geopark it takes part in, transnational geoparks included. Geoparks UNESCO recognized before the Global Geopark label existed are dated ${LABEL_YEAR}, the year it was created. Results page with next_cursor and carry facet counts over the whole match.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: queryInput(
      `Keywords; every word must match the start of a word in the geopark's name, introduction, description, or account of sustaining local communities. Case, accents, and punctuation are ignored, so the query must contain at least one letter or digit and at most ${MAX_QUERY_WORDS} distinct words; no phrases, operators, or fuzzy matching. For a landform, use a word such as volcanic, karst, or fossil.`,
    ),
    country: countryInput(
      'ISO 3166-1 alpha-2 or alpha-3 code, any case (FR, FRA). Matches every geopark the country takes part in, transnational geoparks included. For a country name, look up its code with unesco_list_reference (topic countries).',
    ),
    transnational: booleanInput(
      'true: only geoparks spanning more than one country. false: only single-country geoparks.',
    ),
    designated_from: yearInput('Earliest designation year, inclusive.'),
    designated_to: yearInput('Latest designation year, inclusive.'),
    near: nearInput(
      'Only geoparks within radius_km of this point. Every geopark has one point, which the distance measures.',
    ),
    sort: blankAsUnset(z.enum(SORTS).optional()).describe(
      'Result order. Default: relevance when query is set, else distance when near is set, else name. relevance needs query; distance needs near. area_largest orders by recorded area.',
    ),
    include_description: includeDescriptionInput(
      "Set false to leave each row's introduction out of the response (default true); unesco_get_geopark returns it. Which geoparks match, their order, and matched_in are unchanged.",
    ),
    limit: limitInput,
    cursor: cursorInput,
  }),
  output: z.object({
    geoparks: z.array(GeoparkRow).describe('Matching geoparks on this page.'),
    next_cursor: z
      .string()
      .optional()
      .describe(
        'Pass as cursor, with the same filters and sort, to fetch the next page. Present when more results remain.',
      ),
  }),
  enrichment: {
    ...pageEnrichment,
    sources: sourcesFieldOf(['eg0001']),
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
        'Call unesco_list_reference with topic countries and filter set to the country name to find its ISO code, then call unesco_search_geoparks again with that code.',
    },
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'designated_from is later than designated_to',
      severity: 'notice',
      recovery:
        'Set designated_from to a year at or before designated_to, then call unesco_search_geoparks again.',
    },
    {
      reason: 'sort_needs_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sort relevance without query, or sort distance without near',
      severity: 'notice',
      recovery:
        'Add query for sort relevance or near for sort distance, or call unesco_search_geoparks with sort name, designated_newest, designated_oldest, or area_largest.',
    },
    {
      reason: 'cursor_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'cursor was issued for different filters or sort, or for an earlier data snapshot',
      severity: 'notice',
      recovery:
        'Call unesco_search_geoparks again with the same filters and no cursor, then page with the next_cursor it returns.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'cursor is malformed, or its offset or limit is not a non-negative whole number',
      severity: 'notice',
      thrownBy: 'service',
      recovery:
        'Call unesco_search_geoparks without cursor to start from the first page, or pass the next_cursor from the previous response unchanged.',
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No geopark snapshot has loaded yet and the Data Hub is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the UNESCO Global Geoparks; wait until the next load attempt this error names (retryAfter, in seconds), then call unesco_search_geoparks again.',
    },
  ],

  async handler(input, ctx) {
    if (
      input.designated_from !== undefined &&
      input.designated_to !== undefined &&
      input.designated_from > input.designated_to
    ) {
      throw ctx.fail(
        'invalid_year_range',
        `designated_from (${input.designated_from}) is later than designated_to (${input.designated_to}).`,
      );
    }
    const sort = input.sort ?? (input.query ? 'relevance' : input.near ? 'distance' : 'name');
    if ((sort === 'relevance' && !input.query) || (sort === 'distance' && !input.near)) {
      throw ctx.fail(
        'sort_needs_input',
        `sort ${sort} needs ${sort === 'relevance' ? 'query' : 'near'}.`,
      );
    }

    const geoparks = await getUnescoDataHubService().getGeoparks(ctx);
    const { records, folded } = geoparks;

    let country: { code: string; name: string } | undefined;
    if (input.country) {
      if (!isAssignedAlpha2(input.country) && !geoparks.codes.has(input.country)) {
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
      ...(input.transnational !== undefined ? { transnational: input.transnational } : {}),
      ...(input.designated_from !== undefined ? { designated_from: input.designated_from } : {}),
      ...(input.designated_to !== undefined ? { designated_to: input.designated_to } : {}),
      ...(input.near ? { near: input.near } : {}),
      sort,
      limit: input.limit,
      include_description: input.include_description,
    };
    const { limit: _limit, include_description: _includeDescription, ...fingerprinted } = applied;
    const fp = fingerprint(fingerprinted);

    let offset = 0;
    if (input.cursor) {
      const cursor = readCursor(input.cursor, ctx);
      if (cursor.fp !== fp || cursor.asOf !== geoparks.asOf) {
        throw ctx.fail(
          'cursor_mismatch',
          'The cursor was issued for different filters or sort, or for an earlier data snapshot.',
        );
      }
      offset = cursor.offset;
    }

    ctx.enrich({ sources: [sourceOf(geoparks)], applied_filters: applied });

    const words = input.query ? queryWords(input.query) : [];
    const tierOf = input.query ? folded.map((tiers) => matchTier(words, tiers)) : [];
    const near = input.near;
    const distanceOf = near
      ? records.map((g) => haversineKm(near.latitude, near.longitude, g.latitude, g.longitude))
      : [];

    const filters: NamedFilter<Geopark>[] = [];
    if (input.query) filters.push({ name: 'query', test: (_g, i) => tierOf[i] !== undefined });
    if (country) {
      const code = country.code;
      filters.push({ name: 'country', test: (g) => g.country_codes.includes(code) });
    }
    if (input.transnational !== undefined) {
      filters.push({ name: 'transnational', test: (g) => g.transnational === input.transnational });
    }
    const from = input.designated_from;
    if (from !== undefined)
      filters.push({ name: 'designated_from', test: (g) => g.designation_year >= from });
    const to = input.designated_to;
    if (to !== undefined)
      filters.push({ name: 'designated_to', test: (g) => g.designation_year <= to });
    if (near) {
      filters.push({
        name: 'near',
        test: (_g, i) => (distanceOf[i] ?? Number.POSITIVE_INFINITY) <= near.radius_km,
      });
    }

    const matched = applyFilters(records, filters);
    const total = matched.length;
    ctx.enrich.total(total);
    ctx.enrich({ facets: geoparkFacets(matched.map((i) => records[i] as Geopark)) });

    matched.sort(geoparkComparator(sort, records, tierOf, distanceOf));
    const page = matched
      .slice(offset, offset + input.limit)
      .map((i) =>
        toRow(records[i] as Geopark, tierOf[i], distanceOf[i], input.include_description),
      );
    ctx.enrich({ truncated: false, shown: page.length, cap: input.limit });

    const fragments: string[] = [];
    if (total === 0) {
      if (filters.length >= 2) {
        fragments.push(
          combinedFiltersFragment('geopark', filters.length, bestSingleRemoval(records, filters)),
        );
      }
      const alone = (name: string) => {
        const filter = filters.find((f) => f.name === name);
        return filter ? applyFilters(records, [filter]).length : undefined;
      };
      if (country && alone('country') === 0) {
        fragments.push(
          `No UNESCO Global Geopark lists ${country.code} (${country.name}) among its countries. unesco_list_reference with topic countries shows how many geoparks each country has.`,
        );
      }
      if (input.query && alone('query') === 0) {
        fragments.push(
          `No geopark's name, introduction, description, or account of sustaining local communities contains every word of "${inline(input.query)}" (each word matches at the start of a word, and all are required). Try fewer or broader words.`,
        );
      }
      if (near && alone('near') === 0) {
        fragments.push(
          `No UNESCO Global Geopark lies within ${near.radius_km} km of (${near.latitude}, ${near.longitude}). Increase radius_km.`,
        );
      }
    }
    if (input.cursor && total > 0 && offset >= total) {
      fragments.push(
        `The cursor is past the last of ${countOf(total, 'result')}. Call unesco_search_geoparks without cursor to start over.`,
      );
    }
    if ((from !== undefined || to !== undefined) && (from ?? LABEL_YEAR) <= LABEL_YEAR) {
      const dated = records.filter((g) => g.designation_year === LABEL_YEAR).length;
      const one = dated === 1;
      fragments.push(
        `The ${countOf(dated, 'geopark')} dated ${LABEL_YEAR} ${one ? 'carries' : 'carry'} the year UNESCO created the UNESCO Global Geopark designation, not the year ${one ? 'it' : 'each'} joined the Global Geoparks Network, which the data does not record.`,
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
        asOf: geoparks.asOf,
      });
    } else if (notice) {
      ctx.enrich.notice(notice);
    }

    ctx.log.info('Geoparks searched', { total, shown: page.length, offset, sort });
    return { geoparks: page, ...(next_cursor ? { next_cursor } : {}) };
  },

  format: (result) => {
    const lines = [`**${countOf(result.geoparks.length, 'geopark')} on this page**`];
    for (const g of result.geoparks) {
      const countries = g.country_codes.map((code, i) => {
        const name = g.countries[i];
        return name ? `${inline(name)} (${code})` : code;
      });
      const facts = [
        countries.join(', '),
        `Designated ${g.designation_year}`,
        `Transnational: ${g.transnational ? 'Yes' : 'No'}`,
        `Area: ${g.area_hectares} ha`,
        `Population: ${g.population ?? 'Not available'}`,
        `Coordinates: ${g.latitude}, ${g.longitude}`,
        ...(g.distance_km !== undefined ? [`Distance: ${g.distance_km} km`] : []),
        ...(g.matched_in ? [`Matched in: ${g.matched_in}`] : []),
      ];
      lines.push('', `### ${inline(g.name)} (${inline(g.ugg_id)})`, facts.join(' · '));
      if (g.introduction !== undefined) lines.push(quote(g.introduction));
    }
    if (result.next_cursor) lines.push('', `Next cursor: ${result.next_cursor}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function toRow(
  geopark: Geopark,
  tier: number | undefined,
  distance: number | undefined,
  includeDescription: boolean,
): GeoparkRowT {
  return {
    ugg_id: geopark.ugg_id,
    name: geopark.name,
    country_codes: geopark.country_codes,
    countries: geopark.countries,
    transnational: geopark.transnational,
    designation_year: geopark.designation_year,
    area_hectares: geopark.area_hectares,
    ...(geopark.population !== undefined ? { population: geopark.population } : {}),
    latitude: geopark.latitude,
    longitude: geopark.longitude,
    ...(distance !== undefined ? { distance_km: distance } : {}),
    ...(tier !== undefined ? { matched_in: MATCH_TIERS[tier] } : {}),
    ...(includeDescription ? { introduction: geopark.introduction } : {}),
  };
}

function geoparkComparator(
  sort: (typeof SORTS)[number],
  records: readonly Geopark[],
  tierOf: readonly (number | undefined)[],
  distanceOf: readonly number[],
): (a: number, b: number) => number {
  const geopark = (i: number) => records[i] as Geopark;
  const byId = (a: number, b: number) => compareText(geopark(a).ugg_id, geopark(b).ugg_id);
  const byName = (a: number, b: number) =>
    compareText(geopark(a).name, geopark(b).name) || byId(a, b);
  switch (sort) {
    case 'relevance':
      return (a, b) => (tierOf[a] ?? 0) - (tierOf[b] ?? 0) || byName(a, b);
    case 'name':
      return byName;
    case 'designated_newest':
      return (a, b) => geopark(b).designation_year - geopark(a).designation_year || byId(a, b);
    case 'designated_oldest':
      return (a, b) => geopark(a).designation_year - geopark(b).designation_year || byId(a, b);
    case 'area_largest':
      return (a, b) => geopark(b).area_hectares - geopark(a).area_hectares || byId(a, b);
    case 'distance':
      return (a, b) => (distanceOf[a] ?? 0) - (distanceOf[b] ?? 0) || byId(a, b);
  }
}

function geoparkFacets(geoparks: readonly Geopark[]): Facets {
  return {
    transnational: countBoolean(geoparks.map((g) => g.transnational)),
    top_countries: topCounts(
      geoparks.flatMap((g) => [...new Set(g.country_codes)]),
      10,
    ).map(({ key, count }) => ({ code: key, name: countryDisplayName(key), count })),
  };
}

function renderFacets(f: Facets): string {
  return [
    '### Facets (whole match)',
    `- Transnational: yes ${f.transnational.true} · no ${f.transnational.false}`,
    `- Top countries: ${
      f.top_countries.map((c) => `${inline(c.name)} (${c.code}) ${c.count}`).join(' · ') || 'none'
    }`,
  ].join('\n');
}

function renderAppliedFilters(a: AppliedFilters): string {
  const lines = ['### Applied filters'];
  if (a.query !== undefined) lines.push(`- query: "${inline(a.query)}"`);
  if (a.country) lines.push(`- country: ${a.country.code} (${inline(a.country.name)})`);
  if (a.transnational !== undefined) lines.push(`- transnational: ${a.transnational}`);
  if (a.designated_from !== undefined) lines.push(`- designated_from: ${a.designated_from}`);
  if (a.designated_to !== undefined) lines.push(`- designated_to: ${a.designated_to}`);
  if (a.near)
    lines.push(`- near: ${a.near.latitude}, ${a.near.longitude} within ${a.near.radius_km} km`);
  lines.push(
    `- sort: ${a.sort}`,
    `- limit: ${a.limit}`,
    `- include_description: ${a.include_description}`,
  );
  return lines.join('\n');
}
