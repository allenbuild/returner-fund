# Scoring model V5

Status: **research artifact rejected for insufficient data; not a production model**
Artifact ID: `traction-post-forecast-v5@5.0.0-research`
Target protocol: `returner-post-performance-v5-prereg-2026-07-20`
Production default and rollback: `returner-traction@4.0.0` (`returner-traction-v4-canonical`)

## Executive decision

V5 was not promoted. No screened external dataset cleared the legal-access,
target-compatibility, production-feature, hashing, and temporal-split gates, and
the repository does not contain enough genuine longitudinal `t0 -> t1`
observations to form independent training, validation, calibration, and final
test populations. The deterministic pipeline therefore emits
`rejected_insufficient_data`, supports no platform, produces no fitted platform
parameters, and leaves company aggregation unsupported.

This is the intended fail-closed outcome. No V4 coefficient, post-slot vector,
platform weight, half-life, missing-date prior, confidence rule, or cohort blend
was relabeled as learned V5 behavior.

## Target

For each supported platform, a future accepted model would estimate the
probability that one canonical physical native object exceeds the training-only
nearest-rank 80th percentile of:

```text
log1p(platform-native counter at t1) - log1p(the same counter at t0)
```

Social horizons are seven days with a 12-hour tolerance. GitHub uses repository
star growth at 28 days with a 24-hour tolerance. Only observations and features
available at `t0` are allowed. Thresholds are fitted from training rows only and
frozen for validation and final test. A 0–100 probability label is permitted
only after the pre-registered calibration gates pass.

The full target, prospective periods, support thresholds, split controls,
metrics, calibration rules, and acceptance decision are in
[`scoring-research/TARGET_SPEC.md`](scoring-research/TARGET_SPEC.md). The exact
feature boundary is in [`scoring-research/FEATURE_SPEC.md`](scoring-research/FEATURE_SPEC.md).

## Data decision

The internal audit found 3,695 canonical units across 52 committed graph
revisions, but only 474 units had multiple readings and only 127 of 649 adjacent
pairs changed a comparable native counter. There were five seven-day candidate
pairs, no 30-day pairs, and no three independent temporal populations. Current
company benchmark histories are V4-derived and would be circular labels.

The research registry screened 25 sources. It records 11 accepted protocols, one
conditional dataset (GH Archive), one conditional method, nine rejected
datasets, and three screen-only sources. **Zero sources are claimed as genuinely
incorporated**, and the checked-in training manifest has no accepted sources.
That failure is explicit in
[`scoring-research/RED_TEAM_INCORPORATION.md`](scoring-research/RED_TEAM_INCORPORATION.md).

## Deterministic pipeline

The offline TypeScript pipeline provides:

- strict source-registry, decision, citation, license, and SHA-256 admission;
- exact `t0`/`t1` native-counter rows with missing distinct from zero;
- canonical physical-object and content-fingerprint split protection;
- prospective time splits and a deterministic SHA-256 unseen-entity holdout;
- training-only platform thresholds;
- a frozen equal-log-sum and constrained-logistic candidate grid;
- nonnegative native-counter effects and a non-increasing age coefficient;
- validation-only selection and Platt calibration;
- an untouched final-test path and deterministic entity-clustered bootstrap;
- compact JSON artifacts and TypeScript runtime inference parity;
- byte-identical double execution before artifacts are written.

The checked-in default run has zero rows, so these are tested research mechanics,
not evidence of predictive validity.

## Current artifact result

| Field | Result |
| --- | --- |
| Gate decision | `reject` |
| Status | `rejected_insufficient_data` |
| Supported V5 platforms | none |
| Fitted platform models | none |
| Company V5 aggregation | unsupported |
| Feature schema | `scoring-v5-features-v3` |
| Model artifact schema | `scoring-v5-model-artifact-v2` |
| Test used for selection | false |
| Bootstrap | 10,000 entity-clustered replicates, seed `20260720` |
| Per-post statistical interval | unsupported |

Because there are no accepted rows, there are no held-out performance,
calibration, subgroup, fairness, ablation, or V4-comparison estimates to report.
Zero-valued placeholder metrics would be misleading and are not emitted.

## Artifact hashes

| Artifact | SHA-256 |
| --- | --- |
| Model | `481d9fb9b652b8a564c7c99f0bdd2afe1c3edb4ed899f701184907c15bd23377` |
| Evaluation | `89d29dd402a72aae1ca9f19e44b2398c42c379df77b09efd15a423eece42c862` |
| Candidate search | `bd49340a15ffa8da0b637fe6fa8bfe159bcbc4fc816b60ac09f327dd8934925d` |
| Canonical dataset | `eaf4a00732c3a03325aab1cd29b8d547bfb1fa504fdd1474fa72690bcb163bd8` |
| Split manifest | `bd05d5253fe39ffc6ce456cf8985453da9b7ccd643706bc6305dd4759407a1a2` |
| Export manifest | `95b136a1acc23ecebc548d237667961d95d0607fefd68c2f84d26117bfeb2e1b` |
| Reproducibility report | `cce91c4741e32c0b9be25658a2510294aedfbaf93991360cba8cce0de6ccd37b` |
| Research registry | `612d28b9597adc4ed9966615554c6ce0327cc8d1ddf4c025bd33a2ebc1f060bb` |

Executable V5 runner/source/test snapshot:
`sha256:64a83e80d9e83e6f9bda1a4f2b4789a83e6081e2173875da57382668f889d0e4`.

`artifacts/scoring-v5/generated/reproducibility.json` records byte identity for
both in-process executions. The independent clean-directory reproduction report
is written separately after its release-gate run.

## Product behavior

- The graph and leaderboard continue to show immutable V4 scores and V4 model
  labels.
- Ranked Posts uses the graph's canonical V4 per-evidence score because V5 did
  not clear its gate; it does not present the result as a forecast.
- The Stats and public methodology surfaces state that V5 is unpromoted, has no
  validated platform coverage, and that an unsupported V5 row is unscored.
- Topic, Vertical, Platform, Top Voice, Industry, Group Partner, and minimum-score
  controls remain visibility filters. They never refit or mutate canonical
  scores.
- Map connections explain graph relationships only and never add score points.

## Migration and rollback

There is no production V5 migration or backfill to apply. Historical V4 scores
and artifacts remain unchanged. A future accepted V5 release must use a new
immutable version, dual-score an identical cohort/evidence cutoff, replay
history under one version before comparing deltas, publish its model and source
hashes, and update the API/UI version label atomically. Rollback is selection of
the preserved V4 model and matching V4 artifacts; V5 research artifacts are not
valid rollback inputs.

Public graph artifacts were intentionally not regenerated during this work
because concurrent source-discovery changes were modifying canonical evidence,
and the current public manifest was already stale relative to those graph bytes.

## Reproduction

With the pinned Node runtime on `PATH`:

```bash
npm run scoring:research:validate
npm run scoring:v5:validate
npm run scoring:v5:reproduce
npm run scoring:v5:parity
npm run scoring:v5:audit
```

Source acquisition, if any source is later accepted, must occur separately.
Training/evaluation runs network-free from registered, hashed artifacts.

## Acceptance blockers

The following remain unconditional blockers, not future polish:

- no legally and scientifically accepted longitudinal training dataset;
- required author/account grouping metadata and its leakage/concentration gate are not yet implemented;
- no source-specific reproduced protocol or benchmark baseline;
- no registered V4 replay comparison on the same untouched final test;
- one-standard-error model-selection refinement is pending;
- the frozen calibration-family comparison is pending;
- weekly-query macro evaluation, reliability-bin, subgroup, fairness, and
  latency gates are pending;
- per-post statistical uncertainty is unsupported;
- no pre-registered company future target or learned company aggregation exists.

The parameters of any future accepted artifact will be predictive associations
for its stated target, not causal estimates of company quality or investment
outcomes.
