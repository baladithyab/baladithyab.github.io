# GitHub Integration

The Profile page displays GitHub information using the GitHub REST API directly, not third-party badge renderers.

## Data Source

- `src/lib/github.ts`: fetches user + repositories and derives:
  - account counts
  - approximate total stars across public non-fork repos
  - top languages (by repo count)
  - top 5 recently updated repos

## Caching

When running on Cloudflare Workers, responses are cached in `caches.default` to reduce rate-limit pressure.

## Endpoint

- `GET /api/github/summary`: JSON summary (used for debugging and the status page).

## Optional Token

Set `GITHUB_TOKEN` (fine-grained PAT recommended) to reduce the chance of unauthenticated rate limiting.

