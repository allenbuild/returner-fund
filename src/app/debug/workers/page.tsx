import { buildWorkerReport } from "@/lib/ingestion/public-data-debug";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

export default function DebugWorkersPage() {
  const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
  const report = buildWorkerReport(graph, 12);
  const sampleTasks = report.lanes.flatMap((lane) => lane.tasks.slice(0, 18));

  return (
    <main className="debug-page">
      <header className="debug-header">
        <div>
          <span className="eyebrow">debug</span>
          <h1>Ingestion Workers</h1>
          <p>
            {report.workerCount} workers, {report.taskCount} checkpointed public connector tasks.
          </p>
        </div>
        <nav className="debug-nav">
          <a href="/debug/coverage">Coverage</a>
          <a href="/debug/duplicates">Duplicates</a>
          <a href="/debug/evidence">Evidence</a>
        </nav>
      </header>

      <section className="debug-panel">
        <h2>Status Counts</h2>
        <dl className="debug-dl">
          {Object.entries(report.statusCounts).map(([status, count]) => (
            <div key={status}>
              <dt>{status}</dt>
              <dd>{count}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="debug-panel">
        <h2>Worker Lanes</h2>
        <table className="debug-table">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Tasks</th>
              <th>Completed</th>
              <th>Needs review</th>
              <th>Blocked/empty</th>
              <th>Queued</th>
            </tr>
          </thead>
          <tbody>
            {report.lanes.map((lane) => (
              <tr key={lane.workerId}>
                <td>{lane.workerId}</td>
                <td>{lane.taskCount}</td>
                <td>{lane.completed}</td>
                <td>{lane.needsReview}</td>
                <td>{lane.blockedOrEmpty}</td>
                <td>{lane.queued}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="debug-panel">
        <h2>Task Sample</h2>
        <table className="debug-table debug-table-wide">
          <thead>
            <tr>
              <th>Task</th>
              <th>Company</th>
              <th>Platform</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Rate limit</th>
              <th>Checkpoint</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {sampleTasks.map((task) => (
              <tr key={task.id}>
                <td>{task.id}</td>
                <td>{task.companyName}</td>
                <td>{task.platform}</td>
                <td>{task.status}</td>
                <td>{task.attempts}</td>
                <td>{task.rateLimitMs}ms</td>
                <td>{task.checkpointKey}</td>
                <td>{task.lastError ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
