---
'@adginr/google-ads-rest': patch
---

`uploadClickConversions`: a partial failure without a GoogleAdsFailure detail (no details, or another
`@type`) now yields one `failures` entry without `index` (`rpc.<CODE>` and Google's message) instead of an
empty list that read as success.
