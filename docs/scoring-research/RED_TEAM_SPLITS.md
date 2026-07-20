# V5 Split, Leakage, and Acceptance Red Team

Review status: **production acceptance FAIL; fail-closed release behavior PASS**
Reviewed protocol: `returner-post-performance-v5-prereg-2026-07-20`
Review snapshot: `2026-07-20 06:23 America/Chicago`
Scope: the frozen V5 pre-registration and feature specification, `scripts/scoring-v5`, `src/lib/scoring/v5`, all five focused V5 test files, and the seven generated artifacts. No implementation or artifact was changed by this review.

## Executive verdict

The final implementation is a deterministic, fail-closed research scaffold. The material pre-remediation leakage and provenance defects are fixed: the protocol freezes the target and split, observations require canonical exact instants and per-metric `t0` timestamps, platform metric namespaces are enforced, conflicting duplicate readings are quarantined without looking at future growth, missing is distinct from zero, registry approval is bound to exact source identity, inference requires a trusted observation cutoff and training-only support envelopes, and experimental output is explicitly unvalidated and has no probability or common-score fields.

It is **not eligible to replace V4 or emit a production V5 probability**. The checked-in run has no accepted rows, supports no platform, and is correctly `rejected_insufficient_data`. Even a compatible nonempty run cannot become `accepted`: the pipeline appends unconditional blockers for V4 replay, the one-standard-error rule, the complete calibration-family comparison, weekly-query macro evaluation, subgroup/reliability checks, and latency. Additional pre-registered acceptance work remains absent, most importantly the required salted author/account grouping field and its leakage/concentration gate.

Exact current verdict: **split/leakage scaffold PASS for the controls it implements; artifact/runtime publication controls PASS; scientific acceptance and production release FAIL.**

## Severity and disposition

`Blocker` means production acceptance must remain impossible. `High` can materially bias labels, splits, probabilities, or release decisions. `Medium` is an auditability, reproducibility, or robustness gap.

| ID | Area | Severity | Result | Final disposition |
| --- | --- | --- | --- | --- |
| RT-01 | Fail-closed release state | — | **PASS** | Empty default run rejects; a compatible nonempty run is forced to remain `experimental` by unconditional gate reasons. |
| RT-02 | Frozen target | — | **PASS** | Exact platform target table and threshold definition are bound to the protocol ID; mutation is rejected. |
| RT-03 | Feature cutoff | — | **PASS** | Every present metric requires its own canonical observation instant exactly equal to global `t0`; later/mixed features are rejected. |
| RT-04 | Timestamp precision | — | **PASS** | Date-only/noncanonical observation, outcome, exact-publication, and metric timestamps fail closed. |
| RT-05 | Duplicate resolution | — | **PASS** | Equal-priority `t0` or `t1` disagreement is quarantined deterministically; future growth is not a precedence rule. |
| RT-06 | Target construction | — | **PASS** | Native-counter `log1p(t1)-log1p(t0)`, training-only nearest-rank q80, and strict `>` are implemented. |
| RT-07 | Temporal/physical split | — | **PASS** | Assignment uses `t0`; canonical IDs are deduplicated; known content-fingerprint collisions cannot cross partitions. |
| RT-08 | Known/unseen company policy | — | **PASS** | The stable SHA-256 holdout is removed from all fitting/calibration/known-test inputs and used only in final-period unseen-company evaluation. |
| RT-09 | Frozen split policy | — | **PASS** | Exact Central-time UTC boundaries and `groupByEntity=false`/`groupByBatch=false` are immutable under this protocol ID. |
| RT-10 | Missing values | — | **PASS** | Canonical data preserves absence and schema v3 exports explicit `*_missing` indicators; observed zero remains distinct. |
| RT-11 | Registered ranking metric | Blocker | **FAIL** | Evaluation still computes one platform-wide NDCG, not equal-platform Central-calendar-week macro NDCG@50; the one-standard-error selection rule is absent. |
| RT-12 | Calibration protocol | Blocker | **FAIL** | Only validation-fitted Platt calibration exists; uncalibrated/beta/isotonic selection, Brier-vs-base-rate, and maximum reliability-gap gates are absent. |
| RT-13 | Final-test isolation | — | **PASS** | Reversing final-test outcomes does not change thresholds, selected parameters, calibration, or validation results; candidate-search output contains no test metrics. |
| RT-14 | Bootstrap | Medium | **PARTIAL FAIL** | Seed `20260720`, 10,000 replicates, stable ordering, company clusters, and counter-based draws pass, but the bootstrapped statistic is the unregistered global NDCG from RT-11. |
| RT-15 | Support and author grouping | Blocker | **FAIL** | Row/entity/positive/wave/concentration minima exist, but the required `author_group_hash` is absent from raw/canonical/split types and no author/account concentration or cross-split leakage gate exists. Exact-lineage coverage is not separately measured. |
| RT-16 | Subgroups and transfer | Blocker | **FAIL** | Pre-registered subgroup, source/missingness/correction, leave-one-batch-out, platform-transfer, and full secondary-metric evaluations are not emitted. |
| RT-17 | Comparators and release gates | Blocker | **FAIL** | V4 replay, complete strongest-baseline intervals, known/unseen gap, full robustness suite, registered-machine p95 latency, per-platform artifact-size gate, model card, migration, and rollback evidence are incomplete or absent. |
| RT-18 | Source registration | — | **PASS** | Accepted bytes are path-constrained, hashed, licensed, cited, offline, and bound to registry decision, source revision, SHA-256, access time, and license. |
| RT-19 | Reproduction/publication | — | **PASS** | Code snapshot, dependency lock, pinned runtime, same-process byte reproduction, seven-file validation, and an independent clean-directory reproduction with two complete transactional exports all pass byte-for-byte. |
| RT-20 | Experimental output | — | **PASS** | Default experimental inference is unscored; explicit research override returns `experimental_unvalidated` without probability or 0–100 score. |
| RT-21 | Runtime provenance/OOD | Medium | **PARTIAL PASS** | Schema v3 inference binds canonical ID, artifact/target/data/split hashes, `asOf`, trusted cutoff, exact publication time, missingness, evidence coverage, and explanation; incompatible, unsupported, or out-of-training-envelope inputs fail closed. Separate link-verification/freshness fields and validated uncertainty remain unfinished. |

## Remediated adversarial findings

The prior target/split mutation, date-only timestamp, and future-outcome duplicate probes now fail as required and are permanent regression tests.

- Frozen protocol: changing any target counter/horizon/tolerance/quantile, split boundary, or grouping flag under the registered protocol throws before source rows are read.
- Observation cutoff: raw schema `scoring-v5-observations-v2` requires canonical ISO instants; every present metric has `metricObservedAt`; any metric not exactly at `t0` is rejected.
- Duplicate integrity: source order cannot decide a row; conflicting equal-priority `t0` metrics or `t1` outcomes quarantine every conflicting representation; otherwise deterministic earliest `t0`/earliest eligible `t1` rules apply without future-growth sorting.
- Namespace integrity: each platform has a frozen native-counter namespace. Unknown metrics and cross-platform aliases, such as GitHub stars on X, are quarantined.
- Missing semantics: model schema `scoring-v5-features-v3` uses `*_missing` indicators. The tests prove absent `likes` and observed `likes=0` produce different feature vectors.
- Registry identity: an accepted source cannot borrow another registry entry. Decision, implementation evidence, citation, revision, bytes, access time, and license must match exactly.
- Inference safety: `scoring-v5-model-artifact-v2` verifies its artifact hash, requires canonical physical ID and evidence SHA-256, requires a trusted canonical cutoff, rejects observations after that cutoff, and requires the registered target counter.
- Distribution support: min/max envelopes are fit from training rows only. A metric with no trained envelope is `missing_feature_support`; a value outside its envelope is `out_of_distribution`. This is a conservative support boundary, not a statistical uncertainty interval.
- Research semantics: a nonaccepted artifact cannot silently emit a calibrated probability. `allowExperimental` yields a provenance-rich `experimental_unvalidated` result and deliberately omits probability/common-score fields.

## Genuine remaining production blockers

### Author/account grouping is still not implemented

`FEATURE_SPEC.md` requires a salted deterministic `author_group_hash` before any dataset can be accepted. V5 types currently carry company `entityId` and optional `batchId`, but no author/account group. Consequently the pipeline cannot detect the same author/account crossing companies or temporal partitions, calculate author/account concentration, or satisfy the support requirement expressed as companies/accounts. This remains an unconditional production blocker even if future company-level split checks pass.

### Evaluation and calibration still differ from the pre-registration

`evaluation.ts` ranks a whole platform partition as one query. It does not construct Central-calendar-week queries, exclude/report zero-positive weeks under the frozen rule, or macro-average those weekly query scores with equal platform weight. Candidate selection therefore also lacks the registered one-bootstrap-standard-error tie set.

Calibration remains Platt-only. Production probability acceptance still requires the frozen four-family comparison, validation selection ordering, final-test Brier improvement over the training-base-rate predictor, finite clipped log loss, ECE ceiling, and per-bin reliability-gap gate. The current experimental calculations cannot establish those conditions.

### The full acceptance evidence is absent

There is no prospective dataset in the default run and no supported platform model. V4 replay and the full registered comparator/interval suite are absent. The known-vs-unseen limit, subgroup decisions, leave-one-batch-out checks, complete robustness and secondary metrics, latency benchmark, per-platform artifact-size measurement, and release documentation/rollback evidence are also incomplete. `pipeline.ts` correctly makes acceptance impossible rather than treating missing gates as passes.

### Independent clean reproduction is complete

The runner computes its own SHA-256 code snapshot over every V5 runner module, scoring source, and focused test; rejects a caller-supplied mismatch; asserts Node `24.14.0`, UTC, and `en-US`; hashes `package-lock.json`; runs the pipeline twice; and compares serialized dataset, split, model, evaluation, candidate search, and export-manifest bytes. It then validates all seven published files byte-for-byte. Publication uses a staged directory, validates before and after the swap, and restores the complete prior set on failure.

That establishes deterministic same-process output and safe set publication. In addition, `INDEPENDENT_REPRODUCTION.md` records a brand-new directory containing only 26 minimal inputs, two complete transactional exports, seven-file comparisons against the settled artifacts, and a final `--validate-only` pass. All bytes matched; the temporary directory was then moved recoverably to Trash.

## Current artifact audit

The generated directory contains exactly seven artifacts and `--validate-only` matched every byte. The current empty-data result is intentionally small (8,085 total bytes), supports no platform, exports no growth threshold, and preserves V4 as the only production baseline.

| Artifact | SHA-256 |
| --- | --- |
| `candidate-search.json` | `bd49340a15ffa8da0b637fe6fa8bfe159bcbc4fc816b60ac09f327dd8934925d` |
| `canonical-dataset.json` | `eaf4a00732c3a03325aab1cd29b8d547bfb1fa504fdd1474fa72690bcb163bd8` |
| `evaluation.json` | `89d29dd402a72aae1ca9f19e44b2398c42c379df77b09efd15a423eece42c862` |
| `export-manifest.json` | `95b136a1acc23ecebc548d237667961d95d0607fefd68c2f84d26117bfeb2e1b` |
| `model.json` | `481d9fb9b652b8a564c7c99f0bdd2afe1c3edb4ed899f701184907c15bd23377` |
| `reproducibility.json` | `cce91c4741e32c0b9be25658a2510294aedfbaf93991360cba8cce0de6ccd37b` |
| `split-manifest.json` | `bd05d5253fe39ffc6ce456cf8985453da9b7ccd643706bc6305dd4759407a1a2` |

The export manifest binds:

- code snapshot revision: `sha256:64a83e80d9e83e6f9bda1a4f2b4789a83e6081e2173875da57382668f889d0e4`;
- dependency-lock SHA-256: `80cd12e4c1424387f3df9647ac7cd9b103c0b9a9c0669be410604bda043e009c`;
- runtime: Node `24.14.0`, UTC, `en-US`, seed `20260720`, offline after registration;
- model schema `scoring-v5-model-artifact-v2` and feature schema `scoring-v5-features-v3`;
- model status `rejected_insufficient_data`, gate decision `reject`, supported platforms `[]`;
- the sole empty-run gate reason: `No platform has compatible rows with both outcome classes in every frozen split.`

The empty artifact lists only the data-support reason because no platform model was trained. The implementation's other unconditional blockers are appended once any compatible platform model exists; the nonempty fixture verifies that result remains `experimental`.

## Verification results

| Check | Result |
| --- | --- |
| Focused Vitest: pipeline, provenance, splits | **PASS** — 3 files, 28 tests |
| Node tests: runner and code snapshot | **PASS** — 6 tests |
| Focused ESLint: runner, V5 source, and five focused test files | **PASS** |
| TypeScript: `tsc --noEmit` | **PASS** |
| `git diff --check` for the completed report | **PASS** |
| Pinned-runtime offline runner with `--validate-only` | **PASS** — exact seven-file byte match, rejection state unchanged |
| Target/split mutation regression | **PASS** — rejected |
| Date-only/future-metric regression | **PASS** — rejected |
| Conflicting `t0`/`t1` duplicate regressions | **PASS** — deterministically quarantined |
| Namespace/trusted-cutoff/OOD regressions | **PASS** — unscored with explicit reason |

## Inspected specification and input hashes

| File | SHA-256 |
| --- | --- |
| `TARGET_SPEC.md` | `ef5d8c7394725c80896ad3c6a5994fa4020f1c78e0d1980b9d7c3e26c0a3fca4` |
| `FEATURE_SPEC.md` | `deaa451d425be1e7c2b5941a155144d8a853768547b2c3f96251729b5519530a` |
| `source-registry.json` | `9c7eadbad87b62491397c8ad3f3a7541a319df502be1a24025a700e1753392f8` |
| `input-manifest.json` | `7945b9fc829bbb7cc6b4118c587d19c28daaa9841ee05b346c0e155d9455806a` |

## Acceptance decision

**Do not replace V4. Do not expose the current V5 artifact as a production probability, score, or company aggregate.** The present artifact set is safe to retain as a deterministic, offline, explicitly rejected research scaffold. Production reconsideration requires prospective support plus every remaining Blocker above—especially author/account grouping, registered weekly macro evaluation, full calibration, V4/comparator evidence, subgroup/robustness gates, and release operations—to be implemented and rerun on an untouched final test.
