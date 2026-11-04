/**
 * @fileoverview Strict Zod schemas for the `exports/json` rows of `whc001`,
 * `ich001`, `mab001`, and `eg0001` (exactly the selected keys: the allowlist,
 * less any optional field the dataset's metadata no longer lists), the dataset
 * metadata schema, the edge parsers (text and URL entity decoding, criteria
 * and the criterion (vi) inference, the `components_list` and `whc_sites` JSON
 * strings, the year lists, booleans), and the row → domain mappers.
 * @module services/unesco-datahub/rows
 */

import { z } from '@cyanheads/mcp-ts-core';
import { countryDisplayName } from './iso3166.js';
import type {
  BiosphereReserve,
  Geopark,
  HeritageSite,
  IntangibleElement,
  SiteComponent,
} from './types.js';
import {
  BIOSPHERE_NETWORK_NAMES,
  CATEGORIES,
  CRITERIA_CODES,
  type CriterionCode,
  INTANGIBLE_LISTS,
  REGIONS,
  type RegionName,
} from './vocabulary.js';

/* ------------------------------------------------------------------ */
/* Field allowlists — `select` is the only query parameter ever sent. */
/* ------------------------------------------------------------------ */

export const WHC_FIELDS = [
  'id_no',
  'name_en',
  'name_fr',
  'name_es',
  'name_ru',
  'name_ar',
  'name_zh',
  'short_description_en',
  'short_description_fr',
  'short_description_es',
  'short_description_ru',
  'short_description_ar',
  'short_description_zh',
  'justification_en',
  'category',
  'criteria_txt',
  'states_names',
  'iso_codes',
  'region',
  'transboundary',
  'date_inscribed',
  'secondary_dates',
  'danger',
  'danger_list',
  'area_hectares',
  'coordinates',
  'components_count',
  'components_list',
  'main_image_url',
  'main_image_copyright',
  'main_image_author',
] as const;

export const ICH_FIELDS = [
  'ich_public_ref',
  'inscription_year',
  'title_en',
  'title_fr',
  'description_en',
  'description_fr',
  'type_of_element_en',
  'countries',
  'http_url_en',
  'concepts_primary_names',
  'concepts_secondary_names',
  'whc_sites',
  'main_image_url',
  'main_image_caption_en',
  'main_image_copyright',
  'main_image_author',
] as const;

export const MAB_FIELDS = [
  'mab_id',
  'title_en',
  'iso2',
  'country_title_en',
  'date',
  'introduction_en',
  'ecological_characteristics_en',
  'socio_economic_characteristics_en',
  'population_total',
  'population_core',
  'population_buffer',
  'population_transition',
  'area_total',
  'area_total_terrestrial',
  'area_core_terrestrial',
  'area_buffer_terrestrial',
  'area_transition_terrestrial',
  'area_total_marine',
  'area_core_marine',
  'area_buffer_marine',
  'area_transition_marine',
  'extension',
  'renaming',
  'periodic_review',
  'regional_network',
  'coordinates',
  'tbr',
  'website',
  'url',
  'regional_group',
  'sids',
] as const;

export const EG_FIELDS = [
  'ugg_id',
  'title_en',
  'countries',
  'transnational',
  'date',
  'introduction_en',
  'description',
  'sustaining_local_communities_description',
  'area_unit',
  'area_total',
  'population',
  'website',
  'coordinates',
  'url',
] as const;

/**
 * The allowlisted fields each dataset can load without: when the dataset's
 * metadata no longer lists one, the select leaves it out and the mappers read
 * it as absent. A missing image credit or URL drops the record's image, a
 * missing caption only the caption, and a missing description translation
 * reads as unpublished in that language. Any other allowlisted field the
 * metadata no longer lists fails the load.
 */
export const OPTIONAL_FIELDS = {
  whc001: [
    'short_description_fr',
    'short_description_es',
    'short_description_ru',
    'short_description_ar',
    'short_description_zh',
    'main_image_url',
    'main_image_copyright',
    'main_image_author',
  ],
  ich001: [
    'description_fr',
    'main_image_url',
    'main_image_caption_en',
    'main_image_copyright',
    'main_image_author',
  ],
  mab001: ['website'],
  eg0001: ['website'],
} as const satisfies {
  whc001: readonly (typeof WHC_FIELDS)[number][];
  ich001: readonly (typeof ICH_FIELDS)[number][];
  mab001: readonly (typeof MAB_FIELDS)[number][];
  eg0001: readonly (typeof EG_FIELDS)[number][];
};

/* ------------------------------------------------------------------ */
/* Row schemas                                                         */
/* ------------------------------------------------------------------ */

/** `T` with the keys `K` optional: a row whose export may have left those fields out. */
type WithOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

const TrueFalse = z.enum(['True', 'False']);
const Year = z.string().regex(/^\d{4}$/);
/** A `mab001` / `eg0001` point. */
const GeoPoint = z.object({ lon: z.number(), lat: z.number() }).strict();
/**
 * A `whc001` `coordinates` value (a `geo_shape`): a GeoJSON Feature whose
 * MultiPoint holds one `[lon, lat]` position per component, in
 * `components_list` order.
 */
const SiteGeometry = z
  .object({
    type: z.literal('Feature'),
    geometry: z
      .object({
        type: z.literal('MultiPoint'),
        coordinates: z.array(z.tuple([z.number(), z.number()])).min(1),
      })
      .strict(),
    properties: z.object({}).strict(),
  })
  .strict();
const CRITERIA_TXT = /^(\((?:i|ii|iii|iv|v|vi|vii|viii|ix|x)\))+$/;

/**
 * Length bounds on upstream strings, in characters: names, credits, and short
 * lists; descriptions, statements, narratives, and image captions; the
 * `components_list` JSON; URLs. A longer value fails the row, and with it the
 * refresh.
 */
const ShortText = z.string().max(2_000);
const FreeText = z.string().max(65_536);
const ComponentsText = z.string().max(262_144);
const UrlText = z.string().max(2_048);

export const WhcRowSchema = z
  .object({
    id_no: z.string().regex(/^[1-9]\d*$/),
    name_en: ShortText,
    name_fr: ShortText,
    name_es: ShortText.nullable(),
    name_ru: ShortText.nullable(),
    name_ar: ShortText.nullable(),
    name_zh: ShortText.nullable(),
    short_description_en: FreeText.nullable(),
    short_description_fr: FreeText.nullable(),
    short_description_es: FreeText.nullable(),
    short_description_ru: FreeText.nullable(),
    short_description_ar: FreeText.nullable(),
    short_description_zh: FreeText.nullable(),
    justification_en: FreeText.nullable(),
    category: z.enum(CATEGORIES),
    criteria_txt: z.string().regex(CRITERIA_TXT).nullable(),
    states_names: z.array(ShortText).min(1),
    iso_codes: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .nullable(),
    region: z.enum(REGIONS),
    transboundary: TrueFalse,
    date_inscribed: Year,
    secondary_dates: ShortText,
    danger: TrueFalse,
    danger_list: z
      .string()
      .regex(/^Y \d{4}$/)
      .nullable(),
    area_hectares: z.number().nullable(),
    coordinates: SiteGeometry.nullable(),
    components_count: z.number().int().nonnegative(),
    components_list: ComponentsText.nullable(),
    main_image_url: UrlText.nullable(),
    main_image_copyright: ShortText.nullable(),
    main_image_author: ShortText.nullable(),
  })
  .strict();
export type WhcRow = WithOptional<
  z.infer<typeof WhcRowSchema>,
  (typeof OPTIONAL_FIELDS.whc001)[number]
>;

export const IchRowSchema = z
  .object({
    ich_public_ref: z.string().regex(/^[1-9]\d{0,4}$/),
    inscription_year: Year,
    title_en: ShortText,
    title_fr: ShortText,
    description_en: FreeText,
    description_fr: FreeText.nullable(),
    type_of_element_en: z.enum(INTANGIBLE_LISTS),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
    http_url_en: UrlText,
    concepts_primary_names: z.array(ShortText).nullable(),
    concepts_secondary_names: z.array(ShortText).nullable(),
    whc_sites: FreeText.nullable(),
    main_image_url: UrlText,
    main_image_caption_en: FreeText.nullable(),
    main_image_copyright: ShortText.nullable(),
    main_image_author: ShortText.nullable(),
  })
  .strict();
export type IchRow = WithOptional<
  z.infer<typeof IchRowSchema>,
  (typeof OPTIONAL_FIELDS.ich001)[number]
>;

export const MabRowSchema = z
  .object({
    mab_id: z.string().min(1).max(20),
    title_en: ShortText,
    iso2: z.string().regex(/^[A-Z]{2}$/),
    country_title_en: ShortText,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    introduction_en: FreeText,
    ecological_characteristics_en: FreeText.nullable(),
    socio_economic_characteristics_en: FreeText.nullable(),
    population_total: z.number(),
    population_core: z.number(),
    population_buffer: z.number(),
    population_transition: z.number(),
    area_total: z.number(),
    area_total_terrestrial: z.number(),
    area_core_terrestrial: z.number(),
    area_buffer_terrestrial: z.number(),
    area_transition_terrestrial: z.number(),
    area_total_marine: z.number(),
    area_core_marine: z.number(),
    area_buffer_marine: z.number(),
    area_transition_marine: z.number(),
    extension: z.number().nullable(),
    renaming: z.number().nullable(),
    periodic_review: ShortText.nullable(),
    regional_network: z.enum(BIOSPHERE_NETWORK_NAMES).nullable(),
    coordinates: GeoPoint,
    tbr: TrueFalse,
    website: UrlText.nullable(),
    url: UrlText,
    regional_group: ShortText,
    sids: TrueFalse,
  })
  .strict();
export type MabRow = WithOptional<
  z.infer<typeof MabRowSchema>,
  (typeof OPTIONAL_FIELDS.mab001)[number]
>;

export const EgRowSchema = z
  .object({
    ugg_id: z
      .string()
      .max(20)
      .regex(/^[A-Z0-9]+$/),
    title_en: ShortText,
    /** One entry per row; a transnational geopark's entry joins its codes (`AT,SI`). */
    countries: z.array(ShortText.regex(/^[A-Z]{2}(?:,\s*[A-Z]{2})*$/)).min(1),
    transnational: TrueFalse,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    introduction_en: FreeText,
    description: FreeText,
    sustaining_local_communities_description: FreeText,
    area_unit: z.literal('ha'),
    area_total: z.number(),
    population: z.number().nullable(),
    website: UrlText.nullable(),
    coordinates: GeoPoint,
    url: UrlText,
  })
  .strict();
export type EgRow = WithOptional<
  z.infer<typeof EgRowSchema>,
  (typeof OPTIONAL_FIELDS.eg0001)[number]
>;

/**
 * The `.omit()` mask of a row schema for one export: the fields of `optional`
 * that `listed` (the names in the dataset's metadata `fields`) leaves out, as
 * the export's select does. The omitted schema stays strict, so every selected
 * field must be present and no other may appear.
 */
export function unlistedMask<K extends string>(
  optional: readonly K[],
  listed: ReadonlySet<string>,
): Partial<Record<K, true>> {
  const mask: Partial<Record<K, true>> = {};
  for (const field of optional) if (!listed.has(field)) mask[field] = true;
  return mask;
}

/**
 * The dataset metadata the loader reads: the field names, which bound the
 * export's select, and three `metas` values. The rest of the document is ignored.
 */
export const DatasetMetaSchema = z.object({
  fields: z.array(z.object({ name: z.string().max(200) })),
  metas: z.object({
    default: z.object({
      data_processed: z.string().max(100),
      records_count: z.number().int().nonnegative(),
      license: z.string().max(100),
    }),
  }),
});

/** A World Heritage List page, `https://whc.unesco.org/en/list/{id_no}`. */
const WHC_LIST_URL = /^https:\/\/whc\.unesco\.org\/en\/list\/[1-9]\d*$/;

/**
 * The `whc_sites` links. A link's `id_no` is the last segment of its `url`;
 * `ref` (served empty) is not read, so its value is not checked.
 */
const WhcSiteLinksSchema = z.array(
  z
    .object({
      ref: z.unknown().optional(),
      name_en: z.string(),
      name_fr: z.string().nullable().optional(),
      url: z.string().regex(WHC_LIST_URL),
    })
    .strict(),
);

/**
 * One `components_list` entry. Stripping rather than strict, so a key UNESCO
 * adds is ignored instead of skipping every component.
 */
const ComponentEntrySchema = z.object({
  name: z.string(),
  ref: z.string().trim().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/* ------------------------------------------------------------------ */
/* Edge parsers                                                        */
/* ------------------------------------------------------------------ */

/**
 * A run of `<ul>`/`<li>` tags (opening or closing, any case), raw or
 * entity-encoded, with the whitespace between and after them. Matched before
 * entities decode, so an encoded `&lt;` in prose is never read as a tag. Every
 * repetition starts with `<` or `&`, which `\s` never matches, so the match is
 * linear in the input.
 */
const LIST_TAGS = /(?:(?:<|&lt;)\/?(?:ul|li)\s*(?:>|&gt;)\s*)+/gi;
const INLINE_TAG = /<\/?(?:em|i|u|b|strong|sup|small)\s*>/gi;
const LINE_BREAK_TAG = /<br\s*\/?>/gi;
const ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
]);

/**
 * Decodes numeric entities, the five XML named entities, and `&nbsp;`, any
 * case, in one left-to-right pass: decoded text is never read again, so
 * `&amp;lt;` becomes `&lt;`. Any other `&…;` text stays as written.
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(Number.parseInt(lower.slice(2), 16), whole);
    if (lower.startsWith('#')) return safeCodePoint(Number.parseInt(lower.slice(1), 10), whole);
    return NAMED_ENTITIES.get(lower) ?? whole;
  });
}

/**
 * Turns each run of list tags (raw or entity-encoded) into a line break, so a
 * list reads one item per line; strips UNESCO's inline markup tags (the closed
 * list, any case); turns `<br>` into a space; then decodes entities
 * (`decodeEntities`). Other `<…>` text passes through. Trimmed.
 */
export function cleanText(text: string): string {
  return decodeEntities(
    text.replace(LIST_TAGS, '\n').replace(LINE_BREAK_TAG, ' ').replace(INLINE_TAG, ''),
  ).trim();
}

function safeCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : fallback;
}

/** Cleans a nullable or absent upstream string; empty results become `undefined`. */
function cleanOptional(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined) return;
  const cleaned = cleanText(text);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** `(ii)(iii)(iv)` → `['ii', 'iii', 'iv']`. */
export function parseCriteriaTxt(txt: string | null): CriterionCode[] {
  if (!txt) return [];
  return [...txt.matchAll(/\(([ivx]+)\)/g)].map((m) => m[1] as CriterionCode);
}

const CRITERION_VI = /criteri(?:on|a)\s*\(vi\)/i;

/** Whether a statement of Outstanding Universal Value names criterion (vi). */
export function justificationNamesVi(justification: string | undefined): boolean {
  return justification !== undefined && CRITERION_VI.test(justification);
}

/** Orders criteria codes by numeral. */
function sortCriteria(codes: Iterable<CriterionCode>): CriterionCode[] {
  const set = new Set(codes);
  return CRITERIA_CODES.filter((c) => set.has(c));
}

/**
 * Parses the `components_list` JSON string, `[{ name, ref, latitude, longitude }]`
 * (`null` lists no components). Text that is not a JSON array throws, failing
 * the row. An entry with a missing or mistyped key, a blank ref, or a
 * coordinate outside ±90/±180 is skipped and counted; a name blank after
 * cleanup is left out.
 */
export function parseComponentsList(list: string | null): {
  components: SiteComponent[];
  parts: number;
  unparsed: number;
} {
  if (list === null) return { components: [], parts: 0, unparsed: 0 };
  const entries: unknown = JSON.parse(list);
  if (!Array.isArray(entries)) throw new Error('components_list is not a JSON array.');
  const components: SiteComponent[] = [];
  let unparsed = 0;
  for (const entry of entries) {
    const parsed = ComponentEntrySchema.safeParse(entry);
    if (!parsed.success) {
      unparsed += 1;
      continue;
    }
    const { ref, latitude, longitude } = parsed.data;
    const name = cleanText(parsed.data.name);
    components.push({ ref, latitude, longitude, ...(name ? { name } : {}) });
  }
  return { components, parts: entries.length, unparsed };
}

/** Every four-digit group in a text, as numbers. */
export function yearsIn(text: string | null): number[] {
  if (!text) return [];
  return [...text.matchAll(/\d{4}/g)].map((m) => Number(m[0]));
}

/**
 * A MAB `extension`/`renaming` number: `2010.0` is one year, and two years
 * fused into one decimal (`2004.2016`) are split, with the fraction
 * right-padded to four digits so `2004.201` (a serialized `2004.2010`) reads
 * `2010`. A year outside 1970–2100 throws, failing the row.
 */
export function parseFusedYears(value: number | null): number[] {
  if (value === null) return [];
  const [whole = '', fraction] = String(value).split('.');
  const years = [Number(whole)];
  if (fraction) years.push(Number(fraction.padEnd(4, '0')));
  for (const year of years) {
    if (!Number.isInteger(year) || year < 1970 || year > 2100) {
      throw new Error(`Year list value ${value} does not decode to years in 1970–2100.`);
    }
  }
  return years;
}

/**
 * Parses the `whc_sites` JSON string into `{ id_no, name }` links, each
 * `id_no` read from its link's World Heritage List `url`. A link without one
 * throws, failing the row.
 */
export function parseWhcSites(json: string | null): { id_no: string; name: string }[] {
  if (json === null) return [];
  const links = WhcSiteLinksSchema.parse(JSON.parse(json));
  return links.map((link) => ({
    id_no: link.url.slice(link.url.lastIndexOf('/') + 1),
    name: cleanText(link.name_en),
  }));
}

/**
 * An upstream URL with its entities decoded (`decodeEntities`, so `&amp;` and
 * `&#38;` separate query parameters as `&`), serialized as the WHATWG parser
 * does (`href`, which drops tabs and line breaks, so none reaches a markdown
 * line), or `undefined` when it is absent, blank, or not http(s). Only
 * entities are decoded; tags are left to the parser.
 */
function httpUrl(value: string | null | undefined): string | undefined {
  const url = value ? URL.parse(decodeEntities(value).trim()) : null;
  return url?.protocol === 'http:' || url?.protocol === 'https:' ? url.href : undefined;
}

/** A URL the record requires; anything but an http(s) URL fails the row. */
function requiredHttpUrl(value: string, field: string): string {
  const url = httpUrl(value);
  if (!url) throw new Error(`${field} is not an http(s) URL.`);
  return url;
}

/* ------------------------------------------------------------------ */
/* Row → domain mappers                                                */
/* ------------------------------------------------------------------ */

/**
 * Whether a row's export selected both image credit fields. Without either
 * field the record serves no image; a null credit value still serves one.
 */
function creditsSelected(row: {
  main_image_copyright?: string | null;
  main_image_author?: string | null;
}): boolean {
  return row.main_image_copyright !== undefined && row.main_image_author !== undefined;
}

/** Maps a validated `whc001` row to a site. */
export function toHeritageSite(row: WhcRow): { site: HeritageSite; componentParts: number } {
  const justification = cleanOptional(row.justification_en);
  const description = cleanOptional(row.short_description_en);
  const recorded = parseCriteriaTxt(row.criteria_txt);
  const inferred: CriterionCode[] =
    !recorded.includes('vi') && justificationNamesVi(justification) ? ['vi'] : [];
  const { components, parts, unparsed } = parseComponentsList(row.components_list);
  // Only a one-position MultiPoint is a recorded point; a serial site's positions are its components.
  const positions = row.coordinates?.geometry.coordinates ?? [];
  const point = positions.length === 1 ? positions[0] : undefined;
  const secondary = yearsIn(row.secondary_dates).slice(1);
  const dangerYear = row.danger_list ? Number(row.danger_list.slice(2)) : undefined;
  const names = {
    ...optionalText('fr', row.name_fr),
    ...optionalText('es', row.name_es),
    ...optionalText('ru', row.name_ru),
    ...optionalText('ar', row.name_ar),
    ...optionalText('zh', row.name_zh),
  };
  const translations = {
    ...optionalText('fr', row.short_description_fr),
    ...optionalText('es', row.short_description_es),
    ...optionalText('ru', row.short_description_ru),
    ...optionalText('ar', row.short_description_ar),
    ...optionalText('zh', row.short_description_zh),
  };
  const imageUrl = creditsSelected(row) ? httpUrl(row.main_image_url) : undefined;
  const copyright = cleanOptional(row.main_image_copyright);
  const author = cleanOptional(row.main_image_author);
  const site: HeritageSite = {
    id_no: row.id_no,
    name: cleanText(row.name_en),
    names,
    category: row.category,
    states: row.states_names.map(cleanText),
    country_codes: row.iso_codes ?? [],
    region: row.region,
    transboundary: row.transboundary === 'True',
    inscribed_year: Number(row.date_inscribed),
    secondary_years: secondary,
    criteria: sortCriteria([...recorded, ...inferred]),
    criteria_inferred: inferred,
    in_danger: row.danger === 'True',
    ...(dangerYear !== undefined ? { danger_listed_year: dangerYear } : {}),
    ...(row.area_hectares !== null ? { area_hectares: row.area_hectares } : {}),
    ...(point ? { latitude: point[1], longitude: point[0] } : {}),
    ...(description ? { description } : {}),
    description_translations: translations,
    ...(justification ? { justification } : {}),
    components,
    components_total: row.components_count,
    components_unparsed: unparsed,
    ...(imageUrl
      ? {
          image: {
            url: imageUrl,
            ...(copyright ? { copyright } : {}),
            ...(author ? { author } : {}),
          },
        }
      : {}),
  };
  return { site, componentParts: parts };
}

/** `{ [key]: cleaned value }`, or `{}` when the value is absent, null, or blank after cleanup. */
function optionalText<K extends string>(
  key: K,
  value: string | null | undefined,
): Partial<Record<K, string>> {
  const cleaned = cleanOptional(value);
  return cleaned ? ({ [key]: cleaned } as Partial<Record<K, string>>) : {};
}

/** Maps a validated `ich001` row to an element. */
export function toIntangibleElement(row: IchRow): IntangibleElement {
  const imageUrl = creditsSelected(row) ? httpUrl(row.main_image_url) : undefined;
  const caption = cleanOptional(row.main_image_caption_en);
  const copyright = cleanOptional(row.main_image_copyright);
  const author = cleanOptional(row.main_image_author);
  return {
    ich_ref: row.ich_public_ref,
    name: cleanText(row.title_en),
    name_fr: cleanText(row.title_fr),
    list: row.type_of_element_en,
    country_codes: row.countries,
    countries: row.countries.map(countryDisplayName),
    multinational: row.countries.length > 1,
    inscribed_year: Number(row.inscription_year),
    description: cleanText(row.description_en),
    description_translations: optionalText('fr', row.description_fr),
    concepts: (row.concepts_primary_names ?? []).map(cleanText).filter(Boolean),
    concepts_secondary: (row.concepts_secondary_names ?? []).map(cleanText).filter(Boolean),
    world_heritage_sites: parseWhcSites(row.whc_sites),
    url: requiredHttpUrl(row.http_url_en, 'http_url_en'),
    ...(imageUrl
      ? {
          image: {
            url: imageUrl,
            ...(caption ? { caption } : {}),
            ...(copyright ? { copyright } : {}),
            ...(author ? { author } : {}),
          },
        }
      : {}),
  };
}

/** Maps a validated `mab001` row to a reserve. */
export function toBiosphereReserve(row: MabRow): BiosphereReserve {
  const regions = [...new Set(row.regional_group.split(',').map((r) => r.trim()))];
  for (const region of regions) {
    if (!(REGIONS as readonly string[]).includes(region)) {
      throw new Error(`Reserve ${row.mab_id} lists an unknown regional_group entry.`);
    }
  }
  const ecological = cleanOptional(row.ecological_characteristics_en);
  const socio = cleanOptional(row.socio_economic_characteristics_en);
  const website = httpUrl(row.website);
  return {
    mab_id: row.mab_id.normalize('NFC'),
    name: cleanText(row.title_en),
    country_code: row.iso2,
    country: cleanText(row.country_title_en),
    regions: regions as RegionName[],
    ...(row.regional_network ? { regional_network: row.regional_network } : {}),
    designation_year: Number(row.date.slice(0, 4)),
    extension_years: parseFusedYears(row.extension),
    renaming_years: parseFusedYears(row.renaming),
    periodic_review_years: yearsIn(row.periodic_review),
    transboundary: row.tbr === 'True',
    sids: row.sids === 'True',
    area_hectares: {
      total: row.area_total,
      terrestrial: {
        total: row.area_total_terrestrial,
        core: row.area_core_terrestrial,
        buffer: row.area_buffer_terrestrial,
        transition: row.area_transition_terrestrial,
      },
      marine: {
        total: row.area_total_marine,
        core: row.area_core_marine,
        buffer: row.area_buffer_marine,
        transition: row.area_transition_marine,
      },
    },
    population: {
      total: row.population_total,
      core: row.population_core,
      buffer: row.population_buffer,
      transition: row.population_transition,
    },
    latitude: row.coordinates.lat,
    longitude: row.coordinates.lon,
    introduction: cleanText(row.introduction_en),
    ...(ecological ? { ecological_characteristics: ecological } : {}),
    ...(socio ? { socio_economic_characteristics: socio } : {}),
    ...(website ? { website } : {}),
    url: requiredHttpUrl(row.url, 'url'),
  };
}

/**
 * Maps a validated `eg0001` row to a geopark. A transnational geopark's one
 * joined `countries` entry (`AT,SI`) splits into its codes; area and population
 * pass through as recorded, and a null population stays absent.
 */
export function toGeopark(row: EgRow): Geopark {
  const codes = row.countries.flatMap((entry) => entry.split(',').map((c) => c.trim()));
  const website = httpUrl(row.website);
  return {
    ugg_id: row.ugg_id,
    name: cleanText(row.title_en),
    country_codes: codes,
    countries: codes.map(countryDisplayName),
    transnational: row.transnational === 'True',
    designation_year: Number(row.date.slice(0, 4)),
    area_hectares: row.area_total,
    ...(row.population !== null ? { population: row.population } : {}),
    latitude: row.coordinates.lat,
    longitude: row.coordinates.lon,
    introduction: cleanText(row.introduction_en),
    description: cleanText(row.description),
    sustaining_local_communities: cleanText(row.sustaining_local_communities_description),
    ...(website ? { website } : {}),
    url: requiredHttpUrl(row.url, 'url'),
  };
}
