import { describe, expect, it } from "vitest";
import {
  applyAttributionGuard,
  auditEvidenceAttribution,
  buildAttributionContext,
  type AttributionCompanyProfile
} from "@/lib/graph/evidence-attribution";
import type { EvidenceItem, Platform } from "@/lib/graph/types";

const companies: AttributionCompanyProfile[] = [
  {
    id: "company-alpha-ai",
    name: "Alpha AI",
    slug: "alpha-ai",
    websiteUrl: "https://alpha.ai",
    socialLinks: [{ platform: "x", url: "https://x.com/alphaai" }],
    founders: [
      {
        id: "founder-alpha-ai-ana",
        name: "Ana Alpha",
        socialLinks: [{ platform: "x", url: "https://x.com/anaalpha" }]
      }
    ]
  },
  {
    id: "company-beta-robots",
    name: "Beta Robots",
    slug: "beta-robots",
    websiteUrl: "https://betarobots.com",
    socialLinks: [{ platform: "youtube", url: "https://www.youtube.com/@betarobots" }],
    founders: []
  },
  {
    id: "company-standout",
    name: "Standout",
    slug: "standout",
    websiteUrl: "https://standout.work",
    socialLinks: [{ platform: "x", url: "https://x.com/standoutwork" }],
    founders: []
  }
];

const context = buildAttributionContext(companies);

describe("evidence attribution guard", () => {
  it("blocks another company's launch video from scoring for the wrong company", () => {
    const item = evidence({
      platform: "youtube",
      text: "Beta Robots launch demo: warehouse robot fleet in production.",
      sourceUrl: "https://www.youtube.com/watch?v=beta-demo",
      attachedCompanyId: "company-alpha-ai",
      attachedCompanyName: "Alpha AI"
    });

    const audit = auditEvidenceAttribution(item, context);
    const guarded = applyAttributionGuard(item, context);

    expect(audit.reviewState).toBe("needs_review");
    expect(audit.scoreMultiplier).toBe(0);
    expect(audit.conflictingCompanyNames).toContain("Beta Robots");
    expect(guarded.contributionScore).toBe(0);
  });

  it("allows verified company account posts even when the caption is terse", () => {
    const item = evidence({
      platform: "x",
      authorHandle: "alphaai",
      text: "new demo is live",
      sourceUrl: "https://x.com/alphaai/status/123",
      accountUrl: "https://x.com/alphaai",
      attachedCompanyId: "company-alpha-ai",
      attachedCompanyName: "Alpha AI"
    });

    const audit = auditEvidenceAttribution(item, context);

    expect(audit.reviewState).toBe("verified");
    expect(audit.scoreMultiplier).toBe(1);
    expect(audit.risk).toBe("low");
  });

  it("allows verified founder account posts to roll up to the company", () => {
    const item = evidence({
      platform: "x",
      entityType: "founder",
      entityId: "founder-alpha-ai-ana",
      authorHandle: "anaalpha",
      text: "new customer workflow video",
      sourceUrl: "https://x.com/anaalpha/status/456",
      accountUrl: "https://x.com/anaalpha",
      attachedCompanyId: "company-alpha-ai",
      attachedCompanyName: "Alpha AI"
    });

    const audit = auditEvidenceAttribution(item, context);

    expect(audit.reviewState).toBe("verified");
    expect(audit.scoreMultiplier).toBe(1);
  });

  it("holds clear off-topic first-party founder posts for review instead of scoring", () => {
    const item = evidence({
      platform: "x",
      entityType: "founder",
      entityId: "founder-alpha-ai-ana",
      authorHandle: "anaalpha",
      text: "Rented out a theater for a movie night with friends. Tickets below.",
      sourceUrl: "https://x.com/anaalpha/status/654",
      accountUrl: "https://x.com/anaalpha",
      attachedCompanyId: "company-alpha-ai",
      attachedCompanyName: "Alpha AI"
    });

    const audit = auditEvidenceAttribution(item, context);
    const guarded = applyAttributionGuard(item, context);

    expect(audit.reviewState).toBe("needs_review");
    expect(audit.scoreMultiplier).toBe(0);
    expect(audit.risk).toBe("medium");
    expect(guarded.contributionScore).toBe(0);
  });

  it("does not confuse support-ticket product language with off-topic social chatter", () => {
    const item = evidence({
      platform: "x",
      authorHandle: "alphaai",
      text: "New onboarding demo reduces support tickets by guiding users through the product.",
      sourceUrl: "https://x.com/alphaai/status/655",
      accountUrl: "https://x.com/alphaai",
      attachedCompanyId: "company-alpha-ai",
      attachedCompanyName: "Alpha AI"
    });

    const audit = auditEvidenceAttribution(item, context);

    expect(audit.reviewState).toBe("verified");
    expect(audit.scoreMultiplier).toBe(1);
    expect(audit.risk).toBe("low");
  });

  it("blocks verified account posts that visibly promote another company without a target signal", () => {
    const item = evidence({
      platform: "x",
      entityType: "founder",
      entityId: "founder-alpha-ai-ana",
      authorHandle: "anaalpha",
      text: "The Beta Robots launch video is incredible. Everyone should watch @betarobots.",
      sourceUrl: "https://x.com/anaalpha/status/789",
      accountUrl: "https://x.com/anaalpha",
      attachedCompanyId: "company-alpha-ai",
      attachedCompanyName: "Alpha AI"
    });

    const audit = auditEvidenceAttribution(item, context);
    const guarded = applyAttributionGuard(item, context);

    expect(audit.reviewState).toBe("needs_review");
    expect(audit.scoreMultiplier).toBe(0);
    expect(audit.risk).toBe("high");
    expect(audit.conflictingCompanyNames).toContain("Beta Robots");
    expect(guarded.contributionScore).toBe(0);
  });

  it("blocks quote-like X rows without visible target-company identity", () => {
    const item = evidence({
      platform: "x",
      entityType: "founder",
      entityId: "founder-alpha-ai-ana",
      authorHandle: "anaalpha",
      text: "Vibe coding my house Quote Y Combinator @ycombinator · May 29 It is never been easier to design your dream house. @DraftedAI generates floor plans.",
      rawVisibleText: JSON.stringify({
        author: "anaalpha",
        name: "Ana Alpha",
        text: "Vibe coding my house\nQuote\nY Combinator\n@ycombinator\nIt is never been easier to design your dream house. @DraftedAI generates floor plans."
      }),
      sourceUrl: "https://x.com/anaalpha/status/101112",
      accountUrl: "https://x.com/anaalpha",
      attachedCompanyId: "company-alpha-ai",
      attachedCompanyName: "Alpha AI"
    });

    const audit = auditEvidenceAttribution(item, context);
    const guarded = applyAttributionGuard(item, context);

    expect(audit.reviewState).toBe("needs_review");
    expect(audit.scoreMultiplier).toBe(0);
    expect(audit.risk).toBe("high");
    expect(guarded.contributionScore).toBe(0);
  });

  it("does not confuse generic single-word adjectives with company attribution conflicts", () => {
    const item = evidence({
      platform: "x",
      authorHandle: "alphaai",
      text: "Alpha AI was included in a roundup of standout startups from demo day.",
      sourceUrl: "https://x.com/alphaai/status/987",
      accountUrl: "https://x.com/alphaai",
      attachedCompanyId: "company-alpha-ai",
      attachedCompanyName: "Alpha AI"
    });

    const audit = auditEvidenceAttribution(item, context);

    expect(audit.reviewState).toBe("verified");
    expect(audit.scoreMultiplier).toBe(1);
    expect(audit.conflictingCompanyNames).not.toContain("Standout");
  });

  it("moves weak third-party social evidence to needs review before scoring", () => {
    const item = evidence({
      platform: "youtube",
      text: "Cool YC launch compilation with no clear target mention.",
      sourceUrl: "https://www.youtube.com/watch?v=generic",
      attachedCompanyId: "company-alpha-ai",
      attachedCompanyName: "Alpha AI"
    });

    const guarded = applyAttributionGuard(item, context);

    expect(guarded.review_state).toBe("needs_review");
    expect(guarded.contributionScore).toBe(0);
    expect(guarded.why).toContain("Attribution guard");
  });

  it("does not score unrelated GitHub dependency repos merely because they were attached", () => {
    const item = evidence({
      platform: "github",
      authorName: "thirdparty/huge-runtime",
      authorHandle: "thirdparty",
      text: "thirdparty/huge-runtime: popular distributed runtime library.",
      sourceUrl: "https://github.com/thirdparty/huge-runtime",
      accountUrl: "https://github.com/thirdparty",
      attachedCompanyId: "company-alpha-ai",
      attachedCompanyName: "Alpha AI"
    });

    const guarded = applyAttributionGuard(item, context);

    expect(guarded.review_state).toBe("needs_review");
    expect(guarded.contributionScore).toBe(0);
  });
});

function evidence(overrides: Partial<EvidenceItem> & { platform: Platform; text: string }): EvidenceItem {
  return {
    id: "evidence-test",
    entityType: overrides.entityType ?? "company",
    entityId: overrides.entityId ?? "company-alpha-ai",
    platform: overrides.platform,
    authorName: overrides.authorName ?? "Test Author",
    authorHandle: overrides.authorHandle ?? null,
    postedAt: "2026-06-01T00:00:00Z",
    text: overrides.text,
    mediaType: "video",
    metrics: { views: 100_000, likes: 1_000, comments: 10 },
    contributionScore: 80,
    sourceUrl: overrides.sourceUrl ?? "https://example.com/post",
    rawVisibleText: overrides.rawVisibleText,
    why: "test",
    attachedCompanyId: overrides.attachedCompanyId,
    attachedCompanyName: overrides.attachedCompanyName,
    accountUrl: overrides.accountUrl,
    review_state: "verified"
  };
}
