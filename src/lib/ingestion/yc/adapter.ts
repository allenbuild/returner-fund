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
  if (/^S\d{2}$/.test(normalized) || /^P\d{4}$/.test(normalized) || /^W\d{4}$/.test(normalized)) {
    return normalized;
  }
  const summer = input.match(/summer\s*(\d{4})/i);
  if (summer) return `S${summer[1].slice(2)}`;
  const spring = input.match(/spring\s*(\d{4})/i);
  if (spring) return `P${spring[1]}`;
  const winter = input.match(/winter\s*(\d{4})/i);
  if (winter) return `W${winter[1]}`;
  return normalized;
}

export async function fetchYcBatch(batchSlug: string, options?: { demo?: boolean }): Promise<YcBatchResult> {
  const slug = normalizeBatchSlug(batchSlug);
  if (options?.demo === true) {
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

export function createDemoBatchResult(batchSlug = "S26"): YcBatchResult {
  return {
    batch:
      batchSlug === demoBatch.slug
        ? demoBatch
        : {
            ...demoBatch,
            id: `batch-${batchSlug.toLowerCase()}`,
            slug: batchSlug,
            label: formatBatchLabel(batchSlug)
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

function formatBatchLabel(batchSlug: string): string {
  if (/^S\d{2}$/.test(batchSlug)) {
    return `YC Summer 20${batchSlug.slice(1)} (${batchSlug})`;
  }
  const year = batchSlug.match(/20\d{2}/)?.[0] ?? `20${batchSlug.replace(/^[A-Z]/, "").slice(-2)}`;
  if (batchSlug.startsWith("W")) {
    return `YC Winter ${year} (W${year.slice(2)})`;
  }
  return `YC Spring ${year} (P${year.slice(2)})`;
}
