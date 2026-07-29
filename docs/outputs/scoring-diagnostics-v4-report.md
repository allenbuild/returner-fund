# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-monotonic` (`returner-traction` v4.0.1)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `6832151277f157152c8ead1456e94d5de12601419e83b4077fededda4711f23a`
- Effective versioned scoring-input SHA-256: `48f74ffd609665f3646c074fd5e2b0e96b034bf7efe27fa1222b1e302cb62ae5`
- Canonical config: 83 leaf parameters across scoring, calibration, and confidence; 8 role-labeled runtime source files.
- Audit JSON SHA-256: `45f55c3ff4620e395d1bcdbdf0b109e6b1abd7948a31abb165ef723ff0dbe0e9`
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 371 companies across 3 cohorts were inspected with 7372 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 0 evidence URL groups.
- Alias diagnostics found 573 overlaps across 474 scored rows.
- Production eligibility rejected 1581 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 359 scored rows; metric gaps affect 0.
- Robust fences flagged 165 eligible evidence rows and 7/7 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 13/13 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 4658 | 3441 | 45.7766 | 39.4315 | 39.4315 | 0 | 0 |
| S26 | 115 | 1697 | 1347 | 50.7652 | 40.3304 | 40.3304 | 0 | 0 |
| A16ZSR006 | 59 | 1017 | 1003 | 43.7966 | 41.0169 | 41.0169 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 0 | 1217 | 0 | 0 | 355 | 49 | 282 | 95 | 102 | 2/2 |
| S26 | 0 | 0 | 350 | 0 | 0 | 138 | 102 | 206 | 37 | 38 | 2/2 |
| A16ZSR006 | 0 | 0 | 14 | 0 | 0 | 76 | 2 | 20 | 10 | 25 | 3/3 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 324/157 | 28/28 | 5.736/5.736 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 607/42 | 25/25 | 5.7868/5.7868 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 72/71 | 3/3 | 0.9594/0.9594 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 366/358 | 142/142 | 31.3096/31.3096 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 6/3 | 2/2 | 0.6091/0.6091 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.1523/0.1523 | 0 | 0 | 0 | 0 |
| S2026 | x | 2940/2609 | 156/156 | 37.0914/37.0914 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 342/200 | 158/158 | 16.9086/16.9086 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 136/104 | 23/23 | 7.3652/7.3652 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 87/6 | 6/6 | 3.0261/3.0261 | 0 | 0 | 0 | 0 |
| S26 | instagram | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 259/181 | 82/82 | 34.5826/34.5826 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 5/2 | 2/2 | 0.9739/0.9739 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 1084/990 | 84/84 | 32.1391/32.1391 | 0 | 0 | 0 | 0 |
| S26 | youtube | 126/64 | 46/46 | 6.5391/6.5391 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/18 | 6/6 | 3.0169/3.0169 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 94/94 | 16/16 | 9.9153/9.9153 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 145/145 | 46/46 | 38.5424/38.5424 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 5/3 | 1/1 | 1.1695/1.1695 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 2.4915/2.4915 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 603/603 | 38/38 | 23.9153/23.9153 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 132/132 | 15/15 | 8.6102/8.6102 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 48.26%/48.26% | 0.3577/0.3577 | 10.71%/10.71% | 60.3%/60.3% |
| S26 | x/x | 44.89%/44.89% | 0.3998/0.3998 | 24.78%/24.78% | 69.4%/69.4% |
| A16ZSR006 | linkedin/linkedin | 49.63%/49.63% | 0.3594/0.3594 | 28.07%/28.07% | 59.27%/59.27% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 157 | 8 | 1.5/33.5 | 0/1767.633 |
| S2026 | hacker_news | 42 | 0 | 9.5/335.1244 | 0/60877.8094 |
| S2026 | instagram | 71 | 1 | 50.2055/1146.3588 | 0/121694.2496 |
| S2026 | linkedin | 358 | 0 | 36.4/327.6497 | 0.4358/8560.0246 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 2609 | 80 | 12.16/136.7 | 0/4659.6986 |
| S2026 | youtube | 200 | 13 | 7.3687/22.7936 | 0.7457/113.0674 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 104 | 6 | 1.8663/23.3665 | 0/602.9414 |
| S26 | hacker_news | 6 | 1 | 303.8874/501.2161 | 143.2157/1060.7384 |
| S26 | instagram | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | linkedin | 181 | 0 | 45.7/504.5 | 0.3113/18001.2828 |
| S26 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 990 | 21 | 7.2348/91.7438 | 0/3504.3714 |
| S26 | youtube | 64 | 10 | 3.3748/13.0989 | 0/80.5702 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 18 | 0 | 1.7194/47.2892 | 0/3612.404 |
| A16ZSR006 | hacker_news | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 94 | 2 | 27.8468/197.5997 | 0.5969/3586.5691 |
| A16ZSR006 | linkedin | 145 | 0 | 50.2/455 | 0.9263/12119.1268 |
| A16ZSR006 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 603 | 21 | 5.8498/68.799 | 0/2269.4083 |
| A16ZSR006 | youtube | 132 | 2 | 0.5937/43.4081 | 0/6530.9149 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 7 | 0 |
| S26 | 168 | 0 | 0 | 5 | 0 |
| A16ZSR006 | 189 | 0 | 0 | 1 | 0 |

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
| input_envelope_hash_consistent | yes | "6832151277f157152c8ead1456e94d5de12601419e83b4077fededda4711f23a" |
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
