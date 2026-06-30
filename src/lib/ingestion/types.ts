export type SourceReliability = "high" | "medium" | "low";
export type ReviewState = "verified" | "needs_review" | "rejected";

export interface SourceEvidence {
  url: string;
  title?: string | null;
  snippet?: string | null;
  sourceReliability: SourceReliability;
  extractedAt: string;
}

export interface YcFounderRecord {
  name: string;
  ycProfileUrl: string | null;
  personalWebsiteUrl: string | null;
  sourceReliability: SourceReliability;
  sources: SourceEvidence[];
  review_state: ReviewState;
}

export interface YcCompanyRecord {
  name: string;
  batchSlug: string;
  ycProfileUrl: string | null;
  websiteUrl: string | null;
  tagline: string | null;
  description: string | null;
  industries: string[];
  founders: YcFounderRecord[];
  groupPartner: string | null;
  sourceReliability: SourceReliability;
  sources: SourceEvidence[];
  review_state: ReviewState;
  warnings: string[];
}

export interface YcBatchResult {
  batchSlug: string;
  label: string;
  mode: "demo" | "official" | "fallback";
  companies: YcCompanyRecord[];
  expectedCompanyCount: number | null;
  observedCompanyCount: number;
  sources: SourceEvidence[];
  warnings: string[];
}

export interface YcSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

export interface YcBatchFetchOptions {
  demo?: boolean;
  maxCompanies?: number;
  signal?: AbortSignal;
}

export interface YcSearchProvider {
  search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<YcSearchResult[]>;
}
