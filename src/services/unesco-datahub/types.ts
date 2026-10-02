/**
 * @fileoverview Domain types for the four UNESCO Data Hub snapshots: World
 * Heritage sites, intangible heritage elements, biosphere reserves, UNESCO
 * Global Geoparks, and the snapshot container the service hands to tools.
 * @module services/unesco-datahub/types
 */

import type {
  BiosphereNetwork,
  CriterionCode,
  DatasetId,
  IntangibleList,
  RegionName,
  SiteCategory,
} from './vocabulary.js';

/** One component part of a World Heritage site, parsed from `components_list`. */
export interface SiteComponent {
  latitude: number;
  longitude: number;
  /** Absent for components UNESCO lists without a name. */
  name?: string;
  ref: string;
}

/** A World Heritage site as the loader cleaned it. */
export interface HeritageSite {
  area_hectares?: number;
  category: SiteCategory;
  components: SiteComponent[];
  /** UNESCO's `components_count`. */
  components_total: number;
  /** Entries of `components_list` the parser could not read. */
  components_unparsed: number;
  /** ISO 3166-1 alpha-2 codes aligned with `states`; `[]` for the site without a code. */
  country_codes: string[];
  /** Recorded ∪ inferred criteria, in numeral order. */
  criteria: CriterionCode[];
  /** The subset of `criteria` inferred from the statement of Outstanding Universal Value. */
  criteria_inferred: CriterionCode[];
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
  names: { fr?: string; es?: string; ru?: string; ar?: string; zh?: string };
  region: RegionName;
  secondary_years: number[];
  /** States Parties as UNESCO names them. */
  states: string[];
  transboundary: boolean;
}

/** An intangible cultural heritage element as the loader cleaned it. */
export interface IntangibleElement {
  concepts: string[];
  concepts_secondary: string[];
  /** English display names aligned with `country_codes`. */
  countries: string[];
  /** ISO 3166-1 alpha-2 codes as UNESCO lists them. */
  country_codes: string[];
  description: string;
  ich_ref: string;
  image?: { url: string; caption?: string; copyright?: string; author?: string };
  inscribed_year: number;
  list: IntangibleList;
  multinational: boolean;
  name: string;
  name_fr: string;
  url: string;
  world_heritage_sites: { id_no: string; name: string }[];
}

/** Zoned areas as recorded (unit undocumented upstream; hectares inferred). */
export interface ZonedArea {
  buffer: number;
  core: number;
  total: number;
  transition: number;
}

/** A biosphere reserve as the loader cleaned it. */
export interface BiosphereReserve {
  area_hectares: { total: number; terrestrial: ZonedArea; marine: ZonedArea };
  country: string;
  country_code: string;
  designation_year: number;
  ecological_characteristics?: string;
  extension_years: number[];
  introduction: string;
  latitude: number;
  longitude: number;
  mab_id: string;
  name: string;
  periodic_review_years: number[];
  population: ZonedArea;
  regional_network?: BiosphereNetwork;
  /** Deduplicated UNESCO regions the reserve belongs to. */
  regions: RegionName[];
  renaming_years: number[];
  sids: boolean;
  socio_economic_characteristics?: string;
  transboundary: boolean;
  url: string;
  website?: string;
}

/** A UNESCO Global Geopark as the loader cleaned it. */
export interface Geopark {
  /** As recorded; `eg0001` states the unit (`ha`), and the loader fails a row in any other. */
  area_hectares: number;
  /** English display names aligned with `country_codes`. */
  countries: string[];
  /** ISO 3166-1 alpha-2 codes, split from the joined entry a transnational geopark carries. */
  country_codes: string[];
  description: string;
  /** Designation year as UNESCO records it; geoparks older than the 2015 label are dated 2015. */
  designation_year: number;
  introduction: string;
  latitude: number;
  longitude: number;
  name: string;
  /** As recorded; absent when UNESCO records none, and 0 can mean unreported. */
  population?: number;
  sustaining_local_communities: string;
  transnational: boolean;
  ugg_id: string;
  url: string;
  website?: string;
}

/** One loaded dataset, indexed for local search and lookup. */
export interface Snapshot<T> {
  /** The dataset's `data_processed` timestamp (ISO 8601). */
  asOf: string;
  /** Lookup key → record (`id_no`, `ich_ref`, folded `mab_id`, or `ugg_id`). */
  byId: ReadonlyMap<string, T>;
  /** Country codes any record carries. */
  codes: ReadonlySet<string>;
  dataset: DatasetId;
  /** Folded match text per record (parallel to `records`), one ' '-prefixed string per tier. */
  folded: readonly (readonly string[])[];
  license: string;
  loadedAt: number;
  records: readonly T[];
  recordsCount: number;
}

export type HeritageSnapshot = Snapshot<HeritageSite>;
export type IntangibleSnapshot = Snapshot<IntangibleElement>;
export type BiosphereSnapshot = Snapshot<BiosphereReserve>;
export type GeoparkSnapshot = Snapshot<Geopark>;

/** Attribution entry every data response carries. */
export interface SourceEntry {
  attribution: string;
  data_as_of: string;
  dataset: DatasetId;
  license: string;
  title: string;
}
