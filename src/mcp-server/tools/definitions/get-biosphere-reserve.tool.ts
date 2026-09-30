/**
 * @fileoverview unesco_get_biosphere_reserve — one biosphere reserve's full
 * record by mab_id: introduction, ecological and socio-economic
 * characteristics, zoned areas and population, designation, extension,
 * renaming, and periodic-review years, coordinates, and UNESCO page.
 * @module mcp-server/tools/definitions/get-biosphere-reserve.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderSources, sourcesField } from '@/mcp-server/shared/enrichment.js';
import { mabIdInput } from '@/mcp-server/shared/inputs.js';
import { inline, quoted } from '@/mcp-server/shared/markdown.js';
import { buildReserveRecord } from '@/services/unesco-datahub/records.js';
import { foldText } from '@/services/unesco-datahub/search.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import { BIOSPHERE_NETWORK_NAMES, REGIONS } from '@/services/unesco-datahub/vocabulary.js';

const ZonedArea = (what: string) =>
  z
    .object({
      total: z.number().describe(`Total ${what} area, as recorded.`),
      core: z.number().describe(`Core-zone ${what} area, as recorded.`),
      buffer: z.number().describe(`Buffer-zone ${what} area, as recorded.`),
      transition: z.number().describe(`Transition-zone ${what} area, as recorded.`),
    })
    .describe(
      `The ${what} area by zone in hectares, as recorded; zone sums don't always match the total upstream.`,
    );

export const getBiosphereReserveTool = tool('unesco_get_biosphere_reserve', {
  title: 'Get biosphere reserve',
  description:
    "Fetch one biosphere reserve's full record by mab_id: its introduction, ecological and socio-economic characteristics, core, buffer, and transition areas (terrestrial and marine, in hectares) with resident population by zone, designation, extension, renaming, and periodic-review years, coordinates, and its UNESCO page.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    mab_id: mabIdInput(
      "The reserve's mab_id, from unesco_search_biosphere_reserves. Case and accents are ignored.",
    ),
  }),
  output: z.object({
    mab_id: z.string().describe('Biosphere reserve id (mab_id).'),
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
    extension_years: z
      .array(z.number().describe('Year.'))
      .describe('Years the reserve was extended; empty when none.'),
    renaming_years: z
      .array(z.number().describe('Year.'))
      .describe('Years the reserve was renamed; empty when none.'),
    periodic_review_years: z
      .array(z.number().describe('Year.'))
      .describe('Years of periodic review; empty when none recorded.'),
    transboundary: z
      .boolean()
      .describe('True for a transboundary reserve; each participating country has its own mab_id.'),
    sids: z.boolean().describe('True when the reserve is in a Small Island Developing State.'),
    area_hectares: z
      .object({
        total: z.number().describe('Total area, as recorded.'),
        terrestrial: ZonedArea('terrestrial'),
        marine: ZonedArea('marine'),
      })
      .describe(
        'Areas in hectares (unit inferred; undocumented upstream), as recorded — the server computes no totals, and zone sums do not always match the totals.',
      ),
    population: z
      .object({
        total: z.number().describe('Total resident population, as recorded.'),
        core: z.number().describe('Core-zone population, as recorded.'),
        buffer: z.number().describe('Buffer-zone population, as recorded.'),
        transition: z.number().describe('Transition-zone population, as recorded.'),
      })
      .describe(
        'Resident population by zone, as recorded; 0 can mean none or unreported, and zone sums do not always match the total.',
      ),
    latitude: z.number().describe('Representative point latitude.'),
    longitude: z.number().describe('Representative point longitude.'),
    introduction: z.string().describe("UNESCO's introduction to the reserve."),
    ecological_characteristics: z
      .string()
      .optional()
      .describe('Ecological characteristics, when recorded.'),
    socio_economic_characteristics: z
      .string()
      .optional()
      .describe('Socio-economic characteristics, when recorded.'),
    website: z.string().optional().describe("The reserve's own website, when recorded."),
    url: z.string().describe("The reserve's UNESCO page URL."),
  }),
  enrichment: {
    sources: sourcesField,
  },
  enrichmentTrailer: {
    sources: { render: renderSources },
  },
  errors: [
    {
      reason: 'biosphere_reserve_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record carries this mab_id, after folding case and diacritics',
      recovery:
        "Find the reserve's mab_id with unesco_search_biosphere_reserves (search by name), then call unesco_get_biosphere_reserve again.",
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No MAB snapshot has loaded yet and the Data Hub is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the biosphere reserve network; wait until the next load attempt this error names (retryAfter, in seconds), then call unesco_get_biosphere_reserve again.',
    },
  ],

  async handler(input, ctx) {
    const biosphere = await getUnescoDataHubService().getBiosphere(ctx);
    ctx.enrich({ sources: [sourceOf(biosphere)] });
    const reserve = biosphere.byId.get(foldText(input.mab_id));
    if (!reserve) {
      throw ctx.fail(
        'biosphere_reserve_not_found',
        `No biosphere reserve has mab_id "${inline(input.mab_id)}".`,
        { mab_id: input.mab_id },
      );
    }
    ctx.log.info('Biosphere reserve fetched', { mab_id: reserve.mab_id });
    return buildReserveRecord(reserve);
  },

  format: (r) => {
    const years = (list: number[]) => (list.length > 0 ? list.join(', ') : 'None');
    const { terrestrial: t, marine: m } = r.area_hectares;
    const p = r.population;
    const lines = [
      `## ${inline(r.name)} (${inline(r.mab_id)})`,
      `- **Country:** ${inline(r.country)} (${r.country_code})`,
      `- **Regions:** ${r.regions.join(', ')}`,
      `- **Regional network:** ${r.regional_network ?? 'No regional network'}`,
      `- **Designated:** ${r.designation_year}`,
      `- **Transboundary:** ${r.transboundary ? 'Yes' : 'No'}`,
      `- **SIDS (Small Island Developing State):** ${r.sids ? 'Yes' : 'No'}`,
      `- **Total area:** ${r.area_hectares.total} ha (as recorded)`,
      `- **Coordinates:** ${r.latitude}, ${r.longitude}`,
      '',
      '**Zoning** (hectares and residents as recorded; zone sums may not match totals):',
      '',
      '| Zone | Terrestrial (ha) | Marine (ha) | Population |',
      '|:-----|-----------------:|------------:|-----------:|',
      `| Core | ${t.core} | ${m.core} | ${p.core} |`,
      `| Buffer | ${t.buffer} | ${m.buffer} | ${p.buffer} |`,
      `| Transition | ${t.transition} | ${m.transition} | ${p.transition} |`,
      `| Total | ${t.total} | ${m.total} | ${p.total} |`,
      '',
      `- **Extension years:** ${years(r.extension_years)}`,
      `- **Renaming years:** ${years(r.renaming_years)}`,
      `- **Periodic review years:** ${years(r.periodic_review_years)}`,
      '',
      quoted('Introduction', r.introduction),
      '',
      quoted('Ecological characteristics', r.ecological_characteristics),
      '',
      quoted('Socio-economic characteristics', r.socio_economic_characteristics),
      '',
      `**Website:** ${r.website ?? 'Not available'}`,
      `**UNESCO page:** ${r.url}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
