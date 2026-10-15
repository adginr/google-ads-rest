# Contributing

Thanks for helping. Bug reports, new tools and documentation fixes are all welcome.

## Setup

```bash
git clone https://github.com/adginr/google-ads-rest.git
cd google-ads-rest
pnpm install
pnpm test
```

Node.js 22 or newer and pnpm are required (`corepack enable` sets up the pinned pnpm version).

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Create a branch, make the change, add tests. The [AGENTS.md](AGENTS.md) file describes the layout and the
   conventions for tools.
3. Run `pnpm lint && pnpm typecheck && pnpm test`.
4. Add a changeset with `pnpm changeset` describing the change for users.
5. Open a pull request. CI runs lint, type checks, tests on Node 22 and 24, the build and a check that the
   generated types are current.

## Testing against a real account

Unit tests never touch the network. To try a change for real, put credentials in `.env` (see
`.env.example`) and run the MCP server from source:

```bash
pnpm --filter @adginr/google-ads-mcp start -- --read-only
```

Prefer read-only tools and `validateOnly: true` when testing mutations on a live account.

## Updating the Google Ads API version

1. Change `GOOGLE_ADS_API_VERSION` in `packages/rest/src/api-version.ts`.
2. Run `pnpm codegen`, then `pnpm typecheck` and fix what broke.
3. Read the [release notes](https://developers.google.com/google-ads/api/docs/release-notes) for behaviour
   changes and add a changeset.

## Releases

Merging to `main` with pending changesets opens a "Version packages" pull request. Merging that publishes to
npm through trusted publishing (no token, with provenance) and creates the git tags and GitHub releases.

The "Version packages" pull request is opened by GitHub Actions, which does not trigger CI on its own pull
requests. Close and reopen it once to run the required checks before merging.
