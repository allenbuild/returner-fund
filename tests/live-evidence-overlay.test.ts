import { describe, expect, it } from "vitest";
import { momentumSort } from "@/lib/graph/benchmarks";
import { buildGraphResponse, getNodeRadius } from "@/lib/graph/graph-builder";
import { liveEvidenceCacheVersion } from "@/lib/graph/live-evidence-dataset";
import {
  liveEvidenceRecordToEvidenceItem,
  overlayLiveEvidenceOnGraph,
  scoreLiveEvidence
} from "@/lib/graph/live-evidence-overlay";
import { TRACTION_SCORING_CONFIG } from "@/lib/graph/traction-scoring-config";
import { aggregateBalancedTractionScore } from "@/lib/graph/traction-scoring";
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

  it("resolves live account IDs only through the matching materialized account owner", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const screenpipe = graph.nodes.find((node) => node.entityId === "company-screenpipe");
    const companyAccount = screenpipe?.socialAccounts.find((account) => account.platform === "x");
    const founderAccount = screenpipe?.founders
      .flatMap((founder) => founder.socialAccounts)
      .find((account) => account.platform === "x");
    const matchedRecord = screenpipeRecord({
      id: "live-x-screenpipe-materialized-account",
      sourceUrl: "https://x.com/screenpipe/status/3077045452579778664",
      platformPostId: "3077045452579778664",
      rawVisibleText: JSON.stringify({
        post: {
          author: {
            screen_name: "screenpipe",
            name: "screenpipe (YC S26)",
            url: "https://twitter.com/screenpipe"
          }
        }
      })
    });
    const standalone = liveEvidenceRecordToEvidenceItem(matchedRecord);
    const expectedMatchedScore = scoreLiveEvidence(standalone, graph.evidence).contributionScore;
    const matchedResult = overlayLiveEvidenceOnGraph(graph, [matchedRecord]);
    const matchedEvidence = matchedResult.graph.evidence.find((item) => item.id === matchedRecord.id);

    expect(companyAccount).toBeDefined();
    expect(founderAccount).toBeDefined();
    expect(standalone.socialAccountId).toBeNull();
    expect(matchedEvidence).toEqual(
      expect.objectContaining({
        entityType: "company",
        entityId: "company-screenpipe",
        platform: "x",
        socialAccountId: companyAccount?.id,
        contributionScore: expectedMatchedScore
      })
    );

    const crossOwnerRecord = screenpipeRecord({
      id: "live-x-screenpipe-owner-mismatch",
      sourceUrl: "https://x.com/louis030195/status/3077045452579778665",
      platformPostId: "3077045452579778665",
      rawVisibleText: JSON.stringify({
        post: {
          author: {
            screen_name: "louis030195",
            name: "Louis Beaumont",
            url: founderAccount?.url
          }
        }
      })
    });
    const expectedCrossOwnerScore = scoreLiveEvidence(
      liveEvidenceRecordToEvidenceItem(crossOwnerRecord),
      graph.evidence
    ).contributionScore;
    const crossOwnerResult = overlayLiveEvidenceOnGraph(graph, [crossOwnerRecord]);
    const crossOwnerEvidence = crossOwnerResult.graph.evidence.find((item) => item.id === crossOwnerRecord.id);

    expect(crossOwnerEvidence).toEqual(
      expect.objectContaining({
        entityType: "company",
        entityId: "company-screenpipe",
        platform: "x",
        socialAccountId: null,
        contributionScore: expectedCrossOwnerScore
      })
    );
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

  it("keeps a null publication date unknown so observation time cannot inflate momentum or confidence", () => {
    const observedAt = "2035-07-14T17:00:00.000Z";
    const undated = liveEvidenceRecordToEvidenceItem(
      screenpipeRecord({
        id: "live-x-screenpipe-undated",
        sourceUrl: "https://x.com/screenpipe/status/3077045452579778664",
        platformPostId: "3077045452579778664",
        postedAt: null,
        first_seen_at: observedAt,
        last_checked_at: observedAt,
        last_updated_at: observedAt,
        linkCheckedAt: observedAt
      })
    );
    const dated = liveEvidenceRecordToEvidenceItem(
      screenpipeRecord({
        id: "live-x-screenpipe-dated",
        sourceUrl: "https://x.com/screenpipe/status/3077045452579778664",
        platformPostId: "3077045452579778664",
        postedAt: observedAt,
        first_seen_at: observedAt,
        last_checked_at: observedAt,
        last_updated_at: observedAt,
        linkCheckedAt: observedAt
      })
    );
    const scoredUndated = scoreLiveEvidence(undated, []);
    const scoredDated = scoreLiveEvidence(dated, []);
    const undatedBreakdown = aggregateBalancedTractionScore([scoredUndated]);
    const datedBreakdown = aggregateBalancedTractionScore([scoredDated]);

    expect(undated).toMatchObject({
      postedAt: "",
      publishedAtPrecision: "unknown",
      observedAt,
      metricsCheckedAt: observedAt,
      last_updated_at: observedAt
    });
    expect(scoredUndated.contributionScore).toBeLessThan(scoredDated.contributionScore);
    expect(undatedBreakdown.signalFamilyScores.momentum).toBe(0);
    expect(datedBreakdown.signalFamilyScores.momentum).toBeGreaterThan(0);
    expect(undatedBreakdown.confidence.datedEvidenceCount).toBe(0);
    expect(datedBreakdown.confidence.datedEvidenceCount).toBe(1);
    expect(undatedBreakdown.confidence.value).toBeLessThan(datedBreakdown.confidence.value);
  });

  it("replaces stale canonical rationale when live evidence is rescored", () => {
    const initial = scoreLiveEvidence(
      liveEvidenceRecordToEvidenceItem(
        screenpipeRecord({
          id: "live-x-screenpipe-rationale",
          sourceUrl: "https://x.com/screenpipe/status/3077045452579778666",
          platformPostId: "3077045452579778666"
        })
      ),
      []
    );
    const rescored = scoreLiveEvidence(
      {
        ...initial,
        metrics: { views: 1, likes: 1, comments: 0, replies: 0, reposts: 0 }
      },
      []
    );

    expect(rescored.contributionScore).toBeLessThan(initial.contributionScore);
    expect(rescored.why).toContain(initial.matchReason);
    expect(rescored.why.match(new RegExp(TRACTION_SCORING_CONFIG.name, "g"))).toHaveLength(1);
    expect(rescored.why).toContain(`scored ${rescored.contributionScore}/100.`);
    expect(rescored.why).not.toContain(`scored ${initial.contributionScore}/100.`);
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

  it("batch-calibrates the full company cohort atomically after live evidence changes", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const beforeByCompanyId = new Map(graph.nodes.map((node) => [node.entityId, node]));
    const record = screenpipeRecord({
      metrics: {
        ...screenpipeRecord().metrics,
        views: 999999
      },
      last_checked_at: "2030-07-14T17:00:00.000Z",
      linkCheckedAt: "2030-07-14T17:00:00.000Z"
    });
    const result = overlayLiveEvidenceOnGraph(graph, [record]);
    const positiveCohortSize = result.graph.nodes.filter(
      (node) => (node.scoreBreakdown?.absoluteScore ?? 0) > 0
    ).length;

    expect(positiveCohortSize).toBeGreaterThan(1);
    for (const node of result.graph.nodes) {
      const before = beforeByCompanyId.get(node.entityId)!;
      const calibration = node.scoreBreakdown?.calibration;

      expect(node.score).toBe(node.scoreBreakdown?.totalScore);
      expect(calibration?.cohortSize).toBe(positiveCohortSize);
      expect(calibration?.inputScore).toBe(node.scoreBreakdown?.absoluteScore);
      expect(calibration?.method).toBe(
        (node.scoreBreakdown?.absoluteScore ?? 0) > 0 ? "tie_aware_percentile_blend" : "none"
      );
      expect(node.scoreDelta).toBe(Math.round(node.score - before.score));
      if (node.score === before.score) {
        expect(node.scoreDelta).toBe(0);
      }
    }

    expect(result.graph.leaderboard.map((row) => row.rank)).toEqual(
      tiedRanks(result.graph.leaderboard.map((row) => row.score))
    );
  });

  it("recomputes radii, benchmark momentum, and scoring provenance after a material overlay", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const record = screenpipeRecord({
      metrics: {
        ...screenpipeRecord().metrics,
        views: 9_999_999,
        likes: 25_000
      },
      last_checked_at: "2030-07-14T17:00:00.000Z",
      linkCheckedAt: "2030-07-14T17:00:00.000Z"
    });
    const beforeMomentumByCompany = new Map(graph.fastestGaining.map((row) => [row.companyId, row]));
    const result = overlayLiveEvidenceOnGraph(graph, [record]);
    const peerScores = result.graph.nodes
      .filter((node) => node.entityType === "company")
      .map((node) => node.score);
    const leaderboardByCompany = new Map(result.graph.leaderboard.map((row) => [row.companyId, row]));

    expect(
      result.graph.nodes.every(
        (node) => node.radius === getNodeRadius(node.score, peerScores, node.entityType)
      )
    ).toBe(true);

    for (const row of result.graph.fastestGaining) {
      const leaderboardRow = leaderboardByCompany.get(row.companyId)!;
      const before = beforeMomentumByCompany.get(row.companyId)!;

      expect(row.dod).toEqual(recomputedMomentum(before.dod, leaderboardRow.score, leaderboardRow.rank));
      expect(row.wow).toEqual(recomputedMomentum(before.wow, leaderboardRow.score, leaderboardRow.rank));
    }
    expect(result.graph.fastestGaining.map((row) => row.companyId)).toEqual(
      [...result.graph.fastestGaining].sort(momentumSort("dod")).map((row) => row.companyId)
    );
    expect(result.graph.fastestGaining.map((row) => row.rank)).toEqual(
      result.graph.fastestGaining.map((_, index) => index + 1)
    );

    expect(result.graph.scoringContext).toEqual({
      modelId: TRACTION_SCORING_CONFIG.modelId,
      modelVersion: TRACTION_SCORING_CONFIG.version,
      modelName: TRACTION_SCORING_CONFIG.name,
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt: result.graph.generatedAt,
      evidenceAsOf: "2030-07-14T17:00:00.000Z"
    });
  });

  it("keeps platform-selected overlay scoring canonical and all-platform calibrated", () => {
    const graph = buildGraphResponse(
      { batchSlug: "S26", platforms: ["x"] },
      ycSpring2026GraphDataset
    );
    const result = overlayLiveEvidenceOnGraph(graph, [screenpipeRecord()]);

    expect(result.graph.scoringContext).toMatchObject({
      modelId: TRACTION_SCORING_CONFIG.modelId,
      modelVersion: TRACTION_SCORING_CONFIG.version,
      modelName: TRACTION_SCORING_CONFIG.name,
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt: result.graph.generatedAt
    });
    for (const node of result.graph.nodes.filter((candidate) => candidate.entityType === "company")) {
      expect(node.scoreBreakdown).toBeDefined();
      expect(node.score).toBe(node.scoreBreakdown?.totalScore);
    }
  });

  it("keeps calibrated score surfaces and the leaderboard unchanged when an observation is replayed", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const record = screenpipeRecord({
      metrics: {
        ...screenpipeRecord().metrics,
        views: 999999
      },
      last_checked_at: "2030-07-14T17:00:00.000Z",
      linkCheckedAt: "2030-07-14T17:00:00.000Z"
    });
    const applied = overlayLiveEvidenceOnGraph(graph, [record]);
    const replayed = overlayLiveEvidenceOnGraph(applied.graph, [record]);

    expect(replayed.visibleEvidence).toHaveLength(1);
    expect(replayed.graph).toBe(applied.graph);
    expect(scoreSurface(replayed.graph)).toEqual(scoreSurface(applied.graph));
    expect(replayed.graph.leaderboard).toEqual(applied.graph.leaderboard);
  });

  it("treats a canonical observation already present in the calibrated base graph as a no-op", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const existing = graph.evidence.find(
      (item) => item.sourceUrl === "https://github.com/screenpipe/screenpipe"
    );
    expect(existing).toBeDefined();
    const checkedAt = existing?.last_checked_at ?? existing?.metricsCheckedAt ?? existing?.observedAt ?? existing!.postedAt;
    const replay = screenpipeRecord({
      id: existing!.id,
      platform: existing!.platform,
      title: existing!.title ?? existing!.text,
      sourceUrl: existing!.sourceUrl,
      platformPostId: existing!.platformPostId ?? null,
      text: existing!.text,
      thumbnailUrl: existing!.thumbnailUrl ?? null,
      thumbnailSource: existing!.thumbnailSource ?? null,
      mediaUrl: existing!.mediaUrl ?? null,
      mediaUrls: existing!.mediaUrls ?? [],
      media_urls: existing!.mediaUrls ?? [],
      media_posters: [],
      linkStatus: existing!.linkStatus ?? null,
      linkCheckedAt: existing!.linkCheckedAt ?? null,
      linkFailureReason: existing!.linkFailureReason ?? null,
      rawVisibleText: existing!.rawVisibleText ?? "{}",
      postedAt: existing!.postedAt,
      metrics: existing!.metrics,
      contributionScore: existing!.contributionScore,
      review_state: existing!.review_state ?? "verified",
      matchReason: existing!.matchReason ?? existing!.why,
      first_seen_at: existing!.first_seen_at ?? checkedAt,
      last_checked_at: checkedAt,
      last_updated_at: existing!.last_updated_at ?? checkedAt
    });
    const result = overlayLiveEvidenceOnGraph(graph, [replay]);

    expect(result.visibleEvidence).toHaveLength(1);
    expect(scoreSurface(result.graph)).toEqual(scoreSurface(graph));
    expect(result.graph.leaderboard).toEqual(graph.leaderboard);
  });

  it("is permutation-invariant, canonical-post deduped, and safe when duplicate timestamps are missing", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const screenpipe = graph.nodes.find((node) => node.entityId === "company-screenpipe");
    const founderId = screenpipe?.founders[0]?.id;
    expect(founderId).toBeTruthy();

    const timestamplessOverstatement = screenpipeRecord({
      id: "live-x-screenpipe-timestampless-overstatement",
      sourceUrl: "https://twitter.com/screenpipe/status/2077045452579778664?s=20",
      platformPostId: null,
      postedAt: null,
      first_seen_at: "",
      last_checked_at: "",
      last_updated_at: "",
      linkCheckedAt: null,
      metrics: { views: 900000000, likes: 9000000, replies: 900000, reposts: 900000 },
      contributionScore: 100
    });
    const explicitCorrection = screenpipeRecord({
      id: "live-x-screenpipe-explicit-correction",
      entityType: "founder",
      entityId: founderId!,
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778664?utm_source=refresh",
      metrics: { views: 250, likes: 4, replies: 1, reposts: 0 },
      contributionScore: 5,
      first_seen_at: "2031-07-14T17:00:00.000Z",
      last_checked_at: "2031-07-14T17:00:00.000Z",
      last_updated_at: "2031-07-14T17:00:00.000Z",
      linkCheckedAt: "2031-07-14T17:00:00.000Z"
    });
    const secondPost = screenpipeRecord({
      id: "live-x-screenpipe-second-post",
      sourceUrl: "https://x.com/screenpipe/status/2077045452579778665",
      platformPostId: "2077045452579778665",
      metrics: { views: 12500, likes: 80, replies: 9, reposts: 4 },
      first_seen_at: "2030-07-15T17:00:00.000Z",
      last_checked_at: "2030-07-15T17:00:00.000Z",
      last_updated_at: "2030-07-15T17:00:00.000Z",
      linkCheckedAt: "2030-07-15T17:00:00.000Z"
    });
    const results = permutations([timestamplessOverstatement, explicitCorrection, secondPost]).map((records) =>
      overlayLiveEvidenceOnGraph(graph, records)
    );

    for (const result of results.slice(1)) {
      expect(result).toEqual(results[0]);
    }
    const canonicalRows = results[0].graph.evidence.filter(
      (item) => item.platform === "x" && item.platformPostId === "2077045452579778664"
    );
    expect(canonicalRows).toHaveLength(1);
    expect(canonicalRows[0]).toMatchObject({
      entityType: "founder",
      entityId: founderId,
      metrics: { views: 250 }
    });
    expect(results[0].visibleEvidence).toHaveLength(2);
  });

  it("lets a fresher canonical observation lower stale scores and keeps every graph score surface aligned", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const staleHigh = screenpipeRecord({
      id: "live-x-screenpipe-stale-high",
      metrics: { views: 900000000, likes: 9000000, replies: 900000, reposts: 900000 },
      contributionScore: 100,
      first_seen_at: "2030-07-14T17:00:00.000Z",
      last_checked_at: "2030-07-14T17:00:00.000Z",
      last_updated_at: "2030-07-14T17:00:00.000Z",
      linkCheckedAt: "2030-07-14T17:00:00.000Z"
    });
    const freshLower = screenpipeRecord({
      id: "live-x-screenpipe-fresh-lower",
      sourceUrl: "https://twitter.com/screenpipe/status/2077045452579778664?s=20",
      metrics: { views: 25, likes: 1, replies: 0, reposts: 0 },
      contributionScore: 5,
      first_seen_at: "2030-07-14T17:00:00.000Z",
      last_checked_at: "2031-07-14T17:00:00.000Z",
      last_updated_at: "2031-07-14T17:00:00.000Z",
      linkCheckedAt: "2031-07-14T17:00:00.000Z"
    });
    const staleResult = overlayLiveEvidenceOnGraph(graph, [staleHigh]);
    const correctedResult = overlayLiveEvidenceOnGraph(staleResult.graph, [freshLower]);
    const staleNode = staleResult.graph.nodes.find((node) => node.entityId === "company-screenpipe")!;
    const correctedNode = correctedResult.graph.nodes.find((node) => node.entityId === "company-screenpipe")!;
    const staleEvidence = staleResult.graph.evidence.find(
      (item) => item.platform === "x" && item.platformPostId === staleHigh.platformPostId
    )!;
    const correctedEvidence = correctedResult.graph.evidence.find(
      (item) => item.platform === "x" && item.platformPostId === freshLower.platformPostId
    )!;
    const leaderboardRow = correctedResult.graph.leaderboard.find(
      (row) => row.companyId === "company-screenpipe"
    )!;

    expect(correctedEvidence.metrics.views).toBe(25);
    expect(correctedEvidence.id).toBe(staleEvidence.id);
    expect(correctedEvidence.contributionScore).toBeLessThan(staleEvidence.contributionScore);
    expect(correctedNode.platformScores.x).toBeLessThan(staleNode.platformScores.x ?? Number.POSITIVE_INFINITY);
    expect(correctedNode.scoreBreakdown?.absoluteScore).toBeLessThan(
      staleNode.scoreBreakdown?.absoluteScore ?? Number.POSITIVE_INFINITY
    );
    expect(correctedNode.score).toBeLessThanOrEqual(staleNode.score);
    expect(correctedNode.scoreDelta).toBe(Math.round(correctedNode.score - staleNode.score));
    expect(correctedNode.scoreBreakdown).toBeDefined();
    expect(correctedNode.score).toBe(correctedNode.scoreBreakdown?.totalScore);
    expect(correctedNode.platformScores).toEqual(correctedNode.scoreBreakdown?.platformScores);
    expect(leaderboardRow.score).toBe(correctedNode.score);
    expect(leaderboardRow.topPlatform).toBe(correctedNode.topPlatform);

    const companyEvidence = correctedResult.graph.evidence.filter((item) =>
      correctedNode.evidenceIds.includes(item.id)
    );
    expect(leaderboardRow.biggestContribution?.contributionScore).toBe(
      Math.max(...companyEvidence.map((item) => item.contributionScore))
    );
    expect(correctedResult.graph.leaderboard.map((row) => row.rank)).toEqual(
      tiedRanks(correctedResult.graph.leaderboard.map((row) => row.score))
    );
    for (let index = 1; index < correctedResult.graph.leaderboard.length; index += 1) {
      expect(correctedResult.graph.leaderboard[index - 1].score).toBeGreaterThanOrEqual(
        correctedResult.graph.leaderboard[index].score
      );
    }
  });

  it("preserves an explicit zero-score correction instead of resurrecting it from visible metrics", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const correction = screenpipeRecord({
      id: "live-x-screenpipe-context-only-correction",
      contributionScore: 0,
      metrics: { views: 9_000_000, likes: 20_000, replies: 5_000, reposts: 2_000 },
      first_seen_at: "2032-07-14T17:00:00.000Z",
      last_checked_at: "2032-07-14T17:00:00.000Z",
      last_updated_at: "2032-07-14T17:00:00.000Z",
      linkCheckedAt: "2032-07-14T17:00:00.000Z",
      matchReason: "Verified native activity retained as contextual, explicitly excluded upstream."
    });
    const result = overlayLiveEvidenceOnGraph(graph, [correction]);
    const corrected = result.graph.evidence.find(
      (item) => item.platform === "x" && item.platformPostId === correction.platformPostId
    );

    expect(corrected).toBeDefined();
    expect(corrected?.metrics.views).toBe(9_000_000);
    expect(corrected?.contributionScore).toBe(0);
    expect(corrected?.normalizedScore).toBe(0);
    expect(corrected?.why).toContain("upstream_excluded");
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

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) {
    return [items];
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])
  );
}

function scoreSurface(graph: ReturnType<typeof buildGraphResponse>) {
  return graph.nodes.map((node) => ({
    companyId: node.entityId,
    score: node.score,
    previousScore: node.previousScore,
    scoreDelta: node.scoreDelta,
    topPlatform: node.topPlatform,
    platformScores: node.platformScores,
    scoreBreakdown: node.scoreBreakdown
  }));
}

function tiedRanks(scores: number[]): number[] {
  let rank = 0;
  let previousScore: number | null = null;

  return scores.map((score, index) => {
    if (previousScore === null || score !== previousScore) {
      rank = index + 1;
    }
    previousScore = score;
    return rank;
  });
}

function recomputedMomentum(
  before: ReturnType<typeof buildGraphResponse>["fastestGaining"][number]["dod"],
  currentScore: number,
  currentRank: number
) {
  const scoreDelta = before.baselineScore === null ? 0 : currentScore - before.baselineScore;
  return {
    scoreDelta,
    percentDelta:
      before.baselineScore === null
        ? 0
        : round((scoreDelta / Math.max(before.baselineScore, 1)) * 100, 1),
    rankDelta: before.baselineRank === null ? 0 : before.baselineRank - currentRank,
    currentScore,
    currentRank,
    baselineScore: before.baselineScore,
    baselineRank: before.baselineRank,
    benchmarkedAt: before.benchmarkedAt
  };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
