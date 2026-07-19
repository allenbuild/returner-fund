import { describe, expect, it } from "vitest";
import publicEvidence from "@/lib/social/public-evidence-current.json";

const SUPPORTED_METRICS: Record<string, string[]> = {
  x: ["views", "likes", "replies", "comments", "reposts", "shares", "quotes"],
  linkedin: ["views", "likes", "reactions", "comments", "reposts", "shares"],
  instagram: ["views", "likes", "comments", "shares", "reposts", "saves"],
  product_hunt: ["upvotes", "comments"],
  youtube: ["views", "likes", "comments"],
  hacker_news: ["upvotes", "comments"],
  reddit: ["upvotes", "comments"],
  github: ["stars", "forks", "watchers", "issues", "open_issues", "recent_commits_30d"]
};

function isNativeContentUrl(platform: string, rawUrl: string) {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/\/$/, "");
  if (platform === "x") return /\/[^/]+\/status\/\d+$/i.test(path);
  if (platform === "instagram") return /^\/(?:p|reel|tv)\/[^/]+$/i.test(path);
  if (platform === "linkedin") return /\/feed\/update\/urn:li:activity:\d+$|\/posts\/[^/]*?activity-\d+/i.test(path);
  if (platform === "youtube") return (path === "/watch" && Boolean(url.searchParams.get("v"))) || /^\/shorts\/[^/]+$/i.test(path);
  if (platform === "product_hunt") return /^\/(?:posts|products)\/[^/]+$/i.test(path);
  if (platform === "hacker_news") return url.hostname === "news.ycombinator.com" && path === "/item" && /^\d+$/.test(url.searchParams.get("id") ?? "");
  if (platform === "reddit") return /\/comments\/[^/]+/i.test(path);
  if (platform === "github") return path.split("/").filter(Boolean).length === 2;
  return false;
}

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
      expect(["verified", "needs_review"]).toContain(item.review_state);
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
    expect(socialProfiles.every((item) => item.review_state === "needs_review")).toBe(true);
  });

  it("keeps every positive row native, verified, and backed by a supported visible metric", () => {
    const positiveRows = publicEvidence.evidence.filter((item) => item.contributionScore > 0);

    expect(positiveRows.length).toBeGreaterThan(0);
    for (const item of positiveRows) {
      const metrics = item.metrics as Record<string, number | null | undefined>;
      expect(item.review_state).toBe("verified");
      expect(isNativeContentUrl(item.platform, item.sourceUrl)).toBe(true);
      expect((SUPPORTED_METRICS[item.platform] ?? []).some((metric) => Number(metrics[metric]) > 0)).toBe(true);
    }
  });

  it("stores Hacker News discussion URLs and numeric LinkedIn activity IDs", () => {
    const hackerNewsRows = publicEvidence.evidence.filter((item) => item.platform === "hacker_news");
    const linkedInPostRows = publicEvidence.evidence.filter(
      (item) => item.platform === "linkedin" && item.contributionScore > 0
    );

    expect(hackerNewsRows.length).toBeGreaterThan(0);
    expect(linkedInPostRows.length).toBeGreaterThan(0);
    expect(hackerNewsRows.every((item) => /^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/.test(item.sourceUrl))).toBe(true);
    expect(hackerNewsRows.every((item) => /^\d+$/.test(String(item.platformPostId)))).toBe(true);
    expect(linkedInPostRows.every((item) => /^\d+$/.test(String(item.platformPostId)))).toBe(true);
  });

  it("does not keep generic Context.dev YouTube false positives", () => {
    const sourceUrls = publicEvidence.evidence
      .filter((item) => item.companySlug === "contextdev" && item.platform === "youtube")
      .map((item) => item.sourceUrl);

    expect(sourceUrls).not.toContain("https://www.youtube.com/watch?v=bSG9wUYaHWU");
    expect(sourceUrls).not.toContain("https://www.youtube.com/watch?v=UUrd9WCQKtc");
  });
});
