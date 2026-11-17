import { createHash } from "node:crypto";

const accountKey = (value) => {
  try {
    const url = new URL(value);
    if (!/^(?:www\.)?linkedin\.com$/i.test(url.hostname) || !/^\/(?:company|in)\/[^/]+\/?$/.test(url.pathname)) return null;
    return url.pathname.replace(/\/$/, "").toLowerCase();
  } catch { return null; }
};

/** A reviewed empty-caption receipt may preserve media metadata, never OCR as a caption. */
export function isVerifiedLinkedInCaptionAbsence(post, proof, authorProfileUrl, nativeId) {
  if (proof?.source !== "authorized_native_linkedin_caption_absence_review_v1" || proof.review_state !== "verified" || proof.platformPostId !== nativeId || post?.text !== "" || post.captionAbsent !== true || post.bodyTruncated) return false;
  const observation = post.nativeObservation;
  const embed = observation?.nativeEmbedPreview;
  if (!observation?.cardText || embed?.activityUrn !== `urn:li:activity:${nativeId}` || !Number.isFinite(Date.parse(proof.observedAt))) return false;
  if (proof.nativeObservationSha256 !== createHash("sha256").update(JSON.stringify(observation)).digest("hex")) return false;
  const ownerKey = accountKey(authorProfileUrl);
  const author = post.author?.name;
  if (!ownerKey || !author || !embed.links?.some((link) => accountKey(link.href) === ownerKey && link.text?.trim() === author)) return false;
  const lines = String(embed.text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.includes(author) || lines.some((line) => line !== author && !/^(?:LinkedIn|Like|Comment|Share|Repost|Follow|\d[\d,]*(?:\s+(?:followers?|reactions?|comments?))?|\d+[hwdmy])$/i.test(line))) return false;
  return observation.media?.images?.some((image) => {
    try { const url = new URL(image.src); return url.protocol === "https:" && /(?:^|\.)licdn\.com$/i.test(url.hostname); } catch { return false; }
  }) === true;
}
