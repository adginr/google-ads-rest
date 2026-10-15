# Security policy

## Supported versions

Only the latest minor release of each package receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue. Report it privately through
[GitHub security advisories](https://github.com/adginr/google-ads-rest/security/advisories/new).
You will get an answer within a few days; a fix and advisory follow once the issue is confirmed.

## Handling credentials

These packages read OAuth credentials (`GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`,
`GOOGLE_ADS_REFRESH_TOKEN`) from the environment and never log them. A refresh token grants full access to
every Google Ads account the user can reach: keep it out of version control and revoke it at
<https://myaccount.google.com/permissions> if it leaks.

The HTTP transport of `@adginr/google-ads-mcp` binds to `127.0.0.1` and has no authentication. Do not expose
it to a network without putting authentication in front of it.
