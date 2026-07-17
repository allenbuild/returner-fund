import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { loadLiveEvidenceRecords, runLiveSourceRefresh, type LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";

const X_PROVIDER_RESPONSE_CASES = [
  { label: "FxTwitter tweet", shape: "fxtwitter_tweet", provider: "fxtwitter" },
  { label: "FxTwitter status", shape: "fxtwitter_status", provider: "fxtwitter" },
  { label: "VxTwitter", shape: "vxtwitter", provider: "vxtwitter" }
] as const;

type XProviderResponseShape = (typeof X_PROVIDER_RESPONSE_CASES)[number]["shape"];

describe("live source refresh", () => {
  it("discovers and stores the current Screenpipe X post from public profile HTML and post JSON", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://x.com/screenpipe") {
        return new Response('<a href="https://x.com/screenpipe/status/2077045452579778664">post</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://api.fxtwitter.com/screenpipe/status/2077045452579778664") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/screenpipe/status/2077045452579778664",
            id: "2077045452579778664",
            text: "introducing screenpipe: it records and learns how you work and turns it into a searchable memory, SOPs, and AI agents",
            created_timestamp: 1784041200,
            replies: 74,
            retweets: 104,
            likes: 697,
            views: 116000,
            bookmarks: 1000,
            author: {
              screen_name: "screenpipe",
              name: "screenpipe (YC S26)",
              url: "https://x.com/screenpipe"
            },
            media: {
              all: [
                {
                  url: "https://video.twimg.com/screenpipe-demo.mp4",
                  thumbnail_url: "https://pbs.twimg.com/screenpipe-demo.jpg",
                  type: "video"
                }
              ]
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlugs: ["S26"],
        platforms: ["x"],
        xTargetHandles: ["screenpipe"],
        xConcurrency: 1,
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:00:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.acceptedEvidence[0]).toMatchObject({
        entityId: "company-screenpipe",
        companyName: "screenpipe",
        platform: "x",
        sourceUrl: "https://x.com/screenpipe/status/2077045452579778664",
        platformPostId: "2077045452579778664",
        metrics: expect.objectContaining({
          views: 116000,
          likes: 697,
          replies: 74,
          reposts: 104
        }),
        review_state: "verified"
      });
      expect(result.acceptedEvidence[0]?.metrics).not.toHaveProperty("comments");
      expect(result.acceptedEvidence[0]?.metrics).not.toHaveProperty("shares");
      expect(result.failureReasonCounts.adapter_not_wired).toBeUndefined();
      expect(result.stageLog.some((entry) => entry.stage === "accepted" && entry.reason === undefined)).toBe(true);
      expect(result).toMatchObject({
        cancellationReason: null,
        networkRequests: 2,
        networkRequestBudget: null,
        networkRequestBudgetExhausted: false
      });

      const stored = JSON.parse(await readFile(targetedEvidencePath, "utf8"));
      expect(stored.evidence).toHaveLength(1);
      expect(stored.evidence[0].rawVisibleText).toContain('"source":"live_x_profile"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ingests an explicit first-party X status URL even when profile scanning is disabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-direct-x-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.fxtwitter.com/screenpipe/status/2077045452579778664") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/screenpipe/status/2077045452579778664",
            id: "2077045452579778664",
            text: "introducing screenpipe: it records and learns how you work and turns it into a searchable memory, SOPs, and AI agents",
            created_timestamp: 1784041200,
            replies: 74,
            retweets: 104,
            likes: 697,
            views: 116000,
            bookmarks: 1000,
            author: {
              screen_name: "screenpipe",
              name: "screenpipe (YC S26)",
              url: "https://x.com/screenpipe"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        maxXTargets: 0,
        xRequestTimeoutMs: 500,
        xSourceUrls: ["https://x.com/screenpipe/status/2077045452579778664"],
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:05:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.acceptedEvidence[0]).toMatchObject({
        entityId: "company-screenpipe",
        companyName: "screenpipe",
        platform: "x",
        sourceUrl: "https://x.com/screenpipe/status/2077045452579778664",
        metrics: expect.objectContaining({
          views: 116000,
          likes: 697,
          replies: 74,
          reposts: 104
        })
      });
      expect(result.stageLog.some((entry) => entry.message.includes("Accepted direct X post"))).toBe(true);
      expect(result.stageLog.some((entry) => entry.sourceUrl === "https://x.com/screenpipe")).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each(X_PROVIDER_RESPONSE_CASES)(
    "rejects a mismatched status ID from a $label response with structured provider context",
    async ({ shape, provider }) => {
      const requestedPostId = "2077045452579778664";
      const returnedPostId = "2077045452579778999";
      const result = await runDirectProviderPayload(
        shape,
        providerPayload(shape, {
          returnedPostId,
          canonicalPostId: requestedPostId
        }),
        requestedPostId
      );

      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.failureReasonCounts.provider_post_id_mismatch).toBe(1);
      expect(result.stageLog).toContainEqual(
        expect.objectContaining({
          stage: "failed",
          provider,
          reason: "provider_post_id_mismatch",
          sourceUrl: `https://x.com/screenpipe/status/${requestedPostId}`,
          expectedPostId: requestedPostId,
          returnedPostId,
          returnedCanonicalUrl: `https://x.com/screenpipe/status/${requestedPostId}`
        })
      );
    }
  );

  it.each(X_PROVIDER_RESPONSE_CASES)(
    "rejects a canonical URL mismatch from a $label response with structured provider context",
    async ({ shape, provider }) => {
      const requestedPostId = "2077045452579778664";
      const canonicalPostId = "2077045452579778999";
      const result = await runDirectProviderPayload(
        shape,
        providerPayload(shape, {
          returnedPostId: requestedPostId,
          canonicalPostId
        }),
        requestedPostId
      );

      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.failureReasonCounts.provider_canonical_url_mismatch).toBe(1);
      expect(result.stageLog).toContainEqual(
        expect.objectContaining({
          stage: "failed",
          provider,
          reason: "provider_canonical_url_mismatch",
          sourceUrl: `https://x.com/screenpipe/status/${requestedPostId}`,
          expectedPostId: requestedPostId,
          returnedPostId: requestedPostId,
          returnedCanonicalUrl: `https://x.com/screenpipe/status/${canonicalPostId}`
        })
      );
    }
  );

  it.each(X_PROVIDER_RESPONSE_CASES)(
    "accepts a $label response only when its ID and canonical URL match the requested status",
    async ({ shape }) => {
      const requestedPostId = "2077045452579778664";
      const result = await runDirectProviderPayload(
        shape,
        providerPayload(shape, {
          returnedPostId: requestedPostId,
          canonicalPostId: requestedPostId
        }),
        requestedPostId
      );

      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.acceptedEvidence[0]).toMatchObject({
        entityId: "company-screenpipe",
        platformPostId: requestedPostId,
        metrics: expect.objectContaining({ views: 116000, likes: 697, replies: 74, reposts: 104 })
      });
      expect(result.acceptedEvidence[0]?.sourceUrl).toMatch(
        new RegExp(`/screenpipe/status/${requestedPostId}$`, "i")
      );
      expect(result.failureReasonCounts.provider_post_id_mismatch).toBeUndefined();
      expect(result.failureReasonCounts.provider_canonical_url_mismatch).toBeUndefined();
    }
  );

  it("accepts a direct post from a founder defined by a verified social override", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-verified-founder-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.fxtwitter.com/farzatv/status/2077130366230639022") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/FarzaTV/status/2077130366230639022",
            id: "2077130366230639022",
            text: "Today we're shipping screen-aware dictation. Now dictate using your screen as context.",
            created_at: "Tue Jul 14 20:37:25 +0000 2026",
            replies: 544,
            retweets: 465,
            likes: 10602,
            views: 2687075,
            author: {
              screen_name: "FarzaTV",
              name: "Farza",
              url: "https://x.com/FarzaTV"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S2026",
        platforms: ["x"],
        maxXTargets: 0,
        xRequestTimeoutMs: 500,
        xSourceUrls: ["https://x.com/FarzaTV/status/2077130366230639022"],
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-16T18:00:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence, JSON.stringify(result.stageLog, null, 2)).toHaveLength(1);
      expect(result.acceptedEvidence[0]).toMatchObject({
        entityType: "founder",
        entityId: "founder-heyclicky-farza-majeed-manual-farza-majeed",
        companyName: "HeyClicky",
        title: "Today we're shipping screen-aware dictation. Now dictate using your screen as context.",
        sourceUrl: "https://x.com/FarzaTV/status/2077130366230639022",
        postedAt: "2026-07-14T20:37:25.000Z",
        metrics: expect.objectContaining({
          views: 2687075,
          likes: 10602,
          replies: 544,
          reposts: 465
        })
      });
      expect(result.failureReasonCounts.direct_x_url_not_batch_target).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("dedupes a live X post found by both profile scanning and a direct status URL", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-dedupe-accepted-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://x.com/screenpipe") {
        return new Response('<a href="https://x.com/screenpipe/status/2077045452579778664">post</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://api.fxtwitter.com/screenpipe/status/2077045452579778664") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/screenpipe/status/2077045452579778664",
            id: "2077045452579778664",
            text: "introducing screenpipe: searchable work memory and AI agents",
            created_timestamp: 1784041200,
            replies: 74,
            retweets: 104,
            likes: 697,
            views: 116000,
            author: {
              screen_name: "screenpipe",
              name: "screenpipe (YC S26)",
              url: "https://x.com/screenpipe"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        xTargetHandles: ["screenpipe"],
        xSourceUrls: ["https://x.com/screenpipe/status/2077045452579778664"],
        xConcurrency: 1,
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:06:30.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.storedEvidence).toHaveLength(1);
      expect(result.platformRows.x).toBe(1);
      expect(result.failureReasonCounts.duplicate_accepted_live_evidence).toBe(1);
      const stored = JSON.parse(await readFile(targetedEvidencePath, "utf8"));
      expect(stored.evidence).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("aborts an in-flight profile body read when the run deadline expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T20:00:00.000Z"));
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-deadline-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const snapshotContent = JSON.stringify({
      source: { fetchedAt: "2026-07-14T00:00:00.000Z" },
      evidence: [],
      needsReview: []
    });
    const stageLogContent = "existing-stage-log";
    await writeFile(targetedEvidencePath, snapshotContent);
    await writeFile(stageLogPath, stageLogContent);

    let markBodyReadStarted: () => void = () => {};
    const bodyReadStarted = new Promise<void>((resolve) => {
      markBodyReadStarted = resolve;
    });
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: () => {
        markBodyReadStarted();
        return new Promise<string>(() => {});
      }
    }) as Response) as typeof fetch;

    try {
      const refresh = runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        xTargetHandles: ["screenpipe"],
        xConcurrency: 1,
        xRequestTimeoutMs: 1_000,
        deadlineAt: new Date(Date.now() + 50),
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-16T20:00:00.000Z"),
        fetchImpl
      });

      await bodyReadStarted;
      await vi.advanceTimersByTimeAsync(50);
      const result = await refresh;

      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.cancellationReason).toBe("refresh_deadline_exceeded");
      expect(result.networkRequests).toBe(1);
      expect(result.networkRequestBudget).toBeNull();
      expect(result.networkRequestBudgetExhausted).toBe(false);
      expect(await readFile(targetedEvidencePath, "utf8")).toBe(snapshotContent);
      expect(await readFile(stageLogPath, "utf8")).toBe(stageLogContent);
    } finally {
      vi.useRealTimers();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("interrupts a pending response JSON body read when the parent signal aborts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-abort-body-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const controller = new AbortController();
    const requestSignals: AbortSignal[] = [];
    let markBodyReadStarted: () => void = () => {};
    const bodyReadStarted = new Promise<void>((resolve) => {
      markBodyReadStarted = resolve;
    });
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) {
        requestSignals.push(init.signal);
      }
      return {
        ok: true,
        status: 200,
        json: () => {
          markBodyReadStarted();
          return new Promise<unknown>(() => {});
        }
      } as Response;
    }) as typeof fetch;

    try {
      const refresh = runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        maxXTargets: 0,
        xSourceUrls: ["https://x.com/screenpipe/status/2077045452579778664"],
        xRequestTimeoutMs: 10_000,
        signal: controller.signal,
        write: false,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-16T20:01:00.000Z"),
        fetchImpl
      });

      await bodyReadStarted;
      controller.abort(new Error("caller cancelled"));
      const result = await refresh;

      expect(requestSignals[0]?.aborted).toBe(true);
      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.cancellationReason).toBe("refresh_cancelled");
      expect(result.networkRequests).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("caps run-wide network requests and bounds direct URL concurrency", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-request-cap-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const postIds = [
      "2077045452579778701",
      "2077045452579778702",
      "2077045452579778703",
      "2077045452579778704"
    ];
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchedUrls: string[] = [];
    let activeRequests = 0;
    let peakActiveRequests = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      activeRequests += 1;
      peakActiveRequests = Math.max(peakActiveRequests, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      const postId = url.match(/\/status\/(\d+)$/)?.[1] ?? "";
      return Response.json({
        code: 200,
        tweet: {
          url: `https://x.com/screenpipe/status/${postId}`,
          id: postId,
          text: `screenpipe request budget update ${postId}`,
          created_timestamp: 1784041200,
          replies: 2,
          retweets: 3,
          likes: 20,
          views: 500,
          author: {
            screen_name: "screenpipe",
            name: "screenpipe (YC S26)",
            url: "https://x.com/screenpipe"
          }
        }
      });
    }) as typeof fetch;

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        maxXTargets: 0,
        xSourceUrls: postIds.map((postId) => `https://x.com/screenpipe/status/${postId}`),
        xConcurrency: 2,
        xRequestTimeoutMs: 500,
        maxNetworkRequests: 3,
        write: false,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-16T20:02:00.000Z"),
        fetchImpl
      });

      expect(fetchedUrls).toHaveLength(3);
      expect(peakActiveRequests).toBe(2);
      expect(result.acceptedEvidence).toHaveLength(3);
      expect(result.failureReasonCounts.network_request_budget_exhausted).toBe(1);
      expect(result).toMatchObject({
        cancellationReason: null,
        networkRequests: 3,
        networkRequestBudget: 3,
        networkRequestBudgetExhausted: true
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("spends a constrained network budget on explicit direct X URLs before profiles", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-direct-priority-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const postId = "2077045452579778710";
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchedUrls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url === `https://api.fxtwitter.com/screenpipe/status/${postId}`) {
        return Response.json({
          code: 200,
          tweet: {
            url: `https://x.com/screenpipe/status/${postId}`,
            id: postId,
            text: "screenpipe direct source priority update",
            created_timestamp: 1784041200,
            replies: 4,
            retweets: 5,
            likes: 40,
            views: 900,
            author: {
              screen_name: "screenpipe",
              name: "screenpipe (YC S26)",
              url: "https://x.com/screenpipe"
            }
          }
        });
      }
      return new Response("profile should not be fetched", { status: 500 });
    }) as typeof fetch;

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        xTargetHandles: ["screenpipe"],
        xSourceUrls: [`https://x.com/screenpipe/status/${postId}`],
        xConcurrency: 4,
        xRequestTimeoutMs: 500,
        maxNetworkRequests: 1,
        write: false,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-16T20:03:00.000Z"),
        fetchImpl
      });

      expect(fetchedUrls).toEqual([`https://api.fxtwitter.com/screenpipe/status/${postId}`]);
      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.acceptedEvidence[0]?.rawVisibleText).toContain('"directSource":true');
      expect(result).toMatchObject({
        cancellationReason: null,
        networkRequests: 1,
        networkRequestBudget: 1,
        networkRequestBudgetExhausted: true
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not write evidence or stage logs after parent cancellation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-no-write-after-abort-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const snapshotContent = JSON.stringify({
      source: { fetchedAt: "2026-07-14T00:00:00.000Z" },
      evidence: [],
      needsReview: []
    });
    const stageLogContent = "existing-stage-log";
    await writeFile(targetedEvidencePath, snapshotContent);
    await writeFile(stageLogPath, stageLogContent);

    const controller = new AbortController();
    let markRequestStarted: () => void = () => {};
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const fetchImpl = (async () => {
      markRequestStarted();
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    try {
      const refresh = runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        maxXTargets: 0,
        xSourceUrls: ["https://x.com/screenpipe/status/2077045452579778720"],
        xRequestTimeoutMs: 10_000,
        signal: controller.signal,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-16T20:04:00.000Z"),
        fetchImpl
      });

      await requestStarted;
      controller.abort(new Error("client disconnected"));
      const result = await refresh;

      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.storedEvidence).toHaveLength(0);
      expect(result.cancellationReason).toBe("refresh_cancelled");
      expect(result.networkRequests).toBe(1);
      expect(await readFile(targetedEvidencePath, "utf8")).toBe(snapshotContent);
      expect(await readFile(stageLogPath, "utf8")).toBe(stageLogContent);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies TikTok and Bluesky as requested adapters that are not wired", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-forward-platforms-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        platforms: ["tiktok", "bluesky"],
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-16T20:05:00.000Z")
      });

      expect(result.failureReasonCounts.adapter_not_wired).toBe(2);
      expect(
        result.stageLog
          .filter((entry) => entry.reason === "adapter_not_wired")
          .map((entry) => [entry.platform, entry.stage])
      ).toEqual([
        ["tiktok", "skipped"],
        ["bluesky", "skipped"]
      ]);
      expect(result).toMatchObject({
        cancellationReason: null,
        networkRequests: 0,
        networkRequestBudget: null,
        networkRequestBudgetExhausted: false
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers and stores A16Z company X posts from the social-account snapshot", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-a16z-company-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://x.com/amdahl_ai") {
        return new Response('<a href="https://x.com/amdahl_ai/status/2078000000000000001">post</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://api.fxtwitter.com/amdahl_ai/status/2078000000000000001") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/amdahl_ai/status/2078000000000000001",
            id: "2078000000000000001",
            text: "Amdahl a16z Speedrun launch update with live customer pilots.",
            created_timestamp: 1784046600,
            replies: 17,
            retweets: 22,
            likes: 186,
            views: 48000,
            author: {
              screen_name: "amdahl_ai",
              name: "Amdahl",
              url: "https://x.com/amdahl_ai"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "A16ZSR006",
        platforms: ["x"],
        xTargetHandles: ["amdahl_ai"],
        xConcurrency: 1,
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:07:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.acceptedEvidence[0]).toMatchObject({
        entityType: "company",
        entityId: "a16z-speedrun-006-amdahl",
        companyName: "Amdahl",
        platform: "x",
        sourceUrl: "https://x.com/amdahl_ai/status/2078000000000000001",
        platformPostId: "2078000000000000001",
        metrics: expect.objectContaining({
          views: 48000,
          likes: 186,
          replies: 17,
          reposts: 22
        }),
        review_state: "verified"
      });
      expect(result.failureReasonCounts.direct_x_url_not_batch_target).toBeUndefined();
      expect(result.stageLog.some((entry) => entry.stage === "accepted" && entry.entityId === "a16z-speedrun-006-amdahl")).toBe(
        true
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers A16Z founder X posts only when the native post mentions their company", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-a16z-founder-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://x.com/chinmaychauhan") {
        return new Response('<a href="https://x.com/chinmaychauhan/status/2078000000000000002">post</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://api.fxtwitter.com/chinmaychauhan/status/2078000000000000002") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/chinmaychauhan/status/2078000000000000002",
            id: "2078000000000000002",
            text: "Acceler8 a16z Speedrun demo day update from the founder account.",
            created_timestamp: 1784046900,
            replies: 24,
            retweets: 35,
            likes: 244,
            views: 52000,
            author: {
              screen_name: "chinmaychauhan",
              name: "Chinmay Chauhan",
              url: "https://x.com/chinmaychauhan"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "A16ZSR006",
        platforms: ["x"],
        xTargetHandles: ["chinmaychauhan"],
        xConcurrency: 1,
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:08:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.acceptedEvidence[0]).toMatchObject({
        entityType: "founder",
        entityId: "a16z-speedrun-006-acceler8-founder-chinmay-chauhan",
        companyName: "Acceler8",
        platform: "x",
        sourceUrl: "https://x.com/chinmaychauhan/status/2078000000000000002",
        platformPostId: "2078000000000000002",
        metrics: expect.objectContaining({
          views: 52000,
          likes: 244,
          replies: 24,
          reposts: 35
        }),
        review_state: "verified"
      });
      expect(result.failureReasonCounts.founder_post_missing_company_mention).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("attributes A16Z company X posts only to verified account records", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-a16z-company-trust-"));
    const socialDir = join(tempDir, "src", "lib", "social");
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const postId = "2078000000000000101";
    const fetchedUrls: string[] = [];
    await mkdir(socialDir, { recursive: true });
    await writeFile(
      join(socialDir, "a16z-speedrun-006-social-accounts.json"),
      JSON.stringify({
        companies: [
          {
            companyName: "Company Trust",
            companySlug: "company-trust",
            accounts: [
              {
                platform: "x",
                url: "https://x.com/company_needs_review",
                handle: "company_needs_review",
                review_state: "needs_review"
              },
              {
                platform: "x",
                url: "https://x.com/company_rejected",
                handle: "company_rejected",
                review_state: "rejected"
              },
              {
                platform: "x",
                url: "https://x.com/company_verified",
                handle: "company_verified",
                review_state: "verified"
              }
            ],
            founders: []
          },
          {
            companyName: "Untrusted Company",
            companySlug: "untrusted-company",
            accounts: [
              {
                platform: "x",
                url: "https://x.com/untrusted_company_review",
                handle: "untrusted_company_review",
                review_state: "needs_review"
              },
              {
                platform: "x",
                url: "https://x.com/untrusted_company_rejected",
                handle: "untrusted_company_rejected",
                review_state: "rejected"
              }
            ],
            founders: []
          }
        ]
      })
    );
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url === `https://api.fxtwitter.com/company_verified/status/${postId}`) {
        return Response.json({
          code: 200,
          tweet: {
            url: `https://x.com/company_verified/status/${postId}`,
            id: postId,
            text: "Company Trust launch update from the verified company account.",
            created_timestamp: 1784047200,
            replies: 8,
            retweets: 12,
            likes: 90,
            views: 14000,
            author: {
              screen_name: "company_verified",
              name: "Company Trust",
              url: "https://x.com/company_verified"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: tempDir,
        batchSlug: "A16ZSR006",
        platforms: ["x"],
        maxXTargets: 0,
        xSourceUrls: [
          `https://x.com/company_needs_review/status/${postId}`,
          `https://x.com/company_rejected/status/${postId}`,
          `https://x.com/company_verified/status/${postId}`,
          `https://x.com/untrusted_company_review/status/${postId}`,
          `https://x.com/untrusted_company_rejected/status/${postId}`
        ],
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-16T18:10:00.000Z"),
        fetchImpl
      });

      expect(fetchedUrls).toEqual([`https://api.fxtwitter.com/company_verified/status/${postId}`]);
      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.acceptedEvidence[0]).toMatchObject({
        entityType: "company",
        entityId: "a16z-speedrun-006-company-trust",
        sourceUrl: `https://x.com/company_verified/status/${postId}`
      });
      expect(result.failureReasonCounts.direct_x_url_not_batch_target).toBe(4);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("attributes A16Z founder X posts only to verified account records", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-a16z-founder-trust-"));
    const socialDir = join(tempDir, "src", "lib", "social");
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const postId = "2078000000000000102";
    const fetchedUrls: string[] = [];
    await mkdir(socialDir, { recursive: true });
    await writeFile(
      join(socialDir, "a16z-speedrun-006-social-accounts.json"),
      JSON.stringify({
        companies: [
          {
            companyName: "Founder Trust",
            companySlug: "founder-trust",
            accounts: [],
            founders: [
              {
                name: "Verified Founder",
                founderSlug: "verified-founder",
                accounts: [
                  {
                    platform: "x",
                    url: "https://x.com/founder_needs_review",
                    handle: "founder_needs_review",
                    review_state: "needs_review"
                  },
                  {
                    platform: "x",
                    url: "https://x.com/founder_rejected",
                    handle: "founder_rejected",
                    review_state: "rejected"
                  },
                  {
                    platform: "x",
                    url: "https://x.com/founder_verified",
                    handle: "founder_verified",
                    review_state: "verified"
                  }
                ]
              },
              {
                name: "Untrusted Founder",
                founderSlug: "untrusted-founder",
                accounts: [
                  {
                    platform: "x",
                    url: "https://x.com/untrusted_founder_review",
                    handle: "untrusted_founder_review",
                    review_state: "needs_review"
                  },
                  {
                    platform: "x",
                    url: "https://x.com/untrusted_founder_rejected",
                    handle: "untrusted_founder_rejected",
                    review_state: "rejected"
                  }
                ]
              }
            ]
          }
        ]
      })
    );
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url === `https://api.fxtwitter.com/founder_verified/status/${postId}`) {
        return Response.json({
          code: 200,
          tweet: {
            url: `https://x.com/founder_verified/status/${postId}`,
            id: postId,
            text: "Founder Trust launch update from the verified founder account.",
            created_timestamp: 1784047500,
            replies: 6,
            retweets: 9,
            likes: 75,
            views: 11000,
            author: {
              screen_name: "founder_verified",
              name: "Verified Founder",
              url: "https://x.com/founder_verified"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: tempDir,
        batchSlug: "A16ZSR006",
        platforms: ["x"],
        maxXTargets: 0,
        xSourceUrls: [
          `https://x.com/founder_needs_review/status/${postId}`,
          `https://x.com/founder_rejected/status/${postId}`,
          `https://x.com/founder_verified/status/${postId}`,
          `https://x.com/untrusted_founder_review/status/${postId}`,
          `https://x.com/untrusted_founder_rejected/status/${postId}`
        ],
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-16T18:15:00.000Z"),
        fetchImpl
      });

      expect(fetchedUrls).toEqual([`https://api.fxtwitter.com/founder_verified/status/${postId}`]);
      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.acceptedEvidence[0]).toMatchObject({
        entityType: "founder",
        entityId: "a16z-speedrun-006-founder-trust-founder-verified-founder",
        sourceUrl: `https://x.com/founder_verified/status/${postId}`
      });
      expect(result.failureReasonCounts.direct_x_url_not_batch_target).toBe(4);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not treat a founder profile bio as a company mention in an unrelated X post", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-founder-bio-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://x.com/chinmaychauhan") {
        return new Response('<a href="https://x.com/chinmaychauhan/status/2078000000000000003">post</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://api.fxtwitter.com/chinmaychauhan/status/2078000000000000003") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/chinmaychauhan/status/2078000000000000003",
            id: "2078000000000000003",
            text: "A great weekend at the tennis final.",
            created_timestamp: 1784047200,
            replies: 11,
            retweets: 8,
            likes: 97,
            views: 12000,
            author: {
              screen_name: "chinmaychauhan",
              name: "Chinmay Chauhan",
              description: "Founder and CEO at Acceler8",
              url: "https://x.com/chinmaychauhan"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "A16ZSR006",
        platforms: ["x"],
        xTargetHandles: ["chinmaychauhan"],
        xConcurrency: 1,
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:09:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.failureReasonCounts.founder_post_missing_company_mention).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects direct X status URLs embedded inside non-X hosts before fetching post JSON", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-direct-x-invalid-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const fetchedUrls: string[] = [];
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input));
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        maxXTargets: 0,
        xRequestTimeoutMs: 500,
        xSourceUrls: [
          "https://example.com/https://x.com/screenpipe/status/2077045452579778664",
          "https://x.com.evil.test/screenpipe/status/2077045452579778664",
          "https://x.com/i/status/2077045452579778664"
        ],
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:06:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.failureReasonCounts.invalid_direct_x_url).toBe(3);
      expect(fetchedUrls).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scopes a single-batch refresh to that batch instead of scanning every default YC batch", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-scope-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const fetchedProfiles: string[] = [];
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://x.com/")) {
        fetchedProfiles.push(url);
        return new Response("<html>No public status ids here</html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        xTargetHandles: ["screenpipe", "insforge"],
        xConcurrency: 1,
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:00:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toEqual([]);
      expect(fetchedProfiles).toContain("https://x.com/screenpipe");
      expect(fetchedProfiles).not.toContain("https://x.com/insforge");
      expect(result.stageLog.some((entry) => entry.reason === "target_cap")).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers top-voice X posts and attributes them only when they mention a selected-batch company", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-top-voice-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://x.com/sama") {
        return new Response('<a href="https://x.com/sama/status/2077000000000000001">post</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://api.fxtwitter.com/sama/status/2077000000000000001") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/sama/status/2077000000000000001",
            id: "2077000000000000001",
            text: "screenpipe is making local-first AI agents more useful.",
            created_timestamp: 1784043000,
            replies: 90,
            retweets: 120,
            likes: 900,
            views: 150000,
            author: {
              screen_name: "sama",
              name: "Sam Altman",
              url: "https://x.com/sama"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        topVoices: "insiders",
        xTargetHandles: ["sama"],
        xConcurrency: 1,
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:10:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.acceptedEvidence[0]).toMatchObject({
        entityId: "company-screenpipe",
        companyName: "screenpipe",
        platform: "x",
        sourceUrl: "https://x.com/sama/status/2077000000000000001",
        platformPostId: "2077000000000000001",
        matchReason: expect.stringContaining("top voice Sam Altman")
      });
      expect(result.stageLog.some((entry) => entry.stage === "accepted" && entry.target === "sama")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not attribute generic words in insider posts to same-named companies", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-top-voice-generic-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.fxtwitter.com/rowghani/status/1933171248567394371") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/rowghani/status/1933171248567394371",
            id: "1933171248567394371",
            text: "We invest in early-stage companies and help founders with go-to-market.",
            created_timestamp: 1749738916,
            replies: 65,
            retweets: 30,
            likes: 433,
            views: 73192,
            author: {
              screen_name: "rowghani",
              name: "Ali Rowghani",
              url: "https://x.com/rowghani"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S2026",
        platforms: ["x"],
        topVoices: "insiders",
        maxTopVoiceXTargets: 0,
        xRequestTimeoutMs: 500,
        xSourceUrls: ["https://x.com/rowghani/status/1933171248567394371"],
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:20:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.stageLog.some((entry) => entry.reason === "top_voice_post_missing_company_mention")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ingests an explicit top-voice X status URL when it is native and mentions a selected-batch company", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-direct-top-voice-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.fxtwitter.com/sama/status/2077000000000000001") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/sama/status/2077000000000000001",
            id: "2077000000000000001",
            text: "screenpipe is making local-first AI agents more useful.",
            created_timestamp: 1784043000,
            replies: 90,
            retweets: 120,
            likes: 900,
            views: 150000,
            author: {
              screen_name: "sama",
              name: "Sam Altman",
              url: "https://x.com/sama"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        topVoices: "insiders",
        maxTopVoiceXTargets: 0,
        xRequestTimeoutMs: 500,
        xSourceUrls: ["https://x.com/sama/status/2077000000000000001"],
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:15:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.acceptedEvidence[0]).toMatchObject({
        entityId: "company-screenpipe",
        companyName: "screenpipe",
        platform: "x",
        sourceUrl: "https://x.com/sama/status/2077000000000000001",
        matchReason: expect.stringContaining("top voice Sam Altman")
      });
      expect(result.stageLog.some((entry) => entry.message.includes("Accepted direct top-voice X post"))).toBe(true);
      expect(result.stageLog.some((entry) => entry.sourceUrl === "https://x.com/sama")).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects top-voice X reposts even when they mention a selected-batch company", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-top-voice-repost-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://x.com/sama") {
        return new Response('<a href="https://x.com/sama/status/2077000000000000777">post</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://api.fxtwitter.com/sama/status/2077000000000000777") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/sama/status/2077000000000000777",
            id: "2077000000000000777",
            text: "RT @screenpipe: introducing screenpipe",
            is_retweet: true,
            retweeted_status: {
              id: "2077000000000000666",
              author: { screen_name: "screenpipe" }
            },
            created_timestamp: 1784043000,
            replies: 90,
            retweets: 120,
            likes: 900,
            views: 150000,
            author: {
              screen_name: "sama",
              name: "Sam Altman",
              url: "https://x.com/sama"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        topVoices: "insiders",
        xTargetHandles: ["sama"],
        xConcurrency: 1,
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:18:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.failureReasonCounts.non_native_x_repost).toBe(1);
      expect(result.stageLog.some((entry) => entry.reason === "non_native_x_repost")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("short-circuits repeated top-voice X scans that recently found no selected-batch company mention", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-top-voice-cache-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const fetchedUrls: string[] = [];
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url === "https://x.com/pmarca") {
        return new Response('<a href="https://x.com/pmarca/status/2077000000000000999">post</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://api.fxtwitter.com/pmarca/status/2077000000000000999") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/pmarca/status/2077000000000000999",
            id: "2077000000000000999",
            text: "a general market observation without selected batch company names",
            created_timestamp: 1784043000,
            replies: 90,
            retweets: 120,
            likes: 900,
            views: 150000,
            author: {
              screen_name: "pmarca",
              name: "Marc Andreessen",
              url: "https://x.com/pmarca"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const baseOptions = {
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x" as const],
        topVoices: "insiders" as const,
        xTargetHandles: ["pmarca"],
        xConcurrency: 1,
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        fetchImpl
      };
      const first = await runLiveSourceRefresh({
        ...baseOptions,
        now: new Date("2026-07-14T17:30:00.000Z")
      });
      const fetchesAfterFirstRun = fetchedUrls.length;
      const second = await runLiveSourceRefresh({
        ...baseOptions,
        now: new Date("2026-07-14T17:31:00.000Z")
      });

      expect(first.acceptedEvidence).toHaveLength(0);
      expect(first.failureReasonCounts.top_voice_post_missing_company_mention).toBe(1);
      expect(second.acceptedEvidence).toHaveLength(0);
      expect(second.failureReasonCounts.top_voice_recent_no_match).toBe(1);
      expect(fetchedUrls).toHaveLength(fetchesAfterFirstRun);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects top-voice company matches that only appear as substrings inside unrelated words", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-top-voice-substring-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://x.com/levie") {
        return new Response('<a href="https://x.com/levie/status/1800224021193396594">post</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://api.fxtwitter.com/levie/status/1800224021193396594") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/levie/status/1800224021193396594",
            id: "1800224021193396594",
            text: "iPad calculator is actually pretty nuts",
            created_timestamp: 1718041827,
            replies: 283,
            retweets: 2094,
            likes: 21164,
            views: 4016554,
            bookmarks: 3851,
            author: {
              screen_name: "levie",
              name: "Aaron Levie",
              url: "https://x.com/levie"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        topVoices: "insiders",
        xTargetHandles: ["levie"],
        xConcurrency: 1,
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:20:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.failureReasonCounts.top_voice_post_missing_company_mention).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects top-voice X matches that only appear in the author identity or URL", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-top-voice-author-only-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://x.com/mwseibel") {
        return new Response('<a href="https://x.com/mwseibel/status/2077000000000000123">post</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "https://api.fxtwitter.com/mwseibel/status/2077000000000000123") {
        return Response.json({
          code: 200,
          tweet: {
            url: "https://x.com/mwseibel/status/2077000000000000123",
            id: "2077000000000000123",
            text: "strong launch day energy from the new YC batch",
            created_timestamp: 1784043000,
            replies: 90,
            retweets: 120,
            likes: 900,
            views: 150000,
            author: {
              screen_name: "mwseibel",
              name: "screenpipe fan",
              url: "https://x.com/mwseibel"
            }
          }
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        topVoices: "insiders",
        xTargetHandles: ["mwseibel"],
        xConcurrency: 1,
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-14T17:22:00.000Z"),
        fetchImpl
      });

      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.failureReasonCounts.top_voice_post_missing_company_mention).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["malformed JSON", '{"source":{"fetchedAt":"2026-07-14T00:00:00.000Z"},"evidence":['],
    [
      "an invalid evidence shape",
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: {}, needsReview: [] })
    ]
  ])("refuses to replace a snapshot containing %s", async (_label, snapshotContent) => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-corrupt-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    await writeFile(targetedEvidencePath, snapshotContent);

    try {
      await expect(
        runLiveSourceRefresh({
          rootDir: process.cwd(),
          platforms: ["github"],
          targetedEvidencePath,
          stageLogPath,
          now: new Date("2026-07-16T18:00:00.000Z")
        })
      ).rejects.toThrow(/Refusing to replace (?:corrupt|invalid) evidence snapshot/);
      expect(await readFile(targetedEvidencePath, "utf8")).toBe(snapshotContent);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent refresh writes so neither accepted observation is lost", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-concurrent-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const postIds = ["2077045452579778664", "2077045452579778665"];
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    let arrivals = 0;
    let releaseFetches: () => void = () => {};
    const bothFetchesReady = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const match = String(input).match(/api\.fxtwitter\.com\/screenpipe\/status\/(\d+)/);
      if (!match?.[1]) {
        return new Response("not found", { status: 404 });
      }
      arrivals += 1;
      if (arrivals === postIds.length) {
        releaseFetches();
      }
      await bothFetchesReady;
      const postId = match[1];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tweet: {
            url: `https://x.com/screenpipe/status/${postId}`,
            id: postId,
            text: `screenpipe concurrent observation ${postId}`,
            created_timestamp: 1784041200,
            replies: 4,
            retweets: 2,
            likes: 20,
            views: postId.endsWith("4") ? 400 : 500,
            author: { screen_name: "screenpipe", name: "screenpipe", url: "https://x.com/screenpipe" }
          }
        })
      } as Response;
    }) as typeof fetch;

    try {
      await Promise.all(
        postIds.map((postId, index) =>
          runLiveSourceRefresh({
            rootDir: process.cwd(),
            batchSlug: "S26",
            platforms: ["x"],
            maxXTargets: 0,
            xSourceUrls: [`https://x.com/screenpipe/status/${postId}`],
            xRequestTimeoutMs: 500,
            targetedEvidencePath,
            stageLogPath: join(tempDir, `stage-log-${index}.json`),
            now: new Date(`2026-07-16T18:0${index}:00.000Z`),
            fetchImpl
          })
        )
      );

      const stored = JSON.parse(await readFile(targetedEvidencePath, "utf8"));
      expect(stored.evidence.map((record: LiveEvidenceRecord) => record.platformPostId).sort()).toEqual(postIds);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses explicit fallback freshness and only replaces a canonical observation when newer", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-freshness-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const postId = "2077045452579778664";
    const firstSeenAt = "2026-07-10T12:00:00.000Z";
    const existing = liveXRecord({
      linkCheckedAt: "2026-07-18T12:00:00.000Z",
      last_checked_at: undefined,
      last_updated_at: undefined,
      first_seen_at: firstSeenAt,
      metrics: { views: 900, likes: 90, replies: 9, reposts: 3 }
    });
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [existing], needsReview: [] })
    );

    const refresh = (now: string, views: number) =>
      runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        maxXTargets: 0,
        xSourceUrls: [`https://x.com/screenpipe/status/${postId}`],
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date(now),
        fetchImpl: screenpipeFxFetch(postId, { views, likes: 12, replies: 2, retweets: 1 })
      });

    try {
      await refresh("2026-07-17T12:00:00.000Z", 700);
      const afterStaleRefresh = JSON.parse(await readFile(targetedEvidencePath, "utf8"));
      expect(afterStaleRefresh.evidence[0].metrics.views).toBe(900);
      expect(afterStaleRefresh.evidence[0].linkCheckedAt).toBe("2026-07-18T12:00:00.000Z");

      await refresh("2026-07-19T12:00:00.000Z", 1200);
      const afterFreshRefresh = JSON.parse(await readFile(targetedEvidencePath, "utf8"));
      expect(afterFreshRefresh.evidence[0].metrics.views).toBe(1200);
      expect(afterFreshRefresh.evidence[0].last_checked_at).toBe("2026-07-19T12:00:00.000Z");
      expect(afterFreshRefresh.evidence[0].first_seen_at).toBe(firstSeenAt);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("collapses X comment/reply and share/repost aliases into one canonical metric each", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-aliases-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const postId = "2077045452579778664";
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
    );

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        maxXTargets: 0,
        xSourceUrls: [`https://x.com/screenpipe/status/${postId}`],
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-16T18:30:00.000Z"),
        fetchImpl: screenpipeFxFetch(postId, {
          views: 1000,
          likes: 40,
          comments: 7,
          replies: 5,
          shares: 3,
          reposts: 4,
          retweets: 2
        })
      });

      expect(result.acceptedEvidence).toHaveLength(1);
      expect(result.acceptedEvidence[0]?.metrics).toEqual({ views: 1000, likes: 40, replies: 7, reposts: 4 });
      expect(result.acceptedEvidence[0]?.metrics).not.toHaveProperty("comments");
      expect(result.acceptedEvidence[0]?.metrics).not.toHaveProperty("shares");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["negative", -1],
    ["nonfinite", Number.POSITIVE_INFINITY]
  ])("rejects %s X visible metrics and preserves existing evidence", async (_label, invalidLikes) => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-invalid-metrics-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const stageLogPath = join(tempDir, "stage-log.json");
    const postId = "2077045452579778664";
    const existing = liveXRecord({ metrics: { views: 777, likes: 70, replies: 7, reposts: 3 } });
    await writeFile(
      targetedEvidencePath,
      JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [existing], needsReview: [] })
    );

    try {
      const result = await runLiveSourceRefresh({
        rootDir: process.cwd(),
        batchSlug: "S26",
        platforms: ["x"],
        maxXTargets: 0,
        xSourceUrls: [`https://x.com/screenpipe/status/${postId}`],
        xRequestTimeoutMs: 500,
        targetedEvidencePath,
        stageLogPath,
        now: new Date("2026-07-16T19:00:00.000Z"),
        fetchImpl: screenpipeFxFetch(postId, { views: 1000, likes: invalidLikes, replies: 2, retweets: 1 })
      });

      expect(result.acceptedEvidence).toHaveLength(0);
      expect(result.failureReasonCounts.invalid_visible_metrics).toBe(1);
      const stored = JSON.parse(await readFile(targetedEvidencePath, "utf8"));
      expect(stored.evidence).toHaveLength(1);
      expect(stored.evidence[0].metrics.views).toBe(777);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("revalidates persisted live X rows before they can reload into the graph", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-load-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const good = liveXRecord();
    const invalidLink = liveXRecord({
      id: "live-x-invalid-link",
      linkStatus: "invalid",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778665",
      platformPostId: "2077045452579778665",
      rawVisibleText: liveRawText({
        id: "2077045452579778665",
        source: "live_x_profile",
        handle: "screenpipe",
        text: "screenpipe update with metrics"
      })
    });
    const spoofedHost = liveXRecord({
      id: "live-x-spoofed-host",
      sourceUrl: "https://x.com.evil.test/screenpipe/status/2077045452579778666",
      platformPostId: "2077045452579778666",
      rawVisibleText: liveRawText({
        id: "2077045452579778666",
        source: "live_x_profile",
        handle: "screenpipe",
        text: "screenpipe update with metrics"
      })
    });
    const authorMismatch = liveXRecord({
      id: "live-x-author-mismatch",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778667",
      platformPostId: "2077045452579778667",
      rawVisibleText: liveRawText({
        id: "2077045452579778667",
        source: "live_x_profile",
        handle: "not-screenpipe",
        text: "screenpipe update with metrics"
      })
    });
    const repost = liveXRecord({
      id: "live-x-repost",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778668",
      platformPostId: "2077045452579778668",
      rawVisibleText: liveRawText({
        id: "2077045452579778668",
        source: "live_x_profile",
        handle: "screenpipe",
        text: "RT @someone: screenpipe update",
        extraPost: { is_retweet: true, retweeted_status: { id: "2077045452579778660" } }
      })
    });
    const negativeMetrics = liveXRecord({
      id: "live-x-negative-metrics",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778669",
      platformPostId: "2077045452579778669",
      metrics: { views: 100, likes: -1 },
      rawVisibleText: liveRawText({
        id: "2077045452579778669",
        source: "live_x_profile",
        handle: "screenpipe",
        text: "screenpipe update with invalid metrics"
      })
    });
    const nonfiniteMetrics = liveXRecord({
      id: "live-x-nonfinite-metrics",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778670",
      platformPostId: "2077045452579778670",
      metrics: { views: 100, likes: "Infinity" as unknown as number },
      rawVisibleText: liveRawText({
        id: "2077045452579778670",
        source: "live_x_profile",
        handle: "screenpipe",
        text: "screenpipe update with invalid metrics"
      })
    });

    await writeFile(
      targetedEvidencePath,
      JSON.stringify({
        source: { fetchedAt: "2026-07-14T00:00:00.000Z" },
        evidence: [invalidLink, spoofedHost, authorMismatch, repost, negativeMetrics, nonfiniteMetrics, good],
        needsReview: []
      })
    );

    try {
      const rows = await loadLiveEvidenceRecords(process.cwd(), { targetedEvidencePath });

      expect(rows.map((row) => row.id)).toEqual([good.id]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("drops persisted top-voice live rows unless the native post text still mentions the company", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-load-top-voice-"));
    const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
    const good = liveXRecord({
      id: "live-x-top-voice-good",
      entityType: "company",
      entityId: "company-screenpipe",
      companyName: "screenpipe",
      sourceUrl: "https://x.com/sama/status/2077045452579778671",
      platformPostId: "2077045452579778671",
      matchReason: "Live manual refresh verified a native X post from top voice Sam Altman (@sama) mentioning screenpipe.",
      rawVisibleText: liveRawText({
        id: "2077045452579778671",
        source: "live_x_top_voice_profile",
        handle: "sama",
        text: "screenpipe is a useful local-first AI agent memory layer",
        topVoiceMemberId: "sam-altman"
      })
    });
    const authorOnly = liveXRecord({
      id: "live-x-top-voice-author-only",
      entityType: "company",
      entityId: "company-screenpipe",
      companyName: "screenpipe",
      sourceUrl: "https://x.com/sama/status/2077045452579778672",
      platformPostId: "2077045452579778672",
      matchReason: "Live manual refresh verified a native X post from top voice Sam Altman (@sama) mentioning screenpipe.",
      rawVisibleText: liveRawText({
        id: "2077045452579778672",
        source: "live_x_top_voice_profile",
        handle: "sama",
        text: "strong launch day energy from the new YC batch",
        authorName: "screenpipe fan",
        topVoiceMemberId: "sam-altman"
      })
    });

    await writeFile(
      targetedEvidencePath,
      JSON.stringify({
        source: { fetchedAt: "2026-07-14T00:00:00.000Z" },
        evidence: [authorOnly, good],
        needsReview: []
      })
    );

    try {
      const rows = await loadLiveEvidenceRecords(process.cwd(), { targetedEvidencePath });

      expect(rows.map((row) => row.id)).toEqual([good.id]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function liveXRecord(overrides: Partial<LiveEvidenceRecord> = {}): LiveEvidenceRecord {
  const id = overrides.platformPostId ?? "2077045452579778664";
  const rawVisibleText =
    overrides.rawVisibleText ??
    liveRawText({
      id,
      source: "live_x_profile",
      handle: "screenpipe",
      text: "screenpipe records and learns how you work"
    });

  return {
    id: `live-x-company-screenpipe-${id}`,
    entityType: "company",
    entityId: "company-screenpipe",
    companyName: "screenpipe",
    platform: "x",
    title: "screenpipe records and learns how you work",
    sourceUrl: `https://x.com/screenpipe/status/${id}`,
    platformPostId: id,
    text: "screenpipe records and learns how you work",
    thumbnailUrl: null,
    thumbnailSource: null,
    mediaUrl: null,
    mediaUrls: [],
    media_urls: [],
    media_posters: [],
    linkStatus: "verified",
    linkCheckedAt: "2026-07-14T17:00:00.000Z",
    rawVisibleText,
    postedAt: "2026-07-14T16:00:00.000Z",
    metrics: {
      views: 116000,
      likes: 697,
      comments: 74,
      replies: 74,
      reposts: 104
    },
    contributionScore: 97,
    review_state: "verified",
    matchReason: "Live manual refresh verified a native X post from official @screenpipe for screenpipe.",
    first_seen_at: "2026-07-14T17:00:00.000Z",
    last_checked_at: "2026-07-14T17:00:00.000Z",
    last_updated_at: "2026-07-14T16:00:00.000Z",
    ...overrides
  };
}

function liveRawText({
  id,
  source,
  handle,
  text,
  authorName,
  topVoiceMemberId,
  extraPost = {}
}: {
  id: string;
  source: "live_x_profile" | "live_x_top_voice_profile";
  handle: string;
  text: string;
  authorName?: string;
  topVoiceMemberId?: string;
  extraPost?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    source,
    profile: {
      targetHandle: handle,
      accountUrl: source === "live_x_profile" ? `https://x.com/${handle}` : undefined,
      batchSlug: "S26",
      topVoiceMemberId,
      topVoiceDisplayName: topVoiceMemberId ? "Sam Altman" : undefined
    },
    post: {
      url: `https://x.com/${handle}/status/${id}`,
      id,
      text,
      created_timestamp: 1784041200,
      replies: 74,
      retweets: 104,
      likes: 697,
      views: 116000,
      author: {
        screen_name: handle,
        name: authorName ?? handle,
        url: `https://x.com/${handle}`
      },
      ...extraPost
    },
    counts: {
      views: 116000,
      likes: 697,
      comments: 74,
      replies: 74,
      reposts: 104
    }
  });
}

function screenpipeFxFetch(
  postId: string,
  metrics: Record<string, unknown>,
  text = "screenpipe records and learns how you work"
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (String(input) === `https://api.fxtwitter.com/screenpipe/status/${postId}`) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 200,
          tweet: {
            url: `https://x.com/screenpipe/status/${postId}`,
            id: postId,
            text,
            created_timestamp: 1784041200,
            ...metrics,
            author: {
              screen_name: "screenpipe",
              name: "screenpipe (YC S26)",
              url: "https://x.com/screenpipe"
            }
          }
        })
      } as Response;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function providerPayload(
  shape: XProviderResponseShape,
  identity: { returnedPostId: string; canonicalPostId: string }
): Record<string, unknown> {
  const canonicalUrl = `https://x.com/screenpipe/status/${identity.canonicalPostId}`;
  const post = {
    url: canonicalUrl,
    id: identity.returnedPostId,
    text: "screenpipe provider identity verification update",
    created_timestamp: 1784041200,
    replies: 74,
    retweets: 104,
    likes: 697,
    views: 116000,
    author: {
      screen_name: "screenpipe",
      name: "screenpipe (YC S26)",
      url: "https://x.com/screenpipe"
    }
  };

  if (shape === "fxtwitter_tweet") {
    return { code: 200, tweet: post };
  }
  if (shape === "fxtwitter_status") {
    return { code: 200, status: post };
  }
  return {
    tweetID: identity.returnedPostId,
    tweetURL: canonicalUrl,
    text: post.text,
    date: "Tue Jul 14 17:00:00 +0000 2026",
    date_epoch: post.created_timestamp,
    replies: post.replies,
    retweets: post.retweets,
    likes: post.likes,
    views: post.views,
    user_name: post.author.name,
    user_screen_name: post.author.screen_name,
    media_extended: []
  };
}

async function runDirectProviderPayload(
  shape: XProviderResponseShape,
  payload: Record<string, unknown>,
  requestedPostId: string
) {
  const tempDir = await mkdtemp(join(tmpdir(), "returner-live-refresh-provider-trust-"));
  const targetedEvidencePath = join(tempDir, "targeted-evidence-current.json");
  const stageLogPath = join(tempDir, "stage-log.json");
  await writeFile(
    targetedEvidencePath,
    JSON.stringify({ source: { fetchedAt: "2026-07-14T00:00:00.000Z" }, evidence: [], needsReview: [] })
  );

  const fxUrl = `https://api.fxtwitter.com/screenpipe/status/${requestedPostId}`;
  const vxUrl = `https://api.vxtwitter.com/screenpipe/status/${requestedPostId}`;
  const responseUrl = shape === "vxtwitter" ? vxUrl : fxUrl;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input) === responseUrl) {
      return Response.json(payload);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    return await runLiveSourceRefresh({
      rootDir: process.cwd(),
      batchSlug: "S26",
      platforms: ["x"],
      maxXTargets: 0,
      xConcurrency: 1,
      xRequestTimeoutMs: 500,
      xSourceUrls: [`https://x.com/screenpipe/status/${requestedPostId}`],
      targetedEvidencePath,
      stageLogPath,
      now: new Date("2026-07-16T21:00:00.000Z"),
      fetchImpl
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
