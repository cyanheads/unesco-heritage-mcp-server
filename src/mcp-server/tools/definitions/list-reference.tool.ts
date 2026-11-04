/**
 * @fileoverview unesco_list_reference — decodes the vocabulary the other
 * unesco_ tools accept (criteria, countries, regions, intangible heritage
 * lists, MAB regional networks) and reports dataset coverage, license, and
 * data dates. The country-name → ISO code resolver. A topic that reads several
 * datasets answers from the ones that loaded and names the others.
 * @module mcp-server/tools/definitions/list-reference.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { countOf, renderSources, sourcesFieldOf } from '@/mcp-server/shared/enrichment.js';
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
  GeoparkSnapshot,
  HeritageSnapshot,
  IntangibleSnapshot,
  Snapshot,
} from '@/services/unesco-datahub/types.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import {
  BIOSPHERE_NETWORKS,
  CRITERIA,
  CRITERIA_CODES,
  DATASET_IDS,
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
      .optional()
      .describe('World Heritage sites listing this country, transboundary sites included.'),
    intangible_element_count: z
      .number()
      .optional()
      .describe(
        'Intangible heritage elements listing this country, multinational elements included.',
      ),
    biosphere_reserve_count: z.number().optional().describe('Biosphere reserves in this country.'),
    geopark_count: z
      .number()
      .optional()
      .describe('UNESCO Global Geoparks listing this country, transnational geoparks included.'),
  })
  .describe(
    'One country. A count is absent, never 0, when its dataset could not load; the notice names that dataset.',
  );

const RegionRow = z
  .object({
    name: z.string().describe('UNESCO region name, as the region inputs take it.'),
    code: z.string().describe('UNESCO region code, also accepted by the region inputs.'),
    heritage_site_count: z.number().optional().describe('World Heritage sites in the region.'),
    biosphere_reserve_count: z
      .number()
      .optional()
      .describe(
        'Biosphere reserves in the region (a reserve spanning two regions counts in each).',
      ),
  })
  .describe(
    'One UNESCO region. A count is absent, never 0, when its dataset could not load; the notice names that dataset.',
  );

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
    available: z.boolean().describe('Whether the dataset loaded.'),
    retryable: z
      .boolean()
      .optional()
      .describe(
        "Whether a later call can load the dataset: true when the Data Hub was unreachable or failing, false when it rejected this server's request or served data this server cannot use. Present only when available is false.",
      ),
    records: z.number().optional().describe('Records in the loaded snapshot.'),
    data_as_of: z
      .string()
      .optional()
      .describe("The dataset's data_processed timestamp (ISO 8601)."),
    license: z.string().optional().describe('Dataset license.'),
    license_url: z.string().describe('License text URL.'),
    attribution: z.string().describe('Credit line to reproduce with the data.'),
    coverage_notes: z
      .array(z.string().describe('One note.'))
      .optional()
      .describe('Data gaps that change how results read.'),
  })
  .describe(
    'One dataset. records, data_as_of, license, and coverage_notes are absent when it could not load.',
  );

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
/** The topics that read more than one dataset, and so can answer while one is unavailable. */
type PartialTopic = 'countries' | 'regions' | 'datasets';

/** A dataset the topic reads whose first load failed with `snapshot_unavailable`. */
interface Unavailable {
  dataset: DatasetId;
  error: McpError;
  retryable: boolean;
}

/** The snapshots of the four datasets; one whose first load failed is undefined. */
interface Snapshots {
  biosphere: BiosphereSnapshot | undefined;
  geoparks: GeoparkSnapshot | undefined;
  heritage: HeritageSnapshot | undefined;
  intangible: IntangibleSnapshot | undefined;
}

export const listReferenceTool = tool('unesco_list_reference', {
  title: 'List UNESCO reference vocabulary',
  description:
    "List the vocabulary the other unesco_ tools accept and the coverage of the underlying datasets: the ten inscription criteria with their meanings and site counts, the countries in each dataset with their ISO alpha-2 and alpha-3 codes and record counts, the five UNESCO regions, the three intangible heritage lists, the MAB regional networks, and each dataset's record count, license, and data date. Set filter to narrow a topic to matching entries, for example a country name to find its code.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    topic: z
      .enum(TOPICS)
      .describe(
        'What to list. criteria: the ten inscription criteria (i)–(x) with meanings and site counts, the values of the criteria input of unesco_search_sites. countries: every country with its ISO alpha-2 and alpha-3 codes and counts per dataset, the values of every country input. regions: the five UNESCO regions with codes, the values of the region inputs. intangible_lists: the three intangible heritage lists with acronyms, the values of the list input of unesco_search_intangible_heritage. biosphere_networks: the MAB regional networks with acronyms, the values of the regional_network input of unesco_search_biosphere_reserves. datasets: each dataset with whether it loaded, its record count, data date, license, attribution, and coverage notes.',
      ),
    filter: queryInput(
      `Keep only entries whose name or code (a criterion's meaning, a dataset's title) contains every word of this text, each word matching at the start of a word. Case, accents, and punctuation are ignored, so the filter must contain at least one letter or digit and at most ${MAX_QUERY_WORDS} distinct words. For example, a country name finds its ISO code. For countries, a two- or three-letter ISO code (or UK) keeps exactly that country, as the country inputs read it, and common former or everyday names such as Turkey, Swaziland, or Holland match too.`,
      100,
    ),
  }),
  output: ReferenceOutput,
  enrichment: {
    sources: sourcesFieldOf(DATASET_IDS),
    notice: z
      .string()
      .optional()
      .describe(
        'Names each dataset that could not load and what the answer leaves out for it, then guidance when the filter matched no entry.',
      ),
  },
  enrichmentTrailer: {
    sources: { render: renderSources },
  },
  errors: [
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No dataset the topic reads has loaded yet (countries, regions, and datasets answer from the ones that did, when any did): the Data Hub is unreachable, failing, or rate-limiting (retryable), or it rejected the request or served data this server cannot use (not retryable)',
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the datasets this topic reads; wait until the next load attempt this error names (retryAfter, in seconds), then call unesco_list_reference again.',
    },
  ],

  async handler(input, ctx) {
    const svc = getUnescoDataHubService();
    const filter = input.filter;
    const keep = <T>(rows: T[], columns: (row: T) => (string | undefined)[]) =>
      filter ? rows.filter((row) => matchesAllWords(filter, columns(row))) : rows;

    /** The datasets the topic reads whose first load failed, in topic order. */
    const unavailable: Unavailable[] = [];
    let unavailableNote: string | undefined;
    let noMatch: string | undefined;

    /**
     * A settled load's snapshot, or undefined for a `snapshot_unavailable`
     * failure, which `unavailable` records. Any other rejection, the caller's
     * abort above all, rejects the call unchanged.
     */
    const loaded = <S>(dataset: DatasetId, result: PromiseSettledResult<S>): S | undefined => {
      if (result.status === 'fulfilled') return result.value;
      const error: unknown = result.reason;
      if (!(error instanceof McpError) || error.data?.reason !== 'snapshot_unavailable') {
        throw error;
      }
      unavailable.push({ dataset, error, retryable: error.data.retryable === true });
      return;
    };

    /**
     * Ends a topic's loads. Fails the call when none of its `read` datasets
     * loaded, with the first retryable failure in topic order, else the first,
     * so every run names the same dataset; then when the caller has cancelled,
     * so the datasets that loaded never answer a cancelled call.
     */
    const settle = (topic: PartialTopic, read: number) => {
      const [first] = unavailable;
      if (first && unavailable.length === read) {
        throw (unavailable.find((u) => u.retryable) ?? first).error;
      }
      ctx.signal.throwIfAborted();
      unavailableNote = unavailableFragment(topic, unavailable);
    };

    const loadAll = async (topic: 'countries' | 'datasets'): Promise<Snapshots> => {
      const [heritage, intangible, biosphere, geoparks] = await Promise.allSettled([
        svc.getHeritage(ctx),
        svc.getIntangible(ctx),
        svc.getBiosphere(ctx),
        svc.getGeoparks(ctx),
      ]);
      const snapshots: Snapshots = {
        heritage: loaded('whc001', heritage),
        intangible: loaded('ich001', intangible),
        biosphere: loaded('mab001', biosphere),
        geoparks: loaded('eg0001', geoparks),
      };
      settle(topic, 4);
      return snapshots;
    };
    const sourcesOf = (s: Snapshots) =>
      sourcesFrom(s.heritage, s.intangible, s.biosphere, s.geoparks);

    const list = async (topic: Topic): Promise<ReferenceResult> => {
      switch (topic) {
        case 'criteria': {
          const heritage = await svc.getHeritage(ctx);
          ctx.enrich({ sources: [sourceOf(heritage)] });
          return { topic, criteria: keep(criteriaRows(heritage), (r) => [r.code, r.meaning]) };
        }
        case 'countries': {
          const snapshots = await loadAll(topic);
          ctx.enrich({ sources: sourcesOf(snapshots) });
          const rows = countryRows(snapshots);
          const code = filter && normalizeCountry(filter);
          if (typeof code === 'string' && isAssignedAlpha2(code)) {
            const exact = rows.filter((r) => r.code === code);
            if (exact.length === 0) {
              noMatch = `${code} (${countryDisplayName(code)}) is an assigned ISO 3166-1 code, but ${unavailable.length === 0 ? 'no UNESCO dataset lists' : 'none of the UNESCO datasets that loaded lists'} that country.`;
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
          const [heritageLoad, biosphereLoad] = await Promise.allSettled([
            svc.getHeritage(ctx),
            svc.getBiosphere(ctx),
          ]);
          const heritage = loaded('whc001', heritageLoad);
          const biosphere = loaded('mab001', biosphereLoad);
          settle(topic, 2);
          ctx.enrich({ sources: sourcesFrom(heritage, biosphere) });
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
          const snapshots = await loadAll(topic);
          ctx.enrich({ sources: sourcesOf(snapshots) });
          return {
            topic,
            datasets: keep(datasetRows(snapshots, unavailable), (r) => [r.dataset, r.title]),
          };
        }
      }
    };

    const result = await list(input.topic);
    const listed = result[result.topic];
    const filterNote =
      filter && listed?.length === 0
        ? (noMatch ??
          `No ${input.topic} entry contains every word of "${inline(filter)}". Call unesco_list_reference with topic ${input.topic} and no filter to see every entry.`)
        : undefined;
    // One notice: `ctx.enrich.notice` keeps only its last value.
    const notice = [unavailableNote, filterNote].filter((n) => n !== undefined).join(' ');
    if (notice) ctx.enrich.notice(notice);
    ctx.log.info('Reference listed', {
      topic: input.topic,
      entries: listed?.length ?? 0,
      unavailable: unavailable.map((u) => u.dataset),
    });
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
            'Geoparks',
          ],
          result.countries.map((r) => [
            r.code ?? 'No ISO code',
            r.alpha3 ?? '—',
            cell(r.name),
            r.unesco_name ? cell(r.unesco_name) : '—',
            countCell(r.heritage_site_count),
            countCell(r.intangible_element_count),
            countCell(r.biosphere_reserve_count),
            countCell(r.geopark_count),
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
            countCell(r.heritage_site_count),
            countCell(r.biosphere_reserve_count),
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
          [
            'Dataset',
            'Title',
            'Available',
            'Records',
            'Data as of',
            'License',
            'License URL',
            'Attribution',
          ],
          result.datasets.map((r) => [
            r.dataset,
            r.title,
            availabilityCell(r),
            countCell(r.records),
            r.data_as_of === undefined ? NOT_AVAILABLE : cell(r.data_as_of),
            r.license ?? NOT_AVAILABLE,
            r.license_url,
            cell(r.attribution),
          ]),
        ),
      );
      for (const r of result.datasets) {
        if (r.coverage_notes) {
          sections.push(
            `**Coverage notes — ${r.dataset}:**\n${r.coverage_notes.map((n) => `- ${n}`).join('\n')}`,
          );
        }
      }
    }
    return [{ type: 'text', text: sections.join('\n\n') }];
  },
});

/** How a table renders a value its dataset could not supply. */
const NOT_AVAILABLE = 'Not available';

/** A markdown table; cells arrive already escaped. */
function table(header: string[], rows: string[][]): string {
  if (rows.length === 0) return '_No entries._';
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/** A count cell, `Not available` when the count's dataset could not load. */
function countCell(count: number | undefined): string {
  return count === undefined ? NOT_AVAILABLE : String(count);
}

/** A dataset row's availability: `Yes`, or `No` with whether a retry can load it. */
function availabilityCell(row: z.infer<typeof DatasetRow>): string {
  const loaded = row.available ? 'Yes' : 'No';
  if (row.retryable === undefined) return loaded;
  return `${loaded}, ${row.retryable ? 'retryable' : 'not retryable'}`;
}

/** The `sources` entries of the snapshots that loaded, in topic order. */
function sourcesFrom(...snapshots: (Snapshot<unknown> | undefined)[]) {
  return snapshots.flatMap((s) => (s ? [sourceOf(s)] : []));
}

/** What an answer leaves out for its unavailable datasets, by topic; `one` when a single dataset is unavailable. */
const LEFT_OUT: Readonly<Record<PartialTopic, (one: boolean) => string>> = {
  countries: (one) =>
    one
      ? 'this answer leaves out its counts and any country only it lists'
      : 'this answer leaves out their counts and any country only they list',
  regions: (one) => `this answer leaves out ${one ? 'its' : 'their'} counts`,
  datasets: (one) =>
    one ? 'its row reports available: false' : 'their rows report available: false',
};

/** The notice fragment naming each unavailable dataset by title and id, and what the answer leaves out. */
function unavailableFragment(
  topic: PartialTopic,
  unavailable: readonly Unavailable[],
): string | undefined {
  if (unavailable.length === 0) return;
  const names = unavailable.map(
    (u, i) => `${i === 0 ? 'The' : 'the'} ${DATASET_TITLES[u.dataset]} (${u.dataset})`,
  );
  const joined =
    names.length > 2
      ? `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`
      : names.join(' and ');
  return `${joined} could not be loaded from the UNESCO Data Hub, so ${LEFT_OUT[topic](names.length === 1)}.`;
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

/**
 * One row per country the loaded datasets list. An unavailable dataset adds no
 * rows, and its count field is absent from every row.
 */
function countryRows({
  heritage,
  intangible,
  biosphere,
  geoparks,
}: Snapshots): z.infer<typeof CountryRow>[] {
  type Tally = {
    unesco_name?: string;
    heritage: number;
    intangible: number;
    biosphere: number;
    geoparks: number;
  };
  const byCode = new Map<string, Tally>();
  const codeless = new Map<string, Tally>();
  const tally = (map: Map<string, Tally>, key: string) => {
    let entry = map.get(key);
    if (!entry) {
      entry = { heritage: 0, intangible: 0, biosphere: 0, geoparks: 0 };
      map.set(key, entry);
    }
    return entry;
  };
  const counts = (t: Tally) => ({
    ...(heritage ? { heritage_site_count: t.heritage } : {}),
    ...(intangible ? { intangible_element_count: t.intangible } : {}),
    ...(biosphere ? { biosphere_reserve_count: t.biosphere } : {}),
    ...(geoparks ? { geopark_count: t.geoparks } : {}),
  });

  if (heritage) {
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
  }
  if (intangible) {
    for (const element of intangible.records) {
      for (const code of new Set(element.country_codes)) tally(byCode, code).intangible += 1;
    }
  }
  if (biosphere) {
    for (const reserve of biosphere.records) {
      const entry = tally(byCode, reserve.country_code);
      entry.unesco_name ??= reserve.country;
      entry.biosphere += 1;
    }
  }
  if (geoparks) {
    for (const geopark of geoparks.records) {
      for (const code of new Set(geopark.country_codes)) tally(byCode, code).geoparks += 1;
    }
  }

  const rows: z.infer<typeof CountryRow>[] = [];
  for (const [code, t] of byCode) {
    const alpha3 = alpha3Of(code);
    rows.push({
      code,
      ...(alpha3 ? { alpha3 } : {}),
      name: countryDisplayName(code),
      ...(t.unesco_name ? { unesco_name: t.unesco_name } : {}),
      ...counts(t),
    });
  }
  for (const [name, t] of codeless) {
    rows.push({ name, unesco_name: name, ...counts(t) });
  }
  return rows.sort((a, b) => compareText(a.name, b.name));
}

/** The five regions; an unavailable dataset's count field is absent from every row. */
function regionRows(
  heritage: HeritageSnapshot | undefined,
  biosphere: BiosphereSnapshot | undefined,
): z.infer<typeof RegionRow>[] {
  return REGIONS.map((name) => ({
    name,
    code: REGION_CODES[name],
    ...(heritage
      ? { heritage_site_count: heritage.records.filter((s) => s.region === name).length }
      : {}),
    ...(biosphere
      ? {
          biosphere_reserve_count: biosphere.records.filter((r) => r.regions.includes(name)).length,
        }
      : {}),
  }));
}

/**
 * One row per dataset in topic order: a loaded one with its snapshot's record
 * count, date, license, and coverage notes; an unavailable one with
 * `available: false` and its failure's `retryable` instead.
 */
function datasetRows(
  { heritage, intangible, biosphere, geoparks }: Snapshots,
  unavailable: readonly Unavailable[],
): z.infer<typeof DatasetRow>[] {
  const rows = new Map<DatasetId, z.infer<typeof DatasetRow>>(
    unavailable.map(({ dataset, retryable }) => [
      dataset,
      {
        dataset,
        title: DATASET_TITLES[dataset],
        available: false,
        retryable,
        license_url: LICENSE_URL,
        attribution: datasetAttribution(dataset),
      },
    ]),
  );
  if (heritage) {
    const viSites = heritage.records.filter((s) => s.criteria_inferred.includes('vi')).length;
    rows.set(
      'whc001',
      loadedDatasetRow(heritage, [
        `UNESCO's criteria fields omit criterion (vi); this server infers it from each site's statement of Outstanding Universal Value (${countOf(viSites, 'site')}) and marks it as inferred.`,
        'The Danger list carries one year per current listing: no threat factors, no earlier listings, and no sites removed from the list.',
        'No delisted sites are present.',
      ]),
    );
  }
  if (intangible) {
    const dated2008 = intangible.records.filter((e) => e.inscribed_year === 2008).length;
    rows.set(
      'ich001',
      loadedDatasetRow(intangible, [
        `The ${countOf(dated2008, 'element')} dated 2008 ${dated2008 === 1 ? 'carries' : 'carry'} the year of incorporation into the Representative List, not the earlier proclamation.`,
        'Each element carries one inscription year; transfers between lists and removals are not recorded.',
      ]),
    );
  }
  if (biosphere) {
    rows.set(
      'mab001',
      loadedDatasetRow(biosphere, [
        'The area unit is undocumented upstream; areas are passed through as recorded and labelled hectares.',
        'Zone areas and populations do not always sum to the recorded totals, and a population of 0 can mean none or unreported.',
        'No withdrawn reserves are present.',
      ]),
    );
  }
  if (geoparks) {
    const dated2015 = geoparks.records.filter((g) => g.designation_year === 2015).length;
    rows.set(
      'eg0001',
      loadedDatasetRow(geoparks, [
        `The ${countOf(dated2015, 'geopark')} dated 2015 ${dated2015 === 1 ? 'carries' : 'carry'} the year UNESCO created the UNESCO Global Geopark designation, not the year ${dated2015 === 1 ? 'it' : 'each'} joined the Global Geoparks Network, which the data does not record.`,
        'Areas and populations are passed through as recorded; population is absent where UNESCO records no figure, and 0 can mean unreported.',
        'Images are omitted, because the dataset records no image credit.',
      ]),
    );
  }
  return DATASET_IDS.flatMap((dataset) => rows.get(dataset) ?? []);
}

function loadedDatasetRow(
  snapshot: Snapshot<unknown>,
  coverage_notes: string[],
): z.infer<typeof DatasetRow> {
  return {
    dataset: snapshot.dataset,
    title: DATASET_TITLES[snapshot.dataset],
    available: true,
    records: snapshot.records.length,
    data_as_of: snapshot.asOf,
    license: snapshot.license,
    license_url: LICENSE_URL,
    attribution: datasetAttribution(snapshot.dataset),
    coverage_notes,
  };
}
