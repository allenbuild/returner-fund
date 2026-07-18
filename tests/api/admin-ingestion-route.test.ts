import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticsResult = {
  generatedAt: "2026-07-18T13:00:00.000Z",
  view: "summary" as const,
  source: { kind: "supabase" as const, label: "Supabase operational tables", reason: null },
  filters: { page: 1, pageSize: 25 },
  summary: {
    runs: { value: 1, reason: null },
    activeRuns: { value: 0, reason: null },
    tasks: { value: 4, reason: null },
    pendingTasks: { value: 0, reason: null },
    failures: { value: 0, reason: null },
    artifacts: { value: 12, reason: null },
    latestRunAt: "2026-07-18T12:00:00.000Z",
    latestRunReason: null,
  },
};

describe("GET /api/admin/ingestion", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ADMIN_INGESTION_SECRET", "");
    vi.stubEnv("REFRESH_SECRET", "");
  });

  afterEach(() => {
    vi.doUnmock("@/lib/admin/ingestion-diagnostics");
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("fails closed when no server secret is configured", async () => {
    const readIngestionDiagnostics = vi.fn();
    vi.doMock("@/lib/admin/ingestion-diagnostics", async (importOriginal) => ({
      ...await importOriginal<typeof import("../../src/lib/admin/ingestion-diagnostics")>(),
      readIngestionDiagnostics,
    }));
    const { GET } = await import("../../src/app/api/admin/ingestion/route");

    const response = await GET(new Request("http://localhost/api/admin/ingestion"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.error.code).toBe("admin_ingestion_secret_not_configured");
    expect(readIngestionDiagnostics).not.toHaveBeenCalled();
  });

  it("allows development loopback and always disables caching", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_INGESTION_ALLOW_INSECURE_LOOPBACK", "true");
    const readIngestionDiagnostics = vi.fn(async () => diagnosticsResult);
    vi.doMock("@/lib/admin/ingestion-diagnostics", async (importOriginal) => ({
      ...await importOriginal<typeof import("../../src/lib/admin/ingestion-diagnostics")>(),
      readIngestionDiagnostics,
    }));
    const { GET } = await import("../../src/app/api/admin/ingestion/route");

    const response = await GET(new Request("http://127.0.0.1/api/admin/ingestion?view=summary"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual(diagnosticsResult);
    expect(readIngestionDiagnostics).toHaveBeenCalledWith({ view: "summary", page: 1, pageSize: 25 });
  });

  it("accepts a valid bearer secret and rejects malformed credentials", async () => {
    vi.stubEnv("ADMIN_INGESTION_SECRET", "diagnostics-test-secret");
    const readIngestionDiagnostics = vi.fn(async () => diagnosticsResult);
    vi.doMock("@/lib/admin/ingestion-diagnostics", async (importOriginal) => ({
      ...await importOriginal<typeof import("../../src/lib/admin/ingestion-diagnostics")>(),
      readIngestionDiagnostics,
    }));
    const { GET } = await import("../../src/app/api/admin/ingestion/route");

    const authorized = await GET(new Request("https://admin.example/api/admin/ingestion", {
      headers: { Authorization: "Bearer diagnostics-test-secret" },
    }));
    const rejected = await GET(new Request("https://admin.example/api/admin/ingestion", {
      headers: { Authorization: "Bearer diagnostics-test-secret,extra" },
    }));

    expect(authorized.status).toBe(200);
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("www-authenticate")).toBe('Bearer realm="admin-ingestion"');
    expect(readIngestionDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("returns a no-store 400 for invalid pagination before reading data", async () => {
    vi.stubEnv("ADMIN_INGESTION_SECRET", "diagnostics-test-secret");
    const readIngestionDiagnostics = vi.fn();
    vi.doMock("@/lib/admin/ingestion-diagnostics", async (importOriginal) => ({
      ...await importOriginal<typeof import("../../src/lib/admin/ingestion-diagnostics")>(),
      readIngestionDiagnostics,
    }));
    const { GET } = await import("../../src/app/api/admin/ingestion/route");

    const response = await GET(new Request("https://admin.example/api/admin/ingestion?pageSize=500", {
      headers: { "x-admin-ingestion-secret": "diagnostics-test-secret" },
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.error.code).toBe("invalid_diagnostics_query");
    expect(readIngestionDiagnostics).not.toHaveBeenCalled();
  });
});
