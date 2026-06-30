import { describe, expect, it } from "vitest";
import {
  createConnectorRegistry,
  InstagramPublicConnector
} from "@/lib/connectors";
import { LinkedInSafeConnector, XOfficialApiConnector } from "@/lib/connectors/placeholders";
import type { SocialAccount } from "@/types/domain";

describe("connector limitations", () => {
  it("registers the initial read-only connector set", () => {
    const platforms = Object.values(createConnectorRegistry()).map((connector) => connector.platform);

    expect(platforms).toEqual([
      "github",
      "web",
      "product_hunt",
      "youtube",
      "rss",
      "instagram",
      "x",
      "linkedin"
    ]);
  });

  it("requires every connector to publish read-only safety rules", () => {
    const limitations = Object.values(createConnectorRegistry()).map((connector) => connector.explainLimitations());

    for (const limitation of limitations) {
      expect(limitation.supportsMutation).toBe(false);
      expect(limitation.notes.join(" ").toLowerCase()).toMatch(/read|public|official|no|disabled|rss|metadata|api/);
    }
  });

  it("keeps Instagram public-only and unauthenticated", async () => {
    const connector = new InstagramPublicConnector();
    const limitations = connector.explainLimitations();

    expect(limitations.requiresAuth).toBe(false);
    expect(limitations.supportsMutation).toBe(false);
    expect(limitations.notes.join(" ")).toContain("Public unauthenticated Instagram pages only");
    expect(limitations.notes.join(" ")).toContain("No login session");
    await expect(
      connector.fetchRecentPosts(
        socialAccount("instagram", "https://www.instagram.com/example/", "example"),
        { limit: 5 }
      )
    ).resolves.toEqual([]);
  });

  it("keeps X on official API placeholder instead of browser automation", () => {
    const limitations = new XOfficialApiConnector().explainLimitations();

    expect(limitations.requiresAuth).toBe(true);
    expect(limitations.supportsMutation).toBe(false);
    expect(limitations.notes.join(" ")).toContain("Official X API");
    expect(limitations.notes.join(" ")).toContain("No browser automation");
  });

  it("keeps LinkedIn manual-only by default", async () => {
    const connector = new LinkedInSafeConnector();
    const limitations = connector.explainLimitations();

    expect(limitations.requiresAuth).toBe(true);
    expect(limitations.supportsMutation).toBe(false);
    expect(limitations.notes.join(" ")).toContain("LinkedIn restricts browser automation");
    await expect(
      connector.fetchRecentPosts(
        socialAccount("linkedin", "https://www.linkedin.com/company/example/", null),
        { limit: 5 }
      )
    ).resolves.toEqual([]);
  });
});

function socialAccount(platform: SocialAccount["platform"], url: string, handle: string | null): SocialAccount {
  return {
    id: `${platform}-account`,
    entityType: "company",
    entityId: "company-1",
    platform,
    handle,
    url,
    accountId: null,
    followerCount: null,
    followingCount: null,
    verified: false,
    review_state: "needs_review",
    discoveredFromUrl: null,
    evidence: {}
  };
}
