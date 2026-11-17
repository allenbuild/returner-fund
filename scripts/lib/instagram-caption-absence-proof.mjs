import { createHash } from "node:crypto";
import { instagramNativeAuthorHandle } from "./instagram-native-observation.mjs";

export function isVerifiedInstagramCaptionAbsence(post, proof, authorHandle, nativeId) {
  if (proof?.source !== "authorized_native_instagram_caption_absence_review_v1" || proof.review_state !== "verified" || proof.platformPostId !== nativeId || proof.authorHandle !== authorHandle || post.text !== "" || !post.nativeText || post.bodyTruncated) return false;
  const firstHeaderLine = post.nativeText.split("\n").map((line) => line.trim()).filter(Boolean).find((line) => !/^\d+$/.test(line));
  if (firstHeaderLine !== authorHandle && !(post.nativeAuthorHeader && instagramNativeAuthorHandle(post) === authorHandle)) return false;
  const controls = new Set((post.controls ?? []).flatMap((control) => control.icons ?? []));
  return controls.has("Like") && controls.has("Comment") &&
    Boolean(post.media?.images?.length || post.media?.videos?.length) &&
    Number.isFinite(Date.parse(proof.observedAt)) &&
    proof.nativeTextSha256 === createHash("sha256").update(post.nativeText).digest("hex");
}
