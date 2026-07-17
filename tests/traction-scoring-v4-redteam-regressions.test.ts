import { describe, expect, it, vi } from "vitest";
import { dedupeEvidenceForScoring } from "@/lib/graph/dedupe";
import {
  computeEvidenceRawEngagement,
  normalizeEvidenceScores
} from "@/lib/graph/traction-scoring";
import type { EvidenceItem, EvidenceMetrics } from "@/lib/graph/types";
import { scorePost } from "@/lib/scoring";

const AS_OF = "2026-07-15T12:00:00.000Z";
const STALE_OBSERVATION = "2026-07-01T12:00:00.000Z";
const FUTURE_OBSERVATION = "2026-07-16T12:00:00.000Z";

describe("traction scoring v4 red-team regressions", () => {
  it("excludes observations after an explicit asOf from scoring and its cohort", () => {
    const target = evidence("asof-target", "1849812345000000001", { likes: 100 });
    const future = evidence(
      "asof-future-observation",
      "1849812345000000002",
      { likes: 1_000_000 },
      observationOverrides(FUTURE_OBSERVATION)
    );
    const baseline = requiredEvidence(
      normalizeEvidenceScores([target], { asOf: AS_OF }),
      target.id
    );
    const scored = normalizeEvidenceScores([target, future], { asOf: AS_OF });

    expect(requiredEvidence(scored, target.id).contributionScore).toBe(
      baseline.contributionScore
    );
    expect(requiredEvidence(scored, future.id)).toMatchObject({
      contributionScore: 0,
      normalizedScore: 0
    });
    expect(requiredEvidence(scored, future.id).why).toContain("future_observation");
  });

  it("does not let an unreviewed duplicate erase a verified scoring row", () => {
    const postId = "1849812345000000003";
    const verified = evidence(
      "verified-duplicate",
      postId,
      { likes: 100 },
      observationOverrides(STALE_OBSERVATION)
    );
    const unreviewed = evidence(
      "unreviewed-duplicate",
      postId,
      { views: Number.MAX_SAFE_INTEGER, likes: Number.MAX_SAFE_INTEGER, replies: 1_000 },
      { review_state: undefined }
    );
    const baseline = requiredEvidence(
      normalizeEvidenceScores([verified], { asOf: AS_OF }),
      verified.id
    );

    expect(dedupeEvidenceForScoring([verified, unreviewed])).toEqual([verified]);
    expect(dedupeEvidenceForScoring([unreviewed, verified])).toEqual([verified]);

    for (const rows of [[verified, unreviewed], [unreviewed, verified]]) {
      const scored = normalizeEvidenceScores(rows, { asOf: AS_OF });
      expect(requiredEvidence(scored, verified.id).contributionScore).toBe(
        baseline.contributionScore
      );
      expect(requiredEvidence(scored, unreviewed.id).contributionScore).toBe(0);
    }
  });

  it("prefers a fresher correction over a stale alias-heavy duplicate", () => {
    const postId = "1849812345000000004";
    const staleAliasHeavy = evidence(
      "stale-alias-heavy",
      postId,
      { comments: 9_000, replies: 9_000, shares: 8_000, reposts: 8_000 },
      observationOverrides(STALE_OBSERVATION)
    );
    const freshCorrection = evidence("fresh-correction", postId, {
      replies: 9,
      reposts: 8
    });

    expect(computeEvidenceRawEngagement("x", staleAliasHeavy.metrics)).toBeGreaterThan(
      computeEvidenceRawEngagement("x", freshCorrection.metrics)
    );
    expect(dedupeEvidenceForScoring([staleAliasHeavy, freshCorrection])).toEqual([
      freshCorrection
    ]);
    expect(dedupeEvidenceForScoring([freshCorrection, staleAliasHeavy])).toEqual([
      freshCorrection
    ]);
  });

  it("keeps duplicate selection order-invariant with overflow-scale ignored metrics", () => {
    const postId = "1849812345000000005";
    const alpha = evidence("overflow-alpha", postId, {
      likes: 10,
      followers: Number.MAX_VALUE,
      unknown_alpha: Number.MAX_VALUE
    });
    const omega = evidence("overflow-omega", postId, {
      likes: 10,
      subscribers: Number.MAX_VALUE,
      unknown_omega: Number.MAX_VALUE
    });

    expect(computeEvidenceRawEngagement("x", alpha.metrics)).toBe(
      computeEvidenceRawEngagement("x", omega.metrics)
    );
    expect(dedupeEvidenceForScoring([alpha, omega])).toEqual([alpha]);
    expect(dedupeEvidenceForScoring([omega, alpha])).toEqual([alpha]);
  });

  it("keeps deprecated scorePost deterministic when collectedAt is omitted", () => {
    const input = {
      postId: "legacy-without-collected-at",
      platform: "x" as const,
      metrics: { views: 10_000, likes: 100, replies: 5 },
      postedAt: AS_OF
    };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
      const earlierWallClock = scorePost(input);
      vi.setSystemTime(new Date("2036-07-17T12:00:00.000Z"));
      const laterWallClock = scorePost(input);

      expect(laterWallClock).toEqual(earlierWallClock);
      expect(earlierWallClock.explanationJson.ageDays).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function evidence(
  id: string,
  postId: string,
  metrics: EvidenceMetrics,
  overrides: Partial<EvidenceItem> = {}
): EvidenceItem {
  return {
    id,
    entityType: "company",
    entityId: "redteam-company",
    platform: "x",
    authorName: "Red Team Fixture",
    authorHandle: "redteamfixture",
    postedAt: STALE_OBSERVATION,
    publishedAtPrecision: "exact",
    observedAt: AS_OF,
    metricsCheckedAt: AS_OF,
    text: "Canonical v4 red-team regression fixture",
    mediaType: "text",
    linkStatus: "verified",
    metrics,
    contributionScore: 1,
    sourceUrl: `https://x.com/redteamfixture/status/${postId}`,
    platformPostId: postId,
    first_seen_at: AS_OF,
    last_checked_at: AS_OF,
    last_updated_at: AS_OF,
    why: "Deterministic red-team regression fixture.",
    review_state: "verified",
    ...overrides
  };
}

function observationOverrides(observedAt: string): Partial<EvidenceItem> {
  return {
    observedAt,
    metricsCheckedAt: observedAt,
    first_seen_at: observedAt,
    last_checked_at: observedAt,
    last_updated_at: observedAt
  };
}

function requiredEvidence(rows: EvidenceItem[], id: string): EvidenceItem {
  const row = rows.find((item) => item.id === id);
  if (!row) throw new Error(`Missing evidence fixture ${id}`);
  return row;
}
