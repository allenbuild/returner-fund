import { createHash } from "node:crypto";
import { NATIVE_YOUTUBE_SHORT_DOM_SOURCE, nativeYouTubeChannelIdentity, nativeYouTubeDomSource, nativeYouTubeDomSummary } from "./youtube-native-dom-receipt.mjs";

export const NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE = "authorized_native_youtube_short_unknown_date_dom_v1";
export const NATIVE_YOUTUBE_UNKNOWN_DATE_VALIDATION = "fall_2026_native_youtube_short_unknown_date_dom_ingestion_v1";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
const normalize = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
const relative = (value) => String(value ?? "").match(/^([1-9]\d*) (second|minute|hour|day|week|month|year)s? ago$/);
const consistentRelativeText = (fact) => {
  const match = relative(fact?.label);
  if (!match) return false;
  const units = { second: "s", minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" };
  const text = normalize(fact.text).toLowerCase();
  return text === fact.label || text === `${match[1]}${units[match[2]]} ago`;
};
const sameNativeUrl = (actual, expected) => {
  try {
    const a = new URL(actual), b = new URL(expected);
    return a.protocol === "https:" && ["youtube.com", "www.youtube.com"].includes(a.hostname) && !a.username && !a.password && !a.port && !a.hash && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
};

/** Reuse every positive-date native identity/body/counter gate. The only
 * tolerated failure is absent calendar day, with a literal relative factoid.
 * No clock subtraction, video-ID decoding or synthetic date is performed. */
export function nativeYouTubeUnknownDateSummary(receipt, company) {
  const summary = nativeYouTubeDomSummary(receipt, company), native = receipt?.nativeObservation;
  const reasons = summary.reasons.filter((reason) => reason !== "youtube_short_native_exact_metrics_and_day_required");
  const facts = Array.isArray(native?.nativeFactoids) ? native.nativeFactoids : [];
  const publications = facts.filter((fact) => relative(fact?.label));
  if (nativeYouTubeDomSource(native) !== NATIVE_YOUTUBE_SHORT_DOM_SOURCE || summary.publishedDay !== null || summary.reasons.length !== 1 || summary.reasons[0] !== "youtube_short_native_exact_metrics_and_day_required" || facts.length !== 3 || publications.length !== 1 || !consistentRelativeText(publications[0]) || !Number.isSafeInteger(summary.metrics.views) || !Number.isSafeInteger(summary.metrics.likes)) reasons.push("youtube_explicit_relative_publication_factoid_required");
  const publication = publications[0];
  const relativePublicationReceipt = publication ? { mechanism: "native_relative_publication_label_no_calendar_date_v1", label: publication.label, text: publication.text, html: publication.html, observedAt: native.observedAt } : null;
  return { ...summary, ok: reasons.length === 0, reasons: [...new Set(reasons)], publishedDay: null, publishedAtPrecision: "unknown", relativePublicationReceipt, contributionScore: 0, tractionStatus: "unscored" };
}

export function verifiedNativeYouTubeUnknownDateReasons(row, company) {
  let raw;
  try { raw = JSON.parse(row?.rawVisibleText); } catch { return ["youtube_unknown_date_native_receipt_required"]; }
  if (raw?.source !== NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE || !raw.nativeYouTubeDomReceipt) return ["youtube_unknown_date_native_receipt_required"];
  const receipt = raw.nativeYouTubeDomReceipt, validation = raw.validation;
  const summary = nativeYouTubeUnknownDateSummary(receipt, company), reasons = [...summary.reasons];
  const slug = company?.slug ?? company?.companySlug, name = company?.name ?? company?.companyName;
  if (row.batchSlug !== "F26" || row.platform !== "youtube" || row.companySlug !== slug || row.companyName !== name || row.entityType !== "company" || row.entityId !== `company-${slug}` || row.review_state !== "verified" || row.attributionVersion !== 3 || row.attributionStatus !== "verified" || row.attributionMode !== "author" || row.attributionProvenance !== NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE) reasons.push("youtube_unknown_date_canonical_owner_conflict");
  if (row.platformPostId !== summary.videoId || !sameNativeUrl(row.sourceUrl, summary.sourceUrl) || nativeYouTubeChannelIdentity(row.accountUrl)?.url !== nativeYouTubeChannelIdentity(receipt.identityProof?.channelUrl)?.url || row.authorHandle !== summary.channelHandle || row.authorName !== summary.channelName || row.title !== summary.title || row.text !== summary.text || row.originalText !== summary.text || JSON.stringify(row.metrics) !== JSON.stringify(summary.metrics)) reasons.push("youtube_unknown_date_canonical_identity_body_metric_conflict");
  if (row.postedAt !== null || row.publishedAtPrecision !== "unknown" || row.contributionScore !== 0 || row.tractionStatus !== "unscored" || row.score !== undefined && row.score !== 0) reasons.push("youtube_unknown_date_must_remain_null_and_unscored");
  if (JSON.stringify(receipt.unknownDatePublicationReceipt) !== JSON.stringify(summary.relativePublicationReceipt) || summary.descriptionNormalization && JSON.stringify(receipt.descriptionNormalization) !== JSON.stringify(summary.descriptionNormalization) || !summary.descriptionNormalization && receipt.descriptionNormalization != null) reasons.push("youtube_unknown_date_relative_or_description_receipt_conflict");
  if (validation?.source !== NATIVE_YOUTUBE_UNKNOWN_DATE_VALIDATION || validation.archiveHashesVerified !== true || validation.literalOfficialAnchorVerified !== true || validation.parentDomSegmentsVerified !== true || validation.nativeReceiptSha256 !== hash(receipt) || !Array.isArray(validation.archives) || !["native_short", "native_channel", "official_website"].every((kind) => validation.archives.some((archive) => archive.kind === kind && typeof archive.path === "string" && archive.path && digest(archive.sha256))) || !validation.archives.some((archive) => archive.kind === "official_website" && archive.sha256 === receipt.identityProof?.homepage?.htmlSha256)) reasons.push("youtube_unknown_date_physical_archive_validation_conflict");
  return [...new Set(reasons)];
}

export function isVerifiedNativeYouTubeUnknownDateReceipt(row, company) {
  try { return verifiedNativeYouTubeUnknownDateReasons(row, company).length === 0; }
  catch { return false; }
}
