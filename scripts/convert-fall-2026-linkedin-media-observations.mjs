import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isVerifiedLinkedInCaptionAbsence } from "./lib/linkedin-caption-absence-proof.mjs";

const value = (name, fallback) => process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const inputPath = value("--input", "outputs/fall-2026/linkedin-media-only-observations.json");
const output = value("--output", "outputs/fall-2026/linkedin-media-only-importable.json");
const input = JSON.parse(await readFile(inputPath, "utf8"));
const catalog = JSON.parse(await readFile("src/lib/yc/fall-2026-companies.json", "utf8"));
const evidence = [], needsReview = [];
const key = (value) => { try { return new URL(value).pathname.toLowerCase().replace(/\/$/, ""); } catch { return null; } };
for (const row of input.observations ?? []) {
  const company = catalog.companies.find((entry) => entry.slug === row.companySlug);
  const observation = { cardText: row.cardText, nativeEmbedPreview: row.nativeEmbedPreview, media: row.media, visibleMetricControls: row.visibleMetricControls };
  const proof = { source: "authorized_native_linkedin_caption_absence_review_v1", review_state: "verified", platformPostId: row.platformPostId, observedAt: row.observedAt, nativeObservationSha256: createHash("sha256").update(JSON.stringify(observation)).digest("hex"), observationSource: inputPath };
  const post = { id: row.platformPostId, url: row.sourceUrl, text: "", author: { name: row.authorName, profileUrl: row.accountUrl }, dateLabel: row.dateLabel, publishedAt: null, kind: "original_company_media_post", metrics: row.metrics, captionAbsent: true, captionAbsenceProof: proof, nativeObservation: observation };
  if (input.source !== "authorized_linkedin_browser_dom_v1" || !company || row.entityId !== `company-${company.slug}` || row.batchSlug !== "F26" || row.captionAbsent !== true || row.text !== "" || row.originalText !== "" || key(company.socialLinks.linkedin) !== key(row.accountUrl) || !/^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:\d+\/$/.test(row.sourceUrl) || !row.sourceUrl.includes(`activity:${row.platformPostId}/`) || !isVerifiedLinkedInCaptionAbsence(post, proof, row.accountUrl, row.platformPostId)) {
    needsReview.push({ platformPostId: row.platformPostId, sourceUrl: row.sourceUrl, reasons: ["captionless_native_owner_or_absence_receipt_not_verified"] }); continue;
  }
  evidence.push({ ...row, id: `linkedin-f26-media-${row.platformPostId}`, title: `${company.name} LinkedIn media post`, mediaType: "image", mediaUrls: row.media.images.map((image) => image.src), postedAt: null, publishedAtPrecision: "unknown", contributionScore: 0, tractionStatus: "unscored", review_state: "verified", linkStatus: "verified", linkCheckedAt: row.observedAt, attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: "authorized_linkedin_browser_dom_v1", attributionSignals: ["official_yc_linked_company_account", "visible_native_linkedin_post", "visible_author_matches_official_company"], matchReason: "Exact official company account and native post ID match a hash-bound card and embed receipt with an empty caption and visible native media. Image text is archived separately and is not a caption.", rawVisibleText: JSON.stringify({ source: "authorized_linkedin_browser_dom_v1", officialIdentitySourceUrl: company.ycProfileUrl, observedAt: row.observedAt, profile: { name: row.authorName, url: row.accountUrl }, post }), first_seen_at: row.observedAt, last_checked_at: row.observedAt, last_updated_at: row.observedAt });
}
const summary = { batchSlug: "F26", observations: input.observations?.length ?? 0, accepted: evidence.length, needsReview: needsReview.length, fullHistoryComplete: false };
await writeFile(output, `${JSON.stringify({ source: summary, evidence, needsReview }, null, 2)}\n`);
console.log(JSON.stringify(summary));
