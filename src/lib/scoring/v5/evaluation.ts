import { rounded } from "./math";
import type { V5EvaluationMetrics } from "./types";

export interface V5LabeledPrediction {
  id: string;
  groupId: string;
  label: 0 | 1;
  probability: number;
}

export function evaluatePredictions(
  predictions: readonly V5LabeledPrediction[]
): V5EvaluationMetrics {
  const stable = [...predictions].sort((left, right) => left.id.localeCompare(right.id, "en"));
  const positives = stable.reduce((sum, item) => sum + item.label, 0);
  if (stable.length === 0) {
    return {
      rows: 0,
      positives: 0,
      ndcgAt10: 0,
      ndcgAt50: 0,
      pairwiseAccuracy: 0,
      brier: 0,
      logLoss: 0,
      expectedCalibrationError: 0
    };
  }

  return {
    rows: stable.length,
    positives,
    ndcgAt10: rounded(ndcg(stable, 10)),
    ndcgAt50: rounded(ndcg(stable, 50)),
    pairwiseAccuracy: rounded(pairwiseAccuracy(stable)),
    brier: rounded(
      stable.reduce((sum, item) => sum + (clampProbability(item.probability) - item.label) ** 2, 0) /
        stable.length
    ),
    logLoss: rounded(
      stable.reduce((sum, item) => {
        const probability = clampProbability(item.probability);
        return sum - item.label * Math.log(probability) - (1 - item.label) * Math.log(1 - probability);
      }, 0) / stable.length
    ),
    expectedCalibrationError: rounded(expectedCalibrationError(stable, 10))
  };
}

export function pairedBootstrapNdcgDelta(
  selected: readonly V5LabeledPrediction[],
  baseline: readonly V5LabeledPrediction[],
  seed = 20_260_720,
  replicates = 10_000
): { delta: number; confidenceInterval95: [number, number] } {
  if (selected.length !== baseline.length || selected.length === 0) {
    return { delta: 0, confidenceInterval95: [0, 0] };
  }
  const selectedById = new Map(selected.map((item) => [item.id, item]));
  const pairs = [...baseline]
    .sort((left, right) => left.id.localeCompare(right.id, "en"))
    .map((base) => {
      const choice = selectedById.get(base.id);
      if (!choice || choice.label !== base.label) throw new Error("Paired bootstrap ids or labels differ.");
      return { selected: choice, baseline: base };
    });
  const grouped = new Map<string, typeof pairs>();
  for (const pair of pairs) {
    const members = grouped.get(pair.selected.groupId) ?? [];
    members.push(pair);
    grouped.set(pair.selected.groupId, members);
  }
  const groupedPairs = [...grouped.entries()].sort(
    ([left], [right]) => left.localeCompare(right, "en")
  );
  const deltas: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const selectedSample: V5LabeledPrediction[] = [];
    const baselineSample: V5LabeledPrediction[] = [];
    for (let index = 0; index < groupedPairs.length; index += 1) {
      const draw = counterBasedDraw(seed, replicate, index);
      const sampledGroup = groupedPairs[draw % groupedPairs.length][1];
      for (const [memberIndex, sampled] of sampledGroup.entries()) {
        const suffix = `:bootstrap:${replicate}:${index}:${memberIndex}`;
        selectedSample.push({ ...sampled.selected, id: `${sampled.selected.id}${suffix}` });
        baselineSample.push({ ...sampled.baseline, id: `${sampled.baseline.id}${suffix}` });
      }
    }
    deltas.push(ndcg(selectedSample, 50) - ndcg(baselineSample, 50));
  }
  deltas.sort((left, right) => left - right);
  const observed = ndcg(selected, 50) - ndcg(baseline, 50);
  return {
    delta: rounded(observed),
    confidenceInterval95: [
      rounded(quantile(deltas, 0.025)),
      rounded(quantile(deltas, 0.975))
    ]
  };
}

function counterBasedDraw(seed: number, replicate: number, drawIndex: number): number {
  let value =
    (seed ^ Math.imul(replicate + 1, 0x9e3779b1) ^ Math.imul(drawIndex + 1, 0x85ebca6b)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function ndcg(predictions: readonly V5LabeledPrediction[], k: number): number {
  const ranked = [...predictions].sort(
    (left, right) => right.probability - left.probability || left.id.localeCompare(right.id, "en")
  );
  const ideal = [...predictions].sort(
    (left, right) => right.label - left.label || left.id.localeCompare(right.id, "en")
  );
  const actualGain = dcg(ranked.slice(0, k).map((item) => item.label));
  const idealGain = dcg(ideal.slice(0, k).map((item) => item.label));
  return idealGain === 0 ? 0 : actualGain / idealGain;
}

function dcg(labels: readonly number[]): number {
  return labels.reduce((sum, label, index) => sum + label / Math.log2(index + 2), 0);
}

function pairwiseAccuracy(predictions: readonly V5LabeledPrediction[]): number {
  const positives = predictions.filter((item) => item.label === 1);
  const negatives = predictions.filter((item) => item.label === 0);
  if (positives.length === 0 || negatives.length === 0) return 0;
  let correct = 0;
  let comparisons = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      comparisons += 1;
      correct +=
        positive.probability > negative.probability
          ? 1
          : positive.probability === negative.probability
            ? 0.5
            : 0;
    }
  }
  return correct / comparisons;
}

function expectedCalibrationError(
  predictions: readonly V5LabeledPrediction[],
  binCount: number
): number {
  let total = 0;
  const ordered = [...predictions].sort(
    (left, right) => left.probability - right.probability || left.id.localeCompare(right.id, "en")
  );
  for (let bin = 0; bin < binCount; bin += 1) {
    const start = Math.floor((bin * ordered.length) / binCount);
    const end = Math.floor(((bin + 1) * ordered.length) / binCount);
    const members = ordered.slice(start, end);
    if (members.length === 0) continue;
    const confidence = members.reduce((sum, item) => sum + clampProbability(item.probability), 0) / members.length;
    const accuracy = members.reduce((sum, item) => sum + item.label, 0) / members.length;
    total += (members.length / predictions.length) * Math.abs(accuracy - confidence);
  }
  return total;
}

function clampProbability(value: number): number {
  return Math.max(1e-6, Math.min(1 - 1e-6, value));
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}
