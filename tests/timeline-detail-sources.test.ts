import { describe, expect, it } from "vitest";
import type { TimelineEvidenceDetail, TimelinePostEvidence } from "@/lib/timeline/contracts";
import { splitTimelineDetailSources, timelineSourceUrlKey } from "@/lib/timeline/detail-sources";

const evidence: TimelineEvidenceDetail = {
  id: "source-launch",
  title: "We launched",
  publisher: "Acme",
  domain: "x.com",
  sourceType: "company_post",
  publishedAt: "2026-03-18T12:00:00.000Z",
  evidenceRole: "primary",
  url: "https://x.com/acme/status/123",
  publicationDate: "2026-03-18",
  excerpt: "Acme is live.",
  sourceEventDate: "2026-03-18",
  isConflicting: false,
  conflictDescription: null,
};

const post: TimelinePostEvidence = {
  id: "post-launch",
  platform: "x",
  account: "@acme",
  postDate: "2026-03-18",
  excerpt: "Acme is live.",
  url: "https://twitter.com/acme/status/123/?utm_source=launch#metrics",
  metrics: { likes: 42 },
  evidenceRole: "primary",
};

describe("timeline detail source sections", () => {
  it("renders a social source in the richer post section only", () => {
    expect(timelineSourceUrlKey(evidence.url)).toBe(timelineSourceUrlKey(post.url));

    const result = splitTimelineDetailSources("2026-03-18", [evidence], [post]);

    expect(result.evidence).toEqual([]);
    expect(result.posts).toEqual([post]);
  });

  it("preserves conflict metadata instead of replacing it with a post card", () => {
    const conflicting = {
      ...evidence,
      evidenceRole: "conflicting" as const,
      sourceEventDate: "2026-03-17",
      isConflicting: true,
      conflictDescription: "The post names March 17 as the launch date.",
    };

    const result = splitTimelineDetailSources("2026-03-18", [conflicting], [post]);

    expect(result.evidence).toEqual([conflicting]);
    expect(result.posts).toEqual([]);
  });

  it("keeps independent web evidence and posts in their respective sections", () => {
    const article = { ...evidence, url: "https://acme.test/blog/launch", sourceType: "company_blog" as const };

    expect(splitTimelineDetailSources("2026-03-18", [article], [post])).toEqual({
      evidence: [article],
      posts: [post],
    });
  });
});
