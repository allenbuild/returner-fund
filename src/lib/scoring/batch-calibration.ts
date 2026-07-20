import type { CompanyRecord } from "@/lib/graph/types";
import { percentileRank } from "./percentiles";
import { TRACTION_SCORING_CONFIG } from "./traction-config";

export function calibrateBatchCompanyScores(
  companies: CompanyRecord[],
  calibrationCohort: CompanyRecord[] = companies
): CompanyRecord[] {
  const calibrationConfig = TRACTION_SCORING_CONFIG.batchCalibration;
  const cohortCompanies = mergeCalibrationCohort(calibrationCohort, companies);
  const absoluteScores = cohortCompanies
    .filter(hasCanonicalScoreBreakdown)
    .map(absoluteCompanyScore)
    .filter((score) => Number.isFinite(score) && score > 0);
  const cohortSize = absoluteScores.length;
  const blendedScores = absoluteScores.map((score) =>
    blendedCalibrationScore(score, percentileRank(absoluteScores, score), calibrationConfig)
  );
  const minimumBlendedScore = blendedScores.length > 0 ? Math.min(...blendedScores) : 0;
  const maximumBlendedScore = blendedScores.length > 0 ? Math.max(...blendedScores) : 0;

  return companies.map((company) => {
    if (!hasCanonicalScoreBreakdown(company)) return company;

    const inputScore = absoluteCompanyScore(company);
    if (inputScore <= 0 || cohortSize === 0) {
      return {
        ...company,
        totalScore: 0,
        previousScore: 0,
        scoreBreakdown: {
          ...company.scoreBreakdown,
          totalScore: 0,
          absoluteScore: inputScore,
          calibration: { method: "none", cohortSize, percentile: null, inputScore }
        }
      };
    }

    const percentile = percentileRank(absoluteScores, inputScore);
    const blendedScore = blendedCalibrationScore(inputScore, percentile, calibrationConfig);
    const calibratedScore = fullRangeScore(
      blendedScore,
      minimumBlendedScore,
      maximumBlendedScore
    );

    return {
      ...company,
      totalScore: calibratedScore,
      previousScore: calibratedScore,
      scoreBreakdown: {
        ...company.scoreBreakdown,
        totalScore: calibratedScore,
        absoluteScore: inputScore,
        calibration: {
          method: "tie_aware_percentile_blend",
          cohortSize,
          percentile: round(percentile, 4),
          inputScore
        },
        explanation: `${company.scoreBreakdown.explanation} Cohort calibration blends the ${inputScore}/100 absolute score with the tie-aware ${round(
          percentile * 100,
          2
        )}th peer percentile across ${cohortSize} positive-evidence companies, then stretches the positive cohort across the 1-100 range to ${calibratedScore}/100.`
      }
    };
  });
}

function mergeCalibrationCohort(
  calibrationCohort: CompanyRecord[],
  companies: CompanyRecord[]
): CompanyRecord[] {
  const byId = new Map(calibrationCohort.map((company) => [company.id, company]));
  for (const company of companies) {
    byId.set(company.id, company);
  }
  return [...byId.values()];
}

function blendedCalibrationScore(
  inputScore: number,
  percentile: number,
  calibrationConfig: typeof TRACTION_SCORING_CONFIG.batchCalibration
): number {
  return (
    inputScore * calibrationConfig.absoluteScoreWeight +
    percentile * 100 * calibrationConfig.cohortPercentileWeight
  );
}

function fullRangeScore(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
    return Math.max(1, Math.min(100, Math.round(value)));
  }
  const normalized = (value - minimum) / (maximum - minimum);
  return Math.max(1, Math.min(100, Math.round(1 + normalized * 99)));
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
  const score = Number.isFinite(canonicalAbsoluteScore) ? Number(canonicalAbsoluteScore) : company.totalScore;
  return Math.max(0, Math.min(100, score));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
