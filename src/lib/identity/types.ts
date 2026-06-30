import { Platform } from "../scoring";
import type { ReviewState } from "@/types/domain";

export type EntityType = "company" | "founder";

export interface IdentityEntity {
  type: EntityType;
  id: string;
  name: string;
  companyName?: string | null;
  batchSlug?: string | null;
  websiteUrl?: string | null;
  ycProfileUrl?: string | null;
}

export interface IdentityCandidate {
  platform: Platform;
  url: string;
  handle?: string | null;
  displayName?: string | null;
  bio?: string | null;
  websiteUrl?: string | null;
  verified?: boolean | null;
  discoveredFromUrl?: string | null;
  foundOnOfficialSite?: boolean | null;
  recentActivityAt?: string | Date | null;
  review_state?: ReviewState | null;
  evidence?: Record<string, unknown>;
}

export interface IdentityReviewOptions {
  now?: string | Date;
}

export interface IdentitySignalContribution {
  signal: string;
  matched: boolean;
  category: "strong" | "supporting";
  reason: string;
}

export interface IdentityReviewExplanation {
  entity: IdentityEntity;
  candidate: IdentityCandidate;
  policy: string;
  contributions: IdentitySignalContribution[];
  matchedSignals: string[];
  limitations: string[];
}

export interface IdentityReviewResult {
  review_state: ReviewState;
  canonical: boolean;
  reasons: string[];
  explanationJson: IdentityReviewExplanation;
}
