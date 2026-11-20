# tubot-sf-data360

A Cloudflare Worker that retrieves a Salesforce Data 360 catalog and its
records, stores encrypted snapshots in Backblaze B2, and serves them back
through HTTP and Worker RPC. It also exposes agent-context helpers used by the
TuBot messaging stack.

The Worker owns all Salesforce retrieval and B2 writes. Bash scripts only
launch setup and verification — they never build an export or upload snapshot
files themselves.

## What it does

- **Discovery and export** — finds Data 360 objects (DLO, DMO, Unified DMO,
  Link DMO, UDMO, Data Graph, Calculated Insight), retrieves populated rows and
  referenced files, and writes a snapshot to B2 under
  `<prefix>/<verified-org>/<target>/snapshots/<snapshot-id>/`.
- **Cache** — a `latest.json` manifest is published only after every snapshot
  file is uploaded. Operational metadata is cached in KV (org catalog 6h,
  per-family last-known-good objects 7d, channel/agent resolutions 24h). Every
  cache is a hint with a live fallback.
- **HTTP API** — `/health`, `/export`, `/context`, `/corresponding-data`,
  `/cache/latest`, `/cache/query`, `/cache/download`, `/cache/snapshots`, and
  user/session Data 360 routes. Data routes require either a signed HMAC
  service call or a live-validated Salesforce bearer token plus
  `x-salesforce-instance-url`.
- **RPC** — `TubotSfData360Entrypoint` exposes `exportData360Zip`,
  `extractData360`, `queryCache`, `getContext`, `getAgentCode`, and related
  methods for authorized service bindings.

Calls to Salesforce credentials and B2 storage are brokered through
`tubot-sf-auth` and the Salesforce parser service; see `wrangler.jsonc` for
bindings. A scheduled retention purge is dormant-ready (the fetch path
piggybacks the daily claim until cron capacity is available).

## Layout

- `src/index.ts` — Worker entrypoint, HTTP routing, auth gates, RPC entrypoint.
- `src/data360-extractor.ts`, `src/data-cloud-client.ts` — catalog discovery
  and retrieval.
- `src/b2-client.ts`, `src/b2-cache-manager.ts` — snapshot storage and cache.
- `src/cache.ts`, `src/cache-helper.ts` — KV hint cache and query helpers.
- `src/auth-client.ts`, `src/rpc-sign.ts` — Salesforce auth bridge and signed
  service calls.
- `src/zip-builder.ts`, `src/unstructured-extractor.ts`, `src/agent-analyzer.ts`
  — export packaging and file handling.
- `src/retention.ts` — D1 retention purge.
- `test/` — Vitest/Bun unit and package-coverage tests.
- `scripts/data-cloud/` — live seed, test, and verification scripts; see
  `scripts/data-cloud/README.md`.
- `security-review/SECURITY-AUDIT-REPORT.md` — security audit.

## Requirements

- Bun, Wrangler, and `wrangler types` after changing bindings.
- The `TUBOT_SF_AUTH` and `TUBOT_SF_PARSER` service bindings, a D1 database
  binding (`DB`), and a KV namespace (`DATA360_KV`).
- B2 credentials as secrets. `BACKBLAZE_BUCKET_NAME` and `DATA360_PATH_PREFIX`
  are vars; staging and production use different prefixes and bindings.

Credentials go in `.dev.vars` locally or Wrangler secrets in deployment — never
in arguments or tracked files.

## Setup and checks

```bash
bun install

bun test                     # unit / package-coverage tests
bunx tsc --noEmit            # typecheck
bun run dev                  # wrangler dev
bun run deploy               # wrangler deploy
bun run verify:live          # live Data 360 gate (needs an authenticated org)
```

For live setup, seed, and independent B2 readback, follow
`scripts/data-cloud/README.md`. It requires `bun`, `sf`, and `jq`, an
authenticated Salesforce CLI alias with Data 360 access, and real source data —
missing data fails explicitly rather than being fabricated.

## Notes

- Streaming Insight is deferred and excluded from discovery, storage, seeding,
  and the coverage gate.
- Catalog metadata is slim by default (per-object `fields` arrays are dropped).
  Pass `includeObjectSchemas: true` on `/export` when full schemas are needed.
- `latest.json` is the commit marker for a complete snapshot. Explicit `/export`
  ZIP responses and legacy B2 snapshot reads remain supported.
- No credentials or generated export archives are committed (`.dev.vars` and
  `*.zip` are gitignored).

## License

Business Source License 1.1 — see [LICENSE](LICENSE). Non-production use is
granted; the file states the Change Date and Change License.
