import { demoGraphDataset } from "./demo-data";
import { graphNodeMatchesSearchQuery } from "./search";
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
  ReviewState
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

export function buildGraphResponse(
  filters: GraphFilters = {},
  dataset: DemoGraphDataset = demoGraphDataset
): GraphResponse {
  const batch = resolveBatch(filters.batchSlug, dataset);
  const selectedPlatforms = normalizePlatforms(filters.platforms);
  const selectedEdgeTypes = normalizeEdgeTypes(filters.edgeTypes);
  const minScore = filters.minScore ?? 0;
  const selectedIndustries = normalizeStrings(filters.industries);
  const selectedGroupPartners = normalizeStrings(filters.groupPartners);
  const selectedBusinessModels = normalizeStrings(filters.businessModels);
  const query = filters.query?.trim().toLowerCase() ?? "";

  const batchCompanies = dataset.companies.filter((company) => company.batchSlug === batch.slug);
  const batchFounders = dataset.founders.filter((founder) => founder.batchSlug === batch.slug);
  const evidenceByEntity = indexEvidence(dataset.evidence, selectedPlatforms);

  const companyScores = batchCompanies.map((company) => company.totalScore);
  const foundersByCompany = groupFoundersByCompany(batchFounders);

  const nodes = batchCompanies.map((company) =>
    companyToNode(company, companyScores, evidenceByEntity, foundersByCompany.get(company.id) ?? [])
  ).filter((node) =>
    nodeMatchesFilters(node, {
      minScore,
      selectedIndustries,
      selectedGroupPartners,
      selectedBusinessModels,
      query,
      selectedPlatforms
    })
  );

  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const edges = buildGraphEdges(batchCompanies, batchFounders, {
    similarityThreshold: filters.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD
  }).filter(
    (edge) =>
      visibleNodeIds.has(edge.source) &&
      visibleNodeIds.has(edge.target) &&
      (!selectedEdgeTypes.length || selectedEdgeTypes.includes(edge.edgeType))
  );

  const visibleCompanyIds = new Set(
    nodes.filter((node) => node.entityType === "company").map((node) => node.entityId)
  );
  const visibleFounderIds = new Set(
    nodes.flatMap((node) => node.founders.map((founder) => founder.id))
  );
  const visibleEvidenceEntityIds = new Set([...visibleCompanyIds, ...visibleFounderIds]);
  const visibleEvidence = dataset.evidence
    .filter((item) => evidenceMatchesPlatforms(item, selectedPlatforms))
    .filter((item) => visibleEvidenceEntityIds.has(item.entityId))
    .sort((a, b) => b.contributionScore - a.contributionScore);

  const visibleCompanies = batchCompanies.filter((company) => visibleCompanyIds.has(company.id));

  return {
    batch,
    batches: dataset.batches,
    nodes,
    edges,
    leaderboard: buildLeaderboard(visibleCompanies, visibleEvidence),
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
    generatedAt: new Date().toISOString(),
    mode: dataset.mode ?? "demo"
  };
}

export function buildGraphEdges(
  companies: CompanyRecord[],
  _founders: FounderRecord[],
  options: { similarityThreshold?: number } = {}
): GraphEdge[] {
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  const similarityCandidates: GraphEdge[] = [];
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

  return [
    ...buildGroupPartnerEdges(companies),
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
    dataset.batches.find((batch) => batch.slug === "S2026") ??
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
  const companySocialAccounts = dedupeCompanyAccountsAgainstFounders(company.socialAccounts, founderSummaries);
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
    review_state_counts: reviewStateCounts
  };
}

function dedupeCompanyAccountsAgainstFounders(
  companyAccounts: CompanyRecord["socialAccounts"],
  founders: FounderSummary[]
): CompanyRecord["socialAccounts"] {
  const founderAccountKeys = new Set(
    founders.flatMap((founder) => founder.socialAccounts.map(canonicalSocialAccountKey))
  );
  const seen = new Set<string>();
  const deduped: CompanyRecord["socialAccounts"] = [];

  for (const account of companyAccounts) {
    const key = canonicalSocialAccountKey(account);
    if (founderAccountKeys.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(account);
  }

  return deduped;
}

function canonicalSocialAccountKey(account: CompanyRecord["socialAccounts"][number]): string {
  return `${account.platform}:${canonicalSocialAccountPart(account.url, account.handle)}`;
}

function canonicalSocialAccountPart(rawUrl: string, handle: string | null): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    if (url.hostname === "twitter.com" || url.hostname === "mobile.twitter.com") {
      url.hostname = "x.com";
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return String(handle ?? "")
      .toLowerCase()
      .replace(/^@/, "")
      .trim();
  }
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

function buildLeaderboard(companies: CompanyRecord[], evidence: EvidenceItem[]): LeaderboardRow[] {
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
      biggestContribution: evidenceByCompany.get(company.id)?.[0] ?? null
    }));
}

function buildFastestGaining(companies: CompanyRecord[]): FastestGainingRow[] {
  const currentRank = rankCompanies(companies, "totalScore");
  const previousRank = rankCompanies(companies, "previousScore");

  return [...companies]
    .sort((a, b) => b.totalScore - b.previousScore - (a.totalScore - a.previousScore))
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
        rank: index + 1,
        companyId: company.id,
        companyName: company.name,
        dod: delta,
        wow: delta
      };
    });
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
