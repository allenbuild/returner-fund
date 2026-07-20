# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-canonical` (`returner-traction` v4.0.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `0c2595d3c061037ffe6480cfbe624f5bfb2aa1de5a70e3e5c11d294dddd66ac5`
- Effective versioned scoring-input SHA-256: `3bc4182861dfb6a08ff4c219a197ecffcc0a1431715d43c2a75e1713ad3f933d`
- Canonical config: 83 leaf parameters across scoring, calibration, and confidence; 8 role-labeled runtime source files.
- Audit JSON SHA-256: `15ebc273d209022a7fb9a59829dbaa197ef11b1cebed440bf590c0c23b4b9177`
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 371 companies across 3 cohorts were inspected with 4095 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 1 evidence URL groups.
- Alias diagnostics found 524 overlaps across 407 scored rows.
- Production eligibility rejected 859 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 242 scored rows; metric gaps affect 0.
- Robust fences flagged 86 eligible evidence rows and 14/14 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 13/13 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 2758 | 2184 | 44.9898 | 41.5533 | 41.5533 | 0 | 0 |
| S26 | 115 | 1003 | 730 | 47.9913 | 37.9652 | 37.9652 | 0 | 0 |
| A16ZSR006 | 59 | 334 | 322 | 44.7797 | 42.4576 | 42.4576 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 1 | 574 | 0 | 0 | 318 | 49 | 224 | 53 | 58 | 14/14 |
| S26 | 0 | 0 | 273 | 0 | 0 | 118 | 102 | 139 | 40 | 23 | 0/0 |
| A16ZSR006 | 0 | 0 | 12 | 0 | 0 | 76 | 2 | 20 | 10 | 5 | 0/0 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 233/102 | 26/26 | 5.4416/5.4416 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 69/42 | 25/25 | 5.8883/5.8883 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 72/71 | 3/3 | 0.9797/0.9797 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 279/268 | 129/129 | 28.4162/28.4162 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 5/2 | 1/1 | 0.3959/0.3959 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.1574/0.1574 | 0 | 0 | 0 | 0 |
| S2026 | x | 1971/1649 | 144/144 | 35.4975/35.4975 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 128/49 | 41/41 | 5.1269/5.1269 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 119/86 | 21/21 | 7.5913/7.5913 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 35/3 | 3/3 | 1.3913/1.3913 | 0 | 0 | 0 | 0 |
| S26 | instagram | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 194/115 | 59/59 | 25.3304/25.3304 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 4/1 | 1/1 | 0.4609/0.4609 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 595/504 | 54/54 | 22.513/22.513 | 0 | 0 | 0 | 0 |
| S26 | youtube | 56/21 | 14/14 | 2.5826/2.5826 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/18 | 6/6 | 3.4576/3.4576 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 94/94 | 16/16 | 10.5424/10.5424 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 82/82 | 40/40 | 33.1864/33.1864 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 5/3 | 1/1 | 1.1525/1.1525 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/10 | 7/7 | 3/3 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 40/40 | 10/10 | 7.3051/7.3051 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 75/75 | 12/12 | 7.2373/7.2373 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 52.25%/52.25% | 0.4075/0.4075 | 32.79%/32.79% | 68.61%/68.61% |
| S26 | linkedin/linkedin | 47.57%/47.57% | 0.3997/0.3997 | 56.7%/56.7% | 100%/100% |
| A16ZSR006 | linkedin/linkedin | 61.55%/61.55% | 0.422/0.422 | 58.93%/58.93% | 100%/100% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 102 | 9 | 1.5/17.3737 | 0/365.0853 |
| S2026 | hacker_news | 42 | 0 | 9.5/335.1244 | 0/60877.8094 |
| S2026 | instagram | 71 | 1 | 50.2055/1146.3588 | 0/121694.2496 |
| S2026 | linkedin | 268 | 1 | 50.6248/395.0173 | 1.4298/8412.9028 |
| S2026 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 1649 | 45 | 12.48/192.42 | 0/10511.805 |
| S2026 | youtube | 49 | 2 | 6.875/38.5 | 0/442.7281 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 86 | 5 | 1.5/27.8055 | 0/1125.6265 |
| S26 | hacker_news | 3 | 0 | n/a/n/a | n/a/n/a |
| S26 | instagram | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | linkedin | 115 | 0 | 71.3782/572.3029 | 2.2467/12779.5125 |
| S26 | product_hunt | 1 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 504 | 14 | 4.4599/79.4719 | 0/4552.3865 |
| S26 | youtube | 21 | 4 | 4.85/13.4 | 0.5148/54.6125 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 18 | 0 | 1.5/47.2892 | 0/4098.3456 |
| A16ZSR006 | hacker_news | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 94 | 2 | 27.8468/197.5997 | 0.5969/3586.5691 |
| A16ZSR006 | linkedin | 82 | 0 | 62.4032/761.0746 | 0.5215/31755.1211 |
| A16ZSR006 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | reddit | 10 | 0 | 4/94.3865 | 0/7947.0827 |
| A16ZSR006 | x | 40 | 1 | 40.5203/465.0302 | 0.1042/17523.4559 |
| A16ZSR006 | youtube | 75 | 2 | 1.3617/58.6247 | 0/7562.7139 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 243 | 0 | 0 | 8 | 0 |
| S26 | 145 | 0 | 0 | 5 | 0 |
| A16ZSR006 | 191 | 0 | 0 | 2 | 0 |

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
| input_envelope_hash_consistent | yes | "0c2595d3c061037ffe6480cfbe624f5bfb2aa1de5a70e3e5c11d294dddd66ac5" |
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
