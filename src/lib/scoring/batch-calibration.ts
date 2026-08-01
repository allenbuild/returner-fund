import type { CompanyRecord } from "@/lib/graph/types";
import { TRACTION_SCORING_CONFIG } from "./traction-config";

export function calibrateBatchCompanyScores(
  companies: CompanyRecord[],
  calibrationCohort: CompanyRecord[] = companies
): CompanyRecord[] {
  const cohortCompanies = mergeCalibrationCohort(calibrationCohort, companies);
  const cohortSize = cohortCompanies
    .filter(hasCanonicalScoreBreakdown)
    .map(absoluteCompanyScore)
    .filter((score) => Number.isFinite(score) && score > 0).length;

  return companies.map((company) => {
    if (!hasCanonicalScoreBreakdown(company)) return company;

    const inputScore = absoluteCompanyScore(company);
    return {
      ...company,
      totalScore: inputScore,
      previousScore: inputScore,
      scoreBreakdown: {
        ...company.scoreBreakdown,
        totalScore: inputScore,
        absoluteScore: inputScore,
        calibration: {
          method: "none",
          cohortSize,
          percentile: null,
          inputScore
        },
        explanation: `${company.scoreBreakdown.explanation} The absolute fixed-platform score is used directly; cohort distribution does not change it.`
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
