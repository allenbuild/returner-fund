import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NATIVE_YOUTUBE_DOM_SOURCE, NATIVE_YOUTUBE_DOM_VALIDATION, NATIVE_YOUTUBE_SHORT_DOM_SOURCE, NATIVE_YOUTUBE_SHORT_DOM_VALIDATION, nativeYouTubeDomSource, nativeYouTubeDomValidation, isNativeYouTubeDomProvenance, nativeYouTubePostId, nativeYouTubeChannelIdentity, nativeYouTubeVideoId, nativeYouTubeDomSummary, nativeYouTubeShortDescription, verifiedNativeYouTubeDomReasons, isVerifiedNativeYouTubeDomReceipt } from "../src/lib/graph/youtube-native-dom-receipt.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const siteHash = "a".repeat(64), channelUrl = "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv";
const company = { slug: "fixture-labs", name: "Fixture Labs", websiteUrl: "https://fixture.example/" };
function fixture() {
  const title = "A complete product demo", description = "Our full demo.\n\nA second paragraph with 🧪 and & source evidence.";
  const ownerAnchor = '<a href="/@fixturelabs">Fixture Labs Inc.</a>';
  const ownerHtml = `<div id="owner">${ownerAnchor}<span>7 subscribers</span></div>`;
  const descriptionHtml = '<div id="expanded">Our full demo.\n\nA second paragraph with 🧪 and &amp; source evidence.</div>';
  const descriptionExpanderHtml = `<ytd-text-inline-expander id="description-inline-expander" is-expanded="">${descriptionHtml}<tp-yt-paper-button id="collapse">Show less</tp-yt-paper-button></ytd-text-inline-expander>`;
  const nativeInfoText = "1,234 views  Nov 11, 2026  #Demo";
  const nativeInfoHtml = `<div id="info-container"><span>1,234 views</span><span>  Nov 11, 2026  #Demo</span></div>`;
  const button = { label: "like this video along with 7 other people", text: "7", pressed: "false", html: '<button aria-label="like this video along with 7 other people" aria-pressed="false"><span>7</span></button>' };
  const watchUrl = "https://www.youtube.com/watch?v=abcdefghijk";
  const listedHtml = `<a href="/watch?v=abcdefghijk">${title}</a>`;
  const receipt = {
    mechanism: NATIVE_YOUTUBE_DOM_SOURCE, companySlug: company.slug, channelUrl,
    identityProof: { source: "official_company_website_youtube_channel_v1", companySlug: company.slug, companyName: company.name, entityId: "company-fixture-labs", officialYcCompanyUrl: "https://www.ycombinator.com/companies/fixture-labs", officialWebsite: company.websiteUrl, channelUrl, homepage: { requestedUrl: company.websiteUrl, finalUrl: company.websiteUrl, htmlSha256: siteHash, literalAnchorHtml: `<a href="${channelUrl}">YouTube</a>`, containingAncestorHtml: `<footer>Fixture Labs <a href="${channelUrl}">YouTube</a></footer>` } },
    channelObservation: { url: channelUrl, observedAt: "2026-11-16T20:50:00.000Z", mainText: "Fixture Labs Inc.\n@fixturelabs\n7 subscribers\n1 video", mainHtml: `<ytd-browse><ytd-tabbed-page-header><h1>Fixture Labs Inc.</h1><span>@fixturelabs</span></ytd-tabbed-page-header>${listedHtml}</ytd-browse>`, tabs: [{ text: "Videos", ariaSelected: "true" }], alerts: [], loading: [], links: [{ href: watchUrl, text: title, html: listedHtml }] },
    nativeObservation: { source: "native_youtube_watch_dom_v1", url: watchUrl, title, description, descriptionConfirmedExpanded: true, descriptionHtml, descriptionExpanderHtml, ownerHtml, ownerLinks: [{ href: "https://www.youtube.com/@fixturelabs", text: "Fixture Labs Inc.", html: ownerAnchor }], ownerText: "Fixture Labs Inc.\n7 subscribers\nSubscribe", nativeInfoText, nativeInfoHtml, metricControls: [button], observedAt: "2026-11-16T20:51:00.000Z", alerts: [], metadataHtml: `<ytd-watch-metadata video-id="abcdefghijk"><h1>${title}</h1>${ownerHtml}${descriptionExpanderHtml}${nativeInfoHtml}${button.html}</ytd-watch-metadata>`, metadataText: `${title}\nFixture Labs Inc.\n7 subscribers\n7\n${nativeInfoText}\n${description}` },
  };
  const summary = nativeYouTubeDomSummary(receipt, company);
  assert.deepEqual(summary.reasons, []);
  const row = { batchSlug: "F26", platform: "youtube", companySlug: company.slug, companyName: company.name, entityType: "company", entityId: "company-fixture-labs", review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: NATIVE_YOUTUBE_DOM_SOURCE, platformPostId: summary.videoId, sourceUrl: summary.sourceUrl, accountUrl: channelUrl, authorHandle: summary.channelHandle, authorName: summary.channelName, title, text: description, originalText: description, postedAt: summary.publishedDay, publishedAtPrecision: "day", metrics: summary.metrics };
  const validation = { source: NATIVE_YOUTUBE_DOM_VALIDATION, archiveHashesVerified: true, literalOfficialAnchorVerified: true, parentDomSegmentsVerified: true, nativeReceiptSha256: hash(receipt), archives: [{ kind: "native_watch", path: "watch.json", sha256: "b".repeat(64) }, { kind: "native_channel", path: "channel.json", sha256: "c".repeat(64) }, { kind: "official_website", path: "website.html", sha256: siteHash }] };
  return { row, receipt, validation };
}
function seal(value) {
  value.validation.nativeReceiptSha256 = hash(value.receipt);
  value.row.rawVisibleText = JSON.stringify({ source: nativeYouTubeDomSource(value.receipt.nativeObservation), nativeYouTubeDomReceipt: value.receipt, validation: value.validation });
  return value.row;
}

test("exact native body, day-only date and own counters are admitted without inventing comments", () => {
  const f = fixture(), summary = nativeYouTubeDomSummary(f.receipt, company);
  assert.equal(summary.publishedDay, "2026-11-11");
  assert.equal(summary.publishedAtPrecision, "day");
  assert.deepEqual(summary.metrics, { views: 1234, likes: 7 });
  assert.equal("comments" in summary.metrics, false);
  assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), true);
});

test("canonical www removal preserves exact native video kind, path, query and ID", () => {
  const row = seal(fixture());
  assert.equal(isVerifiedNativeYouTubeDomReceipt({ ...row, sourceUrl: row.sourceUrl.replace("www.youtube.com", "youtube.com") }, company), true);
  for (const sourceUrl of ["https://youtube.com/shorts/abcdefghijk", "https://youtube.com/watch?v=lmnopqrstuv", "https://youtube.com/watch?v=abcdefghijk&feature=shared", "https://youtube.com.evil.example/watch?v=abcdefghijk", "http://youtube.com/watch?v=abcdefghijk"]) assert.equal(isVerifiedNativeYouTubeDomReceipt({ ...row, sourceUrl }, company), false);
});

test("an exact official handle footer is reusable without a pinned channel/company special case", () => {
  const f = fixture(), next = "https://www.youtube.com/@fixturelabs";
  f.receipt.channelUrl = next; f.receipt.identityProof.channelUrl = next;
  f.receipt.identityProof.homepage.literalAnchorHtml = `<a href="${next}">YouTube</a>`;
  f.receipt.identityProof.homepage.containingAncestorHtml = `<footer>Fixture Labs ${f.receipt.identityProof.homepage.literalAnchorHtml}</footer>`;
  f.receipt.channelObservation.url = next; f.row.accountUrl = next;
  assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), true);
});

test("an explicit native zero is preserved without turning an unknown counter into zero", () => {
  const f = fixture(), native = f.receipt.nativeObservation, prior = native.metricControls[0];
  const next = { label: "like this video", text: "0", pressed: "false", html: '<button aria-label="like this video" aria-pressed="false"><span>0</span></button>' };
  native.metadataHtml = native.metadataHtml.replace(prior.html, next.html);
  native.metricControls = [next];
  f.row.metrics = { views: 1234, likes: 0 };
  assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), true);
  next.text = "Like";
  assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), false);
});

for (const label of ["1.2K views  Nov 11, 2026", "1,234 views  Nov 11", "1,234 views  Feb 30, 2026", "1,234 views  Jan 1, 2030", "1,,234 views  Nov 11, 2026"]) {
  test(`fully rebound native info still rejects an unsupported date/count: ${label}`, () => {
    const f = fixture(), native = f.receipt.nativeObservation, prior = native.nativeInfoHtml;
    native.nativeInfoHtml = `<div id="info-container">${label}</div>`;
    native.metadataHtml = native.metadataHtml.replace(prior, native.nativeInfoHtml);
    native.metadataText = native.metadataText.replace(native.nativeInfoText, label);
    native.nativeInfoText = label;
    assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), false);
  });
}

const semanticTampering = [
  ["watch ID mismatch", (f) => { f.receipt.nativeObservation.url = "https://www.youtube.com/watch?v=lmnopqrstuv"; }],
  ["native metadata ID mismatch", (f) => { f.receipt.nativeObservation.metadataHtml = f.receipt.nativeObservation.metadataHtml.replace('video-id="abcdefghijk"', 'video-id="lmnopqrstuv"'); }],
  ["post absent from exact owned channel listing", (f) => { f.receipt.channelObservation.links = []; }],
  ["unrelated channel", (f) => { f.receipt.channelObservation.url = "https://www.youtube.com/@another"; }],
  ["third-party primary owner", (f) => { f.receipt.nativeObservation.ownerLinks[0].href = "https://www.youtube.com/@another"; }],
  ["owner link detached from own parent DOM", (f) => { f.receipt.nativeObservation.ownerHtml = "<div id=\"owner\">Fixture Labs Inc.</div>"; }],
  ["owner only in description cannot replace native header", (f) => { f.receipt.nativeObservation.ownerLinks = []; }],
  ["official company conflict", (f) => { f.receipt.identityProof.companySlug = "unrelated"; }],
  ["third-party ownership host", (f) => { f.receipt.identityProof.homepage.finalUrl = "https://press.example/"; }],
  ["literal anchor differs", (f) => { f.receipt.identityProof.homepage.literalAnchorHtml = '<a href="https://www.youtube.com/@another">YouTube</a>'; }],
  ["unexpanded description", (f) => { f.receipt.nativeObservation.descriptionConfirmedExpanded = false; }],
  ["missing native expanded attribute", (f) => { f.receipt.nativeObservation.descriptionExpanderHtml = f.receipt.nativeObservation.descriptionExpanderHtml.replace(' is-expanded=""', ""); }],
  ["visible body suffix omitted", (f) => { f.receipt.nativeObservation.description = "Our full demo."; f.row.text = f.row.originalText = "Our full demo."; }],
  ["description detached from watch parent", (f) => { f.receipt.nativeObservation.metadataHtml = f.receipt.nativeObservation.metadataHtml.replace(f.receipt.nativeObservation.descriptionExpanderHtml, ""); }],
  ["wrong title", (f) => { f.receipt.nativeObservation.title = "Another title"; }],
  ["rounded views", (f) => { f.receipt.nativeObservation.nativeInfoText = "1.2K views  Nov 11, 2026"; }],
  ["date without year", (f) => { f.receipt.nativeObservation.nativeInfoText = "1,234 views  Nov 11"; }],
  ["invalid native day", (f) => { f.receipt.nativeObservation.nativeInfoText = "1,234 views  Feb 30, 2026"; }],
  ["conflicting Like count", (f) => { f.receipt.nativeObservation.metricControls[0].text = "70"; }],
  ["subscriber count cannot replace likes", (f) => { f.receipt.nativeObservation.metricControls[0].label = "7 subscribers"; }],
  ["duplicate own Like controls", (f) => { f.receipt.nativeObservation.metricControls.push(structuredClone(f.receipt.nativeObservation.metricControls[0])); }],
  ["service warning", (f) => { f.receipt.nativeObservation.alerts = ["Sign in to confirm you are not a bot"]; }],
  ["channel still loading", (f) => { f.receipt.channelObservation.loading = ["Loading"]; }],
  ["future collection clock", (f) => { f.receipt.channelObservation.observedAt = "2026-11-17T20:50:00.000Z"; }],
];
for (const [label, mutate] of semanticTampering) {
  test(`rehashed tampering is rejected: ${label}`, () => {
    const f = fixture(); mutate(f); const row = seal(f);
    assert.equal(isVerifiedNativeYouTubeDomReceipt(row, company), false);
    assert.ok(verifiedNativeYouTubeDomReasons(row, company).length > 0);
  });
}

for (const [label, mutate] of [
  ["fabricated midnight timestamp", (f) => { f.row.postedAt += "T00:00:00.000Z"; }],
  ["precision upgraded beyond native day", (f) => { f.row.publishedAtPrecision = "exact"; }],
  ["invented comments", (f) => { f.row.metrics = { ...f.row.metrics, comments: 0 }; }],
  ["body changed after receipt", (f) => { f.row.originalText += "changed"; }],
  ["hash validation missing", (f) => { f.validation.archiveHashesVerified = false; }],
  ["official website archive missing", (f) => { f.validation.archives = f.validation.archives.filter((a) => a.kind !== "official_website"); }],
  ["official website archive differs", (f) => { f.validation.archives.find((a) => a.kind === "official_website").sha256 = "d".repeat(64); }],
]) {
  test(`canonical/archive mismatch is rejected: ${label}`, () => {
    const f = fixture(); mutate(f); assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), false);
  });
}

test("unbound content tampering cannot survive the pinned receipt hash", () => {
  const f = fixture(), row = seal(f), raw = JSON.parse(row.rawVisibleText);
  raw.nativeYouTubeDomReceipt.nativeObservation.description += " changed";
  row.rawVisibleText = JSON.stringify(raw);
  assert.ok(verifiedNativeYouTubeDomReasons(row, company).includes("youtube_ingestion_archive_validation_conflict"));
});

test("URL identities reject credentials, unrelated hosts and ambiguous query parameters", () => {
  for (const value of ["http://www.youtube.com/watch?v=abcdefghijk", "https://youtube.com.evil.example/watch?v=abcdefghijk", "https://user@www.youtube.com/watch?v=abcdefghijk", "https://www.youtube.com/watch?v=abcdefghijk&v=lmnopqrstuv", "https://www.youtube.com/watch?v=abcdefghijk#x"]) assert.equal(nativeYouTubeVideoId(value), null);
  assert.equal(nativeYouTubeChannelIdentity("https://www.youtube.com/@fixturelabs?x=1"), null);
  assert.equal(nativeYouTubeChannelIdentity("https://www.youtube.com/@fixturelabs/shorts").handle, "fixturelabs");
});

function shortParents(native) {
  native.channelHeaderHtml = `<ytd-video-description-header-renderer>${native.channelLinks[0].html}<span>Fixture Labs Inc.</span>${native.nativeFactoids.map((fact) => fact.html).join("")}</ytd-video-description-header-renderer>`;
  native.descriptionExpanderHtml = `<ytd-text-inline-expander id="inline-expander">${native.descriptionHtml}</ytd-text-inline-expander>`;
  native.descriptionPanelHtml = `<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-structured-description" visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED">${native.channelHeaderHtml}${native.descriptionExpanderHtml}</ytd-engagement-panel-section-list-renderer>`;
  const binding = native.nativeShortIdentityBinding;
  binding.rendererHtml = `${binding.rendererOpeningTag}${binding.rendererPlayerTitleLinks.map((link) => link.html).join("")}${binding.rendererChannelLinks.map((link) => link.html).join("")}</ytd-reel-video-renderer>`;
  binding.rootHtml = `<ytd-shorts role="main">${binding.rendererHtml}${native.descriptionPanelHtml}</ytd-shorts>`;
}
function shortFixture() {
  const f = fixture(), url = "https://www.youtube.com/shorts/abcdefghijk";
  const body = "A full native Short.\r\n\r\n#FullCaption #Evidence";
  const playerTitle = { href: url, text: "A full native Short.", html: `<a class="ytp-title-link" href="${url}">A full native Short.</a>` };
  const rendererOwner = { href: "https://www.youtube.com/@fixturelabs/shorts", text: "@fixturelabs", html: '<a href="/@fixturelabs/shorts">@fixturelabs</a>' };
  const fact = (label, text, htmlText) => ({ label, text, html: `<div role="text" aria-label="${label}">${htmlText}</div>` });
  const native = { source: "native_youtube_short_description_dom_v1", url, title: "\n", description: body, descriptionHtml: `<yt-formatted-string id="formatted-snippet-text">${body}</yt-formatted-string>`, descriptionPanelText: `Fixture Labs Inc.\n${body}`, channelHeaderText: "Fixture Labs Inc.\n28\nLikes\n1.3K\nViews", channelLinks: [{ href: "https://www.youtube.com/@fixturelabs", text: "", html: '<a href="/@fixturelabs"><img alt="Fixture Labs Inc."></a>' }], shortChannelLinks: [rendererOwner], fullDescriptionReceipt: { textVisible: true, ellipsisVisible: false, expandButtonVisible: false, isExpanded: false, snippetClientHeight: 80, snippetScrollHeight: 80 }, nativeFactoids: [fact("28 likes", "28\nLikes", "<span>28</span><span>Likes</span>"), fact("1,312 views", "1.3K\nViews", "<span>1.3K</span><span>Views</span>"), fact("Oct 31, 2026", "Oct 31\n2026", "<span>Oct 31</span><span>2026</span>")], nativeShortText: "@fixturelabs\nSubscribe\nA full native Short.", observedAt: "2026-11-16T20:51:00.000Z", alerts: [], nativeShortIdentityBinding: { url, rendererCount: 1, rendererOpeningTag: '<ytd-reel-video-renderer id="reel-video-renderer">', rendererPlayerTitleLinks: [playerTitle], rendererChannelLinks: [rendererOwner] } };
  shortParents(native);
  f.receipt.mechanism = NATIVE_YOUTUBE_SHORT_DOM_SOURCE;
  f.receipt.nativeObservation = native;
  f.receipt.channelObservation.tabs = [{ text: "Shorts", ariaSelected: "true" }];
  f.receipt.channelObservation.links[0] = { href: url, text: "A full native Short.", html: '<a href="/shorts/abcdefghijk">A full native Short.</a>' };
  f.receipt.channelObservation.mainHtml = `<ytd-browse><ytd-tabbed-page-header><h1>Fixture Labs Inc.</h1><span>@fixturelabs</span></ytd-tabbed-page-header>${f.receipt.channelObservation.links[0].html}</ytd-browse>`;
  const summary = nativeYouTubeDomSummary(f.receipt, company);
  assert.deepEqual(summary.reasons, []);
  Object.assign(f.row, { sourceUrl: url, title: summary.title, text: body, originalText: body, postedAt: summary.publishedDay, metrics: summary.metrics, attributionProvenance: NATIVE_YOUTUBE_SHORT_DOM_SOURCE });
  f.validation.source = NATIVE_YOUTUBE_SHORT_DOM_VALIDATION;
  f.validation.archives[0].kind = "native_short";
  return f;
}

test("Shorts mode preserves CRLF full captions, exact aria counters and day-only dates", () => {
  const f = shortFixture(), summary = nativeYouTubeDomSummary(f.receipt, company);
  assert.equal(nativeYouTubeDomSource(f.receipt.nativeObservation), NATIVE_YOUTUBE_SHORT_DOM_SOURCE);
  assert.equal(nativeYouTubeDomValidation(f.receipt.nativeObservation), NATIVE_YOUTUBE_SHORT_DOM_VALIDATION);
  assert.equal(isNativeYouTubeDomProvenance(NATIVE_YOUTUBE_SHORT_DOM_SOURCE), true);
  assert.equal(nativeYouTubePostId(summary.sourceUrl), "abcdefghijk");
  assert.equal(summary.text, "A full native Short.\r\n\r\n#FullCaption #Evidence");
  assert.deepEqual(summary.metrics, { views: 1312, likes: 28 });
  assert.equal(summary.publishedDay, "2026-10-31");
  assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), true);
});

test("Shorts accepts explicit native No likes/0 Likes while missing counters remain unknown", () => {
  const f = shortFixture(), native = f.receipt.nativeObservation, fact = native.nativeFactoids[0];
  fact.label = "No likes"; fact.text = "0\nLikes"; fact.html = '<div role="text" aria-label="No likes"><span>0</span><span>Likes</span></div>';
  shortParents(native); f.row.metrics = { views: 1312, likes: 0 };
  assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), true);
  native.nativeFactoids.shift(); shortParents(native);
  assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), false);
});

for (const [label, mutate, reparent = true] of [
  ["missing native ID binding", (n) => { delete n.nativeShortIdentityBinding; }, false],
  ["wrong renderer player title permalink", (n) => { n.nativeShortIdentityBinding.rendererPlayerTitleLinks[0].href = "https://www.youtube.com/shorts/lmnopqrstuv"; }],
  ["more than one active renderer", (n) => { n.nativeShortIdentityBinding.rendererCount = 2; }],
  ["third-party renderer channel", (n) => { n.nativeShortIdentityBinding.rendererChannelLinks[0] = { href: "https://www.youtube.com/@another/shorts", text: "@another", html: '<a href="/@another/shorts">@another</a>' }; }],
  ["third-party panel channel", (n) => { n.channelLinks[0].href = "https://www.youtube.com/@another"; }],
  ["clipped description", (n) => { n.fullDescriptionReceipt.snippetScrollHeight = 160; }],
  ["visible description ellipsis", (n) => { n.fullDescriptionReceipt.ellipsisVisible = true; }],
  ["visible More description control", (n) => { n.fullDescriptionReceipt.expandButtonVisible = true; }],
  ["description not visible", (n) => { n.fullDescriptionReceipt.textVisible = false; }],
  ["fabricated shortened body", (n) => { n.description = "A full native Short."; }],
  ["global stale Description panel", (n) => { n.nativeShortIdentityBinding.rootHtml = n.nativeShortIdentityBinding.rootHtml.replace(n.descriptionPanelHtml, ""); }, false],
  ["rounded aria views", (n) => { const fact = n.nativeFactoids[1]; fact.label = "1.3K views"; fact.html = '<div role="text" aria-label="1.3K views"><span>1.3K</span><span>Views</span></div>'; }],
  ["no native date factoid", (n) => { n.nativeFactoids.pop(); }],
  ["duplicate native Like factoids", (n) => { n.nativeFactoids.push(structuredClone(n.nativeFactoids[0])); }],
]) {
  test(`Shorts rejects fully rehashed unsafe proof: ${label}`, () => {
    const f = shortFixture(); mutate(f.receipt.nativeObservation);
    if (reparent) shortParents(f.receipt.nativeObservation);
    assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), false);
  });
}

function variantFixture({ derived = false, attributed = false, recorded = true } = {}) {
  const f = shortFixture(), native = f.receipt.nativeObservation, body = native.description;
  const oldExpander = native.descriptionExpanderHtml;
  const plainHtml = `<span id="plain-snippet-text">${attributed ? "" : body}</span>`;
  const attributedHtml = `<yt-attributed-string id="attributed-snippet-text">${attributed ? body : ""}</yt-attributed-string>`;
  const formattedHtml = '<yt-formatted-string id="formatted-snippet-text" hidden="" is-empty=""></yt-formatted-string>';
  const selectedId = attributed ? "attributed-snippet-text" : "plain-snippet-text", selectedTag = attributed ? "YT-ATTRIBUTED-STRING" : "SPAN", selectedHtml = attributed ? attributedHtml : plainHtml;
  native.descriptionExpanderHtml = `<ytd-text-inline-expander id="inline-expander"><div id="snippet">${plainHtml}${attributedHtml}${formattedHtml}<span id="ellipsis" hidden="">…</span><button id="expand" hidden="">...more</button></div></ytd-text-inline-expander>`;
  native.descriptionPanelHtml = native.descriptionPanelHtml.replace(oldExpander, native.descriptionExpanderHtml);
  native.nativeShortIdentityBinding.rootHtml = native.nativeShortIdentityBinding.rootHtml.replace(oldExpander, native.descriptionExpanderHtml);
  native.descriptionHtml = derived ? formattedHtml : selectedHtml;
  native.description = derived ? "" : body;
  native.fullDescriptionReceipt.textVisible = !derived;
  if (recorded) native.nativeDescriptionVariantReceipt = {
    url: native.url, visibleNonemptyCount: 1, selectedId, selectedTag, selectedText: body,
    variants: [
      { id: "plain-snippet-text", tag: "SPAN", html: plainHtml, text: attributed ? "" : body, hidden: false, visible: !attributed, rect: { height: 80, width: attributed ? 0 : 300 } },
      { id: "attributed-snippet-text", tag: "YT-ATTRIBUTED-STRING", html: attributedHtml, text: attributed ? body : "", hidden: false, visible: attributed, rect: { height: 80, width: attributed ? 300 : 0 } },
      { id: "formatted-snippet-text", tag: "YT-FORMATTED-STRING", html: formattedHtml, text: "", hidden: true, visible: false, rect: { height: 0, width: 0 } },
    ],
  };
  const result = nativeYouTubeShortDescription(native);
  assert.equal(result.ok, true);
  f.receipt.descriptionNormalization = result.normalization;
  return f;
}

for (const options of [{}, { attributed: true }, { derived: true, recorded: false }]) {
  test(`native description variant preserves full caption and immutable raw data: ${JSON.stringify(options)}`, () => {
    const f = variantFixture(options), native = f.receipt.nativeObservation, rawBefore = JSON.stringify(native);
    const summary = nativeYouTubeDomSummary(f.receipt, company);
    assert.equal(summary.ok, true);
    assert.equal(summary.text, f.row.text);
    assert.equal(summary.descriptionNormalization.derivedFromEmptyCollectorField, options.derived === true);
    assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), true);
    assert.equal(JSON.stringify(native), rawBefore);
    delete f.receipt.descriptionNormalization;
    assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), false);
  });
}

for (const [label, mutate] of [
  ["missing native visible variant", (n) => { n.nativeDescriptionVariantReceipt.variants[0].visible = false; }],
  ["zero-width chosen variant", (n) => { n.nativeDescriptionVariantReceipt.variants[0].rect.width = 0; }],
  ["selected variant mismatch", (n) => { n.nativeDescriptionVariantReceipt.selectedId = "formatted-snippet-text"; }],
  ["unbound selected HTML", (n) => { n.nativeDescriptionVariantReceipt.variants[0].html += "altered"; }],
  ["collector nonempty mismatch", (n) => { n.description = "Other caption"; }],
  ["truncated native snippet", (n) => { n.fullDescriptionReceipt.snippetScrollHeight = 160; }],
  ["missing exact panel caption", (n) => { n.descriptionPanelText = "Fixture Labs Inc."; }],
]) {
  test(`visible variant gate rejects semantic tampering: ${label}`, () => {
    const f = variantFixture(); mutate(f.receipt.nativeObservation);
    assert.equal(nativeYouTubeShortDescription(f.receipt.nativeObservation).ok, false);
    assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), false);
  });
}

test("empty-field recovery rejects two nonhidden caption variants or a hidden actual caption", () => {
  for (const mutation of [
    (html) => html.replace('<yt-attributed-string id="attributed-snippet-text"></yt-attributed-string>', '<yt-attributed-string id="attributed-snippet-text">Another caption</yt-attributed-string>'),
    (html) => html.replace('<span id="plain-snippet-text">', '<span id="plain-snippet-text" hidden="">'),
    (html) => html.replace('<span id="plain-snippet-text">', '<span id="plain-snippet-text" style="display:none">'),
    (html) => html.replace('</ytd-text-inline-expander>', '<span id="plain-snippet-text">Other</span></ytd-text-inline-expander>'),
  ]) {
    const f = variantFixture({ derived: true, recorded: false }), native = f.receipt.nativeObservation;
    const previous = native.descriptionExpanderHtml;
    native.descriptionExpanderHtml = mutation(previous);
    native.descriptionPanelHtml = native.descriptionPanelHtml.replace(previous, native.descriptionExpanderHtml);
    native.nativeShortIdentityBinding.rootHtml = native.nativeShortIdentityBinding.rootHtml.replace(previous, native.descriptionExpanderHtml);
    assert.equal(nativeYouTubeShortDescription(native).ok, false);
    assert.equal(isVerifiedNativeYouTubeDomReceipt(seal(f), company), false);
  }
});
