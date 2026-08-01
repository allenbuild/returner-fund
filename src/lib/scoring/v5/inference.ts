import { stableHash } from "./determinism";
import { rounded } from "./math";
import { isMetricAllowedForPlatform } from "./protocol";
import { applyCalibration, rawLinearOutput, transformedFeatureValue } from "./training";
import {
  V5_PLATFORM_IDS,
  isMetricFeature,
  type V5CanonicalObservation,
  type V5FeatureName,
  type V5InferenceInput,
  type V5MetricFeature,
  type V5ModelArtifact,
  type V5Platform,
  type V5Prediction,
  type V5PredictionProvenance
} from "./types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface V5InferenceOptions {
  allowExperimental?: boolean;
  modelArtifactHash?: string;
  trustedObservationCutoff?: string;
}

export function predictV5(
  artifact: V5ModelArtifact,
  input: V5InferenceInput,
  options: V5InferenceOptions = {}
): V5Prediction {
  if (!V5_PLATFORM_IDS.includes(input.platform as V5Platform)) {
    return unscored(input.platform, "unsupported_platform", "No v5 schema exists for this platform.");
  }
  const platform = input.platform as V5Platform;
  const canonicalPostId = typeof input.canonicalPostId === "string" ? input.canonicalPostId.trim() : "";
  if (!canonicalPostId) {
    return unscored(platform, "missing_canonical_post_id", "A canonical physical-object id is required.");
  }
  const model = artifact.platformModels[platform];
  const platformTarget = artifact.target.platformTargets[platform];
  const growthThreshold = artifact.trainingPlatformGrowthThresholds[platform];
  if (!model || !platformTarget || growthThreshold === undefined) {
    return unscored(platform, "unsupported_platform", "No compatible held-out training data supports this platform.");
  }
  if (model.featureNames.includes("post_age_hours")) {
    return unscored(
      platform,
      "feature_schema_mismatch",
      "Publication age is not an allowed scoring feature."
    );
  }
  if (input.featureSchemaVersion !== artifact.featureSchemaVersion) {
    return unscored(
      platform,
      "feature_schema_mismatch",
      `Inference schema ${input.featureSchemaVersion || "<missing>"} does not match ${artifact.featureSchemaVersion}.`
    );
  }
  const experimental = artifact.status === "experimental";
  if (artifact.status !== "accepted" && (!experimental || !options.allowExperimental)) {
    return unscored(
      platform,
      "model_not_accepted",
      "The v5 acceptance gate did not pass; research use requires an explicit experimental opt-in."
    );
  }

  const modelArtifactHash = stableHash(artifact);
  if (options.modelArtifactHash && options.modelArtifactHash !== modelArtifactHash) {
    return unscored(
      platform,
      "model_artifact_hash_mismatch",
      "The supplied model artifact hash does not match the canonical artifact bytes."
    );
  }
  const evidenceSourceId = typeof input.evidenceSourceId === "string" ? input.evidenceSourceId.trim() : "";
  if (
    !evidenceSourceId ||
    typeof input.evidenceArtifactSha256 !== "string" ||
    !SHA256_PATTERN.test(input.evidenceArtifactSha256)
  ) {
    return unscored(
      platform,
      "invalid_evidence_provenance",
      "A stable evidence source id and lowercase SHA-256 artifact hash are required."
    );
  }
  const trustedCutoffMs = parseCanonicalDate(options.trustedObservationCutoff);
  if (trustedCutoffMs === null) {
    return unscored(
      platform,
      "missing_trusted_observation_cutoff",
      "A trusted canonical observation cutoff is required for runtime inference."
    );
  }
  const observationMs = parseCanonicalDate(input.observationAt);
  if (observationMs === null) {
    return unscored(
      platform,
      "invalid_observation_time",
      "Observation time must be a canonical ISO instant with millisecond precision."
    );
  }
  if (observationMs > trustedCutoffMs) {
    return unscored(
      platform,
      "observation_after_trusted_cutoff",
      "Observation time cannot follow the trusted runtime evidence cutoff."
    );
  }
  if (input.publishedAt === null) {
    return unscored(
      platform,
      "missing_publication_date",
      "No date-missing model was trained; v5 does not guess a momentum prior."
    );
  }
  if (input.publishedAtPrecision !== "exact") {
    return unscored(
      platform,
      "imprecise_publication_date",
      "The primary age-aware v5 model requires an exact native publication timestamp."
    );
  }
  const publishedMs = parseCanonicalDate(input.publishedAt);
  if (publishedMs === null) {
    return unscored(
      platform,
      "missing_publication_date",
      "Publication time must be a canonical ISO instant with millisecond precision."
    );
  }
  if (publishedMs > observationMs) {
    return unscored(platform, "future_publication_date", "Publication time cannot follow observation time.");
  }

  if (!input.metrics || typeof input.metrics !== "object" || !input.metricObservedAt || typeof input.metricObservedAt !== "object") {
    return unscored(
      platform,
      "invalid_metric_observation_time",
      "Metrics and their canonical observation-time map are required."
    );
  }
  const metrics: Partial<Record<V5MetricFeature, number>> = {};
  for (const metric of Object.keys(input.metrics).sort((left, right) => left.localeCompare(right, "en"))) {
    if (!isMetricFeature(metric) || !isMetricAllowedForPlatform(platform, metric)) {
      return unscored(
        platform,
        "incompatible_platform_metric",
        `Metric ${metric} is not admitted by the frozen ${platform} feature namespace.`
      );
    }
    const metricName = metric;
    const value = input.metrics[metricName];
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      return unscored(platform, "invalid_metric_value", `Metric ${metricName} must be finite and nonnegative.`);
    }
    const metricTimeMs = parseCanonicalDate(input.metricObservedAt[metricName]);
    if (metricTimeMs === null || metricTimeMs !== observationMs) {
      return unscored(
        platform,
        "invalid_metric_observation_time",
        `Metric ${metricName} must carry the same canonical observation instant as the prediction as-of time.`
      );
    }
    metrics[metricName] = value;
  }

  const targetCounterValue = metrics[platformTarget.targetMetric];
  if (targetCounterValue === undefined) {
    return unscored(
      platform,
      "missing_target_counter",
      `The registered t0 target counter (${platformTarget.targetMetric}) is required for this platform.`
    );
  }
  const featureEnvelopes = model.featureEnvelopes ?? {};
  for (const [metric, value] of Object.entries(metrics).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const envelope = featureEnvelopes[metric as V5MetricFeature];
    const supportFailure = envelopeFailure(metric, value, envelope);
    if (supportFailure) return unscored(platform, supportFailure.reason, supportFailure.limitation);
  }
  const postAgeHours = (observationMs - publishedMs) / 3_600_000;
  if (model.featureNames.includes("post_age_hours")) {
    const supportFailure = envelopeFailure("post_age_hours", postAgeHours, featureEnvelopes.post_age_hours);
    if (supportFailure) return unscored(platform, supportFailure.reason, supportFailure.limitation);
  }
  const row: Pick<V5CanonicalObservation, "metrics" | "postAgeHours"> = {
    metrics,
    postAgeHours
  };
  const rawModelOutput = rawLinearOutput(model.parameters, row);
  const contributions = model.featureNames
    .map((feature) => ({
      feature,
      value: rounded(transformedFeatureValue(row, feature)),
      contribution: rounded(
        transformedFeatureValue(row, feature) * (model.parameters.coefficients[feature] ?? 0)
      )
    }))
    .sort(
      (left, right) =>
        Math.abs(right.contribution) - Math.abs(left.contribution) ||
        (left.feature as V5FeatureName).localeCompare(right.feature as V5FeatureName, "en")
    );
  const modelMetrics = [...new Set(model.featureNames.filter(isMetricFeature))].sort((left, right) =>
    left.localeCompare(right, "en")
  );
  const missingFeatures = modelMetrics.filter((metric) => metrics[metric] === undefined);
  const observedModelMetrics = modelMetrics.length - missingFeatures.length;
  const observationAt = new Date(observationMs).toISOString();
  const trustedObservationCutoff = new Date(trustedCutoffMs).toISOString();
  const common: V5PredictionProvenance = {
    modelId: artifact.modelId,
    modelVersion: artifact.version,
    modelArtifactHash,
    targetSpecId: artifact.target.id,
    canonicalPostId,
    platform,
    observationAt,
    asOf: observationAt,
    trustedObservationCutoff,
    publishedAt: new Date(publishedMs).toISOString(),
    publishedAtPrecision: "exact",
    predictionHorizonHours: platformTarget.horizonHours,
    highPerformanceGrowthThreshold: growthThreshold,
    rawModelOutput: rounded(rawModelOutput),
    uncertaintyInterval: null,
    featureSchemaVersion: artifact.featureSchemaVersion,
    trainingDataManifestHash: artifact.trainingManifestHash,
    trainingDataHash: artifact.trainingDataHash,
    splitHash: artifact.splitHash,
    missingFeatures,
    evidence: {
      sourceId: evidenceSourceId,
      artifactSha256: input.evidenceArtifactSha256,
      observedModelMetrics,
      totalModelMetrics: modelMetrics.length,
      coverageRatio: rounded(observedModelMetrics / Math.max(modelMetrics.length, 1))
    },
    explanation: {
      method: "linear_logit_contributions",
      contributions,
      intercept: model.parameters.intercept
    },
    limitations: [
      "This is a predictive association for the registered high-performance outcome, not a causal estimate.",
      "A per-prediction uncertainty interval is not supported by this artifact."
    ]
  };

  if (artifact.status === "accepted") {
    const probability = applyCalibration(rawModelOutput, model.calibration);
    return {
      ...common,
      status: "scored",
      calibratedProbability: rounded(probability),
      score: rounded(probability * 100, 6)
    };
  }
  return {
    ...common,
    status: "experimental_unvalidated",
    validationState: "acceptance_gate_failed",
    limitations: [
      "Experimental research output: acceptance and probability-calibration gates have not passed.",
      ...common.limitations
    ]
  };
}

function envelopeFailure(
  feature: string,
  value: number,
  envelope: { minimum: number; maximum: number; observations: number; fittedOn: "training" } | undefined
): {
  reason: "missing_feature_support" | "out_of_distribution";
  limitation: string;
} | null {
  if (
    !envelope ||
    envelope.fittedOn !== "training" ||
    !Number.isFinite(envelope.minimum) ||
    !Number.isFinite(envelope.maximum) ||
    envelope.observations <= 0 ||
    envelope.minimum > envelope.maximum
  ) {
    return {
      reason: "missing_feature_support",
      limitation: `No valid training-derived support envelope exists for ${feature}.`
    };
  }
  if (value < envelope.minimum || value > envelope.maximum) {
    return {
      reason: "out_of_distribution",
      limitation: `Feature ${feature} is outside its training-derived support envelope.`
    };
  }
  return null;
}

function parseCanonicalDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function unscored(
  platform: string,
  reason: Extract<V5Prediction, { status: "unscored" }>["reason"],
  limitation: string
): V5Prediction {
  return { status: "unscored", platform, reason, limitations: [limitation] };
}
