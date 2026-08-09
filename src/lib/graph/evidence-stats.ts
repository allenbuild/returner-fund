import { enrichEvidenceTopics, topicPhysicalPostCounts } from "./graph-taxonomies";
import type { EvidenceItem, EvidenceStats } from "./types";

export function buildEvidenceStats(
  evidence: EvidenceItem[],
  entities: { companyIds: ReadonlySet<string>; founderIds: ReadonlySet<string> }
): EvidenceStats {
  const entityIds = new Set([...entities.companyIds, ...entities.founderIds]);
  const attributableEvidence = evidence.filter((item) =>
    evidenceBelongsToEntityScope(item, entities.companyIds, entityIds)
  );
  const byPlatform: EvidenceStats["byPlatform"] = {};
  const byTopic = Object.fromEntries(
    topicPhysicalPostCounts(attributableEvidence.map(enrichEvidenceTopics)).entries()
  ) as EvidenceStats["byTopic"];
  const firstSeenByDay: Record<string, number> = {};
  const companiesWithSources = new Set<string>();
  const foundersWithSources = new Set<string>();
  const companyFirstSeen = new Map<string, number>();
  const founderFirstSeen = new Map<string, number>();
  let scoringEligibleCount = 0;

  for (const item of attributableEvidence) {
    byPlatform[item.platform] = (byPlatform[item.platform] ?? 0) + 1;
    if (item.contributionScore > 0 || item.tractionStatus === "unscored") {
      scoringEligibleCount += 1;
    }

    const directCompanyId = item.entityType === "company" && entities.companyIds.has(item.entityId)
      ? item.entityId
      : null;
    const attachedCompanyId = item.attachedCompanyId && entities.companyIds.has(item.attachedCompanyId)
      ? item.attachedCompanyId
      : null;
    if (directCompanyId) companiesWithSources.add(directCompanyId);
    if (attachedCompanyId) companiesWithSources.add(attachedCompanyId);

    const founderId = item.entityType === "founder" && entities.founderIds.has(item.entityId)
      ? item.entityId
      : null;
    if (founderId) foundersWithSources.add(founderId);

    const timestamp = item.first_seen_at ?? item.observedAt ?? null;
    if (timestamp) {
      const date = new Date(timestamp);
      if (Number.isFinite(date.getTime())) {
        const time = date.getTime();
        const day = date.toISOString().slice(0, 10);
        firstSeenByDay[day] = (firstSeenByDay[day] ?? 0) + 1;
        if (directCompanyId) setEarliestTimestamp(companyFirstSeen, directCompanyId, time);
        if (attachedCompanyId) setEarliestTimestamp(companyFirstSeen, attachedCompanyId, time);
        if (founderId) setEarliestTimestamp(founderFirstSeen, founderId, time);
      }
    }
  }

  return {
    totalCount: attributableEvidence.length,
    scoringEligibleCount,
    byPlatform,
    byTopic,
    firstSeenByDay,
    entityCoverage: {
      company: {
        withSourcesCount: companiesWithSources.size,
        firstSeenByDay: firstSeenEntityCountsByDay(companyFirstSeen)
      },
      founder: {
        withSourcesCount: foundersWithSources.size,
        firstSeenByDay: firstSeenEntityCountsByDay(founderFirstSeen)
      }
    }
  };
}

export function evidenceBelongsToEntityScope(
  item: EvidenceItem,
  companyIds: ReadonlySet<string>,
  entityIds: ReadonlySet<string>
): boolean {
  return item.attachedCompanyId
    ? companyIds.has(item.attachedCompanyId)
    : entityIds.has(item.entityId);
}

function setEarliestTimestamp(target: Map<string, number>, id: string, timestamp: number): void {
  const current = target.get(id);
  if (current === undefined || timestamp < current) target.set(id, timestamp);
}

function firstSeenEntityCountsByDay(firstSeen: ReadonlyMap<string, number>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const timestamp of firstSeen.values()) {
    const day = new Date(timestamp).toISOString().slice(0, 10);
    counts[day] = (counts[day] ?? 0) + 1;
  }
  return counts;
}
