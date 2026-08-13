# Ingestion coverage campaign receipt

Prepare an immutable v1 package from one explicit autonomous campaign directory:

```sh
node scripts/prepare-ingestion-coverage-campaign.mjs \
  --campaign-dir=work/autonomous-ingestion-campaigns/<campaign-key> \
  --output-dir=work/ingestion-coverage-campaigns/<campaign-key>-v1 \
  --idempotency-key=<exact-autonomous-idempotency-key> \
  --campaign-key=<campaign-key> \
  --batches=S2026,S26,A16ZSR006 \
  --materialized-at=<canonical-ISO-UTC-after-the-latest-attempt>
```

Only after a fresh historical run has written its final `run_completed` event,
add `--historical-journal=<fresh-v2-run>/pages.ndjson`. An unfinished or legacy
journal is rejected; it is never inferred complete from the surrounding
directory. Add `--historical-completion-proofs=<path>` only when an explicit
artifact-bound proof array exists. The preparer validates and copies the exact
merged public/GitHub outputs, every configured shard, every public checkpoint,
the canonical catalog sources, and verified-account overrides. It emits a full
NDJSON task plan, an independently derived expected manifest, runner-window
events based on actual attempt timestamps, and a SHA-256 descriptor for every
copied/generated input. The output directory must be new, making reruns
resumable without silently overwriting prior evidence.

Before publication, stage completed historical evidence without changing the
canonical public snapshot:

```sh
node scripts/stage-historical-publication.mjs \
  --journal=<fresh-v2-run>/pages.ndjson \
  --output-dir=<fresh-v2-run>/historical-publication-staging-v1 \
  --staged-at=<canonical-ISO-UTC-at-or-after-final-run_completed-recordedAt>
```

Use `--dry-run` without `--output-dir` for a no-write reconciliation. The
stager uses the canonical public merge as its attribution/quarantine gate,
keeps every canonical evidence and operational-ledger row unchanged, performs
batch/company/platform physical deduplication against both canonical evidence
and existing reviews, and writes new rows with
`publicationPolicy: "stored_but_unpublished"`. It emits separate accepted,
adapter-rejected, and deduplicated ledgers plus exact per-platform and per-batch
counts. A journal whose final event is not `run_completed`, whose summary is
not completed, or whose evidence attribution differs from its target is a hard
failure.

`npm run ingest:coverage:materialize -- --manifest=<campaign.json> --output=<coverage.json>`
builds the measured coverage matrix. It exits `2` after writing when either the
production release or full ingestion objective is incomplete. Use
`--allow-incomplete` only for an audit that must return exit code `0`.

The CLI does not scan a directory or interpret row counts as success. Every
input is named in `ingestion-coverage-campaign.v1`, bounded before it is read,
and checked against its declared SHA-256 digest. Paths must be relative to the
manifest and cannot escape that directory, including through symlinks.

```json
{
  "schemaVersion": "ingestion-coverage-campaign.v1",
  "runId": "run-id",
  "idempotencyKey": "durable-run-key",
  "campaignKey": "cross-run-campaign-key",
  "generatedAt": "2026-08-02T18:31:00.000Z",
  "coverageGeneratedAt": "2026-08-02T18:30:30.000Z",
  "manifestObservedAt": "2026-08-02T18:31:00.000Z",
  "artifacts": {
    "catalogs": { "path": "catalogs.json", "sha256": "<64 hex>", "observedAt": "2026-08-02T18:31:00.000Z", "format": "json" },
    "expectedCatalogManifest": { "path": "expected.json", "sha256": "<64 hex>", "observedAt": "2026-08-02T18:31:00.000Z", "format": "json" },
    "taskPlan": { "path": "tasks.ndjson", "sha256": "<64 hex>", "observedAt": "2026-08-02T18:31:00.000Z", "format": "ndjson" },
    "runnerLog": { "path": "runner.ndjson", "sha256": "<64 hex>", "observedAt": "2026-08-02T18:31:00.000Z", "format": "ndjson" },
    "collectors": [
      { "kind": "public", "path": "public-s26.json", "sha256": "<64 hex>", "observedAt": "2026-08-02T18:29:00.000Z", "format": "json" }
    ],
    "supporting": [
      { "kind": "public_s26_shard_0", "path": "supporting/public-s26-shard-0.json", "sha256": "<64 hex>", "observedAt": "2026-08-02T18:29:00.000Z", "format": "json" }
    ],
    "historicalBackfills": [
      {
        "journal": { "path": "history/pages.ndjson", "sha256": "<64 hex>", "observedAt": "2026-08-02T18:29:00.000Z", "format": "ndjson" },
        "completionProofs": { "path": "history/completion-proofs.json", "sha256": "<64 hex>", "observedAt": "2026-08-02T18:29:00.000Z", "format": "json" },
        "limits": { "maxEvents": 250000 }
      }
    ],
    "pairScopes": { "path": "pair-scopes.json", "sha256": "<64 hex>", "observedAt": "2026-08-02T18:30:00.000Z", "format": "json" },
    "multiAttributionReviews": { "path": "attribution-reviews.json", "sha256": "<64 hex>", "observedAt": "2026-08-02T18:30:00.000Z", "format": "json" },
    "releaseProofs": { "path": "release-proofs.json", "sha256": "<64 hex>", "observedAt": "2026-08-02T18:31:00.000Z", "format": "json" }
  }
}
```

`pairScopes`, `multiAttributionReviews`, `releaseProofs`, and
`historicalBackfills` are optional. Missing proof never becomes success.
Historical completion is accepted only through the historical adapter's exact
artifact-bound completion proof; source exhaustion or a numeric count is not
enough.

`coverageGeneratedAt` is the fresh receipt timestamp associated with the
collector run. `generatedAt` is the later materialization timestamp, so build,
deployment, and production-sample receipts can be captured after collection
without weakening the receipt's current-run freshness checks.

The release proof file uses four independent
`ingestion-production-release-proof.v1` receipts:

- `expectedManifest` with status `verified` and the independently supplied
  expected-manifest digest;
- `productionArtifact` with status `rebuilt`, artifact digest, and revision;
- `productionSample` with status `verified`, the same artifact digest and
  revision, and explicit verified sample rows covering every canonical batch
  and supported core platform;
- `deployment` with status `verified`, `environment: "production"`, and the
  same artifact digest and revision.

Each receipt also requires `receiptId`, canonical `checkedAt`, `toolVersion`,
and an exact operational `reason`. The full coverage objective independently
requires every supported core pair to carry recent, historical,
stored-unpublished, scheduler, and duplicate/attribution/timestamp/scoring
integrity receipts. Documented technical blockers are reported as
`blocked_with_next_actions`; they never become `objectiveComplete`.
