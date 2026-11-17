import assert from "node:assert/strict";
import test from "node:test";
import {
  ROBIN_FOUNDER_PUBLICATION_SOURCE, ROBIN_FOUNDER_PUBLICATION_VALIDATION,
  robinPublicationSha256 as sha, robinPublicationNativeFields,
  isVerifiedRobinFounderPublicationContext, robinFounderPublicationContextReasons
} from "../src/lib/graph/robin-founder-publication-context-receipt.mjs";

const entity = { entityId: "founder-adsideai-robin-choy-406206", companySlug: "adsideai", companyName: "Adside.ai", founderName: "Robin Choy", socialAccounts: { x: "https://x.com/ChoyRb" } };
function resign(row) {
  row.originalBodyHtmlSha256 = sha(row.originalBodyHtml);
  const raw = {
    source: ROBIN_FOUNDER_PUBLICATION_SOURCE, ownership: row.officialFounderPublicationOwnership, nativePost: robinPublicationNativeFields(row), text: row.text,
    nativeFeedPublishedAtLiteral: row.nativeFeedPublishedAtLiteral, observedAt: row.observedAt, archives: [{ path: "fixture/native-post.html", sha256: sha("native page fixture") }]
  };
  raw.validation = { source: ROBIN_FOUNDER_PUBLICATION_VALIDATION, archiveHashesVerified: true, exactRosterFounderVerified: true, nativeOwnProfileAnchorVerified: true,
    personalSiteSelfBiographyAndReciprocalXVerified: true, literalOwnedPublicationAnchorVerified: true, fullNativePostPreloadAndHtmlVerified: true, fullRssBodyAndNativeClockVerified: true,
    originalTextSha256: sha(row.originalText), originalBodyHtmlSha256: row.originalBodyHtmlSha256, nativeFieldsSha256: sha(JSON.stringify(raw.nativePost)),
    ownershipSha256: sha(JSON.stringify(raw.ownership)), archivesSha256: sha(JSON.stringify(raw.archives)) };
  row.rawVisibleText = JSON.stringify(raw);
  return row;
}
function fixture() {
  const owner = { source: "official_founder_native_profile_personal_site_publication_chain_v1", companySlug: "adsideai", founderId: "406206", founderName: "Robin Choy", entityId: entity.entityId,
    officialYcCompanyUrl: "https://www.ycombinator.com/companies/adsideai", officialXProfileUrl: "https://x.com/ChoyRb", personalWebsiteUrl: "https://robinchoy.com/", publicationUrl: "https://robinchoy.substack.com/", nativePublicationId: 2319101,
    nativeXProfileWebsiteAnchor: { href: "https://t.co/t7XtL09Z8N", text: "robinchoy.com", anchorHtml: '<a data-testid="UserUrl" href="https://t.co/t7XtL09Z8N">robinchoy.com</a>' },
    personalHomepageFounderHeadingHtml: "<h1>Robin Choy</h1>", personalHomepageSelfBiographyHtml: "<p>I'm a repeat founder. I am building Adside.</p>",
    personalHomepageReciprocalXAnchorHtml: '<a href="https://x.com/ChoyRb">@ChoyRb</a>', publicationAnchorHtml: '<a href="https://robinchoy.substack.com/">Substack</a>',
    nativeXProfileArchiveSha256: sha("profile fixture"), personalHomepageSha256: sha("homepage fixture"), rosterSha256: sha("roster fixture"), ownershipInventorySha256: sha("ownership fixture") };
  return resign({ batchSlug: "F26", companySlug: "adsideai", companyName: "Adside.ai", entityType: "founder", entityId: entity.entityId, founderId: "406206", authorName: "Robin Choy",
    platform: "web", publisherPlatform: "substack", nativePostId: "211370047", nativePublicationId: 2319101, sourceUrl: "https://robinchoy.substack.com/p/every-yc-company-should-be-investing",
    platformPostId: "https://robinchoy.substack.com/p/every-yc-company-should-be-investing", authorUrl: "https://substack.com/@robinchoy1", identitySourceUrl: "https://www.ycombinator.com/companies/adsideai",
    title: "An exact native title", text: "First paragraph.\n\nSecond paragraph.", originalText: "First paragraph.\n\nSecond paragraph.", originalBodyHtml: "<p>First paragraph.</p><p>Second paragraph.</p>",
    postedAt: "2026-07-18T01:30:00.187Z", nativePublishedAtLiteral: "2026-07-18T01:30:00.187Z", nativeFeedPublishedAtLiteral: "Sat, 18 Jul 2026 01:30:00 GMT", observedAt: "2026-11-16T21:11:53.849Z",
    nativePublishedBylines: [{ id: 224124204, name: "Robin Choy", handle: "robinchoy1", is_guest: false }], nativeAudience: "everyone", nativeIsPublished: true, bodyTruncated: false, bodyPaywalled: false,
    metrics: {}, contributionScore: 0, tractionStatus: "unscored", nativeSocialPostAdmission: false, historyComplete: false,
    review_state: "verified", attributionStatus: "verified", attributionMode: "author", attributionProvenance: ROBIN_FOUNDER_PUBLICATION_SOURCE, officialFounderPublicationOwnership: owner });
}

test("exact known founder, native ownership chain and full article receipt admit only unscored context", () => {
  const row = fixture();
  assert.deepEqual(robinFounderPublicationContextReasons(row, entity), []);
  assert.equal(isVerifiedRobinFounderPublicationContext(row, entity), true);
});
test("wrong known founder/company or official X account cannot self-declare ownership", () => {
  for (const changed of [{ ...entity, entityId: "founder-other" }, { ...entity, companySlug: "other" }, { ...entity, socialAccounts: { x: "https://x.com/someone_else" } }]) assert.equal(isVerifiedRobinFounderPublicationContext(fixture(), changed), false);
});
test("changed body, native title, ownership or archive references invalidate receipt hashes", () => {
  for (const change of [r => { r.text += " fabricated"; }, r => { r.title += " changed"; }, r => { r.officialFounderPublicationOwnership.personalHomepageSha256 = sha("changed"); }, r => { const raw = JSON.parse(r.rawVisibleText); raw.archives[0].sha256 = sha("changed"); r.rawVisibleText = JSON.stringify(raw); }]) {
    const row = fixture(); change(row); assert.equal(isVerifiedRobinFounderPublicationContext(row, entity), false);
  }
});
test("different native post/publication/byline or a third-party publication cannot be resigned into this lane", () => {
  for (const change of [r => { r.nativePostId = "123"; }, r => { r.nativePublicationId++; }, r => { r.sourceUrl = r.platformPostId = "https://other.substack.com/p/press"; }, r => { r.nativePublishedBylines[0].name = "Reporter"; }, r => { r.nativePublishedBylines[0].is_guest = true; }]) {
    const row = fixture(); change(row); resign(row); assert.equal(isVerifiedRobinFounderPublicationContext(row, entity), false);
  }
});
test("exact own website reciprocal/header/publication anchor chain is required, not a press link", () => {
  for (const change of [r => { r.officialFounderPublicationOwnership.nativeXProfileWebsiteAnchor.text = "different.com"; }, r => { r.officialFounderPublicationOwnership.personalHomepageFounderHeadingHtml = "<h1>Reporter</h1>"; }, r => { r.officialFounderPublicationOwnership.personalHomepageSelfBiographyHtml = "<p>Interview with Robin Choy</p>"; }, r => { r.officialFounderPublicationOwnership.personalHomepageReciprocalXAnchorHtml = '<a href="https://x.com/other">Other</a>'; }, r => { r.officialFounderPublicationOwnership.publicationAnchorHtml = '<a href="https://press.example">Press</a>'; }]) {
    const row = fixture(); change(row); resign(row); assert.equal(isVerifiedRobinFounderPublicationContext(row, entity), false);
  }
});
test("native future clock, RSS date conflict, draft/paywall/truncation remain held", () => {
  for (const change of [r => { r.observedAt = "2026-07-18T01:29:00Z"; }, r => { r.nativeFeedPublishedAtLiteral = "Sat, 18 Jul 2026 01:31:00 GMT"; }, r => { r.nativeIsPublished = false; }, r => { r.nativeAudience = "paid"; }, r => { r.bodyPaywalled = true; }, r => { r.bodyTruncated = true; }]) {
    const row = fixture(); change(row); resign(row); assert.equal(isVerifiedRobinFounderPublicationContext(row, entity), false);
  }
});
test("metrics, positive score, complete-history claim and derived founder people URL are rejected", () => {
  for (const change of [r => { r.metrics = { likes: 1 }; }, r => { r.contributionScore = 1; }, r => { r.historyComplete = true; }, r => { r.nativeSocialPostAdmission = true; }, r => { r.identitySourceUrl = "https://www.ycombinator.com/people/robin-choy"; }]) {
    const row = fixture(); change(row); resign(row); assert.equal(isVerifiedRobinFounderPublicationContext(row, entity), false);
  }
});
test("physical ingestion validation is mandatory and invalid input fails closed", () => {
  const row = fixture(), raw = JSON.parse(row.rawVisibleText); raw.validation.archiveHashesVerified = false; row.rawVisibleText = JSON.stringify(raw);
  assert.equal(isVerifiedRobinFounderPublicationContext(row, entity), false);
  for (const value of [null, {}, { rawVisibleText: "not JSON" }]) assert.equal(isVerifiedRobinFounderPublicationContext(value, entity), false);
});
