/**
 * @fileoverview unesco_search_biosphere_reserves — searches the World Network
 * of Biosphere Reserves (UNESCO Man and the Biosphere Programme) by keyword,
 * country, region, MAB regional network, designation years, transboundary or
 * SIDS status, or distance from a point, with facet counts over the whole
 * match and cursor paging.
 * @module mcp-server/tools/definitions/search-biosphere-reserves.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  combinedFiltersFragment,
  composePageNotice,
  countOf,
  pageEnrichment,
  renderSources,
} from '@/mcp-server/shared/enrichment.js';
import {
  blankAsUnset,
  booleanInput,
  countryInput,
  cursorInput,
  foldToEnum,
  limitInput,
  nearInput,
  queryInput,
  regionInput,
  yearInput,
} from '@/mcp-server/shared/inputs.js';
import { inline, quote } from '@/mcp-server/shared/markdown.js';
import { countryDisplayName, isAssignedAlpha2 } from '@/services/unesco-datahub/iso3166.js';
import {
  applyFilters,
  bestSingleRemoval,
  compareText,
  countBoolean,
  countInto,
  fingerprint,
  haversineKm,
  makeCursor,
  matchTier,
  type NamedFilter,
  queryWords,
  readCursor,
  topCounts,
} from '@/services/unesco-datahub/search.js';
import type { BiosphereReserve } from '@/services/unesco-datahub/types.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import {
  BIOSPHERE_NETWORK_NAMES,
  BIOSPHERE_NETWORKS,
  REGIONS,
} from '@/services/unesco-datahub/vocabulary.js';

const SORTS = [
  'relevance',
  'name',
  'designated_newest',
  'designated_oldest',
  'area_largest',
  'distance',
] as const;

const MATCH_TIERS = ['name', 'introduction', 'characteristics'] as const;

/** The `regional_network` facet key for reserves outside every network. */
const NO_NETWORK = 'none';

const NETWORK_ALIASES = Object.fromEntries(BIOSPHERE_NETWORKS.map((n) => [n.acronym, n.name]));

const ReserveRow = z
  .object({
    mab_id: z
      .string()
      .describe('Biosphere reserve id; pass to unesco_get_biosphere_reserve for the full record.'),
    name: z.string().describe('English name.'),
    country_code: z.string().describe('ISO 3166-1 alpha-2 code of the reserve country.'),
    country: z.string().describe('Country name as UNESCO records it.'),
    regions: z
      .array(z.enum(REGIONS).describe('UNESCO region.'))
      .describe('UNESCO regions the reserve belongs to.'),
    regional_network: z
      .enum(BIOSPHERE_NETWORK_NAMES)
      .optional()
      .describe('MAB regional network, when the reserve belongs to one.'),
    designation_year: z.number().describe('Year of designation.'),
    transboundary: z
      .boolean()
      .describe('True for a transboundary reserve; each participating country has its own mab_id.'),
    sids: z.boolean().describe('True when the reserve is in a Small Island Developing State.'),
    area_total_hectares: z
      .number()
      .describe('Total area in hectares, as recorded (unit inferred; undocumented upstream).'),
    area_marine_hectares: z.number().describe('Total marine area in hectares, as recorded.'),
    population_total: z
      .number()
      .describe('Resident population, as recorded; 0 can mean none or unreported.'),
    latitude: z.number().describe('Representative point latitude.'),
    longitude: z.number().describe('Representative point longitude.'),
    distance_km: z
      .number()
      .optional()
      .describe('Distance from the near point in km (present when near is set).'),
    matched_in: z
      .enum(MATCH_TIERS)
      .optional()
      .describe(
        'The first field tier by which every query word had matched (present when query is set).',
      ),
    introduction: z.string().describe("UNESCO's introduction to the reserve."),
  })
  .describe('One biosphere reserve.');
type ReserveRowT = z.infer<typeof ReserveRow>;

const FacetsSchema = z
  .object({
    region: z
      .record(z.string(), z.number())
      .describe('Matching reserves per region; a reserve in two regions counts in both.'),
    regional_network: z
      .record(z.string(), z.number())
      .describe(
        `Matching reserves per MAB regional network; "${NO_NETWORK}" counts those in none.`,
      ),
    transboundary: z
      .object({
        true: z.number().describe('Matching transboundary reserves.'),
        false: z.number().describe('Matching single-country reserves.'),
      })
      .describe('Matching reserves by transboundary status.'),
    sids: z
      .object({
        true: z.number().describe('Matching reserves in Small Island Developing States.'),
        false: z.number().describe('Matching reserves elsewhere.'),
      })
      .describe('Matching reserves by Small Island Developing State status.'),
    top_countries: z
      .array(
        z
          .object({
            code: z.string().describe('ISO 3166-1 alpha-2 code.'),
            name: z.string().describe('Country name.'),
            count: z.number().describe('Matching reserves in the country.'),
          })
          .describe('One country count.'),
      )
      .describe('Top 10 countries.'),
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
    region: z.enum(REGIONS).optional().describe('Region filter.'),
    regional_network: z
      .enum(BIOSPHERE_NETWORK_NAMES)
      .optional()
      .describe('MAB regional network filter.'),
    transboundary: z.boolean().optional().describe('Transboundary filter.'),
    sids: z.boolean().optional().describe('Small Island Developing State filter.'),
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
  })
  .describe('The filters and sort as the server applied them.');
type AppliedFilters = z.infer<typeof AppliedFiltersSchema>;

export const searchBiosphereReservesTool = tool('unesco_search_biosphere_reserves', {
  title: 'Search biosphere reserves',
  description:
    "Search the World Network of Biosphere Reserves (UNESCO Man and the Biosphere Programme) by keyword, country, region, MAB regional network, designation year range, transboundary or Small Island Developing States status, or distance from a point. Every keyword must appear at the start of a word in the reserve's name, introduction, or ecological or socio-economic description; there is no biome or ecosystem field, so an ecosystem search is a keyword search such as mangrove or alpine. A country is an ISO 3166-1 alpha-2 or alpha-3 code. A transboundary reserve appears once per participating country, each with its own mab_id. Results page with next_cursor and carry facet counts over the whole match.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: queryInput(
      "Keywords; every word must match the start of a word in the reserve's name, introduction, or ecological or socio-economic description. Case, accents, and punctuation are ignored, so the query must contain at least one letter or digit; no phrases, operators, or fuzzy matching. For an ecosystem, use a habitat word such as mangrove, wetland, or alpine.",
    ),
    country: countryInput(
      "ISO 3166-1 alpha-2 or alpha-3 code, any case (FR, FRA). Matches the reserve's country; a transboundary reserve has one row per participating country. For a country name, look up its code with unesco_list_reference (topic countries).",
    ),
    region: regionInput(
      "UNESCO region: Africa, Arab States, Asia and the Pacific, Europe and North America, or Latin America and the Caribbean (codes AFR, ARB, APA, EUR, LAC accepted). Matches any of a reserve's regions.",
    ),
    regional_network: blankAsUnset(
      z.enum(BIOSPHERE_NETWORK_NAMES).optional(),
      foldToEnum(BIOSPHERE_NETWORK_NAMES, NETWORK_ALIASES),
    ).describe(
      `MAB regional network, by full name or acronym (${BIOSPHERE_NETWORKS.map((n) => n.acronym).join(', ')}), any case. A few reserves belong to no network.`,
    ),
    transboundary: booleanInput(
      'true: only transboundary reserves (one row per participating country). false: only single-country reserves.',
    ),
    sids: booleanInput(
      'true: only reserves in Small Island Developing States. false: only reserves elsewhere.',
    ),
    designated_from: yearInput('Earliest designation year, inclusive.'),
    designated_to: yearInput('Latest designation year, inclusive.'),
    near: nearInput('Only reserves within radius_km of this point. Every reserve has coordinates.'),
    sort: blankAsUnset(z.enum(SORTS).optional()).describe(
      'Result order. Default: relevance when query is set, else distance when near is set, else name. relevance needs query; distance needs near. area_largest orders by total recorded area.',
    ),
    limit: limitInput,
    cursor: cursorInput,
  }),
  output: z.object({
    reserves: z.array(ReserveRow).describe('Matching reserves on this page.'),
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
      recovery:
        'Call unesco_list_reference with topic countries and filter set to the country name to find its ISO code, then call unesco_search_biosphere_reserves again with that code.',
    },
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'designated_from is later than designated_to',
      recovery:
        'Set designated_from to a year at or before designated_to, then call unesco_search_biosphere_reserves again.',
    },
    {
      reason: 'sort_needs_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sort relevance without query, or sort distance without near',
      recovery:
        'Add query for sort relevance or near for sort distance, or call unesco_search_biosphere_reserves with sort name, designated_newest, designated_oldest, or area_largest.',
    },
    {
      reason: 'cursor_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'cursor was issued for different filters or sort, or for an earlier data snapshot',
      recovery:
        'Call unesco_search_biosphere_reserves again with the same filters and no cursor, then page with the next_cursor it returns.',
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No MAB snapshot has loaded yet and the Data Hub is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the biosphere reserve network; wait until the next load attempt this error names (retryAfter, in seconds), then call unesco_search_biosphere_reserves again.',
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

    const biosphere = await getUnescoDataHubService().getBiosphere(ctx);
    const { records, folded } = biosphere;

    let country: { code: string; name: string } | undefined;
    if (input.country) {
      if (!isAssignedAlpha2(input.country) && !biosphere.codes.has(input.country)) {
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
      ...(input.region ? { region: input.region } : {}),
      ...(input.regional_network ? { regional_network: input.regional_network } : {}),
      ...(input.transboundary !== undefined ? { transboundary: input.transboundary } : {}),
      ...(input.sids !== undefined ? { sids: input.sids } : {}),
      ...(input.designated_from !== undefined ? { designated_from: input.designated_from } : {}),
      ...(input.designated_to !== undefined ? { designated_to: input.designated_to } : {}),
      ...(input.near ? { near: input.near } : {}),
      sort,
      limit: input.limit,
    };
    const { limit: _limit, ...fingerprinted } = applied;
    const fp = fingerprint(fingerprinted);

    let offset = 0;
    if (input.cursor) {
      const cursor = readCursor(input.cursor, ctx);
      if (cursor.fp !== fp || cursor.asOf !== biosphere.asOf) {
        throw ctx.fail(
          'cursor_mismatch',
          'The cursor was issued for different filters or sort, or for an earlier data snapshot.',
        );
      }
      offset = cursor.offset;
    }

    ctx.enrich({ sources: [sourceOf(biosphere)], applied_filters: applied });

    const words = input.query ? queryWords(input.query) : [];
    const tierOf = input.query ? folded.map((tiers) => matchTier(words, tiers)) : [];
    const near = input.near;
    const distanceOf = near
      ? records.map((r) => haversineKm(near.latitude, near.longitude, r.latitude, r.longitude))
      : [];

    const filters: NamedFilter<BiosphereReserve>[] = [];
    if (input.query) filters.push({ name: 'query', test: (_r, i) => tierOf[i] !== undefined });
    if (country) {
      const code = country.code;
      filters.push({ name: 'country', test: (r) => r.country_code === code });
    }
    const region = input.region;
    if (region) filters.push({ name: 'region', test: (r) => r.regions.includes(region) });
    if (input.regional_network) {
      filters.push({
        name: 'regional_network',
        test: (r) => r.regional_network === input.regional_network,
      });
    }
    if (input.transboundary !== undefined) {
      filters.push({ name: 'transboundary', test: (r) => r.transboundary === input.transboundary });
    }
    if (input.sids !== undefined)
      filters.push({ name: 'sids', test: (r) => r.sids === input.sids });
    const from = input.designated_from;
    if (from !== undefined)
      filters.push({ name: 'designated_from', test: (r) => r.designation_year >= from });
    const to = input.designated_to;
    if (to !== undefined)
      filters.push({ name: 'designated_to', test: (r) => r.designation_year <= to });
    if (near) {
      filters.push({
        name: 'near',
        test: (_r, i) => (distanceOf[i] ?? Number.POSITIVE_INFINITY) <= near.radius_km,
      });
    }

    const matched = applyFilters(records, filters);
    const total = matched.length;
    ctx.enrich.total(total);
    ctx.enrich({ facets: reserveFacets(matched.map((i) => records[i] as BiosphereReserve)) });

    matched.sort(reserveComparator(sort, records, tierOf, distanceOf));
    const page = matched
      .slice(offset, offset + input.limit)
      .map((i) => toRow(records[i] as BiosphereReserve, tierOf[i], distanceOf[i]));
    ctx.enrich({ truncated: false, shown: page.length, cap: input.limit });

    const fragments: string[] = [];
    if (total === 0) {
      if (filters.length >= 2) {
        fragments.push(
          combinedFiltersFragment('reserve', filters.length, bestSingleRemoval(records, filters)),
        );
      }
      const alone = (name: string) => {
        const filter = filters.find((f) => f.name === name);
        return filter ? applyFilters(records, [filter]).length : undefined;
      };
      if (country && alone('country') === 0) {
        fragments.push(
          `No biosphere reserve lists ${country.code} (${country.name}) as its country. unesco_list_reference with topic countries shows how many reserves each country has.`,
        );
      }
      if (input.query && alone('query') === 0) {
        fragments.push(
          `No reserve's name, introduction, or ecological or socio-economic description contains every word of "${inline(input.query)}". There is no ecosystem-type field, so try a single habitat word (for example mangrove, wetland, or alpine) or fewer words.`,
        );
      }
      if (near && alone('near') === 0) {
        fragments.push(
          `No biosphere reserve lies within ${near.radius_km} km of (${near.latitude}, ${near.longitude}). Increase radius_km.`,
        );
      }
    }
    if (input.cursor && total > 0 && offset >= total) {
      fragments.push(
        `The cursor is past the last of ${countOf(total, 'result')}. Call unesco_search_biosphere_reserves without cursor to start over.`,
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
        asOf: biosphere.asOf,
      });
    } else if (notice) {
      ctx.enrich.notice(notice);
    }

    ctx.log.info('Biosphere reserves searched', { total, shown: page.length, offset, sort });
    return { reserves: page, ...(next_cursor ? { next_cursor } : {}) };
  },

  format: (result) => {
    const lines = [`**${countOf(result.reserves.length, 'biosphere reserve')} on this page**`];
    for (const r of result.reserves) {
      const facts = [
        `${inline(r.country)} (${r.country_code})`,
        r.regions.join(', '),
        r.regional_network ?? 'No regional network',
        `Designated ${r.designation_year}`,
        `Transboundary: ${r.transboundary ? 'Yes' : 'No'}`,
        `SIDS: ${r.sids ? 'Yes' : 'No'}`,
        `Area: ${r.area_total_hectares} ha (marine ${r.area_marine_hectares} ha)`,
        `Population: ${r.population_total}`,
        `Coordinates: ${r.latitude}, ${r.longitude}`,
        ...(r.distance_km !== undefined ? [`Distance: ${r.distance_km} km`] : []),
        ...(r.matched_in ? [`Matched in: ${r.matched_in}`] : []),
      ];
      lines.push(
        '',
        `### ${inline(r.name)} (${inline(r.mab_id)})`,
        facts.join(' · '),
        quote(r.introduction),
      );
    }
    if (result.next_cursor) lines.push('', `Next cursor: ${result.next_cursor}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function toRow(
  reserve: BiosphereReserve,
  tier: number | undefined,
  distance: number | undefined,
): ReserveRowT {
  return {
    mab_id: reserve.mab_id,
    name: reserve.name,
    country_code: reserve.country_code,
    country: reserve.country,
    regions: reserve.regions,
    ...(reserve.regional_network ? { regional_network: reserve.regional_network } : {}),
    designation_year: reserve.designation_year,
    transboundary: reserve.transboundary,
    sids: reserve.sids,
    area_total_hectares: reserve.area_hectares.total,
    area_marine_hectares: reserve.area_hectares.marine.total,
    population_total: reserve.population.total,
    latitude: reserve.latitude,
    longitude: reserve.longitude,
    ...(distance !== undefined ? { distance_km: distance } : {}),
    ...(tier !== undefined ? { matched_in: MATCH_TIERS[tier] } : {}),
    introduction: reserve.introduction,
  };
}

function reserveComparator(
  sort: (typeof SORTS)[number],
  records: readonly BiosphereReserve[],
  tierOf: readonly (number | undefined)[],
  distanceOf: readonly number[],
): (a: number, b: number) => number {
  const reserve = (i: number) => records[i] as BiosphereReserve;
  const byId = (a: number, b: number) => compareText(reserve(a).mab_id, reserve(b).mab_id);
  const byName = (a: number, b: number) =>
    compareText(reserve(a).name, reserve(b).name) || byId(a, b);
  switch (sort) {
    case 'relevance':
      return (a, b) => (tierOf[a] ?? 0) - (tierOf[b] ?? 0) || byName(a, b);
    case 'name':
      return byName;
    case 'designated_newest':
      return (a, b) => reserve(b).designation_year - reserve(a).designation_year || byId(a, b);
    case 'designated_oldest':
      return (a, b) => reserve(a).designation_year - reserve(b).designation_year || byId(a, b);
    case 'area_largest':
      return (a, b) =>
        reserve(b).area_hectares.total - reserve(a).area_hectares.total || byId(a, b);
    case 'distance':
      return (a, b) => (distanceOf[a] ?? 0) - (distanceOf[b] ?? 0) || byId(a, b);
  }
}

function reserveFacets(reserves: readonly BiosphereReserve[]): Facets {
  return {
    region: countInto(
      REGIONS,
      reserves.flatMap((r) => r.regions),
    ),
    regional_network: countInto(
      [...BIOSPHERE_NETWORK_NAMES, NO_NETWORK],
      reserves.map((r) => r.regional_network ?? NO_NETWORK),
    ),
    transboundary: countBoolean(reserves.map((r) => r.transboundary)),
    sids: countBoolean(reserves.map((r) => r.sids)),
    top_countries: topCounts(
      reserves.map((r) => r.country_code),
      10,
    ).map(({ key, count }) => ({ code: key, name: countryDisplayName(key), count })),
  };
}

function renderFacets(f: Facets): string {
  const counts = (record: Record<string, number>) =>
    Object.entries(record)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(' · ') || 'none';
  return [
    '### Facets (whole match)',
    `- Region: ${counts(f.region)}`,
    `- Regional network: ${counts(f.regional_network)}`,
    `- Transboundary: yes ${f.transboundary.true} · no ${f.transboundary.false}`,
    `- SIDS: yes ${f.sids.true} · no ${f.sids.false}`,
    `- Top countries: ${
      f.top_countries.map((c) => `${inline(c.name)} (${c.code}) ${c.count}`).join(' · ') || 'none'
    }`,
  ].join('\n');
}

function renderAppliedFilters(a: AppliedFilters): string {
  const lines = ['### Applied filters'];
  if (a.query !== undefined) lines.push(`- query: "${inline(a.query)}"`);
  if (a.country) lines.push(`- country: ${a.country.code} (${inline(a.country.name)})`);
  if (a.region) lines.push(`- region: ${a.region}`);
  if (a.regional_network) lines.push(`- regional_network: ${a.regional_network}`);
  if (a.transboundary !== undefined) lines.push(`- transboundary: ${a.transboundary}`);
  if (a.sids !== undefined) lines.push(`- sids: ${a.sids}`);
  if (a.designated_from !== undefined) lines.push(`- designated_from: ${a.designated_from}`);
  if (a.designated_to !== undefined) lines.push(`- designated_to: ${a.designated_to}`);
  if (a.near)
    lines.push(`- near: ${a.near.latitude}, ${a.near.longitude} within ${a.near.radius_km} km`);
  lines.push(`- sort: ${a.sort}`, `- limit: ${a.limit}`);
  return lines.join('\n');
}
