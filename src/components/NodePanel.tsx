"use client";

import { dedupeEvidenceItems } from "@/lib/graph/dedupe";
import { TOP_POSTS_LIMIT } from "@/lib/graph/presentation-limits";
import type { EvidenceItem, GraphNode } from "@/lib/graph/types";
import { EvidenceMediaCard } from "./EvidenceMediaCard";
import { PlatformIdentity } from "./PlatformLogo";

interface NodePanelProps {
  node: GraphNode | null;
  relatedNodes: GraphNode[];
  evidence: EvidenceItem[];
  highlightedFounderId?: string | null;
}

export function NodePanel({ node, evidence, highlightedFounderId }: NodePanelProps) {
  if (!node) {
    return (
      <aside className="node-panel">
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

  return (
    <aside className="node-panel">
      <header className="node-panel-header">
        <div className="node-title-row">
          <h2>{node.label}</h2>
          <div className="score-orb" aria-label={`Score ${node.score}`}>
            <span>{node.score}</span>
          </div>
        </div>
      </header>

      {node.entityType === "company" && (
        <PlatformContributions node={node} />
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
    </aside>
  );
}

function PlatformContributions({ node }: { node: GraphNode }) {
  const rawPlatformContributions = [
    ...(Array.isArray(node.scoreBreakdown?.weightedPlatforms) ? node.scoreBreakdown.weightedPlatforms : [])
  ]
    .filter((platform) => numberValue(platform?.contribution) !== null && platform.contribution > 0)
    .sort((left, right) => right.contribution - left.contribution);
  const platformContributions = allocateCalibrationAcrossPlatforms(node, rawPlatformContributions);

  return (
    <section className="score-platform-section" aria-labelledby={`score-platforms-${node.id}`}>
      <h3 id={`score-platforms-${node.id}`}>Platform contributions</h3>
      {platformContributions.length > 0 ? (
        <ol className="score-platform-contributions">
          {platformContributions.map((platform) => (
            <li key={platform.platform}>
              <PlatformIdentity platform={platform.platform} />
              <span className="score-platform-contribution">
                <strong>{formatScore(platform.contribution)} pts</strong>
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

type WeightedPlatformContribution = NonNullable<GraphNode["scoreBreakdown"]>["weightedPlatforms"][number];

function allocateCalibrationAcrossPlatforms(
  node: GraphNode,
  platforms: WeightedPlatformContribution[]
): WeightedPlatformContribution[] {
  const calibration = node.scoreBreakdown?.calibration;
  const rawTotal = platforms.reduce((sum, platform) => sum + platform.contribution, 0);
  if (!calibration || calibration.method === "none" || rawTotal <= 0 || node.score <= 0) {
    return platforms;
  }

  const targetTenths = Math.round(node.score * 10);
  const allocations = platforms.map((platform, index) => {
    const exactTenths = (platform.contribution / rawTotal) * targetTenths;
    const floorTenths = Math.floor(exactTenths);
    return { index, exactTenths, tenths: floorTenths };
  });
  let remainder = targetTenths - allocations.reduce((sum, allocation) => sum + allocation.tenths, 0);
  const remainderOrder = [...allocations].sort(
    (left, right) =>
      right.exactTenths - right.tenths - (left.exactTenths - left.tenths) || left.index - right.index
  );
  for (let index = 0; index < remainderOrder.length && remainder > 0; index += 1, remainder -= 1) {
    remainderOrder[index].tenths += 1;
  }

  return platforms.map((platform, index) => ({
    ...platform,
    contribution: allocations[index].tenths / 10
  }));
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
