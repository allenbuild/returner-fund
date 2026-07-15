import { describe, expect, it } from "vitest";
import { datasetWithLiveEvidence } from "@/lib/graph/live-evidence-dataset";
import type { LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";
import type { DemoGraphDataset, EvidenceItem } from "@/lib/graph/types";

describe("live evidence dataset merge", () => {
  it("normalizes live evidence scores before top-voice graph rollups consume them", () => {
    const dataset = datasetWithLiveEvidence(baseDataset(), [
      liveXRecord({
        contributionScore: 17,
        metrics: {
          views: 100000,
          likes: 2000,
          comments: 140,
          reposts: 90
        }
      })
    ]);
    const liveEvidence = dataset.evidence.find((item) => item.id === "live-x-company-screenpipe-2077045452579778664");

    expect(liveEvidence?.contributionScore).toBeGreaterThan(17);
    expect(liveEvidence?.normalizedScore).toBe(liveEvidence?.contributionScore);
    expect(liveEvidence?.why).toContain("Log-normalized");
  });
});

function baseDataset(): DemoGraphDataset {
  return {
    mode: "official_snapshot",
    batches: [{ slug: "S26", label: "YC Summer 2026 (S26)", companyCountExpected: 1, companyCountObserved: 1 }],
    companies: [],
    founders: [],
    evidence: [
      evidenceItem("existing-low", { views: 1000, likes: 20, comments: 2 }, 30),
      evidenceItem("existing-mid", { views: 10000, likes: 120, comments: 12 }, 55)
    ],
    needsReview: [],
    platformStatus: []
  };
}

function evidenceItem(id: string, metrics: EvidenceItem["metrics"], contributionScore: number): EvidenceItem {
  return {
    id,
    entityType: "company",
    entityId: "company-existing",
    platform: "x",
    authorName: "Existing",
    authorHandle: "existing",
    postedAt: "2026-07-10T00:00:00.000Z",
    title: "Existing post",
    text: "Existing post",
    mediaType: "text",
    metrics,
    contributionScore,
    sourceUrl: `https://x.com/existing/status/${id}`,
    platformPostId: id,
    why: "Existing normalized evidence.",
    attachedCompanyId: "company-existing",
    attachedCompanyName: "Existing"
  };
}

function liveXRecord(overrides: Partial<LiveEvidenceRecord> = {}): LiveEvidenceRecord {
  return {
    id: "live-x-company-screenpipe-2077045452579778664",
    entityType: "company",
    entityId: "company-screenpipe",
    companyName: "screenpipe",
    platform: "x",
    title: "introducing screenpipe",
    sourceUrl: "https://x.com/screenpipe/status/2077045452579778664",
    platformPostId: "2077045452579778664",
    text: "introducing screenpipe: searchable work memory and AI agents",
    thumbnailUrl: null,
    thumbnailSource: null,
    mediaUrl: null,
    mediaUrls: [],
    media_urls: [],
    media_posters: [],
    linkStatus: "verified",
    linkCheckedAt: "2026-07-14T17:00:00.000Z",
    rawVisibleText: JSON.stringify({
      source: "live_x_profile",
      post: {
        author: {
          screen_name: "screenpipe",
          name: "screenpipe (YC S26)",
          url: "https://x.com/screenpipe"
        }
      }
    }),
    postedAt: "2026-07-14T15:00:00.000Z",
    metrics: {
      views: 116000,
      likes: 697,
      comments: 74,
      replies: 74,
      reposts: 104
    },
    contributionScore: 17,
    review_state: "verified",
    matchReason: "Live manual refresh verified a native X post from official @screenpipe for screenpipe.",
    first_seen_at: "2026-07-14T17:00:00.000Z",
    last_checked_at: "2026-07-14T17:00:00.000Z",
    last_updated_at: "2026-07-14T15:00:00.000Z",
    ...overrides
  };
}
