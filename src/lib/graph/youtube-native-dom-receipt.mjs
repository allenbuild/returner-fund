import { createHash } from "node:crypto";

export const NATIVE_YOUTUBE_DOM_SOURCE = "authorized_native_youtube_watch_dom_v1";
export const NATIVE_YOUTUBE_DOM_VALIDATION = "fall_2026_native_youtube_watch_dom_ingestion_v1";
export const NATIVE_YOUTUBE_SHORT_DOM_SOURCE = "authorized_native_youtube_short_description_dom_v1";
export const NATIVE_YOUTUBE_SHORT_DOM_VALIDATION = "fall_2026_native_youtube_short_description_dom_ingestion_v1";
export const nativeYouTubeDomSource = (native) => native?.source === "native_youtube_watch_dom_v1" ? NATIVE_YOUTUBE_DOM_SOURCE : native?.source === "native_youtube_short_description_dom_v1" ? NATIVE_YOUTUBE_SHORT_DOM_SOURCE : null;
export const nativeYouTubeDomValidation = (native) => nativeYouTubeDomSource(native) === NATIVE_YOUTUBE_DOM_SOURCE ? NATIVE_YOUTUBE_DOM_VALIDATION : nativeYouTubeDomSource(native) === NATIVE_YOUTUBE_SHORT_DOM_SOURCE ? NATIVE_YOUTUBE_SHORT_DOM_VALIDATION : null;
export const isNativeYouTubeDomProvenance = (value) => [NATIVE_YOUTUBE_DOM_SOURCE, NATIVE_YOUTUBE_SHORT_DOM_SOURCE].includes(value);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
const normalize = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
const decode = (value) => String(value ?? "").replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " }, key = entity.slice(1, -1).toLowerCase();
  if (key in named) return named[key];
  const point = /^#x/.test(key) ? parseInt(key.slice(2), 16) : Number(key.slice(1));
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
});
const textFromHtml = (value) => decode(String(value ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, ""));
const attribute = (html, name) => decode(String(html ?? "").match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2] ?? "");
const validClock = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const publicUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash ? url : null;
  } catch { return null; }
};
const host = (value) => publicUrl(value)?.hostname.toLowerCase().replace(/^www\./, "") ?? null;
const nativeHref = (value) => { try { return new URL(value, "https://www.youtube.com").href; } catch { return null; } };
const exactInteger = (value) => /^(?:0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)$/.test(value ?? "");
const htmlDigest = (value) => createHash("sha256").update(value).digest("hex");
const hasHidden = (html) => /\bhidden(?:\s|=|>)/i.test(String(html ?? "").split(">")[0] + ">") || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attribute(String(html ?? "").split(">")[0] + ">", "style"));

// Slice the original element bytes, including nested same-tag nodes. Never
// reserialize archived HTML or infer a caption from the player title.
function exactElementsById(html, id) {
  if (typeof html !== "string") return [];
  const results = [], tags = [...html.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)\b[^>]*>/gi)];
  for (let index = 0; index < tags.length; index++) {
    const opening = tags[index];
    if (!opening[1] || opening[0].startsWith("</") || attribute(opening[0], "id") !== id) continue;
    let depth = 1;
    for (let end = index + 1; end < tags.length; end++) {
      const token = tags[end];
      if (token[1]?.toLowerCase() !== opening[1].toLowerCase()) continue;
      depth += token[0].startsWith("</") ? -1 : /\/\s*>$/.test(token[0]) ? 0 : 1;
      if (depth === 0) { results.push({ id, tag: opening[1].toUpperCase(), html: html.slice(opening.index, token.index + token[0].length) }); break; }
    }
  }
  return results;
}

/** Recover only a single complete native description variant from its own DOM. */
export function nativeYouTubeShortDescription(native) {
  const reasons = [], body = native?.description, html = native?.descriptionHtml, expander = native?.descriptionExpanderHtml, full = native?.fullDescriptionReceipt;
  const panel = native?.descriptionPanelHtml, root = native?.nativeShortIdentityBinding?.rootHtml;
  const fail = () => ({ ok: false, reasons: ["youtube_short_full_description_clipping_conflict"], text: null, html: null, normalization: null });
  if (!full || full.expandButtonVisible !== false || full.ellipsisVisible !== false || !Number.isFinite(full.snippetClientHeight) || !Number.isFinite(full.snippetScrollHeight) || full.snippetClientHeight <= 0 || full.snippetScrollHeight > full.snippetClientHeight || native?.bodyTruncated === true || typeof expander !== "string" || !/^<ytd-text-inline-expander\b/i.test(expander) || !panel?.includes(expander) || !root?.includes(panel)) return fail();
  if (full.isExpanded === true) {
    return full.textVisible === true && typeof body === "string" && normalize(body) && typeof html === "string" && attribute(html, "id") === "expanded" && !hasHidden(html) && normalize(textFromHtml(html)) === normalize(body) && expander.includes(html) && /\bis-expanded(?:\s|=|>)/i.test(expander.split(">")[0] + ">") && String(native.descriptionPanelText ?? "").includes(body) ? { ok: true, reasons, text: body, html, normalization: null } : fail();
  }
  const ids = ["plain-snippet-text", "attributed-snippet-text", "formatted-snippet-text"];
  const variants = ids.flatMap((id) => exactElementsById(expander, id));
  if (ids.some((id) => variants.filter((variant) => variant.id === id).length > 1)) return fail();
  const visible = variants.filter((variant) => !hasHidden(variant.html) && normalize(textFromHtml(variant.html)));
  if (visible.length !== 1) return fail();
  const selected = visible[0], selectedText = textFromHtml(selected.html), recorded = native.nativeDescriptionVariantReceipt;
  if (!String(native.descriptionPanelText ?? "").includes(selectedText)) return fail();
  if (recorded) {
    if (recorded.url !== native.url || recorded.visibleNonemptyCount !== 1 || recorded.selectedId !== selected.id || recorded.selectedTag !== selected.tag || recorded.selectedText !== selectedText || !Array.isArray(recorded.variants) || recorded.variants.length !== variants.length) return fail();
    const visibleRecorded = recorded.variants.filter((variant) => variant.visible === true && normalize(variant.text));
    if (visibleRecorded.length !== 1 || visibleRecorded[0].id !== selected.id) return fail();
    for (const variant of variants) {
      const observations = recorded.variants.filter((item) => item.id === variant.id);
      if (observations.length !== 1) return fail();
      const observation = observations[0], dimensionsVisible = observation.rect?.height > 0 && observation.rect?.width > 0 && observation.hidden === false;
      if (observation.tag !== variant.tag || observation.html !== variant.html || observation.text !== textFromHtml(variant.html) || observation.hidden !== hasHidden(variant.html) || observation.visible !== dimensionsVisible) return fail();
    }
  }
  const sameCollectedBody = typeof body === "string" && body === selectedText && html === selected.html;
  if (!sameCollectedBody && (body !== "" || typeof html !== "string" || normalize(textFromHtml(html)) || !hasHidden(html) || !expander.includes(html))) return fail();
  if (sameCollectedBody && full.textVisible !== true) return fail();
  if (!sameCollectedBody && full.textVisible !== false) return fail();
  const normalization = selected.id === "formatted-snippet-text" && !recorded && sameCollectedBody ? null : {
    mechanism: "native_youtube_short_unique_description_variant_v1",
    source: recorded ? "native_visible_variant_receipt_v1" : "native_parent_dom_variant_v1",
    selectedId: selected.id, selectedTag: selected.tag,
    selectedHtmlSha256: htmlDigest(selected.html), textSha256: htmlDigest(selectedText),
    originalDescriptionSha256: htmlDigest(body), originalDescriptionHtmlSha256: htmlDigest(html),
    derivedFromEmptyCollectorField: !sameCollectedBody,
  };
  return { ok: true, reasons, text: sameCollectedBody ? body : selectedText, html: selected.html, normalization };
}

export function nativeYouTubeVideoId(value) {
  const url = publicUrl(value);
  return url && ["youtube.com", "www.youtube.com"].includes(url.hostname.toLowerCase()) && url.pathname === "/watch" && [...url.searchParams].length === 1 && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") ?? "") ? url.searchParams.get("v") : null;
}
const shortId = (value) => { const url = publicUrl(value); return url && ["youtube.com", "www.youtube.com"].includes(url.hostname.toLowerCase()) && !url.search ? url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/)?.[1] ?? null : null; };
export const nativeYouTubePostId = (value) => nativeYouTubeVideoId(value) ?? shortId(value);

export function nativeYouTubeChannelIdentity(value) {
  const url = publicUrl(value);
  if (!url || !["youtube.com", "www.youtube.com"].includes(url.hostname.toLowerCase()) || url.search) return null;
  const channel = url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/(?:videos|shorts|streams|about))?\/?$/);
  const handle = url.pathname.match(/^\/@([A-Za-z0-9._-]+)(?:\/(?:videos|shorts|streams|about))?\/?$/);
  return channel ? { channelId: channel[1], handle: null, url: `https://www.youtube.com/channel/${channel[1]}` } : handle ? { channelId: null, handle: handle[1].toLowerCase(), url: `https://www.youtube.com/@${handle[1].toLowerCase()}` } : null;
}

/** Parse only exact native day/date and counters, never rounded counts or IDs. */
export function nativeYouTubeDomInfo(native) {
  const info = normalize(native?.nativeInfoText), html = native?.nativeInfoHtml;
  if (typeof html !== "string" || !/^<div\b/i.test(html) || attribute(html, "id") !== "info-container" || normalize(textFromHtml(html)) !== info) return null;
  const match = info.match(/^([\d,]+) views?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})(?:\s+.*)?$/);
  if (!match || !exactInteger(match[1]) || !Array.isArray(native?.metricControls)) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months.indexOf(match[2]) + 1, day = Number(match[3]), year = Number(match[4]);
  const publishedDay = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${publishedDay}T00:00:00.000Z`);
  const views = Number(match[1].replaceAll(",", ""));
  if (!Number.isSafeInteger(views) || views < 0 || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== publishedDay) return null;
  const likes = [];
  for (const control of native?.metricControls ?? []) {
    const label = control.label?.match(/^like this video along with ([\d,]+) other (?:person|people)$/i);
    const explicitZero = /^like this video$/i.test(control.label ?? "") && control.text === "0";
    if (!label && !explicitZero) continue;
    const countText = explicitZero ? "0" : label[1];
    const count = Number(countText.replaceAll(",", ""));
    if (!Number.isSafeInteger(count) || count < 0 || !exactInteger(countText) || !exactInteger(control.text) || Number(control.text.replaceAll(",", "")) !== count || !/^<button\b/i.test(control.html ?? "") || attribute(control.html, "aria-label") !== control.label || attribute(control.html, "aria-pressed") !== control.pressed || !["true", "false"].includes(control.pressed) || normalize(textFromHtml(control.html)) !== normalize(control.text) || !native.metadataHtml?.includes(control.html)) return null;
    likes.push(count);
  }
  // Dislikes, subscribers, recommendations and comments supply no Like count.
  if (likes.length !== 1) return null;
  return { publishedDay, publishedAtPrecision: "day", metrics: { views, likes: likes[0] } };
}

function shortSummary(receipt, common) {
  const { reasons, videoId, expected, observed, channelName, handle } = common, native = receipt.nativeObservation;
  const binding = native.nativeShortIdentityBinding, root = binding?.rootHtml, renderer = binding?.rendererHtml, panel = native.descriptionPanelHtml;
  const titleLinks = binding?.rendererPlayerTitleLinks?.filter((link) => shortId(link.href) === videoId && shortId(attribute(link.html, "href")) === videoId && /\bytp-title-link\b/.test(attribute(link.html, "class")) && renderer?.includes(link.html) && normalize(textFromHtml(link.html)) === normalize(link.text)) ?? [];
  if (!binding || binding.url !== native.url || binding.rendererCount !== 1 || typeof root !== "string" || !/^<ytd-shorts\b/i.test(root) || attribute(root, "role") !== "main" || typeof renderer !== "string" || !/^<ytd-reel-video-renderer\b/i.test(renderer) || !renderer.startsWith(binding.rendererOpeningTag) || !root.includes(renderer) || (root.match(/<ytd-reel-video-renderer\b/gi) ?? []).length !== 1 || titleLinks.length !== 1 || !root.includes(panel) || !validClock(native.observedAt) || Date.parse(receipt.channelObservation.observedAt) > Date.parse(native.observedAt) || native.alerts?.length) reasons.push("youtube_short_active_renderer_native_id_conflict");
  const rendererOwners = binding?.rendererChannelLinks?.filter((link) => nativeYouTubeChannelIdentity(link.href)?.handle === handle && normalize(link.text) === `@${handle}` && renderer?.includes(link.html) && nativeYouTubeChannelIdentity(nativeHref(attribute(link.html, "href")))?.handle === handle && normalize(textFromHtml(link.html)) === `@${handle}`) ?? [];
  const panelOwners = native.channelLinks?.filter((link) => nativeYouTubeChannelIdentity(link.href)?.handle === handle && native.channelHeaderHtml?.includes(link.html) && nativeYouTubeChannelIdentity(nativeHref(attribute(link.html, "href")))?.handle === handle) ?? [];
  if (rendererOwners.length !== 1 || !panelOwners.length || !native.shortChannelLinks?.some((link) => rendererOwners.some((owner) => owner.html === link.html)) || native.channelHeaderText?.split("\n")[0] !== channelName || !native.nativeShortText?.split("\n").some((line) => line.trim() === `@${handle}`) || !/^<ytd-video-description-header-renderer\b/i.test(native.channelHeaderHtml ?? "") || !panel?.includes(native.channelHeaderHtml) || !normalize(textFromHtml(native.channelHeaderHtml)).includes(channelName)) reasons.push("youtube_short_native_primary_channel_conflict");
  const description = nativeYouTubeShortDescription(native), body = description.text;
  if (typeof panel !== "string" || !/^<ytd-engagement-panel-section-list-renderer\b/i.test(panel) || attribute(panel, "target-id") !== "engagement-panel-structured-description" || attribute(panel, "visibility") !== "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" || !description.ok) reasons.push("youtube_short_full_description_clipping_conflict");
  const values = {}, facts = native.nativeFactoids;
  if (!Array.isArray(facts)) reasons.push("youtube_short_native_factoids_required");
  for (const fact of facts ?? []) {
    if (!panel?.includes(fact.html) || !native.channelHeaderHtml?.includes(fact.html) || attribute(fact.html, "role") !== "text" || attribute(fact.html, "aria-label") !== fact.label || textFromHtml(fact.html).replace(/\s/gu, "") !== String(fact.text ?? "").replace(/\s/gu, "")) { reasons.push("youtube_short_native_factoid_parent_conflict"); continue; }
    if (fact.label === "No likes" && normalize(fact.text) === "0 Likes") {
      if (values.likes !== undefined) reasons.push("youtube_short_native_factoid_counter_conflict");
      values.likes = 0;
      continue;
    }
    const count = fact.label?.match(/^([\d,]+) (likes?|views?)$/i);
    if (count && exactInteger(count[1])) {
      const key = /^like/i.test(count[2]) ? "likes" : "views", value = Number(count[1].replaceAll(",", ""));
      if (values[key] !== undefined || !Number.isSafeInteger(value)) reasons.push("youtube_short_native_factoid_counter_conflict");
      values[key] = value;
      continue;
    }
    const date = fact.label?.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/);
    if (date) {
      const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(date[1]) + 1;
      const day = `${date[3]}-${String(month).padStart(2, "0")}-${date[2].padStart(2, "0")}`;
      if (values.publishedDay || !Number.isFinite(Date.parse(`${day}T00:00:00.000Z`)) || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day || day > String(native.observedAt ?? "").slice(0, 10)) reasons.push("youtube_short_native_day_date_conflict");
      values.publishedDay = day;
    }
  }
  if (!Number.isSafeInteger(values.likes) || !Number.isSafeInteger(values.views) || !values.publishedDay) reasons.push("youtube_short_native_exact_metrics_and_day_required");
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], videoId, sourceUrl: videoId ? `https://www.youtube.com/shorts/${videoId}` : null, channelId: expected?.channelId ?? observed?.channelId ?? null, channelHandle: handle ?? null, channelName: channelName ?? null, title: titleLinks[0]?.text?.trim() ?? null, text: body ?? null, descriptionNormalization: description.normalization, publishedDay: values.publishedDay ?? null, publishedAtPrecision: "day", metrics: Number.isSafeInteger(values.views) && Number.isSafeInteger(values.likes) ? { views: values.views, likes: values.likes } : {} };
}

export function nativeYouTubeDomSummary(receipt, company) {
  const reasons = [], native = receipt?.nativeObservation, channel = receipt?.channelObservation, proof = receipt?.identityProof;
  const slug = company?.slug ?? company?.companySlug, name = company?.name ?? company?.companyName;
  const expected = nativeYouTubeChannelIdentity(proof?.channelUrl), observed = nativeYouTubeChannelIdentity(channel?.url);
  const short = nativeYouTubeDomSource(native) === NATIVE_YOUTUBE_SHORT_DOM_SOURCE;
  const videoId = short ? shortId(native?.url) : nativeYouTubeVideoId(native?.url);
  if (!nativeYouTubeDomSource(native) || receipt?.mechanism !== nativeYouTubeDomSource(native) || receipt.companySlug !== slug) reasons.push("youtube_native_dom_receipt_required");
  if (!proof || proof.source !== "official_company_website_youtube_channel_v1" || proof.companySlug !== slug || proof.companyName !== name || proof.entityId !== `company-${slug}` || proof.officialYcCompanyUrl !== `https://www.ycombinator.com/companies/${slug}` || !host(company?.websiteUrl) || host(proof.officialWebsite) !== host(company.websiteUrl) || host(proof.homepage?.requestedUrl) !== host(company.websiteUrl) || host(proof.homepage?.finalUrl) !== host(company.websiteUrl) || !digest(proof.homepage?.htmlSha256) || !expected || nativeYouTubeChannelIdentity(attribute(proof.homepage?.literalAnchorHtml, "href"))?.url !== expected.url || !proof.homepage?.containingAncestorHtml?.includes(proof.homepage.literalAnchorHtml) || !normalize(textFromHtml(proof.homepage.containingAncestorHtml)).toLowerCase().includes(String(name ?? "").toLowerCase())) reasons.push("youtube_official_channel_ownership_conflict");
  if (!observed || !expected || observed.url !== expected.url || nativeYouTubeChannelIdentity(receipt.channelUrl)?.url !== expected.url || !validClock(channel?.observedAt) || channel.alerts?.length || channel.loading?.length || typeof channel.mainHtml !== "string" || !Array.isArray(channel.links) || !channel.tabs?.some((tab) => tab.text === (short ? "Shorts" : "Videos") && tab.ariaSelected === "true")) reasons.push("youtube_native_channel_observation_conflict");
  const headerHtml = channel?.mainHtml?.match(/<ytd-tabbed-page-header\b[\s\S]*?<\/ytd-tabbed-page-header>/i)?.[0];
  const headerLines = String(channel?.mainText ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const channelName = headerLines[0], handle = headerLines[1]?.match(/^@([A-Za-z0-9._-]+)$/)?.[1]?.toLowerCase();
  if (!headerHtml || !channelName || !handle || !normalize(textFromHtml(headerHtml)).includes(channelName) || !textFromHtml(headerHtml).includes(`@${handle}`) || expected?.handle && expected.handle !== handle) reasons.push("youtube_native_channel_header_conflict");
  const listed = channel?.links?.filter((link) => nativeYouTubePostId(link.href) === videoId && (short || normalize(link.text) === normalize(native?.title)) && link.html && channel.mainHtml.includes(link.html) && nativeYouTubePostId(nativeHref(attribute(link.html, "href"))) === videoId) ?? [];
  if (!videoId || !listed.length) reasons.push("youtube_watch_not_in_owned_native_channel_listing");
  if (short) return shortSummary(receipt, { reasons, videoId, expected, observed, channelName, handle });
  const metadata = native?.metadataHtml;
  if (typeof metadata !== "string" || !/^<ytd-watch-metadata\b/i.test(metadata) || attribute(metadata, "video-id") !== videoId || !validClock(native?.observedAt) || Date.parse(channel?.observedAt) > Date.parse(native.observedAt) || native.alerts?.length) reasons.push("youtube_native_watch_identity_or_clock_conflict");
  const title = native?.title, titleHtml = metadata?.match(/<h1\b[\s\S]*?<\/h1>/i)?.[0];
  if (!title || !titleHtml || normalize(textFromHtml(titleHtml)) !== normalize(title) || !String(native.metadataText ?? "").startsWith(title)) reasons.push("youtube_native_title_conflict");
  const owner = native?.ownerHtml, ownerLinks = native?.ownerLinks ?? [];
  const primary = ownerLinks.filter((link) => normalize(link.text) === channelName && nativeYouTubeChannelIdentity(link.href)?.handle === handle && typeof link.html === "string" && owner?.includes(link.html) && nativeYouTubeChannelIdentity(nativeHref(attribute(link.html, "href")))?.handle === handle && normalize(textFromHtml(link.html)) === channelName);
  if (!owner || attribute(owner, "id") !== "owner" || !metadata?.includes(owner) || native.ownerText?.split("\n")[0] !== channelName || primary.length !== 1) reasons.push("youtube_native_primary_channel_owner_conflict");
  const description = native?.description, descriptionHtml = native?.descriptionHtml, expander = native?.descriptionExpanderHtml;
  if (typeof description !== "string" || !normalize(description) || native.descriptionConfirmedExpanded !== true || typeof descriptionHtml !== "string" || attribute(descriptionHtml, "id") !== "expanded" || normalize(textFromHtml(descriptionHtml)) !== normalize(description) || typeof expander !== "string" || !/^<ytd-text-inline-expander\b/i.test(expander) || !/\bis-expanded(?:\s|=|>)/i.test(expander.split(">")[0] + ">") || !expander.includes(descriptionHtml) || !/<tp-yt-paper-button\b[^>]*\bid=["']collapse["'][\s\S]*?>[\s\S]*?Show less[\s\S]*?<\/tp-yt-paper-button>/i.test(expander) || !metadata?.includes(expander) || !String(native?.metadataText ?? "").includes(description)) reasons.push("youtube_native_expanded_full_description_conflict");
  const info = nativeYouTubeDomInfo(native);
  if (!info || !metadata?.includes(native.nativeInfoHtml) || !String(native.metadataText ?? "").includes(native.nativeInfoText) || info.publishedDay > String(native.observedAt ?? "").slice(0, 10)) reasons.push("youtube_native_day_date_or_metrics_conflict");
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], videoId, sourceUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null, channelId: expected?.channelId ?? observed?.channelId ?? null, channelHandle: handle ?? null, channelName: channelName ?? null, title: title ?? null, text: description ?? null, publishedDay: info?.publishedDay ?? null, publishedAtPrecision: "day", metrics: info?.metrics ?? {} };
}

export function verifiedNativeYouTubeDomReasons(row, company) {
  const reasons = [];
  let raw;
  try { raw = JSON.parse(row?.rawVisibleText); } catch { return ["missing_native_youtube_dom_receipt"]; }
  const receipt = raw?.nativeYouTubeDomReceipt, validation = raw?.validation;
  const provenance = nativeYouTubeDomSource(receipt?.nativeObservation);
  if (!isNativeYouTubeDomProvenance(raw?.source) || raw.source !== provenance || !receipt) return ["missing_native_youtube_dom_receipt"];
  const summary = nativeYouTubeDomSummary(receipt, company);
  reasons.push(...summary.reasons);
  if (summary.descriptionNormalization && JSON.stringify(receipt.descriptionNormalization) !== JSON.stringify(summary.descriptionNormalization) || !summary.descriptionNormalization && receipt.descriptionNormalization != null) reasons.push("youtube_short_description_normalization_conflict");
  const slug = company?.slug ?? company?.companySlug, name = company?.name ?? company?.companyName;
  if (row.batchSlug !== "F26" || row.platform !== "youtube" || row.companySlug !== slug || row.companyName !== name || row.entityType !== "company" || row.entityId !== `company-${slug}` || row.review_state !== "verified" || row.attributionVersion !== 3 || row.attributionStatus !== "verified" || row.attributionMode !== "author" || row.attributionProvenance !== provenance) reasons.push("youtube_canonical_company_or_attribution_conflict");
  // The canonical importer removes www; accept exactly that spelling change.
  // Native path, watch/Shorts kind, query and case-sensitive video ID stay exact.
  const canonicalSource = typeof row.sourceUrl === "string" ? row.sourceUrl.replace(/^https:\/\/youtube\.com\//, "https://www.youtube.com/") : null;
  if (row.platformPostId !== summary.videoId || canonicalSource !== summary.sourceUrl || nativeYouTubeChannelIdentity(row.accountUrl)?.url !== nativeYouTubeChannelIdentity(receipt.identityProof?.channelUrl)?.url || row.authorHandle !== summary.channelHandle || row.authorName !== summary.channelName || row.title !== summary.title || row.text !== summary.text || row.originalText !== summary.text) reasons.push("youtube_canonical_native_identity_or_body_conflict");
  if (row.postedAt !== summary.publishedDay || row.publishedAtPrecision !== "day" || JSON.stringify(row.metrics) !== JSON.stringify(summary.metrics)) reasons.push("youtube_canonical_day_date_or_metric_conflict");
  const nativeKind = provenance === NATIVE_YOUTUBE_SHORT_DOM_SOURCE ? "native_short" : "native_watch";
  if (validation?.source !== nativeYouTubeDomValidation(receipt.nativeObservation) || validation.archiveHashesVerified !== true || validation.literalOfficialAnchorVerified !== true || validation.parentDomSegmentsVerified !== true || validation.nativeReceiptSha256 !== hash(receipt) || !Array.isArray(validation.archives) || ![nativeKind, "native_channel", "official_website"].every((kind) => validation.archives.some((archive) => archive.kind === kind && typeof archive.path === "string" && archive.path && digest(archive.sha256))) || !validation.archives.some((archive) => archive.kind === "official_website" && archive.sha256 === receipt.identityProof?.homepage?.htmlSha256)) reasons.push("youtube_ingestion_archive_validation_conflict");
  return [...new Set(reasons)];
}

export function isVerifiedNativeYouTubeDomReceipt(row, company) {
  try { return verifiedNativeYouTubeDomReasons(row, company).length === 0; }
  catch { return false; }
}
