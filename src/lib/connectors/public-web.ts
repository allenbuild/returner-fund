import { ReadOnlyConnector, readOnlyLimitations } from "@/lib/connectors/base";
import type { EntityRef, ProfileCandidate } from "@/types/domain";

export class PublicWebConnector extends ReadOnlyConnector {
  platform = "web" as const;
  protected limitations = readOnlyLimitations({
    platform: this.platform,
    requiresAuth: false,
    status: "ready",
    supportsProfileDiscovery: true,
    supportsRecentPosts: true,
    supportsMetrics: false,
    authentication: "Public webpages only.",
    notes: ["Reads public webpages only. Does not bypass paywalls, CAPTCHAs, robots restrictions, or login walls."]
  });

  async discoverProfiles(entity: EntityRef): Promise<ProfileCandidate[]> {
    if (!entity.websiteUrl) return [];
    return [
      {
        platform: this.platform,
        handle: null,
        url: entity.websiteUrl,
        review_state: "verified",
        reasons: [
          {
            signal: "official_website",
            weight: 0.9,
            matched: true,
            explanation: "Website URL came from source ingestion or demo seed."
          }
        ],
        discoveredFromUrl: entity.ycProfileUrl,
        evidence: { source: "entity.websiteUrl" }
      }
    ];
  }
}

export class InstagramPublicConnector extends ReadOnlyConnector {
  platform = "instagram" as const;
  protected limitations = readOnlyLimitations({
    platform: this.platform,
    requiresAuth: false,
    status: "public_only",
    supportsProfileDiscovery: true,
    supportsRecentPosts: false,
    supportsMetrics: false,
    authentication: "No Instagram login; public unauthenticated pages only.",
    notes: [
      "Public unauthenticated Instagram pages only.",
      "No login session, saved posts, DMs, private data, follows, likes, comments, or posting.",
      "If Instagram blocks public access with a login wall or CAPTCHA, the connector stops."
    ]
  });
}
