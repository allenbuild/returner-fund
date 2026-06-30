import fs from "node:fs/promises";
import path from "node:path";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import { buildInstagramCoverageReport } from "@/lib/ingestion/instagram-debug";
import companiesSnapshot from "@/lib/yc/spring-2026-companies.json";
import overridesSnapshot from "@/lib/social/verified-social-overrides.json";
import publicEvidenceSnapshot from "@/lib/social/public-evidence-current.json";
import loggedInEvidenceSnapshot from "@/lib/social/logged-in-evidence-current.json";
import targetedEvidenceSnapshot from "@/lib/social/targeted-evidence-current.json";
import type { RawInstagramDiscoveryReport } from "@/lib/ingestion/instagram-debug";

export default async function InstagramCoverageDebugPage() {
  const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
  const discovery = await readInstagramDiscoveryReport();
  const report = buildInstagramCoverageReport({
    graph,
    companies: companiesSnapshot.companies,
    overrides: overridesSnapshot,
    snapshots: [publicEvidenceSnapshot, loggedInEvidenceSnapshot, targetedEvidenceSnapshot],
    discovery
  });

  return (
    <main className="debug-page">
      <header className="debug-header">
        <div>
          <span className="eyebrow">debug</span>
          <h1>Instagram Coverage</h1>
          <p>
            {report.evidence.companiesWithScoredEvidence}/{report.companyCount} companies have scored Instagram evidence;{" "}
            {report.profiles.discoveryAttempts} discovery attempts recorded.
          </p>
        </div>
        <nav className="debug-nav">
          <a href="/debug/thumbnails">Thumbnails</a>
          <a href="/debug/coverage">Coverage</a>
          <a href="/debug/evidence?company=HeyClicky">HeyClicky evidence</a>
        </nav>
      </header>

      <section className="debug-grid">
        <SummaryCard label="Snapshot IG profiles" value={report.profiles.snapshotCompanyProfiles + report.profiles.snapshotFounderProfiles} />
        <SummaryCard label="Verified IG overrides" value={report.profiles.verifiedCompanyOverrides + report.profiles.verifiedFounderOverrides} />
        <SummaryCard label="Instagram rows" value={report.evidence.rows} />
        <SummaryCard label="Real IG thumbnails" value={report.evidence.realThumbnailRows} />
      </section>

      <section className="debug-panel">
        <h2>Root Cause</h2>
        <ul>
          {report.rootCause.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="debug-panel">
        <h2>Companies With Instagram Evidence</h2>
        <table className="debug-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Rows</th>
              <th>Scored</th>
              <th>Thumbnails</th>
              <th>Top URL</th>
            </tr>
          </thead>
          <tbody>
            {report.feedCompanies.map((row) => (
              <tr key={row.companyId}>
                <td>{row.companyName}</td>
                <td>{row.instagramRows}</td>
                <td>{row.scoredRows}</td>
                <td>{row.thumbnailRows}</td>
                <td>
                  {row.topPostUrl ? (
                    <a href={row.topPostUrl} target="_blank" rel="noreferrer">
                      {row.topPostUrl}
                    </a>
                  ) : (
                    "none"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="debug-panel">
        <h2>Missing Company Examples</h2>
        <table className="debug-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {report.missingCompanies.slice(0, 80).map((row) => (
              <tr key={row.companyId}>
                <td>{row.companyName}</td>
                <td>{row.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="debug-panel">
        <h2>Recent Discovery Attempts</h2>
        <table className="debug-table debug-table-wide">
          <thead>
            <tr>
              <th>Company</th>
              <th>Entity</th>
              <th>Source</th>
              <th>Status</th>
              <th>Useful</th>
              <th>Query</th>
              <th>Failure</th>
            </tr>
          </thead>
          <tbody>
            {(report.attempts ?? []).slice(-150).map((attempt, index) => (
              <tr key={`${attempt.companySlug}-${attempt.source}-${index}`}>
                <td>{attempt.companyName}</td>
                <td>{attempt.entityName ?? attempt.entityType}</td>
                <td>{attempt.source}</td>
                <td>{attempt.status}</td>
                <td>{attempt.useful_result_count ?? 0}</td>
                <td>{attempt.query}</td>
                <td>{attempt.failure_reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <article className="debug-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

async function readInstagramDiscoveryReport(): Promise<RawInstagramDiscoveryReport | null> {
  try {
    const filePath = path.join(process.cwd(), "outputs", "instagram-discovery-candidates.json");
    return JSON.parse(await fs.readFile(filePath, "utf8")) as RawInstagramDiscoveryReport;
  } catch {
    return null;
  }
}
