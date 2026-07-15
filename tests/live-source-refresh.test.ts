import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadLiveEvidenceRecords, runLiveSourceRefresh, type LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";

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
          comments: 74,
          reposts: 104
        }),
        review_state: "verified"
      });
      expect(result.failureReasonCounts.adapter_not_wired).toBeUndefined();
      expect(result.stageLog.some((entry) => entry.stage === "accepted" && entry.reason === undefined)).toBe(true);

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
          comments: 74,
          reposts: 104
        })
      });
      expect(result.stageLog.some((entry) => entry.message.includes("Accepted direct X post"))).toBe(true);
      expect(result.stageLog.some((entry) => entry.sourceUrl === "https://x.com/screenpipe")).toBe(false);
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
          comments: 17,
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
          comments: 24,
          reposts: 35
        }),
        review_state: "verified"
      });
      expect(result.failureReasonCounts.founder_post_missing_company_mention).toBeUndefined();
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

    await writeFile(
      targetedEvidencePath,
      JSON.stringify({
        source: { fetchedAt: "2026-07-14T00:00:00.000Z" },
        evidence: [invalidLink, spoofedHost, authorMismatch, repost, good],
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
