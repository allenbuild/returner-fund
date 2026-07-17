import { describe, expect, it } from "vitest";
import {
  auditEvidenceAttribution,
  buildAttributionContext,
  type AttributionCompanyProfile
} from "@/lib/graph/evidence-attribution";
import type { EvidenceItem } from "@/lib/graph/types";

const companies: AttributionCompanyProfile[] = [
  {
    id: "company-hexa",
    name: "Hexa",
    slug: "hexa",
    websiteUrl: "https://www.hexaagents.com",
    socialLinks: [{ platform: "linkedin", url: "https://www.linkedin.com/company/hexaagents" }],
    founders: [
      {
        id: "founder-hexa-ishaan-makkar",
        name: "Ishaan Makkar",
        socialLinks: [{ platform: "linkedin", url: "https://www.linkedin.com/in/ishaan-makkar" }]
      }
    ]
  },
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
    id: "company-panacea",
    name: "Panacea",
    slug: "panacea",
    websiteUrl: "https://withpanacea.com",
    socialLinks: [],
    founders: []
  },
  {
    id: "company-care-gp",
    name: "Care GP",
    slug: "care-gp",
    websiteUrl: "https://caregp.com.au",
    socialLinks: [{ platform: "github", url: "https://github.com/orgs/Care-AI-Inc" }],
    founders: []
  }
];

const context = buildAttributionContext(companies);
const genericPostText =
  "Displacing ERPs used to be impossible. AI has made switching costs smaller and the wedge product obvious.";

describe("evidence attribution proof integrity", () => {
  it("rejects the Hexa-style Top Voice row when only generated and accepted metadata names Hexa", () => {
    const item = evidence({
      rawVisibleText: topVoiceRaw(genericPostText),
      matchReason:
        "The shared YC launch card names Hexa, and accepted snapshot metadata maps it to the company.",
      why: "Accepted Top Voice provenance for Hexa."
    });

    const audit = auditEvidenceAttribution(item, context);

    expect(audit.reviewState).toBe("needs_review");
    expect(audit.scoreMultiplier).toBe(0);
    expect(audit.risk).toBe("high");
  });

  it.each([
    ["generated title", { title: "Alpha AI traction post" }],
    [
      "generated title copied into text",
      { title: "Alpha AI traction post", text: "Alpha AI traction post" }
    ],
    ["match reason", { matchReason: "Matched to Alpha AI by an accepted reviewer." }],
    ["why/provenance", { why: "Attached through founder Ana Alpha provenance." }],
    ["generated author-name fallback", { authorName: "Alpha AI" }]
  ])("does not accept %s as entity proof", (_label, overrides) => {
    const item = evidence({
      entityId: "company-alpha-ai",
      attachedCompanyId: "company-alpha-ai",
      attachedCompanyName: "Alpha AI",
      platform: "x",
      sourceUrl: "https://x.com/outsidevoice/status/123",
      title: "Outside Voice post",
      text: "A generic observation about workflow software.",
      rawVisibleText: JSON.stringify({
        post: {
          author: { screen_name: "outsidevoice", name: "Outside Voice" },
          text: "A generic observation about workflow software."
        }
      }),
      matchReason: "Generic fixture provenance.",
      why: "Generic fixture provenance.",
      ...overrides
    });

    const audit = auditEvidenceAttribution(item, context);

    expect(audit.reviewState).toBe("needs_review");
    expect(audit.scoreMultiplier).toBe(0);
  });

  it("accepts a short company name when the native Top Voice body names it", () => {
    const nativeText = "Hexa is replacing legacy ERP workflows for industrial distributors.";
    const item = evidence({
      text: nativeText,
      rawVisibleText: topVoiceRaw(nativeText)
    });

    const audit = auditEvidenceAttribution(item, context);

    expect(audit.reviewState).toBe("verified");
    expect(audit.scoreMultiplier).toBe(1);
    expect(audit.risk).toBe("low");
  });

  it("accepts the company's native source domain without generated entity prose", () => {
    const item = evidence({
      platform: "hacker_news",
      title: "ERP workflow launch",
      text: genericPostText,
      sourceUrl: "https://www.hexaagents.com/launch",
      platformPostId: null,
      rawVisibleText: JSON.stringify({ post: { text: genericPostText } }),
      matchReason: "Generic fixture provenance.",
      why: "Generic fixture provenance."
    });

    const audit = auditEvidenceAttribution(item, context);

    expect(audit.reviewState).toBe("verified");
    expect(audit.scoreMultiplier).toBe(1);
  });

  it("accepts a target signal carried by a native share card", () => {
    const item = evidence({
      rawVisibleText: topVoiceRaw(genericPostText, {
        card: {
          title: "Hexa for industrial distributors",
          description: "AI-native ERP workflows",
          url: "https://www.hexaagents.com/launch",
          domain: "hexaagents.com"
        }
      })
    });

    const audit = auditEvidenceAttribution(item, context);

    expect(audit.reviewState).toBe("verified");
    expect(audit.scoreMultiplier).toBe(1);
  });

  it("accepts a native social mention matching the distinctive company-domain stem", () => {
    const nativeText = "@withpanacea gives FDA consultants AI superpowers and cuts timelines in half.";
    const item = evidence({
      entityId: "company-panacea",
      attachedCompanyId: "company-panacea",
      attachedCompanyName: "Panacea",
      platform: "x",
      sourceUrl: "https://x.com/aaron_epstein/status/2056858519635374466",
      platformPostId: "2056858519635374466",
      text: nativeText,
      rawVisibleText: JSON.stringify({ post: { text: nativeText, authorHandle: "aaron_epstein" } })
    });

    expect(auditEvidenceAttribution(item, context)).toMatchObject({
      reviewState: "verified",
      scoreMultiplier: 1,
      risk: "low"
    });
  });

  it("recognizes a verified GitHub organization URL as the native repository owner", () => {
    const item = evidence({
      entityId: "company-care-gp",
      attachedCompanyId: "company-care-gp",
      attachedCompanyName: "Care GP",
      platform: "github",
      sourceUrl: "https://github.com/Care-AI-Inc/careai-corina-service-releases",
      platformPostId: "Care-AI-Inc/careai-corina-service-releases",
      title: "Care-AI-Inc/careai-corina-service-releases",
      text: "Care-AI-Inc/careai-corina-service-releases: GitHub repository",
      authorHandle: "Care-AI-Inc",
      accountUrl: "https://github.com/Care-AI-Inc",
      rawVisibleText: JSON.stringify({
        profile: { username: "Care-AI-Inc", url: "https://github.com/Care-AI-Inc" },
        post: { text: "Care-AI-Inc/careai-corina-service-releases: GitHub repository" }
      })
    });

    expect(auditEvidenceAttribution(item, context)).toMatchObject({
      reviewState: "verified",
      scoreMultiplier: 1,
      risk: "low"
    });
  });
});

function evidence(overrides: Partial<EvidenceItem>): EvidenceItem {
  return {
    id: "evidence-proof-integrity",
    entityType: "company",
    entityId: "company-hexa",
    platform: "linkedin",
    authorName: "Grey Baker",
    authorHandle: "greysteil",
    postedAt: "2026-06-04T03:25:09.266Z",
    title: "Grey Baker LinkedIn post about Hexa and ERP displacement",
    text: genericPostText,
    mediaType: "text",
    metrics: { likes: 27, comments: 2 },
    contributionScore: 1,
    sourceUrl:
      "https://www.linkedin.com/posts/greysteil_displacing-erps-used-to-be-impossible-activity-123",
    platformPostId: "123",
    rawVisibleText: topVoiceRaw(genericPostText),
    why: "Accepted Top Voice provenance.",
    attachedCompanyId: "company-hexa",
    attachedCompanyName: "Hexa",
    matchReason: "Accepted Top Voice provenance.",
    review_state: "verified",
    ...overrides
  };
}

function topVoiceRaw(postText: string, postOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: "linkedin_topvoice_seventh_pass",
    profile: {
      name: "Grey Baker",
      username: "greysteil",
      url: "https://www.linkedin.com/in/greysteil"
    },
    post: {
      id: "123",
      url:
        "https://www.linkedin.com/posts/greysteil_displacing-erps-used-to-be-impossible-activity-123",
      rawText: postText,
      text: postText,
      authorName: "Grey Baker",
      authorHandle: "greysteil",
      ...postOverrides
    },
    target: {
      companyName: "Hexa",
      companySlug: "hexa",
      topVoiceAudience: "yc_partners",
      topVoiceName: "Grey Baker"
    },
    verification: {
      status: "accepted",
      method: "Accepted Top Voice review for Hexa.",
      reason: "The shared YC launch card names Hexa."
    },
    title: "Grey Baker LinkedIn post about Hexa and ERP displacement"
  });
}
