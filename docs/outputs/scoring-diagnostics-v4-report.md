# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-absolute-fixed-platform-global-best` (`returner-traction` v4.2.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `78a93fc67c9e5e2f7e1555199aa4710bf11ba89e6087114bea014a709133c14d`
- Effective versioned scoring-input SHA-256: `c91d4c4d5d52fff88d1b049bfe2f6359efe3dc8de41ec76f795d55d3b634c4ae`
- Canonical config: 70 leaf parameters across scoring, calibration, and confidence; 9 role-labeled runtime source files.
- Audit JSON SHA-256: `6385da5c33c0ea647a742a091b96d36fa620ee434cfdc29d7d7bde7f883591aa`
- Detail retention: at most 32 examples per repetitive collection; 106606 repeated records omitted across 128 collections with full SHA-256 commitments.
- Release size ceiling: 50331648 bytes.
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 453 companies across 3 cohorts were inspected with 45196 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 810 evidence URL groups.
- Alias diagnostics found 613 overlaps across 507 scored rows.
- Production eligibility rejected 32524 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 520 scored rows; metric gaps affect 0.
- Robust fences flagged 500 eligible evidence rows and 7/7 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 14/14 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 21328 | 5284 | 38.132 | 20.1878 | 20.1878 | 0 | 0 |
| S26 | 197 | 14688 | 3146 | 30.401 | 16.0964 | 16.0964 | 0 | 0 |
| A16ZSR006 | 59 | 9180 | 4242 | 36.0847 | 19.1186 | 19.1186 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 179 | 16044 | 0 | 0 | 349 | 52 | 1029 | 5690 | 130 | 4/4 |
| S26 | 0 | 609 | 11542 | 0 | 0 | 191 | 43 | 470 | 4732 | 79 | 1/1 |
| A16ZSR006 | 0 | 22 | 4938 | 0 | 0 | 69 | 2 | 211 | 2571 | 291 | 2/2 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 301/144 | 27/27 | 0.8883/0.8883 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 2404/47 | 28/28 | 0.3604/0.3604 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 297/295 | 12/12 | 0.8426/0.8426 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 717/706 | 164/164 | 6.335/6.335 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 13/3 | 2/2 | 0.0457/0.0457 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.0051/0.0051 | 0 | 0 | 0 | 0 |
| S2026 | x | 13425/3822 | 160/160 | 9.7513/9.7513 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 826/266 | 160/160 | 2.0051/2.0051 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 216/133 | 32/32 | 1.0254/1.0254 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 498/25 | 25/25 | 0.2944/0.2944 | 0 | 0 | 0 | 0 |
| S26 | instagram | 55/55 | 5/5 | 0.2284/0.2284 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 277/273 | 114/114 | 4.3604/4.3604 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 7/2 | 2/2 | 0.0406/0.0406 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 9229/2401 | 154/154 | 9.335/9.335 | 0 | 0 | 0 | 0 |
| S26 | youtube | 485/257 | 91/91 | 0.868/0.868 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/16 | 5/5 | 0.4237/0.4237 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 1/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 2904/2903 | 16/16 | 3.3051/3.3051 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 235/235 | 48/48 | 7.0847/7.0847 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 8/5 | 2/2 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 3349/846 | 40/40 | 7.0678/7.0678 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 588/229 | 15/15 | 1.0678/1.0678 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 48.37%/48.37% | 0.3455/0.3455 | 8.16%/8.16% | 57.46%/57.46% |
| S26 | x/x | 58.1%/58.1% | 0.4178/0.4178 | 26.6%/26.6% | 69.71%/69.71% |
| A16ZSR006 | x/x | 36.95%/36.95% | 0.305/0.305 | 27.59%/27.59% | 60.05%/60.05% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 144 | 9 | 2.8687/41.6245 | 0/1557.8489 |
| S2026 | hacker_news | 47 | 0 | 9.5/315.2214 | 0/52262.0001 |
| S2026 | instagram | 295 | 1 | 9.9/496.7877 | 0/153627.0956 |
| S2026 | linkedin | 706 | 0 | 21.3/168.6999 | 0.0623/3561.4333 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 3822 | 113 | 13.795/136.86 | 0/3920.2461 |
| S2026 | youtube | 266 | 7 | 4.325/21.9309 | 0/203.9157 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 133 | 10 | 4/42 | 0/1083.4665 |
| S26 | hacker_news | 25 | 0 | 8/350 | 0/85486.7776 |
| S26 | instagram | 55 | 1 | 3.3/30.8074 | 0/638.9062 |
| S26 | linkedin | 273 | 0 | 30.8/395 | 0/17400.9247 |
| S26 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 2401 | 59 | 13.4/142.04 | 0/4477.1642 |
| S26 | youtube | 257 | 9 | 1.925/10.975 | 0/98.1973 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 16 | 0 | 1.5/51.1774 | 0/4974.0274 |
| A16ZSR006 | hacker_news | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 2903 | 257 | 23.1/329.9591 | 0/16841.6469 |
| A16ZSR006 | linkedin | 235 | 0 | 19.0425/301.35 | 0/17714.2965 |
| A16ZSR006 | product_hunt | 5 | 0 | 83.5/834 | 1.7203/25936.6798 |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 846 | 30 | 5.9/57.4678 | 0/1441.1777 |
| A16ZSR006 | youtube | 229 | 4 | 0.975/46.7 | 0/5660.6797 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 8 | 0 |
| S26 | 227 | 0 | 0 | 7 | 0 |
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
| input_envelope_hash_consistent | yes | "78a93fc67c9e5e2f7e1555199aa4710bf11ba89e6087114bea014a709133c14d" |
| required_cohort_coverage | yes | ["A16ZSR006","S2026","S26"] |
| cohort_evidence_partition_exact | yes | {"cohort_entity_evidence_rows":45196,"cohort_evidence_rows":{"A16ZSR006":9180,"S2026":21328,"S26":14688},"invalid_batch_scope_evidence_rows":0} |
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
