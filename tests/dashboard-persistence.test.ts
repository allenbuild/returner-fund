import { describe, expect, it } from "vitest";
import type { DashboardCandidate } from "@/lib/dashboard/contracts";
import {
  persistDashboardSnapshot,
  type DashboardPersistenceClient,
  type DashboardPersistenceQuery
} from "@/lib/dashboard/persistence";
import { buildDashboardSnapshot } from "@/lib/dashboard/pipeline";

const NOW = new Date("2026-08-15T12:00:00.000Z");

describe("dashboard durable publication", () => {
  it("writes an idempotent run, story/source projections, all view snapshots, then publishes", async () => {
    const snapshot = buildDashboardSnapshot([candidate()], { now: NOW }).snapshot;
    const client = new RecordingDashboardClient();

    const result = await persistDashboardSnapshot(snapshot, { client });

    expect(result).toMatchObject({ status: "persisted", runKey: expect.stringMatching(/^dashboard:/) });
    expect(client.valuesFor("dashboard_runs", "insert")[0]).toMatchObject({
      status: "running",
      window_start: "2026-08-14T12:00:00.000Z",
      window_end: NOW.toISOString()
    });
    expect(client.rpcValuesFor("finalize_dashboard_publication")[0]).toMatchObject({
      p_dashboard_run_id: "run-1",
      p_input_observed_through: NOW.toISOString()
    });
    const operationNames = client.operations.map((operation) => `${operation.table}:${operation.action}`);
    expect(operationNames.indexOf("dashboard_publications:insert")).toBeLessThan(
      operationNames.indexOf("finalize_dashboard_publication:rpc")
    );
    expect(client.valuesFor("dashboard_stories", "upsert")[0]).toHaveLength(1);
    expect(client.valuesFor("dashboard_stories", "upsert")[0]).toEqual([
      expect.objectContaining({ first_seen_at: NOW.toISOString(), last_seen_at: NOW.toISOString() })
    ]);
    expect(client.valuesFor("dashboard_external_sources", "upsert")[0]).toHaveLength(1);
    expect(client.valuesFor("dashboard_story_entities", "upsert")[0]).toEqual([
      expect.objectContaining({
        company_id: "90000000-0000-4000-8000-000000000101",
        attribution_state: "verified",
        is_returner: true,
        metadata_json: expect.objectContaining({ batchSlug: "s26" })
      })
    ]);
    const storySourceRows = client.valuesFor("dashboard_story_sources", "upsert")[0] as Array<Record<string, unknown>>;
    expect(storySourceRows[0]).toMatchObject({
      source_role: "supporting",
      verification_state: "verified"
    });
    expect(client.rpcValuesFor("reconcile_dashboard_story_source_primaries")[0]).toEqual({
      p_primary_links: [{ story_id: "story-1", external_source_id: "source-1" }]
    });
    const scoreRows = client.valuesFor("dashboard_story_scores", "upsert")[0] as Array<Record<string, unknown>>;
    expect(scoreRows[0]).toMatchObject({
      trend_score: expect.any(Number),
      velocity_score: expect.any(Number)
    });
    expect(client.valuesFor("dashboard_rank_snapshots", "upsert")[0]).toHaveLength(3);

    const publicationWrites = client.valuesFor("dashboard_publications", "insert");
    const publicationRow = publicationWrites[0] as Record<string, unknown>;
    expect(publicationRow).toMatchObject({ status: "draft", is_current: false });
  });

  it("does not attempt a database write without a configured client", async () => {
    const snapshot = buildDashboardSnapshot([candidate()], { now: NOW }).snapshot;
    await expect(persistDashboardSnapshot(snapshot, { client: null })).resolves.toEqual({
      status: "skipped",
      reason: "database_not_configured"
    });
  });

  it("resumes an interrupted writable run without duplicating scores, ranks, or its staged draft", async () => {
    const snapshot = buildDashboardSnapshot([candidate()], { now: NOW }).snapshot;
    const client = new ResumableDashboardClient();

    await expect(persistDashboardSnapshot(snapshot, { client })).resolves.toMatchObject({ status: "persisted" });

    expect(client.valuesFor("dashboard_runs", "insert")).toEqual([]);
    expect(client.valuesFor("dashboard_story_scores", "upsert")).toHaveLength(1);
    expect(client.valuesFor("dashboard_rank_snapshots", "upsert")).toHaveLength(1);
    expect(client.valuesFor("dashboard_publications", "insert")).toEqual([]);
    expect(client.rpcValuesFor("finalize_dashboard_publication")).toHaveLength(1);
  });
});

function candidate(): DashboardCandidate {
  return {
    id: "persistence-source",
    canonicalKey: "github:repository-object:42",
    platform: "github",
    sourceKind: "repository",
    url: "https://github.com/acme/project",
    destinationUrl: "https://github.com/acme/project",
    title: "Acme Project releases a technology update",
    summary: "Acme published a verified release with developer-facing improvements.",
    publishedAt: "2026-08-15T11:00:00.000Z",
    observedAt: NOW.toISOString(),
    metrics: { stars: 120, forks: 12 },
    accountBaseline: { stars: 10 },
    topics: ["open_source", "launches"],
    trackedEntity: {
      companyId: "90000000-0000-4000-8000-000000000101",
      name: "Acme",
      cohortLabel: "YC S26",
      batchSlug: "s26"
    }
  };
}

type Action = "select" | "insert" | "upsert" | "update" | "rpc";
type Operation = { table: string; action: Action; values?: unknown; filters: Array<[string, unknown]> };

class RecordingDashboardClient implements DashboardPersistenceClient {
  readonly operations: Operation[] = [];

  from<T = Record<string, unknown>>(table: string): DashboardPersistenceQuery<T> {
    return new RecordingDashboardQuery<T>(this, table);
  }

  valuesFor(table: string, action: Action): unknown[] {
    return this.operations.filter((operation) => operation.table === table && operation.action === action)
      .map((operation) => operation.values);
  }

  rpcValuesFor(functionName: string): unknown[] {
    return this.operations
      .filter((operation) => operation.action === "rpc" && operation.table === functionName)
      .map((operation) => operation.values);
  }

  rpc<T>(functionName: string, args: Record<string, unknown>): Promise<{ data: T | null; error: null }> {
    this.operations.push({ table: functionName, action: "rpc", values: args, filters: [] });
    const data = functionName === "finalize_dashboard_publication" ? "published" : null;
    return Promise.resolve({ data: data as T | null, error: null });
  }

  response<T>(operation: Operation): T[] {
    if (operation.table === "dashboard_runs" && operation.action === "insert") {
      return [{ id: "run-1", status: "running" }] as T[];
    }
    if (operation.table === "scoring_model_versions") return [{ id: "model-1" }] as T[];
    if (operation.table === "dashboard_stories") {
      return (operation.values as Array<{ story_key: string }>).map((row, index) => ({ id: `story-${index + 1}`, story_key: row.story_key })) as T[];
    }
    if (operation.table === "dashboard_external_sources") {
      return (operation.values as Array<{ canonical_key: string }>).map((row, index) => ({ id: `source-${index + 1}`, canonical_key: row.canonical_key })) as T[];
    }
    if (operation.table === "dashboard_story_scores") {
      return (operation.values as Array<{ story_id: string }>).map((row, index) => ({ id: `score-${index + 1}`, story_id: row.story_id })) as T[];
    }
    if (operation.table === "dashboard_publications" && operation.action === "insert") return [{ id: "publication-1" }] as T[];
    return [];
  }
}

class ResumableDashboardClient extends RecordingDashboardClient {
  override response<T>(operation: Operation): T[] {
    if (operation.table === "dashboard_runs" && operation.action === "select") {
      return [{ id: "run-1", status: "running" }] as T[];
    }
    if (operation.table === "dashboard_publications" && operation.action === "select") {
      return [{ id: "publication-1", status: "draft", publication_key: "existing-draft" }] as T[];
    }
    return super.response<T>(operation);
  }
}

class RecordingDashboardQuery<T> implements DashboardPersistenceQuery<T> {
  private action: Action = "select";
  private values: unknown;
  private readonly filters: Array<[string, unknown]> = [];

  constructor(private readonly client: RecordingDashboardClient, private readonly table: string) {}

  select(): this { return this; }
  insert(values: unknown): this { this.action = "insert"; this.values = values; return this; }
  upsert(values: unknown): this { this.action = "upsert"; this.values = values; return this; }
  update(values: unknown): this { this.action = "update"; this.values = values; return this; }
  eq(column: string, value: unknown): this { this.filters.push([column, value]); return this; }

  maybeSingle(): Promise<{ data: T | null; error: null }> {
    const rows = this.recordAndRespond();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  single(): Promise<{ data: T | null; error: null }> {
    const rows = this.recordAndRespond();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  then<TResult1 = { data: T[] | null; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: T[] | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.recordAndRespond(), error: null }).then(onfulfilled, onrejected);
  }

  private recordAndRespond(): T[] {
    const operation: Operation = { table: this.table, action: this.action, values: this.values, filters: [...this.filters] };
    this.client.operations.push(operation);
    return this.client.response<T>(operation);
  }
}
