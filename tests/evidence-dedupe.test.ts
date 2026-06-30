import { describe, expect, it } from "vitest";
import { canonicalEvidenceUrl, dedupeEvidenceItems } from "@/lib/graph/dedupe";
import type { EvidenceItem } from "@/lib/graph/types";

describe("evidence dedupe", () => {
  it("canonicalizes social URL variants", () => {
    expect(canonicalEvidenceUrl("https://twitter.com/AllenXTech/status/12345?s=20&utm_source=x")).toBe(
      "https://x.com/allenxtech/status/12345"
    );
    expect(canonicalEvidenceUrl("https://mobile.twitter.com/AllenXTech/status/12345?ref_src=twsrc")).toBe(
      "https://x.com/allenxtech/status/12345"
    );
    expect(canonicalEvidenceUrl("https://www.instagram.com/reel/ABC123/?igshid=test&utm_campaign=x")).toBe(
      "https://instagram.com/reel/ABC123"
    );
  });

  it("keeps only the strongest duplicate evidence row", () => {
    const items = [
      evidence("low", "https://x.com/allenxtech/status/12345?utm_source=one", 20),
      evidence("high", "https://twitter.com/allenxtech/status/12345?s=20", 90)
    ];

    expect(dedupeEvidenceItems(items).map((item) => item.id)).toEqual(["high"]);
  });

  it("keeps the latest duplicate metric snapshot even when an older row was stronger", () => {
    const items = [
      {
        ...evidence("older-high", "https://x.com/allenxtech/status/12345?utm_source=one", 95),
        last_checked_at: "2026-06-01T00:00:00Z"
      },
      {
        ...evidence("newer-lower", "https://twitter.com/allenxtech/status/12345?s=20", 72),
        last_checked_at: "2026-06-28T00:00:00Z"
      }
    ];

    expect(dedupeEvidenceItems(items).map((item) => item.id)).toEqual(["newer-lower"]);
  });

  it("uses platform post IDs as the strongest canonical key when available", () => {
    const items = [
      {
        ...evidence("company-path", "https://instagram.com/reel/ABC123?igshid=one", 40),
        platform: "instagram" as const,
        platformPostId: "ABC123",
        last_checked_at: "2026-06-20T00:00:00Z"
      },
      {
        ...evidence("founder-path", "https://instagram.com/p/ignored", 48),
        platform: "instagram" as const,
        platformPostId: "abc123",
        last_checked_at: "2026-06-21T00:00:00Z"
      }
    ];

    expect(dedupeEvidenceItems(items).map((item) => item.id)).toEqual(["founder-path"]);
  });
});

function evidence(id: string, sourceUrl: string, contributionScore: number): EvidenceItem {
  return {
    id,
    entityType: "company",
    entityId: "company-test",
    platform: "x",
    authorName: "Test",
    authorHandle: "test",
    postedAt: "2026-06-01T00:00:00Z",
    text: "Launch post",
    mediaType: "text",
    metrics: { views: contributionScore * 100 },
    contributionScore,
    sourceUrl,
    why: "test"
  };
}
