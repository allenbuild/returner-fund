const NUMBER = "[\\d,.]+[KMB]?";

/**
 * Extracts only post-level LinkedIn engagement from either a verified
 * structured native receipt or the primary post footer in LinkedIn's public
 * reader. Comment counters and related-post counters are outside the bounded
 * primary region and can never be returned.
 */
export function extractLinkedInParentPostMetrics({ rawVisibleText, expectedPostId = null } = {}) {
  const text = String(rawVisibleText ?? "");
  const expected = cleanPostId(expectedPostId);
  if (!text.trim()) return unproven("linkedin_metric_payload_missing");

  const structured = structuredNativeReceipt(text, expected);
  if (structured) return structured;

  const sourceUrl = text.match(/\bURL\s+Source\s*:\s*(https?:\/\/\S+)/i)?.[1] ?? null;
  const sourcePostId = linkedInPostId(sourceUrl);
  if (!sourceUrl || !sourcePostId) {
    return unproven("linkedin_reader_source_activity_missing");
  }
  if (expected && sourcePostId !== expected) {
    return unproven("linkedin_reader_source_activity_mismatch");
  }

  const reportPattern = /\[Report this post\]\([^)]*guestReportContentType=POST[^)]*\)/ig;
  const reports = [...text.matchAll(reportPattern)];
  if (reports.length === 0) return unproven("linkedin_primary_post_report_marker_missing");
  const primaryStart = reports[0].index + reports[0][0].length;
  const boundaryIndices = [
    reports[1]?.index ?? -1,
    boundaryAfter(text, primaryStart, /\[Report this comment\]\([^)]*guestReportContentType=COMMENT[^)]*\)/i),
    boundaryAfter(text, primaryStart, /##\s+More Relevant Posts\b/i)
  ].filter((index) => index >= primaryStart);
  const primaryEnd = boundaryIndices.length > 0 ? Math.min(...boundaryIndices) : text.length;
  const primary = text.slice(primaryStart, primaryEnd);

  const pairPattern = new RegExp(
    `\\[(?:!\\[[^\\]]*\\]\\([^)]*\\)){1,12}\\s*(${NUMBER})\\]\\([^)]*\\)\\s*` +
      `\\[(${NUMBER})\\s+Comments?\\b(?:[^\\]]*\\]\\([^)]*\\))?`,
    "ig"
  );
  const pairs = [...primary.matchAll(pairPattern)];
  if (pairs.length > 0) {
    const pair = pairs.at(-1);
    return verifiedReaderMetrics({
      reactions: parseCompactNumber(pair[1]),
      comments: parseCompactNumber(pair[2])
    }, "linkedin_parent_icon_aggregate_and_comments");
  }

  const actionPattern = /\[Like\]\([^)]*\)\s*\[Comment\]\([^)]*\)(?:\s*(?:Share\b|\[Repost\]\([^)]*\)))?/ig;
  const actions = [...primary.matchAll(actionPattern)];
  if (actions.length === 0) {
    return unproven("linkedin_parent_engagement_footer_unproven");
  }
  const action = actions[0];
  const footer = primary.slice(Math.max(0, action.index - 1_800), action.index);
  const reactionPattern = new RegExp(
    `\\[(?:!\\[[^\\]]*\\]\\([^)]*\\)){1,12}\\s*(${NUMBER})(?:\\s+(?:Reactions?|Likes?))?\\]\\([^)]*\\)\\s*$`,
    "i"
  );
  const commentsPattern = new RegExp(
    `\\[(${NUMBER})\\s+Comments?\\b[^\\]]*\\]\\([^)]*\\)\\s*$`,
    "i"
  );
  const comments = footer.match(commentsPattern);
  const beforeComments = comments ? footer.slice(0, comments.index) : footer;
  const reactions = beforeComments.match(reactionPattern);
  const metrics = removeNullish({
    reactions: reactions ? parseCompactNumber(reactions[1]) : null,
    comments: comments ? parseCompactNumber(comments[1]) : null
  });
  if (Object.keys(metrics).length === 0) {
    return unproven("linkedin_parent_engagement_footer_unproven");
  }
  return verifiedReaderMetrics(
    metrics,
    reactions && comments
      ? "linkedin_parent_action_footer_reactions_and_comments"
      : reactions
        ? "linkedin_parent_action_footer_reactions_only"
        : "linkedin_parent_action_footer_comments_only"
  );
}

export function isLinkedInPublicReaderPayload(rawVisibleText) {
  const text = String(rawVisibleText ?? "");
  return /\bURL\s+Source\s*:\s*https?:\/\/\S+/i.test(text) &&
    /\[Report this post\]\([^)]*guestReportContentType=POST[^)]*\)/i.test(text);
}

function structuredNativeReceipt(text, expectedPostId) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const receiptPostId = cleanPostId(parsed?.post?.id ?? linkedInPostId(parsed?.post?.url));
  const accepted = parsed?.verification?.status === "accepted" &&
    parsed?.verification?.metricsVisible === true &&
    parsed?.verification?.notProfileOrSearchPage === true;
  if (!accepted || !receiptPostId || (expectedPostId && receiptPostId !== expectedPostId)) {
    return unproven("linkedin_structured_native_receipt_unverified");
  }
  const metrics = removeNullish({
    reactions: nonnegativeNumber(parsed?.counts?.reactions ?? parsed?.counts?.likes),
    comments: nonnegativeNumber(parsed?.counts?.comments)
  });
  if (!Object.values(metrics).some((value) => value > 0)) {
    return unproven("linkedin_structured_native_receipt_metricless");
  }
  return {
    status: "verified",
    source: "structured_native_receipt",
    reason: "linkedin_structured_native_receipt_verified",
    metrics
  };
}

function verifiedReaderMetrics(metrics, reason) {
  const cleaned = removeNullish(metrics);
  if (!Object.values(cleaned).some((value) => value > 0)) {
    return unproven("linkedin_parent_engagement_footer_metricless");
  }
  return { status: "verified", source: "public_reader_parent_footer", reason, metrics: cleaned };
}

function unproven(reason) {
  return { status: "unproven", source: null, reason, metrics: {} };
}

function boundaryAfter(text, start, pattern) {
  const relative = text.slice(start).search(pattern);
  return relative < 0 ? -1 : start + relative;
}

function linkedInPostId(value) {
  const text = String(value ?? "");
  return cleanPostId(
    text.match(/activity[-/:](\d{12,})\b/i)?.[1] ??
    text.match(/\burn:li:activity:(\d{12,})\b/i)?.[1]
  );
}

function cleanPostId(value) {
  const text = String(value ?? "").trim();
  return /^\d{12,}$/.test(text) ? text : null;
}

function parseCompactNumber(value) {
  const match = String(value ?? "").replace(/,/g, "").trim().match(/^([\d.]+)\s*([KMB])?$/i);
  if (!match) return null;
  const numeric = Number(match[1]);
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * multiplier) : null;
}

function nonnegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function removeNullish(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}
