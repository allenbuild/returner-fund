import { buildCanonicalDataset } from "./dataset";
import { canonicalJson, sha256Text, stableHash } from "./determinism";
import { evaluatePredictions, pairedBootstrapNdcgDelta } from "./evaluation";
import { labelFromTrainingOnly } from "./labeling";
import { validateTrainingSourcesAgainstRegistry } from "./registry";
import { buildLeakageSafeSplits } from "./splits";
import { predictRows, trainAndSelectCandidate, V5_FROZEN_CANDIDATE_GRID } from "./training";
import {
  V5_PLATFORM_IDS,
  V5_METRIC_FEATURES,
  isMetricFeature,
  metricForMissingFeature,
  type V5EnvelopeFeature,
  type V5FeatureEnvelope,
  type V5EvaluationArtifact,
  type V5CandidateSearchArtifact,
  type V5ExportManifest,
  type V5InputManifest,
  type V5ModelArtifact,
  type V5PipelineArtifacts,
  type V5Platform,
  type V5PlatformModel,
  type V5ResearchRegistry
} from "./types";

export const V5_BOOTSTRAP_SEED = 20_260_720;
export const V5_BOOTSTRAP_REPLICATES = 10_000;
export const V5_MAXIMUM_ACCEPTANCE_ECE = 0.05;

export interface RunV5PipelineOptions {
  inputManifest: V5InputManifest;
  registeredFiles: Readonly<Record<string, string>>;
  modelVersion: string;
  codeRevision: string;
  dependencyLockHash: string;
  researchRegistry: V5ResearchRegistry;
}

export function runV5Pipeline(options: RunV5PipelineOptions): V5PipelineArtifacts {
  validateRunMetadata(options);
  validateTrainingSourcesAgainstRegistry(options.inputManifest, options.researchRegistry);
  const inputManifestHash = stableHash({
    ...options.inputManifest,
    sources: [...options.inputManifest.sources].sort((left, right) => left.id.localeCompare(right.id, "en"))
  });
  const researchRegistryHash = stableHash(options.researchRegistry);
  const dataset = buildCanonicalDataset(options.inputManifest, options.registeredFiles);
  const split = buildLeakageSafeSplits(dataset.rows, options.inputManifest.split);
  const labeled = labelFromTrainingOnly(split, options.inputManifest.target);
  const unseenEntityHoldout = new Set(split.unseenEntityHoldoutIds);
  const platformModels: Partial<Record<V5Platform, V5PlatformModel>> = {};
  const platformCandidateSearch: V5CandidateSearchArtifact["platforms"] = {};
  const platformGateReasons: string[] = [];

  for (const platform of V5_PLATFORM_IDS) {
    const trainingRows = labeled.rows.train.filter(
      (row) => row.platform === platform && !unseenEntityHoldout.has(row.entityId)
    );
    const validationRows = labeled.rows.validation.filter(
      (row) => row.platform === platform && !unseenEntityHoldout.has(row.entityId)
    );
    const testRows = labeled.rows.test.filter(
      (row) => row.platform === platform && !unseenEntityHoldout.has(row.entityId)
    );
    const unseenCompanyTestRows = labeled.rows.test.filter(
      (row) => row.platform === platform && unseenEntityHoldout.has(row.entityId)
    );
    const selection = trainAndSelectCandidate(trainingRows, validationRows);
    if (!selection) continue;
    platformCandidateSearch[platform] = {
      selectedCandidateId: selection.selected.id,
      candidates: selection.candidates
    };
    if (!hasBothClasses(testRows)) {
      platformGateReasons.push(`${platform}: final test does not contain both outcome classes.`);
      continue;
    }

    // Selection and calibration are frozen before this point. Test labels enter
    // only the following evaluation calls and cannot alter parameters.
    const selectedTestPredictions = predictRows(
      testRows,
      selection.selected.parameters,
      selection.selected.calibration
    );
    const baselineTestPredictions = predictRows(
      testRows,
      selection.baseline.parameters,
      selection.baseline.calibration
    );
    const pairedBootstrap = pairedBootstrapNdcgDelta(
      selectedTestPredictions,
      baselineTestPredictions,
      V5_BOOTSTRAP_SEED,
      V5_BOOTSTRAP_REPLICATES
    );
    const platformModel: V5PlatformModel = {
      platform,
      candidateId: selection.selected.id,
      family: selection.selected.family,
      featureNames: selection.selected.features,
      featureEnvelopes: trainingFeatureEnvelopes(trainingRows, selection.selected.features),
      parameters: selection.selected.parameters,
      calibration: selection.selected.calibration,
      validation: selection.selected.validation,
      test: evaluatePredictions(selectedTestPredictions),
      baselineTest: evaluatePredictions(baselineTestPredictions),
      unseenCompanyTest: evaluatePredictions(
        predictRows(
          unseenCompanyTestRows,
          selection.selected.parameters,
          selection.selected.calibration
        )
      ),
      pairedBootstrap: {
        seed: V5_BOOTSTRAP_SEED,
        replicates: V5_BOOTSTRAP_REPLICATES,
        ndcgAt50Delta: pairedBootstrap.delta,
        confidenceInterval95: pairedBootstrap.confidenceInterval95
      }
    };
    assertMonotonicParameters(platformModel);
    platformModels[platform] = platformModel;
    platformGateReasons.push(
      ...acceptanceFailures(platformModel, trainingRows, validationRows, testRows, unseenCompanyTestRows)
    );
  }

  const supportedPlatforms = V5_PLATFORM_IDS.filter((platform) => platformModels[platform] !== undefined);
  const unsupportedPlatforms = V5_PLATFORM_IDS.filter((platform) => platformModels[platform] === undefined);
  const gateReasons = [...new Set(platformGateReasons)].sort((left, right) => left.localeCompare(right, "en"));
  if (supportedPlatforms.length === 0) {
    gateReasons.unshift("No platform has compatible rows with both outcome classes in every frozen split.");
  } else {
    gateReasons.push(
      "V4 replay comparison is not registered in this input manifest; production acceptance is prohibited.",
      "The frozen one-standard-error candidate rule and full calibration-family comparison remain unimplemented.",
      "Pre-registered weekly-query macro metrics, subgroup gates, reliability-gap checks, and release latency gates remain unimplemented."
    );
    gateReasons.sort((left, right) => left.localeCompare(right, "en"));
  }
  const status: V5ModelArtifact["status"] =
    supportedPlatforms.length === 0
      ? "rejected_insufficient_data"
      : gateReasons.length === 0
        ? "accepted"
        : "experimental";
  const model: V5ModelArtifact = {
    schemaVersion: "scoring-v5-model-artifact-v2",
    modelId: "traction-post-forecast-v5",
    version: options.modelVersion,
    displayName: "V5 future high-performance forecast",
    status,
    target: options.inputManifest.target,
    trainingPlatformGrowthThresholds: labeled.trainingPlatformGrowthThresholds,
    featureSchemaVersion: "scoring-v5-features-v3",
    platformModels,
    supportedPlatforms,
    unsupportedPlatforms,
    trainingDataHash: dataset.datasetHash,
    splitHash: split.splitHash,
    trainingManifestHash: inputManifestHash,
    trainedAt: options.inputManifest.registeredAt,
    selectionProtocol:
      "Frozen finite grid; validation NDCG@50 descending, validation log loss ascending, complexity ascending, stable candidate id; Platt calibration on validation only; final test opened after selection. The pre-registered one-standard-error refinement is not implemented, so acceptance is blocked.",
    uncertainty: {
      method: "fixed_seed_paired_bootstrap_evaluation_only",
      perPredictionIntervals: false
    },
    companyAggregation: {
      status: "unsupported",
      reason:
        "No registered entity-level future-outcome target is present. Post probabilities are not manually pooled into a company score."
    },
    limitations: limitationsFor(status, unsupportedPlatforms)
  };
  const evaluation: V5EvaluationArtifact = {
    schemaVersion: "scoring-v5-evaluation-v1",
    status,
    gateDecision: status === "accepted" ? "accept" : "reject",
    gateReasons,
    platformResults: Object.fromEntries(
      supportedPlatforms.map((platform) => [platform, platformModels[platform]?.test])
    ),
    testWasUsedForSelection: false,
    bootstrapSeed: V5_BOOTSTRAP_SEED,
    bootstrapReplicates: V5_BOOTSTRAP_REPLICATES
  };
  const candidateSearch: V5CandidateSearchArtifact = {
    schemaVersion: "scoring-v5-candidate-search-v1",
    selectionRule:
      "Validation NDCG@50 descending, validation log loss ascending, complexity ascending, stable candidate id. One-standard-error refinement is pending and blocks acceptance.",
    frozenGrid: V5_FROZEN_CANDIDATE_GRID.map((candidate) => ({ ...candidate })),
    platforms: platformCandidateSearch,
    containsTestMetrics: false
  };
  const serializedDataset = canonicalJson(dataset);
  const serializedSplit = canonicalJson(splitForExport(split));
  const serializedModel = canonicalJson(model);
  const serializedEvaluation = canonicalJson(evaluation);
  const serializedCandidateSearch = canonicalJson(candidateSearch);
  const manifest: V5ExportManifest = {
    schemaVersion: "scoring-v5-export-manifest-v1",
    modelId: model.modelId,
    modelVersion: model.version,
    modelArtifactHash: sha256Text(serializedModel),
    evaluationArtifactHash: sha256Text(serializedEvaluation),
    candidateSearchArtifactHash: sha256Text(serializedCandidateSearch),
    inputManifestHash,
    researchRegistryHash,
    incorporatedResearchSources: incorporatedResearchSources(
      options.inputManifest,
      options.researchRegistry
    ),
    trainingDataHash: dataset.datasetHash,
    splitHash: split.splitHash,
    sourceHashes: dataset.sourceHashes,
    codeRevision: options.codeRevision,
    dependencyLockHash: options.dependencyLockHash,
    environment: {
      nodeVersion: "24.14.0",
      timezone: "UTC",
      locale: "en-US",
      seed: V5_BOOTSTRAP_SEED,
      networkRequiredAfterRegistration: false
    },
    licensingSummary: licensingSummary(options.inputManifest)
  };
  const serializedManifest = canonicalJson(manifest);

  return {
    dataset,
    split,
    model,
    evaluation,
    candidateSearch,
    manifest,
    serialized: {
      dataset: serializedDataset,
      split: serializedSplit,
      model: serializedModel,
      evaluation: serializedEvaluation,
      candidateSearch: serializedCandidateSearch,
      manifest: serializedManifest
    }
  };
}

export function byteIdentityReport(
  first: V5PipelineArtifacts,
  second: V5PipelineArtifacts
): { identical: boolean; mismatches: string[]; hashes: Record<string, string> } {
  const keys = ["dataset", "split", "model", "evaluation", "candidateSearch", "manifest"] as const;
  const mismatches = keys.filter((key) => first.serialized[key] !== second.serialized[key]);
  return {
    identical: mismatches.length === 0,
    mismatches,
    hashes: Object.fromEntries(keys.map((key) => [key, sha256Text(first.serialized[key])]))
  };
}

function acceptanceFailures(
  model: V5PlatformModel,
  trainingRows: readonly { entityId: string; collectorWaveId: string; highPerformanceOutcome: 0 | 1 }[],
  validationRows: readonly { entityId: string; collectorWaveId: string; highPerformanceOutcome: 0 | 1 }[],
  testRows: readonly { entityId: string; collectorWaveId: string; highPerformanceOutcome: 0 | 1 }[],
  unseenCompanyTestRows: readonly { entityId: string; collectorWaveId: string; highPerformanceOutcome: 0 | 1 }[]
): string[] {
  const prefix = `${model.platform}:`;
  const reasons: string[] = [];
  reasons.push(...supportFailures(prefix, "training", trainingRows, 2_000, 100, 200));
  reasons.push(...supportFailures(prefix, "validation", validationRows, 500, 50, 50));
  reasons.push(...supportFailures(prefix, "final test", testRows, 500, 50, 50));
  reasons.push(...supportFailures(prefix, "unseen-company final test", unseenCompanyTestRows, 200, 20, 20));
  if (model.family !== "nonnegative_logistic") {
    reasons.push(`${prefix} validation selection did not beat the transparent baseline.`);
  }
  if (
    model.pairedBootstrap.ndcgAt50Delta < 0.02 ||
    model.pairedBootstrap.confidenceInterval95[0] <= 0
  ) {
    reasons.push(`${prefix} paired bootstrap NDCG@50 improvement does not clear +0.02 with a positive lower bound.`);
  }
  if (model.test.expectedCalibrationError > V5_MAXIMUM_ACCEPTANCE_ECE) {
    reasons.push(`${prefix} held-out calibration exceeds the pre-registered ECE ceiling.`);
  }
  return reasons;
}

function supportFailures(
  prefix: string,
  partition: string,
  rows: readonly { entityId: string; collectorWaveId: string; highPerformanceOutcome: 0 | 1 }[],
  minimumRows: number,
  minimumEntities: number,
  minimumPositives: number
): string[] {
  const reasons: string[] = [];
  const entities = new Set(rows.map((row) => row.entityId));
  const waves = new Set(rows.map((row) => row.collectorWaveId));
  const positives = rows.filter((row) => row.highPerformanceOutcome === 1).length;
  const largestEntityShare = Math.max(
    0,
    ...[...entities].map(
      (entityId) => rows.filter((row) => row.entityId === entityId).length / Math.max(rows.length, 1)
    )
  );
  if (rows.length < minimumRows || entities.size < minimumEntities || positives < minimumPositives) {
    reasons.push(
      `${prefix} ${partition} misses support (${rows.length}/${minimumRows} rows, ${entities.size}/${minimumEntities} entities, ${positives}/${minimumPositives} positives).`
    );
  }
  if (waves.size < 3) reasons.push(`${prefix} ${partition} has fewer than three collector waves.`);
  if (largestEntityShare > 0.1) reasons.push(`${prefix} ${partition} has one entity above 10% of rows.`);
  return reasons;
}

function assertMonotonicParameters(model: V5PlatformModel): void {
  for (const [feature, coefficient] of Object.entries(model.parameters.coefficients)) {
    if (feature === "post_age_hours" && (coefficient ?? 0) > 0) {
      throw new Error(`${model.platform} age coefficient violates the non-increasing constraint.`);
    }
    if (feature !== "post_age_hours" && !metricForMissingFeature(feature) && (coefficient ?? 0) < 0) {
      throw new Error(`${model.platform} metric coefficient violates the nonnegative constraint.`);
    }
  }
  if (model.calibration.slope < 0) {
    throw new Error(`${model.platform} calibration violates the nonnegative slope constraint.`);
  }
}

function trainingFeatureEnvelopes(
  rows: readonly { metrics: Partial<Record<(typeof V5_METRIC_FEATURES)[number], number>>; postAgeHours: number }[],
  selectedFeatures: readonly string[]
): Partial<Record<V5EnvelopeFeature, V5FeatureEnvelope>> {
  const envelopeFeatures: V5EnvelopeFeature[] = V5_METRIC_FEATURES.filter((metric) =>
    rows.some((row) => row.metrics[metric] !== undefined)
  );
  if (selectedFeatures.includes("post_age_hours")) envelopeFeatures.push("post_age_hours");
  return Object.fromEntries(
    envelopeFeatures
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((feature) => {
        const values = rows
          .map((row) => (isMetricFeature(feature) ? row.metrics[feature] : row.postAgeHours))
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        if (values.length === 0) {
          throw new Error(`Cannot export a feature envelope without training support: ${feature}`);
        }
        return [
          feature,
          {
            minimum: Math.min(...values),
            maximum: Math.max(...values),
            observations: values.length,
            fittedOn: "training" as const
          }
        ];
      })
  );
}

function hasBothClasses(rows: readonly { highPerformanceOutcome: 0 | 1 }[]): boolean {
  return rows.some((row) => row.highPerformanceOutcome === 0) && rows.some((row) => row.highPerformanceOutcome === 1);
}

function limitationsFor(
  status: V5ModelArtifact["status"],
  unsupportedPlatforms: readonly V5Platform[]
): string[] {
  const limitations = [
    "Predictive associations are not causal estimates of company quality or investment outcomes.",
    "Per-prediction uncertainty intervals are unsupported; bootstrap intervals cover held-out aggregate performance only.",
    "Company aggregation remains unsupported until an entity-level future-outcome dataset is registered."
  ];
  if (status !== "accepted") {
    limitations.unshift("The acceptance gate did not pass; this artifact must not replace the v4 production baseline.");
  }
  if (unsupportedPlatforms.length > 0) {
    limitations.push(`Unscored platforms: ${unsupportedPlatforms.join(", ")}.`);
  }
  return limitations;
}

function licensingSummary(manifest: V5InputManifest): string {
  const accepted = manifest.sources.filter((source) => source.status === "accepted");
  if (accepted.length === 0) return "No external or internal training source was accepted in this run.";
  return accepted
    .map((source) => `${source.id}: ${source.license.id} (${source.license.redistribution})`)
    .sort((left, right) => left.localeCompare(right, "en"))
    .join("; ");
}

function incorporatedResearchSources(
  manifest: V5InputManifest,
  registry: V5ResearchRegistry
): V5ExportManifest["incorporatedResearchSources"] {
  const acceptedIds = new Set(
    manifest.sources.filter((source) => source.status === "accepted").map((source) => source.id)
  );
  return registry.sources
    .filter((source) => acceptedIds.has(source.id))
    .map((source) => ({
      id: source.id,
      decision: source.decision.status,
      exactUse: source.incorporation.exact_use,
      implementationEvidence: [...source.incorporation.implementation_evidence].sort((left, right) =>
        left.localeCompare(right, "en")
      )
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function splitForExport(split: ReturnType<typeof buildLeakageSafeSplits>): object {
  return {
    assignments: split.assignments,
    exclusions: split.exclusions,
    unseenEntityHoldoutIds: split.unseenEntityHoldoutIds,
    splitHash: split.splitHash
  };
}

function validateRunMetadata(options: RunV5PipelineOptions): void {
  if (!/^5\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(options.modelVersion)) {
    throw new Error("V5 model version must be an immutable semantic version beginning with 5.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(options.codeRevision)) {
    throw new Error("A deterministic SHA-256 code snapshot revision is required.");
  }
  if (!/^[a-f0-9]{64}$/.test(options.dependencyLockHash)) {
    throw new Error("A SHA-256 dependency lock hash is required.");
  }
}
