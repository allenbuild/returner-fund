import { createHash } from "node:crypto";

import {
  applyResolvedNativeAuthor,
  assessLinkedInPrimaryPostBody
} from "./public-evidence-attribution.mjs";

export const NEEDS_REVIEW_NATIVE_RECOVERY_VERSION =
  "needs-review-native-recovery.v2";

const SUPPORTED_PLATFORMS = new Set([
  "x",
  "linkedin",
  "instagram",
  "youtube"
]);

export function canonicalNativePost(row) {
  const platform = normalizePlatform(row?.platform);
  if (!SUPPORTED_PLATFORMS.has(platform)) return null;
  const rawUrl = String(
    row?.sourceUrl ?? row?.canonicalUrl ?? row?.candidateUrl ?? row?.url ?? ""
  ).trim();
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const path = safeDecode(url.pathname).replace(/\/+$/, "");
  let match = null;
  let postId = null;
  let canonicalUrl = null;

  if (platform === "x" && ["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) {
    match = path.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/.*)?$/i);
    if (match) {
      postId = match[2];
      canonicalUrl = `https://x.com/${match[1].toLowerCase()}/status/${postId}`;
    }
  } else if (
    platform === "linkedin" &&
    (host === "linkedin.com" || host.endsWith(".linkedin.com"))
  ) {
    match = path.match(/(?:urn:li:activity:|activity[-:])(\d{10,})(?:-[^/]*)?(?:\/.*)?$/i);
    if (!match) {
      match = path.match(/(?:^|[-_:])(\d{16,20})(?:[-_]|$)/);
    }
    if (match) {
      postId = match[1];
      canonicalUrl = `https://linkedin.com/feed/update/urn:li:activity:${postId}`;
    }
  } else if (
    platform === "instagram" &&
    (host === "instagram.com" || host.endsWith(".instagram.com"))
  ) {
    match = path.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)(?:\/.*)?$/i);
    if (match) {
      const route = match[1].toLowerCase() === "reels" ? "reel" : match[1].toLowerCase();
      postId = match[2];
      canonicalUrl = `https://instagram.com/${route}/${postId}`;
    }
  } else if (platform === "youtube") {
    if (host === "youtu.be") match = path.match(/^\/([A-Za-z0-9_-]+)(?:\/.*)?$/);
    if (["youtube.com", "m.youtube.com"].includes(host)) {
      if (path === "/watch") {
        const videoId = String(url.searchParams.get("v") ?? "");
        match = videoId.match(/^([A-Za-z0-9_-]+)$/);
      } else {
        match = path.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]+)(?:\/.*)?$/i);
      }
    }
    if (match) {
      postId = match[1];
      canonicalUrl = `https://youtube.com/watch?v=${postId}`;
    }
  }

  if (!postId || !canonicalUrl) return null;
  postId = String(postId);
  return {
    platform,
    postId,
    physicalKey: `${platform}:${platform === "instagram" || platform === "youtube" ? postId : postId.toLowerCase()}`,
    sourceUrl: canonicalUrl
  };
}

export function buildPhysicalPostIndex(snapshots) {
  const result = new Set();
  for (const snapshot of snapshots ?? []) {
    for (const row of snapshot?.evidence ?? []) {
      const native = canonicalNativePost(row);
      if (native) result.add(native.physicalKey);
    }
  }
  return result;
}

export function discoverNeedsReviewNativeCandidates({
  needsReview,
  currentPhysicalKeys,
  resolveNativeAuthor,
  catalogs
}) {
  const youtubeOwners = buildYouTubeOwnerIndex(catalogs);
  const seen = new Set();
  const candidates = [];
  const rejected = [];

  for (const row of needsReview ?? []) {
    const native = canonicalNativePost(row);
    const reasons = [];
    if (!native) reasons.push("not_supported_native_post_url");
    if (native && currentPhysicalKeys?.has(native.physicalKey)) {
      reasons.push("already_in_current_evidence");
    }
    if (native && seen.has(native.physicalKey)) reasons.push("duplicate_needs_review_post");
    if (native) seen.add(native.physicalKey);
    if (row?.review_state !== "needs_review" && row?.review_state !== "rejected") {
      reasons.push("row_not_in_review_state");
    }

    let ownership = null;
    if (native?.platform === "youtube") {
      ownership = resolveYouTubeOwnership(row, youtubeOwners);
    } else if (native && typeof resolveNativeAuthor === "function") {
      ownership = resolveNativeAuthor(row);
    }
    if (native && ownership?.status !== "matched") {
      reasons.push(ownership?.reason ?? "native_owner_not_resolved");
    }

    if (reasons.length > 0) {
      rejected.push(rejection(row, native, reasons));
      continue;
    }
    candidates.push({
      physicalKey: native.physicalKey,
      native,
      ownership,
      row
    });
  }

  return {
    candidates: candidates.sort((left, right) =>
      left.physicalKey.localeCompare(right.physicalKey)
    ),
    rejected
  };
}

export function validateOfflineCandidate(candidate) {
  const { native, ownership, row } = candidate;
  if (native.platform === "x" || native.platform === "youtube") {
    return { status: "network_required", reasons: [] };
  }
  if (native.platform === "linkedin") {
    const body = assessLinkedInPrimaryPostBody({
      ...row,
      sourceUrl: native.sourceUrl,
      platformPostId: native.postId
    });
    if (!body.verified) {
      return { status: "rejected", reasons: [body.reason] };
    }
    return {
      status: "accepted",
      reasons: [],
      receipt: {
        kind: "linkedin_primary_body",
        reason: body.reason,
        text: body.text
      }
    };
  }
  if (native.platform === "instagram") {
    const receipt = validateInstagramReceipt(candidate);
    return receipt.accepted
      ? { status: "accepted", reasons: [], receipt: receipt.receipt }
      : { status: "rejected", reasons: receipt.reasons };
  }
  return {
    status: "rejected",
    reasons: [ownership?.reason ?? "unsupported_validation_platform"]
  };
}

export function validateNetworkPayload(candidate, payload) {
  if (candidate.native.platform === "x") {
    return validateXOembed(candidate, payload);
  }
  if (candidate.native.platform === "youtube") {
    return validateYouTubeOembed(candidate, payload);
  }
  return { accepted: false, reasons: ["network_validation_not_supported"] };
}

export function validationEndpoint(candidate) {
  const encoded = encodeURIComponent(candidate.native.sourceUrl);
  if (candidate.native.platform === "x") {
    return `https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encoded}`;
  }
  if (candidate.native.platform === "youtube") {
    return `https://www.youtube.com/oembed?format=json&url=${encoded}`;
  }
  return null;
}

export function buildPromotionEvidence(candidate, validation) {
  const resolved = candidate.native.platform === "youtube"
    ? applyYouTubeOwner(candidate.row, candidate.ownership)
    : applyResolvedNativeAuthor(candidate.row, candidate.ownership);
  const extractedText = validation?.receipt?.text;
  const checkedAt = validation?.checkedAt ?? null;
  const rawVisibleText = serializeRawVisibleText(
    resolved.rawVisibleText,
    validation?.receipt?.rawVisibleText,
    extractedText,
    {
      recovery: NEEDS_REVIEW_NATIVE_RECOVERY_VERSION,
      physicalKey: candidate.physicalKey,
      sourceUrl: candidate.native.sourceUrl,
      validation: validation?.receipt ?? null
    }
  );
  const row = {
    ...resolved,
    sourceEvidenceId: resolved.sourceEvidenceId ?? resolved.id ?? null,
    sourceUrl: candidate.native.sourceUrl,
    platformPostId: candidate.native.postId,
    ...(extractedText ? { text: extractedText } : {}),
    ...(extractedText && !resolved.title
      ? { title: extractedText.slice(0, 300) }
      : {}),
    rawVisibleText,
    review_state: "verified",
    linkStatus: "verified",
    ...(checkedAt ? { linkCheckedAt: checkedAt, last_checked_at: checkedAt } : {}),
    attributionStatus: "verified",
    attributionMode: "account_owner",
    attributionVersion: Math.max(3, Number(resolved.attributionVersion ?? 0)),
    attributionSignals: [...new Set([
      ...(resolved.attributionSignals ?? []),
      "unique_native_author",
      validationSignal(candidate.native.platform)
    ])].sort(),
    metrics: normalizedMetrics(resolved.metrics),
    contributionScore: Number.isFinite(Number(resolved.contributionScore))
      ? Number(resolved.contributionScore)
      : 0,
    _needsReviewRecovery: {
      schemaVersion: NEEDS_REVIEW_NATIVE_RECOVERY_VERSION,
      physicalKey: candidate.physicalKey,
      validation: validation?.receipt ?? null
    }
  };
  delete row.quarantineReasons;
  delete row.attributionReconciliationDirective;
  return row;
}

export function summarizeRecovery({ candidates, validations, discoveryRejected }) {
  const accepted = [];
  const rejected = [...(discoveryRejected ?? [])];
  for (const candidate of candidates ?? []) {
    const validation = validations.get(candidate.physicalKey);
    if (validation?.status === "accepted") {
      accepted.push(buildPromotionEvidence(candidate, validation));
    } else {
      rejected.push(rejection(
        candidate.row,
        candidate.native,
        validation?.reasons ?? ["validation_not_completed"]
      ));
    }
  }
  accepted.sort((left, right) =>
    canonicalNativePost(left).physicalKey.localeCompare(canonicalNativePost(right).physicalKey)
  );
  const rejectionReasons = countReasons(rejected);
  const byBatch = countValues(accepted, (row) => row.batchSlug ?? "unscoped");
  const byPlatform = countValues(accepted, (row) => row.platform ?? "unknown");
  return { accepted, rejected, rejectionReasons, byBatch, byPlatform };
}

export function recoveryInputFingerprint(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function validateInstagramReceipt(candidate) {
  let payload;
  try {
    payload = JSON.parse(String(candidate.row?.rawVisibleText ?? ""));
  } catch {
    return { accepted: false, reasons: ["instagram_receipt_invalid_json"] };
  }
  const expectedAuthor = candidate.ownership?.author?.key;
  const post = payload?.post ?? payload?.receipt?.post ?? null;
  const receipt = payload?.receipt ?? payload;
  const shortcode = String(post?.shortcode ?? post?.id ?? "");
  const author = normalizeHandle(
    post?.authorUsername ?? post?.authorHandle ?? payload?.profile?.username
  );
  const receiptAccount = normalizeHandle(
    receipt?.username ?? payload?.profile?.username ?? post?.authorUsername
  );
  const source = String(receipt?.source ?? payload?.source ?? "");
  const supportedProfileSource = [
    "instagram_public_web_profile_info_v1",
    "instagram_native_feed_api",
    "instagram_browser_profile_grid"
  ].includes(source) || payload?.verification?.ownerMatchesSeededAccount === true;
  const nativeFeed = receipt?.nativeFeed ?? payload?.nativeFeed ?? null;
  const supportedAnonymousNativeFeed = [
    "instagram_anonymous_native_feed_standalone_v1",
    "instagram_public_web_profile_info_with_native_feed_metrics_v1"
  ].includes(source) &&
    nativeFeed?.source === "instagram_anonymous_native_feed_v1" &&
    Number(nativeFeed?.uniqueItemCount ?? 0) > 0 &&
    post?.nativeFeedOnly === true &&
    post?.nativeFeedMetricSource === "instagram_anonymous_native_feed_v1" &&
    post?.profileRole === "primary" &&
    candidate.row?.attributionProvenance ===
      "instagram_anonymous_native_feed_native_owner_v1" &&
    candidate.row?.nativeAuthorResolution?.status === "matched";
  const supportedSource = supportedProfileSource || supportedAnonymousNativeFeed;
  const reasons = [];
  if (!supportedSource) reasons.push("instagram_receipt_source_unverified");
  if (shortcode !== candidate.native.postId) reasons.push("instagram_receipt_post_id_mismatch");
  if (!expectedAuthor || author !== expectedAuthor || receiptAccount !== expectedAuthor) {
    reasons.push("instagram_receipt_author_mismatch");
  }
  return {
    accepted: reasons.length === 0,
    reasons,
    receipt: reasons.length === 0
      ? { kind: "instagram_profile_receipt", source, author, shortcode }
      : null
  };
}

function validateXOembed(candidate, payload) {
  const returned = canonicalNativePost({ platform: "x", sourceUrl: payload?.url });
  const returnedAuthor = xAccountIdentity(payload?.author_url);
  const expectedAuthor = candidate.ownership?.author?.key;
  const rawVisibleText = String(payload?.html ?? "").trim();
  const text = visibleTextFromOembedHtml(rawVisibleText);
  const reasons = [];
  if (returned?.physicalKey !== candidate.physicalKey) reasons.push("x_oembed_post_id_mismatch");
  if (!expectedAuthor || returnedAuthor !== expectedAuthor) {
    reasons.push("x_oembed_author_identity_mismatch");
  }
  if (!rawVisibleText.includes("twitter-tweet") || !text) {
    reasons.push("x_oembed_post_body_missing");
  }
  return {
    accepted: reasons.length === 0,
    reasons,
    receipt: reasons.length === 0
      ? {
          kind: "official_x_oembed",
          author: returnedAuthor,
          returnedUrl: returned.sourceUrl,
          text,
          rawVisibleText
        }
      : null
  };
}

function validateYouTubeOembed(candidate, payload) {
  const returnedAuthor = youtubeAccountIdentity(payload?.author_url);
  const expectedAuthor = candidate.ownership?.author?.key;
  const reasons = [];
  if (!expectedAuthor || returnedAuthor !== expectedAuthor) {
    reasons.push("youtube_oembed_author_identity_mismatch");
  }
  if (!String(payload?.title ?? "").trim()) reasons.push("youtube_oembed_title_missing");
  return {
    accepted: reasons.length === 0,
    reasons,
    receipt: reasons.length === 0
      ? {
          kind: "official_youtube_oembed",
          author: returnedAuthor,
          text: String(payload.title).trim(),
          rawVisibleText: stableStringify({
            authorName: payload?.author_name ?? null,
            authorUrl: payload?.author_url ?? null,
            providerName: payload?.provider_name ?? null,
            title: payload?.title ?? null,
            type: payload?.type ?? null
          })
        }
      : null
  };
}

function visibleTextFromOembedHtml(value) {
  const html = String(value ?? "");
  const paragraph = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
  return decodeHtmlEntities(
    paragraph
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim()
  );
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function serializeRawVisibleText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") return stableStringify(value);
  }
  throw new Error("Verified recovery evidence is missing a raw visible text receipt.");
}

function buildYouTubeOwnerIndex(catalogs) {
  const index = new Map();
  for (const catalog of catalogs ?? []) {
    for (const company of catalog?.companies ?? []) {
      indexYouTubeAccounts(index, catalog, company, company, "company");
      for (const founder of company.founders ?? []) {
        indexYouTubeAccounts(index, catalog, company, founder, "founder");
      }
    }
  }
  return index;
}

function indexYouTubeAccounts(index, catalog, company, entity, entityType) {
  for (const account of entity.accounts ?? []) {
    if (normalizePlatform(account?.platform) !== "youtube" || account?.verified !== true) continue;
    const key = youtubeAccountIdentity(account.url ?? account.handle);
    if (!key) continue;
    const owner = {
      batchSlug: catalog.slug,
      entityType,
      entityId: entity.sourceKey,
      entityName: entity.name,
      companySlug: companySlug(company),
      companyName: company.name,
      companyEntityId: company.sourceKey
    };
    index.set(key, [...(index.get(key) ?? []), { owner, author: { platform: "youtube", key } }]);
  }
}

function resolveYouTubeOwnership(row, index) {
  const key = youtubeAccountIdentity(row?.youtubeChannelUrl ?? row?.accountUrl);
  if (!key) return { status: "unavailable", reason: "youtube_channel_identity_unavailable" };
  const matches = [...new Map(
    (index.get(key) ?? []).map((entry) => [
      `${entry.owner.batchSlug}:${entry.owner.entityType}:${entry.owner.entityId}`,
      entry
    ])
  ).values()];
  if (matches.length === 0) {
    return { status: "unmatched", reason: "youtube_channel_not_in_verified_roster", author: { platform: "youtube", key } };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", reason: "youtube_channel_maps_to_multiple_owners", author: { platform: "youtube", key } };
  }
  return { status: "matched", reason: "youtube_channel_maps_to_unique_owner", ...matches[0] };
}

function applyYouTubeOwner(row, ownership) {
  const owner = ownership.owner;
  return {
    ...row,
    batchSlug: owner.batchSlug,
    entityType: owner.entityType,
    entityId: owner.entityId,
    entityName: owner.entityName,
    companySlug: owner.companySlug,
    companyName: owner.companyName,
    nativeAuthorResolution: {
      status: "matched",
      reason: ownership.reason,
      author: ownership.author,
      owner
    }
  };
}

function validationSignal(platform) {
  return {
    x: "official_x_oembed_author_match",
    linkedin: "linkedin_primary_body_author_match",
    instagram: "instagram_profile_receipt_author_match",
    youtube: "official_youtube_oembed_author_match"
  }[platform];
}

function youtubeAccountIdentity(value) {
  try {
    const url = new URL(String(value ?? ""));
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("@")) return `handle:${parts[0].slice(1).toLowerCase()}`;
    if (parts[0] === "channel" && parts[1]) return `channel:${parts[1].toLowerCase()}`;
    if (["c", "user"].includes(parts[0]) && parts[1]) {
      return `${parts[0]}:${parts[1].toLowerCase()}`;
    }
  } catch {
    const handle = normalizeHandle(value);
    if (handle) return `handle:${handle}`;
  }
  return null;
}

function xAccountIdentity(value) {
  try {
    const url = new URL(String(value ?? ""));
    return normalizeHandle(url.pathname.split("/").filter(Boolean)[0]);
  } catch {
    return normalizeHandle(value);
  }
}

function companySlug(company) {
  try {
    const parts = new URL(company?.profileUrl).pathname.split("/").filter(Boolean);
    const index = parts.indexOf("companies");
    if (index >= 0 && parts[index + 1]) return parts[index + 1];
  } catch {
    // Stable source identity below.
  }
  return String(company?.sourceKey ?? "")
    .replace(/^company-/, "")
    .replace(/^a16z-speedrun-006-/, "");
}

function rejection(row, native, reasons) {
  return {
    id: row?.id ?? null,
    batchSlug: row?.batchSlug ?? row?.batch_slug ?? null,
    platform: normalizePlatform(row?.platform),
    physicalKey: native?.physicalKey ?? null,
    reasons: [...new Set(reasons)].sort()
  };
}

function countReasons(rows) {
  const counts = {};
  for (const row of rows) {
    for (const reason of row.reasons ?? []) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0])
  ));
}

function countValues(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = String(key(row));
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort());
}

function normalizedMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, metric]) =>
    Number.isFinite(Number(metric)) && Number(metric) >= 0
  ).map(([key, metric]) => [key, Number(metric)]));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeHandle(value) {
  return String(value ?? "").trim().replace(/^@/, "").replace(/\/$/, "").toLowerCase() || null;
}

function normalizePlatform(value) {
  const platform = String(value ?? "").trim().toLowerCase();
  return platform === "twitter" ? "x" : platform;
}
