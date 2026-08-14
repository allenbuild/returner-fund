import {
  loadPublishedGraphSnapshot,
  PUBLISHED_GRAPH_BATCH_FILES,
  type PublishedGraphBatchSlug
} from "@/lib/graph/published-graph-snapshot";
import type { EvidenceItem, TopVoiceMember } from "@/lib/graph/types";
import { resolveTopVoiceAudience } from "@/lib/social/top-voices";
import {
  YC_PARTNER_FAVORITE_MODEL_NAME,
  YC_PARTNER_FAVORITE_MODEL_VERSION,
  scoreFavoritePair
} from "./favorite-scoring";
import type {
  YcPartnerFavoriteDetail,
  YcPartnerFavoriteRanking,
  YcPartnersResponse
} from "./favorite-contracts";

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  response: YcPartnersResponse;
}

interface InFlightEntry {
  generation: number;
  promise: Promise<YcPartnersResponse>;
}

const inFlight = new Map<string, InFlightEntry>();
const cache = new Map<string, CacheEntry>();
let cacheGeneration = 0;

export interface YcPartnerFavoritesQuery {
  partnerId?: string;
  batchSlug?: string;
  includeNoEvidence?: boolean;
}

interface NormalizedYcPartnerFavoritesQuery {
  partnerId?: string;
  batchSlug?: PublishedGraphBatchSlug;
  includeNoEvidence: boolean;
}

export type YcPartnerFavoritesQueryErrorCode = "invalid_partner" | "invalid_batch";

export class YcPartnerFavoritesQueryError extends Error {
  readonly code: YcPartnerFavoritesQueryErrorCode;
  readonly statusCode = 400;

  constructor(code: YcPartnerFavoritesQueryErrorCode) {
    super(
      code === "invalid_partner"
        ? "The requested YC partner is not available."
        : "The requested batch is not available."
    );
    this.name = "YcPartnerFavoritesQueryError";
    this.code = code;
  }
}

export function normalizeYcPartnerFavoritesQuery(
  query: YcPartnerFavoritesQuery = {}
): NormalizedYcPartnerFavoritesQuery {
  const partnerId = normalizePartnerId(query.partnerId);
  const batchSlug = normalizeBatchSlug(query.batchSlug);
  const { members } = resolveTopVoiceAudience("yc_partners");

  if (partnerId && !members.some((member) => member.personId.toLowerCase() === partnerId)) {
    throw new YcPartnerFavoritesQueryError("invalid_partner");
  }

  return {
    partnerId: partnerId
      ? members.find((member) => member.personId.toLowerCase() === partnerId)?.personId
      : undefined,
    batchSlug,
    // The product contract is a complete partner-by-startup ranking. Callers
    // may explicitly opt out when they only need attributable evidence rows.
    includeNoEvidence: query.includeNoEvidence !== false
  };
}

export async function loadYcPartnerFavorites(
  query: YcPartnerFavoritesQuery = {}
): Promise<YcPartnersResponse> {
  const normalizedQuery = normalizeYcPartnerFavoritesQuery(query);
  const key = JSON.stringify(normalizedQuery);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.response;
  if (cached) cache.delete(key);

  const generation = cacheGeneration;
  const existing = inFlight.get(key);
  if (existing?.generation === generation) return existing.promise;

  const request = loadAndBuild(normalizedQuery)
    .then((response) => {
      // A refresh can invalidate an older build while its snapshot reads are
      // still in flight. Never let that old result repopulate the cache.
      if (cacheGeneration === generation) {
        cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, response });
      }
      return response;
    })
    .finally(() => {
      if (inFlight.get(key)?.promise === request) inFlight.delete(key);
    });

  inFlight.set(key, { generation, promise: request });
  return request;
}

export function clearYcPartnerFavoriteCache(): void {
  cacheGeneration += 1;
  cache.clear();
  inFlight.clear();
}

async function loadAndBuild(
  query: NormalizedYcPartnerFavoritesQuery
): Promise<YcPartnersResponse> {
  const batchEntries = query.batchSlug
    ? [query.batchSlug]
    : (Object.keys(PUBLISHED_GRAPH_BATCH_FILES) as PublishedGraphBatchSlug[]);
  const { members } = resolveTopVoiceAudience("yc_partners");
  const activeMembers = query.partnerId
    ? members.filter((member) => member.personId === query.partnerId)
    : members;
  const memberById = new Map(activeMembers.map((member) => [member.personId, member]));

  const loaded = await Promise.all(
    batchEntries.map(async (batchSlug) => {
      const [base, partner] = await Promise.all([
        loadPublishedGraphSnapshot({ batchSlug, audienceId: "off" }),
        loadPublishedGraphSnapshot({ batchSlug, audienceId: "yc_partners" })
      ]);
      return { base, partner };
    })
  );

  const allCompanies = new Map<string, CompanyContext>();
  const evidenceByPartnerAndCompany = new Map<string, EvidenceBucket>();
  const generatedAtValues: string[] = [];

  for (const { base, partner } of loaded) {
    generatedAtValues.push(base.generatedAt, partner.generatedAt);

    for (const node of base.nodes) {
      if (node.entityType !== "company") continue;
      allCompanies.set(companyKey(node.batchSlug, node.entityId), {
        id: node.entityId,
        name: node.label,
        batchSlug: node.batchSlug,
        batchLabel: base.batch.label,
        groupPartner: node.groupPartner
      });
    }

    for (const evidence of partner.evidence) {
      const topVoice = evidence.topVoice;
      const member = topVoice?.audienceId === "yc_partners"
        ? memberById.get(topVoice.memberId)
        : undefined;
      if (!member) continue;

      // The snapshot batch is authoritative. A malformed evidence row must
      // not attach a company from another batch to this ranking.
      if (
        evidence.batchSlug &&
        evidence.batchSlug.toLowerCase() !== partner.batch.slug.toLowerCase()
      ) {
        continue;
      }

      const companyId = evidence.attachedCompanyId?.trim() ||
        (evidence.entityType === "company" ? evidence.entityId.trim() : "");
      if (!companyId) continue;

      const company = allCompanies.get(companyKey(partner.batch.slug, companyId));
      if (!company) continue;
      if (company.groupPartner === null || !partnerNameMatches(member, company.groupPartner)) continue;

      const key = `${member.personId}:${companyKey(company.batchSlug, company.id)}`;
      const bucket = evidenceByPartnerAndCompany.get(key);
      if (bucket) {
        bucket.evidence.push(evidence);
      } else {
        evidenceByPartnerAndCompany.set(key, {
          member,
          company,
          evidence: [evidence]
        });
      }
    }
  }

  // A partner's ranking is scoped to the companies assigned to that partner
  // in YC metadata. Commentary alone cannot establish ownership: a partner
  // may publicly praise another partner's company.
  const assignedCompaniesByPartner = new Map<string, CompanyContext[]>();
  for (const member of activeMembers) {
    const assignedCompanies = [...allCompanies.values()].filter((company) =>
      company.groupPartner !== null && partnerNameMatches(member, company.groupPartner)
    );
    assignedCompaniesByPartner.set(member.personId, assignedCompanies);
  }

  const rankingsByPartner = new Map<string, YcPartnerFavoriteRanking[]>();
  for (const bucket of evidenceByPartnerAndCompany.values()) {
    const scored = scoreFavoritePair(bucket.member, bucket.evidence);
    const ranking: YcPartnerFavoriteRanking = {
      rank: 0,
      companyId: bucket.company.id,
      companyName: bucket.company.name,
      batchSlug: bucket.company.batchSlug,
      batchLabel: bucket.company.batchLabel,
      score: scored.score,
      confidence: scored.confidence,
      evidenceCount: scored.breakdown.uniqueEvidenceCount,
      primaryReason: scored.primaryReason,
      citations: scored.citations,
      breakdown: scored.breakdown
    };
    const partnerRankings = rankingsByPartner.get(bucket.member.personId);
    if (partnerRankings) partnerRankings.push(ranking);
    else rankingsByPartner.set(bucket.member.personId, [ranking]);
  }

  const updatedAt = maxIsoTimestamp(generatedAtValues) ?? new Date().toISOString();
  const scopedCompanies = new Set<string>();
  for (const companies of assignedCompaniesByPartner.values()) {
    for (const company of companies) scopedCompanies.add(companyKey(company.batchSlug, company.id));
  }
  const details = activeMembers
    .map((member) => {
      let rankings = [...(rankingsByPartner.get(member.personId) ?? [])];
      if (query.includeNoEvidence) {
        const seen = new Set(rankings.map((ranking) => companyKey(ranking.batchSlug, ranking.companyId)));
        for (const company of assignedCompaniesByPartner.get(member.personId) ?? []) {
          const key = companyKey(company.batchSlug, company.id);
          if (!seen.has(key)) rankings.push(emptyRanking(company));
        }
      }

      rankings.sort(compareRankings);
      rankings = rankings.map((ranking, index) => ({ ...ranking, rank: index + 1 }));
      const topFavorite = rankings.find((ranking) => ranking.evidenceCount > 0) ?? null;

      return {
        partnerId: member.personId,
        partnerName: member.displayName,
        category: member.category,
        topFavorite,
        // This is the number of rows in the partner's returned ranking. It
        // includes zero-evidence companies when explicitly requested.
        rankingCount: rankings.length,
        supportingEvidenceCount: rankings.reduce((sum, ranking) => sum + ranking.evidenceCount, 0),
        confidence: topFavorite?.confidence ?? null,
        updatedAt,
        rankings
      } satisfies YcPartnerFavoriteDetail;
    })
    .sort((left, right) => left.partnerName.localeCompare(right.partnerName));

  return {
    generatedAt: updatedAt,
    modelVersion: YC_PARTNER_FAVORITE_MODEL_VERSION,
    modelName: YC_PARTNER_FAVORITE_MODEL_NAME,
    batchCount: loaded.length,
    companyCount: scopedCompanies.size,
    partnerCount: details.length,
    partners: details
  } satisfies YcPartnersResponse;
}

interface CompanyContext {
  id: string;
  name: string;
  batchSlug: string;
  batchLabel: string;
  groupPartner: string | null;
}

interface EvidenceBucket {
  member: TopVoiceMember;
  company: CompanyContext;
  evidence: EvidenceItem[];
}

function partnerNameMatches(member: TopVoiceMember, companyPartner: string): boolean {
  const normalizedCompanyPartner = normalizePartnerName(companyPartner);
  return [member.displayName, ...member.aliases]
    .some((name) => normalizePartnerName(name) === normalizedCompanyPartner);
}

function normalizePartnerName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizePartnerId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeBatchSlug(value: string | undefined): PublishedGraphBatchSlug | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;

  for (const [slug, filename] of Object.entries(PUBLISHED_GRAPH_BATCH_FILES)) {
    if (slug.toLowerCase() === normalized || filename.toLowerCase() === normalized) {
      return slug as PublishedGraphBatchSlug;
    }
  }

  throw new YcPartnerFavoritesQueryError("invalid_batch");
}

function companyKey(batchSlug: string, companyId: string): string {
  return `${batchSlug.toLowerCase()}:${companyId}`;
}

function compareRankings(left: YcPartnerFavoriteRanking, right: YcPartnerFavoriteRanking): number {
  return right.confidence.score - left.confidence.score ||
    right.score - left.score ||
    right.evidenceCount - left.evidenceCount ||
    left.companyName.localeCompare(right.companyName) ||
    left.batchSlug.localeCompare(right.batchSlug) ||
    left.companyId.localeCompare(right.companyId);
}

function emptyRanking(company: CompanyContext): YcPartnerFavoriteRanking {
  return {
    rank: 0,
    companyId: company.id,
    companyName: company.name,
    batchSlug: company.batchSlug,
    batchLabel: company.batchLabel,
    score: 0,
    confidence: {
      level: "low",
      score: 0,
      reasons: ["No attributable partner commentary was found."],
      uniqueEvidenceCount: 0,
      uniquePlatformCount: 0,
      uniqueContextCount: 0,
      datedEvidenceCount: 0,
      verifiedLinkCount: 0
    },
    evidenceCount: 0,
    primaryReason: "No attributable partner commentary was found.",
    citations: [],
    breakdown: {
      strongestEvidenceScore: 0,
      secondaryEvidenceBonus: 0,
      independentContextBonus: 0,
      negativePenalty: 0,
      convictionStrength: 0,
      praiseStrength: 0,
      specificity: 0,
      contextQuality: 0,
      uniqueEvidenceCount: 0,
      uniquePlatformCount: 0,
      uniqueContextCount: 0,
      signalTypes: []
    }
  };
}

function maxIsoTimestamp(values: string[]): string | null {
  const valid = values
    .map((value) => ({ value, timestamp: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => right.timestamp - left.timestamp);
  return valid[0]?.value ?? null;
}
