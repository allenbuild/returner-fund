# Traction Scoring Model

## Canonical version

The production graph scoring model is:

- Model ID: `returner-traction`
- Version: `4.0.0`
- Name: `returner-traction-v4-canonical`
- Canonical configuration: [`src/lib/scoring/traction-config.ts`](../src/lib/scoring/traction-config.ts)
- Evidence normalizer and entity aggregate: [`src/lib/graph/traction-scoring.ts`](../src/lib/graph/traction-scoring.ts)
- Shared company batch calibration: [`src/lib/scoring/batch-calibration.ts`](../src/lib/scoring/batch-calibration.ts)
- Physical-evidence dedupe: [`src/lib/graph/dedupe.ts`](../src/lib/graph/dedupe.ts)
- YC attribution guard: [`src/lib/graph/evidence-attribution.ts`](../src/lib/graph/evidence-attribution.ts)
- Canonical-score graph assembly and visibility filters: [`src/lib/graph/graph-builder.ts`](../src/lib/graph/graph-builder.ts) and [`src/lib/graph/client-filters.ts`](../src/lib/graph/client-filters.ts)
- Live refresh overlay: [`src/lib/graph/live-evidence-overlay.ts`](../src/lib/graph/live-evidence-overlay.ts)
- Runtime score types: [`src/lib/graph/types.ts`](../src/lib/graph/types.ts)

The compatibility module at `src/lib/graph/traction-scoring-config.ts` only re-exports the canonical configuration; it defines no independent weights. The canonical object includes the evidence, platform, batch-calibration, and confidence parameters and validates normalized totals, scored-platform references and metrics, slot ordering, finite weights, and confidence thresholds at import time. The production `buildGraphResponse` path uses `traction-config.ts` and `batch-calibration.ts` under `src/lib/scoring/`, and batch calibration depends on `percentiles.ts`. A separate legacy demo-domain path in `src/lib/graph/build.ts` still imports `src/lib/scoring/model.ts`, which in turn uses the compatibility APIs in `aggregation.ts` and `formulas.ts`; that is not the v4 graph-response scorer documented here.

The score is a deterministic traction index on a `0..100` scale. It is not a probability, valuation, company-quality judgment, or statistically calibrated prediction of an outcome. See [`SCORING_V4_AUDIT.md`](SCORING_V4_AUDIT.md) for the v3 retirement rationale, migration notes, and validation boundary.

## Pipeline

For each canonical all-platform scoring run, v4 performs these stages:

1. Resolve account identity and company/founder attribution, retaining profile, fragment, and comment context without scoring it.
2. Check whether each evidence row is eligible.
3. Normalize metric aliases and compute weighted raw engagement.
4. Blend an absolute platform reference with a within-platform evidence midrank.
5. Apply recency only to the momentum share of the evidence score.
6. Deduplicate physical evidence and aggregate the strongest five rows into each platform score.
7. Combine the strongest platform with a fixed-weight diversified platform term.
8. In full-batch dataset assembly, calibrate positive company scores against their batch with tie-aware percentiles. A material live-overlay rebuild recalculates that same canonical all-platform company score before any response filters are applied.
9. Report confidence, limitations, model identity, and evidence timestamps separately from the traction score.

Company rollups may include both company evidence and founder evidence attached to that company. Founder records are also scored separately from their own evidence. Attribution is an upstream data decision; the scoring formula does not infer company or founder identity.

## Attribution and account identity

YC S26/S2026 assembly applies [`applyAttributionGuard`](../src/lib/graph/evidence-attribution.ts) before normalization. The A16Z builder does not call that guard; it uses its own curated attachment, native-URL, account-owner, and seeded-author rules described below. In the YC guard, attribution proof can come from a verified same-platform author/account handle, the company's own non-social source domain, or native post/body/quote/attachment/card text containing an accepted target name, website domain, or handle. Generated top-level `title`, `authorName`, `matchReason`, `why`, social-link domains, and self-declared target metadata are not proof. `item.text` is also ignored when it merely repeats the generated title. A source-URL handle is considered only when no author-backed handle is available.

YC account materialization marks an official social URL `verified` only when its host matches the declared platform and `handleFromUrl` returns a syntactically valid, non-generic identity. LinkedIn identity is the segment after `/company/` or `/in/`; feed, search, login, activity, admin, posts, recent-activity, and other generic identities are rejected. A16Z instead normalizes platform-specific account roots from a curated snapshot and preserves each snapshot row's review state, defaulting a missing snapshot state to `verified`. The live A16Z X target builder is stricter than that default: it selects only company and founder accounts whose `review_state` is exactly `verified`.

For A16Z seeded rows, author ownership is separate from a mentioned founder. Evidence authored by a verified founder account or an exact founder author name belongs to that founder. External Top Voice attention instead attaches to the company and may retain the mentioned founder as `targetFounderId`; it can make the company visible under a Top Voice filter without changing the canonical company or founder score.

LinkedIn comments and profile-activity fragments are context only. A stable native comment locator is retained with `contributionScore = 0`; an unlocated comment is held for review, and a parent post falsely presented as somebody else's comment is rejected as traction. Parent-post IDs and metrics are never reused as comment/company traction. Physical score dedupe also prefers an eligible native parent over a comment/reply fragment.

Materialized account lineage is owner-scoped. Dataset resolvers match `(entityType, entityId, platform, canonical account URL)` against the company or founder's `SocialAccountSummary` rows and set `socialAccountId` only on an exact owner/platform/URL match; an unresolved row keeps `socialAccountId = null`. The same account URL under two owners therefore does not collapse into one lineage record. The live overlay performs the same owner-scoped lookup and does not invent a social-account row when no match exists.

`socialAccountId`, optional `canonicalAccountId`, and `accountUrl` are provenance fields, not score inputs. Scoring eligibility does not require them. `canonicalPostKey` consults `canonicalAccountId` and then `socialAccountId` only in its last-resort text fallback after native identity and canonical URL both fail; score-eligible evidence must already have a native URL identity.

## Evidence eligibility

For an ordinary exclusion, `normalizeEvidenceScores` assigns zero `normalizedScore` and zero `contributionScore` and records the first applicable exclusion reason in `why`. Verified native TikTok and Bluesky rows take the separate visibly-unscored path described below: their `rawEngagement` and `normalizedScore` are absent rather than numeric zero.

A runtime evidence row is eligible only when all of the following are true:

1. Its platform has a positive configured platform weight.
2. `review_state` is exactly `verified`. The field remains optional in the runtime transport type, but a missing value fails scoring eligibility.
3. `linkStatus` is neither `invalid` nor `blocked`. `verified` is preferred but is not required; `unchecked` and missing status can still score.
4. Its incoming `contributionScore` is finite and greater than zero. At this stage the value is an upstream include/exclude flag; its positive magnitude is not a numeric input to the v4 formula.
5. `sourceUrl` yields a platform-native object ID under the strict host and path grammar below.
6. If a non-empty `platformPostId` is present, its platform-normalized value agrees with the URL-derived identity. Unrecognized or malformed explicit values are retained as conflicts rather than ignored.
7. At least one finite, positive, configured metric remains after alias normalization, producing weighted raw engagement greater than zero.

The checks run in the order above, so the recorded reason is the first failure. The supported scoring platforms are X, Instagram, LinkedIn, GitHub, YouTube, Product Hunt, Hacker News, Reddit, and Bilibili. `web` and `rss` rows can remain as context but cannot score.

### Native URL shapes

| Platform | Implemented native-identity grammar |
| --- | --- |
| X | Exact normalized host `x.com`, `twitter.com`, or `mobile.twitter.com`; exact `/<handle>/status/<numeric-id>` or `/i/web/status/<numeric-id>`, optionally followed by `/photo/<n>` or `/video/<n>` |
| Instagram | Exact normalized host `instagram.com` or `m.instagram.com`; exact `/p/<id>`, `/reel/<id>`, or `/tv/<id>` with an alphanumeric, underscore, or hyphen ID |
| LinkedIn | Exact normalized host `linkedin.com` or `m.linkedin.com`; exact `/feed/update/urn:li:activity:<numeric-id>` or a single `/posts/<segment>` containing `activity-<id>` or `activity:<id>` |
| YouTube | Exact `youtu.be/<id>`, or exact normalized host `youtube.com`/`m.youtube.com` with `/watch?v=<id>`, `/shorts/<id>`, or `/live/<id>` |
| Reddit | Exact `redd.it/<id>`, or exact normalized Reddit host (`reddit.com`, `old`, `new`, `np`, or `m`) with an optional `/r/<subreddit>` followed by `/comments/<post-id>` and optional slug/comment segments |
| Hacker News | Exact host `news.ycombinator.com`, exact path `/item`, and a numeric `id` query parameter |
| Product Hunt | Exact normalized host `producthunt.com`; exact `/posts/<slug>`, `/p/<slug>` with at most one optional child segment, or `/products/<product>/launches/<launch>` |
| Bilibili | Exact normalized host `bilibili.com` or `m.bilibili.com`; exact `/video/<alphanumeric-id>` |
| GitHub | Exact host `github.com`; exactly `<owner>/<repository>` with owner/repository grammar checks and a reserved-owner denylist |
| TikTok | Exact normalized host `tiktok.com` or `m.tiktok.com`; exact `/@<handle>/video/<numeric-id>` |
| Bluesky | Exact host `bsky.app`; exact `/profile/<actor>/post/<record-key>` |

Normalization removes a leading `www` before host comparison and removes trailing path slashes. These checks are syntactic and return the native ID used by dedupe. They do not fetch the URL, prove account ownership, or prove that metrics are current. Explicit link rechecks are reflected in confidence, not in the traction formula.

TikTok and Bluesky have native identity, runtime/database storage, and display support but no positive v4 platform weight, calibrated reference, or collection adapter. A row is retained as visibly `unscored` only when it is explicitly `verified`, has neither an invalid nor blocked link, has a strict native URL identity, and has no URL/explicit-ID conflict. That path sets `tractionStatus = "unscored"`, `contributionScore = 0`, and leaves `rawEngagement` and `normalizedScore` absent; it does not require a positive incoming contribution flag or configured metric because no scoring model exists. `web` and `rss` instead follow the ordinary unsupported-platform exclusion path. Platform status reports TikTok and Bluesky as disabled, so this support does not imply successful live collection.

The database attribution contract is stricter than the optional runtime compatibility fields: migration 004 permits `score_eligible = true` only for a `verified`, `low`-risk attribution. New persisted pipelines should satisfy that contract before constructing runtime evidence.

## Canonical dedupe

`dedupeEvidenceItems` uses `canonicalEvidenceKey`, which prefixes physical identity with the entity ID. Dataset assembly uses this entity-scoped form before normalization, so the same physical post may remain once for each distinct entity attribution. `dedupeEvidenceForScoring` uses `canonicalPostKey`, which deliberately omits entity attribution. Entity aggregation uses this physical form so the same native post cannot contribute twice to one company or founder rollup merely because it arrived through multiple source or attribution rows.

Identity is selected in this order:

1. A platform-native object ID parsed with the strict URL grammar, falling back to a platform-normalized `platformPostId`.
2. A canonical URL.
3. A deterministic fallback composed from platform, canonical account identity, author, and the first 220 normalized characters of author-plus-text content.

If both URL and explicit IDs exist and disagree, `dedupeEvidenceForScoring` drops the row. `canonicalPostKey` gives a non-fragment conflict its own conflict key for non-scoring uses. Canonical URL cleanup removes fragments and known tracking parameters, strips `www`, maps Twitter hosts to `x.com`, normalizes recognized X and Instagram post paths, and removes LinkedIn query strings and trailing slashes. Instagram, YouTube, and Bilibili opaque IDs remain case-sensitive; Reddit and GitHub identities are lowercased, while numeric IDs are unchanged. Product Hunt identities are lowercased and retain their path namespace (`posts/`, `p/`, or `products/.../launches/...`); explicit-ID comparison also accepts the implemented bare-slug and hyphenated aliases.

Both dedupe functions use the same replacement order. The candidate replaces the current row only at the first unequal stage below:

1. Prefer a native candidate with no ID conflict, no present non-`verified` review state, neither an invalid nor blocked link, a finite positive incoming contribution flag, and a strict native URL identity. This comparator tier accepts a missing review state even though `scoringEligibility` later rejects it, and it does not check configured metrics.
2. Prefer a non-fragment, non-conflicting parent candidate over an activity fragment or ID-conflict row. This stage adds no separate native-URL requirement.
3. Prefer a row whose explicit platform ID agrees with the URL-derived ID.
4. Prefer more finite numeric metric fields. This is field count, not configured-weight coverage or positive-metric count.
5. Prefer the freshest row, using the maximum of `metricsCheckedAt`, `observedAt`, optional `ingestedAt`, `last_checked_at`, `last_updated_at`, and `first_seen_at`. Publication time is not a dedupe-freshness field.
6. Prefer `contributionScore * 1,000,000 + sum(finite raw metrics)`, then the lexicographically smaller evidence `id`.

An exact final tie with the same ID retains the row encountered first. The comparator can retain an older but more scoreable, identity-consistent, or metric-complete row over a fresher sparse row.

Dataset builders call entity-scoped dedupe before `normalizeEvidenceScores`, and entity aggregation applies physical dedupe again before platform rollup. Inside the normalizer, both the same-platform percentile samples and the implicit reference clock come from the same physically deduplicated eligible winners. The normalizer still returns one scored/excluded output per original input row, so a losing duplicate can receive a score and remain in the returned collection until rollup dedupe, but its metrics and timestamp do not independently enter the sample or clock. A duplicate can affect those shared inputs only by winning the canonical replacement comparison.

Comment rows remain available as contextual evidence but do not enter the physical scoring rollup. When a comment locator and its native parent share a canonical parent identity, the eligible parent wins; a fresher comment cannot replace the parent's metrics.

## Metric aliases and weights

Metric normalization first removes non-finite, zero, and negative values. Alias families use the maximum observed value rather than adding synonymous fields, which prevents the same visible counter from being counted twice.

| Platform | Alias handling before weighting |
| --- | --- |
| X | `replies = max(replies, comments)`; `reposts = max(reposts, shares)` |
| LinkedIn | `reactions = max(reactions, likes)`; `comments = max(comments, replies)`; `reposts = max(reposts, shares)` |
| Instagram | `comments = max(comments, replies)`; `shares = max(shares, reposts)` |
| GitHub | `issues = max(issues, open_issues)`; a watcher count equal to stars is discarded |
| Other supported platforms | Positive metric names pass through unchanged |

Raw engagement for platform `p` is:

```text
R_p = sum(normalized_metric_m * configured_weight_p,m)
```

Only the following canonical metrics have nonzero v4 weights:

| Platform | Weighted metrics |
| --- | --- |
| X | `views*0.04 + likes*1.4 + replies*4.5 + reposts*6 + quotes*6` |
| Instagram | `views*0.04 + likes*1.1 + comments*4.5 + shares*5 + saves*4` |
| LinkedIn | `views*0.04 + reactions*1.4 + comments*4.5 + reposts*6` |
| GitHub | `stars*1.5 + forks*4 + issues*0.5 + recent_commits_30d*1` |
| YouTube | `views*0.025 + likes*1 + comments*3.5` |
| Product Hunt | `upvotes*2 + comments*3.5` |
| Hacker News | `upvotes*2 + comments*3.5` |
| Reddit | `upvotes*2 + comments*3.5` |
| Bilibili | `views*0.025 + likes*1 + comments*3.5 + shares*4` |

GitHub `watchers` is retained only when it differs from stars, but it has no nonzero v4 weight and therefore does not affect raw engagement. Followers, subscribers, and other unconfigured fields also do not score. V4 does not compute follower-adjusted engagement rate.

## Evidence score

### Platform references

Each platform has an absolute raw-engagement reference `H_p`, a recency half-life `L_p`, and a company diversification weight `w_p`.

| Platform | `H_p` high engagement | `L_p` days | `w_p` |
| --- | ---: | ---: | ---: |
| X | 120,000 | 45 | 0.21 |
| Instagram | 80,000 | 60 | 0.21 |
| LinkedIn | 18,000 | 75 | 0.15 |
| GitHub | 40,000 | 365 | 0.15 |
| YouTube | 35,000 | 150 | 0.10 |
| Product Hunt | 4,000 | 120 | 0.07 |
| Hacker News | 2,500 | 60 | 0.05 |
| Reddit | 4,000 | 60 | 0.04 |
| Bilibili | 35,000 | 150 | 0.02 |

The platform weights sum to `1`. Missing platforms are zero in the diversified term; their weights are not reassigned to available platforms.

### Absolute and midrank normalization

The absolute evidence score is logarithmic and capped:

```text
A = clamp(100 * log1p(R_p) / log1p(H_p), 0, 100)
```

The evidence midrank is computed among eligible, positive rows of the same platform in the current normalization input. Let `less` be the number of platform samples below the row's `log1p(R_p)`, `equal` the number exactly equal to it, and `N` the platform sample count:

```text
Q = 100 * (less + 0.5 * equal) / N
```

This is tie-aware. Equal evidence receives equal rank credit. Because `log1p` is monotone, it does not change ordering, but it matches the scale used by the absolute score. A single eligible row receives a midrank of `50`, and the largest unique row in a finite sample is below `100` because the row is included in its own sample.

The base evidence score preserves mostly absolute meaning while adding limited cohort context:

```text
B = 0.85 * A + 0.15 * Q
```

### Durable and momentum recency

The caller may pass an explicit `asOf` string or `Date`; an invalid explicit value throws. Without one, reference time `T` is the latest `observedAt`, `metricsCheckedAt`, or optional `ingestedAt` across the physically deduplicated eligible rows. `last_checked_at`, `last_updated_at`, `first_seen_at`, `linkCheckedAt`, and `postedAt` are not default reference-clock inputs. If no physical observation parses, `T` is the Unix epoch. The wall clock is never consulted. For a usable publication date:

```text
age_days = max(0, T - posted_at in days)
M = 0.5 ^ (age_days / L_p)
```

If `publishedAtPrecision` is `unknown`, or `postedAt` cannot be parsed, `M = 0.45`.

Recency controls only the 25% momentum share. The durable floor remains:

```text
recency_multiplier = 0.75 + 0.25 * M
E = round(clamp(B * recency_multiplier, 1, 100))
```

For dated evidence, the multiplier ranges from `0.75` for extremely old evidence to `1` for evidence at the reference time. Missing-date evidence uses `0.8625`. An eligible positive row receives at least `1`; an ineligible row receives exactly `0`.

## Platform aggregation

For each platform, deduplicated positive evidence scores are sorted from strongest to weakest. At most five fixed slots contribute:

```text
P_p = round(
  0.82 * E_1 +
  0.08 * E_2 +
  0.05 * E_3 +
  0.03 * E_4 +
  0.02 * E_5
)
```

Missing slots contribute zero. The slot weights sum to `1` and decrease with rank. For fixed evidence scores, adding another nonnegative row or increasing a row cannot lower the platform score. This replaces v3's averages and consistency bonuses, which could let a weak additional row dilute an otherwise strong platform.

Runtime slot count is controlled by `platformEvidenceSlots.length`; there is no separate v4 `topKPosts` setting.

## Cross-platform aggregation

Let `A` be the sum of configured weights for platforms with eligible evidence, and let:

```text
D = sum(w_p * P_p) / A
```

The pre-calibration absolute entity score is:

```text
U = round(clamp(D, 0, 100))
```

Available platforms are normalized by their configured weights. Platforms with equal configured weights therefore receive equal base influence and differ only through their platform scores. Missing platforms do not penalize a company, and for fixed platform scores, increasing any platform cannot lower `U`.

`aggregateBalancedTractionScore` returns `totalScore = absoluteScore = U` before any batch calibration. It also returns two compatibility diagnostics:

- `weightedAvailableScore` is the same normalized weighted average before integer rounding.
- `coverageFactor` is the derived ratio `U / weightedAvailableScore` when that denominator is positive and should remain approximately `1` apart from rounding.

`coverageFactor` is not a v4 multiplier and can sit just above or below `1` because `U` is rounded. In `weightedPlatforms`, `contribution` decomposes the normalized configured-weight formula, and `appliedWeight` is that platform's share of total v4 contribution.

Contribution rows are ordered by contribution, then platform score, configured weight, and platform ID for deterministic display.

## Tie-aware company calibration

Batch dataset builders can calibrate company scores after absolute aggregation. The exported aggregate scorer itself does not calibrate, and founder scores are not batch-calibrated by this path.

The calibration cohort contains only records whose score breakdown matches the canonical model ID and version, using their finite clamped absolute scores greater than zero. Legacy or foreign-model records neither enter the cohort nor change. For canonical company score `U`, the tie-aware percentile is:

```text
C_percentile = (count(peer < U) + 0.5 * count(peer = U)) / positive_cohort_size
```

The published calibrated company score is:

```text
C = round(clamp(0.82 * U + 0.18 * 100 * C_percentile, 1, 100))
```

Equal absolute scores receive equal percentile and equal calibrated score. Canonical companies with zero absolute score stay at zero, are excluded from the positive calibration cohort, and record calibration method `none`. Positive calibrated rows record method `tie_aware_percentile_blend`, cohort size, percentile, and input absolute score. The blend uses the unrounded percentile and stores it rounded to four decimals. The helper sets both `totalScore` and `previousScore` to the calibrated value; it leaves a record with no canonical v4 `scoreBreakdown` unchanged.

The 82/18 calibration is implemented once in [`src/lib/scoring/batch-calibration.ts`](../src/lib/scoring/batch-calibration.ts). The A16Z and YC dataset builders import that shared helper; its percentile calculation comes from [`src/lib/scoring/percentiles.ts`](../src/lib/scoring/percentiles.ts). The helper reads both blend weights from `TRACTION_SCORING_CONFIG.batchCalibration`.

## Canonical score and response filters

There is one company score: the calibrated all-platform score assembled for the complete batch. Positive company rows use `tie_aware_percentile_blend`; zero rows use `none`. Founder records remain absolute. Every canonical graph and static snapshot carries `scoringContext.scoreScope = "all_platforms"` and `scoringContext.selectedPlatforms = []`.

Platform and Top Voice controls are visibility filters, not scoring modes:

- A platform filter narrows visible companies, evidence, review items, edges, and each visible node's evidence IDs. It preserves the source node's score, previous score, radius, rank, momentum, top platform, platform-score map, and complete score breakdown.
- A Top Voice filter requires post-level evidence with visible metrics, excludes repost-like X rows, requires a visible target mention, and matches the native author identity to the selected audience. It uses the matching rows to decide visibility and to populate connection/evidence metadata while preserving the same canonical company score and rank.
- A platform filter can further narrow the evidence shown within a Top Voice result. It still does not recompute evidence normalization, entity aggregation, calibration, rank, or momentum.

`TopVoiceMember.weight` remains provenance metadata on the match and connection. It does not multiply `contributionScore`, and the graph does not emit a separate Top Voice or platform-filtered company score. The optional legacy `topVoiceScore` transport field is not populated by the canonical graph path.

The simplified score detail surface shows the canonical score's `weightedPlatforms` as platform contributions. It does not present alternate audience or platform totals. The client-side filter implementation also remains browser-safe and does not import server-only benchmark persistence (`node:fs`/`node:path`).

## Live evidence overlay

The current graph and refresh API paths build or update the canonical all-platform graph before applying ordinary visibility filters. When Top Voices is off, [`live-evidence-overlay.ts`](../src/lib/graph/live-evidence-overlay.ts) merges live rows into that unfiltered graph. Live rows enter a Top Voice result only through a full dataset rebuild followed by normal Top Voice matching; the overlay itself hides records when a Top Voice audience is active. When an overlay is allowed, it:

1. Hides records whose entity is not represented by a company node and all records when a Top Voice audience is active. Its optional internal platform selector can also hide nonmatching records, but the production graph API applies platform visibility after the canonical overlay.
2. Treats the request as a replay when every visible live row has both a matching company-plus-`canonicalPostKey` and the same effective evidence signature as an existing row. That signature covers identity, content/media, observation and link fields, metrics, review state, and whether scoring is enabled. A replay returns the incoming graph unchanged and reports the matching existing rows as visible evidence.
3. Otherwise groups existing and live rows by company identity plus `canonicalPostKey`. This merge comparator is separate from `dedupe.ts`: it first compares the maximum of `metricsCheckedAt`, `observedAt`, `last_checked_at`, `linkCheckedAt`, `last_updated_at`, and `first_seen_at`; if no such field parses, `postedAt` forms a lower freshness tier. It then prefers a live row over an existing row and finally uses stable serialization. It preserves an existing row ID when possible and the earliest valid `first_seen_at`.
4. Preserves the winning row's upstream contribution flag, including an explicit zero-score correction, then calls `normalizeEvidenceScores` across the merged canonical evidence. A fresh lower observation can lower a stale score; visible metrics cannot resurrect a context-only row.
5. Recomputes every company node present in the incoming canonical graph, not only companies that received a live row, and passes the positive company cohort through `calibrateBatchCompanyScores`. It updates node score surfaces, company radii, company/founder evidence IDs and founder platform scores, leaderboard scores/order, benchmark momentum, `generatedAt`, and `scoringContext` including `evidenceAsOf`.

A non-replay rebuild therefore calibrates positive company scores among the company nodes in the incoming canonical graph. Platform and Top Voice filters run afterward and preserve those score surfaces. On rebuild, each company node's `previousScore` becomes its incoming `score`, and `scoreDelta` is the rounded difference from that value. Company radii, leaderboard ranks, momentum, and provenance are rebuilt atomically. Founder evidence IDs and platform scores are refreshed inside company nodes, but non-company graph nodes and standalone founder totals/radii are not rescored. Evidence normalization uses only the incoming graph's merged evidence. `generatedAt` and `scoringContext.responseBuiltAt` advance to the maximum of the prior `generatedAt` and visible live-evidence freshness; they are not set from the wall clock. Canonical responses retain `scoreScope = "all_platforms"` and an empty selected-platform list.

## Confidence and limitations

Confidence describes evidence quality and coverage. It does not multiply, cap, or otherwise change the traction score.

The aggregate scorer physically deduplicates its input and reruns the complete `scoringEligibility` predicate before computing score or confidence. It does not call `normalizeEvidenceScores`, however, so a direct caller's positive `contributionScore` is used as the platform-slot score magnitude. Direct callers must normalize first unless they intentionally supply already-normalized contribution values.

For `n` unique scored rows, `p` represented platforms out of nine, `d` rows whose `publishedAtPrecision` is not `unknown` and whose `postedAt` parses, and `v` rows whose `linkStatus` is exactly `verified`:

```text
depth = 1 - exp(-n / 4)
breadth = sqrt(p / 9)
date_completeness = d / n
link_completeness = v / n

confidence_raw = clamp(
  0.20 +
  0.38 * depth +
  0.22 * breadth +
  0.12 * date_completeness +
  0.08 * link_completeness,
  0,
  1
)

confidence = round(confidence_raw, 3)
```

These constants and thresholds come from `TRACTION_SCORING_CONFIG.confidence`. The level is selected from the same three-decimal value that is reported: `low` below `0.500`, `medium` from `0.500` through `0.749`, and `high` at `0.750` or above. No eligible scored rows produce confidence `0` and level `low`.

The score breakdown separately reports limitations for no evidence, fewer than three unique scored rows, single-platform evidence, missing publication dates, and links not explicitly rechecked. These are explanation fields, not score penalties beyond the formula already described.

Secondary `signalFamilyScores` for reach, engagement, developer adoption, launch/community, and momentum are explanatory views over subsets of evidence. Their local reducer uses `0.55`, `0.25`, and `0.12` for the three strongest rows plus `8 * (1 - exp(-tail / 3))`, where `tail` is the sum of each remaining score divided by `100`. Those explanatory constants are not in `TRACTION_SCORING_CONFIG` and do not feed `absoluteScore` or `totalScore`.

## Model and data provenance

Every `ScoreBreakdown` carries:

- `modelId`, `modelVersion`, and `modelName`
- absolute and displayed total scores
- platform scores and contribution decomposition
- calibration method, cohort size, percentile, and input score
- confidence counts, reasons, and level
- signal-family scores and limitations
- `evidenceAsOf`, based on the latest `observedAt`, `metricsCheckedAt`, or optional `ingestedAt` among scored physical rows

Graph responses additionally carry a `scoringContext` with model identity, canonical all-platform scope, an empty selected-platform list, response build time, and evidence-as-of time. Graph construction can derive context time from the score breakdowns plus broader legacy check/update/first-seen fields, so it is not necessarily the same clock as a single `ScoreBreakdown.evidenceAsOf`. Initial graph building and material live-overlay rebuilds construct or refresh this context; visibility filters and exact effective live replays leave it unchanged. The static snapshot contract rejects any other score scope or a non-empty selected-platform list.

Migration [`004_traction_scoring_evidence_lineage.sql`](../supabase/migrations/004_traction_scoring_evidence_lineage.sql) adds durable provenance structures:

- canonical `evidence_items`
- auditable company/founder `evidence_attributions`
- append-oriented `metric_observations`
- versioned `scoring_model_versions`, with rewrites blocked after a completed run references a version
- version, as-of, observation-cutoff, fingerprint, and run-key fields on `scoring_runs`
- run, rank, and evidence-count fields on company and founder snapshots

The nullable version tuple `scoring_model_version_id`, `as_of_at`, and `input_observed_through` must be supplied together, with the observation cutoff no later than the run's as-of time. A new completed run additionally requires non-null `input_fingerprint` and `run_key`. A trigger makes those completed-run provenance fields immutable, and another trigger prevents changes to a model definition after a completed run references it; the foreign key also restricts deletion of a referenced model version. Model rows can still be corrected before their first completed use. `metric_observations` is described as append-only, but migration 004 does not add an update/delete prevention trigger for that table. A completed score should never be relabeled from v3 to v4; publish a new model-version row and a new scoring run.

The migration is additive and leaves legacy posts, post scores, runs, and snapshots readable. Version fields and snapshot run links are nullable so pre-v4 rows remain valid. Migration 004 does not backfill old rows or insert the v4 model-version record; migration [`007_register_traction_scoring_v4.sql`](../supabase/migrations/007_register_traction_scoring_v4.sql) now registers the exact canonical model/config when applied and rejects drift on rerun. Neither file proves deployment or an end-to-end runtime writer. Operational rollout and rollback details are in [`SCORING_V4_AUDIT.md`](SCORING_V4_AUDIT.md).

## Artifacts and reproducibility

The local diagnostic entry point is [`scripts/run-scoring-diagnostics-v4.mjs`](../scripts/run-scoring-diagnostics-v4.mjs), exposed as `npm run scoring:audit:v4`. It freezes the clock, disables `fetch`, reads local snapshot inputs, imports the graph scorer and canonical dedupe/config exports, and writes only:

- [`docs/outputs/scoring-diagnostics-v4-audit.json`](outputs/scoring-diagnostics-v4-audit.json)
- [`docs/outputs/scoring-diagnostics-v4-report.md`](outputs/scoring-diagnostics-v4-report.md)

The script inventories canonical duplicates, metric aliases, URL categories, missing data, and platform concentration. It also performs deterministic reverse-order, metric-increase, timestamp-shift, and sampled monotonicity perturbations. Its before/after scoring calls the evidence normalizer and absolute aggregate, not shared batch calibration; already-published calibrated company scores are retained only as a separate reference. Its "after" view is an in-memory cleanup simulation that uses production eligibility and metric normalization, entity-scoped canonical dedupe, and the production physical comparator only for eligible rows with one unambiguous company owner. It is not a migration or persisted score update.

The current checked-in diagnostic is frozen at `2026-07-17T12:00:00.000Z`. Its JSON SHA-256 is `3cd06213e6a0e819d0f500632dbc32908399302b9bd8e4b2915395c03f739e72`; the rendered report SHA-256 is `ea106d3ea5fbdc09901e3ea068b048a1a29aae3287c59ac34149edb433e7be92`. The audit records a 52-file input-envelope hash of `78582133534fbc4f4fdc70370e6e5401b28e3492dd5d0c88be0ed73e66da6ae2`, all 83 canonical config leaves with config hash `adfce3cd311a6fd658f76406679e2ad536ef56163b3cc18da879afc19645cf28`, eight role-labeled scoring sources with combined hash `271ff53a495fd8465c5f7ae1f0c25511609d6857453af81df67428514badcf3b`, and a combined versioned-scoring-input hash of `03e432277ba4769cc4121311b8282d84edc3af135159046c27730358a45835e6`. The reproducibility test regenerated both artifacts byte-for-byte and separately confirmed that an input-envelope mismatch exits nonzero without replacing them. These hashes establish artifact identity and current parity for the recorded local inputs, but not predictive validity, deployment, or external-source liveness.

[`scripts/run-scoring-experiments.mjs`](../scripts/run-scoring-experiments.mjs), exposed as `npm run scoring:experiments`, freezes its clock, disables network access, and writes only the experiment JSON, detailed report, and [`SCORING_EXPERIMENTS.md`](SCORING_EXPERIMENTS.md). The current experiment is frozen at `2026-07-16T12:00:00.000Z`; its JSON SHA-256 is `16bd3e64027c962af3650252a94032de5beb9ab7fe4640e488b9051772e11ff4`, its rendered report SHA-256 is `5758bc9eacbb2ea2d2d79f22b2ad7eb9d55a1f10c1c61c9fee0c1a0051d105d8`, its production-config hash is `adfce3cd311a6fd658f76406679e2ad536ef56163b3cc18da879afc19645cf28`, and its dataset hash is `dee12b50325b8a494d2b457bb5f2c01b69b30957eac238e6f09b992805abe474`. It records `93,321` imported-normalizer parity assertions, no production-config mutation, and six scorer/config/dedupe/dataset source hashes that matched in a read-only check. Its narrower manifest does not hash the experiment runner or every imported snapshot, so rerun before treating candidate order or examples as current after any unmanifested input changes.

The public publication set is separate: nine graph files under [`public/graph`](../public/graph) cover three batches across the unfiltered, YC Partners, and Insiders visibility variants, with three history files under [`outputs/benchmarks`](../outputs/benchmarks). [`scripts/validate-public-artifacts.mjs`](../scripts/validate-public-artifacts.mjs) checks canonical v4 model identity, complete score breakdowns, canonical all-platform scoring context, evidence references, ranking surfaces, timestamps, and history shape. Runtime consumers also validate static snapshots: `Dashboard` falls back to `/api/graph` when the shared contract or requested batch/audience identity fails and starts background API revalidation after every accepted static response, while the refresh route dynamically rebuilds when its stricter structure, identity, audience, or current-Central-day freshness checks fail. The release gate requires every graph and a canonical daily history entry to fall on the current `America/Chicago` day, so structural validity alone does not imply release freshness. Public graph files carry `generatedAt` and `evidenceAsOf` but no complete input fingerprint, so they are not a substitute for the diagnostic input manifest or proof of deployment/source liveness.

Exact score replay requires the canonical model/config version, exact evidence and metric rows, attribution and owner-scoped account mapping, normalization cohort, physical observation cutoff or explicit `asOf`, and company calibration cohort. Reproducing a filtered response additionally requires the platform selection or Top Voice audience used for visibility, but those controls are not score inputs. Exact output-byte replay also requires stable input order for otherwise exact same-ID dedupe ties, a frozen response clock, benchmark history, and the same sanitization/publication path. The diagnostic runner accepts `--expect-input-sha256` to fail before scoring when its full input envelope differs.

None of the diagnostic, experiment, migration, static graph, or benchmark artifacts proves that a database migration was deployed, that a runtime writer persisted v4 lineage, or that any external collector succeeded. The real-time refresh route has an implemented X branch; the presence of historical rows or platform types must not be presented as a current live-source check.

## Regression checks

Focused regression coverage includes `tests/traction-scoring-v4.test.ts`, `tests/evidence-dedupe.test.ts`, `tests/scoring-dataset-contracts-v4.test.ts`, `tests/live-evidence-overlay.test.ts`, `tests/evidence-attribution-proof-integrity.test.ts`, `tests/a16z-speedrun-006-dataset.test.ts`, and `tests/yc-spring-2026-dataset.test.ts`. Tests and diagnostics establish deterministic implementation behavior on their fixtures and local snapshots only; they do not establish predictive validity, statistical calibration, optimal weights, or fairness.

## Known limitations

- Metric weights, platform references, slot weights, and confidence weights are product heuristics, not fitted or statistically validated parameters.
- Within-platform midranks and company calibration depend on the current input cohort. Cohort additions can change scores even when a company's raw evidence does not change.
- Fixed-slot and cross-platform aggregation are monotone for fixed input scores, but evidence normalization can move when the percentile sample or reference timestamp changes.
- Public metric availability and semantics differ by platform. Missing, hidden, deleted, private, estimated, botted, or paid engagement is not fully detectable.
- Native URL validation is syntactic even though host/path grammar is strict. Unchecked or missing link status may score, and no check proves ownership, liveness, or metric freshness.
- Entity aggregation physically deduplicates and reruns the full scoring-eligibility check, but it does not call `normalizeEvidenceScores`. It treats each surviving positive `contributionScore` as an already-normalized evidence score, so direct callers must normalize first or deliberately supply values with that meaning.
- Dedupe identity fallbacks can collide for similar account/author/text content. Replacement completeness counts all finite numeric metric fields, including zero, negative, and unweighted fields, and can outrank freshness. Dedupe freshness excludes `postedAt` and `linkCheckedAt`.
- The normalizer derives both its percentile sample and implicit reference clock from physically deduplicated eligible winners, but emits one output per input row. A losing duplicate can therefore retain a computed score in the returned collection until rollup dedupe, although it cannot independently move the cohort sample or clock.
- A present malformed or stale `platformPostId` is treated as an identity conflict with a valid native URL rather than ignored, which can quarantine legacy rows until their explicit ID is corrected or removed.
- The default normalization clock ignores legacy check/update/first-seen fields. With no parseable `observedAt`, `metricsCheckedAt`, or `ingestedAt`, it falls back to the Unix epoch, causing later publication dates to clamp to age zero unless the caller supplies `asOf`.
- Missing publication dates use the fixed momentum prior `0.45`; this is not an inferred date distribution.
- Runtime date "verification" text is stronger than the actual completeness check, which only requires non-`unknown` precision and a parseable `postedAt`; it does not externally verify the publication timestamp. Runtime scoring does, however, require `review_state` to be exactly `verified`.
- Follower count and account size do not adjust v4 traction. The score measures visible weighted response, not engagement efficiency.
- Stored `platform_baselines` are not consulted by the graph v4 formula; its absolute references are the heuristic values in the canonical config.
- Batch-calibration and confidence weights are canonical config fields, but changing them still requires a new model version and replay to compare scores meaningfully.
- Platform and Top Voice filters can make the visible evidence set narrower than the evidence behind the displayed canonical score. They deliberately preserve all-platform scores, source ranks, radii, momentum, top-platform metadata, and score breakdowns; consumers must not reinterpret filtered evidence as a separately recomputed total.
- A material live overlay rebuilds companies represented in the incoming canonical graph evidence, including company radii, leaderboard, benchmark momentum, and scoring context, but standalone founder graph-node totals and radii remain unchanged. The current API overlays the full all-platform graph before client filtering, and an exact effective replay leaves the graph unchanged.
- Native-proof attribution intentionally favors false negatives over accepting generated/provenance metadata as evidence. Legitimate relationships visible only in omitted metadata require review or better native capture.
- Checked-in diagnostics and experiments are point-in-time fixture results, not live-source checks. The diagnostic's full 52-file envelope currently matches and regenerates byte-for-byte; the experiment manifest is narrower and must be rerun after changes to unmanifested inputs before its examples are treated as current.
- The separate `src/lib/graph/build.ts` demo path and its `src/lib/scoring/model.ts` compatibility helpers expose older follower-rate, average, and re-normalized-weight formulas. Their outputs must not be mixed with `buildGraphResponse` v4 outputs.
- Migration 004 protects completed-run provenance, blocks model-version rewrites after completed use, and restricts deletion of referenced model versions. Its append-only description for `metric_observations` is not enforced by an update/delete prevention trigger.
- Score changes across model versions are not longitudinal traction changes unless the same model, configuration, evidence cutoff, and cohort are replayed.
