import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/graph/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/graph/refresh live evidence validation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns a refresh summary proving newest live evidence was ingested and made visible", async () => {
    const record = screenpipeRecord();
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>();
      return {
        ...actual,
        runLiveSourceRefresh: vi.fn(async () => ({
          runId: "test-live-refresh",
          generatedAt: "2026-07-14T17:00:00.000Z",
          acceptedEvidence: [record],
          storedEvidence: [record],
          stageLog: [
            {
              stage: "accepted",
              platform: "x",
              sourceUrl: record.sourceUrl,
              companyName: record.companyName,
              message: "Accepted Screenpipe test post.",
              at: "2026-07-14T17:00:00.000Z"
            }
          ],
          sourceSnapshots: {
            targetedEvidencePath: "test-targeted.json",
            targetedEvidenceBefore: 0,
            targetedEvidenceAfter: 1
          },
          platformRows: { x: 1 },
          failureReasonCounts: {}
        }))
      };
    });

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.errors).toEqual([]);
    expect(body.refreshSummary).toMatchObject({
      status: "completed",
      requestedPlatforms: ["x"],
      attemptedPlatforms: ["x"],
      unsupportedPlatforms: [],
      acceptedRows: 1,
      storedRows: 1,
      visibleRows: 1
    });
    expect(body.refreshSummary.newestIngestedEvidence[0]).toMatchObject({
      companyName: "screenpipe",
      platform: "x",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778664"
    });
    expect(body.refreshSummary.newestVisibleEvidence[0]).toMatchObject({
      companyName: "screenpipe",
      platform: "x",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778664"
    });
    expect(JSON.stringify(body.graph)).toContain("2077045452579778664");
  });

  it("lets live top-voice evidence participate in the top-voice graph instead of being hidden after filtering", async () => {
    const record = insiderScreenpipeRecord();
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>();
      return {
        ...actual,
        runLiveSourceRefresh: vi.fn(async () => ({
          runId: "test-live-insider-refresh",
          generatedAt: "2026-07-14T17:10:00.000Z",
          acceptedEvidence: [record],
          storedEvidence: [record],
          stageLog: [
            {
              stage: "accepted",
              platform: "x",
              sourceUrl: record.sourceUrl,
              companyName: record.companyName,
              message: "Accepted Sam Altman mentioning Screenpipe.",
              at: "2026-07-14T17:10:00.000Z"
            }
          ],
          sourceSnapshots: {
            targetedEvidencePath: "test-targeted.json",
            targetedEvidenceBefore: 0,
            targetedEvidenceAfter: 1
          },
          platformRows: { x: 1 },
          failureReasonCounts: {}
        })),
        loadLiveEvidenceRecords: vi.fn(async () => [record])
      };
    });

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"], topVoices: "insiders" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.graph.selectedTopVoiceAudience.id).toBe("insiders");
    expect(body.graph.nodes.some((node: { entityId: string }) => node.entityId === "company-screenpipe")).toBe(true);
    expect(body.graph.evidence[0]).toMatchObject({
      sourceUrl: "https://x.com/sama/status/2077000000000000001",
      attachedCompanyName: "screenpipe",
      topVoice: expect.objectContaining({
        displayName: "Sam Altman",
        audienceId: "insiders"
      })
    });
    expect(body.refreshSummary.newestVisibleEvidence[0]).toMatchObject({
      companyName: "screenpipe",
      platform: "x",
      sourceUrl: "https://x.com/sama/status/2077000000000000001"
    });
  });

  it("does not replace existing live top-voice evidence with the static no-op snapshot", async () => {
    const record = insiderScreenpipeRecord();
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>();
      return {
        ...actual,
        runLiveSourceRefresh: vi.fn(async () => ({
          runId: "test-live-insider-no-new-rows",
          generatedAt: "2026-07-14T17:12:00.000Z",
          acceptedEvidence: [],
          storedEvidence: [],
          stageLog: [
            {
              stage: "dropped",
              platform: "x",
              target: "sama",
              sourceUrl: "https://x.com/sama",
              reason: "top_voice_recent_no_match",
              message: "No new matching insider post was found.",
              at: "2026-07-14T17:12:00.000Z"
            }
          ],
          sourceSnapshots: {
            targetedEvidencePath: "test-targeted.json",
            targetedEvidenceBefore: 1,
            targetedEvidenceAfter: 1
          },
          platformRows: {},
          failureReasonCounts: { top_voice_recent_no_match: 1 }
        })),
        loadLiveEvidenceRecords: vi.fn(async () => [record])
      };
    });

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"], topVoices: "insiders" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.refreshSummary.fastPath).toBeUndefined();
    expect(body.graph.nodes.some((node: { entityId: string }) => node.entityId === "company-screenpipe")).toBe(true);
    expect(JSON.stringify(body.graph.evidence)).toContain("2077000000000000001");
  });

  it("does not return a stale generated top-voice snapshot after the local benchmark day changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T06:05:00.000Z"));

    vi.doMock("node:fs/promises", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs/promises")>()),
      readFile: vi.fn(async () =>
        JSON.stringify({
          generatedAt: "2026-07-14T06:05:00.000Z",
          fastestGaining: []
        })
      )
    }));
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>();
      return {
        ...actual,
        runLiveSourceRefresh: vi.fn(async () => ({
          runId: "test-stale-static-top-voice",
          generatedAt: "2026-07-15T06:05:00.000Z",
          acceptedEvidence: [],
          storedEvidence: [],
          stageLog: [
            {
              stage: "dropped",
              platform: "x",
              target: "top-voices",
              reason: "top_voice_recent_no_match",
              message: "No new matching top-voice post was found.",
              at: "2026-07-15T06:05:00.000Z"
            }
          ],
          sourceSnapshots: {
            targetedEvidencePath: "test-targeted.json",
            targetedEvidenceBefore: 0,
            targetedEvidenceAfter: 0
          },
          platformRows: {},
          failureReasonCounts: { top_voice_recent_no_match: 1 }
        })),
        loadLiveEvidenceRecords: vi.fn(async () => [])
      };
    });

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"], topVoices: "insiders" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.refreshSummary.fastPath).toBeUndefined();
    expect(body.logs.join(" ")).not.toContain("returned the generated public top-voice graph snapshot");
  });

  it("returns failed when live refresh completes without accepted evidence", async () => {
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>();
      return {
        ...actual,
        runLiveSourceRefresh: vi.fn(async () => ({
          runId: "test-empty-live-refresh",
          generatedAt: "2026-07-14T17:20:00.000Z",
          acceptedEvidence: [],
          storedEvidence: [],
          stageLog: [
            {
              stage: "dropped",
              platform: "x",
              target: "screenpipe",
              reason: "no_status_ids",
              sourceUrl: "https://x.com/screenpipe",
              message: "No post-level X status URLs were visible.",
              at: "2026-07-14T17:20:00.000Z"
            }
          ],
          sourceSnapshots: {
            targetedEvidencePath: "test-targeted.json",
            targetedEvidenceBefore: 0,
            targetedEvidenceAfter: 0
          },
          platformRows: {},
          failureReasonCounts: {
            no_status_ids: 1
          }
        })),
        loadLiveEvidenceRecords: vi.fn(async () => [])
      };
    });

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["x"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.errors[0]).toContain("Live refresh finished without accepted evidence");
    expect(body.refreshSummary).toMatchObject({
      status: "failed",
      requestedPlatforms: ["x"],
      attemptedPlatforms: ["x"],
      unsupportedPlatforms: [],
      acceptedRows: 0,
      storedRows: 0,
      visibleRows: 0
    });
    expect(body.refreshSummary.failureReasonCounts).toMatchObject({ no_status_ids: 1 });
  });

  it("returns failed and reports unsupported platforms when no requested adapter is wired", async () => {
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>();
      return {
        ...actual,
        runLiveSourceRefresh: vi.fn(async () => ({
          runId: "test-unsupported-live-refresh",
          generatedAt: "2026-07-14T17:25:00.000Z",
          acceptedEvidence: [],
          storedEvidence: [],
          stageLog: [
            {
              stage: "skipped",
              platform: "github",
              reason: "adapter_not_wired",
              message: "GitHub real-time adapter is not wired.",
              at: "2026-07-14T17:25:00.000Z"
            }
          ],
          sourceSnapshots: {
            targetedEvidencePath: "test-targeted.json",
            targetedEvidenceBefore: 0,
            targetedEvidenceAfter: 0
          },
          platformRows: {},
          failureReasonCounts: {
            adapter_not_wired: 1
          }
        })),
        loadLiveEvidenceRecords: vi.fn(async () => [])
      };
    });

    const { POST } = await import("../../src/app/api/graph/refresh/route");
    const response = await POST(jsonRequest({ action: "refresh", batchSlug: "S26", platforms: ["github"] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.refreshSummary).toMatchObject({
      requestedPlatforms: ["github"],
      attemptedPlatforms: [],
      unsupportedPlatforms: ["github"],
      acceptedRows: 0,
      visibleRows: 0
    });
    expect(body.errors[0]).toContain("adapter_not_wired:1");
  });
});

function screenpipeRecord(): LiveEvidenceRecord {
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
    last_updated_at: "2026-07-14T15:00:00.000Z"
  };
}

function insiderScreenpipeRecord(): LiveEvidenceRecord {
  return {
    id: "live-x-company-screenpipe-2077000000000000001",
    entityType: "company",
    entityId: "company-screenpipe",
    companyName: "screenpipe",
    platform: "x",
    title: "screenpipe is making local-first AI agents more useful",
    sourceUrl: "https://x.com/sama/status/2077000000000000001",
    platformPostId: "2077000000000000001",
    text: "screenpipe is making local-first AI agents more useful.",
    thumbnailUrl: null,
    thumbnailSource: null,
    mediaUrl: null,
    mediaUrls: [],
    media_urls: [],
    media_posters: [],
    linkStatus: "verified",
    linkCheckedAt: "2026-07-14T17:10:00.000Z",
    rawVisibleText: JSON.stringify({
      source: "live_x_top_voice_profile",
      post: {
        author: {
          screen_name: "sama",
          name: "Sam Altman",
          url: "https://x.com/sama"
        },
        text: "screenpipe is making local-first AI agents more useful."
      }
    }),
    postedAt: "2026-07-14T16:30:00.000Z",
    metrics: {
      views: 150000,
      likes: 900,
      comments: 90,
      replies: 90,
      reposts: 120
    },
    contributionScore: 96,
    review_state: "verified",
    matchReason: "Live manual refresh verified a native X post from insider @sama mentioning screenpipe.",
    first_seen_at: "2026-07-14T17:10:00.000Z",
    last_checked_at: "2026-07-14T17:10:00.000Z",
    last_updated_at: "2026-07-14T16:30:00.000Z"
  };
}
