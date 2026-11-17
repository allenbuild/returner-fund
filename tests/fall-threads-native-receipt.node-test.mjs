import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NATIVE_THREADS_SOURCE, NATIVE_THREADS_VALIDATION, nativeThreadsCaption, nativeThreadsIdentity, isVerifiedNativeThreadsReceipt, verifiedNativeThreadsReasons } from "../src/lib/graph/threads-native-receipt.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const identitySha256 = "d222eaf18a27f8b6008313cf1cbc09efed4c7b7a2ca3fb22aee63ccef7bacf3f";
const identityArchivePath = "outputs/fall-2026/browser-checkpoints/instagram-sirsho-identity-ui-current.json";
const entityId = "founder-antimattr-sirsho-c-3675155";
const identity = { profile: { links: [{ url: "https://www.threads.com/@sirsho29?xmt=synthetic-tracking", text: "sirsho29" }] } };
const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// Synthetic DOM fixtures exercise the receipt contract without reading mutable,
// ignored collection artifacts. Physical archives are the importer's concern.
function articleFor(id, body, counter = false) {
  const url = `https://www.threads.com/@sirsho29/post/${id}`, datetime = "2026-10-05T17:55:53.000Z", dateText = "10/05/26";
  const contentSpans = [{ tag: "SPAN", text: "sirsho29", html: "<span>sirsho29</span>" }, { tag: "SPAN", text: dateText, html: `<span><a href="/@sirsho29/post/${id}"><time datetime="${datetime}">${dateText}</time></a></span>` }, ...body.map((text) => ({ tag: "SPAN", text, html: `<span dir="auto">${escapeHtml(text)}</span>` }))];
  if (counter) contentSpans.push({ tag: "SPAN", text: "1", html: "<span><div><span>1</span></div></span>" });
  return { companySlug: "antimattr", founderId: "3675155", platform: "threads", sourceUrl: url, observedAt: "2026-11-16T18:14:01.141Z", time: { datetime, href: url, text: dateText }, links: [{ url: "https://www.threads.com/@sirsho29", text: "sirsho29" }, { url, text: dateText }], controls: [{ label: null, text: counter ? "1" : "", icons: [] }], contentSpans, nativeHtml: `<div>${contentSpans.map((span) => span.html).join("")}</div>`, nativeText: contentSpans.map((span) => span.text).join("\n") };
}
const checkpoint = { source: { identitySha256 }, nativePosts: [articleFor("CaseSensitiveA", ["First paragraph & exact newline\nsecond line", "github.com/visible…"], true), articleFor("CaseSensitiveB", ["1", "Numeric caption remains body."], true), articleFor("CaseSensitiveC", ["Unicode quote ’ and emoji :)", "#native #caption"]), articleFor("CaseSensitiveD", ["Full native body without counters."])] };
function rowFor(article = checkpoint.nativePosts[0]) {
  const account = { handle: "sirsho29", entityType: "founder", founderId: "3675155", founderName: "Sirsho C", review_state: "verified", companyAccountMention: "antimattr.one", profileUrl: "https://www.instagram.com/sirsho29/", nativeFounderSocialIdentity: { source: "native_instagram_exact_roster_social_outbound_v1", batchSlug: "F26", companySlug: "antimattr", entityId, founderId: "3675155", founderName: "Sirsho C", companyHandle: "antimattr.one", artifactPath: identityArchivePath, artifactSha256: identitySha256, profileUrl: "https://www.instagram.com/sirsho29/", observedAt: "2026-11-16T18:07:17.890Z", visibleBio: "sirsho29\nbuilding @antimattr.one", nativeOutboundLinks: [{ url: "https://x.com/sirsho29" }, { url: "https://linkedin.com/in/sirsho29" }], matchedCanonicalAccounts: { x: "https://x.com/sirsho29", linkedin: "https://linkedin.com/in/sirsho29" } } };
  const proof = { source: "verified_instagram_founder_threads_outbound_v1", companySlug: "antimattr", entityId: "founder-antimattr-sirsho-c-3675155", founderId: "3675155", founderName: "Sirsho C", threadsProfileUrl: "https://www.threads.com/@sirsho29", instagramAccountProof: account, nativeInstagramThreadsLink: identity.profile.links.find((link) => link.url.includes("/@sirsho29")), identityArchivePath: "outputs/fall-2026/browser-checkpoints/instagram-sirsho-identity-ui-current.json", identityArchiveSha256: checkpoint.source.identitySha256, validation: { source: "fall_2026_threads_identity_ingestion_v1", archiveHashesVerified: true } };
  const post = { id: nativeThreadsIdentity(article.sourceUrl).postId, url: article.sourceUrl, authorHandle: "sirsho29", publishedAt: article.time.datetime, text: nativeThreadsCaption(article), bodyTruncated: false, metrics: {}, nativeObservation: article };
  const raw = { source: NATIVE_THREADS_SOURCE, observedAt: "2026-11-16T18:14:01.144Z", post, identityProof: proof, validation: { source: NATIVE_THREADS_VALIDATION, archiveHashesVerified: true, nativeObservationSha256: hash(article), identityProofSha256: hash(proof), identityArchiveSha256: checkpoint.source.identitySha256 } };
  return { batchSlug: "F26", companyName: "antimattr", entityType: "founder", entityId: proof.entityId, platform: "threads", sourceUrl: article.sourceUrl, accountUrl: proof.threadsProfileUrl, authorName: "Sirsho C", authorHandle: "sirsho29", platformPostId: post.id, text: post.text, originalText: post.text, postedAt: post.publishedAt, metrics: {}, contributionScore: 0, tractionStatus: "unscored", review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: NATIVE_THREADS_SOURCE, rawVisibleText: JSON.stringify(raw) };
}
function mutate(row, change, rehash = false) {
  const copy = clone(row), raw = JSON.parse(copy.rawVisibleText);
  change(copy, raw);
  if (rehash) { raw.validation.nativeObservationSha256 = hash(raw.post.nativeObservation); raw.validation.identityProofSha256 = hash(raw.identityProof); }
  copy.rawVisibleText = JSON.stringify(raw);
  return copy;
}

test("native Threads cards verify exact UTC, Unicode, numeric body and unlabeled counters", () => {
  for (const article of checkpoint.nativePosts) {
    const row = rowFor(article);
    assert.deepEqual(verifiedNativeThreadsReasons(row), []);
    assert.equal(isVerifiedNativeThreadsReceipt(row), true);
    assert.ok(!row.text.endsWith("\n1"));
    assert.deepEqual(row.metrics, {});
  }
});
test("identity accepts native profile tracking only and rejects arbitrary URLs", () => {
  assert.deepEqual(nativeThreadsIdentity(identity.profile.links.find((link) => link.url.includes("/@sirsho29")).url), { handle: "sirsho29", postId: null });
  for (const url of ["https://evil.test/@sirsho29/post/abc", "http://threads.com/@sirsho29", "https://threads.com/@sirsho29?next=x", "https://threads.com/@sirsho29/post/abc?xmt=one", "https://user:pass@threads.com/@sirsho29"]) assert.equal(nativeThreadsIdentity(url), null);
});
test("wrong company, founder, outer author or native ID fails", () => {
  const row = rowFor();
  for (const change of [(r) => { r.entityId = "founder-other"; }, (r) => { r.authorHandle = "other"; }, (r) => { r.companyName = "other"; }, (r) => { r.platformPostId = "other"; }, (r, raw) => { raw.post.nativeObservation.links.push({ url: "https://threads.com/@other/post/abc", text: "other" }); }]) assert.equal(isVerifiedNativeThreadsReceipt(mutate(row, change, true)), false);
});
test("self-declared owner, changed X or LinkedIn evidence and archive SHA fail", () => {
  for (const change of [(_, raw) => { raw.identityProof.instagramAccountProof.nativeFounderSocialIdentity.matchedCanonicalAccounts.x = "https://x.com/other"; }, (_, raw) => { raw.identityProof.instagramAccountProof.nativeFounderSocialIdentity.nativeOutboundLinks = []; }, (_, raw) => { raw.identityProof.nativeInstagramThreadsLink.url = "https://threads.com/@other"; }, (_, raw) => { raw.identityProof.identityArchiveSha256 = "a".repeat(64); }]) assert.equal(isVerifiedNativeThreadsReceipt(mutate(rowFor(), change, true)), false);
});
test("exact span, body and HTML hashes cannot be changed independently", () => {
  for (const change of [(r) => { r.text += " invented"; }, (_, raw) => { raw.post.nativeObservation.contentSpans[2].text += " invented"; }, (_, raw) => { raw.post.nativeObservation.nativeHtml += " changed"; }, (_, raw) => { raw.validation.nativeObservationSha256 = "b".repeat(64); }]) assert.equal(isVerifiedNativeThreadsReceipt(mutate(rowFor(), change)), false);
  assert.equal(isVerifiedNativeThreadsReceipt(mutate(rowFor(), (_, raw) => { raw.post.nativeObservation.contentSpans[2].text += " invented"; }, true)), false);
});
test("unexpanded controls, missing spans and mixed-card content fail", () => {
  for (const change of [(_, raw) => { raw.post.nativeObservation.controls.push({ text: "See more" }); }, (_, raw) => { raw.post.nativeObservation.contentSpans = []; }, (_, raw) => { raw.post.bodyTruncated = true; }]) assert.equal(isVerifiedNativeThreadsReceipt(mutate(rowFor(), change, true)), false);
});
test("native publication must be valid UTC and no later than observation", () => {
  for (const date of ["2026-02-30T17:55:53.000Z", "2026-11-17T00:00:00.000Z", "2026-10-05"]) assert.equal(isVerifiedNativeThreadsReceipt(mutate(rowFor(), (r, raw) => { r.postedAt = date; raw.post.publishedAt = date; raw.post.nativeObservation.time.datetime = date; }, true)), false);
});
test("unlabeled counters never become invented likes or score", () => {
  for (const change of [(r) => { r.metrics = { likes: 1 }; }, (_, raw) => { raw.post.metrics = { likes: 0 }; }, (r) => { r.contributionScore = 1; }, (r) => { r.tractionStatus = "ranked"; }]) assert.equal(isVerifiedNativeThreadsReceipt(mutate(rowFor(), change)), false);
});
