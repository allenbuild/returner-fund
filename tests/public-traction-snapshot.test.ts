import { describe, expect, it } from "vitest";
import publicEvidence from "@/lib/social/public-evidence-current.json";

describe("public traction snapshot", () => {
  it("stores public source evidence with required timestamps and raw visible text", () => {
    expect(publicEvidence.evidence.length).toBeGreaterThan(0);
    expect(publicEvidence.evidence.some((item) => item.platform !== "github")).toBe(true);

    for (const item of publicEvidence.evidence) {
      expect(item.platform).toBeTruthy();
      expect(item.sourceUrl).toMatch(/^https?:\/\//);
      expect(item.rawVisibleText).toEqual(expect.any(String));
      expect(item.first_seen_at).toEqual(expect.any(String));
      expect(item.last_checked_at).toEqual(expect.any(String));
      expect(item.last_updated_at).toEqual(expect.any(String));
      expect(item.review_state).toBe("verified");
    }
  });

  it("keeps blocked or unclear public platform attempts out of scoring", () => {
    expect(publicEvidence.failures.some((item) => item.platform === "reddit")).toBe(true);
    expect(publicEvidence.failures.some((item) => item.platform === "instagram")).toBe(true);
  });

  it("keeps unrelated Product Hunt candidates out of the review queue", () => {
    const productHuntReviewUrls = publicEvidence.needsReview
      .filter((item) => item.platform === "product_hunt")
      .map((item) => item.candidateUrl);
    const repeatedUrls = productHuntReviewUrls.filter((url, index) => productHuntReviewUrls.indexOf(url) !== index);

    expect(productHuntReviewUrls).not.toContain("https://www.producthunt.com/products/screen-studio");
    expect(repeatedUrls).toEqual([]);
  });

  it("stores web and RSS context without letting metadata affect traction scores", () => {
    const contextOnly = publicEvidence.evidence.filter((item) => item.platform === "web" || item.platform === "rss");
    expect(contextOnly.length).toBeGreaterThan(0);
    expect(contextOnly.every((item) => item.contributionScore === 0)).toBe(true);
  });

  it("does not score social profile pages as post traction", () => {
    const socialProfiles = publicEvidence.evidence.filter(
      (item) =>
        ["x", "linkedin", "instagram"].includes(item.platform) &&
        /profile stored as identity context only/i.test(item.matchReason ?? "")
    );

    expect(socialProfiles.length).toBeGreaterThan(0);
    expect(socialProfiles.every((item) => item.contributionScore === 0)).toBe(true);
  });
});
