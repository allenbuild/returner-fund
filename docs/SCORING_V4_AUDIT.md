# Scoring v4 Implementation Audit

> Historical baseline: this audit records `4.0.0`. Production `4.0.2`
> (`returner-traction-v4-date-invariant`) also removes publication-age and
> recent-commit scoring, preserves the prior versions as rollback targets, and is documented in
> [`SCORING_MODEL.md`](SCORING_MODEL.md).

## Scope and conclusion

This is a historical documentation-level code conformance audit of the `4.0.0` scoring implementation. It covers the canonical configuration, graph scorer, entity- and physical-evidence dedupe, shared company calibration, visibility filters, live overlays, diagnostics, runtime types, and migrations 004 and 007. It does not describe the date-invariant `4.0.2` evidence formula and does not certify predictive accuracy, statistical calibration, fairness, causal validity, or business outcomes.

The graph path audited here identified itself as `returner-traction` version
`4.0.0`. The current graph path identifies as `4.0.2`. Each batch graph
preserves one calibrated all-platform company score and canonical rank;
platform and Top Voice controls change visibility and evidence presentation
without creating alternate score scopes.

Canonical sources reviewed:

- [`src/lib/scoring/traction-config.ts`](../src/lib/scoring/traction-config.ts)
- [`src/lib/scoring/batch-calibration.ts`](../src/lib/scoring/batch-calibration.ts)
- [`src/lib/scoring/percentiles.ts`](../src/lib/scoring/percentiles.ts)
- [`src/lib/graph/traction-scoring.ts`](../src/lib/graph/traction-scoring.ts)
- [`src/lib/graph/dedupe.ts`](../src/lib/graph/dedupe.ts)
- [`src/lib/graph/evidence-attribution.ts`](../src/lib/graph/evidence-attribution.ts)
- [`src/lib/graph/graph-builder.ts`](../src/lib/graph/graph-builder.ts)
- [`src/lib/graph/client-filters.ts`](../src/lib/graph/client-filters.ts)
- [`src/lib/graph/live-evidence-overlay.ts`](../src/lib/graph/live-evidence-overlay.ts)
- [`src/lib/graph/types.ts`](../src/lib/graph/types.ts)
- [`src/lib/graph/a16z-speedrun-006-dataset.ts`](../src/lib/graph/a16z-speedrun-006-dataset.ts)
- [`src/lib/graph/yc-spring-2026-dataset.ts`](../src/lib/graph/yc-spring-2026-dataset.ts)
- [`scripts/run-scoring-diagnostics-v4.mjs`](../scripts/run-scoring-diagnostics-v4.mjs)
- [`supabase/migrations/004_traction_scoring_evidence_lineage.sql`](../supabase/migrations/004_traction_scoring_evidence_lineage.sql)
- [`supabase/migrations/007_register_traction_scoring_v4.sql`](../supabase/migrations/007_register_traction_scoring_v4.sql)

Compatibility-only paths were also checked: [`src/lib/graph/build.ts`](../src/lib/graph/build.ts) and [`src/lib/scoring/model.ts`](../src/lib/scoring/model.ts). They implement the separate legacy demo-domain graph, not the `buildGraphResponse` v4 path.

## Conformance summary

| Concern | Audited 4.0.0 behavior | Audit result |
| --- | --- | --- |
| Canonical configuration | Model identity, platform/metric weights, references, evidence/recency/platform blends, slots, batch calibration, and confidence live in `src/lib/scoring/traction-config.ts` | Canonical; `src/lib/graph/traction-scoring-config.ts` is only a re-export |
| Eligibility | Positive-weight platform; review state exactly `verified`; link not `invalid`/`blocked`; finite positive contribution flag; strict native URL identity; no URL/explicit-ID conflict; positive configured engagement | Implemented in normalization and rerun by entity aggregation; runtime compatibility fields may be optional, but missing review state does not score |
| Attribution proof | Verified author/account identity or native body/quote/card/domain/handle evidence; generated labels and provenance metadata do not prove the target | Implemented before normalization; conservative failures are zeroed or review-gated |
| Account and comment integrity | Non-generic parsed account identity; verified-only live A16Z X targets; LinkedIn comments/activity fragments retained as zero-score context | Implemented in dataset assembly and live refresh; parent-post IDs/metrics are not reused as comment traction |
| Native URL policy | Shared strict native-ID parser with exact normalized hosts and platform-specific whole-path grammars; unchecked or missing link status may score | Implemented; syntactic only, with no ownership, liveness, or freshness proof |
| Canonical dedupe | Strict URL/explicit native ID, then canonical URL, then fallback identity; conflicts are excluded from scoring; replacement prefers scoreable native rows, parent, agreement, completeness, freshness, score/metrics, then ID | Implemented for entity-scoped assembly, normalization sampling, and physical rollups |
| Alias handling | Synonymous counters collapse by maximum before weighting | Implemented for X, LinkedIn, Instagram, and GitHub issue aliases |
| Evidence normalization | `85%` absolute log reference plus `15%` same-platform tie-aware midrank over eligible physical rows | Implemented; the percentile sample and implicit clock use physically deduplicated eligible winners, while one output is emitted per input row |
| Recency | `75%` durable floor plus `25%` platform-half-life momentum | Implemented; missing dates use fixed momentum `0.45` |
| Platform aggregation | Fixed descending slots `82/8/5/3/2` over the strongest five unique rows | Implemented and monotone for fixed evidence scores |
| Cross-platform aggregation | Normalized configured-weight average over platforms with eligible evidence (`strongestPlatformWeight=0`, `diversifiedPlatformWeight=1`) | Implemented and monotone in each included platform score; missing platforms do not penalize the entity |
| Confidence | Separate evidence-depth, breadth, date, and link-completeness heuristic | Implemented; does not alter score |
| Company calibration | Shared `82%` absolute plus `18%` tie-aware positive-cohort percentile, followed by a positive-cohort 1–100 stretch | Implemented in `batch-calibration.ts` and called by A16Z/YC dataset assembly; not part of the aggregate scorer |
| Platform and Top Voice filters | Restrict visible companies, evidence, review items, and graph metadata while preserving canonical all-platform company scores and ranks | Implemented in graph assembly and `applyClientGraphFilters`; Top Voice weights are provenance metadata, not score multipliers |
| Live overlay | Exact effective-evidence replays are no-ops; material changes preserve fresh lower/zero corrections, renormalize merged canonical evidence, reaggregate the canonical company set, and run shared calibration before filters | Implemented; company radii, leaderboard, momentum, and scoring context are rebuilt, while standalone founder graph-node totals/radii remain unchanged |
| Provenance | Model identity, canonical all-platform scope, evidence time, calibration, confidence, limitations | Implemented on canonical graph responses and refreshed after material live overlays |
| Client/server bundle boundary | Browser filters do not import server benchmark persistence | Fixed; the recorded final production build and local graph/home GET smoke pass, with a separate broad NFT trace warning still open |
| Diagnostics | Offline local-snapshot inventory and deterministic perturbations | Tooling exists; checked-in outputs predate the final scorer/attribution/account/comment state and are not current-worktree results |
| Durable lineage | Canonical evidence, attribution, metric observations, model versions, versioned runs, run-scoped snapshots | Migration 004 defines lineage and immutability guards; migration 007 seeds canonical v4; only observation append-only behavior lacks an update/delete trigger |

## Runtime conformance findings

### Dedupe replacement order

`dedupeEvidenceItems` keys by entity plus physical post and is used before dataset normalization. `dedupeEvidenceForScoring` keys only by physical post and is used in company/founder rollups. Both use the same first-difference replacement sequence:

1. scoreable native candidate: no ID conflict, compatible review/link state, finite positive incoming contribution, and a strict native URL identity
2. non-fragment, non-conflicting parent candidate over a comment/reply fragment or ID-conflict row, with no additional native-URL check at this stage
3. explicit platform ID agreeing with the URL-derived ID
4. count of finite numeric metric fields
5. freshness across `metricsCheckedAt`, `observedAt`, optional `ingestedAt`, `last_checked_at`, `last_updated_at`, and `first_seen_at`
6. `contributionScore * 1,000,000 + sum(finite raw metrics)`, then lexicographically smaller evidence ID

`dedupeEvidenceForScoring` drops URL/explicit-ID conflicts before grouping. An exact tie with the same ID retains the first row. Metric completeness counts zero, negative, unknown, and unweighted finite fields, so a more complete older row can beat a fresher sparse row. Publication time and `linkCheckedAt` are not dedupe-freshness inputs.

`normalizeEvidenceScores` builds its same-platform samples and default reference clock from the same eligible, physically deduplicated winners. It still emits one output per input row, so a losing duplicate can remain in the normalized collection until rollup dedupe, but it cannot independently move the percentile sample or implicit clock.

### Eligibility and confidence

`normalizeEvidenceScores` applies eligibility in a fixed order and writes the first failure into `why`. `review_state` must be exactly `verified`; a missing value is excluded. Missing/`unchecked` `linkStatus` remains eligible, while `invalid`/`blocked` links are rejected. The contribution flag must be finite and greater than zero. A shared parser then requires an exact normalized host and whole-path native object grammar. If a non-empty `platformPostId` is present, its platform-normalized value must agree with the URL-derived ID; malformed or unrecognized explicit values remain conflicts rather than being ignored.

Without explicit `asOf`, normalization uses the latest `observedAt`, `metricsCheckedAt`, or optional `ingestedAt` among the physically deduplicated eligible winners. It ignores legacy check/update/first-seen fields and publication time; with no parseable physical observation, it falls back to the Unix epoch. An explicit invalid `asOf` throws.

The aggregate scorer reruns the complete scoring-eligibility predicate and then physically deduplicates the eligible rows before score and confidence calculations. Confidence uses canonical-config depth, platform breadth, parseable non-`unknown` publication dates, and links whose status is exactly `verified`; it never changes the score. The value is rounded to three decimals before the medium/high thresholds are applied, so the reported value and level use the same number. It is a completeness heuristic, not a confidence interval.

### Attribution, accounts, and contextual rows

Dataset builders apply the attribution guard before normalization. Target proof is limited to verified same-platform author/account identity, the company's own non-social source domain, or native item/body/quote/attachment/card text containing an accepted name, domain, or handle. Generated titles, author-name fallbacks, `matchReason`, `why`, social-link domains, and self-declared target metadata do not prove attribution. Text that merely repeats the generated title is also excluded. Source-URL handles are fallback evidence only when no author-backed handle is present.

Account parsing rejects generic and malformed identities. In particular, LinkedIn company/person identities come from the segment immediately after `/company/` or `/in/`; nested `admin`, `about`, `posts`, or `recent-activity` segments never become verified handles. Live A16Z company/founder X targeting requires an account record whose review state is exactly `verified`.

A16Z author ownership is separate from the person mentioned by a post. A seeded row belongs to a founder only when a verified account/handle or exact author name resolves to that founder. External Top Voice attention attaches to the company and can retain a mentioned founder as `targetFounderId`, so Insider-mode company attention does not inflate the founder's rollup.

LinkedIn comments and profile-activity fragments remain visible context with zero contribution. Stable native comment locators are retained; unlocated comments are review-gated; parent posts falsely presented as another author's comment are rejected. Parent-post IDs and metrics never become comment/company traction, and scoring dedupe prefers the eligible native parent over a comment/reply fragment.

### Canonical score and visibility filters

The A16Z and YC dataset builders import `calibrateBatchCompanyScores` from the shared `src/lib/scoring/batch-calibration.ts`. Full all-platform company records therefore carry tie-aware batch calibration when their absolute score is positive: the configured 82/18 blend is calculated first, then the positive cohort's blended values are stretched across 1–100 (with a bounded blend fallback when the cohort is degenerate). Founder records are not calibrated.

Graph assembly computes canonical leaderboard ranks from those full-batch company records before applying platform, industry, group, score, query, or Top Voice visibility. Platform filtering narrows visible companies and evidence but preserves each source node's score, previous score, radius, rank, momentum, top-platform metadata, platform-score map, and score breakdown.

Top Voice matching decides which companies, evidence, and attention connections are visible. It annotates matching evidence with the member and configured weight as provenance while preserving `originalContributionScore`; the weight does not multiply the evidence or company score. API paths build or overlay the canonical all-platform graph first, inherit its company score surfaces into audience projections, and apply ordinary filters afterward. Canonical responses retain `scoreScope = "all_platforms"` and `selectedPlatforms = []`.

### Live overlay

When Top Voices is off, refresh routes overlay visible live rows whose entity belongs to a company node in the canonical graph. Existing and live rows are grouped by company plus `canonicalPostKey`. This overlay comparator is not the canonical dedupe comparator: it first compares the maximum of `metricsCheckedAt`, `observedAt`, `last_checked_at`, `linkCheckedAt`, `last_updated_at`, and `first_seen_at`; when none parses, `postedAt` forms a lower freshness tier. It then prefers live over existing and finally stable serialization. It preserves an existing ID and the earliest valid `first_seen_at`. The winning row's contribution flag is preserved, so a fresh lower observation can lower a stale score and an explicit zero-score/context-only correction remains excluded after normalization.

Before merging, the overlay checks whether every visible live row has a matching company-plus-canonical key and the same effective evidence signature as an existing row. The signature includes identity, content/media, observation and link fields, metrics, review state, and the score-enabled flag. If every row matches, the overlay treats the request as a replay, returns the graph unchanged, and reports the matching existing rows as visible evidence.

For a non-replay change, the overlay normalizes all merged canonical evidence, absolutely reaggregates every company represented in the incoming canonical graph, then calls the shared batch-calibration helper over that canonical positive-company cohort. This can move companies without a new row because the evidence-normalization or calibration cohort changed. It updates calibrated company node scores/breakdowns, company radii, evidence IDs, founder evidence IDs and platform scores, leaderboard scores/order, benchmark momentum, `generatedAt`, and scoring context/evidence time before platform or Top Voice filters run.

The rebuild sets each company node's `previousScore` to its incoming score and computes `scoreDelta` against it. Standalone founder graph-node totals/radii are not rebuilt with the recalibrated company peer set; this is the remaining derived-surface limitation.

## Why v3 and min-max were retired

The previous graph configuration was named `social-traction-v3-balanced-recency`. Its runtime normalization and aggregation had several properties that made scores difficult to interpret and unstable under ordinary data refreshes.

### Cohort extrema controlled evidence scores

V3 log-transformed recency-adjusted engagement, then mapped each platform's observed minimum to `5` and maximum to `100`. If all values tied, every row received `50`.

That min-max rule meant adding or removing one extreme row could rescale every other row even when their evidence did not change. It also guaranteed a platform winner near `100` without requiring meaningful absolute traction. V4 anchors `85%` of the evidence score to a declared platform reference and limits current-cohort rank influence to `15%` with tie-aware midranks.

### Eligibility was too permissive

V3 treated any positive upstream row outside `web` and `rss` as scoreable. It did not require a native object URL, visible configured metrics, a usable link state, or a compatible review state. If a platform's configured metric sum was zero, it retried the row with X weights, allowing metrics to acquire unintended meaning.

V4 has explicit exclusion reasons and no cross-platform metric-weight fallback.

### Aliases could be counted twice

V3 configured both sides of several synonymous pairs, including X replies/comments and reposts/shares, LinkedIn likes/reactions and reposts/shares, and GitHub issues/open issues. GitHub stars and commonly identical watcher counts could also both contribute.

V4 canonicalizes alias families with `max` before weighting, ignores unweighted fields, and does not assign a watcher weight.

### Weak rows could dilute strong platform traction

V3 used platform-specific averages, top-three averages, consistency bonuses, and repository-depth bonuses. Adding a weak row could lower an average even though no traction had disappeared.

V4 uses fixed descending slots with missing slots treated as zero. For fixed evidence scores, adding or improving a row cannot reduce the platform aggregate.

### Missing platforms were mostly re-normalized away

V3 re-normalized configured platform weights over whichever platforms were present, then applied a narrow breadth factor from `0.85` to `1`. A strong single-platform company could therefore inherit almost the whole available-weight average, while a strong signal could also be diluted by weaker present platforms.

V4 uses the normalized configured-weight average over platforms with eligible evidence. The canonical configuration gives the separate strongest-platform term zero weight and the diversified term full weight. Missing platforms are excluded from the available-weight denominator, so they do not penalize the entity; adding another platform changes the available-platform weighted average.

### Provenance and uncertainty were underspecified

V3's graph breakdown did not identify a model ID/version, separate an absolute score from calibration, expose evidence-as-of time, or report a confidence object. V4 adds those fields and migration 004 creates durable model/run lineage.

This retirement rationale is an engineering judgment about determinism, interpretability, dedupe, and monotonic aggregation. It is not evidence that v4 is statistically predictive or that its weights are optimal.

## Migration compatibility

Migration 004 is additive relative to the initial schema:

- It creates new canonical evidence, attribution, observation, and model-version tables.
- It leaves `posts`, `post_metrics`, `post_scores`, `scoring_runs`, and both snapshot tables in place.
- It adds nullable version/provenance columns to existing scoring runs.
- It adds nullable run, rank, and evidence-count columns to existing company and founder snapshots.
- It adds uniqueness and lookup indexes for canonical identities, observations, versioned runs, and run-scoped snapshots.

Pre-v4 rows remain valid because the new run-version triplet can be entirely null and snapshot run links are nullable. The triplet constraint requires `scoring_model_version_id`, `as_of_at`, and `input_observed_through` to be either all present or all absent. The declared `input_observed_through` cutoff cannot be later than `as_of_at`.

Migrations 004 and 007 do not:

- backfill legacy posts into `evidence_items`
- backfill metric history into `metric_observations`
- attach old runs or snapshots to a model version
- define a down migration
- enforce append-only `metric_observations` behavior with an update/delete trigger

Migration 007 inserts the canonical `returner-traction` / `4.0.0` model definition and rejects a conflicting config on rerun. Migration 004 requires complete provenance when a run becomes completed, prevents changes to that completed-run provenance, prevents rewriting a model definition after a completed run references it, and restricts deletion of referenced model versions. New v4 persistence should use the seeded model row, preserve its config hash and optional code revision, create a versioned scoring run with an explicit observation cutoff, and write snapshots linked to that run. Historical v3 data should retain its original identity or remain explicitly unversioned; it must not be relabeled as v4.

## Rollout and rollback

The safest application rollback is schema-forward: deploy the prior application while leaving migration 004 in place. The old application can continue using legacy tables and columns, while v4 rows retain their provenance for diagnosis or replay.

A database rollback is a separate, destructive operation and is not supplied by migration 004. Before dropping anything, an operator would need to stop v4 writers, export or archive v4 evidence and run lineage, remove foreign-key dependencies in reverse order, and decide how to preserve any v4 snapshots. Deleting a scoring run cascades to linked snapshots; deleting a referenced model version is restricted.

Although many tables, columns, and indexes use `if not exists`, migration 004 should be applied once through migration history. Named constraints and triggers are not uniformly guarded against recreation, so the file is not a general-purpose idempotent replay script.

For a formula rollback without an application rollback, publish a new model version or explicitly resume a preserved prior version and create a new scoring run. Never overwrite a completed v4 model definition or reuse a v4 run key for different inputs.

## Open implementation cautions

1. Core evidence, platform, batch-calibration, and confidence parameters are canonical config fields, but explanatory signal-family slot/tail constants remain local to the scorer.
2. `normalizeEvidenceScores` derives its percentile sample and implicit reference clock from physically deduplicated eligible winners, but still emits one result per input row. A losing duplicate can retain a normalized output until rollup dedupe, but cannot independently move the sample or clock.
3. Without an explicit `asOf`, normalization ignores legacy check/update/first-seen timestamps. If all physical observation fields are missing, the Unix-epoch fallback makes later publication dates clamp to age zero.
4. `aggregateBalancedTractionScore` reruns the full scoring-eligibility predicate and physically deduplicates before aggregation. Direct callers must still normalize first because an eligible row's positive `contributionScore` is treated as its already-normalized score magnitude.
5. A present malformed or stale `platformPostId` conflicts with an otherwise valid native URL instead of being ignored, so legacy rows can be quarantined until the explicit ID is corrected or removed.
6. Native URL validation has exact host/path grammar but remains syntactic. Missing or unchecked link state can score, and no check proves ownership, liveness, or metric freshness.
7. Dedupe metric completeness counts every finite numeric metric field, not only positive configured metrics. Scoreability/parent/identity/completeness priority can intentionally retain an older row, and dedupe freshness excludes publication and link-check times.
8. `weightedAvailableScore` and `coverageFactor` remain compatibility fields with v3-oriented names. In v4, `coverageFactor` is a derived ratio and can exceed `1`.
9. Platform and Top Voice controls can show less evidence than contributed to the displayed score. They intentionally preserve the canonical all-platform company score, rank, radius, momentum, top-platform metadata, and score breakdown.
10. A non-replay live overlay normalizes and calibrates the incoming canonical graph before visibility filters. It rebuilds company radii, leaderboard, benchmark momentum, and scoring context, but standalone founder graph-node totals/radii remain unchanged. An exact effective replay leaves score surfaces unchanged.
11. Runtime explanation text uses "verified" for dates and no-evidence states more broadly than the actual eligibility/date checks justify.
12. `src/lib/graph/build.ts` still uses the legacy demo-domain `src/lib/scoring/model.ts` path, whose formulas differ from the production `buildGraphResponse` v4 path.
13. Completed-run provenance and completed-use model immutability are enforced by migration 004 triggers and foreign keys. Only the append-only description of `metric_observations` lacks an update/delete prevention trigger.
14. The checked-in diagnostic artifacts were regenerated from the current recorded input envelope and pass byte-for-byte reproducibility. The experiment artifacts pass their narrower manifest parity check; neither artifact is a live-source or deployment check.
15. The browser/server import chain is fixed, but the production build still records an unexpectedly broad NFT trace through the refresh route. Static publication remains a separate operational surface, with runtime contract validation, API fallback, and background revalidation protecting consumers from invalid snapshots.

These cautions do not make the documented v4 formula ambiguous, but they are important boundaries for callers, migrations, and future refactors.

## Validation boundary

The repository contains deterministic tests for formula behavior, URL eligibility, alias handling, tie-aware calibration, response contracts, dedupe, attribution proof, A16Z ownership, LinkedIn comments, verified live targets, live corrections, and client/server filtering. The release gate in [`SCORING_V4_FINAL_REPORT.md`](./SCORING_V4_FINAL_REPORT.md) records the settled-worktree test, build, artifact, and browser results when they complete. Those checks cover fixtures and local snapshots, not external-source liveness or deployment.

The local `npm run scoring:audit:v4` diagnostic freezes time, disables network fetches, reads local snapshots, and writes the JSON and Markdown files under `docs/outputs/`. It inventories duplicates, aliases, URLs, missing data, platform concentration, reverse-order sensitivity, small metric/timestamp perturbations, and sampled monotonicity. Before/after scores use the evidence normalizer and absolute aggregate without shared batch calibration; published calibrated scores are a separate reference. Its cleanup "after" view is a diagnostic simulation with custom duplicate selection, not a proposed or deployed scoring model.

The checked-in diagnostic output was regenerated after the attribution, account parsing, A16Z ownership, LinkedIn comment, live-correction, and client/server fixes. Its reported counts and zero sampled failures describe only the frozen local inputs and tested perturbations.

Tests and diagnostics do not establish:

- predictive validity against investment or company outcomes
- statistical calibration of a `0..100` score
- optimal metric or platform weights
- robustness to missing-not-at-random platform data
- resistance to purchased, botted, or manipulated engagement
- cross-platform equivalence of views, reactions, comments, stars, or upvotes
- fairness across company type, geography, audience size, or platform access

The confidence value is likewise a deterministic completeness heuristic, not a confidence interval or posterior probability. Any future claim of statistical validation requires a labeled target, a frozen evaluation design, held-out data, reported uncertainty, and versioned results beyond the implementation checks documented here.
