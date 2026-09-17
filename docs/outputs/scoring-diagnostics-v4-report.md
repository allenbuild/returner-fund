# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-bounded-primary-signal-calibrated` (`returner-traction` v4.3.1)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `8fe6cc47c1aeee1c85f46bcf476ee4ca6631d70b99c5e3b43e399b2b5aad1432`
- Effective versioned scoring-input SHA-256: `4c8276c3c4efc5f1037fd9d2b499bc04728d934abe59e32ab62d809e618f5a7c`
- Canonical config: 69 leaf parameters across scoring, calibration, and confidence; 9 role-labeled runtime source files.
- Audit JSON SHA-256: `1da3f99222dfb17326e8b23be42bb41d4d113c6a8faa2c799b77ea49a37ce576`
- Detail retention: at most 32 examples per repetitive collection; 103088 repeated records omitted across 128 collections with full SHA-256 commitments.
- Release size ceiling: 50331648 bytes.
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 488 companies across 3 cohorts were inspected with 47350 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 810 evidence URL groups.
- Alias diagnostics found 563 overlaps across 456 scored rows.
- Production eligibility rejected 31326 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 378 scored rows; metric gaps affect 0.
- Robust fences flagged 614 eligible evidence rows and 26/26 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 14/14 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 22468 | 6430 | 61.5178 | 60.2487 | 60.2487 | 0 | 0 |
| S26 | 232 | 15335 | 4993 | 58.6078 | 57.4267 | 57.4267 | 0 | 0 |
| A16ZSR006 | 59 | 9547 | 4601 | 60.9831 | 59.7627 | 59.7627 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 179 | 16038 | 0 | 0 | 377 | 57 | 800 | 5676 | 164 | 3/3 |
| S26 | 0 | 609 | 10342 | 0 | 0 | 112 | 17 | 545 | 3630 | 143 | 20/20 |
| A16ZSR006 | 0 | 22 | 4946 | 0 | 0 | 69 | 2 | 207 | 2579 | 307 | 3/3 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 344/162 | 30/30 | 5.5939/5.5939 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 2369/47 | 28/28 | 7.5787/7.5787 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 329/327 | 12/12 | 3.934/3.934 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 720/709 | 165/165 | 41.6091/41.6091 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 13/3 | 2/2 | 0.665/0.665 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.198/0.198 | 0 | 0 | 0 | 0 |
| S2026 | x | 14504/4899 | 160/160 | 45.3096/45.3096 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 844/282 | 161/161 | 20.7208/20.7208 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 115/61 | 16/16 | 2.6207/2.6207 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 467/38 | 34/34 | 7.2414/7.2414 | 0 | 0 | 0 | 0 |
| S26 | instagram | 84/80 | 6/6 | 1.2759/1.2759 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 273/268 | 114/114 | 24.3534/24.3534 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 7/1 | 1/1 | 0.2543/0.2543 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 10923/4163 | 192/192 | 49.6767/49.6767 | 0 | 0 | 0 | 0 |
| S26 | youtube | 607/382 | 168/168 | 15.3276/15.3276 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/16 | 5/5 | 2.3898/2.3898 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 2/1 | 1/1 | 0.5932/0.5932 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 3028/3019 | 16/16 | 14.8475/14.8475 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 235/235 | 48/48 | 45.678/45.678 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 8/5 | 2/2 | 1.7627/1.7627 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 3.1017/3.1017 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 3507/1004 | 40/40 | 32.4068/32.4068 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 672/313 | 15/15 | 10.2542/10.2542 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 52.22%/52.22% | 0.3925/0.3925 | 7.65%/7.65% | 99.21%/99.21% |
| S26 | x/x | 69.22%/69.22% | 0.5223/0.5223 | 15.63%/15.63% | 99.63%/99.63% |
| A16ZSR006 | linkedin/linkedin | 54.39%/54.39% | 0.3861/0.3861 | 25.86%/25.86% | 99.32%/99.32% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 162 | 10 | 3/44.5992 | 0/1754.1009 |
| S2026 | hacker_news | 47 | 0 | 9.5/315.2214 | 0/52262.0001 |
| S2026 | instagram | 327 | 1 | 11/662.9945 | 0/273298.8248 |
| S2026 | linkedin | 709 | 0 | 21.3/169.4 | 0.0557/3598.2887 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 4899 | 146 | 15.91/138.59 | 0/3309.7044 |
| S2026 | youtube | 282 | 7 | 4.7125/22.6172 | 0/197.5344 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 61 | 3 | 6/69 | 0/2212.5944 |
| S26 | hacker_news | 38 | 0 | 9.4726/331.9989 | 0/59706.3234 |
| S26 | instagram | 80 | 3 | 7.8/88.3329 | 0/2888.3787 |
| S26 | linkedin | 268 | 0 | 32.2/384.0217 | 0/15204.6794 |
| S26 | product_hunt | 1 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 4163 | 117 | 17.96/174.57 | 0/4946.3001 |
| S26 | youtube | 382 | 20 | 2.6124/13.5303 | 0/116.2165 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 16 | 0 | 1.5/51.5762 | 0/5069.6377 |
| A16ZSR006 | hacker_news | 1 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 3019 | 266 | 23.659/330.0389 | 0/16281.9843 |
| A16ZSR006 | linkedin | 235 | 0 | 19.0425/301.35 | 0/17714.2965 |
| A16ZSR006 | product_hunt | 5 | 0 | 83.5/834 | 1.7203/25936.6798 |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 1004 | 35 | 6.355/65.17 | 0/1784.5797 |
| A16ZSR006 | youtube | 313 | 6 | 1.175/38.75 | 0/3104.6602 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 7 | 0 |
| S26 | 239 | 0 | 0 | 9 | 0 |
| A16ZSR006 | 190 | 0 | 0 | 2 | 0 |

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
| versioned_runtime_parameter_hashes_complete | yes | {"category_hash_mismatch_count":0,"parameter_count":69,"parameter_mismatch_count":0} |
| versioned_source_hashes_complete | yes | {"source_file_count":9,"source_mismatch_count":0} |
| input_envelope_hash_consistent | yes | "8fe6cc47c1aeee1c85f46bcf476ee4ca6631d70b99c5e3b43e399b2b5aad1432" |
| required_cohort_coverage | yes | ["A16ZSR006","S2026","S26"] |
| cohort_evidence_partition_exact | yes | {"cohort_entity_evidence_rows":47350,"cohort_evidence_rows":{"A16ZSR006":9547,"S2026":22468,"S26":15335},"invalid_batch_scope_evidence_rows":0} |
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
