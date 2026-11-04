/**
 * @fileoverview Tests for unesco_list_reference: every topic's rows and counts
 * over the synthetic fixtures, the blank-as-unset `filter` and its word-prefix
 * matching, zero-match notices, the enrichment contract, per-topic dataset
 * independence, upstream failure classes, and format() parity with
 * structuredContent including pipe and line-break escaping in table cells.
 * @module tests/tools/list-reference.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { searchBiosphereReservesTool } from '@/mcp-server/tools/definitions/search-biosphere-reserves.tool.js';
import { searchGeoparksTool } from '@/mcp-server/tools/definitions/search-geoparks.tool.js';
import { searchIntangibleHeritageTool } from '@/mcp-server/tools/definitions/search-intangible-heritage.tool.js';
import { searchSitesTool } from '@/mcp-server/tools/definitions/search-sites.tool.js';
import {
  getUnescoDataHubService,
  type UnescoDataHubService,
} from '@/services/unesco-datahub/unesco-datahub-service.js';
import { CRITERIA, DATASET_IDS, type DatasetId } from '@/services/unesco-datahub/vocabulary.js';
import { declaredRecovery } from '../fixtures/contract.js';
import {
  contentFailureCases,
  expectContentFailure,
  settle,
  transportFailureCases,
  withFakeTimers,
} from '../fixtures/failures.js';
import { DATA_AS_OF, type HubOptions, httpFailure, transientFailure } from '../fixtures/hub.js';
import { EG_ROWS, egRow, ICH_ROWS, ichRow, WHC_ROWS, whcRow } from '../fixtures/rows.js';
import {
  allText,
  disposeServiceAfterEach,
  errorOf,
  structured,
  textBlocks,
  useHub,
} from '../fixtures/tool.js';

type ReferenceOutput = z.infer<typeof listReferenceTool.output> & {
  notice?: string;
  sources: { dataset: string; license: string; data_as_of: string }[];
};

disposeServiceAfterEach();

const list = async (input: Record<string, unknown>) => {
  const result = await runToolContract(listReferenceTool, input as never);
  return { result, out: structured<ReferenceOutput>(result), text: allText(result) };
};

const NO_ICH: HubOptions = {
  intercept: (call) => (call.dataset === 'ich001' ? transientFailure() : undefined),
};

const NO_EG: HubOptions = {
  intercept: (call) => (call.dataset === 'eg0001' ? transientFailure() : undefined),
};

/**
 * Every topic's whole answer with every dataset loaded, on both surfaces. A
 * dataset that cannot load changes a topic's answer; one that loads must not.
 */
describe('unesco_list_reference — every dataset loaded', () => {
  beforeEach(() => {
    useHub();
  });

  it('answers topic criteria in full', async () => {
    const { out, text } = await list({ topic: 'criteria' });
    expect(out).toMatchInlineSnapshot(`
      {
        "criteria": [
          {
            "code": "i",
            "group": "cultural",
            "inferred_count": 0,
            "meaning": "A masterpiece of human creative genius.",
            "site_count": 1,
          },
          {
            "code": "ii",
            "group": "cultural",
            "inferred_count": 0,
            "meaning": "An important interchange of human values over time or within a cultural area, in architecture, technology, monumental arts, town planning, or landscape design.",
            "site_count": 1,
          },
          {
            "code": "iii",
            "group": "cultural",
            "inferred_count": 0,
            "meaning": "A unique or exceptional testimony to a cultural tradition or a civilization, living or vanished.",
            "site_count": 3,
          },
          {
            "code": "iv",
            "group": "cultural",
            "inferred_count": 0,
            "meaning": "An outstanding example of a type of building, architectural or technological ensemble, or landscape illustrating significant stages in human history.",
            "site_count": 34,
          },
          {
            "code": "v",
            "group": "cultural",
            "inferred_count": 0,
            "meaning": "An outstanding example of traditional human settlement, land use, or sea use representative of a culture or of human interaction with the environment, especially where vulnerable to irreversible change.",
            "site_count": 0,
          },
          {
            "code": "vi",
            "group": "cultural",
            "inferred_count": 2,
            "meaning": "Direct association with events, living traditions, ideas, beliefs, or artistic and literary works of outstanding universal significance.",
            "site_count": 2,
          },
          {
            "code": "vii",
            "group": "natural",
            "inferred_count": 0,
            "meaning": "Superlative natural phenomena, or areas of exceptional natural beauty and aesthetic importance.",
            "site_count": 1,
          },
          {
            "code": "viii",
            "group": "natural",
            "inferred_count": 0,
            "meaning": "An outstanding example of a major stage of Earth's history, including the record of life, significant ongoing geological processes, or significant landforms.",
            "site_count": 0,
          },
          {
            "code": "ix",
            "group": "natural",
            "inferred_count": 0,
            "meaning": "An outstanding example of significant ongoing ecological and biological processes in the evolution of ecosystems and communities of plants and animals.",
            "site_count": 1,
          },
          {
            "code": "x",
            "group": "natural",
            "inferred_count": 0,
            "meaning": "The most important natural habitats for in-situ conservation of biological diversity, including those holding threatened species of outstanding universal value.",
            "site_count": 1,
          },
        ],
        "sources": [
          {
            "attribution": "UNESCO — World Heritage List (whc001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "whc001",
            "license": "CC BY-SA 4.0",
            "title": "World Heritage List",
          },
        ],
        "topic": "criteria",
      }
    `);
    expect(text).toMatchInlineSnapshot(`
      "## UNESCO reference: criteria

      | Code | Group | Meaning | Sites | Inferred |
      | --- | --- | --- | --- | --- |
      | (i) | cultural | A masterpiece of human creative genius. | 1 | 0 |
      | (ii) | cultural | An important interchange of human values over time or within a cultural area, in architecture, technology, monumental arts, town planning, or landscape design. | 1 | 0 |
      | (iii) | cultural | A unique or exceptional testimony to a cultural tradition or a civilization, living or vanished. | 3 | 0 |
      | (iv) | cultural | An outstanding example of a type of building, architectural or technological ensemble, or landscape illustrating significant stages in human history. | 34 | 0 |
      | (v) | cultural | An outstanding example of traditional human settlement, land use, or sea use representative of a culture or of human interaction with the environment, especially where vulnerable to irreversible change. | 0 | 0 |
      | (vi) | cultural | Direct association with events, living traditions, ideas, beliefs, or artistic and literary works of outstanding universal significance. | 2 | 2 |
      | (vii) | natural | Superlative natural phenomena, or areas of exceptional natural beauty and aesthetic importance. | 1 | 0 |
      | (viii) | natural | An outstanding example of a major stage of Earth's history, including the record of life, significant ongoing geological processes, or significant landforms. | 0 | 0 |
      | (ix) | natural | An outstanding example of significant ongoing ecological and biological processes in the evolution of ecosystems and communities of plants and animals. | 1 | 0 |
      | (x) | natural | The most important natural habitats for in-situ conservation of biological diversity, including those holding threatened species of outstanding universal value. | 1 | 0 |


      Source: UNESCO — World Heritage List (whc001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/"
    `);
  });

  it('answers topic countries in full', async () => {
    const { out, text } = await list({ topic: 'countries' });
    expect(out).toMatchInlineSnapshot(`
      {
        "countries": [
          {
            "alpha3": "BEL",
            "biosphere_reserve_count": 0,
            "code": "BE",
            "geopark_count": 0,
            "heritage_site_count": 0,
            "intangible_element_count": 1,
            "name": "Belgium",
          },
          {
            "alpha3": "ETH",
            "biosphere_reserve_count": 0,
            "code": "ET",
            "geopark_count": 0,
            "heritage_site_count": 1,
            "intangible_element_count": 1,
            "name": "Ethiopia",
            "unesco_name": "Ethiopia",
          },
          {
            "alpha3": "FRA",
            "biosphere_reserve_count": 1,
            "code": "FR",
            "geopark_count": 1,
            "heritage_site_count": 32,
            "intangible_element_count": 1,
            "name": "France",
            "unesco_name": "France",
          },
          {
            "alpha3": "DEU",
            "biosphere_reserve_count": 1,
            "code": "DE",
            "geopark_count": 1,
            "heritage_site_count": 3,
            "intangible_element_count": 0,
            "name": "Germany",
            "unesco_name": "Germany",
          },
          {
            "alpha3": "ITA",
            "biosphere_reserve_count": 0,
            "code": "IT",
            "geopark_count": 1,
            "heritage_site_count": 0,
            "intangible_element_count": 0,
            "name": "Italy",
          },
          {
            "alpha3": "JPN",
            "biosphere_reserve_count": 0,
            "code": "JP",
            "geopark_count": 1,
            "heritage_site_count": 1,
            "intangible_element_count": 1,
            "name": "Japan",
            "unesco_name": "Japan",
          },
          {
            "alpha3": "PER",
            "biosphere_reserve_count": 1,
            "code": "PE",
            "geopark_count": 1,
            "heritage_site_count": 1,
            "intangible_element_count": 0,
            "name": "Peru",
            "unesco_name": "Peru",
          },
          {
            "alpha3": "POL",
            "biosphere_reserve_count": 1,
            "code": "PL",
            "geopark_count": 1,
            "heritage_site_count": 1,
            "intangible_element_count": 0,
            "name": "Poland",
            "unesco_name": "Poland",
          },
          {
            "biosphere_reserve_count": 0,
            "geopark_count": 0,
            "heritage_site_count": 1,
            "intangible_element_count": 0,
            "name": "Synthetic Party Name",
            "unesco_name": "Synthetic Party Name",
          },
        ],
        "sources": [
          {
            "attribution": "UNESCO — World Heritage List (whc001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "whc001",
            "license": "CC BY-SA 4.0",
            "title": "World Heritage List",
          },
          {
            "attribution": "UNESCO — Intangible Heritage List (ich001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "ich001",
            "license": "CC BY-SA 4.0",
            "title": "Intangible Heritage List",
          },
          {
            "attribution": "UNESCO — Man and the Biosphere Programme (mab001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "mab001",
            "license": "CC BY-SA 4.0",
            "title": "Man and the Biosphere Programme",
          },
          {
            "attribution": "UNESCO — UNESCO Global Geoparks (eg0001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "eg0001",
            "license": "CC BY-SA 4.0",
            "title": "UNESCO Global Geoparks",
          },
        ],
        "topic": "countries",
      }
    `);
    expect(text).toMatchInlineSnapshot(`
      "## UNESCO reference: countries

      | Code | Alpha-3 | Name | UNESCO name | World Heritage sites | Intangible elements | Biosphere reserves | Geoparks |
      | --- | --- | --- | --- | --- | --- | --- | --- |
      | BE | BEL | Belgium | — | 0 | 1 | 0 | 0 |
      | ET | ETH | Ethiopia | Ethiopia | 1 | 1 | 0 | 0 |
      | FR | FRA | France | France | 32 | 1 | 1 | 1 |
      | DE | DEU | Germany | Germany | 3 | 0 | 1 | 1 |
      | IT | ITA | Italy | — | 0 | 0 | 0 | 1 |
      | JP | JPN | Japan | Japan | 1 | 1 | 0 | 1 |
      | PE | PER | Peru | Peru | 1 | 0 | 1 | 1 |
      | PL | POL | Poland | Poland | 1 | 0 | 1 | 1 |
      | No ISO code | — | Synthetic Party Name | Synthetic Party Name | 1 | 0 | 0 | 0 |


      Source: UNESCO — World Heritage List (whc001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/
      Source: UNESCO — Intangible Heritage List (ich001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/
      Source: UNESCO — Man and the Biosphere Programme (mab001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/
      Source: UNESCO — UNESCO Global Geoparks (eg0001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/"
    `);
  });

  it('answers topic regions in full', async () => {
    const { out, text } = await list({ topic: 'regions' });
    expect(out).toMatchInlineSnapshot(`
      {
        "regions": [
          {
            "biosphere_reserve_count": 0,
            "code": "AFR",
            "heritage_site_count": 1,
            "name": "Africa",
          },
          {
            "biosphere_reserve_count": 0,
            "code": "ARB",
            "heritage_site_count": 1,
            "name": "Arab States",
          },
          {
            "biosphere_reserve_count": 0,
            "code": "APA",
            "heritage_site_count": 1,
            "name": "Asia and the Pacific",
          },
          {
            "biosphere_reserve_count": 3,
            "code": "EUR",
            "heritage_site_count": 35,
            "name": "Europe and North America",
          },
          {
            "biosphere_reserve_count": 1,
            "code": "LAC",
            "heritage_site_count": 1,
            "name": "Latin America and the Caribbean",
          },
        ],
        "sources": [
          {
            "attribution": "UNESCO — World Heritage List (whc001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "whc001",
            "license": "CC BY-SA 4.0",
            "title": "World Heritage List",
          },
          {
            "attribution": "UNESCO — Man and the Biosphere Programme (mab001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "mab001",
            "license": "CC BY-SA 4.0",
            "title": "Man and the Biosphere Programme",
          },
        ],
        "topic": "regions",
      }
    `);
    expect(text).toMatchInlineSnapshot(`
      "## UNESCO reference: regions

      | Region | Code | World Heritage sites | Biosphere reserves |
      | --- | --- | --- | --- |
      | Africa | AFR | 1 | 0 |
      | Arab States | ARB | 1 | 0 |
      | Asia and the Pacific | APA | 1 | 0 |
      | Europe and North America | EUR | 35 | 3 |
      | Latin America and the Caribbean | LAC | 1 | 1 |


      Source: UNESCO — World Heritage List (whc001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/
      Source: UNESCO — Man and the Biosphere Programme (mab001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/"
    `);
  });

  it('answers topic intangible_lists in full', async () => {
    const { out, text } = await list({ topic: 'intangible_lists' });
    expect(out).toMatchInlineSnapshot(`
      {
        "intangible_lists": [
          {
            "acronym": "RL",
            "element_count": 1,
            "name": "Representative List",
          },
          {
            "acronym": "USL",
            "element_count": 1,
            "name": "Urgent Safeguarding List",
          },
          {
            "acronym": "Art18",
            "element_count": 1,
            "name": "Register of Good Safeguarding Practices",
          },
        ],
        "sources": [
          {
            "attribution": "UNESCO — Intangible Heritage List (ich001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "ich001",
            "license": "CC BY-SA 4.0",
            "title": "Intangible Heritage List",
          },
        ],
        "topic": "intangible_lists",
      }
    `);
    expect(text).toMatchInlineSnapshot(`
      "## UNESCO reference: intangible_lists

      | List | Acronym | Elements |
      | --- | --- | --- |
      | Representative List | RL | 1 |
      | Urgent Safeguarding List | USL | 1 |
      | Register of Good Safeguarding Practices | Art18 | 1 |


      Source: UNESCO — Intangible Heritage List (ich001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/"
    `);
  });

  it('answers topic biosphere_networks in full', async () => {
    const { out, text } = await list({ topic: 'biosphere_networks' });
    expect(out).toMatchInlineSnapshot(`
      {
        "biosphere_networks": [
          {
            "acronym": "AfriMAB",
            "name": "African Biosphere Reserve Network (AfriMAB)",
            "reserve_count": 0,
          },
          {
            "acronym": "ArabMAB",
            "name": "Arab States Biosphere Reserve Network (ArabMAB)",
            "reserve_count": 0,
          },
          {
            "acronym": "EABRN",
            "name": "East Asian Biosphere Reserve Network (EABRN)",
            "reserve_count": 0,
          },
          {
            "acronym": "EuroMAB",
            "name": "Europe and North America Biosphere Reserve Network (EuroMAB)",
            "reserve_count": 3,
          },
          {
            "acronym": "IberoMAB",
            "name": "Ibero-American MAB Network (IberoMAB)",
            "reserve_count": 0,
          },
          {
            "acronym": "SACAM",
            "name": "South and Central Asia MAB Network (SACAM)",
            "reserve_count": 0,
          },
          {
            "acronym": "SeaBRnet",
            "name": "Southeast Asian Biosphere Reserve Network (SeaBRnet)",
            "reserve_count": 0,
          },
          {
            "name": "No regional network",
            "reserve_count": 1,
          },
        ],
        "sources": [
          {
            "attribution": "UNESCO — Man and the Biosphere Programme (mab001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "mab001",
            "license": "CC BY-SA 4.0",
            "title": "Man and the Biosphere Programme",
          },
        ],
        "topic": "biosphere_networks",
      }
    `);
    expect(text).toMatchInlineSnapshot(`
      "## UNESCO reference: biosphere_networks

      | Network | Acronym | Reserves |
      | --- | --- | --- |
      | African Biosphere Reserve Network (AfriMAB) | AfriMAB | 0 |
      | Arab States Biosphere Reserve Network (ArabMAB) | ArabMAB | 0 |
      | East Asian Biosphere Reserve Network (EABRN) | EABRN | 0 |
      | Europe and North America Biosphere Reserve Network (EuroMAB) | EuroMAB | 3 |
      | Ibero-American MAB Network (IberoMAB) | IberoMAB | 0 |
      | South and Central Asia MAB Network (SACAM) | SACAM | 0 |
      | Southeast Asian Biosphere Reserve Network (SeaBRnet) | SeaBRnet | 0 |
      | No regional network | — | 1 |


      Source: UNESCO — Man and the Biosphere Programme (mab001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/"
    `);
  });

  it('answers topic datasets in full', async () => {
    const { out, text } = await list({ topic: 'datasets' });
    expect(out).toMatchInlineSnapshot(`
      {
        "datasets": [
          {
            "attribution": "UNESCO — World Heritage List (whc001), UNESCO Data Hub, CC BY-SA 4.0",
            "available": true,
            "coverage_notes": [
              "UNESCO's criteria fields omit criterion (vi); this server infers it from each site's statement of Outstanding Universal Value (2 sites) and marks it as inferred.",
              "The Danger list carries one year per current listing: no threat factors, no earlier listings, and no sites removed from the list.",
              "No delisted sites are present.",
            ],
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "whc001",
            "license": "CC BY-SA 4.0",
            "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
            "records": 39,
            "title": "World Heritage List",
          },
          {
            "attribution": "UNESCO — Intangible Heritage List (ich001), UNESCO Data Hub, CC BY-SA 4.0",
            "available": true,
            "coverage_notes": [
              "The 1 element dated 2008 carries the year of incorporation into the Representative List, not the earlier proclamation.",
              "Each element carries one inscription year; transfers between lists and removals are not recorded.",
            ],
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "ich001",
            "license": "CC BY-SA 4.0",
            "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
            "records": 3,
            "title": "Intangible Heritage List",
          },
          {
            "attribution": "UNESCO — Man and the Biosphere Programme (mab001), UNESCO Data Hub, CC BY-SA 4.0",
            "available": true,
            "coverage_notes": [
              "The area unit is undocumented upstream; areas are passed through as recorded and labelled hectares.",
              "Zone areas and populations do not always sum to the recorded totals, and a population of 0 can mean none or unreported.",
              "No withdrawn reserves are present.",
            ],
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "mab001",
            "license": "CC BY-SA 4.0",
            "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
            "records": 4,
            "title": "Man and the Biosphere Programme",
          },
          {
            "attribution": "UNESCO — UNESCO Global Geoparks (eg0001), UNESCO Data Hub, CC BY-SA 4.0",
            "available": true,
            "coverage_notes": [
              "The 2 geoparks dated 2015 carry the year UNESCO created the UNESCO Global Geopark designation, not the year each joined the Global Geoparks Network, which the data does not record.",
              "Areas and populations are passed through as recorded; population is absent where UNESCO records no figure, and 0 can mean unreported.",
              "Images are omitted, because the dataset records no image credit.",
            ],
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "eg0001",
            "license": "CC BY-SA 4.0",
            "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
            "records": 5,
            "title": "UNESCO Global Geoparks",
          },
        ],
        "sources": [
          {
            "attribution": "UNESCO — World Heritage List (whc001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "whc001",
            "license": "CC BY-SA 4.0",
            "title": "World Heritage List",
          },
          {
            "attribution": "UNESCO — Intangible Heritage List (ich001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "ich001",
            "license": "CC BY-SA 4.0",
            "title": "Intangible Heritage List",
          },
          {
            "attribution": "UNESCO — Man and the Biosphere Programme (mab001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "mab001",
            "license": "CC BY-SA 4.0",
            "title": "Man and the Biosphere Programme",
          },
          {
            "attribution": "UNESCO — UNESCO Global Geoparks (eg0001), UNESCO Data Hub, CC BY-SA 4.0",
            "data_as_of": "2026-09-30T02:06:00+00:00",
            "dataset": "eg0001",
            "license": "CC BY-SA 4.0",
            "title": "UNESCO Global Geoparks",
          },
        ],
        "topic": "datasets",
      }
    `);
    expect(text).toMatchInlineSnapshot(`
      "## UNESCO reference: datasets

      | Dataset | Title | Available | Records | Data as of | License | License URL | Attribution |
      | --- | --- | --- | --- | --- | --- | --- | --- |
      | whc001 | World Heritage List | Yes | 39 | 2026-09-30T02:06:00+00:00 | CC BY-SA 4.0 | https://creativecommons.org/licenses/by-sa/4.0/ | UNESCO — World Heritage List (whc001), UNESCO Data Hub, CC BY-SA 4.0 |
      | ich001 | Intangible Heritage List | Yes | 3 | 2026-09-30T02:06:00+00:00 | CC BY-SA 4.0 | https://creativecommons.org/licenses/by-sa/4.0/ | UNESCO — Intangible Heritage List (ich001), UNESCO Data Hub, CC BY-SA 4.0 |
      | mab001 | Man and the Biosphere Programme | Yes | 4 | 2026-09-30T02:06:00+00:00 | CC BY-SA 4.0 | https://creativecommons.org/licenses/by-sa/4.0/ | UNESCO — Man and the Biosphere Programme (mab001), UNESCO Data Hub, CC BY-SA 4.0 |
      | eg0001 | UNESCO Global Geoparks | Yes | 5 | 2026-09-30T02:06:00+00:00 | CC BY-SA 4.0 | https://creativecommons.org/licenses/by-sa/4.0/ | UNESCO — UNESCO Global Geoparks (eg0001), UNESCO Data Hub, CC BY-SA 4.0 |

      **Coverage notes — whc001:**
      - UNESCO's criteria fields omit criterion (vi); this server infers it from each site's statement of Outstanding Universal Value (2 sites) and marks it as inferred.
      - The Danger list carries one year per current listing: no threat factors, no earlier listings, and no sites removed from the list.
      - No delisted sites are present.

      **Coverage notes — ich001:**
      - The 1 element dated 2008 carries the year of incorporation into the Representative List, not the earlier proclamation.
      - Each element carries one inscription year; transfers between lists and removals are not recorded.

      **Coverage notes — mab001:**
      - The area unit is undocumented upstream; areas are passed through as recorded and labelled hectares.
      - Zone areas and populations do not always sum to the recorded totals, and a population of 0 can mean none or unreported.
      - No withdrawn reserves are present.

      **Coverage notes — eg0001:**
      - The 2 geoparks dated 2015 carry the year UNESCO created the UNESCO Global Geopark designation, not the year each joined the Global Geoparks Network, which the data does not record.
      - Areas and populations are passed through as recorded; population is absent where UNESCO records no figure, and 0 can mean unreported.
      - Images are omitted, because the dataset records no image credit.


      Source: UNESCO — World Heritage List (whc001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/
      Source: UNESCO — Intangible Heritage List (ich001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/
      Source: UNESCO — Man and the Biosphere Programme (mab001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/
      Source: UNESCO — UNESCO Global Geoparks (eg0001), data as of 2026-09-30T02:06:00+00:00, CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/"
    `);
  });
});

describe('unesco_list_reference — criteria', () => {
  beforeEach(() => {
    useHub();
  });

  it('lists the ten criteria in order with meanings, groups, and site counts', async () => {
    const { out } = await list({ topic: 'criteria' });
    expect(out.topic).toBe('criteria');
    expect(out.criteria?.map((c) => c.code)).toEqual([
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
    ]);
    const counts = Object.fromEntries((out.criteria ?? []).map((c) => [c.code, c.site_count]));
    expect(counts).toEqual({
      i: 1,
      ii: 1,
      iii: 3,
      iv: 34,
      v: 0,
      vi: 2,
      vii: 1,
      viii: 0,
      ix: 1,
      x: 1,
    });
    expect(out.criteria?.find((c) => c.code === 'vi')).toMatchObject({
      inferred_count: 2,
      group: 'cultural',
      meaning: CRITERIA.vi.meaning,
    });
    expect(out.criteria?.filter((c) => c.inferred_count > 0)).toHaveLength(1);
    expect(out.criteria?.find((c) => c.code === 'ix')?.group).toBe('natural');
  });

  it('attributes only the World Heritage List and never reads the other datasets', async () => {
    const hub = useHub();
    const { out } = await list({ topic: 'criteria' });
    expect(out.sources.map((s) => s.dataset)).toEqual(['whc001']);
    expect(hub.callsFor('ich001')).toHaveLength(0);
    expect(hub.callsFor('mab001')).toHaveLength(0);
  });

  it('counts zero everywhere over an empty World Heritage dataset', async () => {
    useHub({ rows: { whc001: [] } });
    const { out } = await list({ topic: 'criteria' });
    expect(out.criteria).toHaveLength(10);
    expect(out.criteria?.every((c) => c.site_count === 0 && c.inferred_count === 0)).toBe(true);
    expect(out.notice).toBeUndefined();
  });
});

describe('unesco_list_reference — countries', () => {
  beforeEach(() => {
    useHub();
  });

  it('lists every country in any dataset, sorted by name, with the code-less party last here', async () => {
    const { out } = await list({ topic: 'countries' });
    expect(out.countries).toHaveLength(9);
    expect(out.countries?.map((c) => c.name)).toEqual([
      'Belgium',
      'Ethiopia',
      'France',
      'Germany',
      'Italy',
      'Japan',
      'Peru',
      'Poland',
      'Synthetic Party Name',
    ]);
  });

  it('counts each dataset per country and carries the alpha-3 code', async () => {
    const { out } = await list({ topic: 'countries' });
    const byCode = Object.fromEntries((out.countries ?? []).map((c) => [c.code ?? 'none', c]));
    expect(byCode.FR).toMatchObject({
      alpha3: 'FRA',
      name: 'France',
      unesco_name: 'France',
      heritage_site_count: 32,
      intangible_element_count: 1,
      biosphere_reserve_count: 1,
      geopark_count: 1,
    });
    expect(byCode.DE).toMatchObject({
      alpha3: 'DEU',
      heritage_site_count: 3,
      intangible_element_count: 0,
      biosphere_reserve_count: 1,
      geopark_count: 1,
    });
    expect(byCode.PL).toMatchObject({
      heritage_site_count: 1,
      biosphere_reserve_count: 1,
      geopark_count: 1,
    });
    expect(byCode.ET).toMatchObject({
      heritage_site_count: 1,
      intangible_element_count: 1,
      geopark_count: 0,
    });
    expect(byCode.JP).toMatchObject({
      heritage_site_count: 1,
      intangible_element_count: 1,
      geopark_count: 1,
    });
    expect(byCode.PE).toMatchObject({
      heritage_site_count: 1,
      biosphere_reserve_count: 1,
      geopark_count: 1,
    });
  });

  it('lists a country that only a geopark carries, with no UNESCO spelling', async () => {
    const { out } = await list({ topic: 'countries' });
    const italy = out.countries?.find((c) => c.code === 'IT');
    expect(italy).toEqual({
      code: 'IT',
      alpha3: 'ITA',
      name: 'Italy',
      heritage_site_count: 0,
      intangible_element_count: 0,
      biosphere_reserve_count: 0,
      geopark_count: 1,
    });
  });

  it('counts a transnational geopark once for each of its countries', async () => {
    useHub({
      rows: {
        eg0001: [
          egRow({ ugg_id: 'EUA301', countries: ['HU,SK'], transnational: 'True' }),
          egRow({ ugg_id: 'EUSK02', countries: ['SK'] }),
          egRow({ ugg_id: 'EUFR03', countries: ['FR'] }),
        ],
      },
    });
    const { out } = await list({ topic: 'countries' });
    const byCode = Object.fromEntries((out.countries ?? []).map((c) => [c.code ?? 'none', c]));
    expect(byCode.SK).toEqual({
      code: 'SK',
      alpha3: 'SVK',
      name: 'Slovakia',
      heritage_site_count: 0,
      intangible_element_count: 0,
      biosphere_reserve_count: 0,
      geopark_count: 2,
    });
    expect(byCode.HU).toMatchObject({ geopark_count: 1, heritage_site_count: 0 });
    expect(byCode.FR?.geopark_count).toBe(1);
    expect(byCode.DE?.geopark_count).toBe(0);
    const total = (out.countries ?? []).reduce(
      (sum, c) => sum + (c.geopark_count ?? Number.NaN),
      0,
    );
    expect(total).toBe(4);
  });

  it('counts zero geoparks everywhere over an empty geopark dataset', async () => {
    useHub({ rows: { eg0001: [] } });
    const { out } = await list({ topic: 'countries' });
    expect(out.countries?.map((c) => c.code)).not.toContain('IT');
    expect(out.countries).toHaveLength(8);
    expect(out.countries?.every((c) => c.geopark_count === 0)).toBe(true);
  });

  it('gives a country only an intangible element lists no UNESCO spelling', async () => {
    const { out } = await list({ topic: 'countries' });
    const be = out.countries?.find((c) => c.code === 'BE');
    expect(be).toMatchObject({
      alpha3: 'BEL',
      name: 'Belgium',
      heritage_site_count: 0,
      intangible_element_count: 1,
      biosphere_reserve_count: 0,
    });
    expect(be).not.toHaveProperty('unesco_name');
  });

  it('lists the code-less State Party by its UNESCO text with no code or alpha-3', async () => {
    const { out } = await list({ topic: 'countries' });
    const codeless = out.countries?.find((c) => c.code === undefined);
    expect(codeless).toEqual({
      name: 'Synthetic Party Name',
      unesco_name: 'Synthetic Party Name',
      heritage_site_count: 1,
      intangible_element_count: 0,
      biosphere_reserve_count: 0,
      geopark_count: 0,
    });
  });

  it('attributes all four datasets', async () => {
    const hub = useHub();
    const { out } = await list({ topic: 'countries' });
    expect(out.sources.map((s) => s.dataset)).toEqual(['whc001', 'ich001', 'mab001', 'eg0001']);
    expect(out.sources.every((s) => s.data_as_of === DATA_AS_OF)).toBe(true);
    expect(hub.callsFor('eg0001', 'export')).toHaveLength(1);
  });

  it('still lists countries from the other datasets when the World Heritage dataset is empty', async () => {
    useHub({ rows: { whc001: [] } });
    const { out } = await list({ topic: 'countries' });
    const codes = out.countries?.map((c) => c.code);
    expect(codes).toContain('FR');
    expect(out.countries?.find((c) => c.code === 'FR')?.heritage_site_count).toBe(0);
    expect(out.countries?.some((c) => c.code === undefined)).toBe(false);
  });
});

describe('unesco_list_reference — regions, lists, networks, datasets', () => {
  beforeEach(() => {
    useHub();
  });

  it('counts sites and reserves per region with the region codes', async () => {
    const { out } = await list({ topic: 'regions' });
    expect(out.regions).toEqual([
      { name: 'Africa', code: 'AFR', heritage_site_count: 1, biosphere_reserve_count: 0 },
      { name: 'Arab States', code: 'ARB', heritage_site_count: 1, biosphere_reserve_count: 0 },
      {
        name: 'Asia and the Pacific',
        code: 'APA',
        heritage_site_count: 1,
        biosphere_reserve_count: 0,
      },
      {
        name: 'Europe and North America',
        code: 'EUR',
        heritage_site_count: 35,
        biosphere_reserve_count: 3,
      },
      {
        name: 'Latin America and the Caribbean',
        code: 'LAC',
        heritage_site_count: 1,
        biosphere_reserve_count: 1,
      },
    ]);
  });

  it('attributes the World Heritage and biosphere datasets for regions, and not the intangible one', async () => {
    const hub = useHub();
    const { out } = await list({ topic: 'regions' });
    expect(out.sources.map((s) => s.dataset)).toEqual(['whc001', 'mab001']);
    expect(hub.callsFor('ich001')).toHaveLength(0);
  });

  it('counts the elements on each intangible list with its acronym', async () => {
    const { out } = await list({ topic: 'intangible_lists' });
    expect(out.intangible_lists).toEqual([
      { name: 'Representative List', acronym: 'RL', element_count: 1 },
      { name: 'Urgent Safeguarding List', acronym: 'USL', element_count: 1 },
      { name: 'Register of Good Safeguarding Practices', acronym: 'Art18', element_count: 1 },
    ]);
    expect(out.sources.map((s) => s.dataset)).toEqual(['ich001']);
  });

  it('counts reserves per MAB network and adds the no-network row without an acronym', async () => {
    const { out } = await list({ topic: 'biosphere_networks' });
    expect(out.biosphere_networks).toHaveLength(8);
    const euro = out.biosphere_networks?.find((n) => n.acronym === 'EuroMAB');
    expect(euro).toMatchObject({
      name: 'Europe and North America Biosphere Reserve Network (EuroMAB)',
      reserve_count: 3,
    });
    const none = out.biosphere_networks?.at(-1);
    expect(none).toEqual({ name: 'No regional network', reserve_count: 1 });
    expect(none).not.toHaveProperty('acronym');
    const others = out.biosphere_networks?.filter(
      (n) => n.acronym !== 'EuroMAB' && n.acronym !== undefined,
    );
    expect(others?.every((n) => n.reserve_count === 0)).toBe(true);
    expect(out.sources.map((s) => s.dataset)).toEqual(['mab001']);
  });

  it('reports each dataset with its record count, license, date, attribution, and notes', async () => {
    const { out } = await list({ topic: 'datasets' });
    expect(out.datasets?.map((d) => [d.dataset, d.records])).toEqual([
      ['whc001', 39],
      ['ich001', 3],
      ['mab001', 4],
      ['eg0001', EG_ROWS.length],
    ]);
    for (const d of out.datasets ?? []) {
      expect(d).toMatchObject({
        license: 'CC BY-SA 4.0',
        license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
        data_as_of: DATA_AS_OF,
      });
      expect(d.attribution).toContain(d.dataset);
      expect(d.coverage_notes?.length).toBeGreaterThan(0);
    }
    const [whc, ich] = out.datasets ?? [];
    expect(whc?.coverage_notes?.[0]).toContain('(2 sites)');
    expect(ich?.coverage_notes?.[0]).toBe(
      'The 1 element dated 2008 carries the year of incorporation into the Representative List, not the earlier proclamation.',
    );
  });

  it('reports the geopark dataset with its title, attribution, and coverage notes', async () => {
    const { out } = await list({ topic: 'datasets' });
    const eg = out.datasets?.find((d) => d.dataset === 'eg0001');
    expect(eg).toEqual({
      dataset: 'eg0001',
      title: 'UNESCO Global Geoparks',
      available: true,
      records: 5,
      data_as_of: DATA_AS_OF,
      license: 'CC BY-SA 4.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      attribution: 'UNESCO — UNESCO Global Geoparks (eg0001), UNESCO Data Hub, CC BY-SA 4.0',
      coverage_notes: [
        'The 2 geoparks dated 2015 carry the year UNESCO created the UNESCO Global Geopark designation, not the year each joined the Global Geoparks Network, which the data does not record.',
        'Areas and populations are passed through as recorded; population is absent where UNESCO records no figure, and 0 can mean unreported.',
        'Images are omitted, because the dataset records no image credit.',
      ],
    });
    expect(out.sources.map((s) => s.dataset)).toEqual(['whc001', 'ich001', 'mab001', 'eg0001']);
  });

  it('counts the 2015-dated geoparks from the loaded snapshot, singular for one', async () => {
    useHub({
      rows: {
        eg0001: [
          egRow({ ugg_id: 'EUFR01', date: '2015-01-01' }),
          egRow({ ugg_id: 'EUFR02', date: '2016-01-01' }),
        ],
      },
    });
    const { out } = await list({ topic: 'datasets' });
    const eg = out.datasets?.find((d) => d.dataset === 'eg0001');
    expect(eg?.records).toBe(2);
    expect(eg?.coverage_notes?.[0]).toBe(
      'The 1 geopark dated 2015 carries the year UNESCO created the UNESCO Global Geopark designation, not the year it joined the Global Geoparks Network, which the data does not record.',
    );
  });

  it('reports an empty geopark dataset as zero records with its notes', async () => {
    useHub({ rows: { eg0001: [] } });
    const { out } = await list({ topic: 'datasets' });
    const eg = out.datasets?.find((d) => d.dataset === 'eg0001');
    expect(eg?.records).toBe(0);
    expect(eg?.coverage_notes?.[0]).toMatch(/^The 0 geoparks dated 2015 carry /);
  });
});

describe('unesco_list_reference — filter', () => {
  beforeEach(() => {
    useHub();
  });

  it('keeps entries containing a matching word', async () => {
    const { out } = await list({ topic: 'countries', filter: 'germany' });
    expect(out.countries?.map((c) => c.code)).toEqual(['DE']);
  });

  it('matches a word prefix, ignoring case and accents', async () => {
    const { out } = await list({ topic: 'countries', filter: 'GERM' });
    expect(out.countries?.map((c) => c.code)).toEqual(['DE']);
    const accented = await list({ topic: 'criteria', filter: 'MASTERPIÉCE' });
    expect(accented.out.criteria?.map((c) => c.code)).toEqual(['i']);
    const plain = await list({ topic: 'criteria', filter: 'Masterpiece' });
    expect(plain.out.criteria?.map((c) => c.code)).toEqual(['i']);
  });

  it('matches across columns: the ISO code, the alpha-3, and the name together', async () => {
    const { out } = await list({ topic: 'countries', filter: 'fr fra france' });
    expect(out.countries?.map((c) => c.code)).toEqual(['FR']);
    const byAlpha3 = await list({ topic: 'countries', filter: 'deu' });
    expect(byAlpha3.out.countries?.map((c) => c.code)).toEqual(['DE']);
  });

  it('requires every word to match', async () => {
    const { out } = await list({ topic: 'countries', filter: 'germany france' });
    expect(out.countries).toEqual([]);
  });

  it('filters the other topics by name and code', async () => {
    expect(
      (await list({ topic: 'regions', filter: 'eur' })).out.regions?.map((r) => r.code),
    ).toEqual(['EUR']);
    expect(
      (await list({ topic: 'intangible_lists', filter: 'urgent' })).out.intangible_lists?.map(
        (l) => l.acronym,
      ),
    ).toEqual(['USL']);
    expect(
      (await list({ topic: 'biosphere_networks', filter: 'euromab' })).out.biosphere_networks?.map(
        (n) => n.acronym,
      ),
    ).toEqual(['EuroMAB']);
    expect(
      (await list({ topic: 'datasets', filter: 'whc001' })).out.datasets?.map((d) => d.dataset),
    ).toEqual(['whc001']);
    expect(
      (await list({ topic: 'datasets', filter: 'geoparks' })).out.datasets?.map((d) => d.dataset),
    ).toEqual(['eg0001']);
    expect(
      (await list({ topic: 'countries', filter: 'italy' })).out.countries?.map((c) => [
        c.code,
        c.geopark_count,
      ]),
    ).toEqual([['IT', 1]]);
  });

  it.each(['', '   '])('reads a blank filter %j as unset', async (filter) => {
    const { out } = await list({ topic: 'criteria', filter });
    expect(out.criteria).toHaveLength(10);
    expect(out.notice).toBeUndefined();
  });

  it('trims the filter', async () => {
    const { out } = await list({ topic: 'countries', filter: '  germany  ' });
    expect(out.countries).toHaveLength(1);
  });

  it('reports a notice and an empty list when nothing matches, on the zero-result page', async () => {
    const { out, text } = await list({ topic: 'countries', filter: 'nomatchword' });
    expect(out.countries).toEqual([]);
    expect(out.notice).toBe(
      'No countries entry contains every word of "nomatchword". Call unesco_list_reference with topic countries and no filter to see every entry.',
    );
    expect(out.sources).toHaveLength(4);
    expect(text).toContain('_No entries._');
    expect(text).toContain(out.notice as string);
  });

  it('flattens line breaks in the echoed filter', async () => {
    const { out } = await list({ topic: 'regions', filter: 'no\nmatch' });
    expect(out.notice).toContain('every word of "no match"');
    expect(out.notice).not.toMatch(/[\r\n]/);
  });

  it('returns a partial page with no notice when the filter matches some entries', async () => {
    const { out } = await list({ topic: 'countries', filter: 'p' });
    expect(out.countries?.length).toBeGreaterThan(0);
    expect(out.countries?.length).toBeLessThan(9);
    expect(out.notice).toBeUndefined();
    expect(out.sources).toHaveLength(4);
  });

  it('gives each topic its own notice wording', async () => {
    for (const topic of [
      'criteria',
      'regions',
      'intangible_lists',
      'biosphere_networks',
      'datasets',
    ]) {
      const { out } = await list({ topic, filter: 'nomatchword' });
      expect(out.notice, topic).toContain(`No ${topic} entry contains every word`);
      expect(out.notice, topic).toContain(`topic ${topic} and no filter`);
    }
  });
});

describe('unesco_list_reference — countries filter: codes and alternate names', () => {
  const EXTRA_CODES = ['UA', 'GB', 'TR', 'CZ', 'CI', 'SZ', 'TL', 'NL', 'CD', 'CG'];

  beforeEach(() => {
    useHub({
      rows: {
        ich001: [
          ...ICH_ROWS,
          ...EXTRA_CODES.map((code, i) =>
            ichRow({
              ich_public_ref: String(5001 + i),
              countries: [code],
              http_url_en: `https://ich.unesco.org/en/RL/0${5001 + i}`,
            }),
          ),
        ],
      },
    });
  });

  it.each([
    ['UK', 'GB'],
    ['uk', 'GB'],
    [' Uk ', 'GB'],
    ['gbr', 'GB'],
    ['GB', 'GB'],
    ['UA', 'UA'],
    ['ukr', 'UA'],
    ['fra', 'FR'],
  ])(
    'reads the code-shaped filter %j exactly as a country input reads it (%s)',
    async (filter, code) => {
      const { out } = await list({ topic: 'countries', filter });
      expect(out.countries?.map((c) => c.code)).toEqual([code]);
    },
  );

  it('says an assigned code that no dataset lists is a real code with no records', async () => {
    const { out } = await list({ topic: 'countries', filter: 'aq' });
    expect(out.countries).toEqual([]);
    expect(out.notice).toBe(
      'AQ (Antarctica) is an assigned ISO 3166-1 code, but no UNESCO dataset lists that country.',
    );
  });

  it('keeps a code that only a transnational geopark carries', async () => {
    useHub({
      rows: {
        eg0001: [egRow({ ugg_id: 'EUA301', countries: ['HU,SK'], transnational: 'True' })],
      },
    });
    const { out } = await list({ topic: 'countries', filter: 'svk' });
    expect(out.countries).toEqual([
      expect.objectContaining({ code: 'SK', heritage_site_count: 0, geopark_count: 1 }),
    ]);
    expect(out.notice).toBeUndefined();
  });

  it('keeps word-prefix matching for a short filter that is not an assigned code', async () => {
    const { out } = await list({ topic: 'countries', filter: 'ger' });
    expect(out.countries?.map((c) => c.code)).toEqual(['DE']);
  });

  it.each([
    ['Turkey', 'TR'],
    ['Czech Republic', 'CZ'],
    ['Ivory Coast', 'CI'],
    ['Swaziland', 'SZ'],
    ['East Timor', 'TL'],
    ['Holland', 'NL'],
    ['DR Congo', 'CD'],
    ['Republic of the Congo', 'CG'],
    ['england', 'GB'],
  ])('resolves the former or everyday name %j to %s', async (filter, code) => {
    const { out } = await list({ topic: 'countries', filter });
    expect(out.countries?.map((c) => c.code)).toEqual([code]);
  });
});

describe('unesco_list_reference — input validation', () => {
  beforeEach(() => {
    useHub();
  });

  it.each([
    ['an unknown topic', { topic: 'sites' }],
    ['a missing topic', {}],
    ['a blank topic', { topic: '' }],
    ['a filter over 100 characters', { topic: 'criteria', filter: 'a'.repeat(101) }],
    ['a filter object', { topic: 'criteria', filter: { text: 'x' } }],
  ])('rejects %s as invalid arguments', async (_label, input) => {
    const error = errorOf(await runToolContract(listReferenceTool, input as never));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it('accepts a filter of exactly 100 characters', async () => {
    const { out } = await list({ topic: 'criteria', filter: 'a'.repeat(100) });
    expect(out.criteria).toEqual([]);
    expect(out.notice).toBeDefined();
  });
});

describe('unesco_list_reference — declared errors and dataset independence', () => {
  it('answers countries without the intangible counts when that dataset is down', async () => {
    useHub(NO_ICH);
    const { out, text } = await list({ topic: 'countries' });
    expect(out.countries?.map((c) => c.name)).toEqual([
      'Ethiopia',
      'France',
      'Germany',
      'Italy',
      'Japan',
      'Peru',
      'Poland',
      'Synthetic Party Name',
    ]);
    for (const c of out.countries ?? []) expect(c).not.toHaveProperty('intangible_element_count');
    expect(out.countries?.find((c) => c.code === 'FR')).toEqual({
      code: 'FR',
      alpha3: 'FRA',
      name: 'France',
      unesco_name: 'France',
      heritage_site_count: 32,
      biosphere_reserve_count: 1,
      geopark_count: 1,
    });
    expect(out.sources.map((s) => s.dataset)).toEqual(['whc001', 'mab001', 'eg0001']);
    expect(out.notice).toBe(
      'The Intangible Heritage List (ich001) could not be loaded from the UNESCO Data Hub, so this answer leaves out its counts and any country only it lists.',
    );
    expect(text).toContain('| FR | FRA | France | France | 32 | Not available | 1 | 1 |');
    expect(text).toContain(out.notice as string);
  });

  it.each(['intangible_lists'])(
    'fails topic %s when the intangible dataset is down',
    async (topic) => {
      useHub(NO_ICH);
      const error = errorOf(await runToolContract(listReferenceTool, { topic } as never));
      expect(error.data?.reason).toBe('snapshot_unavailable');
    },
  );

  it.each(['criteria', 'regions', 'biosphere_networks'])(
    'still serves topic %s when the intangible dataset is down',
    async (topic) => {
      useHub(NO_ICH);
      const { out } = await list({ topic });
      expect(out.topic).toBe(topic);
      expect(out.sources.every((s) => s.dataset !== 'ich001')).toBe(true);
    },
  );

  it('answers topic countries without the geopark counts or a geopark-only country when that dataset cannot load', async () => {
    useHub(NO_EG);
    const { out, text } = await list({ topic: 'countries' });
    expect(out.countries?.map((c) => c.code)).not.toContain('IT');
    expect(out.countries).toHaveLength(8);
    for (const c of out.countries ?? []) {
      expect(c).not.toHaveProperty('geopark_count');
      expect(c).toHaveProperty('heritage_site_count');
    }
    expect(out.sources.map((s) => s.dataset)).toEqual(['whc001', 'ich001', 'mab001']);
    expect(out.notice).toBe(
      'The UNESCO Global Geoparks (eg0001) could not be loaded from the UNESCO Data Hub, so this answer leaves out its counts and any country only it lists.',
    );
    expect(text).toContain('| DE | DEU | Germany | Germany | 3 | 0 | 1 | Not available |');
    expect(text).not.toContain('Source: UNESCO — UNESCO Global Geoparks (eg0001)');
  });

  it('answers topic datasets with the geopark row unavailable when that dataset cannot load', async () => {
    useHub(NO_EG);
    const { out, text } = await list({ topic: 'datasets' });
    expect(out.datasets?.map((d) => [d.dataset, d.available])).toEqual([
      ['whc001', true],
      ['ich001', true],
      ['mab001', true],
      ['eg0001', false],
    ]);
    expect(out.datasets?.at(-1)).toStrictEqual({
      dataset: 'eg0001',
      title: 'UNESCO Global Geoparks',
      available: false,
      retryable: true,
      license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      attribution: 'UNESCO — UNESCO Global Geoparks (eg0001), UNESCO Data Hub, CC BY-SA 4.0',
    });
    expect(out.notice).toBe(
      'The UNESCO Global Geoparks (eg0001) could not be loaded from the UNESCO Data Hub, so its row reports available: false.',
    );
    expect(text).toContain(
      '| eg0001 | UNESCO Global Geoparks | No, retryable | Not available | Not available | Not available | https://creativecommons.org/licenses/by-sa/4.0/ | UNESCO — UNESCO Global Geoparks (eg0001), UNESCO Data Hub, CC BY-SA 4.0 |',
    );
    expect(text).not.toContain('**Coverage notes — eg0001:**');
    expect(text).toContain('**Coverage notes — mab001:**');
  });

  it.each(['criteria', 'regions', 'intangible_lists', 'biosphere_networks'])(
    'serves topic %s without reading the geopark dataset, even while it is down',
    async (topic) => {
      const hub = useHub(NO_EG);
      const { out } = await list({ topic });
      expect(out.topic).toBe(topic);
      expect(out.sources.every((s) => s.dataset !== 'eg0001')).toBe(true);
      expect(hub.callsFor('eg0001')).toHaveLength(0);
    },
  );

  it('names the failing dataset when the World Heritage dataset is down', async () => {
    useHub({ intercept: (call) => (call.dataset === 'whc001' ? httpFailure(404) : undefined) });
    const error = errorOf(await runToolContract(listReferenceTool, { topic: 'criteria' }));
    expect(error.data).toMatchObject({ reason: 'snapshot_unavailable', dataset: 'whc001' });
  });

  it('answers topic datasets with the intangible row unavailable when the handler is called directly', async () => {
    useHub(NO_ICH);
    const result = await listReferenceTool.handler(
      listReferenceTool.input.parse({ topic: 'datasets' }),
      createMockContext({ errors: listReferenceTool.errors }),
    );
    expect(result.datasets?.find((d) => d.dataset === 'ich001')).toStrictEqual({
      dataset: 'ich001',
      title: 'Intangible Heritage List',
      available: false,
      retryable: true,
      license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      attribution: 'UNESCO — Intangible Heritage List (ich001), UNESCO Data Hub, CC BY-SA 4.0',
    });
  });

  it('carries the declared reason on a thrown error when the handler is called directly', async () => {
    useHub(NO_ICH);
    await expect(
      listReferenceTool.handler(
        listReferenceTool.input.parse({ topic: 'intangible_lists' }),
        createMockContext({ errors: listReferenceTool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'snapshot_unavailable', dataset: 'ich001' },
    });
  });
});

/** Fails the loads of `datasets` with `failure`; the others load from the fixtures. */
const failing = (datasets: readonly DatasetId[], failure: () => Response): HubOptions => ({
  intercept: (call) => (datasets.includes(call.dataset) ? failure() : undefined),
});

/** A load failure a retry may fix, and one it cannot. */
const CAUSES = [
  ['a retryable failure', transientFailure, true],
  ['a non-retryable failure', () => httpFailure(404), false],
] as const;

const TWO_DOWN =
  'The World Heritage List (whc001) and the Intangible Heritage List (ich001) could not be loaded from the UNESCO Data Hub, so';

describe('unesco_list_reference — partial answers while datasets cannot load', () => {
  it('advertises every count, record, date, license, and note field as optional, and available as required', () => {
    const schema = z.toJSONSchema(listReferenceTool.output) as {
      properties: Record<string, { items: { required: string[]; properties: object } }>;
    };
    const required = (arm: string) => schema.properties[arm]?.items.required;
    expect(required('countries')).toEqual(['name']);
    expect(required('regions')).toEqual(['name', 'code']);
    expect(required('datasets')).toEqual([
      'dataset',
      'title',
      'available',
      'license_url',
      'attribution',
    ]);
    expect(schema.properties.datasets?.items.properties).toMatchObject({
      available: { type: 'boolean' },
      retryable: { type: 'boolean' },
    });
  });

  it.each(CAUSES)(
    'answers topic countries from the datasets that loaded after %s',
    async (_label, failure) => {
      useHub(failing(['whc001', 'ich001'], failure));
      const { out, text } = await list({ topic: 'countries' });
      expect(out.countries).toEqual([
        {
          code: 'FR',
          alpha3: 'FRA',
          name: 'France',
          unesco_name: 'France',
          biosphere_reserve_count: 1,
          geopark_count: 1,
        },
        {
          code: 'DE',
          alpha3: 'DEU',
          name: 'Germany',
          unesco_name: 'Germany',
          biosphere_reserve_count: 1,
          geopark_count: 1,
        },
        { code: 'IT', alpha3: 'ITA', name: 'Italy', biosphere_reserve_count: 0, geopark_count: 1 },
        { code: 'JP', alpha3: 'JPN', name: 'Japan', biosphere_reserve_count: 0, geopark_count: 1 },
        {
          code: 'PE',
          alpha3: 'PER',
          name: 'Peru',
          unesco_name: 'Peru',
          biosphere_reserve_count: 1,
          geopark_count: 1,
        },
        {
          code: 'PL',
          alpha3: 'POL',
          name: 'Poland',
          unesco_name: 'Poland',
          biosphere_reserve_count: 1,
          geopark_count: 1,
        },
      ]);
      expect(out.sources.map((s) => s.dataset)).toEqual(['mab001', 'eg0001']);
      expect(out.notice).toBe(
        `${TWO_DOWN} this answer leaves out their counts and any country only they list.`,
      );
      expect(text).toContain(
        '| FR | FRA | France | France | Not available | Not available | 1 | 1 |',
      );
      expect(text).toContain('| IT | ITA | Italy | — | Not available | Not available | 0 | 1 |');
      expect(text).not.toMatch(/\| [0-9]+ \| [0-9]+ \| [0-9]+ \| [0-9]+ \|/);
      expect(text).toContain(out.notice as string);
      expect(text).not.toContain('Source: UNESCO — World Heritage List');
      expect(text).not.toContain('Source: UNESCO — Intangible Heritage List');
    },
  );

  it.each(CAUSES)(
    'answers topic regions from the biosphere dataset after %s',
    async (_label, failure) => {
      const hub = useHub(failing(['whc001', 'ich001'], failure));
      const { out, text } = await list({ topic: 'regions' });
      expect(out.regions).toEqual([
        { name: 'Africa', code: 'AFR', biosphere_reserve_count: 0 },
        { name: 'Arab States', code: 'ARB', biosphere_reserve_count: 0 },
        { name: 'Asia and the Pacific', code: 'APA', biosphere_reserve_count: 0 },
        { name: 'Europe and North America', code: 'EUR', biosphere_reserve_count: 3 },
        { name: 'Latin America and the Caribbean', code: 'LAC', biosphere_reserve_count: 1 },
      ]);
      expect(out.sources.map((s) => s.dataset)).toEqual(['mab001']);
      expect(out.notice).toBe(
        'The World Heritage List (whc001) could not be loaded from the UNESCO Data Hub, so this answer leaves out its counts.',
      );
      expect(text).toContain('| Europe and North America | EUR | Not available | 3 |');
      expect(hub.callsFor('ich001')).toHaveLength(0);
    },
  );

  it.each(CAUSES)(
    'reports both unavailable datasets on topic datasets after %s',
    async (_label, failure, retryable) => {
      useHub(failing(['whc001', 'ich001'], failure));
      const { out, text } = await list({ topic: 'datasets' });
      const [whc, ich, mab, eg] = out.datasets ?? [];
      expect(whc).toStrictEqual({
        dataset: 'whc001',
        title: 'World Heritage List',
        available: false,
        retryable,
        license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
        attribution: 'UNESCO — World Heritage List (whc001), UNESCO Data Hub, CC BY-SA 4.0',
      });
      expect(ich).toMatchObject({ dataset: 'ich001', available: false, retryable });
      for (const field of ['records', 'data_as_of', 'license', 'coverage_notes']) {
        expect(ich).not.toHaveProperty(field);
      }
      expect(mab).toMatchObject({ dataset: 'mab001', available: true, records: 4 });
      expect(eg).toMatchObject({ dataset: 'eg0001', available: true, records: EG_ROWS.length });
      expect(mab).not.toHaveProperty('retryable');
      expect(out.sources.map((s) => s.dataset)).toEqual(['mab001', 'eg0001']);
      expect(out.notice).toBe(`${TWO_DOWN} their rows report available: false.`);
      const status = retryable ? 'No, retryable' : 'No, not retryable';
      expect(text).toContain(
        `| whc001 | World Heritage List | ${status} | Not available | Not available | Not available |`,
      );
      expect(text).toContain(`| ich001 | Intangible Heritage List | ${status} |`);
      expect(text).toContain(`| mab001 | Man and the Biosphere Programme | Yes | 4 |`);
      expect(text).not.toContain('**Coverage notes — whc001:**');
      expect(text).not.toContain('**Coverage notes — ich001:**');
      expect(text).toContain('**Coverage notes — eg0001:**');
    },
  );

  it('joins three unavailable datasets in one notice', async () => {
    useHub(failing(['whc001', 'ich001', 'mab001'], transientFailure));
    const { out } = await list({ topic: 'countries' });
    expect(out.notice).toBe(
      'The World Heritage List (whc001), the Intangible Heritage List (ich001), and the Man and the Biosphere Programme (mab001) could not be loaded from the UNESCO Data Hub, so this answer leaves out their counts and any country only they list.',
    );
    expect(out.countries?.map((c) => [c.code, c.geopark_count])).toEqual([
      ['FR', 1],
      ['DE', 1],
      ['IT', 1],
      ['JP', 1],
      ['PE', 1],
      ['PL', 1],
    ]);
    expect(out.sources.map((s) => s.dataset)).toEqual(['eg0001']);
  });

  it.each([
    ['a name', 'germany', 'DE'],
    ['an alpha-2 code', 'de', 'DE'],
    ['an alpha-3 code', 'pol', 'PL'],
    ['an everyday name', 'Holland', 'NL'],
  ])(
    'resolves %s that a loaded dataset lists, with only the unavailable-dataset notice',
    async (_label, filter, code) => {
      useHub({
        ...failing(['whc001', 'ich001'], transientFailure),
        rows: { eg0001: [...EG_ROWS, egRow({ ugg_id: 'EUNL01', countries: ['NL'] })] },
      });
      const { out } = await list({ topic: 'countries', filter });
      expect(out.countries?.map((c) => c.code)).toEqual([code]);
      expect(out.countries?.[0]).not.toHaveProperty('heritage_site_count');
      expect(out.notice).toBe(
        `${TWO_DOWN} this answer leaves out their counts and any country only they list.`,
      );
    },
  );

  it('never says no UNESCO dataset lists an assigned code that only an unavailable dataset lists', async () => {
    useHub(failing(['whc001', 'ich001'], transientFailure));
    const { out, text } = await list({ topic: 'countries', filter: 'et' });
    expect(out.countries).toEqual([]);
    expect(out.notice).toBe(
      `${TWO_DOWN} this answer leaves out their counts and any country only they list. ET (Ethiopia) is an assigned ISO 3166-1 code, but none of the UNESCO datasets that loaded lists that country.`,
    );
    expect(out.notice).not.toContain('no UNESCO dataset lists');
    expect(text).toContain('_No entries._');
  });

  it('puts the unavailable-dataset fragment ahead of the filter fragment when nothing matches', async () => {
    useHub(failing(['whc001', 'ich001'], transientFailure));
    const { out } = await list({ topic: 'countries', filter: 'ethiopia' });
    expect(out.countries).toEqual([]);
    expect(out.notice).toBe(
      `${TWO_DOWN} this answer leaves out their counts and any country only they list. No countries entry contains every word of "ethiopia". Call unesco_list_reference with topic countries and no filter to see every entry.`,
    );
    const regions = await list({ topic: 'regions', filter: 'nomatchword' });
    expect(regions.out.notice).toBe(
      'The World Heritage List (whc001) could not be loaded from the UNESCO Data Hub, so this answer leaves out its counts. No regions entry contains every word of "nomatchword". Call unesco_list_reference with topic regions and no filter to see every entry.',
    );
  });

  it.each([
    ['unesco_search_sites', searchSitesTool, 'whc001', 'heritage_site_count'],
    [
      'unesco_search_intangible_heritage',
      searchIntangibleHeritageTool,
      'ich001',
      'intangible_element_count',
    ],
    [
      'unesco_search_biosphere_reserves',
      searchBiosphereReservesTool,
      'mab001',
      'biosphere_reserve_count',
    ],
    ['unesco_search_geoparks', searchGeoparksTool, 'eg0001', 'geopark_count'],
  ] as const)(
    "follows %s's unknown_country recovery to a code while every other dataset is down",
    async (_name, tool, dataset, column) => {
      useHub(
        failing(
          DATASET_IDS.filter((d) => d !== dataset),
          transientFailure,
        ),
      );
      const search = tool as unknown as typeof searchSitesTool;
      const rejected = errorOf(await runToolContract(search, { country: 'France' }));
      expect(rejected.data?.reason).toBe('unknown_country');
      expect(rejected.data?.recovery?.hint).toContain(
        'unesco_list_reference with topic countries and filter set to the country name',
      );
      const { out } = await list({ topic: 'countries', filter: 'France' });
      expect(out.countries).toEqual([
        expect.objectContaining({ code: 'FR', [column]: expect.any(Number) }),
      ]);
      expect(out.sources.map((s) => s.dataset)).toEqual([dataset]);
      const retried = await runToolContract(search, { country: out.countries?.[0]?.code });
      expect(retried.isError, allText(retried)).not.toBe(true);
    },
  );
});

/** Each dataset's getter on the accessor's service, called with a fresh context. */
const LOAD: Record<DatasetId, (svc: UnescoDataHubService) => Promise<unknown>> = {
  whc001: (svc) => svc.getHeritage(createMockContext()),
  ich001: (svc) => svc.getIntangible(createMockContext()),
  mab001: (svc) => svc.getBiosphere(createMockContext()),
  eg0001: (svc) => svc.getGeoparks(createMockContext()),
};

describe('unesco_list_reference — cancellation and unexpected failures', () => {
  it.each(['countries', 'datasets'])(
    "rejects topic %s with the caller's abort when it lands mid-load, though the other datasets loaded",
    async (topic) => {
      const controller = new AbortController();
      const inFlight = new Set<DatasetId>();
      useHub({
        intercept: (call) => {
          if (call.dataset !== 'whc001' && call.dataset !== 'ich001') return;
          inFlight.add(call.dataset);
          // Both loads under test are in flight: the caller gives up.
          if (inFlight.size === 2) controller.abort();
          return new Promise<Response>((resolve) => {
            if (controller.signal.aborted) resolve(transientFailure());
            else controller.signal.addEventListener('abort', () => resolve(transientFailure()));
          });
        },
      });
      const svc = getUnescoDataHubService();
      await LOAD.mab001(svc);
      await LOAD.eg0001(svc);
      await expect(
        listReferenceTool.handler(
          listReferenceTool.input.parse({ topic }),
          createMockContext({ errors: listReferenceTool.errors, signal: controller.signal }),
        ),
      ).rejects.toBe(controller.signal.reason);
      expect([...inFlight].sort()).toEqual(['ich001', 'whc001']);
    },
  );

  it('rejects with an already-aborted signal while a failed dataset waits out its backoff', async () => {
    useHub(failing(['whc001'], transientFailure));
    const svc = getUnescoDataHubService();
    await Promise.all([LOAD.ich001(svc), LOAD.mab001(svc), LOAD.eg0001(svc)]);
    await expect(LOAD.whc001(svc)).rejects.toMatchObject({
      data: { reason: 'snapshot_unavailable', dataset: 'whc001' },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      listReferenceTool.handler(
        listReferenceTool.input.parse({ topic: 'countries' }),
        createMockContext({ errors: listReferenceTool.errors, signal: controller.signal }),
      ),
    ).rejects.toBe(controller.signal.reason);
  });

  it('rejects unchanged with a load failure that is not snapshot_unavailable, never a partial answer', async () => {
    useHub(failing(['whc001'], transientFailure));
    const boom = new Error('synthetic loader bug');
    vi.spyOn(getUnescoDataHubService(), 'getIntangible').mockRejectedValue(boom);
    await expect(
      listReferenceTool.handler(
        listReferenceTool.input.parse({ topic: 'countries' }),
        createMockContext({ errors: listReferenceTool.errors }),
      ),
    ).rejects.toBe(boom);
  });
});

/**
 * Every dataset of a topic fails, each with its own cause. `pivot` fails after
 * every other load has settled (`last`) or before any other fails (`first`); a
 * call that names `pivot` both ways follows neither the first nor the last
 * failure to arrive.
 */
async function everyDatasetFails(
  topic: string,
  causes: Partial<Record<DatasetId, () => Response>>,
  pivot: DatasetId,
  when: 'first' | 'last',
) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = (dataset: DatasetId) => (when === 'last') === (dataset === pivot);
  useHub({
    intercept: async (call) => {
      if (held(call.dataset)) await gate;
      return causes[call.dataset]?.();
    },
  });
  const pending = runToolContract(listReferenceTool, { topic } as never);
  const svc = getUnescoDataHubService();
  const early = (Object.keys(causes) as DatasetId[]).filter((d) => !held(d));
  await Promise.allSettled(early.map((d) => LOAD[d](svc)));
  release();
  return errorOf(await pending);
}

const ARRIVALS = [
  ['countries', 'last'],
  ['countries', 'first'],
  ['datasets', 'last'],
  ['datasets', 'first'],
] as const;

describe('unesco_list_reference — every dataset a topic reads fails', () => {
  it.each(ARRIVALS)(
    'fails topic %s with the first retryable failure in topic order, though it failed %s',
    async (topic, when) => {
      const error = await everyDatasetFails(
        topic,
        {
          whc001: () => httpFailure(404),
          ich001: transientFailure,
          mab001: transientFailure,
          eg0001: () => httpFailure(404),
        },
        'ich001',
        when,
      );
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'snapshot_unavailable',
        dataset: 'ich001',
        retryable: true,
        retryAfter: 60,
        recovery: { hint: declaredRecovery(listReferenceTool.errors, 'snapshot_unavailable') },
      });
    },
  );

  it.each(ARRIVALS)(
    'fails topic %s with the first failure in topic order when none is retryable, though it failed %s',
    async (topic, when) => {
      const notFound = () => httpFailure(404);
      const error = await everyDatasetFails(
        topic,
        { whc001: notFound, ich001: notFound, mab001: notFound, eg0001: notFound },
        'whc001',
        when,
      );
      expectContentFailure(
        error,
        'whc001',
        declaredRecovery(listReferenceTool.errors, 'snapshot_unavailable'),
      );
    },
  );

  it.each(['last', 'first'] as const)(
    'fails topic regions with the World Heritage failure, though it arrived %s',
    async (when) => {
      const error = await everyDatasetFails(
        'regions',
        { whc001: transientFailure, mab001: transientFailure },
        'whc001',
        when,
      );
      expect(error.data).toMatchObject({
        reason: 'snapshot_unavailable',
        dataset: 'whc001',
        retryable: true,
      });
    },
  );
});

describe('unesco_list_reference — upstream failure classes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(transportFailureCases('whc001', WHC_ROWS.length))(
    'reports %s as retryable snapshot_unavailable with the declared recovery',
    async (_label, intercept) => {
      withFakeTimers();
      useHub({ intercept });
      const error = errorOf(
        await settle(runToolContract(listReferenceTool, { topic: 'criteria' })),
      );
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'snapshot_unavailable',
        retryable: true,
        dataset: 'whc001',
        recovery: { hint: declaredRecovery(listReferenceTool.errors, 'snapshot_unavailable') },
      });
    },
  );

  it.each(contentFailureCases('whc001'))(
    'reports %s as non-retryable snapshot_unavailable with the service recovery',
    async (_label, hub) => {
      useHub(hub);
      const result = await runToolContract(listReferenceTool, { topic: 'criteria' });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expectContentFailure(
        error,
        'whc001',
        declaredRecovery(listReferenceTool.errors, 'snapshot_unavailable'),
      );
      expect(allText(result)).toContain(`Recovery: ${error.data?.recovery?.hint}`);
    },
  );

  it('reports a license change as snapshot_unavailable, and the dataset as unavailable and not retryable', async () => {
    useHub({ metas: { ich001: { license: 'All rights reserved' } } });
    const error = errorOf(await runToolContract(listReferenceTool, { topic: 'intangible_lists' }));
    expect(error.data).toMatchObject({
      reason: 'snapshot_unavailable',
      dataset: 'ich001',
      retryable: false,
    });
    const { out } = await list({ topic: 'datasets' });
    expect(out.datasets?.find((d) => d.dataset === 'ich001')).toMatchObject({
      available: false,
      retryable: false,
    });
    expect(JSON.stringify(out)).not.toContain('All rights reserved');
  });

  it('reports a schema-invalid row as snapshot_unavailable, and answers regions without its counts', async () => {
    useHub({ rows: { whc001: [whcRow({ region: 'Atlantis' })] } });
    const error = errorOf(await runToolContract(listReferenceTool, { topic: 'criteria' }));
    expect(error.data?.reason).toBe('snapshot_unavailable');
    const { out } = await list({ topic: 'regions' });
    expect(out.regions?.every((r) => r.heritage_site_count === undefined)).toBe(true);
    expect(out.regions).toHaveLength(5);
  });
});

describe('unesco_list_reference — format() parity and text safety', () => {
  beforeEach(() => {
    useHub();
  });

  it('renders a criteria table carrying every structured field', async () => {
    const { result, out } = await list({ topic: 'criteria' });
    const body = textBlocks(result)[0] ?? '';
    expect(body).toContain('## UNESCO reference: criteria');
    expect(body).toContain('| Code | Group | Meaning | Sites | Inferred |');
    for (const c of out.criteria ?? []) {
      expect(body).toContain(
        `| (${c.code}) | ${c.group} | ${c.meaning} | ${c.site_count} | ${c.inferred_count} |`,
      );
    }
  });

  it('renders every country row, with the no-code and no-spelling fallbacks', async () => {
    const { result, out } = await list({ topic: 'countries' });
    const body = textBlocks(result)[0] ?? '';
    expect(body).toContain(
      '| Code | Alpha-3 | Name | UNESCO name | World Heritage sites | Intangible elements | Biosphere reserves | Geoparks |',
    );
    for (const c of out.countries ?? []) {
      expect(body).toContain(
        `| ${c.code ?? 'No ISO code'} | ${c.alpha3 ?? '—'} | ${c.name} | ${c.unesco_name ?? '—'} | ${c.heritage_site_count} | ${c.intangible_element_count} | ${c.biosphere_reserve_count} | ${c.geopark_count} |`,
      );
    }
    expect(body).toContain('| BE | BEL | Belgium | — | 0 | 1 | 0 | 0 |');
    expect(body).toContain('| IT | ITA | Italy | — | 0 | 0 | 0 | 1 |');
    expect(body).toContain(
      '| No ISO code | — | Synthetic Party Name | Synthetic Party Name | 1 | 0 | 0 | 0 |',
    );
  });

  it('renders regions, lists, and networks with their codes and counts', async () => {
    const regions = (await list({ topic: 'regions' })).text;
    expect(regions).toContain('| Europe and North America | EUR | 35 | 3 |');
    const lists = (await list({ topic: 'intangible_lists' })).text;
    expect(lists).toContain('| Urgent Safeguarding List | USL | 1 |');
    const networks = (await list({ topic: 'biosphere_networks' })).text;
    expect(networks).toContain(
      '| Europe and North America Biosphere Reserve Network (EuroMAB) | EuroMAB | 3 |',
    );
    expect(networks).toContain('| No regional network | — | 1 |');
  });

  it('renders the dataset table and every coverage note', async () => {
    const { out, text } = await list({ topic: 'datasets' });
    for (const d of out.datasets ?? []) {
      expect(text).toContain(
        `| ${d.dataset} | ${d.title} | Yes | ${d.records} | ${d.data_as_of} |`,
      );
      expect(text).toContain(`**Coverage notes — ${d.dataset}:**`);
      expect(d.coverage_notes?.length).toBeGreaterThan(0);
      for (const note of d.coverage_notes ?? []) expect(text).toContain(`- ${note}`);
    }
  });

  it('closes with one source line per attributed dataset', async () => {
    const { text } = await list({ topic: 'countries' });
    for (const dataset of ['whc001', 'ich001', 'mab001', 'eg0001']) {
      expect(text).toContain(`(${dataset}), data as of ${DATA_AS_OF}, CC BY-SA 4.0`);
    }
    expect(text).toContain(
      `Source: UNESCO — UNESCO Global Geoparks (eg0001), data as of ${DATA_AS_OF}, CC BY-SA 4.0`,
    );
  });

  it('advertises every dataset id in the sources enum', () => {
    const sources = listReferenceTool.enrichment?.sources;
    expect(sources).toBeDefined();
    expect(z.toJSONSchema(sources as z.ZodType)).toMatchObject({
      items: { properties: { dataset: { enum: [...DATASET_IDS] } } },
    });
    expect(DATASET_IDS).toContain('eg0001');
  });

  it('keeps a code-less State Party name with a pipe and line breaks inside one table cell', async () => {
    useHub({
      rows: {
        whc001: [
          whcRow({
            id_no: '920',
            states_names: ['Party | One\r\n# Two\\Three'],
            iso_codes: null,
          }),
        ],
      },
    });
    const { text } = await list({ topic: 'countries' });
    const rows = text.split('\n').filter((line) => line.includes('Party'));
    expect(rows).toHaveLength(1);
    const row = rows[0] as string;
    expect(row).toContain('Party \\| One # Two\\\\Three');
    const cells = row.split(/(?<!\\)\|/);
    expect(cells).toHaveLength(10);
    expect(text.split('\n').some((l) => l.startsWith('# Two'))).toBe(false);
  });

  it('never emits raw line-break characters inside a table row', async () => {
    const nel = String.fromCodePoint(0x85);
    const lineSep = String.fromCodePoint(0x2028);
    useHub({
      rows: {
        whc001: [
          whcRow({
            id_no: '921',
            states_names: [`Row${nel}Break${lineSep}Name`],
            iso_codes: null,
          }),
        ],
      },
    });
    const { text } = await list({ topic: 'countries' });
    expect(text).not.toContain(nel);
    expect(text).not.toContain(lineSep);
    expect(text).toContain('| Row Break Name |');
  });

  it('renders _No entries._ for an empty topic table', async () => {
    const { text } = await list({ topic: 'criteria', filter: 'nomatchword' });
    expect(text).toContain('## UNESCO reference: criteria\n\n_No entries._');
  });

  it('serves the same data on the default fixture set as the structured rows', async () => {
    const { out, text } = await list({ topic: 'countries' });
    expect((out.countries ?? []).length).toBe(
      text.split('\n').filter((l) => /^\| .* \|$/.test(l)).length - 2,
    );
    expect(WHC_ROWS.length).toBe(39);
  });
});
