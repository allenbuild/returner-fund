# Scoring Model

## Principles

- Scores are relative within platform and within selected YC batch.
- Default scoring context is `S2026` / `YC Spring 2026`.
- Do not claim that one Instagram like equals one LinkedIn like or one X like.
- Use within-platform percentiles and within-batch percentiles.
- Every score stores an explanation with intermediate values.
- Missing platforms are re-normalized across available weighted platforms and recorded in explanation limitations.
- Identity/source quality is represented by `review_state`, not a numeric product field.

## Raw Engagement Weights

| Metric | Weight |
| --- | ---: |
| likes | 1 |
| comments | 3 |
| shares/reposts | 4 |
| saves | 4 |
| views | 0.02 |
| upvotes | 2 |
| GitHub stars | 1.5 |
| GitHub forks | 4 |
| GitHub watchers | 2 |
| GitHub issues/discussions | 0.5 |
| GitHub recent push activity (`recent_commits_30d`) | 1 |
| Product Hunt upvotes | 2 |
| Product Hunt comments | 3 |

## Post-Level Formula

1. Compute weighted raw engagement:

```text
raw = likes*1 + comments*3 + shares*4 + reposts*4 + saves*4 + views*0.02
    + upvotes*2 + stars*1.5 + forks*4 + watchers*2 + issues*0.5
    + recent_commits_30d*1
```

2. Apply log scaling:

```text
log_engagement = log1p(raw)
```

3. Apply recency decay:

```text
recency_weight = 0.5 ^ (age_days / half_life_days)
```

Default half-life: 60 days, with platform-specific overrides in `src/lib/graph/traction-scoring-config.ts`.

4. Compute engagement rate if follower count exists:

```text
engagement_rate = raw / max(followers, 1)
```

5. Convert to percentiles:

- `platform_log_percentile`
- `engagement_rate_percentile`
- `momentum_percentile`

6. Combine:

```text
post_score = 100 * (
  0.50 * platform_log_percentile +
  0.30 * engagement_rate_percentile +
  0.20 * momentum_percentile
)
```

## Platform-Level Formula

For each entity/platform:

- Average top 5 post scores.
- Add smaller posting consistency contribution.
- Add smaller account-level metric contribution when available.
- Keep final platform score in 0..100.
- Exclude `rejected` profiles.
- Keep `needs_review` profiles visible but marked in score explanations.

Suggested MVP:

```text
platform_score = 0.75 * avg_top_5_posts + 0.15 * consistency + 0.10 * account_metric_score
```

Platform score explanations must include sample size, metric availability, baseline source status, connector limitations, and review-state mix.

## Company-Level Formula

Current live platform weights:

- GitHub: 35%
- X/Twitter: 20%
- Instagram: 15%
- Product Hunt: 15%
- YouTube: 10%
- LinkedIn: 3%
- Hacker News: 2%

Founder evidence is attached to founders in the data model, then rolls up into company scoring and company feeds. Founder nodes do not appear in the graph.

For this MVP, disabled/risky platform access is simply absent unless explicitly configured. Available platform weights are re-normalized, then a coverage adjustment is applied:

```text
coverage_factor = 0.85 + 0.15 * sqrt(platforms_with_evidence / supported_platforms)
final_score = weighted_available_score * coverage_factor
```

Final company score:

- 0..100
- relative to companies in selected batch
- node radius uses percentile/caps, not raw absolute score
- default `S2026` comparisons should track loaded count versus expected count `197`

## Founder-Level Formula

Founder score uses personal social accounts:

- recent post performance
- follower-adjusted engagement
- relevance to company
- profile review state

Final founder score:

- 0..100
- relative to founders in selected batch
- node radius uses percentile/caps

## Fastest Gaining

Compare latest snapshot against previous snapshot:

- absolute score delta
- percentage score delta
- rank delta
- new high-performing posts since previous refresh
- platform responsible for largest change

## Baseline Research

Baseline sources are stored in `platform_baselines`:

- platform
- metric_name
- segment
- value
- source_url
- source_title
- collected_at
- notes

MVP fallback:

- use within-batch percentiles
- record baseline limitations in `score_explanation_json`

## Explanation JSON

Every post score stores:

```json
{
  "rawMetrics": {},
  "weights": {},
  "rawEngagement": 0,
  "logEngagement": 0,
  "ageDays": 0,
  "recencyWeight": 1,
  "engagementRate": null,
  "platformLogPercentile": 0,
  "engagementRatePercentile": 0,
  "momentumPercentile": 0,
  "postScore": 0,
  "review_state": "verified",
  "reviewSignals": [],
  "limitations": []
}
```

Snapshot explanations must keep enough detail to answer why a node changed rank without exposing internal review-rank numbers as product fields.
