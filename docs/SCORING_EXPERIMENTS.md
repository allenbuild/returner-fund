# Scoring Experiments

## V4 Candidate Run

- Frozen clock: `2026-07-16T12:00:00.000Z`.
- Historical production model used for this frozen experiment:
  `returner-traction@4.0.0` (`returner-traction-v4-canonical`). Current
  production is `returner-traction@4.0.1`
  (`returner-traction-v4-monotonic`).
- Scope: 3 cohorts, 339 companies, 4074 cohort-scoped evidence rows, and 9 candidate combinations.
- Canonical parity assertions: 93321; production config mutated: `false`.
- Machine-readable artifact SHA-256: `16bd3e64027c962af3650252a94032de5beb9ab7fe4640e488b9051772e11ff4`.

**Interpretation boundary:** No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance.

Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. Diagnostic rank is not a production recommendation; concentration resistance and local perturbation stability are engineering properties, not labeled outcome quality.

## Candidates

Normalization compares absolute-only, percentile-heavy (35/65), and the imported v4 robust blend. Platform aggregation compares max, mean of the canonical top-K window, and imported v4 decaying slots. Metric aliases/weights, eligibility, identity, physical dedupe, recency, cross-platform aggregation, confidence, and company batch calibration remain canonical.

## Deterministic Diagnostic Order

| Rank | Candidate | Perturbation Spearman | Top-10 overlap | >=98% top share |
| ---: | --- | ---: | ---: | ---: |
| 1 | Percentile-heavy (35/65) + V4 decaying slots | 0.999813 | 98.33% | 60.94% |
| 2 | V4 robust blend + Max | 0.999788 | 100% | 61.65% |
| 3 | V4 robust blend + V4 decaying slots | 0.999786 | 98.33% | 63.02% |
| 4 | Absolute-only + Mean (top-K) | 0.999783 | 100% | 61.95% |
| 5 | Percentile-heavy (35/65) + Max | 0.99978 | 100% | 60.07% |
| 6 | V4 robust blend + Mean (top-K) | 0.999771 | 98.33% | 59.99% |
| 7 | Percentile-heavy (35/65) + Mean (top-K) | 0.999746 | 100% | 58.86% |
| 8 | Absolute-only + V4 decaying slots | 0.999537 | 98.33% | 64.69% |
| 9 | Absolute-only + Max | 0.999479 | 100% | 63.7% |

The order above ranks mechanical stability and concentration diagnostics only. It is not a recommendation or predictive leaderboard.

## Observed Diagnostics

All reverse-order runs matched exactly. The v4 baseline remained highly rank-stable under +1% configured metrics and a +1-day clock, while dominant-platform ablation caused much larger movement and only 50% top-10 overlap in each cohort. Single-platform coverage is therefore reported separately from near-total top-contribution concentration.

## V4 Baseline by Cohort

| Cohort | Score range | Mean coverage | Single-platform rate | >=98% top share | +1% metric Spearman | +1 day Spearman | Ablation top-10 overlap |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0-79 | 21.08% | 37.71% | 50.86% | 0.99986 | 0.99976 | 50% |
| S26 | 0-79 | 16.67% | 60.29% | 69.12% | 0.999601 | 0.999496 | 50% |
| A16ZSR006 | 0-74 | 17.57% | 60% | 69.09% | 1 | 1 | 50% |

The detailed report contains 24 before/after examples with confidence reasons, evidence coverage, and caveats.

## Artifacts

- Detailed report: [`docs/outputs/scoring-experiments-v4.md`](outputs/scoring-experiments-v4.md)
- Machine-readable results: [`docs/outputs/scoring-experiments-v4.json`](outputs/scoring-experiments-v4.json)

Reproduce with `npm run scoring:experiments`. The runner is offline, frozen-clock, and write-allowlisted.
