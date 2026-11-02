# tubot-sf-data360 — Security Audit Report (2026-11-02)

First full audit of this worker. Two live-proven findings, both fixed,
deployed, and live-verified the same day.

## Scope

- `src/index.ts` (fetch router + `TubotSfData360Entrypoint` RPC),
  `src/auth-client.ts`, `src/cache-helper.ts`, `src/service-verify.ts`,
  `src/rpc-sign.ts`, B2/Data Cloud clients.
- Live target: `https://tubot-sf-data360.emalteaproductions.workers.dev`
  (workers.dev public; D1 `agent-dashboard-db-staging`).
- Out of scope: B2 bucket policy review (no bucket-admin surface in repo).

## Finding D2 (CRITICAL, fixed): unauthenticated tenant-data read + cache poison

**Mechanism.** The HTTP data routes served D1/edge cache reads keyed by bare
caller-supplied IDs before any authentication:

- `/api/v1/context` (+3 aliases): `d1Cache.getUserWithETag(userId)` with no
  tenant check; auth validated only when a token was supplied
  (`if (options.accessToken && options.instanceUrl) await getAuth()`).
- `/api/data360/corresponding-data` (+alias): same pattern (`getUser`,
  `caches.default.match` pre-auth).
- `/api/data360/users/:userId`, `/users/:userId/data360`,
  `/api/data360/messagingsessions/:id` (+aliases): same pattern, plus
  unauthenticated POST writes of caller-supplied data.
- `/export`, `/api/export`: `resolveToken` channel path reachable with
  scope-only headers (no credential), minting the channel's Salesforce
  token on valid IDs.

On extraction failure the loaders cached degenerate/empty rows at FULL TTL
via `ON CONFLICT(user_id) DO UPDATE`, so anyone could squat shared cache
rows (proven) and overwrite expired real rows (code path).

**Live proof (fake IDs only; no real tenant data touched).**
`GET /api/v1/context?userId=005000000000000EAA…` with no credentials
returned `200 {"ok":true,"context":{…}}`; blind `wrangler d1 execute`
read-back confirmed the probe wrote `data360_user_cache` + conversation
rows; probe rows deleted afterwards. `/export` with fake scope reached the
channel lookup (`channel_not_found`, not 401), proving the mint path.

**Fix (this repo, deployed as version `ba1c6a60`).**
- `requireData360HttpAuth` gate in `fetch()`: every data route requires an
  HMAC service signature (existing `service-verify` contract, single-use
  nonces) or a live-validated Salesforce token (userinfo call in the gate;
  asserted org must match). Purge is service-only.
- Token mode pins the validated org (`httpOrg`): D1 reads bind
  (`AND org_id = ?` + org-scoped isolate-memory keys), B2/edge keys salted,
  POST writes pinned; the gate's validated connection is reused downstream
  (single userinfo call, no scope-only channel mint over HTTP).
- Failure fallbacks cache at 30s negative TTL (`NEGATIVE_CACHE_TTL_SEC`)
  instead of full TTL: ETag stability + herd protection without shadowing
  real rows. Cross-tenant protection comes from the gate + org binding.
- 500 handler no longer returns `err.stack`.
- RPC entrypoint unchanged (already HMAC-gated per method); no production
  HTTP callers existed (verified by repo-wide grep; only tests).

## Finding D1 (LOW, fixed): unauthenticated edge-cache purge

`POST /api/data360/cache/purge` required no credential (proven live: 200 on
a nonexistent tag). Impact bounded to own edge-cache eviction (no CF API
token involved). Now service-only HMAC via the same gate.

## Verification

- `bun test`: 230 pass / 0 fail (was 192/29-fail mid-fix; fallout was
  legacy specs calling routes without auth, updated to sign).
- New `test/http-auth.spec.ts` (9 tests): 401 on all 16 gated route/method
  combos, scope-only rejection, bad-token 401, org-mismatch 403,
  purge service-only, HMAC replay rejection, same-org hit, cross-org miss,
  negative-TTL bound. Fails-without-fix proven: 8/9 fail on stashed src.
- `bunx tsc --noEmit`: clean.
- Live post-deploy: anon `/export`, `/context`, `/purge` → 401;
  `/health` → 200; D1 blind read confirms zero probe-junk rows.

## Residual / accepted

- Service-mode (HMAC) callers keep legacy unbound reads: trusted panel /
  sf-auth key-holders only; external callers cannot reach this mode.
- `x-data360-secret` legacy header on `/cache/refresh` retained during the
  panel cutover (pre-existing TRANSITION, still documented in code).
- Local `wrangler d1 execute` (non-remote) fails in workerd startup in this
  environment; all D1 evidence used `--remote`.

## Re-run

`bun test` (suite) and the curl probes above against the workers.dev URL.
