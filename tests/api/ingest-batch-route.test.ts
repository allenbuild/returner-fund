import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../src/app/api/ingest/batch/route";

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
  url = "http://localhost/api/ingest/batch"
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

describe("POST /api/ingest/batch", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("INGEST_BATCH_SECRET", "");
    vi.stubEnv("REFRESH_SECRET", "");
  });

  afterEach(() => {
    vi.doUnmock("@/lib/workers/ingest-batch");
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("runs the demo ingest pipeline and returns graph data", async () => {
    const response = await POST(
      jsonRequest({
        batchSlug: "YC Summer 2026",
        options: { demo: true, refreshProfiles: true, refreshPosts: true, maxCompanies: 2 }
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.status).toBe("completed");
    expect(body.runId).toMatch(/^run_/);
    expect(body.errors).toEqual([]);
    expect(body.graph.batch.slug).toBe("S26");
    expect(body.graph.batch.label).toBe("YC Summer 2026 (S26)");
    expect(body.graph.batch.expectedCompanyCount).toBe(83);
    expect(body.graph.mode).toBe("demo");
    expect(body.graph.nodes.length).toBeGreaterThan(0);
    expect(body.graph.nodes.every((node: { type: string }) => node.type === "company")).toBe(true);
    expect(body.graph.edges.some((edge: { edgeType: string }) => edge.edgeType === "founder_of")).toBe(false);
    expect(body.graph.needsReview.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.graph)).not.toContain(["con", "fidence"].join(""));
    expect(body.logs.join("\n")).toContain("Read-only policy active");
  });

  it("defaults to YC Summer 2026 when batchSlug is omitted", async () => {
    const response = await POST(
      jsonRequest({
        options: { demo: true, maxCompanies: 1 }
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.graph.batch).toMatchObject({
      slug: "S26",
      label: "YC Summer 2026 (S26)",
      expectedCompanyCount: 83
    });
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/ingest/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.errors[0]).toBe("Request body must be valid JSON.");
  });

  it("accepts forward-compatible platforms and reports unavailable adapters", async () => {
    const response = await POST(
      jsonRequest({
        batchSlug: "S26",
        options: { demo: true, platforms: ["tiktok", "bluesky"] }
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("completed");
    expect(body.logs.join("\n")).toContain("tiktok, bluesky collection adapter(s) are unavailable");
    expect(body.logs.join("\n")).toContain("pass through as unscored");
  });

  it("rejects unsupported request fields", async () => {
    const response = await POST(
      jsonRequest({
        batchSlug: "S26",
        options: { demo: true, browserProfilePath: "C:/Users/example/Profile" }
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.errors.join("\n")).toContain("Unrecognized key");
  });

  it("rejects cookies and tokens at the API boundary", async () => {
    const response = await POST(
      jsonRequest({
        batchSlug: "S26",
        options: { demo: true },
        githubToken: "placeholder-value"
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.errors.join("\n")).toContain("Do not send cookies");
    expect(body.errors.join("\n")).toContain("$.githubToken");
  });

  it("fails closed in production without a configured ingest secret before starting a run", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const runIngestBatch = vi.fn();
    vi.resetModules();
    vi.doMock("@/lib/workers/ingest-batch", () => ({ runIngestBatch }));
    const { POST: protectedPost } = await import("../../src/app/api/ingest/batch/route");

    const response = await protectedPost(jsonRequest({ batchSlug: "S26", options: { demo: false } }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.error.code).toBe("ingest_secret_not_configured");
    expect(body).not.toHaveProperty("runId");
    expect(runIngestBatch).not.toHaveBeenCalled();
  });

  it("rejects adversarial credentials before any ingest batch or run is created", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INGEST_BATCH_SECRET", "batch-route-test-secret");
    const runIngestBatch = vi.fn();
    vi.resetModules();
    vi.doMock("@/lib/workers/ingest-batch", () => ({ runIngestBatch }));
    const { POST: protectedPost } = await import("../../src/app/api/ingest/batch/route");

    const requests = [
      jsonRequest({ batchSlug: "S26", options: { demo: false } }),
      jsonRequest(
        { batchSlug: "S26", options: { demo: false } },
        { authorization: "Bearer definitely-not-the-secret" }
      ),
      jsonRequest(
        { batchSlug: "S26", options: { demo: false } },
        { authorization: "Bearer batch-route-test-secret, definitely-not-the-secret" }
      ),
      jsonRequest(
        { batchSlug: "S26", options: { demo: false }, ingestSecret: "batch-route-test-secret" },
        {},
        "http://localhost/api/ingest/batch?access_token=batch-route-test-secret"
      )
    ];

    for (const request of requests) {
      const response = await protectedPost(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="ingest-batch"');
      expect(body.error.code).toBe("ingest_unauthorized");
      expect(body).not.toHaveProperty("runId");
    }

    expect(runIngestBatch).not.toHaveBeenCalled();
  });

  it("only delegates to the worker after a valid bearer, ingest-secret, or shared refresh-secret header", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INGEST_BATCH_SECRET", "batch-route-test-secret");
    const runIngestBatch = vi.fn(async () => ({
      runId: "run_authorized",
      status: "completed" as const,
      logs: [],
      errors: []
    }));
    vi.resetModules();
    vi.doMock("@/lib/workers/ingest-batch", () => ({ runIngestBatch }));
    const { POST: protectedPost } = await import("../../src/app/api/ingest/batch/route");

    const bearerResponse = await protectedPost(
      jsonRequest(
        { batchSlug: "S26", options: { demo: true } },
        { authorization: "Bearer batch-route-test-secret" }
      )
    );
    const headerResponse = await protectedPost(
      jsonRequest(
        { batchSlug: "S26", options: { demo: true } },
        { "x-ingest-batch-secret": "batch-route-test-secret" }
      )
    );
    vi.stubEnv("INGEST_BATCH_SECRET", "");
    vi.stubEnv("REFRESH_SECRET", "shared-refresh-secret");
    const refreshHeaderResponse = await protectedPost(
      jsonRequest(
        { batchSlug: "S26", options: { demo: true } },
        { "x-refresh-secret": "shared-refresh-secret" }
      )
    );

    expect(bearerResponse.status).toBe(200);
    expect(headerResponse.status).toBe(200);
    expect(refreshHeaderResponse.status).toBe(200);
    expect(runIngestBatch).toHaveBeenCalledTimes(3);
    expect(runIngestBatch).toHaveBeenCalledWith({ batchSlug: "S26", options: { demo: true } });
  });

  it("accepts either configured secret when ingest and refresh secrets coexist", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INGEST_BATCH_SECRET", "ingest-secret");
    vi.stubEnv("REFRESH_SECRET", "refresh-secret");
    const runIngestBatch = vi.fn(async () => ({
      runId: "run_dual_secret",
      status: "completed" as const,
      logs: [],
      errors: []
    }));
    vi.resetModules();
    vi.doMock("@/lib/workers/ingest-batch", () => ({ runIngestBatch }));
    const { POST: protectedPost } = await import("../../src/app/api/ingest/batch/route");

    const ingestResponse = await protectedPost(
      jsonRequest(
        { batchSlug: "S26", options: { demo: true } },
        { "x-ingest-batch-secret": "ingest-secret" }
      )
    );
    const refreshResponse = await protectedPost(
      jsonRequest(
        { batchSlug: "S26", options: { demo: true } },
        { "x-refresh-secret": "refresh-secret" }
      )
    );

    expect(ingestResponse.status).toBe(200);
    expect(refreshResponse.status).toBe(200);
    expect(runIngestBatch).toHaveBeenCalledTimes(2);
  });

  it("fails closed when real database ingest is requested before adapters are wired", async () => {
    const response = await POST(
      jsonRequest({
        batchSlug: "S26",
        options: { demo: false }
      })
    );

    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.status).toBe("failed");
    expect(body.errors.join("\n")).toContain("Supabase");
    expect(body.logs.join("\n")).toContain("Database mode requested");
  });
});
