import assert from "node:assert/strict";
import test from "node:test";

import {
  extractLinkedInPublicPostReceipt,
  extractLinkedInPublicProfileSurface
} from "../scripts/lib/linkedin-public-jsonld.mjs";
import { assessLinkedInPrimaryPostBody } from "../scripts/lib/public-evidence-attribution.mjs";

const profileUrl = "https://www.linkedin.com/company/tash-cards";
const postUrl = "https://www.linkedin.com/posts/tash-cards_launch-activity-7489018280448245760-hDoc";

function postNode(overrides = {}) {
  return {
    "@context": "https://schema.org",
    "@type": "SocialMediaPosting",
    "@id": postUrl,
    datePublished: "2026-07-31T18:04:57.270Z",
    headline: "We're excited to share that tash is part of YC S26.",
    articleBody: "We're excited to share that tash is part of the YC S26 batch.",
    author: {
      "@type": "Organization",
      name: "tash (YC S26)",
      url: profileUrl
    },
    interactionStatistic: [
      {
        "@type": "InteractionCounter",
        interactionType: "http://schema.org/LikeAction",
        userInteractionCount: 304
      },
      {
        "@type": "InteractionCounter",
        interactionType: "https://schema.org/CommentAction",
        userInteractionCount: 118
      }
    ],
    comment: [
      {
        "@type": "Comment",
        text: "Unrelated comment metric must not leak",
        interactionStatistic: {
          interactionType: "https://schema.org/LikeAction",
          userInteractionCount: 9_999
        }
      }
    ],
    ...overrides
  };
}

function htmlWithJsonLd(value) {
  return `<html><head><script type="application/ld+json">${JSON.stringify(value)}</script></head></html>`;
}

test("extracts an exact LinkedIn post body and parent-only engagement receipt", () => {
  const result = extractLinkedInPublicPostReceipt({
    html: htmlWithJsonLd(postNode()),
    postUrl,
    expectedAccountUrl: profileUrl
  });

  assert.equal(result.verified, true);
  assert.equal(result.receipt.post.id, "7489018280448245760");
  assert.equal(result.receipt.post.author.slug, "tash-cards");
  assert.equal(result.receipt.post.datePublished, "2026-07-31T18:04:57.270Z");
  assert.deepEqual(result.receipt.counts, { reactions: 304, comments: 118 });
  assert.equal(JSON.stringify(result.receipt.counts).includes("9999"), false);

  const body = assessLinkedInPrimaryPostBody({
    sourceUrl: postUrl,
    accountUrl: profileUrl,
    platformPostId: "7489018280448245760",
    rawVisibleText: JSON.stringify(result.receipt)
  });
  assert.deepEqual(body, {
    verified: true,
    reason: "linkedin_structured_primary_body_verified",
    text: "We're excited to share that tash is part of the YC S26 batch."
  });
});

test("rejects a JSON-LD activity other than the requested post", () => {
  const result = extractLinkedInPublicPostReceipt({
    html: htmlWithJsonLd(postNode({
      "@id": "https://www.linkedin.com/posts/tash-cards_other-activity-7489018280448245761-aBc"
    })),
    postUrl,
    expectedAccountUrl: profileUrl
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, "linkedin_public_jsonld_activity_not_found");
});

test("rejects a post whose structured author differs from the mapped account", () => {
  const result = extractLinkedInPublicPostReceipt({
    html: htmlWithJsonLd(postNode({
      author: { "@type": "Organization", name: "Other", url: "https://www.linkedin.com/company/other" }
    })),
    postUrl,
    expectedAccountUrl: profileUrl
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, "linkedin_public_jsonld_author_mismatch");
});

test("rejects ambiguous duplicate JSON-LD nodes for the same activity", () => {
  const result = extractLinkedInPublicPostReceipt({
    html: htmlWithJsonLd({ "@graph": [postNode(), postNode()] }),
    postUrl,
    expectedAccountUrl: profileUrl
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, "linkedin_public_jsonld_activity_ambiguous");
});

test("rejects malformed and oversized public payloads without throwing", () => {
  const malformed = extractLinkedInPublicPostReceipt({
    html: "<script type='application/ld+json'>{nope</script>",
    postUrl,
    expectedAccountUrl: profileUrl
  });
  assert.equal(malformed.verified, false);
  assert.equal(malformed.reason, "linkedin_public_jsonld_activity_not_found");

  const oversized = extractLinkedInPublicPostReceipt({
    html: "x".repeat(6_000_001),
    postUrl,
    expectedAccountUrl: profileUrl
  });
  assert.equal(oversized.verified, false);
  assert.equal(oversized.reason, "linkedin_public_jsonld_input_invalid");
});

test("profile discovery keeps only exact-author native post anchors", () => {
  const surface = extractLinkedInPublicProfileSurface({
    profileUrl,
    html: `
      <html><head>
        <link rel="canonical" href="${profileUrl}">
        <meta property="og:title" content="tash (YC S26) | LinkedIn">
        <meta property="og:description" content="tash | 2,143 followers on LinkedIn">
      </head><body>
        <a href="${postUrl}">Launch</a>
        <a href="https://www.linkedin.com/posts/other_launch-activity-7489018280448245761-aBc">Other</a>
        <a href="${postUrl}?trk=duplicate">Duplicate</a>
      </body></html>
    `
  });

  assert.equal(surface.verified, true);
  assert.equal(surface.accountSlug, "tash-cards");
  assert.equal(surface.followers, 2_143);
  assert.deepEqual(surface.postCandidates.map((candidate) => candidate.postId), ["7489018280448245760"]);
  assert.equal(surface.postCandidates[0].url.includes("?"), false);
});

test("structured body validation independently rejects an author mismatch", () => {
  const result = extractLinkedInPublicPostReceipt({
    html: htmlWithJsonLd(postNode()),
    postUrl,
    expectedAccountUrl: profileUrl
  });
  result.receipt.post.author.url = "https://www.linkedin.com/company/other";
  result.receipt.post.author.slug = "other";
  assert.equal(assessLinkedInPrimaryPostBody({
    sourceUrl: postUrl,
    accountUrl: profileUrl,
    rawVisibleText: JSON.stringify(result.receipt)
  }).reason, "linkedin_structured_primary_body_author_unverified");
});
