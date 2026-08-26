# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-absolute-fixed-platform-global-best` (`returner-traction` v4.2.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `7254b438e4ba8f0cd5a8be71b5271e449bad5bff6976a7f872d1e1409a9b3169`
- Effective versioned scoring-input SHA-256: `6b47c5d07d319e1f1a853d59fd1211e1b50bc5971a9e4aad52471480b3086091`
- Canonical config: 70 leaf parameters across scoring, calibration, and confidence; 9 role-labeled runtime source files.
- Audit JSON SHA-256: `cf477da14f4f8c2a9147289749ed29838f1c654d7478ad033117333a223741c8`
- Detail retention: at most 32 examples per repetitive collection; 108788 repeated records omitted across 129 collections with full SHA-256 commitments.
- Release size ceiling: 50331648 bytes.
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 492 companies across 3 cohorts were inspected with 46606 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 810 evidence URL groups.
- Alias diagnostics found 604 overlaps across 503 scored rows.
- Production eligibility rejected 31432 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 5464 scored rows; metric gaps affect 0.
- Robust fences flagged 596 eligible evidence rows and 5/5 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 14/14 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 22065 | 6046 | 38.6599 | 20.4822 | 20.4822 | 0 | 0 |
| S26 | 236 | 15101 | 4634 | 31.4788 | 16.6695 | 16.6695 | 0 | 0 |
| A16ZSR006 | 59 | 9440 | 4494 | 36.2881 | 19.2203 | 19.2203 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 179 | 16019 | 0 | 0 | 359 | 54 | 1832 | 5674 | 159 | 2/2 |
| S26 | 0 | 609 | 10467 | 0 | 0 | 171 | 33 | 1801 | 3712 | 134 | 1/1 |
| A16ZSR006 | 0 | 22 | 4946 | 0 | 0 | 69 | 2 | 3032 | 2579 | 303 | 2/2 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 319/154 | 28/28 | 0.9086/0.9086 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 2369/47 | 28/28 | 0.3604/0.3604 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 325/323 | 12/12 | 0.8579/0.8579 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 717/706 | 164/164 | 6.335/6.335 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 13/3 | 2/2 | 0.0457/0.0457 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.0051/0.0051 | 0 | 0 | 0 | 0 |
| S2026 | x | 14146/4541 | 160/160 | 9.9543/9.9543 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 831/271 | 161/161 | 2.0406/2.0406 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 201/122 | 27/27 | 0.7203/0.7203 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 461/32 | 29/29 | 0.2839/0.2839 | 0 | 0 | 0 | 0 |
| S26 | instagram | 81/77 | 6/6 | 0.2712/0.2712 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 270/266 | 112/112 | 3.5763/3.5763 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 7/1 | 1/1 | 0.0169/0.0169 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 10611/3794 | 193/193 | 10.5551/10.5551 | 0 | 0 | 0 | 0 |
| S26 | youtube | 551/342 | 165/165 | 1.3305/1.3305 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/16 | 5/5 | 0.4237/0.4237 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 2/1 | 1/1 | 0.0339/0.0339 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 3014/3005 | 16/16 | 3.322/3.322 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 235/235 | 48/48 | 7.0847/7.0847 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 8/5 | 2/2 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 3459/956 | 40/40 | 7.1356/7.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 627/268 | 15/15 | 1.0678/1.0678 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 48.67%/48.67% | 0.3459/0.3459 | 7.65%/7.65% | 57.72%/57.72% |
| S26 | x/x | 63.29%/63.29% | 0.4544/0.4544 | 18.06%/18.06% | 75.43%/75.43% |
| A16ZSR006 | x/x | 37.21%/37.21% | 0.3046/0.3046 | 25.86%/25.86% | 60.05%/60.05% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 154 | 10 | 3/41.8745 | 0/1503.5494 |
| S2026 | hacker_news | 47 | 0 | 9.5/315.2214 | 0/52262.0001 |
| S2026 | instagram | 323 | 1 | 11/574.0064 | 0/190724.9966 |
| S2026 | linkedin | 706 | 0 | 21.3/168.6999 | 0.0623/3561.4333 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 4541 | 141 | 15.04/135.34 | 0/3377.7159 |
| S2026 | youtube | 271 | 7 | 4.5624/22.4113 | 0/201.1498 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 122 | 7 | 4.5/49.2323 | 0/1385.4767 |
| S26 | hacker_news | 32 | 0 | 6/337.6304 | 0/113936.7887 |
| S26 | instagram | 77 | 3 | 7.8/85.6 | 0/2672.4417 |
| S26 | linkedin | 266 | 0 | 32.2/397.7718 | 0/16598.8397 |
| S26 | product_hunt | 1 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 3794 | 111 | 16.5049/163.6398 | 0/4747.9289 |
| S26 | youtube | 342 | 13 | 2.375/10.9937 | 0/79.3482 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 16 | 0 | 1.5/52.3708 | 0/5263.4034 |
| A16ZSR006 | hacker_news | 1 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 3005 | 265 | 23.2/327.3 | 0/16403.1661 |
| A16ZSR006 | linkedin | 235 | 0 | 19.0425/301.35 | 0/17714.2965 |
| A16ZSR006 | product_hunt | 5 | 0 | 83.5/834 | 1.7203/25936.6798 |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 956 | 33 | 6.295/64.15 | 0/1737.7956 |
| A16ZSR006 | youtube | 268 | 5 | 1.1187/38.9115 | 0/3262.1305 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 11 | 0 |
| S26 | 233 | 0 | 0 | 14 | 0 |
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
| input_envelope_hash_consistent | yes | "7254b438e4ba8f0cd5a8be71b5271e449bad5bff6976a7f872d1e1409a9b3169" |
| required_cohort_coverage | yes | ["A16ZSR006","S2026","S26"] |
| cohort_evidence_partition_exact | yes | {"cohort_entity_evidence_rows":46606,"cohort_evidence_rows":{"A16ZSR006":9440,"S2026":22065,"S26":15101},"invalid_batch_scope_evidence_rows":0} |
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
