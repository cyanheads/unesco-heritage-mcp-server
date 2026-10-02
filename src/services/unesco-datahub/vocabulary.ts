/**
 * @fileoverview Controlled vocabularies and dataset constants: UNESCO regions,
 * site categories, the ten inscription criteria with paraphrased meanings, the
 * three intangible heritage lists, the MAB regional networks, and per-dataset
 * titles and attribution. Shared by the loader (enum validation), the tools
 * (input enums and normalizers), and the reference tool.
 * @module services/unesco-datahub/vocabulary
 */

/** The UNESCO Data Hub dataset ids this server reads. */
export const DATASET_IDS = ['whc001', 'ich001', 'mab001', 'eg0001'] as const;
export type DatasetId = (typeof DATASET_IDS)[number];

/** The only license the loader accepts; any other value fails the refresh. */
export const EXPECTED_LICENSE = 'CC BY-SA 4.0';
export const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

/** Server-constant dataset titles (never read from upstream text). */
export const DATASET_TITLES: Readonly<Record<DatasetId, string>> = {
  whc001: 'World Heritage List',
  ich001: 'Intangible Heritage List',
  mab001: 'Man and the Biosphere Programme',
  eg0001: 'UNESCO Global Geoparks',
};

/** The credit line to reproduce with data from a dataset. */
export function datasetAttribution(dataset: DatasetId): string {
  return `UNESCO — ${DATASET_TITLES[dataset]} (${dataset}), UNESCO Data Hub, CC BY-SA 4.0`;
}

export const REGIONS = [
  'Africa',
  'Arab States',
  'Asia and the Pacific',
  'Europe and North America',
  'Latin America and the Caribbean',
] as const;
export type RegionName = (typeof REGIONS)[number];

/** UNESCO region codes, as the World Heritage List pairs them with region names. */
export const REGION_CODES: Readonly<Record<RegionName, string>> = {
  Africa: 'AFR',
  'Arab States': 'ARB',
  'Asia and the Pacific': 'APA',
  'Europe and North America': 'EUR',
  'Latin America and the Caribbean': 'LAC',
};

export const CATEGORIES = ['Cultural', 'Natural', 'Mixed'] as const;
export type SiteCategory = (typeof CATEGORIES)[number];

export const CRITERIA_CODES = [
  'i',
  'ii',
  'iii',
  'iv',
  'v',
  'vi',
  'vii',
  'viii',
  'ix',
  'x',
] as const;
export type CriterionCode = (typeof CRITERIA_CODES)[number];

/** A criterion's group and its meaning, paraphrased for this server from the Operational Guidelines. */
export const CRITERIA: Readonly<
  Record<CriterionCode, { group: 'cultural' | 'natural'; meaning: string }>
> = {
  i: { group: 'cultural', meaning: 'A masterpiece of human creative genius.' },
  ii: {
    group: 'cultural',
    meaning:
      'An important interchange of human values over time or within a cultural area, in architecture, technology, monumental arts, town planning, or landscape design.',
  },
  iii: {
    group: 'cultural',
    meaning:
      'A unique or exceptional testimony to a cultural tradition or a civilization, living or vanished.',
  },
  iv: {
    group: 'cultural',
    meaning:
      'An outstanding example of a type of building, architectural or technological ensemble, or landscape illustrating significant stages in human history.',
  },
  v: {
    group: 'cultural',
    meaning:
      'An outstanding example of traditional human settlement, land use, or sea use representative of a culture or of human interaction with the environment, especially where vulnerable to irreversible change.',
  },
  vi: {
    group: 'cultural',
    meaning:
      'Direct association with events, living traditions, ideas, beliefs, or artistic and literary works of outstanding universal significance.',
  },
  vii: {
    group: 'natural',
    meaning:
      'Superlative natural phenomena, or areas of exceptional natural beauty and aesthetic importance.',
  },
  viii: {
    group: 'natural',
    meaning:
      "An outstanding example of a major stage of Earth's history, including the record of life, significant ongoing geological processes, or significant landforms.",
  },
  ix: {
    group: 'natural',
    meaning:
      'An outstanding example of significant ongoing ecological and biological processes in the evolution of ecosystems and communities of plants and animals.',
  },
  x: {
    group: 'natural',
    meaning:
      'The most important natural habitats for in-situ conservation of biological diversity, including those holding threatened species of outstanding universal value.',
  },
};

export const INTANGIBLE_LISTS = [
  'Representative List',
  'Urgent Safeguarding List',
  'Register of Good Safeguarding Practices',
] as const;
export type IntangibleList = (typeof INTANGIBLE_LISTS)[number];

/** The acronym UNESCO uses for each intangible heritage list (also its page-URL segment). */
export const INTANGIBLE_LIST_ACRONYMS: Readonly<Record<IntangibleList, string>> = {
  'Representative List': 'RL',
  'Urgent Safeguarding List': 'USL',
  'Register of Good Safeguarding Practices': 'Art18',
};

/** MAB regional networks: the full name as `mab001` records it, and its acronym. */
export const BIOSPHERE_NETWORKS = [
  { name: 'African Biosphere Reserve Network (AfriMAB)', acronym: 'AfriMAB' },
  { name: 'Arab States Biosphere Reserve Network (ArabMAB)', acronym: 'ArabMAB' },
  { name: 'East Asian Biosphere Reserve Network (EABRN)', acronym: 'EABRN' },
  { name: 'Europe and North America Biosphere Reserve Network (EuroMAB)', acronym: 'EuroMAB' },
  { name: 'Ibero-American MAB Network (IberoMAB)', acronym: 'IberoMAB' },
  { name: 'South and Central Asia MAB Network (SACAM)', acronym: 'SACAM' },
  { name: 'Southeast Asian Biosphere Reserve Network (SeaBRnet)', acronym: 'SeaBRnet' },
] as const;
export type BiosphereNetwork = (typeof BIOSPHERE_NETWORKS)[number]['name'];
export const BIOSPHERE_NETWORK_NAMES = BIOSPHERE_NETWORKS.map((n) => n.name) as [
  BiosphereNetwork,
  ...BiosphereNetwork[],
];
