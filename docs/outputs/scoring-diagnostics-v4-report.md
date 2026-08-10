# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-absolute-fixed-platform-global-best` (`returner-traction` v4.2.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `8ed450a64a9a10be6158324ff912e024ef016b5253379e6a7824c4347bd65c3a`
- Effective versioned scoring-input SHA-256: `c91d4c4d5d52fff88d1b049bfe2f6359efe3dc8de41ec76f795d55d3b634c4ae`
- Canonical config: 70 leaf parameters across scoring, calibration, and confidence; 9 role-labeled runtime source files.
- Audit JSON SHA-256: `ec3b398d2091011b32ff51f6b552fb7f461ab83db8d4ded9615930f3a4de84c3`
- Detail retention: at most 32 examples per repetitive collection; 106372 repeated records omitted across 128 collections with full SHA-256 commitments.
- Release size ceiling: 50331648 bytes.
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 450 companies across 3 cohorts were inspected with 44880 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 800 evidence URL groups.
- Alias diagnostics found 611 overlaps across 505 scored rows.
- Production eligibility rejected 32500 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 509 scored rows; metric gaps affect 0.
- Robust fences flagged 493 eligible evidence rows and 7/7 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 14/14 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 21220 | 5184 | 38.0305 | 20.132 | 20.132 | 0 | 0 |
| S26 | 194 | 14497 | 2970 | 29.8402 | 15.799 | 15.799 | 0 | 0 |
| A16ZSR006 | 59 | 9163 | 4226 | 36.0847 | 19.1186 | 19.1186 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 174 | 16036 | 0 | 0 | 348 | 52 | 1026 | 5683 | 127 | 4/4 |
| S26 | 0 | 604 | 11527 | 0 | 0 | 190 | 41 | 460 | 4721 | 75 | 1/1 |
| A16ZSR006 | 0 | 22 | 4937 | 0 | 0 | 69 | 2 | 211 | 2570 | 291 | 2/2 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 300/143 | 27/27 | 0.8883/0.8883 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 2403/46 | 27/27 | 0.3553/0.3553 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 297/295 | 12/12 | 0.8426/0.8426 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 717/706 | 164/164 | 6.335/6.335 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 13/3 | 2/2 | 0.0457/0.0457 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.0051/0.0051 | 0 | 0 | 0 | 0 |
| S2026 | x | 13328/3726 | 160/160 | 9.731/9.731 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 824/264 | 160/160 | 1.9797/1.9797 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 212/132 | 32/32 | 1.0258/1.0258 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 496/23 | 23/23 | 0.2784/0.2784 | 0 | 0 | 0 | 0 |
| S26 | instagram | 55/55 | 5/5 | 0.232/0.232 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 277/273 | 114/114 | 4.4278/4.4278 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 7/2 | 2/2 | 0.0412/0.0412 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 9063/2236 | 149/149 | 9.0206/9.0206 | 0 | 0 | 0 | 0 |
| S26 | youtube | 475/249 | 88/88 | 0.8247/0.8247 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/16 | 5/5 | 0.4237/0.4237 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 1/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 2904/2903 | 16/16 | 3.3051/3.3051 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 235/235 | 48/48 | 7.0847/7.0847 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 8/5 | 2/2 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 3339/836 | 40/40 | 7.0678/7.0678 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 582/223 | 15/15 | 1.0678/1.0678 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 48.38%/48.38% | 0.3459/0.3459 | 8.16%/8.16% | 57.46%/57.46% |
| S26 | x/x | 57.21%/57.21% | 0.4126/0.4126 | 25.14%/25.14% | 68.31%/68.31% |
| A16ZSR006 | x/x | 36.95%/36.95% | 0.305/0.305 | 27.59%/27.59% | 60.05%/60.05% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 143 | 9 | 3/41.7493 | 0/1492.5912 |
| S2026 | hacker_news | 46 | 0 | 9.5/317.3535 | 0/53147.405 |
| S2026 | instagram | 295 | 1 | 9.9/496.7877 | 0/153627.0956 |
| S2026 | linkedin | 706 | 0 | 21.3/168.6999 | 0.0623/3561.4333 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 3726 | 111 | 13.72/136.73 | 0/3940.9367 |
| S2026 | youtube | 264 | 6 | 4.325/21.7562 | 0/200.0339 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 132 | 10 | 4/40.87 | 0/1013.6189 |
| S26 | hacker_news | 23 | 0 | 11.1861/357.1766 | 0/57074.3104 |
| S26 | instagram | 55 | 1 | 3.3/30.8074 | 0/638.9062 |
| S26 | linkedin | 273 | 0 | 30.8/395 | 0/17400.9247 |
| S26 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 2236 | 57 | 12.775/135.7949 | 0/4279.9237 |
| S26 | youtube | 249 | 7 | 1.975/10.525 | 0/86.8763 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 16 | 0 | 1.5/51.1774 | 0/4974.0274 |
| A16ZSR006 | hacker_news | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 2903 | 257 | 23.1/329.9591 | 0/16841.6469 |
| A16ZSR006 | linkedin | 235 | 0 | 19.0425/301.35 | 0/17714.2965 |
| A16ZSR006 | product_hunt | 5 | 0 | 83.5/834 | 1.7203/25936.6798 |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 836 | 30 | 5.75/53.9221 | 0/1273.7208 |
| A16ZSR006 | youtube | 223 | 4 | 1.0372/47.3875 | 0/5600.3922 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 8 | 0 |
| S26 | 225 | 0 | 0 | 9 | 0 |
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
| versioned_runtime_parameter_hashes_complete | yes | {"category_hash_mismatch_count":0,"parameter_count":70,"parameter_mismatch_count":0} |
| versioned_source_hashes_complete | yes | {"source_file_count":9,"source_mismatch_count":0} |
| input_envelope_hash_consistent | yes | "8ed450a64a9a10be6158324ff912e024ef016b5253379e6a7824c4347bd65c3a" |
| required_cohort_coverage | yes | ["A16ZSR006","S2026","S26"] |
| cohort_evidence_partition_exact | yes | {"cohort_entity_evidence_rows":44880,"cohort_evidence_rows":{"A16ZSR006":9163,"S2026":21220,"S26":14497},"invalid_batch_scope_evidence_rows":0} |
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
