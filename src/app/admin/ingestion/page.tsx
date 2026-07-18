"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, LockKeyhole, RefreshCw } from "lucide-react";
import type {
  DiagnosticsSection,
  DiagnosticsView,
  IngestionArtifactDiagnostic,
  IngestionDiagnosticsResponse,
  IngestionFailureDiagnostic,
  IngestionRunDiagnostic,
  IngestionTaskDiagnostic,
  SummaryMetric,
} from "@/lib/admin/ingestion-diagnostics";
import styles from "./admin-ingestion.module.css";

const VIEWS: Array<{ id: DiagnosticsView; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "runs", label: "Runs" },
  { id: "tasks", label: "Tasks" },
  { id: "failures", label: "Failures" },
  { id: "artifacts", label: "Artifacts" },
];

interface ApiError {
  error?: { code?: string; message?: string };
}

export default function AdminIngestionPage() {
  const [view, setView] = useState<DiagnosticsView>("summary");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [platform, setPlatform] = useState("");
  const [runId, setRunId] = useState("");
  const [secret, setSecret] = useState("");
  const [appliedSecret, setAppliedSecret] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState<IngestionDiagnosticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const requestUrl = useMemo(() => {
    const params = new URLSearchParams({ view, page: String(page), pageSize: "25" });
    if (status && (view === "runs" || view === "tasks")) params.set("status", status);
    if (platform && (view === "tasks" || view === "failures")) {
      params.set("platform", platform);
    }
    if (runId && (view === "runs" || view === "tasks")) params.set("runId", runId);
    return `/api/admin/ingestion?${params}`;
  }, [page, platform, runId, status, view]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(requestUrl, {
        cache: "no-store",
        headers: appliedSecret ? { Authorization: `Bearer ${appliedSecret}` } : undefined,
        signal: controller.signal,
      })
      .then(async (response) => ({
        response,
        body: await response.json() as IngestionDiagnosticsResponse & ApiError,
      }))
      .then(({ response, body }) => {
        if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status}).`);
        setData(body);
        setError(null);
        setLoading(false);
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setData(null);
        setError(requestError instanceof Error ? requestError.message : "Diagnostics request failed.");
        setLoading(false);
      });
    return () => controller.abort();
  }, [appliedSecret, refreshKey, requestUrl]);

  function selectView(nextView: DiagnosticsView) {
    setView(nextView);
    setPage(1);
    setLoading(true);
  }

  function refresh() {
    setLoading(true);
    setAppliedSecret(secret);
    setRefreshKey((value) => value + 1);
  }

  const section = sectionForView(data, view);
  const totalPages = section?.total === null || section?.total === undefined
    ? null
    : Math.max(1, Math.ceil(section.total / section.pageSize));

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>Admin / Ingestion</p>
          <h1>Ingestion diagnostics</h1>
          <div className={styles.sourceLine}>
            <span className={`${styles.sourceDot} ${data?.source.kind === "supabase" ? styles.live : ""}`} />
            <span>{data?.source.label ?? (loading ? "Checking source" : "Source unavailable")}</span>
            {data?.generatedAt ? <time>{formatTime(data.generatedAt)}</time> : null}
          </div>
        </div>
        <div className={styles.actions}>
          <label className={styles.secretField}>
            <LockKeyhole aria-hidden="true" size={15} />
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Admin secret"
              autoComplete="current-password"
              aria-label="Admin secret"
            />
          </label>
          <button className={styles.iconButton} type="button" onClick={refresh} title="Refresh diagnostics" aria-label="Refresh diagnostics">
            <RefreshCw aria-hidden="true" size={17} className={loading ? styles.spinning : ""} />
          </button>
        </div>
      </header>

      <nav className={styles.tabs} aria-label="Diagnostics views">
        {VIEWS.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={view === item.id}
            className={view === item.id ? styles.activeTab : ""}
            onClick={() => selectView(item.id)}
            key={item.id}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {view !== "summary" ? (
        <section className={styles.filters} aria-label="Diagnostics filters">
          {(view === "runs" || view === "tasks") ? (
            <label>
              <span>Status</span>
              <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); setLoading(true); }}>
                <option value="">All statuses</option>
                <option value="queued">Queued</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="needs_review">Needs review</option>
                <option value="blocked_or_empty">Blocked / empty</option>
                <option value="retry_scheduled">Retry scheduled</option>
                <option value="skipped">Skipped</option>
                <option value="canceled">Canceled</option>
                <option value="dead_lettered">Dead lettered</option>
              </select>
            </label>
          ) : null}
          {(view === "tasks" || view === "failures") ? (
            <label>
              <span>Platform</span>
              <input value={platform} onChange={(event) => { setPlatform(event.target.value); setPage(1); setLoading(true); }} placeholder="All platforms" />
            </label>
          ) : null}
          {(view === "runs" || view === "tasks") ? (
            <label className={styles.runFilter}>
              <span>Run ID</span>
              <input value={runId} onChange={(event) => { setRunId(event.target.value); setPage(1); setLoading(true); }} placeholder="All runs" />
            </label>
          ) : null}
        </section>
      ) : null}

      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {data?.source.reason ? <div className={styles.notice}>{data.source.reason}</div> : null}
      {section && !section.available ? <div className={styles.notice}>{section.reason}</div> : null}

      <section className={styles.content} aria-busy={loading}>
        {loading && !data ? <div className={styles.empty}>Loading diagnostics...</div> : null}
        {!loading && data?.summary ? <SummaryView summary={data.summary} /> : null}
        {!loading && data?.runs?.available ? <RunsTable section={data.runs} /> : null}
        {!loading && data?.tasks?.available ? <TasksTable section={data.tasks} /> : null}
        {!loading && data?.failures?.available ? <FailuresTable section={data.failures} /> : null}
        {!loading && data?.artifacts?.available ? <ArtifactsTable section={data.artifacts} /> : null}
      </section>

      {view !== "summary" && section?.available ? (
        <footer className={styles.pagination}>
          <span>{section.total === null ? "Total unavailable" : `${section.total.toLocaleString()} records`}</span>
          <div>
            <button type="button" className={styles.iconButton} disabled={page <= 1} onClick={() => { setPage((value) => Math.max(1, value - 1)); setLoading(true); }} title="Previous page" aria-label="Previous page">
              <ChevronLeft aria-hidden="true" size={17} />
            </button>
            <span>Page {page}{totalPages ? ` of ${totalPages}` : ""}</span>
            <button type="button" className={styles.iconButton} disabled={totalPages !== null ? page >= totalPages : section.items.length < section.pageSize} onClick={() => { setPage((value) => value + 1); setLoading(true); }} title="Next page" aria-label="Next page">
              <ChevronRight aria-hidden="true" size={17} />
            </button>
          </div>
        </footer>
      ) : null}
    </main>
  );
}

function SummaryView({ summary }: { summary: NonNullable<IngestionDiagnosticsResponse["summary"]> }) {
  const metrics: Array<[string, SummaryMetric]> = [
    ["Runs", summary.runs],
    ["Active runs", summary.activeRuns],
    ["Tasks", summary.tasks],
    ["Pending tasks", summary.pendingTasks],
    ["Failures", summary.failures],
    ["Artifacts", summary.artifacts],
  ];
  return (
    <>
      <div className={styles.metricGrid}>
        {metrics.map(([label, metric]) => (
          <article className={styles.metric} key={label} title={metric.reason ?? undefined}>
            <span>{label}</span>
            <strong>{metric.value === null ? "Unavailable" : metric.value.toLocaleString()}</strong>
            {metric.reason ? <small>{metric.reason}</small> : null}
          </article>
        ))}
      </div>
      <div className={styles.latestRun}>
        <span>Latest run</span>
        <strong title={summary.latestRunReason ?? undefined}>
          {summary.latestRunAt ? formatTime(summary.latestRunAt) : summary.latestRunReason ?? "No runs"}
        </strong>
      </div>
    </>
  );
}

function RunsTable({ section }: { section: DiagnosticsSection<IngestionRunDiagnostic> }) {
  return <DataTable headers={["Run", "Status", "Started", "Finished", "Logs", "Errors"]} empty={section.items.length === 0}>
    {section.items.map((run) => <tr key={run.id}>
      <td className={styles.mono} title={run.id}>{compactId(run.id)}</td>
      <td><Status value={run.status} /></td>
      <td>{formatTime(run.startedAt)}</td><td>{formatTime(run.finishedAt)}</td>
      <td>{run.logCount}</td><td>{run.errorCount}</td>
    </tr>)}
  </DataTable>;
}

function TasksTable({ section }: { section: DiagnosticsSection<IngestionTaskDiagnostic> }) {
  return <DataTable headers={["Company", "Platform", "Status", "Attempts", "Updated", "Checkpoint", "Last error"]} empty={section.items.length === 0}>
    {section.items.map((task) => <tr key={task.id}>
      <td>{task.companyName || "Unknown"}</td><td>{task.platform}</td><td><Status value={task.status} /></td>
      <td>{task.attempts}</td><td>{formatTime(task.updatedAt)}</td>
      <td className={styles.mono} title={task.checkpointKey}>{compactText(task.checkpointKey, 28)}</td>
      <td className={styles.message} title={task.lastError ?? undefined}>{task.lastError ?? ""}</td>
    </tr>)}
  </DataTable>;
}

function FailuresTable({ section }: { section: DiagnosticsSection<IngestionFailureDiagnostic> }) {
  return <DataTable headers={["Occurred", "Company", "Platform", "Kind", "Message", "Source"]} empty={section.items.length === 0}>
    {section.items.map((failure) => <tr key={failure.id}>
      <td>{formatTime(failure.occurredAt)}</td><td>{failure.companyName}</td><td>{failure.platform}</td>
      <td><Status value={failure.kind} /></td><td className={styles.message} title={failure.message}>{failure.message}</td>
      <td>{failure.sourceUrl ? <a href={failure.sourceUrl} target="_blank" rel="noreferrer">Open</a> : ""}</td>
    </tr>)}
  </DataTable>;
}

function ArtifactsTable({ section }: { section: DiagnosticsSection<IngestionArtifactDiagnostic> }) {
  return <DataTable headers={["Artifact", "Platform", "Kind", "Last seen", "Size", "Location"]} empty={section.items.length === 0}>
    {section.items.map((artifact) => <tr key={artifact.id}>
      <td className={styles.mono} title={artifact.id}>{compactId(artifact.id)}</td><td>{artifact.platform ?? "Local"}</td>
      <td>{artifact.kind}</td><td>{formatTime(artifact.lastSeenAt)}</td><td>{formatBytes(artifact.sizeBytes)}</td>
      <td className={styles.message} title={artifact.location ?? undefined}>{artifact.location?.startsWith("http") ? <a href={artifact.location} target="_blank" rel="noreferrer">Open</a> : artifact.location ?? ""}</td>
    </tr>)}
  </DataTable>;
}

function DataTable({ headers, empty, children }: { headers: string[]; empty: boolean; children: React.ReactNode }) {
  if (empty) return <div className={styles.empty}>No records match the current filters.</div>;
  return <div className={styles.tableWrap}><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function Status({ value }: { value: string | null }) {
  const normalized = value || "unknown";
  return <span className={`${styles.status} ${styles[`status_${normalized}`] ?? ""}`}>{normalized.replaceAll("_", " ")}</span>;
}

function sectionForView(data: IngestionDiagnosticsResponse | null, view: DiagnosticsView) {
  if (!data) return null;
  if (view === "runs") return data.runs;
  if (view === "tasks") return data.tasks;
  if (view === "failures") return data.failures;
  if (view === "artifacts") return data.artifacts;
  return null;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date);
}

function compactId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function compactText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function formatBytes(value: number | null): string {
  if (value === null) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
