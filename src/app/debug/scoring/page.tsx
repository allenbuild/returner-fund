import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { EvidenceItem, GraphNode } from "@/lib/graph/types";

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DebugScoringPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const leftName = value(params.left) ?? "InsForge";
  const rightName = value(params.right) ?? "Interfaze";
  const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
  const left = findCompany(graph.nodes, leftName);
  const right = findCompany(graph.nodes, rightName);

  return (
    <main className="debug-page">
      <header className="debug-header">
        <div>
          <span className="eyebrow">debug</span>
          <h1>Scoring Comparison</h1>
        </div>
        <a href="/debug/evidence">Evidence audit</a>
      </header>

      <section className="debug-grid">
        {[left, right].map((node) =>
          node ? (
            <article className="debug-panel" key={node.id}>
              <h2>{node.label}</h2>
              <dl className="debug-dl">
                <div>
                  <dt>Total score</dt>
                  <dd>{node.score}</dd>
                </div>
                <div>
                  <dt>Top platform</dt>
                  <dd>{node.topPlatform ?? "none"}</dd>
                </div>
                <div>
                  <dt>Weighted available</dt>
                  <dd>{node.scoreBreakdown?.weightedAvailableScore ?? 0}</dd>
                </div>
                <div>
                  <dt>Coverage factor</dt>
                  <dd>{node.scoreBreakdown?.coverageFactor ?? 0}</dd>
                </div>
              </dl>

              <h3>Platform Scores</h3>
              <table className="debug-table">
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>Score</th>
                    <th>Applied weight</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {(node.scoreBreakdown?.weightedPlatforms ?? []).map((platform) => (
                    <tr key={platform.platform}>
                      <td>{platform.platform}</td>
                      <td>{platform.score}</td>
                      <td>{Math.round(platform.appliedWeight * 100)}%</td>
                      <td>{platform.evidenceCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h3>Top Evidence</h3>
              <EvidenceTable evidence={topEvidenceForNode(graph.evidence, node)} />
            </article>
          ) : (
            <article className="debug-panel" key="missing">
              <h2>Company not found</h2>
            </article>
          )
        )}
      </section>
    </main>
  );
}

function EvidenceTable({ evidence }: { evidence: EvidenceItem[] }) {
  return (
    <table className="debug-table">
      <thead>
        <tr>
          <th>Platform</th>
          <th>Score</th>
          <th>Raw</th>
          <th>Metrics</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {evidence.map((item) => (
          <tr key={item.id}>
            <td>{item.platform}</td>
            <td>{item.contributionScore}</td>
            <td>{item.rawEngagement ?? 0}</td>
            <td>{formatMetrics(item.metrics)}</td>
            <td>
              <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                {item.authorName}
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function topEvidenceForNode(evidence: EvidenceItem[], node: GraphNode): EvidenceItem[] {
  return evidence
    .filter((item) => node.evidenceIds.includes(item.id))
    .filter((item) => item.contributionScore > 0)
    .sort((left, right) => right.contributionScore - left.contributionScore)
    .slice(0, 10);
}

function findCompany(nodes: GraphNode[], name: string): GraphNode | undefined {
  const normalized = name.toLowerCase();
  return nodes.find((node) => node.entityType === "company" && node.label.toLowerCase() === normalized);
}

function formatMetrics(metrics: EvidenceItem["metrics"]): string {
  return Object.entries(metrics)
    .filter(([, metric]) => metric !== undefined)
    .map(([metric, value]) => `${metric}:${value}`)
    .join(", ");
}

function value(input: string | string[] | undefined): string | undefined {
  return Array.isArray(input) ? input[0] : input;
}
