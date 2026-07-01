"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, Settings, TrendingUp, Trophy } from "lucide-react";
import { useMemo, useState } from "react";
import type { EvidenceItem, FastestGainingRow, GraphResponse, LeaderboardRow, MomentumDelta } from "@/lib/graph/types";
import { PlatformIdentity } from "./PlatformLogo";

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
  { key: "gaining", label: "Fastest gaining", icon: TrendingUp },
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
                <th>Biggest contribution</th>
              </tr>
            </thead>
            <tbody>
              {overviewRows.map((row) => {
                const contribution = formatContribution(row.biggestContribution);
                return (
                  <tr key={row.companyId}>
                    <td className="insight-rank-cell overview-rank-cell">{row.rank}</td>
                    <td className="overview-company-cell">
                      <button type="button" onClick={() => onSelectNode(`company:${row.companyId}`)}>
                        {row.companyName}
                      </button>
                    </td>
                    <td className="overview-score-cell">{row.score}</td>
                    <td className="overview-platform-cell">
                      {row.topPlatform ? <PlatformIdentity platform={row.topPlatform} /> : "None"}
                    </td>
                    <td className="overview-contribution-cell">
                      {contribution.url ? (
                        <a
                          className="overview-contribution-link"
                          href={contribution.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span>{contribution.title}</span>
                          {contribution.metrics && <small>{contribution.metrics}</small>}
                        </a>
                      ) : (
                        <>
                          <span>{contribution.title}</span>
                          {contribution.metrics && <small>{contribution.metrics}</small>}
                        </>
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
                    <td className="insight-rank-cell">{index + 1}</td>
                    <td className="insight-company-cell">
                      <button type="button" onClick={() => onSelectNode(`company:${row.companyId}`)}>
                        {row.companyName}
                      </button>
                    </td>
                    <td>{formatScoreDelta(delta)}</td>
                    <td>{formatRankDelta(delta.rankDelta)}</td>
                    <td>
                      {delta.currentScore} pts / #{delta.currentRank}
                    </td>
                    <td>{formatBenchmark(delta)}</td>
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

function formatScoreDelta(delta: MomentumDelta): string {
  return `${signed(delta.scoreDelta)} pts (${signed(delta.percentDelta)}%)`;
}

function formatRankDelta(rankDelta: number): string {
  if (rankDelta === 0) {
    return "0";
  }
  return `${rankDelta > 0 ? "+" : ""}${rankDelta} ranks`;
}

function formatBenchmark(delta: MomentumDelta): string {
  if (delta.baselineScore === null || delta.baselineRank === null || !delta.benchmarkedAt) {
    return "No benchmark yet";
  }
  return `${delta.baselineScore} pts / #${delta.baselineRank} on ${new Date(delta.benchmarkedAt).toLocaleDateString()}`;
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

function formatContribution(item: EvidenceItem | null): { title: string; metrics: string; url: string | null } {
  if (!item) {
    return { title: "No evidence", metrics: "", url: null };
  }

  return {
    title: firstSentence(item.text || item.title || "No evidence"),
    metrics: formatMetrics(item.metrics),
    url: item.sourceUrl || null
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
  const parts = orderedMetrics
    .map((key) => {
      const value = metrics[key];
      return typeof value === "number" && value > 0 ? `${compactNumber(value)} ${formatMetricLabel(key)}` : null;
    })
    .filter((part): part is string => Boolean(part))
    .slice(0, 4);

  return parts.join(" / ");
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
