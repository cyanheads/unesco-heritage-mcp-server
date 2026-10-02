#!/usr/bin/env node
/**
 * @fileoverview unesco-heritage-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { SERVER_INSTRUCTIONS } from './mcp-server/instructions.js';
import { biosphereReserveResource } from './mcp-server/resources/definitions/biosphere-reserve.resource.js';
import { geoparkResource } from './mcp-server/resources/definitions/geopark.resource.js';
import { intangibleHeritageElementResource } from './mcp-server/resources/definitions/intangible-heritage-element.resource.js';
import { siteResource } from './mcp-server/resources/definitions/site.resource.js';
import { getBiosphereReserveTool } from './mcp-server/tools/definitions/get-biosphere-reserve.tool.js';
import { getGeoparkTool } from './mcp-server/tools/definitions/get-geopark.tool.js';
import { getIntangibleHeritageElementTool } from './mcp-server/tools/definitions/get-intangible-heritage-element.tool.js';
import { getSiteTool } from './mcp-server/tools/definitions/get-site.tool.js';
import { listReferenceTool } from './mcp-server/tools/definitions/list-reference.tool.js';
import { searchBiosphereReservesTool } from './mcp-server/tools/definitions/search-biosphere-reserves.tool.js';
import { searchGeoparksTool } from './mcp-server/tools/definitions/search-geoparks.tool.js';
import { searchIntangibleHeritageTool } from './mcp-server/tools/definitions/search-intangible-heritage.tool.js';
import { searchSitesTool } from './mcp-server/tools/definitions/search-sites.tool.js';
import {
  getUnescoDataHubService,
  initUnescoDataHubService,
} from './services/unesco-datahub/unesco-datahub-service.js';

await createApp({
  name: 'unesco-heritage-mcp-server',
  title: 'unesco-heritage-mcp-server',
  instructions: SERVER_INSTRUCTIONS,
  tools: [
    searchSitesTool,
    getSiteTool,
    searchIntangibleHeritageTool,
    getIntangibleHeritageElementTool,
    searchBiosphereReservesTool,
    getBiosphereReserveTool,
    searchGeoparksTool,
    getGeoparkTool,
    listReferenceTool,
  ],
  resources: [
    siteResource,
    intangibleHeritageElementResource,
    biosphereReserveResource,
    geoparkResource,
  ],
  setup() {
    initUnescoDataHubService();
  },
  teardown() {
    getUnescoDataHubService().dispose();
  },
});
