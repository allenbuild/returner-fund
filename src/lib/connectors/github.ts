import { ReadOnlyConnector, readOnlyLimitations } from "@/lib/connectors/base";
import { scoreProfileCandidate } from "@/lib/identity/review-state";
import type { EntityRef, ProfileCandidate, SocialProfile } from "@/types/domain";

export class GitHubConnector extends ReadOnlyConnector {
  platform = "github" as const;
  protected limitations = readOnlyLimitations({
    platform: this.platform,
    requiresAuth: false,
    status: "ready",
    supportsProfileDiscovery: true,
    supportsRecentPosts: false,
    supportsMetrics: true,
    authentication: "Public GitHub API/pages by default; optional GITHUB_TOKEN only raises read limits.",
    notes: [
      "Uses public GitHub pages or gh/API when configured.",
      "MVP connector is read-only and never stars, forks, follows, or opens issues."
    ]
  });

  async discoverProfiles(entity: EntityRef): Promise<ProfileCandidate[]> {
    if (!entity.websiteUrl) return [];
    const handle = entity.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return [
      scoreProfileCandidate(entity, {
        platform: this.platform,
        handle,
        url: `https://github.com/${handle}`,
        discoveredFromUrl: entity.websiteUrl,
        signals: {
          exactCompanyName: entity.type === "company",
          exactFounderName: entity.type === "founder",
          domainMatch: true,
          recentActivity: true
        },
        evidence: { generatedCandidate: true }
      })
    ];
  }

  async getAccountMetrics(profile: SocialProfile) {
    return {
      followerCount: profile.followerCount ?? null,
      followingCount: profile.followingCount ?? null,
      verified: Boolean(profile.verified),
      raw: { source: "profile_cache_or_public_api" }
    };
  }
}
