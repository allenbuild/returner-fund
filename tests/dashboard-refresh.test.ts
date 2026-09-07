import { describe, expect, it } from "vitest";
import type { DashboardCandidate, DashboardMetrics, DashboardPublicSnapshot } from "@/lib/dashboard/contracts";
import {
  assertConfiguredYoutubeDiscoverySucceeded,
  configuredInstagramDiscoveryFailureLabels,
  dashboardExternalCandidateCounts,
  dashboardExternalAttemptCount,
  dashboardRefreshLogDiagnostics,
  dashboardRefreshSourceHealth,
  enrichDashboardCandidatesWithPriorSnapshotMetrics,
  retainPriorVerifiedYoutubeCandidatesOnDetailFailure,
  retainPriorDashboardSnapshotOnBroadSourceFailure
} from "@/lib/dashboard/refresh";
import {
  MAX_DASHBOARD_INSTAGRAM_ACCOUNTS,
  MAX_DASHBOARD_YOUTUBE_CHANNELS
} from "@/lib/dashboard/external-discovery";
import { buildDashboardSnapshot, dashboardTop100Eligibility } from "@/lib/dashboard/pipeline";
import { velocityScore } from "@/lib/dashboard/scoring";

const PRIOR_GENERATED_AT = "2026-08-15T11:00:00.000Z";
const NOW = new Date("2026-08-15T12:00:00.000Z");

describe("dashboard worker metric-history enrichment", () => {
  it("counts the optional official X request only when its credential is configured", () => {
    const boundedSources = { rssFeeds: [], researchFeeds: [], redditSubreddits: [] };
    expect(dashboardExternalAttemptCount(boundedSources)).toBe(3);
    expect(dashboardExternalAttemptCount({ ...boundedSources, xBearerToken: "x-token" })).toBe(4);
    expect(dashboardExternalAttemptCount({ ...boundedSources, xBearerToken: "   " })).toBe(3);
    expect(dashboardExternalAttemptCount({ ...boundedSources, includeYoutubeSearch: true })).toBe(4);
    expect(dashboardExternalAttemptCount({
      ...boundedSources,
      instagramAccounts: [{ name: "Apple", username: "apple" }, { name: "MKBHD", username: "mkbhd" }]
    })).toBe(5);
    expect(dashboardExternalAttemptCount({
      ...boundedSources,
      youtubeChannels: [{ name: "Apple", handle: "Apple" }, { name: "MKBHD", handle: "mkbhd" }]
    })).toBe(5);
    expect(dashboardExternalAttemptCount({
      ...boundedSources,
      youtubeChannels: Array.from({ length: MAX_DASHBOARD_YOUTUBE_CHANNELS + 5 }, (_, index) => ({
        name: `Channel ${index}`,
        handle: `channel${index}`
      }))
    })).toBe(3 + MAX_DASHBOARD_YOUTUBE_CHANNELS);
    expect(dashboardExternalAttemptCount({
      ...boundedSources,
      instagramAccounts: Array.from({ length: MAX_DASHBOARD_INSTAGRAM_ACCOUNTS + 5 }, (_, index) => ({
        name: `Account ${index}`,
        username: `account${index}`
      }))
    })).toBe(3 + MAX_DASHBOARD_INSTAGRAM_ACCOUNTS);
  });

  it("fails closed when every configured YouTube adapter lacks a source receipt", () => {
    const channels = [{ name: "Apple", handle: "Apple" }, { name: "MKBHD", handle: "mkbhd" }];

    expect(() => assertConfiguredYoutubeDiscoverySucceeded(
      channels,
      ["hacker_news", "github", "rss:example"],
      ["youtube_apple_browse_http_429", "youtube_mkbhd_browse_fetch_failed", "rss_example_http_503"]
    )).toThrowError(
      "dashboard_youtube_discovery_unavailable:youtube_apple_browse_http_429,youtube_mkbhd_browse_fetch_failed"
    );
  });

  it("accepts one successful YouTube adapter even when it yields no eligible candidate", () => {
    const channels = [{ name: "Apple", handle: "Apple" }, { name: "MKBHD", handle: "mkbhd" }];

    expect(() => assertConfiguredYoutubeDiscoverySucceeded(
      channels,
      ["hacker_news", "youtube:mkbhd"]
    )).not.toThrow();
    expect(() => assertConfiguredYoutubeDiscoverySucceeded([], ["hacker_news"])).not.toThrow();
  });

  it("does not let broad search conceal a total configured-channel outage", () => {
    const channels = [{ name: "Apple", handle: "Apple" }];

    expect(() => assertConfiguredYoutubeDiscoverySucceeded(
      channels,
      ["hacker_news", "youtube:search"],
      ["youtube_apple_browse_http_429"]
    )).toThrowError("dashboard_youtube_discovery_unavailable:youtube_apple_browse_http_429");
  });

  it("accepts a prior verified YouTube candidate only for transient detail unavailability", () => {
    const channels = [{ name: "Apple", handle: "Apple" }];
    expect(() => assertConfiguredYoutubeDiscoverySucceeded(
      channels,
      ["hacker_news"],
      ["youtube_apple_detail_unavailable:player_http_429:watch_http_503"],
      1
    )).not.toThrow();
    expect(() => assertConfiguredYoutubeDiscoverySucceeded(
      channels,
      ["hacker_news"],
      ["youtube_apple_detail_unavailable:discovery_deadline"],
      1
    )).not.toThrow();
    expect(() => assertConfiguredYoutubeDiscoverySucceeded(
      channels,
      ["hacker_news"],
      ["youtube_apple_browse_http_429"],
      1
    )).toThrowError("dashboard_youtube_discovery_unavailable:youtube_apple_browse_http_429");
    expect(() => assertConfiguredYoutubeDiscoverySucceeded(
      [...channels, { name: "MKBHD", handle: "mkbhd" }],
      ["hacker_news"],
      ["youtube_apple_detail_unavailable:player_http_429:watch_http_503", "youtube_mkbhd_browse_http_429"],
      1
    )).toThrowError(
      "dashboard_youtube_discovery_unavailable:youtube_apple_detail_unavailable:player_http_429:watch_http_503,youtube_mkbhd_browse_http_429"
    );
  });

  it("retains only prior YouTube proof that still clears every strict Top-100 gate", () => {
    const channels = [{ name: "Apple", handle: "Apple" }];
    const prior = buildDashboardSnapshot(
      [qualifyingYoutubeCandidate()],
      { now: new Date(PRIOR_GENERATED_AT) }
    ).snapshot;
    const later = NOW;
    const failures = ["youtube_apple_detail_unavailable:player_http_429:watch_http_503"];
    const retained = retainPriorVerifiedYoutubeCandidatesOnDetailFailure([], prior, later, failures, channels);
    const deadlineRetained = retainPriorVerifiedYoutubeCandidatesOnDetailFailure(
      [],
      prior,
      later,
      ["youtube_apple_detail_unavailable:discovery_deadline"],
      channels
    );

    expect(retained).toEqual([
      expect.objectContaining({
        id: "youtube:abcdefghijk",
        canonicalKey: "youtube:video:abcdefghijk",
        priorStoryStableKey: prior.stories[0]!.stableKey,
        publishedAt: "2026-08-15T10:00:00.000Z",
        observedAt: PRIOR_GENERATED_AT,
        metrics: { views: 2_000_000, likes: 20_000 },
        publicationPrecision: "exact",
        sourceVerified: true,
        sourceLinkStatus: "verified"
      })
    ]);
    expect(retained[0]?.metricHistory).toBeUndefined();
    expect(deadlineRetained).toEqual(retained);
    expect(dashboardTop100Eligibility(retained[0]!, later)).toMatchObject({ eligible: true });
    const firstCarry = buildDashboardSnapshot(retained, { now: later }).snapshot;
    expect(firstCarry.stories[0]?.stableKey).toBe(prior.stories[0]?.stableKey);
    expect(firstCarry.stories[0]?.updatedAt).toBe(PRIOR_GENERATED_AT);
    expect(firstCarry.updatedAt).toBe(later.toISOString());
    const recursiveCarry = retainPriorVerifiedYoutubeCandidatesOnDetailFailure(
      [],
      firstCarry,
      new Date("2026-08-15T13:00:00.000Z"),
      failures,
      channels
    );
    expect(recursiveCarry[0]?.observedAt).toBe(PRIOR_GENERATED_AT);

    const belowReach = structuredClone(prior);
    belowReach.stories[0]!.sources[0]!.metrics.views = 999_999;
    expect(retainPriorVerifiedYoutubeCandidatesOnDetailFailure([], belowReach, later, failures, channels)).toEqual([]);

    const imprecise = structuredClone(prior);
    imprecise.stories[0]!.sources[0]!.publishedAt = "2026-08-15";
    expect(retainPriorVerifiedYoutubeCandidatesOnDetailFailure([], imprecise, later, failures, channels)).toEqual([]);

    const expired = structuredClone(prior);
    expired.stories[0]!.sources[0]!.publishedAt = "2026-08-12T11:59:59.999Z";
    expect(retainPriorVerifiedYoutubeCandidatesOnDetailFailure([], expired, later, failures, channels)).toEqual([]);

    const wrongIdentity = structuredClone(prior);
    wrongIdentity.stories[0]!.sources[0]!.canonicalKey = "youtube:video:different01";
    expect(retainPriorVerifiedYoutubeCandidatesOnDetailFailure([], wrongIdentity, later, failures, channels)).toEqual([]);

    expect(retainPriorVerifiedYoutubeCandidatesOnDetailFailure(
      [qualifyingYoutubeCandidate()],
      prior,
      later,
      failures,
      channels
    )).toEqual([]);
    expect(retainPriorVerifiedYoutubeCandidatesOnDetailFailure(
      [],
      prior,
      later,
      ["youtube_apple_browse_http_429"],
      channels
    )).toEqual([]);
    expect(retainPriorVerifiedYoutubeCandidatesOnDetailFailure(
      [],
      prior,
      later,
      failures,
      [{ name: "Different channel", handle: "DifferentChannel" }]
    )).toEqual([]);
  });

  it("records a complete Instagram outage as partial while healthy adapters continue", () => {
    const accounts = [{ name: "Apple", username: "apple" }, { name: "Tech Burner", username: "techburner" }];
    const accountFailures = ["instagram_apple_http_401", "instagram_techburner_http_401"];

    expect(configuredInstagramDiscoveryFailureLabels(
      accounts,
      ["hacker_news", "github", "youtube:mkbhd"]
    )).toEqual(["instagram_discovery_unavailable"]);
    expect(configuredInstagramDiscoveryFailureLabels(
      accounts,
      ["hacker_news", "instagram:apple"]
    )).toEqual([]);
    expect(configuredInstagramDiscoveryFailureLabels([], ["hacker_news"])).toEqual([]);

    const pipeline = buildDashboardSnapshot([qualifyingSocialCandidate("healthy-youtube")], {
      now: NOW,
      platformFailures: [
        ...accountFailures,
        ...configuredInstagramDiscoveryFailureLabels(accounts, ["hacker_news", "github", "youtube:mkbhd"])
      ]
    });
    expect(pipeline.snapshot.stories).toHaveLength(1);
    expect(pipeline.snapshot.status.partialPlatformFailures).toEqual([
      "instagram_apple_http_401",
      "instagram_discovery_unavailable",
      "instagram_techburner_http_401"
    ]);
    expect(dashboardRefreshSourceHealth({
      returnerAttempted: 3,
      returnerSucceeded: 3,
      externalAttempted: 5,
      externalSucceeded: 3
    }).broadSourceFailure).toBe(false);
  });

  it("reports sanitized per-platform eligibility and rejection counts, including zero YouTube candidates", () => {
    const eligible = {
      ...qualifyingSocialCandidate("eligible-youtube"),
      canonicalKey: "youtube:video:eligibleyt",
      platform: "youtube" as const,
      sourceKind: "video" as const,
      url: "https://www.youtube.com/watch?v=eligibleyt"
    };
    const belowReach = {
      ...eligible,
      id: "below-reach-youtube",
      canonicalKey: "youtube:video:belowreach",
      url: "https://www.youtube.com/watch?v=belowreach",
      metrics: { views: 999_999, likes: 20_000 }
    };

    expect(dashboardExternalCandidateCounts([eligible, belowReach], NOW, ["youtube"])).toEqual({
      "industry:youtube:candidates": 2,
      "industry:youtube:eligible": 1,
      "industry:youtube:rejected:below_one_million_views": 1
    });
    expect(dashboardExternalCandidateCounts([], NOW, ["youtube"])).toEqual({
      "industry:youtube:candidates": 0,
      "industry:youtube:eligible": 0
    });
  });

  it("uses a prior published source reading plus the current worker reading for the exact canonical source", () => {
    const candidate = dashboardCandidate({
      canonicalKey: "reddit:post:abc123",
      observedAt: "2026-08-15T12:00:00.050Z",
      metrics: { upvotes: 110, comments: 20 }
    });
    const [enriched] = enrichDashboardCandidatesWithPriorSnapshotMetrics(
      [candidate],
      priorSnapshot("reddit:post:abc123", { upvotes: 10, comments: 2 }),
      NOW
    );

    expect(enriched).not.toBe(candidate);
    expect(enriched.metricHistory).toEqual([
      { observedAt: PRIOR_GENERATED_AT, metrics: { upvotes: 10, comments: 2 } },
      { observedAt: "2026-08-15T12:00:00.050Z", metrics: { upvotes: 110, comments: 20 } }
    ]);
    expect(velocityScore(enriched, NOW)).toBeGreaterThan(0);
  });

  it("leaves a one-scrape source unchanged when no safely ordered prior/current pair exists", () => {
    const prior = priorSnapshot("reddit:post:abc123", { upvotes: 10 });
    const unmatched = dashboardCandidate({ canonicalKey: "reddit:post:other", observedAt: NOW.toISOString() });
    const sameTimestamp = dashboardCandidate({ id: "same-timestamp", observedAt: PRIOR_GENERATED_AT });
    const noCurrentMetrics = dashboardCandidate({ id: "no-current-metrics", observedAt: NOW.toISOString(), metrics: {} });
    const materiallyFuture = dashboardCandidate({
      id: "future-reading",
      observedAt: "2026-08-15T12:31:00.000Z"
    });

    const enriched = enrichDashboardCandidatesWithPriorSnapshotMetrics(
      [unmatched, sameTimestamp, noCurrentMetrics, materiallyFuture],
      prior,
      NOW
    );

    expect(enriched).toEqual([unmatched, sameTimestamp, noCurrentMetrics, materiallyFuture]);
    expect(enriched.every((candidate, index) => candidate === [unmatched, sameTimestamp, noCurrentMetrics, materiallyFuture][index])).toBe(true);
    expect(enriched.map((candidate) => velocityScore(candidate, NOW))).toEqual([0, 0, 0, 0]);
  });

  it("does not treat a casing-only key difference as the same physical source", () => {
    const candidate = dashboardCandidate({ canonicalKey: "rss:url:https://example.com/Release" });
    const [enriched] = enrichDashboardCandidatesWithPriorSnapshotMetrics(
      [candidate],
      priorSnapshot("rss:url:https://example.com/release", { views: 20 }),
      NOW
    );

    expect(enriched).toBe(candidate);
    expect(enriched.metricHistory).toBeUndefined();
  });

  it("distinguishes a broad adapter outage from a healthy under-100 collection", () => {
    expect(dashboardRefreshSourceHealth({
      returnerAttempted: 3,
      returnerSucceeded: 3,
      externalAttempted: 57,
      externalSucceeded: 52
    })).toMatchObject({
      attemptedSourceCount: 60,
      successfulSourceCount: 55,
      failedSourceCount: 5,
      broadSourceFailure: false
    });

    expect(dashboardRefreshSourceHealth({
      returnerAttempted: 3,
      returnerSucceeded: 3,
      externalAttempted: 57,
      externalSucceeded: 0
    })).toMatchObject({
      attemptedSourceCount: 60,
      successfulSourceCount: 3,
      failedSourceCount: 57,
      broadSourceFailure: true
    });
  });

  it("projects only bounded aggregate diagnostics into the worker log", () => {
    const pipeline = buildDashboardSnapshot([
      qualifyingSocialCandidate("eligible"),
      qualifyingSocialCandidate("second")
    ], { now: NOW });
    const diagnosticsWithUnsafeFutureField = {
      ...pipeline.diagnostics,
      rawCandidateSample: [{ title: "private title", url: "https://private.example.com/source" }]
    };

    const logged = dashboardRefreshLogDiagnostics({
      diagnostics: diagnosticsWithUnsafeFutureField
    });

    expect(logged).toEqual({
      platformDistribution: pipeline.diagnostics.platformDistribution,
      eligibilityReasonDistribution: pipeline.diagnostics.eligibilityReasonDistribution
    });
    expect(JSON.stringify(logged)).not.toContain("private title");
    expect(JSON.stringify(logged)).not.toContain("private.example.com");
  });

  it("retains and marks the prior truthful window only when broad source failure shrinks it", () => {
    const prior = buildDashboardSnapshot([
      qualifyingSocialCandidate("prior-one"),
      qualifyingSocialCandidate("prior-two")
    ], { now: NOW }).snapshot;
    const later = new Date(NOW.getTime() + 60 * 60 * 1_000);
    const underfilled = buildDashboardSnapshot([
      qualifyingSocialCandidate("prior-one", "2026-08-15T11:30:00.000Z")
    ], { now: later }).snapshot;
    const broadFailure = dashboardRefreshSourceHealth({
      returnerAttempted: 3,
      returnerSucceeded: 0,
      externalAttempted: 57,
      externalSucceeded: 0
    });

    const retained = retainPriorDashboardSnapshotOnBroadSourceFailure(
      prior,
      underfilled,
      broadFailure,
      ["fetch_failed"]
    );

    expect(retained?.stories).toEqual(prior.stories);
    expect(retained?.generatedAt).toBe(prior.generatedAt);
    expect(retained?.windowStart).toBe(prior.windowStart);
    expect(retained?.status.partialPlatformFailures).toEqual([
      "fetch_failed",
      "source_health_collapse",
      "source_retained"
    ]);

    const healthy = dashboardRefreshSourceHealth({
      returnerAttempted: 3,
      returnerSucceeded: 3,
      externalAttempted: 57,
      externalSucceeded: 52
    });
    expect(retainPriorDashboardSnapshotOnBroadSourceFailure(prior, underfilled, healthy)).toBeNull();
  });
});

function qualifyingSocialCandidate(id: string, publishedAt = "2026-08-15T11:00:00.000Z"): DashboardCandidate {
  return {
    id,
    canonicalKey: `x:${id}`,
    platform: "x",
    sourceKind: "post",
    url: `https://x.com/example/status/${id}`,
    title: `${id} launches an AI software platform`,
    text: `${id} launches an AI software platform for developer teams.`,
    publishedAt,
    observedAt: NOW.toISOString(),
    metrics: { views: 2_000_000, likes: 20_000 },
    topics: ["ai", "launches"],
    socialBackfillEligible: true,
    sourceVerified: true,
    sourceLinkStatus: "verified",
    publicationPrecision: "exact"
  };
}

function qualifyingYoutubeCandidate(): DashboardCandidate {
  return {
    ...qualifyingSocialCandidate("abcdefghijk", "2026-08-15T10:00:00.000Z"),
    id: "youtube:abcdefghijk",
    canonicalKey: "youtube:video:abcdefghijk",
    platform: "youtube",
    sourceKind: "video",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
    authorName: "Apple",
    publisher: "YouTube",
    observedAt: PRIOR_GENERATED_AT,
    topics: ["ai"]
  };
}

function dashboardCandidate(overrides: Partial<DashboardCandidate> = {}): DashboardCandidate {
  const id = overrides.id ?? "candidate";
  return {
    id,
    canonicalKey: "reddit:post:abc123",
    platform: "reddit",
    sourceKind: "discussion",
    url: `https://www.reddit.com/comments/${id}`,
    title: "A technology discussion",
    publishedAt: "2026-08-15T10:00:00.000Z",
    observedAt: NOW.toISOString(),
    metrics: { upvotes: 100, comments: 10 },
    ...overrides
  };
}

function priorSnapshot(canonicalKey: string, metrics: DashboardMetrics): DashboardPublicSnapshot {
  // The worker needs only the generated time and source readings. Keeping the
  // fixture intentionally narrow makes clear that it derives history from the
  // already-published projection rather than another discovery call.
  return {
    generatedAt: PRIOR_GENERATED_AT,
    stories: [{ sources: [{ canonicalKey, metrics }] }]
  } as unknown as DashboardPublicSnapshot;
}
