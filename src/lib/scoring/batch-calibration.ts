import type { CompanyRecord } from "@/lib/graph/types";
import { percentileRank } from "./percentiles";
import { TRACTION_SCORING_CONFIG } from "./traction-config";

export function calibrateBatchCompanyScores(companies: CompanyRecord[]): CompanyRecord[] {
  const calibrationConfig = TRACTION_SCORING_CONFIG.batchCalibration;
  const absoluteScores = companies
    .filter(hasCanonicalScoreBreakdown)
    .map(absoluteCompanyScore)
    .filter((score) => Number.isFinite(score) && score > 0);
  const cohortSize = absoluteScores.length;

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
    const calibratedScore = Math.max(
      1,
      Math.min(
        100,
        Math.round(
          inputScore * calibrationConfig.absoluteScoreWeight +
            percentile * 100 * calibrationConfig.cohortPercentileWeight
        )
      )
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
        explanation: `${company.scoreBreakdown.explanation} Batch calibration blends the ${inputScore}/100 absolute score with the tie-aware ${round(
          percentile * 100,
          2
        )}th peer percentile across ${cohortSize} positive-evidence companies to ${calibratedScore}/100.`
      }
    };
  });
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
