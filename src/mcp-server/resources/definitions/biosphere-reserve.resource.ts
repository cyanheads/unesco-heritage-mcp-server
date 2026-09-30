/**
 * @fileoverview unesco://biosphere-reserve/{mab_id} — one biosphere reserve
 * record: the unesco_get_biosphere_reserve payload plus the `sources`
 * attribution block. Non-ASCII ids arrive percent-encoded in the URI and are
 * decoded and NFC-normalized by the shared mab_id schema before lookup.
 * @module mcp-server/resources/definitions/biosphere-reserve.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { mabIdInput } from '@/mcp-server/shared/inputs.js';
import { inline } from '@/mcp-server/shared/markdown.js';
import { buildReserveRecord } from '@/services/unesco-datahub/records.js';
import { foldText } from '@/services/unesco-datahub/search.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';

export const biosphereReserveResource = resource('unesco://biosphere-reserve/{mab_id}', {
  name: 'unesco_biosphere_reserve',
  title: 'Biosphere reserve record',
  description:
    "One biosphere reserve's full record by mab_id, as unesco_get_biosphere_reserve returns it, plus a sources array carrying the dataset date, license, and UNESCO attribution.",
  mimeType: 'application/json',
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  params: z.object({
    mab_id: mabIdInput(
      "The reserve's mab_id, from unesco_search_biosphere_reserves; percent-encoded when it holds non-ASCII letters. Case and accents are ignored.",
    ),
  }),
  errors: [
    {
      reason: 'biosphere_reserve_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record carries this mab_id, after folding case and diacritics',
      recovery:
        "Find the reserve's mab_id with unesco_search_biosphere_reserves (search by name), then read unesco://biosphere-reserve/{mab_id} with it or call unesco_get_biosphere_reserve.",
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No MAB snapshot has loaded yet and the Data Hub is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'The UNESCO Data Hub could not be reached to load the biosphere reserve network; wait until the next load attempt this error names (retryAfter, in seconds), then read the resource again.',
    },
  ],

  async handler(params, ctx) {
    const biosphere = await getUnescoDataHubService().getBiosphere(ctx);
    const reserve = biosphere.byId.get(foldText(params.mab_id));
    if (!reserve) {
      throw ctx.fail(
        'biosphere_reserve_not_found',
        `No biosphere reserve has mab_id "${inline(params.mab_id)}".`,
        { mab_id: params.mab_id },
      );
    }
    return { ...buildReserveRecord(reserve), sources: [sourceOf(biosphere)] };
  },
});
