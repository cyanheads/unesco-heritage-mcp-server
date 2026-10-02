/**
 * @fileoverview unesco_get_geopark — one UNESCO Global Geopark's full record by
 * ugg_id: countries, designation year, transnational status, recorded area and
 * population, coordinates, UNESCO's introduction and description, its account
 * of sustaining local communities, website, and UNESCO page.
 * @module mcp-server/tools/definitions/get-geopark.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderSources, sourcesFieldOf } from '@/mcp-server/shared/enrichment.js';
import { uggIdInput } from '@/mcp-server/shared/inputs.js';
import { bareUrl, inline, quoted } from '@/mcp-server/shared/markdown.js';
import { buildGeoparkRecord } from '@/services/unesco-datahub/records.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';

export const getGeoparkTool = tool('unesco_get_geopark', {
  title: 'Get UNESCO Global Geopark',
  description:
    "Fetch one UNESCO Global Geopark's full record by ugg_id: its countries, designation year, transnational status, area and resident population as recorded, coordinates, UNESCO's introduction and description, its account of how the geopark sustains local communities, its own website, and its UNESCO page.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ugg_id: uggIdInput(
      "The geopark's ugg_id, such as EUFR10, from unesco_search_geoparks. Case and surrounding whitespace are ignored.",
    ),
  }),
  output: z.object({
    ugg_id: z.string().describe('UNESCO Global Geopark id (ugg_id).'),
    name: z.string().describe('English name.'),
    country_codes: z
      .array(z.string().describe('ISO 3166-1 alpha-2 code.'))
      .describe(
        "ISO 3166-1 alpha-2 codes of the geopark's countries; a transnational geopark lists each.",
      ),
    countries: z
      .array(z.string().describe('Country name.'))
      .describe('Country display names aligned with country_codes.'),
    transnational: z.boolean().describe('True when the geopark spans more than one country.'),
    designation_year: z
      .number()
      .describe(
        'Designation year; geoparks UNESCO recognized before the Global Geopark label existed are dated 2015, the year it was created.',
      ),
    area_hectares: z.number().describe('Area in hectares, as recorded.'),
    population: z
      .number()
      .optional()
      .describe(
        'Resident population, as recorded; absent when UNESCO records none, and 0 can mean unreported.',
      ),
    latitude: z.number().describe("Latitude of the geopark's point."),
    longitude: z.number().describe("Longitude of the geopark's point."),
    introduction: z.string().describe("UNESCO's introduction to the geopark."),
    description: z.string().describe("UNESCO's description of the geopark."),
    sustaining_local_communities: z
      .string()
      .describe("UNESCO's account of how the geopark sustains its local communities."),
    website: z.string().optional().describe("The geopark's own website, when recorded."),
    url: z.string().describe("The geopark's UNESCO page URL."),
  }),
  enrichment: {
    sources: sourcesFieldOf(['eg0001']),
  },
  enrichmentTrailer: {
    sources: { render: renderSources },
  },
  errors: [
    {
      reason: 'geopark_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record carries this ugg_id, after trimming and uppercasing',
      severity: 'notice',
      recovery:
        "Find the geopark's ugg_id with unesco_search_geoparks (search by name), then call unesco_get_geopark again.",
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No geopark snapshot has loaded yet and the Data Hub is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the UNESCO Global Geoparks; wait until the next load attempt this error names (retryAfter, in seconds), then call unesco_get_geopark again.',
    },
  ],

  async handler(input, ctx) {
    const geoparks = await getUnescoDataHubService().getGeoparks(ctx);
    ctx.enrich({ sources: [sourceOf(geoparks)] });
    const geopark = geoparks.byId.get(input.ugg_id);
    if (!geopark) {
      throw ctx.fail(
        'geopark_not_found',
        `No UNESCO Global Geopark has ugg_id "${inline(input.ugg_id)}".`,
        { ugg_id: input.ugg_id },
      );
    }
    ctx.log.info('Geopark fetched', { ugg_id: geopark.ugg_id });
    return buildGeoparkRecord(geopark);
  },

  format: (r) => {
    const countries = r.country_codes.map((code, i) => {
      const name = r.countries[i];
      return name ? `${inline(name)} (${code})` : code;
    });
    const lines = [
      `## ${inline(r.name)} (${inline(r.ugg_id)})`,
      `- **Countries:** ${countries.join(', ')}`,
      `- **Designated:** ${r.designation_year}`,
      `- **Transnational:** ${r.transnational ? 'Yes' : 'No'}`,
      `- **Area:** ${r.area_hectares} ha (as recorded)`,
      `- **Population:** ${r.population !== undefined ? `${r.population} (as recorded)` : 'Not available'}`,
      `- **Coordinates:** ${r.latitude}, ${r.longitude}`,
      '',
      quoted('Introduction', r.introduction),
      '',
      quoted('Description', r.description),
      '',
      quoted('Sustaining local communities', r.sustaining_local_communities),
      '',
      `**Website:** ${r.website ? bareUrl(r.website) : 'Not available'}`,
      `**UNESCO page:** ${bareUrl(r.url)}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
