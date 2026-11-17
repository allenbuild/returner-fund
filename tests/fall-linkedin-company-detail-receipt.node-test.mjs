import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { nativeLinkedInCompanyDetailSummary, verifiedNativeLinkedInCompanyDetailReasons, isVerifiedNativeLinkedInCompanyDetailReceipt } from "../src/lib/graph/linkedin-company-detail-receipt.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const profile = "https://www.linkedin.com/company/ignitionbenefits/";
const url = "https://www.linkedin.com/feed/update/urn:li:activity:7513974843927707648/";
const entity = { entityId: "company-ignition-benefits", companySlug: "ignition-benefits", companyName: "Ignition", socialAccounts: { linkedin: [profile] } };
function fixture() {
  const menuLabel = "Open control menu for post by Ignition Benefits (YC F26)", captionHtml = "<span>Actual event &amp; company caption.</span>";
  const actor = { href: profile, text: "Ignition Benefits (YC F26)" };
  const reaction = { tag: "BUTTON", ariaLabel: "Reaction button state: no reaction", text: "3", html: '<button aria-label="Reaction button state: no reaction">3</button>' };
  const redirect = { href: `https://www.linkedin.com/signup/cold-join?session_redirect=${encodeURIComponent(url)}`, text: "Join" };
  const detail = { url, observedRedirectTarget: url, observedRedirectLink: redirect, observedAt: "2026-11-16T19:00:00.000Z", menuLabel, primaryActorLinks: [actor], captionHtml, captionText: "Actual event & company caption.", fullnessControls: [], nativeControls: [reaction], cardHtml: `<div><a href="${profile}">${actor.text}</a><button aria-label="${menuLabel}"></button>${captionHtml}${reaction.html}</div>` };
  return { mechanism: "native_linkedin_company_detail_redirect_v1", companySlug: entity.companySlug, profileUrl: profile, observedAt: detail.observedAt, review: { card: { key: "opaque-native-card-key", body: detail.captionText, menu: menuLabel }, nativeEmbedLinks: [redirect], signedInNativeDetail: detail } };
}
function rowFor(receipt = fixture()) {
  const summary = nativeLinkedInCompanyDetailSummary(receipt, entity);
  return { batchSlug: "F26", platform: "linkedin", entityType: "company", entityId: entity.entityId, companyName: entity.companyName, accountUrl: profile, sourceUrl: summary.sourceUrl, platformPostId: summary.platformPostId, authorName: summary.authorName, text: summary.text, originalText: summary.text, metrics: summary.metrics, postedAt: null, publishedAtPrecision: "unknown", review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: "native_linkedin_company_detail_v1", rawVisibleText: JSON.stringify({ source: "authorized_linkedin_browser_dom_v1", observedAt: receipt.observedAt, post: { id: summary.platformPostId, url: summary.sourceUrl, text: summary.text, metrics: summary.metrics, bodyTruncated: false, publishedAt: null, nativeCompanyDetailReceipt: receipt }, validation: { source: "fall_2026_native_linkedin_company_detail_ingestion_v1", archiveHashesVerified: true, nativeCompanyDetailReceiptSha256: hash(receipt) } }) };
}
test("actual observed sign-in redirect binds exact company activity/body and unknown native date", () => {
  assert.deepEqual(verifiedNativeLinkedInCompanyDetailReasons(rowFor(), entity), []);
  const summary = nativeLinkedInCompanyDetailSummary(fixture(), entity);
  assert.deepEqual(summary.metrics, { reactions: 3 });
  assert.equal(summary.postedAt, null);
});
test("guessed UGC/activity IDs and redirects absent from observed native links fail", () => {
  for (const change of [(r) => { r.review.signedInNativeDetail.observedRedirectTarget = url.replace("7513974843927707648", "7513974842870665216"); }, (r) => { r.review.nativeEmbedLinks = []; }, (r) => { r.review.signedInNativeDetail.url = url.replace("activity", "ugcPost"); }]) { const receipt = fixture(); change(receipt); assert.equal(nativeLinkedInCompanyDetailSummary(receipt, entity).ok, false); }
});
test("wrong company actor/menu and partial or altered own captions fail", () => {
  for (const change of [(d) => { d.primaryActorLinks[0].href = "https://www.linkedin.com/company/other/"; }, (d) => { d.menuLabel += " Other"; }, (d) => { d.captionText += " invented"; }, (d) => { d.fullnessControls.push({ text: "See more" }); }, (d) => { d.cardHtml = d.cardHtml.replace("company caption", "company other"); }]) { const receipt = fixture(); change(receipt.review.signedInNativeDetail); assert.equal(nativeLinkedInCompanyDetailSummary(receipt, entity).ok, false); }
});
test("invented metrics/owner/date and stale ingestion hashes fail", () => {
  for (const change of [(row) => { row.metrics.reactions = 4; }, (row) => { row.entityId = "company-other"; }, (row) => { row.postedAt = "2026-11-15T00:00:00.000Z"; }, (row) => { const raw = JSON.parse(row.rawVisibleText); raw.validation.nativeCompanyDetailReceiptSha256 = "0".repeat(64); row.rawVisibleText = JSON.stringify(raw); }]) { const row = rowFor(); change(row); assert.equal(isVerifiedNativeLinkedInCompanyDetailReceipt(row, entity), false); }
});
test("missing, abbreviated and ambiguous counters stay unknown; future receipt order fails", () => {
  const receipt = fixture(), detail = receipt.review.signedInNativeDetail;
  detail.nativeControls[0].text = "3K";
  assert.deepEqual(nativeLinkedInCompanyDetailSummary(receipt, entity).metrics, {});
  detail.observedAt = "2026-11-16T19:00:01.000Z";
  assert.equal(nativeLinkedInCompanyDetailSummary(receipt, entity).ok, false);
});
