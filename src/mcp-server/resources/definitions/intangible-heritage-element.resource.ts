/**
 * @fileoverview unesco://intangible-heritage/{ich_ref} — one intangible
 * heritage element record: the unesco_get_intangible_heritage_element payload
 * plus the `sources` attribution block.
 * @module mcp-server/resources/definitions/intangible-heritage-element.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ichRefInput } from '@/mcp-server/shared/inputs.js';
import { buildElementRecord } from '@/services/unesco-datahub/records.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';

export const intangibleHeritageElementResource = resource(
  'unesco://intangible-heritage/{ich_ref}',
  {
    name: 'unesco_intangible_heritage_element',
    title: 'Intangible heritage element record',
    description:
      "One Intangible Cultural Heritage element's full record by ich_ref, as unesco_get_intangible_heritage_element returns it, plus a sources array carrying the dataset date, license, and UNESCO attribution.",
    mimeType: 'application/json',
    cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
    params: z.object({
      ich_ref: ichRefInput("The element's ich_ref, from unesco_search_intangible_heritage."),
    }),
    errors: [
      {
        reason: 'element_not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'No record carries this ich_ref',
        recovery:
          "Find the element's ich_ref with unesco_search_intangible_heritage (search by name), then read unesco://intangible-heritage/{ich_ref} with it or call unesco_get_intangible_heritage_element.",
      },
      {
        reason: 'snapshot_unavailable',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'No intangible heritage snapshot has loaded yet and the Data Hub is unreachable',
        retryable: true,
        thrownBy: 'service',
        recovery:
          'The UNESCO Data Hub could not be reached to load the Intangible Heritage List; wait until the next load attempt this error names (retryAfter, in seconds), then read the resource again.',
      },
    ],

    async handler(params, ctx) {
      const intangible = await getUnescoDataHubService().getIntangible(ctx);
      const element = intangible.byId.get(params.ich_ref);
      if (!element) {
        throw ctx.fail(
          'element_not_found',
          `No intangible heritage element has ich_ref ${params.ich_ref}.`,
          { ich_ref: params.ich_ref },
        );
      }
      return { ...buildElementRecord(element), sources: [sourceOf(intangible)] };
    },
  },
);
