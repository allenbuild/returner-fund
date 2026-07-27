# V5 migration and rollback

Status: **no production migration authorized**.

## Current state

- Production remains on deterministic V4, now
  `returner-traction@4.0.1` (`returner-traction-v4-monotonic`).
- `returner-traction@4.0.0` remains the immutable rollback target.
- Research artifact `traction-post-forecast-v5@5.0.0-research` is immutable,
  rejected for insufficient data, and supports no platform.
- No database model-version row, backfill, public graph, benchmark history, API
  scoring path, or browser scoring path was changed to V5.
- Historical V4 score interpretation and rollback code remain intact.

## Promotion plan for a future accepted version

1. Freeze a new target/source/feature/experiment manifest before final-test access.
2. Produce a clean, byte-identical accepted artifact with source, data, split,
   model, calibration, uncertainty, evaluation, registry, code, and dependency hashes.
3. Dual-score an identical cohort at an identical evidence cutoff without
   changing the V4 result.
4. Compare V5 only to V4 replayed against that same evidence and cohort; never
   compare deltas across versions.
5. Register the accepted V5 version immutably, with its target and supported
   platform list. Keep the rejected `5.0.0-research` artifact unchanged.
6. Backfill post outputs first. Backfill company outputs only if a separate
   company target and aggregation gate passed.
7. Regenerate static artifacts only from a stable canonical evidence tree, run
   the artifact validators, then atomically update API and UI model labels.
8. Observe parity, latency, calibration, subgroup, missing-data, and unsupported
   platform telemetry before making V5 the default.

## Rollback

Rollback from `4.0.1` selects the preserved `4.0.0` model row and matching
static artifacts; it never rewrites either version's history. A future V5
rollback likewise selects preserved V4 implementation and V4-matched static
artifacts. It does not rewrite V5 artifacts, reinterpret V5 probabilities as V4
indices, or compare cross-version momentum. Any score history rendered under a
different version must retain its model ID, version, evidence cutoff, cohort,
and target semantics.

## Public artifact decision in this worktree

Public graphs were not regenerated. Canonical evidence was being modified by a
concurrent source-discovery process, and the internal audit found that the public
manifest already described an earlier graph generation. Regenerating from this
moving state would violate the shared-worktree and provenance requirements.
