# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-absolute-fixed-platform-global-best` (`returner-traction` v4.2.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `d927dd2312555f1d36a3c35bfae8284afd535d7ba6a367d8e720454c6e496fb5`
- Effective versioned scoring-input SHA-256: `36641bfc7c074b886376a38dc1cfbc51664cee6fe540c34c934d71434c842584`
- Canonical config: 70 leaf parameters across scoring, calibration, and confidence; 9 role-labeled runtime source files.
- Audit JSON SHA-256: `c58191526cfa42769a700eeb1d88860802a537c4cf65d64ee43d133a40d9dec8`
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 430 companies across 3 cohorts were inspected with 36598 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 131 evidence URL groups.
- Alias diagnostics found 577 overlaps across 473 scored rows.
- Production eligibility rejected 24976 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 431 scored rows; metric gaps affect 0.
- Robust fences flagged 473 eligible evidence rows and 5/5 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 13/13 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 18648 | 4876 | 37.5584 | 19.9036 | 19.9036 | 0 | 0 |
| S26 | 174 | 10888 | 2565 | 30.4023 | 16.1092 | 16.1092 | 0 | 0 |
| A16ZSR006 | 59 | 7062 | 4181 | 36.0169 | 19.0847 | 19.0847 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 3 | 13772 | 0 | 0 | 348 | 52 | 630 | 3412 | 121 | 2/2 |
| S26 | 0 | 128 | 8323 | 0 | 0 | 156 | 37 | 257 | 1398 | 61 | 1/1 |
| A16ZSR006 | 0 | 0 | 2881 | 0 | 0 | 69 | 2 | 36 | 513 | 291 | 2/2 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 300/142 | 27/27 | 0.8883/0.8883 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 2403/46 | 27/27 | 0.3553/0.3553 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 297/295 | 12/12 | 0.8426/0.8426 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 651/640 | 159/159 | 6.1777/6.1777 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 13/3 | 2/2 | 0.0457/0.0457 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.0051/0.0051 | 0 | 0 | 0 | 0 |
| S2026 | x | 13094/3485 | 160/160 | 9.6751/9.6751 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 822/264 | 160/160 | 1.9797/1.9797 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 167/98 | 28/28 | 1.0115/1.0115 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 492/19 | 19/19 | 0.2529/0.2529 | 0 | 0 | 0 | 0 |
| S26 | instagram | 55/55 | 5/5 | 0.2586/0.2586 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 277/273 | 113/113 | 4.9023/4.9023 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 7/2 | 2/2 | 0.046/0.046 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 8835/1871 | 133/133 | 8.7644/8.7644 | 0 | 0 | 0 | 0 |
| S26 | youtube | 469/247 | 84/84 | 0.931/0.931 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/16 | 5/5 | 0.4237/0.4237 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 1/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 2904/2903 | 16/16 | 3.3051/3.3051 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 235/235 | 48/48 | 7.0847/7.0847 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 8/5 | 2/2 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 3305/802 | 40/40 | 7.0339/7.0339 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 571/212 | 15/15 | 1.0678/1.0678 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 48.63%/48.63% | 0.3459/0.3459 | 8.67%/8.67% | 58%/58% |
| S26 | x/x | 54.46%/54.46% | 0.3961/0.3961 | 23.67%/23.67% | 67.89%/67.89% |
| A16ZSR006 | x/x | 36.9%/36.9% | 0.3049/0.3049 | 27.59%/27.59% | 60.22%/60.22% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 142 | 8 | 3/41.5 | 0/1470.9137 |
| S2026 | hacker_news | 46 | 0 | 9.5/317.3535 | 0/53147.405 |
| S2026 | instagram | 295 | 1 | 9.9/496.7877 | 0/153627.0956 |
| S2026 | linkedin | 640 | 0 | 21.6/186.1999 | 0/4461.739 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 3485 | 106 | 13.2/134.56 | 0/3997.4934 |
| S2026 | youtube | 264 | 6 | 4.3437/21.8182 | 0/200.342 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 98 | 5 | 4/58.1148 | 0/2402.175 |
| S26 | hacker_news | 19 | 0 | 12.0767/353.1857 | 0/49925.4206 |
| S26 | instagram | 55 | 1 | 3.3/30.8074 | 0/638.9062 |
| S26 | linkedin | 273 | 0 | 31.4/395 | 0/16919.7828 |
| S26 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 1871 | 43 | 11.2/135.59 | 0/5115.9164 |
| S26 | youtube | 247 | 12 | 2.1/12.3744 | 0/118.8518 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 16 | 0 | 1.5/51.974 | 0/5166.0967 |
| A16ZSR006 | hacker_news | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 2903 | 257 | 23.1/329.9591 | 0/16841.6469 |
| A16ZSR006 | linkedin | 235 | 0 | 19.0425/301.35 | 0/17714.2965 |
| A16ZSR006 | product_hunt | 5 | 0 | 83.5/834 | 1.7203/25936.6798 |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 802 | 30 | 5.705/54.8429 | 0/1341.2173 |
| A16ZSR006 | youtube | 212 | 4 | 0.95/48.3691 | 0/6288.0502 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 13 | 0 |
| S26 | 221 | 0 | 0 | 6 | 0 |
| A16ZSR006 | 189 | 0 | 0 | 3 | 0 |

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
| input_envelope_hash_consistent | yes | "d927dd2312555f1d36a3c35bfae8284afd535d7ba6a367d8e720454c6e496fb5" |
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
