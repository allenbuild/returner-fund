import { describe, expect, it } from "vitest";
import {
  companyTimelineHttpCacheKey,
  parseCompanyTimelineQuery,
  parseTimelineCompanySlug,
  parseTimelineEventId,
  TimelineHttpInputError,
  timelineJsonResponse,
} from "@/lib/timeline/http";

describe("timeline HTTP contract", () => {
  it("parses bounded, canonical filters", () => {
    const cursor = Buffer.from(JSON.stringify({ eventDate: "2026-01-01", id: "event-1" })).toString("base64url");
    const query = parseCompanyTimelineQuery(new URLSearchParams({
      from: "2025-01-01",
      to: "2026-02-28",
      categories: "funding,product_launch",
      cursor,
      limit: "25",
    }));

    expect(query).toEqual({
      from: "2025-01-01",
      to: "2026-02-28",
      categories: ["funding", "product_launch"],
      cursor,
      limit: 25,
    });
    expect(companyTimelineHttpCacheKey("acme", query)).toContain("product_launch");
  });

  it.each([
    ["invalid calendar date", "from=2026-02-30", "from"],
    ["inverted date range", "from=2026-04-02&to=2026-04-01", "from"],
    ["empty categories", "categories=", "categories"],
    ["unknown category", "categories=funding,hype", "categories.1"],
    ["duplicate category", "categories=funding,funding", "categories"],
    ["oversized limit", "limit=101", "limit"],
    ["repeated parameter", "limit=10&limit=20", "limit"],
    ["malformed cursor", "cursor=not-a-real-cursor", "cursor"],
    ["unknown parameter", "platform=github", "query"],
  ])("rejects %s", (_label, search, path) => {
    let thrown: unknown;
    try {
      parseCompanyTimelineQuery(new URLSearchParams(search));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TimelineHttpInputError);
    expect((thrown as TimelineHttpInputError).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  });

  it("normalizes a safe company slug and rejects path-like values", () => {
    expect(parseTimelineCompanySlug("ScreenPipe")).toBe("screenpipe");
    expect(() => parseTimelineCompanySlug("../screenpipe")).toThrow(TimelineHttpInputError);
  });

  it("accepts bounded opaque event IDs and rejects path-like values", () => {
    expect(parseTimelineEventId("timeline:event-1")).toBe("timeline:event-1");
    expect(() => parseTimelineEventId("../event-1")).toThrow(TimelineHttpInputError);
  });

  it("returns cache metadata, SWR headers, and honors If-None-Match", async () => {
    const request = new Request("https://www.returner.fund/api/companies/acme/timeline");
    const payload = { company: { id: "company-acme", slug: "acme", name: "Acme" }, events: [] };
    const response = timelineJsonResponse(request, payload, {
      generatedAt: "2026-07-01T00:00:00.000Z",
      lastModifiedAt: "2026-07-02T00:00:00.000Z",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=0");
    expect(response.headers.get("cache-control")).toContain("s-maxage=30");
    expect(response.headers.get("cache-control")).toContain("stale-while-revalidate=30");
    expect(response.headers.get("etag")).toBe(body.cache.etag);
    expect(response.headers.get("last-modified")).toBe("Thu, 02 Jul 2026 00:00:00 GMT");

    const notModified = timelineJsonResponse(
      new Request(request.url, { headers: { "If-None-Match": body.cache.etag } }),
      payload,
      {
        generatedAt: "2026-07-01T00:00:00.000Z",
        lastModifiedAt: "2026-07-02T00:00:00.000Z",
      },
    );
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
  });
});
