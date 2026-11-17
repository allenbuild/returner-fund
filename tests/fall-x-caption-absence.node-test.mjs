import assert from "node:assert/strict";
import test from "node:test";
import { isVerifiedNativeXCaptionlessPost, nativeXCaptionlessMetrics, nativeXCaptionlessPostReasons } from "../src/lib/graph/x-caption-absence-receipt.mjs";

function fixture() {
  const raw = {
    source: "authenticated_native_x_ui_v1", observedAt: "2026-11-16T17:00:00.000Z", exportedAt: "2026-11-16T17:02:00.000Z",
    post: { platformPostId: "2121676764695191921", authorHandle: "BeukersAndre", nativeDateLink: "https://x.com/BeukersAndre/status/2121676764695191921", publishedAt: "2026-11-16T16:00:00.000Z", text: "", bodyTruncated: false, ownTweetTextElementCount: 0, ownVisibleTextAbsent: true, ownNativeArticleLinks: [], ownMediaPermalinks: [{ href: "https://x.com/BeukersAndre/status/2121676764695191921/photo/1", nativePostId: "2121676764695191921", kind: "photo", mediaIndex: "1", visibleMediaUrls: ["https://pbs.twimg.com/media/NativeOriginal.jpg?format=jpg&name=large"] }] },
    renderedArticleTextIncludingQuotedContent: "Andre Beukers\n@BeukersAndre\n·\nNov 16\n17", metrics: { replies: 0, reposts: 0, likes: 4, views: 17 },
    metricObservations: [{ observedAt: "2026-11-16T17:00:00.000Z", nativeVisibleLabels: ["0 Replies. Reply", "0 reposts. Repost", "4 Likes. Like", "17 views. View post analytics", "Bookmark"], metrics: { replies: 0, reposts: 0, likes: 4, views: 17 } }]
  };
  return { platform: "x", platformPostId: raw.post.platformPostId, authorHandle: "BeukersAndre", accountUrl: "https://x.com/BeukersAndre", sourceUrl: raw.post.nativeDateLink, postedAt: raw.post.publishedAt, text: "", originalText: "", bodyTruncated: false, captionAbsent: true, contributionScore: 0, tractionStatus: "unscored", collectionObservedAt: raw.observedAt, metrics: raw.metrics, rawVisibleText: JSON.stringify(raw) };
}
function editRaw(row, edit) { const raw = JSON.parse(row.rawVisibleText); edit(raw); row.rawVisibleText = JSON.stringify(raw); return row; }

test("native captionless media retains observed positive counters without traction score", () => {
  const row = fixture();
  assert.equal(isVerifiedNativeXCaptionlessPost(row), true);
  assert.equal(row.metrics.likes, 4);
  assert.equal(row.contributionScore, 0);
  assert.deepEqual(nativeXCaptionlessPostReasons(row), []);
});

test("only exact outer author, immutable native ID and date link can qualify", () => {
  for (const change of [r => { r.authorHandle = "SomeoneElse"; }, r => { r.accountUrl = "https://x.com/SomeoneElse"; }, r => { r.platformPostId = "2121676764695191922"; }, r => { r.sourceUrl += "/photo/1"; }, r => editRaw(r, raw => { raw.post.authorHandle = "SomeoneElse"; }), r => editRaw(r, raw => { raw.post.nativeDateLink = "https://x.com/SomeoneElse/status/2121676764695191921"; })]) { const row = fixture(); change(row); assert.equal(isVerifiedNativeXCaptionlessPost(row), false); }
});

test("ambiguous older captures and visible, collapsed or invented captions fail closed", () => {
  for (const change of [r => { delete r.originalText; }, r => { r.text = "An invented image description"; }, r => { r.bodyTruncated = true; }, r => editRaw(r, raw => { delete raw.post.ownVisibleTextAbsent; }), r => editRaw(r, raw => { delete raw.post.ownTweetTextElementCount; }), r => editRaw(r, raw => { raw.post.ownTweetTextElementCount = 1; }), r => editRaw(r, raw => { raw.post.text = "Real native text"; }), r => editRaw(r, raw => { raw.post.bodyTruncated = true; })]) { const row = fixture(); change(row); assert.equal(isVerifiedNativeXCaptionlessPost(row), false); }
});

test("the independently rendered outer author header must match, even when URL fields agree", () => {
  const row = editRaw(fixture(), raw => { raw.renderedArticleTextIncludingQuotedContent = "Another author\n@SomeoneElse\n·\nNov16\n17"; });
  assert.equal(isVerifiedNativeXCaptionlessPost(row), false);
  assert.ok(nativeXCaptionlessPostReasons(row).includes("x_captionless_visible_outer_author_header_conflict"));
});

test("quoted media, cards, avatars, generic media and bare permalinks cannot prove own media", () => {
  for (const change of [raw => { raw.post.ownMediaPermalinks = []; }, raw => { raw.post.ownMediaPermalinks[0].href = "https://x.com/Other/status/2121676764695191922/photo/1"; }, raw => { raw.post.ownMediaPermalinks[0].nativePostId = "2121676764695191922"; }, raw => { raw.post.ownMediaPermalinks[0].visibleMediaUrls = []; }, raw => { raw.post.ownMediaPermalinks[0].visibleMediaUrls = ["https://pbs.twimg.com/profile_images/avatar.jpg"]; }, raw => { raw.post.ownMediaPermalinks[0].visibleMediaUrls = ["https://pbs.twimg.com/card_img/card.jpg"]; }, raw => { raw.post.ownMediaPermalinks[0].visibleMediaUrls = ["https://example.com/image.jpg"]; }, raw => { raw.post.isRepost = true; }]) assert.equal(isVerifiedNativeXCaptionlessPost(editRaw(fixture(), change)), false);
});

test("native Articles cannot be relabeled as empty-caption media", () => {
  assert.equal(isVerifiedNativeXCaptionlessPost(editRaw(fixture(), raw => { raw.post.ownNativeArticleLinks = [{ href: "https://x.com/i/article/123" }]; })), false);
  assert.equal(isVerifiedNativeXCaptionlessPost(editRaw(fixture(), raw => { raw.renderedArticleTextIncludingQuotedContent += "\n Article\nScaling to >10B tokens/day"; })), false);
  assert.equal(isVerifiedNativeXCaptionlessPost(editRaw(fixture(), raw => { delete raw.post.ownNativeArticleLinks; })), false);
});

test("actual own native video media may qualify, without using another post's video", () => {
  const row = editRaw(fixture(), raw => { const m = raw.post.ownMediaPermalinks[0]; m.href = m.href.replace("/photo/", "/video/"); m.kind = "video"; m.visibleMediaUrls = ["https://pbs.twimg.com/amplify_video_thumb/123/img/native.jpg"]; });
  assert.equal(isVerifiedNativeXCaptionlessPost(row), true);
  editRaw(row, raw => { raw.post.ownMediaPermalinks[0].href = raw.post.ownMediaPermalinks[0].href.replace("2121676764695191921", "2121676764695191922"); });
  assert.equal(isVerifiedNativeXCaptionlessPost(row), false);
});

test("publication clock follows each actual observation, including next-day posts", () => {
  assert.equal(isVerifiedNativeXCaptionlessPost(fixture()), true);
  const row = editRaw(fixture(), raw => { raw.post.publishedAt = "2026-11-16T18:00:00.000Z"; }); row.postedAt = "2026-11-16T18:00:00.000Z";
  assert.equal(isVerifiedNativeXCaptionlessPost(row), false);
  assert.equal(isVerifiedNativeXCaptionlessPost(editRaw(fixture(), raw => { raw.exportedAt = "2026-11-16T16:59:59.000Z"; })), false);
  const wrongClock = fixture(); wrongClock.postedAt = "2026-11-16T15:00:00.000Z"; assert.equal(isVerifiedNativeXCaptionlessPost(wrongClock), false);
  const invalidClock = editRaw(fixture(), raw => { raw.post.publishedAt = "2026-02-30T15:00:00.000Z"; }); invalidClock.postedAt = "2026-02-30T15:00:00.000Z"; assert.equal(isVerifiedNativeXCaptionlessPost(invalidClock), false);
});

test("positive counters must retain exact observed values, and cannot become invented zeros", () => {
  const zeroed = fixture(); zeroed.metrics = { replies: 0, reposts: 0, likes: 0, views: 0 }; assert.equal(isVerifiedNativeXCaptionlessPost(zeroed), false);
  const changed = editRaw(fixture(), raw => { raw.metrics.likes = 999; raw.metricObservations[0].metrics.likes = 999; }); changed.metrics.likes = 999; assert.equal(isVerifiedNativeXCaptionlessPost(changed), false);
  assert.equal(isVerifiedNativeXCaptionlessPost(editRaw(fixture(), raw => { raw.metricObservations[0].observedAt = "2026-11-16T18:00:00.000Z"; })), false);
  assert.deepEqual(nativeXCaptionlessMetrics(["1,234 views. View post analytics", "1.2K Likes. Like"]), { views: 1234 });
});

test("missing counters stay unknown and zero counters remain valid unscored metadata", () => {
  const unknown = editRaw(fixture(), raw => { raw.metrics = {}; raw.metricObservations = []; }); unknown.metrics = {}; assert.equal(isVerifiedNativeXCaptionlessPost(unknown), true);
  const zero = editRaw(fixture(), raw => { raw.metrics = { likes: 0 }; raw.metricObservations = [{ observedAt: raw.observedAt, nativeVisibleLabels: ["0 Likes. Like"], metrics: { likes: 0 } }]; }); zero.metrics = { likes: 0 }; assert.equal(isVerifiedNativeXCaptionlessPost(zero), true);
});

test("captionless media never acquires traction through metadata admission", () => {
  const scored = fixture(); scored.contributionScore = 1; assert.equal(isVerifiedNativeXCaptionlessPost(scored), false);
  const status = fixture(); status.tractionStatus = "eligible"; assert.equal(isVerifiedNativeXCaptionlessPost(status), false);
  assert.equal(isVerifiedNativeXCaptionlessPost({ platform: "linkedin", rawVisibleText: "not JSON" }), false);
});
