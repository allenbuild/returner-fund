import assert from "node:assert/strict";
import test from "node:test";
import { extractLinkedInParentPostMetrics } from "../scripts/lib/linkedin-parent-metrics.mjs";

const postId = "7478586962652655616";
const source = `URL Source: https://www.linkedin.com/posts/activity-${postId}-SNCG`;
const reportPost = "[Report this post](https://linkedin.com/guest?guestReportContentType=POST)";
const action = "[Like](https://linkedin.com/signup) [Comment](https://linkedin.com/signup) Share";
const icon = (count) => `[![Image 1](https://static.licdn.com/a)![Image 2](https://static.licdn.com/b) ${count}](https://linkedin.com/signup)`;
const comments = (count) => `[${count} Comments](https://linkedin.com/signup)`;

test("extracts the bounded parent icon aggregate and comments, excluding comment reactions", () => {
  const receipt = extractLinkedInParentPostMetrics({
    expectedPostId: postId,
    rawVisibleText: `${source} ${reportPost} Parent body ${icon("1.2K")}${comments(24)} ${action} ` +
      "[Report this comment](https://linkedin.com/guest?guestReportContentType=COMMENT) Reply 1 Reaction"
  });
  assert.deepEqual(receipt.metrics, { reactions: 1_200, comments: 24 });
  assert.equal(receipt.status, "verified");
});

test("supports a truncated parent footer after the adjacent comments label", () => {
  const receipt = extractLinkedInParentPostMetrics({
    expectedPostId: postId,
    rawVisibleText: `${source} ${reportPost} Parent ${icon("2,345")}[7 Comments`
  });
  assert.deepEqual(receipt.metrics, { reactions: 2_345, comments: 7 });
});

test("supports independently visible reaction-only and comments-only parent footers", () => {
  assert.deepEqual(extractLinkedInParentPostMetrics({
    expectedPostId: postId,
    rawVisibleText: `${source} ${reportPost} Parent ${icon(19)} ${action}`
  }).metrics, { reactions: 19 });
  assert.deepEqual(extractLinkedInParentPostMetrics({
    expectedPostId: postId,
    rawVisibleText: `${source} ${reportPost} Parent ${comments(3)} ${action}`
  }).metrics, { comments: 3 });
});

test("fails closed on activity mismatch, authored metric phrases, and malformed footers", () => {
  for (const rawVisibleText of [
    `${source.replace(postId, "7478586962652655999")} ${reportPost} ${icon(12)}${comments(2)} ${action}`,
    `${source} ${reportPost} We earned 1,000 reactions from customers. ${action}`,
    `${source} ${reportPost} Parent body [24 Comments`,
    `${source} Parent body ${icon(12)}${comments(2)} ${action}`
  ]) {
    const receipt = extractLinkedInParentPostMetrics({ expectedPostId: postId, rawVisibleText });
    assert.equal(receipt.status, "unproven");
    assert.deepEqual(receipt.metrics, {});
  }
});

test("bounds the primary post before related-post and comment metrics", () => {
  const rawVisibleText = `${source} ${reportPost} Parent with no footer ` +
    `[Report this comment](https://linkedin.com/guest?guestReportContentType=COMMENT) 1 Reaction ` +
    `${reportPost} Related ${icon(999)}${comments(88)} ${action}`;
  const receipt = extractLinkedInParentPostMetrics({ expectedPostId: postId, rawVisibleText });
  assert.equal(receipt.status, "unproven");
  assert.deepEqual(receipt.metrics, {});
});

test("accepts an exact structured native receipt and rejects an unverified one", () => {
  const base = {
    post: { id: postId, url: `https://linkedin.com/posts/activity-${postId}` },
    counts: { reactions: 282, comments: 62 },
    verification: { status: "accepted", metricsVisible: true, notProfileOrSearchPage: true }
  };
  assert.deepEqual(extractLinkedInParentPostMetrics({
    expectedPostId: postId,
    rawVisibleText: JSON.stringify(base)
  }).metrics, { reactions: 282, comments: 62 });
  base.verification.status = "needs_review";
  assert.equal(extractLinkedInParentPostMetrics({
    expectedPostId: postId,
    rawVisibleText: JSON.stringify(base)
  }).status, "unproven");
});
