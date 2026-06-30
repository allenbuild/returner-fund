"use client";

import { dedupeEvidenceItems } from "@/lib/graph/dedupe";
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

  const topItems = dedupeEvidenceItems(
    [...evidence].filter((item) => item.contributionScore > 0).sort((a, b) => b.contributionScore - a.contributionScore)
  ).slice(0, 20);
  const founderAccounts = node.founders.flatMap((founder) =>
    founder.socialAccounts.map((account) => ({ founderName: founder.name, account }))
  );

  return (
    <aside className="node-panel">
      <header className="node-panel-header">
        <span className="eyebrow">company</span>
        <div className="node-title-row">
          <h2>{node.label}</h2>
          <div className="score-orb" aria-label={`Score ${node.score}`}>
            <span>{node.score}</span>
          </div>
        </div>
      </header>

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
          <h3>Top contributing posts</h3>
          <span>{topItems.length}/20</span>
        </div>
        <div className="top-post-list">
          {topItems.map((item, index) => (
            <EvidenceMediaCard item={item} compact={index > 5} key={item.id} />
          ))}
          {!topItems.length && <div className="empty-state">No post-level GitHub/social traction found yet.</div>}
        </div>
      </section>
    </aside>
  );
}
