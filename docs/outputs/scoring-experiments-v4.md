# Scoring Experiments v4

## Scope

Compare deterministic candidate score mechanics on the three local cohorts while holding canonical v4 metric, identity, confidence, cross-platform, and batch-calibration semantics fixed.

**Boundary:** No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance.

Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. Diagnostic rank is not a production recommendation; concentration resistance and local perturbation stability are engineering properties, not labeled outcome quality.

Frozen clock: `2026-07-16T12:00:00.000Z`. Production model: `returner-traction@4.0.0` (`returner-traction-v4-canonical`). JSON SHA-256: `16bd3e64027c962af3650252a94032de5beb9ab7fe4640e488b9051772e11ff4`.

## Canonical Reuse

- `src/lib/graph/traction-scoring.ts#normalizeEvidenceScores`
- `src/lib/graph/traction-scoring.ts#aggregateBalancedTractionScore`
- `src/lib/graph/traction-scoring.ts#computeEvidenceRawEngagement`
- `src/lib/graph/traction-scoring.ts#scoringEligibility`
- `src/lib/graph/dedupe.ts#canonicalPostKey`
- `src/lib/graph/dedupe.ts#dedupeEvidenceForScoring`
- `src/lib/scoring/traction-config.ts#TRACTION_SCORING_CONFIG`
- `src/lib/scoring/batch-calibration.ts#calibrateBatchCompanyScores`

The runner completed 93321 imported-normalizer parity assertions and recorded production-config mutation as `false`.

## Candidate Matrix

| Normalization | Absolute | Percentile | Aggregation | Baseline |
| --- | ---: | ---: | --- | --- |
| Absolute-only | 100% | 0% | max | no |
| Absolute-only | 100% | 0% | mean | no |
| Absolute-only | 100% | 0% | decaying-slots | no |
| Percentile-heavy (35/65) | 35% | 65% | max | no |
| Percentile-heavy (35/65) | 35% | 65% | mean | no |
| Percentile-heavy (35/65) | 35% | 65% | decaying-slots | no |
| V4 robust blend | 85% | 15% | max | no |
| V4 robust blend | 85% | 15% | mean | no |
| V4 robust blend | 85% | 15% | decaying-slots | yes |

Max and mean vary only within-platform reduction. All candidates retain canonical v4 metric aliases/weights, eligibility, native identity, physical dedupe, recency, cross-platform aggregation, confidence, and company batch calibration.

## Diagnostic Ranking

Variants are ordered lexicographically by reverse-order exactness, mean small-perturbation Spearman correlation, mean top-10 overlap, mean absolute rank shift, the rate with at least 98% of contribution from one platform, dominant-platform ablation score sensitivity, then stable variant ID.

| Rank | Variant | Perturbation Spearman | Top-10 overlap | Mean rank shift | >=98% top share | Ablation score sensitivity |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Percentile-heavy (35/65) + V4 decaying slots | 0.999813 | 98.33% | 0.2136 | 60.94% | 23.705 |
| 2 | V4 robust blend + Max | 0.999788 | 100% | 0.2413 | 61.65% | 24.7005 |
| 3 | V4 robust blend + V4 decaying slots | 0.999786 | 98.33% | 0.2151 | 63.02% | 22.3489 |
| 4 | Absolute-only + Mean (top-K) | 0.999783 | 100% | 0.2085 | 61.95% | 23.1891 |
| 5 | Percentile-heavy (35/65) + Max | 0.99978 | 100% | 0.2146 | 60.07% | 26.0841 |
| 6 | V4 robust blend + Mean (top-K) | 0.999771 | 98.33% | 0.2464 | 59.99% | 23.1276 |
| 7 | Percentile-heavy (35/65) + Mean (top-K) | 0.999746 | 100% | 0.2147 | 58.86% | 24.0682 |
| 8 | Absolute-only + V4 decaying slots | 0.999537 | 98.33% | 0.2552 | 64.69% | 22.119 |
| 9 | Absolute-only + Max | 0.999479 | 100% | 0.3046 | 63.7% | 24.5911 |

This ordering is a deterministic engineering diagnostic, not a claim that the first row predicts better outcomes.

## Observed Diagnostics

- Reverse-order input was exact for all 9 candidates in all 3 cohorts.
- The v4 baseline's +1% configured-metric Spearman correlation ranged from 0.999601 to 1; the +1-day clock correlation ranged from 0.999496 to 1.
- Single-platform companies represented 37.71% to 60.29% of positive-score companies by cohort.
- Removing every company's own dominant platform reduced v4 baseline top-10 overlap to 50% to 50%, exposing materially greater concentration sensitivity than the small perturbations.
- Percentile-heavy and max/mean candidates can create large company-level rank changes despite high aggregate Spearman values; the detailed examples retain those tails rather than treating cohort-wide correlation as sufficient.

These are descriptive results on frozen, unlabeled snapshots. They do not identify an optimal model.

## Cohort Baselines

| Cohort | Companies | Evidence rows | Scored rows | Baseline top 3 |
| --- | ---: | ---: | ---: | --- |
| S2026 | 197 | 3273 | 1979 | 1. InsForge (79); 2. HeyClicky (77); 3. Ploy (75) |
| S26 | 83 | 548 | 364 | 1. screenpipe (79); 2. Agnost AI (68); 3. 6thSense (64) |
| A16ZSR006 | 59 | 253 | 249 | 1. snag (74); 2. Straia (64); 3. Antihero Studios (61) |

## Stability and Concentration

| Cohort | Variant | +1% Spearman | +1 day Spearman | Reverse exact | Single-platform rate | >=98% top share | Top-platform ablation mean score delta | Top-10 overlap after ablation |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| S2026 | Absolute-only + Max | 0.999816 | 0.999695 | yes | 37.71% | 51.43% | 20.736 | 50% |
| S2026 | Absolute-only + Mean (top-K) | 0.999793 | 0.999783 | yes | 37.71% | 48% | 18.6142 | 60% |
| S2026 | Absolute-only + V4 decaying slots | 0.999758 | 0.999893 | yes | 37.71% | 52.57% | 19.1421 | 50% |
| S2026 | Percentile-heavy (35/65) + Max | 0.999885 | 0.999608 | yes | 37.71% | 48.57% | 22.8985 | 80% |
| S2026 | Percentile-heavy (35/65) + Mean (top-K) | 0.999912 | 0.999713 | yes | 37.71% | 48.57% | 20.1929 | 60% |
| S2026 | Percentile-heavy (35/65) + V4 decaying slots | 0.99995 | 0.999579 | yes | 37.71% | 49.71% | 21.6244 | 60% |
| S2026 | V4 robust blend + Max | 0.999845 | 0.999763 | yes | 37.71% | 48.57% | 21.1472 | 60% |
| S2026 | V4 robust blend + Mean (top-K) | 0.999835 | 0.999743 | yes | 37.71% | 46.86% | 18.5939 | 60% |
| S2026 | V4 robust blend + V4 decaying slots | 0.99986 | 0.99976 | yes | 37.71% | 50.86% | 19.6091 | 50% |
| S26 | Absolute-only + Max | 0.999958 | 0.999097 | yes | 60.29% | 70.59% | 25.7831 | 60% |
| S26 | Absolute-only + Mean (top-K) | 0.999937 | 0.999475 | yes | 60.29% | 70.59% | 24.6988 | 40% |
| S26 | Absolute-only + V4 decaying slots | 0.999727 | 0.999244 | yes | 60.29% | 70.59% | 22.6386 | 60% |
| S26 | Percentile-heavy (35/65) + Max | 0.999874 | 0.999664 | yes | 60.29% | 66.18% | 27.4217 | 50% |
| S26 | Percentile-heavy (35/65) + Mean (top-K) | 0.999874 | 0.999622 | yes | 60.29% | 66.18% | 26.0964 | 60% |
| S26 | Percentile-heavy (35/65) + V4 decaying slots | 0.999916 | 0.999433 | yes | 60.29% | 67.65% | 24.7108 | 40% |
| S26 | V4 robust blend + Max | 0.999601 | 0.999811 | yes | 60.29% | 69.12% | 25.9036 | 60% |
| S26 | V4 robust blend + Mean (top-K) | 0.999895 | 0.999559 | yes | 60.29% | 67.65% | 25.0602 | 40% |
| S26 | V4 robust blend + V4 decaying slots | 0.999601 | 0.999496 | yes | 60.29% | 69.12% | 23.1325 | 50% |
| A16ZSR006 | Absolute-only + Max | 0.999065 | 0.99924 | yes | 60% | 69.09% | 27.2542 | 40% |
| A16ZSR006 | Absolute-only + Mean (top-K) | 0.999942 | 0.999766 | yes | 60% | 67.27% | 26.2542 | 20% |
| A16ZSR006 | Absolute-only + V4 decaying slots | 0.99924 | 0.999357 | yes | 60% | 70.91% | 24.5763 | 40% |
| A16ZSR006 | Percentile-heavy (35/65) + Max | 0.999825 | 0.999825 | yes | 60% | 65.45% | 27.9322 | 40% |
| A16ZSR006 | Percentile-heavy (35/65) + Mean (top-K) | 0.999825 | 0.999532 | yes | 60% | 61.82% | 25.9153 | 20% |
| A16ZSR006 | Percentile-heavy (35/65) + V4 decaying slots | 1 | 1 | yes | 60% | 65.45% | 24.7797 | 50% |
| A16ZSR006 | V4 robust blend + Max | 0.999766 | 0.999942 | yes | 60% | 67.27% | 27.0508 | 40% |
| A16ZSR006 | V4 robust blend + Mean (top-K) | 0.999708 | 0.999883 | yes | 60% | 65.45% | 25.7288 | 20% |
| A16ZSR006 | V4 robust blend + V4 decaying slots | 1 | 1 | yes | 60% | 69.09% | 24.3051 | 50% |

## Representative Before/After Examples (24)

Each row includes the canonical confidence reason and evidence coverage. Full reason arrays and caveats for both sides are preserved in the JSON artifact.

| ID | Cohort | Company | Comparison | Rank | Score | Confidence | Coverage | Reasons | Caveats |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
| S2026-01 | S2026 | Superlog | Absolute-only + Max | 92 -> 49 (+43) | 41 -> 55 (+14) | medium 73.7% | 4 rows, 4/9 platforms | 4 unique scored rows. 4 platforms represented. 3/4 rows have publication dates. 3/4 links were explicitly rechecked. | 1 item has no verified publication date. 1 item link was not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S2026-02 | S2026 | Runtime | Absolute-only + Max | 91 -> 54 (+37) | 41 -> 54 (+13) | medium 71.7% | 4 rows, 3/9 platforms | 4 unique scored rows. 3 platforms represented. 3/4 rows have publication dates. 3/4 links were explicitly rechecked. | 1 item has no verified publication date. 1 item link was not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S2026-03 | S2026 | jo | Percentile-heavy (35/65) + Mean (top-K) | 35 -> 147 (-112) | 56 -> 25 (-31) | medium 66.4% | 5 rows, 1/9 platforms | 5 unique scored rows. 1 platform represented. 5/5 rows have publication dates. 0/5 links were explicitly rechecked. | 5 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. Single-platform score; cross-platform corroboration is unavailable. |
| S2026-04 | S2026 | Adialante | Percentile-heavy (35/65) + Mean (top-K) | 13 -> 120 (-107) | 63 -> 35 (-28) | high 77.2% | 6 rows, 2/9 platforms | 6 unique scored rows. 2 platforms represented. 6/6 rows have publication dates. 4/6 links were explicitly rechecked. | 2 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S2026-05 | S2026 | Totalis | V4 baseline after +1% configured metrics | 54 -> 47 (+7) | 51 -> 53 (+2) | medium 73.2% | 7 rows, 2/9 platforms | 7 unique scored rows. 2 platforms represented. 6/7 rows have publication dates. 1/7 links were explicitly rechecked. | 1 item has no verified publication date. 6 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S2026-06 | S2026 | ProjectX | V4 baseline after +1% configured metrics | 84 -> 78 (+6) | 43 -> 45 (+2) | medium 74.9% | 11 rows, 1/9 platforms | 11 unique scored rows. 1 platform represented. 11/11 rows have publication dates. 0/11 links were explicitly rechecked. | 11 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. Single-platform score; cross-platform corroboration is unavailable. |
| S2026-07 | S2026 | Wato | Remove each company's dominant platform (x for this row) | 26 -> 196 (-170) | 59 -> 0 (-59) | low 0% | 0 rows, 0/9 platforms | No eligible native traction evidence. | Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No eligible native evidence with visible metrics. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S2026-08 | S2026 | Thomas | Remove each company's dominant platform (x for this row) | 46 -> 192 (-146) | 53 -> 0 (-53) | low 0% | 0 rows, 0/9 platforms | No eligible native traction evidence. | Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No eligible native evidence with visible metrics. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S26-01 | S26 | Blueprints | Absolute-only + Max | 16 -> 38 (-22) | 50 -> 44 (-6) | high 80.6% | 31 rows, 2/9 platforms | 31 unique scored rows. 2 platforms represented. 31/31 rows have publication dates. 1/31 links were explicitly rechecked. | 30 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S26-02 | S26 | Coasty | Absolute-only + Max | 22 -> 43 (-21) | 48 -> 42 (-6) | high 83.8% | 27 rows, 3/9 platforms | 27 unique scored rows. 3 platforms represented. 27/27 rows have publication dates. 4/27 links were explicitly rechecked. | 23 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S26-03 | S26 | Archal | Percentile-heavy (35/65) + Mean (top-K) | 4 -> 50 (-46) | 64 -> 31 (-33) | medium 74.3% | 7 rows, 2/9 platforms | 7 unique scored rows. 2 platforms represented. 6/7 rows have publication dates. 2/7 links were explicitly rechecked. | 1 item has no verified publication date. 5 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S26-04 | S26 | 6thSense | Percentile-heavy (35/65) + Mean (top-K) | 3 -> 42 (-39) | 64 -> 41 (-23) | high 81.3% | 19 rows, 2/9 platforms | 19 unique scored rows. 2 platforms represented. 19/19 rows have publication dates. 3/19 links were explicitly rechecked. | 16 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S26-05 | S26 | Prized | V4 baseline after +1% configured metrics | 49 -> 44 (+5) | 35 -> 37 (+2) | medium 65.1% | 3 rows, 2/9 platforms | 3 unique scored rows. 2 platforms represented. 3/3 rows have publication dates. 1/3 links were explicitly rechecked. | 2 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S26-06 | S26 | Cova | V4 baseline after +1% configured metrics | 39 -> 37 (+2) | 39 -> 40 (+1) | medium 55.7% | 1 rows, 1/9 platforms | 1 unique scored row. 1 platform represented. 1/1 rows have publication dates. | Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. Single-platform score; cross-platform corroboration is unavailable. Sparse evidence: fewer than three unique scored items. |
| S26-07 | S26 | Whitespace | Remove each company's dominant platform (linkedin for this row) | 20 -> 82 (-62) | 50 -> 0 (-50) | low 0% | 0 rows, 0/9 platforms | No eligible native traction evidence. | Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No eligible native evidence with visible metrics. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| S26-08 | S26 | Zomma | Remove each company's dominant platform (linkedin for this row) | 21 -> 83 (-62) | 50 -> 0 (-50) | low 0% | 0 rows, 0/9 platforms | No eligible native traction evidence. | Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No eligible native evidence with visible metrics. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| A16ZSR006-01 | A16ZSR006 | Modaic | Absolute-only + Max | 9 -> 21 (-12) | 54 -> 49 (-5) | high 77.3% | 10 rows, 2/9 platforms | 10 unique scored rows. 2 platforms represented. 10/10 rows have publication dates. 0/10 links were explicitly rechecked. | 10 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| A16ZSR006-02 | A16ZSR006 | Bilrost | Absolute-only + Max | 21 -> 11 (+10) | 46 -> 56 (+10) | low 47.7% | 1 rows, 1/9 platforms | 1 unique scored row. 1 platform represented. 1/1 rows have publication dates. 0/1 links were explicitly rechecked. | 1 item link was not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. Single-platform score; cross-platform corroboration is unavailable. Sparse evidence: fewer than three unique scored items. |
| A16ZSR006-03 | A16ZSR006 | Straia | Percentile-heavy (35/65) + Mean (top-K) | 2 -> 29 (-27) | 64 -> 40 (-24) | medium 63.4% | 4 rows, 1/9 platforms | 4 unique scored rows. 1 platform represented. 4/4 rows have publication dates. 0/4 links were explicitly rechecked. | 4 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. Single-platform score; cross-platform corroboration is unavailable. |
| A16ZSR006-04 | A16ZSR006 | Hotbox | Percentile-heavy (35/65) + Mean (top-K) | 11 -> 34 (-23) | 52 -> 36 (-16) | high 75.2% | 8 rows, 2/9 platforms | 8 unique scored rows. 2 platforms represented. 8/8 rows have publication dates. 0/8 links were explicitly rechecked. | 8 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| A16ZSR006-05 | A16ZSR006 | Prior Foundry | V4 baseline after +1% configured metrics | 42 -> 42 (0) | 25 -> 26 (+1) | low 47.7% | 1 rows, 1/9 platforms | 1 unique scored row. 1 platform represented. 1/1 rows have publication dates. 0/1 links were explicitly rechecked. | 1 item link was not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. Single-platform score; cross-platform corroboration is unavailable. Sparse evidence: fewer than three unique scored items. |
| A16ZSR006-06 | A16ZSR006 | Acceler8 | V4 baseline after +1% configured metrics | 18 -> 18 (0) | 47 -> 47 (0) | medium 54.3% | 2 rows, 1/9 platforms | 2 unique scored rows. 1 platform represented. 2/2 rows have publication dates. 0/2 links were explicitly rechecked. | 2 item links were not explicitly rechecked in this snapshot. Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. Single-platform score; cross-platform corroboration is unavailable. Sparse evidence: fewer than three unique scored items. |
| A16ZSR006-07 | A16ZSR006 | Straia | Remove each company's dominant platform (linkedin for this row) | 2 -> 55 (-53) | 64 -> 0 (-64) | low 0% | 0 rows, 0/9 platforms | No eligible native traction evidence. | Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No eligible native evidence with visible metrics. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |
| A16ZSR006-08 | A16ZSR006 | Sellara | Remove each company's dominant platform (linkedin for this row) | 7 -> 51 (-44) | 56 -> 0 (-56) | low 0% | 0 rows, 0/9 platforms | No eligible native traction evidence. | Candidate scores are in-memory diagnostics and do not change production configuration. Confidence is the canonical v4 evidence-completeness heuristic, not a probability or confidence interval. No eligible native evidence with visible metrics. No labeled outcomes are available, so this comparison does not establish predictive calibration or investment performance. |

## Reproduction

```bash
npm run scoring:experiments
shasum -a 256 docs/outputs/scoring-experiments-v4.json docs/outputs/scoring-experiments-v4.md docs/SCORING_EXPERIMENTS.md
```

The runner reads local snapshots only, disables network access, freezes time, and refuses writes outside its three documented output paths.
