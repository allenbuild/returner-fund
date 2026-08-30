# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-absolute-fixed-platform-global-best` (`returner-traction` v4.2.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `47e82fb6231cecf6bbf3981fbabe0226bb83a268c74f2a64cb5d65fc31ad753b`
- Effective versioned scoring-input SHA-256: `fcab70cfd16c505dc437213095b45e76ad2b2c7178028252032c4237165ac841`
- Canonical config: 70 leaf parameters across scoring, calibration, and confidence; 9 role-labeled runtime source files.
- Audit JSON SHA-256: `21b169f0294a391e8d57a8d87791187c0e529e89beed2abdff64a07d819dc42a`
- Detail retention: at most 32 examples per repetitive collection; 103946 repeated records omitted across 128 collections with full SHA-256 commitments.
- Release size ceiling: 50331648 bytes.
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 491 companies across 3 cohorts were inspected with 47333 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 810 evidence URL groups.
- Alias diagnostics found 595 overlaps across 489 scored rows.
- Production eligibility rejected 31420 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 763 scored rows; metric gaps affect 0.
- Robust fences flagged 610 eligible evidence rows and 6/6 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 14/14 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 22381 | 6352 | 38.7563 | 20.533 | 20.533 | 0 | 0 |
| S26 | 235 | 15448 | 5003 | 31.7957 | 16.834 | 16.834 | 0 | 0 |
| A16ZSR006 | 59 | 9504 | 4558 | 36.322 | 19.2373 | 19.2373 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 179 | 16029 | 0 | 0 | 369 | 55 | 1050 | 5672 | 165 | 2/2 |
| S26 | 0 | 609 | 10445 | 0 | 0 | 153 | 24 | 617 | 3689 | 140 | 2/2 |
| A16ZSR006 | 0 | 22 | 4946 | 0 | 0 | 69 | 2 | 274 | 2579 | 305 | 2/2 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 331/156 | 28/28 | 0.9086/0.9086 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 2369/47 | 28/28 | 0.3604/0.3604 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 329/327 | 12/12 | 0.8579/0.8579 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 717/706 | 164/164 | 6.335/6.335 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 13/3 | 2/2 | 0.0457/0.0457 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.0051/0.0051 | 0 | 0 | 0 | 0 |
| S2026 | x | 14444/4839 | 160/160 | 9.9848/9.9848 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 833/273 | 161/161 | 2.0457/2.0457 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 168/103 | 22/22 | 0.5617/0.5617 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 463/34 | 31/31 | 0.3064/0.3064 | 0 | 0 | 0 | 0 |
| S26 | instagram | 84/80 | 6/6 | 0.2766/0.2766 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 269/265 | 111/111 | 3.5532/3.5532 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 7/1 | 1/1 | 0.017/0.017 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 10987/4170 | 194/194 | 10.8/10.8 | 0 | 0 | 0 | 0 |
| S26 | youtube | 559/350 | 167/167 | 1.3872/1.3872 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/16 | 5/5 | 0.4237/0.4237 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 2/1 | 1/1 | 0.0339/0.0339 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 3023/3014 | 16/16 | 3.322/3.322 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 235/235 | 48/48 | 7.0847/7.0847 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 8/5 | 2/2 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 3501/998 | 40/40 | 7.1695/7.1695 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 640/281 | 15/15 | 1.0678/1.0678 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 48.73%/48.73% | 0.346/0.346 | 7.65%/7.65% | 57.56%/57.56% |
| S26 | x/x | 64.15%/64.15% | 0.4637/0.4637 | 17.26%/17.26% | 75.49%/75.49% |
| A16ZSR006 | x/x | 37.27%/37.27% | 0.3048/0.3048 | 25.86%/25.86% | 60.29%/60.29% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 156 | 10 | 3/42.4915 | 0/1558.2695 |
| S2026 | hacker_news | 47 | 0 | 9.5/315.2214 | 0/52262.0001 |
| S2026 | instagram | 327 | 1 | 11/626.5909 | 0/237365.62 |
| S2026 | linkedin | 706 | 0 | 21.3/168.6999 | 0.0623/3561.4333 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 4839 | 147 | 15.61/136.76 | 0/3289.4363 |
| S2026 | youtube | 273 | 7 | 4.75/22.775 | 0/198.8939 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 103 | 7 | 4.5/42.4971 | 0/966.4029 |
| S26 | hacker_news | 34 | 0 | 6.4539/331.9989 | 0/99432.0288 |
| S26 | instagram | 80 | 3 | 7.8/88.3329 | 0/2888.3787 |
| S26 | linkedin | 265 | 0 | 32.2/395 | 0/16311.8874 |
| S26 | product_hunt | 1 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 4170 | 119 | 17.575/171.1048 | 0/4852.8921 |
| S26 | youtube | 350 | 11 | 2.4562/12.0493 | 0/94.7343 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 16 | 0 | 1.5/51.5762 | 0/5069.6377 |
| A16ZSR006 | hacker_news | 1 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 3014 | 265 | 23.44/328.9046 | 0/16360.3501 |
| A16ZSR006 | linkedin | 235 | 0 | 19.0425/301.35 | 0/17714.2965 |
| A16ZSR006 | product_hunt | 5 | 0 | 83.5/834 | 1.7203/25936.6798 |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 998 | 35 | 6.32/64.3299 | 0/1740.8633 |
| A16ZSR006 | youtube | 281 | 5 | 1.125/39.5 | 0/3368.7614 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 9 | 0 |
| S26 | 235 | 0 | 0 | 14 | 0 |
| A16ZSR006 | 190 | 0 | 0 | 3 | 0 |

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
| input_envelope_hash_consistent | yes | "47e82fb6231cecf6bbf3981fbabe0226bb83a268c74f2a64cb5d65fc31ad753b" |
| required_cohort_coverage | yes | ["A16ZSR006","S2026","S26"] |
| cohort_evidence_partition_exact | yes | {"cohort_entity_evidence_rows":47333,"cohort_evidence_rows":{"A16ZSR006":9504,"S2026":22381,"S26":15448},"invalid_batch_scope_evidence_rows":0} |
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
- The JSON audit includes every config leaf hash, role-labeled effective source hash, all aggregate findings and invariant observations, and deterministic bounded examples for repetitive row-level collections. Each omitted collection retains its full record count and SHA-256 commitment in `metadata.detail_retention.collections`.
- The full machine-readable artifact is `docs/outputs/scoring-diagnostics-v4-audit.json`.

The profiler writes only the two allowlisted files under `docs/outputs/` and performs no network or mutable API calls.
