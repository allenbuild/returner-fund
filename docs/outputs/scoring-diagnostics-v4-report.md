# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-absolute-fixed-platform-global-best` (`returner-traction` v4.2.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `291e17984fb529be8bd33b41b0b9ff104dcc3eaf79c9d30094718211a9d2df1a`
- Effective versioned scoring-input SHA-256: `d83fc0c182b51cc652b510a93aa3d471e8534cd3888e8871ab4adee555c88b21`
- Canonical config: 70 leaf parameters across scoring, calibration, and confidence; 9 role-labeled runtime source files.
- Audit JSON SHA-256: `f53fff016beeac50eeb03b0ae84110b8e508aff9d7f5f35c8d031e47f5f8e19a`
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 427 companies across 3 cohorts were inspected with 10492 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 0 evidence URL groups.
- Alias diagnostics found 580 overlaps across 479 scored rows.
- Production eligibility rejected 1656 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 479 scored rows; metric gaps affect 0.
- Robust fences flagged 171 eligible evidence rows and 5/5 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 13/13 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 5373 | 4111 | 36.2538 | 19.2234 | 19.2234 | 0 | 0 |
| S26 | 171 | 2296 | 1918 | 25.4094 | 13.4561 | 13.4561 | 0 | 0 |
| A16ZSR006 | 59 | 2823 | 2807 | 33.8644 | 17.9322 | 17.9322 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 0 | 1262 | 0 | 0 | 351 | 52 | 344 | 87 | 96 | 3/3 |
| S26 | 0 | 0 | 378 | 0 | 0 | 156 | 34 | 185 | 45 | 45 | 1/1 |
| A16ZSR006 | 0 | 0 | 16 | 0 | 0 | 69 | 2 | 45 | 12 | 30 | 1/1 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 300/142 | 27/27 | 0.8883/0.8883 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 607/42 | 25/25 | 0.3401/0.3401 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 169/168 | 12/12 | 0.7868/0.7868 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 614/604 | 156/156 | 6.0558/6.0558 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 6/3 | 2/2 | 0.0457/0.0457 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.0051/0.0051 | 0 | 0 | 0 | 0 |
| S2026 | x | 3214/2902 | 157/157 | 9.2234/9.2234 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 462/249 | 158/158 | 1.9492/1.9492 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 167/98 | 28/28 | 1.0292/1.0292 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 90/8 | 8/8 | 0.117/0.117 | 0 | 0 | 0 | 0 |
| S26 | instagram | 16/16 | 3/3 | 0.1404/0.1404 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 259/258 | 111/111 | 4.924/4.924 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 5/2 | 2/2 | 0.0468/0.0468 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 1409/1330 | 100/100 | 6.3684/6.3684 | 0 | 0 | 0 | 0 |
| S26 | youtube | 350/206 | 74/74 | 0.8363/0.8363 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/16 | 5/5 | 0.4237/0.4237 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 1635/1635 | 16/16 | 2.7966/2.7966 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 217/217 | 48/48 | 7/7 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 5/3 | 1/1 | 0.0847/0.0847 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 722/722 | 38/38 | 6.5424/6.5424 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 206/206 | 15/15 | 1.0678/1.0678 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 47.95%/47.95% | 0.3428/0.3428 | 9.18%/9.18% | 57.83%/57.83% |
| S26 | x/x | 47.45%/47.45% | 0.3681/0.3681 | 30.32%/30.32% | 71.61%/71.61% |
| A16ZSR006 | linkedin/linkedin | 38.74%/38.74% | 0.3105/0.3105 | 25%/25% | 59.92%/59.92% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 142 | 8 | 3/41.5 | 0/1470.9137 |
| S2026 | hacker_news | 42 | 0 | 9.5/335.1244 | 0/60877.8094 |
| S2026 | instagram | 168 | 1 | 25.3168/844.3735 | 0/153910.5456 |
| S2026 | linkedin | 604 | 0 | 21.6/201.674 | 0/5441.9235 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 2902 | 82 | 12.4/135.915 | 0/4470.676 |
| S2026 | youtube | 249 | 5 | 4.35/21.725 | 0/197.9432 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 98 | 5 | 4/58.1148 | 0/2402.175 |
| S26 | hacker_news | 8 | 0 | 44.8506/373.508 | 0.9641/8741.4995 |
| S26 | instagram | 16 | 0 | 2.9938/57.7714 | 0/3316.6655 |
| S26 | linkedin | 258 | 0 | 34.5449/408.5247 | 0/16014.2753 |
| S26 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 1330 | 29 | 9.07/115.8931 | 0/4622.0528 |
| S26 | youtube | 206 | 11 | 2.4312/14.3437 | 0/144.0953 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 16 | 0 | 1.5/51.974 | 0/5166.0967 |
| A16ZSR006 | hacker_news | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 1635 | 0 | 30.8/7002.7933 | 0/22892467.0091 |
| A16ZSR006 | linkedin | 217 | 0 | 21/306.6 | 0/16080.6945 |
| A16ZSR006 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 722 | 27 | 5.25/52.8048 | 0/1358.0514 |
| A16ZSR006 | youtube | 206 | 3 | 0.9624/50.7186 | 0/6996.4666 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 10 | 0 |
| S26 | 186 | 0 | 0 | 10 | 0 |
| A16ZSR006 | 187 | 0 | 0 | 4 | 0 |

## Largest cleanup rank changes

### S2026

No score or rank changes.

### S26

No score or rank changes.

### A16ZSR006

No score or rank changes.

## Invariants

| Invariant | Passed | Observed |
| --- | --- | --- |
| versioned_runtime_parameter_hashes_complete | yes | {"category_hash_mismatch_count":0,"parameter_count":70,"parameter_mismatch_count":0} |
| versioned_source_hashes_complete | yes | {"source_file_count":9,"source_mismatch_count":0} |
| input_envelope_hash_consistent | yes | "291e17984fb529be8bd33b41b0b9ff104dcc3eaf79c9d30094718211a9d2df1a" |
| required_cohort_coverage | yes | ["A16ZSR006","S2026","S26"] |
| company_rankings_complete_unique_ordered_and_bounded | yes | 0 |
| cleanup_row_accounting_exact | yes | 0 |
| retained_rows_production_eligible | yes | 0 |
| eligible_company_physical_dedupe_complete | yes | 0 |
| eligible_physical_dedupe_policy_self_check | yes | {"ambiguous_owner_removed_rows":0,"ambiguous_owner_retained_rows":2,"eligible_removed_rows":1,"eligible_retained_rows":1,"mixed_eligibility_removed_rows":0,"mixed_eligibility_retained_rows":2} |
| batch_platform_comparisons_complete | yes | 0 |
| reverse_input_order_stable | yes | 0 |
| sampled_monotonicity_non_decreasing | yes | 0 |
| artifact_write_allowlist_exact | yes | ["docs/outputs/scoring-diagnostics-v4-audit.json","docs/outputs/scoring-diagnostics-v4-report.md"] |

## Interpretation notes

- GitHub `watchers_count` is stored as `watchers` by the local collector and commonly equals stars. v4 flags equal positive star/watcher pairs; the diagnostic after view canonicalizes metrics with the production normalizer.
- URL findings distinguish platform profiles, search/result pages, and URLs rejected by the production native-evidence check. Zero-score context rows are still counted in diagnostics but do not create a score delta.
- Eligibility rejections use the exported production `scoringEligibility` predicate. The after view removes rejected rows but retains publication-date gaps that production handles with conservative momentum.
- Physical-post duplicates use the production `canonicalPostKey` and `dedupeEvidenceForScoring` comparator only when every retained candidate is eligible and maps to one unambiguous company owner. Ambiguous ownership is reported and never silently collapsed.
- Evidence outliers use Tukey 1.5 IQR fences over `log1p` production-weighted raw engagement; company score outliers use direct 0-100 scores. These are inventory flags, not invariant failures or automatic exclusions.
- Monotonicity uses a deterministic raw-engagement-stratified sample capped at 40 scored rows per platform; exact eligible, sampled, and coverage counts are recorded per cohort in the JSON audit.
- Published scores can include cohort calibration in dataset builders. The before/after comparison therefore uses a fresh exported-scorer baseline on both sides; published ranks remain a separate reference.
- The JSON audit includes every config leaf hash, role-labeled effective source hashes, full company changes for overall and batch/platform comparisons, row-level findings, transformations, and invariant observations.
- The full machine-readable artifact is `docs/outputs/scoring-diagnostics-v4-audit.json`.

The profiler writes only the two allowlisted files under `docs/outputs/` and performs no network or mutable API calls.
