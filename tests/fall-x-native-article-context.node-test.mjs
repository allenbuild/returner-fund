import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NATIVE_X_ARTICLE_CONTEXT_PROVENANCE, NATIVE_X_ARTICLE_CONTEXT_VALIDATION, nativeXArticleContextReasons, isVerifiedNativeXArticleContext } from "../src/lib/graph/x-native-article-context-receipt.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex"), hash = (value) => sha(JSON.stringify(value));
const entity = { entityId: "founder-example-jane-42", companySlug: "example", companyName: "Example", founderName: "Jane Founder", socialAccounts: { x: "https://x.com/janefounder" } };
const url = "https://x.com/janefounder/status/1234567890123456789";
function fixture(legacy = false) {
  const headerAnchor = '<a href="/janefounder">Jane Founder</a>', header = { text: "Jane Founder\n@janefounder", html: `<div data-testid="User-Name">${headerAnchor}<span>@janefounder</span></div>`, links: [{ href: "https://x.com/janefounder", text: "Jane Founder", html: headerAnchor }] };
  const titleHtml = '<div data-testid="twitter-article-title">An exact native Article</div>', bodyHtml = '<div data-testid="twitterArticleRichTextView"><p>First &amp; original paragraph.</p><p>Second paragraph.</p></div>', view = `<div data-testid="twitterArticleReadView">${titleHtml}${bodyHtml}</div>`;
  const timeHtml = '<a href="/janefounder/status/1234567890123456789"><time datetime="2026-11-16T10:00:00.000Z">5:00 AM · Nov 16, 2026</time></a>';
  const body = "First & original paragraph.\nSecond paragraph.", observedAt = "2026-11-16T11:00:00.000Z", postedAt = "2026-11-16T10:00:00.000Z";
  const record = { source: "authorized_native_x_article_dom_v1", pageUrl: url, nativePostUrl: url, nativePublishedAt: postedAt, nativeTimeHtml: timeHtml, nativeAuthorHeader: header, title: "An exact native Article", titleHtml, body, bodyHtml, readViewHtml: view, nativeMainHtml: `<main>${header.html}${view}${timeHtml}</main>`, observedAt };
  if (legacy) { Object.assign(record, { mechanism: "native_x_article_read_view_v1", sourceUrl: url, outerNativePostId: "1234567890123456789", bodyText: body, primaryActorHeader: header, times: [{ href: url, datetime: postedAt, html: timeHtml }] }); delete record.source; }
  const outer = { platform: "x", platformPostId: "1234567890123456789", sourceUrl: url, accountUrl: "https://x.com/janefounder", postedAt, text: "Original short outer caption.", bodyTruncated: false, rawVisibleText: JSON.stringify({ source: "authenticated_native_x_ui_v1", post: { platformPostId: "1234567890123456789", authorHandle: "janefounder", text: "Original short outer caption.", bodyTruncated: false } }) };
  const raw = { source: "authorized_native_x_article_context_v1", nativeRecord: record, outerPost: outer, exportedAt: "2026-11-16T12:00:00.000Z", sourceArchivePath: "outputs/frozen-native.json", sourceArchiveSha256: "a".repeat(64), sourceRecordPointer: "/source/nativeArticleBodiesAfterControlReset/0", outerPostArchivePath: "outputs/frozen-outer.json", outerPostArchiveSha256: "b".repeat(64), validation: { source: NATIVE_X_ARTICLE_CONTEXT_VALIDATION, archiveHashesVerified: true, nativeArticleRecordSha256: hash(record), outerPostRecordSha256: hash(outer), nativeBodySha256: sha(body) } };
  return { batchSlug: "F26", platform: "x", entityType: "founder", entityId: entity.entityId, companySlug: "example", companyName: "Example", authorName: "Jane Founder", accountUrl: "https://x.com/janefounder", sourceUrl: url, nativeArticleUrl: url, outerNativePostId: "1234567890123456789", articleNativeId: null, contextObjectType: "native_x_article_body", contentKind: "native_x_article", outerPostText: outer.text, title: record.title, text: body, originalText: body, postedAt, observedAt, metrics: {}, contributionScore: 0, tractionStatus: "unscored", bodyTruncated: false, captionAbsent: false, attributionProvenance: NATIVE_X_ARTICLE_CONTEXT_PROVENANCE, rawVisibleText: JSON.stringify(raw) };
}
function change(fn, rehash = true) {
  const row = fixture(), raw = JSON.parse(row.rawVisibleText); fn(row, raw);
  if (rehash) Object.assign(raw.validation, { nativeArticleRecordSha256: hash(raw.nativeRecord), outerPostRecordSha256: hash(raw.outerPost), nativeBodySha256: sha(raw.nativeRecord.body) });
  row.rawVisibleText = JSON.stringify(raw); return row;
}
test("full Article body and native clock verify separately from its preserved outer caption", () => {
  for (const legacy of [false, true]) assert.deepEqual(nativeXArticleContextReasons(fixture(legacy), entity), []);
  assert.notEqual(fixture().text, fixture().outerPostText);
});
test("outer status IDs never become invented Article IDs or a replacement native post namespace", () => {
  for (const fn of [(r) => { r.platformPostId = r.outerNativePostId; }, (r) => { r.articleNativeId = r.outerNativePostId; }, (r) => { r.outerNativePostId = "111"; }, (r) => { r.nativeArticleUrl = "https://x.com/janefounder/article/1234567890123456789"; }, (r) => { r.sourceUrl = "https://x.com/janefounder/status/111"; }]) assert.equal(isVerifiedNativeXArticleContext(change(fn), entity), false);
});
test("body/title bytes and literal native HTML hierarchy are bound", () => {
  for (const fn of [(r) => { r.text += " invented"; }, (r, raw) => { raw.nativeRecord.body += " invented"; r.text = r.originalText = raw.nativeRecord.body; }, (_, raw) => { raw.nativeRecord.bodyHtml = "<div>Substituted body</div>"; }, (r) => { r.title += " changed"; }, (_, raw) => { raw.nativeRecord.nativeMainHtml = "<main>shell</main>"; }]) assert.equal(isVerifiedNativeXArticleContext(change(fn), entity), false);
});
test("known founder and primary native author cannot be replaced by a quoted or unrelated account", () => {
  for (const fn of [(r) => { r.entityId = "founder-other"; }, (r) => { r.accountUrl = "https://x.com/other"; }, (_, raw) => { raw.nativeRecord.nativeAuthorHeader.text = "Jane Founder\n@other"; }, (_, raw) => { raw.nativeRecord.nativeAuthorHeader.links = []; }]) assert.equal(isVerifiedNativeXArticleContext(change(fn), entity), false);
});
test("literal native full-name capitalization may differ from the same official roster name", () => {
  const row = fixture(); row.authorName = "JANE FOUNDER";
  assert.equal(isVerifiedNativeXArticleContext(row, { ...entity, founderName: "JANE FOUNDER" }), true);
  assert.equal(isVerifiedNativeXArticleContext(row, { ...entity, founderName: "JANE OTHER" }), false);
});
test("outer short captions stay immutable, including genuine empty outer text", () => {
  assert.equal(isVerifiedNativeXArticleContext(change((row, raw) => { row.outerPostText = raw.outerPost.text = ""; const receipt = JSON.parse(raw.outerPost.rawVisibleText); receipt.post.text = ""; raw.outerPost.rawVisibleText = JSON.stringify(receipt); }), entity), true);
  for (const fn of [(r) => { r.outerPostText += " changed"; }, (_, raw) => { raw.outerPost.text += " changed"; }, (_, raw) => { raw.outerPost.platformPostId = "111"; }, (_, raw) => { raw.outerPost.bodyTruncated = true; }]) assert.equal(isVerifiedNativeXArticleContext(change(fn), entity), false);
});
test("next-day native dates are allowed only before the actual observation/export clocks", () => {
  assert.equal(isVerifiedNativeXArticleContext(fixture(), entity), true);
  for (const fn of [(r) => { r.postedAt = "2026-11-16T13:00:00.000Z"; }, (_, raw) => { raw.nativeRecord.observedAt = "2026-11-16T09:59:59.000Z"; }, (_, raw) => { raw.exportedAt = "2026-11-16T10:59:59.000Z"; }, (_, raw) => { raw.nativeRecord.nativePublishedAt = "2026-02-30T00:00:00.000Z"; }]) assert.equal(isVerifiedNativeXArticleContext(change(fn), entity), false);
});
test("context has no engagement score and requires the physical archive validation receipt", () => {
  for (const fn of [(r) => { r.metrics = { likes: 3 }; }, (r) => { r.contributionScore = 1; }, (r) => { r.tractionStatus = "verified"; }, (_, raw) => { raw.validation.archiveHashesVerified = false; }, (_, raw) => { raw.sourceArchiveSha256 = "wrong"; }]) assert.equal(isVerifiedNativeXArticleContext(change(fn), entity), false);
  assert.equal(isVerifiedNativeXArticleContext(change((_, raw) => { raw.nativeRecord.body += " changed"; }, false), entity), false);
});
