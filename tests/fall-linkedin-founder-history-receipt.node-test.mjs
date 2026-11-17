import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NATIVE_LINKEDIN_FOUNDER_HISTORY_PROVENANCE, NATIVE_LINKEDIN_FOUNDER_HISTORY_VALIDATION, nativeLinkedInFounderCaption, nativeLinkedInFounderCardSummary, verifiedNativeLinkedInFounderHistoryReasons, isVerifiedNativeLinkedInFounderHistoryReceipt } from "../src/lib/graph/linkedin-founder-history-receipt.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const profile = "https://www.linkedin.com/in/jay-flaherty-53b3b659/", url = "https://www.linkedin.com/feed/update/urn:li:activity:7527023968877182976/";
const entity = { entityId: "founder-gatherhq-jay-flaherty-1823180", companySlug: "gatherhq", companyName: "GatherHQ", founderName: "Jay Flaherty", socialAccounts: { linkedin: profile } };
function fixture() {
  const moreHtml = '<button aria-hidden="true" data-testid="expandable-text-button"><span>… more</span></button>';
  const captionHtml = `<span data-testid="expandable-text-box">Exact body &amp; buyer.<br><br>Second paragraph.${moreHtml}</span>`;
  const caption = { text: "Exact body & buyer.\n\nSecond paragraph.\n… more", captionNodeHtml: captionHtml, href: url, html: `<a href="${url}">${captionHtml}</a>`, remainingSeeMoreControls: [{ text: "… more", ariaHidden: "true", html: moreHtml }] };
  const actor = { href: profile, text: "Jay Flaherty\n • 3rd+", html: `<a href="${profile}">Jay Flaherty • 3rd+</a>` };
  const menuLabel = "Open control menu for post by Jay Flaherty", menuHtml = `<button aria-label="${menuLabel}"></button>`;
  const controls = [{ tag: "BUTTON", ariaLabel: "Reaction button state: no reaction", text: "1,234", href: null, html: '<button aria-label="Reaction button state: no reaction"><span>1,234</span></button>' }, { tag: "A", ariaLabel: "Comment", text: "0", href: url, html: `<a aria-label="Comment" href="${url}">0</a>` }, { tag: "BUTTON", ariaLabel: "Repost", text: "2", href: null, html: '<button aria-label="Repost">2</button>' }];
  const card = { menuLabel, menuHtml, captionNodes: [caption], links: [actor], controls, timeNodes: [], ownCardHtml: `<div>${actor.html}${menuHtml}${caption.html}${controls.map((control) => control.html).join("")}</div>` };
  return { mechanism: "native_linkedin_founder_activity_card_v1", companySlug: "gatherhq", founderId: "1823180", founderName: "Jay Flaherty", profileUrl: profile, observedAt: "2026-11-16T19:00:00.000Z", card };
}
function rowFor(receipt = fixture()) {
  const summary = nativeLinkedInFounderCardSummary(receipt, entity);
  const raw = { source: "authorized_linkedin_browser_dom_v1", observedAt: "2026-11-16T19:00:01.000Z", post: { id: summary.platformPostId, url: summary.sourceUrl, text: summary.text, bodyTruncated: false, publishedAt: null, metrics: summary.metrics, nativeFounderHistoryReceipt: receipt }, validation: { source: NATIVE_LINKEDIN_FOUNDER_HISTORY_VALIDATION, archiveHashesVerified: true, nativeCardSha256: hash(receipt.card), nativeFounderHistoryReceiptSha256: hash(receipt) } };
  return { batchSlug: "F26", platform: "linkedin", entityType: "founder", entityId: entity.entityId, companyName: entity.companyName, authorName: entity.founderName, sourceUrl: summary.sourceUrl, accountUrl: profile, platformPostId: summary.platformPostId, text: summary.text, originalText: summary.text, postedAt: null, publishedAtPrecision: "unknown", metrics: summary.metrics, review_state: "verified", attributionVersion: 3, attributionStatus: "verified", attributionMode: "author", attributionProvenance: NATIVE_LINKEDIN_FOUNDER_HISTORY_PROVENANCE, rawVisibleText: JSON.stringify(raw) };
}
function mutate(change, rehash = true) {
  const row = rowFor(), raw = JSON.parse(row.rawVisibleText);
  change(row, raw);
  if (rehash) { raw.validation.nativeCardSha256 = hash(raw.post.nativeFounderHistoryReceipt.card); raw.validation.nativeFounderHistoryReceiptSha256 = hash(raw.post.nativeFounderHistoryReceipt); }
  row.rawVisibleText = JSON.stringify(raw);
  return row;
}

test("known founder own carousel caption/outer ID/footer counters verify; dates remain null", () => {
  assert.deepEqual(verifiedNativeLinkedInFounderHistoryReasons(rowFor(), entity), []);
  const summary = nativeLinkedInFounderCardSummary(fixture(), entity);
  assert.equal(summary.text, "Exact body & buyer.\n\nSecond paragraph.");
  assert.deepEqual(summary.metrics, { reactions: 1234, comments: 0, reposts: 2 });
  assert.equal(summary.postedAt, null);
});
test("only exact captured hidden expandable UI is removed, preserving original body", () => {
  const node = fixture().card.captionNodes[0];
  assert.equal(nativeLinkedInFounderCaption(node).ok, true);
  for (const change of [(n) => { n.remainingSeeMoreControls[0].html = '<button>… more</button>'; }, (n) => { n.text += " altered"; }, (n) => { n.remainingSeeMoreControls = []; }, (n) => { n.captionNodeHtml = n.captionNodeHtml.replace('aria-hidden="true"', 'aria-hidden="false"'); }]) { const copy = clone(node); change(copy); assert.equal(nativeLinkedInFounderCaption(copy).ok, false); }
});
test("reposted author menu, forged founder profile and actor appearing only in body fail", () => {
  for (const change of [(_, raw) => { raw.post.nativeFounderHistoryReceipt.profileUrl = "https://www.linkedin.com/in/other/"; }, (_, raw) => { raw.post.nativeFounderHistoryReceipt.card.menuLabel = "Open control menu for post by Other"; }, (_, raw) => { const card = raw.post.nativeFounderHistoryReceipt.card, actor = card.links[0]; card.ownCardHtml = card.ownCardHtml.replace(actor.html, "").replace("</div>", `${actor.html}</div>`); }]) assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(mutate(change), entity), false);
});
test("opaque feed keys, nested quote hrefs and missing own first-caption IDs are held", () => {
  for (const href of [null, "https://www.linkedin.com/feed/update/urn:li:ugcPost:7527023967904247808/", "update-card-focusOpaqueKey"]) assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(mutate((_, raw) => { raw.post.nativeFounderHistoryReceipt.card.captionNodes[0].href = href; }), entity), false);
  assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(mutate((row) => { row.platformPostId = "7527023967904247808"; }), entity), false);
});
test("nested quote caption is separate from first own body; quote counters stay unknown", () => {
  const receipt = fixture(), card = receipt.card;
  const quote = { captionNodeHtml: "<span>Quoted author body.</span>", html: "<div><span>Quoted author body.</span></div>", text: "Quoted author body.", remainingSeeMoreControls: [] };
  card.captionNodes.push(quote);
  card.ownCardHtml = card.ownCardHtml.replace(card.controls[0].html, `${card.controls[0].html}${quote.html}`);
  const result = nativeLinkedInFounderCardSummary(receipt, entity);
  assert.equal(result.ok, true);
  assert.equal(result.text, "Exact body & buyer.\n\nSecond paragraph.");
  assert.deepEqual(result.metrics, { comments: 0, reposts: 2 });
});
test("foreign Comment IDs, ambiguous counters and unlabeled buttons remain unknown", () => {
  const receipt = fixture(), card = receipt.card;
  const duplicate = clone(card.controls[0]); card.controls.push(duplicate); card.ownCardHtml = card.ownCardHtml.replace("</div>", `${duplicate.html}</div>`);
  card.controls[1].href = "https://www.linkedin.com/feed/update/urn:li:activity:111/";
  card.controls[2].text = "2K";
  assert.deepEqual(nativeLinkedInFounderCardSummary(receipt, entity).metrics, {});
});
test("invented body/counters, changed owner and stale receipt hashes fail", () => {
  for (const change of [(row) => { row.metrics.reactions = 9; }, (row) => { row.text += " invented"; }, (row) => { row.entityId = "founder-other"; }]) assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(mutate(change), entity), false);
  assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(mutate((_, raw) => { raw.validation.nativeCardSha256 = "a".repeat(64); }, false), entity), false);
  assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(mutate((_, raw) => { raw.post.nativeFounderHistoryReceipt.card.ownCardHtml += "changed"; }, false), entity), false);
});
test("relative dates are never inferred and invalid or future observation ordering fails", () => {
  for (const change of [(row) => { row.postedAt = "2026-11-14T00:00:00.000Z"; }, (_, raw) => { raw.observedAt = "2026-11-16T18:59:00.000Z"; }, (_, raw) => { raw.post.nativeFounderHistoryReceipt.observedAt = "2026-02-30T00:00:00.000Z"; }, (_, raw) => { raw.post.nativeFounderHistoryReceipt.card.timeNodes = [{ datetime: "2026-11-14" }]; }]) assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(mutate(change), entity), false);
});
function embedFixture() {
  const receipt = fixture(), card = receipt.card, old = card.captionNodes[0];
  card.componentKey = "opaque-source-card-key-never-used-as-post-id";
  card.captionNodes[0] = { html: old.captionNodeHtml, outerHref: null, text: old.text, remainingSeeMoreControls: old.remainingSeeMoreControls };
  card.ownCardHtml = card.ownCardHtml.replace(old.html, old.captionNodeHtml);
  const actor = card.links[0];
  card.authorHeader = { html: `<header>${actor.html}</header>`, links: [{ href: actor.href, text: actor.text }] };
  card.ownCardHtml = card.ownCardHtml.replace(actor.html, card.authorHeader.html);
  card.links = card.links.map((link) => { const copy = { ...link }; delete copy.html; return copy; });
  card.controls = card.controls.map((control) => { const copy = { ...control }; delete copy.tag; return copy; });
  const actorHref = `${profile.replace(/\/$/, "")}?trk=public_post_embed_feed-actor-name`;
  const paragraph = { text: "Exact body & buyer.\n\nSecond paragraph.", html: '<p data-test-id="main-feed-activity-embed-card__commentary">Exact body &amp; buyer.\n\nSecond paragraph.</p>' };
  const preview = { activityUrn: "urn:li:activity:7527023968877182976", observedAt: receipt.observedAt, paragraphs: [paragraph], links: [{ href: actorHref, text: "Jay Flaherty " }], timeNodes: [{ datetime: null, text: "2w" }], html: `<article data-activity-urn="urn:li:activity:7527023968877182976"><a href="${actorHref}" data-tracking-control-name="public_post_embed_feed-actor-name">Jay Flaherty</a>${paragraph.html}</article>` };
  receipt.detailProof = { mechanism: "native_linkedin_founder_embed_article_v1", nativeReceipt: { sourceCardKey: card.componentKey, sourceCardMenuLabel: card.menuLabel, sourceCaption: clone(card.captionNodes[0]), observedAt: receipt.observedAt, collectionMethod: "native_exact_founder_card_embed_article_v1", preview } };
  return receipt;
}
test("full-feed exact native Embed binds activity article, primary author and full own caption", () => {
  const receipt = embedFixture(), summary = nativeLinkedInFounderCardSummary(receipt, entity);
  assert.deepEqual(summary.reasons, []);
  assert.deepEqual(summary.metrics, { reactions: 1234, comments: 0, reposts: 2 });
  assert.equal(summary.platformPostId, "7527023968877182976");
  assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(rowFor(receipt), entity), true);
});
test("opaque key, UGC iframe ID, changed body/actor and mismatched source caption cannot replace native article proof", () => {
  for (const change of [(receipt) => { receipt.detailProof.nativeReceipt.sourceCardKey = "other"; }, (receipt) => { receipt.detailProof.nativeReceipt.preview.activityUrn = "urn:li:ugcPost:7527023967904247808"; }, (receipt) => { receipt.detailProof.nativeReceipt.preview.paragraphs[0].text += " changed"; }, (receipt) => { receipt.detailProof.nativeReceipt.sourceCaption.text += " changed"; }, (receipt) => { receipt.detailProof.nativeReceipt.preview.links[0].href = "https://www.linkedin.com/in/other?trk=public_post_embed_feed-actor-name"; }]) { const receipt = embedFixture(); change(receipt); assert.equal(nativeLinkedInFounderCardSummary(receipt, entity).ok, false); }
});
test("native outer quoted-post commentary verifies separately from the nested quoted author/body", () => {
  const receipt = embedFixture(), preview = receipt.detailProof.nativeReceipt.preview;
  const own = preview.paragraphs[0];
  const wrapper = { ...own, html: own.html.replace("main-feed-activity-embed-card__commentary", "feed-reshare-content__commentary") };
  const quote = { text: "Other author's quoted body.", html: '<p data-test-id="main-feed-activity-embed-card__commentary">Other author\'s quoted body.</p>' };
  preview.html = preview.html.replace(own.html, `${wrapper.html}<a href="https://www.linkedin.com/in/other?trk=public_post_embed_reshare-actor-name" data-tracking-control-name="public_post_embed_reshare-actor-name">Other</a>${quote.html}`);
  preview.paragraphs = [quote, wrapper];
  assert.equal(nativeLinkedInFounderCardSummary(receipt, entity).ok, true);
  wrapper.text = quote.text;
  assert.equal(nativeLinkedInFounderCardSummary(receipt, entity).ok, false);
});
function ugcFixture() {
  const receipt = embedFixture(), card = receipt.card;
  const sourceUrl = "https://www.linkedin.com/posts/jay-flaherty-53b3b659_native-post-ugcPost-6765693790826180608-gyCH/?utm_source=share&utm_medium=member_desktop&rcm=exact-native-tracking";
  const caption = { html: '<span data-testid="expandable-text-box">Exact body &amp; buyer.<br><br>Second paragraph.</span>', text: "Exact body & buyer.\n\nSecond paragraph.", remainingSeeMoreControls: [] };
  const controls = [{ ariaLabel: card.menuLabel, html: card.menuHtml, text: "" }, { ariaLabel: "Reaction button state: no reaction", html: '<button aria-label="Reaction button state: no reaction">49</button>', text: "49" }, { ariaLabel: "Comment", html: '<button aria-label="Comment">7</button>', text: "7" }, { ariaLabel: "Repost", html: '<button aria-label="Repost">4</button>', text: "4" }];
  const detail = { nativeObjectType: "ugcPost", nativePostId: "6765693790826180608", url: sourceUrl, observedAt: receipt.observedAt, menuLabel: card.menuLabel, authorHeader: card.authorHeader, captionNodes: [caption], controls, timeNodes: [], nativeCommentUrnReferences: ["replaceableComment_urn:li:comment:(ugcPost:6765693790826180608,6765716628731764736)"], html: `<div>${card.authorHeader.html}${controls[0].html}${caption.html}${controls.slice(1).map((control) => control.html).join("")}</div>` };
  receipt.detailProof = { mechanism: "native_linkedin_founder_copy_link_ugc_detail_v1", nativeReceipt: { sourceCardKey: card.componentKey, sourceCardMenuLabel: card.menuLabel, sourceCaption: clone(card.captionNodes[0]), copiedUrl: "https://lnkd.in/p/dwqruBfJ", resolvedUrl: sourceUrl, observedAt: receipt.observedAt, collectionMethod: "native_exact_founder_card_copy_link_native_detail_v1", detail } };
  return receipt;
}
test("native Copy-link UGC fallback preserves actual namespace and URL, with scoped detail counters", () => {
  const receipt = ugcFixture(), summary = nativeLinkedInFounderCardSummary(receipt, entity);
  assert.deepEqual(summary.reasons, []);
  assert.equal(summary.platformPostId, "ugcPost:6765693790826180608");
  assert.equal(summary.sourceUrl, receipt.detailProof.nativeReceipt.resolvedUrl);
  assert.deepEqual(summary.metrics, { reactions: 49, reposts: 4 });
  receipt.detailProof.nativeReceipt.detail.nativeCommentUrnReferences.push("translatable-commentary-FeTranslationUrn(commentUrn=CommentUrn(commentId=111, thread=urn:li:ugcPost:6765693790826180608))");
  assert.equal(nativeLinkedInFounderCardSummary(receipt, entity).ok, true);
  const row = rowFor(receipt);
  assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(row, entity), true);
  row.sourceUrl = summary.sourceUrl.replace(/utm_source=share&utm_medium=member_desktop&/, "");
  assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(row, entity), true);
  row.sourceUrl = row.sourceUrl.replace("rcm=exact-native-tracking", "rcm=changed");
  assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(row, entity), false);
});
test("UGC fallback rejects missing native URNs, mismatched namespace/owner/body and inferred activity IDs", () => {
  for (const change of [(receipt) => { receipt.detailProof.nativeReceipt.detail.nativeObjectType = "activity"; }, (receipt) => { receipt.detailProof.nativeReceipt.detail.nativePostId = "111"; }, (receipt) => { receipt.detailProof.nativeReceipt.detail.nativeCommentUrnReferences = []; }, (receipt) => { receipt.detailProof.nativeReceipt.detail.nativeCommentUrnReferences = ["urn:li:comment:(activity:6765693790826180608,111)"]; }, (receipt) => { receipt.detailProof.nativeReceipt.copiedUrl = "https://other.test/p/dwqruBfJ"; }, (receipt) => { receipt.detailProof.nativeReceipt.detail.captionNodes[0].text += " changed"; }, (receipt) => { receipt.detailProof.nativeReceipt.detail.authorHeader.links = []; }]) { const receipt = ugcFixture(); change(receipt); assert.equal(nativeLinkedInFounderCardSummary(receipt, entity).ok, false); }
  const receipt = ugcFixture(), row = rowFor(receipt);
  row.platformPostId = "6765693790826180608";
  assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(row, entity), false);
  const canonicalKeyOnly = rowFor(receipt); canonicalKeyOnly.sourceUrl = "https://linkedin.com/feed/update/urn:li:ugcPost:6765693790826180608";
  assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(canonicalKeyOnly, entity), false);
});

function shareActivityFixture() {
  const receipt = ugcFixture(), native = receipt.detailProof.nativeReceipt, detail = native.detail;
  receipt.detailProof.mechanism = "native_linkedin_founder_copy_link_share_activity_detail_v1";
  native.resolvedUrl = "https://www.linkedin.com/posts/jay-flaherty-53b3b659_native-story-share-6887178180399132672-jmyw/?utm_source=share&rcm=exact-native-tracking";
  detail.url = native.resolvedUrl;
  detail.nativeObjectType = null;
  detail.nativePostId = null;
  detail.nativeCommentUrnReferences = [
    "replaceableComment_urn:li:comment:(activity:6887178180847898624,6888855452768079872)",
    "CommentComponentReference_urn:li:comment:(activity:6887178180847898624,6888855452768079872)",
    "comment-urn:li:comment:(activity:6887178180847898624,6888855452768079872)::9",
  ];
  return receipt;
}
test("actual share detail binds independent unanimous native activity URNs, never the share URL number", () => {
  const receipt = shareActivityFixture(), summary = nativeLinkedInFounderCardSummary(receipt, entity);
  assert.deepEqual(summary.reasons, []);
  assert.equal(summary.platformPostId, "6887178180847898624");
  assert.equal(summary.sourceUrl, "https://www.linkedin.com/feed/update/urn:li:activity:6887178180847898624/");
  assert.equal(receipt.detailProof.nativeReceipt.resolvedUrl.includes("share-6887178180399132672-"), true);
  assert.deepEqual(summary.metrics, { reactions: 49, reposts: 4 });
  assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(rowFor(receipt), entity), true);
});
test("share fallback fails closed for missing, mixed, wrong-namespace or nonnative comment references", () => {
  for (const change of [
    (native) => { native.detail.nativeCommentUrnReferences = []; },
    (native) => { native.detail.nativeCommentUrnReferences.push("replaceableComment_urn:li:comment:(activity:111,222)"); },
    (native) => { native.detail.nativeCommentUrnReferences = ["replaceableComment_urn:li:comment:(ugcPost:6887178180847898624,222)"]; },
    (native) => { native.detail.nativeCommentUrnReferences = ["plain body says urn:li:activity:6887178180847898624"]; },
    (native) => { native.detail.nativeCommentUrnReferences = ["replaceableComment_urn:li:comment:(activity:6887178180399132672,222)"]; },
    (native) => { native.detail.nativeObjectType = "share"; native.detail.nativePostId = "6887178180399132672"; },
    (native) => { native.resolvedUrl = native.resolvedUrl.replace("linkedin.com", "other.test"); native.detail.url = native.resolvedUrl; },
    (native) => { native.resolvedUrl = native.resolvedUrl.replace("-share-", "-ugcPost-"); native.detail.url = native.resolvedUrl; },
  ]) { const receipt = shareActivityFixture(); change(receipt.detailProof.nativeReceipt); assert.equal(nativeLinkedInFounderCardSummary(receipt, entity).ok, false); }
});
test("share detail preserves full frozen source body, primary actor, observed URLs and receipt hash", () => {
  for (const change of [
    (native) => { native.sourceCaption.text += " changed"; },
    (native) => { native.detail.captionNodes[0].text += " changed"; },
    (native) => { native.detail.authorHeader.links = []; },
    (native) => { native.sourceCardKey = "unrelated"; },
    (native) => { native.detail.url += "changed"; },
    (native) => { native.copiedUrl = "https://other.test/p/dwqruBfJ"; },
  ]) { const receipt = shareActivityFixture(); change(receipt.detailProof.nativeReceipt); assert.equal(nativeLinkedInFounderCardSummary(receipt, entity).ok, false); }
  const row = rowFor(shareActivityFixture()), raw = JSON.parse(row.rawVisibleText);
  raw.post.nativeFounderHistoryReceipt.detailProof.nativeReceipt.resolvedUrl += "changed";
  row.rawVisibleText = JSON.stringify(raw);
  assert.equal(isVerifiedNativeLinkedInFounderHistoryReceipt(row, entity), false);
});
