# V5 heuristic, manipulation, and labeling red team

Audit date: **2026-07-20**
Audit disposition: **current production safety PASS; V5 production promotion FAIL**
Scope: settled V5 preprocessing, duplicate resolution, feature construction, training, calibration, evaluation, inference, artifacts, production selectors, and user-facing model-status copy.

This review was performed after the structural remediation pass. It does not authorize V5 promotion. The correct current state is still the frozen V4 production baseline plus a V5 artifact with `status = rejected_insufficient_data`, `gateDecision = reject`, zero supported platforms, and no learned coefficients.

## Executive verdict

The most important safety property passes: **no unfinished V5 result can silently become a production score**. The default artifact rejects, a nonempty research run is forced to remain experimental while registered gates are missing, the ordinary inference path refuses an experimental artifact, experimental opt-in returns `experimental_unvalidated` without a probability or 0–100 score, company aggregation remains unsupported, and there is no production call site for `predictV5`. V4 scoring files have no tracked diff from this work.

The remediation also closes the original hidden-semantics defects. The protocol table and split are now byte-semantics-frozen; raw timestamps must be canonical instants; each metric must carry an exact `t0`; missing metrics have explicit learned missingness indicators; duplicate conflicts quarantine; registry approval binds the exact source hash/revision/access time/license; input order does not select a different row or model; and artifact provenance binds the exact executable V5 source snapshot.

The three adversarial executable gaps found in the first pass are now closed:

1. A frozen platform-to-metric namespace routes every admitted metric. A cross-platform metric quarantines a training row and makes runtime inference visibly unscored.
2. Each trained platform artifact exports finite raw feature envelopes fitted only on the actual fitting population. Supplied features without training support or outside those envelopes fail closed; no hand-picked count cap was introduced.
3. Runtime inference requires a canonical trusted observation cutoff and rejects any observation after it. Historical/offline evaluation remains possible by explicitly supplying its authoritative as-of instant.

V5 nevertheless remains **ineligible for production** because the registered longitudinal data and mandatory scientific acceptance gates are not complete. The settled default artifact therefore remains `rejected_insufficient_data`, not an accepted model.

## Severity and result meanings

| Level | Meaning |
| --- | --- |
| P0 / blocker | Could permit an invalid V5 model to replace production or corrupt held-out evaluation now. |
| P1 / high | Must be closed before any platform is accepted or any V5 output is displayed as a score. |
| P2 / medium | Required release, reproducibility, or integration hardening; current fail-closed state limits impact. |
| P3 / low | Documentation or clarity defect with no present score mutation. |

`PASS` means the adversarial scenario is rejected, separated, or deterministically handled. `FAIL` means the settled implementation still exhibits the unsafe behavior. `PARTIAL` means the core safety invariant passes but a narrower production claim or integration requirement does not.

## Finding matrix

| ID | Area | Severity | Result | Evidence |
| --- | --- | --- | --- | --- |
| H-01 | Frozen target and split | P0 | **PASS** | `dataset.ts:28-72` hashes the complete split and platform-target table against frozen constants in `protocol.ts`. Independent mutations of X target metric, train cutoff, and grouping flags all threw. |
| H-02 | Exact `t0` and feature-time provenance | P0 | **PASS** | `dataset.ts:219-247` requires canonical instants and an exact per-metric `metricObservedAt` equal to `t0`. Date-only timestamps and a metric observed at `t1` were rejected. |
| H-03 | Missing versus observed zero | P1 | **PASS** | `training.ts:43-54,113-120` adds a missing indicator for every observed metric. The probe produced different raw outputs for absent `likes` and `likes = 0`; inference also reports `missingFeatures` and coverage. |
| H-04 | Duplicate manipulation and order | P0 | **PASS** | `dataset.ts:298-401` quarantines equal-priority `t0`/`t1` conflicts and resolves only by registered temporal/provenance rules. Conflicting outcomes emitted zero rows; reversed row order emitted identical serialized input, rows, and dataset hash. |
| H-05 | Platform-specific feature schema | P1 | **PASS** | `protocol.ts` freezes `V5_PREREG_PLATFORM_METRICS`; `dataset.ts` quarantines platform-incompatible keys and `inference.ts` returns `incompatible_platform_metric`. An X row carrying GitHub `stars` now fails closed in both paths. |
| H-06 | Extreme/OOD input | P1 | **PASS** | `pipeline.ts` derives finite per-feature minimum/maximum/count envelopes from fitting rows only and exports them in model-artifact v2. `inference.ts` requires support for every supplied feature and returns `missing_feature_support` or `out_of_distribution`; an extreme `likes = training maximum + 1` is unscored. |
| H-07 | Future runtime observation | P2 | **PASS** | Accepted inference now requires a canonical `trustedObservationCutoff`, records it in output provenance, and returns `observation_after_trusted_cutoff` when `t0` exceeds it. Missing/invalid authority returns `missing_trusted_observation_cutoff`. |
| H-08 | Experimental versus production semantics | P0 | **PASS** | Default use of an experimental model returns `model_not_accepted`. Explicit research opt-in returns `experimental_unvalidated`, adds an acceptance-failure warning, and omits `calibratedProbability` and `score` (`inference.ts:50-57,209-226`). |
| H-09 | Required target/date/platform behavior | P1 | **PASS** | Unsupported platform, missing target counter, missing/imprecise publication date, future publication relative to `t0`, schema mismatch, malformed evidence provenance, and supplied artifact-hash mismatch are visibly unscored. |
| H-10 | Hidden V5 aggregation constants | P0 | **PASS** | No V5 post-slot, platform-weight, confidence, missing-date, or company-pooling vector exists. `companyAggregation.status` is `unsupported`; V4 values appear only in the explicitly labeled historical V4 interpreter. |
| H-11 | Monotonic constraints | P1 | **PASS** | Numeric metric coefficients are projected nonnegative, age nonpositive, missingness unconstrained, and calibration slope nonnegative (`training.ts:171-181`, `pipeline.ts:312-324`). Existing parity tests confirm increasing a genuine positive metric cannot lower a prediction. |
| H-12 | Registry/source binding | P0 | **PASS** | `registry.ts:13-45` requires `accepted_dataset`, implemented incorporation, citation match, and exact SHA-256, revision, access time, and license identity. Source bytes are rehashed before parsing. |
| H-13 | Selection/calibration/evaluation completeness | P0 | **FAIL for promotion; PASS fail-closed** | One-standard-error selection, calibration-family comparison, weekly macro queries, V4 replay, subgroup/reliability/manipulation and latency gates remain unimplemented. `pipeline.ts:124-142` adds unconditional rejection reasons whenever a platform model exists, so this incompleteness cannot produce `accepted`. |
| H-14 | Arbitrary experimental optimizer constants | P2 | **PARTIAL** | L2 grid values, 1,500/1,200 iterations, and learning-rate schedules are fixed and documented, deterministic, and select fit-driven coefficients; they are not current production weights. They still need convergence checks and held-out comparison before the search can be accepted. |
| H-15 | Determinism and source order | P1 | **PASS** | Every execution runs the full pipeline twice and requires byte identity before validation or publication. Source-registration reversal and final-test-label isolation are covered by the focused suite. |
| H-16 | Production integration and V4 preservation | P0 | **PASS** | No source outside `src/lib/scoring/v5/**` imports or calls `predictV5`. Graph/runtime scoring still uses `TRACTION_SCORING_CONFIG`; the audited V4 scoring files have no tracked diff. Ranked Posts continues to display the canonical V4 evidence score and visible model version. |
| H-17 | Product copy | P1 | **PASS** | The UI says V4 is current and V5 is unpromoted with zero validated coverage. Its OOD statement is now implemented by the training-derived envelope checks in H-06. |
| H-18 | Release artifact identity | P2 | **PASS** | The runner computes `codeRevision = sha256:64a83e80d9e83e6f9bda1a4f2b4789a83e6081e2173875da57382668f889d0e4` over every executable runner module, V5 source file, and V5 test file. Validation recomputes it and rejects mismatched assertions or any stale/corrupt generated byte. |
| H-19 | Runtime provenance | P1 | **PASS** | Before reading inputs or building, the runner inspects and requires exact Node `24.14.0`, active `UTC`, and default `en-US`. Tests verify wrong timezone and Node versions fail closed; the actual asserted values are emitted in the run report. |
| H-20 | Artifact-set publication | P1 | **PASS** | All seven outputs are written and byte-validated in a sibling staging directory, then directory-swapped as one set. An injected swap failure restored the complete previous directory; successful publication exposed exactly the seven expected files. |

## Adversarial scenario results

These probes used the real settled TypeScript modules through the repository loader. Accepted/experimental fixture artifacts were used only to reach inference branches that the rejected default artifact correctly makes unreachable.

| Scenario | Observed result | Verdict |
| --- | --- | --- |
| Same protocol ID, X target changed to likes | `Platform target table does not match the frozen v5 pre-registration.` | **PASS** |
| Frozen train cutoff changed by one day | `Split configuration does not match the frozen v5 pre-registration.` | **PASS** |
| Entity/batch grouping flags changed | `Split configuration does not match the frozen v5 pre-registration.` | **PASS** |
| Date-only `t0`/publication/`t1` labeled exact | Row rejected as `invalid_observation_or_outcome_time`. | **PASS** |
| One metric timestamp set to `t1` | Row rejected as `feature_observed_after_t0:likes`. | **PASS** |
| Same physical post and `t0`, conflicting `t1` values | Both rows quarantined as `conflicting_duplicate_t1_outcome`; zero rows retained. | **PASS** |
| Same physical post and `t0`, conflicting metric values | Both rows quarantine in the focused suite as `conflicting_duplicate_t0_metric:<metric>`. | **PASS** |
| Reversed raw row order | Serialized source bytes, canonical rows, and dataset hash identical. | **PASS** |
| Reversed source-registration order | Model, evaluation, and export bytes identical in focused tests. | **PASS** |
| Final-test labels flipped | Candidate, parameters, calibration, validation metrics, and training threshold unchanged in focused tests. | **PASS** |
| Missing optional `likes` versus observed `likes = 0` | Missingness indicator changed raw output and `missingFeatures`; values are no longer conflated. | **PASS** |
| Missing registered target counter | `unscored / missing_target_counter`. | **PASS** |
| Publication follows `t0` | `unscored / future_publication_date`. | **PASS** |
| Experimental artifact without opt-in | `unscored / model_not_accepted`. | **PASS** |
| Experimental artifact with opt-in | `experimental_unvalidated`; no probability or score fields. | **PASS** |
| X row carrying GitHub `stars` | Dataset row quarantined as `incompatible_platform_metric:stars`; inference returns `incompatible_platform_metric`. | **PASS** |
| Accepted fixture with a metric above its training maximum | `unscored / out_of_distribution`. | **PASS** |
| Allowed metric absent from all fitting rows | `unscored / missing_feature_support`. | **PASS** |
| Accepted fixture with observation in 2099 but trusted cutoff in 2026 | `unscored / observation_after_trusted_cutoff`. | **PASS** |
| Accepted fixture without a trusted cutoff | `unscored / missing_trusted_observation_cutoff`. | **PASS** |

## No hidden V5 production aggregation

The search found no disguised replacement for the prohibited V4 heuristics. V5 does not contain the V4 metric exchange rates, platform shares, engagement references, half-lives, 85/15 or 75/25 blends, missing-date value, 82/8/5/3/2 slots, 82/18 company calibration, or confidence thresholds. The equal-log-sum vector is a transparent baseline only; if it wins validation, the family check rejects promotion. Platform models remain separate, and company aggregation refuses to produce a V5 company score.

The V4 values are intentionally visible in `ScoringMethodology` through `src/lib/scoring/presentation.ts`. That section calls itself a historical-score interpreter and rollback baseline. It does not relabel those values as V5 parameters.

## Production versus experimental labeling

Labeling is now strong enough for the current state:

- The Stats methodology panel says the visible graph score is V4 and the learned scorer has not been promoted.
- The public methodology page says V5 has no validated platform coverage and makes no calibrated-probability claim.
- The default model artifact says `rejected_insufficient_data` and lists every platform as unsupported.
- A research opt-in output cannot be mistaken structurally for a score because it has status `experimental_unvalidated` and contains neither `score` nor `calibratedProbability`.
- Ranked Posts uses the existing canonical evidence score, calls it `Post score`, and displays the graph model version. It does not call the value a V5 forecast.

The OOD sentence is now backed by executable, artifact-bound behavior: a runtime metric must belong to the platform namespace, have fitting-population support, and remain inside its exported training-derived finite envelope. These checks are necessary release defenses, not evidence that any platform model has passed the remaining acceptance gates.

## Verification record

Commands and results from this audit:

| Check | Result |
| --- | --- |
| `npm run scoring:v5:audit` with the bundled primary runtime | **PASS — 6 Node runner/snapshot tests plus 4 Vitest files / 37 tests** |
| `npm run typecheck` | **PASS** |
| Focused V5 ESLint run | **PASS** |
| `npm run scoring:v5:validate` | **PASS — reject, zero supported platforms** |
| Explicit `TZ=UTC` artifact regeneration and validate-only run on the bundled primary runtime | **PASS**, same hashes and computed code revision |
| Internal run 1 versus internal run 2 | **PASS**, no differences |
| Snapshot one-byte mutation test | **PASS**, revision changes |
| Stale pre-regeneration directory under `--validate-only` | **PASS — rejected at `export-manifest.json`** |
| Per-file corruption probes | **PASS — each of all seven generated files rejected** |
| Injected artifact-directory swap failure | **PASS — complete prior set restored** |
| Direct protocol/time/duplicate/missing/extreme/future/experimental probes | Results recorded above |
| V5 production call-site search | **PASS — none found** |
| Tracked V4 scoring-file diff search | **PASS — no diff** |

Current generated byte hashes:

| File | SHA-256 |
| --- | --- |
| `candidate-search.json` | `bd49340a15ffa8da0b637fe6fa8bfe159bcbc4fc816b60ac09f327dd8934925d` |
| `canonical-dataset.json` | `eaf4a00732c3a03325aab1cd29b8d547bfb1fa504fdd1474fa72690bcb163bd8` |
| `evaluation.json` | `89d29dd402a72aae1ca9f19e44b2398c42c379df77b09efd15a423eece42c862` |
| `export-manifest.json` | `95b136a1acc23ecebc548d237667961d95d0607fefd68c2f84d26117bfeb2e1b` |
| `model.json` | `481d9fb9b652b8a564c7c99f0bdd2afe1c3edb4ed899f701184907c15bd23377` |
| `reproducibility.json` | `cce91c4741e32c0b9be25658a2510294aedfbaf93991360cba8cce0de6ccd37b` |
| `split-manifest.json` | `bd05d5253fe39ffc6ce456cf8985453da9b7ccd643706bc6305dd4759407a1a2` |

The generated model uses `scoring-v5-model-artifact-v2` and `scoring-v5-features-v3`. Its export manifest records code revision `sha256:64a83e80d9e83e6f9bda1a4f2b4789a83e6081e2173875da57382668f889d0e4`.

## Required closure before V5 promotion

1. Implement and machine-check every currently unconditional acceptance blocker: weekly macro queries, one-standard-error selection, full calibration-family comparison, V4 and strongest-baseline deltas, subgroup/reliability/known-unseen/manipulation gates, and latency/artifact-size gates.
2. Train only after compatible registered longitudinal data meet every support gate. The current empty artifact is not a model result.
3. Exercise the namespace, OOD, trusted-cutoff, and manipulation policies on registered out-of-time data before accepting any platform.
4. Preserve the completed independent clean-copy reproduction record and rerun it whenever the code revision or settled artifact hashes change.

Final decision: **keep V4 in production; keep V5 rejected/experimental; do not display or aggregate a V5 score.**
