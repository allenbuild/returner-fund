import { describe, expect, it } from "vitest";
import {
  credibleNativePublicationDate,
  isCrediblyPublishedToday,
  isCrediblyPublishedWithinWindow
} from "@/lib/graph/native-publication-date";
import type { EvidenceItem, Platform } from "@/lib/graph/types";

const DAILY_POST_PLATFORMS = [
  "github",
  "instagram",
  "x",
  "linkedin",
  "youtube",
  "hacker_news",
  "product_hunt",
  "reddit",
  "bilibili",
  "rss"
] satisfies Platform[];

describe("native publication date contract", () => {
  it.each(DAILY_POST_PLATFORMS)("accepts an explicit native publication timestamp for %s", (platform) => {
    const item = evidence(platform, {
      postedAt: "2026-07-31T15:30:00.000Z",
      publishedAtPrecision: "exact"
    });

    expect(credibleNativePublicationDate(item)).toEqual({
      timestamp: Date.parse("2026-07-31T15:30:00.000Z"),
      centralDay: "2026-07-31",
      precision: "exact"
    });
    expect(isCrediblyPublishedToday(item, new Date("2026-07-31T18:00:00.000Z"))).toBe(true);
  });

  it.each(DAILY_POST_PLATFORMS)(
    "never substitutes observation or refresh clocks for a missing %s publication date",
    (platform) => {
      const item = evidence(platform, {
        postedAt: "",
        publishedAtPrecision: "unknown",
        observedAt: "2026-07-31T15:30:00.000Z",
        metricsCheckedAt: "2026-07-31T15:30:00.000Z",
        first_seen_at: "2026-07-31T15:30:00.000Z",
        last_checked_at: "2026-07-31T15:30:00.000Z",
        last_updated_at: "2026-07-31T15:30:00.000Z"
      });

      expect(credibleNativePublicationDate(item)).toBeNull();
      expect(isCrediblyPublishedToday(item, new Date("2026-07-31T18:00:00.000Z"))).toBe(false);
      expect(isCrediblyPublishedWithinWindow(item, new Date("2026-07-31T18:00:00.000Z"), 30 * 86_400_000))
        .toBe(false);
    }
  );

  it("fails closed for missing precision, unknown precision, invalid dates, and false exactness", () => {
    expect(credibleNativePublicationDate({
      postedAt: undefined,
      publishedAtPrecision: "exact"
    } as unknown as Pick<EvidenceItem, "postedAt" | "publishedAtPrecision">)).toBeNull();
    expect(credibleNativePublicationDate(evidence("x", { publishedAtPrecision: undefined }))).toBeNull();
    expect(credibleNativePublicationDate(evidence("x", { publishedAtPrecision: "unknown" }))).toBeNull();
    expect(credibleNativePublicationDate(evidence("x", {
      postedAt: "not-a-date",
      publishedAtPrecision: "exact"
    }))).toBeNull();
    expect(credibleNativePublicationDate(evidence("x", {
      postedAt: "2026-07-31",
      publishedAtPrecision: "exact"
    }))).toBeNull();
    expect(credibleNativePublicationDate(evidence("x", {
      postedAt: "2026-07-31T12:00:00",
      publishedAtPrecision: "exact"
    }))).toBeNull();
    expect(credibleNativePublicationDate(evidence("x", {
      postedAt: "2026-02-31T12:00:00Z",
      publishedAtPrecision: "exact"
    }))).toBeNull();
    expect(credibleNativePublicationDate(evidence("x", {
      postedAt: "2026-07-31T24:00:00Z",
      publishedAtPrecision: "exact"
    }))).toBeNull();
    expect(credibleNativePublicationDate(evidence("x", {
      postedAt: "2026-07-31T12:00:00+14:30",
      publishedAtPrecision: "exact"
    }))).toBeNull();
    expect(credibleNativePublicationDate(evidence("x", {
      postedAt: "2026-02-31",
      publishedAtPrecision: "day"
    }))).toBeNull();
    expect(credibleNativePublicationDate(evidence("x", {
      postedAt: "2026-07-31Tgarbage",
      publishedAtPrecision: "day"
    }))).toBeNull();
  });

  it("accepts valid leap-day exact instants after calendar round-trip validation", () => {
    expect(credibleNativePublicationDate(evidence("x", {
      postedAt: "2028-02-29T23:59:59-06:00",
      publishedAtPrecision: "exact"
    }))).toEqual({
      timestamp: Date.parse("2028-02-29T23:59:59-06:00"),
      centralDay: "2028-02-29",
      precision: "exact"
    });
  });

  it("treats a credible date-only publication as its native calendar day", () => {
    const item = evidence("youtube", {
      postedAt: "2026-07-31",
      publishedAtPrecision: "day"
    });

    // Midnight UTC would be July 30 in Chicago. The native date claim is July 31.
    expect(credibleNativePublicationDate(item)?.centralDay).toBe("2026-07-31");
    expect(isCrediblyPublishedToday(item, new Date("2026-07-31T06:00:00.000Z"))).toBe(true);
  });

  it("rejects future exact instants and future day-only dates", () => {
    const now = new Date("2026-07-31T18:00:00.000Z");
    expect(isCrediblyPublishedToday(evidence("linkedin", {
      postedAt: "2026-07-31T19:00:00.000Z",
      publishedAtPrecision: "exact"
    }), now)).toBe(false);
    expect(isCrediblyPublishedToday(evidence("linkedin", {
      postedAt: "2026-08-01",
      publishedAtPrecision: "day"
    }), now)).toBe(false);
  });
});

function evidence(platform: Platform, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: `${platform}-publication-contract`,
    entityType: "company",
    entityId: "company-1",
    platform,
    authorName: "Example",
    authorHandle: "example",
    postedAt: "2026-07-31T15:30:00.000Z",
    publishedAtPrecision: "exact",
    text: "Native post",
    mediaType: platform === "github" ? "repo" : "text",
    metrics: {},
    contributionScore: 1,
    sourceUrl: "https://example.com/native-post",
    why: "Test fixture",
    ...overrides
  };
}
