/**
 * @fileoverview Full-record builders shared by the get tools and the resources.
 * `buildSiteRecord`, `buildElementRecord`, and `buildReserveRecord` produce the
 * `unesco_get_site`, `unesco_get_intangible_heritage_element`, and
 * `unesco_get_biosphere_reserve` payloads from loaded records. Each builder
 * names the payload's fields explicitly, so the resources (which serialize the
 * builder's return as-is) never carry loader-internal fields.
 * @module services/unesco-datahub/records
 */

import type { BiosphereReserve, HeritageSite, IntangibleElement, SiteComponent } from './types.js';
import { CRITERIA, type CriterionCode } from './vocabulary.js';

/** The `unesco_get_site` payload. */
export interface SiteRecord {
  area_hectares?: number;
  category: HeritageSite['category'];
  components: SiteComponent[];
  components_total: number;
  components_unparsed: number;
  country_codes: string[];
  criteria: { code: CriterionCode; meaning: string; source: 'recorded' | 'inferred' }[];
  danger_listed_year?: number;
  description?: string;
  id_no: string;
  image?: { url: string; copyright?: string; author?: string };
  in_danger: boolean;
  inscribed_year: number;
  justification?: string;
  latitude?: number;
  longitude?: number;
  name: string;
  names: HeritageSite['names'];
  region: HeritageSite['region'];
  secondary_years: number[];
  states: string[];
  transboundary: boolean;
  url: string;
}

/** The UNESCO page URL for a site. */
export function sitePageUrl(idNo: string): string {
  return `https://whc.unesco.org/en/list/${idNo}/`;
}

/** Builds the full site record, listing at most `maxComponents` parsed components. */
export function buildSiteRecord(site: HeritageSite, maxComponents: number): SiteRecord {
  const { components, criteria_inferred, criteria, ...rest } = site;
  return {
    ...rest,
    criteria: criteria.map((code) => ({
      code,
      meaning: CRITERIA[code].meaning,
      source: criteria_inferred.includes(code) ? 'inferred' : 'recorded',
    })),
    components: components.slice(0, maxComponents),
    url: sitePageUrl(site.id_no),
  };
}

/** The `unesco_get_intangible_heritage_element` payload. */
export type ElementRecord = Pick<
  IntangibleElement,
  | 'ich_ref'
  | 'name'
  | 'name_fr'
  | 'list'
  | 'country_codes'
  | 'countries'
  | 'multinational'
  | 'inscribed_year'
  | 'description'
  | 'concepts'
  | 'concepts_secondary'
  | 'world_heritage_sites'
  | 'url'
  | 'image'
>;

/** Builds the full intangible heritage element record. */
export function buildElementRecord(e: IntangibleElement): ElementRecord {
  return {
    ich_ref: e.ich_ref,
    name: e.name,
    name_fr: e.name_fr,
    list: e.list,
    country_codes: e.country_codes,
    countries: e.countries,
    multinational: e.multinational,
    inscribed_year: e.inscribed_year,
    description: e.description,
    concepts: e.concepts,
    concepts_secondary: e.concepts_secondary,
    world_heritage_sites: e.world_heritage_sites,
    url: e.url,
    ...(e.image ? { image: e.image } : {}),
  };
}

/** The `unesco_get_biosphere_reserve` payload. */
export type ReserveRecord = Pick<
  BiosphereReserve,
  | 'mab_id'
  | 'name'
  | 'country_code'
  | 'country'
  | 'regions'
  | 'regional_network'
  | 'designation_year'
  | 'extension_years'
  | 'renaming_years'
  | 'periodic_review_years'
  | 'transboundary'
  | 'sids'
  | 'area_hectares'
  | 'population'
  | 'latitude'
  | 'longitude'
  | 'introduction'
  | 'ecological_characteristics'
  | 'socio_economic_characteristics'
  | 'website'
  | 'url'
>;

/** Builds the full biosphere reserve record. Areas and populations pass through as recorded. */
export function buildReserveRecord(r: BiosphereReserve): ReserveRecord {
  return {
    mab_id: r.mab_id,
    name: r.name,
    country_code: r.country_code,
    country: r.country,
    regions: r.regions,
    ...(r.regional_network ? { regional_network: r.regional_network } : {}),
    designation_year: r.designation_year,
    extension_years: r.extension_years,
    renaming_years: r.renaming_years,
    periodic_review_years: r.periodic_review_years,
    transboundary: r.transboundary,
    sids: r.sids,
    area_hectares: r.area_hectares,
    population: r.population,
    latitude: r.latitude,
    longitude: r.longitude,
    introduction: r.introduction,
    ...(r.ecological_characteristics
      ? { ecological_characteristics: r.ecological_characteristics }
      : {}),
    ...(r.socio_economic_characteristics
      ? { socio_economic_characteristics: r.socio_economic_characteristics }
      : {}),
    ...(r.website ? { website: r.website } : {}),
    url: r.url,
  };
}
