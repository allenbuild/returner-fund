import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractXPublicProfileReceipt } from "../scripts/lib/x-public-profile-html.mjs";

describe("anonymous server-rendered X profile ingestion", () => {
  it("keeps an owner's quote wrapper and rejects the nested quoted author", () => {
    const receipt = extractXPublicProfileReceipt({
      html: profileHtml("michaelzixizhou", [
        postHtml({
          id: "2058603225859977517",
          handle: "michaelzixizhou",
          name: "Michael Zhou",
          postedAt: "2026-05-24T17:37:10.000Z",
          text: "Pinned older post",
          metrics: { likes: 1239, replies: 197, views: 64553 }
        }),
        postHtml({
          id: "2083304728046518692",
          handle: "michaelzixizhou",
          name: "Michael Zhou",
          postedAt: "2026-07-31T21:32:07.000Z",
          text: "this is much better than the video yall took in my apt lobby LMAO",
          metrics: { likes: 4, replies: 1, views: 398 },
          basedOn: "https://x.com/i/status/2083247570202042789",
          nested: postHtml({
            id: "2083247570202042789",
            handle: "spei04",
            name: "Serena Pei",
            postedAt: "2026-07-31T17:45:00.000Z",
            text: "Today we’re launching Palette!",
            metrics: { likes: 100, replies: 20, views: 10000 }
          })
        })
      ]),
      accountUrl: "https://x.com/michaelzixizhou",
      fetchedAt: "2026-08-03T08:00:00.000Z",
      limit: 30
    });

    assert.equal(receipt.verified, true);
    assert.equal(receipt.surfacePostCount, 3);
    assert.equal(receipt.exactOwnerPostCount, 2);
    assert.equal(receipt.rejectedPostCount, 1);
    assert.deepEqual(receipt.posts.map((post) => post.id), [
      "2083304728046518692",
      "2058603225859977517"
    ]);
    assert.deepEqual(receipt.posts[0], {
      id: "2083304728046518692",
      url: "https://x.com/michaelzixizhou/status/2083304728046518692",
      urlHandle: "michaelzixizhou",
      authorHandle: "michaelzixizhou",
      authorName: "Michael Zhou",
      text: "this is much better than the video yall took in my apt lobby LMAO",
      postedAt: "2026-07-31T21:32:07.000Z",
      metrics: { likes: 4, replies: 1, views: 398 },
      mediaUrls: [],
      quotedPostUrl: "https://x.com/i/status/2083247570202042789",
      isQuote: true
    });
    assert.deepEqual(receipt.rejectedPosts, [
      {
        id: "2083247570202042789",
        authorHandle: "spei04",
        url: "https://x.com/spei04/status/2083247570202042789",
        reason: "native_owner_mismatch"
      }
    ]);
  });

  it("sorts recent owner posts ahead of a pinned old post before applying the cap", () => {
    const receipt = extractXPublicProfileReceipt({
      html: profileHtml("agnostai", [
        postHtml({
          id: "2050000000000000000",
          handle: "agnostai",
          postedAt: "2026-05-01T00:00:00.000Z",
          text: "Pinned",
          metrics: { views: 50000 }
        }),
        postHtml({
          id: "2083976371722993811",
          handle: "agnostai",
          postedAt: "2026-08-02T18:01:00.000Z",
          text: "we benchmarked a few iMessage assistants and here are the results!",
          metrics: { views: 69 }
        }),
        postHtml({
          id: "2083452949381140775",
          handle: "agnostai",
          postedAt: "2026-08-01T07:21:06.000Z",
          text: "agnost &lt;&gt; @librahq",
          metrics: { likes: 2, views: 565 }
        })
      ]),
      requestedHandle: "@AgnostAI",
      limit: 2
    });

    assert.equal(receipt.verified, true);
    assert.equal(receipt.exactOwnerPostCount, 3);
    assert.equal(receipt.returnedPostCount, 2);
    assert.equal(receipt.truncated, true);
    assert.deepEqual(receipt.posts.map((post) => post.id), [
      "2083976371722993811",
      "2083452949381140775"
    ]);
    assert.equal(receipt.posts[1].text, "agnost <> @librahq");
  });

  it("fails closed when the profile identity, status URL, or timestamp is not native and exact", () => {
    const identityMismatch = extractXPublicProfileReceipt({
      html: profileHtml("different", [
        postHtml({
          id: "2083976371722993811",
          handle: "requested",
          postedAt: "2026-08-02T18:01:00.000Z",
          text: "post",
          metrics: { views: 1 }
        })
      ]),
      requestedHandle: "requested"
    });
    assert.equal(identityMismatch.verified, false);
    assert.equal(identityMismatch.reason, "x_profile_identity_mismatch");

    const invalidRows = extractXPublicProfileReceipt({
      html: profileHtml("requested", [
        postHtml({
          id: "2083976371722993811",
          urlId: "2083976371722993812",
          handle: "requested",
          postedAt: "2026-08-02T18:01:00.000Z",
          text: "post",
          metrics: { views: 1 }
        }),
        postHtml({
          id: "2083976371722993813",
          handle: "requested",
          postedAt: "not-a-date",
          text: "post with an invalid publication timestamp",
          metrics: { views: 1 }
        })
      ]),
      requestedHandle: "requested"
    });
    assert.equal(invalidRows.verified, false);
    assert.equal(invalidRows.reason, "no_exact_owner_social_media_postings");
    assert.equal(invalidRows.rejectedPosts[0].reason, "native_status_url_mismatch");
    assert.equal(invalidRows.rejectedPosts[1].reason, "invalid_native_publication_timestamp");
  });

  it("does not interpret an exact ProfilePage with no native articles as verified empty", () => {
    const receipt = extractXPublicProfileReceipt({
      html: profileHtml("requested", []),
      requestedHandle: "requested"
    });

    assert.equal(receipt.verified, false);
    assert.equal(receipt.reason, "no_exact_owner_social_media_postings");
    assert.equal(receipt.surfacePostCount, 0);
    assert.deepEqual(receipt.posts, []);
  });
});

function profileHtml(handle, posts) {
  return `<!doctype html><html><body>
    <div itemscope itemtype="https://schema.org/ProfilePage">
      <meta itemprop="url" content="https://x.com/${handle}">
      ${posts.join("\n")}
    </div>
  </body></html>`;
}

function postHtml({
  id,
  handle,
  urlHandle = handle,
  urlId = id,
  name = handle,
  postedAt,
  text,
  metrics = {},
  basedOn = null,
  nested = ""
}) {
  const counters = Object.entries(metrics).map(([metric, value]) => {
    const schema = {
      likes: ["LikeAction", "Likes"],
      reposts: ["ShareAction", "Retweets"],
      quotes: ["InteractAction", "Quotes"],
      replies: ["ReplyAction", "Replies"],
      views: ["ViewAction", "Views"]
    }[metric];
    return `<div itemprop="interactionStatistic" itemscope itemtype="https://schema.org/InteractionCounter">
      <meta itemprop="interactionType" content="https://schema.org/${schema[0]}">
      <meta itemprop="name" content="${schema[1]}">
      <meta itemprop="userInteractionCount" content="${value}">
    </div>`;
  }).join("\n");
  return `<article data-tweet-id="${id}" itemscope itemtype="https://schema.org/SocialMediaPosting">
    <meta itemprop="identifier" content="${id}">
    <meta itemprop="commentCount" content="${metrics.replies ?? 0}">
    <meta itemprop="datePublished" content="${postedAt}">
    <meta itemprop="url" content="https://x.com/${urlHandle}/status/${urlId}">
    <meta itemprop="articleBody" content="${escapeAttribute(text)}">
    <div itemprop="author" itemscope itemtype="https://schema.org/Person">
      <meta itemprop="alternateName" content="${handle}">
      <meta itemprop="name" content="${escapeAttribute(name)}">
      <meta itemprop="url" content="https://x.com/${handle}">
    </div>
    ${basedOn ? `<meta itemprop="isBasedOn" content="${basedOn}">` : ""}
    ${counters}
    ${nested}
  </article>`;
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
