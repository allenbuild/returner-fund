# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-monotonic` (`returner-traction` v4.0.1)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `02f4d8d1e830695b370664cf8ae1287a10b37ff574108433c8e6e740f8435f8b`
- Effective versioned scoring-input SHA-256: `8e6e433e518b64dc7ee9f196da03d92836a59a89000b261395015c2d7581bbdc`
- Canonical config: 83 leaf parameters across scoring, calibration, and confidence; 8 role-labeled runtime source files.
- Audit JSON SHA-256: `6a52a9a6fe0757096096cf6ed8542ec313f3c1ebcfab575c49052bbff0c5364d`
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 371 companies across 3 cohorts were inspected with 7824 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 0 evidence URL groups.
- Alias diagnostics found 573 overlaps across 474 scored rows.
- Production eligibility rejected 1449 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 352 scored rows; metric gaps affect 0.
- Robust fences flagged 176 eligible evidence rows and 8/8 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 13/13 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 5028 | 3835 | 46.1371 | 39.6599 | 39.6599 | 0 | 0 |
| S26 | 115 | 1779 | 1537 | 49.4261 | 40.6348 | 40.6348 | 0 | 0 |
| A16ZSR006 | 59 | 1017 | 1003 | 43 | 40.3051 | 40.3051 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 0 | 1193 | 0 | 0 | 356 | 49 | 282 | 82 | 104 | 2/2 |
| S26 | 0 | 0 | 242 | 0 | 0 | 138 | 25 | 122 | 11 | 47 | 2/2 |
| A16ZSR006 | 0 | 0 | 14 | 0 | 0 | 75 | 2 | 20 | 10 | 25 | 4/4 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 325/158 | 28/28 | 5.7513/5.7513 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 607/42 | 25/25 | 5.7766/5.7766 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 166/165 | 12/12 | 3.3655/3.3655 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 371/363 | 142/142 | 31.3452/31.3452 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 6/3 | 2/2 | 0.6041/0.6041 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.1523/0.1523 | 0 | 0 | 0 | 0 |
| S2026 | x | 3210/2903 | 158/158 | 37.4467/37.4467 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 342/200 | 158/158 | 16.8832/16.8832 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 136/104 | 23/23 | 7.4087/7.4087 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 87/6 | 6/6 | 3.0174/3.0174 | 0 | 0 | 0 | 0 |
| S26 | instagram | 9/9 | 2/2 | 0.487/0.487 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 179/178 | 82/82 | 34.5304/34.5304 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 5/2 | 2/2 | 0.9739/0.9739 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 1233/1170 | 85/85 | 33.7043/33.7043 | 0 | 0 | 0 | 0 |
| S26 | youtube | 130/68 | 49/49 | 6.8957/6.8957 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/18 | 6/6 | 3.0169/3.0169 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 94/94 | 16/16 | 9.8983/9.8983 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 145/145 | 45/45 | 37.8305/37.8305 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 5/3 | 1/1 | 1.1695/1.1695 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 2.4746/2.4746 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 603/603 | 38/38 | 23.8644/23.8644 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 132/132 | 15/15 | 8.5932/8.5932 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 47.34%/47.34% | 0.3442/0.3442 | 10.2%/10.2% | 58.59%/58.59% |
| S26 | x/x | 46.41%/46.41% | 0.396/0.396 | 23.01%/23.01% | 67.74%/67.74% |
| A16ZSR006 | linkedin/linkedin | 48.86%/48.86% | 0.3553/0.3553 | 26.79%/26.79% | 58.8%/58.8% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 158 | 8 | 1.5/32.9887 | 0/1702.8364 |
| S2026 | hacker_news | 42 | 0 | 9.5/335.1244 | 0/60877.8094 |
| S2026 | instagram | 165 | 1 | 24.2/822.9 | 0/154021.9531 |
| S2026 | linkedin | 363 | 0 | 36.6988/328.3996 | 0.4596/8506.7817 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 2903 | 82 | 12.36/135.069 | 0/4421.7057 |
| S2026 | youtube | 200 | 13 | 7.3687/22.7936 | 0.7457/113.0674 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 104 | 6 | 1.8663/23.3665 | 0/602.9414 |
| S26 | hacker_news | 6 | 1 | 303.8874/502.9168 | 142.4863/1069.7495 |
| S26 | instagram | 9 | 0 | 2.2/15.4 | 0/189.2763 |
| S26 | linkedin | 178 | 0 | 50.7748/507.8713 | 0.6803/15678.8423 |
| S26 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 1170 | 30 | 7.8/88.8985 | 0/2934.3305 |
| S26 | youtube | 68 | 10 | 3.262/12.4336 | 0/74.1735 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 18 | 0 | 1.7194/47.2892 | 0/3612.404 |
| A16ZSR006 | hacker_news | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 94 | 2 | 27.8468/197.5997 | 0.5969/3586.5691 |
| A16ZSR006 | linkedin | 145 | 0 | 48.2/455 | 0.7437/12865.6193 |
| A16ZSR006 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 603 | 21 | 5.8498/68.799 | 0/2269.4083 |
| A16ZSR006 | youtube | 132 | 2 | 0.5937/43.4081 | 0/6530.9149 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 7 | 0 |
| S26 | 177 | 0 | 0 | 3 | 0 |
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
| versioned_runtime_parameter_hashes_complete | yes | {"category_hash_mismatch_count":0,"parameter_count":83,"parameter_mismatch_count":0} |
| versioned_source_hashes_complete | yes | {"source_file_count":8,"source_mismatch_count":0} |
| input_envelope_hash_consistent | yes | "02f4d8d1e830695b370664cf8ae1287a10b37ff574108433c8e6e740f8435f8b" |
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
