---
'@adginr/google-ads-rest': minor
'@adginr/google-ads-mcp': minor
---

Read and build Search campaigns. `get_campaign_snapshot` returns one campaign in full (settings, bidding, networks, dates, budget, location/radius/language/device/schedule criteria, ad groups with keywords and responsive search ads, campaign, ad group and shared-list negatives, and linked sitelinks, callouts and structured snippets) as one typed object. New tools for building: `create_campaign_budget`, `create_search_campaign` (budget, bidding, networks, dates, EU political advertising declaration, location and language targeting in one atomic request, paused by default), `update_campaign` (name, bidding), `update_ad_group` (name, CPC bid), `update_keyword_status`, and shared negative keyword lists (`list_negative_keyword_lists`, `create_negative_keyword_list`, `add_keywords_to_negative_keyword_list`, `remove_keywords_from_negative_keyword_list`, `attach_negative_keyword_list`, `detach_negative_keyword_list`).

For apps, `MutatePlan` publishes many related entities in one atomic mutate using temporary resource IDs and maps the results to caller keys, with a validateOnly dry run; `publishInBackground` handles larger plans through a batch job with progress. Operation builders (`searchCampaignOperation`, `adGroupOperation`, `keywordOperation`, `responsiveSearchAdOperation`, …), `GoogleAdsClient` batch job methods and `GoogleAdsError.fromStatus` are exported too.
