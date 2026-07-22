import { describe, expect, it } from "vitest";
import {
  companyVerticalCounts,
  enrichEvidenceTopics,
  enrichGraphNodeVerticals,
  topicPhysicalPostCounts
} from "@/lib/graph/graph-taxonomies";
import { classifyPostTopics } from "@/lib/graph/post-topics";
import type { EvidenceItem, GraphNode } from "@/lib/graph/types";

describe("graph taxonomy enrichment", () => {
  it("classifies evidence once and preserves current classifier output", () => {
    const enriched = enrichEvidenceTopics(evidence({ text: "We crossed 10,000 paid customers." }));
    expect(enriched.topics).toContain("traction-growth");
    expect(enrichEvidenceTopics(enriched)).toBe(enriched);
  });

  it("reclassifies retired flat labels instead of treating them as curated truth", () => {
    const enriched = enrichEvidenceTopics(evidence({ topics: ["culture"], text: "We launched today." }));
    expect(enriched.topics).toEqual(["product-launch"]);
    expect(enriched.topicClassification?.method).toBe("rules");
  });

  it("preserves a canonical manual override across automated taxonomy enrichment", () => {
    const automatic = classifyPostTopics({ text: "We just launched our public beta today." });
    const enriched = enrichEvidenceTopics(evidence({
      topics: ["humor-culture"],
      text: "We just launched our public beta today.",
      topicClassification: { ...automatic, method: "manual", strength: "manual", primaryTopic: "humor-culture", topics: ["humor-culture"] }
    }));
    expect(enriched.topics).toEqual(["humor-culture"]);
    expect(enriched.topicClassification?.method).toBe("manual");
  });

  it("counts unique physical posts per topic across attachment duplicates", () => {
    const tractionText = "We crossed 10,000 paid customers.";
    const duplicateA = enrichEvidenceTopics(evidence({ id: "a", topics: ["traction"], text: tractionText }));
    const duplicateB = enrichEvidenceTopics(evidence({ id: "b", entityType: "founder", entityId: "founder", topics: ["traction"], text: tractionText }));
    const other = enrichEvidenceTopics(evidence({ id: "c", topics: ["traction"], text: tractionText, sourceUrl: "https://x.com/a/status/2", platformPostId: "2" }));
    expect(topicPhysicalPostCounts([duplicateA, duplicateB, other]).get("traction-growth")).toBe(2);
  });

  it("infers and counts bounded company verticals without touching score surfaces", () => {
    const source = companyNode();
    const enriched = enrichGraphNodeVerticals(source);
    expect(enriched.verticals).toContain("robotics");
    expect(enriched.score).toBe(source.score);
    expect(enriched.radius).toBe(source.radius);
    expect(enriched.platformScores).toBe(source.platformScores);
    expect(companyVerticalCounts([enriched]).get("robotics")).toBe(1);
  });
});

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "evidence",
    entityType: "company",
    entityId: "company",
    platform: "x",
    authorName: "Company",
    authorHandle: "company",
    postedAt: "2026-07-20T12:00:00.000Z",
    text: "A company update.",
    mediaType: "text",
    metrics: { likes: 5 },
    contributionScore: 50,
    sourceUrl: "https://x.com/a/status/1",
    platformPostId: "1",
    why: "Test",
    review_state: "verified",
    ...overrides
  };
}

function companyNode(): GraphNode {
  return {
    id: "company:robot",
    entityType: "company",
    entityId: "robot",
    label: "Robot Co",
    batchSlug: "S2026",
    score: 80,
    previousScore: 70,
    scoreDelta: 10,
    radius: 30,
    topPlatform: "x",
    platformScores: { x: 80 },
    socialAccounts: [],
    evidenceIds: [],
    ycProfileUrl: "https://example.com",
    websiteUrl: "https://example.com",
    tagline: "Robots for factories",
    description: "A humanoid robot fleet for production environments.",
    groupPartner: null,
    primaryIndustry: "industrials",
    businessModel: "hardware",
    review_state: "verified",
    sourceUrl: "https://example.com",
    visual: { industryColor: "#fff", shape: "ellipse", borderStyle: "solid", borderColor: "#000", groupRegion: null },
    industries: ["industrials", "robotics"],
    relatedEntityIds: [],
    founders: [],
    review_state_counts: { verified: 0, needs_review: 0, rejected: 0 }
  };
}
