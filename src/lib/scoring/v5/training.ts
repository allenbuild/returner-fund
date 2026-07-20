import { rounded } from "./math";
import { evaluatePredictions, type V5LabeledPrediction } from "./evaluation";
import {
  V5_METRIC_FEATURES,
  metricForMissingFeature,
  missingFeatureName,
  type V5CalibrationParameters,
  type V5CandidateResult,
  type V5CanonicalObservation,
  type V5FeatureName,
  type V5LabeledObservation,
  type V5MetricFeature,
  type V5ModelParameters
} from "./types";

const V5_CANDIDATE_GRID_DEFINITION = [
  { id: "equal-log-sum", family: "baseline", lambda: null, includeAge: false },
  { id: "age-only-logistic-l2-0.01", family: "nonnegative_logistic", lambda: 0.01, includeAge: true },
  { id: "metric-logistic-l2-0", family: "nonnegative_logistic", lambda: 0, includeAge: false },
  { id: "metric-logistic-l2-0.01", family: "nonnegative_logistic", lambda: 0.01, includeAge: false },
  { id: "metric-logistic-l2-0.1", family: "nonnegative_logistic", lambda: 0.1, includeAge: false },
  { id: "metric-logistic-l2-1", family: "nonnegative_logistic", lambda: 1, includeAge: false },
  { id: "metric-age-logistic-l2-0.01", family: "nonnegative_logistic", lambda: 0.01, includeAge: true },
  { id: "metric-age-logistic-l2-0.1", family: "nonnegative_logistic", lambda: 0.1, includeAge: true }
] as const;

export const V5_FROZEN_CANDIDATE_GRID = Object.freeze(
  V5_CANDIDATE_GRID_DEFINITION.map((candidate) => Object.freeze(candidate))
);

const TRAINING_ITERATIONS = 1_500;
const CALIBRATION_ITERATIONS = 1_200;

export function trainAndSelectCandidate(
  trainingRows: readonly V5LabeledObservation[],
  validationRows: readonly V5LabeledObservation[]
): { selected: V5CandidateResult; candidates: V5CandidateResult[]; baseline: V5CandidateResult } | null {
  if (!hasBothClasses(trainingRows) || !hasBothClasses(validationRows)) return null;
  const metricFeatures = observedMetricFeatures(trainingRows);
  if (metricFeatures.length === 0) return null;
  const candidates: V5CandidateResult[] = [];

  for (const gridPoint of V5_FROZEN_CANDIDATE_GRID) {
    const metricAndMissingFeatures = metricFeatures.flatMap<V5FeatureName>((metric) => [
      metric,
      missingFeatureName(metric)
    ]);
    let features: V5FeatureName[];
    if (gridPoint.id.startsWith("age-only")) features = ["post_age_hours"];
    else {
      features = gridPoint.includeAge
        ? [...metricAndMissingFeatures, "post_age_hours"]
        : metricAndMissingFeatures;
    }
    const parameters = roundParameters(
      gridPoint.family === "baseline"
        ? equalLogSumParameters(metricFeatures)
        : fitConstrainedLogistic(trainingRows, features, gridPoint.lambda)
    );
    const validationRaw = validationRows.map((row) => rawLinearOutput(parameters, row));
    const calibration = roundCalibration(
      fitPlattCalibration(validationRaw, validationRows.map((row) => row.highPerformanceOutcome))
    );
    const predictions = validationRows.map<V5LabeledPrediction>((row, index) => ({
      id: row.rowId,
      groupId: row.entityId,
      label: row.highPerformanceOutcome,
      probability: applyCalibration(validationRaw[index], calibration)
    }));
    candidates.push({
      id: gridPoint.id,
      family: gridPoint.family,
      lambda: gridPoint.lambda,
      includeAge: gridPoint.includeAge,
      features,
      parameters,
      calibration,
      validation: evaluatePredictions(predictions),
      complexity: features.length + 1
    });
  }

  candidates.sort(compareCandidates);
  const baseline = candidates.find((candidate) => candidate.id === "equal-log-sum");
  if (!baseline) throw new Error("Frozen candidate grid is missing its declared baseline.");
  return { selected: candidates[0], candidates, baseline };
}

export function predictRows(
  rows: readonly V5LabeledObservation[],
  parameters: V5ModelParameters,
  calibration: V5CalibrationParameters
): V5LabeledPrediction[] {
  return rows.map((row) => ({
    id: row.rowId,
    groupId: row.entityId,
    label: row.highPerformanceOutcome,
    probability: applyCalibration(rawLinearOutput(parameters, row), calibration)
  }));
}

export function rawLinearOutput(
  parameters: V5ModelParameters,
  row: Pick<V5CanonicalObservation, "metrics" | "postAgeHours">
): number {
  return Object.entries(parameters.coefficients)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .reduce((sum, [feature, coefficient]) => {
      return sum + (coefficient ?? 0) * transformedFeatureValue(row, feature as V5FeatureName);
    }, parameters.intercept);
}

export function transformedFeatureValue(
  row: Pick<V5CanonicalObservation, "metrics" | "postAgeHours">,
  feature: V5FeatureName
): number {
  if (feature === "post_age_hours") return Math.log1p(Math.max(0, row.postAgeHours));
  const missingMetric = metricForMissingFeature(feature);
  if (missingMetric) return row.metrics[missingMetric] === undefined ? 1 : 0;
  return Math.log1p(Math.max(0, row.metrics[feature as V5MetricFeature] ?? 0));
}

export function applyCalibration(rawOutput: number, calibration: V5CalibrationParameters): number {
  return sigmoid(calibration.intercept + calibration.slope * rawOutput);
}

function observedMetricFeatures(rows: readonly V5LabeledObservation[]): V5MetricFeature[] {
  return V5_METRIC_FEATURES.filter((feature) => rows.some((row) => row.metrics[feature] !== undefined));
}

function equalLogSumParameters(features: readonly V5MetricFeature[]): V5ModelParameters {
  return {
    intercept: 0,
    coefficients: Object.fromEntries(
      features.flatMap((feature) => [
        [feature, 1],
        [missingFeatureName(feature), 0]
      ])
    )
  };
}

function fitConstrainedLogistic(
  rows: readonly V5LabeledObservation[],
  features: readonly V5FeatureName[],
  lambda: number
): V5ModelParameters {
  const prevalence = rows.reduce((sum, row) => sum + row.highPerformanceOutcome, 0) / rows.length;
  let intercept = Math.log(Math.max(1e-6, prevalence) / Math.max(1e-6, 1 - prevalence));
  const coefficients = Object.fromEntries(features.map((feature) => [feature, 0])) as Record<
    V5FeatureName,
    number
  >;
  for (let iteration = 0; iteration < TRAINING_ITERATIONS; iteration += 1) {
    let interceptGradient = 0;
    const gradients = Object.fromEntries(features.map((feature) => [feature, 0])) as Record<
      V5FeatureName,
      number
    >;
    for (const row of rows) {
      const raw = features.reduce(
        (sum, feature) => sum + coefficients[feature] * transformedFeatureValue(row, feature),
        intercept
      );
      const error = sigmoid(raw) - row.highPerformanceOutcome;
      interceptGradient += error;
      for (const feature of features) {
        gradients[feature] += error * transformedFeatureValue(row, feature);
      }
    }
    const learningRate = 0.04 / (1 + iteration / 300);
    intercept -= learningRate * (interceptGradient / rows.length);
    for (const feature of features) {
      const gradient = gradients[feature] / rows.length + lambda * coefficients[feature];
      const next = coefficients[feature] - learningRate * gradient;
      coefficients[feature] =
        feature === "post_age_hours"
          ? Math.min(0, next)
          : metricForMissingFeature(feature)
            ? next
            : Math.max(0, next);
    }
  }
  return { intercept, coefficients };
}

function fitPlattCalibration(
  rawOutputs: readonly number[],
  labels: readonly (0 | 1)[]
): V5CalibrationParameters {
  const mean = rawOutputs.reduce((sum, value) => sum + value, 0) / rawOutputs.length;
  const variance = rawOutputs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rawOutputs.length;
  const scale = Math.sqrt(variance) || 1;
  const prevalence = labels.reduce<number>((sum, label) => sum + label, 0) / labels.length;
  let intercept = Math.log(Math.max(1e-6, prevalence) / Math.max(1e-6, 1 - prevalence));
  let slope = 0;
  for (let iteration = 0; iteration < CALIBRATION_ITERATIONS; iteration += 1) {
    let interceptGradient = 0;
    let slopeGradient = 0;
    for (let index = 0; index < rawOutputs.length; index += 1) {
      const normalized = (rawOutputs[index] - mean) / scale;
      const error = sigmoid(intercept + slope * normalized) - labels[index];
      interceptGradient += error;
      slopeGradient += error * normalized;
    }
    const learningRate = 0.05 / (1 + iteration / 250);
    intercept -= learningRate * (interceptGradient / rawOutputs.length);
    slope = Math.max(0, slope - learningRate * (slopeGradient / rawOutputs.length));
  }
  return {
    method: "platt_nonnegative_slope",
    intercept: intercept - (slope * mean) / scale,
    slope: slope / scale,
    fittedOn: "validation"
  };
}

function compareCandidates(left: V5CandidateResult, right: V5CandidateResult): number {
  return (
    right.validation.ndcgAt50 - left.validation.ndcgAt50 ||
    left.validation.logLoss - right.validation.logLoss ||
    left.complexity - right.complexity ||
    left.id.localeCompare(right.id, "en")
  );
}

function roundParameters(parameters: V5ModelParameters): V5ModelParameters {
  return {
    intercept: rounded(parameters.intercept),
    coefficients: Object.fromEntries(
      Object.entries(parameters.coefficients).map(([feature, value]) => [feature, rounded(value ?? 0)])
    )
  };
}

function roundCalibration(calibration: V5CalibrationParameters): V5CalibrationParameters {
  return {
    ...calibration,
    intercept: rounded(calibration.intercept),
    slope: rounded(calibration.slope)
  };
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-Math.min(value, 700)));
  const exponential = Math.exp(Math.max(value, -700));
  return exponential / (1 + exponential);
}

function hasBothClasses(rows: readonly V5LabeledObservation[]): boolean {
  return rows.some((row) => row.highPerformanceOutcome === 0) && rows.some((row) => row.highPerformanceOutcome === 1);
}
