# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-canonical` (`returner-traction` v4.0.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `e6f2de29f58c6408ee581de31b1ce96564d86d8dc0d631d962a94dbebc1adffa`
- Effective versioned scoring-input SHA-256: `d37367190cccaf50ce6d5206c2ef0b20c84dccc34daaf199121c17ec2a532e15`
- Canonical config: 83 leaf parameters across scoring, calibration, and confidence; 8 role-labeled runtime source files.
- Audit JSON SHA-256: `25ebeb708c727ac37d4cadce56ac936e6c8367cbfed01dddf504aa2eaab40e50`
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 371 companies across 3 cohorts were inspected with 7264 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 0 evidence URL groups.
- Alias diagnostics found 544 overlaps across 421 scored rows.
- Production eligibility rejected 1563 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 324 scored rows; metric gaps affect 0.
- Robust fences flagged 164 eligible evidence rows and 7/7 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 13/13 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 4585 | 3387 | 47.7868 | 41.9239 | 41.9239 | 0 | 0 |
| S26 | 115 | 1662 | 1311 | 51.487 | 43.1217 | 43.1217 | 0 | 0 |
| A16ZSR006 | 59 | 1017 | 1003 | 44.6949 | 43.322 | 43.322 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 0 | 1198 | 0 | 0 | 325 | 48 | 275 | 57 | 103 | 1/1 |
| S26 | 0 | 0 | 351 | 0 | 0 | 131 | 101 | 176 | 40 | 36 | 3/3 |
| A16ZSR006 | 0 | 0 | 14 | 0 | 0 | 76 | 2 | 20 | 10 | 25 | 3/3 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 256/109 | 28/28 | 6/6 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 607/42 | 25/25 | 5.8426/5.8426 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 72/71 | 3/3 | 0.9695/0.9695 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 366/358 | 142/142 | 32.0203/32.0203 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 6/3 | 2/2 | 0.5838/0.5838 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.1523/0.1523 | 0 | 0 | 0 | 0 |
| S2026 | x | 2937/2606 | 156/156 | 39.7868/39.7868 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 340/197 | 158/158 | 19.2843/19.2843 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 130/97 | 21/21 | 7.7043/7.7043 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 86/5 | 5/5 | 2.4/2.4 | 0 | 0 | 0 | 0 |
| S26 | instagram | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 259/181 | 82/82 | 35.0957/35.0957 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 5/2 | 2/2 | 0.9304/0.9304 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 1059/965 | 83/83 | 34.6957/34.6957 | 0 | 0 | 0 | 0 |
| S26 | youtube | 123/61 | 45/45 | 7.713/7.713 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/18 | 6/6 | 3.4407/3.4407 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 94/94 | 16/16 | 10.4068/10.4068 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 145/145 | 46/46 | 39.3559/39.3559 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 5/3 | 1/1 | 1.1525/1.1525 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 2.6102/2.6102 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 603/603 | 38/38 | 26.4237/26.4237 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 132/132 | 15/15 | 9.6271/9.6271 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 48.75%/48.75% | 0.3569/0.3569 | 10.71%/10.71% | 61.42%/61.42% |
| S26 | x/x | 45.81%/45.81% | 0.4003/0.4003 | 27.43%/27.43% | 68.96%/68.96% |
| A16ZSR006 | linkedin/linkedin | 48.03%/48.03% | 0.352/0.352 | 28.07%/28.07% | 59.23%/59.23% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 109 | 8 | 1.5/30 | 0/1352.6121 |
| S2026 | hacker_news | 42 | 0 | 9.5/335.1244 | 0/60877.8094 |
| S2026 | instagram | 71 | 1 | 50.2055/1146.3588 | 0/121694.2496 |
| S2026 | linkedin | 358 | 0 | 36.4/327.6497 | 0.4358/8560.0246 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 2606 | 80 | 12.16/136.6249 | 0/4653.3497 |
| S2026 | youtube | 197 | 14 | 7.375/22.75 | 0.7537/112.418 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 97 | 6 | 1.5/23 | 0/712.8683 |
| S26 | hacker_news | 5 | 1 | 330.5/539 | 158.4477/1121.6881 |
| S26 | instagram | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | linkedin | 181 | 0 | 45.7/504.5 | 0.3113/18001.2828 |
| S26 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 965 | 21 | 6.94/89.2 | 0/3452.7078 |
| S26 | youtube | 61 | 8 | 3.25/12.25 | 0/71.9384 |
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
| S2026 | 244 | 0 | 0 | 10 | 0 |
| S26 | 167 | 0 | 0 | 4 | 0 |
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
| input_envelope_hash_consistent | yes | "e6f2de29f58c6408ee581de31b1ce96564d86d8dc0d631d962a94dbebc1adffa" |
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
