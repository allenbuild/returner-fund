import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NATIVE_YOUTUBE_SHORT_DOM_SOURCE, nativeYouTubeDomSummary } from "../src/lib/graph/youtube-native-dom-receipt.mjs";
import { NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE, NATIVE_YOUTUBE_UNKNOWN_DATE_VALIDATION, nativeYouTubeUnknownDateSummary, verifiedNativeYouTubeUnknownDateReasons, isVerifiedNativeYouTubeUnknownDateReceipt } from "../src/lib/graph/youtube-native-unknown-date-receipt.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const company = { slug: "fixture", name: "Fixture Company", websiteUrl: "https://fixture.example" }, channelUrl = "https://www.youtube.com/@fixture";
const url = "https://www.youtube.com/shorts/abcdefghijk", body = "The complete native caption.\n\nWith all hashtags. #Evidence";
function parents(native) {
  const binding = native.nativeShortIdentityBinding;
  native.channelHeaderHtml = `<ytd-video-description-header-renderer>${native.channelLinks[0].html}<span>Fixture Channel</span>${native.nativeFactoids.map((fact) => fact.html).join("")}</ytd-video-description-header-renderer>`;
  native.descriptionPanelHtml = `<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-structured-description" visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED">${native.channelHeaderHtml}${native.descriptionExpanderHtml}</ytd-engagement-panel-section-list-renderer>`;
  binding.rendererHtml = `${binding.rendererOpeningTag}${binding.rendererPlayerTitleLinks[0].html}${binding.rendererChannelLinks[0].html}</ytd-reel-video-renderer>`;
  binding.rootHtml = `<ytd-shorts role="main">${binding.rendererHtml}${native.descriptionPanelHtml}</ytd-shorts>`;
}
function fixture() {
  const anchor = { href: "https://www.youtube.com/@fixture/shorts", text: "@fixture", html: '<a href="/@fixture/shorts">@fixture</a>' };
  const fact = (label, text) => ({ label, text, html: `<div role="text" aria-label="${label}">${text.replaceAll("\n", "<br>")}</div>` });
  const native = { source: "native_youtube_short_description_dom_v1", url, title: "", description: body, descriptionHtml: `<yt-formatted-string id="formatted-snippet-text">${body}</yt-formatted-string>`, descriptionExpanderHtml: `<ytd-text-inline-expander id="inline-expander"><yt-formatted-string id="formatted-snippet-text">${body}</yt-formatted-string></ytd-text-inline-expander>`, descriptionPanelText: `Fixture Channel\n${body}`, fullDescriptionReceipt: { isExpanded: false, expandButtonVisible: false, ellipsisVisible: false, textVisible: true, snippetClientHeight: 80, snippetScrollHeight: 80 }, channelHeaderText: "Fixture Channel\n0\nLikes\n1\nViews\n4h\nAgo", channelLinks: [{ href: channelUrl, text: "", html: '<a href="/@fixture"><img alt="Fixture Channel"></a>' }], shortChannelLinks: [anchor], nativeShortText: "@fixture\nSubscribe\nThe complete native caption.", observedAt: "2026-11-16T21:00:00.000Z", alerts: [], nativeFactoids: [fact("No likes", "0\nLikes"), fact("1 view", "1\nViews"), fact("4 hours ago", "4h\nAgo")], nativeShortIdentityBinding: { url, rendererCount: 1, rendererOpeningTag: '<ytd-reel-video-renderer id="reel-video-renderer">', rendererPlayerTitleLinks: [{ href: url, text: "The complete native caption.", html: `<a class="ytp-title-link" href="${url}">The complete native caption.</a>` }], rendererChannelLinks: [anchor] } };
  parents(native);
  const listing = `<a href="/shorts/abcdefghijk">The complete native caption.</a>`;
  const receipt = { mechanism: NATIVE_YOUTUBE_SHORT_DOM_SOURCE, companySlug: company.slug, channelUrl, identityProof: { source: "official_company_website_youtube_channel_v1", companySlug: company.slug, companyName: company.name, entityId: "company-fixture", officialYcCompanyUrl: "https://www.ycombinator.com/companies/fixture", officialWebsite: company.websiteUrl, channelUrl, homepage: { requestedUrl: company.websiteUrl, finalUrl: company.websiteUrl, htmlSha256: "a".repeat(64), literalAnchorHtml: `<a href="${channelUrl}">YouTube</a>`, containingAncestorHtml: `<footer>Fixture Company<a href="${channelUrl}">YouTube</a></footer>` } }, channelObservation: { url: channelUrl, observedAt: "2026-11-16T20:59:00.000Z", mainText: "Fixture Channel\n@fixture\n2 videos", mainHtml: `<ytd-browse><ytd-tabbed-page-header><h1>Fixture Channel</h1><span>@fixture</span></ytd-tabbed-page-header>${listing}</ytd-browse>`, tabs: [{ text: "Shorts", ariaSelected: "true" }], alerts: [], loading: [], links: [{ href: url, text: "The complete native caption.", html: listing }] }, nativeObservation: native };
  const summary = nativeYouTubeUnknownDateSummary(receipt, company);
  assert.deepEqual(summary.reasons, []);
  receipt.unknownDatePublicationReceipt = summary.relativePublicationReceipt;
  const row = { batchSlug: "F26", platform: "youtube", companySlug: company.slug, companyName: company.name, entityType: "company", entityId: "company-fixture", review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE, platformPostId: summary.videoId, sourceUrl: url, accountUrl: channelUrl, authorHandle: "fixture", authorName: "Fixture Channel", title: summary.title, text: body, originalText: body, postedAt: null, publishedAtPrecision: "unknown", metrics: { views: 1, likes: 0 }, contributionScore: 0, tractionStatus: "unscored" };
  const validation = { source: NATIVE_YOUTUBE_UNKNOWN_DATE_VALIDATION, archiveHashesVerified: true, literalOfficialAnchorVerified: true, parentDomSegmentsVerified: true, archives: [{ kind: "native_short", path: "short.json", sha256: "b".repeat(64) }, { kind: "native_channel", path: "channel.json", sha256: "c".repeat(64) }, { kind: "official_website", path: "website.html", sha256: "a".repeat(64) }] };
  return { row, receipt, validation };
}
function seal(f) {
  f.validation.nativeReceiptSha256 = hash(f.receipt);
  f.row.rawVisibleText = JSON.stringify({ source: NATIVE_YOUTUBE_UNKNOWN_DATE_SOURCE, nativeYouTubeDomReceipt: f.receipt, validation: f.validation });
  return f.row;
}

test("explicit relative native publication label retains caption/ID/metrics with null unknown date and zero score", () => {
  const f = fixture(), before = JSON.stringify(f.receipt.nativeObservation), summary = nativeYouTubeUnknownDateSummary(f.receipt, company);
  assert.equal(summary.ok, true);
  assert.equal(summary.publishedDay, null);
  assert.equal(summary.publishedAtPrecision, "unknown");
  assert.equal(summary.relativePublicationReceipt.label, "4 hours ago");
  assert.deepEqual(summary.metrics, { views: 1, likes: 0 });
  assert.equal(isVerifiedNativeYouTubeUnknownDateReceipt(seal(f), company), true);
  assert.equal(JSON.stringify(f.receipt.nativeObservation), before);
  assert.deepEqual(nativeYouTubeDomSummary(f.receipt, company).reasons, ["youtube_short_native_exact_metrics_and_day_required"]);
});

test("only native www hostname normalization is allowed without changing Shorts path or query", () => {
  const f = fixture(); f.row.sourceUrl = url.replace("www.", "");
  assert.equal(isVerifiedNativeYouTubeUnknownDateReceipt(seal(f), company), true);
  for (const wrong of ["https://www.youtube.com/watch?v=abcdefghijk", url + "?x=1", url + "#x", "https://youtube.com.evil.example/shorts/abcdefghijk"]) {
    f.row.sourceUrl = wrong;
    assert.equal(isVerifiedNativeYouTubeUnknownDateReceipt(seal(f), company), false);
  }
});

for (const [label, mutate] of [
  ["made-up observed-day timestamp", (f) => { f.row.postedAt = "2026-11-16T00:00:00.000Z"; }],
  ["precision silently upgraded", (f) => { f.row.publishedAtPrecision = "day"; }],
  ["positive contribution", (f) => { f.row.contributionScore = 1; }],
  ["traction marked scored", (f) => { f.row.tractionStatus = "scored"; }],
  ["positive score field", (f) => { f.row.score = 1; }],
  ["invented comments", (f) => { f.row.metrics.comments = 0; }],
  ["changed caption", (f) => { f.row.text += "change"; }],
  ["unbound relative receipt", (f) => { f.receipt.unknownDatePublicationReceipt.label = "8 hours ago"; }],
  ["missing physical archive gate", (f) => { f.validation.archiveHashesVerified = false; }],
  ["missing native channel archive", (f) => { f.validation.archives.splice(1, 1); }],
]) {
  test(`unknown-date canonical/archive gate rejects ${label}`, () => { const f = fixture(); mutate(f); assert.equal(isVerifiedNativeYouTubeUnknownDateReceipt(seal(f), company), false); });
}

for (const [label, mutate] of [
  ["missing relative factoid", (n) => { n.nativeFactoids.pop(); }],
  ["duplicated relative factoid", (n) => { n.nativeFactoids.push(structuredClone(n.nativeFactoids[2])); }],
  ["ambiguous publication label", (n) => { n.nativeFactoids[2] = { label: "Recently", text: "Recently", html: '<div role="text" aria-label="Recently">Recently</div>' }; }],
  ["calendar day already available", (n) => { n.nativeFactoids[2] = { label: "Nov 16, 2026", text: "Nov 16\n2026", html: '<div role="text" aria-label="Nov 16, 2026">Nov 16<br>2026</div>' }; }],
  ["visible relative count conflicts", (n) => { n.nativeFactoids[2] = { label: "4 hours ago", text: "8h\nAgo", html: '<div role="text" aria-label="4 hours ago">8h<br>Ago</div>' }; }],
  ["third-party primary actor", (n) => { n.channelLinks[0].href = "https://www.youtube.com/@another"; }],
  ["wrong active native ID", (n) => { n.nativeShortIdentityBinding.url = "https://www.youtube.com/shorts/lmnopqrstuv"; }],
  ["clipped full caption", (n) => { n.fullDescriptionReceipt.snippetScrollHeight = 100; }],
  ["missing own views", (n) => { n.nativeFactoids.splice(1, 1); }],
  ["native service warning", (n) => { n.alerts = ["Sign in to confirm you are not a bot"]; }],
]) {
  test(`unknown-date exception keeps all strict native proof gates: ${label}`, () => {
    const f = fixture(); mutate(f.receipt.nativeObservation); parents(f.receipt.nativeObservation);
    const summary = nativeYouTubeUnknownDateSummary(f.receipt, company);
    assert.equal(summary.ok, false);
    assert.equal(isVerifiedNativeYouTubeUnknownDateReceipt(seal(f), company), false);
    assert.ok(verifiedNativeYouTubeUnknownDateReasons(seal(f), company).length > 0);
  });
}

test("relative label in a detached overlay cannot replace the same native panel factoid", () => {
  const f = fixture(), native = f.receipt.nativeObservation;
  native.descriptionPanelHtml = native.descriptionPanelHtml.replace(native.nativeFactoids[2].html, "");
  native.nativeShortIdentityBinding.rootHtml = `<ytd-shorts role="main">${native.nativeShortIdentityBinding.rendererHtml}${native.descriptionPanelHtml}</ytd-shorts>`;
  assert.equal(isVerifiedNativeYouTubeUnknownDateReceipt(seal(f), company), false);
});
