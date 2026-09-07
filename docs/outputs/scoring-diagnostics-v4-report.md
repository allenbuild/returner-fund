# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-bounded-primary-signal-calibrated` (`returner-traction` v4.3.1)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `7124d2e438d2e70d4a1fa6e49b9694b70fe097e9c728afc1b9b350bda11bcd25`
- Effective versioned scoring-input SHA-256: `4c8276c3c4efc5f1037fd9d2b499bc04728d934abe59e32ab62d809e618f5a7c`
- Canonical config: 69 leaf parameters across scoring, calibration, and confidence; 9 role-labeled runtime source files.
- Audit JSON SHA-256: `74b0442a3c96753a0ed243352e930a9c9960166af1b18188e5ac82bca52476c4`
- Detail retention: at most 32 examples per repetitive collection; 103604 repeated records omitted across 128 collections with full SHA-256 commitments.
- Release size ceiling: 50331648 bytes.
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 490 companies across 3 cohorts were inspected with 47381 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 810 evidence URL groups.
- Alias diagnostics found 555 overlaps across 452 scored rows.
- Production eligibility rejected 31377 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 728 scored rows; metric gaps affect 0.
- Robust fences flagged 607 eligible evidence rows and 29/29 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 14/14 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 22447 | 6419 | 61.5127 | 60.2437 | 60.2437 | 0 | 0 |
| S26 | 234 | 15395 | 4992 | 58.0128 | 56.8504 | 56.8504 | 0 | 0 |
| A16ZSR006 | 59 | 9539 | 4593 | 60.9831 | 59.7627 | 59.7627 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 179 | 16028 | 0 | 0 | 370 | 55 | 1052 | 5670 | 164 | 3/3 |
| S26 | 0 | 609 | 10403 | 0 | 0 | 111 | 18 | 612 | 3640 | 137 | 23/23 |
| A16ZSR006 | 0 | 22 | 4946 | 0 | 0 | 69 | 2 | 235 | 2579 | 306 | 3/3 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 333/159 | 28/28 | 5.2893/5.2893 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 2369/47 | 28/28 | 7.5787/7.5787 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 329/327 | 12/12 | 3.934/3.934 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 717/706 | 164/164 | 41.3249/41.3249 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 13/3 | 2/2 | 0.665/0.665 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.198/0.198 | 0 | 0 | 0 | 0 |
| S2026 | x | 14504/4899 | 160/160 | 45.3096/45.3096 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 837/277 | 161/161 | 20.7259/20.7259 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 119/60 | 16/16 | 2.5812/2.5812 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 466/37 | 33/33 | 6.9915/6.9915 | 0 | 0 | 0 | 0 |
| S26 | instagram | 84/80 | 6/6 | 1.265/1.265 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 266/261 | 110/110 | 23.5256/23.5256 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 7/1 | 1/1 | 0.2521/0.2521 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 11006/4195 | 193/193 | 49.5214/49.5214 | 0 | 0 | 0 | 0 |
| S26 | youtube | 582/358 | 167/167 | 14.4487/14.4487 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/16 | 5/5 | 2.3898/2.3898 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 2/1 | 1/1 | 0.5932/0.5932 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 3028/3019 | 16/16 | 14.8475/14.8475 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 235/235 | 48/48 | 45.678/45.678 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 8/5 | 2/2 | 1.7627/1.7627 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 3.1017/3.1017 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 3507/1004 | 40/40 | 32.4068/32.4068 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 664/305 | 15/15 | 10.2203/10.2203 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 52.22%/52.22% | 0.3925/0.3925 | 7.65%/7.65% | 99.21%/99.21% |
| S26 | x/x | 70.23%/70.23% | 0.5347/0.5347 | 16.89%/16.89% | 99.67%/99.67% |
| A16ZSR006 | linkedin/linkedin | 54.39%/54.39% | 0.3861/0.3861 | 25.86%/25.86% | 99.32%/99.32% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 159 | 10 | 3/42.7436 | 0/1580.9604 |
| S2026 | hacker_news | 47 | 0 | 9.5/315.2214 | 0/52262.0001 |
| S2026 | instagram | 327 | 1 | 11/662.9945 | 0/273298.8248 |
| S2026 | linkedin | 706 | 0 | 21.3/168.6999 | 0.0623/3561.4333 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 4899 | 146 | 15.91/138.59 | 0/3309.7044 |
| S2026 | youtube | 277 | 7 | 4.75/22.15 | 0/186.0147 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 60 | 3 | 5.5/56.6246 | 0/1520.0716 |
| S26 | hacker_news | 37 | 0 | 8/332.5 | 0/75226.3618 |
| S26 | instagram | 80 | 3 | 7.8/88.3329 | 0/2888.3787 |
| S26 | linkedin | 261 | 0 | 32.2/395 | 0/16311.8874 |
| S26 | product_hunt | 1 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 4195 | 119 | 18.12/174.61 | 0/4887.1134 |
| S26 | youtube | 358 | 12 | 2.6124/12.25 | 0/92.0764 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 16 | 0 | 1.5/51.5762 | 0/5069.6377 |
| A16ZSR006 | hacker_news | 1 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 3019 | 266 | 23.659/330.0389 | 0/16281.9843 |
| A16ZSR006 | linkedin | 235 | 0 | 19.0425/301.35 | 0/17714.2965 |
| A16ZSR006 | product_hunt | 5 | 0 | 83.5/834 | 1.7203/25936.6798 |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 1004 | 35 | 6.355/65.17 | 0/1784.5797 |
| A16ZSR006 | youtube | 305 | 5 | 1.15/38.75 | 0/3158.9859 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 7 | 0 |
| S26 | 238 | 0 | 0 | 9 | 0 |
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
| input_envelope_hash_consistent | yes | "7124d2e438d2e70d4a1fa6e49b9694b70fe097e9c728afc1b9b350bda11bcd25" |
| required_cohort_coverage | yes | ["A16ZSR006","S2026","S26"] |
| cohort_evidence_partition_exact | yes | {"cohort_entity_evidence_rows":47381,"cohort_evidence_rows":{"A16ZSR006":9539,"S2026":22447,"S26":15395},"invalid_batch_scope_evidence_rows":0} |
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
