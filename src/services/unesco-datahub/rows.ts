/**
 * @fileoverview Strict Zod schemas for the `exports/json` rows of `whc001`,
 * `ich001`, and `mab001` (exactly the allowlisted keys), the edge parsers
 * (text cleanup, criteria and the criterion (vi) inference, the pseudo-JSON
 * `components_list`, the `whc_sites` JSON string, the year lists, booleans),
 * and the row → domain mappers.
 * @module services/unesco-datahub/rows
 */

import { z } from '@cyanheads/mcp-ts-core';
import { countryDisplayName } from './iso3166.js';
import type { BiosphereReserve, HeritageSite, IntangibleElement, SiteComponent } from './types.js';
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

/* ------------------------------------------------------------------ */
/* Row schemas                                                         */
/* ------------------------------------------------------------------ */

const TrueFalse = z.enum(['True', 'False']);
const Year = z.string().regex(/^\d{4}$/);
const GeoPoint = z.object({ lon: z.number(), lat: z.number() }).strict();
const CRITERIA_TXT = /^(\((?:i|ii|iii|iv|v|vi|vii|viii|ix|x)\))+$/;

/**
 * Length bounds on upstream strings, in characters: names, credits, and short
 * lists; descriptions, statements, and narratives; the pseudo-JSON component
 * list; URLs. A longer value fails the row, and with it the refresh.
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
    justification_en: FreeText.nullable(),
    category: z.enum(CATEGORIES),
    criteria_txt: z.string().regex(CRITERIA_TXT).nullable(),
    states_names: z.array(ShortText).min(1),
    iso_codes: ShortText.regex(/^[A-Z]{2}(?:,\s*[A-Z]{2})*$/).nullable(),
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
    coordinates: GeoPoint.nullable(),
    components_count: z.number().int().nonnegative(),
    components_list: ComponentsText.nullable(),
    main_image_url: UrlText.nullable(),
    main_image_copyright: ShortText.nullable(),
    main_image_author: ShortText.nullable(),
  })
  .strict();
export type WhcRow = z.infer<typeof WhcRowSchema>;

export const IchRowSchema = z
  .object({
    ich_public_ref: z.string().regex(/^[1-9]\d{0,4}$/),
    inscription_year: Year,
    title_en: ShortText,
    title_fr: ShortText,
    description_en: FreeText,
    type_of_element_en: z.enum(INTANGIBLE_LISTS),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
    http_url_en: UrlText,
    concepts_primary_names: z.array(ShortText).nullable(),
    concepts_secondary_names: z.array(ShortText).nullable(),
    whc_sites: FreeText.nullable(),
    main_image_url: UrlText,
    main_image_caption_en: ShortText.nullable(),
    main_image_copyright: ShortText.nullable(),
    main_image_author: ShortText.nullable(),
  })
  .strict();
export type IchRow = z.infer<typeof IchRowSchema>;

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
export type MabRow = z.infer<typeof MabRowSchema>;

/** The dataset metadata fields the loader reads (the rest of the document is ignored). */
export const DatasetMetaSchema = z.object({
  metas: z.object({
    default: z.object({
      data_processed: z.string().max(100),
      records_count: z.number().int().nonnegative(),
      license: z.string().max(100),
    }),
  }),
});

const WhcSiteLinksSchema = z.array(
  z
    .object({
      ref: z.union([
        z
          .string()
          .trim()
          .regex(/^[1-9]\d*$/),
        z.number().int().positive(),
      ]),
      name_en: z.string(),
      name_fr: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
    })
    .strict(),
);

/* ------------------------------------------------------------------ */
/* Edge parsers                                                        */
/* ------------------------------------------------------------------ */

const INLINE_TAG = /<\/?(?:em|i|u|b|strong|sup|small)\s*>/gi;
const LINE_BREAK_TAG = /<br\s*\/?>/gi;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Strips UNESCO's inline markup tags (the closed list, any case), turns `<br>`
 * into a space, then decodes numeric entities and the five XML named entities.
 * Other `<…>` text passes through. Trimmed.
 */
export function cleanText(text: string): string {
  return text
    .replace(LINE_BREAK_TAG, ' ')
    .replace(INLINE_TAG, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith('#x')) return safeCodePoint(Number.parseInt(lower.slice(2), 16), whole);
      if (lower.startsWith('#')) return safeCodePoint(Number.parseInt(lower.slice(1), 10), whole);
      return NAMED_ENTITIES[lower] ?? whole;
    })
    .trim();
}

function safeCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : fallback;
}

/** Cleans a nullable upstream string; empty results become `undefined`. */
function cleanOptional(text: string | null): string | undefined {
  if (text === null) return;
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

const NAME_KEY = 'name: ';
const REF_KEY = ', ref: ';
const LATITUDE_KEY = ', latitude: ';
const LONGITUDE_KEY = ', longitude: ';
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * Splits one `components_list` entry, `name: …, ref: …, latitude: …,
 * longitude: …`, from the right: the last `, longitude: `, then the last
 * `, latitude: ` before it, then the last `, ref: ` before that, with both
 * coordinates decimal. Taking the last key sequence lets a name hold commas or
 * key text, and keeps the split linear in the entry's length.
 */
function splitComponentPart(
  part: string,
): { name: string; ref: string; latitude: string; longitude: string } | undefined {
  if (!part.startsWith(NAME_KEY)) return;
  const longitudeAt = part.lastIndexOf(LONGITUDE_KEY);
  if (longitudeAt < 0) return;
  const latitudeAt = part.lastIndexOf(LATITUDE_KEY, longitudeAt - LATITUDE_KEY.length);
  if (latitudeAt < 0) return;
  const refAt = part.lastIndexOf(REF_KEY, latitudeAt - REF_KEY.length);
  if (refAt < NAME_KEY.length) return;
  const latitude = part.slice(latitudeAt + LATITUDE_KEY.length, longitudeAt);
  const longitude = part.slice(longitudeAt + LONGITUDE_KEY.length);
  if (!DECIMAL.test(latitude) || !DECIMAL.test(longitude)) return;
  return {
    name: part.slice(NAME_KEY.length, refAt),
    ref: part.slice(refAt + REF_KEY.length, latitudeAt),
    latitude,
    longitude,
  };
}

/**
 * Parses UNESCO's pseudo-JSON `components_list`. Entries that don't split (or
 * with an empty ref, or out-of-range coordinates) are skipped and counted.
 */
export function parseComponentsList(list: string | null): {
  components: SiteComponent[];
  parts: number;
  unparsed: number;
} {
  if (list === null || list.trim() === '') return { components: [], parts: 0, unparsed: 0 };
  let body = list.trim();
  if (body.startsWith('{')) body = body.slice(1);
  if (body.endsWith('}')) body = body.slice(0, -1);
  const parts = body.split('}, {');
  const components: SiteComponent[] = [];
  let unparsed = 0;
  for (const part of parts) {
    const fields = splitComponentPart(part);
    const ref = fields?.ref.trim();
    const latitude = Number(fields?.latitude);
    const longitude = Number(fields?.longitude);
    if (!fields || !ref || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      unparsed += 1;
      continue;
    }
    const name = cleanText(fields.name);
    components.push({ ref, latitude, longitude, ...(name ? { name } : {}) });
  }
  return { components, parts: parts.length, unparsed };
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

/** Parses the `whc_sites` JSON string into `{ id_no, name }` links. */
export function parseWhcSites(json: string | null): { id_no: string; name: string }[] {
  if (json === null) return [];
  const links = WhcSiteLinksSchema.parse(JSON.parse(json));
  return links.map((link) => ({ id_no: String(link.ref), name: cleanText(link.name_en) }));
}

/**
 * An upstream URL as the WHATWG parser serializes it (`href`, which drops tabs
 * and line breaks, so none reaches a markdown line), or `undefined` when it is
 * blank or not http(s).
 */
function httpUrl(value: string | null): string | undefined {
  const url = value ? URL.parse(value.trim()) : null;
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

/** Maps a validated `whc001` row to a site. */
export function toHeritageSite(row: WhcRow): { site: HeritageSite; componentParts: number } {
  const justification = cleanOptional(row.justification_en);
  const description = cleanOptional(row.short_description_en);
  const recorded = parseCriteriaTxt(row.criteria_txt);
  const inferred: CriterionCode[] =
    !recorded.includes('vi') && justificationNamesVi(justification) ? ['vi'] : [];
  const { components, parts, unparsed } = parseComponentsList(row.components_list);
  const secondary = yearsIn(row.secondary_dates).slice(1);
  const dangerYear = row.danger_list ? Number(row.danger_list.slice(2)) : undefined;
  const names = {
    ...optionalName('fr', row.name_fr),
    ...optionalName('es', row.name_es),
    ...optionalName('ru', row.name_ru),
    ...optionalName('ar', row.name_ar),
    ...optionalName('zh', row.name_zh),
  };
  const imageUrl = httpUrl(row.main_image_url);
  const copyright = cleanOptional(row.main_image_copyright);
  const author = cleanOptional(row.main_image_author);
  const site: HeritageSite = {
    id_no: row.id_no,
    name: cleanText(row.name_en),
    names,
    category: row.category,
    states: row.states_names.map(cleanText),
    country_codes: row.iso_codes
      ? row.iso_codes
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
      : [],
    region: row.region,
    transboundary: row.transboundary === 'True',
    inscribed_year: Number(row.date_inscribed),
    secondary_years: secondary,
    criteria: sortCriteria([...recorded, ...inferred]),
    criteria_inferred: inferred,
    in_danger: row.danger === 'True',
    ...(dangerYear !== undefined ? { danger_listed_year: dangerYear } : {}),
    ...(row.area_hectares !== null ? { area_hectares: row.area_hectares } : {}),
    ...(row.coordinates ? { latitude: row.coordinates.lat, longitude: row.coordinates.lon } : {}),
    ...(description ? { description } : {}),
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

function optionalName<K extends string>(key: K, value: string | null): Partial<Record<K, string>> {
  const cleaned = cleanOptional(value);
  return cleaned ? ({ [key]: cleaned } as Partial<Record<K, string>>) : {};
}

/** Maps a validated `ich001` row to an element. */
export function toIntangibleElement(row: IchRow): IntangibleElement {
  const imageUrl = httpUrl(row.main_image_url);
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
