import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateInsiderRequest = vi.fn();
const loadUserInsiderConfiguration = vi.fn();
const clearGraphResponseCache = vi.fn();
const reportGenerator = vi.fn();

vi.mock("@/lib/social/user-insiders-server", () => ({
  authenticateInsiderRequest,
  loadUserInsiderConfiguration
}));
vi.mock("@/lib/graph/graph-response-cache", () => ({ clearGraphResponseCache }));

describe("POST /api/insiders/recompute", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invalidates derived-score caches from stored evidence without regenerating a report", async () => {
    authenticateInsiderRequest.mockResolvedValue({ client: {}, userId: "user-a" });
    loadUserInsiderConfiguration.mockResolvedValue({ version: 7 });
    const { POST } = await import("@/app/api/insiders/recompute/route");

    const response = await POST(new Request("http://localhost/api/insiders/recompute", {
      method: "POST",
      headers: { Authorization: "Bearer token" }
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "recomputed",
      configurationVersion: 7,
      source: "stored_evidence",
      reportRegenerated: false
    });
    expect(clearGraphResponseCache).toHaveBeenCalledOnce();
    expect(reportGenerator).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    authenticateInsiderRequest.mockResolvedValue(null);
    const { POST } = await import("@/app/api/insiders/recompute/route");
    const response = await POST(new Request("http://localhost/api/insiders/recompute", {
      method: "POST"
    }));
    expect(response.status).toBe(401);
    expect(clearGraphResponseCache).not.toHaveBeenCalled();
  });
});
