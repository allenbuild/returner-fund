import { generatedEvidenceThumbnailSvg } from "@/lib/graph/generated-evidence-thumbnail";
import type { Platform } from "@/lib/graph/types";

export const runtime = "nodejs";

export function GET(request: Request) {
  const url = new URL(request.url);
  const platform = normalizePlatform(url.searchParams.get("platform"));
  const title = url.searchParams.get("title") || "Traction post";
  const author = url.searchParams.get("author") || "";
  const svg = generatedEvidenceThumbnailSvg({
    id: url.searchParams.get("id") || "generated-thumbnail",
    platform,
    sourceUrl: "",
    title,
    authorName: author,
    contributionScore: Number(url.searchParams.get("score"))
  });

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable"
    }
  });
}

function normalizePlatform(value: string | null): Platform {
  const candidate = String(value ?? "").trim() as Platform;
  return candidate === "github" ||
    candidate === "x" ||
    candidate === "linkedin" ||
    candidate === "instagram" ||
    candidate === "product_hunt" ||
    candidate === "youtube" ||
    candidate === "rss" ||
    candidate === "web" ||
    candidate === "reddit" ||
    candidate === "hacker_news" ||
    candidate === "bilibili" ||
    candidate === "tiktok" ||
    candidate === "bluesky"
    ? candidate
    : "web";
}
