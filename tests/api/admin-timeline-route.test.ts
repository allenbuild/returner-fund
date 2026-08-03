import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTimelineHttpCacheForTests } from "@/lib/timeline/http-cache";

describe("timeline admin APIs", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ADMIN_TIMELINE_SECRET", "timeline-test-secret");
    vi.stubEnv("ADMIN_INGESTION_SECRET", "");
    vi.stubEnv("REFRESH_SECRET", "");
    vi.stubEnv("ADMIN_TIMELINE_ACTOR_ID", "");
    vi.stubEnv("ADMIN_TIMELINE_ACTOR_EMAIL", "");
    clearTimelineHttpCacheForTests();
  });

  afterEach(() => {
    clearTimelineHttpCacheForTests();
    vi.doUnmock("@/lib/timeline/store");
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("fails closed without an admin credential", async () => {
    const listTimelineCoverage = vi.fn();
    vi.doMock("@/lib/timeline/store", () => ({ listTimelineCoverage }));
    const { GET } = await import("../../src/app/api/admin/timeline/coverage/route");
    const response = await GET(new Request("https://www.returner.fund/api/admin/timeline/coverage"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(listTimelineCoverage).not.toHaveBeenCalled();
  });

  it("does not elevate legacy ingestion or refresh credentials into timeline admin access", async () => {
    vi.stubEnv("ADMIN_TIMELINE_SECRET", "timeline-test-secret");
    vi.stubEnv("ADMIN_INGESTION_SECRET", "ingestion-test-secret");
    vi.stubEnv("REFRESH_SECRET", "refresh-test-secret");
    const applyTimelineAdminEventAction = vi.fn();
    vi.doMock("@/lib/timeline/store", () => ({
      applyTimelineAdminCandidateAction: vi.fn(),
      applyTimelineAdminCompanyAction: vi.fn(),
      applyTimelineAdminEventAction,
    }));
    const { POST } = await import("../../src/app/api/admin/timeline/actions/route");
    const credentialHeaders: HeadersInit[] = [
      { Authorization: "Bearer ingestion-test-secret" },
      { Authorization: "Bearer refresh-test-secret" },
      { "x-admin-ingestion-secret": "ingestion-test-secret" },
    ];

    for (const headers of credentialHeaders) {
      const response = await POST(new Request(
        "https://www.returner.fund/api/admin/timeline/actions",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            scope: "event",
            action: {
              type: "unpublish",
              eventId: "event-1",
              reason: "Evidence was withdrawn.",
            },
          }),
        },
      ));

      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect(applyTimelineAdminEventAction).not.toHaveBeenCalled();
  });

  it("remains unavailable when only legacy admin credentials are configured", async () => {
    vi.stubEnv("ADMIN_TIMELINE_SECRET", "");
    vi.stubEnv("ADMIN_INGESTION_SECRET", "ingestion-test-secret");
    vi.stubEnv("REFRESH_SECRET", "refresh-test-secret");
    const listTimelineCoverage = vi.fn();
    vi.doMock("@/lib/timeline/store", () => ({ listTimelineCoverage }));
    const { GET } = await import("../../src/app/api/admin/timeline/coverage/route");
    const response = await GET(new Request(
      "https://www.returner.fund/api/admin/timeline/coverage",
      { headers: { Authorization: "Bearer ingestion-test-secret" } },
    ));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("admin_timeline_secret_not_configured");
    expect(listTimelineCoverage).not.toHaveBeenCalled();
  });

  it("lists bounded coverage for authorized operators", async () => {
    const listTimelineCoverage = vi.fn(async () => ({ items: [], nextCursor: null }));
    vi.doMock("@/lib/timeline/store", () => ({ listTimelineCoverage }));
    const { GET } = await import("../../src/app/api/admin/timeline/coverage/route");
    const response = await GET(new Request(
      "https://www.returner.fund/api/admin/timeline/coverage?status=partial&limit=25&q=acme",
      { headers: { Authorization: "Bearer timeline-test-secret" } },
    ));

    expect(response.status).toBe(200);
    expect(listTimelineCoverage).toHaveBeenCalledWith({
      q: "acme",
      status: "partial",
      cursor: undefined,
      limit: 25,
    });
  });

  it("rejects malformed coverage cursors before reading the manifest", async () => {
    const listTimelineCoverage = vi.fn();
    vi.doMock("@/lib/timeline/store", () => ({ listTimelineCoverage }));
    const { GET } = await import("../../src/app/api/admin/timeline/coverage/route");
    const response = await GET(new Request(
      "https://www.returner.fund/api/admin/timeline/coverage?cursor=malformed",
      { headers: { Authorization: "Bearer timeline-test-secret" } },
    ));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(listTimelineCoverage).not.toHaveBeenCalled();
  });

  it("loads protected event detail and audit history", async () => {
    const eventDetail = {
      event: { id: "event-1" },
      evidence: [],
      posts: [],
      auditHistory: [{ id: "audit-1", action: "publish" }],
    };
    const getTimelineAdminEventDetail = vi.fn(async () => eventDetail);
    vi.doMock("@/lib/timeline/store", () => ({ getTimelineAdminEventDetail }));
    const { GET } = await import("../../src/app/api/admin/timeline/events/[eventId]/route");
    const response = await GET(
      new Request("https://www.returner.fund/api/admin/timeline/events/event-1", {
        headers: { Authorization: "Bearer timeline-test-secret" },
      }),
      { params: Promise.resolve({ eventId: "event-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await response.json()).eventDetail).toEqual(eventDetail);
    expect(getTimelineAdminEventDetail).toHaveBeenCalledWith("event-1");
  });

  it("rejects invalid review filters before querying candidates", async () => {
    const listTimelineCandidates = vi.fn();
    vi.doMock("@/lib/timeline/store", () => ({ listTimelineCandidates }));
    const { GET } = await import("../../src/app/api/admin/timeline/review/route");
    const response = await GET(new Request(
      "https://www.returner.fund/api/admin/timeline/review?status=probably",
      { headers: { "x-admin-timeline-secret": "timeline-test-secret" } },
    ));

    expect(response.status).toBe(400);
    expect(listTimelineCandidates).not.toHaveBeenCalled();
  });

  it("validates and audits candidate mutations", async () => {
    const applyTimelineAdminCandidateAction = vi.fn(async () => ({
      auditId: "audit-1",
      affectedEventIds: ["event-1"],
      cacheInvalidated: true,
    }));
    vi.doMock("@/lib/timeline/store", () => ({
      applyTimelineAdminCandidateAction,
      applyTimelineAdminCompanyAction: vi.fn(),
      applyTimelineAdminEventAction: vi.fn(),
    }));
    const { POST } = await import("../../src/app/api/admin/timeline/actions/route");
    const response = await POST(new Request(
      "https://www.returner.fund/api/admin/timeline/actions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer timeline-test-secret",
          "Content-Type": "application/json",
          "x-admin-actor-id": "reviewer-7",
        },
        body: JSON.stringify({
          scope: "candidate",
          action: {
            type: "publish_candidate",
            candidateId: "candidate-1",
            reason: "Direct primary evidence supports every public field.",
          },
        }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result.auditId).toBe("audit-1");
    expect(applyTimelineAdminCandidateAction).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: "candidate-1" }),
      { id: "reviewer-7" },
    );
  });

  it("uses deployment-owned audit identity in production and ignores caller headers", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_TIMELINE_ACTOR_ID", "timeline-release-operator");
    vi.stubEnv("ADMIN_TIMELINE_ACTOR_EMAIL", "timeline-ops@example.com");
    const applyTimelineAdminCandidateAction = vi.fn(async () => ({
      auditId: "audit-production",
      affectedEventIds: ["event-1"],
      cacheInvalidated: true,
    }));
    vi.doMock("@/lib/timeline/store", () => ({
      applyTimelineAdminCandidateAction,
      applyTimelineAdminCompanyAction: vi.fn(),
      applyTimelineAdminEventAction: vi.fn(),
    }));
    const { POST } = await import("../../src/app/api/admin/timeline/actions/route");
    const response = await POST(new Request(
      "https://www.returner.fund/api/admin/timeline/actions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer timeline-test-secret",
          "Content-Type": "application/json",
          "x-admin-actor-id": "spoofed-browser-actor",
          "x-admin-actor-email": "spoofed@example.com",
        },
        body: JSON.stringify({
          scope: "candidate",
          action: {
            type: "publish_candidate",
            candidateId: "candidate-1",
            reason: "Direct primary evidence supports every public field.",
          },
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(applyTimelineAdminCandidateAction).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: "candidate-1" }),
      { id: "timeline-release-operator", email: "timeline-ops@example.com" },
    );
  });

  it("rejects oversized action bodies without invoking a mutation", async () => {
    const applyTimelineAdminEventAction = vi.fn();
    vi.doMock("@/lib/timeline/store", () => ({
      applyTimelineAdminCandidateAction: vi.fn(),
      applyTimelineAdminCompanyAction: vi.fn(),
      applyTimelineAdminEventAction,
    }));
    const { POST } = await import("../../src/app/api/admin/timeline/actions/route");
    const response = await POST(new Request(
      "https://www.returner.fund/api/admin/timeline/actions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer timeline-test-secret",
          "Content-Length": String(65 * 1024),
        },
        body: "{}",
      },
    ));

    expect(response.status).toBe(413);
    expect(applyTimelineAdminEventAction).not.toHaveBeenCalled();
  });

  it("fails closed when the store cannot confirm audit and cache invalidation", async () => {
    const applyTimelineAdminEventAction = vi.fn(async () => ({
      auditId: "",
      affectedEventIds: ["event-1"],
      cacheInvalidated: false,
    }));
    vi.doMock("@/lib/timeline/store", () => ({
      applyTimelineAdminCandidateAction: vi.fn(),
      applyTimelineAdminCompanyAction: vi.fn(),
      applyTimelineAdminEventAction,
    }));
    const { POST } = await import("../../src/app/api/admin/timeline/actions/route");
    const response = await POST(new Request(
      "https://www.returner.fund/api/admin/timeline/actions",
      {
        method: "POST",
        headers: { Authorization: "Bearer timeline-test-secret" },
        body: JSON.stringify({
          scope: "event",
          action: { type: "unpublish", eventId: "event-1", reason: "Evidence was withdrawn." },
        }),
      },
    ));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("timeline_admin_request_failed");
  });
});
