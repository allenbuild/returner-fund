import type { EvidenceItem, GraphResponse, NeedsReviewItem, Platform } from "@/lib/graph/types";

export interface RawInstagramSnapshotCompany {
  slug: string;
  name: string;
  websiteUrl?: string | null;
  socialLinks?: Record<string, string | null | undefined>;
  founders?: Array<{
    name: string;
    socialLinks?: Record<string, string | null | undefined>;
  }>;
}

export interface RawInstagramEvidenceSnapshot {
  evidence?: Array<Record<string, unknown> & {
    companySlug?: string;
    companyName?: string;
    review_state?: string;
    thumbnailUrl?: string | null;
    thumbnailSource?: string | null;
  }>;
  needsReview?: Array<Record<string, unknown> & {
    companySlug?: string;
    companyName?: string;
    review_state?: string;
  }>;
  failures?: Array<{
    companySlug?: string;
    companyName?: string;
    platform?: Platform | string;
    message?: string;
    failureReason?: string;
    url?: string | null;
  }>;
}

export interface RawInstagramOverrides {
  [companySlug: string]: {
    companySocialLinks?: Record<string, string | null | undefined>;
    matchReason?: string;
    rejectedInstagram?: Array<{
      url?: string | null;
      rejectedAt?: string;
      reason?: string;
      source?: string;
    }>;
    prunedInstagram?: {
      url?: string | null;
      matchReason?: string;
      prunedAt?: string;
      pruneReason?: string;
    };
    founders?: Array<{
      name?: string;
      socialLinks?: Record<string, string | null | undefined>;
      matchReason?: string;
    }>;
  };
}

export interface RawInstagramDiscoveryReport {
  companies_checked?: number;
  searched_with_opencli?: boolean;
  searched_with_web?: boolean;
  candidates?: Array<{
    companySlug?: string;
    companyName?: string;
    entityType?: string;
    entityName?: string;
    candidateUrl?: string | null;
    review_state?: string;
    matchReason?: string;
    sourceUrl?: string | null;
  }>;
  attempts?: Array<{
    companySlug?: string;
    companyName?: string;
    entityType?: string;
    entityName?: string;
    query?: string;
    source?: string;
    result_count?: number;
    useful_result_count?: number;
    status?: string;
    failure_reason?: string | null;
  }>;
}

export interface InstagramCoverageReport {
  generatedAt: string;
  companyCount: number;
  rootCause: string[];
  profiles: {
    snapshotCompanyProfiles: number;
    snapshotFounderProfiles: number;
    verifiedCompanyOverrides: number;
    verifiedFounderOverrides: number;
    discoveredCandidates: number;
    needsReviewCandidates: number;
    rejectedCandidates: number;
    failedCandidates: number;
    discoveryAttempts: number;
    noResultAttempts: number;
    failedAttempts: number;
  };
  evidence: {
    rows: number;
    scoredRows: number;
    companiesWithEvidence: number;
    companiesWithScoredEvidence: number;
    postsWithThumbnails: number;
    realThumbnailRows: number;
    thumbnailSources: Record<string, number>;
  };
  feedCompanies: Array<{
    companyName: string;
    companyId: string;
    instagramRows: number;
    scoredRows: number;
    thumbnailRows: number;
    topPostUrl: string | null;
  }>;
  missingCompanies: Array<{
    companyName: string;
    companyId: string;
    reason: string;
  }>;
  attempts: RawInstagramDiscoveryReport["attempts"];
}

export function buildInstagramCoverageReport(input: {
  graph: GraphResponse;
  companies: RawInstagramSnapshotCompany[];
  overrides: RawInstagramOverrides;
  snapshots: RawInstagramEvidenceSnapshot[];
  discovery?: RawInstagramDiscoveryReport | null;
}): InstagramCoverageReport {
  const evidence = input.graph.evidence.filter((item) => item.platform === "instagram");
  const scored = evidence.filter((item) => item.contributionScore > 0);
  const ownerByEvidenceId = ownerIndex(input.graph);
  const rowsByCompany = groupInstagramRowsByCompany(input.graph, evidence, ownerByEvidenceId);
  const discoveryCandidates = input.discovery?.candidates ?? [];
  const attempts = input.discovery?.attempts ?? [];
  const companyIdsWithEvidence = new Set(evidence.map((item) => ownerByEvidenceId.get(item.id)).filter(Boolean));
  const companyIdsWithScored = new Set(scored.map((item) => ownerByEvidenceId.get(item.id)).filter(Boolean));

  return {
    generatedAt: new Date().toISOString(),
    companyCount: input.companies.length,
    rootCause: rootCauseFindings(input, evidence),
    profiles: {
      snapshotCompanyProfiles: input.companies.filter((company) => Boolean(company.socialLinks?.instagram)).length,
      snapshotFounderProfiles: input.companies.flatMap((company) => company.founders ?? []).filter((founder) =>
        Boolean(founder.socialLinks?.instagram)
      ).length,
      verifiedCompanyOverrides: Object.values(input.overrides).filter((item) => Boolean(item.companySocialLinks?.instagram)).length,
      verifiedFounderOverrides: Object.values(input.overrides).flatMap((item) => item.founders ?? []).filter((founder) =>
        Boolean(founder.socialLinks?.instagram)
      ).length,
      discoveredCandidates: discoveryCandidates.length,
      needsReviewCandidates: discoveryCandidates.filter((item) => item.review_state === "needs_review").length,
      rejectedCandidates: discoveryCandidates.filter((item) => item.review_state === "rejected").length,
      failedCandidates: discoveryCandidates.filter((item) => item.review_state === "failed").length,
      discoveryAttempts: attempts.length,
      noResultAttempts: attempts.filter((item) => item.status === "no_results").length,
      failedAttempts: attempts.filter((item) => item.status === "failed").length
    },
    evidence: {
      rows: evidence.length,
      scoredRows: scored.length,
      companiesWithEvidence: companyIdsWithEvidence.size,
      companiesWithScoredEvidence: companyIdsWithScored.size,
      postsWithThumbnails: evidence.filter((item) => Boolean(item.thumbnailUrl)).length,
      realThumbnailRows: evidence.filter((item) => Boolean(item.thumbnailUrl) && !isFallbackThumbnail(item.thumbnailUrl)).length,
      thumbnailSources: countBy(evidence, (item) => item.thumbnailSource ?? "none")
    },
    feedCompanies: [...rowsByCompany.values()]
      .map((row) => ({
        companyName: row.company.label,
        companyId: row.company.entityId,
        instagramRows: row.rows.length,
        scoredRows: row.rows.filter((item) => item.contributionScore > 0).length,
        thumbnailRows: row.rows.filter((item) => Boolean(item.thumbnailUrl)).length,
        topPostUrl: row.rows.sort((left, right) => right.contributionScore - left.contributionScore)[0]?.sourceUrl ?? null
      }))
      .sort((left, right) => right.scoredRows - left.scoredRows || left.companyName.localeCompare(right.companyName)),
    missingCompanies: input.graph.nodes
      .filter((node) => node.entityType === "company" && !companyIdsWithScored.has(node.entityId))
      .map((node) => ({
        companyName: node.label,
        companyId: node.entityId,
        reason: missingReason(node.entityId, input, discoveryCandidates, attempts)
      }))
      .sort((left, right) => left.companyName.localeCompare(right.companyName)),
    attempts
  };
}

function rootCauseFindings(
  input: {
    companies: RawInstagramSnapshotCompany[];
    overrides: RawInstagramOverrides;
    discovery?: RawInstagramDiscoveryReport | null;
  },
  evidence: EvidenceItem[]
): string[] {
  const findings = [];
  if (!input.companies.some((company) => company.socialLinks?.instagram)) {
    findings.push("The YC Spring 2026 snapshot has zero company-level Instagram profile URLs.");
  }
  if (!input.companies.some((company) => (company.founders ?? []).some((founder) => founder.socialLinks?.instagram))) {
    findings.push("The YC Spring 2026 snapshot has zero founder-level Instagram profile URLs.");
  }
  const verifiedOverrideCount = Object.values(input.overrides).filter((item) => item.companySocialLinks?.instagram).length;
  if (verifiedOverrideCount <= 1) {
    findings.push("Only one verified company Instagram override exists, so logged-in ingestion only has one company target.");
  }
  const hasBroadDiscovery =
    input.discovery?.searched_with_opencli ||
    input.discovery?.searched_with_web ||
    input.discovery?.attempts?.some((attempt) => attempt.source && attempt.source !== "official-website");
  if (input.discovery && !hasBroadDiscovery) {
    findings.push("The last Instagram discovery report did not run a broad Instagram search; it only crawled official websites.");
  }
  if (new Set(evidence.map((item) => item.attachedCompanyName ?? item.entityId)).size <= 1) {
    findings.push("Current Instagram evidence is effectively attached to a single company feed.");
  }
  return findings;
}

function ownerIndex(graph: GraphResponse): Map<string, string> {
  const result = new Map<string, string>();
  for (const node of graph.nodes) {
    for (const evidenceId of node.evidenceIds) {
      result.set(evidenceId, node.entityId);
    }
  }
  return result;
}

function groupInstagramRowsByCompany(
  graph: GraphResponse,
  evidence: EvidenceItem[],
  ownerByEvidenceId: Map<string, string | undefined>
) {
  const nodesById = new Map(graph.nodes.map((node) => [node.entityId, node]));
  const result = new Map<string, { company: GraphResponse["nodes"][number]; rows: EvidenceItem[] }>();
  for (const item of evidence) {
    const ownerId = ownerByEvidenceId.get(item.id) ?? item.attachedCompanyId;
    const company = ownerId ? nodesById.get(ownerId) : null;
    if (!company) continue;
    const row = result.get(company.entityId) ?? { company, rows: [] };
    row.rows.push(item);
    result.set(company.entityId, row);
  }
  return result;
}

function missingReason(
  companyId: string,
  input: {
    overrides: RawInstagramOverrides;
    discovery?: RawInstagramDiscoveryReport | null;
  },
  candidates: NonNullable<RawInstagramDiscoveryReport["candidates"]>,
  attempts: NonNullable<RawInstagramDiscoveryReport["attempts"]>
): string {
  const slug = companyId.replace(/^company-/, "");
  if (input.overrides[slug]?.companySocialLinks?.instagram) {
    return "Verified Instagram profile exists but no scored Instagram post evidence is attached yet.";
  }
  if (candidates.some((candidate) => candidate.companySlug === slug && candidate.review_state === "needs_review")) {
    return "Instagram candidate exists but is still needs_review and does not count toward scoring.";
  }
  if (attempts.some((attempt) => attempt.companySlug === slug && attempt.status === "failed")) {
    return "Instagram discovery attempted and failed; see discovery attempt failure_reason.";
  }
  if (attempts.some((attempt) => attempt.companySlug === slug && attempt.status === "no_results")) {
    return "Instagram discovery attempted but found no useful profile candidates.";
  }
  return "No verified Instagram profile target is known yet.";
}

function isFallbackThumbnail(url: string | null | undefined): boolean {
  if (!url) return false;
  const normalized = url.toLowerCase();
  return normalized.endsWith(".svg") || normalized.includes("fallback") || normalized.includes("placeholder");
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
