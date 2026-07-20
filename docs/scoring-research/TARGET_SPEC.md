# V5 Target Specification

Status: **pre-registered protocol; no V5 model is accepted by this document**
Protocol ID: `returner-post-performance-v5-prereg-2026-07-20`
Frozen on: `2026-07-20`
Time zone for collection periods and product "Today": `America/Chicago`
Internal-data finding: the current repository does not contain enough leakage-safe, temporally separated longitudinal outcomes to train, select, calibrate, and test this target. See `INTERNAL_DATA_AUDIT.md`.

## Decision

V5 will predict a future platform-native outcome from a real metric observation at `t0`. It will not try to learn the existing V4 traction score, use a same-time metric as its own label, or learn a preferred company ordering.

The production post score, if and only if every gate below passes, is:

> **100 × the calibrated probability that the physical post or repository will be in the top 20% of future native-outcome growth for its platform at the registered horizon.**

This is a predictive association for the specified event. It is not company quality, investment merit, causal impact, or a universal exchange rate among likes, comments, reposts, views, stars, and forks.

Current internal data cannot support this probability interpretation. Until a candidate clears the gate, V4 remains the versioned baseline/rollback path and V5 outputs must be absent or explicitly experimental and unscored.

## Unit, identity, and attribution

The unit is one **physical platform-native object**:

- social platform: native post, video, story, or launch;
- Hacker News or Reddit: native submitted item, not an arbitrary comment fragment;
- GitHub: repository, not an account total, commit, pull request, or release mixed with repository adoption;
- no profile, search page, website, RSS item, or generated context row.

Identity is the repository's canonical platform-native object identity, with this priority:

1. normalized platform plus validated native object ID;
2. normalized platform plus canonical native URL;
3. no fallback based only on author, title, text, company, or timestamp is allowed in a training set.

Every representation of the same canonical object stays in one split. Company/founder attribution is retained only for grouping, leakage auditing, and product navigation. Attribution is not a prediction feature.

## Timestamps

For every row:

- `published_at`: real native publication time; its precision is recorded separately;
- `t0`: the metric observation timestamp, never `last_updated_at`, file modification time, score-run time, link-check time, or graph-build time;
- `H`: registered platform horizon;
- nominal `t1 = t0 + H`;
- selected outcome observation: the earliest genuine observation in `[t1 - tolerance, t1 + tolerance]`;
- `as_of`: the inclusive feature cutoff, equal to `t0`.

One dataset build emits at most one supervised row per canonical object. It chooses the earliest eligible `t0` in that build's registered collection period for which an eligible `t1` exists. Alternative anchors may be evaluated only as a separately registered dataset version; they may not create correlated duplicates across splits.

An observation is genuine only when a versioned collector artifact or append-only `metric_observations` row proves the metric value and `observed_at`. `first_seen_at` may establish discovery time, but is not automatically a metric observation. `last_updated_at`, GitHub `pushedAt`, publication time, a source-import time, and a graph generation time do not prove a metric reading.

## Platform targets and horizons

Counts remain separate. No manual scalar combines reaction, reply, reshare, save, or view labels.

| Platform | Native outcome `Y` | Horizon | Tolerance | Present internal status |
| --- | --- | ---: | ---: | --- |
| X | native post views/impressions | 7 days | ±12 hours | unsupported for V5 training: only a few aligned internal pairs |
| YouTube | video views | 7 days | ±12 hours | unsupported for V5 training |
| Instagram | video plays/views, only after one canonical counter is proven consistent | 7 days | ±12 hours | unsupported; current rows mostly expose likes, not longitudinal plays |
| LinkedIn | native impressions | 7 days | ±12 hours | unsupported; impressions are not present |
| Reddit | native submission score/upvotes | 7 days | ±12 hours | unsupported; no changed aligned outcomes |
| Hacker News | native item points | 7 days | ±12 hours | unsupported; sample is too small |
| Product Hunt | launch upvotes | 7 days | ±12 hours | unsupported; sample is too small |
| GitHub | repository stars | 28 days | ±24 hours | unsupported; no 28-day pairs and no three temporal waves |
| Bilibili | native video views | 7 days | ±12 hours | unsupported; no internal history |
| Bluesky | none registered | — | — | unsupported |
| TikTok | none registered | — | — | unsupported |

The platform counter must have the same documented meaning at `t0` and `t1`. Aliases may be canonicalized only when platform documentation or captured payload lineage proves semantic equivalence. The model must not route an unsupported platform through another platform's parameters.

## Outcome and high-performance event

For a platform's registered native counter:

```text
growth = log1p(Y at t1) - log1p(Y at t0)
```

Using training rows only, calculate the deterministic nearest-rank 80th percentile of `growth` independently for each platform. Store that numeric threshold in the target manifest. The binary outcome is:

```text
high_performance = 1 if growth > training_platform_q80 else 0
high_performance = 0 otherwise
```

Strict `>` is intentional and makes ties at the threshold negative. The training base rate may therefore be below 20%; it must be reported. Validation and test use the frozen training threshold. The quantile is never recomputed per batch, cohort, company, browser filter, or product request.

If an accepted benchmark has a legally accessible, pre-defined future outcome but cannot express this repository target, it may be used for representation or protocol comparison, not silently pooled as labels. A different target requires a new protocol ID before its test labels are opened.

## Incomplete, missing, deleted, and corrected outcomes

- No `t1` in the registered tolerance window: right-censored/incomplete; exclude from supervised labels and report it.
- Post too new to complete `H`: developing; never label negative.
- Deleted/private/unavailable at `t1`: censored with a reason, not a zero. Deletion may be modeled separately only under a new pre-registration.
- Counter hidden at either endpoint: missing, not zero.
- Estimated or interpolated counter: excluded from primary training and test.
- Counter decreases: retain only if both captures have verified lineage; mark `counter_decrease=true` and include in a correction/deletion sensitivity analysis. Otherwise quarantine.
- Future-dated observation, observation before publication, or invalid timestamp: reject.
- Missing or `unknown` publication date: exclude from the primary age-aware model. A recency-free candidate may score it only after its own held-out gate passes.
- Day-precision publication date: excluded from the primary model unless interval-censored age handling is implemented and pre-registered. Never substitute noon or midnight as though exact.

## Feature and label separation

Only information with timestamp `<= t0` may enter features. The target counter at `t0` may be a feature; its `t1` value, its growth, and any artifact derived after `t0` are forbidden.

Forbidden fields include:

- future/later metric observations and outcome-window counters;
- current or future V4/V5 scores, ranks, percentiles, calibrations, and score explanations;
- company/founder identity, exact handle, account ID, batch, group partner, Top Voice status, or investor identity;
- Topic, Vertical, and Industry labels;
- named-company indicators or expected-quality labels;
- graph degree or any edge/node surface computed using post-`t0` data;
- collector success/failure fields written after `t0`;
- GitHub `pushedAt`/`updatedAt` used as repository creation age;
- final rank, high-performance label, or threshold encoded into text/features.

The full allowed schema is in `FEATURE_SPEC.md`.

## Platform comparability

Models are evaluated and calibrated per platform first. A platform score becomes comparable only when its validation and final-test calibration gates pass for the same event semantics above.

The common 0–100 output is a probability scale, not a percentile. A platform that passes ranking but fails calibration remains experimental and must display a platform percentile or raw prediction under a different label; it cannot enter the common score. Cross-platform pooling, platform weights, and breadth bonuses are prohibited unless a separately trained entity-level target validates them.

## Company score

No company-level V5 target is currently supported. The score benchmark histories are V4-derived score snapshots and would make a circular label. They are not evidence that post probabilities add to company performance.

Post probabilities must not be summed, averaged, top-k weighted, or combined across platforms as a production V5 company score until the repository has a separately pre-registered future company outcome and leakage-safe entity histories. Any interim company aggregation must remain the explicitly labeled V4 baseline or an experimental transparent baseline behind a feature flag.

## Prospective collection periods

The current historical rows are audit/development material only. The first eligible prospective evaluation uses these immutable Central-time `t0` periods:

| Partition | `t0` period, America/Chicago | Purpose |
| --- | --- | --- |
| Training | 2026-07-21 00:00:00 through 2026-09-14 23:59:59.999 | fit preprocessing and model candidates |
| Validation | 2026-09-15 00:00:00 through 2026-10-12 23:59:59.999 | select model and calibration; freeze acceptance inputs |
| Final test | 2026-10-13 00:00:00 through 2026-11-09 23:59:59.999 | one final evaluation only |

Outcome collection must continue through `2026-11-17 11:59:59.999 America/Chicago` for seven-day targets and through `2026-12-08 23:59:59.999 America/Chicago` for the GitHub tolerance window. A missed capture window is not repaired with a later current total.

If prospective collection does not start on schedule, these boundaries do not slide automatically. Publish a new protocol ID before collection resumes.

## Split controls

- Split assignment is based on `t0`, then all representations and later observations of that canonical object inherit its split.
- No canonical post appears in more than one split.
- No content-fingerprint duplicate may cross splits; uncertain cross-posts remain separate platform objects but share a leakage-audit group.
- Preprocessing fits training only.
- Hyperparameters and target thresholds use training/validation only.
- Calibration uses out-of-fold training predictions or validation predictions, never final test.
- Final test is read once after the candidate, calibration family, thresholds, and report code are frozen.
- Primary evaluation is temporal and may contain previously seen companies.
- Secondary unseen-company evaluation removes a deterministic 20% company holdout, assigned by the first byte of `SHA-256("v5-company-holdout\0" + canonical_company_id)` being `< 51`, from all fitting and calibration; only its final-test-period rows are evaluated.
- Leave-one-batch-out development checks rotate S2026, S26, and A16ZSR006, but none substitutes for the temporal final test.
- Named-company inspection occurs only after selection and cannot change it.

## Minimum support gate

A platform remains unsupported unless, after all leakage and provenance exclusions, it has at least:

- training: 2,000 labeled physical objects, 100 companies/accounts, and 200 positives;
- validation: 500 labeled objects, 50 companies/accounts, and 50 positives;
- final test: 500 labeled objects, 50 companies/accounts, and 50 positives;
- unseen-company final test: 200 labeled objects, 20 companies, and 20 positives;
- at least three independent collector waves in every partition;
- at least 95% of rows with hashed source lineage and an exact `t0`;
- no single company/account supplying more than 10% of a partition.

These are support gates, not score coefficients. Falling short leaves the platform unscored; platforms are not pooled merely to clear a count.

## Evaluation

Primary metric: macro-average platform **NDCG@50** on final-test `high_performance`, with each supported platform weighted equally. Within-platform queries are Central calendar weeks of `t0`; queries with no positive outcome are reported and excluded from NDCG aggregation by a frozen rule.

Secondary metrics:

- NDCG@10, MAP, pairwise accuracy;
- Spearman and Kendall correlation with continuous `growth`;
- precision-recall AUC and ROC AUC;
- log loss, Brier score, and expected calibration error (10 deterministic equal-frequency bins);
- top-10/top-50 overlap;
- known-company and unseen-company results;
- batch, account-size, post-age, coverage, platform, topic, vertical, and industry slices (the last three are evaluation metadata only);
- missingness, duplicates, counter corrections, and source-provider slices.

## Deterministic model selection

Before final test is opened:

1. Reject candidates with leakage, nondeterminism, unsupported features, monotonicity failures, or invalid licenses.
2. Select the highest validation macro NDCG@50 from the frozen finite search.
3. Treat candidates within one bootstrap standard error of that maximum as tied.
4. Among tied candidates, choose lowest validation log loss.
5. If still tied within `1e-12`, choose fewer fitted parameters, then smaller artifact bytes, then lexicographically smaller stable model ID.

No named company, product screenshot, final-test metric, or preferred rank may alter this rule.

## Calibration

Calibration candidates are uncalibrated, Platt/logistic, beta, and isotonic. Their implementations, clipping, and grids must be frozen before validation evaluation. Fit on out-of-fold training predictions or validation as declared in the experiment manifest. Select by validation log loss, then Brier score, then ECE, then the simplicity order `uncalibrated < Platt < beta < isotonic` when differences are within `1e-12`.

A probability-labeled score requires all of:

- ECE `<= 0.05` on final test;
- Brier score below the constant training-base-rate predictor;
- finite log loss with probabilities clipped only for numerical evaluation at `[1e-6, 1 - 1e-6]`;
- no platform reliability-bin absolute gap greater than `0.10` in a bin with at least 50 examples.

If calibration fails, do not call the output a probability.

## Uncertainty

Evaluation uncertainty uses 10,000 paired, company-clustered bootstrap resamples with seed `20260720`, stable company ordering, and a documented counter-based RNG. Report percentile 95% intervals. Model-selection bootstrap uses validation only.

Per-post uncertainty may use deterministic fold-ensemble disagreement or a separately validated conformal method. Coverage, missingness, freshness, link verification, and date precision remain separate fields; none is added to the score or called a confidence interval.

## Final acceptance gate

V5 replaces V4 for a supported platform only if all applicable conditions pass:

- every source is registered, licensed, hashed, and reproducible offline;
- no canonical/content duplicate or future observation crosses the feature/label boundary;
- clean double reproduction yields byte-identical split, model, calibration, and evaluation artifacts;
- TypeScript inference matches training-runtime raw and calibrated outputs within `1e-12` for every parity fixture;
- validation selection followed the frozen rule without final-test access;
- final-test macro NDCG@50 improves over both V4 and the strongest valid simple baseline by at least `0.02`, and the paired 95% bootstrap interval for each improvement has lower bound `> 0`;
- probability calibration passes the gates above;
- unseen-company NDCG@50 is no more than `0.05` below known-company NDCG@50, unless the difference is shown statistically indistinguishable with the registered interval;
- no tested subgroup with at least 100 rows has NDCG@50 more than `0.10` below its platform aggregate without an explicit unsupported-status decision;
- monotonicity, duplicate resistance, missing-data, source-order, observation-shift, and extreme-count tests pass;
- p95 server inference is `< 1 ms/post` on the registered release machine and the artifact is `< 1 MiB/platform`;
- provenance, model card, migration, version labels, and rollback are complete.

Failure of any gate keeps V4 as the default and V5 experimental or unscored. The failure and exact missing evidence must be published; no arbitrary coefficients may be inserted to force release.

## Amendment rule

Corrections made before any final-test labels are opened require a new protocol ID, a diff explaining the reason, and a new frozen hash. After final-test access, any target, period, feature, threshold, model-selection, calibration, or acceptance change defines a new experiment and a new untouched final test.
