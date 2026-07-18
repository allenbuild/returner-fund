import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseDiagnosticsQuery,
  readIngestionDiagnostics,
  type DiagnosticsReader,
} from "../src/lib/admin/ingestion-diagnostics";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ingestion diagnostics", () => {
  it("parses supported filters and enforces pagination bounds", () => {
    expect(parseDiagnosticsQuery(new URLSearchParams(
      "view=tasks&page=2&pageSize=50&status=running&platform=github&runId=run-123",
    ))).toEqual({
      view: "tasks",
      page: 2,
      pageSize: 50,
      status: "running",
      platform: "github",
      runId: "run-123",
    });

    expect(() => parseDiagnosticsQuery(new URLSearchParams("view=unknown"))).toThrow(/view must be one of/);
    expect(() => parseDiagnosticsQuery(new URLSearchParams("pageSize=101"))).toThrow(/pageSize/);
    expect(() => parseDiagnosticsQuery(new URLSearchParams("platform=github,*"))).toThrow(/unsupported characters/);
    expect(() => parseDiagnosticsQuery(new URLSearchParams("view=failures&status=failed"))).toThrow(
      /status is only supported/,
    );
  });

  it("returns exact Supabase summary metrics without inventing missing values", async () => {
    const reader: DiagnosticsReader = {
      count: vi.fn(async (table, filters = []) => {
        const key = `${table}:${filters[0]?.values?.join("|") ?? "all"}`;
        return {
          "ingestion_runs:all": 11,
          "ingestion_runs:queued|running": 2,
          "ingestion_tasks:all": 140,
          "ingestion_tasks:queued|running|retry_scheduled": 9,
          "ingestion_tasks:failed|dead_lettered": 7,
          "ingestion_artifact_manifests:all": 12,
        }[key] ?? 0;
      }),
      list: vi.fn(async () => ({
        rows: [{ id: "run-11", started_at: "2026-07-18T12:00:00.000Z" }],
        total: 11,
      })),
    };

    const response = await readIngestionDiagnostics(
      { view: "summary", page: 1, pageSize: 25 },
      { reader, now: () => new Date("2026-07-18T13:00:00.000Z") },
    );

    expect(response.source.kind).toBe("supabase");
    expect(response.summary).toMatchObject({
      runs: { value: 11, reason: null },
      activeRuns: { value: 2, reason: null },
      tasks: { value: 140, reason: null },
      pendingTasks: { value: 9, reason: null },
      failures: { value: 7, reason: null },
      artifacts: { value: 12, reason: null },
      latestRunAt: "2026-07-18T12:00:00.000Z",
      latestRunReason: null,
    });
    expect(response.generatedAt).toBe("2026-07-18T13:00:00.000Z");
  });

  it("forwards task filters and maps only paged operational rows", async () => {
    const list = vi.fn(async () => ({
      total: 51,
      rows: [{
        id: "task-1",
        ingestion_run_id: "run-1",
        company_name: "Example Co",
        entity_type: "company",
        platform: "github",
        status: "running",
        attempts: 2,
        checkpoint_key: "S26:example:github",
        last_error: null,
        updated_at: "2026-07-18T10:00:00.000Z",
      }],
    }));
    const reader: DiagnosticsReader = { count: vi.fn(), list };

    const response = await readIngestionDiagnostics({
      view: "tasks",
      page: 2,
      pageSize: 25,
      status: "running",
      platform: "github",
      runId: "run-1",
    }, { reader });

    expect(list).toHaveBeenCalledWith("ingestion_tasks", expect.objectContaining({
      page: 2,
      pageSize: 25,
      filters: [
        { column: "status", value: "running" },
        { column: "platform", value: "github" },
        { column: "ingestion_run_id", value: "run-1" },
      ],
    }));
    expect(response.tasks).toMatchObject({
      available: true,
      total: 51,
      page: 2,
      items: [{ id: "task-1", companyName: "Example Co", attempts: 2 }],
    });
  });

  it("marks an individual view unavailable when its table query fails", async () => {
    const reader: DiagnosticsReader = {
      count: vi.fn(),
      list: vi.fn(async () => { throw new Error("ingestion_tasks: relation does not exist"); }),
    };

    const response = await readIngestionDiagnostics(
      { view: "failures", page: 1, pageSize: 25 },
      { reader },
    );

    expect(response.source.kind).toBe("supabase");
    expect(response.failures).toEqual({
      available: false,
      reason: "ingestion_tasks: relation does not exist",
      items: [],
      total: null,
      page: 1,
      pageSize: 25,
    });
  });

  it("returns explicit unavailability outside development when Supabase is not configured", async () => {
    const response = await readIngestionDiagnostics(
      { view: "artifacts", page: 1, pageSize: 25 },
      { env: { NODE_ENV: "production" } },
    );

    expect(response.source.kind).toBe("unavailable");
    expect(response.source.reason).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(response.artifacts).toMatchObject({ available: false, total: null, items: [] });
  });
});
