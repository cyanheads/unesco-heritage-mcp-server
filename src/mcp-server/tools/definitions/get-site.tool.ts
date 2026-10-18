/**
 * @fileoverview unesco_get_site — one World Heritage site's full record by
 * id_no: description (English, or another UNESCO language on request, with an
 * explicit English fallback), statement of Outstanding Universal Value,
 * criteria with meanings, States Parties, coordinates, area, years, Danger-list
 * year, component parts, names in six languages, and the main image credit.
 * @module mcp-server/tools/definitions/get-site.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  countOf,
  descriptionLanguageFragment,
  renderSources,
  sourcesField,
} from '@/mcp-server/shared/enrichment.js';
import {
  BUDGET_CEILING,
  budgetInput,
  COMPONENTS_BUDGET,
  clampBudget,
  descriptionLanguageInput,
  idNoInput,
} from '@/mcp-server/shared/inputs.js';
import { bareUrl, inline, quoted } from '@/mcp-server/shared/markdown.js';
import { buildSiteRecord } from '@/services/unesco-datahub/records.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import {
  CATEGORIES,
  CRITERIA_CODES,
  REGIONS,
  SITE_DESCRIPTION_LANGUAGES,
} from '@/services/unesco-datahub/vocabulary.js';

export const getSiteTool = tool('unesco_get_site', {
  title: 'Get World Heritage site',
  description:
    "Fetch one World Heritage site's full record by id_no: its description, statement of Outstanding Universal Value, each inscription criterion with its meaning (criterion (vi) marked as inferred), States Parties, coordinates, area, inscription and later years, Danger-list year, component parts, names in six languages, and the main image with its copyright credit. description_language returns UNESCO's French, Spanish, Russian, Arabic, or Chinese description instead of the English one. Intangible heritage UNESCO links to the site is listed by unesco_search_intangible_heritage with world_heritage_site.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    id_no: idNoInput(
      "The site's World Heritage id_no, from unesco_search_sites. A number, a digit string, or the site's whc.unesco.org/en/list/{id} page URL.",
    ),
    max_components: budgetInput(
      0,
      20,
      `Maximum component parts to list (default 20). One call lists at most ${COMPONENTS_BUDGET.cap}: a larger value, up to ${BUDGET_CEILING}, is served as ${COMPONENTS_BUDGET.cap} and notice says so. 0 omits the list but keeps components_total; the largest site has 758 components.`,
    ),
    description_language: descriptionLanguageInput(
      SITE_DESCRIPTION_LANGUAGES,
      'Language of the description UNESCO publishes for the site: en, fr, es, ru, ar, or zh, in any case. Unset returns the English description. When UNESCO publishes none in that language, the English one is returned with description_language en, and notice says so. The statement of Outstanding Universal Value is English only.',
    ),
  }),
  output: z.object({
    id_no: z.string().describe('World Heritage id_no.'),
    name: z.string().describe('English name.'),
    names: z
      .object({
        fr: z.string().optional().describe('French name.'),
        es: z.string().optional().describe('Spanish name.'),
        ru: z.string().optional().describe('Russian name.'),
        ar: z.string().optional().describe('Arabic name.'),
        zh: z.string().optional().describe('Chinese name.'),
      })
      .describe('Names in the other UNESCO languages, each present when UNESCO records it.'),
    category: z.enum(CATEGORIES).describe('Cultural, Natural, or Mixed.'),
    states: z
      .array(z.string().describe('State Party name.'))
      .describe('States Parties as UNESCO names them.'),
    country_codes: z
      .array(z.string().describe('ISO 3166-1 alpha-2 code.'))
      .describe(
        'ISO 3166-1 alpha-2 codes aligned with states; empty for the one site without a code.',
      ),
    region: z.enum(REGIONS).describe('UNESCO region.'),
    transboundary: z.boolean().describe('True when the site spans more than one State Party.'),
    inscribed_year: z.number().describe('Year of inscription.'),
    secondary_years: z
      .array(z.number().describe('Year.'))
      .describe(
        "Later years UNESCO's secondary dates list for the site after inscription; empty when none.",
      ),
    criteria: z
      .array(
        z
          .object({
            code: z.enum(CRITERIA_CODES).describe('Criterion numeral.'),
            meaning: z
              .string()
              .describe(
                "The criterion's meaning, paraphrased from UNESCO's Operational Guidelines.",
              ),
            source: z
              .enum(['recorded', 'inferred'])
              .describe(
                "recorded: from UNESCO's criteria field. inferred: named by the statement of Outstanding Universal Value (criterion (vi), which UNESCO's criteria fields omit).",
              ),
          })
          .describe('One inscription criterion.'),
      )
      .describe('Inscription criteria in numeral order.'),
    in_danger: z
      .boolean()
      .describe('True when the site is on the List of World Heritage in Danger.'),
    danger_listed_year: z
      .number()
      .optional()
      .describe("Year of the site's current Danger-list entry, when in danger."),
    area_hectares: z.number().optional().describe('Area in hectares, when recorded.'),
    latitude: z.number().optional().describe('Representative point latitude, when recorded.'),
    longitude: z.number().optional().describe('Representative point longitude, when recorded.'),
    description: z
      .string()
      .optional()
      .describe(
        "UNESCO's short description, when recorded: in English, or in the language description_language names.",
      ),
    description_language: z
      .enum(SITE_DESCRIPTION_LANGUAGES)
      .optional()
      .describe(
        'Language of description, present when the description_language input was set and a description is returned: the requested language, or en when UNESCO publishes no description in it.',
      ),
    justification: z
      .string()
      .optional()
      .describe(
        'The statement of Outstanding Universal Value, in English (UNESCO publishes no translation), when recorded.',
      ),
    components: z
      .array(
        z
          .object({
            ref: z.string().describe('Component reference.'),
            name: z.string().optional().describe('Component name; absent when UNESCO lists none.'),
            latitude: z.number().describe('Component point latitude.'),
            longitude: z.number().describe('Component point longitude.'),
          })
          .describe('One component part.'),
      )
      .describe('Component parts in UNESCO order, up to max_components.'),
    components_total: z.number().describe("UNESCO's component count for the site."),
    components_unparsed: z
      .number()
      .describe(
        "Entries of UNESCO's component list that could not be read and are omitted; 0 normally.",
      ),
    image: z
      .object({
        url: z
          .string()
          .describe('Main image URL (opens in a browser; not fetched by this server).'),
        copyright: z.string().optional().describe('Copyright holder, when recorded.'),
        author: z.string().optional().describe('Photographer, when recorded.'),
      })
      .optional()
      .describe('Main image with its credit, when UNESCO lists one.'),
    url: z.string().describe("The site's UNESCO page URL."),
  }),
  enrichment: {
    sources: sourcesField,
    truncated: z
      .boolean()
      .describe('True when the list stops at cap with more readable components left.'),
    shown: z.number().describe('Components listed.'),
    cap: z
      .number()
      .describe(
        `The max_components applied: the request, or the per-call cap of ${COMPONENTS_BUDGET.cap} when it was larger.`,
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'That max_components was above the per-call cap, that the description is not in the requested description_language, how to list more components, or why some are missing.',
      ),
  },
  enrichmentTrailer: {
    sources: { render: renderSources },
  },
  errors: [
    {
      reason: 'site_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record carries this id_no',
      severity: 'notice',
      recovery:
        "Find the site's id_no with unesco_search_sites (search by name), then call unesco_get_site again.",
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No World Heritage snapshot has loaded yet: the Data Hub is unreachable, failing, or rate-limiting (retryable), or it rejected the request or served data this server cannot use (not retryable)',
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the World Heritage List; wait until the next load attempt this error names (retryAfter, in seconds), then call unesco_get_site again.',
    },
  ],

  async handler(input, ctx) {
    const heritage = await getUnescoDataHubService().getHeritage(ctx);
    ctx.enrich({ sources: [sourceOf(heritage)] });
    const site = heritage.byId.get(input.id_no);
    if (!site) {
      throw ctx.fail('site_not_found', `No World Heritage site has id_no ${input.id_no}.`, {
        id_no: input.id_no,
      });
    }

    const components = clampBudget(COMPONENTS_BUDGET, input.max_components);
    const language = input.description_language;
    const record = buildSiteRecord(site, components.applied, language);
    const parsed = site.components.length;
    const shown = record.components.length;
    ctx.enrich({ truncated: false, shown, cap: components.applied });

    const truncated = parsed > components.applied;
    const fragments = components.fragment ? [components.fragment] : [];
    const fallback =
      language && descriptionLanguageFragment('site', language, record.description_language);
    if (fallback) fragments.push(fallback);
    if (truncated) {
      fragments.push(
        components.applied < COMPONENTS_BUDGET.cap
          ? `Showing ${shown} of ${countOf(parsed, 'component')}; call unesco_get_site with a higher max_components (up to ${COMPONENTS_BUDGET.cap}) to list more.`
          : `Showing ${shown} of ${countOf(parsed, 'component')}, the most one call lists.`,
      );
    }
    if (site.components_unparsed > 0) {
      fragments.push(
        `${site.components_unparsed} of the site's ${countOf(site.components_total, 'component')} could not be read from UNESCO's component list and are omitted.`,
      );
    }
    const notice = fragments.join(' ');
    if (truncated) {
      ctx.enrich.truncated({ shown, cap: components.applied, guidance: notice });
    } else if (notice) {
      ctx.enrich.notice(notice);
    }

    ctx.log.info('Site fetched', { id_no: site.id_no, components: shown });
    return record;
  },

  format: (r) => {
    const codes = r.states.map((state, i) => {
      const code = r.country_codes[i];
      return code ? `${inline(state)} (${code})` : inline(state);
    });
    const lines = [
      `## ${inline(r.name)} (id_no ${r.id_no})`,
      `- **Category:** ${r.category}`,
      `- **Region:** ${r.region}`,
      `- **States Parties:** ${codes.join(', ')}`,
      `- **Transboundary:** ${r.transboundary ? 'Yes' : 'No'}`,
      `- **Inscribed:** ${r.inscribed_year}`,
      `- **Secondary years:** ${r.secondary_years.length > 0 ? r.secondary_years.join(', ') : 'None'}`,
      `- **Danger:** ${r.in_danger ? `In Danger${r.danger_listed_year !== undefined ? ` since ${r.danger_listed_year}` : ''}` : 'Not in Danger'}`,
      `- **Area:** ${r.area_hectares !== undefined ? `${r.area_hectares} ha` : 'Not available'}`,
      `- **Coordinates:** ${r.latitude !== undefined && r.longitude !== undefined ? `${r.latitude}, ${r.longitude}` : 'Not available'}`,
      `- **URL:** ${bareUrl(r.url)}`,
      '',
      '**Criteria:**',
      ...(r.criteria.length > 0
        ? r.criteria.map(
            (c) =>
              `- (${c.code}) ${c.meaning}${c.source === 'inferred' ? ' (inferred from the statement of Outstanding Universal Value)' : ' (recorded)'}`,
          )
        : ['- Not recorded']),
      '',
      quoted(
        r.description_language ? `Description (${r.description_language})` : 'Description',
        r.description,
      ),
      '',
      quoted('Statement of Outstanding Universal Value', r.justification),
      '',
      '**Other names:**',
    ];
    const names = Object.entries(r.names).flatMap(([lang, v]) =>
      v ? [`- ${lang}: ${inline(v)}`] : [],
    );
    lines.push(...(names.length > 0 ? names : ['- None recorded']), '');
    if (r.components_total > 0 || r.components.length > 0 || r.components_unparsed > 0) {
      lines.push(
        `**Components** (${r.components.length} of ${r.components_total}${r.components_unparsed > 0 ? `, ${r.components_unparsed} unreadable` : ''}):`,
        ...r.components.map(
          (c) =>
            `- ${inline(c.ref)} — ${c.name ? inline(c.name) : 'Name not available'} (${c.latitude}, ${c.longitude})`,
        ),
        '',
      );
    }
    if (r.image) {
      lines.push(
        `**Image:** ${bareUrl(r.image.url)}`,
        ...(r.image.copyright ? [`© ${inline(r.image.copyright)}`] : []),
        ...(r.image.author ? [`Photo: ${inline(r.image.author)}`] : []),
      );
    } else {
      lines.push('**Image:** Not available');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
