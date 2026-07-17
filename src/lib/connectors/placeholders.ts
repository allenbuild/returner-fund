import { ReadOnlyConnector, readOnlyLimitations } from "@/lib/connectors/base";

export class YouTubeConnector extends ReadOnlyConnector {
  platform = "youtube" as const;
  protected limitations = readOnlyLimitations({
    platform: this.platform,
    requiresAuth: false,
    status: "ready",
    supportsProfileDiscovery: true,
    supportsRecentPosts: true,
    supportsMetrics: true,
    authentication: "Public YouTube metadata/transcripts through Agent Reach or yt-dlp where allowed.",
    notes: ["Uses public YouTube metadata/transcripts through yt-dlp where allowed. Comments are optional."]
  });
}

export class RssConnector extends ReadOnlyConnector {
  platform = "rss" as const;
  protected limitations = readOnlyLimitations({
    platform: this.platform,
    requiresAuth: false,
    status: "ready",
    supportsProfileDiscovery: true,
    supportsRecentPosts: true,
    supportsMetrics: false,
    authentication: "Public RSS/Atom feeds only.",
    notes: ["Reads public RSS/Atom feeds only."]
  });
}

export class XOfficialApiConnector extends ReadOnlyConnector {
  platform = "x" as const;
  protected limitations = readOnlyLimitations({
    platform: this.platform,
    requiresAuth: true,
    status: "needs_api_key",
    supportsProfileDiscovery: false,
    supportsRecentPosts: false,
    supportsMetrics: false,
    authentication: "Official X API credentials only; no browser automation by default.",
    missingCapabilities: ["No browser automation. No posting, liking, reposting, following, or DMs."],
    notes: [
      "Official X API preferred for account safety.",
      "Requires user-provided developer credentials and approved use case.",
      "No browser automation by default."
    ]
  });
}

export class LinkedInSafeConnector extends ReadOnlyConnector {
  platform = "linkedin" as const;
  protected limitations = readOnlyLimitations({
    platform: this.platform,
    requiresAuth: true,
    status: "manual_only",
    supportsProfileDiscovery: false,
    supportsRecentPosts: false,
    supportsMetrics: false,
    authentication: "No LinkedIn browser automation by default; manual review or official/approved access only.",
    missingCapabilities: ["No browser automation. No profile harvesting, messaging, connecting, reacting, or following."],
    notes: [
      "LinkedIn restricts browser automation. This connector is disabled unless explicit per-task approval exists.",
      "No profile harvesting, messaging, connecting, reacting, or following."
    ]
  });
}

export class TikTokUnavailableConnector extends ReadOnlyConnector {
  platform = "tiktok" as const;
  protected limitations = readOnlyLimitations({
    platform: this.platform,
    requiresAuth: true,
    status: "disabled",
    supportsProfileDiscovery: false,
    supportsRecentPosts: false,
    supportsMetrics: false,
    authentication: "No TikTok collection adapter is configured; future collection requires approved official access.",
    missingCapabilities: ["No profile discovery, post fetch, or metric collection adapter."],
    notes: [
      "Verified externally supplied native TikTok post evidence can be retained, but remains unscored because no calibrated traction model is configured.",
      "Short-link redirects are not treated as stable post identity."
    ]
  });
}

export class BlueskyUnavailableConnector extends ReadOnlyConnector {
  platform = "bluesky" as const;
  protected limitations = readOnlyLimitations({
    platform: this.platform,
    requiresAuth: false,
    status: "stub",
    supportsProfileDiscovery: false,
    supportsRecentPosts: false,
    supportsMetrics: false,
    authentication: "Public Bluesky and AT Protocol reads are not wired into this worker.",
    missingCapabilities: ["No profile discovery, post fetch, or metric collection adapter."],
    notes: [
      "Verified externally supplied native Bluesky post evidence can be retained, but remains unscored because no calibrated traction model is configured."
    ]
  });
}
