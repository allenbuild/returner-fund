"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { dedupeEvidenceItems } from "@/lib/graph/dedupe";
import { getCompanyVerticalDefinition } from "@/lib/graph/company-verticals";
import { TOP_POSTS_LIMIT } from "@/lib/graph/presentation-limits";
import type { EvidenceItem, GraphNode } from "@/lib/graph/types";
import { timelineCompanyRefFromGraphNode } from "@/lib/timeline/company-identity";
import { EvidenceMediaCard } from "./EvidenceMediaCard";
import { PlatformIdentity } from "./PlatformLogo";
import timelineStyles from "./timeline/CompanyTimeline.module.css";

const CompanyTimeline = dynamic(
  () => import("./timeline/CompanyTimeline").then((module) => module.CompanyTimeline),
  {
    ssr: false,
    loading: () => <div role="status" aria-label="Loading company timeline" />,
  },
);

interface NodePanelProps {
  node: GraphNode | null;
  relatedNodes: GraphNode[];
  evidence: EvidenceItem[];
  highlightedFounderId?: string | null;
}

type CompanyPanelView = "posts" | "timeline";

export function NodePanel({ node, evidence, highlightedFounderId }: NodePanelProps) {
  const [view, setView] = useState<CompanyPanelView>("posts");
  const panelRef = useRef<HTMLElement | null>(null);
  const viewRef = useRef<CompanyPanelView>("posts");
  const savedScrollRef = useRef<Record<CompanyPanelView, number>>({ posts: 0, timeline: 0 });
  const timelineCompany = useMemo(() => node ? timelineCompanyRefFromGraphNode(node) : null, [node]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    savedScrollRef.current = { posts: 0, timeline: 0 };
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [timelineCompany?.slug]);

  useEffect(() => {
    const syncViewFromUrl = () => {
      const requested = new URLSearchParams(window.location.search).get("view") === "timeline"
        ? "timeline"
        : "posts";
      const next = timelineCompany ? requested : "posts";
      changeVisibleView(next, false);
    };
    syncViewFromUrl();
    window.addEventListener("popstate", syncViewFromUrl);
    return () => window.removeEventListener("popstate", syncViewFromUrl);
  // The company identity is deliberately the only dependency: popstate reads
  // the live view from viewRef, avoiding a listener replacement on every click.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineCompany?.slug]);

  useEffect(() => {
    if (!timelineCompany) return;
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const prefetch = () => {
      void Promise.all([
        import("./timeline/CompanyTimeline"),
        import("./timeline/client").then(({ prefetchCompanyTimeline }) => prefetchCompanyTimeline(timelineCompany.slug)),
      ]).catch(() => undefined);
    };
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(prefetch, { timeout: 2_000 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(prefetch, 1_200);
    return () => window.clearTimeout(handle);
  }, [timelineCompany]);

  if (!node) {
    return (
      <aside className="node-panel" ref={panelRef}>
        <div className="empty-state">No node selected.</div>
      </aside>
    );
  }

  const scoredItems = dedupeEvidenceItems(
    [...evidence]
      .filter(isScoredEvidence)
      .sort((a, b) => b.contributionScore - a.contributionScore)
  );
  const topItems = scoredItems.slice(0, TOP_POSTS_LIMIT);
  const founderAccounts = node.founders.flatMap((founder) =>
    founder.socialAccounts.map((account) => ({ founderName: founder.name, account }))
  );

  function changeVisibleView(next: CompanyPanelView, restoreScroll = true) {
    const current = viewRef.current;
    if (panelRef.current) savedScrollRef.current[current] = panelRef.current.scrollTop;
    viewRef.current = next;
    setView(next);
    if (!restoreScroll) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (panelRef.current) panelRef.current.scrollTop = savedScrollRef.current[next];
      });
    });
  }

  function switchView() {
    const next: CompanyPanelView = view === "timeline" ? "posts" : "timeline";
    if (next === "timeline") {
      const measuredWindow = window as Window & {
        __returnerTimelineSwitchAt?: number;
        __returnerTimelineSwitchSequence?: number;
      };
      measuredWindow.__returnerTimelineSwitchAt = window.performance.now();
      measuredWindow.__returnerTimelineSwitchSequence = (measuredWindow.__returnerTimelineSwitchSequence ?? 0) + 1;
      window.performance.clearMarks?.("returner:timeline-switch");
      window.performance.clearMeasures?.("returner:timeline-click-to-visible");
      window.performance.mark?.("returner:timeline-switch");
    }
    const url = new URL(window.location.href);
    if (next === "timeline") url.searchParams.set("view", "timeline");
    else url.searchParams.delete("view");
    window.history.pushState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    changeVisibleView(next);
  }

  const postsView = (
    <>
      {node.entityType === "company" && (node.verticals?.length ?? 0) > 0 && (
        <section className="node-verticals" aria-label="Company verticals">
          {node.verticals?.map((vertical) => (
            <span className="vertical-chip" key={vertical}>{getCompanyVerticalDefinition(vertical).label}</span>
          ))}
        </section>
      )}

      {node.entityType === "company" && (
        <>
          {node.insiderScoreBreakdown && <InsiderContributions node={node} />}
          <PlatformContributions node={node} />
        </>
      )}

      {(node.founders.length > 0 || node.socialAccounts.length > 0) && (
        <section className="profile-context">
          {node.founders.length > 0 && (
            <div>
              <span className="context-label">Founders</span>
              <div className="founder-chip-list">
                {node.founders.map((founder) => (
                  <a
                    href={founder.ycProfileUrl}
                    target="_blank"
                    rel="noreferrer"
                    key={founder.id}
                    className={founder.id === highlightedFounderId ? "active" : ""}
                  >
                    {founder.name}
                  </a>
                ))}
              </div>
            </div>
          )}
          {node.socialAccounts.length > 0 && (
            <div>
              <span className="context-label">Verified public accounts</span>
              <div className="account-chip-list">
                {node.socialAccounts.map((account) => (
                  <a href={account.url} target="_blank" rel="noreferrer" key={account.id}>
                    <PlatformIdentity platform={account.platform} />
                    {account.handle && <span className="account-handle">/ {account.handle}</span>}
                  </a>
                ))}
              </div>
            </div>
          )}
          {founderAccounts.length > 0 && (
            <div>
              <span className="context-label">Founder accounts</span>
              <div className="founder-account-chip-list">
                {founderAccounts.map(({ founderName, account }) => (
                  <a href={account.url} target="_blank" rel="noreferrer" key={`${founderName}-${account.id}`}>
                    {founderName}
                    <small>
                      <PlatformIdentity platform={account.platform} />
                      {account.handle && <span className="account-handle">/ {account.handle}</span>}
                    </small>
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="top-contribution-section">
        <div className="section-title-row">
          <h3>Top Posts</h3>
          <span>{topItems.length}/{TOP_POSTS_LIMIT}</span>
        </div>
        <div className="top-post-list">
          {topItems.map((item, index) => (
            <EvidenceMediaCard item={item} compact={index > 5} key={item.id} />
          ))}
          {!topItems.length && <div className="empty-state">No scored traction posts yet.</div>}
        </div>
      </section>
    </>
  );

  return (
    <aside className="node-panel" ref={panelRef}>
      <header className={`node-panel-header ${timelineStyles.panelHeader}`}>
        <div className={`node-title-row ${timelineStyles.panelTitleRow}`}>
          <div className={timelineStyles.panelTitleCluster}>
            <h2>{node.label}</h2>
            <div className="score-orb" aria-label={`Score ${node.score}`}>
              <span>{node.score}</span>
            </div>
          </div>
          {timelineCompany ? (
            <button
              type="button"
              className={timelineStyles.viewToggle}
              aria-label={`Show ${node.label} ${view === "timeline" ? "posts" : "timeline"}`}
              aria-pressed={view === "timeline"}
              onClick={switchView}
            >
              {view === "timeline" ? "Posts" : "Timeline"}
            </button>
          ) : null}
        </div>
      </header>

      {view === "timeline" && timelineCompany
        ? <CompanyTimeline key={timelineCompany.slug} companySlug={timelineCompany.slug} companyName={timelineCompany.name} />
        : postsView}
    </aside>
  );
}

function InsiderContributions({ node }: { node: GraphNode }) {
  const breakdown = node.insiderScoreBreakdown!;
  return (
    <section className="score-platform-section insider-score-section" aria-label="Insider score breakdown">
      <h3>Insider adjustment</h3>
      <p>
        Published score {formatScore(breakdown.baseScore)}. Insider adjustment{" "}
        {formatSignedScore(breakdown.insiderScoreAdjustment)}. Result{" "}
        <strong>{formatScore(breakdown.finalScore)}</strong>.
      </p>
      <small>
        Each matched insider contributes weight² influence and counts once, even with multiple posts. Published{" "}
        influence {formatScore(breakdown.publishedInsiderInfluence)} → current influence{" "}
        {formatScore(breakdown.weightedInsiderSubtotal)}.
      </small>
      <ol className="score-platform-contributions">
        {breakdown.matches.map((match) => {
          return (
            <li key={match.memberId} className={match.included ? "" : "excluded"}>
              <span>{match.displayName}</span>
              <span className="score-platform-contribution">
                <strong>
                  {match.included
                    ? `Weight ${match.effectiveWeight}² = ${formatScore(match.influenceScore)} influence`
                    : "Excluded"}
                </strong>
                <small>
                  Published {match.publishedWeight}² = {formatScore(match.publishedInfluenceScore)} · adjustment{" "}
                  {formatSignedScore(match.adjustment)} · {formatItemCount(match.evidenceCount)}
                </small>
              </span>
            </li>
          );
        })}
      </ol>
      {breakdown.selectedInsiderIds.length > 0 && (
        <small>Visible score uses the selected Insider subset.</small>
      )}
    </section>
  );
}

function PlatformContributions({ node }: { node: GraphNode }) {
  const rawPlatformContributions = [
    ...(Array.isArray(node.scoreBreakdown?.weightedPlatforms) ? node.scoreBreakdown.weightedPlatforms : [])
  ]
    .filter((platform) => numberValue(platform?.contribution) !== null && platform.contribution > 0)
    .sort((left, right) => right.contribution - left.contribution);
  const platformContributions = rawPlatformContributions;
  const calibrationMultiplier = scoreContributionMultiplier(node);

  return (
    <section className="score-platform-section" aria-labelledby={`score-platforms-${node.id}`}>
      <h3 id={`score-platforms-${node.id}`}>Platform contributions</h3>
      {platformContributions.length > 0 ? (
        <ol className="score-platform-contributions">
          {platformContributions.map((platform) => (
            <li key={platform.platform}>
              <PlatformIdentity platform={platform.platform} />
              <span className="score-platform-contribution">
                <strong>{formatScore(platform.contribution * calibrationMultiplier)} pts</strong>
                <small>{formatItemCount(Math.max(0, Math.round(numberValue(platform.evidenceCount) ?? 0)))}</small>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="score-platform-empty">No positive contributions yet.</p>
      )}
    </section>
  );
}

function scoreContributionMultiplier(node: GraphNode): number {
  const scaleFactor = node.scoreBreakdown?.calibration?.scaleFactor;
  return node.scoreBreakdown?.calibration?.method === "global_best_ratio" &&
    typeof scaleFactor === "number" &&
    Number.isFinite(scaleFactor)
    ? scaleFactor
    : 1;
}

function isScoredEvidence(item: EvidenceItem): boolean {
  return item.contributionScore > 0 && item.tractionStatus !== "unscored";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatItemCount(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

function formatScore(score: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(score);
}

function formatSignedScore(score: number): string {
  if (score === 0) return "0";
  return `${score > 0 ? "+" : "−"}${formatScore(Math.abs(score))}`;
}
