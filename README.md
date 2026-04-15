# @pockgin/scripts

Data pipeline scripts for the Pockgin plugin registry.

## Scripts

| Script | Description |
|--------|-------------|
| `validate-registry.js` | Validate all `registry/plugins/*.json` against the schema |
| `sync-github.js` | Fetch enriched data from GitHub API for each plugin |
| `generate-public-data.js` | Generate `public/data/*` from synced data |

## Setup

```bash
npm install
```

## Usage

```bash
# Validate registry entries
REGISTRY_DIR=/path/to/registry/plugins npm run validate

# Sync GitHub data (requires token for reasonable rate limits)
GITHUB_TOKEN=ghp_xxx REGISTRY_DIR=/path/to/registry/plugins npm run sync

# Generate public data from sync cache
PUBLIC_DATA_DIR=/path/to/public/data npm run generate

# Run full pipeline
npm run pipeline
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REGISTRY_DIR` | No | Path to `registry/plugins/` (defaults to `../pockgin/registry/plugins`) |
| `PUBLIC_DIR` | No | Path to `public/` (defaults to `../pockgin/public`) |
| `PUBLIC_DATA_DIR` | No | Path to `public/data/` (defaults to `../pockgin/public/data`) |
| `GITHUB_TOKEN` | Recommended | GitHub API token for higher rate limits |

## Rate Limit Protection

- ETag-based caching (`.cache/` directory)
- Exponential backoff on 403/429 responses
- Graceful degradation when quota is low
- Fail-safe: never overwrites public data with empty output

See [rate-limit-strategy.md](https://github.com/pockgin/docs/blob/main/rate-limit-strategy.md) for details.

## License

MIT
