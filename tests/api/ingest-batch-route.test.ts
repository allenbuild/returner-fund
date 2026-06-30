import { describe, expect, it } from "vitest";
import { POST } from "../../src/app/api/ingest/batch/route";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/ingest/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/ingest/batch", () => {
  it("runs the demo ingest pipeline and returns graph data", async () => {
    const response = await POST(
      jsonRequest({
        batchSlug: "YC Spring 2026",
        options: { demo: true, refreshProfiles: true, refreshPosts: true, maxCompanies: 2 }
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.status).toBe("completed");
    expect(body.runId).toMatch(/^run_/);
    expect(body.errors).toEqual([]);
    expect(body.graph.batch.slug).toBe("S2026");
    expect(body.graph.batch.label).toBe("YC Spring 2026");
    expect(body.graph.batch.expectedCompanyCount).toBe(197);
    expect(body.graph.mode).toBe("demo");
    expect(body.graph.nodes.length).toBeGreaterThan(0);
    expect(body.graph.nodes.every((node: { type: string }) => node.type === "company")).toBe(true);
    expect(body.graph.edges.some((edge: { edgeType: string }) => edge.edgeType === "founder_of")).toBe(false);
    expect(body.graph.needsReview.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.graph)).not.toContain(["con", "fidence"].join(""));
    expect(body.logs.join("\n")).toContain("Read-only policy active");
  });

  it("defaults to YC Spring 2026 when batchSlug is omitted", async () => {
    const response = await POST(
      jsonRequest({
        options: { demo: true, maxCompanies: 1 }
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.graph.batch).toMatchObject({
      slug: "S2026",
      label: "YC Spring 2026",
      expectedCompanyCount: 197
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

  it("rejects unsupported request fields", async () => {
    const response = await POST(
      jsonRequest({
        batchSlug: "S2026",
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
        batchSlug: "S2026",
        options: { demo: true },
        githubToken: "placeholder-value"
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.errors.join("\n")).toContain("Do not send cookies");
    expect(body.errors.join("\n")).toContain("$.githubToken");
  });

  it("fails closed when real database ingest is requested before adapters are wired", async () => {
    const response = await POST(
      jsonRequest({
        batchSlug: "S2026",
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
