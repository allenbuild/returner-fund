import { stat } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

export const DIAGNOSTICS_VIEWS = ["summary", "runs", "tasks", "failures", "artifacts"] as const;

export type DiagnosticsView = (typeof DIAGNOSTICS_VIEWS)[number];
export type DiagnosticsSourceKind = "supabase" | "filesystem" | "unavailable";

export interface DiagnosticsQuery {
  view: DiagnosticsView;
  page: number;
  pageSize: number;
  status?: string;
  platform?: string;
  runId?: string;
}

export interface DiagnosticsSource {
  kind: DiagnosticsSourceKind;
  label: string;
  reason: string | null;
}

export interface DiagnosticsSection<T> {
  available: boolean;
  reason: string | null;
  items: T[];
  total: number | null;
  page: number;
  pageSize: number;
}

export interface SummaryMetric {
  value: number | null;
  reason: string | null;
}

export interface IngestionSummary {
  runs: SummaryMetric;
  activeRuns: SummaryMetric;
  tasks: SummaryMetric;
  pendingTasks: SummaryMetric;
  failures: SummaryMetric;
  artifacts: SummaryMetric;
  latestRunAt: string | null;
  latestRunReason: string | null;
}

export interface IngestionRunDiagnostic {
  id: string;
  batchId: string | null;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  logCount: number;
  errorCount: number;
}

export interface IngestionTaskDiagnostic {
  id: string;
  runId: string | null;
  companyName: string;
  entityType: string;
  platform: string;
  status: string;
  attempts: number;
  checkpointKey: string;
  lastError: string | null;
  updatedAt: string;
}

export interface IngestionFailureDiagnostic {
  id: string;
  taskId: string | null;
  companyName: string;
  platform: string;
  kind: string;
  message: string;
  sourceUrl: string | null;
  occurredAt: string;
}

export interface IngestionArtifactDiagnostic {
  id: string;
  platform: string | null;
  kind: string;
  location: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  sizeBytes: number | null;
}

export interface IngestionDiagnosticsResponse {
  generatedAt: string;
  view: DiagnosticsView;
  source: DiagnosticsSource;
  filters: Omit<DiagnosticsQuery, "view">;
  summary?: IngestionSummary;
  runs?: DiagnosticsSection<IngestionRunDiagnostic>;
  tasks?: DiagnosticsSection<IngestionTaskDiagnostic>;
  failures?: DiagnosticsSection<IngestionFailureDiagnostic>;
  artifacts?: DiagnosticsSection<IngestionArtifactDiagnostic>;
}

type TableName = "ingestion_runs" | "ingestion_tasks" | "ingestion_artifact_manifests";
type FilterName = "status" | "platform" | "id" | "ingestion_run_id";

interface ReaderFilter {
  column: FilterName;
  value: string;
  values?: string[];
}

interface ReaderListOptions {
  columns: string;
  filters: ReaderFilter[];
  orderBy: string;
  ascending?: boolean;
  page: number;
  pageSize: number;
}

export interface DiagnosticsReader {
  count(table: TableName, filters?: ReaderFilter[]): Promise<number>;
  list(
    table: TableName,
    options: ReaderListOptions,
  ): Promise<{ rows: Array<Record<string, unknown>>; total: number }>;
}

interface ReadOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  reader?: DiagnosticsReader;
  now?: () => Date;
}

const FILESYSTEM_ARTIFACTS = [
  "outputs/longrun/active-run.json",
  "outputs/ingestion-refresh-stage-log-current.json",
  "outputs/ingest-public-s2026.json",
  "outputs/longrun/s26-collection-2026-07-09T16-57-54-179Z.summary.json",
] as const;

const RUN_COLUMNS = "id,batch_id,status,started_at,finished_at,logs,errors_json";
const TASK_COLUMNS =
  "id,ingestion_run_id,company_name,entity_type,platform,status,attempts,checkpoint_key,last_error,updated_at";
const FAILURE_COLUMNS =
  "id,ingestion_run_id,company_name,platform,last_failure_kind,last_error,last_attempt_at,updated_at";
const ARTIFACT_COLUMNS =
  "id,artifact_type,storage_uri,content_type,byte_size,sha256,created_at";

export function parseDiagnosticsQuery(searchParams: URLSearchParams): DiagnosticsQuery {
  const rawView = searchParams.get("view") ?? "summary";
  if (!DIAGNOSTICS_VIEWS.includes(rawView as DiagnosticsView)) {
    throw new Error(`view must be one of: ${DIAGNOSTICS_VIEWS.join(", ")}`);
  }

  const query: DiagnosticsQuery = {
    view: rawView as DiagnosticsView,
    page: parseInteger(searchParams.get("page"), 1, 1, 10_000, "page"),
    pageSize: parseInteger(searchParams.get("pageSize"), 25, 1, 100, "pageSize"),
    status: parseFilter(searchParams.get("status"), "status"),
    platform: parseFilter(searchParams.get("platform"), "platform"),
    runId: parseFilter(searchParams.get("runId"), "runId"),
  };
  if (query.status && query.view !== "runs" && query.view !== "tasks") {
    throw new Error("status is only supported for runs and tasks views");
  }
  if (query.platform && !["tasks", "failures"].includes(query.view)) {
    throw new Error("platform is only supported for tasks and failures views");
  }
  if (query.runId && query.view !== "runs" && query.view !== "tasks") {
    throw new Error("runId is only supported for runs and tasks views");
  }
  return query;
}

export async function readIngestionDiagnostics(
  query: DiagnosticsQuery,
  options: ReadOptions = {},
): Promise<IngestionDiagnosticsResponse> {
  const env = options.env ?? process.env;
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const filters = {
    page: query.page,
    pageSize: query.pageSize,
    status: query.status,
    platform: query.platform,
    runId: query.runId,
  };
  const configuredReader = options.reader ?? createSupabaseReader(env);

  if (configuredReader) {
    const response: IngestionDiagnosticsResponse = {
      generatedAt,
      view: query.view,
      source: { kind: "supabase", label: "Supabase operational tables", reason: null },
      filters,
    };
    await populateView(response, query, configuredReader);
    return response;
  }

  if (env.NODE_ENV === "development" && env.ADMIN_INGESTION_FILESYSTEM_FALLBACK !== "false") {
    return readFilesystemDiagnostics(query, options.cwd ?? process.cwd(), generatedAt);
  }

  return unavailableResponse(
    query,
    generatedAt,
    "Supabase diagnostics require NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
  );
}

async function populateView(
  response: IngestionDiagnosticsResponse,
  query: DiagnosticsQuery,
  reader: DiagnosticsReader,
): Promise<void> {
  if (query.view === "summary") {
    response.summary = await readSummary(reader);
    return;
  }

  if (query.view === "runs") {
    response.runs = await readSection(query, () => reader.list("ingestion_runs", {
      columns: RUN_COLUMNS,
      filters: runFilters(query),
      orderBy: "started_at",
      page: query.page,
      pageSize: query.pageSize,
    }), mapRun);
    return;
  }

  if (query.view === "tasks") {
    response.tasks = await readSection(query, () => reader.list("ingestion_tasks", {
      columns: TASK_COLUMNS,
      filters: taskFilters(query),
      orderBy: "updated_at",
      page: query.page,
      pageSize: query.pageSize,
    }), mapTask);
    return;
  }

  if (query.view === "failures") {
    response.failures = await readSection(query, () => reader.list("ingestion_tasks", {
      columns: FAILURE_COLUMNS,
      filters: [
        { column: "status", value: "", values: ["failed", "dead_lettered"] },
        ...(query.platform ? [{ column: "platform" as const, value: query.platform }] : []),
      ],
      orderBy: "last_attempt_at",
      page: query.page,
      pageSize: query.pageSize,
    }), mapFailure);
    return;
  }

  response.artifacts = await readSection(query, () => reader.list("ingestion_artifact_manifests", {
    columns: ARTIFACT_COLUMNS,
    filters: [],
    orderBy: "created_at",
    page: query.page,
    pageSize: query.pageSize,
  }), mapArtifact);
}

async function readSummary(reader: DiagnosticsReader): Promise<IngestionSummary> {
  const metric = async (work: () => Promise<number>): Promise<SummaryMetric> => {
    try {
      return { value: await work(), reason: null };
    } catch (error) {
      return { value: null, reason: errorReason(error) };
    }
  };

  const [runs, activeRuns, tasks, pendingTasks, failures, artifacts, latestRun] = await Promise.all([
    metric(() => reader.count("ingestion_runs")),
    metric(() => reader.count("ingestion_runs", [{ column: "status", value: "", values: ["queued", "running"] }])),
    metric(() => reader.count("ingestion_tasks")),
    metric(() => reader.count("ingestion_tasks", [{ column: "status", value: "", values: ["queued", "running", "retry_scheduled"] }])),
    metric(() => reader.count("ingestion_tasks", [{ column: "status", value: "", values: ["failed", "dead_lettered"] }])),
    metric(() => reader.count("ingestion_artifact_manifests")),
    reader.list("ingestion_runs", {
      columns: "id,started_at",
      filters: [],
      orderBy: "started_at",
      page: 1,
      pageSize: 1,
    })
      .then((result) => ({ result, reason: null }))
      .catch((error: unknown) => ({
        result: { rows: [] as Array<Record<string, unknown>>, total: 0 },
        reason: errorReason(error),
      })),
  ]);

  return {
    runs,
    activeRuns,
    tasks,
    pendingTasks,
    failures,
    artifacts,
    latestRunAt: stringOrNull(latestRun.result.rows[0]?.started_at),
    latestRunReason: latestRun.reason,
  };
}

async function readSection<T>(
  query: DiagnosticsQuery,
  work: () => Promise<{ rows: Array<Record<string, unknown>>; total: number }>,
  map: (row: Record<string, unknown>) => T,
): Promise<DiagnosticsSection<T>> {
  try {
    const result = await work();
    return {
      available: true,
      reason: null,
      items: result.rows.map(map),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    };
  } catch (error) {
    return unavailableSection(query, errorReason(error));
  }
}

function createSupabaseReader(env: NodeJS.ProcessEnv): DiagnosticsReader | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;

  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return {
    async count(table, filters = []) {
      let request = client.from(table).select("id", { count: "exact", head: true });
      request = applyFilters(request, filters);
      const { count, error } = await request;
      if (error) throw new Error(`${table}: ${error.message}`);
      if (count === null) throw new Error(`${table}: exact count was unavailable`);
      return count;
    },
    async list(table, options) {
      const start = (options.page - 1) * options.pageSize;
      let request = client.from(table).select(options.columns, { count: "exact" });
      request = applyFilters(request, options.filters);
      const { data, count, error } = await request
        .order(options.orderBy, { ascending: options.ascending ?? false })
        .range(start, start + options.pageSize - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      if (count === null) throw new Error(`${table}: exact count was unavailable`);
      return { rows: (data ?? []) as unknown as Array<Record<string, unknown>>, total: count };
    },
  };
}

function applyFilters<T extends { eq(column: string, value: string): T; in(column: string, values: string[]): T }>(
  request: T,
  filters: ReaderFilter[],
): T {
  return filters.reduce((current, filter) => {
    if (filter.values) return current.in(filter.column, filter.values);
    return current.eq(filter.column, filter.value);
  }, request);
}

async function readFilesystemDiagnostics(
  query: DiagnosticsQuery,
  cwd: string,
  generatedAt: string,
): Promise<IngestionDiagnosticsResponse> {
  const artifacts = await Promise.all(FILESYSTEM_ARTIFACTS.map(async (
    relativePath,
  ): Promise<IngestionArtifactDiagnostic | null> => {
    // This allowlisted filesystem view is development-only. Ignore the dynamic
    // caller cwd during production tracing; otherwise Turbopack conservatively
    // includes the entire repository in every route importing diagnostics.
    const absolutePath = path.resolve(/* turbopackIgnore: true */ cwd, relativePath);
    if (!isInsideDirectory(absolutePath, cwd)) return null;
    try {
      const details = await stat(/* turbopackIgnore: true */ absolutePath);
      if (!details.isFile()) return null;
      return {
        id: relativePath,
        platform: null,
        kind: "filesystem-json",
        location: relativePath,
        firstSeenAt: null,
        lastSeenAt: details.mtime.toISOString(),
        sizeBytes: details.size,
      } satisfies IngestionArtifactDiagnostic;
    } catch {
      return null;
    }
  }));
  const availableArtifacts = artifacts.filter((item): item is IngestionArtifactDiagnostic => item !== null);
  const source: DiagnosticsSource = {
    kind: "filesystem",
    label: "Development filesystem artifacts",
    reason: "Supabase is not configured; only fixed, allowlisted operational artifact paths are inspected.",
  };
  const response: IngestionDiagnosticsResponse = {
    generatedAt,
    view: query.view,
    source,
    filters: withoutView(query),
  };

  if (query.view === "summary") {
    const unavailable = (label: string): SummaryMetric => ({
      value: null,
      reason: `${label} are unavailable from the filesystem artifact index.`,
    });
    response.summary = {
      runs: unavailable("Run totals"),
      activeRuns: unavailable("Active run totals"),
      tasks: unavailable("Task totals"),
      pendingTasks: unavailable("Pending task totals"),
      failures: unavailable("Failure totals"),
      artifacts: { value: availableArtifacts.length, reason: null },
      latestRunAt: null,
      latestRunReason: "Latest run time is unavailable from the filesystem artifact index.",
    };
  } else if (query.view === "artifacts") {
    const start = (query.page - 1) * query.pageSize;
    response.artifacts = {
      available: true,
      reason: null,
      items: availableArtifacts.slice(start, start + query.pageSize),
      total: availableArtifacts.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  } else {
    const reason = `${query.view} require Supabase operational tables; filesystem fallback does not infer them from JSON contents.`;
    if (query.view === "runs") response.runs = unavailableSection(query, reason);
    if (query.view === "tasks") response.tasks = unavailableSection(query, reason);
    if (query.view === "failures") response.failures = unavailableSection(query, reason);
  }

  return response;
}

function unavailableResponse(
  query: DiagnosticsQuery,
  generatedAt: string,
  reason: string,
): IngestionDiagnosticsResponse {
  const response: IngestionDiagnosticsResponse = {
    generatedAt,
    view: query.view,
    source: { kind: "unavailable", label: "Diagnostics unavailable", reason },
    filters: withoutView(query),
  };
  const metric = (): SummaryMetric => ({ value: null, reason });
  if (query.view === "summary") {
    response.summary = {
      runs: metric(),
      activeRuns: metric(),
      tasks: metric(),
      pendingTasks: metric(),
      failures: metric(),
      artifacts: metric(),
      latestRunAt: null,
      latestRunReason: reason,
    };
  }
  if (query.view === "runs") response.runs = unavailableSection(query, reason);
  if (query.view === "tasks") response.tasks = unavailableSection(query, reason);
  if (query.view === "failures") response.failures = unavailableSection(query, reason);
  if (query.view === "artifacts") response.artifacts = unavailableSection(query, reason);
  return response;
}

function unavailableSection<T>(query: DiagnosticsQuery, reason: string): DiagnosticsSection<T> {
  return { available: false, reason, items: [], total: null, page: query.page, pageSize: query.pageSize };
}

function runFilters(query: DiagnosticsQuery): ReaderFilter[] {
  const filters: ReaderFilter[] = [];
  if (query.status) filters.push({ column: "status", value: query.status });
  if (query.runId) filters.push({ column: "id", value: query.runId });
  return filters;
}

function taskFilters(query: DiagnosticsQuery): ReaderFilter[] {
  const filters: ReaderFilter[] = [];
  if (query.status) filters.push({ column: "status", value: query.status });
  if (query.platform) filters.push({ column: "platform", value: query.platform });
  if (query.runId) filters.push({ column: "ingestion_run_id", value: query.runId });
  return filters;
}

function mapRun(row: Record<string, unknown>): IngestionRunDiagnostic {
  return {
    id: stringValue(row.id),
    batchId: stringOrNull(row.batch_id),
    status: stringOrNull(row.status),
    startedAt: stringOrNull(row.started_at),
    finishedAt: stringOrNull(row.finished_at),
    logCount: Array.isArray(row.logs) ? row.logs.length : 0,
    errorCount: Array.isArray(row.errors_json) ? row.errors_json.length : 0,
  };
}

function mapTask(row: Record<string, unknown>): IngestionTaskDiagnostic {
  return {
    id: stringValue(row.id),
    runId: stringOrNull(row.ingestion_run_id),
    companyName: stringValue(row.company_name),
    entityType: stringValue(row.entity_type),
    platform: stringValue(row.platform),
    status: stringValue(row.status),
    attempts: numberValue(row.attempts),
    checkpointKey: stringValue(row.checkpoint_key),
    lastError: stringOrNull(row.last_error),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapFailure(row: Record<string, unknown>): IngestionFailureDiagnostic {
  return {
    id: stringValue(row.id),
    taskId: stringValue(row.id),
    companyName: stringValue(row.company_name),
    platform: stringValue(row.platform),
    kind: stringValue(row.last_failure_kind ?? "collector_failure"),
    message: stringValue(row.last_error ?? "Collector failed without a recorded message."),
    sourceUrl: null,
    occurredAt: stringValue(row.last_attempt_at ?? row.updated_at),
  };
}

function mapArtifact(row: Record<string, unknown>): IngestionArtifactDiagnostic {
  return {
    id: stringValue(row.id),
    platform: null,
    kind: stringValue(row.artifact_type),
    location: stringOrNull(row.storage_uri),
    firstSeenAt: stringOrNull(row.created_at),
    lastSeenAt: stringOrNull(row.created_at),
    sizeBytes: nullableNumber(row.byte_size),
  };
}

function parseInteger(value: string | null, fallback: number, min: number, max: number, name: string): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

function parseFilter(value: string | null, name: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 100 || !/^[A-Za-z0-9_:/.-]+$/.test(trimmed)) {
    throw new Error(`${name} contains unsupported characters or is too long`);
  }
  return trimmed;
}

function withoutView(query: DiagnosticsQuery): Omit<DiagnosticsQuery, "view"> {
  const { view: _view, ...filters } = query;
  void _view;
  return filters;
}

function isInsideDirectory(candidate: string, cwd: string): boolean {
  const root = path.resolve(cwd);
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function stringOrNull(value: unknown): string | null {
  const result = stringValue(value).trim();
  return result || null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown diagnostics query error";
  return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}
