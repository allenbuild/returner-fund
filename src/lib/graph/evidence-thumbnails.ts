import type { EvidenceItem, Platform } from "./types";

type ThumbnailInput = Pick<EvidenceItem, "id" | "platform" | "sourceUrl"> &
  Partial<Pick<EvidenceItem, "rawVisibleText" | "mediaUrl" | "mediaUrls" | "thumbnailUrl" | "thumbnailSource" | "authorHandle">>;

export interface EvidenceThumbnailResolution {
  thumbnailUrl: string | null;
  thumbnailSource: string | null;
  mediaUrl: string | null;
}

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif)(?:$|[?#])/i;
const YOUTUBE_ID =
  /(?:youtube\.com\/watch\?[^#\s]*\bv=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,})/i;
const GITHUB_REPO = /github\.com\/([^/\s?#]+)(?:\/([^/\s?#]+))?/i;
const IMAGE_URL = /https?:\/\/[^\s"'()<>\\]+/gi;
const MARKDOWN_IMAGE = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi;

const PLATFORM_HOST_HINTS: Record<Platform, RegExp[]> = {
  x: [/pbs\.twimg\.com\/(?:media|amplify_video_thumb|tweet_video_thumb|card_img)\//i],
  instagram: [/cdninstagram\.com/i, /fbcdn\.net/i],
  linkedin: [/media\.licdn\.com/i],
  product_hunt: [/ph-files\.imgix\.net/i, /producthunt\.com/i],
  youtube: [/i\.ytimg\.com\/vi\//i],
  github: [/opengraph\.githubassets\.com/i, /github\.com\/[^/]+\.png/i],
  web: [],
  rss: [],
  reddit: [/preview\.redd\.it/i, /i\.redd\.it/i],
  hacker_news: [],
  bilibili: [/hdslb\.com/i]
};

const REJECT_ALWAYS = [
  /profile_images/i,
  /profile_banners/i,
  /emoji\/v2/i,
  /abs\.twimg\.com/i,
  /static\.licdn\.com/i,
  /favicon/i,
  /apple-touch-icon/i,
  /sprite/i,
  /\[redacted/i
];

const PLATFORM_REJECTS: Partial<Record<Platform, RegExp[]>> = {
  instagram: [/profile_pic/i, /s150x150/i, /e35\/s\d+x\d+/i, /t51\.82787-19/i],
  linkedin: [/profile-displayphoto/i, /company-logo/i],
  product_hunt: [/favicon/i],
  web: [/logo(?:[-_./]|$)/i, /icon(?:[-_./]|$)/i],
  rss: [/logo(?:[-_./]|$)/i, /icon(?:[-_./]|$)/i]
};

export function enrichEvidenceThumbnail<T extends ThumbnailInput>(item: T): T & EvidenceThumbnailResolution {
  const resolved = resolveEvidenceThumbnail(item);

  return {
    ...item,
    thumbnailUrl: item.thumbnailUrl ?? resolved.thumbnailUrl,
    thumbnailSource: item.thumbnailSource ?? resolved.thumbnailSource,
    mediaUrl: item.mediaUrl ?? resolved.mediaUrl
  };
}

export function resolveEvidenceThumbnail(item: ThumbnailInput): EvidenceThumbnailResolution {
  const explicitThumbnail = sanitizeUrl(item.thumbnailUrl);
  if (explicitThumbnail) {
    return {
      thumbnailUrl: explicitThumbnail,
      thumbnailSource: item.thumbnailSource ?? "stored",
      mediaUrl: sanitizeUrl(item.mediaUrl) ?? firstCleanUrl(item.mediaUrls) ?? explicitThumbnail
    };
  }

  if (item.platform === "youtube") {
    const youtubeThumbnail = youtubeThumbnailFromUrl(item.sourceUrl) ?? youtubeThumbnailFromRaw(item.rawVisibleText);
    if (youtubeThumbnail) {
      return { thumbnailUrl: youtubeThumbnail, thumbnailSource: "youtube", mediaUrl: item.sourceUrl };
    }
  }

  if (item.platform === "github") {
    const githubThumbnail = githubThumbnailFromUrl(item.sourceUrl, item.id, item.authorHandle);
    if (githubThumbnail) {
      return { thumbnailUrl: githubThumbnail, thumbnailSource: "github", mediaUrl: item.sourceUrl };
    }
  }

  const candidates = [
    ...cleanUrls(item.mediaUrls ?? []),
    ...thumbnailCandidatesFromRaw(item.rawVisibleText)
  ];
  const selected = choosePlatformThumbnail(item.platform, candidates, item.sourceUrl);

  return {
    thumbnailUrl: selected?.url ?? null,
    thumbnailSource: selected?.source ?? null,
    mediaUrl: sanitizeUrl(item.mediaUrl) ?? selected?.url ?? null
  };
}

export function thumbnailCandidatesFromRaw(rawVisibleText?: string): string[] {
  if (!rawVisibleText) {
    return [];
  }

  const candidates: string[] = [];

  for (const match of rawVisibleText.matchAll(MARKDOWN_IMAGE)) {
    candidates.push(match[1]);
  }

  try {
    collectUrlsFromJson(JSON.parse(rawVisibleText), candidates);
  } catch {
    // Most rows are plain readable text; regex extraction below handles those.
  }

  for (const match of rawVisibleText.matchAll(IMAGE_URL)) {
    candidates.push(match[0]);
  }

  return cleanUrls(candidates);
}

export function choosePlatformThumbnail(
  platform: Platform,
  candidates: string[],
  sourceUrl: string
): { url: string; source: string } | null {
  const clean = cleanUrls(candidates).filter((candidate) => isUsefulThumbnail(candidate, platform));
  if (!clean.length) {
    return null;
  }

  const priority = platformPriorityThumbnail(platform, clean);
  if (priority) {
    return { url: priority, source: `${platform}-media` };
  }

  const hostHints = PLATFORM_HOST_HINTS[platform] ?? [];
  const hinted = clean.find((candidate) => hostHints.some((hint) => hint.test(candidate)));
  if (hinted) {
    return { url: hinted, source: `${platform}-media` };
  }

  const ogImage = clean.find((candidate) => /og:image|twitter:image/i.test(sourceUrl) || isLikelyImageUrl(candidate));
  return ogImage ? { url: ogImage, source: "embedded-image" } : null;
}

function platformPriorityThumbnail(platform: Platform, candidates: string[]): string | null {
  if (platform === "instagram") {
    return candidates.find((candidate) => /t51\.(?:71878|2885)-15/i.test(candidate)) ?? null;
  }

  if (platform === "x") {
    return (
      candidates.find((candidate) => /amplify_video_thumb|tweet_video_thumb/i.test(candidate)) ??
      candidates.find((candidate) => /pbs\.twimg\.com\/media\//i.test(candidate)) ??
      candidates.find((candidate) => /pbs\.twimg\.com\/card_img\//i.test(candidate)) ??
      null
    );
  }

  return null;
}

export function youtubeThumbnailFromUrl(sourceUrl: string): string | null {
  const videoId = youtubeVideoId(sourceUrl);
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
}

export function githubThumbnailFromUrl(sourceUrl: string, itemId: string, authorHandle?: string | null): string | null {
  const match = sourceUrl.match(GITHUB_REPO);
  if (!match) {
    return authorHandle ? `https://github.com/${encodeURIComponent(authorHandle)}.png?size=240` : null;
  }

  const owner = match[1];
  const repo = match[2]?.replace(/\.git$/i, "");
  if (owner && repo) {
    return `https://opengraph.githubassets.com/${encodeURIComponent(itemId)}/${owner}/${repo}`;
  }

  return owner ? `https://github.com/${owner}.png?size=240` : null;
}

function youtubeThumbnailFromRaw(rawVisibleText?: string): string | null {
  if (!rawVisibleText) {
    return null;
  }

  const direct = thumbnailCandidatesFromRaw(rawVisibleText).find((candidate) => /i\.ytimg\.com\/vi\//i.test(candidate));
  if (direct) {
    return direct;
  }

  try {
    const parsed = JSON.parse(rawVisibleText) as { videoId?: string; id?: string };
    const videoId = parsed.videoId ?? (typeof parsed.id === "string" ? parsed.id : null);
    if (videoId && /^[A-Za-z0-9_-]{6,}$/.test(videoId)) {
      return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }
  } catch {
    const id = youtubeVideoId(rawVisibleText);
    if (id) {
      return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    }
  }

  return null;
}

function youtubeVideoId(value: string): string | null {
  try {
    const url = new URL(value);
    const fromQuery = url.searchParams.get("v");
    if (fromQuery) {
      return fromQuery;
    }
  } catch {
    // Fall through to regex for raw text and non-URL snippets.
  }

  return value.match(YOUTUBE_ID)?.[1] ?? null;
}

function collectUrlsFromJson(value: unknown, output: string[], key = "") {
  if (!value) {
    return;
  }

  if (typeof value === "string") {
    if (keySuggestsImage(key) || isLikelyImageUrl(value)) {
      output.push(value);
    }
    for (const match of value.matchAll(IMAGE_URL)) {
      output.push(match[0]);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectUrlsFromJson(item, output, key));
    return;
  }

  if (typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, childValue]) =>
      collectUrlsFromJson(childValue, output, childKey)
    );
  }
}

function keySuggestsImage(key: string): boolean {
  return /(?:thumbnail|poster|image|media|cover|og:image|twitter:image)/i.test(key);
}

function firstCleanUrl(urls: string[] | undefined): string | null {
  return cleanUrls(urls ?? [])[0] ?? null;
}

function cleanUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];

  for (const url of urls) {
    const sanitized = sanitizeUrl(url);
    if (!sanitized || seen.has(sanitized)) {
      continue;
    }
    seen.add(sanitized);
    clean.push(sanitized);
  }

  return clean;
}

function sanitizeUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = String(value)
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/[)\].,;]+$/g, "")
    .trim();

  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    if (/\[redacted/i.test(trimmed)) {
      for (const [key, value] of [...url.searchParams.entries()]) {
        if (/\[redacted/i.test(value)) {
          url.searchParams.delete(key);
        }
      }
      url.hash = "";
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isUsefulThumbnail(url: string, platform: Platform): boolean {
  if (!isLikelyImageUrl(url)) {
    return false;
  }

  if (REJECT_ALWAYS.some((pattern) => pattern.test(url))) {
    return false;
  }

  const platformRejects = PLATFORM_REJECTS[platform] ?? [];
  return !platformRejects.some((pattern) => pattern.test(url));
}

function isLikelyImageUrl(url: string): boolean {
  return (
    IMAGE_EXTENSIONS.test(url) ||
    /[?&]format=(?:jpg|jpeg|png|webp|gif)\b/i.test(url) ||
    /i\.ytimg\.com\/vi\//i.test(url) ||
    /pbs\.twimg\.com\/(?:media|amplify_video_thumb|tweet_video_thumb|card_img)\//i.test(url) ||
    /media\.licdn\.com/i.test(url) ||
    /cdninstagram\.com/i.test(url) ||
    /ph-files\.imgix\.net/i.test(url)
  );
}
