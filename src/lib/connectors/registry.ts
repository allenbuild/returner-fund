import { GitHubConnector } from "@/lib/connectors/github";
import { InstagramPublicConnector } from "@/lib/connectors/instagram-public";
import { LinkedInSafePlaceholderConnector } from "@/lib/connectors/linkedin-safe";
import { ProductHuntConnector } from "@/lib/connectors/product-hunt";
import { RssConnector } from "@/lib/connectors/rss";
import { WebSearchConnector } from "@/lib/connectors/web-search";
import { XOfficialApiConnector } from "@/lib/connectors/x-official";
import { YouTubeConnector } from "@/lib/connectors/youtube";
import type { Platform, SocialConnector } from "@/types/domain";

export function createDefaultConnectors(): SocialConnector[] {
  return [
    new GitHubConnector(),
    new WebSearchConnector(),
    new ProductHuntConnector(),
    new YouTubeConnector(),
    new RssConnector(),
    new InstagramPublicConnector(),
    new XOfficialApiConnector(),
    new LinkedInSafePlaceholderConnector()
  ];
}

export function createConnectorRegistry(): Record<string, SocialConnector> {
  const connectors = createDefaultConnectors();
  return Object.fromEntries(connectors.map((connector) => [connector.platform, connector]));
}

export function getConnector(platform: Platform): SocialConnector | null {
  return createConnectorRegistry()[platform] ?? null;
}

export function connectorLimitations() {
  return createDefaultConnectors().map((connector) => connector.explainLimitations());
}
