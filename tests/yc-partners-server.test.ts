import { describe, expect, it } from "vitest";
import { loadYcPartnerFavorites } from "@/lib/yc-partners/server";

describe("YC partner favorite materialization", () => {
  it("aggregates the published partner snapshots across all supported batches", async () => {
    const response = await loadYcPartnerFavorites({ partnerId: "brad-flora" });

    expect(response.modelVersion).toBe("conviction-v2");
    expect(response.batchCount).toBeGreaterThanOrEqual(2);
    expect(response.companyCount).toBeGreaterThan(0);
    expect(response.partners).toHaveLength(1);
    expect(response.partners[0]?.partnerId).toBe("brad-flora");
    expect(response.partners[0]?.rankings.length).toBeGreaterThan(0);
    expect(response.partners[0]?.rankings[0]?.score).toBeGreaterThan(0);
    expect(response.partners[0]?.rankings[0]?.citations[0]?.sourceUrl).toMatch(/^https?:\/\//);
  }, 60_000);

  it("includes a partner's commentary on another partner's company, but only in the requested batch", async () => {
    const response = await loadYcPartnerFavorites({
      partnerId: "jared-friedman",
      batchSlug: "S26",
      includeNoEvidence: false
    });
    const partner = response.partners[0];
    const screenpipe = partner?.rankings.find((ranking) => ranking.companyName === "screenpipe");

    // screenpipe's catalog group partner is Gustaf Alstromer. Jared's own
    // attributable post must still appear in Jared's S26 profile.
    expect(screenpipe).toMatchObject({
      batchSlug: "S26",
      companyName: "screenpipe"
    });
    expect(screenpipe?.confidence.score).toBeGreaterThan(0);
    expect(screenpipe?.citations[0]).toMatchObject({
      sourceUrl: "https://x.com/snowmaker/status/2068734568472207470"
    });
    expect(screenpipe?.citations[0]?.verbatimContributingSentences?.join(" ").trim()).not.toBe("");
    expect(partner?.rankings.every((ranking) => ranking.batchSlug === "S26")).toBe(true);
  }, 60_000);
});
