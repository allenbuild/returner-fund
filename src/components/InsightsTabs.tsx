"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Clock3,
  Database,
  Eye,
  GitFork,
  Heart,
  ListOrdered,
  MessageCircle,
  Repeat2,
  Star,
  ThumbsUp,
  TrendingUp,
  Trophy,
  Users
} from "lucide-react";
import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  generatedEvidenceThumbnailDataUri,
  generatedEvidenceThumbnailUrl
} from "@/lib/graph/generated-evidence-thumbnail";
import { evidenceDisplayText, isGenericEvidenceLabel } from "@/lib/graph/evidence-display";
import { selectRankedPosts, type RankedPostsPeriod } from "@/lib/graph/ranked-posts";
import type {
  EvidenceItem,
  FastestGainingRow,
  GraphResponse,
  LeaderboardRow,
  MomentumDelta
} from "@/lib/graph/types";
import { formatPlatform, PlatformIdentity, PlatformLogo } from "./PlatformLogo";

type TabKey = "overview" | "gaining" | "ranked" | "stats";
type MomentumPeriod = "dod" | "wow";
type OverviewSortKey = "rank" | "company";
type SortDirection = "asc" | "desc";

interface InsightsTabsProps {
  graph: GraphResponse;
  statsGraph?: GraphResponse;
  onSelectNode: (nodeId: string) => void;
  now?: Date;
}

const tabs: { key: TabKey; label: string; icon: typeof Trophy }[] = [
  { key: "overview", label: "Overview", icon: Trophy },
  { key: "gaining", label: "Hottest", icon: TrendingUp },
  { key: "ranked", label: "Ranked Posts", icon: ListOrdered },
  { key: "stats", label: "Stats", icon: Database }
];

export function InsightsTabs({ graph, statsGraph = graph, onSelectNode, now }: InsightsTabsProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [momentumPeriod, setMomentumPeriod] = useState<MomentumPeriod>("dod");
  const [rankedPeriod, setRankedPeriod] = useState<RankedPostsPeriod>("all_time");
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
  const rankedPosts = useMemo(
    () => selectRankedPosts(graph, { period: rankedPeriod, now }),
    [graph, now, rankedPeriod]
  );
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
      <div className="tab-list">
        <div className="tab-navigation" role="tablist" aria-label="Dashboard panels">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                id={`insights-tab-${tab.key}`}
                type="button"
                role="tab"
                className="insights-tab-button"
                aria-controls={`insights-panel-${tab.key}`}
                aria-selected={activeTab === tab.key}
                tabIndex={activeTab === tab.key ? 0 : -1}
                onClick={() => setActiveTab(tab.key)}
                onKeyDown={(event) => handleTabKeyDown(event, tab.key)}
              >
                <span className="insights-tab-button-content">
                  <Icon size={16} aria-hidden="true" />
                  <span className="tab-label">{tab.label}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div
          className={`tab-list-actions ${activeTab === "gaining" || activeTab === "ranked" ? "" : "tab-list-actions-hidden"}`}
          aria-hidden={activeTab !== "gaining" && activeTab !== "ranked"}
        >
          {activeTab === "gaining" && (
            <div className="segmented-toggle" role="group" aria-label="Momentum period">
              <button type="button" className={momentumPeriod === "dod" ? "active" : ""} aria-pressed={momentumPeriod === "dod"} onClick={() => setMomentumPeriod("dod")}>Day over day</button>
              <button type="button" className={momentumPeriod === "wow" ? "active" : ""} aria-pressed={momentumPeriod === "wow"} onClick={() => setMomentumPeriod("wow")}>Week over week</button>
            </div>
          )}
          {activeTab === "ranked" && (
            <div className="segmented-toggle ranked-posts-period-toggle" role="group" aria-label="Ranked posts period">
              <button type="button" className={rankedPeriod === "all_time" ? "active" : ""} aria-pressed={rankedPeriod === "all_time"} onClick={() => setRankedPeriod("all_time")}>All time</button>
              <button type="button" className={rankedPeriod === "today" ? "active" : ""} aria-pressed={rankedPeriod === "today"} onClick={() => setRankedPeriod("today")}>Today</button>
              <button type="button" className={rankedPeriod === "month" ? "active" : ""} aria-pressed={rankedPeriod === "month"} onClick={() => setRankedPeriod("month")}>Month</button>
            </div>
          )}
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

      {activeTab === "ranked" && (
        <div
          className="tab-body ranked-posts-tab-body"
          id="insights-panel-ranked"
          role="tabpanel"
          aria-labelledby="insights-tab-ranked"
        >
          {!rankedPosts.length ? (
            <div className="ranked-posts-empty" role="status">
              <Clock3 size={22} aria-hidden="true" />
              <strong>
                {rankedPeriod === "today"
                  ? "No reliably dated posts were published today."
                  : rankedPeriod === "month"
                    ? "No reliably dated posts were published in the last 30 days."
                    : "No eligible scored posts match these filters."}
              </strong>
              <span>
                {rankedPeriod === "today"
                  ? "Posts with unknown or imprecise publication timestamps are excluded from Today."
                  : rankedPeriod === "month"
                    ? "Posts with unknown or imprecise publication timestamps are excluded from Month."
                    : "Try broadening one or more visibility filters."}
              </span>
            </div>
          ) : (
            <ol className="ranked-posts-list" aria-label="Ranked posts">
              {rankedPosts.map((post) => {
                const item = post.evidence;
                const contribution = formatContribution(item);
                const score = rankedEvidenceScore(item);
                const card = (
                  <article className="ranked-post-card">
                    <div className="ranked-post-rank"><RankDisplay rank={post.rank} /></div>
                    <div className="ranked-post-preview">
                      <ContributionThumbnail item={item} />
                    </div>
                    <div className="ranked-post-content">
                      <div className="ranked-post-primary-row">
                        <span className="ranked-post-company">{post.companyName}</span>
                        <div className="ranked-post-meta">
                          <span className={`ranking-platform-chip ranking-platform-${item.platform}`}><PlatformIdentity platform={item.platform} /></span>
                          <span className={`ranked-source-badge ranked-source-${post.sourceKind}`}>{formatSourceKind(post.sourceKind)}</span>
                          <time dateTime={item.postedAt}>{formatPostDate(item.postedAt)}</time>
                        </div>
                      </div>
                      <div className="ranked-post-title-row">
                        <p className="ranked-post-title">{contribution.title}</p>
                      </div>
                      <div className="ranked-post-details">
                        {contribution.author && <span className="ranked-post-author">{formatAuthor(contribution.author, item.authorHandle)}</span>}
                        {contribution.metricPills.length > 0 && (
                          <span className="overview-metric-pills ranked-metric-pills">
                            {contribution.metricPills.map((metric) => <span className={`overview-metric-pill overview-metric-${metric.key}`} key={metric.key}><MetricIcon metric={metric.key} /><span>{metric.value}</span></span>)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="ranked-post-score" aria-label={`Post score ${score}`}>
                      <strong>{score}</strong>
                    </div>
                  </article>
                );
                return (
                  <li key={post.canonicalPostKey}>
                    {contribution.url ? (
                      <a
                        className="ranked-post-row-link"
                        href={contribution.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${post.companyName} post on ${formatPlatform(item.platform)}`}
                      >
                        {card}
                      </a>
                    ) : card}
                  </li>
                );
              })}
            </ol>
          )}
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
              <StatMetric tone="source" label="Sources" value={databaseStats.sourceCount} detail={`${databaseStats.sourcesLast7Days} added in 7 days`} />
              <StatMetric tone="company" label="Companies" value={databaseStats.companyCount} detail={`${databaseStats.companyCoverage}% have sources`} />
              <StatMetric tone="founder" label="Founders" value={databaseStats.founderCount} detail={`${databaseStats.founderCoverage}% have sources`} />
              <StatMetric tone="source" label="New today" value={databaseStats.sourcesToday} detail="sources first seen" />
            </div>

            <div className="stats-growth-grid" aria-label="Daily database growth over the last 14 days">
              <SplineTotalCard label="Total sources" points={databaseStats.dailyGrowth} field="sources" total={databaseStats.sourceCount} />
              <SplineTotalCard label="Total companies" points={databaseStats.dailyGrowth} field="companies" total={databaseStats.companyCount} />
              <SplineTotalCard label="Total founders" points={databaseStats.dailyGrowth} field="founders" total={databaseStats.founderCount} />
            </div>
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
  dailyGrowth: DailyGrowthPoint[];
}

function StatMetric({
  label,
  value,
  detail,
  tone
}: {
  label: string;
  value: number;
  detail: string;
  tone: "source" | "company" | "founder";
}) {
  return (
    <article className={`stats-metric stats-metric-${tone}`}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
      <small>{detail}</small>
    </article>
  );
}

interface TotalGrowthPoint extends DailyGrowthPoint {
  value: number;
}

const SPLINE_WIDTH = 320;
const SPLINE_HEIGHT = 118;
const SPLINE_PADDING = 8;

function SplineTotalCard({
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
  const gradientId = useId().replaceAll(":", "");
  const totals = useMemo(() => cumulativeTotals(points, field, total), [field, points, total]);
  const dragPointerId = useRef<number | null>(null);
  const [activePosition, setActivePosition] = useState(() => Math.max(0, totals.length - 1));
  const clampedPosition = Math.min(activePosition, Math.max(0, totals.length - 1));
  const selectedIndex = Math.round(clampedPosition);
  const selected = totals[selectedIndex] ?? null;
  const values = totals.map((point) => point.value);
  const minimum = Math.min(...values, total);
  const maximum = Math.max(...values, total);
  const range = Math.max(1, maximum - minimum);
  const coordinates = totals.map((point, index) => ({
    x: totals.length <= 1 ? SPLINE_WIDTH / 2 : (index / (totals.length - 1)) * SPLINE_WIDTH,
    y: SPLINE_PADDING + ((maximum - point.value) / range) * (SPLINE_HEIGHT - SPLINE_PADDING * 2)
  }));
  const selectedCoordinate = splinePointAtPosition(coordinates, clampedPosition);
  const linePath = splinePath(coordinates);
  const areaPath = linePath
    ? `${linePath} L ${coordinates.at(-1)?.x ?? 0} ${SPLINE_HEIGHT} L ${coordinates[0]?.x ?? 0} ${SPLINE_HEIGHT} Z`
    : "";

  function selectFromPointer(event: ReactPointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || totals.length <= 1) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    setActivePosition(ratio * (totals.length - 1));
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    dragPointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    selectFromPointer(event);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragPointerId.current === event.pointerId) selectFromPointer(event);
  }

  function finishPointerDrag(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragPointerId.current !== event.pointerId) return;
    dragPointerId.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    let nextIndex = selectedIndex;
    if (event.key === "ArrowLeft") nextIndex -= 1;
    else if (event.key === "ArrowRight") nextIndex += 1;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = totals.length - 1;
    else return;
    event.preventDefault();
    setActivePosition(Math.min(totals.length - 1, Math.max(0, nextIndex)));
  }

  return (
    <article className={`stats-growth-card stats-growth-${field}`}>
      <header>
        <div>
          <span>{label}</span>
          <strong>{(selected?.value ?? total).toLocaleString()}</strong>
        </div>
        <small>{selected?.label ?? "Current"}</small>
      </header>
      <svg
        className="stats-spline"
        viewBox={`0 0 ${SPLINE_WIDTH} ${SPLINE_HEIGHT}`}
        preserveAspectRatio="none"
        role="slider"
        tabIndex={0}
        aria-label={`${label} by day for the last 14 days`}
        aria-valuemin={minimum}
        aria-valuemax={maximum}
        aria-valuenow={selected?.value ?? total}
        aria-valuetext={`${selected?.label ?? "Current"}: ${(selected?.value ?? total).toLocaleString()}`}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
        onLostPointerCapture={() => {
          dragPointerId.current = null;
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.2" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className="stats-spline-area" d={areaPath} fill={`url(#${gradientId})`} />
        <path className="stats-spline-line" d={linePath} />
        <line
          className="stats-spline-guide"
          x1={selectedCoordinate.x}
          x2={selectedCoordinate.x}
          y1={0}
          y2={SPLINE_HEIGHT}
        />
        <circle className="stats-spline-point" cx={selectedCoordinate.x} cy={selectedCoordinate.y} r={5} />
      </svg>
      <footer>
        <span>{totals[0]?.label}</span>
        <span>{totals.at(-1)?.label}</span>
      </footer>
    </article>
  );
}

function cumulativeTotals(
  points: DailyGrowthPoint[],
  field: DailyGrowthField,
  total: number
): TotalGrowthPoint[] {
  const periodChange = points.reduce((sum, point) => sum + point[field], 0);
  let runningTotal = Math.max(0, total - periodChange);
  return points.map((point) => {
    runningTotal += point[field];
    return { ...point, value: runningTotal };
  });
}

function splinePath(points: { x: number; y: number }[]): string {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const midpointX = current.x + (next.x - current.x) / 2;
    path += ` C ${midpointX} ${current.y}, ${midpointX} ${next.y}, ${next.x} ${next.y}`;
  }
  return path;
}

function splinePointAtPosition(
  points: { x: number; y: number }[],
  position: number
): { x: number; y: number } {
  if (!points.length) return { x: 0, y: SPLINE_HEIGHT };
  if (points.length === 1) return points[0];

  const clampedPosition = Math.min(Math.max(position, 0), points.length - 1);
  const segmentIndex = Math.min(Math.floor(clampedPosition), points.length - 2);
  const segmentProgress = clampedPosition - segmentIndex;
  const current = points[segmentIndex];
  const next = points[segmentIndex + 1];
  const midpointX = current.x + (next.x - current.x) / 2;
  const targetX = current.x + (next.x - current.x) * segmentProgress;
  let lowerT = 0;
  let upperT = 1;

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const candidateT = (lowerT + upperT) / 2;
    const candidateX = cubicBezier(current.x, midpointX, midpointX, next.x, candidateT);
    if (candidateX < targetX) lowerT = candidateT;
    else upperT = candidateT;
  }

  const t = (lowerT + upperT) / 2;
  return {
    x: cubicBezier(current.x, midpointX, midpointX, next.x, t),
    y: cubicBezier(current.y, current.y, next.y, next.y, t)
  };
}

function cubicBezier(start: number, controlA: number, controlB: number, end: number, t: number): number {
  const inverseT = 1 - t;
  return (
    inverseT ** 3 * start +
    3 * inverseT ** 2 * t * controlA +
    3 * inverseT * t ** 2 * controlB +
    t ** 3 * end
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

  return {
    sourceCount: graph.evidence.length,
    companyCount: companyIds.size,
    founderCount: founderIds.size,
    sourcesToday: dailyGrowth.at(-1)?.sources ?? 0,
    sourcesLast7Days: dailyGrowth.slice(-7).reduce((sum, point) => sum + point.sources, 0),
    companyCoverage: percentage(companyFirstSeen.size, companyIds.size),
    founderCoverage: percentage(founderFirstSeen.size, founderIds.size),
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
        // Evidence thumbnails can come from arbitrary registered source hosts; the
        // native element preserves ordered fallback-on-error without a remote-host allowlist.
        // eslint-disable-next-line @next/next/no-img-element
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

function formatSourceKind(value: "company" | "founder" | "top_voice"): string {
  if (value === "top_voice") return "Top Voice";
  return value === "founder" ? "Founder" : "Company";
}

function formatPostDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return date.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });
}

function formatAuthor(author: string, handle: string | null): string {
  if (!handle || author.toLowerCase().includes(handle.toLowerCase())) return author;
  return `${author} · @${handle.replace(/^@/, "")}`;
}

function rankedEvidenceScore(item: EvidenceItem): number {
  const value = Number.isFinite(item.normalizedScore) ? item.normalizedScore : item.contributionScore;
  return Math.max(0, Math.min(100, Math.round(value ?? 0)));
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
