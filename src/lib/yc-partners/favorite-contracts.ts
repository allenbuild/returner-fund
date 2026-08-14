import type { Platform } from "@/lib/graph/types";
import type {
  FavoriteCitation,
  FavoriteConfidence,
  FavoriteScoreBreakdown,
  FavoriteSignalType
} from "./favorite-scoring";

export interface YcPartnerFavoriteRanking {
  rank: number;
  companyId: string;
  companyName: string;
  batchSlug: string;
  batchLabel: string;
  score: number;
  confidence: FavoriteConfidence;
  evidenceCount: number;
  primaryReason: string;
  citations: FavoriteCitation[];
  breakdown: FavoriteScoreBreakdown;
}

export interface YcPartnerFavoriteOverview {
  partnerId: string;
  partnerName: string;
  category: string;
  topFavorite: YcPartnerFavoriteRanking | null;
  rankingCount: number;
  supportingEvidenceCount: number;
  confidence: FavoriteConfidence | null;
  updatedAt: string;
}

export interface YcPartnerFavoriteDetail extends YcPartnerFavoriteOverview {
  rankings: YcPartnerFavoriteRanking[];
}

export interface YcPartnersResponse {
  generatedAt: string;
  modelVersion: string;
  modelName: string;
  batchCount: number;
  companyCount: number;
  partnerCount: number;
  partners: YcPartnerFavoriteDetail[];
}

export type FavoriteCitationPlatform = Platform;
export type FavoriteCitationSignalType = FavoriteSignalType;
