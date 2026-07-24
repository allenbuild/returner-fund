# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-canonical` (`returner-traction` v4.0.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `aa13d55d4b258134fb7b557458bc31440701b567925bf6cf80c9fb40be281323`
- Effective versioned scoring-input SHA-256: `d37367190cccaf50ce6d5206c2ef0b20c84dccc34daaf199121c17ec2a532e15`
- Canonical config: 83 leaf parameters across scoring, calibration, and confidence; 8 role-labeled runtime source files.
- Audit JSON SHA-256: `60daf9ea75c461e92c180664ebfbe7d88de7411407ec64e5376e17b4353acd63`
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 371 companies across 3 cohorts were inspected with 4536 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 1 evidence URL groups.
- Alias diagnostics found 535 overlaps across 415 scored rows.
- Production eligibility rejected 885 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 287 scored rows; metric gaps affect 0.
- Robust fences flagged 97 eligible evidence rows and 7/7 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 13/13 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 3001 | 2405 | 46.4975 | 40.8832 | 40.8832 | 0 | 0 |
| S26 | 115 | 1132 | 857 | 57.113 | 42.2348 | 42.2348 | 0 | 0 |
| A16ZSR006 | 59 | 403 | 389 | 47.0847 | 44.2203 | 44.2203 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 1 | 596 | 0 | 0 | 324 | 50 | 271 | 54 | 65 | 4/4 |
| S26 | 0 | 0 | 275 | 0 | 0 | 123 | 102 | 155 | 40 | 26 | 3/3 |
| A16ZSR006 | 0 | 0 | 14 | 0 | 0 | 76 | 2 | 20 | 10 | 6 | 0/0 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 244/108 | 27/27 | 5.7614/5.7614 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 69/42 | 25/25 | 5.868/5.868 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 72/71 | 3/3 | 0.9695/0.9695 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 359/348 | 141/141 | 31.7614/31.7614 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 6/3 | 2/2 | 0.5838/0.5838 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.1523/0.1523 | 0 | 0 | 0 | 0 |
| S2026 | x | 1978/1656 | 145/145 | 35.5736/35.5736 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 272/176 | 144/144 | 17.5025/17.5025 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 123/90 | 21/21 | 7.6/7.6 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 36/4 | 4/4 | 1.913/1.913 | 0 | 0 | 0 | 0 |
| S26 | instagram | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 249/170 | 79/79 | 33.7304/33.7304 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 5/2 | 2/2 | 0.9304/0.9304 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 634/541 | 63/63 | 25.087/25.087 | 0 | 0 | 0 | 0 |
| S26 | youtube | 85/50 | 38/38 | 6.8/6.8 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/18 | 6/6 | 3.4407/3.4407 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 94/94 | 16/16 | 10.4915/10.4915 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 144/144 | 45/45 | 38.7966/38.7966 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 5/3 | 1/1 | 1.1525/1.1525 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 2.6102/2.6102 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 47/47 | 10/10 | 8.0169/8.0169 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 75/75 | 12/12 | 7.2203/7.2203 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 44.67%/44.67% | 0.3429/0.3429 | 17.01%/17.01% | 63.1%/63.1% |
| S26 | linkedin/linkedin | 51.15%/51.15% | 0.3999/0.3999 | 41.07%/41.07% | 81.59%/81.59% |
| A16ZSR006 | linkedin/linkedin | 65.86%/65.86% | 0.469/0.469 | 52.73%/52.73% | 100%/100% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 108 | 8 | 1.5/25.776 | 0/937.5424 |
| S2026 | hacker_news | 42 | 0 | 9.5/335.1244 | 0/60877.8094 |
| S2026 | instagram | 71 | 1 | 50.2055/1146.3588 | 0/121694.2496 |
| S2026 | linkedin | 348 | 0 | 35.1674/339.2667 | 0.2533/9818.1275 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 1656 | 45 | 12.4/192.33 | 0/10593.7543 |
| S2026 | youtube | 176 | 11 | 7.2686/23.0736 | 0.6644/118.5934 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 90 | 6 | 1.5/24.4849 | 0/828.463 |
| S26 | hacker_news | 4 | 0 | 216.5612/545.9882 | 53.5741/2179.5834 |
| S26 | instagram | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | linkedin | 170 | 0 | 44.046/507.8713 | 0.1864/19320.2845 |
| S26 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 541 | 14 | 4.64/77.92 | 0/4129.9414 |
| S26 | youtube | 50 | 6 | 3.337/12.4184 | 0/72.0238 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 18 | 0 | 1.7194/47.2892 | 0/3612.404 |
| A16ZSR006 | hacker_news | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 94 | 2 | 27.8468/197.5997 | 0.5969/3586.5691 |
| A16ZSR006 | linkedin | 144 | 0 | 49.6925/461.0534 | 0.8421/12713.9538 |
| A16ZSR006 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 47 | 2 | 44.8699/829.3682 | 0/63955.6167 |
| A16ZSR006 | youtube | 75 | 2 | 1.3617/58.6247 | 0/7562.7139 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 9 | 0 |
| S26 | 166 | 0 | 0 | 4 | 0 |
| A16ZSR006 | 189 | 0 | 0 | 2 | 0 |

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
| input_envelope_hash_consistent | yes | "aa13d55d4b258134fb7b557458bc31440701b567925bf6cf80c9fb40be281323" |
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
