import { YC_SPRING_2026_BATCH_SLUG, yc2026GraphDataset } from "./yc-spring-2026-dataset";
import { graphNodeMatchesSearchQuery } from "./search";
import { aggregateBalancedTractionScore } from "./traction-scoring";
import {
  matchEvidenceToTopVoice,
  resolveTopVoiceAudience,
  topVoiceAudienceSummaries
} from "../social/top-voices";
import type {
  CompanyRecord,
  DemoGraphDataset,
  EdgeType,
  EvidenceItem,
  FastestGainingRow,
  FounderRecord,
  FounderSummary,
  BusinessModel,
  GraphEdge,
  GraphFilters,
  GraphNode,
  GraphResponse,
  LeaderboardRow,
  MomentumDelta,
  NeedsReviewItem,
  Platform,
  ReviewState,
  TopVoiceAudienceId,
  TopVoiceAudienceSummary,
  TopVoiceConnectionPreview,
  TopVoiceMember
} from "./types";

const COMPANY_RADIUS = { min: 5, max: 68 };
const FOUNDER_RADIUS = { min: 4, max: 38 };
const DEFAULT_SIMILARITY_THRESHOLD = 0.28;
const MAX_SIMILARITY_EDGES = 140;
const MAX_SIMILARITY_EDGES_PER_COMPANY = 2;
const INDUSTRY_COLORS: Record<string, string> = {
  b2b: "#F6CA94",
  industrials: "#F09EA7",
  fintech: "#C7CAFF",
  healthcare: "#F6C2F3",
  consumer: "#FAFABE",
  "real estate and construction": "#CDABEB",
  government: "#C1EBC0"
};
const INDUSTRY_BORDER_COLORS: Record<string, string> = {
  b2b: "#9A4B00",
  industrials: "#A84A55",
  fintech: "#5661B8",
  healthcare: "#A14A9B",
  consumer: "#A39A27",
  "real estate and construction": "#7447A8",
  government: "#3E8A42"
};
const TOP_VOICE_ROLLUP_CACHE_LIMIT = 24;
const topVoiceRollupCache = new Map<string, Map<string, TopVoiceCompanyRollup>>();

export function clearTopVoiceRollupCache(): void {
  topVoiceRollupCache.clear();
}

export function buildGraphResponse(
  filters: GraphFilters = {},
  dataset: DemoGraphDataset = yc2026GraphDataset
): GraphResponse {
  const batch = resolveBatch(filters.batchSlug, dataset);
  const selectedPlatforms = normalizePlatforms(filters.platforms);
  const selectedEdgeTypes = normalizeEdgeTypes(filters.edgeTypes);
  const minScore = filters.minScore ?? 0;
  const selectedIndustries = normalizeStrings(filters.industries);
  const selectedGroupPartners = normalizeStrings(filters.groupPartners);
  const selectedBusinessModels = normalizeStrings(filters.businessModels);
  const query = filters.query?.trim().toLowerCase() ?? "";
  const topVoiceAudience = resolveTopVoiceAudience(filters.topVoices);
  const topVoiceMode = topVoiceAudience.summary.id !== "off";

  const baseBatchCompanies = dataset.companies.filter((company) => company.batchSlug === batch.slug);
  const batchFounders = dataset.founders.filter((founder) => founder.batchSlug === batch.slug);
  const topVoiceRollups = topVoiceMode
    ? buildTopVoiceRollups(
        baseBatchCompanies,
        batchFounders,
        dataset.evidence,
        selectedPlatforms,
        topVoiceAudience.summary.id,
        topVoiceAudience.members
      )
    : new Map<string, TopVoiceCompanyRollup>();
  const batchCompanies = topVoiceMode
    ? applyTopVoiceCompanyScores(baseBatchCompanies, topVoiceRollups, topVoiceAudience.summary)
    : baseBatchCompanies;
  const graphEvidence = topVoiceMode
    ? [...topVoiceRollups.values()].flatMap((rollup) => rollup.evidence)
    : dataset.evidence;
  const evidenceByEntity = indexEvidence(graphEvidence, selectedPlatforms);

  const companyScores = batchCompanies.map((company) => company.totalScore);
  const foundersByCompany = groupFoundersByCompany(batchFounders);

  const companyNodes = batchCompanies.map((company) =>
    companyToNode(company, companyScores, evidenceByEntity, foundersByCompany.get(company.id) ?? [])
  ).filter((node) =>
    (!topVoiceMode || (node.topVoiceConnectionCount ?? 0) > 0) &&
    nodeMatchesFilters(node, {
      minScore,
      selectedIndustries,
      selectedGroupPartners,
      selectedBusinessModels,
      query,
      selectedPlatforms
    })
  );

  const visibleCompanyIds = new Set(
    companyNodes.filter((node) => node.entityType === "company").map((node) => node.entityId)
  );
  const nodes = companyNodes;
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const visibleCompanies = batchCompanies.filter((company) => visibleCompanyIds.has(company.id));
  const edges = buildGraphEdges(visibleCompanies, batchFounders, {
    selectedEdgeTypes,
    similarityThreshold: filters.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD
  }).filter(
    (edge) =>
      visibleNodeIds.has(edge.source) &&
      visibleNodeIds.has(edge.target) &&
      (!selectedEdgeTypes.length || selectedEdgeTypes.includes(edge.edgeType))
  );

  const visibleFounderIds = new Set(
    companyNodes.flatMap((node) => node.founders.map((founder) => founder.id))
  );
  const visibleEvidenceEntityIds = new Set([...visibleCompanyIds, ...visibleFounderIds]);
  const visibleEvidence = graphEvidence
    .filter((item) => evidenceMatchesPlatforms(item, selectedPlatforms))
    .filter((item) => visibleEvidenceEntityIds.has(item.entityId))
    .sort((a, b) => b.contributionScore - a.contributionScore);

  return {
    batch,
    batches: dataset.batches,
    nodes,
    edges,
    leaderboard: buildLeaderboard(visibleCompanies, visibleEvidence, foundersByCompany),
    fastestGaining: buildFastestGaining(visibleCompanies),
    needsReview: [
      ...buildReviewItems(visibleCompanies, batchFounders, {
        visibleFounderIds,
        selectedPlatforms
      }),
      ...(dataset.needsReview ?? []).filter((item) =>
        platformSelected(item.platform, selectedPlatforms) &&
        (item.entityType === "company" ? visibleCompanyIds.has(item.entityId) : visibleFounderIds.has(item.entityId))
      )
    ],
    evidence: visibleEvidence,
    platformStatus: dataset.platformStatus,
    selectedTopVoiceAudience: topVoiceAudience.summary,
    topVoiceAudiences: topVoiceAudienceSummaries(),
    generatedAt: new Date().toISOString(),
    mode: dataset.mode ?? "demo"
  };
}

export function buildGraphEdges(
  companies: CompanyRecord[],
  _founders: FounderRecord[],
  options: { selectedEdgeTypes?: EdgeType[]; similarityThreshold?: number } = {}
): GraphEdge[] {
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const selectedEdgeTypes = options.selectedEdgeTypes ?? [];
  const includeSimilarity = !selectedEdgeTypes.length || selectedEdgeTypes.includes("industry_similarity");
  const includeGroupPartner = !selectedEdgeTypes.length || selectedEdgeTypes.includes("same_group_partner");

  const similarityCandidates: GraphEdge[] = [];
  if (includeSimilarity) {
    for (let i = 0; i < companies.length; i += 1) {
      for (let j = i + 1; j < companies.length; j += 1) {
        const source = companies[i];
        const target = companies[j];
        const similarity = scoreCompanySimilarity(source, target);

        if (similarity >= threshold) {
          similarityCandidates.push({
            id: `edge-industry-${source.id}-${target.id}`,
            source: nodeId("company", source.id),
            target: nodeId("company", target.id),
            edgeType: "industry_similarity",
            weight: round(similarity),
            label: "Industry similarity",
            explanation: `Shared tags or description terms produced a ${Math.round(
              similarity * 100
            )}% similarity score.`
          });
        }
      }
    }
  }

  return [
    ...(includeGroupPartner ? buildGroupPartnerEdges(companies) : []),
    ...limitSimilarityEdges(similarityCandidates)
  ];
}

export function getNodeRadius(
  score: number,
  peerScores: number[],
  entityType: "company" | "founder"
): number {
  const bounds = entityType === "company" ? COMPANY_RADIUS : FOUNDER_RADIUS;
  const percentile = scorePercentile(score, peerScores);
  return round(bounds.min + Math.pow(percentile, 2.2) * (bounds.max - bounds.min));
}

export function nodeId(entityType: "company" | "founder", id: string): string {
  return `${entityType}:${id}`;
}

function resolveBatch(batchSlug: string | undefined, dataset: DemoGraphDataset) {
  return (
    dataset.batches.find((batch) => batch.slug === batchSlug) ??
    dataset.batches.find((batch) => batch.slug === YC_SPRING_2026_BATCH_SLUG) ??
    dataset.batches[0]
  );
}

function normalizePlatforms(platforms: Platform[] | undefined): Platform[] {
  return [...new Set(platforms?.filter(Boolean) ?? [])];
}

function normalizeEdgeTypes(edgeTypes: EdgeType[] | undefined): EdgeType[] {
  return [...new Set(edgeTypes?.filter(Boolean) ?? [])];
}

function normalizeStrings<T extends string>(items: T[] | undefined): T[] {
  return [...new Set(items?.filter(Boolean) ?? [])];
}

function indexEvidence(evidence: EvidenceItem[], platforms: Platform[]) {
  const index = new Map<string, EvidenceItem[]>();

  for (const item of evidence) {
    if (!evidenceMatchesPlatforms(item, platforms)) {
      continue;
    }

    const key = entityKey(item.entityType, item.entityId);
    const current = index.get(key) ?? [];
    current.push(item);
    index.set(key, current);
  }

  return index;
}

function entityKey(entityType: "company" | "founder", id: string): string {
  return `${entityType}:${id}`;
}

function groupFoundersByCompany(founders: FounderRecord[]): Map<string, FounderRecord[]> {
  const grouped = new Map<string, FounderRecord[]>();

  for (const founder of founders) {
    for (const companyId of founder.companyIds) {
      grouped.set(companyId, [...(grouped.get(companyId) ?? []), founder]);
    }
  }

  return grouped;
}

function companyToNode(
  company: CompanyRecord,
  peerScores: number[],
  evidenceByEntity: Map<string, EvidenceItem[]>,
  founders: FounderRecord[]
): GraphNode {
  const companyEvidence = evidenceByEntity.get(entityKey("company", company.id)) ?? [];
  const founderSummaries = founders.map((founder) => founderSummary(founder, evidenceByEntity));
  const companySocialAccounts = company.socialAccounts;
  const reviewStateCounts = countReviewStates(companySocialAccounts);
  const evidenceIds = [
    ...companyEvidence.map((item) => item.id),
    ...founderSummaries.flatMap((founder) => founder.evidenceIds)
  ];

  return {
    id: nodeId("company", company.id),
    entityType: "company",
    entityId: company.id,
    label: company.name,
    batchSlug: company.batchSlug,
    score: company.totalScore,
    previousScore: company.previousScore,
    scoreDelta: round(company.totalScore - company.previousScore),
    radius: getNodeRadius(company.totalScore, peerScores, "company"),
    topPlatform: getWeightedTopPlatform(company),
    platformScores: company.platformScores,
    scoreBreakdown: company.scoreBreakdown,
    socialAccounts: companySocialAccounts,
    evidenceIds,
    ycProfileUrl: company.ycProfileUrl,
    websiteUrl: company.websiteUrl,
    tagline: company.tagline,
    description: company.description,
    groupPartner: company.groupPartner,
    primaryIndustry: company.primaryIndustry,
    businessModel: company.businessModel,
    review_state: company.review_state,
    sourceUrl: company.sourceUrl,
    visual: visualFor(company.primaryIndustry, company.businessModel, company.groupPartner),
    industries: company.industries,
    relatedEntityIds: company.founderIds,
    founders: founderSummaries,
    review_state_counts: reviewStateCounts,
    topVoiceScore: company.topVoiceScore,
    topVoiceConnectionCount: company.topVoiceConnectionCount,
    topVoiceConnections: company.topVoiceConnections,
    selectedTopVoiceAudience: company.selectedTopVoiceAudience
  };
}

function founderSummary(founder: FounderRecord, evidenceByEntity: Map<string, EvidenceItem[]>): FounderSummary {
  return {
    ycProfileUrl: founder.ycProfileUrl,
    id: founder.id,
    name: founder.name,
    socialAccounts: founder.socialAccounts,
    evidenceIds: (evidenceByEntity.get(entityKey("founder", founder.id)) ?? []).map((item) => item.id),
    platformScores: founder.platformScores
  };
}

function nodeMatchesFilters(
  node: GraphNode,
  filters: {
    minScore: number;
    selectedIndustries: string[];
    selectedGroupPartners: string[];
    selectedBusinessModels: BusinessModel[];
    query: string;
    selectedPlatforms: Platform[];
  }
): boolean {
  if (node.score < filters.minScore) {
    return false;
  }

  if (filters.selectedIndustries.length && !filters.selectedIndustries.includes(node.primaryIndustry)) {
    return false;
  }

  if (filters.selectedGroupPartners.length && (!node.groupPartner || !filters.selectedGroupPartners.includes(node.groupPartner))) {
    return false;
  }

  if (filters.selectedBusinessModels.length && !filters.selectedBusinessModels.includes(node.businessModel)) {
    return false;
  }

  if (filters.query) {
    if (!graphNodeMatchesSearchQuery(node, filters.query)) {
      return false;
    }
  }

  if (filters.selectedPlatforms.length) {
    const nodePlatforms = new Set([
      ...Object.keys(node.platformScores),
      ...node.socialAccounts.map((account) => account.platform),
      ...node.founders.flatMap((founder) => Object.keys(founder.platformScores)),
      ...node.founders.flatMap((founder) => founder.socialAccounts.map((account) => account.platform))
    ]);
    return filters.selectedPlatforms.some((platform) => nodePlatforms.has(platform));
  }

  return true;
}

function buildLeaderboard(
  companies: CompanyRecord[],
  evidence: EvidenceItem[],
  foundersByCompany: Map<string, FounderRecord[]>
): LeaderboardRow[] {
  const evidenceByCompany = groupCompanyRollupEvidence(
    companies,
    evidence.filter((item) => item.contributionScore > 0)
  );

  return [...companies]
    .sort((a, b) => b.totalScore - a.totalScore)
    .map((company, index) => ({
      rank: index + 1,
      companyId: company.id,
      companyName: company.name,
      score: company.totalScore,
      topPlatform: getWeightedTopPlatform(company),
      socialAccounts: company.socialAccounts,
      founderAccounts: (foundersByCompany.get(company.id) ?? []).map((founder) => ({
        founderId: founder.id,
        founderName: founder.name,
        socialAccounts: founder.socialAccounts
      })),
      biggestContribution: evidenceByCompany.get(company.id)?.[0] ?? null,
      topVoiceScore: company.topVoiceScore,
      topVoiceConnectionCount: company.topVoiceConnectionCount,
      topVoiceConnections: company.topVoiceConnections
    }));
}

interface TopVoiceCompanyRollup {
  companyId: string;
  evidence: EvidenceItem[];
  connections: TopVoiceConnectionPreview[];
}

function buildTopVoiceRollups(
  companies: CompanyRecord[],
  founders: FounderRecord[],
  evidence: EvidenceItem[],
  platforms: Platform[],
  audienceId: TopVoiceAudienceId,
  members: TopVoiceMember[]
): Map<string, TopVoiceCompanyRollup> {
  const cacheKey = topVoiceRollupCacheKey(companies, evidence, platforms, audienceId, members);
  const cached = topVoiceRollupCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const companyIdByEntityId = new Map<string, string>();
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const foundersByCompany = groupFoundersByCompany(founders);
  for (const company of companies) {
    companyIdByEntityId.set(company.id, company.id);
    for (const founderId of company.founderIds) {
      companyIdByEntityId.set(founderId, company.id);
    }
  }

  const rollups = new Map<string, TopVoiceCompanyRollup>();
  const connectionByCompanyAndMember = new Map<string, TopVoiceConnectionPreview & { evidenceIds: string[] }>();

  for (const item of evidence) {
    if (!evidenceMatchesPlatforms(item, platforms)) {
      continue;
    }

    const companyId = companyIdByEntityId.get(item.entityId);
    if (!companyId) {
      continue;
    }
    const company = companyById.get(companyId);
    if (!company || !isEligibleTopVoiceEvidence(item, company, foundersByCompany.get(companyId) ?? [])) {
      continue;
    }

    const match = matchEvidenceToTopVoice(item, audienceId, members);
    if (!match) {
      continue;
    }

    const weightedEvidence = applyTopVoiceWeight(item, {
      audienceId,
      member: match.member,
      matchedBy: match.matchedBy
    });
    const rollup = rollups.get(companyId) ?? { companyId, evidence: [], connections: [] };
    rollup.evidence.push(weightedEvidence);
    rollups.set(companyId, rollup);

    const connectionKey = `${companyId}:${match.member.personId}`;
    const connection = connectionByCompanyAndMember.get(connectionKey) ?? {
      memberId: match.member.personId,
      displayName: match.member.displayName,
      category: match.member.category,
      weight: match.member.weight,
      contributionScore: 0,
      evidenceCount: 0,
      topEvidenceId: null,
      platforms: [],
      evidenceIds: []
    };
    connection.contributionScore = round(connection.contributionScore + weightedEvidence.contributionScore);
    connection.evidenceCount += 1;
    connection.platforms = [...new Set([...connection.platforms, weightedEvidence.platform])];
    connection.evidenceIds.push(weightedEvidence.id);
    const currentTopEvidence = rollup.evidence.find((candidate) => candidate.id === connection.topEvidenceId);
    if (!currentTopEvidence || weightedEvidence.contributionScore > currentTopEvidence.contributionScore) {
      connection.topEvidenceId = weightedEvidence.id;
    }
    connectionByCompanyAndMember.set(connectionKey, connection);
  }

  for (const [companyId, rollup] of rollups) {
    rollup.evidence.sort((a, b) => b.contributionScore - a.contributionScore);
    rollup.connections = [...connectionByCompanyAndMember.entries()]
      .filter(([key]) => key.startsWith(`${companyId}:`))
      .map(([, connection]) => ({
        memberId: connection.memberId,
        displayName: connection.displayName,
        category: connection.category,
        weight: connection.weight,
        contributionScore: round(connection.contributionScore),
        evidenceCount: connection.evidenceCount,
        topEvidenceId: connection.topEvidenceId,
        platforms: connection.platforms.sort()
      }))
      .sort((a, b) => b.contributionScore - a.contributionScore || a.displayName.localeCompare(b.displayName));
    rollups.set(companyId, rollup);
  }

  topVoiceRollupCache.set(cacheKey, rollups);
  if (topVoiceRollupCache.size > TOP_VOICE_ROLLUP_CACHE_LIMIT) {
    const oldestKey = topVoiceRollupCache.keys().next().value;
    if (oldestKey) {
      topVoiceRollupCache.delete(oldestKey);
    }
  }

  return rollups;
}

function topVoiceRollupCacheKey(
  companies: CompanyRecord[],
  evidence: EvidenceItem[],
  platforms: Platform[],
  audienceId: TopVoiceAudienceId,
  members: TopVoiceMember[]
): string {
  return [
    companies[0]?.batchSlug ?? "unknown-batch",
    audienceId,
    platforms.length ? [...platforms].sort().join(",") : "all-platforms",
    companies.length,
    evidence.length,
    evidenceSignature(evidence),
    members.map((member) => member.personId).join(",")
  ].join("::");
}

function evidenceSignature(evidence: EvidenceItem[]): string {
  return hashString(
    evidence
      .map((item) => [
        item.id,
        item.entityId,
        item.platform,
        item.sourceUrl,
        item.platformPostId ?? "",
        item.contributionScore,
        item.last_checked_at ?? "",
        item.last_updated_at ?? "",
        item.rawVisibleText ? item.rawVisibleText.length : 0
      ].join("|"))
      .sort()
      .join("::")
  );
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return Math.abs(hash).toString(36);
}

function applyTopVoiceWeight(
  item: EvidenceItem,
  input: { audienceId: TopVoiceAudienceId; member: TopVoiceMember; matchedBy: string }
): EvidenceItem {
  const topVoice: EvidenceItem["topVoice"] = {
    audienceId: input.audienceId,
    memberId: input.member.personId,
    displayName: input.member.displayName,
    category: input.member.category,
    weight: input.member.weight,
    matchedBy: input.matchedBy,
    originalContributionScore: item.contributionScore
  };

  return {
    ...item,
    contributionScore: round(Math.min(100, item.contributionScore * input.member.weight)),
    why: `${item.why} Top Voices matched ${input.member.displayName} by ${input.matchedBy} at ${input.member.weight}x weight.`,
    topVoice
  };
}

function applyTopVoiceCompanyScores(
  companies: CompanyRecord[],
  rollups: Map<string, TopVoiceCompanyRollup>,
  audience: TopVoiceAudienceSummary
): CompanyRecord[] {
  return companies.map((company) => {
    const rollup = rollups.get(company.id);
    const scoreBreakdown = aggregateBalancedTractionScore(rollup?.evidence ?? []);
    const topVoiceScore = Math.min(100, Math.max(0, Math.round(scoreBreakdown.totalScore)));
    const topVoiceScoreBreakdown = {
      ...scoreBreakdown,
      totalScore: topVoiceScore,
      explanation:
        topVoiceScore > 0
          ? `${scoreBreakdown.explanation} Filtered to ${audience.displayName}.`
          : `No scored evidence from ${audience.displayName}.`
    };

    return {
      ...company,
      totalScore: topVoiceScore,
      previousScore: topVoiceScore,
      platformScores: topVoiceScoreBreakdown.platformScores,
      scoreBreakdown: topVoiceScoreBreakdown,
      topVoiceScore,
      topVoiceConnectionCount: rollup?.connections.length ?? 0,
      topVoiceConnections: rollup?.connections.slice(0, 8) ?? [],
      selectedTopVoiceAudience: audience
    };
  });
}

function isEligibleTopVoiceEvidence(item: EvidenceItem, company: CompanyRecord, founders: FounderRecord[]): boolean {
  return (
    hasPostLevelUrl(item) &&
    hasVisibleMetrics(item) &&
    !isRepostLikeTopVoiceEvidence(item) &&
    topVoiceEvidenceMentionsTarget(item, company, founders)
  );
}

function isRepostLikeTopVoiceEvidence(item: EvidenceItem): boolean {
  if (item.platform !== "x") {
    return false;
  }

  const raw = String(item.rawVisibleText ?? "");
  const visibleText = [item.title, item.text, raw].filter(Boolean).join("\n").trim();
  if (/^RT\s+@/i.test(visibleText) || /\b(?:retweeted|reposted)\b/i.test(raw)) {
    return true;
  }

  if (raw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const post = parsed.post && typeof parsed.post === "object" ? parsed.post as Record<string, unknown> : parsed;
      return Boolean(
        post.is_retweet === true ||
          post.retweeted_status ||
          post.retweeted_tweet ||
          post.retweet ||
          post.reposted_tweet
      );
    } catch {
      return false;
    }
  }

  return false;
}

function hasPostLevelUrl(item: EvidenceItem): boolean {
  if (!item.sourceUrl) {
    return false;
  }

  try {
    const url = new URL(item.sourceUrl);
    const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean).map((part) => part.toLowerCase());

    if (hostname === "x.com" || hostname === "twitter.com") {
      return parts.includes("status") && Boolean(item.platformPostId ?? parts.at(-1));
    }
    if (hostname.endsWith("linkedin.com")) {
      return parts.includes("posts") || parts.includes("feed") || parts.includes("pulse") || item.sourceUrl.includes("urn:li:activity");
    }
    if (hostname.endsWith("reddit.com")) {
      return parts.includes("comments");
    }
    if (hostname.endsWith("youtube.com") || hostname === "youtu.be") {
      return hostname === "youtu.be" || url.searchParams.has("v") || parts.includes("shorts");
    }
  } catch {
    return false;
  }

  return Boolean(item.platformPostId);
}

function hasVisibleMetrics(item: EvidenceItem): boolean {
  return Object.values(item.metrics).some((value) => Number.isFinite(value) && Number(value) > 0);
}

function topVoiceEvidenceMentionsTarget(item: EvidenceItem, company: CompanyRecord, founders: FounderRecord[]): boolean {
  const haystack = normalizeSearchText([
    item.title,
    item.text,
    visibleRawText(item.rawVisibleText)
  ].filter(Boolean).join(" "));
  if (!haystack) {
    return false;
  }

  return topVoiceTargetTerms(company, founders).some((term) => containsSearchTerm(haystack, term));
}

function topVoiceTargetTerms(company: CompanyRecord, founders: FounderRecord[]): string[] {
  return uniqueStrings([
    company.name,
    company.websiteUrl ? domainToken(company.websiteUrl) : null,
    ...company.socialAccounts.map((account) => account.handle),
    ...founders.map((founder) => founder.name),
    ...founders.flatMap((founder) => founder.socialAccounts.map((account) => account.handle))
  ].filter((value): value is string => Boolean(value)))
    .map(normalizeSearchText)
    .filter((term) => term.length >= 4);
}

function visibleRawText(rawVisibleText: string | undefined): string {
  if (!rawVisibleText) {
    return "";
  }
  if (!rawVisibleText.trim().startsWith("{")) {
    return rawVisibleText;
  }
  try {
    const parsed = JSON.parse(rawVisibleText) as Record<string, unknown>;
    const post = recordValue(parsed.post);
    const detail = recordValue(parsed.detail);
    const profile = recordValue(parsed.profile);
    return [
      typeof parsed.rawText === "string" ? parsed.rawText : null,
      typeof parsed.text === "string" ? parsed.text : null,
      typeof post?.rawText === "string" ? post.rawText : null,
      typeof post?.text === "string" ? post.text : null,
      typeof post?.caption === "string" ? post.caption : null,
      typeof detail?.rawText === "string" ? detail.rawText : null,
      typeof detail?.caption === "string" ? detail.caption : null,
      typeof profile?.name === "string" ? profile.name : null,
      typeof profile?.username === "string" ? profile.username : null
    ].filter(Boolean).join(" ");
  } catch {
    return rawVisibleText;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function domainToken(rawUrl: string): string | null {
  try {
    const hostname = new URL(rawUrl).hostname.replace(/^www\./, "");
    return hostname.split(".")[0] ?? null;
  } catch {
    return null;
  }
}

function containsSearchTerm(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^| )${escaped}($| )`).test(haystack);
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/https?:\/\/(www\.)?/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildFastestGaining(companies: CompanyRecord[]): FastestGainingRow[] {
  const currentRank = rankCompanies(companies, "totalScore");
  const previousRank = rankCompanies(companies, "previousScore");

  return companies
    .map((company, index) => {
      const currentRankValue = currentRank.get(company.id) ?? index + 1;
      const baselineRank = previousRank.get(company.id) ?? index + 1;
      const delta = momentumDelta({
        currentScore: company.totalScore,
        currentRank: currentRankValue,
        baselineScore: company.previousScore,
        baselineRank,
        benchmarkedAt: null
      });
      return {
        rank: 0,
        companyId: company.id,
        companyName: company.name,
        dod: delta,
        wow: delta
      };
    })
    .sort((left, right) => {
      const leftDelta = left.dod;
      const rightDelta = right.dod;
      return (
        rightDelta.scoreDelta - leftDelta.scoreDelta ||
        rightDelta.percentDelta - leftDelta.percentDelta ||
        rightDelta.rankDelta - leftDelta.rankDelta ||
        rightDelta.currentScore - leftDelta.currentScore ||
        left.companyName.localeCompare(right.companyName)
      );
    })
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function momentumDelta(input: {
  currentScore: number;
  currentRank: number;
  baselineScore: number | null;
  baselineRank: number | null;
  benchmarkedAt: string | null;
}): MomentumDelta {
  const baselineScore = input.baselineScore;
  const baselineRank = input.baselineRank;
  const scoreDelta = baselineScore === null ? 0 : round(input.currentScore - baselineScore);
  const percentDelta = baselineScore === null ? 0 : round((scoreDelta / Math.max(baselineScore, 1)) * 100);
  const rankDelta = baselineRank === null ? 0 : baselineRank - input.currentRank;

  return {
    scoreDelta,
    percentDelta,
    rankDelta,
    currentScore: input.currentScore,
    currentRank: input.currentRank,
    baselineScore,
    baselineRank,
    benchmarkedAt: input.benchmarkedAt
  };
}

function buildReviewItems(
  companies: CompanyRecord[],
  founders: FounderRecord[],
  options: { visibleFounderIds: Set<string>; selectedPlatforms: Platform[] }
): NeedsReviewItem[] {
  const reviewItems: NeedsReviewItem[] = [];

  for (const company of companies) {
    for (const account of company.socialAccounts) {
      if (account.review_state === "verified" || !platformSelected(account.platform, options.selectedPlatforms)) {
        continue;
      }

      reviewItems.push({
        id: `review-${account.id}`,
        entityType: "company",
        entityId: company.id,
        entityName: company.name,
        platform: account.platform,
        candidateUrl: account.url,
        review_state: account.review_state,
        matchReason: account.matchReason
      });
    }
  }

  for (const founder of founders) {
    if (!options.visibleFounderIds.has(founder.id)) {
      continue;
    }

    for (const account of founder.socialAccounts) {
      if (account.review_state === "verified" || !platformSelected(account.platform, options.selectedPlatforms)) {
        continue;
      }

      reviewItems.push({
        id: `review-${account.id}`,
        entityType: "founder",
        entityId: founder.id,
        entityName: founder.name,
        platform: account.platform,
        candidateUrl: account.url,
        review_state: account.review_state,
        matchReason: account.matchReason
      });
    }
  }

  const statePriority: Record<ReviewState, number> = {
    needs_review: 0,
    rejected: 1,
    verified: 2
  };

  return reviewItems.sort(
    (a, b) =>
      statePriority[a.review_state] - statePriority[b.review_state] ||
      a.entityName.localeCompare(b.entityName)
  );
}

function rankCompanies(companies: CompanyRecord[], field: "totalScore" | "previousScore") {
  return new Map(
    [...companies]
      .sort((a, b) => b[field] - a[field])
      .map((company, index) => [company.id, index + 1])
  );
}

function groupEvidenceByEntity(evidence: EvidenceItem[], entityType: "company" | "founder") {
  const grouped = new Map<string, EvidenceItem[]>();

  for (const item of evidence.filter((candidate) => candidate.entityType === entityType)) {
    const current = grouped.get(item.entityId) ?? [];
    current.push(item);
    current.sort((a, b) => b.contributionScore - a.contributionScore);
    grouped.set(item.entityId, current);
  }

  return grouped;
}

function groupCompanyRollupEvidence(companies: CompanyRecord[], evidence: EvidenceItem[]): Map<string, EvidenceItem[]> {
  const grouped = new Map<string, EvidenceItem[]>();

  for (const company of companies) {
    const allowedEntityIds = new Set([company.id, ...company.founderIds]);
    grouped.set(
      company.id,
      evidence
        .filter((item) => allowedEntityIds.has(item.entityId))
        .sort((a, b) => b.contributionScore - a.contributionScore)
    );
  }

  return grouped;
}

function evidenceMatchesPlatforms(item: EvidenceItem, platforms: Platform[]): boolean {
  return platformSelected(item.platform, platforms);
}

function platformSelected(platform: Platform, selectedPlatforms: Platform[]): boolean {
  return !selectedPlatforms.length || selectedPlatforms.includes(platform);
}

function countReviewStates(accounts: Array<{ review_state: ReviewState }>): Record<ReviewState, number> {
  return accounts.reduce<Record<ReviewState, number>>(
    (counts, account) => ({
      ...counts,
      [account.review_state]: counts[account.review_state] + 1
    }),
    { verified: 0, needs_review: 0, rejected: 0 }
  );
}

function getTopPlatform(platformScores: Partial<Record<Platform, number>>): Platform | null {
  const entries = Object.entries(platformScores) as [Platform, number][];
  if (!entries.length) {
    return null;
  }

  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

function getWeightedTopPlatform(company: CompanyRecord): Platform | null {
  return company.scoreBreakdown?.weightedPlatforms[0]?.platform ?? getTopPlatform(company.platformScores);
}

function scorePercentile(score: number, peerScores: number[]): number {
  if (peerScores.length <= 1) {
    return 0.5;
  }

  const min = Math.min(...peerScores);
  const max = Math.max(...peerScores);

  if (max === min) {
    return 0.5;
  }

  return (score - min) / (max - min);
}

function scoreCompanySimilarity(source: CompanyRecord, target: CompanyRecord): number {
  const industrySimilarity = jaccard(source.industries, target.industries);
  const sourceTokens = tokenize(`${source.tagline} ${source.description}`);
  const targetTokens = tokenize(`${target.tagline} ${target.description}`);
  const descriptionSimilarity = jaccard(sourceTokens, targetTokens);

  return round(industrySimilarity * 0.75 + descriptionSimilarity * 0.25);
}

function limitSimilarityEdges(candidates: GraphEdge[]): GraphEdge[] {
  const perCompany = new Map<string, number>();
  const limited: GraphEdge[] = [];

  for (const candidate of [...candidates].sort((a, b) => b.weight - a.weight)) {
    const sourceCount = perCompany.get(candidate.source) ?? 0;
    const targetCount = perCompany.get(candidate.target) ?? 0;

    if (
      limited.length >= MAX_SIMILARITY_EDGES ||
      sourceCount >= MAX_SIMILARITY_EDGES_PER_COMPANY ||
      targetCount >= MAX_SIMILARITY_EDGES_PER_COMPANY
    ) {
      continue;
    }

    limited.push(candidate);
    perCompany.set(candidate.source, sourceCount + 1);
    perCompany.set(candidate.target, targetCount + 1);
  }

  return limited;
}

function buildGroupPartnerEdges(companies: CompanyRecord[]): GraphEdge[] {
  const grouped = new Map<string, CompanyRecord[]>();

  for (const company of companies) {
    if (!company.groupPartner) {
      continue;
    }
    grouped.set(company.groupPartner, [...(grouped.get(company.groupPartner) ?? []), company]);
  }

  return [...grouped.entries()].flatMap(([groupPartner, groupCompanies]) =>
    [...groupCompanies]
      .sort((a, b) => b.totalScore - a.totalScore || a.name.localeCompare(b.name))
      .slice(1)
      .map((company, index, sortedTail) => {
        const sortedCompanies = [
          [...groupCompanies].sort((a, b) => b.totalScore - a.totalScore || a.name.localeCompare(b.name))[0],
          ...sortedTail
        ];
        const source = sortedCompanies[index];
        const target = company;

        return {
          id: `edge-group-partner-${source.id}-${target.id}`,
          source: nodeId("company", source.id),
          target: nodeId("company", target.id),
          edgeType: "same_group_partner" as const,
          weight: 0.86,
          label: "Same group partner",
          explanation: `Both public records list YC group partner ${groupPartner}.`
        };
      })
  );
}

function jaccard(sourceValues: string[], targetValues: string[]): number {
  const sourceSet = new Set(sourceValues.map((value) => value.toLowerCase()));
  const targetSet = new Set(targetValues.map((value) => value.toLowerCase()));
  const intersection = [...sourceSet].filter((value) => targetSet.has(value)).length;
  const union = new Set([...sourceSet, ...targetSet]).size;

  return union ? intersection / union : 0;
}

function tokenize(text: string): string[] {
  const stopWords = new Set([
    "and",
    "the",
    "for",
    "with",
    "that",
    "from",
    "into",
    "teams",
    "company",
    "builds",
    "gives"
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function visualFor(primaryIndustry: string, _businessModel: BusinessModel, groupPartner: string | null) {
  return {
    industryColor: clusterColor(primaryIndustry),
    shape: "ellipse" as const,
    borderStyle: "solid" as const,
    borderColor: clusterBorderColor(primaryIndustry),
    groupRegion: groupPartner
  };
}

function clusterColor(value: string): string {
  const key = value.trim().toLowerCase();
  if (INDUSTRY_COLORS[key]) {
    return INDUSTRY_COLORS[key];
  }

  const palette = [
    "#F09EA7",
    "#F6CA94",
    "#FAFABE",
    "#C1EBC0",
    "#C7CAFF",
    "#CDABEB",
    "#F6C2F3"
  ];
  let hash = 0;
  for (const char of key) {
    hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  }
  return palette[Math.abs(hash) % palette.length];
}

function clusterBorderColor(value: string): string {
  const key = value.trim().toLowerCase();
  return INDUSTRY_BORDER_COLORS[key] ?? "#5b6472";
}
