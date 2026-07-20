# V5 Feature Specification

Status: **pre-registered schema for prospective evaluation**
Schema ID: `returner-post-features-v5.0.0-prereg-2026-07-20`
Target: `returner-post-performance-v5-prereg-2026-07-20`

This schema exposes only facts available at the registered observation time `t0`. It intentionally excludes Topic, Vertical, Industry, identity, current rank, V4 score, and every later observation.

## Dataset row

Each row must contain provenance even when a field is not a model feature:

| Field | Role | Requirement |
| --- | --- | --- |
| `canonical_physical_id` | grouping/audit | platform plus canonical native object identity |
| `platform` | routing/feature | registered platform enum; never a fallback to X |
| `company_group_id` | split/audit only | canonical company ID; never enters feature matrix |
| `author_group_hash` | split/audit only | required before any dataset can be accepted; salted deterministic author/account grouping with exact handle excluded. This field and its concentration/leakage gate are not implemented in the current rejected scaffold. |
| `batch_id` | split/audit only | never enters feature matrix |
| `content_fingerprint` | duplicate audit only | normalized text/media fingerprint; never enters primary features |
| `published_at` | age calculation | exact timestamp or null with precision |
| `published_at_precision` | eligibility/audit | `exact`, `day`, or `unknown` |
| `observed_at` | cutoff | exact `t0` from observation lineage |
| `outcome_due_at` | label audit | `t0 + H` |
| `outcome_observed_at` | label audit | selected `t1` within tolerance |
| `source_artifact_sha256` | lineage | required for accepted training/test rows |
| `ingestion_run_id` | lineage | required when database-backed |
| `source_name` and source revision | lineage | immutable collector identity/revision |
| `split` | grouping | deterministic train/validation/test assignment |
| `target_growth`, `target_threshold`, `target_label` | label only | constructed after feature cutoff and never enters features |

The canonical dataset is sorted by `(platform, canonical_physical_id, observed_at, source_artifact_sha256)` before duplicate resolution and emission.

## Metric namespaces

No global engagement total is a V5 input. Every native counter is a separate feature.

| Canonical feature | Accepted source names | Platforms | Notes |
| --- | --- | --- | --- |
| `metric.views` | `views`, documented `impressions` | X, YouTube, Instagram/Bilibili when semantically proven | never infer from reach text |
| `metric.reactions` | `likes` or `reactions` | platform-specific | alias only within a platform with provenance |
| `metric.comments` | `comments` | platform-specific | top-level comments only when collector documents it |
| `metric.replies` | `replies` | X/compatible APIs | do not add to comments if the source says comments already include replies |
| `metric.reposts` | `reposts` or `retweets` | X/compatible APIs | do not combine with quotes in the feature layer |
| `metric.quotes` | `quotes` | X | separate feature |
| `metric.saves` | `saves` or `bookmarks` | compatible platforms | hidden/missing is not zero |
| `metric.upvotes` | `upvotes`, HN `points` when proven equivalent to the displayed item score | Reddit, HN, Product Hunt | platform-routed |
| `metric.stars` | `stars` | GitHub repository | target at `t1`, allowed at `t0` |
| `metric.forks` | `forks` | GitHub repository | separate from stars |
| `metric.open_issues` | `issues`, `openIssues`, `open_issues` | GitHub repository | state count, not adoption |
| `metric.watchers` | `watchers` | GitHub repository | keep separate; audit duplicate semantics with stars |
| `metric.recent_commits` | `recent_commits_30d` | GitHub repository | feature only when calculated strictly as of `t0` |

`followers`, `subscribers`, and account audience size are excluded from the primary candidate. An explicitly registered included-audience candidate may use `log1p(audience_size)` and `audience_size_missing`; it must pass the follower-removal ablation and subgroup gate before acceptance.

Derived V4 fields such as `rawEngagement`, `normalizedScore`, `contributionScore`, `profileScore`, `maxRepoScore`, recency weights, platform weights, post-slot contributions, and batch percentiles are forbidden.

## Transformations available at `t0`

For each genuine numeric metric `m`:

- `log1p_m = log(1 + m)`;
- `m_missing` is 1 only when the metric is not observed, never when it is zero;
- `m_source_family` may route incompatible collector schemas but cannot identify a named account;
- `m_age_seconds = max(0, t0 - metric_observed_at)` is required when a metric is carried from an earlier captured observation;
- optional prior-observation velocity is `(log1p(m_t0) - log1p(m_prev)) / elapsed_hours`, only when `m_prev` is a genuine observation of the same physical object strictly before `t0` and in the same split;
- acceleration requires three genuine observations and is absent otherwise.

No imputation constant is a positive signal. Candidate preprocessing may use training-only median imputation plus an explicit missing indicator, or a model's native missing branch. The imputation method is part of the frozen finite search and artifact.

Do not interpolate observations, treat file/source timestamps as metric timestamps, or reconstruct historical counters from current totals.

## Temporal features

Primary age-aware candidates may use:

- `post_age_hours = (t0 - published_at) / 3600` for exact publication times;
- UTC hour-of-day and day-of-week represented as sine/cosine pairs;
- platform-local publication hour only when the original time zone is known without inference;
- registered observation-horizon indicator in a pooled benchmark model.

Age is never clipped to a guessed publication time. Rows with unknown publication time are excluded from the primary model. Day-precision rows require a separately registered interval-censored implementation.

For GitHub, repository age uses native `createdAt`. `pushedAt` and `updatedAt` are future-sensitive activity timestamps, not repository publication time. If used as activity features, the exact value must have been observed by `t0`; it must never replace `createdAt`.

Temporal candidates compare no age term, monotonic learned spline, and other research-registered curves. There is no hand-selected half-life or missing-date momentum prior in V5.

## Optional content and account features

The primary candidate excludes content embeddings, Topics, Verticals, and Industry. Optional content candidates may use only a fixed, versioned, local extractor that can be replayed at `t0`; they require an ablation and licensing/privacy review. Runtime LLM calls are prohibited.

Allowed optional non-identifying content fields include media type, text length, URL count, and language when produced deterministically. Exact text n-grams, handles, domains, company names, founder names, batch names, investor names, and memorizing embeddings are excluded by default.

Account size is evaluated in included and excluded variants. Exact account handles and account IDs are grouping metadata only.

## Platform features and pooling

The default architecture fits and calibrates separate platform models. A pooled candidate may use a platform one-hot plus monotonic platform interactions only if every participating platform independently meets the support gate. There are no manually selected platform weights.

Cross-platform breadth, number of profiles, number of posts, and Top Voice membership are not post-level features. Unsupported platforms return a structured unscored result.

## Feature availability in the current public snapshots

Read-only audit of the three current base graph snapshots found 3,215 canonical platform-native objects by native ID/URL. This is coverage, not training support:

| Platform | Objects | Primary native counter present | Other notable coverage |
| --- | ---: | ---: | --- |
| X | 2,191 | views 2,148 | likes 2,079; reposts 1,923; comments 1,556 |
| LinkedIn | 438 | impressions 0 | reactions 377; comments 425; 185 unknown publication dates |
| GitHub | 204 | stars 203 | forks 203; issue alias coverage is mixed |
| YouTube | 177 | views 177 | likes 69; 59 unknown publication dates |
| Instagram | 165 | views 9 / plays 24 | likes 165; comments 150 |
| Hacker News | 23 | points 20 | upvotes alias 23; comments 23 |
| Reddit | 11 | upvotes 11 | comments 6 |
| Product Hunt | 6 | upvotes 6 | comments 6 |

These are single/latest surfaces for most objects. They do not become labels without a genuine `t1`.

## Duplicate resolution

For each `(canonical_physical_id, observed_at, canonical_metric)`:

1. reject estimates from the primary set;
2. prefer append-only database observation with ingestion-run lineage;
3. otherwise prefer hashed raw collector artifact over derived graph/output;
4. require values from equally preferred sources to agree;
5. disagreement is quarantined, never averaged or resolved by choosing the larger value;
6. source input order cannot affect the result.

Adding an attributed duplicate must not add a training row, increase a post prediction, or move the object to another split.

## Monotonicity

Where a feature is a genuine positive native counter, learned constraints require that increasing only that counter cannot lower predicted high-performance probability. This applies independently to views, reactions, comments/replies, reposts, quotes, saves, upvotes, stars, and forks when present in a platform model.

Age alone is not new engagement. No constraint may make an older unchanged post look as though it gained engagement. Missingness indicators are unconstrained but must pass adversarial missing-data tests.

## Explicit exclusions

The following never enter the V5 feature matrix without a new pre-registration:

- `company_id`, company name, founder ID/name, author handle, social-account ID;
- batch, group partner, Top Voice audience/member/weight;
- Topic, Vertical, Industry;
- current/future leaderboard rank or score;
- V4 formula components or high-engagement references;
- graph edges, centrality, or peer-company scores;
- link-review outcome recorded after `t0`;
- generated thumbnails or media URLs containing mutable access tokens;
- source-hunt acceptance text created after outcome observation;
- collection failure state correlated with future availability;
- current wall-clock age;
- any manually assigned company-quality value.

## Output contract

A scored post must carry:

- `modelId`, immutable `modelVersion`, and artifact SHA-256;
- feature-schema and target-spec IDs;
- canonical physical post ID and supported platform;
- `observedAt`, `asOf`, horizon, and outcome semantics;
- raw model output and calibrated probability;
- probability score on 0–100 only after calibration acceptance;
- uncertainty interval when statistically supported;
- missing-feature list, evidence coverage, freshness, link verification, and publication precision as separate fields;
- local explanation method and top marginal contributors;
- training-data manifest and split hashes;
- limitations and supported/unsupported status.

The runtime may not emit a V5 score when required fields are missing, the platform artifact is absent, the date-specific model is not validated, or input schema/version mismatches.

## Required feature tests

- no feature timestamp exceeds `t0`;
- no label/outcome field is reachable from feature construction;
- shuffled/reversed input emits byte-identical matrices;
- duplicate source rows emit one canonical row;
- conflicting equal-priority readings quarantine deterministically;
- missing is distinct from zero;
- publication precision controls age eligibility;
- GitHub `createdAt` is age and `pushedAt` is not;
- entity, batch, Top Voice, Topic, Vertical, and Industry columns are absent from matrices;
- preprocessing state is fit only on training;
- increasing a constrained metric cannot lower prediction;
- age without new engagement cannot manufacture a positive metric delta;
- unsupported platform and date-missing cases remain unscored;
- training-runtime and TypeScript feature vectors match exactly.
