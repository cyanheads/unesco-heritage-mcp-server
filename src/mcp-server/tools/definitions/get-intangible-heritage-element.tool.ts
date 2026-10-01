/**
 * @fileoverview unesco_get_intangible_heritage_element — one Intangible
 * Cultural Heritage element's full record by ich_ref: description, list,
 * countries, inscription year, UNESCO concept terms, linked World Heritage
 * sites, UNESCO page, and the main image credit.
 * @module mcp-server/tools/definitions/get-intangible-heritage-element.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderSources, sourcesField } from '@/mcp-server/shared/enrichment.js';
import { ichRefInput } from '@/mcp-server/shared/inputs.js';
import { inline, quoted } from '@/mcp-server/shared/markdown.js';
import { buildElementRecord } from '@/services/unesco-datahub/records.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import { INTANGIBLE_LISTS } from '@/services/unesco-datahub/vocabulary.js';

export const getIntangibleHeritageElementTool = tool('unesco_get_intangible_heritage_element', {
  title: 'Get intangible heritage element',
  description:
    "Fetch one Intangible Cultural Heritage element's full record by ich_ref: its description, the list it is inscribed on, the countries that share it, its inscription year, UNESCO concept terms, the World Heritage sites UNESCO links to it, its UNESCO page, and the main image with its caption and copyright credit.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ich_ref: ichRefInput(
      "The element's ich_ref, from unesco_search_intangible_heritage. A number, a digit string, or the element's ich.unesco.org/en/{RL|USL|Art18}/{ref} page URL.",
    ),
  }),
  output: z.object({
    ich_ref: z.string().describe('Intangible heritage element reference (ich_ref).'),
    name: z.string().describe('English name.'),
    name_fr: z.string().describe('French name.'),
    list: z
      .enum(INTANGIBLE_LISTS)
      .describe(
        'The list the element is inscribed on: Representative List, Urgent Safeguarding List, or Register of Good Safeguarding Practices.',
      ),
    country_codes: z
      .array(z.string().describe('ISO 3166-1 alpha-2 code.'))
      .describe(
        'ISO 3166-1 alpha-2 codes of the countries sharing the element, as UNESCO lists them.',
      ),
    countries: z
      .array(z.string().describe('Country name.'))
      .describe('Country display names aligned with country_codes.'),
    multinational: z.boolean().describe('True when more than one country shares the element.'),
    inscribed_year: z
      .number()
      .describe(
        'Inscription year. Elements dated 2008 were incorporated into the Representative List that year after an earlier proclamation.',
      ),
    description: z.string().describe("UNESCO's description of the element."),
    concepts: z
      .array(z.string().describe('Concept term.'))
      .describe('Primary UNESCO concept terms; empty for the few elements without any.'),
    concepts_secondary: z
      .array(z.string().describe('Concept term.'))
      .describe('Secondary UNESCO concept terms.'),
    world_heritage_sites: z
      .array(
        z
          .object({
            id_no: z.string().describe('World Heritage id_no; pass to unesco_get_site.'),
            name: z.string().describe('Site name as the element record carries it.'),
          })
          .describe('One linked World Heritage site.'),
      )
      .describe('World Heritage sites UNESCO links to the element; empty when none are linked.'),
    url: z.string().describe("The element's UNESCO page URL."),
    image: z
      .object({
        url: z
          .string()
          .describe('Main image URL (opens in a browser; not fetched by this server).'),
        caption: z.string().optional().describe('Image caption, when recorded.'),
        copyright: z.string().optional().describe('Copyright holder, when recorded.'),
        author: z.string().optional().describe('Photographer, when recorded.'),
      })
      .optional()
      .describe('Main image with its caption and credit, when UNESCO lists one.'),
  }),
  enrichment: {
    sources: sourcesField,
  },
  enrichmentTrailer: {
    sources: { render: renderSources },
  },
  errors: [
    {
      reason: 'element_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record carries this ich_ref',
      severity: 'notice',
      recovery:
        "Find the element's ich_ref with unesco_search_intangible_heritage (search by name), then call unesco_get_intangible_heritage_element again.",
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No intangible heritage snapshot has loaded yet and the Data Hub is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the Intangible Heritage List; wait until the next load attempt this error names (retryAfter, in seconds), then call unesco_get_intangible_heritage_element again.',
    },
  ],

  async handler(input, ctx) {
    const intangible = await getUnescoDataHubService().getIntangible(ctx);
    ctx.enrich({ sources: [sourceOf(intangible)] });
    const element = intangible.byId.get(input.ich_ref);
    if (!element) {
      throw ctx.fail(
        'element_not_found',
        `No intangible heritage element has ich_ref ${input.ich_ref}.`,
        { ich_ref: input.ich_ref },
      );
    }
    ctx.log.info('Intangible heritage element fetched', { ich_ref: element.ich_ref });
    return buildElementRecord(element);
  },

  format: (r) => {
    const countries = r.country_codes.map((code, i) => {
      const name = r.countries[i];
      return name ? `${inline(name)} (${code})` : code;
    });
    const lines = [
      `## ${inline(r.name)} (ich_ref ${r.ich_ref})`,
      `- **French name:** ${inline(r.name_fr)}`,
      `- **List:** ${r.list}`,
      `- **Countries:** ${countries.join(', ')}`,
      `- **Inscribed:** ${r.inscribed_year}`,
      `- **Multinational:** ${r.multinational ? 'Yes' : 'No'}`,
      `- **URL:** ${r.url}`,
      '',
      quoted('Description', r.description),
      '',
      `**Concepts:** ${r.concepts.length > 0 ? r.concepts.map(inline).join(', ') : 'None recorded'}`,
      `**Secondary concepts:** ${r.concepts_secondary.length > 0 ? r.concepts_secondary.map(inline).join(', ') : 'None recorded'}`,
      '',
      '**Linked World Heritage sites:**',
      ...(r.world_heritage_sites.length > 0
        ? r.world_heritage_sites.map((s) => `- ${s.id_no} — ${inline(s.name)}`)
        : ['- None linked']),
      '',
    ];
    if (r.image) {
      lines.push(
        `**Image:** ${r.image.url}`,
        ...(r.image.caption ? [`Caption: ${inline(r.image.caption)}`] : []),
        ...(r.image.copyright ? [`© ${inline(r.image.copyright)}`] : []),
        ...(r.image.author ? [`Photo: ${inline(r.image.author)}`] : []),
      );
    } else {
      lines.push('**Image:** Not available');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
