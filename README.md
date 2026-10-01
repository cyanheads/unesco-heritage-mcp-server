<div align="center">
  <h1>@cyanheads/unesco-heritage-mcp-server</h1>
  <p><b>Search UNESCO World Heritage sites, intangible heritage, and Man and the Biosphere reserves via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 3 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/unesco-heritage-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/unesco-heritage-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/unesco-heritage-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/unesco-heritage-mcp-server/releases/latest/download/unesco-heritage-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=unesco-heritage-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdW5lc2NvLWhlcml0YWdlLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22unesco-heritage-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Funesco-heritage-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Three UNESCO datasets from the UNESCO Data Hub: the World Heritage List, the Intangible Cultural Heritage lists, and the World Network of Biosphere Reserves. Search sites (the List of World Heritage in Danger included), intangible heritage elements, and biosphere reserves; read full records; find sites or reserves near a point; and turn country names into the ISO codes the filters take. Runs as a stdio process or a local Streamable HTTP server, with no API key.

### Tools

| Tool | Description |
|:---|:---|
| `unesco_search_sites` | Search World Heritage sites by keyword, country, category, region, criteria, inscription years, Danger-list or transboundary status, or distance from a point |
| `unesco_get_site` | Fetch a site's full record: statement of Outstanding Universal Value, criteria with meanings, component parts, coordinates, and image credit |
| `unesco_search_intangible_heritage` | Search the three intangible heritage lists by keyword, country, list, inscription years, multinational status, or linked World Heritage site |
| `unesco_get_intangible_heritage_element` | Fetch an element's full record: description, list, countries, concept terms, linked sites, and image credit |
| `unesco_search_biosphere_reserves` | Search biosphere reserves by keyword, country, region, MAB regional network, designation years, transboundary or SIDS status, or distance from a point |
| `unesco_get_biosphere_reserve` | Fetch a reserve's full record: ecological and socio-economic profile, zoned areas and population, review years, and coordinates |
| `unesco_list_reference` | Decode criteria, countries (name to ISO code), regions, intangible heritage lists, and MAB networks; report dataset coverage and data dates |

### Resources

| Resource | Description |
|:---|:---|
| `unesco://site/{id_no}` | One World Heritage site record |
| `unesco://intangible-heritage/{ich_ref}` | One intangible heritage element record |
| `unesco://biosphere-reserve/{mab_id}` | One biosphere reserve record |

Each resource mirrors a get tool, so tool-only clients lose nothing.

## Capability reference

### `unesco_search_sites` <sub>tool</sub>

- Filters: `query`, `country` (ISO 3166-1 alpha-2 or alpha-3), `category`, `region`, `criteria` (every listed criterion required), `in_danger`, `transboundary`, `inscribed_from` / `inscribed_to`, and `near` (`latitude`, `longitude`, `radius_km` up to 5000, default 100)
- Up to 50 sites per page (default 20), continued with `next_cursor`; `sort` takes `relevance`, `name`, `inscribed_newest`, `inscribed_oldest`, `area_largest`, `danger_listed_newest`, or `distance`
- `in_danger: true` is the List of World Heritage in Danger; `totalCount` and `facets` (category, region, Danger status, criteria, top 10 countries) cover the whole match, and rows carry `matched_in` and `distance_km` when `query` or `near` is set

---

### `unesco_get_site` <sub>tool</sub>

- One site by `id_no`: a number, a digit string, or the site's whc.unesco.org page URL; `max_components` lists 0–1000 component parts (default 20)
- Description, statement of Outstanding Universal Value, `criteria[]` with meanings and `source: "recorded" | "inferred"`, States Parties with ISO codes, coordinates, area, `secondary_years`, Danger-list year, names in six languages, and the main `image` with its credit
- `components_total` is UNESCO's count and `components_unparsed` the entries that could not be read; an unknown id fails as `site_not_found`

---

### `unesco_search_intangible_heritage` <sub>tool</sub>

- Filters: `query`, `country`, `list` (Representative List, Urgent Safeguarding List, Register of Good Safeguarding Practices; `RL` / `USL` / `Art18` accepted), `multinational`, `world_heritage_site` (an `id_no`), and `inscribed_from` / `inscribed_to`
- Up to 50 elements per page (default 20), continued with `next_cursor`; rows omit the description and carry primary `concepts` and linked `world_heritage_sites`
- `facets` cover list, multinational status, the top 10 countries, and the top 10 concept terms

---

### `unesco_get_intangible_heritage_element` <sub>tool</sub>

- One element by `ich_ref`: a number, a digit string, or the element's ich.unesco.org page URL
- Description, list, countries, inscription year, primary and secondary `concepts`, linked `world_heritage_sites`, UNESCO page, and the main `image` with its caption and credit; an unknown ref fails as `element_not_found`

---

### `unesco_search_biosphere_reserves` <sub>tool</sub>

- Filters: `query` (name, introduction, and ecological or socio-economic text; there is no biome field, so search habitat words), `country`, `region`, `regional_network` (name or acronym), `transboundary`, `sids`, `designated_from` / `designated_to`, and `near`
- Up to 50 reserves per page (default 20), continued with `next_cursor`; `sort` takes `relevance`, `name`, `designated_newest`, `designated_oldest`, `area_largest`, or `distance`
- A transboundary reserve appears once per participating country, each with its own `mab_id`; `facets` cover region, regional network, transboundary and SIDS status, and the top 10 countries

---

### `unesco_get_biosphere_reserve` <sub>tool</sub>

- One reserve by `mab_id`, matched without regard to case or accents
- Introduction, ecological and socio-economic characteristics, terrestrial and marine area by zone, population by zone, designation, extension, renaming, and periodic-review years, coordinates, website, and UNESCO page
- Areas (hectares) and populations pass through as recorded: zone sums can differ from totals, and a population of `0` can mean none or unreported; an unknown id fails as `biosphere_reserve_not_found`

---

### `unesco_list_reference` <sub>tool</sub>

- `topic`: `criteria`, `countries`, `regions`, `intangible_lists`, `biosphere_networks`, or `datasets`
- `filter` keeps matching rows; on `countries`, a country name, an ISO code, or a common former name returns the codes every `country` input accepts
- `datasets` reports each dataset's record count, `data_as_of`, license, attribution line, and coverage notes

---

### `unesco://site/{id_no}` <sub>resource</sub>

- The `unesco_get_site` record with up to 20 components (`components_total` carries the full count), plus `sources`, as `application/json`
- `id_no` comes from `unesco_search_sites`

---

### `unesco://intangible-heritage/{ich_ref}` <sub>resource</sub>

- The `unesco_get_intangible_heritage_element` record plus `sources`, as `application/json`
- `ich_ref` comes from `unesco_search_intangible_heritage`

---

### `unesco://biosphere-reserve/{mab_id}` <sub>resource</sub>

- The `unesco_get_biosphere_reserve` record plus `sources`, as `application/json`
- `mab_id` comes from `unesco_search_biosphere_reserves`; percent-encode an id that holds non-ASCII letters

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

UNESCO-specific:

- Three UNESCO Data Hub datasets: the World Heritage List (`whc001`), the Intangible Heritage List (`ich001`), and the Man and the Biosphere Programme (`mab001`)
- Each dataset loads on first use as an in-memory snapshot (two upstream requests) and refreshes every 24 hours; searching, facets, and distance run locally, and a failed refresh keeps serving the previous snapshot
- Upstream traffic is paced at two concurrent requests and at most 200 a day, with a cooldown after a 429 that honors `Retry-After`
- Criterion (vi), which UNESCO's criteria fields omit, is inferred from each site's statement of Outstanding Universal Value and marked as inferred wherever it appears
- Country inputs take ISO 3166-1 alpha-2 or alpha-3 codes in any case and match every transboundary site or multinational element a country takes part in; site and element ids also accept their UNESCO page URLs

Agent-friendly output:

- Attribution on every response: `sources` names each dataset with its `data_as_of` date, license, and credit line
- Search results report the whole match: `totalCount`, `facets`, and an `applied_filters` echo of the filters and sort the server ran
- Keyword matching is word-prefix with every word required, and `matched_in` says which field tier matched; a zero-hit `notice` names the filter whose removal would match the most records
- Typed error contracts (`unknown_country`, `invalid_year_range`, `sort_needs_input`, `cursor_mismatch`, `*_not_found`, `snapshot_unavailable` with `retryAfter`) carry a recovery hint naming the next call

## Data and licensing

All three datasets come from the [UNESCO Data Hub](https://data.unesco.org) and are licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Credit UNESCO when you reuse the data; every response's `sources` block carries a ready-made credit line. Under ShareAlike, adapted data must be shared under the same license.

Images are not covered by that license. Each World Heritage and intangible heritage image keeps its own copyright, and its holder and photographer travel with the image record. The server returns image links but never fetches or proxies them.

This server is an independent project and is not affiliated with or endorsed by UNESCO.

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "unesco-heritage-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/unesco-heritage-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "unesco-heritage-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/unesco-heritage-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "unesco-heritage-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/unesco-heritage-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account: the UNESCO Data Hub is open.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/unesco-heritage-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd unesco-heritage-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env to change the transport, port, or log level
```

## Configuration

The server has no settings of its own; these framework variables apply.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_HOST` | HTTP server host. | `127.0.0.1` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. `.env.example` and the Docker image set `stateless`. | `auto` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the common framework overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the tools and resources, sets the server instructions, and starts and stops the service. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seven tools across the three datasets. |
| `src/mcp-server/resources` | Resource definitions. One record resource per dataset. |
| `src/mcp-server/shared` | Input schemas and normalizers, enrichment fields, and markdown helpers shared by the tools and resources. |
| `src/services/unesco-datahub` | UNESCO Data Hub service: snapshot loading and refresh, row validation and repair, search and facets, the ISO 3166 table, and vocabularies. |
| `tests/` | Unit tests over synthetic fixtures, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging and `ctx.enrich` for attribution, totals, and notices
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
