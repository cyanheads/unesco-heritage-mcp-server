/**
 * @fileoverview unesco_list_reference — decodes the vocabulary the other
 * unesco_ tools accept (criteria, countries, regions, intangible heritage
 * lists, MAB regional networks) and reports dataset coverage, license, and
 * data dates. The country-name → ISO code resolver.
 * @module mcp-server/tools/definitions/list-reference.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { countOf, renderSources, sourcesField } from '@/mcp-server/shared/enrichment.js';
import { MAX_QUERY_WORDS, queryInput } from '@/mcp-server/shared/inputs.js';
import { cell, inline } from '@/mcp-server/shared/markdown.js';
import {
  alpha3Of,
  countryAliases,
  countryDisplayName,
  isAssignedAlpha2,
  normalizeCountry,
} from '@/services/unesco-datahub/iso3166.js';
import { compareText, matchesAllWords } from '@/services/unesco-datahub/search.js';
import type {
  BiosphereSnapshot,
  HeritageSnapshot,
  IntangibleSnapshot,
} from '@/services/unesco-datahub/types.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import {
  BIOSPHERE_NETWORKS,
  CRITERIA,
  CRITERIA_CODES,
  DATASET_TITLES,
  type DatasetId,
  datasetAttribution,
  INTANGIBLE_LIST_ACRONYMS,
  INTANGIBLE_LISTS,
  LICENSE_URL,
  REGION_CODES,
  REGIONS,
} from '@/services/unesco-datahub/vocabulary.js';

const TOPICS = [
  'criteria',
  'countries',
  'regions',
  'intangible_lists',
  'biosphere_networks',
  'datasets',
] as const;

const CriterionRow = z
  .object({
    code: z
      .enum(CRITERIA_CODES)
      .describe('Criterion numeral, as the criteria input of unesco_search_sites takes it.'),
    group: z
      .enum(['cultural', 'natural'])
      .describe('Whether the criterion is a cultural (i–vi) or natural (vii–x) criterion.'),
    meaning: z
      .string()
      .describe("The criterion's meaning, paraphrased from UNESCO's Operational Guidelines."),
    site_count: z
      .number()
      .describe('World Heritage sites carrying the criterion (recorded or inferred).'),
    inferred_count: z
      .number()
      .describe(
        'Of those, sites where the criterion is inferred from the statement of Outstanding Universal Value (non-zero only for vi).',
      ),
  })
  .describe('One inscription criterion.');

const CountryRow = z
  .object({
    code: z
      .string()
      .optional()
      .describe(
        'ISO 3166-1 alpha-2 code, the form every country input accepts. Absent for the one State-Party entry without a code.',
      ),
    alpha3: z
      .string()
      .optional()
      .describe('ISO 3166-1 alpha-3 code, also accepted by country inputs.'),
    name: z.string().describe('English display name.'),
    unesco_name: z
      .string()
      .optional()
      .describe(
        'The spelling the UNESCO records use (World Heritage spelling, else the biosphere reserve one), when a dataset carries one.',
      ),
    heritage_site_count: z
      .number()
      .describe('World Heritage sites listing this country, transboundary sites included.'),
    intangible_element_count: z
      .number()
      .describe(
        'Intangible heritage elements listing this country, multinational elements included.',
      ),
    biosphere_reserve_count: z.number().describe('Biosphere reserves in this country.'),
  })
  .describe('One country.');

const RegionRow = z
  .object({
    name: z.string().describe('UNESCO region name, as the region inputs take it.'),
    code: z.string().describe('UNESCO region code, also accepted by the region inputs.'),
    heritage_site_count: z.number().describe('World Heritage sites in the region.'),
    biosphere_reserve_count: z
      .number()
      .describe(
        'Biosphere reserves in the region (a reserve spanning two regions counts in each).',
      ),
  })
  .describe('One UNESCO region.');

const IntangibleListRow = z
  .object({
    name: z
      .string()
      .describe('List name, as the list input of unesco_search_intangible_heritage takes it.'),
    acronym: z
      .string()
      .describe('The acronym UNESCO uses for the list, also accepted by the list input.'),
    element_count: z.number().describe('Elements on the list.'),
  })
  .describe('One intangible heritage list.');

const NetworkRow = z
  .object({
    name: z
      .string()
      .describe(
        'Network name, as the regional_network input of unesco_search_biosphere_reserves takes it.',
      ),
    acronym: z
      .string()
      .optional()
      .describe(
        'Network acronym, also accepted by the regional_network input. Absent on the "No regional network" row.',
      ),
    reserve_count: z.number().describe('Biosphere reserves in the network.'),
  })
  .describe('One MAB regional network, or the row counting reserves in none.');

const DatasetRow = z
  .object({
    dataset: z.string().describe('UNESCO Data Hub dataset id.'),
    title: z.string().describe('Dataset title.'),
    records: z.number().describe('Records in the loaded snapshot.'),
    data_as_of: z.string().describe("The dataset's data_processed timestamp (ISO 8601)."),
    license: z.string().describe('Dataset license.'),
    license_url: z.string().describe('License text URL.'),
    attribution: z.string().describe('Credit line to reproduce with the data.'),
    coverage_notes: z
      .array(z.string().describe('One note.'))
      .describe('Data gaps that change how results read.'),
  })
  .describe('One dataset.');

const ReferenceOutput = z.object({
  topic: z.enum(TOPICS).describe('The topic listed.'),
  criteria: z.array(CriterionRow).optional().describe('Criteria rows (topic criteria).'),
  countries: z
    .array(CountryRow)
    .optional()
    .describe('Country rows sorted by name (topic countries).'),
  regions: z.array(RegionRow).optional().describe('Region rows (topic regions).'),
  intangible_lists: z
    .array(IntangibleListRow)
    .optional()
    .describe('Intangible heritage list rows (topic intangible_lists).'),
  biosphere_networks: z
    .array(NetworkRow)
    .optional()
    .describe('MAB regional network rows (topic biosphere_networks).'),
  datasets: z.array(DatasetRow).optional().describe('Dataset rows (topic datasets).'),
});
type ReferenceResult = z.infer<typeof ReferenceOutput>;
type Topic = (typeof TOPICS)[number];

export const listReferenceTool = tool('unesco_list_reference', {
  title: 'List UNESCO reference vocabulary',
  description:
    "List the vocabulary the other unesco_ tools accept and the coverage of the underlying datasets: the ten inscription criteria with their meanings and site counts, the countries in each dataset with their ISO alpha-2 and alpha-3 codes and record counts, the five UNESCO regions, the three intangible heritage lists, the MAB regional networks, and each dataset's record count, license, and data date. Set filter to narrow a topic to matching entries, for example a country name to find its code.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    topic: z
      .enum(TOPICS)
      .describe(
        'What to list. criteria: the ten inscription criteria (i)–(x) with meanings and site counts, the values of the criteria input of unesco_search_sites. countries: every country with its ISO alpha-2 and alpha-3 codes and counts per dataset, the values of every country input. regions: the five UNESCO regions with codes, the values of the region inputs. intangible_lists: the three intangible heritage lists with acronyms, the values of the list input of unesco_search_intangible_heritage. biosphere_networks: the MAB regional networks with acronyms, the values of the regional_network input of unesco_search_biosphere_reserves. datasets: each dataset with its record count, data date, license, attribution, and coverage notes.',
      ),
    filter: queryInput(
      `Keep only entries whose name or code (a criterion's meaning, a dataset's title) contains every word of this text, each word matching at the start of a word. Case, accents, and punctuation are ignored, so the filter must contain at least one letter or digit and at most ${MAX_QUERY_WORDS} distinct words. For example, a country name finds its ISO code. For countries, a two- or three-letter ISO code (or UK) keeps exactly that country, as the country inputs read it, and common former or everyday names such as Turkey, Swaziland, or Holland match too.`,
      100,
    ),
  }),
  output: ReferenceOutput,
  enrichment: {
    sources: sourcesField,
    notice: z.string().optional().describe('Guidance when the filter matched no entry.'),
  },
  enrichmentTrailer: {
    sources: { render: renderSources },
  },
  errors: [
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A dataset the topic reads has not loaded yet and the Data Hub is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load a dataset this topic reads; wait until the next load attempt this error names (retryAfter, in seconds), then call unesco_list_reference again.',
    },
  ],

  async handler(input, ctx) {
    const svc = getUnescoDataHubService();
    const filter = input.filter;
    const keep = <T>(rows: T[], columns: (row: T) => (string | undefined)[]) =>
      filter ? rows.filter((row) => matchesAllWords(filter, columns(row))) : rows;

    const loadAll = () =>
      Promise.all([svc.getHeritage(ctx), svc.getIntangible(ctx), svc.getBiosphere(ctx)]);
    let noMatch: string | undefined;

    const list = async (topic: Topic): Promise<ReferenceResult> => {
      switch (topic) {
        case 'criteria': {
          const heritage = await svc.getHeritage(ctx);
          ctx.enrich({ sources: [sourceOf(heritage)] });
          return { topic, criteria: keep(criteriaRows(heritage), (r) => [r.code, r.meaning]) };
        }
        case 'countries': {
          const snapshots = await loadAll();
          ctx.enrich({ sources: snapshots.map(sourceOf) });
          const rows = countryRows(...snapshots);
          const code = filter && normalizeCountry(filter);
          if (typeof code === 'string' && isAssignedAlpha2(code)) {
            const exact = rows.filter((r) => r.code === code);
            if (exact.length === 0) {
              noMatch = `${code} (${countryDisplayName(code)}) is an assigned ISO 3166-1 code, but no UNESCO dataset lists that country.`;
            }
            return { topic, countries: exact };
          }
          return {
            topic,
            countries: keep(rows, (r) => [
              r.code,
              r.alpha3,
              r.name,
              r.unesco_name,
              ...countryAliases(r.code),
            ]),
          };
        }
        case 'regions': {
          const [heritage, biosphere] = await Promise.all([
            svc.getHeritage(ctx),
            svc.getBiosphere(ctx),
          ]);
          ctx.enrich({ sources: [heritage, biosphere].map(sourceOf) });
          return { topic, regions: keep(regionRows(heritage, biosphere), (r) => [r.name, r.code]) };
        }
        case 'intangible_lists': {
          const intangible = await svc.getIntangible(ctx);
          ctx.enrich({ sources: [sourceOf(intangible)] });
          const rows = INTANGIBLE_LISTS.map((name) => ({
            name,
            acronym: INTANGIBLE_LIST_ACRONYMS[name],
            element_count: intangible.records.filter((e) => e.list === name).length,
          }));
          return { topic, intangible_lists: keep(rows, (r) => [r.name, r.acronym]) };
        }
        case 'biosphere_networks': {
          const biosphere = await svc.getBiosphere(ctx);
          ctx.enrich({ sources: [sourceOf(biosphere)] });
          const rows: z.infer<typeof NetworkRow>[] = BIOSPHERE_NETWORKS.map(
            ({ name, acronym }) => ({
              name,
              acronym,
              reserve_count: biosphere.records.filter((r) => r.regional_network === name).length,
            }),
          );
          rows.push({
            name: 'No regional network',
            reserve_count: biosphere.records.filter((r) => !r.regional_network).length,
          });
          return { topic, biosphere_networks: keep(rows, (r) => [r.name, r.acronym]) };
        }
        case 'datasets': {
          const snapshots = await loadAll();
          ctx.enrich({ sources: snapshots.map(sourceOf) });
          return { topic, datasets: keep(datasetRows(...snapshots), (r) => [r.dataset, r.title]) };
        }
      }
    };

    const result = await list(input.topic);
    const listed = result[result.topic];
    if (filter && listed?.length === 0) {
      ctx.enrich.notice(
        noMatch ??
          `No ${input.topic} entry contains every word of "${inline(filter)}". Call unesco_list_reference with topic ${input.topic} and no filter to see every entry.`,
      );
    }
    ctx.log.info('Reference listed', { topic: input.topic, entries: listed?.length ?? 0 });
    return result;
  },

  format: (result) => {
    const sections: string[] = [`## UNESCO reference: ${result.topic}`];
    if (result.criteria) {
      sections.push(
        table(
          ['Code', 'Group', 'Meaning', 'Sites', 'Inferred'],
          result.criteria.map((r) => [
            `(${r.code})`,
            r.group,
            cell(r.meaning),
            String(r.site_count),
            String(r.inferred_count),
          ]),
        ),
      );
    }
    if (result.countries) {
      sections.push(
        table(
          [
            'Code',
            'Alpha-3',
            'Name',
            'UNESCO name',
            'World Heritage sites',
            'Intangible elements',
            'Biosphere reserves',
          ],
          result.countries.map((r) => [
            r.code ?? 'No ISO code',
            r.alpha3 ?? '—',
            cell(r.name),
            r.unesco_name ? cell(r.unesco_name) : '—',
            String(r.heritage_site_count),
            String(r.intangible_element_count),
            String(r.biosphere_reserve_count),
          ]),
        ),
      );
    }
    if (result.regions) {
      sections.push(
        table(
          ['Region', 'Code', 'World Heritage sites', 'Biosphere reserves'],
          result.regions.map((r) => [
            r.name,
            r.code,
            String(r.heritage_site_count),
            String(r.biosphere_reserve_count),
          ]),
        ),
      );
    }
    if (result.intangible_lists) {
      sections.push(
        table(
          ['List', 'Acronym', 'Elements'],
          result.intangible_lists.map((r) => [r.name, r.acronym, String(r.element_count)]),
        ),
      );
    }
    if (result.biosphere_networks) {
      sections.push(
        table(
          ['Network', 'Acronym', 'Reserves'],
          result.biosphere_networks.map((r) => [r.name, r.acronym ?? '—', String(r.reserve_count)]),
        ),
      );
    }
    if (result.datasets) {
      sections.push(
        table(
          ['Dataset', 'Title', 'Records', 'Data as of', 'License', 'License URL', 'Attribution'],
          result.datasets.map((r) => [
            r.dataset,
            r.title,
            String(r.records),
            cell(r.data_as_of),
            r.license,
            r.license_url,
            cell(r.attribution),
          ]),
        ),
      );
      for (const r of result.datasets) {
        sections.push(
          `**Coverage notes — ${r.dataset}:**\n${r.coverage_notes.map((n) => `- ${n}`).join('\n')}`,
        );
      }
    }
    return [{ type: 'text', text: sections.join('\n\n') }];
  },
});

/** A markdown table; cells arrive already escaped. */
function table(header: string[], rows: string[][]): string {
  if (rows.length === 0) return '_No entries._';
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function criteriaRows(heritage: HeritageSnapshot): z.infer<typeof CriterionRow>[] {
  return CRITERIA_CODES.map((code) => ({
    code,
    group: CRITERIA[code].group,
    meaning: CRITERIA[code].meaning,
    site_count: heritage.records.filter((s) => s.criteria.includes(code)).length,
    inferred_count: heritage.records.filter((s) => s.criteria_inferred.includes(code)).length,
  }));
}

function countryRows(
  heritage: HeritageSnapshot,
  intangible: IntangibleSnapshot,
  biosphere: BiosphereSnapshot,
): z.infer<typeof CountryRow>[] {
  type Tally = { unesco_name?: string; heritage: number; intangible: number; biosphere: number };
  const byCode = new Map<string, Tally>();
  const codeless = new Map<string, Tally>();
  const tally = (map: Map<string, Tally>, key: string) => {
    let entry = map.get(key);
    if (!entry) {
      entry = { heritage: 0, intangible: 0, biosphere: 0 };
      map.set(key, entry);
    }
    return entry;
  };

  for (const site of heritage.records) {
    if (site.country_codes.length === 0) {
      for (const state of site.states) {
        const entry = tally(codeless, state);
        entry.unesco_name = state;
        entry.heritage += 1;
      }
      continue;
    }
    site.country_codes.forEach((code, i) => {
      const entry = tally(byCode, code);
      const state = site.states[i];
      if (!entry.unesco_name && state) entry.unesco_name = state;
    });
    for (const code of new Set(site.country_codes)) tally(byCode, code).heritage += 1;
  }
  for (const element of intangible.records) {
    for (const code of new Set(element.country_codes)) tally(byCode, code).intangible += 1;
  }
  for (const reserve of biosphere.records) {
    const entry = tally(byCode, reserve.country_code);
    entry.unesco_name ??= reserve.country;
    entry.biosphere += 1;
  }

  const rows: z.infer<typeof CountryRow>[] = [];
  for (const [code, t] of byCode) {
    const alpha3 = alpha3Of(code);
    rows.push({
      code,
      ...(alpha3 ? { alpha3 } : {}),
      name: countryDisplayName(code),
      ...(t.unesco_name ? { unesco_name: t.unesco_name } : {}),
      heritage_site_count: t.heritage,
      intangible_element_count: t.intangible,
      biosphere_reserve_count: t.biosphere,
    });
  }
  for (const [name, t] of codeless) {
    rows.push({
      name,
      unesco_name: name,
      heritage_site_count: t.heritage,
      intangible_element_count: t.intangible,
      biosphere_reserve_count: t.biosphere,
    });
  }
  return rows.sort((a, b) => compareText(a.name, b.name));
}

function regionRows(
  heritage: HeritageSnapshot,
  biosphere: BiosphereSnapshot,
): z.infer<typeof RegionRow>[] {
  return REGIONS.map((name) => ({
    name,
    code: REGION_CODES[name],
    heritage_site_count: heritage.records.filter((s) => s.region === name).length,
    biosphere_reserve_count: biosphere.records.filter((r) => r.regions.includes(name)).length,
  }));
}

function datasetRows(
  heritage: HeritageSnapshot,
  intangible: IntangibleSnapshot,
  biosphere: BiosphereSnapshot,
): z.infer<typeof DatasetRow>[] {
  const viSites = heritage.records.filter((s) => s.criteria_inferred.includes('vi')).length;
  const dated2008 = intangible.records.filter((e) => e.inscribed_year === 2008).length;
  const notes: Record<DatasetId, string[]> = {
    whc001: [
      `UNESCO's criteria fields omit criterion (vi); this server infers it from each site's statement of Outstanding Universal Value (${countOf(viSites, 'site')}) and marks it as inferred.`,
      'The Danger list carries one year per current listing: no threat factors, no earlier listings, and no sites removed from the list.',
      'No delisted sites are present.',
    ],
    ich001: [
      `The ${countOf(dated2008, 'element')} dated 2008 ${dated2008 === 1 ? 'carries' : 'carry'} the year of incorporation into the Representative List, not the earlier proclamation.`,
      'Each element carries one inscription year; transfers between lists and removals are not recorded.',
    ],
    mab001: [
      'The area unit is undocumented upstream; areas are passed through as recorded and labelled hectares.',
      'Zone areas and populations do not always sum to the recorded totals, and a population of 0 can mean none or unreported.',
      'No withdrawn reserves are present.',
    ],
  };
  return [heritage, intangible, biosphere].map((s) => ({
    dataset: s.dataset,
    title: DATASET_TITLES[s.dataset],
    records: s.records.length,
    data_as_of: s.asOf,
    license: s.license,
    license_url: LICENSE_URL,
    attribution: datasetAttribution(s.dataset),
    coverage_notes: notes[s.dataset],
  }));
}
