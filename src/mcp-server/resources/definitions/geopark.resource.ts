/**
 * @fileoverview unesco://geopark/{ugg_id} — one UNESCO Global Geopark record:
 * the unesco_get_geopark payload plus the `sources` attribution block. The id
 * is trimmed and uppercased by the shared ugg_id schema before lookup.
 * @module mcp-server/resources/definitions/geopark.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { uggIdInput } from '@/mcp-server/shared/inputs.js';
import { inline } from '@/mcp-server/shared/markdown.js';
import { buildGeoparkRecord } from '@/services/unesco-datahub/records.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';

export const geoparkResource = resource('unesco://geopark/{ugg_id}', {
  name: 'unesco_geopark',
  title: 'UNESCO Global Geopark record',
  description:
    "One UNESCO Global Geopark's full record by ugg_id, as unesco_get_geopark returns it, plus a sources array carrying the dataset date, license, and UNESCO attribution.",
  mimeType: 'application/json',
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  params: z.object({
    ugg_id: uggIdInput(
      "The geopark's ugg_id, such as EUFR10, from unesco_search_geoparks. Case is ignored.",
    ),
  }),
  errors: [
    {
      reason: 'geopark_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record carries this ugg_id, after trimming and uppercasing',
      recovery:
        "Find the geopark's ugg_id with unesco_search_geoparks (search by name), then read unesco://geopark/{ugg_id} with it or call unesco_get_geopark.",
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No geopark snapshot has loaded yet and the Data Hub is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the UNESCO Global Geoparks; wait until the next load attempt this error names (retryAfter, in seconds), then read the resource again.',
    },
  ],

  async handler(params, ctx) {
    const geoparks = await getUnescoDataHubService().getGeoparks(ctx);
    const geopark = geoparks.byId.get(params.ugg_id);
    if (!geopark) {
      throw ctx.fail(
        'geopark_not_found',
        `No UNESCO Global Geopark has ugg_id "${inline(params.ugg_id)}".`,
        { ugg_id: params.ugg_id },
      );
    }
    return { ...buildGeoparkRecord(geopark), sources: [sourceOf(geoparks)] };
  },
});
