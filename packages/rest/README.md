# @adginr/google-ads-rest

Typed Google Ads API client for Node.js over REST, plus ready-made tools for AI agents.

- `fetch` and OAuth only: no gRPC, no protobuf runtime, no developer token.
- Types for all of Google Ads API v26, generated from Google's REST discovery document.
- One atomic `mutate()` for every resource type, GAQL `search()` with pagination, readable errors.
- 30 agent tools with zod schemas, usable from MCP, TanStack AI, the Vercel AI SDK or plain code.

```bash
npm install @adginr/google-ads-rest
```

Requires Node.js 22 or newer.

## Credentials

You need an OAuth client and a refresh token with the `https://www.googleapis.com/auth/adwords` scope:

1. In [Google Cloud Console → Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients),
   create a client of type **Desktop app** in a project with the Google Ads API enabled.
2. Get a refresh token, for example with `npx @adginr/google-ads-mcp auth client_secret.json`, which runs the
   sign-in and writes everything to `.env`.

| Variable                       | Required | Meaning                                                         |
| ------------------------------ | -------- | --------------------------------------------------------------- |
| `GOOGLE_ADS_CLIENT_ID`         | yes      | OAuth client ID                                                 |
| `GOOGLE_ADS_CLIENT_SECRET`     | yes      | OAuth client secret                                             |
| `GOOGLE_ADS_REFRESH_TOKEN`     | yes      | Refresh token of the Google user                                |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | no       | Manager (MCC) account used to reach client accounts; dashes ok. |

Google retired developer tokens on 2026-09-09: API access now comes from the Cloud project that owns the
OAuth client.

## Client

```ts
import { GoogleAdsClient, resourceNames, type services } from '@adginr/google-ads-rest';

const ads = GoogleAdsClient.fromEnv(); // or new GoogleAdsClient({ clientId, clientSecret, refreshToken })

// GAQL, all pages up to maxRows (default 10 000). Rows are typed as services.GoogleAdsRow.
const rows = await ads.search(
  '1234567890',
  `SELECT campaign.id, campaign.name, metrics.cost_micros
	 FROM campaign WHERE segments.date DURING LAST_30_DAYS`
);
rows[0]?.campaign?.name;

// Atomic mutate across resource types (GoogleAdsService.Mutate). validateOnly makes it a dry run.
const operations: services.MutateOperation[] = [
  {
    campaignOperation: {
      update: { resourceName: resourceNames.campaign('1234567890', '987'), status: 'PAUSED' },
      updateMask: 'status'
    }
  }
];
await ads.mutate('1234567890', operations, { validateOnly: true });

await ads.listAccessibleCustomers(); // ['customers/1234567890', …]
await ads.generateKeywordIdeas('1234567890', { keywordSeed: { keywords: ['car lease'] } });
await ads.searchFields("SELECT name, selectable WHERE name LIKE 'campaign.%'");
```

REST returns int64 values (IDs, metrics, `*Micros`) as strings and omits fields that hold their default
value (`0`, `false`, `''`). Money is in micros: divide by 1 000 000.

### Errors

Every failure is a `GoogleAdsError`. Its message leads with Google's specific error codes rather than the
generic "invalid argument":

```
Google Ads API 400 INVALID_ARGUMENT: queryError.UNRECOGNIZED_FIELD: Unrecognized field in the query: 'campaign.nope'.
```

`error.errors` holds each entry (`code`, `message`, `field`, `trigger`), and `error.requestId` is the ID to
quote to Google support.

### Types

```ts
import type { common, resources, services } from '@adginr/google-ads-rest';

const keyword: common.KeywordInfo = { text: 'car lease', matchType: 'EXACT' };
type Status = NonNullable<resources.Campaign['status']>; // 'ENABLED' | 'PAUSED' | 'REMOVED' | …
```

Types are generated from the [discovery document](https://googleads.googleapis.com/$discovery/rest?version=v26)
and erased at build time, so they cost nothing at runtime. `GAQL_RESOURCES` lists every resource that can follow
`FROM`.

### GAQL helpers

```ts
import { buildGaql, gaqlString, unsafeConditionReason } from '@adginr/google-ads-rest';

const query = buildGaql({
  fields: ['ad_group_criterion.keyword.text'],
  resource: 'ad_group_criterion',
  conditions: [`ad_group_criterion.keyword.text = ${gaqlString(userInput)}`], // escaped literal
  limit: 100
});
```

Never interpolate free text into GAQL without `gaqlString`. `unsafeConditionReason` rejects conditions that
would rewrite the query (clause keywords, comments, `;` outside quotes).

## Agent tools

`@adginr/google-ads-rest/tools` exports `adsTools`: each tool has a `name`, a description written for the model,
zod `input` and `output` schemas, annotations (`readOnly`, `destructive`, `idempotent`) and
`run(input, { ads })`.

```ts
import { GoogleAdsClient } from '@adginr/google-ads-rest';
import { adsTools, readOnlyAdsTools } from '@adginr/google-ads-rest/tools';

const ads = GoogleAdsClient.fromEnv();
const tool = adsTools.find((t) => t.name === 'list_campaigns')!;
const result = await tool.run(tool.input.parse({ customerId: '123-456-7890' }), { ads });
```

With TanStack AI:

```ts
import { toolDefinition } from '@tanstack/ai';

const tools = adsTools.map((tool) =>
  toolDefinition({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input,
    outputSchema: tool.output,
    needsApproval: !tool.annotations.readOnly // ask the user before any change
  }).server((input) => tool.run(input, { ads }))
);
```

With the Vercel AI SDK:

```ts
import { tool as aiTool } from 'ai';

const tools = Object.fromEntries(
  adsTools.map((t) => [
    t.name,
    aiTool({
      description: t.description,
      inputSchema: t.input,
      execute: (input) => t.run(input, { ads })
    })
  ])
);
```

Always parse input through `tool.input` before `run`: the schemas normalize what is safe to normalize
(dashes in customer IDs, enum case, whitespace) and reject the rest with messages the model can act on.

The full tool list is in the [MCP server README](../mcp#tools). Write your own with `defineTool()`.

## License

Apache-2.0. Not affiliated with Google.
