import type { EvidenceItem, Platform } from "./types";
import { evidenceDisplayText, isGenericEvidenceLabel } from "./evidence-display";

type GeneratedThumbnailInput = Pick<EvidenceItem, "id" | "platform" | "sourceUrl"> &
  Partial<
    Pick<
      EvidenceItem,
      "authorHandle" | "authorName" | "contributionScore" | "text" | "title" | "tractionStatus"
    >
  >;

const GENERATED_THUMBNAIL_PATH = "/api/evidence-thumbnail";
const WIDTH = 640;
const HEIGHT = 360;

const platformThemes: Record<Platform, { accent: string; accent2: string; surface: string; ink: string }> = {
  github: { accent: "#24292f", accent2: "#8c959f", surface: "#f6f8fa", ink: "#111827" },
  x: { accent: "#111111", accent2: "#4b5563", surface: "#f8fafc", ink: "#111827" },
  linkedin: { accent: "#0a66c2", accent2: "#80b8ee", surface: "#f5f9ff", ink: "#14213d" },
  instagram: { accent: "#d946ef", accent2: "#fb923c", surface: "#fff7fb", ink: "#172033" },
  product_hunt: { accent: "#ff6154", accent2: "#f59e0b", surface: "#fff8f3", ink: "#172033" },
  youtube: { accent: "#ff0033", accent2: "#ff8a8a", surface: "#fff6f7", ink: "#172033" },
  rss: { accent: "#f97316", accent2: "#fbbf24", surface: "#fff8f1", ink: "#172033" },
  web: { accent: "#2563eb", accent2: "#67e8f9", surface: "#f7fbff", ink: "#172033" },
  reddit: { accent: "#ff4500", accent2: "#ffb199", surface: "#fff7f3", ink: "#172033" },
  hacker_news: { accent: "#ff6600", accent2: "#ffb27a", surface: "#fff8f2", ink: "#172033" },
  bilibili: { accent: "#00aeec", accent2: "#93e7ff", surface: "#f5fcff", ink: "#172033" },
  tiktok: { accent: "#111111", accent2: "#25f4ee", surface: "#f8fafc", ink: "#111827" },
  bluesky: { accent: "#1185fe", accent2: "#8ec5ff", surface: "#f5faff", ink: "#172033" }
};

export function generatedEvidenceThumbnailUrl(item: GeneratedThumbnailInput | null | undefined): string | null {
  if (!item) {
    return null;
  }

  const params = new URLSearchParams();
  params.set("platform", item.platform);
  params.set("id", compactParam(item.id || item.sourceUrl, 96));
  params.set("title", compactParam(evidenceDisplayText(item, "Traction post"), 140));

  const author = item.authorName && !isGenericEvidenceLabel(item.authorName) ? item.authorName : item.authorHandle;
  if (author) {
    params.set("author", compactParam(author, 80));
  }

  if (item.tractionStatus !== "unscored" && Number.isFinite(item.contributionScore)) {
    params.set("score", String(Math.round(Number(item.contributionScore))));
  }

  return `${GENERATED_THUMBNAIL_PATH}?${params.toString()}`;
}

export function generatedEvidenceThumbnailDataUri(item: GeneratedThumbnailInput | null | undefined): string | null {
  const svg = generatedEvidenceThumbnailSvg(item);
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
}

export function generatedEvidenceThumbnailSvg(item: GeneratedThumbnailInput | null | undefined): string | null {
  if (!item) {
    return null;
  }

  const theme = platformThemes[item.platform] ?? platformThemes.web;
  const label = platformThumbnailLabel(item.platform);
  const title = evidenceDisplayText(item, "Traction post");
  const author = item.authorName && !isGenericEvidenceLabel(item.authorName)
    ? item.authorName
    : item.authorHandle || "";
  const score = normalizeScore(item.contributionScore);
  const lines = wrapText(title, 24, 3);
  const authorLine = author ? escapeXml(author) : "Verified public traction";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(label)} traction thumbnail">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="${theme.surface}"/>
      <stop offset="0.58" stop-color="#ffffff"/>
      <stop offset="1" stop-color="${theme.surface}"/>
    </linearGradient>
    <linearGradient id="stripe" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${theme.accent}"/>
      <stop offset="1" stop-color="${theme.accent2}"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#101828" flood-opacity="0.11"/>
    </filter>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" rx="34" fill="url(#bg)"/>
  <rect x="0" y="0" width="${WIDTH}" height="12" fill="url(#stripe)"/>
  <circle cx="560" cy="78" r="86" fill="${theme.accent2}" opacity="0.16"/>
  <circle cx="78" cy="284" r="118" fill="${theme.accent}" opacity="0.11"/>
  <g filter="url(#shadow)">
    <rect x="36" y="44" width="${WIDTH - 72}" height="${HEIGHT - 88}" rx="28" fill="#ffffff" opacity="0.94"/>
  </g>
  <rect x="64" y="72" width="180" height="44" rx="22" fill="${theme.accent}" opacity="0.12"/>
  <circle cx="88" cy="94" r="13" fill="${theme.accent}"/>
  <text x="114" y="101" fill="${theme.ink}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="800">${escapeXml(label)}</text>
  ${score ? `<rect x="504" y="64" width="72" height="58" rx="18" fill="${theme.accent}"/>
  <text x="540" y="101" text-anchor="middle" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="28" font-weight="900">${score}</text>` : ""}
  <text x="64" y="172" fill="${theme.ink}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="34" font-weight="900">
${lines.map((line, index) => `    <tspan x="64" dy="${index === 0 ? 0 : 42}">${escapeXml(line)}</tspan>`).join("\n")}
  </text>
  <text x="64" y="306" fill="#667085" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="20" font-weight="700">${authorLine}</text>
</svg>`;
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
    bilibili: "Bilibili",
    tiktok: "TikTok",
    bluesky: "Bluesky"
  };
  return labels[platform] ?? platform;
}

function compactParam(value: string, maxLength: number): string {
  const compact = String(value).replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3).trim()}...` : compact;
}

function normalizeScore(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  return String(Math.max(1, Math.min(100, Math.round(numeric))));
}

function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) {
      lines.push(current);
    }
    current = word.length > maxChars ? `${word.slice(0, maxChars - 1)}...` : word;
    if (lines.length === maxLines - 1) {
      break;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  const remainder = words.slice(lines.join(" ").split(" ").filter(Boolean).length).join(" ");
  if (remainder && lines.length) {
    const last = lines[lines.length - 1];
    if (!last.endsWith("...")) {
      lines[lines.length - 1] = last.length > maxChars - 3 ? `${last.slice(0, maxChars - 3).trim()}...` : `${last}...`;
    }
  }

  return lines.length ? lines : ["Traction post"];
}

function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
