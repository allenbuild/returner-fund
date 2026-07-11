import type { EvidenceItem, Platform } from "./types";

type GeneratedThumbnailInput = Pick<EvidenceItem, "id" | "platform" | "sourceUrl"> &
  Partial<Pick<EvidenceItem, "authorHandle" | "authorName" | "contributionScore" | "text" | "title">>;

const GENERATED_THUMBNAIL_PATH = "/api/evidence-thumbnail";

export function generatedEvidenceThumbnailUrl(item: GeneratedThumbnailInput | null | undefined): string | null {
  if (!item) {
    return null;
  }

  const params = new URLSearchParams();
  params.set("platform", item.platform);
  params.set("id", compactParam(item.id || item.sourceUrl, 96));
  params.set("title", compactParam(item.title || item.text || item.sourceUrl || "Traction post", 140));

  const author = item.authorName || item.authorHandle;
  if (author) {
    params.set("author", compactParam(author, 80));
  }

  if (Number.isFinite(item.contributionScore)) {
    params.set("score", String(Math.round(Number(item.contributionScore))));
  }

  return `${GENERATED_THUMBNAIL_PATH}?${params.toString()}`;
}

export function platformThumbnailLabel(platform: Platform): string {
  const labels: Record<Platform, string> = {
    github: "GitHub",
    x: "X",
    linkedin: "LinkedIn",
    instagram: "Instagram",
    product_hunt: "Product Hunt",
    youtube: "YouTube",
    rss: "RSS",
    web: "Web",
    reddit: "Reddit",
    hacker_news: "Hacker News",
    bilibili: "Bilibili"
  };
  return labels[platform] ?? platform;
}

function compactParam(value: string, maxLength: number): string {
  const compact = String(value).replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3).trim()}...` : compact;
}
