import { load } from "cheerio";

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif|avif)(?:$|[?#])/i;
const IMAGE_HOST_HINTS =
  /(?:images?|img|media|cdn|assets?|static|uploads?|og|opengraph|thumbnail|thumb|preview|cover|poster)\./i;
const REJECT_PREVIEW_IMAGE = [
  /sprite/i,
  /spacer/i,
  /blank/i,
  /transparent/i,
  /pixel/i,
  /tracking/i,
  /analytics/i,
  /profile_images/i,
  /emoji\/v2/i
];
const LOGO_HINT = /(?:^|[-_/])(logo|wordmark|brandmark)(?:[-_.?/]|$)/i;
const ICON_HINT = /(?:favicon|apple-touch-icon|mstile|mask-icon|android-chrome|safari-pinned-tab)/i;

export function extractLinkPreview(html, pageUrl, options = {}) {
  const allowFavicon = options.allowFavicon !== false;
  const $ = load(String(html || ""));
  const candidates = [];

  collectMeta($, pageUrl, candidates);
  collectStructuredImages($, pageUrl, candidates);
  collectArticleImages($, pageUrl, candidates);

  const selected = chooseBestPreviewCandidate(candidates, { allowLogo: false });
  if (selected) {
    return {
      thumbnailUrl: selected.url,
      thumbnailSource: selected.source,
      mediaUrl: selected.url
    };
  }

  const relaxed = chooseBestPreviewCandidate(candidates, { allowLogo: true });
  if (relaxed) {
    return {
      thumbnailUrl: relaxed.url,
      thumbnailSource: `${relaxed.source}-relaxed`,
      mediaUrl: relaxed.url
    };
  }

  if (allowFavicon) {
    const favicon = chooseBestFaviconCandidate(collectFaviconCandidates($, pageUrl), pageUrl);
    if (favicon) {
      return {
        thumbnailUrl: favicon.url,
        thumbnailSource: favicon.source,
        mediaUrl: favicon.url
      };
    }
  }

  return {
    thumbnailUrl: null,
    thumbnailSource: null,
    mediaUrl: null
  };
}

export function collectPreviewCandidates(html, pageUrl) {
  const $ = load(String(html || ""));
  const candidates = [];
  collectMeta($, pageUrl, candidates);
  collectStructuredImages($, pageUrl, candidates);
  collectArticleImages($, pageUrl, candidates);
  return dedupeCandidates(candidates);
}

export function collectFaviconCandidatesFromHtml(html, pageUrl) {
  return collectFaviconCandidates(load(String(html || "")), pageUrl);
}

function collectMeta($, pageUrl, candidates) {
  const metaSelectors = [
    ["meta[property='og:image']", "link-preview-og-image"],
    ["meta[property='og:image:url']", "link-preview-og-image"],
    ["meta[property='og:image:secure_url']", "link-preview-og-image"],
    ["meta[name='og:image']", "link-preview-og-image"],
    ["meta[name='twitter:image']", "link-preview-twitter-image"],
    ["meta[name='twitter:image:src']", "link-preview-twitter-image"],
    ["meta[property='twitter:image']", "link-preview-twitter-image"],
    ["meta[itemprop='image']", "link-preview-itemprop-image"],
    ["link[rel~='image_src']", "link-preview-image-src"]
  ];

  for (const [selector, source] of metaSelectors) {
    $(selector).each((_, element) => {
      const raw = $(element).attr("content") || $(element).attr("href");
      pushCandidate(candidates, raw, pageUrl, source, 100);
    });
  }
}

function collectStructuredImages($, pageUrl, candidates) {
  $("script[type='application/ld+json']").each((_, element) => {
    const json = $(element).text();
    try {
      collectJsonImageCandidates(JSON.parse(json), candidates, pageUrl, "link-preview-jsonld-image", 86);
    } catch {
      // Ignore malformed structured data; many pages include partial JSON-LD.
    }
  });

  $("video[poster]").each((_, element) => {
    pushCandidate(candidates, $(element).attr("poster"), pageUrl, "link-preview-video-poster", 82);
  });
}

function collectArticleImages($, pageUrl, candidates) {
  const selectors = [
    "article img[src]",
    "main img[src]",
    "[role='main'] img[src]",
    ".post img[src]",
    ".article img[src]",
    ".content img[src]",
    "img[src]"
  ];

  selectors.forEach((selector, selectorIndex) => {
    $(selector).each((_, element) => {
      const image = $(element);
      const raw = image.attr("src") || image.attr("data-src") || image.attr("data-lazy-src");
      const width = numericAttr(image.attr("width")) || numericAttr(image.attr("data-width"));
      const height = numericAttr(image.attr("height")) || numericAttr(image.attr("data-height"));
      const alt = `${image.attr("alt") || ""} ${image.attr("class") || ""} ${image.attr("id") || ""}`;
      const dimensionBoost = width && height ? Math.min(20, Math.round(Math.sqrt(width * height) / 75)) : 0;
      const source = selectorIndex < 3 ? "link-preview-article-image" : "link-preview-page-image";
      pushCandidate(candidates, raw, pageUrl, source, 55 - selectorIndex * 3 + dimensionBoost, {
        width,
        height,
        alt
      });
    });
  });
}

function collectFaviconCandidates($, pageUrl) {
  const candidates = [];
  $("link[rel]").each((_, element) => {
    const rel = String($(element).attr("rel") || "").toLowerCase();
    if (!/(?:icon|apple-touch-icon|shortcut icon)/i.test(rel)) {
      return;
    }
    const sizes = String($(element).attr("sizes") || "");
    const sizeScore = Math.max(...[...sizes.matchAll(/(\d+)x(\d+)/gi)].map((match) => Number(match[1]) * Number(match[2])), 0);
    pushCandidate(candidates, $(element).attr("href"), pageUrl, "link-preview-favicon", 20 + Math.min(25, Math.round(Math.sqrt(sizeScore) / 12)), {
      allowIcon: true
    });
  });

  try {
    const url = new URL(pageUrl);
    candidates.push({
      url: `${url.origin}/favicon.ico`,
      source: "link-preview-favicon",
      score: 18,
      allowIcon: true
    });
  } catch {
    // Invalid page URLs are handled by the caller.
  }

  return dedupeCandidates(candidates);
}

function collectJsonImageCandidates(value, candidates, pageUrl, source, score) {
  if (!value) return;
  if (typeof value === "string") {
    pushCandidate(candidates, value, pageUrl, source, score);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonImageCandidates(item, candidates, pageUrl, source, score));
    return;
  }
  if (typeof value !== "object") return;

  const object = value;
  const image = object.image || object.thumbnailUrl || object.thumbnail || object.logo;
  if (image) collectJsonImageCandidates(image, candidates, pageUrl, source, object.logo ? score - 18 : score);
  if (object.url && (object["@type"] === "ImageObject" || object["@type"] === "VideoObject")) {
    pushCandidate(candidates, object.url, pageUrl, source, score);
  }
}

function chooseBestPreviewCandidate(candidates, options) {
  return dedupeCandidates(candidates)
    .filter((candidate) => isUsefulPreviewImage(candidate, options))
    .sort((a, b) => b.score - a.score || sourcePriority(b.source) - sourcePriority(a.source))[0] ?? null;
}

function chooseBestFaviconCandidate(candidates, pageUrl) {
  const useful = dedupeCandidates(candidates)
    .filter((candidate) => isHttpUrl(candidate.url))
    .filter((candidate) => candidate.allowIcon || ICON_HINT.test(candidate.url) || isLikelyImageUrl(candidate.url))
    .sort((a, b) => b.score - a.score);
  if (useful[0]) return useful[0];

  try {
    const url = new URL(pageUrl);
    return {
      url: `${url.origin}/favicon.ico`,
      source: "link-preview-favicon",
      score: 1,
      allowIcon: true
    };
  } catch {
    return null;
  }
}

function isUsefulPreviewImage(candidate, options) {
  if (!isHttpUrl(candidate.url)) return false;
  if (REJECT_PREVIEW_IMAGE.some((pattern) => pattern.test(candidate.url) || pattern.test(candidate.alt || ""))) return false;
  if (!options.allowLogo && (LOGO_HINT.test(candidate.url) || LOGO_HINT.test(candidate.alt || ""))) return false;
  if (ICON_HINT.test(candidate.url)) return false;
  if (candidate.source.includes("og-image") || candidate.source.includes("twitter-image") || candidate.source.includes("jsonld")) {
    return true;
  }
  return isLikelyImageUrl(candidate.url);
}

function isLikelyImageUrl(url) {
  return (
    IMAGE_EXTENSIONS.test(url) ||
    /[?&](?:format|fm|auto)=(?:jpg|jpeg|png|webp|gif|avif|image)\b/i.test(url) ||
    /(?:cdninstagram\.com|fbcdn\.net|pbs\.twimg\.com|media\.licdn\.com|ph-files\.imgix\.net|i\.ytimg\.com|githubassets\.com)/i.test(
      url
    ) ||
    IMAGE_HOST_HINTS.test(url)
  );
}

function pushCandidate(candidates, rawUrl, pageUrl, source, score, meta = {}) {
  const url = absolutizeUrl(rawUrl, pageUrl);
  if (!url) return;
  candidates.push({
    url,
    source,
    score,
    ...meta
  });
}

function absolutizeUrl(rawUrl, pageUrl) {
  if (!rawUrl) return null;
  const trimmed = String(rawUrl)
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .trim();
  if (!trimmed || /^data:/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, pageUrl).toString();
  } catch {
    return null;
  }
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    if (!candidate?.url || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    deduped.push(candidate);
  }
  return deduped;
}

function numericAttr(value) {
  const number = Number.parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sourcePriority(source) {
  if (source.includes("og-image")) return 6;
  if (source.includes("twitter-image")) return 5;
  if (source.includes("jsonld")) return 4;
  if (source.includes("video-poster")) return 3;
  if (source.includes("article-image")) return 2;
  return 1;
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
