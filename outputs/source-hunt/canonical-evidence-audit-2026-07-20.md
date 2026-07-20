# Canonical evidence audit — 2026-07-20

Scope: read-only inspection of canonical source-discovery/evidence files for `S2026`, `S26`, and `A16ZSR006`, plus a focused fix to the autonomous public-snapshot merge. No canonical evidence JSON, graph snapshot, scoring formula, platform/metric weight, taxonomy, vertical, or UI file was changed by this audit.

Working directory: `/Users/allenxu/Documents/Codex/2026-07-09/pu/returner-fund`

Branch: `main`

## Canonical evidence surface

| File | Role | Raw rows |
| --- | --- | ---: |
| `src/lib/social/public-evidence-current.json` | Merged public collector export; YC graph input plus explicit A16Z attachments | 2,286 evidence; 2,103 review; 5,439 failures |
| `src/lib/social/logged-in-evidence-current.json` | Logged-in YC social evidence | 2,546 evidence; 328 failures |
| `src/lib/social/targeted-evidence-current.json` | Canonical YC source-hunt evidence | 1,072 evidence; 1 review |
| `src/lib/social/a16z-speedrun-006-social-evidence.json` | Canonical A16Z source-hunt evidence | 304 evidence |
| `src/lib/social/github-traction.json` | S2026 GitHub snapshot | 40 accounts; 181 repositories |
| `src/lib/social/github-traction-summer-2026.json` | S26 GitHub snapshot | 22 accounts; 92 repositories |
| `src/lib/social/github-traction-a16z-speedrun-006.json` | A16Z GitHub snapshot | 17 accounts; 16 repositories |
| `src/lib/social/eden-robotics-verified-native-evidence.json` | Verification/import fixture, not directly loaded by the graph | 12 evidence |

`a16z-speedrun-006-social-accounts.json` and `verified-social-overrides.json` are attribution/account inventories, not post evidence. They were inspected for entity/account attribution but excluded from post counts.

## Strict native-evidence result

The strict rule used here requires: exact batch scope, known entity attribution, `review_state=verified`, a platform-native post/repository URL, agreement between URL-derived and supplied post IDs, a valid link state, supported post-level metrics only, and at least one positive scoring metric. Counts are after native physical-identity dedupe within each file.

| Canonical file/lane | Strict accepted | Quarantined/rejected | Notes |
| --- | ---: | ---: | --- |
| Public evidence | 429 | 1,857 | Predicted settled-merge result using the catalog resolver. Context-only web/RSS/profile rows remain auditable in `needsReview` rather than accepted evidence. |
| Logged-in evidence | 2,184 | 362 | 49 rows lack a unique batch resolution; 77 lack a native activity URL; 22 are not verified; 39 lack a positive post metric. Reasons overlap. |
| Targeted YC social (non-GitHub) | 993 | 79 | Includes five LinkedIn comment/parent identity conflicts described below. |
| Targeted YC GitHub | 37 | 15 | Rejections contain non-scoring metadata inside `metrics`: 11 `lastActivityAt`, one `commits`, and three `network,sizeKb`. |
| A16Z social (non-GitHub) | 161 | 143 | 119 rows place `metricSource` inside `metrics`; four use `authorFollowers`; 20 are not native activity URLs. Reasons overlap. |
| A16Z seeded GitHub | 2 | 16 | Four commit URLs require repository canonicalization; remaining rejects contain commit diff/language/repository-size metadata or no positive scoring metric. |
| Eden verification fixture | 12 | 0 | All 12 are valid; all 12 already match loaded targeted evidence by batch + attribution + physical post identity. |

Strict source-hunt target counts (`targeted-evidence-current.json` plus `a16z-speedrun-006-social-evidence.json`) by batch and platform:

| Batch | GitHub | HN | Instagram | LinkedIn | Product Hunt | Reddit | X | YouTube | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S2026 | 14 | 45 | 12 | 162 | 2 | 1 | 150 | 106 | 492 |
| S26 | 23 | 35 | 0 | 71 | 1 | 0 | 355 | 53 | 538 |
| A16ZSR006 | 2 | 0 | 16 | 58 | 3 | 10 | 15 | 59 | 163 |
| **Total** | **39** | **80** | **28** | **291** | **6** | **11** | **520** | **218** | **1,193** |

These are strict evidence rows, not unique companies/founders and not scoring totals.

## Native URL, post-ID, and physical identity audit

Across strict accepted social rows in the loaded canonical files:

- 74 same-batch, same-entity physical duplicate clusters (74 extra rows) were found. Canonical URL and normalized post-ID grouping produced the same 74 clusters. The graph dedupe should retain one strongest/freshest observation per attributed physical post.
- 76 physical posts have more than one attribution, covering 189 rows. These must not be globally deleted: many are valid company + founder or one Top Voice post that explicitly names several companies. They must remain separate attribution rows while scoring dedupes the physical post inside any rollup.
- All 12 Eden fixture rows match a loaded targeted row. The fixture is verification provenance, not 12 additional graph observations.
- Five canonical LinkedIn rows are not posts by the claimed Top Voice. Their URL identifies a parent post while `platformPostId` identifies a comment. They must remain context/review rows with contribution zero and must never inherit parent-post metrics:

| Target | Canonical row | URL activity | Supplied comment ID | Exact reason |
| --- | --- | --- | --- | --- |
| InsForge | `linkedin-topvoices_people_only_third_sol_ultra-s2026-topvoice-insforge-amiklas-7462760262366842880` | `7462200339899846656` | `7462760262366842880` | `native_id_conflict`; parent post belongs to another author; `visibleText` is also embedded in `metrics`. |
| Pango | `linkedin-topvoices_people_only_third_sol_ultra-s26-topvoice-pango-petekoomen-7473616064967266304` | `7473269455783948288` | `7473616064967266304` | `native_id_conflict`; parent-post metrics cannot be attributed to Pete Koomen's comment. |
| 9 Mothers | `linkedin-topvoice-insider-sol-ultra-s2026-9-mothers-corporation-taro-fukuyama-7445191769534676992` | `7445188889805271040` | `7445191769534676992` | `native_id_conflict`; comment context only. |
| Atrisa | `linkedin-topvoice-insider-sol-ultra-s2026-atrisa-mathilde-collin-7471364906072686592` | `7471007050957733888` | `7471364906072686592` | `native_id_conflict`; comment context only. |
| Lumius | `linkedin-topvoice-insider-sol-ultra-s2026-lumius-mathilde-collin-7444469004846510080` | `7444403934800297984` | `7444469004846510080` | `native_id_conflict`; comment context only. |

Two representative attribution conflicts requiring proof before either attribution is accepted:

- LinkedIn activity `7480757450569289728` is attributed to Context.dev founder Yahia Bakour in public evidence and Archal founder Noah Song in logged-in evidence.
- LinkedIn activity `7477260374233276416` is attributed to Florin at company level and Dialogus founder Rodrigo Terán in another canonical source.

The broader 76-cluster multi-attribution queue should be checked with native author/account evidence, not mechanically collapsed.

## Batch-scope audit

The previous merged public snapshot declares all three batches at snapshot level and has no row-level batch fields. The old merge could therefore collapse or retain a post without knowing its cohort.

The focused fix now:

- stamps every fresh collector evidence/review/failure row with `batchSlug`;
- resolves legacy rows only when current catalogs yield exactly one cohort;
- treats collisions such as `company-textsidekick` as ambiguous;
- includes batch + entity attribution + strict native physical post identity in the dedupe key; and
- moves missing/ambiguous rows to `needsReview` with `missing_or_ambiguous_batch_scope`.

Current raw reason counts are eight public rows, 49 logged-in rows, and two targeted rows with missing/ambiguous batch scope. In the public snapshot, the only otherwise-strict rows affected are two old Sidekick Hacker News items (`23928666` and `35184120`); they are intentionally quarantined rather than guessed into S2026 or S26.

## Top Voice audit

61 targeted rows explicitly declare a Top Voice audience in structured visible evidence:

- YC Partners: 43/43 match the active allowlist by native handle/name.
- Insiders: 18/18 match the active allowlist by native handle/name.
- Unmatched: 0.

The five LinkedIn comment rows above still fail post identity/scoring eligibility despite matching a Top Voice identity. Top Voice membership is not permission to reuse parent-post metrics.

## Graph visibility and scoring eligibility

No graph snapshot was regenerated by this audit. Existing snapshots were written before this audit at:

- S2026: `2026-07-20T08:27:39.302Z`
- S26: `2026-07-20T08:27:41.765Z`
- A16ZSR006: `2026-07-20T08:27:42.886Z`

Strict revalidation of their visible evidence produced:

| Batch | Visible graph evidence | Strictly eligible now | Strict failures | Failure surface |
| --- | ---: | ---: | ---: | --- |
| S2026 | 2,240 | 2,232 | 8 | GitHub metadata: three `network,sizeKb`, four `lastActivityAt`, one `commits`. |
| S26 | 714 | 692 | 22 | 15 social `authorFollowers`; seven GitHub `lastActivityAt`. |
| A16ZSR006 | 302 | 168 | 134 | 119 social `metricSource`, four social `authorFollowers`, and 11 GitHub rows with `followers`, `language`, or `repository_size_kb`. |
| **Total** | **3,256** | **3,092** | **164** | Unsupported/non-post metadata is silently ignored by scoring normalization today but violates strict evidence eligibility. |

All 3,256 visible rows currently say `review_state=verified` and have positive `contributionScore`; therefore the 164 failures are particularly important: they look accepted in the graph even though their metric payload is not strict.

Historical `outputs/source-hunt` accounting inspected:

- `search-ledger.json` (2026-07-16): 718 canonical rows; 875 rejected candidates — 664 duplicates, 33 missing/weak metrics, nine disallowed Top Voices, 25 profile-only, 113 rejected, 13 repost/quote context failures, 18 search/generic pages.
- `import-candidate-audit.json` (2026-07-15): 326 accepted candidates inspected; 285 duplicates; four unsupported company-site rows; 37 net-new at that point.
- `2026-07-19-yc-import-audit.json`: 405 received, 384 accepted, 21 duplicates, zero rejects.
- `2026-07-19-cross-batch-yc-import-audit.json`: 190 received, 168 routed to YC, 22 routing skips, zero rejects.
- `2026-07-19-a16z-community-import-audit.json`: the same 190 received, 22 routed to A16Z, 168 routing skips, zero rejects.
- `visibility-audit-fifth-pass.json` is an older 152-row sample and is superseded for current eligibility by the 3,256-row graph audit above.

## Focused implementation

Files changed by this audit lane:

- `scripts/lib/autonomous-ingestion-plan.mjs`
- `tests/autonomous-ingestion-plan.node-test.mjs`
- this audit artifact

Coordinated runner changes from the systemic lane are present in `scripts/run-autonomous-ingestion.mjs`: fresh row-level batch provenance and a deterministic current-catalog resolver passed to `mergePublicEvidenceSnapshots`.

Merge behavior now rejects/quarantines:

- unsupported platform;
- invalid or non-native activity URL;
- URL/supplied post-ID conflict;
- missing/ambiguous batch scope;
- non-verified review state;
- invalid/blocked link;
- unsupported metric keys/values; and
- no positive visible scoring metric.

Rejected rows are copied into `needsReview` with `sourceEvidenceId`, `candidateUrl`, and exact `quarantineReasons`; they are not silently deleted.

## Commands and results

- `node --check scripts/lib/autonomous-ingestion-plan.mjs` — passed.
- `node --check scripts/run-autonomous-ingestion.mjs` — passed.
- `node --test --test-name-pattern='autonomous public evidence merge|runner merges only after post-rebase' tests/autonomous-ingestion-plan.node-test.mjs tests/autonomous-ingestion-runner-contract.node-test.mjs` — 7 tests passed, 0 failed.
- Vite SSR loaded the current graph datasets successfully; observed S26 115/228 and A16Z 59/128 roster counts. The combined YC dataset contains all 371 companies and 753 founders.
- Structured Top Voice matcher audit — 61/61 matched, 0 unmatched.
- Strict current public merge simulation with deterministic catalog resolution — 429 accepted, 1,857 quarantined; no canonical file was written.
- Physical identity audit — 74 attributed duplicate clusters, 76 multi-attribution clusters, Eden fixture 12/12 already represented.
- `git diff --check` should be rerun by root after all concurrent lanes settle; it was not used here as a whole-worktree gate while other agents were still writing.

## Release blockers / next actions

1. Do not publish a refreshed graph until the canonical writer is idle and the settled runner has migrated legacy public rows through the new batch/native/metric quarantine.
2. Normalize or move non-scoring metadata (`metricSource`, `authorFollowers`, `lastActivityAt`, `language`, `repository_size_kb`, `network`, `sizeKb`, `commits`) out of `metrics` before treating the 164 graph rows as strict evidence.
3. Keep the five LinkedIn comment rows as zero-score context/review only; never replace their comment ID with the parent ID to make them pass.
4. Review the 76 multi-attribution physical clusters with native author/account proof. Preserve verified company+founder/multi-company attribution, but quarantine unrelated-entity collisions.
5. After the canonical files settle, run the complete focused ingestion/dedupe/graph test set and then regenerate public artifacts once through the existing release workflow.
