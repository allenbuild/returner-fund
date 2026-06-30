import { canonicalEvidenceKey } from "@/lib/graph/dedupe";
import { TRACTION_PLATFORM_WEIGHTS } from "@/lib/graph/traction-scoring";
import type { EvidenceItem, GraphNode, GraphResponse, Platform } from "@/lib/graph/types";

export const PUBLIC_CONNECTOR_PLATFORMS: Platform[] = [
  "github",
  "x",
  "linkedin",
  "instagram",
  "product_hunt",
  "youtube",
  "rss",
  "web",
  "reddit",
  "hacker_news",
  "bilibili"
];

export type IngestionTaskStatus = "completed" | "needs_review" | "blocked_or_empty" | "skipped" | "queued";

export interface CoverageReport {
  generatedAt: string;
  companyCount: number;
  evidenceCount: number;
  scoredEvidenceCount: number;
  nonGithubScoredEvidenceCount: number;
  platformCoverage: PlatformCoverageRow[];
  companyCoverage: CompanyCoverageRow[];
}

export interface PlatformCoverageRow {
  platform: Platform;
  connectorStatus: string;
  evidenceRows: number;
  scoredRows: number;
  companiesWithEvidence: number;
  companiesWithScoredEvidence: number;
  needsReviewRows: number;
  notes: string;
}

export interface CompanyCoverageRow {
  companyId: string;
  companyName: string;
  score: number;
  topPlatform: Platform | null;
  founderCount: number;
  evidenceRows: number;
  scoredEvidenceRows: number;
  nonGithubScoredEvidenceRows: number;
  platformsWithEvidence: Platform[];
  platformsWithScoredEvidence: Platform[];
  missingWeightedPlatforms: Platform[];
}

export interface WorkerTask {
  id: string;
  companyId: string;
  companyName: string;
  platform: Platform;
  status: IngestionTaskStatus;
  attempts: number;
  checkpointKey: string;
  rateLimitMs: number;
  lastError: string | null;
}

export interface WorkerLane {
  workerId: string;
  taskCount: number;
  completed: number;
  needsReview: number;
  blockedOrEmpty: number;
  queued: number;
  tasks: WorkerTask[];
}

export interface WorkerReport {
  generatedAt: string;
  workerCount: number;
  taskCount: number;
  statusCounts: Record<IngestionTaskStatus, number>;
  lanes: WorkerLane[];
}

export interface DuplicateReport {
  generatedAt: string;
  duplicateGroupCount: number;
  duplicateEvidenceCount: number;
  groups: DuplicateGroup[];
  duplicateAccountGroupCount: number;
  duplicateAccountGroups: DuplicateAccountGroup[];
}

export interface DuplicateGroup {
  key: string;
  platform: Platform;
  evidenceIds: string[];
  urls: string[];
  platformPostIds: string[];
  latestCheckedAt: string | null;
}

export interface DuplicateAccountGroup {
  key: string;
  companyId: string;
  companyName: string;
  platform: Platform;
  accountIds: string[];
  urls: string[];
  handles: string[];
  entityNames: string[];
}

const WEIGHTED_PLATFORMS = (Object.entries(TRACTION_PLATFORM_WEIGHTS) as [Platform, number][])
  .filter(([, weight]) => weight > 0)
  .map(([platform]) => platform);
const SLOW_PUBLIC_PLATFORMS = new Set<Platform>(["x", "linkedin", "instagram", "reddit", "bilibili"]);

export function buildCoverageReport(graph: GraphResponse): CoverageReport {
  const evidenceById = new Map(graph.evidence.map((item) => [item.id, item]));
  const platformCoverage = PUBLIC_CONNECTOR_PLATFORMS.map((platform) => platformCoverageRow(graph, platform));
  const companyCoverage = graph.nodes.map((node) => companyCoverageRow(node, evidenceById));

  return {
    generatedAt: new Date().toISOString(),
    companyCount: graph.nodes.length,
    evidenceCount: graph.evidence.length,
    scoredEvidenceCount: graph.evidence.filter((item) => item.contributionScore > 0).length,
    nonGithubScoredEvidenceCount: graph.evidence.filter(
      (item) => item.platform !== "github" && item.contributionScore > 0
    ).length,
    platformCoverage,
    companyCoverage
  };
}

export function buildWorkerReport(graph: GraphResponse, workerCount = 12): WorkerReport {
  const tasks = buildWorkerTasks(graph);
  const lanes: WorkerLane[] = Array.from({ length: workerCount }, (_, index) => ({
    workerId: `worker-${String(index + 1).padStart(2, "0")}`,
    taskCount: 0,
    completed: 0,
    needsReview: 0,
    blockedOrEmpty: 0,
    queued: 0,
    tasks: []
  }));

  tasks.forEach((task, index) => {
    const lane = lanes[index % lanes.length];
    lane.tasks.push(task);
    lane.taskCount += 1;
    if (task.status === "completed") lane.completed += 1;
    if (task.status === "needs_review") lane.needsReview += 1;
    if (task.status === "blocked_or_empty") lane.blockedOrEmpty += 1;
    if (task.status === "queued") lane.queued += 1;
  });

  return {
    generatedAt: new Date().toISOString(),
    workerCount,
    taskCount: tasks.length,
    statusCounts: countTaskStatuses(tasks),
    lanes
  };
}

export function buildWorkerTasks(graph: GraphResponse): WorkerTask[] {
  const evidenceByNode = evidenceForNodes(graph);
  const needsReviewByEntityPlatform = new Set(
    graph.needsReview.map((item) => `${item.entityId}:${item.platform}`)
  );
  const platformStatus = new Map(graph.platformStatus.map((item) => [item.platform, item.status]));

  return graph.nodes.flatMap((node) => {
    const entityIds = new Set([node.entityId, ...node.relatedEntityIds]);
    return PUBLIC_CONNECTOR_PLATFORMS.map((platform) => {
      const evidence = evidenceByNode.get(node.id)?.filter((item) => item.platform === platform) ?? [];
      const hasNeedsReview = [...entityIds].some((entityId) => needsReviewByEntityPlatform.has(`${entityId}:${platform}`));
      const status = taskStatus(platform, platformStatus.get(platform), evidence, hasNeedsReview);
      return {
        id: `task-${node.entityId}-${platform}`,
        companyId: node.entityId,
        companyName: node.label,
        platform,
        status,
        attempts: evidence.length || status === "needs_review" || status === "blocked_or_empty" ? 1 : 0,
        checkpointKey: `${node.batchSlug}:${node.entityId}:${platform}`,
        rateLimitMs: SLOW_PUBLIC_PLATFORMS.has(platform) ? 4500 : 1200,
        lastError:
          status === "blocked_or_empty"
            ? "No public post-level evidence was visible, or the platform blocked unauthenticated access. Batch continues."
            : null
      };
    });
  });
}

export function buildDuplicateReport(graph: GraphResponse): DuplicateReport {
  const groups = new Map<string, EvidenceItem[]>();
  for (const item of graph.evidence) {
    const key = canonicalEvidenceKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const duplicates = [...groups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({
      key,
      platform: items[0].platform,
      evidenceIds: items.map((item) => item.id),
      urls: [...new Set(items.map((item) => item.sourceUrl))],
      platformPostIds: [...new Set(items.map((item) => item.platformPostId).filter((id): id is string => Boolean(id)))],
      latestCheckedAt: latestDate(items.map((item) => item.last_checked_at))
    }));

  const duplicateAccountGroups = duplicateSocialAccountGroups(graph);

  return {
    generatedAt: new Date().toISOString(),
    duplicateGroupCount: duplicates.length,
    duplicateEvidenceCount: duplicates.reduce((sum, item) => sum + item.evidenceIds.length, 0),
    groups: duplicates,
    duplicateAccountGroupCount: duplicateAccountGroups.length,
    duplicateAccountGroups
  };
}

function duplicateSocialAccountGroups(graph: GraphResponse): DuplicateAccountGroup[] {
  const groups = new Map<string, AccountAuditRow[]>();

  for (const node of graph.nodes) {
    const rows: AccountAuditRow[] = [
      ...node.socialAccounts.map((account) => ({
        companyId: node.entityId,
        companyName: node.label,
        entityName: node.label,
        entityType: "company" as const,
        account
      })),
      ...node.founders.flatMap((founder) =>
        founder.socialAccounts.map((account) => ({
          companyId: node.entityId,
          companyName: node.label,
          entityName: founder.name,
          entityType: "founder" as const,
          account
        }))
      )
    ];

    for (const row of rows) {
      const key = `${row.companyId}:${row.account.platform}:${canonicalAccountPart(row.account.url, row.account.handle)}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }

  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({
      key,
      companyId: rows[0].companyId,
      companyName: rows[0].companyName,
      platform: rows[0].account.platform,
      accountIds: rows.map((row) => row.account.id),
      urls: [...new Set(rows.map((row) => row.account.url))],
      handles: [...new Set(rows.map((row) => row.account.handle).filter((handle): handle is string => Boolean(handle)))],
      entityNames: [...new Set(rows.map((row) => `${row.entityName} (${row.entityType})`))]
    }));
}

interface AccountAuditRow {
  companyId: string;
  companyName: string;
  entityName: string;
  entityType: "company" | "founder";
  account: GraphNode["socialAccounts"][number];
}

function canonicalAccountPart(url: string, handle: string | null): string {
  const canonicalUrl = canonicalAccountUrl(url);
  if (canonicalUrl) {
    return canonicalUrl;
  }

  return String(handle ?? "")
    .toLowerCase()
    .replace(/^@/, "")
    .trim();
}

function canonicalAccountUrl(rawUrl: string): string {
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
    return "";
  }
}

function latestDate(values: Array<string | undefined>): string | null {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function platformCoverageRow(graph: GraphResponse, platform: Platform): PlatformCoverageRow {
  const status = graph.platformStatus.find((item) => item.platform === platform);
  const platformEvidence = graph.evidence.filter((item) => item.platform === platform);
  const scoredEvidence = platformEvidence.filter((item) => item.contributionScore > 0);
  const companiesWithEvidence = companiesForEvidence(graph, platformEvidence);
  const companiesWithScoredEvidence = companiesForEvidence(graph, scoredEvidence);

  return {
    platform,
    connectorStatus: status?.status ?? "queued",
    evidenceRows: platformEvidence.length,
    scoredRows: scoredEvidence.length,
    companiesWithEvidence: companiesWithEvidence.size,
    companiesWithScoredEvidence: companiesWithScoredEvidence.size,
    needsReviewRows: graph.needsReview.filter((item) => item.platform === platform).length,
    notes: status?.notes ?? "Connector task is queued."
  };
}

function companyCoverageRow(node: GraphNode, evidenceById: Map<string, EvidenceItem>): CompanyCoverageRow {
  const evidence = node.evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is EvidenceItem => Boolean(item));
  const scoredEvidence = evidence.filter((item) => item.contributionScore > 0);
  const platformsWithEvidence = uniquePlatforms(evidence);
  const platformsWithScoredEvidence = uniquePlatforms(scoredEvidence);

  return {
    companyId: node.entityId,
    companyName: node.label,
    score: node.score,
    topPlatform: node.topPlatform,
    founderCount: node.founders.length,
    evidenceRows: evidence.length,
    scoredEvidenceRows: scoredEvidence.length,
    nonGithubScoredEvidenceRows: scoredEvidence.filter((item) => item.platform !== "github").length,
    platformsWithEvidence,
    platformsWithScoredEvidence,
    missingWeightedPlatforms: WEIGHTED_PLATFORMS.filter((platform) => !platformsWithScoredEvidence.includes(platform))
  };
}

function companiesForEvidence(graph: GraphResponse, evidence: EvidenceItem[]): Set<string> {
  const byEvidenceId = new Map<string, string>();
  for (const node of graph.nodes) {
    for (const evidenceId of node.evidenceIds) {
      byEvidenceId.set(evidenceId, node.entityId);
    }
  }
  return new Set(evidence.map((item) => byEvidenceId.get(item.id)).filter((id): id is string => Boolean(id)));
}

function evidenceForNodes(graph: GraphResponse): Map<string, EvidenceItem[]> {
  const evidenceById = new Map(graph.evidence.map((item) => [item.id, item]));
  const result = new Map<string, EvidenceItem[]>();
  for (const node of graph.nodes) {
    result.set(
      node.id,
      node.evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is EvidenceItem => Boolean(item))
    );
  }
  return result;
}

function taskStatus(
  platform: Platform,
  connectorStatus: string | undefined,
  evidence: EvidenceItem[],
  hasNeedsReview: boolean
): IngestionTaskStatus {
  if (evidence.length > 0) return "completed";
  if (hasNeedsReview) return "needs_review";
  if (connectorStatus === "disabled") return "skipped";
  if (SLOW_PUBLIC_PLATFORMS.has(platform)) return "blocked_or_empty";
  return "queued";
}

function countTaskStatuses(tasks: WorkerTask[]): Record<IngestionTaskStatus, number> {
  return tasks.reduce(
    (counts, task) => {
      counts[task.status] += 1;
      return counts;
    },
    { completed: 0, needs_review: 0, blocked_or_empty: 0, skipped: 0, queued: 0 }
  );
}

function uniquePlatforms(items: EvidenceItem[]): Platform[] {
  return [...new Set(items.map((item) => item.platform))].sort();
}
