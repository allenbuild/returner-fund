import assert from "node:assert/strict";
import test from "node:test";

import {
  instagramPublicProfileRequest,
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
  assert.equal(result.posts[0].mediaUrls.length, 21);
  assert.ok(result.posts[0].mediaUrls.every((url) => !url.includes("secret")));
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
