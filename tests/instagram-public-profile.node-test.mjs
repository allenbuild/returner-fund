import assert from "node:assert/strict";
import test from "node:test";

import {
  instagramEvidenceMetrics,
  instagramNativeFeedRequest,
  instagramPublicProfileRequest,
  mergeInstagramNativeFeedPages,
  overlayInstagramNativeFeedMetrics,
  parseInstagramNativeFeedResponse,
  parseInstagramPublicProfileResponse
} from "../scripts/lib/instagram-public-profile.mjs";

const fetchedAt = "2026-08-02T21:00:00.000Z";

function mediaNode({
  shortcode = "POST_1",
  timestamp = 1_722_470_400,
  type = "GraphImage",
  caption = "Launch day",
  displayUrl = "https://cdn.example/image.jpg?width=640&token=secret#fragment",
  overrides = {}
} = {}) {
  return {
    __typename: type,
    shortcode,
    taken_at_timestamp: timestamp,
    owner: { username: "_heyclicky" },
    coauthor_producers: [],
    display_url: displayUrl,
    edge_media_to_caption: {
      edges: caption == null ? [] : [{ node: { text: caption } }]
    },
    edge_media_preview_like: { count: 12 },
    edge_liked_by: { count: 10 },
    edge_media_to_parent_comment: { count: 4 },
    edge_media_to_comment: { count: 3 },
    ...overrides
  };
}

function payloadFor(username, edges, {
  count = edges.length,
  hasNextPage = false,
  endCursor = null
} = {}) {
  return {
    status: "ok",
    data: {
      user: {
        username,
        edge_owner_to_timeline_media: {
          count,
          page_info: {
            has_next_page: hasNextPage,
            end_cursor: endCursor
          },
          edges: edges.map((node) => ({ node }))
        }
      }
    }
  };
}

function nativeFeedItem({
  shortcode = "REEL_2",
  pk = "3947842135164450123",
  timestamp = 1_722_470_400,
  authorUsername = "_heyclicky",
  coauthors = [],
  likes = 4_050,
  comments = 64,
  plays = 122_000,
  overrides = {}
} = {}) {
  return {
    pk,
    code: shortcode,
    media_type: 2,
    product_type: "clips",
    taken_at: timestamp,
    user: { username: authorUsername },
    coauthor_producers: coauthors.map((username) => ({ username })),
    caption: { text: "Watch the demo" },
    like_count: likes,
    comment_count: comments,
    play_count: plays,
    ig_play_count: plays,
    ...overrides
  };
}

function nativeFeedPayload(username, items, {
  moreAvailable = false,
  nextMaxId = null
} = {}) {
  return {
    status: "ok",
    user: { username },
    num_results: items.length,
    more_available: moreAvailable,
    next_max_id: nextMaxId,
    items
  };
}

test("builds a bounded anonymous web_profile_info request from an exact account", () => {
  const request = instagramPublicProfileRequest({
    accountUrl: "https://www.instagram.com/Tash.Cards/?token=must-not-propagate#bio"
  });

  assert.equal(request.username, "tash.cards");
  assert.equal(
    request.url,
    "https://www.instagram.com/api/v1/users/web_profile_info/?username=tash.cards"
  );
  assert.deepEqual(request.options, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    headers: {
      accept: "application/json",
      "x-ig-app-id": "936619743392459",
      referer: "https://www.instagram.com/tash.cards/",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36"
    }
  });
  assert.equal("cookie" in request.options.headers, false);
  assert.equal("authorization" in request.options.headers, false);
  assert.ok(request.options.headers["user-agent"].length < 256);
  assert.equal(request.options.headers.referer.includes("?"), false);
  assert.equal(request.url.includes("must-not-propagate"), false);
});

test("builds a bounded credential-omitting native feed request with an optional cursor", () => {
  const request = instagramNativeFeedRequest({
    accountUrl: "https://www.instagram.com/Tash.Cards/?sessionid=discard#secret",
    maxId: "cursor/+=="
  });
  const url = new URL(request.url);

  assert.equal(request.username, "tash.cards");
  assert.equal(url.origin + url.pathname, "https://www.instagram.com/api/v1/feed/user/tash.cards/username/");
  assert.equal(url.searchParams.get("count"), "50");
  assert.equal(url.searchParams.get("max_id"), "cursor/+==");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.redirect, "error");
  assert.equal("cookie" in request.options.headers, false);
  assert.equal("authorization" in request.options.headers, false);
  assert.doesNotMatch(JSON.stringify(request), /sessionid=discard|#secret/);
  assert.throws(
    () => instagramNativeFeedRequest({ username: "tash.cards", maxId: "\u0000bad" }),
    /cursor is invalid/i
  );
});

test("request construction rejects invalid and mismatched profile identities", () => {
  assert.throws(
    () => instagramPublicProfileRequest({
      accountUrl: "https://www.instagram.com/tash.cards/",
      username: "somebody_else"
    }),
    /do not match/i
  );
  assert.throws(
    () => instagramPublicProfileRequest({ accountUrl: "https://instagram.com/reel/ABC/" }),
    /account URL is invalid/i
  );
  assert.throws(
    () => instagramPublicProfileRequest({ accountUrl: "https://instagram.com.evil.example/tash.cards/" }),
    /account URL is invalid/i
  );
  assert.throws(
    () => instagramPublicProfileRequest({ username: "bad username" }),
    /username is invalid/i
  );
  assert.throws(
    () => instagramPublicProfileRequest({ username: "tash.cards", appId: "secret" }),
    /app ID is invalid/i
  );
});

test("parses exact-profile image and reel edges, metrics, media, dedupe, and truncation", () => {
  const image = mediaNode();
  const reel = mediaNode({
    shortcode: "REEL_2",
    type: "GraphVideo",
    caption: "Watch the demo",
    displayUrl: "https://cdn.example/reel-cover.jpg?_nc_sid=sensitive&width=1080",
    overrides: {
      is_video: true,
      owner: { username: "farza954" },
      coauthor_producers: [{ username: "_heyclicky" }, { username: "collab_friend" }],
      video_url: "https://cdn.example/reel.mp4?signature=top-secret&quality=hd",
      video_view_count: 1_200,
      video_play_count: 1_500,
      play_count: 1_400
    }
  });
  const duplicateReel = mediaNode({
    shortcode: "REEL_2",
    type: "GraphVideo",
    caption: "",
    displayUrl: "https://cdn.example/reel-alt.jpg?access_token=remove-me",
    overrides: {
      is_video: true,
      owner: { username: "farza954" },
      coauthor_producers: [{ username: "_heyclicky" }],
      edge_media_preview_like: { count: 99 },
      edge_media_to_parent_comment: { count: 8 },
      video_view_count: 1_300,
      play_count: 1_600
    }
  });

  const result = parseInstagramPublicProfileResponse({
    payload: JSON.stringify(payloadFor("_HeyClicky", [image, reel, duplicateReel], {
      count: 7,
      hasNextPage: true,
      endCursor: "cursor-2"
    })),
    requestedUsername: "@_heyclicky",
    fetchedAt
  });

  assert.equal(result.verified, true);
  assert.equal(result.username, "_heyclicky");
  assert.equal(result.accountUrl, "https://www.instagram.com/_heyclicky/");
  assert.equal(result.fetchedAt, fetchedAt);
  assert.equal(result.totalCount, 7);
  assert.deepEqual(result.pageInfo, {
    hasNextPage: true,
    endCursor: "cursor-2"
  });
  assert.equal(result.receivedEdgeCount, 3);
  assert.equal(result.processedEdgeCount, 3);
  assert.equal(result.duplicateEdgeCount, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.posts.length, 2);

  const parsedImage = result.posts.find((post) => post.shortcode === "POST_1");
  assert.equal(parsedImage.url, "https://www.instagram.com/p/POST_1/");
  assert.equal(parsedImage.mediaType, "post");
  assert.equal(parsedImage.authorUsername, "_heyclicky");
  assert.deepEqual(parsedImage.coauthorUsernames, []);
  assert.equal(parsedImage.profileRole, "primary");
  assert.equal(parsedImage.caption, "Launch day");
  assert.equal(parsedImage.postedAt, new Date(1_722_470_400_000).toISOString());
  assert.deepEqual(parsedImage.metrics, {
    likes: 12,
    comments: 4,
    videoViews: null,
    videoPlays: null
  });
  assert.deepEqual(parsedImage.mediaUrls, ["https://cdn.example/image.jpg?width=640"]);

  const parsedReel = result.posts.find((post) => post.shortcode === "REEL_2");
  assert.equal(parsedReel.url, "https://www.instagram.com/reel/REEL_2/");
  assert.equal(parsedReel.mediaType, "reel");
  assert.equal(parsedReel.authorUsername, "farza954");
  assert.deepEqual(parsedReel.coauthorUsernames, ["_heyclicky", "collab_friend"]);
  assert.equal(parsedReel.profileRole, "coauthor");
  assert.deepEqual(parsedReel.metrics, {
    likes: 99,
    comments: 8,
    videoViews: 1_300,
    videoPlays: 1_600
  });
  assert.deepEqual(parsedReel.mediaUrls, [
    "https://cdn.example/reel-cover.jpg?width=1080",
    "https://cdn.example/reel.mp4?quality=hd",
    "https://cdn.example/reel-alt.jpg"
  ]);
  assert.doesNotMatch(JSON.stringify(result), /top-secret|sensitive|remove-me/);
});

test("native reel play_count overrides stale web_profile_info views without regressing engagement", () => {
  const profile = parseInstagramPublicProfileResponse({
    payload: payloadFor("_heyclicky", [mediaNode({
      shortcode: "DbJjYFfy_VL",
      type: "GraphVideo",
      caption: "i am being shipped",
      overrides: {
        is_video: true,
        owner: { username: "_heyclicky" },
        edge_media_preview_like: { count: 4_060 },
        edge_liked_by: { count: 4_060 },
        edge_media_to_parent_comment: { count: 64 },
        edge_media_to_comment: { count: 64 },
        video_view_count: 4_290
      }
    })]),
    requestedUsername: "_heyclicky",
    fetchedAt
  });
  const feedPage = parseInstagramNativeFeedResponse({
    payload: nativeFeedPayload("_heyclicky", [nativeFeedItem({
      shortcode: "DbJjYFfy_VL",
      likes: 4_050,
      comments: 64,
      plays: 122_000
    })]),
    requestedUsername: "_heyclicky",
    fetchedAt
  });
  const feed = mergeInstagramNativeFeedPages([feedPage]);
  const overlaid = overlayInstagramNativeFeedMetrics(profile, feed);
  const post = overlaid.posts[0];

  assert.equal(feed.verified, true);
  assert.equal(overlaid.nativeFeedOverlayCount, 1);
  assert.equal(overlaid.nativeFeedAddedPostCount, 0);
  assert.deepEqual(post.nativeFeedMetrics, {
    likes: 4_050,
    comments: 64,
    plays: 122_000,
    videoViews: null
  });
  assert.deepEqual(instagramEvidenceMetrics(post), {
    likes: 4_060,
    comments: 64,
    views: 122_000
  });
});

test("paginates native feed receipts, deduplicates shortcodes, and adds older feed-only posts", () => {
  const first = parseInstagramNativeFeedResponse({
    payload: nativeFeedPayload("_heyclicky", [
      nativeFeedItem({ shortcode: "NEW", pk: "100", plays: 100 }),
      nativeFeedItem({ shortcode: "DUP", pk: "101", plays: 200 })
    ], { moreAvailable: true, nextMaxId: "cursor-2" }),
    requestedUsername: "_heyclicky",
    fetchedAt
  });
  const second = parseInstagramNativeFeedResponse({
    payload: nativeFeedPayload("_heyclicky", [
      nativeFeedItem({ shortcode: "DUP", pk: "101", plays: 250 }),
      nativeFeedItem({ shortcode: "OLD", pk: "102", plays: 300 })
    ]),
    requestedUsername: "_heyclicky",
    fetchedAt: "2026-08-02T21:01:00.000Z"
  });
  const merged = mergeInstagramNativeFeedPages([first, second]);
  const emptyProfile = parseInstagramPublicProfileResponse({
    payload: payloadFor("_heyclicky", []),
    requestedUsername: "_heyclicky",
    fetchedAt
  });
  const overlaid = overlayInstagramNativeFeedMetrics(emptyProfile, merged);

  assert.equal(merged.pageCount, 2);
  assert.equal(merged.receivedItemCount, 4);
  assert.equal(merged.uniqueItemCount, 3);
  assert.equal(merged.duplicateItemCount, 1);
  assert.equal(merged.sourceExhausted, true);
  assert.equal(merged.truncated, false);
  assert.deepEqual(merged.posts.map((post) => post.shortcode), ["NEW", "DUP", "OLD"]);
  assert.equal(merged.posts.find((post) => post.shortcode === "DUP").metrics.plays, 250);
  assert.equal(overlaid.nativeFeedAddedPostCount, 3);
  assert.deepEqual(
    overlaid.posts.map((post) => instagramEvidenceMetrics(post).views),
    [100, 250, 300]
  );
});

test("records an explicit truncation reason when the native feed item cap is reached", () => {
  const page = parseInstagramNativeFeedResponse({
    payload: nativeFeedPayload("_heyclicky", [
      nativeFeedItem({ shortcode: "ONE", pk: "201" }),
      nativeFeedItem({ shortcode: "TWO", pk: "202" }),
      nativeFeedItem({ shortcode: "THREE", pk: "203" })
    ], { moreAvailable: true, nextMaxId: "cursor-more" }),
    requestedUsername: "_heyclicky",
    fetchedAt
  });
  const merged = mergeInstagramNativeFeedPages([page], { maxItems: 2 });

  assert.equal(merged.uniqueItemCount, 2);
  assert.equal(merged.sourceExhausted, false);
  assert.equal(merged.truncated, true);
  assert.equal(merged.truncationReason, "item_limit");
  assert.equal(merged.nextMaxId, "cursor-more");
});

test("marks verified native-feed pages partial when later pagination is interrupted", () => {
  const page = parseInstagramNativeFeedResponse({
    payload: nativeFeedPayload("_heyclicky", [
      nativeFeedItem({ shortcode: "VERIFIED", pk: "204" })
    ], { moreAvailable: true, nextMaxId: "cursor-next" }),
    requestedUsername: "_heyclicky",
    fetchedAt
  });
  const merged = mergeInstagramNativeFeedPages([page], {
    interruptionReason: "http_500"
  });

  assert.equal(merged.verified, true);
  assert.equal(merged.sourceExhausted, false);
  assert.equal(merged.interrupted, true);
  assert.equal(merged.truncated, true);
  assert.equal(merged.truncationReason, "pagination_interrupted:http_500");
  assert.deepEqual(merged.posts.map((post) => post.shortcode), ["VERIFIED"]);
});

test("native feed parsing fails closed on profile mismatch, malformed pages, and blocked payloads", () => {
  const cases = [
    [nativeFeedPayload("somebody_else", [nativeFeedItem()]), "instagram_native_feed_username_mismatch"],
    [{ status: "ok", user: { username: "_heyclicky" }, items: [], num_results: 1, more_available: false }, "instagram_native_feed_page_malformed"],
    [nativeFeedPayload("_heyclicky", [nativeFeedItem({ overrides: { user: { username: "bad username" } } })]), "instagram_native_feed_item_malformed"],
    [{ status: "fail", status_code: 429, message: "Please wait" }, "instagram_native_feed_rate_limited"]
  ];
  for (const [payload, reason] of cases) {
    const result = parseInstagramNativeFeedResponse({
      payload,
      requestedUsername: "_heyclicky",
      fetchedAt
    });
    assert.equal(result.verified, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.posts, []);
  }
  const oversized = parseInstagramNativeFeedResponse({
    payload: "x".repeat(4_000_001),
    requestedUsername: "_heyclicky",
    fetchedAt
  });
  assert.equal(oversized.reason, "instagram_native_feed_payload_malformed");
});

test("native feed overlay rejects a same-shortcode observation with different ownership", () => {
  const profile = parseInstagramPublicProfileResponse({
    payload: payloadFor("_heyclicky", [mediaNode({
      shortcode: "OWNER_TEST",
      type: "GraphVideo",
      overrides: { is_video: true, owner: { username: "_heyclicky" } }
    })]),
    requestedUsername: "_heyclicky",
    fetchedAt
  });
  const feed = parseInstagramNativeFeedResponse({
    payload: nativeFeedPayload("_heyclicky", [nativeFeedItem({
      shortcode: "OWNER_TEST",
      authorUsername: "somebody_else",
      coauthors: ["_heyclicky"]
    })]),
    requestedUsername: "_heyclicky",
    fetchedAt
  });
  const overlaid = overlayInstagramNativeFeedMetrics(profile, feed);
  assert.equal(overlaid.nativeFeedOverlayCount, 0);
  assert.equal(overlaid.nativeFeedAddedPostCount, 0);
  assert.equal(overlaid.posts[0].nativeFeedMetrics, undefined);
});

test("parses bounded sidecar media URLs and reports sidecar truncation", () => {
  const children = Array.from({ length: 21 }, (_, index) => ({
    node: {
      display_url: `https://cdn.example/sidecar-${index}.jpg?width=640&token=secret-${index}`
    }
  }));
  const post = mediaNode({
    overrides: {
      edge_sidecar_to_children: { edges: children }
    }
  });
  const result = parseInstagramPublicProfileResponse({
    payload: payloadFor("tash.cards", [post]),
    requestedUsername: "tash.cards",
    fetchedAt
  });

  assert.equal(result.verified, true);
  assert.equal(result.truncated, true);
  assert.equal(result.posts[0].mediaUrls.length, 12);
  assert.ok(result.posts[0].mediaUrls.every((url) => !url.includes("secret")));
});

test("preserves public expiring signatures only on allowlisted Instagram CDN hosts", () => {
  const signed = mediaNode({
    displayUrl:
      "https://scontent.cdninstagram.com/photo.jpg?oh=public-signature&oe=expires&access_token=discard"
  });
  const untrusted = mediaNode({
    shortcode: "UNTRUSTED",
    displayUrl:
      "https://cdn.example/photo.jpg?oh=strip-me&oe=strip-me-too&access_token=discard"
  });
  const result = parseInstagramPublicProfileResponse({
    payload: payloadFor("tash.cards", [signed, untrusted]),
    requestedUsername: "tash.cards",
    fetchedAt
  });

  assert.equal(result.verified, true);
  assert.equal(
    result.posts[0].mediaUrls[0],
    "https://scontent.cdninstagram.com/photo.jpg?oh=public-signature&oe=expires"
  );
  assert.equal(result.posts[1].mediaUrls[0], "https://cdn.example/photo.jpg");
  assert.doesNotMatch(JSON.stringify(result), /access_token|discard|strip-me/);
});

test("distinguishes primary, coauthor, and surface-only profile roles", () => {
  const primary = mediaNode({
    shortcode: "PRIMARY_1",
    overrides: {
      owner: { username: "tash.cards" },
      coauthor_producers: [{ username: "friend_one" }]
    }
  });
  const coauthor = mediaNode({
    shortcode: "COAUTHOR_1",
    overrides: {
      owner: { username: "farza954" },
      coauthor_producers: [{ username: "tash.cards" }]
    }
  });
  const surfaceOnly = mediaNode({
    shortcode: "SURFACE_1",
    overrides: {
      owner: { username: "somebody_else" },
      coauthor_producers: [{ username: "another_collaborator" }]
    }
  });
  const result = parseInstagramPublicProfileResponse({
    payload: payloadFor("tash.cards", [primary, coauthor, surfaceOnly]),
    requestedUsername: "tash.cards",
    fetchedAt
  });

  assert.equal(result.verified, true);
  assert.deepEqual(
    result.posts.map((post) => ({
      shortcode: post.shortcode,
      authorUsername: post.authorUsername,
      coauthorUsernames: post.coauthorUsernames,
      profileRole: post.profileRole
    })),
    [
      {
        shortcode: "PRIMARY_1",
        authorUsername: "tash.cards",
        coauthorUsernames: ["friend_one"],
        profileRole: "primary"
      },
      {
        shortcode: "COAUTHOR_1",
        authorUsername: "farza954",
        coauthorUsernames: ["tash.cards"],
        profileRole: "coauthor"
      },
      {
        shortcode: "SURFACE_1",
        authorUsername: "somebody_else",
        coauthorUsernames: ["another_collaborator"],
        profileRole: "surface_only"
      }
    ]
  );
});

test("bounds and deduplicates declared coauthors", () => {
  const coauthors = [
    { username: "tash.cards" },
    { username: "tash.cards" },
    ...Array.from({ length: 19 }, (_, index) => ({ username: `collab_${index}` }))
  ];
  const result = parseInstagramPublicProfileResponse({
    payload: payloadFor("tash.cards", [mediaNode({
      overrides: {
        owner: { username: "farza954" },
        coauthor_producers: coauthors
      }
    })]),
    requestedUsername: "tash.cards",
    fetchedAt
  });

  assert.equal(result.verified, true);
  assert.equal(result.truncated, true);
  assert.equal(result.posts[0].authorUsername, "farza954");
  assert.equal(result.posts[0].coauthorUsernames.length, 19);
  assert.equal(result.posts[0].coauthorUsernames[0], "tash.cards");
  assert.equal(result.posts[0].profileRole, "coauthor");
});

test("fails closed on an exact requested username mismatch", () => {
  const result = parseInstagramPublicProfileResponse({
    payload: payloadFor("somebody_else", [mediaNode()]),
    requestedUsername: "tash.cards",
    fetchedAt
  });

  assert.equal(result.verified, false);
  assert.equal(result.reason, "instagram_public_profile_username_mismatch");
  assert.deepEqual(result.posts, []);
});

test("fails closed on malformed JSON, envelopes, timelines, and edges", () => {
  const cases = [
    ["{nope", "instagram_public_profile_payload_malformed"],
    [[], "instagram_public_profile_payload_malformed"],
    [{ status: "ok", data: { user: null } }, "instagram_public_profile_user_missing"],
    [{ status: "ok", data: { user: { username: "tash.cards" } } }, "instagram_public_profile_timeline_malformed"],
    [payloadFor("tash.cards", [{ shortcode: "NO_TIMESTAMP", display_url: "https://cdn.example/a.jpg" }]), "instagram_public_profile_edge_malformed"],
    [payloadFor("tash.cards", [mediaNode({ overrides: { owner: null } })]), "instagram_public_profile_edge_malformed"],
    [payloadFor("tash.cards", [mediaNode({ overrides: { owner: { username: "bad username" } } })]), "instagram_public_profile_edge_malformed"],
    [payloadFor("tash.cards", [mediaNode({ overrides: { owner: { username: "@_heyclicky" } } })]), "instagram_public_profile_edge_malformed"],
    [payloadFor("tash.cards", [mediaNode({ overrides: { coauthor_producers: [{ username: "bad username" }] } })]), "instagram_public_profile_edge_malformed"],
    [payloadFor("tash.cards", [mediaNode({ displayUrl: "javascript:alert(1)" })]), "instagram_public_profile_edge_malformed"],
    [payloadFor("tash.cards", [mediaNode({ overrides: { edge_media_preview_like: { count: -1 } } })]), "instagram_public_profile_edge_malformed"]
  ];

  for (const [payload, reason] of cases) {
    const result = parseInstagramPublicProfileResponse({
      payload,
      requestedUsername: "tash.cards",
      fetchedAt
    });
    assert.equal(result.verified, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.posts, []);
  }

  const oversized = parseInstagramPublicProfileResponse({
    payload: "x".repeat(4_000_001),
    requestedUsername: "tash.cards",
    fetchedAt
  });
  assert.equal(oversized.verified, false);
  assert.equal(oversized.reason, "instagram_public_profile_payload_malformed");
});

test("classifies challenge, rate-limit, auth, and generic API failures before parsing", () => {
  const cases = [
    [
      { status: "fail", message: "challenge_required", challenge: { url: "/challenge/" } },
      "instagram_public_profile_challenge"
    ],
    [
      { status: "fail", status_code: 429, message: "Please wait a few minutes" },
      "instagram_public_profile_rate_limited"
    ],
    [
      { status: "fail", login_required: true, message: "login required" },
      "instagram_public_profile_auth_required"
    ],
    [
      { status: "fail", message: "Unexpected server response" },
      "instagram_public_profile_api_error"
    ]
  ];

  for (const [payload, reason] of cases) {
    const result = parseInstagramPublicProfileResponse({
      payload,
      requestedUsername: "tash.cards",
      fetchedAt
    });
    assert.equal(result.verified, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.posts, []);
  }
});

test("caps processed edges at fifty while reporting the full response window", () => {
  const edges = Array.from({ length: 51 }, (_, index) => mediaNode({
    shortcode: `POST_${index}`,
    displayUrl: `https://cdn.example/${index}.jpg`
  }));
  const result = parseInstagramPublicProfileResponse({
    payload: payloadFor("tash.cards", edges),
    requestedUsername: "tash.cards",
    fetchedAt
  });

  assert.equal(result.verified, true);
  assert.equal(result.receivedEdgeCount, 51);
  assert.equal(result.processedEdgeCount, 50);
  assert.equal(result.posts.length, 50);
  assert.equal(result.truncated, true);
});

test("requires a valid deterministic fetchedAt value", () => {
  const result = parseInstagramPublicProfileResponse({
    payload: payloadFor("tash.cards", [mediaNode()]),
    requestedUsername: "tash.cards",
    fetchedAt: "not-a-date"
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, "instagram_public_profile_input_invalid");
  assert.deepEqual(result.posts, []);
});
