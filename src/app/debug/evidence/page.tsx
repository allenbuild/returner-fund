import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { EvidenceItem, GraphNode } from "@/lib/graph/types";

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DebugEvidencePage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const companyName = value(params.company) ?? "Runtime";
  const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
  const company = findCompany(graph.nodes, companyName);
  const evidence = company
    ? selectedNodeEvidence(graph, company)
    : graph.evidence.sort((left, right) => right.contributionScore - left.contributionScore);

  return (
    <main className="debug-page">
      <header className="debug-header">
        <div>
          <span className="eyebrow">debug</span>
          <h1>Evidence Attachment Audit</h1>
          <p>{company ? `${company.label}: ${evidence.length} attached evidence rows` : "All evidence rows"}</p>
        </div>
        <a href="/debug/scoring">Scoring comparison</a>
      </header>

      <section className="debug-panel">
        <EvidenceAttachmentTable evidence={evidence.slice(0, 250)} owner={company} />
      </section>
    </main>
  );
}

function EvidenceAttachmentTable({ evidence, owner }: { evidence: EvidenceItem[]; owner?: GraphNode }) {
  const ownerEntityIds = owner ? new Set([owner.entityId, ...owner.relatedEntityIds]) : null;

  return (
    <table className="debug-table debug-table-wide">
      <thead>
        <tr>
          <th>post_id</th>
          <th>platform</th>
          <th>score</th>
          <th>post_url</th>
          <th>platform_post_id</th>
          <th>last_checked_at</th>
          <th>attached_company_id</th>
          <th>attached_company_name</th>
          <th>entity_id</th>
          <th>social_account_id</th>
          <th>account_url</th>
          <th>match_reason</th>
          <th>review_state</th>
          {ownerEntityIds && <th>in_selected_scope</th>}
        </tr>
      </thead>
      <tbody>
        {evidence.map((item) => (
          <tr key={item.id}>
            <td>{item.id}</td>
            <td>{item.platform}</td>
            <td>{item.contributionScore}</td>
            <td>
              <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                {item.sourceUrl}
              </a>
            </td>
            <td>{item.platformPostId ?? ""}</td>
            <td>{item.last_checked_at ?? ""}</td>
            <td>{item.attachedCompanyId ?? ""}</td>
            <td>{item.attachedCompanyName ?? ""}</td>
            <td>{item.entityId}</td>
            <td>{item.socialAccountId ?? ""}</td>
            <td>{item.accountUrl ?? ""}</td>
            <td>{item.matchReason ?? item.why}</td>
            <td>{item.review_state ?? "verified"}</td>
            {ownerEntityIds && <td>{String(ownerEntityIds.has(item.entityId))}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function findCompany(nodes: GraphNode[], name: string): GraphNode | undefined {
  const normalized = name.toLowerCase();
  return nodes.find((node) => node.entityType === "company" && node.label.toLowerCase() === normalized);
}

function value(input: string | string[] | undefined): string | undefined {
  return Array.isArray(input) ? input[0] : input;
}
