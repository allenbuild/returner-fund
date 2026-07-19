"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Database,
  Eye,
  GitFork,
  Heart,
  MessageCircle,
  Repeat2,
  Star,
  ThumbsUp,
  TrendingUp,
  Trophy,
  Users
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";
import {
  generatedEvidenceThumbnailDataUri,
  generatedEvidenceThumbnailUrl
} from "@/lib/graph/generated-evidence-thumbnail";
import { evidenceDisplayText, isGenericEvidenceLabel } from "@/lib/graph/evidence-display";
import type {
  EvidenceItem,
  FastestGainingRow,
  GraphResponse,
  LeaderboardRow,
  MomentumDelta
} from "@/lib/graph/types";
import { formatPlatform, PlatformIdentity, PlatformLogo } from "./PlatformLogo";

type TabKey = "overview" | "gaining" | "stats";
type MomentumPeriod = "dod" | "wow";
type OverviewSortKey = "rank" | "company";
type SortDirection = "asc" | "desc";

interface InsightsTabsProps {
  graph: GraphResponse;
  statsGraph?: GraphResponse;
  onSelectNode: (nodeId: string) => void;
}

const tabs: { key: TabKey; label: string; icon: typeof Trophy }[] = [
  { key: "overview", label: "Overview", icon: Trophy },
  { key: "gaining", label: "Hottest", icon: TrendingUp },
  { key: "stats", label: "Stats", icon: Database }
];

export function InsightsTabs({ graph, statsGraph = graph, onSelectNode }: InsightsTabsProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [momentumPeriod, setMomentumPeriod] = useState<MomentumPeriod>("dod");
  const [overviewSort, setOverviewSort] = useState<{ key: OverviewSortKey; direction: SortDirection }>({
    key: "rank",
    direction: "asc"
  });
  const momentumRows = useMemo(
    () => [...graph.fastestGaining].sort(momentumRowSort(momentumPeriod)),
    [graph.fastestGaining, momentumPeriod]
  );
  const overviewRows = useMemo(
    () => [...graph.leaderboard].sort(overviewRowSort(overviewSort)),
    [graph.leaderboard, overviewSort]
  );
  const databaseStats = useMemo(() => buildDatabaseStats(statsGraph), [statsGraph]);

  function toggleOverviewSort(key: OverviewSortKey) {
    setOverviewSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc"
    }));
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentTab: TabKey) {
    const currentIndex = tabs.findIndex((tab) => tab.key === currentTab);
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setActiveTab(nextTab.key);
    document.getElementById(`insights-tab-${nextTab.key}`)?.focus();
  }

  return (
    <section className="insights-panel">
      <div className="tab-list" role="tablist" aria-label="Dashboard panels">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              id={`insights-tab-${tab.key}`}
              type="button"
              role="tab"
              className={activeTab === tab.key ? "active" : ""}
              aria-controls={`insights-panel-${tab.key}`}
              aria-selected={activeTab === tab.key}
              tabIndex={activeTab === tab.key ? 0 : -1}
              onClick={() => setActiveTab(tab.key)}
              onKeyDown={(event) => handleTabKeyDown(event, tab.key)}
            >
              <Icon size={16} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
        <div
          className={`tab-list-actions ${activeTab === "gaining" ? "" : "tab-list-actions-hidden"}`}
          aria-hidden={activeTab !== "gaining"}
        >
          <div className="segmented-toggle" role="group" aria-label="Momentum period">
            <button
              type="button"
              className={momentumPeriod === "dod" ? "active" : ""}
              aria-pressed={momentumPeriod === "dod"}
              onClick={() => setMomentumPeriod("dod")}
              tabIndex={activeTab === "gaining" ? 0 : -1}
            >
              Day over day
            </button>
            <button
              type="button"
              className={momentumPeriod === "wow" ? "active" : ""}
              aria-pressed={momentumPeriod === "wow"}
              onClick={() => setMomentumPeriod("wow")}
              tabIndex={activeTab === "gaining" ? 0 : -1}
            >
              Week over week
            </button>
          </div>
        </div>
      </div>

      {activeTab === "overview" && (
        <div
          className="tab-body"
          id="insights-panel-overview"
          role="tabpanel"
          aria-labelledby="insights-tab-overview"
        >
          <table className="overview-table">
            <thead>
              <tr>
                <th>
                  <button type="button" className="sortable-th" onClick={() => toggleOverviewSort("rank")}>
                    Rank
                    <SortIcon active={overviewSort.key === "rank"} direction={overviewSort.direction} />
                  </button>
                </th>
                <th>
                  <button type="button" className="sortable-th" onClick={() => toggleOverviewSort("company")}>
                    Company
                    <SortIcon active={overviewSort.key === "company"} direction={overviewSort.direction} />
                  </button>
                </th>
                <th>Score</th>
                <th>Top platform</th>
                <th>Top Posts</th>
              </tr>
            </thead>
            <tbody>
              {!overviewRows.length && (
                <tr>
                  <td colSpan={5}>
                    <div className="overview-empty-state">No companies have traction from this Top Voices audience yet.</div>
                  </td>
                </tr>
              )}
              {overviewRows.map((row) => {
                const contribution = formatContribution(row.biggestContribution);
                return (
                  <tr key={row.companyId}>
                    <td className="insight-rank-cell overview-rank-cell">
                      <RankDisplay rank={row.rank} />
                    </td>
                    <td className="overview-company-cell">
                      <button
                        type="button"
                        className="leaderboard-company-button"
                        title={`Open ${row.companyName} profile`}
                        onClick={() => onSelectNode(`company:${row.companyId}`)}
                      >
                        {row.companyName}
                      </button>
                    </td>
                    <td className="overview-score-cell">
                      <span>{row.score}</span>
                    </td>
                    <td className="overview-platform-cell">
                      {row.topPlatform ? (
                        <span className={`ranking-platform-chip ranking-platform-${row.topPlatform}`}>
                          <PlatformIdentity platform={row.topPlatform} />
                        </span>
                      ) : (
                        <span className="ranking-platform-chip">None</span>
                      )}
                    </td>
                    <td className="overview-contribution-cell">
                      <div className="overview-traction-evidence">
                        {row.biggestContribution && contribution.url ? (
                          <a
                            className="overview-contribution-link"
                            href={contribution.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ContributionThumbnail item={row.biggestContribution} />
                            <ContributionSummary contribution={contribution} item={row.biggestContribution} />
                          </a>
                        ) : row.biggestContribution ? (
                          <div className="overview-contribution-empty">
                            <ContributionThumbnail item={row.biggestContribution} />
                            <ContributionSummary contribution={contribution} item={row.biggestContribution} />
                          </div>
                        ) : (
                          <div className="overview-contribution-empty overview-contribution-empty-inline">
                            No traction posts yet
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "gaining" && (
        <div
          className="tab-body"
          id="insights-panel-gaining"
          role="tabpanel"
          aria-labelledby="insights-tab-gaining"
        >
          <table className="momentum-table">
            <thead>
              <tr>
                <th>Hot rank</th>
                <th>Company</th>
                <th>Score delta</th>
                <th>Rank delta</th>
                <th>Overall rank now</th>
                <th>Benchmark</th>
              </tr>
            </thead>
            <tbody>
              {!momentumRows.length && (
                <tr>
                  <td colSpan={6}>
                    <div className="overview-empty-state">
                      No companies have traction from this Top Voices audience yet.
                    </div>
                  </td>
                </tr>
              )}
              {momentumRows.map((row) => {
                const delta = row[momentumPeriod];
                return (
                  <tr key={row.companyId}>
                    <td className="insight-rank-cell">
                      <RankDisplay rank={row.rank} />
                    </td>
                    <td className="insight-company-cell">
                      <button
                        type="button"
                        className="leaderboard-company-button"
                        title={`Open ${row.companyName} profile`}
                        onClick={() => onSelectNode(`company:${row.companyId}`)}
                      >
                        {row.companyName}
                      </button>
                    </td>
                    <td className="momentum-stat-cell">
                      <span>Score</span>
                      {" "}
                      <strong>
                        <span className="momentum-value-full">{formatScoreDelta(delta)}</span>
                        <span className="momentum-value-compact">{formatScoreDeltaCompact(delta)}</span>
                      </strong>
                    </td>
                    <td className="momentum-stat-cell">
                      <span>Rank</span>
                      {" "}
                      <strong>{formatRankDelta(delta)}</strong>
                    </td>
                    <td className="momentum-stat-cell">
                      <span>Now</span>
                      {" "}
                      <strong>
                        <span className="momentum-value-full">
                          {delta.currentScore} pts / #{delta.currentRank}
                        </span>
                        <span className="momentum-value-compact">
                          {delta.currentScore} / #{delta.currentRank}
                        </span>
                      </strong>
                    </td>
                    <td className="momentum-stat-cell">
                      <span>Benchmark</span>
                      {" "}
                      <strong>
                        <span className="momentum-value-full">{formatBenchmark(delta)}</span>
                        <span className="momentum-value-compact">{formatBenchmarkCompact(delta)}</span>
                      </strong>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "stats" && (
        <div
          className="tab-body stats-tab-body"
          id="insights-panel-stats"
          role="tabpanel"
          aria-labelledby="insights-tab-stats"
        >
          <section className="stats-overview" aria-labelledby="database-stats-title">
            <header className="stats-header">
              <div>
                <h2 id="database-stats-title">Database growth</h2>
                <p>{statsGraph.batch.label}</p>
              </div>
              <span>Updated {formatStatsTimestamp(statsGraph.generatedAt)}</span>
            </header>

            <div className="stats-primary-grid">
              <StatMetric label="Sources" value={databaseStats.sourceCount} detail={`${databaseStats.sourcesLast7Days} added in 7 days`} />
              <StatMetric label="Companies" value={databaseStats.companyCount} detail={`${databaseStats.companyCoverage}% have sources`} />
              <StatMetric label="Founders" value={databaseStats.founderCount} detail={`${databaseStats.founderCoverage}% have sources`} />
              <StatMetric label="New today" value={databaseStats.sourcesToday} detail="sources first seen" />
            </div>

            <div className="stats-growth-grid" aria-label="Daily database growth over the last 14 days">
              <DailyGrowthCard label="Sources added" points={databaseStats.dailyGrowth} field="sources" total={databaseStats.sourceCount} />
              <DailyGrowthCard label="Companies discovered" points={databaseStats.dailyGrowth} field="companies" total={databaseStats.companyCount} />
              <DailyGrowthCard label="Founders discovered" points={databaseStats.dailyGrowth} field="founders" total={databaseStats.founderCount} />
            </div>

            <dl className="stats-detail-grid">
              <StatDetail label="Platforms represented" value={databaseStats.platformCount} />
              <StatDetail label="Verified source links" value={`${databaseStats.verifiedLinkRate}%`} />
              <StatDetail label="Sources per company" value={databaseStats.sourcesPerCompany.toFixed(1)} />
              <StatDetail label="Needs review" value={databaseStats.needsReviewCount} />
            </dl>
          </section>
        </div>
      )}
    </section>
  );
}

type DailyGrowthField = "sources" | "companies" | "founders";

interface DailyGrowthPoint {
  dayKey: string;
  label: string;
  sources: number;
  companies: number;
  founders: number;
}

interface DatabaseStats {
  sourceCount: number;
  companyCount: number;
  founderCount: number;
  sourcesToday: number;
  sourcesLast7Days: number;
  companyCoverage: number;
  founderCoverage: number;
  platformCount: number;
  verifiedLinkRate: number;
  sourcesPerCompany: number;
  needsReviewCount: number;
  dailyGrowth: DailyGrowthPoint[];
}

function StatMetric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <article className="stats-metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
      <small>{detail}</small>
    </article>
  );
}

function StatDetail({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{typeof value === "number" ? value.toLocaleString() : value}</dd>
    </div>
  );
}

function DailyGrowthCard({
  label,
  points,
  field,
  total
}: {
  label: string;
  points: DailyGrowthPoint[];
  field: DailyGrowthField;
  total: number;
}) {
  const maximum = Math.max(1, ...points.map((point) => point[field]));
  const periodTotal = points.reduce((sum, point) => sum + point[field], 0);

  return (
    <article className={`stats-growth-card stats-growth-${field}`}>
      <header>
        <div>
          <span>{label}</span>
          <strong>+{periodTotal.toLocaleString()}</strong>
        </div>
        <small>{total.toLocaleString()} total</small>
      </header>
      <div
        className="stats-bars"
        role="img"
        aria-label={`${label} by day for the last 14 days. ${periodTotal.toLocaleString()} added.`}
      >
        {points.map((point) => {
          const value = point[field];
          return (
            <span className="stats-bar-slot" key={point.dayKey} title={`${point.label}: ${value.toLocaleString()}`}>
              <span className="stats-bar" style={{ height: `${Math.max(value > 0 ? 8 : 2, (value / maximum) * 100)}%` }} />
            </span>
          );
        })}
      </div>
      <footer>
        <span>{points[0]?.label}</span>
        <span>{points.at(-1)?.label}</span>
      </footer>
    </article>
  );
}

function buildDatabaseStats(graph: GraphResponse): DatabaseStats {
  const companyNodes = graph.nodes.filter((node) => node.entityType === "company");
  const companyIds = new Set(companyNodes.map((node) => node.entityId));
  const founderIds = new Set(companyNodes.flatMap((node) => node.founders.map((founder) => founder.id)));
  const companyFirstSeen = new Map<string, number>();
  const founderFirstSeen = new Map<string, number>();
  const sourceDates = graph.evidence
    .map((item) => ({ item, timestamp: statsTimestamp(item.first_seen_at ?? item.observedAt ?? null) }))
    .filter((entry): entry is { item: EvidenceItem; timestamp: number } => entry.timestamp !== null);

  for (const { item, timestamp } of sourceDates) {
    if (item.entityType === "company") {
      setEarliest(companyFirstSeen, item.entityId, timestamp);
    } else {
      setEarliest(founderFirstSeen, item.entityId, timestamp);
    }
    if (item.attachedCompanyId) {
      setEarliest(companyFirstSeen, item.attachedCompanyId, timestamp);
    }
  }

  const generatedTimestamp = statsTimestamp(graph.generatedAt);
  const latestSourceTimestamp = sourceDates.reduce((latest, entry) => Math.max(latest, entry.timestamp), 0);
  const anchorTimestamp = generatedTimestamp ?? (latestSourceTimestamp || Date.now());
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
    } satisfies DailyGrowthPoint;
  });
  const pointsByDay = new Map(dailyGrowth.map((point) => [point.dayKey, point]));

  for (const { timestamp } of sourceDates) {
    const point = pointsByDay.get(dayKey(timestamp));
    if (point) point.sources += 1;
  }
  for (const timestamp of companyFirstSeen.values()) {
    const point = pointsByDay.get(dayKey(timestamp));
    if (point) point.companies += 1;
  }
  for (const timestamp of founderFirstSeen.values()) {
    const point = pointsByDay.get(dayKey(timestamp));
    if (point) point.founders += 1;
  }

  const verifiedLinks = graph.evidence.filter((item) => item.linkStatus === "verified").length;
  const platforms = new Set(graph.evidence.map((item) => item.platform));

  return {
    sourceCount: graph.evidence.length,
    companyCount: companyIds.size,
    founderCount: founderIds.size,
    sourcesToday: dailyGrowth.at(-1)?.sources ?? 0,
    sourcesLast7Days: dailyGrowth.slice(-7).reduce((sum, point) => sum + point.sources, 0),
    companyCoverage: percentage(companyFirstSeen.size, companyIds.size),
    founderCoverage: percentage(founderFirstSeen.size, founderIds.size),
    platformCount: platforms.size,
    verifiedLinkRate: percentage(verifiedLinks, graph.evidence.length),
    sourcesPerCompany: companyIds.size ? graph.evidence.length / companyIds.size : 0,
    needsReviewCount: graph.needsReview.length,
    dailyGrowth
  };
}

function statsTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function setEarliest(target: Map<string, number>, id: string, timestamp: number) {
  const current = target.get(id);
  if (current === undefined || timestamp < current) target.set(id, timestamp);
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

function formatStatsTimestamp(value: string): string {
  const timestamp = statsTimestamp(value);
  if (timestamp === null) return "recently";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) {
    return <ArrowUpDown size={13} aria-hidden="true" />;
  }
  return direction === "asc" ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />;
}

function RankDisplay({ rank }: { rank: number }) {
  if (rank <= 3) {
    const medalClass = rank === 1 ? "gold" : rank === 2 ? "silver" : "bronze";
    return (
      <span className={`rank-medal rank-medal-${medalClass}`} aria-label={`Rank ${rank}`}>
        <span className="rank-medal-disc">{rank}</span>
      </span>
    );
  }

  return <span className="rank-number">{rank}</span>;
}

function ContributionThumbnail({ item }: { item: EvidenceItem | null }) {
  return (
    <ContributionThumbnailContent
      key={item ? `${item.id}:${item.thumbnailUrl ?? ""}` : "empty"}
      item={item}
    />
  );
}

function ContributionThumbnailContent({ item }: { item: EvidenceItem | null }) {
  const [failedThumbnailUrls, setFailedThumbnailUrls] = useState<string[]>([]);
  const platform = item?.platform ?? null;
  const thumbnailCandidates = item ? thumbnailUrlCandidates(item) : [];
  const thumbnailUrl = thumbnailCandidates.find((candidate) => !failedThumbnailUrls.includes(candidate)) ?? null;

  function handleThumbnailError(url: string) {
    setFailedThumbnailUrls((current) => (current.includes(url) ? current : [...current, url]));
  }

  return (
    <span className={`overview-post-thumbnail${platform ? ` overview-post-thumbnail-${platform}` : ""}`}>
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" onError={() => handleThumbnailError(thumbnailUrl)} />
      ) : platform ? (
        <span className="overview-post-thumbnail-fallback" aria-hidden="true">
          <PlatformLogo platform={platform} />
          <span>{formatPlatform(platform)}</span>
        </span>
      ) : (
        <span className="overview-post-thumbnail-fallback overview-post-thumbnail-empty" aria-hidden="true">
          No evidence
        </span>
      )}
    </span>
  );
}

function thumbnailUrlCandidates(item: EvidenceItem): string[] {
  const generatedDataUri = generatedEvidenceThumbnailDataUri(item);
  const generatedUrl = generatedEvidenceThumbnailUrl(item);
  return uniqueStrings([item.thumbnailUrl, generatedDataUri, generatedUrl]);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return values.filter((value, index): value is string => Boolean(value) && values.indexOf(value) === index);
}

function ContributionSummary({
  contribution,
  item
}: {
  contribution: { title: string; metrics: string; metricPills: MetricPill[]; author: string };
  item: EvidenceItem | null;
}) {
  return (
    <span className="overview-post-summary">
      <span className="overview-post-title">
        {item && (
          <span className={`overview-post-title-platform ranking-platform-${item.platform}`} aria-label={formatPlatform(item.platform)}>
            <PlatformLogo platform={item.platform} />
          </span>
        )}
        <span>{contribution.title}</span>
      </span>
      <span className="overview-post-meta">
        {contribution.author && <span className="overview-post-author">{contribution.author}</span>}
        {contribution.metricPills.length > 0 && (
          <span className="overview-metric-pills" aria-hidden="true">
            {contribution.metricPills.map((metric) => (
              <span className={`overview-metric-pill overview-metric-${metric.key}`} key={metric.key}>
                <MetricIcon metric={metric.key} />
                <span>{metric.value}</span>
              </span>
            ))}
          </span>
        )}
      </span>
      {contribution.metrics && <span className="sr-only">{contribution.metrics}</span>}
    </span>
  );
}

function MetricIcon({ metric }: { metric: string }) {
  if (metric === "views") {
    return <Eye size={14} aria-hidden="true" />;
  }
  if (metric === "likes") {
    return <Heart size={14} aria-hidden="true" />;
  }
  if (metric === "comments" || metric === "replies") {
    return <MessageCircle size={14} aria-hidden="true" />;
  }
  if (metric === "reposts" || metric === "quotes") {
    return <Repeat2 size={14} aria-hidden="true" />;
  }
  if (metric === "stars") {
    return <Star size={14} aria-hidden="true" />;
  }
  if (metric === "forks") {
    return <GitFork size={14} aria-hidden="true" />;
  }
  if (metric === "watchers") {
    return <Users size={14} aria-hidden="true" />;
  }
  return <ThumbsUp size={14} aria-hidden="true" />;
}

function formatScoreDelta(delta: MomentumDelta): string {
  if (delta.baselineScore === null) {
    return "Awaiting snapshot";
  }
  return `${signed(delta.scoreDelta)} pts (${signed(delta.percentDelta)}%)`;
}

function formatScoreDeltaCompact(delta: MomentumDelta): string {
  if (delta.baselineScore === null) {
    return "Awaiting snapshot";
  }
  return `${signed(delta.scoreDelta)} (${signed(delta.percentDelta)}%)`;
}

function formatRankDelta(delta: MomentumDelta): string {
  if (delta.baselineRank === null) {
    return "Awaiting snapshot";
  }
  const { rankDelta } = delta;
  if (rankDelta === 0) {
    return "0";
  }
  return `${rankDelta > 0 ? "+" : ""}${rankDelta}`;
}

function formatBenchmark(delta: MomentumDelta): string {
  const benchmarkDate = formatBenchmarkDate(delta.benchmarkedAt);
  if (delta.baselineScore === null || delta.baselineRank === null) {
    return benchmarkDate ? `Awaiting ${benchmarkDate} snapshot` : "Awaiting same-model snapshot";
  }
  return `${delta.baselineScore} pts / #${delta.baselineRank} on ${benchmarkDate ?? "prior snapshot"}`;
}

function formatBenchmarkCompact(delta: MomentumDelta): string {
  const benchmarkDate = formatBenchmarkDate(delta.benchmarkedAt, { month: "numeric", day: "numeric" });
  if (delta.baselineScore === null || delta.baselineRank === null) {
    return benchmarkDate ? `Awaiting ${benchmarkDate} snapshot` : "Awaiting snapshot";
  }
  return `${delta.baselineScore} / #${delta.baselineRank} · ${benchmarkDate ?? "prior"}`;
}

function formatBenchmarkDate(
  value: string | null,
  options: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric", year: "numeric" }
): string | null {
  if (!value) {
    return null;
  }
  const benchmarkDate = new Date(value);
  if (!Number.isFinite(benchmarkDate.getTime())) {
    return null;
  }
  return benchmarkDate.toLocaleDateString(undefined, {
    month: "numeric",
    day: "numeric",
    ...options
  });
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}

function momentumRowSort(period: MomentumPeriod) {
  return (left: FastestGainingRow, right: FastestGainingRow): number => {
    const leftDelta = left[period];
    const rightDelta = right[period];
    return (
      rightDelta.scoreDelta - leftDelta.scoreDelta ||
      rightDelta.percentDelta - leftDelta.percentDelta ||
      rightDelta.rankDelta - leftDelta.rankDelta ||
      rightDelta.currentScore - leftDelta.currentScore ||
      left.companyName.localeCompare(right.companyName)
    );
  };
}

function overviewRowSort(sort: { key: OverviewSortKey; direction: SortDirection }) {
  return (left: LeaderboardRow, right: LeaderboardRow): number => {
    const direction = sort.direction === "asc" ? 1 : -1;
    if (sort.key === "company") {
      return direction * left.companyName.localeCompare(right.companyName);
    }
    return direction * (left.rank - right.rank);
  };
}

interface MetricPill {
  key: string;
  label: string;
  value: string;
}

function formatContribution(item: EvidenceItem | null): {
  title: string;
  metrics: string;
  metricPills: MetricPill[];
  url: string | null;
  author: string;
} {
  if (!item) {
    return { title: "No traction posts yet", metrics: "", metricPills: [], url: null, author: "" };
  }

  return {
    title: firstSentence(evidenceDisplayText(item, "No evidence")),
    metrics: formatMetrics(item.metrics),
    metricPills: formatMetricPills(item.metrics),
    url: item.sourceUrl || null,
    author: evidenceAuthorLabel(item)
  };
}

function evidenceAuthorLabel(item: EvidenceItem): string {
  if (item.topVoice?.displayName) {
    return item.topVoice.displayName;
  }
  if (item.authorName && !isGenericEvidenceLabel(item.authorName)) {
    return item.authorName;
  }
  return item.authorHandle || xHandleFromEvidenceUrl(item.accountUrl) || xHandleFromEvidenceUrl(item.sourceUrl) || "";
}

function xHandleFromEvidenceUrl(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.hostname !== "x.com" && url.hostname !== "twitter.com" && url.hostname !== "www.x.com") return "";
    return url.pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return "";
  }
}

function firstSentence(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "No evidence";
  }

  const sentenceMatch = compact.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = sentenceMatch?.[1] ?? compact;
  return sentence.length > 118 ? `${sentence.slice(0, 115).trim()}...` : sentence;
}

function formatMetrics(metrics: EvidenceItem["metrics"]): string {
  return formatMetricPills(metrics)
    .map((metric) => `${metric.value} ${metric.label}`)
    .join(" / ");
}

function formatMetricPills(metrics: EvidenceItem["metrics"]): MetricPill[] {
  const orderedMetrics = [
    "views",
    "likes",
    "comments",
    "reposts",
    "replies",
    "quotes",
    "upvotes",
    "stars",
    "forks",
    "watchers"
  ];

  return orderedMetrics
    .map((key) => {
      const value = metrics[key];
      return typeof value === "number" && value > 0
        ? { key, label: formatMetricLabel(key), value: compactNumber(value) }
        : null;
    })
    .filter((part): part is MetricPill => Boolean(part))
    .slice(0, 4);
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatMetricLabel(key: string): string {
  return key.replace(/_/g, " ");
}
