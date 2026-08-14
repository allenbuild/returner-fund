import { describe, expect, it } from "vitest";
import type { EvidenceItem, Platform, TopVoiceMember } from "@/lib/graph/types";
import {
  analyzeFavoriteEvidence,
  scoreFavoritePair
} from "@/lib/yc-partners/favorite-scoring";

const partner: TopVoiceMember = {
  personId: "test-partner",
  displayName: "Test Partner",
  aliases: ["Test Partner"],
  handles: { x: ["testpartner"], linkedin: ["test-partner"] },
  category: "yc_partner",
  weight: 1,
  active: true,
  source: "unit-test"
};

function evidence(
  id: string,
  text: string,
  overrides: Partial<EvidenceItem> = {}
): EvidenceItem {
  const platform = overrides.platform ?? "x";
  return {
    id,
    batchSlug: "S26",
    entityType: "company",
    entityId: "company-kara",
    platform,
    authorName: "Test Partner",
    authorHandle: platform === "linkedin" ? "test-partner" : "testpartner",
    postedAt: "2026-07-01T12:00:00.000Z",
    publishedAtPrecision: "exact",
    text,
    mediaType: "text",
    metrics: {},
    contributionScore: 1,
    sourceUrl: sourceUrl(platform, id),
    linkStatus: "verified",
    review_state: "verified",
    why: "unit-test evidence",
    attachedCompanyId: "company-kara",
    attachedCompanyName: "Kara",
    topVoice: {
      audienceId: "yc_partners",
      memberId: partner.personId,
      displayName: partner.displayName,
      category: partner.category,
      weight: partner.weight,
      matchedBy: "handle testpartner",
      originalContributionScore: 1
    },
    ...overrides
  };
}

function sourceUrl(platform: Platform, id: string): string {
  if (platform === "linkedin") {
    return `https://www.linkedin.com/feed/update/urn:li:activity:${id}`;
  }
  return `https://x.com/testpartner/status/${id}`;
}

const strongEndorsement =
  "Kara has arguably the strongest founder-market fit in the batch. It is hard to think of a better team building this scientific hardware platform.";

describe("YC partner favorite scoring", () => {
  it("ranks one strong superlative above many weak mentions", () => {
    const strong = scoreFavoritePair(partner, [evidence("1001", strongEndorsement)]);
    const weak = scoreFavoritePair(
      partner,
      Array.from({ length: 20 }, (_, index) => evidence(String(1100 + index), "Kara"))
    );

    expect(analyzeFavoriteEvidence(evidence("1002", strongEndorsement)).signalType).toBe(
      "explicit_superlative"
    );
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.breakdown.strongestEvidenceScore).toBeGreaterThan(
      weak.breakdown.secondaryEvidenceBonus + weak.breakdown.strongestEvidenceScore
    );
  });

  it("keeps the exact sentences that contain the scoring signal", () => {
    const result = scoreFavoritePair(partner, [evidence("1003", strongEndorsement)]);

    expect(result.citations[0]?.verbatimContributingSentences).toEqual([
      "Kara has arguably the strongest founder-market fit in the batch.",
      "It is hard to think of a better team building this scientific hardware platform."
    ]);
    expect(result.citations[0]?.contributingSentences).toEqual([
      "Kara has arguably the strongest founder-market fit in the batch.",
      "It is hard to think of a better team building this scientific hardware platform."
    ]);
  });

  it("keeps a neutral mention at a low favorite score", () => {
    const result = scoreFavoritePair(partner, [evidence("2001", "Kara")]);

    expect(result.score).toBeLessThan(30);
    expect(result.confidence.level).toBe("medium");
    expect(result.citations[0]?.signalType).toBe("neutral_mention");
    expect(result.primaryReason).toContain("without much additional commentary");
  });

  it("applies diminishing returns and caps secondary mention bonuses", () => {
    const one = scoreFavoritePair(partner, [evidence("3001", "Kara")]);
    const two = scoreFavoritePair(partner, [
      evidence("3001", "Kara"),
      evidence("3002", "Kara")
    ]);
    const six = scoreFavoritePair(
      partner,
      Array.from({ length: 6 }, (_, index) => evidence(String(3010 + index), "Kara"))
    );
    const thirty = scoreFavoritePair(
      partner,
      Array.from({ length: 30 }, (_, index) => evidence(String(3100 + index), "Kara"))
    );

    expect(two.score).toBeGreaterThan(one.score);
    expect(six.score).toBeGreaterThan(two.score);
    expect(six.breakdown.secondaryEvidenceBonus).toBe(16);
    expect(thirty.breakdown.secondaryEvidenceBonus).toBe(16);
    expect(thirty.score).toBe(six.score);
  });

  it("suppresses duplicate physical posts before scoring and citing", () => {
    const original = evidence("4001", "Kara");
    const duplicate = evidence("4002", "Kara", {
      sourceUrl: original.sourceUrl,
      platformPostId: original.platformPostId
    });
    const single = scoreFavoritePair(partner, [original]);
    const duplicated = scoreFavoritePair(partner, [original, duplicate]);

    expect(duplicated.score).toBe(single.score);
    expect(duplicated.breakdown.uniqueEvidenceCount).toBe(1);
    expect(duplicated.confidence.uniqueEvidenceCount).toBe(1);
    expect(duplicated.citations).toHaveLength(1);
  });

  it("subtracts a negative commentary penalty from an otherwise positive ranking", () => {
    const positive = scoreFavoritePair(partner, [evidence("5001", strongEndorsement)]);
    const mixed = scoreFavoritePair(partner, [
      evidence("5001", strongEndorsement),
      evidence("5002", "I am concerned about Kara's weak market and risky team.")
    ]);

    expect(mixed.breakdown.negativePenalty).toBeGreaterThan(0);
    expect(mixed.citations.some((citation) => citation.signalType === "negative_commentary")).toBe(
      true
    );
    expect(mixed.score).toBeLessThan(positive.score);
  });

  it("raises confidence for dated, verified, multi-context evidence", () => {
    const lowConfidencePartner = { ...partner, active: false };
    const low = scoreFavoritePair(
      lowConfidencePartner,
      [
        evidence("6001", "Kara", {
          postedAt: "not-a-date",
          linkStatus: "unchecked",
          review_state: "needs_review",
          contributionScore: 0
        })
      ]
    );
    const high = scoreFavoritePair(partner, [
      evidence("6010", strongEndorsement),
      evidence("6011", "I am excited about Kara's team and product; this will be big."),
      evidence("6012", "Kara has impressive technology, market traction, and a strong moat.", {
        platform: "linkedin"
      }),
      evidence("6013", "Congrats Kara, this platform is worth watching.", {
        platform: "linkedin"
      })
    ]);

    expect(low.confidence.level).toBe("low");
    expect(low.confidence.score).toBeLessThan(high.confidence.score);
    expect(high.confidence.level).toBe("high");
    expect(high.confidence.uniquePlatformCount).toBe(2);
    expect(high.confidence.uniqueContextCount).toBeGreaterThan(1);
    expect(high.confidence.datedEvidenceCount).toBe(4);
    expect(high.confidence.verifiedLinkCount).toBe(4);
    expect(high.confidence.reasons).toContain("Evidence spans multiple platforms.");
  });

  it("is deterministic regardless of input order and uses stable tie-breaking", () => {
    const rows = [
      evidence("7002", "Kara"),
      evidence("7001", "Kara"),
      evidence("7003", "Kara has an impressive product and market.")
    ];
    const forward = scoreFavoritePair(partner, rows);
    const reversed = scoreFavoritePair(partner, [...rows].reverse());

    expect(reversed).toEqual(forward);
    expect(forward.analyses.map((analysis) => analysis.evidenceId)).toEqual([
      "7003",
      "7001",
      "7002"
    ]);
  });

  it("scores the preserved full body and ignores attribution-summary titles", () => {
    const result = scoreFavoritePair(partner, [evidence("1004", "Kara", {
      title: "Partner's strongest endorsement of Kara",
      originalText: "Kara has arguably the strongest founder-market fit in the batch."
    })]);

    expect(result.citations[0]?.verbatimContributingSentences).toEqual([
      "Kara has arguably the strongest founder-market fit in the batch."
    ]);

    const summaryOnly = scoreFavoritePair(partner, [evidence("1005", "Kara", {
      title: "Partner used strongest endorsement for Kara"
    })]);
    expect(summaryOnly.citations[0]?.verbatimContributingSentences).toEqual(["Kara"]);
    expect(summaryOnly.citations[0]?.signalType).toBe("neutral_mention");
  });

  it("does not score provenance summaries as partner-authored evidence", () => {
    const result = scoreFavoritePair(partner, [evidence("1006", "Garry Tan replied to Kara", {
      title: "Garry Tan replied to Kara"
    })]);

    expect(result.score).toBe(0);
    expect(result.confidence.score).toBe(0);
    expect(result.citations).toHaveLength(0);
  });
});
