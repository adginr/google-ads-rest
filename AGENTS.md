# AGENTS.md

Guide for coding agents and contributors working in this repository.

## Map

```
packages/rest   @adginr/google-ads-rest   client + generated types + agent tools (no MCP, no framework)
  src/client.ts          GoogleAdsClient: OAuth refresh, search, mutate, keyword ideas, field metadata.
                         The only file that talks HTTP to Google.
  src/api-version.ts     GOOGLE_ADS_API_VERSION, used by the client and by codegen.
  src/types/*.gen.ts     Generated from the REST discovery document. Never edit; run `pnpm codegen`.
  src/gaql.ts            GAQL escaping, condition guard, query builder.
  src/resource-names.ts  Resource name builders and parsers.
  src/tools/             Agent tools, grouped by entity; index.ts is the registry (`adsTools`).
  scripts/codegen.ts     discovery document → src/types/*.gen.ts and src/gaql-resources.gen.ts
packages/mcp    @adginr/google-ads-mcp    MCP server, CLI (stdio / HTTP / auth), doc resources
```

Dependency direction: `mcp → rest`. `rest` must not import MCP, SvelteKit or any AI framework.

## Adding a tool

1. Add it to the matching file in `packages/rest/src/tools/` (or a new `<entity>.ts`) with `defineTool()`.
2. Register it in `tools/index.ts` (`adsTools` and the named exports).
3. Add tests in `packages/rest/test/` using `fakeApi()`, and update the MCP snapshot
   (`pnpm vitest run -u`), reviewing the diff.
4. Add a changeset (`pnpm changeset`) and a row in `packages/mcp/README.md`.

## Tool conventions

- **Descriptions are prompts**: what it does, when to use it instead of another tool, what it returns, risks.
- **Inputs**: camelCase. `customerId` from `schemas.customerId`; IDs with `entityId()`; closed sets with
  `upperEnum()`; text with `text()` / `optionalText()` (lengths in code points); money with `money()` in
  currency units (never ask the model for micros); booleans are never coerced.
- **Validate everything before the first request.** Tests assert no request is made for bad input.
- **Mutations**: take `validateOnly`, return `null` resource names on a dry run with the same keys otherwise.
  New entities default to PAUSED. Use `remove` operations for removal (REMOVED is not settable by update).
  Mark removals `destructive: true`.
- **GAQL**: never interpolate free text without `gaqlString()`; only validated IDs and enums go in raw.
- **Output**: an object (wrap lists), numbers as numbers, money in currency units, `null` for missing.
- **Errors**: throw. Adapters turn errors into tool results the model can read.

## Code conventions

- TypeScript with erasable syntax only (no enums, namespaces, parameter properties): Node runs the sources
  directly. Relative imports use `.ts` extensions.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` must pass. Comments and commits in English.
- Never commit credentials (`.env`, `client_secret_*.json`).
