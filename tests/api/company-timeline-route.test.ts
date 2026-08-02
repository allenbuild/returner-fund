import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TIMELINE_ARTIFACT_SCHEMA_VERSION,
  TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
  type CompanyTimelineEventDetailArtifact,
  type ListPublishedTimelineEventsResult,
  type TimelineCompanyRef,
} from "@/lib/timeline/contracts";
import { clearTimelineHttpCacheForTests } from "@/lib/timeline/http-cache";

const company: TimelineCompanyRef = { id: "company-acme", slug: "acme", name: "Acme" };
const timelineResult: ListPublishedTimelineEventsResult = {
  company,
  events: [{
    id: "event-launch",
    eventDate: "2026-03-18",
    eventDateType: "announcement_date",
    title: "Launched Acme publicly",
    summary: "The company opened its product to public registrations.",
    category: "product_launch",
    isMajor: true,
    hasConflict: false,
    conflictSummary: null,
    evidenceCount: 1,
    sourcePreview: [{
      id: "source-launch",
      title: "Acme launch",
      publisher: "Acme",
      domain: "acme.test",
      sourceType: "company_blog",
      publishedAt: "2026-03-18T12:00:00.000Z",
      evidenceRole: "primary",
      url: "https://acme.test/blog/launch",
    }],
  }],
  groups: [{ year: 2026, months: [{ month: "2026-03", count: 1 }] }],
  coverage: { status: "complete", publishedEventCount: 1, lastSuccessfulArtifactAt: "2026-07-02T00:00:00.000Z" },
  nextCursor: null,
  cache: {
    etag: "artifact-etag",
    generatedAt: "2026-07-01T00:00:00.000Z",
    lastModifiedAt: "2026-07-02T00:00:00.000Z",
    maxAgeSeconds: 300,
    staleWhileRevalidateSeconds: 86_400,
  },
};

describe("GET /api/companies/[slug]/timeline", () => {
  beforeEach(() => clearTimelineHttpCacheForTests());

  afterEach(() => {
    clearTimelineHttpCacheForTests();
    vi.doUnmock("@/lib/timeline/store");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns only the bounded published timeline payload with SWR caching", async () => {
    const resolveTimelineCompanyBySlug = vi.fn(async () => company);
    const listPublishedTimelineEvents = vi.fn(async () => ({
      ...timelineResult,
      company: { ...timelineResult.company, internalReviewState: "verified" },
      events: timelineResult.events.map((event) => ({
        ...event,
        classifierVersion: "private-classifier-v9",
        importanceScore: 99,
        sourcePreview: event.sourcePreview.map((source) => ({
          ...source,
          contentHash: "private-content-hash",
          rawSnapshotPath: "/private/source.json",
        })),
      })),
      groups: timelineResult.groups.map((group) => ({ ...group, internalCount: 999 })),
      coverage: { ...timelineResult.coverage, lastError: "private operator note" },
    }) as ListPublishedTimelineEventsResult);
    vi.doMock("@/lib/timeline/store", () => ({
      resolveTimelineCompanyBySlug,
      listPublishedTimelineEvents,
    }));
    const { GET } = await import("../../src/app/api/companies/[slug]/timeline/route");
    const request = new Request(
      "https://www.returner.fund/api/companies/acme/timeline?from=2026-01-01&categories=product_launch&limit=10",
    );
    const response = await GET(request, { params: Promise.resolve({ slug: "Acme" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-timeline-cache")).toBe("miss");
    expect(response.headers.get("cache-control")).toContain("stale-while-revalidate");
    expect(body.schemaVersion).toBe(TIMELINE_ARTIFACT_SCHEMA_VERSION);
    expect(body.events).toHaveLength(1);
    expect(body.filters).toEqual({ from: "2026-01-01", to: null, categories: ["product_launch"] });
    expect(body).not.toHaveProperty("classifierVersion");
    expect(body.company).not.toHaveProperty("internalReviewState");
    expect(body.events[0]).not.toHaveProperty("classifierVersion");
    expect(body.events[0]).not.toHaveProperty("importanceScore");
    expect(body.events[0].sourcePreview[0]).not.toHaveProperty("contentHash");
    expect(body.events[0].sourcePreview[0]).not.toHaveProperty("rawSnapshotPath");
    expect(body.groups[0]).not.toHaveProperty("internalCount");
    expect(body.coverage).not.toHaveProperty("lastError");
    expect(resolveTimelineCompanyBySlug).toHaveBeenCalledWith("acme");
    expect(listPublishedTimelineEvents).toHaveBeenCalledWith({
      companyId: "company-acme",
      from: "2026-01-01",
      to: undefined,
      categories: ["product_launch"],
      cursor: undefined,
      limit: 10,
    });
  });

  it("returns a structured 400 before accessing the store", async () => {
    const resolveTimelineCompanyBySlug = vi.fn();
    vi.doMock("@/lib/timeline/store", () => ({
      resolveTimelineCompanyBySlug,
      listPublishedTimelineEvents: vi.fn(),
    }));
    const { GET } = await import("../../src/app/api/companies/[slug]/timeline/route");
    const response = await GET(
      new Request("https://www.returner.fund/api/companies/acme/timeline?limit=500"),
      { params: Promise.resolve({ slug: "acme" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.error.code).toBe("invalid_timeline_request");
    expect(resolveTimelineCompanyBySlug).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown company without leaking store details", async () => {
    vi.doMock("@/lib/timeline/store", () => ({
      resolveTimelineCompanyBySlug: vi.fn(async () => null),
      listPublishedTimelineEvents: vi.fn(),
    }));
    const { GET } = await import("../../src/app/api/companies/[slug]/timeline/route");
    const response = await GET(
      new Request("https://www.returner.fund/api/companies/missing/timeline"),
      { params: Promise.resolve({ slug: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("timeline_company_not_found");
  });
});

describe("GET /api/timeline/events/[eventId]", () => {
  afterEach(() => {
    clearTimelineHttpCacheForTests();
    vi.doUnmock("@/lib/timeline/store");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("lazily returns complete evidence for a published event", async () => {
    const detail: CompanyTimelineEventDetailArtifact = {
      schemaVersion: TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
      company,
      event: {
        ...timelineResult.events[0],
        evidence: [{
          ...timelineResult.events[0].sourcePreview[0],
          publicationDate: "2026-03-18",
          excerpt: "Acme is now available.",
          sourceEventDate: "2026-03-18",
          isConflicting: false,
          conflictDescription: null,
        }],
        posts: [],
      },
      generatedAt: "2026-07-01T00:00:00.000Z",
      lastModifiedAt: "2026-07-02T00:00:00.000Z",
    };
    const getPublishedTimelineEventDetail = vi.fn(async () => detail);
    Object.assign(detail.event, { classifierVersion: "private-classifier-v9", importanceScore: 99 });
    Object.assign(detail.event.evidence[0], { contentHash: "private-content-hash", metadata: { secret: true } });
    vi.doMock("@/lib/timeline/store", () => ({ getPublishedTimelineEventDetail }));
    const { GET } = await import("../../src/app/api/timeline/events/[eventId]/route");
    const request = new Request("https://www.returner.fund/api/timeline/events/event-launch");
    const response = await GET(request, { params: Promise.resolve({ eventId: "event-launch" }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.event.evidence).toHaveLength(1);
    expect(body.event.posts).toEqual([]);
    expect(body.event).not.toHaveProperty("classifierVersion");
    expect(body.event).not.toHaveProperty("importanceScore");
    expect(body.event.evidence[0]).not.toHaveProperty("contentHash");
    expect(body.event.evidence[0]).not.toHaveProperty("metadata");
    expect(response.headers.get("etag")).toBe(body.cache.etag);
  });

  it("projects one social URL into related posts without duplicating web evidence", async () => {
    const socialUrl = "https://x.com/acme/status/123";
    const source = {
      ...timelineResult.events[0].sourcePreview[0],
      domain: "x.com",
      sourceType: "company_post" as const,
      url: socialUrl,
      publicationDate: "2026-03-18",
      excerpt: "Acme is live.",
      sourceEventDate: "2026-03-18",
      isConflicting: false,
      conflictDescription: null,
    };
    const detail: CompanyTimelineEventDetailArtifact = {
      schemaVersion: TIMELINE_EVENT_DETAIL_SCHEMA_VERSION,
      company,
      event: {
        ...timelineResult.events[0],
        evidence: [source],
        posts: [{
          id: "post-launch",
          platform: "x",
          account: "@acme",
          postDate: "2026-03-18",
          excerpt: "Acme is live.",
          url: `${socialUrl}?utm_source=timeline`,
          metrics: { likes: 42 },
          evidenceRole: "primary",
        }],
      },
      generatedAt: "2026-07-01T00:00:00.000Z",
      lastModifiedAt: "2026-07-02T00:00:00.000Z",
    };
    vi.doMock("@/lib/timeline/store", () => ({
      getPublishedTimelineEventDetail: vi.fn(async () => detail),
    }));
    const { GET } = await import("../../src/app/api/timeline/events/[eventId]/route");

    const response = await GET(
      new Request("https://www.returner.fund/api/timeline/events/event-launch"),
      { params: Promise.resolve({ eventId: "event-launch" }) },
    );
    const body = await response.json();

    expect(body.event.evidence).toEqual([]);
    expect(body.event.posts).toHaveLength(1);
    expect(body.event.posts[0].url).toContain(socialUrl);
  });

  it("does not expose unpublished or missing event details", async () => {
    vi.doMock("@/lib/timeline/store", () => ({
      getPublishedTimelineEventDetail: vi.fn(async () => null),
    }));
    const { GET } = await import("../../src/app/api/timeline/events/[eventId]/route");
    const response = await GET(
      new Request("https://www.returner.fund/api/timeline/events/private-event"),
      { params: Promise.resolve({ eventId: "private-event" }) },
    );
    expect(response.status).toBe(404);
  });
});
