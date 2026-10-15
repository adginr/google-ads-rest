# google-ads-rest

[![CI](https://github.com/adginr/google-ads-rest/actions/workflows/ci.yml/badge.svg)](https://github.com/adginr/google-ads-rest/actions/workflows/ci.yml)
[![npm: google-ads-rest](https://img.shields.io/npm/v/@adginr/google-ads-rest?label=%40adginr%2Fgoogle-ads-rest)](https://www.npmjs.com/package/@adginr/google-ads-rest)
[![npm: google-ads-mcp](https://img.shields.io/npm/v/@adginr/google-ads-mcp?label=%40adginr%2Fgoogle-ads-mcp)](https://www.npmjs.com/package/@adginr/google-ads-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Google Ads API for Node.js and AI agents, over plain REST.

- **No gRPC, no protobuf runtime, no developer token.** `fetch` plus OAuth; works anywhere Node 22+ runs.
- **Typed from Google's own discovery document.** Every resource, enum and request of API v26, exactly as it
  goes over the wire (camelCase, int64 as strings). One command regenerates it for the next API version.
- **Agent tools with guard rails.** 30 tools for GAQL reporting, keywords, ads, budgets, callouts and
  sitelinks. New things start paused, every change supports a dry run, removals are flagged as destructive.
- **An MCP server** that puts those tools into any Model Context Protocol client.

| Package                                    | What it is                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| [`@adginr/google-ads-rest`](packages/rest) | REST client, generated types, GAQL helpers and framework-agnostic agent tools.     |
| [`@adginr/google-ads-mcp`](packages/mcp)   | MCP server (stdio and Streamable HTTP) exposing the tools, plus a sign-in command. |

## Quick start

Connect an AI assistant to your Google Ads account:

```bash
npx @adginr/google-ads-mcp auth ~/Downloads/client_secret_….json   # one-time Google sign-in, writes .env
npx @adginr/google-ads-mcp                                         # stdio MCP server
```

Details, client configuration and the tool list: [packages/mcp](packages/mcp#readme).

Use the API from code:

```ts
import { GoogleAdsClient } from '@adginr/google-ads-rest';

const ads = GoogleAdsClient.fromEnv();
const rows = await ads.search(
  '1234567890',
  'SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS'
);
```

More in [packages/rest](packages/rest#readme).

## Why REST

Google ships official Google Ads client libraries for Java, .NET, PHP, Python, Ruby and Perl, all on gRPC.
There is no official Node.js library. The REST interface is a first-class equivalent of the gRPC one, needs
nothing but HTTPS and JSON, and its discovery document is precise enough to generate complete TypeScript
types from. That keeps this project small: a thin client, generated types, and the part that actually
needs care, the tools.

## Development

```bash
pnpm install
pnpm test          # unit tests with a fake API, plus an MCP end-to-end test over stdio
pnpm typecheck
pnpm lint
pnpm build
pnpm codegen       # regenerate types from the discovery document
```

The packages run from source in development (Node strips types natively), so there is no watch step.
See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and [AGENTS.md](AGENTS.md) for the codebase map.

## License

[Apache-2.0](LICENSE). Tool behaviour partly derives from
[googleads/google-ads-mcp](https://github.com/googleads/google-ads-mcp); see [NOTICE](NOTICE).

Not affiliated with or endorsed by Google. "Google Ads" is a trademark of Google LLC.
