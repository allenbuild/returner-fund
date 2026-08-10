import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PublicEvidenceRow {
  platform: string;
  sourceUrl: string;
  rawVisibleText: string;
  first_seen_at: string;
  last_checked_at: string;
  last_updated_at: string;
  review_state: string;
  contributionScore: number;
  metrics: Record<string, number | null | undefined>;
  matchReason?: string;
  companySlug?: string;
  platformPostId?: string | null;
  postedAt?: string | null;
  publishedAtPrecision?: string;
  linkStatus?: string;
  attributionStatus?: string;
  attributionSignals?: string[];
  _recoveryProvenance?: {
    schemaVersion?: number;
    officialHost?: string;
    officialWebsiteUrl?: string;
    contentSha256?: string;
    zeroEngagementAccepted?: boolean;
  };
}

interface PublicReviewRow {
  platform: string;
  candidateUrl: string;
  entityType?: string;
  entityId: string;
  review_state: string;
  contributionScore?: number;
  reason?: string;
  matchReason?: string;
}

interface PublicEvidenceFixture {
  evidence: PublicEvidenceRow[];
  needsReview: PublicReviewRow[];
  failures: Array<{ platform?: string }>;
}

interface PublicEvidenceCanonical extends Omit<PublicEvidenceFixture, "failures" | "needsReview"> {
  operationalLedgerRef: {
    path: string;
    sha256: string;
    bytes: number;
    counts: { failures: number };
  };
  reviewLedgerRef: {
    path: string;
    sha256: string;
    bytes: number;
    counts: { needsReview: number; attributionReconciliationLedger: number };
  };
}

// Load the split source artifacts at runtime. Static JSON imports ask Vite to
// compile large operational ledgers into a JavaScript AST, multiplying memory
// use while changing none of these source-integrity assertions.
const publicEvidenceCanonical = JSON.parse(
  readFileSync(join(process.cwd(), "src/lib/social/public-evidence-current.json"), "utf8")
) as PublicEvidenceCanonical;
const publicEvidenceOperationalLedgerBytes = readFileSync(
  join(process.cwd(), publicEvidenceCanonical.operationalLedgerRef.path)
);
const publicEvidenceOperationalLedger = JSON.parse(
  publicEvidenceOperationalLedgerBytes.toString("utf8")
) as Pick<PublicEvidenceFixture, "failures">;
const publicEvidenceReviewLedgerBytes = readFileSync(
  join(process.cwd(), publicEvidenceCanonical.reviewLedgerRef.path)
);
const publicEvidenceReviewLedger = JSON.parse(
  publicEvidenceReviewLedgerBytes.toString("utf8")
) as Pick<PublicEvidenceFixture, "needsReview"> & {
  attributionReconciliationLedger: unknown[];
};
if (
  publicEvidenceOperationalLedgerBytes.length !== publicEvidenceCanonical.operationalLedgerRef.bytes ||
  createHash("sha256").update(publicEvidenceOperationalLedgerBytes).digest("hex") !==
    publicEvidenceCanonical.operationalLedgerRef.sha256 ||
  publicEvidenceOperationalLedger.failures.length !==
    publicEvidenceCanonical.operationalLedgerRef.counts.failures
) {
  throw new Error("Public evidence operational ledger reference failed integrity verification.");
}
if (
  publicEvidenceReviewLedgerBytes.length !== publicEvidenceCanonical.reviewLedgerRef.bytes ||
  createHash("sha256").update(publicEvidenceReviewLedgerBytes).digest("hex") !==
    publicEvidenceCanonical.reviewLedgerRef.sha256 ||
  publicEvidenceReviewLedger.needsReview.length !==
    publicEvidenceCanonical.reviewLedgerRef.counts.needsReview ||
  publicEvidenceReviewLedger.attributionReconciliationLedger.length !==
    publicEvidenceCanonical.reviewLedgerRef.counts.attributionReconciliationLedger
) {
  throw new Error("Public evidence review ledger reference failed integrity verification.");
}
const publicEvidence: PublicEvidenceFixture = {
  ...publicEvidenceCanonical,
  ...publicEvidenceOperationalLedger,
  ...publicEvidenceReviewLedger
};

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
  if (platform === "product_hunt") {
    return /^\/(?:posts|products)\/[^/]+$/i.test(path)
      || /^\/products\/[^/]+\/launches\/[^/]+$/i.test(path);
  }
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
    const productHuntReviews = publicEvidence.needsReview
      .filter((item) => item.platform === "product_hunt");
    const productHuntReviewUrls = productHuntReviews.map((item) => item.candidateUrl);
    const attributionsByUrl = new Map<string, Set<string>>();
    for (const item of productHuntReviews) {
      const owners = attributionsByUrl.get(item.candidateUrl) ?? new Set<string>();
      owners.add(`${item.entityType ?? "company"}:${item.entityId}`);
      attributionsByUrl.set(item.candidateUrl, owners);
    }
    const conflictingUrls = [...attributionsByUrl]
      .filter(([, owners]) => owners.size > 1)
      .map(([url]) => url);

    expect(productHuntReviewUrls).not.toContain("https://www.producthunt.com/products/screen-studio");
    expect(conflictingUrls).toEqual([]);
  });

  it("keeps unsupported web and RSS context quarantined and unscored", () => {
    const publishedContext = publicEvidence.evidence.filter(
      (item) => item.platform === "web" || item.platform === "rss"
    );
    const quarantinedContext = publicEvidence.needsReview.filter(
      (item) => item.platform === "web" || item.platform === "rss"
    );

    expect(publishedContext).toEqual([]);
    expect(quarantinedContext.length).toBeGreaterThan(0);
    expect(quarantinedContext.every((item) => item.review_state === "needs_review")).toBe(true);
    expect(quarantinedContext.every((item) => Number(item.contributionScore ?? 0) === 0)).toBe(true);
    expect(
      quarantinedContext.some((item) =>
        /unsupported_platform:(?:web|rss)/i.test(item.reason ?? item.matchReason ?? "")
      )
    ).toBe(true);
  });

  it("does not score social profile pages as post traction", () => {
    const publishedSocialProfiles = publicEvidence.evidence.filter(
      (item) =>
        ["x", "linkedin", "instagram"].includes(item.platform) &&
        /identity context only/i.test(item.matchReason ?? "")
    );
    const quarantinedSocialProfiles = publicEvidence.needsReview.filter(
      (item) =>
        ["x", "linkedin", "instagram"].includes(item.platform) &&
        /identity context only/i.test(item.matchReason ?? "")
    );

    expect(publishedSocialProfiles).toEqual([]);
    expect(quarantinedSocialProfiles.length).toBeGreaterThan(0);
    expect(quarantinedSocialProfiles.every((item) => (item.contributionScore ?? 0) === 0)).toBe(true);
    expect(quarantinedSocialProfiles.every((item) => item.review_state === "needs_review")).toBe(true);
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

  it("keeps the Arctic Health LinkedIn metrics tied to the native post", () => {
    const row = publicEvidence.evidence.find(
      (item) => item.platform === "linkedin" && item.platformPostId === "7479951057700306944"
    );

    expect(row).toBeDefined();
    expect(row?.metrics).toEqual({ reactions: 16, comments: 0 });
  });
});
