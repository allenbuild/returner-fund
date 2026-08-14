# Scoring Diagnostics v4 Audit

- Frozen clock: `2026-07-17T12:00:00.000Z`
- Production model: `returner-traction-v4-absolute-fixed-platform-global-best` (`returner-traction` v4.2.0)
- Git SHA: excluded from deterministic artifacts; the runtime command logs the executing revision.
- Input envelope SHA-256: `259f3cadeb24ae2066148d95652679b2b9184cbc382bdcd1474cfe445e9bde6a`
- Effective versioned scoring-input SHA-256: `7561a1e74f72a281ee65dbdef560be20fa90eee2913eb3d594c03c0a90a5aa64`
- Canonical config: 70 leaf parameters across scoring, calibration, and confidence; 9 role-labeled runtime source files.
- Audit JSON SHA-256: `a01b5b1e6024f0e88ce0fc4ada4e9d1f7ef4bbdd9120e4bc439e168c9247eed3`
- Detail retention: at most 32 examples per repetitive collection; 107423 repeated records omitted across 129 collections with full SHA-256 commitments.
- Release size ceiling: 50331648 bytes.
- Command: `npm run scoring:audit:v4`
- Direct command: `node --experimental-strip-types --loader ./scripts/lib/scoring-diagnostics-ts-loader.mjs ./scripts/run-scoring-diagnostics-v4.mjs`
- Safety: local snapshots only; `fetch` disabled; no API calls, benchmark writes, source edits, or user-data mutation.
- Compatibility shims: none.

## Executive summary

- 474 companies across 3 cohorts were inspected with 45956 cohort-scoped evidence rows.
- Global canonical duplicates: 1 company-ID groups, 1 founder-ID groups, 5 social-account URL groups, 0 physical-post groups, and 810 evidence URL groups.
- Alias diagnostics found 614 overlaps across 507 scored rows.
- Production eligibility rejected 32549 rows, including 0 rows whose incoming contribution flag was positive.
- URL diagnostics found 0 scored profile/search/non-native rows. Publication-date metadata gaps affect 521 scored rows; metric gaps affect 0.
- Robust fences flagged 528 eligible evidence rows and 5/5 company scores before/after.
- Monotonicity produced 0 failing company tests. Cleanup changed ranks in 0/3 cohorts and scores in 0/27 batch/platform slices; maximum overall/platform rank shifts were 0/0.
- Invariants: 14/14 passed. Any violation exits nonzero before artifact writes.

The after view is a diagnostic simulation only. It does not update the production model, graph, benchmarks, snapshots, or stored scores.

## Cohort before/after

| Cohort | Companies | Evidence before | Evidence after | Published mean | Diagnostic before mean | Diagnostic after mean | Rank changes | Max shift |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 197 | 21532 | 5485 | 38.3096 | 20.2893 | 20.2893 | 0 | 0 |
| S26 | 218 | 15144 | 3580 | 30.4266 | 16.1147 | 16.1147 | 0 | 0 |
| A16ZSR006 | 59 | 9280 | 4342 | 36.1186 | 19.1356 | 19.1356 | 0 | 0 |

## Diagnostic counts

| Cohort | Post duplicate groups | URL duplicate groups | Eligibility rejects | Enabled rejects | Physical rows removed | Alias rows | URL findings | Publication gaps | Metric gaps | Evidence outliers | Company outliers B/A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 0 | 179 | 16047 | 0 | 0 | 350 | 52 | 1030 | 5691 | 135 | 2/2 |
| S26 | 0 | 609 | 11564 | 0 | 0 | 191 | 44 | 471 | 4735 | 91 | 1/1 |
| A16ZSR006 | 0 | 22 | 4938 | 0 | 0 | 69 | 2 | 211 | 2571 | 302 | 2/2 |

## Batch/platform score and rank shifts

| Cohort | Platform | Evidence B/A | Nonzero companies B/A | Mean score B/A | Score changes | Rank changes | Max score delta | Max rank shift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S2026 | github | 304/145 | 27/27 | 0.8934/0.8934 | 0 | 0 | 0 | 0 |
| S2026 | hacker_news | 2404/47 | 28/28 | 0.3604/0.3604 | 0 | 0 | 0 | 0 |
| S2026 | instagram | 317/315 | 12/12 | 0.8528/0.8528 | 0 | 0 | 0 | 0 |
| S2026 | linkedin | 717/706 | 164/164 | 6.335/6.335 | 0 | 0 | 0 | 0 |
| S2026 | product_hunt | 13/3 | 2/2 | 0.0457/0.0457 | 0 | 0 | 0 | 0 |
| S2026 | reddit | 1/1 | 1/1 | 0.0051/0.0051 | 0 | 0 | 0 | 0 |
| S2026 | x | 13602/3998 | 160/160 | 9.797/9.797 | 0 | 0 | 0 | 0 |
| S2026 | youtube | 830/270 | 161/161 | 2.0254/2.0254 | 0 | 0 | 0 | 0 |
| S26 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | github | 220/134 | 32/32 | 0.9266/0.9266 | 0 | 0 | 0 | 0 |
| S26 | hacker_news | 500/27 | 27/27 | 0.2844/0.2844 | 0 | 0 | 0 | 0 |
| S26 | instagram | 60/60 | 6/6 | 0.2615/0.2615 | 0 | 0 | 0 | 0 |
| S26 | linkedin | 280/276 | 115/115 | 3.9633/3.9633 | 0 | 0 | 0 | 0 |
| S26 | product_hunt | 7/2 | 2/2 | 0.0367/0.0367 | 0 | 0 | 0 | 0 |
| S26 | reddit | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| S26 | x | 9615/2783 | 174/174 | 9.6193/9.6193 | 0 | 0 | 0 | 0 |
| S26 | youtube | 541/298 | 127/127 | 1.0917/1.0917 | 0 | 0 | 0 | 0 |
| A16ZSR006 | bilibili | 0/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | github | 28/16 | 5/5 | 0.4237/0.4237 | 0 | 0 | 0 | 0 |
| A16ZSR006 | hacker_news | 1/0 | 0/0 | 0/0 | 0 | 0 | 0 | 0 |
| A16ZSR006 | instagram | 2961/2960 | 16/16 | 3.322/3.322 | 0 | 0 | 0 | 0 |
| A16ZSR006 | linkedin | 235/235 | 48/48 | 7.0847/7.0847 | 0 | 0 | 0 | 0 |
| A16ZSR006 | product_hunt | 8/5 | 2/2 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | reddit | 10/8 | 6/6 | 0.1356/0.1356 | 0 | 0 | 0 | 0 |
| A16ZSR006 | x | 3379/876 | 40/40 | 7.0678/7.0678 | 0 | 0 | 0 | 0 |
| A16ZSR006 | youtube | 601/242 | 15/15 | 1.0678/1.0678 | 0 | 0 | 0 | 0 |

## Platform concentration

| Cohort | Leading platform B/A | Leading share B/A | HHI B/A | Single-platform companies B/A | Median dominant share B/A |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | x/x | 48.38%/48.38% | 0.3449/0.3449 | 7.65%/7.65% | 57.65%/57.65% |
| S26 | x/x | 59.78%/59.78% | 0.4253/0.4253 | 23.08%/23.08% | 71.42%/71.42% |
| A16ZSR006 | x/x | 37%/37% | 0.305/0.305 | 27.59%/27.59% | 60.05%/60.05% |

## Evidence outliers by platform

| Cohort | Platform | Eligible sample | Outliers | Raw engagement Q1/Q3 | Lower/upper fence |
| --- | --- | ---: | ---: | ---: | ---: |
| S2026 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S2026 | github | 145 | 9 | 3/41.5 | 0/1470.9137 |
| S2026 | hacker_news | 47 | 0 | 9.5/315.2214 | 0/52262.0001 |
| S2026 | instagram | 315 | 1 | 10.4368/377.5608 | 0/72090.388 |
| S2026 | linkedin | 706 | 0 | 21.3/168.6999 | 0.0623/3561.4333 |
| S2026 | product_hunt | 3 | 0 | n/a/n/a | n/a/n/a |
| S2026 | reddit | 1 | 0 | n/a/n/a | n/a/n/a |
| S2026 | x | 3998 | 118 | 14.085/137.18 | 0/3829.8496 |
| S2026 | youtube | 270 | 7 | 4.3748/22.0561 | 0/203.842 |
| S26 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | github | 134 | 10 | 4.1206/41.0969 | 0/991.3144 |
| S26 | hacker_news | 27 | 0 | 6.9373/342.8397 | 0/98034.7973 |
| S26 | instagram | 60 | 1 | 5.5914/47.0648 | 0/945.4614 |
| S26 | linkedin | 276 | 0 | 29.498/388.8339 | 0/17814.2433 |
| S26 | product_hunt | 2 | 0 | n/a/n/a | n/a/n/a |
| S26 | reddit | 0 | 0 | n/a/n/a | n/a/n/a |
| S26 | x | 2783 | 66 | 13.77/155.4699 | 0/5394.1884 |
| S26 | youtube | 298 | 14 | 2.1/9.9562 | 0/71.796 |
| A16ZSR006 | bilibili | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | github | 16 | 0 | 1.5/51.1774 | 0/4974.0274 |
| A16ZSR006 | hacker_news | 0 | 0 | n/a/n/a | n/a/n/a |
| A16ZSR006 | instagram | 2960 | 264 | 23.1/327.774 | 0/16565.0134 |
| A16ZSR006 | linkedin | 235 | 0 | 19.0425/301.35 | 0/17714.2965 |
| A16ZSR006 | product_hunt | 5 | 0 | 83.5/834 | 1.7203/25936.6798 |
| A16ZSR006 | reddit | 8 | 0 | 5.0873/139.9069 | 0/15691.3883 |
| A16ZSR006 | x | 876 | 33 | 5.975/60.6035 | 0/1615.957 |
| A16ZSR006 | youtube | 242 | 5 | 1.1062/42.7341 | 0/4137.0395 |

## Perturbation checks

| Cohort | Monotonic tests | Company decreases | Reverse-order rank changes | +1% max rank shift | +24h max rank shift |
| --- | ---: | ---: | ---: | ---: | ---: |
| S2026 | 244 | 0 | 0 | 8 | 0 |
| S26 | 229 | 0 | 0 | 8 | 0 |
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
| input_envelope_hash_consistent | yes | "259f3cadeb24ae2066148d95652679b2b9184cbc382bdcd1474cfe445e9bde6a" |
| required_cohort_coverage | yes | ["A16ZSR006","S2026","S26"] |
| cohort_evidence_partition_exact | yes | {"cohort_entity_evidence_rows":45956,"cohort_evidence_rows":{"A16ZSR006":9280,"S2026":21532,"S26":15144},"invalid_batch_scope_evidence_rows":0} |
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
