# @adginr/google-ads-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for the Google Ads API. It lets an AI
assistant report on and manage a Google Ads account: GAQL reporting, keyword research, keywords, responsive
search ads, budgets, callouts and sitelinks.

- Runs over the Google Ads **REST** API: no gRPC, no Python, no developer token.
- **Safe by default.** New ad groups and ads start paused, every change supports `validateOnly` dry runs,
  removals are marked destructive so clients ask first, and `--read-only` hides every mutating tool.
- stdio for local clients, Streamable HTTP for everything else.

## 1. Get credentials

1. In a Google Cloud project with the **Google Ads API** enabled, open
   [Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients) and create an OAuth client
   of type **Desktop app**. Download its JSON.
2. Sign in once:

   ```bash
   npx @adginr/google-ads-mcp auth ~/Downloads/client_secret_….json
   ```

   This opens Google sign-in, then writes `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` and
   `GOOGLE_ADS_REFRESH_TOKEN` to `.env` in the current directory and lists the accounts you can reach.

3. If your accounts sit under a manager (MCC) account, add `GOOGLE_ADS_LOGIN_CUSTOMER_ID=123-456-7890` to
   `.env`.

## 2. Connect a client

The server reads `GOOGLE_ADS_*` from the environment and from `.env` in its working directory
(or `--env-file <path>`).

**Claude Code**

```bash
claude mcp add google-ads -- npx -y @adginr/google-ads-mcp --env-file /path/to/.env
```

**Claude Desktop, Cursor, Windsurf** and other clients with a JSON config:

```json
{
  "mcpServers": {
    "google-ads": {
      "command": "npx",
      "args": ["-y", "@adginr/google-ads-mcp"],
      "env": {
        "GOOGLE_ADS_CLIENT_ID": "…",
        "GOOGLE_ADS_CLIENT_SECRET": "…",
        "GOOGLE_ADS_REFRESH_TOKEN": "…",
        "GOOGLE_ADS_LOGIN_CUSTOMER_ID": "1234567890"
      }
    }
  }
}
```

**opencode** (`opencode.json`):

```json
{
  "mcp": {
    "google-ads": {
      "type": "local",
      "command": ["npx", "-y", "@adginr/google-ads-mcp", "--env-file", "/path/to/.env"]
    }
  }
}
```

**Streamable HTTP**:

```bash
npx @adginr/google-ads-mcp --http --port 8765   # http://127.0.0.1:8765/mcp
```

The HTTP transport listens on `127.0.0.1` only and has no authentication. Put an authenticating proxy in
front of it before exposing it anywhere.

## Options

| Flag / variable                             | Effect                                                 |
| ------------------------------------------- | ------------------------------------------------------ |
| `--read-only`, `GOOGLE_ADS_MCP_READ_ONLY=1` | Register only the tools that never change the account. |
| `--http`, `--port <n>`                      | Serve Streamable HTTP instead of stdio (default 8765). |
| `--env-file <path>`, `GOOGLE_ADS_ENV_FILE`  | Env file to load, and to write on `auth`.              |

## Tools

| Tool                                                   | What it does                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `list_accessible_customers`                            | Account IDs the signed-in user can access.                             |
| `list_campaigns`                                       | Campaigns with status, budget and performance over a date range.       |
| `get_resource_metadata`                                | Selectable / filterable / sortable fields of a GAQL resource.          |
| `search`                                               | Structured GAQL query (fields, resource, conditions, ordering, limit). |
| `generate_keyword_ideas`                               | Keyword Planner ideas with volumes, competition and bid ranges.        |
| `pause_campaign`, `enable_campaign`                    | Change campaign status.                                                |
| `update_campaign_budget`                               | Change the daily budget; refuses shared budgets unless confirmed.      |
| `create_ad_group`                                      | New ad group, paused by default.                                       |
| `update_ad_group_status`                               | Enable, pause or remove an ad group.                                   |
| `add_keywords_to_ad_group`                             | Add keywords in one match type, optionally skipping existing ones.     |
| `remove_keyword_from_ad_group`                         | Remove one positive keyword (verified first; never touches negatives). |
| `add_negative_keyword_to_ad_group`                     | Add an ad group negative keyword.                                      |
| `add_negative_keyword_to_campaign`                     | Add a campaign negative keyword.                                       |
| `remove_negative_keyword_from_campaign`                | Remove a campaign negative keyword.                                    |
| `list_ads_in_ad_group`                                 | Ads with full responsive search ad copy, pins and Ad Strength.         |
| `create_responsive_search_ad`                          | New RSA, paused by default, with pin checks and warnings.              |
| `update_ad_status`                                     | Enable, pause or remove an ad.                                         |
| `list_callouts`, `create_callouts`                     | Read callout links; create callout assets.                             |
| `attach_callouts_to_campaign` / `_account`             | Link callouts.                                                         |
| `update_callout_link_status`, `remove_callout_links`   | Pause, enable or unlink callouts.                                      |
| `list_sitelinks`, `create_sitelinks`                   | Read sitelink links; create sitelink assets.                           |
| `attach_sitelinks_to_campaign` / `_ad_group`           | Link sitelinks.                                                        |
| `update_sitelink_link_status`, `remove_sitelink_links` | Pause, enable or unlink sitelinks.                                     |

Every mutating tool takes `validateOnly: true` for a dry run. Money inputs (`dailyBudget`, `cpcBid`) are in the
account currency, not micros.

## Resources

`google-ads://docs/release-notes`, `google-ads://docs/metrics`, `google-ads://docs/segments` and
`google-ads://docs/discovery-document`: Google Ads API reference pages, fetched live.

## Embedding

```ts
import { GoogleAdsClient } from '@adginr/google-ads-rest';
import { createGoogleAdsMcpServer } from '@adginr/google-ads-mcp';
import { createMcpHandler } from '@modelcontextprotocol/server';

const ads = GoogleAdsClient.fromEnv();
const handler = createMcpHandler(() => createGoogleAdsMcpServer({ ads, readOnly: true }));
// e.g. in a web framework route: return handler.fetch(request);
```

`createMcpHandler` comes from `@modelcontextprotocol/server`; any of its transports works.

## License

Apache-2.0. Not affiliated with Google.
