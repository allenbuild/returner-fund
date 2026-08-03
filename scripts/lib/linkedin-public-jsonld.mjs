import * as cheerio from "cheerio";
import {
  linkedinAccountSlugFromUrl,
  linkedinNativeAuthorSlugFromUrl,
  linkedinPostIdFromUrl
} from "./social-native-identity.mjs";

const MAX_HTML_CODE_UNITS = 6_000_000;
const MAX_JSON_LD_CODE_UNITS = 1_000_000;
const MAX_JSON_LD_SCRIPTS = 40;
const MAX_JSON_NODES = 2_000;
const MAX_POST_BODY_CODE_UNITS = 25_000;
const MAX_PROFILE_POSTS = 20;

/**
 * Read the inert, public metadata exposed on a LinkedIn account page. Post
 * candidates are accepted only when their native author slug is the exact
 * mapped account slug. This function never executes page scripts or uses a
 * signed-in session.
 */
export function extractLinkedInPublicProfileSurface({ html, profileUrl }) {
  const source = boundedHtml(html);
  const expectedSlug = linkedinAccountSlugFromUrl(profileUrl);
  if (!source || !expectedSlug) {
    return unverifiedProfile("linkedin_public_profile_input_invalid");
  }

  const $ = cheerio.load(source);
  const canonicalUrl = firstNonempty(
    $("link[rel='canonical']").first().attr("href"),
    $("meta[property='og:url']").first().attr("content")
  );
  const canonicalSlug = canonicalUrl ? linkedinAccountSlugFromUrl(canonicalUrl) : null;
  if (canonicalSlug && canonicalSlug !== expectedSlug) {
    return unverifiedProfile("linkedin_public_profile_canonical_account_mismatch");
  }

  const title = cleanText(
    $("meta[property='og:title']").first().attr("content") ?? $("title").first().text()
  );
  const description = cleanText(
    $("meta[property='og:description']").first().attr("content") ??
      $("meta[name='description']").first().attr("content")
  );
  const postCandidates = [];
  const seenPostIds = new Set();
  $("a[href]").each((_, element) => {
    if (postCandidates.length >= MAX_PROFILE_POSTS) return;
    const href = $(element).attr("href");
    const absolute = safeAbsoluteLinkedInUrl(href, profileUrl);
    const postId = linkedinPostIdFromUrl(absolute);
    const authorSlug = linkedinNativeAuthorSlugFromUrl(absolute);
    if (!postId || authorSlug !== expectedSlug || seenPostIds.has(postId)) return;
    seenPostIds.add(postId);
    postCandidates.push({
      url: canonicalLinkedInUrl(absolute),
      postId,
      authorSlug,
      title: cleanText($(element).attr("aria-label") ?? $(element).text())
    });
  });

  const identityVisible = canonicalSlug === expectedSlug || postCandidates.length > 0;
  if (!identityVisible) {
    return unverifiedProfile("linkedin_public_profile_identity_unproven");
  }

  return {
    verified: true,
    reason: "linkedin_public_profile_exact_account_verified",
    accountSlug: expectedSlug,
    canonicalUrl: canonicalLinkedInUrl(canonicalUrl || profileUrl),
    title,
    description,
    followers: parseFollowerCount(`${title}\n${description}`),
    postCandidates
  };
}

/**
 * Convert the exact SocialMediaPosting JSON-LD node for a requested LinkedIn
 * activity into a bounded receipt understood by the public evidence pipeline.
 * Metrics are read only from the selected post's own interactionStatistic,
 * never from comments, related posts, or page-wide text.
 */
export function extractLinkedInPublicPostReceipt({ html, postUrl, expectedAccountUrl }) {
  const source = boundedHtml(html);
  const expectedPostId = linkedinPostIdFromUrl(postUrl);
  const expectedAuthorSlug = linkedinAccountSlugFromUrl(expectedAccountUrl);
  if (!source || !expectedPostId || !expectedAuthorSlug) {
    return unverifiedPost("linkedin_public_jsonld_input_invalid");
  }

  const $ = cheerio.load(source);
  const candidates = [];
  let scriptCount = 0;
  $("script[type='application/ld+json']").each((_, element) => {
    if (scriptCount >= MAX_JSON_LD_SCRIPTS) return;
    scriptCount += 1;
    const raw = $(element).text().trim();
    if (!raw || raw.length > MAX_JSON_LD_CODE_UNITS) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    collectSocialMediaPostingNodes(parsed, candidates);
  });

  const matching = candidates.filter((node) => {
    const nodePostId = linkedinPostIdFromUrl(
      firstNonempty(node?.["@id"], node?.url, objectUrl(node?.mainEntityOfPage))
    );
    return nodePostId === expectedPostId;
  });
  if (matching.length !== 1) {
    return unverifiedPost(
      matching.length === 0
        ? "linkedin_public_jsonld_activity_not_found"
        : "linkedin_public_jsonld_activity_ambiguous"
    );
  }

  const node = matching[0];
  const authorUrl = objectUrl(node?.author);
  const authorSlug = linkedinAccountSlugFromUrl(authorUrl);
  if (!authorSlug || authorSlug !== expectedAuthorSlug) {
    return unverifiedPost("linkedin_public_jsonld_author_mismatch");
  }

  const articleBody = cleanMultilineText(node?.articleBody ?? node?.text);
  if (!articleBody || articleBody.length > MAX_POST_BODY_CODE_UNITS) {
    return unverifiedPost("linkedin_public_jsonld_body_invalid");
  }
  const datePublished = validIsoDate(node?.datePublished);
  if (!datePublished) {
    return unverifiedPost("linkedin_public_jsonld_date_invalid");
  }

  const directStatistics = Array.isArray(node?.interactionStatistic)
    ? node.interactionStatistic
    : node?.interactionStatistic
      ? [node.interactionStatistic]
      : [];
  const counts = {};
  for (const statistic of directStatistics) {
    if (!statistic || typeof statistic !== "object") continue;
    const interactionType = interactionTypeName(statistic.interactionType);
    const count = nonnegativeInteger(statistic.userInteractionCount);
    if (count === null) continue;
    if (interactionType === "likeaction") counts.reactions = count;
    if (interactionType === "commentaction") counts.comments = count;
  }

  const canonicalPostUrl = canonicalLinkedInUrl(
    firstNonempty(node?.["@id"], node?.url, postUrl)
  );
  return {
    verified: true,
    reason: "linkedin_public_jsonld_exact_post_verified",
    receipt: {
      post: {
        id: expectedPostId,
        url: canonicalPostUrl,
        articleBody,
        text: articleBody,
        headline: cleanText(node?.headline),
        datePublished,
        author: {
          name: cleanText(node?.author?.name),
          url: canonicalLinkedInUrl(authorUrl),
          slug: authorSlug
        }
      },
      counts,
      verification: {
        status: "accepted",
        metricsVisible: directStatistics.length > 0,
        notProfileOrSearchPage: true,
        activityIdMatched: true,
        authorMatched: true,
        source: "linkedin_public_social_media_posting_jsonld_v1"
      }
    }
  };
}

function collectSocialMediaPostingNodes(root, output) {
  const queue = [root];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_JSON_NODES) {
    const value = queue.shift();
    visited += 1;
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      queue.push(...value.slice(0, MAX_JSON_NODES - visited));
      continue;
    }
    if (schemaTypes(value["@type"]).includes("socialmediaposting")) output.push(value);
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
}

function schemaTypes(value) {
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item ?? "").split(/[\/#]/).at(-1).toLowerCase())
    .filter(Boolean);
}

function interactionTypeName(value) {
  const raw = typeof value === "object" ? value?.["@type"] ?? value?.["@id"] : value;
  return String(raw ?? "").split(/[\/#]/).at(-1).toLowerCase();
}

function objectUrl(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return firstNonempty(value.url, value["@id"]);
}

function boundedHtml(value) {
  const source = String(value ?? "");
  return source && source.length <= MAX_HTML_CODE_UNITS ? source : null;
}

function parseFollowerCount(value) {
  const match = String(value ?? "").match(/([\d,.]+)\s+followers?\b/i);
  if (!match) return null;
  const count = Number(match[1].replace(/,/g, ""));
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function nonnegativeInteger(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function validIsoDate(value) {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safeAbsoluteLinkedInUrl(value, baseUrl) {
  try {
    const parsed = new URL(value, baseUrl);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com") ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function canonicalLinkedInUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.protocol = "https:";
    parsed.hostname = "www.linkedin.com";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString();
  } catch {
    return value ?? null;
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanMultilineText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstNonempty(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
}

function unverifiedProfile(reason) {
  return {
    verified: false,
    reason,
    accountSlug: null,
    canonicalUrl: null,
    title: "",
    description: "",
    followers: null,
    postCandidates: []
  };
}

function unverifiedPost(reason) {
  return { verified: false, reason, receipt: null };
}
