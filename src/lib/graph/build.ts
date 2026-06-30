import {
  createEvidenceItems,
  demoBatch,
  demoCompanies,
  demoCompanyFounders,
  demoFounders,
  demoMetrics,
  demoNeedsReview,
  demoPosts,
  demoSocialAccounts
} from "@/lib/demo/data";
import {
  aggregateEntityScore,
  aggregatePlatformScore,
  calculateRawEngagement,
  scorePost
} from "@/lib/scoring/model";
import type {
  Company,
  CompanyFounder,
  EntityScore,
  EvidenceItem,
  FastestGainingRow,
  Founder,
  GraphEdge,
  GraphNode,
  GraphResponse,
  LeaderboardRow,
  PlatformScore,
  SocialAccount
} from "@/types/domain";

export interface BuildGraphInput {
  batchSlug?: string;
  companies: Company[];
  founders: Founder[];
  companyFounders: CompanyFounder[];
  socialAccounts: SocialAccount[];
}

export function buildDemoGraph(batchSlug = "S2026"): GraphResponse {
  const postScores = scoreDemoPosts();
  const postScoreMap = new Map(postScores.map((item) => [item.postId, item.contributionScore]));
  const entityScores = scoreDemoEntities(postScores);
  const nodes = buildNodes(demoCompanies, demoFounders, entityScores);
  const edges = buildEdges({
    batchSlug,
    companies: demoCompanies,
    founders: demoFounders,
    companyFounders: demoCompanyFounders,
    socialAccounts: demoSocialAccounts
  });
  const evidence = createEvidenceItems(postScoreMap);

  return {
    batch: batchSlug === demoBatch.slug ? demoBatch : { ...demoBatch, slug: batchSlug, label: `YC ${batchSlug}` },
    nodes,
    edges,
    companies: demoCompanies,
    founders: demoFounders,
    companyFounders: demoCompanyFounders,
    socialAccounts: demoSocialAccounts,
    evidence,
    leaderboard: buildLeaderboard(demoCompanies, entityScores, evidence),
    fastestGaining: buildFastestGaining(demoCompanies, entityScores),
    needsReview: demoNeedsReview,
    generatedAt: new Date().toISOString(),
    mode: "demo"
  };
}

export function scoreDemoPosts() {
  const rawSamplesByPlatform = new Map<string, number[]>();
  for (const post of demoPosts) {
    const postId = post.id ?? post.platformPostId;
    const metrics = demoMetrics.find((item) => item.postId === postId);
    if (!metrics) continue;
    const raw = calculateRawEngagement(metrics);
    const sample = rawSamplesByPlatform.get(post.platform) ?? [];
    sample.push(raw);
    rawSamplesByPlatform.set(post.platform, sample);
  }

  return demoPosts.map((post) => {
    const postId = post.id ?? post.platformPostId;
    const metrics = demoMetrics.find((item) => item.postId === postId);
    const account = demoSocialAccounts.find((item) => item.id === post.socialAccountId);
    if (!metrics) {
      throw new Error(`Missing demo metrics for ${postId}`);
    }
    const rawSamples = rawSamplesByPlatform.get(post.platform) ?? [];
    const engagementRates = rawSamples.map((raw) => raw / Math.max(account?.followerCount ?? 1, 1));
    return scorePost(post, metrics, rawSamples, engagementRates, account);
  });
}

export function scoreDemoEntities(postScores: ReturnType<typeof scoreDemoPosts>): EntityScore[] {
  const scoresByPost = new Map(postScores.map((item) => [item.postId, item]));
  const platformScoresByEntity = new Map<string, PlatformScore[]>();

  for (const account of demoSocialAccounts.filter((item) => item.review_state === "verified")) {
    const postsForAccount = demoPosts.filter((post) => post.socialAccountId === account.id);
    const accountPostScores = postsForAccount
      .map((post) => scoresByPost.get(post.id ?? post.platformPostId))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const platformScore = aggregatePlatformScore(account.platform, accountPostScores, account.review_state);
    const key = `${account.entityType}:${account.entityId}`;
    const existing = platformScoresByEntity.get(key) ?? [];
    existing.push(platformScore);
    platformScoresByEntity.set(key, existing);
  }

  const companyScores = demoCompanies.map((company) => {
    const direct = platformScoresByEntity.get(`company:${company.id}`) ?? [];
    const founderIds = demoCompanyFounders
      .filter((item) => item.companyId === company.id)
      .map((item) => item.founderId);
    const founderPlatformScores = founderIds.flatMap(
      (founderId) => platformScoresByEntity.get(`founder:${founderId}`) ?? []
    );
    const weightedPlatformScores = [
      ...direct.map((item) => ({ ...item, score: item.score * 0.6 + item.score * 0.4 })),
      ...founderPlatformScores.map((item) => ({ ...item, score: item.score * 0.4 }))
    ];
    return aggregateEntityScore("company", company.id, weightedPlatformScores);
  });

  const founderScores = demoFounders.map((founder) =>
    aggregateEntityScore("founder", founder.id, platformScoresByEntity.get(`founder:${founder.id}`) ?? [])
  );

  return [...companyScores, ...founderScores];
}

export function buildNodes(companies: Company[], founders: Founder[], scores: EntityScore[]): GraphNode[] {
  const companyScoreValues = scores.filter((item) => item.entityType === "company").map((item) => item.totalScore);
  const founderScoreValues = scores.filter((item) => item.entityType === "founder").map((item) => item.totalScore);
  return [
    ...companies.map((company) => {
      const score = scores.find((item) => item.entityType === "company" && item.entityId === company.id);
      return {
        id: `company:${company.id}`,
        type: "company" as const,
        label: company.name,
        score: score?.totalScore ?? 0,
        review_state: score?.review_state ?? company.review_state,
        radius: radiusForScore(score?.totalScore ?? 0, companyScoreValues, 28, 66)
      };
    }),
    ...founders.map((founder) => {
      const score = scores.find((item) => item.entityType === "founder" && item.entityId === founder.id);
      const relation = demoCompanyFounders.find((item) => item.founderId === founder.id);
      return {
        id: `founder:${founder.id}`,
        type: "founder" as const,
        label: founder.name,
        score: score?.totalScore ?? 0,
        review_state: score?.review_state ?? founder.review_state,
        radius: radiusForScore(score?.totalScore ?? 0, founderScoreValues, 18, 46),
        companyId: relation?.companyId
      };
    })
  ];
}

export function buildEdges(input: BuildGraphInput): GraphEdge[] {
  const founderEdges = input.companyFounders.map((relation) => ({
    id: `edge-founder-${relation.founderId}-${relation.companyId}`,
    source: `founder:${relation.founderId}`,
    target: `company:${relation.companyId}`,
    edgeType: "founder_of" as const,
    weight: relation.review_state === "verified" ? 1 : 0,
    explanation: {
      role: relation.role,
      sourceUrl: relation.sourceUrl,
      review_state: relation.review_state
    }
  }));

  const industryEdges: GraphEdge[] = [];
  for (let i = 0; i < input.companies.length; i += 1) {
    for (let j = i + 1; j < input.companies.length; j += 1) {
      const left = input.companies[i];
      const right = input.companies[j];
      const similarity = industrySimilarity(left, right);
      if (similarity >= 0.28) {
        industryEdges.push({
          id: `edge-industry-${left.id}-${right.id}`,
          source: `company:${left.id}`,
          target: `company:${right.id}`,
          edgeType: "industry_similarity",
          weight: similarity,
          explanation: {
            sharedIndustries: left.industries.filter((industry) => right.industries.includes(industry)),
            method: "tag_overlap_plus_text_token_jaccard"
          }
        });
      }
    }
  }

  const groupPartnerEdges: GraphEdge[] = [];
  for (let i = 0; i < input.companies.length; i += 1) {
    for (let j = i + 1; j < input.companies.length; j += 1) {
      const left = input.companies[i];
      const right = input.companies[j];
      if (
        left.groupPartner &&
        right.groupPartner &&
        left.groupPartner !== "Publicly Unknown" &&
        left.groupPartner === right.groupPartner
      ) {
        groupPartnerEdges.push({
          id: `edge-group-${left.id}-${right.id}`,
          source: `company:${left.id}`,
          target: `company:${right.id}`,
          edgeType: "same_group_partner",
          weight: 1,
          explanation: {
            groupPartner: left.groupPartner,
            rule: "Only created when a reliable public group partner value exists for both companies."
          }
        });
      }
    }
  }

  return [...founderEdges, ...industryEdges, ...groupPartnerEdges];
}

export function radiusForScore(score: number, sample: number[], min: number, max: number): number {
  if (sample.length === 0) return min;
  const sorted = [...sample].sort((a, b) => a - b);
  const rank = sorted.filter((value) => value <= score).length / sorted.length;
  return Math.round(min + (max - min) * rank);
}

export function industrySimilarity(left: Company, right: Company): number {
  const leftTags = new Set(left.industries.map(normalizeToken));
  const rightTags = new Set(right.industries.map(normalizeToken));
  const sharedTags = [...leftTags].filter((tag) => rightTags.has(tag)).length;
  const tagUnion = new Set([...leftTags, ...rightTags]).size || 1;
  const tagScore = sharedTags / tagUnion;
  const leftText = tokenize(`${left.tagline ?? ""} ${left.description ?? ""}`);
  const rightText = tokenize(`${right.tagline ?? ""} ${right.description ?? ""}`);
  const sharedText = [...leftText].filter((token) => rightText.has(token)).length;
  const textUnion = new Set([...leftText, ...rightText]).size || 1;
  const textScore = sharedText / textUnion;
  return Number((0.72 * tagScore + 0.28 * textScore).toFixed(3));
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2)
  );
}

function normalizeToken(value: string): string {
  return value.toLowerCase().trim();
}

function buildLeaderboard(
  companies: Company[],
  entityScores: EntityScore[],
  evidence: EvidenceItem[]
): LeaderboardRow[] {
  return companies
    .map((company) => {
      const score = entityScores.find((item) => item.entityType === "company" && item.entityId === company.id);
      const companyEvidence = evidence
        .filter((item) => item.entityId === company.id || founderIdsForCompany(company.id).includes(item.entityId))
        .sort((a, b) => b.contributionScore - a.contributionScore);
      const topPlatform = score?.platformScores.sort((a, b) => b.score - a.score)[0]?.platform ?? "web";
      return {
        rank: 0,
        companyId: company.id,
        company: company.name,
        score: score?.totalScore ?? 0,
        topPlatform,
        biggestContributingPost: companyEvidence[0]?.sourceUrl ?? company.websiteUrl ?? ""
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function buildFastestGaining(companies: Company[], entityScores: EntityScore[]): FastestGainingRow[] {
  return companies
    .map((company, index) => {
      const score = entityScores.find((item) => item.entityType === "company" && item.entityId === company.id);
      const syntheticPrevious = Math.max(1, (score?.totalScore ?? 0) - (10 - index * 2));
      const current = score?.totalScore ?? 0;
      const delta = current - syntheticPrevious;
      const topPlatform = score?.platformScores.sort((a, b) => b.score - a.score)[0]?.platform ?? "web";
      return {
        rank: 0,
        companyId: company.id,
        company: company.name,
        scoreDelta: Number(delta.toFixed(1)),
        percentDelta: Number(((delta / syntheticPrevious) * 100).toFixed(1)),
        rankDelta: index % 2 === 0 ? 2 : 1,
        newHighPerformingPosts: demoPosts
          .filter((post) => post.platform === topPlatform)
          .slice(0, 2)
          .map((post) => post.url),
        topPlatform
      };
    })
    .sort((a, b) => b.scoreDelta - a.scoreDelta)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function founderIdsForCompany(companyId: string): string[] {
  return demoCompanyFounders.filter((item) => item.companyId === companyId).map((item) => item.founderId);
}
