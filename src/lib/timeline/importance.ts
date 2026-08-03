import type { TimelineCategory } from "./contracts";

const CATEGORY_PRIORS: Readonly<Record<TimelineCategory, number>> = {
  founded: 92, accelerator: 78, funding: 88, product_launch: 76, product_update: 42,
  traction_milestone: 66, revenue_milestone: 82, user_milestone: 72, customer: 62,
  partnership: 64, pricing: 45, business_model: 72, hiring: 35, leadership: 68,
  founder: 64, geographic_expansion: 60, open_source: 62, github: 45, research: 65,
  patent: 55, regulatory: 82, legal: 78, press: 35, award: 52, acquisition: 96,
  merger: 92, exit: 94, pivot: 84, shutdown: 98, website: 25, other: 30,
};

const HARD_MAJOR_CATEGORIES = new Set<TimelineCategory>([
  "founded", "funding", "acquisition", "merger", "exit", "pivot", "shutdown", "regulatory",
]);

export interface TimelineImportanceInput {
  category: TimelineCategory;
  sourceQualityTier: 1 | 2 | 3;
  hasQuantitativeMagnitude?: boolean;
  firstOfKind?: boolean;
  namedExternalOrganization?: boolean;
  stateChange?: boolean;
}

export function calculateTimelineImportance(input: TimelineImportanceInput): { score: number; isMajor: boolean } {
  let score = CATEGORY_PRIORS[input.category];
  if (input.sourceQualityTier === 1) score += 4;
  if (input.sourceQualityTier === 3) score -= 8;
  if (input.hasQuantitativeMagnitude) score += 5;
  if (input.firstOfKind) score += 5;
  if (input.namedExternalOrganization) score += 3;
  if (input.stateChange) score += 6;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const isMajor = HARD_MAJOR_CATEGORIES.has(input.category)
    || input.category === "accelerator"
    || input.category === "revenue_milestone" && score >= 80
    || input.category === "user_milestone" && score >= 85
    || input.category === "traction_milestone" && score >= 85
    || input.category === "product_launch" && input.firstOfKind === true;
  return { score, isMajor };
}
