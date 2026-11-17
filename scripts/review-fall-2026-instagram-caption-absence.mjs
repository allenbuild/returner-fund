import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isVerifiedInstagramCaptionAbsence } from "./lib/instagram-caption-absence-proof.mjs";
import { instagramNativeAuthorHandle, normalizeInstagramNativeObservation } from "./lib/instagram-native-observation.mjs";

const values = (key) => process.argv.filter((arg) => arg.startsWith(`${key}=`)).map((arg) => arg.slice(key.length + 1));
const inputs = values("--input");
if (!inputs.length) throw new Error("Pass at least one explicit --input=<frozen-native-dialog.json>.");
const output = values("--output")[0] ?? "outputs/fall-2026/instagram-caption-absence-native-review.json";
const decisionsPath = values("--decisions")[0] ?? "outputs/fall-2026/instagram-caption-absence-decisions.json";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const beforeBytes = await readFile(decisionsPath), decisions = JSON.parse(beforeBytes), accepted = [], held = [];
for (const input of inputs) {
  const bytes = await readFile(input), source = JSON.parse(bytes);
  if (source.source?.batchSlug !== "F26" || source.source.platform !== "instagram") throw new Error("An explicit native F26 Instagram input is required.");
  for (const native of source.nativePosts ?? []) {
    if (native.captionAbsent !== true) continue;
    const post = normalizeInstagramNativeObservation(native), handle = instagramNativeAuthorHandle(native), id = post.id;
    const reasons = [];
    if (!handle || !id || post.text !== "" || native.caption !== "" || native.captionConfirmedVisible !== false) reasons.push("exact_native_empty_caption_and_owner_required");
    const caption = native.nativeCaptionReceipt;
    if (caption?.mechanism !== "native_caption_dialog_h1_v1" || caption.caption !== null || caption.h1Count !== 0 || caption.unlinkedCaptionTimeCount !== 0
      || !Array.isArray(native.times) || native.times.some((time) => !time.link && !time.href)) reasons.push("native_caption_block_absence_not_proven");
    if (!native.dialogHtml?.includes('role="dialog"') || /<h1\b/i.test(native.dialogHtml) || !native.nativeAuthorHeader?.html || !native.dialogHtml.includes(native.nativeAuthorHeader.html)) reasons.push("actual_dialog_header_and_h1_absence_required");
    if (!Number.isFinite(Date.parse(post.postedAt)) || !Number.isFinite(Date.parse(post.observedAt)) || Date.parse(post.postedAt) > Date.parse(post.observedAt)) reasons.push("native_publication_footer_clock_required");
    const actualMedia = [...(native.media?.images ?? []), ...(native.media?.videos ?? [])].filter((media) => !/profile picture$/i.test(media.alt ?? "") && (media.src || media.poster));
    if (!actualMedia.length) reasons.push("actual_native_post_media_required");
    const proof = { source: "authorized_native_instagram_caption_absence_review_v1", platformPostId: id, authorHandle: handle, review_state: "verified", observedAt: post.observedAt,
      nativeTextSha256: sha(post.nativeText), reviewedAt: new Date().toISOString(), observationSource: input, observationSourceSha256: sha(bytes),
      reason: "The exact native dialog header and permalink-bound footer prove post identity; captured H1 count and unlinked caption-time count are zero, caption is null/empty, actual dialog HTML contains no H1, and real media plus own toolbar are present. Preserve empty native text and observed metadata unscored. Owner attribution is still checked separately against verified identity proofs."
    };
    if (!isVerifiedInstagramCaptionAbsence(post, proof, handle, id)) reasons.push("existing_native_caption_absence_gate_rejected");
    if (reasons.length) { held.push({ platformPostId: id ?? null, authorHandle: handle, input, reasons }); continue; }
    accepted.push(proof);
  }
}
const unique = new Map(decisions.posts.map((proof) => [proof.platformPostId, proof]));
for (const proof of accepted) if (!unique.has(proof.platformPostId)) unique.set(proof.platformPostId, proof);
await writeFile(output, `${JSON.stringify({ inputs, accepted, held, canonicalOwnerAdmissionNotPerformed: true }, null, 2)}\n`);
if (process.argv.includes("--write")) {
  if (!(await readFile(decisionsPath)).equals(beforeBytes)) throw new Error("Caption-absence decisions changed during native review.");
  await mkdir("outputs/fall-2026/instagram-captionless-native-receipts", { recursive: true });
  await writeFile(`${output}.decisions-before.json`, beforeBytes);
  await writeFile(decisionsPath, `${JSON.stringify({ ...decisions, posts: [...unique.values()] }, null, 2)}\n`);
}
console.log(JSON.stringify({ output, accepted: accepted.length, held: held.length, newDecisions: unique.size - decisions.posts.length, decisionsWritten: process.argv.includes("--write"), ownerAdmissionPerformed: false }));
