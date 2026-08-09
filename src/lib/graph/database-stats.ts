import type { EvidenceItem, EntityEvidenceCoverageStats, GraphResponse } from "./types";

export interface DailyDatabaseGrowthPoint {
  dayKey: string;
  label: string;
  sources: number;
  companies: number;
  founders: number;
}

export interface DatabaseStats {
  sourceCount: number;
  companyCount: number;
  founderCount: number;
  sourcesToday: number;
  sourcesLast7Days: number;
  companyCoverage: number;
  founderCoverage: number;
  dailyGrowth: DailyDatabaseGrowthPoint[];
}

interface PreviewEntityCoverage {
  company: EntityEvidenceCoverageStats;
  founder: EntityEvidenceCoverageStats;
}

export function buildDatabaseStats(graph: GraphResponse): DatabaseStats {
  const companyNodes = graph.nodes.filter((node) => node.entityType === "company");
  const companyIds = new Set(companyNodes.map((node) => node.entityId));
  const founderIds = new Set(companyNodes.flatMap((node) => node.founders.map((founder) => founder.id)));
  const previewCoverage = buildPreviewEntityCoverage(graph.evidence, companyIds, founderIds);
  const entityCoverage = graph.evidenceStats?.entityCoverage ?? previewCoverage;
  const previewSourceDates = graph.evidence
    .map((item) => statsTimestamp(item.first_seen_at ?? item.observedAt ?? null))
    .filter((timestamp): timestamp is number => timestamp !== null);
  const generatedTimestamp = statsTimestamp(graph.generatedAt);
  const latestAggregateTimestamp = latestDayTimestamp([
    graph.evidenceStats?.firstSeenByDay,
    entityCoverage.company.firstSeenByDay,
    entityCoverage.founder.firstSeenByDay
  ]);
  const latestPreviewTimestamp = previewSourceDates.reduce(
    (latest, timestamp) => Math.max(latest, timestamp),
    0
  );
  const anchorTimestamp = generatedTimestamp ?? latestAggregateTimestamp ?? (latestPreviewTimestamp || Date.now());
  const anchorDate = startUtcDay(anchorTimestamp);
  const dailyGrowth = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(anchorDate);
    date.setUTCDate(anchorDate.getUTCDate() - (13 - index));
    return {
      dayKey: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }),
      sources: 0,
      companies: 0,
      founders: 0
    } satisfies DailyDatabaseGrowthPoint;
  });

  if (graph.evidenceStats) {
    for (const point of dailyGrowth) {
      point.sources = graph.evidenceStats.firstSeenByDay[point.dayKey] ?? 0;
    }
  } else {
    const pointsByDay = new Map(dailyGrowth.map((point) => [point.dayKey, point]));
    for (const timestamp of previewSourceDates) {
      const point = pointsByDay.get(dayKey(timestamp));
      if (point) point.sources += 1;
    }
  }

  for (const point of dailyGrowth) {
    point.companies = entityCoverage.company.firstSeenByDay[point.dayKey] ?? 0;
    point.founders = entityCoverage.founder.firstSeenByDay[point.dayKey] ?? 0;
  }

  return {
    sourceCount: graph.evidenceStats?.totalCount ?? graph.evidence.length,
    companyCount: companyIds.size,
    founderCount: founderIds.size,
    sourcesToday: dailyGrowth.at(-1)?.sources ?? 0,
    sourcesLast7Days: dailyGrowth.slice(-7).reduce((sum, point) => sum + point.sources, 0),
    companyCoverage: percentage(entityCoverage.company.withSourcesCount, companyIds.size),
    founderCoverage: percentage(entityCoverage.founder.withSourcesCount, founderIds.size),
    dailyGrowth
  };
}

function buildPreviewEntityCoverage(
  evidence: EvidenceItem[],
  companyIds: ReadonlySet<string>,
  founderIds: ReadonlySet<string>
): PreviewEntityCoverage {
  const companiesWithSources = new Set<string>();
  const foundersWithSources = new Set<string>();
  const companyFirstSeen = new Map<string, number>();
  const founderFirstSeen = new Map<string, number>();

  for (const item of evidence) {
    const attachedCompanyIds = new Set<string>();
    if (item.entityType === "company" && companyIds.has(item.entityId)) {
      attachedCompanyIds.add(item.entityId);
    }
    if (item.attachedCompanyId && companyIds.has(item.attachedCompanyId)) {
      attachedCompanyIds.add(item.attachedCompanyId);
    }
    for (const companyId of attachedCompanyIds) companiesWithSources.add(companyId);

    const founderId = item.entityType === "founder" && founderIds.has(item.entityId)
      ? item.entityId
      : null;
    if (founderId) foundersWithSources.add(founderId);

    const timestamp = statsTimestamp(item.first_seen_at ?? item.observedAt ?? null);
    if (timestamp === null) continue;
    for (const companyId of attachedCompanyIds) setEarliest(companyFirstSeen, companyId, timestamp);
    if (founderId) setEarliest(founderFirstSeen, founderId, timestamp);
  }

  return {
    company: {
      withSourcesCount: companiesWithSources.size,
      firstSeenByDay: firstSeenCountsByDay(companyFirstSeen)
    },
    founder: {
      withSourcesCount: foundersWithSources.size,
      firstSeenByDay: firstSeenCountsByDay(founderFirstSeen)
    }
  };
}

function statsTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestDayTimestamp(dayMaps: Array<Record<string, number> | undefined>): number | null {
  let latest: number | null = null;
  for (const dayMap of dayMaps) {
    for (const day of Object.keys(dayMap ?? {})) {
      const timestamp = statsTimestamp(`${day}T00:00:00.000Z`);
      if (timestamp !== null && (latest === null || timestamp > latest)) latest = timestamp;
    }
  }
  return latest;
}

function setEarliest(target: Map<string, number>, id: string, timestamp: number): void {
  const current = target.get(id);
  if (current === undefined || timestamp < current) target.set(id, timestamp);
}

function firstSeenCountsByDay(firstSeen: ReadonlyMap<string, number>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const timestamp of firstSeen.values()) {
    const day = dayKey(timestamp);
    counts[day] = (counts[day] ?? 0) + 1;
  }
  return counts;
}

function startUtcDay(timestamp: number): Date {
  const date = new Date(timestamp);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function percentage(numerator: number, denominator: number): number {
  return denominator ? Math.round((numerator / denominator) * 100) : 0;
}
