import { describe, expect, it, vi } from "vitest";
import { normalizeEvidenceTemporalSemantics } from "@/lib/graph/static-graph-snapshot-contract.mjs";
import { normalizeEvidenceScores, scoringEligibility } from "@/lib/graph/traction-scoring";
import { credibleNativePublicationDate, isCrediblyPublishedToday } from "@/lib/graph/native-publication-date";
import { rankableEvidence } from "@/lib/graph/ranked-posts";
import { classifySourceDeterministically } from "@/lib/timeline/classification";
import type { EvidenceItem } from "@/lib/graph/types";
import type { TimelineClassificationInput, TimelineClassificationSource } from "@/lib/timeline/domain";

vi.mock("@/lib/graph/ranked-posts-sidecar", () => ({ rankedPostsSidecarScope: () => null }));

const observedAt = "2026-11-16T21:11:15.376Z";
const evidence: EvidenceItem = { id: "relative-native-short", batchSlug: "F26", entityType: "company", entityId: "company-fixture", platform: "youtube", authorName: "Fixture", authorHandle: "fixture", postedAt: observedAt, observedAt, publishedAtPrecision: "unknown", text: "Fixture launched its native product.", mediaType: "video", sourceUrl: "https://www.youtube.com/shorts/abcdefghijk", platformPostId: "abcdefghijk", metrics: { views: 1, likes: 0 }, contributionScore: 0, tractionStatus: "unscored", review_state: "verified", linkStatus: "verified", why: "The native publication factoid supplies only a relative label." };

describe("unscored native relative-publication boundary", () => {
  it("keeps an observation placeholder out of scores, rankings and credible publication dates", () => {
    const temporal = normalizeEvidenceTemporalSemantics(evidence);
    const [row] = normalizeEvidenceScores([temporal]);
    expect(row.postedAt).toBe(observedAt);
    expect(row.publishedAtPrecision).toBe("unknown");
    expect(row.contributionScore).toBe(0);
    expect(row.tractionStatus).toBe("unscored");
    expect(scoringEligibility(row).eligible).toBe(false);
    expect(rankableEvidence([row])).toEqual([]);
    expect(credibleNativePublicationDate(row)).toBeNull();
    expect(isCrediblyPublishedToday(row, new Date(observedAt))).toBe(false);

    const [known] = normalizeEvidenceScores([{ ...evidence, postedAt: "2026-11-15", publishedAtPrecision: "day", contributionScore: 1, tractionStatus: undefined }]);
    expect(known.contributionScore).toBeGreaterThan(0);
    expect(rankableEvidence([known])).toHaveLength(1);
    expect(credibleNativePublicationDate(known)?.centralDay).toBe("2026-11-15");
  });

  it("cannot turn the observation placeholder into a dated timeline event", () => {
    const source: TimelineClassificationSource = { id: evidence.id, url: evidence.sourceUrl, title: "Fixture product launch", publisher: "Fixture", sourceType: "news_article", platform: "web", publicationTimestamp: observedAt, publicationDatePrecision: "unknown", text: evidence.text, evidenceExcerpt: evidence.text, sourceQualityTier: 2, attributionStatus: "verified", linkStatus: "verified", topic: null, authorRelationship: "company" };
    const input: TimelineClassificationInput = { company: { id: "company-fixture", slug: "fixture", name: "Fixture", aliases: ["Fixture"], websiteUrl: "https://fixture.example", founderNames: [] }, sources: [source], existingEventKeys: [] };
    expect(classifySourceDeterministically(input, source)).toMatchObject({ isMeaningfulEvent: false, reason: "exact_date_unsupported" });
  });
});
