export const V5_PLATFORM_IDS = [
  "x",
  "linkedin",
  "instagram",
  "github",
  "product_hunt",
  "youtube",
  "reddit",
  "hacker_news",
  "bilibili",
  "tiktok",
  "bluesky",
  "rss",
  "web"
] as const;

export type V5Platform = (typeof V5_PLATFORM_IDS)[number];

export const V5_METRIC_FEATURES = [
  "likes",
  "reactions",
  "comments",
  "replies",
  "reposts",
  "shares",
  "quotes",
  "views",
  "impressions",
  "plays",
  "points",
  "saves",
  "upvotes",
  "stars",
  "forks",
  "watchers",
  "issues"
] as const;

export type V5MetricFeature = (typeof V5_METRIC_FEATURES)[number];
export type V5MissingFeatureName = `${V5MetricFeature}_missing`;
export type V5Split = "train" | "validation" | "test";

export function missingFeatureName(metric: V5MetricFeature): V5MissingFeatureName {
  return `${metric}_missing`;
}

export function metricForMissingFeature(feature: string): V5MetricFeature | null {
  if (!feature.endsWith("_missing")) return null;
  const metric = feature.slice(0, -"_missing".length) as V5MetricFeature;
  return V5_METRIC_FEATURES.includes(metric) ? metric : null;
}

export function isMetricFeature(feature: string): feature is V5MetricFeature {
  return V5_METRIC_FEATURES.includes(feature as V5MetricFeature);
}

export interface V5PlatformTargetSpec {
  targetMetric: V5MetricFeature;
  horizonHours: number;
  toleranceHours: number;
  thresholdQuantile: 0.8;
}

export interface V5TargetSpec {
  id: "returner-post-performance-v5-prereg-2026-07-20";
  description: string;
  thresholdDefinition: string;
  platformTargets: Partial<Record<V5Platform, V5PlatformTargetSpec>>;
  outcome: "binary_high_performance_at_horizon";
  observationRule: "features_at_or_before_observation_time";
}

export interface V5SplitSpec {
  trainStart: string;
  trainEnd: string;
  validationEnd: string;
  testEnd: string;
  groupByEntity: boolean;
  groupByBatch: boolean;
}

export interface V5RegisteredSource {
  id: string;
  relativePath: string;
  sha256: string;
  schemaVersion: "scoring-v5-observations-v2";
  citation: string;
  sourceRevision: string;
  accessedAt: string;
  license: {
    id: string;
    permitsResearchUse: boolean;
    redistribution: "allowed" | "restricted" | "unknown";
  };
  status: "accepted" | "rejected";
  rejectionReason: string | null;
}

export interface V5InputManifest {
  schemaVersion: "scoring-v5-input-manifest-v1";
  registeredAt: string;
  target: V5TargetSpec;
  split: V5SplitSpec;
  sources: V5RegisteredSource[];
}

export interface V5ResearchRegistry {
  schema_version: string;
  sources: Array<{
    id: string;
    citation: string;
    decision: { status: string; reason: string };
    incorporation: {
      state: string;
      exact_use: string;
      implementation_evidence: string[];
    };
    training_artifact?: {
      sha256: string;
      source_revision: string;
      accessed_at: string;
      license: V5RegisteredSource["license"];
    };
  }>;
}

export interface V5RawObservation {
  sourceRowId: string;
  canonicalPostId: string;
  contentFingerprint: string | null;
  platform: string;
  entityId: string;
  batchId?: string | null;
  observationAt: string;
  publishedAt: string | null;
  publishedAtPrecision: "exact" | "day" | "unknown";
  outcomeObservedAt: string;
  collectorWaveId: string;
  metrics: Partial<Record<V5MetricFeature, number | null>>;
  metricObservedAt: Partial<Record<V5MetricFeature, string | null>>;
  targetMetric: V5MetricFeature;
  targetValueAtObservation: number;
  targetValueAtOutcome: number;
}

export interface V5CanonicalObservation {
  rowId: string;
  sourceId: string;
  sourceRevision: string;
  sourceArtifactSha256: string;
  sourceRowId: string;
  canonicalPostId: string;
  contentFingerprint: string | null;
  platform: V5Platform;
  entityId: string;
  batchId: string | null;
  observationAt: string;
  publishedAt: string;
  publishedAtPrecision: "exact";
  outcomeObservedAt: string;
  collectorWaveId: string;
  horizonHours: number;
  toleranceHours: number;
  postAgeHours: number;
  metrics: Partial<Record<V5MetricFeature, number>>;
  metricObservedAt: Partial<Record<V5MetricFeature, string>>;
  targetMetric: V5MetricFeature;
  targetValueAtObservation: number;
  targetValueAtOutcome: number;
  growth: number;
}

export interface V5LabeledObservation extends V5CanonicalObservation {
  highPerformanceOutcome: 0 | 1;
}

export interface V5RejectedRow {
  sourceId: string;
  sourceRowId: string;
  reason: string;
}

export interface V5DatasetBuild {
  rows: V5CanonicalObservation[];
  rejectedRows: V5RejectedRow[];
  datasetHash: string;
  sourceHashes: Record<string, string>;
}

export interface V5SplitAssignment {
  rowId: string;
  canonicalPostId: string;
  contentFingerprint: string | null;
  entityId: string;
  batchId: string | null;
  platform: V5Platform;
  split: V5Split;
  unseenEntityHoldout: boolean;
}

export interface V5SplitBuild {
  assignments: V5SplitAssignment[];
  rows: Record<V5Split, V5CanonicalObservation[]>;
  exclusions: Array<{ entityId: string; reason: string }>;
  unseenEntityHoldoutIds: string[];
  splitHash: string;
}

export type V5FeatureName = V5MetricFeature | V5MissingFeatureName | "post_age_hours";
export type V5EnvelopeFeature = V5MetricFeature | "post_age_hours";

export interface V5FeatureEnvelope {
  minimum: number;
  maximum: number;
  observations: number;
  fittedOn: "training";
}

export interface V5ModelParameters {
  intercept: number;
  coefficients: Partial<Record<V5FeatureName, number>>;
}

export interface V5CalibrationParameters {
  method: "platt_nonnegative_slope";
  intercept: number;
  slope: number;
  fittedOn: "validation";
}

export interface V5CandidateResult {
  id: string;
  family: "baseline" | "nonnegative_logistic";
  lambda: number | null;
  includeAge: boolean;
  features: V5FeatureName[];
  parameters: V5ModelParameters;
  calibration: V5CalibrationParameters;
  validation: V5EvaluationMetrics;
  complexity: number;
}

export interface V5EvaluationMetrics {
  rows: number;
  positives: number;
  ndcgAt10: number;
  ndcgAt50: number;
  pairwiseAccuracy: number;
  brier: number;
  logLoss: number;
  expectedCalibrationError: number;
}

export interface V5PlatformModel {
  platform: V5Platform;
  candidateId: string;
  family: "baseline" | "nonnegative_logistic";
  featureNames: V5FeatureName[];
  featureEnvelopes: Partial<Record<V5EnvelopeFeature, V5FeatureEnvelope>>;
  parameters: V5ModelParameters;
  calibration: V5CalibrationParameters;
  validation: V5EvaluationMetrics;
  test: V5EvaluationMetrics;
  baselineTest: V5EvaluationMetrics;
  unseenCompanyTest: V5EvaluationMetrics;
  pairedBootstrap: {
    seed: number;
    replicates: number;
    ndcgAt50Delta: number;
    confidenceInterval95: [number, number];
  };
}

export interface V5ModelArtifact {
  schemaVersion: "scoring-v5-model-artifact-v2";
  modelId: "traction-post-forecast-v5";
  version: string;
  displayName: string;
  status: "accepted" | "experimental" | "rejected_insufficient_data";
  target: V5TargetSpec;
  trainingPlatformGrowthThresholds: Partial<Record<V5Platform, number>>;
  featureSchemaVersion: "scoring-v5-features-v3";
  platformModels: Partial<Record<V5Platform, V5PlatformModel>>;
  supportedPlatforms: V5Platform[];
  unsupportedPlatforms: V5Platform[];
  trainingDataHash: string;
  splitHash: string;
  trainingManifestHash: string;
  trainedAt: string;
  selectionProtocol: string;
  uncertainty: {
    method: "fixed_seed_paired_bootstrap_evaluation_only";
    perPredictionIntervals: false;
  };
  companyAggregation: {
    status: "unsupported";
    reason: string;
  };
  limitations: string[];
}

export interface V5EvaluationArtifact {
  schemaVersion: "scoring-v5-evaluation-v1";
  status: V5ModelArtifact["status"];
  gateDecision: "accept" | "reject";
  gateReasons: string[];
  platformResults: Partial<Record<V5Platform, V5PlatformModel["test"]>>;
  testWasUsedForSelection: false;
  bootstrapSeed: number;
  bootstrapReplicates: number;
}

export interface V5CandidateSearchArtifact {
  schemaVersion: "scoring-v5-candidate-search-v1";
  selectionRule: string;
  frozenGrid: Array<{
    id: string;
    family: "baseline" | "nonnegative_logistic";
    lambda: number | null;
    includeAge: boolean;
  }>;
  platforms: Partial<
    Record<
      V5Platform,
      {
        selectedCandidateId: string;
        candidates: V5CandidateResult[];
      }
    >
  >;
  containsTestMetrics: false;
}

export interface V5ExportManifest {
  schemaVersion: "scoring-v5-export-manifest-v1";
  modelId: V5ModelArtifact["modelId"];
  modelVersion: string;
  modelArtifactHash: string;
  evaluationArtifactHash: string;
  candidateSearchArtifactHash: string;
  inputManifestHash: string;
  researchRegistryHash: string;
  incorporatedResearchSources: Array<{
    id: string;
    decision: string;
    exactUse: string;
    implementationEvidence: string[];
  }>;
  trainingDataHash: string;
  splitHash: string;
  sourceHashes: Record<string, string>;
  codeRevision: string;
  dependencyLockHash: string;
  environment: {
    nodeVersion: "24.14.0";
    timezone: "UTC";
    locale: "en-US";
    seed: number;
    networkRequiredAfterRegistration: false;
  };
  licensingSummary: string;
}

export interface V5PipelineArtifacts {
  dataset: V5DatasetBuild;
  split: V5SplitBuild;
  model: V5ModelArtifact;
  evaluation: V5EvaluationArtifact;
  candidateSearch: V5CandidateSearchArtifact;
  manifest: V5ExportManifest;
  serialized: {
    dataset: string;
    split: string;
    model: string;
    evaluation: string;
    candidateSearch: string;
    manifest: string;
  };
}

export interface V5InferenceInput {
  featureSchemaVersion: V5ModelArtifact["featureSchemaVersion"];
  canonicalPostId: string;
  platform: string;
  observationAt: string;
  publishedAt: string | null;
  publishedAtPrecision: "exact" | "day" | "unknown";
  metrics: Partial<Record<V5MetricFeature, number | null>>;
  metricObservedAt: Partial<Record<V5MetricFeature, string | null>>;
  evidenceSourceId: string;
  evidenceArtifactSha256: string;
}

export interface V5PredictionProvenance {
  modelId: V5ModelArtifact["modelId"];
  modelVersion: string;
  modelArtifactHash: string;
  targetSpecId: V5TargetSpec["id"];
  canonicalPostId: string;
  platform: V5Platform;
  observationAt: string;
  asOf: string;
  trustedObservationCutoff: string;
  publishedAt: string;
  publishedAtPrecision: "exact";
  predictionHorizonHours: number;
  highPerformanceGrowthThreshold: number;
  rawModelOutput: number;
  uncertaintyInterval: null;
  featureSchemaVersion: V5ModelArtifact["featureSchemaVersion"];
  trainingDataManifestHash: string;
  trainingDataHash: string;
  splitHash: string;
  missingFeatures: V5MetricFeature[];
  evidence: {
    sourceId: string;
    artifactSha256: string;
    observedModelMetrics: number;
    totalModelMetrics: number;
    coverageRatio: number;
  };
  explanation: {
    method: "linear_logit_contributions";
    contributions: Array<{ feature: V5FeatureName; value: number; contribution: number }>;
    intercept: number;
  };
  limitations: string[];
}

export interface V5ScoredPrediction extends V5PredictionProvenance {
  status: "scored";
  calibratedProbability: number;
  score: number;
}

export interface V5ExperimentalPrediction extends V5PredictionProvenance {
  status: "experimental_unvalidated";
  validationState: "acceptance_gate_failed";
}

export interface V5UnscoredPrediction {
  status: "unscored";
  platform: string;
  reason:
    | "unsupported_platform"
    | "model_not_accepted"
    | "missing_canonical_post_id"
    | "invalid_evidence_provenance"
    | "model_artifact_hash_mismatch"
    | "feature_schema_mismatch"
    | "incompatible_platform_metric"
    | "missing_feature_support"
    | "out_of_distribution"
    | "missing_trusted_observation_cutoff"
    | "observation_after_trusted_cutoff"
    | "missing_publication_date"
    | "imprecise_publication_date"
    | "missing_target_counter"
    | "invalid_metric_value"
    | "invalid_metric_observation_time"
    | "invalid_observation_time"
    | "future_publication_date";
  limitations: string[];
}

export type V5Prediction = V5ScoredPrediction | V5ExperimentalPrediction | V5UnscoredPrediction;
