import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { verifyInstagramFounderSocialIdentityArchive } from "./lib/instagram-founder-social-proof.mjs";
import { nativeThreadsIdentity, nativeThreadsCaption, verifiedNativeThreadsReasons, NATIVE_THREADS_SOURCE, NATIVE_THREADS_VALIDATION } from "../src/lib/graph/threads-native-receipt.mjs";

const value = (flag, fallback) => process.argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? fallback;
const inputPath = value("--input", "outputs/fall-2026/browser-checkpoints/threads-sirsho-ui-current.json");
const outputPath = value("--output", "outputs/fall-2026/threads-sirsho-importable.json");
const identityPath = "outputs/fall-2026/browser-checkpoints/instagram-sirsho-identity-ui-current.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const objectHash = (value) => sha(JSON.stringify(value));
const [inputBytes, identityBytes, seedBytes, rosterBytes] = await Promise.all([
  readFile(inputPath), readFile(identityPath), readFile("outputs/fall-2026/instagram-all-identity-seed.json"), readFile("src/lib/yc/fall-2026-companies.json")
]);
const input = JSON.parse(inputBytes), identityNative = JSON.parse(identityBytes), seed = JSON.parse(seedBytes), roster = JSON.parse(rosterBytes);
const company = roster.companies.find((row) => row.slug === "antimattr");
const founder = company.founders.find((row) => String(row.id) === "3675155");
const instagramAccountProof = seed.companies.find((row) => row.companySlug === company.slug).accounts.find((row) => row.entityType === "founder" && String(row.founderId) === String(founder.id) && row.handle === "sirsho29");
if (input.source?.batchSlug !== "F26" || input.source?.identitySha256 !== sha(identityBytes) || instagramAccountProof?.nativeFounderSocialIdentity?.artifactSha256 !== sha(identityBytes)
  || !await verifyInstagramFounderSocialIdentityArchive(instagramAccountProof, company, founder)) throw new Error("Threads founder identity must match the physically verified Instagram/roster receipt.");
const nativeInstagramThreadsLink = identityNative.profile?.links?.find((link) => { const id = nativeThreadsIdentity(link.url); return id?.handle === "sirsho29" && !id.postId; });
if (!nativeInstagramThreadsLink) throw new Error("Exact native Instagram outbound Threads account link is required.");
const identityProof = {
  source: "verified_instagram_founder_threads_outbound_v1", companySlug: company.slug, entityId: `founder-${company.slug}-sirsho-c-${founder.id}`,
  founderId: String(founder.id), founderName: founder.name, threadsProfileUrl: "https://www.threads.com/@sirsho29",
  instagramAccountProof, nativeInstagramThreadsLink, identityArchivePath: identityPath, identityArchiveSha256: sha(identityBytes),
  validation: { source: "fall_2026_threads_identity_ingestion_v1", archiveHashesVerified: true }
};
const evidence = [], needsReview = [];
for (const nativeObservation of input.nativePosts ?? []) {
  const native = nativeThreadsIdentity(nativeObservation.sourceUrl), text = nativeThreadsCaption(nativeObservation);
  if (!native?.postId || text === null) { needsReview.push({ sourceUrl: nativeObservation.sourceUrl, reasons: ["native_threads_full_caption_or_identity_unverified"] }); continue; }
  const post = { id: native.postId, url: nativeObservation.sourceUrl, authorHandle: native.handle, publishedAt: nativeObservation.time.datetime, text, metrics: {}, bodyTruncated: false, nativeObservation };
  const raw = {
    source: NATIVE_THREADS_SOURCE, observedAt: [input.source.observedAt, nativeObservation.observedAt].filter((time) => Number.isFinite(Date.parse(time))).sort((a, b) => Date.parse(b) - Date.parse(a))[0], identityProof, post,
    observationSource: inputPath, observationSourceSha256: sha(inputBytes),
    validation: { source: NATIVE_THREADS_VALIDATION, archiveHashesVerified: true, nativeObservationSha256: objectHash(nativeObservation), identityProofSha256: objectHash(identityProof), identityArchiveSha256: sha(identityBytes) }
  };
  const row = {
    id: `threads-f26-${native.postId}`, batchSlug: "F26", companySlug: company.slug, companyName: company.name,
    entityType: "founder", entityId: identityProof.entityId, entityName: founder.name, founderName: founder.name,
    platform: "threads", platformPostId: native.postId, accountUrl: identityProof.threadsProfileUrl, sourceUrl: nativeObservation.sourceUrl,
    authorName: founder.name, authorHandle: native.handle, title: text.split("\n")[0], text, originalText: text,
    postedAt: post.publishedAt, publishedAtPrecision: "exact", observedAt: nativeObservation.observedAt,
    metrics: {}, contributionScore: 0, tractionStatus: "unscored", mediaType: nativeObservation.media?.some((item) => item.kind === "video") ? "video" : "text",
    tractionLimitations: ["Native Threads action counters lack semantic metric labels and remain unknown. No calibrated Threads traction model is configured.", "Only four publicly visible cards were available before the explicit login frontier; this does not establish complete account history."],
    review_state: "verified", linkStatus: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: NATIVE_THREADS_SOURCE,
    attributionSignals: ["verified_founder_instagram_native_threads_outbound", "exact_native_threads_post_author"],
    matchReason: "A physically hashed native Instagram profile binds the exact roster founder's X/LinkedIn accounts and literal Threads outbound link; this own native Threads card proves its author, physical ID, complete body and UTC publication time.",
    rawVisibleText: JSON.stringify(raw), first_seen_at: nativeObservation.observedAt, last_checked_at: nativeObservation.observedAt, last_updated_at: post.publishedAt
  };
  const reasons = verifiedNativeThreadsReasons(row);
  if (reasons.length) needsReview.push({ sourceUrl: row.sourceUrl, reasons }); else evidence.push(row);
}
const source = { batchSlug: "F26", kind: NATIVE_THREADS_SOURCE, inputPath, inputSha256: sha(inputBytes), identityPath, identitySha256: sha(identityBytes), received: input.nativePosts?.length ?? 0, accepted: evidence.length, needsReview: needsReview.length, coverage: input.coverage, fullHistoryComplete: false };
await writeFile(outputPath, `${JSON.stringify({ source, evidence, needsReview }, null, 2)}\n`);
console.log(JSON.stringify(source));
