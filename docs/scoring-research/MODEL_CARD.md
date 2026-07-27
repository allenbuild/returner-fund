# Model card: traction-post-forecast-v5@5.0.0-research

## Model status

**Rejected for insufficient data. Experimental artifact only.** This artifact is
not served as a production score, supports no platform, contains no fitted
platform model, and has no company aggregation. Production remains
`returner-traction@4.0.1`; immutable `returner-traction@4.0.0` is retained as
the rollback path.

## Intended use

The V5 pipeline is intended to train and evaluate a deterministic post-level
forecast after compatible longitudinal data is legally accepted and registered.
A future accepted model may rank posts and display a calibrated probability of a
specific future platform-native event. The current rejected artifact is intended
only for provenance validation, deterministic pipeline development, leakage and
manipulation tests, and prospective collection planning.

## Prohibited interpretations

Neither V4 nor this V5 research artifact establishes company quality, causality,
valuation, investment return, durable business success, fair treatment outside
tested subgroups, cross-platform equivalence, or resistance to purchased/bot
engagement. The rejected artifact has no predictive performance claim.

## Target and unit

The unit is one canonical physical native object. Social objects use the same
documented native counter at `t0` and seven-day `t1`; GitHub uses repository
stars at 28 days. Growth is `log1p(counter_t1) - log1p(counter_t0)`. The positive
event is strict growth above the platform's training-only nearest-rank 80th
percentile. Validation and final test reuse the frozen threshold.

Only genuine observations inside the registered tolerance are eligible.
Developing, deleted, private, hidden, missing, interpolated, future-dated, and
unknown-publication-time cases are censored, quarantined, or unscored according
to `TARGET_SPEC.md`; they are never silently converted to negative or to a
guessed age.

## Platform coverage

Validated V5 coverage is **none**. X, LinkedIn, Instagram, GitHub, Product Hunt,
YouTube, Reddit, Hacker News, Bilibili, TikTok, Bluesky, RSS, and Web are
explicitly unsupported by the generated artifact. Bluesky, TikTok, RSS, and Web
have no registered target. Unsupported inputs return a structured unscored
result; there is no generic or X-weight fallback.

## Training and evaluation data

No external or internal source was accepted into the checked-in run. The
canonical dataset has zero rows and no source hashes. The local longitudinal
audit found 649 adjacent candidates across graph history, only 127 with a
changed comparable counter, five seven-day candidates, no 30-day candidates,
and no three independent temporal populations. These rows are audit evidence,
not training examples. V4 benchmark histories were excluded because using them
as targets would be circular.

## Research reviewed

The versioned registry screens 25 sources across X RecSys challenges, cascade
prediction, Reddit, GitHub, learning to rank, probability calibration,
conformal uncertainty, and monotonic modeling. It records identifiers,
publication status, task, unit, horizons, metrics, availability, licenses,
access dates, artifact hashes, compatible/incompatible features, decisions, and
reasons.

Registry decisions: 11 accepted protocols, one conditional dataset (GH
Archive), one conditional method, nine rejected datasets, and three screen-only
sources. A protocol decision is not dataset permission. No source is marked
implemented and `incorporated_count` is zero. The independent incorporation red
team therefore fails genuine incorporation while passing the narrower
anti-overclaim check.

## Accepted and rejected sources

No source is accepted as a training dataset. GH Archive is only conditional on
legal review, exact hourly-object manifests/hashes, schema handling, repository
identity, and held-out temporal/entity tests. RecSys 2020/2021 are rejected for
this target because they predict personalized reader–Tweet engagement and need
reader/exposure features absent in production. Cascade datasets/models are not
usable without timestamped reshare paths and verified licensing. Screened
Reddit sources fail legal, license, horizon, split, language/domain, or production
feature gates. Current GitHub research supports keeping stars and forks separate
but does not provide a transferable accepted model. Exact source-by-source
decisions are in `source-registry.json` and `SOURCE_REGISTRY.md`.

## Feature schema

The implemented candidate scaffold accepts platform-routed `log1p` native
counters, explicit missingness, and exact post/repository age. Counts such as
views, reactions, comments, replies, reposts, quotes, upvotes, stars, forks,
issues, and watchers remain separate. The broader pre-registration permits
future genuine prior-observation velocity, calendar-time features, and strictly
`t0`-derived recent-commit features, but they are not implemented or claimed in
this artifact. Missing is not zero.

Excluded from the feature matrix: company/founder/author identity, exact handle,
batch, group partner, Top Voice membership, Topic, Vertical, Industry, current
rank, V4/V5 scores, V4 formula components, investor identity, graph edges,
future observations, target-window values, mutable current age, and named-company
flags. Audience size and content features require separately registered
candidates and ablations; the primary candidate excludes them.

## Preprocessing and duplicate controls

Rows are canonically sorted. Source admission is registry-checked before a file
is read, and accepted source bytes must match SHA-256. Equal-priority metric
disagreements quarantine rather than average. Physical native identity and a
content-fingerprint leakage group cannot cross temporal splits. Exact
publication time is required for age-aware models. Preprocessing and platform
target thresholds fit training only.

## Candidate model family and search

The frozen finite grid contains an equal-log-sum baseline, an age-only logistic
candidate, metric-only nonnegative logistic candidates with L2 values 0, 0.01,
0.1, and 1, and metric-plus-age candidates with L2 values 0.01 and 0.1. Native
counter coefficients are projected nonnegative and age nonpositive. CPU loops,
stable ordering, fixed iteration counts, and fixed tie-breakers are used; no GPU,
random hyperparameter search, or external model service is involved.

Selection is validation NDCG@50 descending, validation log loss ascending,
complexity ascending, then stable candidate ID. The promised one-standard-error
refinement is not implemented and blocks acceptance. Final-test metrics cannot
change the selected candidate.

## Selected model and learned parameters

None. Zero platforms contain all outcome classes in every frozen split, so no
candidate was selected and no coefficient, spline, tree, marginal-effect curve,
platform combination, recency curve, or post/company pooling parameter was
fitted. The candidate grid is an experimental mechanism, not a learned result.

## Calibration

The research implementation can fit a nonnegative-slope Platt calibrator using
validation predictions only. It does not yet implement the pre-registered
comparison with uncalibrated, beta, and isotonic alternatives, so calibration is
an unconditional acceptance blocker. The rejected artifact must not be labeled
as a calibrated probability.

## Uncertainty

Evaluation code uses 10,000 deterministic entity-clustered bootstrap replicates
with seed `20260720`. With no held-out rows, it emits no performance interval.
Per-prediction statistical intervals and conformal coverage are unsupported.
Evidence coverage, freshness, source reliability, link verification, missingness,
and publication precision remain separate and are not added to a score.

## Splits and leakage controls

Prospective `t0` periods in America/Chicago are training 2026-07-21 through
2026-09-14, validation 2026-09-15 through 2026-10-12, and final test 2026-10-13
through 2026-11-09. A deterministic SHA-256 20% entity holdout is excluded from
fitting/calibration and evaluated only in the final-test period. Canonical
physical/content duplicates and later observations of the same object cannot
cross partitions. Collector batch is retained as audit metadata and excluded
from features, but the frozen scaffold does not group an entire collector batch
into one partition; leave-one-batch-out checks remain planned development work.
Training-only thresholding and validation-only selection and calibration prevent
final-test leakage.

## Evaluation, performance, and calibration results

The gate decision is `reject`, reason: no platform has compatible rows with both
outcome classes in every frozen split. There are no exact held-out NDCG, MAP,
pairwise, correlation, PR-AUC, ROC-AUC, log-loss, Brier, ECE, reliability,
known/unseen-company, cross-batch, or temporal-generalization results. Reporting
zeros would falsely imply an evaluated population.

## Subgroup and fairness results

None. Platform, batch, vertical, topic, company/account size, geography,
evidence coverage, age, and source-provider slices lack an accepted held-out
population. The artifact makes no fairness or non-inferiority claim.

## Ablations and robustness

The test suite exercises order invariance, source reversal, fixed-clock
determinism, split isolation, duplicate handling, content-fingerprint leakage,
missing-versus-zero semantics, exact publication time, future-observation
rejection, unsupported platform/date behavior, monotonic predictions, artifact
hashing, selection independence from final test, and TypeScript inference parity.

Data-dependent ablations—metric-family removal, audience/content/age/platform
removal, pooling alternatives, multi-platform behavior, held-out rank movement,
calibration, and subgroup effects—cannot be run without accepted populations and
remain acceptance blockers.

## Manipulation tests

Structural safeguards reject or keep separate duplicate rows, malformed native
identity, missing dates, later observations, unsupported platforms, and missing
metrics. Constrained counters cannot reduce prediction in experimental fixtures.
No claim is made about bot bursts, purchased-like patterns, reply spam, enormous
accounts, privacy-hidden metrics, or stale-lower corrections on real held-out
data; those scenarios require the registered population and measurable features,
not hand-picked penalties.

## Privacy and licensing

Restricted raw data is not committed. Source rows must pass explicit registry
decision, license/redistribution, citation, exact-use/evidence, and content-hash
checks. `conditional_dataset` is never trainable; admission requires the explicit
`accepted_dataset` decision. Training and evaluation run offline after source
registration. Identity values are grouping/audit metadata and excluded from the
feature matrix.

## Determinism and environment

Pinned runtime metadata: Node 24.14.0, UTC, `en-US`, fixed seed `20260720`, CPU
only, network not required after registration. The dependency lock hash, registry
hash, input manifest hash, source hashes, training-data hash, split hash, model
hash, and evaluation hash are exported. The default runner executes twice and
requires byte identity before writing.

## Artifact hashes

- model: `481d9fb9b652b8a564c7c99f0bdd2afe1c3edb4ed899f701184907c15bd23377`
- evaluation: `89d29dd402a72aae1ca9f19e44b2398c42c379df77b09efd15a423eece42c862`
- candidate search: `bd49340a15ffa8da0b637fe6fa8bfe159bcbc4fc816b60ac09f327dd8934925d`
- canonical dataset: `eaf4a00732c3a03325aab1cd29b8d547bfb1fa504fdd1474fa72690bcb163bd8`
- split manifest: `bd05d5253fe39ffc6ce456cf8985453da9b7ccd643706bc6305dd4759407a1a2`
- export manifest: `95b136a1acc23ecebc548d237667961d95d0607fefd68c2f84d26117bfeb2e1b`
- reproducibility report: `cce91c4741e32c0b9be25658a2510294aedfbaf93991360cba8cce0de6ccd37b`
- research registry: `612d28b9597adc4ed9966615554c6ce0327cc8d1ddf4c025bd33a2ebc1f060bb`

Executable V5 runner/source/test snapshot:
`sha256:64a83e80d9e83e6f9bda1a4f2b4789a83e6081e2173875da57382668f889d0e4`.

## Runtime integration

`src/lib/scoring/v5/inference.ts` consumes compact JSON model artifacts and
returns structured scored/unscored output. The checked-in artifact always
returns unscored because it contains no platform model. Production graph build,
API scoring, public static artifacts, and browser bundles still use V4; no Python,
notebook, network, LLM, or hosted model is required at runtime.

## Migration and rollback

No V5 production migration was performed. No V4 definition or historical score
was rewritten. Future promotion requires a new immutable accepted artifact,
dual-scoring comparison on identical evidence/cohort cutoffs, version-labeled
API/UI responses, replay/backfill and static-artifact plans, and protections
against comparing deltas across model versions. Rollback retains V4 and its
matching static artifacts.

## Reproduction commands

```bash
npm run scoring:research:validate
npm run scoring:v5:validate
npm run scoring:v5:reproduce
npm run scoring:v5:parity
npm run scoring:v5:audit
```

The full runner atomically builds data, splits, labels, candidates, calibration,
evaluation, model/export manifests, and a second byte-identity execution. See
`scripts/scoring-v5/README.md` and `INDEPENDENT_REPRODUCTION.md`.

## Known limitations and next evidence required

Collect the pre-registered prospective periods with append-only `metric_observations`,
real `t0/t1` capture lineage, immutable source hashes, non-selected/censored
objects, exact GitHub creation age, and salted author/account grouping metadata.
Implement the required author-group leakage and concentration gate before any
dataset can be accepted. Legally promote and actually incorporate
compatible sources with source-specific evidence. Then implement the remaining
V4 replay, one-standard-error, calibration-family, weekly-macro, reliability,
subgroup/fairness, latency, manipulation, and per-prediction uncertainty gates.

The parameters of any future accepted model will be predictive associations for
the stated target, not causal estimates of company quality or investment
outcomes.
