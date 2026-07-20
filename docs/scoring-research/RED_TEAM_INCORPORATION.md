# Red team 2: research incorporation audit

Audit date: **2026-07-20**
Scope: `docs/scoring-research/source-registry.json`, `SOURCE_REGISTRY.md`, `src/lib/scoring/v5`, `scripts/scoring-v5`, `tests/scoring-v5-*`, `tests/scoring-research-registry.test.ts`, and `artifacts/scoring-v5`
Question: **Is the screened research genuinely incorporated, or merely cited?**

## Verdict

**FAIL — the research is accurately registered and conservatively described, but no screened source is yet provenance-proven as incorporated.**

Two different gates must not be conflated:

| Gate | Result | Evidence |
|---|---|---|
| No false claim of incorporation | **PASS** | All 25 records are `registry_only`, every `implementation_evidence` array is empty, and `summary.incorporated_count` is `0`. The human review also says no external source is incorporated. |
| Genuine incorporation of screened research | **FAIL** | The runner consumes/hashes the registry, requires an explicit accepted-dataset decision, and exports exact incorporated training-source metadata. The settled input and exported list are empty, and no protocol-source list, source-specific baseline, or source-specific acceptance test identifies any of the 25 screened sources as adopted. |
| Source-specific benchmark/data use | **FAIL** | The checked-in V5 input manifest has `sources: []`; the generated canonical dataset has no rows or source hashes; the generated model is rejected for insufficient data. |
| Source-specific protocol/baseline reproduction | **FAIL** | V5 contains generic fixed-horizon, temporal-split, ranking, calibration, and monotonicity mechanisms, but no record identifies which exact source caused each choice, no source-specific baseline is reproduced, and no registry row cites an implementation path. |
| Reproducible evidence path | **PASS for the empty-data rejection** | The focused suites and validate-only runner pass, the generated artifacts use the current target schema, and their hashes match a current reproduction. This proves deterministic rejection with no data; it does not prove research incorporation. |

The `incorporated_count: 0` statement is therefore honest. It is not evidence that the override’s research-incorporation requirement was completed; it is evidence that it remains open.

## Audit standard

A source passes this red team only if repository evidence satisfies at least one incorporation criterion stated in `SOURCE_REGISTRY.md`: actual benchmark data use; a reproduced protocol or baseline; an adopted and justified observation window/target; an implemented split or metric; a reproduced model; a tested source-derived failure mode; or an explicit fairness/calibration acceptance test. Mere similarity to a familiar method is insufficient. The evidence must identify the registry source and the exact use through a path, test, manifest, or evaluation artifact.

For rejected and screen-only sources, “not incorporated” is often the correct product decision. Those rows still fail the **incorporation** gate, while passing the narrower **claim accuracy** gate because they do not pretend otherwise.

## Findings

### RT2-01 — No source has an implementation evidence chain

**Severity: Critical**
**Result: FAIL**

The machine registry has 25 `registry_only` sources, zero implemented sources, zero implementation-evidence entries, and a summary count of zero. The V5 runner and pipeline now read/hash the registry and enforce dataset admission, but a repository-wide search finds no use of a stable external source ID in V5 implementation, tests, or artifacts. The only named sources remain in the registry/review themselves.

This is the decisive red-team result. Scientific ideas resembling the literature exist in code, but no source is provenance-proven to have been adopted.

### RT2-02 — Generic protocol mechanisms exist, but attribution is missing

**Severity: High**
**Result: FAIL**

The V5 implementation contains meaningful, defensible mechanisms:

- `dataset.ts` requires a real observation time, a later outcome time, a registered platform horizon/tolerance, a matching t0 counter, and nondecreasing native counters.
- `dataset.ts` computes future native growth as `log1p(t1) - log1p(t0)`.
- `splits.ts` assigns forward-time train/validation/test periods, rejects entity and collector-batch cross-boundary contamination, and derives a deterministic unseen-entity holdout.
- `labeling.ts` freezes the high-performance threshold from non-holdout training growth only.
- `evaluation.ts` reports NDCG@10/50, pairwise accuracy, Brier score, log loss, ECE, and entity-grouped paired bootstrap intervals.
- `training.ts` compares an equal-log-sum baseline with nonnegative logistic candidates, fits Platt calibration on validation, constrains engagement coefficients nonnegative and age nonpositive, and deterministically breaks selection ties.

These overlap with lessons in SEISMIC, DeepCas, the GitHub popularity paper, the calibration literature, and the XGBoost monotonicity documentation. They do not establish incorporation because:

1. no code/test/artifact names a registry source;
2. the registry says every one of those lessons remains proposed or unimplemented;
3. several ideas are generic and cannot be uniquely attributed after the fact; and
4. the exact published methods are not reproduced.

Promoting a source now solely because code happens to resemble it would be retrospective provenance laundering.

### RT2-03 — Dataset admission is fail-closed and exported; protocol attribution is absent

**Severity: High**
**Result: PASS for datasets / FAIL for protocols**

`scripts/scoring-v5/run.mjs` loads `source-registry.json`, and `runV5Pipeline` calls `validateTrainingSourcesAgainstRegistry`. An accepted input must exist in the registry, have the explicit `accepted_dataset` decision, have `incorporation.state = implemented`, have nonempty implementation evidence, and match the registry citation, source revision, SHA-256, access time, and license. Conditional datasets are not trainable. The export manifest includes `researchRegistryHash` plus `incorporatedResearchSources`, whose entries carry source ID, decision, exact-use text, and implementation evidence. Focused tests reject both absent and conditional sources and verify the exported mapping. This closes the self-declared-source and conditional-promotion gaps for the normal runner and pipeline API.

The current machine registry intentionally defines no `accepted_dataset` row or decision value, so every real source remains blocked until a coordinated registry-schema migration and evidence-backed promotion occurs. That is fail-closed behavior, not current dataset readiness.

One material gap remains: `incorporatedResearchSources` represents accepted **training datasets**, not adopted **protocol sources**. No artifact can prove whether SEISMIC, DeepCas, a calibration paper, or another protocol source caused a target, split, metric, calibration, failure-mode, or acceptance-test choice. The full-registry hash proves which registry bytes were consulted, not which protocol rows were used.

Dataset admission therefore passes. End-to-end research incorporation still fails because protocol attribution is absent and the actual incorporated-source export is correctly empty.

### RT2-04 — No paper data, external benchmark, or paper model was used

**Severity: High**
**Result: FAIL**

The checked-in `artifacts/scoring-v5/input-manifest.json` declares no sources. The generated canonical dataset contains zero rows and zero source hashes. The generated candidate search contains no platform result, and the generated model is `rejected_insufficient_data` with every platform unsupported. No GH Archive object, RecSys row, Reddit example, cascade trace, GHTorrent dump, or other external benchmark enters training or evaluation.

This is the safe decision given the source registry’s legal and feature findings, but it means criterion 1 (data used in training/held-out evaluation) and criterion 5 (published model reproduced) are unmet for every source.

### RT2-05 — The current empty-data rejection is reproducible

**Severity: Positive control**
**Result: PASS**

At the audit snapshot:

- the current input manifest and V5 test fixtures use the current target ID, `trainStart`, and per-platform target schema;
- the registry, V5 provenance, V5 pipeline, and V5 split suites pass 37/37; six runner/code-snapshot Node tests also pass, and validate-only freshly rebuilds and byte-compares all seven artifacts before returning the insufficient-data rejection;
- repository-wide `tsc --noEmit` passes with no diagnostics;
- generated model/evaluation/candidate-search hashes match the current validate-only reproduction; and
- the export manifest pins the full research-registry hash and exports exact incorporated training-source metadata (an empty list for this no-data run).

An independent reproduction from 26 minimal copied inputs in a brand-new clean temporary directory also produced two byte-identical transactional exports and matched all seven settled generated files. See `INDEPENDENT_REPRODUCTION.md` for the commands, input fingerprints, output hashes, and cleanup record.

This is valid evidence for deterministic, fail-closed behavior when no admissible training data exists. It does not change the incorporation verdict because the valid current input still contains no sources and the model remains rejected.

### RT2-06 — Calibration and monotonicity are partial implementations, not source reproductions

**Severity: Medium**
**Result: FAIL**

The current trainer fits only a custom nonnegative-slope Platt calibrator. It does not compare uncalibrated, Platt, beta, isotonic, and temperature candidates as proposed in `TARGET_SPEC.md` and the calibration registry rows. The pipeline itself records that the full calibration-family comparison is unimplemented.

Likewise, V5 projects custom logistic coefficients onto monotonic signs; it does not use XGBoost, reproduce its monotonic constraints, or pin an XGBoost build. The monotonic behavior is useful, but it cannot count as incorporation of either the XGBoost system paper or its official monotonicity documentation without an explicit protocol link and test evidence.

No conformal method or per-prediction interval is implemented; the model artifact correctly says such intervals are unsupported.

### RT2-07 — The anti-overclaim controls are effective

**Severity: Positive control**
**Result: PASS**

`tests/scoring-research-registry.test.ts` passes all nine checks. It enforces the registry schema, stable IDs, exact access dates, official HTTPS URLs, recorded dataset licensing, explicit rejection reasons, pinned downloaded-artifact hashes, consistent summary counts, and the rule that incorporation needs a concrete use and evidence. The registry and human review consistently avoid claiming that a citation, candidate protocol, or rejected source is an implemented model.

This safeguard should be preserved. The correction is to add real evidence before promotion, not to weaken the zero-incorporation assertion.

## Source-by-source adjudication

Every row below passes **claim accuracy** because the registry says it is not incorporated. Every row fails **genuine incorporation** because no source-specific implementation evidence exists.

| Registry source | Repository evidence observed | Incorporation result |
|---|---|---|
| `twitter-recsys-2020` | Temporal splitting exists generically. No reader–Tweet schema, exposure/pseudo-negative task, separate-label RCE/PR-AUC baseline, challenge data, or source-ID reference exists. | **FAIL — not incorporated; registry claim accurate.** |
| `twitter-recsys-2021` | No reader–Tweet model, follower-quintile fairness metric, author-audience acceptance test, challenge data, or source-ID reference. | **FAIL — not incorporated; registry claim accurate.** |
| `seismic-2015` | Fixed t0/t1 horizons, forward splits, and ranking metrics resemble protocol lessons. No retweet event process, Kendall/top-k coverage reproduction, SEISMIC baseline, or traceable adoption. | **FAIL — partial resemblance only; registry claim accurate.** |
| `feature-point-process-2016` | V5 compares a transparent sum with logistic models and uses a calendar split. No Hawkes/point-process baseline, published feature experiment, licensed benchmark, or source link. | **FAIL — partial resemblance only; registry claim accurate.** |
| `deepcas-2017` | V5 computes future increment from t0 to t1 and splits temporally. It has no cascade graph model, DeepCas reproduction, benchmark, or source link. | **FAIL — partial resemblance only; registry claim accurate.** |
| `deephawkes-2017` | No DeepHawkes implementation/data and no source-specific test that rejects diffusion-path input when unavailable. | **FAIL — not incorporated; registry claim accurate.** |
| `ctcp-2023` | No continuous-time graph state/model or benchmark. V5’s leakage-safe entity split is a generic design, not a reproduced CTCP failure-mode ablation. | **FAIL — not incorporated; registry claim accurate.** |
| `concat-2025` | No neural ODE/point-process model, event cascade, split reproduction, or source link. | **FAIL — not incorporated; registry claim accurate.** |
| `reddit-v-2025` | No Reddit-V rows, multimodal model, licensed artifact, fixed-horizon adaptation, or evaluation. | **FAIL — not incorporated; registry claim accurate.** |
| `poprero-2024` | No PoPreRo data/model and no subreddit-held-out evaluation. | **FAIL — not incorporated; registry claim accurate.** |
| `mmg-pop-2026` | Platform-specific horizons are supported generically, but no 4/8/16/24-hour comparative benchmark, MMG model, artifact, or source link exists. | **FAIL — partial resemblance only; registry claim accurate.** |
| `github-popularity-2016` | V5 can define a GitHub-native future counter and ranking metrics. No paper sample, future-star reconstruction, paper baseline, or traceable source adoption exists. | **FAIL — partial resemblance only; registry claim accurate.** |
| `gh-archive` | Input manifest has no source and no GH Archive object/hash. No reconstruction, identity policy, or GitHub held-out experiment exists. | **FAIL — correctly remains conditional and unincorporated.** |
| `ghtorrent` | No dump, schema map, query, or training/evaluation use. | **FAIL — correctly remains screen-only and unincorporated.** |
| `can-cascades-be-predicted-2014` | No relative-growth/doubling baseline, matched-content evaluation, Facebook data, or source link. | **FAIL — not incorporated; registry claim accurate.** |
| `lambdamart-2010` | NDCG is computed, but no LambdaMART implementation, ranking groups, model comparison, or source attribution exists. | **FAIL — metric resemblance is not model reproduction.** |
| `calibration-guo-2017` | V5 fits calibration outside final test and reports reliability metrics, but does not implement/compare temperature scaling or cite this source in an acceptance test. | **FAIL — partial protocol resemblance only.** |
| `calibration-niculescu-mizil-2005` | A Platt-like calibrator exists, but no Platt-versus-isotonic experiment or source-linked acceptance test exists. | **FAIL — partial method resemblance only.** |
| `conformal-angelopoulos-bates-2021` | No conformal interval, coverage test, or exchangeability audit. Artifacts explicitly mark per-prediction intervals unsupported. | **FAIL — correctly unincorporated.** |
| `xgboost-paper-2016` | No XGBoost dependency, training run, model artifact, or baseline comparison. V5 uses custom constrained logistic regression. | **FAIL — correctly remains conditional and unincorporated.** |
| `xgboost-monotonic-docs` | Custom logistic coefficient signs and monotonic prediction tests resemble the requirement, but no XGBoost constraint configuration or source-linked adoption exists. | **FAIL — partial requirement resemblance only.** |
| `reddit-data-api-terms-2025` | The terms change the registry’s Reddit decisions, and the generic dataset gate now blocks rejected registry rows. No Reddit/source-specific regression test or terms-revision evidence is exported, and the source remains `registry_only`. | **FAIL incorporation; screening rationale and generic rejection are accurate.** |
| `online-conformal-2024` | No online conformal algorithm, delayed-outcome coverage test, or interval-width report. | **FAIL — not incorporated; registry claim accurate.** |
| `recsys-2020-x-engineering-review` | No adversarial-validation procedure or test traceable to the retrospective. | **FAIL — not incorporated; registry claim accurate.** |
| `deepcas-independent-mmg-2026` | No DeepCas/DeepHawkes cross-benchmark on MMG-Pop or other transfer experiment. | **FAIL — correctly remains screen-only and unincorporated.** |

## Required evidence to pass a follow-up red team

1. Extend the proven research-registry enforcement/export boundary to claimed protocol sources; each must reference a stable registry ID and exact adopted element.
2. Add protocol entries to a source-to-implementation manifest with `sourceId`, exact adopted element, implementation paths, tests, artifact hashes, and protocol version. Export that mapping with the model alongside `incorporatedResearchSources`.
3. For any protocol source promoted to `implemented`, add at least one source-specific test or reproduced baseline. Generic code similarity is not sufficient.
4. Keep rejected datasets out of training, but add executable gates for the reason where appropriate—for example, absent cascade histories, prohibited Reddit training rights, or reader/exposure target mismatch.
5. Preserve the current manifest/test/runner/artifact agreement; after any nonempty source is admitted, regenerate from registered inputs in a clean environment and verify every exported hash.
6. Implement and freeze the promised calibration-family comparison before attributing calibration protocol incorporation. Do not promote XGBoost, LambdaMART, or conformal sources until those methods or explicit source-derived acceptance tests actually exist.
7. Only then update `incorporation.state`, `exact_use`, `implementation_evidence`, and `summary.incorporated_count`. The registry test should continue to fail any evidence-free promotion.

## Read-only validation record

Commands executed from the repository root:

```text
jq -e '.summary.incorporated_count == 0 and ([.sources[].incorporation.state] | all(. == "registry_only")) and ([.sources[].incorporation.implementation_evidence] | all(length == 0))' docs/scoring-research/source-registry.json
```

Result: **PASS** (`true`).

```text
vitest run tests/scoring-research-registry.test.ts tests/scoring-v5-provenance.test.ts tests/scoring-v5-pipeline.test.ts tests/scoring-v5-splits.test.ts
```

Result: **PASS (37/37)** across all four focused suites. The separate runner/code-snapshot Node suite passes **6/6**.

```text
node --experimental-strip-types --loader ./scripts/scoring-v5/typescript-loader.mjs ./scripts/scoring-v5/run.mjs --validate-only
```

Result: **PASS**, after a fresh double build and byte comparison of all seven checked-in artifacts, deterministically returning `rejected_insufficient_data`, no supported platforms, and an evaluation gate decision of `reject`.

```text
tsc --noEmit
```

Result: **PASS**, exit 0 with no TypeScript diagnostics.
