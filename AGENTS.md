# Developer Protocol

**Server:** unesco-heritage-mcp-server
**Version:** 0.1.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.10`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.1.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

> **Read the design next:** `docs/design.md` records the tool surface, the shared input conventions, the snapshot lifecycle, the upstream data quirks the loader repairs, and the numbered design decisions. Update it when the surface or a decision changes.

---

## Domain

Seven read-only tools and three resources over three UNESCO Data Hub datasets (`data.unesco.org`, Explore API v2.1), all keyless and CC BY-SA 4.0:

| Dataset | Content | Record key | Tools |
|:--------|:--------|:-----------|:------|
| `whc001` | World Heritage List | `id_no` | `unesco_search_sites`, `unesco_get_site` |
| `ich001` | Intangible Cultural Heritage lists | `ich_ref` | `unesco_search_intangible_heritage`, `unesco_get_intangible_heritage_element` |
| `mab001` | World Network of Biosphere Reserves | `mab_id` | `unesco_search_biosphere_reserves`, `unesco_get_biosphere_reserve` |

`unesco_list_reference` decodes the vocabulary (criteria, countries, regions, intangible lists, MAB networks) and reports dataset coverage. Each resource (`unesco://site/{id_no}`, `unesco://intangible-heritage/{ich_ref}`, `unesco://biosphere-reserve/{mab_id}`) mirrors a get tool. There are no prompts.

`UnescoDataHubService` loads each dataset lazily as an in-memory snapshot (one metadata GET plus one `exports/json` GET), refreshes it after 24 h with stale-while-revalidate, and keeps the previous snapshot when a refresh fails. Every tool call is answered from the snapshot: filtering, keyword tiers, facets, and distance search are local. There are no server-specific environment variables: the TTL, deadlines, and pacer limits are constants.

Conventions every definition follows:

- **Attribution first.** Every data tool declares the required `sources` enrichment field (`sourcesField` from `src/mcp-server/shared/enrichment.ts`) and writes it before any branch; resources embed `sources` in the JSON payload.
- **Upstream text is data.** Names, descriptions, and statements of Outstanding Universal Value go through `inline()` / `quote()` / `quoted()` / `cell()` from `src/mcp-server/shared/markdown.ts` before interpolation in `format()`, and upstream URLs through `bareUrl()`. Never interpolate raw upstream text.
- **Inputs come from `src/mcp-server/shared/inputs.ts`.** Every optional scalar is wrapped in `blankAsUnset`; country, region, year, query, pagination, `near`, and record-id inputs use the shared builders so normalization stays identical across tools.
- **No fabrication.** Missing coordinates, areas, and images render as `Not available`; MAB areas and populations pass through as recorded; criterion (vi) is marked inferred wherever it appears.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Abridged from `src/mcp-server/tools/definitions/get-intangible-heritage-element.tool.ts`:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderSources, sourcesField } from '@/mcp-server/shared/enrichment.js';
import { ichRefInput } from '@/mcp-server/shared/inputs.js';
import { inline, quoted } from '@/mcp-server/shared/markdown.js';
import { buildElementRecord } from '@/services/unesco-datahub/records.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';

export const getIntangibleHeritageElementTool = tool('unesco_get_intangible_heritage_element', {
  title: 'Get intangible heritage element',
  description: "Fetch one Intangible Cultural Heritage element's full record by ich_ref: …",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ich_ref: ichRefInput("The element's ich_ref, from unesco_search_intangible_heritage. …"),
  }),
  output: z.object({
    ich_ref: z.string().describe('Intangible heritage element reference (ich_ref).'),
    name: z.string().describe('English name.'),
    description: z.string().describe("UNESCO's description of the element."),
    // … list, countries, concepts, world_heritage_sites, url, image
  }),
  enrichment: { sources: sourcesField },
  enrichmentTrailer: { sources: { render: renderSources } },
  errors: [
    {
      reason: 'element_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record carries this ich_ref',
      severity: 'notice',
      recovery:
        "Find the element's ich_ref with unesco_search_intangible_heritage (search by name), then call unesco_get_intangible_heritage_element again.",
    },
    {
      reason: 'snapshot_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No intangible heritage snapshot has loaded yet and the Data Hub is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery: 'The UNESCO Data Hub could not be reached to load the Intangible Heritage List; wait until …',
    },
  ],

  async handler(input, ctx) {
    const intangible = await getUnescoDataHubService().getIntangible(ctx);
    ctx.enrich({ sources: [sourceOf(intangible)] }); // attribution first, before any branch
    const element = intangible.byId.get(input.ich_ref);
    if (!element) {
      throw ctx.fail(
        'element_not_found',
        `No intangible heritage element has ich_ref ${input.ich_ref}.`,
        { ich_ref: input.ich_ref },
      );
    }
    ctx.log.info('Intangible heritage element fetched', { ich_ref: element.ich_ref });
    return buildElementRecord(element);
  },

  // format() is the content[] twin of structuredContent: every output field appears,
  // and upstream text is flattened (inline) or blockquoted (quoted), never interpolated raw.
  format: (r) => [{
    type: 'text',
    text: [`## ${inline(r.name)} (ich_ref ${r.ich_ref})`, '', quoted('Description', r.description)].join('\n'),
  }],
});
```

The search tools add the page enrichment (`pageEnrichment`: `totalCount`, `truncated`, `shown`, `cap`, `notice`) plus `applied_filters` and `facets`, compose the zero-hit and continuation notice with `composePageNotice`, and page with `makeCursor` / `readCursor`, whose fingerprint ties a cursor to its filters, sort, and snapshot date. `docs/design.md` § Shared enrichment gives the write order.

### Resource

Abridged from `src/mcp-server/resources/definitions/site.resource.ts`. A resource reuses its get tool's record builder and embeds `sources`, since resources carry no enrichment block:

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { idNoInput } from '@/mcp-server/shared/inputs.js';
import { buildSiteRecord } from '@/services/unesco-datahub/records.js';
import {
  getUnescoDataHubService,
  sourceOf,
} from '@/services/unesco-datahub/unesco-datahub-service.js';

export const siteResource = resource('unesco://site/{id_no}', {
  name: 'unesco_site',
  title: 'World Heritage site record',
  description: "One World Heritage site's full record by id_no, as unesco_get_site returns it …",
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
    // … snapshot_unavailable
  ],

  async handler(params, ctx) {
    const heritage = await getUnescoDataHubService().getHeritage(ctx);
    const site = heritage.byId.get(params.id_no);
    if (!site) {
      throw ctx.fail('site_not_found', `No World Heritage site has id_no ${params.id_no}.`, {
        id_no: params.id_no,
      });
    }
    return { ...buildSiteRecord(site, 20), sources: [sourceOf(heritage)] };
  },
});
```

### Server config

None. The server reads no environment variables of its own and has no `src/config/`. Snapshot TTL, load deadlines, retry policy, and pacer limits are constants in `UnescoDataHubService`; its constructor options (`get`, `now`, `ttlMs`) exist for tests. If a server-specific variable is ever added, follow the `api-config` skill (`parseEnvConfig`, and `z.stringbool()` for booleans) and add it to `.env.example`, `server.json`, `manifest.json`, and both plugin manifests together.

### Server identity, instructions, and lifecycle

`src/index.ts` (imports and instructions abridged):

```ts
await createApp({
  name: 'unesco-heritage-mcp-server',
  title: 'unesco-heritage-mcp-server',
  instructions: 'Three UNESCO datasets from the UNESCO Data Hub (data.unesco.org), read-only and keyless: …',
  tools: [searchSitesTool, getSiteTool, /* … */ listReferenceTool],
  resources: [siteResource, intangibleHeritageElementResource, biosphereReserveResource],
  setup() {
    initUnescoDataHubService();
  },
  teardown() {
    getUnescoDataHubService().dispose();
  },
});
```

Identity is `name` + `title`, both the unscoped package name (`lint:packaging` enforces the match); `description` comes from `package.json`. `instructions` (kept under 2,048 characters) carries the cross-tool workflow, so update it with the tool names whenever the surface changes. `teardown()` disposes the service's pacer.

No tool calls `ctx.requestInput`, so `createApp()` declares no `sessionMode`; `.env.example` and the Dockerfile set `MCP_SESSION_MODE=stateless`.

---

## Context

Handlers receive a unified `ctx` object. The properties this server uses:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.enrich` | Success-path agent context — `ctx.enrich(...)` or `.notice()` / `.total()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). Carries `sources` on every data tool, plus the page fields, `applied_filters`, and `facets` on the search tools. |
| `ctx.fail` | Throws a declared error-contract entry by `reason` (see Errors). |
| `ctx.signal` | `AbortSignal` for cancellation. The service races a shared snapshot load against it, so a cancelled caller stops waiting without aborting the load. |
| `ctx.requestId` | Request ID — the one every log record of the call carries and its error envelope returns as `data.requestId`. |

No handler uses `ctx.state`, `ctx.requestInput`, `ctx.inputs`, or `ctx.content`: the snapshots live in the service, not in tenant storage. Read the `api-context` skill before adding any of them.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point, server instructions, service lifecycle
  services/
    unesco-datahub/
      unesco-datahub-service.ts         # Snapshot lifecycle per dataset: load, TTL, single-flight, backoff, pacer
      rows.ts                           # Strict export-row schemas + edge parsers (text cleanup, criteria, components)
      records.ts                        # Full-record builders shared by the get tools and resources
      search.ts                         # Folding, word-prefix tiers, filters, facets, haversine, sorts, cursors
      iso3166.ts                        # ISO 3166-1 alpha-2 ↔ alpha-3 table, country normalizer, display names
      vocabulary.ts                     # Regions, categories, criteria, lists, MAB networks, titles, license
      types.ts                          # Domain and snapshot types
  mcp-server/
    shared/
      inputs.ts                         # blankAsUnset + shared input builders and record-id normalizers
      enrichment.ts                     # sources field/trailer, page enrichment, composed page notice
      markdown.ts                       # inline / cell / quote / quoted / bareUrl for upstream text in format()
    tools/definitions/                  # 7 tool definitions (*.tool.ts)
    resources/definitions/              # 3 resource definitions (*.resource.ts)
tests/
  fixtures/                             # Synthetic Data Hub rows + test harness helpers
  services/ shared/ tools/ resources/   # Tests mirroring src/
docs/
  design.md                             # Surface, conventions, lifecycle, data quirks, decisions
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-sites.tool.ts` |
| Tool names | snake_case, `unesco_` prefix, verb first | `unesco_search_sites` |
| Resource names | snake_case, `unesco_` prefix; URIs under `unesco://` | `unesco_site` → `unesco://site/{id_no}` |
| Input and output fields | snake_case | `inscribed_from`, `data_as_of` |
| Directories | kebab-case | `src/services/unesco-datahub/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search the UNESCO World Heritage List by keyword, …'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with coverage |
| `bun run start` | Run the built server (`node dist/index.js`, transport from the environment) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create the GitHub Release from an annotated tag and attach the `.mcpb` bundle |
| `bun run publish-mcp` | Log in to the MCP Registry and publish `server.json` (used by `release-and-publish`) |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. A server using DataCanvas therefore ships a portable bundle without the DuckDB native — `@duckdb/node-api` is an optional peer loaded lazily, so canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging; no `ctx.state` (snapshots live in the service)
- [ ] Handlers throw on failure — `ctx.fail` against a declared `errors[]` entry, or error factories; no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Every data tool declares `sources` and writes it first; resources embed `sources` in the payload
- [ ] Upstream text reaches `format()` only through `inline` / `cell` / `quote` / `quoted` (`src/mcp-server/shared/markdown.ts`)
- [ ] Inputs built from `src/mcp-server/shared/inputs.ts`; every optional scalar is blank-as-unset
- [ ] New export fields: added to the strict row schema in `rows.ts` and the export `select` list, reviewed against real upstream sparsity/nullability, never fabricated when missing
- [ ] Tests run on synthetic fixtures in `tests/fixtures/`, including at least one sparse row with omitted upstream fields
- [ ] Registered in the `createApp()` arrays in `src/index.ts`; server `instructions` updated when a tool name or workflow changes
- [ ] `docs/design.md` updated when the surface or a design decision changes
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `npm run devcheck` passes
