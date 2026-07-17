# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-canonical` (`returner-traction` v4.0.0)
- Git SHA: `4c902faca02f971a3008cd9f76e1a94d5b14d854`
- Input envelope SHA-256: `78582133534fbc4f4fdc70370e6e5401b28e3492dd5d0c88be0ed73e66da6ae2`
- Effective versioned scoring-input SHA-256: `03e432277ba4769cc4121311b8282d84edc3af135159046c27730358a45835e6`
- Canonical config: 83 leaf parameters across scoring, calibration, and confidence; 8 role-labeled runtime source files.
- Audit JSON SHA-256: `3cd06213e6a0e819d0f500632dbc32908399302b9bd8e4b2915395c03f739e72`
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 339 companies across 3 cohorts were inspected with 4074 cohort-scoped evidence rows.
- Global canonical duplicates: 0 company-ID groups, 0 founder-ID groups, 11 social-account URL groups, 0 physical-post groups, and 18 evidence URL groups.
- Alias diagnostics found 507 overlaps across 406 scored rows.
- Production eligibility rejected 1481 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 60 scored rows; metric gaps affect 0.
- Robust fences flagged 75 eligible evidence rows and 0/0 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 13/13 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 3273 | 1980 | 36.5635 | 34.8477 | 34.8477 | 0 | 0 |
| S26 | 83 | 548 | 364 | 33.5181 | 31.8675 | 31.8675 | 0 | 0 |
| A16ZSR006 | 59 | 253 | 249 | 35.6271 | 33.2542 | 33.2542 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 18 | 1293 | 0 | 0 | 298 | 97 | 909 | 894 | 59 | 0/0 |
| S26 | 0 | 0 | 184 | 0 | 0 | 113 | 94 | 103 | 65 | 13 | 0/0 |
| A16ZSR006 | 0 | 0 | 4 | 0 | 0 | 79 | 2 | 1 | 2 | 3 | 0/0 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 211/92 | 24/24 | 3.8528/3.8528 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 18/18 | 18/18 | 3.2995/3.2995 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 62/62 | 3/3 | 0.6244/0.6244 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 136/101 | 79/79 | 12.8528/12.8528 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 5/2 | 1/1 | 0.2893/0.2893 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.1117/0.1117 | 0 | 0 | 0 | 0 |
| S2026 | x | 1979/1628 | 143/143 | 26.8274/26.8274 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 82/76 | 63/63 | 5.3706/5.3706 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 82/57 | 15/15 | 4.8313/4.8313 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 4/3 | 3/3 | 1.3855/1.3855 | 0 | 0 | 0 | 0 |
| S26 | instagram | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 143/66 | 45/45 | 19.8916/19.8916 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 4/1 | 1/1 | 0.4699/0.4699 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 273/221 | 29/29 | 13.8916/13.8916 | 0 | 0 | 0 | 0 |
| S26 | youtube | 16/16 | 9/9 | 1.9277/1.9277 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 19/17 | 6/6 | 2.5763/2.5763 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 68/68 | 16/16 | 7.6102/7.6102 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 63/63 | 35/35 | 21.7966/21.7966 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 5/3 | 1/1 | 0.8475/0.8475 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/10 | 7/7 | 2.1356/2.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 38/38 | 10/10 | 4.9153/4.9153 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 50/50 | 12/12 | 5.2712/5.2712 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 62.6%/62.6% | 0.4545/0.4545 | 37.71%/37.71% | 98.12%/98.12% |
| S26 | linkedin/linkedin | 51.08%/51.08% | 0.3913/0.3913 | 60.29%/60.29% | 100%/100% |
| A16ZSR006 | linkedin/linkedin | 62.83%/62.83% | 0.4266/0.4266 | 60%/60% | 100%/100% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 92 | 7 | 1.5/27.9505 | 0/1139.8539 |
| S2026 | hacker_news | 18 | 1 | 206.9281/498.6107 | 54.8259/1859.8417 |
| S2026 | instagram | 62 | 1 | 41.925/1123.1876 | 0/150670.7699 |
| S2026 | linkedin | 101 | 0 | 106.8/684.1 | 5.7285/10975.3204 |
| S2026 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 1628 | 48 | 12.31/180.4399 | 0/9130.993 |
| S2026 | youtube | 76 | 2 | 4.8248/25.601 | 0/258.6096 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 57 | 2 | 1/28.5 | 0/1670.1293 |
| S26 | hacker_news | 3 | 0 | n/a/n/a | n/a/n/a |
| S26 | instagram | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | linkedin | 66 | 1 | 138.397/816.7148 | 8.8114/11616.8151 |
| S26 | product_hunt | 1 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 221 | 8 | 10.64/170.26 | 0/9664.1896 |
| S26 | youtube | 16 | 2 | 5.0736/12.5286 | 0.827/43.9742 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 17 | 0 | 1.5/49.5 | 0/4583.7793 |
| A16ZSR006 | hacker_news | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 68 | 2 | 27.575/217.1492 | 0.3547/4600.5617 |
| A16ZSR006 | linkedin | 63 | 0 | 64.6856/808.2665 | 0.5189/34995.4107 |
| A16ZSR006 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | reddit | 10 | 0 | 4/94.3865 | 0/7947.0827 |
| A16ZSR006 | x | 38 | 0 | 38.5908/426.7334 | 0.1149/15188.4105 |
| A16ZSR006 | youtube | 50 | 1 | 1.7354/96.6477 | 0/20825.5917 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 221 | 0 | 0 | 6 | 0 |
| S26 | 140 | 0 | 0 | 1 | 0 |
| A16ZSR006 | 188 | 0 | 0 | 0 | 0 |

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
| input_envelope_hash_consistent | yes | "78582133534fbc4f4fdc70370e6e5401b28e3492dd5d0c88be0ed73e66da6ae2" |
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
