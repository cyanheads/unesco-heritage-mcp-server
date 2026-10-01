/**
 * @fileoverview Shared input schemas and schema-level normalizers for the
 * unesco_* tools and resources: blank-as-unset wrapping, country, region,
 * year bounds, keyword query and filter, pagination, the `near` point, and the record-id
 * normalizers. Every normalization runs in the schema, before the validator.
 * @module mcp-server/shared/inputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import { normalizeCountry } from '@/services/unesco-datahub/iso3166.js';
import { queryWords } from '@/services/unesco-datahub/search.js';
import { REGION_CODES, REGIONS } from '@/services/unesco-datahub/vocabulary.js';

/** True for a string that is empty after trimming — what form clients send for "unset". */
export function isBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '';
}

/**
 * Wraps an optional or defaulted schema so a blank string parses as unset,
 * optionally normalizing a non-blank value before the validator runs.
 */
export function blankAsUnset<T extends z.ZodType>(
  schema: T,
  normalize?: (value: unknown) => unknown,
) {
  return z.preprocess((value) => {
    if (isBlank(value)) return;
    return normalize ? normalize(value) : value;
  }, schema);
}

/** Case-folds a string to the matching enum spelling; other values pass through. */
export function foldToEnum(
  options: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
) {
  const byFolded = new Map<string, string>(options.map((o) => [o.toLowerCase(), o]));
  for (const [alias, target] of Object.entries(aliases)) byFolded.set(alias.toLowerCase(), target);
  return (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return byFolded.get(trimmed.toLowerCase()) ?? trimmed;
  };
}

/** The five UNESCO regions; codes (AFR, ARB, APA, EUR, LAC) are accepted, any case. */
export function regionInput(description: string) {
  const aliases = Object.fromEntries(REGIONS.map((name) => [REGION_CODES[name], name]));
  return blankAsUnset(z.enum(REGIONS).optional(), foldToEnum(REGIONS, aliases)).describe(
    description,
  );
}

/** An ISO 3166-1 alpha-2 or alpha-3 code, any case, normalized to alpha-2. */
export function countryInput(description: string) {
  return blankAsUnset(z.string().max(64).optional(), normalizeCountry).describe(description);
}

/** An inclusive year bound. */
export function yearInput(description: string) {
  return blankAsUnset(z.number().int().min(1900).max(2100).optional()).describe(description);
}

/**
 * A keyword query or filter (word-prefix AND matching). A non-blank value must
 * hold at least one letter or digit: one that folds to no words would match
 * nothing (search) or everything (filter), so it is rejected, never read as unset.
 */
export function queryInput(description: string, maxLength = 200) {
  return blankAsUnset(
    z
      .string()
      .trim()
      .max(maxLength)
      .refine((value) => queryWords(value).length > 0, {
        message: 'Must contain at least one letter or digit; punctuation alone matches nothing.',
      })
      .optional(),
  ).describe(description);
}

export const limitInput = blankAsUnset(z.number().int().min(1).max(50).default(20)).describe(
  'Maximum results per page (1–50, default 20).',
);

export const cursorInput = blankAsUnset(z.string().max(1024).optional()).describe(
  "Opaque continuation cursor from the previous call's next_cursor. Pass it with the same filters and sort to fetch the next page.",
);

/** A boolean filter; blank means unset. */
export function booleanInput(description: string) {
  return blankAsUnset(z.boolean().optional()).describe(description);
}

const NearSchema = z
  .object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe('Latitude of the point, in decimal degrees (−90 to 90).'),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .describe('Longitude of the point, in decimal degrees (−180 to 180).'),
    radius_km: blankAsUnset(z.number().positive().max(5000).default(100)).describe(
      'Search radius in kilometres (up to 5000, default 100).',
    ),
  })
  .strict();

/** A `near` point; an object whose every field is blank is unset. */
export function nearInput(description: string) {
  return z
    .preprocess((value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const blank = Object.values(value).every(
          (v) => v === undefined || v === null || isBlank(v),
        );
        return blank ? undefined : value;
      }
      return isBlank(value) ? undefined : value;
    }, NearSchema.optional())
    .describe(description);
}

/** A site page or any sub-page under it (`…/list/162/gallery/`). */
const WHC_PAGE_URL =
  /^(?:https?:\/\/)?(?:www\.)?whc\.unesco\.org\/[a-z-]+\/list\/(\d+)(?:\/[^?#\s]*)?(?:[?#].*)?$/i;
/** An element page, with or without the title slug before the ref (`…/RL/some-title-01964`). */
const ICH_PAGE_URL =
  /^(?:https?:\/\/)?(?:www\.)?ich\.unesco\.org\/[a-z-]+\/(?:RL|USL|Art18)\/(?:[^/?#\s]*-)?(\d+)\/?(?:[?#].*)?$/i;

function normalizeNumericId(value: unknown, pageUrl: RegExp): unknown {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const fromUrl = pageUrl.exec(trimmed)?.[1] ?? trimmed;
  return /^\d+$/.test(fromUrl) ? fromUrl.replace(/^0+(?=\d)/, '') : fromUrl;
}

/** `id_no` / `world_heritage_site` preprocess: number → digits, page URL → id, leading zeros stripped. */
export function normalizeWhcId(value: unknown): unknown {
  return normalizeNumericId(value, WHC_PAGE_URL);
}

/** `ich_ref` preprocess: number → digits, element page URL → ref, leading zeros stripped. */
export function normalizeIchRef(value: unknown): unknown {
  return normalizeNumericId(value, ICH_PAGE_URL);
}

const NUMERIC_ID = /^[1-9]\d{0,4}$/;

/** A required World Heritage `id_no`. */
export function idNoInput(description: string) {
  return z.preprocess(normalizeWhcId, z.string().regex(NUMERIC_ID)).describe(description);
}

/** An optional World Heritage `id_no` (blank = unset). */
export function optionalIdNoInput(description: string) {
  return blankAsUnset(z.string().regex(NUMERIC_ID).optional(), normalizeWhcId).describe(
    description,
  );
}

/** A required intangible heritage `ich_ref`. */
export function ichRefInput(description: string) {
  return z.preprocess(normalizeIchRef, z.string().regex(NUMERIC_ID)).describe(description);
}

/**
 * `mab_id` preprocess: decode percent-escapes (a resource URI carries the
 * non-ASCII ids percent-encoded; a malformed escape stays as sent and misses),
 * then trim, so an id that decodes to whitespace is blank and fails the schema,
 * then NFC so a decomposed accent matches the stored id. Real ids hold only
 * letters and digits, so decoding never changes a valid id.
 */
export function normalizeMabId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let id = value;
  if (id.includes('%')) {
    try {
      id = decodeURIComponent(id);
    } catch {
      // Malformed escape: keep the raw value; the lookup reports it as not found.
    }
  }
  return id.trim().normalize('NFC');
}

/**
 * A required biosphere reserve `mab_id`. Length-bounded with no pattern: ids
 * carry non-ASCII letters, and a Unicode letter-class pattern does not survive
 * JSON Schema clients. Lookup folds case and diacritics.
 */
export function mabIdInput(description: string) {
  return z.preprocess(normalizeMabId, z.string().min(1).max(20)).describe(description);
}
