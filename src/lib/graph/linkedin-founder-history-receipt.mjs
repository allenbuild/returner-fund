import { createHash } from "node:crypto";

export const NATIVE_LINKEDIN_FOUNDER_HISTORY_PROVENANCE = "native_linkedin_founder_history_v1";
export const NATIVE_LINKEDIN_FOUNDER_HISTORY_VALIDATION = "fall_2026_native_linkedin_founder_history_ingestion_v1";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const decode = (value) => value.replace(/&(?:amp|quot|apos|lt|gt|nbsp|hellip|rsquo|lsquo|ndash|mdash);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", hellip: "…", rsquo: "’", lsquo: "‘", ndash: "–", mdash: "—" };
  const key = entity.slice(1, -1).toLowerCase();
  if (key in named) return named[key];
  const point = /^#x/i.test(key) ? parseInt(key.slice(2), 16) : Number(key.slice(1));
  return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
});
const textFromHtml = (value) => decode(value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, ""));
const attribute = (html, name) => decode(String(html ?? "").match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2] ?? "");
const validClock = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function linkedinUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port || url.hash) return null;
    const profile = url.pathname.match(/^\/in\/([^/]+)\/?$/i), activity = url.pathname.match(/^\/feed\/update\/urn:li:activity:(\d+)\/?$/);
    const ugc = url.pathname.match(/^\/posts\/[^/]+-ugcPost-(\d+)-[^/]+\/?$/)?.[1] ?? url.pathname.match(/^\/feed\/update\/urn:li:ugcPost:(\d+)\/?$/)?.[1];
    return profile && [...url.searchParams.keys()].every((key) => key === "trk") ? { profile: `https://www.linkedin.com/in/${profile[1].toLowerCase()}/`, activityId: null } : activity && !url.search ? { profile: null, activityId: activity[1] } : ugc ? { profile: null, activityId: null, ugcPostId: ugc } : null;
  } catch { return null; }
}

function verifiedUgcDetail(receipt, entity, ownCaption) {
  const proof = receipt.detailProof, native = proof?.nativeReceipt, detail = native?.detail, card = receipt.card;
  if (proof?.mechanism !== "native_linkedin_founder_copy_link_ugc_detail_v1" || native?.collectionMethod !== "native_exact_founder_card_copy_link_native_detail_v1" || native.sourceCardKey !== card.componentKey || native.sourceCardMenuLabel !== card.menuLabel || JSON.stringify(native.sourceCaption) !== JSON.stringify(card.captionNodes[0]) || !/^https:\/\/lnkd\.in\/p\/[A-Za-z0-9_-]+$/.test(native.copiedUrl ?? "") || !validClock(native.observedAt) || !validClock(detail?.observedAt) || Date.parse(detail.observedAt) > Date.parse(native.observedAt) || Date.parse(native.observedAt) > Date.parse(receipt.observedAt) || detail.url !== native.resolvedUrl || typeof detail.html !== "string") return null;
  const id = linkedinUrl(native.resolvedUrl)?.ugcPostId;
  // Comment URNs are separate native DOM observations outside the scoped post
  // HTML. Their exact array is bound by the physically validated receipt hash.
  const matchingUgcReference = (reference) => {
    if (typeof reference !== "string") return false;
    const ids = [...reference.matchAll(/urn:li:comment:\(ugcPost:(\d+),/g), ...reference.matchAll(/thread=urn:li:ugcPost:(\d+)(?=\))/g)].map((match) => match[1]);
    return ids.length > 0 && ids.every((nativeId) => nativeId === id);
  };
  if (!id || detail.nativeObjectType !== "ugcPost" || detail.nativePostId !== id || !new URL(native.resolvedUrl).pathname.startsWith("/posts/") || !Array.isArray(detail.nativeCommentUrnReferences) || !detail.nativeCommentUrnReferences.length || !detail.nativeCommentUrnReferences.every(matchingUgcReference)) return null;
  const caption = detail.captionNodes?.[0], body = nativeLinkedInFounderCaption(caption), header = detail.authorHeader;
  if (!body.ok || normalize(body.text) !== normalize(ownCaption) || !detail.html.includes(caption.html) || detail.menuLabel !== card.menuLabel || !header?.html || !detail.html.includes(header.html) || detail.html.indexOf(header.html) >= detail.html.indexOf(caption.html)) return null;
  const expectedProfile = linkedinUrl(receipt.profileUrl)?.profile;
  if (!(header.html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []).some((anchor) => linkedinUrl(attribute(anchor, "href"))?.profile === expectedProfile && normalize(textFromHtml(anchor)).startsWith(entity.founderName)) || !header.links?.some((link) => linkedinUrl(link.href ?? link.url)?.profile === expectedProfile && link.text?.split("\n")[0]?.trim() === entity.founderName)) return null;
  const menu = detail.controls?.filter((control) => control.ariaLabel === card.menuLabel && attribute(control.html, "aria-label") === card.menuLabel && detail.html.includes(control.html)) ?? [];
  if (menu.length !== 1 || detail.timeNodes?.some((time) => time.datetime)) return null;
  return { id, sourceUrl: native.resolvedUrl, metricCard: { ownCardHtml: detail.html, captionNodes: detail.captionNodes, controls: detail.controls } };
}

function verifiedShareActivityDetail(receipt, entity, ownCaption) {
  const proof = receipt.detailProof, native = proof?.nativeReceipt, detail = native?.detail, card = receipt.card;
  if (proof?.mechanism !== "native_linkedin_founder_copy_link_share_activity_detail_v1" || native?.collectionMethod !== "native_exact_founder_card_copy_link_native_detail_v1" || native.sourceCardKey !== card.componentKey || native.sourceCardMenuLabel !== card.menuLabel || JSON.stringify(native.sourceCaption) !== JSON.stringify(card.captionNodes[0]) || !/^https:\/\/lnkd\.in\/p\/[A-Za-z0-9_-]+$/.test(native.copiedUrl ?? "") || !validClock(native.observedAt) || !validClock(detail?.observedAt) || Date.parse(detail.observedAt) > Date.parse(native.observedAt) || Date.parse(native.observedAt) > Date.parse(receipt.observedAt) || detail.url !== native.resolvedUrl || typeof detail.html !== "string") return null;
  let resolved;
  try { resolved = new URL(native.resolvedUrl); } catch { return null; }
  const shareId = resolved.pathname.match(/^\/posts\/[^/]+-share-(\d+)-[^/]+\/?$/)?.[1];
  if (resolved.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(resolved.hostname) || resolved.username || resolved.password || resolved.port || resolved.hash || !shareId || detail.nativeObjectType !== null || detail.nativePostId !== null || !Array.isArray(detail.nativeCommentUrnReferences) || !detail.nativeCommentUrnReferences.length) return null;
  // These are literal native comment-component DOM attributes captured on the
  // same resolved detail page, outside the scoped post HTML. They are bound by
  // the physical receipt hash. A share URL never supplies an activity ID.
  const activityIds = new Set();
  for (const reference of detail.nativeCommentUrnReferences) {
    if (typeof reference !== "string") return null;
    const match = reference.match(/^(?:replaceableComment_|CommentComponentReference_)urn:li:comment:\(activity:(\d+),\d+\)$/) ?? reference.match(/^comment-urn:li:comment:\(activity:(\d+),\d+\)::\d+$/);
    if (!match) return null;
    activityIds.add(match[1]);
  }
  if (activityIds.size !== 1) return null;
  const id = [...activityIds][0];
  if (id === shareId) return null;
  const caption = detail.captionNodes?.[0], body = nativeLinkedInFounderCaption(caption), header = detail.authorHeader;
  if (!body.ok || normalize(body.text) !== normalize(ownCaption) || !detail.html.includes(caption.html) || detail.menuLabel !== card.menuLabel || !header?.html || !detail.html.includes(header.html) || detail.html.indexOf(header.html) >= detail.html.indexOf(caption.html)) return null;
  const expectedProfile = linkedinUrl(receipt.profileUrl)?.profile;
  if (!(header.html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []).some((anchor) => linkedinUrl(attribute(anchor, "href"))?.profile === expectedProfile && normalize(textFromHtml(anchor)).startsWith(entity.founderName)) || !header.links?.some((link) => linkedinUrl(link.href ?? link.url)?.profile === expectedProfile && link.text?.split("\n")[0]?.trim() === entity.founderName)) return null;
  const menu = detail.controls?.filter((control) => control.ariaLabel === card.menuLabel && attribute(control.html, "aria-label") === card.menuLabel && detail.html.includes(control.html)) ?? [];
  if (menu.length !== 1 || detail.timeNodes?.some((time) => time.datetime)) return null;
  return { id, shareId, observedSourceUrl: native.resolvedUrl, metricCard: { ownCardHtml: detail.html, captionNodes: detail.captionNodes, controls: detail.controls } };
}
const metricsEqual = (left, right) => left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right) && Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, count]) => Number.isSafeInteger(count) && count >= 0 && right[key] === count);

/** Remove only a captured native aria-hidden expandable button. A visible
 * expansion control, unsupported suffix or uncorroborated body remains held. */
export function nativeLinkedInFounderCaption(node) {
  const captionHtml = node?.captionNodeHtml ?? node?.html;
  if (typeof node?.text !== "string" || !node.text || typeof captionHtml !== "string" || !captionHtml || !Array.isArray(node.remainingSeeMoreControls)) return { ok: false, reason: "native_caption_nodes_required" };
  let text = node.text, html = captionHtml;
  for (const control of node.remainingSeeMoreControls) {
    if (typeof control.html !== "string" || !html.includes(control.html) || attribute(control.html, "aria-hidden") !== "true" || attribute(control.html, "data-testid") !== "expandable-text-button" || normalize(textFromHtml(control.html)) !== "… more" || normalize(control.text) !== "… more" || !text.endsWith(control.text)) return { ok: false, reason: "native_caption_expansion_not_corroborated" };
    html = html.replace(control.html, "");
    text = text.slice(0, -control.text.length).replace(/\s+$/, "");
  }
  if (!text || /data-testid=["']expandable-text-button["']/.test(html) || normalize(textFromHtml(html)) !== normalize(text)) return { ok: false, reason: "native_caption_html_text_conflict" };
  return { ok: true, text, removedUiControlCount: node.remainingSeeMoreControls.length };
}

function verifiedEmbedActivity(receipt, entity, ownCaption) {
  const proof = receipt.detailProof, native = proof?.nativeReceipt, preview = native?.preview, card = receipt.card;
  if (proof?.mechanism !== "native_linkedin_founder_embed_article_v1" || native?.collectionMethod !== "native_exact_founder_card_embed_article_v1" || native.sourceCardKey !== card.componentKey || native.sourceCardMenuLabel !== card.menuLabel || JSON.stringify(native.sourceCaption) !== JSON.stringify(card.captionNodes[0]) || !validClock(native.observedAt) || !validClock(preview?.observedAt) || Date.parse(preview.observedAt) > Date.parse(native.observedAt) || Date.parse(native.observedAt) > Date.parse(receipt.observedAt) || typeof preview.html !== "string") return null;
  const urn = preview.activityUrn?.match(/^urn:li:activity:(\d+)$/)?.[1];
  if (!urn || attribute(preview.html, "data-activity-urn") !== preview.activityUrn || !/^<article\b/i.test(preview.html)) return null;
  const paragraphs = (preview.paragraphs?.filter((paragraph) => paragraph.html && preview.html.includes(paragraph.html) && ["main-feed-activity-embed-card__commentary", "feed-reshare-content__commentary"].includes(attribute(paragraph.html, "data-test-id"))) ?? []).sort((left, right) => preview.html.indexOf(left.html) - preview.html.indexOf(right.html));
  // Choose the first native own commentary by actual DOM position. A quoted
  // body's later paragraph can never substitute for a missing own wrapper.
  if (!paragraphs.length || normalize(paragraphs[0].text) !== normalize(ownCaption) || normalize(textFromHtml(paragraphs[0].html)) !== normalize(ownCaption)) return null;
  const paragraphIndex = preview.html.indexOf(paragraphs[0].html), expectedProfile = linkedinUrl(receipt.profileUrl)?.profile;
  const anchors = preview.html.slice(0, paragraphIndex).match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  const primary = anchors.filter((html) => attribute(html, "data-tracking-control-name") === "public_post_embed_feed-actor-name" && linkedinUrl(attribute(html, "href"))?.profile === expectedProfile && normalize(textFromHtml(html)) === entity.founderName);
  if (primary.length !== 1 || !preview.links?.some((link) => linkedinUrl(link.href)?.profile === expectedProfile && normalize(link.text) === entity.founderName && new URL(link.href).searchParams.get("trk") === "public_post_embed_feed-actor-name")) return null;
  if (preview.timeNodes?.some((time) => time.datetime)) return null;
  return urn;
}

export function nativeLinkedInFounderCardSummary(receipt, entity) {
  const reasons = [], card = receipt?.card, html = card?.ownCardHtml, caption = card?.captionNodes?.[0];
  const expected = entity?.socialAccounts?.linkedin, known = (Array.isArray(expected) ? expected : [expected]).map((url) => linkedinUrl(url)?.profile).filter(Boolean);
  const account = linkedinUrl(receipt?.profileUrl)?.profile;
  if (receipt?.mechanism !== "native_linkedin_founder_activity_card_v1" || !account || !known.includes(account) || receipt.companySlug !== entity?.companySlug || receipt.founderName !== entity?.founderName || typeof receipt.founderId !== "string" || !entity?.entityId?.endsWith(`-${receipt.founderId}`) || !validClock(receipt.observedAt)) reasons.push("linkedin_founder_known_profile_identity_conflict");
  if (!card || typeof html !== "string" || !html || !Array.isArray(card.captionNodes) || !Array.isArray(card.links) || !Array.isArray(card.controls)) return { ok: false, reasons: [...reasons, "linkedin_founder_native_card_required"] };
  const menuLabel = `Open control menu for post by ${entity?.founderName}`;
  if (card.menuLabel !== menuLabel || !card.menuHtml || !html.includes(card.menuHtml) || attribute(card.menuHtml, "aria-label") !== menuLabel) reasons.push("linkedin_founder_exact_own_menu_required");
  const captionResult = nativeLinkedInFounderCaption(caption);
  if (!captionResult.ok || !caption?.html || !html.includes(caption.html) || !caption.html.includes(caption.captionNodeHtml ?? caption.html)) reasons.push("linkedin_founder_exact_first_own_caption_required");
  const captionIndex = caption?.html ? html.indexOf(caption.html) : -1;
  const actor = card.links.find((link) => linkedinUrl(link.href)?.profile === account && link.text?.split("\n")[0]?.trim() === entity?.founderName && link.html && html.includes(link.html) && html.indexOf(link.html) < captionIndex && linkedinUrl(attribute(link.html, "href"))?.profile === account && normalize(textFromHtml(link.html)).startsWith(entity.founderName));
  const header = card.authorHeader, headerIndex = header?.html ? html.indexOf(header.html) : -1;
  const headerActor = headerIndex >= 0 && headerIndex < captionIndex && (header.html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []).some((anchor) => linkedinUrl(attribute(anchor, "href"))?.profile === account && normalize(textFromHtml(anchor)).startsWith(entity.founderName)) && header.links?.some((link) => linkedinUrl(link.href)?.profile === account && link.text?.split("\n")[0]?.trim() === entity.founderName);
  if ((!actor && !headerActor) || captionIndex < 0) reasons.push("linkedin_founder_primary_actor_before_caption_required");
  const outer = linkedinUrl(caption?.href), anchorHref = linkedinUrl(attribute(caption?.html, "href"));
  const carouselId = outer?.activityId && anchorHref?.activityId === outer.activityId && /^<a\b/i.test(caption?.html ?? "") ? outer.activityId : null;
  const embedId = receipt.detailProof?.mechanism === "native_linkedin_founder_embed_article_v1" && captionResult.ok ? verifiedEmbedActivity(receipt, entity, captionResult.text) : null;
  const ugc = receipt.detailProof?.mechanism === "native_linkedin_founder_copy_link_ugc_detail_v1" && captionResult.ok ? verifiedUgcDetail(receipt, entity, captionResult.text) : null;
  const shareActivity = receipt.detailProof?.mechanism === "native_linkedin_founder_copy_link_share_activity_detail_v1" && captionResult.ok ? verifiedShareActivityDetail(receipt, entity, captionResult.text) : null;
  if (!carouselId && !embedId && !ugc && !shareActivity || receipt.detailProof && (!embedId && !ugc && !shareActivity || carouselId && carouselId !== (embedId ?? shareActivity?.id))) reasons.push("linkedin_founder_outer_caption_or_native_embed_activity_required");
  const platformPostId = ugc ? `ugcPost:${ugc.id}` : carouselId ?? embedId ?? shareActivity?.id, sourceUrl = ugc?.sourceUrl ?? (platformPostId ? `https://www.linkedin.com/feed/update/urn:li:activity:${platformPostId}/` : null);
  // All caption nodes, including nested quote text, precede the owner's action
  // footer. Counts inside a quote or duplicate counters remain unknown.
  const metricCard = ugc?.metricCard ?? shareActivity?.metricCard ?? card, metricHtml = metricCard.ownCardHtml;
  let lastCaptionEnd = -1;
  for (const node of metricCard.captionNodes) {
    const nodeHtml = node.html ?? node.captionNodeHtml;
    if (typeof nodeHtml !== "string" || !metricHtml.includes(nodeHtml)) reasons.push("linkedin_founder_nested_caption_scope_conflict");
    else lastCaptionEnd = Math.max(lastCaptionEnd, metricHtml.indexOf(nodeHtml) + nodeHtml.length);
  }
  const metrics = {};
  for (const [metric, label, tag] of [["reactions", /^Reaction button state: /, "BUTTON"], ["comments", /^Comment$/, "A"], ["reposts", /^Repost$/, "BUTTON"]]) {
    const controls = metricCard.controls.filter((control) => label.test(control.ariaLabel ?? "") && control.html?.match(/^<([a-z]+)\b/i)?.[1]?.toUpperCase() === tag && (control.tag === undefined || control.tag === tag) && metricHtml.includes(control.html) && metricHtml.indexOf(control.html) >= lastCaptionEnd && attribute(control.html, "aria-label") === control.ariaLabel && (metric !== "comments" || (control.href === undefined || linkedinUrl(control.href)?.activityId === platformPostId) && linkedinUrl(attribute(control.html, "href"))?.activityId === platformPostId));
    if (controls.length !== 1) continue;
    const control = controls[0], literal = control.text?.trim();
    if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(literal ?? "") || normalize(textFromHtml(control.html)) !== literal) continue;
    const count = Number(literal.replaceAll(",", ""));
    if (Number.isSafeInteger(count)) metrics[metric] = count;
  }
  if (card.timeNodes?.length) reasons.push("linkedin_founder_native_time_requires_separate_precision_contract");
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], platformPostId, sourceUrl, accountUrl: account, text: captionResult.ok ? captionResult.text : null, metrics, postedAt: null, publishedAtPrecision: "unknown" };
}

export function verifiedNativeLinkedInFounderHistoryReasons(row, entity) {
  if (row?.platform !== "linkedin" || row.attributionProvenance !== NATIVE_LINKEDIN_FOUNDER_HISTORY_PROVENANCE) return ["linkedin_founder_native_provenance_required"];
  let raw;
  try { raw = JSON.parse(row.rawVisibleText); } catch { return ["linkedin_founder_native_receipt_required"]; }
  const receipt = raw?.post?.nativeFounderHistoryReceipt, validation = raw?.validation;
  if (raw?.source !== "authorized_linkedin_browser_dom_v1" || !receipt || validation?.source !== NATIVE_LINKEDIN_FOUNDER_HISTORY_VALIDATION) return ["linkedin_founder_native_receipt_required"];
  const result = nativeLinkedInFounderCardSummary(receipt, entity), reasons = [...result.reasons];
  if (row.batchSlug !== "F26" || row.entityType !== "founder" || row.entityId !== entity?.entityId || row.companyName !== entity?.companyName || row.authorName !== entity?.founderName || row.review_state !== "verified" || row.attributionVersion !== 3 || row.attributionStatus !== "verified" || row.attributionMode !== "author") reasons.push("linkedin_founder_verified_canonical_owner_required");
  const nativeKey = (url) => { const id = linkedinUrl(url); return id?.ugcPostId ? `ugcPost:${id.ugcPostId}` : id?.activityId; };
  const normalizedObservedUgcUrl = (value) => { try { const url = new URL(value); for (const key of [...url.searchParams.keys()]) if (key.startsWith("utm_")) url.searchParams.delete(key); url.searchParams.sort(); return `${url.protocol}//${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}?${url.searchParams}`; } catch { return null; } };
  if (row.platformPostId !== result.platformPostId || nativeKey(row.sourceUrl) !== result.platformPostId || linkedinUrl(row.accountUrl)?.profile !== result.accountUrl || raw.post.id !== result.platformPostId || nativeKey(raw.post.url) !== result.platformPostId || String(result.platformPostId).startsWith("ugcPost:") && (normalizedObservedUgcUrl(row.sourceUrl) !== normalizedObservedUgcUrl(result.sourceUrl) || raw.post.url !== result.sourceUrl)) reasons.push("linkedin_founder_exact_native_outer_id_conflict");
  if (row.text !== result.text || row.originalText !== result.text || raw.post.text !== result.text || raw.post.bodyTruncated !== false || row.bodyTruncated === true || row.captionAbsent === true) reasons.push("linkedin_founder_exact_native_body_conflict");
  if (!metricsEqual(row.metrics, result.metrics) || !metricsEqual(raw.post.metrics, result.metrics)) reasons.push("linkedin_founder_scoped_native_metrics_conflict");
  if (row.postedAt !== null || raw.post.publishedAt !== null || row.publishedAtPrecision !== "unknown") reasons.push("linkedin_founder_relative_date_must_remain_unknown");
  if (!validClock(raw.observedAt) || Date.parse(raw.observedAt) < Date.parse(receipt.observedAt)) reasons.push("linkedin_founder_native_observation_clock_conflict");
  if (validation.archiveHashesVerified !== true || validation.nativeFounderHistoryReceiptSha256 !== hash(receipt) || validation.nativeCardSha256 !== hash(receipt.card)) reasons.push("linkedin_founder_native_validation_hash_conflict");
  return [...new Set(reasons)];
}

export function isVerifiedNativeLinkedInFounderHistoryReceipt(row, entity) {
  try { return verifiedNativeLinkedInFounderHistoryReasons(row, entity).length === 0; } catch { return false; }
}
