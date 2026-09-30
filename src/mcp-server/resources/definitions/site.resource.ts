/**
 * @fileoverview unesco://site/{id_no} — one World Heritage site record: the
 * unesco_get_site payload with the default component cap, plus the `sources`
 * attribution block.
 * @module mcp-server/resources/definitions/site.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { idNoInput } from '@/mcp-server/shared/inputs.js';
import { buildSiteRecord } from '@/services/unesco-datahub/records.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';

/** The component cap the resource applies — unesco_get_site's default max_components. */
const RESOURCE_MAX_COMPONENTS = 20;

export const siteResource = resource('unesco://site/{id_no}', {
  name: 'unesco_site',
  title: 'World Heritage site record',
  description:
    "One World Heritage site's full record by id_no, as unesco_get_site returns it with up to 20 components (components_total gives the full count), plus a sources array carrying the dataset date, license, and UNESCO attribution.",
  mimeType: 'application/json',
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  params: z.object({
    id_no: idNoInput("The site's World Heritage id_no, from unesco_search_sites."),
  }),
  errors: [
    {
      reason: 'site_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record carries this id_no',
      recovery:
        "Find the site's id_no with unesco_search_sites (search by name), then read unesco://site/{id_no} with it or call unesco_get_site.",
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No World Heritage snapshot has loaded yet and the Data Hub is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the World Heritage List; wait until the next load attempt this error names (retryAfter, in seconds), then read the resource again.',
    },
  ],

  async handler(params, ctx) {
    const heritage = await getUnescoDataHubService().getHeritage(ctx);
    const site = heritage.byId.get(params.id_no);
    if (!site) {
      throw ctx.fail('site_not_found', `No World Heritage site has id_no ${params.id_no}.`, {
        id_no: params.id_no,
      });
    }
    return {
      ...buildSiteRecord(site, RESOURCE_MAX_COMPONENTS),
      sources: [sourceOf(heritage)],
    };
  },
});
