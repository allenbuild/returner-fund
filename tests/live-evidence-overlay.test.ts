import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { liveEvidenceCacheVersion } from "@/lib/graph/live-evidence-dataset";
import { liveEvidenceRecordToEvidenceItem, overlayLiveEvidenceOnGraph } from "@/lib/graph/live-evidence-overlay";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";

describe("live evidence overlay", () => {
  it("attaches freshly ingested Screenpipe X evidence to the visible company graph", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const record = {
      ...screenpipeRecord(),
      metrics: {
        ...screenpipeRecord().metrics,
        views: 999999
      },
      last_checked_at: "2030-07-14T17:00:00.000Z",
      linkCheckedAt: "2030-07-14T17:00:00.000Z"
    };
    const result = overlayLiveEvidenceOnGraph(graph, [record]);
    const screenpipe = result.graph.nodes.find((node) => node.entityId === "company-screenpipe");

    expect(result.visibleEvidence).toHaveLength(1);
    expect(result.hiddenEvidence).toEqual([]);
    const screenpipeRows = result.graph.evidence.filter((item) => item.sourceUrl === "https://x.com/screenpipe/status/2077045452579778664");
    expect(screenpipeRows).toHaveLength(1);
    expect(screenpipeRows[0]?.metrics.views).toBe(999999);
    expect(screenpipe?.evidenceIds).toContain(screenpipeRows[0]?.id);
    expect(result.graph.leaderboard.find((row) => row.companyId === "company-screenpipe")?.score).toBeGreaterThan(0);
  });

  it("reports current filters that hide live evidence instead of pretending refresh succeeded visibly", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "insiders" }, ycSpring2026GraphDataset);
    const result = overlayLiveEvidenceOnGraph(graph, [screenpipeRecord()], { topVoices: "insiders" });

    expect(result.visibleEvidence).toEqual([]);
    expect(result.hiddenEvidence[0]).toMatchObject({
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778664",
      companyName: "screenpipe",
      reason: "hidden_by_top_voice_filter:insiders"
    });
  });

  it("changes the API cache version when live evidence metrics change at the same checked time", () => {
    const original = screenpipeRecord();
    const corrected = {
      ...original,
      metrics: {
        ...original.metrics,
        views: 250000,
        likes: 1200
      },
      contributionScore: 97
    };

    expect(liveEvidenceCacheVersion([corrected])).not.toBe(liveEvidenceCacheVersion([original]));
  });

  it("lets incoming live metrics win over same-post evidence with equal freshness timestamps", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const first = screenpipeRecord({
      metrics: {
        ...screenpipeRecord().metrics,
        views: 100
      },
      contributionScore: 35,
      last_checked_at: "2030-07-14T17:00:00.000Z",
      linkCheckedAt: "2030-07-14T17:00:00.000Z"
    });
    const corrected = screenpipeRecord({
      metrics: {
        ...screenpipeRecord().metrics,
        views: 250000
      },
      contributionScore: 97,
      last_checked_at: "2030-07-14T17:00:00.000Z",
      linkCheckedAt: "2030-07-14T17:00:00.000Z"
    });
    const withFirst = overlayLiveEvidenceOnGraph(graph, [first]).graph;
    const withCorrected = overlayLiveEvidenceOnGraph(withFirst, [corrected]).graph;
    const row = withCorrected.evidence.find((item) => item.sourceUrl === corrected.sourceUrl);

    expect(row?.id).toBe(first.id);
    expect(row?.metrics.views).toBe(250000);
  });

  it("classifies image-only X media as image and native video media as video", () => {
    const imageOnly = liveEvidenceRecordToEvidenceItem(
      screenpipeRecord({
        id: "live-x-company-screenpipe-image",
        thumbnailUrl: null,
        thumbnailSource: null,
        mediaUrl: "https://pbs.twimg.com/media/screenpipe-still.jpg",
        mediaUrls: ["https://pbs.twimg.com/media/screenpipe-still.jpg"],
        media_urls: ["https://pbs.twimg.com/media/screenpipe-still.jpg"],
        media_posters: []
      })
    );
    const video = liveEvidenceRecordToEvidenceItem(screenpipeRecord());

    expect(imageOnly.mediaType).toBe("image");
    expect(video.mediaType).toBe("video");
  });
});

function screenpipeRecord(overrides: Partial<LiveEvidenceRecord> = {}): LiveEvidenceRecord {
  return {
    id: "live-x-company-screenpipe-2077045452579778664",
    entityType: "company",
    entityId: "company-screenpipe",
    companyName: "screenpipe",
    platform: "x",
    title: "introducing screenpipe",
    sourceUrl: "https://x.com/screenpipe/status/2077045452579778664",
    platformPostId: "2077045452579778664",
    text: "introducing screenpipe: it records and learns how you work and turns it into a searchable memory, SOPs, and AI agents",
    thumbnailUrl: "https://pbs.twimg.com/screenpipe-demo.jpg",
    thumbnailSource: "x_media",
    mediaUrl: "https://video.twimg.com/screenpipe-demo.mp4",
    mediaUrls: ["https://video.twimg.com/screenpipe-demo.mp4"],
    media_urls: ["https://video.twimg.com/screenpipe-demo.mp4"],
    media_posters: ["https://pbs.twimg.com/screenpipe-demo.jpg"],
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
      reposts: 104,
      saves: 1000
    },
    contributionScore: 90,
    review_state: "verified",
    matchReason: "Live manual refresh verified a native X post from official @screenpipe for screenpipe.",
    first_seen_at: "2026-07-14T17:00:00.000Z",
    last_checked_at: "2026-07-14T17:00:00.000Z",
    last_updated_at: "2026-07-14T15:00:00.000Z",
    ...overrides
  };
}
