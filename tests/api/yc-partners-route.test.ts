import { beforeEach, describe, expect, it, vi } from "vitest";
import type { YcPartnersResponse } from "@/lib/yc-partners/favorite-contracts";

const loadYcPartnerFavorites = vi.fn();

vi.mock("@/lib/yc-partners/server", () => ({
  loadYcPartnerFavorites
}));

const responseFixture: YcPartnersResponse = {
  generatedAt: "2026-08-13T12:00:00.000Z",
  modelVersion: "conviction-v2",
  modelName: "YC partner conviction score",
  batchCount: 2,
  companyCount: 3,
  partnerCount: 1,
  partners: [
    {
      partnerId: "brad-flora",
      partnerName: "Brad Flora",
      category: "yc_partner",
      rankingCount: 1,
      supportingEvidenceCount: 1,
      confidence: {
        level: "medium",
        score: 62,
        reasons: ["Evidence is attributable to the partner."],
        uniqueEvidenceCount: 1,
        uniquePlatformCount: 1,
        uniqueContextCount: 1,
        datedEvidenceCount: 1,
        verifiedLinkCount: 1
      },
      updatedAt: "2026-08-13T12:00:00.000Z",
      topFavorite: {
        rank: 1,
        companyId: "kara",
        companyName: "Kara",
        batchSlug: "s26",
        batchLabel: "Summer 2026",
        score: 86,
        confidence: {
          level: "medium",
          score: 62,
          reasons: ["Evidence is attributable to the partner."],
          uniqueEvidenceCount: 1,
          uniquePlatformCount: 1,
          uniqueContextCount: 1,
          datedEvidenceCount: 1,
          verifiedLinkCount: 1
        },
        evidenceCount: 1,
        primaryReason: "Used a strong superlative and gave specific reasons about the team and market.",
        citations: [
          {
            evidenceId: "post-1",
            sourceUrl: "https://example.com/post-1",
            platform: "linkedin",
            postedAt: "2026-08-12T12:00:00.000Z",
            excerpt: "Hard to think of a better team.",
            reason: "Used a strong superlative and gave specific reasons about the team and market.",
            signalType: "explicit_superlative",
            scoreContribution: 78
          }
        ],
        breakdown: {
          strongestEvidenceScore: 78,
          secondaryEvidenceBonus: 0,
          independentContextBonus: 0,
          negativePenalty: 0,
          convictionStrength: 100,
          praiseStrength: 100,
          specificity: 54,
          contextQuality: 100,
          uniqueEvidenceCount: 1,
          uniquePlatformCount: 1,
          uniqueContextCount: 1,
          signalTypes: ["explicit_superlative"]
        }
      },
      rankings: []
    }
  ]
};

describe("/api/yc-partners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadYcPartnerFavorites.mockResolvedValue(responseFixture);
  });

  it("passes cleaned filters to the loader and returns the documented response contract", async () => {
    const { GET } = await import("@/app/api/yc-partners/route");
    const response = await GET(new Request(
      "http://localhost/api/yc-partners?partner=%20brad-flora%20&batch=%20s26%20&includeNoEvidence=true"
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(loadYcPartnerFavorites).toHaveBeenCalledWith({
      partnerId: "brad-flora",
      batchSlug: "s26",
      includeNoEvidence: true
    });
    expect(response.headers.get("cache-control")).toContain("s-maxage=60");
    expect(response.headers.get("x-yc-partner-favorite-model")).toBe("conviction-v2");
    expect(body).toEqual(responseFixture);
    expect(body.partners[0].topFavorite.citations[0]).toMatchObject({
      sourceUrl: "https://example.com/post-1",
      excerpt: "Hard to think of a better team.",
      reason: expect.any(String)
    });
  });

  it("uses the all-partners defaults when no filters are supplied", async () => {
    const { GET } = await import("@/app/api/yc-partners/route");
    const response = await GET(new Request("http://localhost/api/yc-partners"));

    expect(response.status).toBe(200);
    expect(loadYcPartnerFavorites).toHaveBeenCalledWith({
      partnerId: undefined,
      batchSlug: undefined,
      includeNoEvidence: true
    });
  });

  it("returns a sanitized service-unavailable response when the loader fails", async () => {
    loadYcPartnerFavorites.mockRejectedValueOnce(new Error("fixture failure"));
    const { GET } = await import("@/app/api/yc-partners/route");

    const response = await GET(new Request("http://localhost/api/yc-partners"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "YC partner favorites are temporarily unavailable." });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(body)).not.toContain("fixture failure");
  });
});
