"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Eye,
  GitFork,
  Heart,
  MessageCircle,
  Repeat2,
  Settings,
  Star,
  ThumbsUp,
  TrendingUp,
  Trophy,
  Users
} from "lucide-react";
import { useMemo, useState } from "react";
import type { EvidenceItem, FastestGainingRow, GraphResponse, LeaderboardRow, MomentumDelta } from "@/lib/graph/types";
import { formatPlatform, PlatformIdentity, PlatformLogo } from "./PlatformLogo";

type TabKey = "overview" | "gaining" | "settings";
type MomentumPeriod = "dod" | "wow";
type OverviewSortKey = "rank" | "company";
type SortDirection = "asc" | "desc";

interface InsightsTabsProps {
  graph: GraphResponse;
  onSelectNode: (nodeId: string) => void;
}

const tabs: { key: TabKey; label: string; icon: typeof Trophy }[] = [
  { key: "overview", label: "Overview", icon: Trophy },
  { key: "gaining", label: "Hottest", icon: TrendingUp },
  { key: "settings", label: "Settings", icon: Settings }
];

export function InsightsTabs({ graph, onSelectNode }: InsightsTabsProps) {
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

  function toggleOverviewSort(key: OverviewSortKey) {
    setOverviewSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc"
    }));
  }

  return (
    <section className="insights-panel">
      <div className="tab-list" role="tablist" aria-label="Dashboard panels">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              type="button"
              className={activeTab === tab.key ? "active" : ""}
              onClick={() => setActiveTab(tab.key)}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
        {activeTab === "gaining" && (
          <div className="tab-list-actions">
            <div className="segmented-toggle" role="group" aria-label="Momentum period">
              <button
                type="button"
                className={momentumPeriod === "dod" ? "active" : ""}
                onClick={() => setMomentumPeriod("dod")}
              >
                Day over day
              </button>
              <button
                type="button"
                className={momentumPeriod === "wow" ? "active" : ""}
                onClick={() => setMomentumPeriod("wow")}
              >
                Week over week
              </button>
            </div>
          </div>
        )}
      </div>

      {activeTab === "overview" && (
        <div className="tab-body">
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
              {overviewRows.map((row) => {
                const contribution = formatContribution(row.biggestContribution);
                return (
                  <tr key={row.companyId}>
                    <td className="insight-rank-cell overview-rank-cell">
                      <RankDisplay rank={row.rank} />
                    </td>
                    <td className="overview-company-cell">
                      <span>{row.companyName}</span>
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
                      {contribution.url ? (
                        <a
                          className="overview-contribution-link"
                          href={contribution.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ContributionThumbnail item={row.biggestContribution} />
                          <ContributionSummary contribution={contribution} item={row.biggestContribution} />
                        </a>
                      ) : (
                        <div className="overview-contribution-empty">
                          <ContributionThumbnail item={row.biggestContribution} />
                          <ContributionSummary contribution={contribution} item={row.biggestContribution} />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "gaining" && (
        <div className="tab-body">
          <table className="momentum-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Company</th>
                <th>Score delta</th>
                <th>Rank delta</th>
                <th>Current</th>
                <th>Benchmark</th>
              </tr>
            </thead>
            <tbody>
              {momentumRows.map((row, index) => {
                const delta = row[momentumPeriod];
                return (
                  <tr key={row.companyId}>
                    <td className="insight-rank-cell">
                      <RankDisplay rank={index + 1} />
                    </td>
                    <td className="insight-company-cell">
                      <button type="button" onClick={() => onSelectNode(`company:${row.companyId}`)}>
                        {row.companyName}
                      </button>
                    </td>
                    <td className="momentum-stat-cell">
                      <span>Score</span>
                      <strong>
                        <span className="momentum-value-full">{formatScoreDelta(delta)}</span>
                        <span className="momentum-value-compact">{formatScoreDeltaCompact(delta)}</span>
                      </strong>
                    </td>
                    <td className="momentum-stat-cell">
                      <span>Rank</span>
                      <strong>{formatRankDelta(delta.rankDelta)}</strong>
                    </td>
                    <td className="momentum-stat-cell">
                      <span>Now</span>
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

      {activeTab === "settings" && (
        <div className="tab-body status-grid">
          {graph.platformStatus.map((item) => (
            <article className="status-item" key={item.platform}>
              <div>
                <span className={`status-dot status-${item.status}`} />
                <strong>
                  <PlatformIdentity platform={item.platform} />
                </strong>
              </div>
              <span>{formatStatus(item.status)}</span>
              <p>{item.authMethod}</p>
              <small>{item.notes}</small>
            </article>
          ))}
        </div>
      )}
    </section>
  );
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
  const [imageFailed, setImageFailed] = useState(false);
  const platform = item?.platform ?? null;
  const thumbnailUrl = item?.thumbnailUrl && !imageFailed ? item.thumbnailUrl : null;

  return (
    <span className={`overview-post-thumbnail${platform ? ` overview-post-thumbnail-${platform}` : ""}`}>
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
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
  return `${signed(delta.scoreDelta)} pts (${signed(delta.percentDelta)}%)`;
}

function formatScoreDeltaCompact(delta: MomentumDelta): string {
  return `${signed(delta.scoreDelta)} (${signed(delta.percentDelta)}%)`;
}

function formatRankDelta(rankDelta: number): string {
  if (rankDelta === 0) {
    return "0";
  }
  return `${rankDelta > 0 ? "+" : ""}${rankDelta} ranks`;
}

function formatBenchmark(delta: MomentumDelta): string {
  if (delta.baselineScore === null || delta.baselineRank === null || !delta.benchmarkedAt) {
    return "Awaiting prior snapshot";
  }
  return `${delta.baselineScore} pts / #${delta.baselineRank} on ${new Date(delta.benchmarkedAt).toLocaleDateString()}`;
}

function formatBenchmarkCompact(delta: MomentumDelta): string {
  if (delta.baselineScore === null || delta.baselineRank === null || !delta.benchmarkedAt) {
    return "Pending";
  }
  const benchmarkDate = new Date(delta.benchmarkedAt);
  return `${delta.baselineScore} / #${delta.baselineRank} · ${benchmarkDate.toLocaleDateString(undefined, {
    month: "numeric",
    day: "numeric"
  })}`;
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
    return { title: "No evidence", metrics: "", metricPills: [], url: null, author: "" };
  }

  return {
    title: firstSentence(item.text || item.title || "No evidence"),
    metrics: formatMetrics(item.metrics),
    metricPills: formatMetricPills(item.metrics),
    url: item.sourceUrl || null,
    author: item.authorName || item.authorHandle || ""
  };
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

function formatStatus(status: GraphResponse["platformStatus"][number]["status"]): string {
  const labels = {
    working: "Working",
    public_only: "Public only",
    needs_config: "Needs config",
    disabled: "Disabled",
    risky: "Explicit only"
  };
  return labels[status];
}
