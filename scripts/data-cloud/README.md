# Live Data 360 setup and verification

Supported families: DLO, DMO, Unified DMO, Link DMO, UDMO, Data Graph, and Calculated Insight. Streaming Insight is deferred and excluded from discovery, storage, seeding, and the required coverage gate.

The Worker owns Salesforce retrieval and B2 writes. Bash only launches setup and verification; it never builds an export or uploads snapshot files itself.

## Run

Install dependencies with `bun install`. Use an authenticated Salesforce CLI alias with access to Data 360 and actual source data. All scripts require `bun`, `sf`, and `jq`.

```bash
export SF_TARGET_ORG=test2
bash scripts/data-cloud/seed.sh --target-org "$SF_TARGET_ORG"
bash scripts/data-cloud/test.sh --target-org "$SF_TARGET_ORG"
```

The seed maps a populated Individual source's real email data to Contact Point Email when needed, creates or reuses an Identity Resolution ruleset, waits for publication and successful execution, and verifies populated Unified Individual and Link outputs using separate Salesforce CLI processes. It then checks populated representatives of all seven families. Existing DLO/DMO mappings, UDMO ingestion, a materialized Data Graph, and a populated Calculated Insight are prerequisites; missing real data fails explicitly. It creates no fabricated CRM rows or events.

Use `--check` for a read-only readiness check, or `--phase identity` for just the identity setup. `--timeout-seconds` defaults to 900 for each materialization wait. API versions are discovered from the connected org; `--api-version vNN.0` selects an available version. `--asset-prefix` customizes seed asset labels.

Set `BACKBLAZE_KEY_ID`, `BACKBLAZE_APPLICATION_KEY`, and `BACKBLAZE_BUCKET_ID` in the environment or the ignored project `.dev.vars`; set `BACKBLAZE_BUCKET_NAME` and `DATA360_PATH_PREFIX` for the intended deployment when required. Do not put credentials in arguments or tracked files.

The default test invokes the actual Worker handler in Bun against live Salesforce and B2. Test workerd or a deployed Worker over HTTP with:

```bash
bash scripts/data-cloud/test.sh --target-org "$SF_TARGET_ORG" --worker-url http://127.0.0.1:8796
```

Pass `--agent` or `--channel` to select a real target; otherwise the first live BotDefinition is used. The test requires nonempty results for all seven families, a real Salesforce file, anonymous/cross-org cache rejection, independent Salesforce CLI readbacks, and a separate B2 REST checker verifying every stored object's byte count and SHA-256. Live checks use no mocks. Package coverage tests remain separate (`bun test`).

## B2 layout and reads

Snapshots use `<prefix>/<verified-org>/<target>/snapshots/<snapshot-id>/`:

- `metadata/<family>.json`: complete discovered catalogs, with data-space context.
- `data/<family>.json`: records keyed by object API name; duplicate names use a data-space-qualified key.
- `metadata/context.json`, `data/crm.json`, `agent/context.json`.
- `metadata/files.json` and original file bytes under `files/<category>/<id>/<filename>`.
- `manifest.json`: scope, family mapping, byte counts, and file checksums.

`latest.json` is published after all snapshot files finish uploading. New B2 snapshots contain neither a ZIP export nor `data-bundle.json`. Explicit `/export` ZIP responses and legacy B2 snapshot reads remain supported.

Retrieval includes all agent-referenced catalog objects and one populated representative of each family, bounded by `maxRecords` (default 500, Data 360 reads capped at 5,000). Catalog discovery does not imply every object's rows are exported.

HTTP cache reads require `Authorization: Bearer <Salesforce token>` and `x-salesforce-instance-url`. The verified token organization selects the B2 prefix; a conflicting `orgId` returns 403. `/cache/query` accepts `objectType`, `objectName`, optional `dataSpace`, and optional `snapshotId`. Supported type values are `dlo`, `dmo`, `unified-dmo`, `link-dmo`, `udmo`, `data-graph`, and `calculated-insight`. The older `dmo`, `crmEntity`, and `file` parameters still work. RPC cache methods require explicit Salesforce credentials or a complete tenant scope resolved through the signed `tubot-sf-auth` bridge.
