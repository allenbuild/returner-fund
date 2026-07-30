import type {
  EvidenceItem,
  GraphNode,
  GraphResponse,
  LeaderboardRow,
  Platform,
  TopVoiceConnectionPreview,
  TopVoiceMember
} from "./types";
import { applyInsiderScenarioScoring } from "./insider-scoring";
import { matchEvidenceToTopVoice } from "@/lib/social/top-voices";
import {
  effectiveInsiderMembers,
  type UserInsiderConfiguration
} from "@/lib/social/user-insiders";

/**
 * Rebuilds the small, user-specific Insider graph from published snapshots.
 *
 * Request-time personalization must not import the full source datasets: those
 * files are tens of megabytes and make a serverless graph function fail before
 * it can handle a request. The daily ingestion publisher has already performed
 * the expensive attribution and scoring work. This function reuses that
 * canonical result, applies the user's enabled members and weights, and only
 * scans the canonical base snapshot for evidence belonging to newly-added
 * members.
 */
export function personalizeInsiderGraphSnapshot(input: {
  insiderGraph: GraphResponse;
  baseGraph: GraphResponse;
  configuration: UserInsiderConfiguration;
  selectedInsiderIds?: string[];
}): GraphResponse {
  const members = effectiveInsiderMembers(input.configuration);
  const selectedInsiderIds = unique(input.selectedInsiderIds ?? []);
  const selected = new Set(selectedInsiderIds);
  const enabledMembers = selected.size
    ? members.filter((member) => selected.has(member.personId))
    : members;
  const enabledMemberById = new Map(
    enabledMembers.map((member) => [member.personId, member])
  );
  const companyIdByEntityId = companyIdIndex(input.baseGraph);
  const baseCompanyById = new Map(
    input.baseGraph.nodes
      .filter((node) => node.entityType === "company")
      .map((node) => [node.entityId, node])
  );
  const insiderCompanyById = new Map(
    input.insiderGraph.nodes
      .filter((node) => node.entityType === "company")
      .map((node) => [node.entityId, node])
  );
  const baseRowByCompany = new Map(
    input.baseGraph.leaderboard.map((row) => [row.companyId, row])
  );
  const insiderRowByCompany = new Map(
    input.insiderGraph.leaderboard.map((row) => [row.companyId, row])
  );

  const evidenceById = new Map<string, EvidenceItem>();
  for (const item of input.insiderGraph.evidence) {
    const memberId = item.topVoice?.memberId;
    if (!memberId) continue;
    const member = enabledMemberById.get(memberId);
    if (!member) continue;
    evidenceById.set(item.id, withMemberAttribution(item, member));
  }

  const addedMembers = enabledMembers.filter((member) => member.source === "user-added");
  if (addedMembers.length) {
    for (const item of input.baseGraph.evidence) {
      if (evidenceById.has(item.id) || !eligibleStoredEvidence(item, input.baseGraph, companyIdByEntityId)) {
        continue;
      }
      const match = matchEvidenceToTopVoice(item, "insiders", addedMembers);
      if (!match) continue;
      evidenceById.set(
        item.id,
        withMemberAttribution(item, match.member, match.matchedBy)
      );
    }
  }

  const evidence = [...evidenceById.values()].sort(
    (left, right) =>
      right.contributionScore - left.contributionScore ||
      left.id.localeCompare(right.id)
  );
  const grouped = groupEvidenceByCompanyAndMember(
    evidence,
    companyIdByEntityId,
    enabledMemberById
  );
  const visibleCompanyIds = new Set(grouped.keys());
  const nodes = [...visibleCompanyIds]
    .map((companyId) => {
      const source = insiderCompanyById.get(companyId) ?? baseCompanyById.get(companyId);
      if (!source) return null;
      const companyEvidence = groupedEvidence(grouped.get(companyId));
      return withCompanyAudience(
        source,
        companyEvidence,
        buildConnections(grouped.get(companyId), enabledMemberById),
        input.insiderGraph
      );
    })
    .filter((node): node is GraphNode => Boolean(node));
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const leaderboard = nodes.map((node) => {
    const source = insiderRowByCompany.get(node.entityId) ?? baseRowByCompany.get(node.entityId);
    return withLeaderboardAudience(
      source ?? fallbackLeaderboardRow(node),
      groupedEvidence(grouped.get(node.entityId)),
      node.topVoiceConnections ?? []
    );
  });
  const selectedAudience = {
    ...input.insiderGraph.selectedTopVoiceAudience,
    memberCount: enabledMembers.length
  };
  const personalizedBase: GraphResponse = {
    ...input.insiderGraph,
    nodes: nodes.map((node) => ({
      ...node,
      selectedTopVoiceAudience: selectedAudience
    })),
    edges: input.baseGraph.edges.filter(
      (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
    ),
    leaderboard,
    fastestGaining: input.baseGraph.fastestGaining.filter((row) =>
      visibleCompanyIds.has(row.companyId)
    ),
    needsReview: [],
    evidence,
    selectedTopVoiceAudience: selectedAudience,
    topVoiceAudiences: input.insiderGraph.topVoiceAudiences.map((audience) =>
      audience.id === "insiders" ? selectedAudience : audience
    ),
    insiderFilterOptions: members.map((member) => ({
      memberId: member.personId,
      displayName: member.displayName,
      weight: member.weight
    })),
    selectedInsiderIds,
    insiderConfigurationVersion: input.configuration.version,
    generatedAt: new Date().toISOString()
  };

  return applyInsiderScenarioScoring(personalizedBase, {
    selectedInsiderIds,
    configurationVersion: input.configuration.version,
    publishedInsiderGraph: input.insiderGraph
  });
}

function companyIdIndex(graph: GraphResponse): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.entityType !== "company") continue;
    index.set(node.entityId, node.entityId);
    for (const founder of node.founders) index.set(founder.id, node.entityId);
  }
  return index;
}

function withMemberAttribution(
  item: EvidenceItem,
  member: TopVoiceMember,
  matchedBy = item.topVoice?.matchedBy ?? "stored native identity"
): EvidenceItem {
  return {
    ...item,
    topVoice: {
      audienceId: "insiders",
      memberId: member.personId,
      displayName: member.displayName,
      category: member.category,
      weight: member.weight,
      matchedBy,
      originalContributionScore:
        item.topVoice?.originalContributionScore ?? item.contributionScore
    }
  };
}

function eligibleStoredEvidence(
  item: EvidenceItem,
  graph: GraphResponse,
  companyIdByEntityId: Map<string, string>
): boolean {
  if (
    item.contributionScore <= 0 ||
    item.review_state !== "verified" ||
    !hasVisibleMetrics(item) ||
    !hasPostLevelUrl(item) ||
    isRepostLikeEvidence(item)
  ) {
    return false;
  }
  const companyId = item.attachedCompanyId ?? companyIdByEntityId.get(item.entityId);
  if (!companyId) return false;
  const company = graph.nodes.find(
    (node) => node.entityType === "company" && node.entityId === companyId
  );
  if (!company) return false;
  return (
    hasValidClaimedDirectReplyTarget(item, company) &&
    mentionsCompanyOrFounder(item, company)
  );
}

function hasVisibleMetrics(item: EvidenceItem): boolean {
  return Object.values(item.metrics).some(
    (value) => Number.isFinite(value) && Number(value) > 0
  );
}

function hasPostLevelUrl(item: EvidenceItem): boolean {
  try {
    const url = new URL(item.sourceUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean).map((part) => part.toLowerCase());
    if (host === "x.com" || host === "twitter.com") return parts.includes("status");
    if (host.endsWith("linkedin.com")) {
      return (
        parts.includes("posts") ||
        parts.includes("feed") ||
        parts.includes("pulse") ||
        item.sourceUrl.includes("urn:li:activity")
      );
    }
    if (host.endsWith("reddit.com")) return parts.includes("comments");
    if (host.endsWith("youtube.com") || host === "youtu.be") {
      return host === "youtu.be" || url.searchParams.has("v") || parts.includes("shorts");
    }
    return Boolean(item.platformPostId);
  } catch {
    return false;
  }
}

function mentionsCompanyOrFounder(item: EvidenceItem, company: GraphNode): boolean {
  const haystack = normalizeSearchText(
    [item.title, item.text, visibleRawText(item.rawVisibleText)].filter(Boolean).join(" ")
  );
  if (!haystack) return false;
  const terms = unique([
    company.label,
    company.websiteUrl ? domainToken(company.websiteUrl) : null,
    ...company.socialAccounts.map((account) => account.handle),
    ...company.founders.flatMap((founder) => [
      founder.name,
      ...founder.socialAccounts.map((account) => account.handle)
    ])
  ])
    .map((value) => normalizeSearchText(value ?? ""))
    .filter((term) => term.length >= 4);
  return terms.some((term) => containsTerm(haystack, term));
}

function hasValidClaimedDirectReplyTarget(item: EvidenceItem, company: GraphNode): boolean {
  if (item.platform !== "x") return true;
  const claimText = [item.title, item.text].filter(Boolean).join(" ");
  if (!/\b(?:reply|replied|responded)\s+(?:directly\s+)?to\b/i.test(claimText)) {
    return true;
  }
  const replyTarget = xReplyTarget(item.rawVisibleText);
  if (!replyTarget) return true;
  const handles = new Set(
    [
      ...company.socialAccounts,
      ...company.founders.flatMap((founder) => founder.socialAccounts)
    ]
      .filter((account) => account.platform === "x")
      .map((account) => normalizeSocialHandle(account.handle))
      .filter(Boolean)
  );
  return handles.has(normalizeSocialHandle(replyTarget));
}

function xReplyTarget(rawVisibleText: string | undefined): string | null {
  if (!rawVisibleText?.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(rawVisibleText) as Record<string, unknown>;
    const post = recordValue(parsed.post) ?? parsed;
    for (const key of ["replying_to", "replyingTo", "in_reply_to_screen_name"]) {
      if (typeof post[key] === "string" && post[key].trim()) {
        return post[key].trim();
      }
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeSocialHandle(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/, 1)[0]
    .toLowerCase();
}

function isRepostLikeEvidence(item: EvidenceItem): boolean {
  if (item.platform !== "x") return false;
  const raw = String(item.rawVisibleText ?? "");
  const visibleText = [item.title, item.text, raw].filter(Boolean).join("\n").trim();
  if (/^RT\s+@/i.test(visibleText) || /\b(?:retweeted|reposted)\b/i.test(raw)) {
    return true;
  }
  if (!raw.trim().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const post = recordValue(parsed.post) ?? parsed;
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

function visibleRawText(rawVisibleText: string | undefined): string {
  if (!rawVisibleText) return "";
  if (!rawVisibleText.trim().startsWith("{")) return rawVisibleText;
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
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function domainToken(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").split(".")[0] ?? null;
  } catch {
    return null;
  }
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

function containsTerm(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^| )${escaped}($| )`).test(haystack);
}

type MemberEvidence = Map<string, EvidenceItem[]>;

function groupEvidenceByCompanyAndMember(
  evidence: EvidenceItem[],
  companyIdByEntityId: Map<string, string>,
  members: Map<string, TopVoiceMember>
): Map<string, MemberEvidence> {
  const grouped = new Map<string, MemberEvidence>();
  for (const item of evidence) {
    const companyId = item.attachedCompanyId ?? companyIdByEntityId.get(item.entityId);
    const memberId = item.topVoice?.memberId;
    if (!companyId || !memberId || !members.has(memberId)) continue;
    const byMember = grouped.get(companyId) ?? new Map<string, EvidenceItem[]>();
    const items = byMember.get(memberId) ?? [];
    items.push(item);
    byMember.set(memberId, items);
    grouped.set(companyId, byMember);
  }
  return grouped;
}

function groupedEvidence(grouped: MemberEvidence | undefined): EvidenceItem[] {
  return [...(grouped?.values() ?? [])]
    .flat()
    .sort(
      (left, right) =>
        right.contributionScore - left.contributionScore ||
        left.id.localeCompare(right.id)
    );
}

function buildConnections(
  grouped: MemberEvidence | undefined,
  members: Map<string, TopVoiceMember>
): TopVoiceConnectionPreview[] {
  if (!grouped) return [];
  const connections: TopVoiceConnectionPreview[] = [];
  for (const [memberId, evidence] of grouped.entries()) {
    const member = members.get(memberId);
    if (!member) continue;
    const ordered = [...evidence].sort(
      (left, right) =>
        right.contributionScore - left.contributionScore ||
        left.id.localeCompare(right.id)
    );
    connections.push({
      memberId,
      displayName: member.displayName,
      category: member.category,
      weight: member.weight,
      contributionScore: round(
        ordered.reduce((total, item) => total + item.contributionScore, 0)
      ),
      evidenceCount: ordered.length,
      topEvidenceId: ordered[0]?.id ?? null,
      platforms: unique(ordered.map((item) => item.platform)).sort() as Platform[]
    });
  }
  return connections.sort(
    (left, right) =>
      right.contributionScore - left.contributionScore ||
      left.displayName.localeCompare(right.displayName)
  );
}

function withCompanyAudience(
  node: GraphNode,
  evidence: EvidenceItem[],
  connections: TopVoiceConnectionPreview[],
  sourceGraph: GraphResponse
): GraphNode {
  const evidenceIds = new Set(evidence.map((item) => item.id));
  return {
    ...node,
    evidenceIds: [...evidenceIds],
    founders: node.founders.map((founder) => ({
      ...founder,
      evidenceIds: evidence
        .filter((item) => item.entityType === "founder" && item.entityId === founder.id)
        .map((item) => item.id)
    })),
    topVoiceScore: connections.reduce((total, connection) => total + connection.weight, 0),
    topVoiceConnectionCount: connections.length,
    topVoiceConnections: connections,
    selectedTopVoiceAudience: sourceGraph.selectedTopVoiceAudience
  };
}

function withLeaderboardAudience(
  row: LeaderboardRow,
  evidence: EvidenceItem[],
  connections: TopVoiceConnectionPreview[]
): LeaderboardRow {
  return {
    ...row,
    biggestContribution: evidence[0] ?? null,
    topVoiceScore: connections.reduce((total, connection) => total + connection.weight, 0),
    topVoiceConnectionCount: connections.length,
    topVoiceConnections: connections
  };
}

function fallbackLeaderboardRow(node: GraphNode): LeaderboardRow {
  return {
    rank: 0,
    companyId: node.entityId,
    companyName: node.label,
    score: node.score,
    topPlatform: node.topPlatform,
    socialAccounts: node.socialAccounts,
    founderAccounts: node.founders.map((founder) => ({
      founderId: founder.id,
      founderName: founder.name,
      socialAccounts: founder.socialAccounts
    })),
    biggestContribution: null
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
