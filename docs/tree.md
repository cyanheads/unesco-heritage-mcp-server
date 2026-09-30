# unesco-heritage-mcp-server - Directory Structure

Generated on: 2026-09-30 04:10:40

```text
unesco-heritage-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── biosphere-reserve.resource.ts
│   │   │       ├── intangible-heritage-element.resource.ts
│   │   │       └── site.resource.ts
│   │   ├── shared/
│   │   │   ├── enrichment.ts
│   │   │   ├── inputs.ts
│   │   │   └── markdown.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── get-biosphere-reserve.tool.ts
│   │           ├── get-intangible-heritage-element.tool.ts
│   │           ├── get-site.tool.ts
│   │           ├── list-reference.tool.ts
│   │           ├── search-biosphere-reserves.tool.ts
│   │           ├── search-intangible-heritage.tool.ts
│   │           └── search-sites.tool.ts
│   ├── services/
│   │   └── unesco-datahub/
│   │       ├── iso3166.ts
│   │       ├── records.ts
│   │       ├── rows.ts
│   │       ├── search.ts
│   │       ├── types.ts
│   │       ├── unesco-datahub-service.ts
│   │       └── vocabulary.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── contract.ts
│   │   ├── failures.ts
│   │   ├── hub.ts
│   │   ├── paging.ts
│   │   ├── resource.ts
│   │   ├── rows.ts
│   │   └── tool.ts
│   ├── fuzz/
│   ├── integration/
│   ├── prompts/
│   ├── resources/
│   │   ├── biosphere-reserve.resource.test.ts
│   │   ├── intangible-heritage-element.resource.test.ts
│   │   └── site.resource.test.ts
│   ├── services/
│   │   └── unesco-datahub/
│   │       ├── iso3166.test.ts
│   │       ├── records-element-reserve.test.ts
│   │       ├── records.test.ts
│   │       ├── rows.test.ts
│   │       ├── search.test.ts
│   │       └── unesco-datahub-service.test.ts
│   ├── shared/
│   │   ├── enrichment.test.ts
│   │   ├── inputs.test.ts
│   │   ├── mab-id-input.test.ts
│   │   └── markdown.test.ts
│   ├── smoke/
│   └── tools/
│       ├── get-biosphere-reserve.tool.test.ts
│       ├── get-intangible-heritage-element.tool.test.ts
│       ├── get-site.tool.test.ts
│       ├── list-reference.tool.test.ts
│       ├── search-biosphere-reserves.tool.test.ts
│       ├── search-intangible-heritage.tool.test.ts
│       └── search-sites.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
