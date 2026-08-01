import type { CompanyRecord, ScoreCalibration } from "@/lib/graph/types";
import { TRACTION_SCORING_CONFIG } from "./traction-config";

const GLOBAL_BENCHMARK_SCOPE = "all_supported_batches" as const;
const GLOBAL_BENCHMARK_POPULATION = "current_company_snapshot" as const;

/**
 * Converts canonical absolute evidence scores into one cross-batch headline scale.
 *
 * The strongest current company across the supplied global population is 100.
 * This is a ratio to a single shared maximum, not per-cohort min/max stretching.
 * Raw absolute scores, platform scores, and weighted platform contributions remain
 * untouched so the evidence math stays auditable.
 */
export function benchmarkGlobalCompanyScores(
  companies: CompanyRecord[],
  globalPopulation: CompanyRecord[] = companies
): CompanyRecord[] {
  const population = mergeGlobalPopulation(globalPopulation, companies);
  const positiveScores = population
    .filter(hasCanonicalScoreBreakdown)
    .map(absoluteCompanyScore)
    .filter((score) => Number.isFinite(score) && score > 0);
  const benchmarkScore = positiveScores.length > 0 ? Math.max(...positiveScores) : 0;
  const scaleFactor = benchmarkScore > 0 ? 100 / benchmarkScore : 0;

  return applyGlobalBenchmark(companies, {
    cohortSize: positiveScores.length,
    benchmarkScore,
    scaleFactor
  });
}

/**
 * Applies the complete global benchmark metadata already published on a graph.
 *
 * This is the safe fallback for partial live overlays that do not have the full
 * cross-batch population available. Invalid or incomplete metadata is rejected
 * instead of silently treating the visible batch as the global population.
 */
export function benchmarkCompanyScoresWithPublishedGlobalFactor(
  companies: CompanyRecord[],
  publishedCalibration: ScoreCalibration
): CompanyRecord[] {
  const parameters = validatedPublishedParameters(publishedCalibration);
  return applyGlobalBenchmark(companies, parameters);
}

interface GlobalBenchmarkParameters {
  cohortSize: number;
  benchmarkScore: number;
  scaleFactor: number;
}

function applyGlobalBenchmark(
  companies: CompanyRecord[],
  parameters: GlobalBenchmarkParameters
): CompanyRecord[] {
  const { cohortSize, benchmarkScore, scaleFactor } = parameters;

  return companies.map((company) => {
    if (!hasCanonicalScoreBreakdown(company)) return company;

    const inputScore = absoluteCompanyScore(company);
    const headlineScore = benchmarkScore > 0
      ? clampScore(Math.round((inputScore / benchmarkScore) * 100))
      : 0;

    return {
      ...company,
      totalScore: headlineScore,
      previousScore: headlineScore,
      scoreBreakdown: {
        ...company.scoreBreakdown,
        totalScore: headlineScore,
        absoluteScore: inputScore,
        calibration: {
          method: "global_best_ratio",
          cohortSize,
          percentile: null,
          inputScore,
          benchmarkScore,
          scaleFactor,
          benchmarkScope: GLOBAL_BENCHMARK_SCOPE,
          benchmarkPopulation: GLOBAL_BENCHMARK_POPULATION
        },
        explanation: `${company.scoreBreakdown.explanation} Headline scores use one global current-company benchmark across all supported batches: the strongest absolute evidence score is 100. Raw platform contributions are not scaled.`
      }
    };
  });
}

function validatedPublishedParameters(
  calibration: ScoreCalibration
): GlobalBenchmarkParameters {
  if (
    calibration.method !== "global_best_ratio" ||
    calibration.benchmarkScope !== GLOBAL_BENCHMARK_SCOPE ||
    calibration.benchmarkPopulation !== GLOBAL_BENCHMARK_POPULATION ||
    calibration.percentile !== null ||
    !Number.isInteger(calibration.cohortSize) ||
    calibration.cohortSize < 0 ||
    !Number.isFinite(calibration.benchmarkScore) ||
    Number(calibration.benchmarkScore) < 0 ||
    Number(calibration.benchmarkScore) > 100 ||
    !Number.isFinite(calibration.scaleFactor) ||
    Number(calibration.scaleFactor) < 0
  ) {
    throw new Error("Published graph is missing a valid global score benchmark.");
  }

  const benchmarkScore = Number(calibration.benchmarkScore);
  const scaleFactor = Number(calibration.scaleFactor);
  const expectedScaleFactor = benchmarkScore > 0 ? 100 / benchmarkScore : 0;
  const tolerance = Math.max(1, expectedScaleFactor) * 1e-12;
  const zeroStateIsValid = benchmarkScore === 0 && scaleFactor === 0 && calibration.cohortSize === 0;
  const positiveStateIsValid =
    benchmarkScore > 0 &&
    calibration.cohortSize > 0 &&
    Math.abs(scaleFactor - expectedScaleFactor) <= tolerance;

  if (!zeroStateIsValid && !positiveStateIsValid) {
    throw new Error("Published graph contains inconsistent global score benchmark values.");
  }

  return {
    cohortSize: calibration.cohortSize,
    benchmarkScore,
    scaleFactor
  };
}

function mergeGlobalPopulation(
  globalPopulation: CompanyRecord[],
  companies: CompanyRecord[]
): CompanyRecord[] {
  const byIdentity = new Map(
    globalPopulation.map((company) => [companyIdentity(company), company])
  );
  for (const company of companies) {
    byIdentity.set(companyIdentity(company), company);
  }
  return [...byIdentity.values()];
}

function companyIdentity(company: CompanyRecord): string {
  return `${company.batchSlug}\u0000${company.id}`;
}

function hasCanonicalScoreBreakdown(
  company: CompanyRecord
): company is CompanyRecord & { scoreBreakdown: NonNullable<CompanyRecord["scoreBreakdown"]> } {
  return (
    company.scoreBreakdown?.modelId === TRACTION_SCORING_CONFIG.modelId &&
    company.scoreBreakdown.modelVersion === TRACTION_SCORING_CONFIG.version
  );
}

function absoluteCompanyScore(company: CompanyRecord): number {
  const canonicalAbsoluteScore = company.scoreBreakdown?.absoluteScore;
  const score = Number.isFinite(canonicalAbsoluteScore)
    ? Number(canonicalAbsoluteScore)
    : company.totalScore;
  return clampScore(score);
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}
