/**
 * @fileoverview unesco_search_sites — searches the World Heritage List by
 * keyword, country, category, region, criteria, inscription years,
 * Danger-list and transboundary status, or distance from a point, with facet
 * counts over the whole match and cursor paging.
 * @module mcp-server/tools/definitions/search-sites.tool
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
  includeDescriptionInput,
  isBlank,
  limitInput,
  MAX_QUERY_WORDS,
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
  compareNumericId,
  compareOptional,
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
import type { HeritageSite, SiteComponent } from '@/services/unesco-datahub/types.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import {
  CATEGORIES,
  CRITERIA,
  CRITERIA_CODES,
  REGIONS,
} from '@/services/unesco-datahub/vocabulary.js';

const SORTS = [
  'relevance',
  'name',
  'inscribed_newest',
  'inscribed_oldest',
  'area_largest',
  'danger_listed_newest',
  'distance',
] as const;

const MATCH_TIERS = ['name', 'description', 'justification'] as const;

/** `1`–`10` (number or digit string), `(iv)`, `IV` → the numeral. */
function normalizeCriterion(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10) {
    return CRITERIA_CODES[value - 1];
  }
  if (typeof value !== 'string') return value;
  const folded = value.trim().toLowerCase().replace(/[()]/g, '');
  return /^(?:10|[1-9])$/.test(folded) ? CRITERIA_CODES[Number(folded) - 1] : folded;
}

const CRITERIA_MEANINGS = CRITERIA_CODES.map((c) => `(${c}) ${CRITERIA[c].meaning}`).join(' ');

const SiteRow = z
  .object({
    id_no: z
      .string()
      .describe('World Heritage id_no; pass to unesco_get_site for the full record.'),
    name: z.string().describe('English name.'),
    category: z.enum(CATEGORIES).describe('Cultural, Natural, or Mixed.'),
    states: z
      .array(z.string().describe('State Party name.'))
      .describe('States Parties as UNESCO names them.'),
    country_codes: z
      .array(z.string().describe('ISO 3166-1 alpha-2 code.'))
      .describe(
        'ISO 3166-1 alpha-2 codes aligned with states; empty for the one site without a code.',
      ),
    region: z.enum(REGIONS).describe('UNESCO region.'),
    transboundary: z.boolean().describe('True when the site spans more than one State Party.'),
    inscribed_year: z.number().describe('Year of inscription.'),
    criteria: z
      .array(z.enum(CRITERIA_CODES).describe('Criterion numeral.'))
      .describe('Inscription criteria (recorded plus inferred), in numeral order.'),
    criteria_inferred: z
      .array(z.enum(CRITERIA_CODES).describe('Criterion numeral.'))
      .optional()
      .describe(
        'The subset of criteria inferred from the statement of Outstanding Universal Value (in practice vi); present only when non-empty.',
      ),
    in_danger: z.boolean().describe('True when on the List of World Heritage in Danger.'),
    danger_listed_year: z
      .number()
      .optional()
      .describe('Year of the current Danger-list entry, when in danger.'),
    area_hectares: z.number().optional().describe('Area in hectares, when recorded.'),
    latitude: z.number().optional().describe('Representative point latitude, when recorded.'),
    longitude: z.number().optional().describe('Representative point longitude, when recorded.'),
    distance_km: z
      .number()
      .optional()
      .describe(
        "Distance in km from the near point to the nearest of the site's representative point and its components (present when near is set).",
      ),
    nearest_component: z
      .object({
        ref: z.string().describe('Component reference.'),
        name: z.string().optional().describe('Component name; absent when UNESCO lists none.'),
        latitude: z.number().describe('Component point latitude.'),
        longitude: z.number().describe('Component point longitude.'),
      })
      .optional()
      .describe(
        'The component distance_km is measured to; present when near is set and a component is nearer than the representative point at distance_km precision (0.1 km; a tie keeps the representative point), or the site has no representative point.',
      ),
    matched_in: z
      .enum(MATCH_TIERS)
      .optional()
      .describe(
        'The first field tier by which every query word had matched; justification is the statement of Outstanding Universal Value (present when query is set).',
      ),
    description: z
      .string()
      .optional()
      .describe(
        "UNESCO's short description, when recorded; omitted from every row when include_description is false.",
      ),
  })
  .describe('One World Heritage site.');
type SiteRowT = z.infer<typeof SiteRow>;

const CountryFacet = z
  .object({
    code: z
      .string()
      .optional()
      .describe('ISO 3166-1 alpha-2 code; absent for the State-Party entry without one.'),
    name: z.string().describe('Country name.'),
    count: z.number().describe('Matching sites listing the country.'),
  })
  .describe('One country count.');

const FacetsSchema = z
  .object({
    category: z.record(z.string(), z.number()).describe('Matching sites per category.'),
    region: z.record(z.string(), z.number()).describe('Matching sites per region.'),
    in_danger: z
      .object({
        true: z.number().describe('Matching sites in danger.'),
        false: z.number().describe('Matching sites not in danger.'),
      })
      .describe('Matching sites by Danger-list status.'),
    criteria: z
      .record(z.string(), z.number())
      .describe('Matching sites per criterion; the vi count is inferred.'),
    top_countries: z
      .array(CountryFacet)
      .describe(
        'Top 10 countries by matching-site count, ties by code with the code-less State-Party entry last; a transboundary site counts once for each of its countries.',
      ),
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
    category: z.enum(CATEGORIES).optional().describe('Category filter.'),
    region: z.enum(REGIONS).optional().describe('Region filter.'),
    criteria: z
      .array(z.enum(CRITERIA_CODES).describe('Criterion numeral.'))
      .optional()
      .describe('Required criteria.'),
    in_danger: z.boolean().optional().describe('Danger-list filter.'),
    transboundary: z.boolean().optional().describe('Transboundary filter.'),
    inscribed_from: z.number().optional().describe('Earliest inscription year.'),
    inscribed_to: z.number().optional().describe('Latest inscription year.'),
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
    include_description: z.boolean().describe('Whether rows carry their description.'),
  })
  .describe('The filters and sort as the server applied them.');
type AppliedFilters = z.infer<typeof AppliedFiltersSchema>;

export const searchSitesTool = tool('unesco_search_sites', {
  title: 'Search World Heritage sites',
  description:
    "Search the UNESCO World Heritage List by keyword, country, category (Cultural, Natural, Mixed), region, inscription criteria (i)–(x), inscription year range, Danger-list status, transboundary status, or distance from a point. Every keyword must appear at the start of a word in a site's name (any of six languages), description, or statement of Outstanding Universal Value, and name matches rank first. A country is an ISO 3166-1 alpha-2 or alpha-3 code and matches every site it shares, transboundary sites included. Set in_danger to true for the List of World Heritage in Danger; the data records the year of each site's current Danger-list entry but no threat factors. Criterion (vi) is inferred from each site's statement of Outstanding Universal Value and marked as inferred. Results page with next_cursor and carry facet counts over the whole match.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: queryInput(
      `Keywords; every word must match the start of a word in a site's name (any of six languages), description, or statement of Outstanding Universal Value. Case, accents, and punctuation are ignored, so the query must contain at least one letter or digit and at most ${MAX_QUERY_WORDS} distinct words; no phrases, operators, or fuzzy matching.`,
    ),
    country: countryInput(
      'ISO 3166-1 alpha-2 or alpha-3 code, any case (FR, FRA). Matches every site the country takes part in, transboundary sites included. For a country name, look up its code with unesco_list_reference (topic countries).',
    ),
    category: blankAsUnset(z.enum(CATEGORIES).optional(), foldToEnum(CATEGORIES)).describe(
      'Site category: Cultural, Natural, or Mixed.',
    ),
    region: regionInput(
      'UNESCO region: Africa, Arab States, Asia and the Pacific, Europe and North America, or Latin America and the Caribbean (codes AFR, ARB, APA, EUR, LAC accepted).',
    ),
    criteria: z
      .preprocess(
        (value) =>
          isBlank(value) || (Array.isArray(value) && value.length === 0) ? undefined : value,
        z
          .array(
            z
              .preprocess(normalizeCriterion, z.enum(CRITERIA_CODES))
              .describe('A criterion numeral i–x; 1–10 and (iv)-style forms are accepted.'),
          )
          .max(10)
          .optional(),
      )
      .describe(
        `Inscription criteria a site must all carry. ${CRITERIA_MEANINGS} Criterion (vi) is inferred from the statement of Outstanding Universal Value, since UNESCO's criteria fields omit it.`,
      ),
    in_danger: booleanInput(
      'true: only sites on the List of World Heritage in Danger. false: only sites not on it. Omit for both.',
    ),
    transboundary: booleanInput(
      'true: only sites shared by more than one State Party. false: only single-State sites.',
    ),
    inscribed_from: yearInput('Earliest inscription year, inclusive.'),
    inscribed_to: yearInput('Latest inscription year, inclusive.'),
    near: nearInput(
      'Only sites within radius_km of this point: a site matches when its representative point or any of its components lies within the radius, and a site with neither never matches. distance_km and the distance sort use the nearest of those points.',
    ),
    sort: blankAsUnset(z.enum(SORTS).optional()).describe(
      'Result order. Default: relevance when query is set, else distance when near is set, else name. relevance needs query; distance needs near. Absent areas and Danger years sort last.',
    ),
    include_description: includeDescriptionInput(
      "Set false to leave each row's description out of the response (default true); unesco_get_site returns it. Which sites match, their order, and matched_in are unchanged.",
    ),
    limit: limitInput,
    cursor: cursorInput,
  }),
  output: z.object({
    sites: z.array(SiteRow).describe('Matching sites on this page.'),
    next_cursor: z
      .string()
      .optional()
      .describe(
        'Pass as cursor, with the same filters and sort, to fetch the next page. Present when more results remain.',
      ),
    descriptions_omitted: z
      .literal(true)
      .optional()
      .describe(
        'Present when include_description is false: no row carries its description, which unesco_get_site returns.',
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
        'Call unesco_list_reference with topic countries and filter set to the country name to find its ISO code, then call unesco_search_sites again with that code.',
    },
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'inscribed_from is later than inscribed_to',
      severity: 'notice',
      recovery:
        'Set inscribed_from to a year at or before inscribed_to, then call unesco_search_sites again.',
    },
    {
      reason: 'sort_needs_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sort relevance without query, or sort distance without near',
      severity: 'notice',
      recovery:
        'Add query for sort relevance or near for sort distance, or call unesco_search_sites with sort name, inscribed_newest, inscribed_oldest, area_largest, or danger_listed_newest.',
    },
    {
      reason: 'cursor_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'cursor was issued for different filters or sort, or for an earlier data snapshot',
      severity: 'notice',
      recovery:
        'Call unesco_search_sites again with the same filters and no cursor, then page with the next_cursor it returns.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'cursor is malformed, or its offset or limit is not a non-negative whole number',
      severity: 'notice',
      thrownBy: 'service',
      recovery:
        'Call unesco_search_sites without cursor to start from the first page, or pass the next_cursor from the previous response unchanged.',
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No World Heritage snapshot has loaded yet and the Data Hub is unreachable, erroring, or rate-limiting',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the World Heritage List; wait until the next load attempt this error names (retryAfter, in seconds), then call unesco_search_sites again.',
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
    const sort = input.sort ?? (input.query ? 'relevance' : input.near ? 'distance' : 'name');
    if ((sort === 'relevance' && !input.query) || (sort === 'distance' && !input.near)) {
      throw ctx.fail(
        'sort_needs_input',
        `sort ${sort} needs ${sort === 'relevance' ? 'query' : 'near'}.`,
      );
    }

    const heritage = await getUnescoDataHubService().getHeritage(ctx);
    const { records, folded } = heritage;

    let country: { code: string; name: string } | undefined;
    if (input.country) {
      if (!isAssignedAlpha2(input.country) && !heritage.codes.has(input.country)) {
        throw ctx.fail(
          'unknown_country',
          `"${inline(input.country)}" is not an ISO 3166-1 alpha-2 or alpha-3 country code.`,
          { country: input.country },
        );
      }
      country = { code: input.country, name: countryDisplayName(input.country) };
    }

    const criteria = input.criteria
      ? CRITERIA_CODES.filter((c) => input.criteria?.includes(c))
      : undefined;
    const applied: AppliedFilters = {
      ...(input.query ? { query: input.query } : {}),
      ...(country ? { country } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.region ? { region: input.region } : {}),
      ...(criteria ? { criteria } : {}),
      ...(input.in_danger !== undefined ? { in_danger: input.in_danger } : {}),
      ...(input.transboundary !== undefined ? { transboundary: input.transboundary } : {}),
      ...(input.inscribed_from !== undefined ? { inscribed_from: input.inscribed_from } : {}),
      ...(input.inscribed_to !== undefined ? { inscribed_to: input.inscribed_to } : {}),
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
      if (cursor.fp !== fp || cursor.asOf !== heritage.asOf) {
        throw ctx.fail(
          'cursor_mismatch',
          'The cursor was issued for different filters or sort, or for an earlier data snapshot.',
        );
      }
      offset = cursor.offset;
    }

    ctx.enrich({ sources: [sourceOf(heritage)], applied_filters: applied });

    const words = input.query ? queryWords(input.query) : [];
    const tierOf = input.query ? folded.map((tiers) => matchTier(words, tiers)) : [];
    const near = input.near;
    const nearest = near ? records.map((s) => nearestPoint(s, near.latitude, near.longitude)) : [];
    const distanceOf = nearest.map((n) => n?.km);

    const filters: NamedFilter<HeritageSite>[] = [];
    if (input.query) filters.push({ name: 'query', test: (_s, i) => tierOf[i] !== undefined });
    if (country) {
      const code = country.code;
      filters.push({ name: 'country', test: (s) => s.country_codes.includes(code) });
    }
    if (input.category)
      filters.push({ name: 'category', test: (s) => s.category === input.category });
    if (input.region) filters.push({ name: 'region', test: (s) => s.region === input.region });
    if (criteria)
      filters.push({
        name: 'criteria',
        test: (s) => criteria.every((c) => s.criteria.includes(c)),
      });
    if (input.in_danger !== undefined)
      filters.push({ name: 'in_danger', test: (s) => s.in_danger === input.in_danger });
    if (input.transboundary !== undefined) {
      filters.push({ name: 'transboundary', test: (s) => s.transboundary === input.transboundary });
    }
    const from = input.inscribed_from;
    if (from !== undefined)
      filters.push({ name: 'inscribed_from', test: (s) => s.inscribed_year >= from });
    const to = input.inscribed_to;
    if (to !== undefined)
      filters.push({ name: 'inscribed_to', test: (s) => s.inscribed_year <= to });
    if (near) {
      filters.push({
        name: 'near',
        test: (_s, i) => {
          const d = distanceOf[i];
          return d !== undefined && d <= near.radius_km;
        },
      });
    }

    const matched = applyFilters(records, filters);
    const total = matched.length;
    ctx.enrich.total(total);
    ctx.enrich({ facets: siteFacets(matched.map((i) => records[i] as HeritageSite)) });

    matched.sort(siteComparator(sort, records, tierOf, distanceOf));
    const page = matched
      .slice(offset, offset + input.limit)
      .map((i) =>
        toRow(records[i] as HeritageSite, tierOf[i], nearest[i], input.include_description),
      );
    ctx.enrich({ truncated: false, shown: page.length, cap: input.limit });

    const fragments: string[] = [];
    if (total === 0) {
      if (filters.length >= 2) {
        fragments.push(
          combinedFiltersFragment('site', filters.length, bestSingleRemoval(records, filters)),
        );
      }
      const alone = (name: string) => {
        const filter = filters.find((f) => f.name === name);
        return filter ? applyFilters(records, [filter]).length : undefined;
      };
      if (country && alone('country') === 0) {
        fragments.push(
          `No World Heritage site lists ${country.code} (${country.name}) among its States Parties. unesco_list_reference with topic countries shows how many sites each country has.`,
        );
      }
      if (input.query && alone('query') === 0) {
        fragments.push(
          `No site's name, description, or statement of Outstanding Universal Value contains every word of "${inline(input.query)}" (each word matches at the start of a word, and all are required). Try fewer or broader words.`,
        );
      }
      if (near && alone('near') === 0) {
        const pointless = nearest.filter((n) => n === undefined).length;
        const neverMatch =
          pointless > 0
            ? `, and ${countOf(pointless, 'site')} ${pointless === 1 ? 'has' : 'have'} no coordinates at all, so ${pointless === 1 ? 'it never matches' : 'they never match'} near`
            : '';
        fragments.push(
          `No site's representative point or component lies within ${near.radius_km} km of (${near.latitude}, ${near.longitude})${neverMatch}. Increase radius_km.`,
        );
      }
    }
    if (input.cursor && total > 0 && offset >= total) {
      fragments.push(
        `The cursor is past the last of ${countOf(total, 'result')}. Call unesco_search_sites without cursor to start over.`,
      );
    }
    if (criteria?.includes('vi')) {
      const viSites = records.filter((s) => s.criteria_inferred.includes('vi')).length;
      fragments.push(
        `UNESCO's criteria fields omit criterion (vi). This server infers it from each site's statement of Outstanding Universal Value, which names it for ${countOf(viSites, 'site')}, and marks it in criteria_inferred.`,
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
        asOf: heritage.asOf,
      });
    } else if (notice) {
      ctx.enrich.notice(notice);
    }

    ctx.log.info('Sites searched', { total, shown: page.length, offset, sort });
    return {
      sites: page,
      ...(next_cursor ? { next_cursor } : {}),
      ...(input.include_description ? {} : { descriptions_omitted: true as const }),
    };
  },

  format: (result) => {
    const lines = [`**${countOf(result.sites.length, 'World Heritage site')} on this page**`];
    if (result.descriptions_omitted) {
      lines.push(
        "Descriptions omitted (include_description: false); unesco_get_site returns a site's description.",
      );
    }
    for (const s of result.sites) {
      const states = s.states.map((state, i) => {
        const code = s.country_codes[i];
        return code ? `${inline(state)} (${code})` : inline(state);
      });
      const criteria = s.criteria.length > 0 ? s.criteria.join(', ') : 'none recorded';
      const inferred = s.criteria_inferred?.length
        ? ` (${s.criteria_inferred.join(', ')} inferred)`
        : '';
      const facts = [
        s.category,
        s.region,
        states.join(', '),
        `Transboundary: ${s.transboundary ? 'Yes' : 'No'}`,
        `Inscribed ${s.inscribed_year}`,
        `Criteria: ${criteria}${inferred}`,
        s.in_danger
          ? `In Danger${s.danger_listed_year !== undefined ? ` since ${s.danger_listed_year}` : ''}`
          : 'Not in Danger',
        s.area_hectares !== undefined ? `Area: ${s.area_hectares} ha` : 'Area: Not available',
        s.latitude !== undefined && s.longitude !== undefined
          ? `Coordinates: ${s.latitude}, ${s.longitude}`
          : 'Coordinates: Not available',
        ...(s.distance_km !== undefined
          ? [`Distance: ${s.distance_km} km${componentNote(s.nearest_component)}`]
          : []),
        ...(s.matched_in ? [`Matched in: ${s.matched_in}`] : []),
      ];
      lines.push('', `### ${inline(s.name)} (id_no ${s.id_no})`, facts.join(' · '));
      if (s.description) lines.push(quote(s.description));
      else if (!result.descriptions_omitted) lines.push('Description: Not available');
    }
    if (result.next_cursor) lines.push('', `Next cursor: ${result.next_cursor}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** A site's distance from the `near` point, and the component it was measured to, if any. */
interface NearestPoint {
  component?: SiteComponent;
  km: number;
}

/**
 * The nearest of a site's points to (lat, lon), on the rounded distance: its
 * representative point unless a component is strictly nearer, in which case the
 * nearest component (the earlier in UNESCO order on a tie). Undefined when the
 * site has neither.
 */
function nearestPoint(site: HeritageSite, lat: number, lon: number): NearestPoint | undefined {
  let nearest: NearestPoint | undefined =
    site.latitude !== undefined && site.longitude !== undefined
      ? { km: haversineKm(lat, lon, site.latitude, site.longitude) }
      : undefined;
  for (const component of site.components) {
    const km = haversineKm(lat, lon, component.latitude, component.longitude);
    if (!nearest || km < nearest.km) nearest = { km, component };
  }
  return nearest;
}

/**
 * ` (component {ref} {name} at {lat}, {lon})` for the distance fact, the name
 * left out for a nameless component; empty when no component is nearest.
 */
function componentNote(component: SiteRowT['nearest_component']): string {
  if (!component) return '';
  const name = component.name ? ` ${inline(component.name)}` : '';
  return ` (component ${inline(component.ref)}${name} at ${component.latitude}, ${component.longitude})`;
}

function toRow(
  site: HeritageSite,
  tier: number | undefined,
  nearest: NearestPoint | undefined,
  includeDescription: boolean,
): SiteRowT {
  return {
    id_no: site.id_no,
    name: site.name,
    category: site.category,
    states: site.states,
    country_codes: site.country_codes,
    region: site.region,
    transboundary: site.transboundary,
    inscribed_year: site.inscribed_year,
    criteria: site.criteria,
    ...(site.criteria_inferred.length > 0 ? { criteria_inferred: site.criteria_inferred } : {}),
    in_danger: site.in_danger,
    ...(site.danger_listed_year !== undefined
      ? { danger_listed_year: site.danger_listed_year }
      : {}),
    ...(site.area_hectares !== undefined ? { area_hectares: site.area_hectares } : {}),
    ...(site.latitude !== undefined ? { latitude: site.latitude } : {}),
    ...(site.longitude !== undefined ? { longitude: site.longitude } : {}),
    ...(nearest ? { distance_km: nearest.km } : {}),
    ...(nearest?.component ? { nearest_component: nearest.component } : {}),
    ...(tier !== undefined ? { matched_in: MATCH_TIERS[tier] } : {}),
    ...(includeDescription && site.description ? { description: site.description } : {}),
  };
}

function siteComparator(
  sort: (typeof SORTS)[number],
  records: readonly HeritageSite[],
  tierOf: readonly (number | undefined)[],
  distanceOf: readonly (number | undefined)[],
): (a: number, b: number) => number {
  const site = (i: number) => records[i] as HeritageSite;
  const byId = (a: number, b: number) => compareNumericId(site(a).id_no, site(b).id_no);
  const byName = (a: number, b: number) => compareText(site(a).name, site(b).name) || byId(a, b);
  switch (sort) {
    case 'relevance':
      return (a, b) => (tierOf[a] ?? 0) - (tierOf[b] ?? 0) || byName(a, b);
    case 'name':
      return byName;
    case 'inscribed_newest':
      return (a, b) => site(b).inscribed_year - site(a).inscribed_year || byId(a, b);
    case 'inscribed_oldest':
      return (a, b) => site(a).inscribed_year - site(b).inscribed_year || byId(a, b);
    case 'area_largest':
      return (a, b) =>
        compareOptional(site(a).area_hectares, site(b).area_hectares, 'desc') || byId(a, b);
    case 'danger_listed_newest':
      return (a, b) =>
        compareOptional(site(a).danger_listed_year, site(b).danger_listed_year, 'desc') ||
        byId(a, b);
    case 'distance':
      return (a, b) => compareOptional(distanceOf[a], distanceOf[b], 'asc') || byId(a, b);
  }
}

function siteFacets(sites: readonly HeritageSite[]): Facets {
  const countryKeys = sites.flatMap((s) =>
    s.country_codes.length > 0
      ? [...new Set(s.country_codes)]
      : s.states.map((state) => `~${state}`),
  );
  return {
    category: countInto(
      CATEGORIES,
      sites.map((s) => s.category),
    ),
    region: countInto(
      REGIONS,
      sites.map((s) => s.region),
    ),
    in_danger: countBoolean(sites.map((s) => s.in_danger)),
    criteria: countInto(
      CRITERIA_CODES,
      sites.flatMap((s) => s.criteria),
    ),
    top_countries: topCounts(countryKeys, Number.POSITIVE_INFINITY)
      .sort(
        (a, b) =>
          b.count - a.count || Number(a.key.startsWith('~')) - Number(b.key.startsWith('~')),
      )
      .slice(0, 10)
      .map(({ key, count }) =>
        key.startsWith('~')
          ? { name: key.slice(1), count }
          : { code: key, name: countryDisplayName(key), count },
      ),
  };
}

function renderFacets(f: Facets): string {
  return [
    '### Facets (whole match)',
    `- Category: ${renderCounts(f.category)}`,
    `- Region: ${renderCounts(f.region)}`,
    `- In Danger: yes ${f.in_danger.true} · no ${f.in_danger.false}`,
    `- Criteria: ${renderCounts(f.criteria, (k) => (k === 'vi' ? 'vi (inferred)' : k))}`,
    `- Top countries: ${
      f.top_countries
        .map((c) => `${inline(c.name)}${c.code ? ` (${c.code})` : ''} ${c.count}`)
        .join(' · ') || 'none'
    }`,
  ].join('\n');
}

function renderAppliedFilters(a: AppliedFilters): string {
  const lines = ['### Applied filters'];
  if (a.query !== undefined) lines.push(`- query: "${inline(a.query)}"`);
  if (a.country) lines.push(`- country: ${a.country.code} (${inline(a.country.name)})`);
  if (a.category) lines.push(`- category: ${a.category}`);
  if (a.region) lines.push(`- region: ${a.region}`);
  if (a.criteria) lines.push(`- criteria: ${a.criteria.join(', ')}`);
  if (a.in_danger !== undefined) lines.push(`- in_danger: ${a.in_danger}`);
  if (a.transboundary !== undefined) lines.push(`- transboundary: ${a.transboundary}`);
  if (a.inscribed_from !== undefined) lines.push(`- inscribed_from: ${a.inscribed_from}`);
  if (a.inscribed_to !== undefined) lines.push(`- inscribed_to: ${a.inscribed_to}`);
  if (a.near)
    lines.push(`- near: ${a.near.latitude}, ${a.near.longitude} within ${a.near.radius_km} km`);
  lines.push(
    `- sort: ${a.sort}`,
    `- limit: ${a.limit}`,
    `- include_description: ${a.include_description}`,
  );
  return lines.join('\n');
}
