import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { nativeXCaptionlessIdentity, nativeXCaptionlessMetrics, nativeXCaptionlessPostReasons } from "../src/lib/graph/x-caption-absence-receipt.mjs";

const value = (name, fallback) => process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const inputPath = value("--input", "outputs/source-hunt/2026-11-15-fall-2026-x-ui-native-importable.json");
const prefix = value("--output-prefix", "outputs/source-hunt/2026-11-15-fall-2026-x-ui");
if (!resolve(prefix).startsWith(`${resolve("outputs")}/`)) throw new Error("Prepared artifacts must stay under outputs/; canonical writes are not supported.");
const inputBytes = await readFile(inputPath), input = JSON.parse(inputBytes);
const catalog = JSON.parse(await readFile("src/lib/yc/fall-2026-companies.json", "utf8"));
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const owners = new Map();
for (const company of catalog.companies) {
  const links = [{ entityType: "company", entityId: `company-${company.slug}`, url: company.socialLinks.x }, ...company.founders.map((founder) => ({ entityType: "founder", entityId: `founder-${company.slug}-${slug(founder.name)}-${founder.id}`, url: founder.socialLinks.x }))];
  for (const link of links) {
    const native = nativeXCaptionlessIdentity(link.url);
    if (native && !native.postId) owners.set(native.handle, [...(owners.get(native.handle) ?? []), { ...link, companySlug: company.slug, ycProfileUrl: company.ycProfileUrl }]);
  }
}
const equal = (left, right) => left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right) && Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, number]) => Number.isSafeInteger(number) && number >= 0 && right[key] === number);
const identityEqual = (left, right) => left && right && left.handle === right.handle && left.postId === right.postId && !left.mediaKind && !right.mediaKind;
const zero = [], captionless = [], held = [], decisions = [];
for (const original of input.candidates ?? []) {
  if (!original.entityId || !original.companySlug) continue;
  const reasons = [], row = structuredClone(original);
  let raw;
  try { raw = JSON.parse(row.rawVisibleText); } catch { reasons.push("native_receipt_invalid"); }
  const post = raw?.post, native = nativeXCaptionlessIdentity(row.sourceUrl), account = nativeXCaptionlessIdentity(row.accountUrl), dateLink = nativeXCaptionlessIdentity(post?.nativeDateLink);
  const allowed = new Set(["no_positive_native_metrics", "native_media_only_post_without_captured_text"]);
  if (!row.quarantineReasons?.length || row.quarantineReasons.some((reason) => !allowed.has(reason))) reasons.push("other_quarantine_reason_requires_review");
  const official = owners.get(native?.handle)?.filter((owner) => owner.entityId === row.entityId && owner.entityType === row.entityType && owner.companySlug === row.companySlug && owner.ycProfileUrl === raw?.identitySourceUrl) ?? [];
  if (row.platform !== "x" || row.batchSlug !== "F26" || official.length !== 1 || !native?.postId || !account || account.postId || account.handle !== native.handle || !identityEqual(native, dateLink) || row.platformPostId !== native.postId || post?.platformPostId !== native.postId || String(post?.authorHandle).toLowerCase() !== native.handle || String(row.authorHandle).toLowerCase() !== native.handle || raw?.source !== "authenticated_native_x_ui_v1") reasons.push("exact_official_native_owner_or_id_not_verified");
  if (!identityEqual(native, nativeXCaptionlessIdentity(post?.url)) || nativeXCaptionlessIdentity(raw?.accountUrl)?.handle !== native?.handle || nativeXCaptionlessIdentity(raw?.accountUrl)?.postId) reasons.push("native_outer_permalink_or_author_url_missing");
  const published = Date.parse(post?.publishedAt), observed = Date.parse(raw?.observedAt), exported = Date.parse(raw?.exportedAt);
  if (![published, observed, exported].every(Number.isFinite) || published > observed || observed > exported || row.postedAt !== post?.publishedAt || row.collectionObservedAt !== raw?.observedAt || row.bodyTruncated !== false || post?.bodyTruncated !== false || row.text !== post?.text || post?.is_retweet || post?.isRepost) reasons.push("native_body_or_clock_not_verified");
  const observedMetrics = {};
  if (!Array.isArray(raw?.metricObservations)) reasons.push("native_metric_labels_missing");
  else for (const observation of raw.metricObservations) {
    const metrics = nativeXCaptionlessMetrics(observation.nativeVisibleLabels), metricTime = Date.parse(observation.observedAt);
    if (!metrics || !equal(metrics, observation.metrics) || !Number.isFinite(metricTime) || metricTime < published || metricTime > exported) reasons.push("native_metric_labels_conflict");
    else Object.assign(observedMetrics, metrics);
  }
  if (!equal(observedMetrics, row.metrics) || !equal(observedMetrics, raw?.metrics)) reasons.push("native_metric_values_conflict");
  Object.assign(row, { originalText: row.text, contributionScore: 0, tractionStatus: "unscored", review_state: "verified", attributionStatus: "verified", attributionProvenance: "authenticated_native_x_ui_v1" });
  if (row.text === "") {
    row.captionAbsent = true;
    reasons.push(...nativeXCaptionlessPostReasons(row));
    if (!reasons.length) {
      post.captionAbsent = true;
      row.rawVisibleText = JSON.stringify(raw);
      row.mediaUrls = [...new Set(post.ownMediaPermalinks.flatMap((media) => media.visibleMediaUrls))];
      row.mediaType = post.ownMediaPermalinks.every((media) => media.kind === "video") ? "video" : "image";
      row.title = `${row.authorName} X media post`;
      delete row.quarantineReasons;
      captionless.push(row);
    }
  } else if (!row.text?.trim() || Object.values(row.metrics ?? {}).some((number) => number > 0)) reasons.push("not_a_zero_engagement_text_original");
  else if (!reasons.length) { delete row.quarantineReasons; zero.push(row); }
  const decision = { sourceUrl: original.sourceUrl, platformPostId: original.platformPostId, entityId: original.entityId, originalQuarantineReasons: original.quarantineReasons, decision: reasons.length ? "held" : row.captionAbsent ? "proved_captionless_unscored" : "zero_engagement_text_unscored", reasons: [...new Set(reasons)] };
  decisions.push(decision);
  if (reasons.length) held.push(decision);
}
const source = { ...input.source, inputPath, inputSha256: createHash("sha256").update(inputBytes).digest("hex"), scope: "F26", canonicalWritten: false };
for (const [suffix, data] of [["-zero-engagement-importable.json", { source, evidence: zero }], ["-proved-captionless-importable.json", { source, evidence: captionless }], ["-unscored-preflight.json", { source, summary: { zeroEngagementTextOriginals: zero.length, provedCaptionless: captionless.length, held: held.length }, decisions }]]) {
  const path = `${prefix}${suffix}`, temporary = `${path}.next`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`); await rename(temporary, path);
}
console.log(JSON.stringify({ zeroEngagementTextOriginals: zero.length, provedCaptionless: captionless.length, held: held.length, canonicalWritten: false }));
