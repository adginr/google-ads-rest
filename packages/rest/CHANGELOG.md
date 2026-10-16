# @adginr/google-ads-rest

## 0.2.0

### Minor Changes

- [#9](https://github.com/adginr/google-ads-rest/pull/9) [`6b5ed85`](https://github.com/adginr/google-ads-rest/commit/6b5ed85836693229af55f220b98e869d35693731) Thanks [@adginr](https://github.com/adginr)! - `generate_keyword_ideas` returns searches per month (`monthlySearches`, oldest first) and takes an optional `fromMonth`/`toMonth` range, so 13+ months allow year-over-year comparisons. It now rejects more than 10 locations before calling Google. New `GoogleAdsClient.suggestGeoTargetConstants()` and read-only `suggest_geo_targets` tool find location IDs from (partial) place names.

## 0.1.0

### Minor Changes

- [`ebc4999`](https://github.com/adginr/google-ads-rest/commit/ebc499947141481705018c78dbf715befac84350) Thanks [@adginr](https://github.com/adginr)! - First release: Google Ads API v26 REST client with generated types, 30 agent tools, and an MCP server with
  stdio and Streamable HTTP transports and a `google-ads-mcp auth` sign-in command.
