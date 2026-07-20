# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-canonical` (`returner-traction` v4.0.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `c78158f4ed3edcc90109a22ac68c7c2c52ece76668d0231f012b1992cdd5289c`
- Effective versioned scoring-input SHA-256: `6a3b255c2a6636bf14df9bece844b37fc28811c6d87f89b19d8e344e6df954dd`
- Canonical config: 83 leaf parameters across scoring, calibration, and confidence; 8 role-labeled runtime source files.
- Audit JSON SHA-256: `f5bb8c882432c4b4abae15dd7402e42b278f2d997c4268879c174588f799ee76`
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 371 companies across 3 cohorts were inspected with 4136 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 5 physical-post groups, and 6 evidence URL groups.
- Alias diagnostics found 539 overlaps across 428 scored rows.
- Production eligibility rejected 880 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 248 scored rows; metric gaps affect 0.
- Robust fences flagged 87 eligible evidence rows and 15/15 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 13/13 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 2841 | 2240 | 47.8325 | 39.3249 | 39.3249 | 0 | 0 |
| S26 | 115 | 989 | 714 | 46 | 36.3913 | 36.3913 | 0 | 0 |
| A16ZSR006 | 59 | 306 | 302 | 42.322 | 40.5932 | 40.5932 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 5 | 6 | 601 | 0 | 0 | 307 | 41 | 296 | 52 | 61 | 15/15 |
| S26 | 0 | 0 | 275 | 0 | 0 | 136 | 102 | 127 | 40 | 21 | 0/0 |
| A16ZSR006 | 0 | 0 | 4 | 0 | 0 | 80 | 2 | 1 | 2 | 5 | 0/0 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 217/101 | 26/26 | 5.4365/5.4365 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 47/20 | 18/18 | 4.6497/4.6497 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 72/71 | 3/3 | 0.9797/0.9797 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 357/315 | 141/141 | 28.7208/28.7208 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 5/2 | 1/1 | 0.3959/0.3959 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.1574/0.1574 | 0 | 0 | 0 | 0 |
| S2026 | x | 1972/1650 | 144/144 | 35.5228/35.5228 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 170/80 | 66/66 | 7.8528/7.8528 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 119/86 | 21/21 | 7.5652/7.5652 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 35/3 | 3/3 | 1.4/1.4 | 0 | 0 | 0 | 0 |
| S26 | instagram | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 180/101 | 54/54 | 23.0348/23.0348 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 4/1 | 1/1 | 0.4609/0.4609 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 593/501 | 54/54 | 22.4783/22.4783 | 0 | 0 | 0 | 0 |
| S26 | youtube | 58/22 | 14/14 | 2.713/2.713 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 19/17 | 6/6 | 3.4576/3.4576 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 94/94 | 16/16 | 10.1864/10.1864 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 63/63 | 35/35 | 29.1017/29.1017 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 5/3 | 1/1 | 1.1525/1.1525 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/10 | 7/7 | 3/3 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 40/40 | 10/10 | 7.3051/7.3051 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 75/75 | 12/12 | 7.2542/7.2542 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 51.53%/51.53% | 0.396/0.396 | 23.91%/23.91% | 68.69%/68.69% |
| S26 | linkedin/linkedin | 44.77%/44.77% | 0.3944/0.3944 | 55.91%/55.91% | 100%/100% |
| A16ZSR006 | linkedin/linkedin | 58.41%/58.41% | 0.39/0.39 | 60%/60% | 100%/100% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 101 | 9 | 1.5/17.5 | 0/371.4083 |
| S2026 | hacker_news | 20 | 3 | 170.4781/485.112 | 34.9267/2319.2129 |
| S2026 | instagram | 71 | 1 | 50.2055/1146.3588 | 0/121694.2496 |
| S2026 | linkedin | 315 | 0 | 20.3453/183.4497 | 0/4684.3562 |
| S2026 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 1650 | 45 | 12.45/192.39 | 0/10542.9201 |
| S2026 | youtube | 80 | 3 | 4.8248/28.2124 | 0/327.0903 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 86 | 5 | 1.5/26.486 | 0/1001.0044 |
| S26 | hacker_news | 3 | 0 | n/a/n/a | n/a/n/a |
| S26 | instagram | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | linkedin | 101 | 0 | 38.7/527.4 | 0/25656.9091 |
| S26 | product_hunt | 1 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 501 | 14 | 4.4/77.94 | 0/4411.1693 |
| S26 | youtube | 22 | 2 | 3.3575/12.1424 | 0/67.8391 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 17 | 0 | 1.5/49 | 0/4471.136 |
| A16ZSR006 | hacker_news | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 94 | 2 | 18.2042/168.723 | 0/4458.1895 |
| A16ZSR006 | linkedin | 63 | 0 | 64.6856/808.2665 | 0.5189/34995.4107 |
| A16ZSR006 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | reddit | 10 | 0 | 4/94.3865 | 0/7947.0827 |
| A16ZSR006 | x | 40 | 1 | 40.5203/465.0302 | 0.1042/17523.4559 |
| A16ZSR006 | youtube | 75 | 2 | 1.3617/58.6247 | 0/7562.7139 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 223 | 0 | 0 | 8 | 0 |
| S26 | 146 | 0 | 0 | 3 | 0 |
| A16ZSR006 | 190 | 0 | 0 | 1 | 0 |

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
| versioned_runtime_parameter_hashes_complete | yes | {"category_hash_mismatch_count":0,"parameter_count":83,"parameter_mismatch_count":0} |
| versioned_source_hashes_complete | yes | {"source_file_count":8,"source_mismatch_count":0} |
| input_envelope_hash_consistent | yes | "c78158f4ed3edcc90109a22ac68c7c2c52ece76668d0231f012b1992cdd5289c" |
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
