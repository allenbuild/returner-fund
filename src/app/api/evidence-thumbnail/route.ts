import { platformThumbnailLabel } from "@/lib/graph/generated-evidence-thumbnail";
import type { Platform } from "@/lib/graph/types";

export const runtime = "nodejs";

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
  bilibili: { accent: "#00aeec", accent2: "#93e7ff", surface: "#f5fcff", ink: "#172033" }
};

export function GET(request: Request) {
  const url = new URL(request.url);
  const platform = normalizePlatform(url.searchParams.get("platform"));
  const theme = platformThemes[platform];
  const label = platformThumbnailLabel(platform);
  const title = url.searchParams.get("title") || "Traction post";
  const author = url.searchParams.get("author") || "";
  const score = normalizeScore(url.searchParams.get("score"));
  const lines = wrapText(title, 24, 3);
  const authorLine = author ? escapeXml(author) : "Verified public traction";

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
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

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable"
    }
  });
}

function normalizePlatform(value: string | null): Platform {
  const candidate = String(value ?? "").trim() as Platform;
  return candidate in platformThemes ? candidate : "web";
}

function normalizeScore(value: string | null): string {
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
