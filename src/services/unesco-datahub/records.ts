/**
 * @fileoverview Full-record builders shared by the get tools and the resources.
 * `buildSiteRecord`, `buildElementRecord`, `buildReserveRecord`, and
 * `buildGeoparkRecord` produce the `unesco_get_site`,
 * `unesco_get_intangible_heritage_element`, `unesco_get_biosphere_reserve`, and
 * `unesco_get_geopark` payloads from loaded records. Each builder names the
 * payload's fields explicitly, so the resources (which serialize the builder's
 * return as-is) never carry loader-internal fields. The site and element
 * builders take an optional description language; without one they return the
 * English description, as the resources do.
 * @module services/unesco-datahub/records
 */

import type {
  BiosphereReserve,
  Geopark,
  HeritageSite,
  IntangibleElement,
  SiteComponent,
} from './types.js';
import {
  CRITERIA,
  type CriterionCode,
  type ElementDescriptionLanguage,
  type SiteDescriptionLanguage,
} from './vocabulary.js';

/**
 * The description fields of a record read in `language`: the text UNESCO
 * publishes in that language, else the English text, each labelled with the
 * language it is in; neither field when there is no text in either.
 */
function describedIn<L extends SiteDescriptionLanguage>(
  language: L,
  english: string | undefined,
  translations: Partial<Record<SiteDescriptionLanguage, string>>,
): { description?: string; description_language?: L | 'en' } {
  const text = language === 'en' ? english : translations[language];
  if (text !== undefined) return { description: text, description_language: language };
  return english === undefined ? {} : { description: english, description_language: 'en' };
}

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
  /** The language of `description`; set only when a language was requested and a description is returned. */
  description_language?: SiteDescriptionLanguage;
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

/**
 * Builds the full site record, listing at most `maxComponents` parsed
 * components, with the description in `language` when one is given.
 */
export function buildSiteRecord(
  site: HeritageSite,
  maxComponents: number,
  language?: SiteDescriptionLanguage,
): SiteRecord {
  const { components, criteria_inferred, criteria, description_translations, ...rest } = site;
  return {
    ...rest,
    ...(language ? describedIn(language, site.description, description_translations) : {}),
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
> & {
  /** The language of `description`; set only when a language was requested. */
  description_language?: ElementDescriptionLanguage;
};

/** Builds the full intangible heritage element record, with the description in `language` when one is given. */
export function buildElementRecord(
  e: IntangibleElement,
  language?: ElementDescriptionLanguage,
): ElementRecord {
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
    ...(language ? describedIn(language, e.description, e.description_translations) : {}),
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

/** The `unesco_get_geopark` payload. */
export type GeoparkRecord = Pick<
  Geopark,
  | 'ugg_id'
  | 'name'
  | 'country_codes'
  | 'countries'
  | 'transnational'
  | 'designation_year'
  | 'area_hectares'
  | 'population'
  | 'latitude'
  | 'longitude'
  | 'introduction'
  | 'description'
  | 'sustaining_local_communities'
  | 'website'
  | 'url'
>;

/** Builds the full geopark record. Area and population pass through as recorded. */
export function buildGeoparkRecord(g: Geopark): GeoparkRecord {
  return {
    ugg_id: g.ugg_id,
    name: g.name,
    country_codes: g.country_codes,
    countries: g.countries,
    transnational: g.transnational,
    designation_year: g.designation_year,
    area_hectares: g.area_hectares,
    ...(g.population !== undefined ? { population: g.population } : {}),
    latitude: g.latitude,
    longitude: g.longitude,
    introduction: g.introduction,
    description: g.description,
    sustaining_local_communities: g.sustaining_local_communities,
    ...(g.website ? { website: g.website } : {}),
    url: g.url,
  };
}
