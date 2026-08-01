# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-absolute-fixed-platform-global-best` (`returner-traction` v4.2.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `867be692de1b085a042056438bea448e9365760c24fd2738aac3545d94a98a4c`
- Effective versioned scoring-input SHA-256: `9ceaf2898085923eb76d431130c5c4ba5aa181061e4ee1505c3c2614b2b3c4dd`
- Canonical config: 70 leaf parameters across scoring, calibration, and confidence; 9 role-labeled runtime source files.
- Audit JSON SHA-256: `9569720a54e2595dee6e0dace605fbb885091fd2bb456d58ee38bb039c7ad151`
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 423 companies across 3 cohorts were inspected with 7932 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 0 evidence URL groups.
- Alias diagnostics found 591 overlaps across 482 scored rows.
- Production eligibility rejected 1511 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 437 scored rows; metric gaps affect 0.
- Robust fences flagged 168 eligible evidence rows and 4/4 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 13/13 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 5032 | 3826 | 35.5381 | 18.5279 | 18.5279 | 0 | 0 |
| S26 | 167 | 1883 | 1594 | 21.8922 | 11.4132 | 11.4132 | 0 | 0 |
| A16ZSR006 | 59 | 1017 | 1001 | 32.0678 | 16.661 | 16.661 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 0 | 1206 | 0 | 0 | 361 | 54 | 333 | 97 | 103 | 3/3 |
| S26 | 0 | 0 | 289 | 0 | 0 | 151 | 33 | 176 | 45 | 40 | 1/1 |
| A16ZSR006 | 0 | 0 | 16 | 0 | 0 | 75 | 2 | 24 | 12 | 25 | 0/0 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 325/145 | 27/27 | 0.8883/0.8883 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 607/42 | 25/25 | 0.3401/0.3401 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 166/165 | 12/12 | 0.7817/0.7817 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 371/363 | 142/142 | 5.4365/5.4365 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 6/3 | 2/2 | 0.0457/0.0457 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.0051/0.0051 | 0 | 0 | 0 | 0 |
| S2026 | x | 3214/2907 | 158/158 | 9.2386/9.2386 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 342/200 | 158/158 | 1.9036/1.9036 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 163/95 | 26/26 | 0.994/0.994 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 90/9 | 9/9 | 0.1377/0.1377 | 0 | 0 | 0 | 0 |
| S26 | instagram | 9/9 | 2/2 | 0.0719/0.0719 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 179/178 | 83/83 | 3.994/3.994 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 5/2 | 2/2 | 0.0479/0.0479 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 1281/1207 | 87/87 | 5.4611/5.4611 | 0 | 0 | 0 | 0 |
| S26 | youtube | 156/94 | 73/73 | 0.7545/0.7545 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/16 | 5/5 | 0.4237/0.4237 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 94/94 | 16/16 | 2.4746/2.4746 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 145/145 | 45/45 | 6.5254/6.5254 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 5/3 | 1/1 | 0.0847/0.0847 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 603/603 | 38/38 | 6.1356/6.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 132/132 | 15/15 | 0.9661/0.9661 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 49.8%/49.8% | 0.3475/0.3475 | 10.2%/10.2% | 59.16%/59.16% |
| S26 | x/x | 47.93%/47.93% | 0.3621/0.3621 | 33.82%/33.82% | 71.38%/71.38% |
| A16ZSR006 | linkedin/linkedin | 38.87%/38.87% | 0.3127/0.3127 | 26.79%/26.79% | 59.28%/59.28% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 145 | 7 | 2/40.5 | 0/2134.199 |
| S2026 | hacker_news | 42 | 0 | 9.5/335.1244 | 0/60877.8094 |
| S2026 | instagram | 165 | 1 | 24.2/822.9 | 0/154021.9531 |
| S2026 | linkedin | 363 | 0 | 36.6988/328.3996 | 0.4596/8506.7817 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 2907 | 82 | 12.37/135.7199 | 0/4469.7746 |
| S2026 | youtube | 200 | 13 | 7.3687/22.7936 | 0.7457/113.0674 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 95 | 6 | 4/49.2444 | 0/1599.5314 |
| S26 | hacker_news | 9 | 0 | 60.5/408.5 | 2.5794/7034.9394 |
| S26 | instagram | 9 | 0 | 2.2/15.4 | 0/189.2763 |
| S26 | linkedin | 178 | 0 | 54.9748/507.8713 | 1.0421/13947.593 |
| S26 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 1207 | 25 | 8.27/104.7999 | 0/4078.3757 |
| S26 | youtube | 94 | 9 | 3.1241/12.8999 | 0/85.0077 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 16 | 0 | 1.5/51.974 | 0/5166.0967 |
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
| S2026 | 244 | 0 | 0 | 9 | 0 |
| S26 | 180 | 0 | 0 | 7 | 0 |
| A16ZSR006 | 187 | 0 | 0 | 2 | 0 |

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
| input_envelope_hash_consistent | yes | "867be692de1b085a042056438bea448e9365760c24fd2738aac3545d94a98a4c" |
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
