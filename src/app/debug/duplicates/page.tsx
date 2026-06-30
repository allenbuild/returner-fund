import { buildDuplicateReport } from "@/lib/ingestion/public-data-debug";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

export default function DebugDuplicatesPage() {
  const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
  const report = buildDuplicateReport(graph);

  return (
    <main className="debug-page">
      <header className="debug-header">
        <div>
          <span className="eyebrow">debug</span>
          <h1>Duplicate Evidence Audit</h1>
          <p>
            {report.duplicateGroupCount} duplicate canonical evidence groups, {report.duplicateEvidenceCount} rows.
            {" "}
            {report.duplicateAccountGroupCount} duplicate social-account groups.
          </p>
        </div>
        <nav className="debug-nav">
          <a href="/debug/coverage">Coverage</a>
          <a href="/debug/workers">Workers</a>
          <a href="/debug/evidence">Evidence</a>
        </nav>
      </header>

      <section className="debug-panel">
        <h2>Evidence Rows</h2>
        {report.groups.length === 0 ? (
          <div className="empty-state">No duplicate canonical evidence keys in the current graph.</div>
        ) : (
          <table className="debug-table debug-table-wide">
            <thead>
              <tr>
                <th>Key</th>
                <th>Platform</th>
                <th>Platform post IDs</th>
                <th>Latest checked</th>
                <th>Evidence IDs</th>
                <th>URLs</th>
              </tr>
            </thead>
            <tbody>
              {report.groups.map((group) => (
                <tr key={group.key}>
                  <td>{group.key}</td>
                  <td>{group.platform}</td>
                  <td>{group.platformPostIds.join(", ")}</td>
                  <td>{group.latestCheckedAt ?? ""}</td>
                  <td>{group.evidenceIds.join(", ")}</td>
                  <td>{group.urls.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="debug-panel">
        <h2>Social Accounts</h2>
        {report.duplicateAccountGroups.length === 0 ? (
          <div className="empty-state">No duplicate social-account attachments in the current graph.</div>
        ) : (
          <table className="debug-table debug-table-wide">
            <thead>
              <tr>
                <th>Company</th>
                <th>Platform</th>
                <th>Entities</th>
                <th>Handles</th>
                <th>Account IDs</th>
                <th>URLs</th>
              </tr>
            </thead>
            <tbody>
              {report.duplicateAccountGroups.map((group) => (
                <tr key={group.key}>
                  <td>{group.companyName}</td>
                  <td>{group.platform}</td>
                  <td>{group.entityNames.join(", ")}</td>
                  <td>{group.handles.join(", ")}</td>
                  <td>{group.accountIds.join(", ")}</td>
                  <td>{group.urls.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
