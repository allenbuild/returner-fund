import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import { buildThumbnailCoverageReport } from "@/lib/ingestion/thumbnail-debug";

export default function ThumbnailDebugPage() {
  const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
  const report = buildThumbnailCoverageReport(graph);

  return (
    <main className="debug-page">
      <header className="debug-header">
        <div>
          <span className="eyebrow">debug</span>
          <h1>Thumbnail Coverage</h1>
          <p>
            {report.rowsWithRealThumbnail}/{report.evidenceRows} evidence rows have real thumbnails;{" "}
            {report.rowsMissingThumbnail} rows are still missing covers.
          </p>
        </div>
        <nav className="debug-nav">
          <a href="/debug/instagram-coverage">Instagram</a>
          <a href="/debug/evidence">Evidence</a>
          <a href="/debug/coverage">Coverage</a>
        </nav>
      </header>

      <section className="debug-grid">
        <SummaryCard label="Evidence rows" value={report.evidenceRows} />
        <SummaryCard label="Real thumbnails" value={report.rowsWithRealThumbnail} />
        <SummaryCard label="Fallback thumbnails" value={report.rowsWithFallbackThumbnail} />
        <SummaryCard label="Missing thumbnails" value={report.rowsMissingThumbnail} />
      </section>

      <section className="debug-panel">
        <h2>Platform Coverage</h2>
        <table className="debug-table">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Evidence</th>
              <th>Real</th>
              <th>Fallback</th>
              <th>Missing</th>
              <th>Sources</th>
            </tr>
          </thead>
          <tbody>
            {report.platformCoverage.map((row) => (
              <tr key={row.platform}>
                <td>{row.platform}</td>
                <td>{row.evidenceRows}</td>
                <td>{row.withRealThumbnail}</td>
                <td>{row.withFallback}</td>
                <td>{row.missing}</td>
                <td>{JSON.stringify(row.thumbnailSources)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="debug-panel">
        <h2>Missing Thumbnail Examples</h2>
        <table className="debug-table debug-table-wide">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Company</th>
              <th>Title</th>
              <th>URL</th>
              <th>Link status</th>
            </tr>
          </thead>
          <tbody>
            {report.missingExamples.slice(0, 100).map((row) => (
              <tr key={row.id}>
                <td>{row.platform}</td>
                <td>{row.companyName}</td>
                <td>{row.title}</td>
                <td>
                  <a href={row.sourceUrl} target="_blank" rel="noreferrer">
                    {row.sourceUrl}
                  </a>
                </td>
                <td>{row.linkStatus ?? row.linkFailureReason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="debug-panel">
        <h2>Fallback Thumbnail Examples</h2>
        <table className="debug-table debug-table-wide">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Company</th>
              <th>Source</th>
              <th>URL</th>
              <th>Thumbnail</th>
            </tr>
          </thead>
          <tbody>
            {report.blockedOrFallbackExamples.slice(0, 100).map((row) => (
              <tr key={row.id}>
                <td>{row.platform}</td>
                <td>{row.companyName}</td>
                <td>{row.thumbnailSource}</td>
                <td>
                  <a href={row.sourceUrl} target="_blank" rel="noreferrer">
                    {row.sourceUrl}
                  </a>
                </td>
                <td>{row.thumbnailUrl}</td>
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
