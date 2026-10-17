# @adginr/google-ads-rest

## 0.4.0

### Minor Changes

- [#13](https://github.com/adginr/google-ads-rest/pull/13) [`c7688d8`](https://github.com/adginr/google-ads-rest/commit/c7688d8a9b085ce98ecbf692c4363e37599865f7) Thanks [@adginr](https://github.com/adginr)! - Read and build Search campaigns. `get_campaign_snapshot` returns one campaign in full (settings, bidding, networks, dates, budget, location/radius/language/device/schedule criteria, ad groups with keywords and responsive search ads, campaign, ad group and shared-list negatives, and linked sitelinks, callouts and structured snippets) as one typed object. New tools for building: `create_campaign_budget`, `create_search_campaign` (budget, bidding, networks, dates, EU political advertising declaration, location and language targeting in one atomic request, paused by default), `update_campaign` (name, bidding), `update_ad_group` (name, CPC bid), `update_keyword_status`, and shared negative keyword lists (`list_negative_keyword_lists`, `create_negative_keyword_list`, `add_keywords_to_negative_keyword_list`, `remove_keywords_from_negative_keyword_list`, `attach_negative_keyword_list`, `detach_negative_keyword_list`).
  
  For apps, `MutatePlan` publishes many related entities in one atomic mutate using temporary resource IDs and maps the results to caller keys, with a validateOnly dry run; `publishInBackground` handles larger plans through a batch job with progress. Operation builders (`searchCampaignOperation`, `adGroupOperation`, `keywordOperation`, `responsiveSearchAdOperation`, …), `GoogleAdsClient` batch job methods and `GoogleAdsError.fromStatus` are exported too.

## 0.3.0

### Minor Changes

- [#11](https://github.com/adginr/google-ads-rest/pull/11) [`ba52417`](https://github.com/adginr/google-ads-rest/commit/ba5241745e97b708b7eee963f1d1dc8d28d51da9) Thanks [@adginr](https://github.com/adginr)! - `generate_keyword_ideas` takes `wholeSite: true` to generate ideas from every page of `pageUrl`'s site (Google's site seed, host only) instead of that one page. It cannot be combined with `keywords`; the default stays the single page.

## 0.2.0

### Minor Changes

- [#9](https://github.com/adginr/google-ads-rest/pull/9) [`6b5ed85`](https://github.com/adginr/google-ads-rest/commit/6b5ed85836693229af55f220b98e869d35693731) Thanks [@adginr](https://github.com/adginr)! - `generate_keyword_ideas` returns searches per month (`monthlySearches`, oldest first) and takes an optional `fromMonth`/`toMonth` range, so 13+ months allow year-over-year comparisons. It now rejects more than 10 locations before calling Google. New `GoogleAdsClient.suggestGeoTargetConstants()` and read-only `suggest_geo_targets` tool find location IDs from (partial) place names.

## 0.1.0

### Minor Changes

- [`ebc4999`](https://github.com/adginr/google-ads-rest/commit/ebc499947141481705018c78dbf715befac84350) Thanks [@adginr](https://github.com/adginr)! - First release: Google Ads API v26 REST client with generated types, 30 agent tools, and an MCP server with
  stdio and Streamable HTTP transports and a `google-ads-mcp auth` sign-in command.
