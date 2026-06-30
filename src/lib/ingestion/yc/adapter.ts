import { demoBatch, demoCompanies, demoCompanyFounders, demoFounders } from "@/lib/demo/data";
import type { Batch, Company, CompanyFounder, Founder, ReviewState } from "@/types/domain";

export interface YcBatchResult {
  batch: Batch;
  companies: Company[];
  founders: Founder[];
  companyFounders: CompanyFounder[];
  sourceUrls: string[];
  review_state: ReviewState;
  mode: "demo" | "official" | "fallback";
  logs: string[];
}

export function normalizeBatchSlug(input: string): string {
  const normalized = input.trim().toUpperCase().replace(/\s+/g, "");
  if (/^S\d{4}$/.test(normalized) || /^W\d{4}$/.test(normalized)) {
    return normalized;
  }
  const springOrSummer = input.match(/(?:spring|summer)\s*(\d{4})/i);
  if (springOrSummer) return `S${springOrSummer[1]}`;
  const winter = input.match(/winter\s*(\d{4})/i);
  if (winter) return `W${winter[1]}`;
  return normalized;
}

export async function fetchYcBatch(batchSlug: string, options?: { demo?: boolean }): Promise<YcBatchResult> {
  const slug = normalizeBatchSlug(batchSlug);
  if (options?.demo !== false) {
    return createDemoBatchResult(slug);
  }
  return {
    ...createDemoBatchResult(slug),
    mode: "fallback",
    review_state: "needs_review",
    logs: [
      "Real YC ingestion is scaffolded but not executed in this MVP run.",
      "Use official YC directory first, then public web/search fallback with review_state."
    ]
  };
}

export function createDemoBatchResult(batchSlug = "S2026"): YcBatchResult {
  return {
    batch:
      batchSlug === demoBatch.slug
        ? demoBatch
        : {
            ...demoBatch,
            id: `batch-${batchSlug.toLowerCase()}`,
            slug: batchSlug,
            label: batchSlug === "S2026" ? "YC Spring 2026" : `YC ${batchSlug}`
          },
    companies: demoCompanies,
    founders: demoFounders,
    companyFounders: demoCompanyFounders,
    sourceUrls: ["https://www.ycombinator.com/companies"],
    review_state: "verified",
    mode: "demo",
    logs: [
      `Loaded deterministic demo dataset for ${batchSlug}.`,
      "Demo data includes uncertain profile candidates for needs_review."
    ]
  };
}
