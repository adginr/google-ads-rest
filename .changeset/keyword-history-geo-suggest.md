---
'@adginr/google-ads-rest': minor
'@adginr/google-ads-mcp': minor
---

`generate_keyword_ideas` returns searches per month (`monthlySearches`, oldest first) and takes an optional `fromMonth`/`toMonth` range, so 13+ months allow year-over-year comparisons. It now rejects more than 10 locations before calling Google. New `GoogleAdsClient.suggestGeoTargetConstants()` and read-only `suggest_geo_targets` tool find location IDs from (partial) place names.
