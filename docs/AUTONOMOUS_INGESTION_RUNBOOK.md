# Autonomous Ingestion Runbook

## Operating assumptions

This runbook operates the implementation described in `AUTONOMOUS_INGESTION_ARCHITECTURE.md`. It does not assert that migration 008 has been applied to production or that any scheduled production run has succeeded. Confirm deployment state before enabling the workflow.

Use service-role credentials only in trusted server or CI environments. Never expose `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_INGESTION_SECRET`, `REFRESH_SECRET`, provider tokens, cookies, or browser profiles in client code, logs, commits, or workflow artifacts.

Automated collectors may use public interfaces and explicitly authorized credentials only. A login wall, CAPTCHA, robots restriction, permission error, or blocked endpoint is a stop condition. Do not bypass access controls.

## Deployment order

1. Review and merge migration 008, runtime types/store, coordinator, collectors, workflow, diagnostics, and these documents as one compatible release.
2. Back up the target database and confirm migrations 001 through 007 are present in order.
3. Apply migration `008_autonomous_ingestion_runtime.sql` exactly once through the environment's normal migration mechanism.
4. Verify new tables, functions, constraints, RLS, grants, and append-only triggers before starting a writer.
5. Configure server-side application environment variables and deploy the application. This makes protected diagnostics available but does not start collection.
6. Configure GitHub Actions secrets and repository permissions. Keep the schedule disabled until the manual canary succeeds.
7. Run the local plan preflight. Compare task counts and terminal reasons with the reviewed release.
8. Trigger one manual workflow run with a unique replay key and monitor it through import, publication validation, and commit.
9. Verify Supabase rows, generated manifest hashes, the bot publication commit, and the application graph.
10. Enable the scheduled workflow and observe both a morning and evening Central slot.

Do not deploy the coordinator before migration 008. It calls runtime-lock RPCs and writes columns/tables that do not exist in migrations 001 through 007.

The workflow pins Node.js `24.14.0`, installs with `npm ci`, needs GitHub `contents: write`, and pushes to the checked-out branch. Confirm repository workflow permissions and branch protections allow the bot publication commit, or replace direct push with an approved publication path before enabling the schedule.

### Applying the migration

The repository's `release:migrate:v4` command handles migrations 004 through 007 only. It does not apply migration 008.

Prefer the production environment's established migration-history mechanism. If this repository is linked and managed by the Supabase CLI, inspect before applying:

```bash
supabase migration list
supabase db push --dry-run
supabase db push
```

If the environment intentionally uses `psql` rather than Supabase migration history, first prove 001 through 007 are present, then run:

```bash
psql "$DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f supabase/migrations/008_autonomous_ingestion_runtime.sql
```

Direct `psql` does not automatically update Supabase migration history. Do not mix mechanisms without reconciling that history. Migration 008 preserves legacy rows, but it is a forward migration, not a repeatedly runnable repair script.

### Schema verification

Run with a database administration connection:

```sql
select to_regclass('public.ingestion_runtime_locks') as runtime_locks,
       to_regclass('public.ingestion_run_events') as run_events,
       to_regclass('public.ingestion_checkpoints') as checkpoints,
       to_regclass('public.provider_rate_limits') as rate_limits,
       to_regclass('public.ingestion_dead_letters') as dead_letters,
       to_regclass('public.ingestion_coverage_reports') as coverage_reports,
       to_regclass('public.ingestion_artifact_manifests') as artifact_manifests;

select proname
from pg_proc
where proname in (
  'claim_ingestion_runtime_lock',
  'renew_ingestion_runtime_lock',
  'release_ingestion_runtime_lock',
  'claim_ingestion_tasks',
  'renew_ingestion_task_lease',
  'requeue_expired_ingestion_tasks'
)
order by proname;

select relname, relrowsecurity
from pg_class
where relname in (
  'ingestion_runs', 'ingestion_runtime_locks', 'ingestion_tasks',
  'metric_observations', 'ingestion_run_events', 'ingestion_checkpoints',
  'provider_rate_limits', 'ingestion_dead_letters',
  'ingestion_coverage_reports', 'ingestion_artifact_manifests'
)
order by relname;
```

All listed relations must exist and report RLS enabled. Also test with anon/authenticated credentials that operational reads fail; do not infer access isolation from migration text alone.

## Environment and secrets

### Required for the autonomous coordinator

| Variable/input | Required where | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Coordinator and diagnostics server | Supabase project URL. Despite the name, it is paired with a server-only service key in these paths. |
| `SUPABASE_SERVICE_ROLE_KEY` | Coordinator and full diagnostics server | Service-role access to RLS-protected operational/evidence tables and runtime RPCs. |
| `--idempotency-key` or `INGESTION_IDEMPOTENCY_KEY` | Coordinator | Stable run identity. The workflow passes the resolved Central slot or manual replay key as the CLI argument. |

When either Supabase secret is missing, the workflow continues in explicitly labeled file-backed recovery mode so source collection and Git publication do not stop. That mode does not provide durable database locking, task history, importer counters, or database idempotency; the repository publication lane is the only coordinator lock. It is always reported as degraded and fails the workflow health receipt. Configure both secrets for the production contract.

### Required for production admin diagnostics

Configure at least one:

| Variable | Behavior |
| --- | --- |
| `ADMIN_INGESTION_SECRET` | Dedicated bearer/header secret for ingestion diagnostics. Preferred for least privilege. |
| `REFRESH_SECRET` | Accepted as an alternative and also used by refresh/ingest routes. Broader reuse increases blast radius. |

Without either secret, the production API returns `503`. Without the Supabase URL and service key, authorization can succeed but diagnostics report the data source unavailable.

### Optional and active

| Variable | Current use |
| --- | --- |
| `GITHUB_TOKEN` | Used by `fetch-github-traction.mjs` to raise GitHub API limits. GitHub Actions maps the automatic `github.token`; no separate repository secret is required for that mapping. |
| `ARTIFACT_INGESTION_RUN_ID` or `INGESTION_RUN_ID` | Fallback run ID for the manifest writer when the CLI flag is omitted. |
| `EVIDENCE_COLLECTED_AT`, `OLDEST_PLATFORM_REFRESH_AT`, `ARTIFACT_PUBLISHED_AT` | Optional manifest timestamp overrides. Normally values are derived or generated. |

### Credentialed discovery and remaining inactive credentials

`X_BEARER_TOKEN` is consumed by the broad public collector for batched official recent-search reads of exact mapped X accounts. `EXA_API_KEY` is consumed for domain-restricted LinkedIn, X, and Product Hunt source discovery. Missing X, Exa, or Supabase credentials are recorded as degraded collection-health reasons, and the workflow health gate rejects the resulting publication receipt instead of reporting a green refresh.

Reddit client variables are still passed but are not consumed by the current broad-public script; Reddit continues to use public JSON/page access.

`INGESTION_ARTIFACT_BUCKET` is not used; artifacts are not uploaded to object storage. `INGESTION_GLOBAL_CONCURRENCY`, `INGESTION_REQUEST_TIMEOUT_MS`, and `INGESTION_MAX_ATTEMPTS` are not read by the current coordinator or collectors. `YOUTUBE_COOKIES_PATH` and `PLATFORM_COOKIES_PATH` are not used by this workflow.

Authenticated social collection is optional and platform-isolated. It requires all of `OPENCLI_BIN`, `OPENCLI_HOME`, `OPENCLI_PROFILE`, `RETURNER_INSTAGRAM_VIEWER_HANDLE`, and `RETURNER_LINKEDIN_VIEWER_PROFILE` in the self-hosted runner environment. `OPENCLI_CONFIG_DIR` may point at the reviewed `browser-profiles.json`; otherwise OpenCLI uses its standard configuration directory. LinkedIn additionally requires the durable Supabase credentials and `LINKEDIN_GLOBAL_LOCK_NAMESPACE`. `OPENCLI_MAIN` is not consumed by the coordinator.

Each ordinary scheduled run performs a just-in-time service and platform preflight after the public collectors finish. LinkedIn and Instagram have independent readiness, bounded retries, and explicit debt: one failed authenticated lane is skipped without blocking the other lane or the public GitHub/RSS/YouTube publication path. Instagram readiness invokes the exact `instagram profile <viewer> -f json --site-session persistent` adapter and then proves the signed-in account-settings DOM immediately before collection. An explicit authenticated historical replay is stricter and fails closed unless both platforms pass.

## Preflight and canary

Install exactly from the lockfile used by GitHub Actions:

```bash
npm ci
```

Run the side-effect-free plan without Supabase credentials:

```bash
npm run ingest:autonomous:plan
```

At the catalog state covered by the current tests, expect:

```text
3 batches
1,029 entities
13,377 expected tasks
4,243 queued tasks
9,134 pre-terminal tasks
```

Review `missingMappings`, `unsupported`, and every per-platform count. A plan is not a source-liveness check.

Run focused release verification:

```bash
node --test \
  tests/ingestion-schedule.node-test.mjs \
  tests/autonomous-ingestion-workflow.node-test.mjs \
  tests/autonomous-ingestion-plan.node-test.mjs \
  tests/autonomous-ingestion-runner-contract.node-test.mjs \
  tests/http-policy.test.mjs \
  tests/durable-evidence-import.test.mjs \
  tests/artifact-manifest.test.mjs

npx vitest run \
  tests/autonomous-ingestion-schema.test.ts \
  tests/autonomous-ingestion-store.test.ts \
  tests/account-inventory.test.ts \
  tests/canonical-evidence.test.ts \
  tests/ingestion-diagnostics.test.ts \
  tests/api/admin-ingestion-route.test.ts \
  tests/database-autonomous-types.test.ts

npm run typecheck
```

These tests validate code and local artifacts. They do not verify production credentials, provider access, workflow permissions, migration application, or a live Supabase schema.

### Manual canary

Trigger a complete canary with a unique replay key:

```bash
gh workflow run autonomous-ingestion.yml \
  -f replay_key="manual-$(date -u +%Y%m%dT%H%M%SZ)"

gh run list --workflow autonomous-ingestion.yml --limit 5
```

Use the GitHub Actions UI if `gh` is unavailable. The workflow has a 390-minute job timeout. The accepted-slot controller retries only explicit transient failures and starts another child only when the child can retain its complete runner and cleanup allowance. The coordinator starts the collector cohorts concurrently, validates and pushes the artifact commit, and then finalizes the durable run.

A local database-writing smoke mode exists:

```bash
node scripts/run-autonomous-ingestion.mjs \
  --idempotency-key="smoke-$(date -u +%Y%m%dT%H%M%SZ)" \
  --skip-network \
  --skip-publish
```

This is not read-only. It synchronizes inventory, creates a run and tasks, marks queued tasks skipped, writes coverage, and completes the run. Use it only against an approved nonproduction database or when those production records are intentionally desired.

## Schedule operations

The intended Central schedule is exactly `06:00` and `18:00` every day.

- During CDT, the primary UTC candidates are `11:00` and `23:00`.
- During CST, the primary UTC candidates are `12:00` and `00:00` on the next UTC day for the prior Central evening.
- `7,22,37,52 * * * *` supplies recovery wakeups between the primary candidates.
- Every cron resolves the same newest eligible Central slot and becomes a no-op only when the complete committed publication watermark is current.
- Accepted publishers share the non-canceling `repository-publication-main` queue.

Do not replace the four primary cron candidates plus recovery wakeup with fixed UTC assumptions. Verify DST behavior with `tests/ingestion-schedule.node-test.mjs` after any schedule edit.

## Monitoring

### GitHub Actions

Watch these workflow stages in order:

1. Resolve Central ingestion slot.
2. Install dependencies for accepted candidates only.
3. Run autonomous ingestion.
4. Validate generated public artifacts.
5. Publish refreshed public artifacts.

An inactive DST candidate is a healthy no-op. A run that reports no public artifact changes is also valid when the database run completed and source state did not change.

### Admin UI and API

Open:

```text
/admin/ingestion
```

Enter the admin secret and use Summary, Runs, Tasks, Failures, and Artifacts. The secret remains in page memory and is sent as a bearer token.

Direct API examples:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $ADMIN_INGESTION_SECRET" \
  "$APP_URL/api/admin/ingestion?view=summary"

curl --fail-with-body \
  -H "Authorization: Bearer $ADMIN_INGESTION_SECRET" \
  "$APP_URL/api/admin/ingestion?view=tasks&runId=$RUN_ID&page=1&pageSize=100"
```

Responses are no-store. Query limits are `page` 1-10,000 and `pageSize` 1-100.

The admin surface is incomplete: failures are legacy `source_failures`, artifacts are canonical evidence items, and summary pending tasks omit `retry_scheduled`. Use the database checks below for runtime leases, events, coverage, dead letters, provider state, and manifest records.

### Database checks

The queries below use the `psql` variable `run_id`. Invoke `psql` with `-v run_id="$RUN_ID"`, or replace `:'run_id'` with a safely quoted run UUID in the database console.

Latest runs and heartbeat health:

```sql
select id, idempotency_key, status, started_at, heartbeat_at,
       lease_owner, lease_expires_at, finished_at, stats_json
from public.ingestion_runs
order by started_at desc
limit 20;
```

Treat a `running` row with an old heartbeat or expired lease as suspect. Check the global lock before intervening:

```sql
select lock_key, owner_id, heartbeat_at, lease_expires_at, metadata_json
from public.ingestion_runtime_locks
where lock_key = 'autonomous-ingestion';
```

Run events:

```sql
select occurred_at, severity, event_type, message, payload_json
from public.ingestion_run_events
where ingestion_run_id = :'run_id'
order by occurred_at, id;
```

Task terminality and outcomes:

```sql
select status, platform, count(*)
from public.ingestion_tasks
where ingestion_run_id = :'run_id'
group by status, platform
order by platform, status;

select count(*) as nonterminal
from public.ingestion_tasks
where ingestion_run_id = :'run_id'
  and status not in (
    'completed', 'needs_review', 'blocked_or_empty', 'skipped',
    'failed', 'canceled', 'dead_lettered'
  );
```

Coverage and importer counters:

```sql
select expected_count, attempted_count, succeeded_count,
       failed_count, skipped_count, generated_at, report_json
from public.ingestion_coverage_reports
where ingestion_run_id = :'run_id'
  and report_key = 'overall';
```

Open dead letters and provider blocks:

```sql
select id, ingestion_task_id, failure_kind, attempts,
       dead_lettered_at, failure_message
from public.ingestion_dead_letters
where status = 'open'
order by dead_lettered_at;

select provider, scope_key, remaining, reset_at, blocked_until,
       consecutive_failures, last_response_at
from public.provider_rate_limits
where blocked_until > now() or consecutive_failures > 0
order by provider, scope_key;
```

The current coordinator does not populate provider-rate-limit state and does not route its collector failures to the DLQ. Empty results do not prove healthy HTTP behavior.

Manifest record:

```sql
select artifact_key, artifact_type, storage_uri, byte_size, sha256, created_at
from public.ingestion_artifact_manifests
where ingestion_run_id = :'run_id'
order by artifact_key;
```

## Success criteria

A production run is successful only when all of the following are true:

- The workflow accepted the intended Central slot or explicit replay key.
- When Supabase is configured, one run row exists for the idempotency key and ends in `completed` and the runtime lock is released. In file-backed mode, the receipt must explicitly report that these guarantees were skipped.
- The overall coverage report has `nonTerminal = 0`.
- Explicit terminal mapped failures are at or below the hard budget of five and their exact checkpoint keys appear in the coverage receipt. Any nonterminal task or a sixth terminal failure blocks publication.
- Durable importer counters have plausible `received`, `stored`, `readBack`, attribution, observation, and rejection values.
- The production build, graph/benchmark publication, manifest write, and artifact validation completed.
- The manifest run ID matches the ingestion run, and its SHA-256 matches the committed file.
- The workflow pushed and remotely verified the expected publication commit. A no-change result is an error for a new accepted slot.
- The source-delta receipt distinguishes newly inserted physical posts from re-observed rows. The final Central slot fails the daily freshness audit if both slots found zero new physical sources.
- The deployed graph/API reflects the intended publication after deployment catches up with the pushed commit.

## Manual replay and backfill

### Full replay

Use `workflow_dispatch` with a new key to perform a full collection and durable import:

```bash
gh workflow run autonomous-ingestion.yml \
  -f replay_key="incident-20260718-retry-1"
```

Reusing the key of a completed run is a no-op. Use a new key when a new observation and publication are intended. A failed key can be invoked again, but a fresh incident key gives clearer audit separation.

### Backfill limits

The coordinator has no batch, platform, company, date-range, or task-ID filter. A manual replay is a full three-batch plan. The durable importer is a library called by the coordinator; there is no checked-in standalone CLI that imports an arbitrary historical JSON file. There is also no completed database-to-graph read path.

For a selective or historical backfill, first implement or review a dedicated tool that:

- creates a distinct ingestion run;
- hashes and records every input artifact;
- uses the durable importer and existing canonicalization rules;
- emits coverage and unresolved-attribution counters;
- is idempotent at evidence, attribution, and observation keys;
- performs a dry run before production writes.

Do not edit canonical tables by hand as a substitute for attribution and metric validation.

### DLQ replay limit

Migration 008 and `AutonomousIngestionStore` can requeue expired leased tasks, but the current coordinator does not drain the fine-grained task queue. Changing a dead-letter row to `requeued` or a task to `retry_scheduled` will not make the current scheduled runner execute that task. Use a full replay with a new key or deploy a reviewed task worker before relying on DLQ requeue semantics.

## Failure diagnosis

### Workflow skips unexpectedly

- Confirm `github.event_name` is `schedule`, `repository_dispatch`, or `workflow_dispatch`.
- Confirm scheduled cron is one of the four primary candidates or the declared recovery cron.
- Check resolver reason and watermark status: `publication-watermark-current`, `unrecognized-cron`, `unsupported-event`, `behind`, `divergent`, `missing`, or `invalid`.
- For `repository_dispatch`, require the exact `autonomous-ingestion-recovery` action and matching expected/triggered full `main` SHA; the host must never provide a slot key.
- For manual dispatch, ensure the replay key uses only letters, numbers, period, underscore, colon, and hyphen.

### Missing table, column, or RPC

Typical errors mention `claim_ingestion_runtime_lock`, `ingestion_run_events`, `stats_json`, or `ingestion_coverage_reports`. Stop the workflow and verify migration 008 application and schema cache. Do not patch around missing runtime objects in the coordinator.

### Another coordinator owns the lease

Inspect `ingestion_runtime_locks`, the owning workflow run, and the corresponding ingestion run heartbeat. Do not delete a nonexpired lock while its owner is active. GitHub concurrency cannot protect local or external invocations.

If the lock is expired and no process is active, a new claim can replace it. Preserve the old run/events for diagnosis.

### Heartbeat or release failure

The coordinator renews every 60 seconds against a 20-minute lease. Transient transport failures retry with capped exponential backoff beyond the former four-attempt ceiling while retaining the exact run and runtime-lock fencing tokens. Initial claim contention is retried with the same idempotency key through a sixth bounded attempt after 32.5 minutes of cumulative backoff; that final attempt still retains the complete runner and cleanup allowance. It reserves enough of the current lease for both renewal calls; confirmed lock loss after work starts, a semantic database error, or exhaustion of that safe window fails closed. The next idempotent invocation may recover after the old lease expires, but do not manually start an overlapping replacement while the lock is nonexpired.

### Self-hosted Actions job lease loss

The optional macOS host services handle power continuity, authenticated-browser
continuity, and recovery. The awake service continuously holds an AC-only
system-sleep assertion. The auth-browser service keeps a separately identified
local Chrome Canary running against the dedicated signed-in data directory. The
lease supervisor handles the infrastructure case where GitHub invalidates a
self-hosted job lease and the recovery gap where GitHub delays or drops scheduled
workflow events. None replaces the in-job retry controller.

Before install, place the vendor-signed Google Chrome Canary application exactly
at `~/Applications/Google Chrome Canary.app`. The installer rejects symlinked
executables, `/Volumes` and App Translocation paths, recursive quarantine,
signature/team/bundle-identifier mismatches, and any alternative executable
path. Install or idempotently refresh all three user
LaunchAgents from a reviewed checkout. Do this only while no ingestion is active
because refresh briefly unloads the existing services before loading their
reviewed replacements:

```bash
npm run ingest:lease-supervisor:install
launchctl print "gui/$(id -u)/com.returner-fund.ingestion-awake"
launchctl print "gui/$(id -u)/com.returner-fund.auth-chrome-runner"
launchctl print "gui/$(id -u)/com.returner-fund.ingestion-lease-supervisor"
pmset -g assertions
```

`com.returner-fund.ingestion-awake` runs exactly `/usr/bin/caffeinate -s` with
`KeepAlive`. The `-s` assertion is valid only on AC power, does not keep the
display awake, and does not simulate user activity. The workflow requires AC
and an effective `PreventSystemSleep` assertion before dependency installation,
then verifies a separate job-scoped assertion before collection. A scheduled
non-user wake is sufficient for public collectors and the bounded ordinary
authenticated lanes. The explicit user-wake gate remains required for a manual
authenticated historical replay.

`com.returner-fund.auth-chrome-runner` uses `KeepAlive` and the Aqua session to
run exactly
`~/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary` with
`--user-data-dir=~/Library/Application Support/Returner Fund Auth Chrome Runner`
and the `Default` profile. It exposes no remote-debugging port. The runtime
preflight rechecks the vendor signature, exact launchd program and data
directory, launchd PID, in-bundle framework child, PID-bound profile singleton,
and the exact OpenCLI profile connection before asking OpenCLI to prove each
platform. A launchd entry with only a dormant outer launcher is not ready.
Transient cold-start, bridge, extension, and `profile_disconnected` failures
receive bounded retries; a still-disconnected profile fails closed before either
platform probe. Login walls, challenges, checkpoints, and rate limits do not
retry.

The one-shot agent runs at load and every 300 seconds. It scans `Worker_*.log` diagnostics and fails closed unless the GitHub API confirms the exact repository, workflow, failed run attempt, self-hosted runner, and cancelled ingestion step. It never stores a GitHub token; `/opt/homebrew/bin/gh` uses the logged-in user's keychain session.

Recovery remains single-flight and power-aware. The supervisor defers while another autonomous workflow is active or while the Mac is below 60% on battery. It rejects an incident whose workflow SHA is not current `main`, which prevents an old failure from reviving superseded code. For an eligible event it calls GitHub's failed-jobs rerun endpoint, preserving the original event, run ID, replay/slot key, and candidate provenance. Durable dedupe is written only after GitHub accepts the rerun or reports a newer run attempt; stale-SHA incidents are recorded as intentionally skipped.

Independently, after 30 minutes without any autonomous workflow wakeup, the supervisor verifies that the workflow is active, its exact named runner is online, local power is eligible, no autonomous run is active or pending, and the complete publication watermark read from the current `main` SHA is stale, missing, invalid, or divergent. It then emits `autonomous-ingestion-recovery` with only that expected SHA. The workflow requires the dispatched SHA to match, rereads the committed watermark, and computes the newest `06:00`/`18:00` Central slot itself. A durable same-slot 30-minute cooldown and GitHub active-run check prevent dispatch storms. Refresh the installed host services after merging installer or supervisor changes; merging alone does not update the copied host script or loaded plists.

The checked-in templates are
`ops/launchd/com.returner-fund.ingestion-awake.plist.template`,
`ops/launchd/com.returner-fund.auth-chrome-runner.plist.template`, and
`ops/launchd/com.returner-fund.ingestion-lease-supervisor.plist.template`.
Runtime state is mode-restricted under
`~/Library/Application Support/Returner Fund/ingestion-lease-supervisor/state`,
the persistent authenticated Chrome data is under
`~/Library/Application Support/Returner Fund Auth Chrome Runner`, and logs are
in `~/Library/Logs/returner-fund-*.log`.

To unload all three services and remove only their installed plists, again
while no ingestion is active, run:

```bash
npm run ingest:lease-supervisor:uninstall
```

Uninstall is idempotent and intentionally preserves copied support files,
supervisor state, the authenticated Chrome data directory, and logs for audit
or a later reinstall.

### Collector timeout or failure

- Broad-public shard timeout: 70 minutes per attempt.
- GitHub shard timeout: 20 minutes per attempt.
- Collector and Top Voice attempts retry with capped exponential backoff until success or the shared 120-minute collection deadline; there is no small attempt-count cutoff.
- Coordinator work budget: 324 minutes plus six minutes reserved for its complete cleanup path.
- Retry-controller deadline: 345 minutes. It starts a child only with at least 331 minutes remaining, then allows six minutes after `SIGTERM` before a hard kill.
- Overall ingestion step timeout: 355 minutes; overall job timeout: 390 minutes. This retains controller-finalization and job setup/post-step headroom.
- Public cohort collectors run in parallel. GitHub cohort collectors share a serialized queue to respect public API limits.

A deadline-stopped child can leave a validated snapshot or public checkpoint. Snapshot recovery is on by default, and GitHub Actions keeps collector state outside the checkout-cleaned repository when `RETURNER_INGESTION_STATE_ROOT`, `OPENCLI_HOME`, or `RUNNER_WORKSPACE` is available. The next run for the same idempotency key reuses only snapshots that pass the exact campaign, attempt, shard, source, and freshness bindings. Up to the computed terminal mapped-failure budget can publish a clearly labeled degraded refresh; any nonterminal task, an incomplete collector matrix, or zero successful collection rows blocks publication.

If every collector fails before writing a readable snapshot, the durable importer rejects the run because it requires at least one snapshot. Partial available snapshots can still import.

### Source blocked or login-walled

Record the source as failed, skipped, blocked/empty, or needs review. Inspect `authenticated_social.preflight.finished` and the platform-specific `authenticated_social.*_preflight_debt` event before retrying. Login walls, challenges, checkpoints, and rate limits are nonretryable safety states for the authenticated lane; they do not stop public collection. Do not add cookies, browser sessions, or bypass behavior to restore a metric without approved access and a separate security review.

### Durable import failure

Check the `evidence.imported` event if it exists and inspect errors for:

- invalid or noncanonical source URLs;
- evidence read-back mismatch after upsert;
- unresolved catalog attribution;
- missing migration 004 evidence tables or migration 008 append-only/grant changes;
- service-role permission or schema-cache errors.

Compatibility JSON may have been modified locally before the import failed. GitHub Actions will not reach the commit step, but local operators should inspect and discard only files created by their failed run, without overwriting concurrent work.

### Nonterminal publication guard

Query task states for the run. `queued`, `running`, and `retry_scheduled` are nonterminal. The coordinator will fail before build/publication when any remain. The current coordinator should normally reconcile every queued task directly; remaining rows indicate an interrupted or inconsistent reconciliation.

### Build, benchmark, or artifact failure

Run in this order:

```bash
npm run build
npm run benchmarks:daily
node scripts/write-artifact-manifest.mjs --ingestion-run-id="$RUN_ID"
node scripts/write-artifact-manifest.mjs --validate --ingestion-run-id="$RUN_ID"
npm run artifacts:validate
```

The manifest validator detects missing, changed, unreferenced, or invalid graph/benchmark JSON, hash/size mismatches, stale model references, stale watermarks, and run-ID mismatches. Do not publish by skipping validation.

### Admin diagnostics unavailable

- `503`: configure `ADMIN_INGESTION_SECRET` or `REFRESH_SECRET` on the server.
- `401`: provide the exact bearer or `x-admin-ingestion-secret` value.
- Authorized but unavailable source: configure the Supabase URL and service key on the server.
- Local development fallback: use a loopback URL and leave `ADMIN_INGESTION_FILESYSTEM_FALLBACK` unset or not equal to `false`. Only allowlisted file metadata is exposed.

## Rollback

### Stop new writes

Disable the workflow before application or data rollback:

```bash
gh workflow disable autonomous-ingestion.yml
```

Confirm no accepted workflow or local coordinator is running. Wait for lease expiry or confirm clean release before starting replacement work.

### Application and publication rollback

1. Deploy the last known-good application commit.
2. Revert the specific bot publication commit with a normal reviewed `git revert <commit>`, then push through the normal release process.
3. Re-run artifact validation on the reverted publication.
4. Keep durable run, event, evidence, and observation history for audit.

Because the application still reads social JSON, reverting only application code without restoring compatible JSON can produce inconsistent graph behavior.

### Database rollback

Migration 008 has no down migration. The preferred rollback is schema-forward: stop the new writer and deploy the prior application while leaving the additive runtime schema and durable history in place.

Do not drop migration 008 objects casually. It adds append-only triggers to `metric_observations`, service-role-only grants, source-key uniqueness, task status values, and foreign-key-connected audit tables. A destructive rollback requires a tested backup restore or a separately reviewed reverse migration, with writers stopped and retained evidence exported first.

Reverting a publication commit does not delete durable observations. If a run imported bad evidence, preserve the run and mark or supersede data through a reviewed correction process; do not update or delete append-only metric observations.

### Re-enable

After diagnosis and a manual canary:

```bash
gh workflow enable autonomous-ingestion.yml
```

Observe the next accepted Central slot and verify the complete success criteria.

## JSON retirement operations

Do not stop JSON writes yet. The application dataset imports `public-evidence-current.json` and the three GitHub traction JSON files, and publication builds graph snapshots from that path.

Before switching reads to Supabase, require:

- a repeatable historical backfill with input hashes and run IDs;
- durable-to-JSON parity for canonical keys, attributions, raw observations, scores, rankings, and coverage;
- a database-backed graph reader exercised in shadow mode;
- alerting on parity and unresolved attribution regressions;
- a reversible application control for the read switch;
- at least one full retention window of twice-daily successful dual writes;
- a tested rollback to a prior durable run.

After the database read path is authoritative, continue generating JSON as compatibility output until all consumers are identified and migrated. Retire source JSON imports separately from public graph JSON publication; those are different responsibilities.
