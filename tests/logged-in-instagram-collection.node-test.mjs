import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalInstagramPostUrl,
  instagramAdapterProfileIdentityDecision,
  instagramBrowserProfileIdentityDecision,
  instagramCircuitDecision,
  instagramCollectionAttemptState,
  instagramDetailObservationMatchesMeta,
  instagramEvidenceProvenance,
  instagramFailureKind,
  instagramMetaDescriptionFields,
  instagramPostIdFromUrl,
  instagramRecencyDecision,
  instagramTargetIsVerifiedForIngestion,
  mergeVerifiedSocialAccountCandidates,
  normalizeInstagramDetailObservation,
  prioritizeInstagramTargets
} from "../scripts/lib/logged-in-instagram-collection.mjs";

describe("logged-in Instagram collection", () => {
  it("extracts native post, reel, and TV shortcodes only", () => {
    assert.equal(
      instagramPostIdFromUrl("https://www.instagram.com/p/ABC_123/?utm_source=test"),
      "ABC_123"
    );
    assert.equal(
      instagramPostIdFromUrl("https://instagram.com/reel/XYZ-9/"),
      "XYZ-9"
    );
    assert.equal(
      instagramPostIdFromUrl("https://instagram.com/tv/TV42/"),
      "TV42"
    );
    assert.equal(
      instagramPostIdFromUrl("https://instagram.com/example/"),
      null
    );
    assert.equal(
      canonicalInstagramPostUrl("https://instagram.com.evil.example/p/ABC_123/"),
      null
    );
    assert.equal(
      canonicalInstagramPostUrl("https://instagram.com/example/p/ABC_123/"),
      null
    );
  });

  it("joins adapter, grid, and detail provenance by exact shortcode without positional fallback", () => {
    const post = {
      url: "https://www.instagram.com/reel/RIGHT_1/",
      caption: "adapter caption",
      likes: 12
    };
    const wrongGridItem = {
      href: "https://www.instagram.com/reel/WRONG_1/",
      caption: "wrong caption",
      likes: 999_999
    };
    const rightGridItem = {
      href: "https://www.instagram.com/reel/RIGHT_1/",
      caption: "right caption",
      likes: 13
    };
    const wrongDetail = {
      url: "https://www.instagram.com/reel/WRONG_1/",
      caption: "wrong detail",
      likes: 888_888
    };
    const rightDetail = {
      url: "https://www.instagram.com/reel/RIGHT_1/",
      caption: "right detail",
      likes: 14
    };

    assert.deepEqual(
      instagramEvidenceProvenance({
        post,
        gridItems: [wrongGridItem, rightGridItem],
        detailItems: [wrongDetail, rightDetail]
      }),
      {
        sourceUrl: "https://www.instagram.com/reel/RIGHT_1/",
        platformPostId: "RIGHT_1",
        gridItem: rightGridItem,
        detail: rightDetail
      }
    );
    assert.equal(
      instagramEvidenceProvenance({
        post: { caption: "no native identity", likes: 100 },
        gridItems: [wrongGridItem]
      }),
      null
    );
  });

  it("treats the canonical meta description as authoritative over adjacent modal JSON", () => {
    const description =
      '2,418 likes, 81 comments - farza954 on July 8, 2026: "The source reel caption."';

    assert.deepEqual(instagramMetaDescriptionFields(description), {
      caption: "The source reel caption.",
      dateLabel: "July 8, 2026",
      likes: 2_418,
      comments: 81,
      views: null
    });
    assert.deepEqual(
      normalizeInstagramDetailObservation({
        description,
        caption: "Caption from an adjacent modal post",
        dateLabel: "2026-07-11T00:00:00.000Z",
        likes: 4_675,
        comments: 42,
        views: 99_000
      }),
      {
        description,
        caption: "The source reel caption.",
        dateLabel: "July 8, 2026",
        likes: 2_418,
        comments: 81,
        views: 99_000
      }
    );
  });

  it("parses compact Instagram metrics and falls back field-by-field", () => {
    assert.deepEqual(
      normalizeInstagramDetailObservation({
        description:
          '1.2M views, 10.6K likes - founder on June 4, 2026: "Launch day"',
        comments: 17
      }),
      {
        description:
          '1.2M views, 10.6K likes - founder on June 4, 2026: "Launch day"',
        caption: "Launch day",
        dateLabel: "June 4, 2026",
        likes: 10_600,
        comments: 17,
        views: 1_200_000
      }
    );
  });

  it("preserves newer exact metrics when the detail caption matches canonical metadata", () => {
    const detail = {
      description:
        '293 likes, 12 comments - mirrormirror.ai on June 9, 2026: "Introducing Digital Twin Studio!"',
      caption: "Introducing Digital Twin Studio!",
      dateLabel: "2026-06-10T13:31:09.000Z",
      likes: 398,
      comments: 16
    };

    assert.equal(instagramDetailObservationMatchesMeta(detail), true);
    assert.deepEqual(normalizeInstagramDetailObservation(detail), {
      ...detail,
      views: null
    });
    assert.equal(
      instagramDetailObservationMatchesMeta({
        ...detail,
        caption: "Caption from an adjacent modal card"
      }),
      false
    );
  });

  it("uses an explicit adapter shortcode only when the browser independently proves the same post", () => {
    const matchingGridItem = {
      href: "https://www.instagram.com/p/CODE_42/",
      caption: "visible grid caption"
    };
    assert.deepEqual(
      instagramEvidenceProvenance({
        post: { shortcode: "CODE_42", caption: "adapter caption" },
        gridItems: [matchingGridItem]
      }),
      {
        sourceUrl: "https://www.instagram.com/p/CODE_42/",
        platformPostId: "CODE_42",
        gridItem: matchingGridItem,
        detail: null
      }
    );
    assert.equal(
      instagramEvidenceProvenance({
        post: { shortcode: "CODE_42", caption: "adapter caption" },
        gridItems: []
      }),
      null
    );
  });

  it("fails closed unless the adapter profile proves the exact verified handle", () => {
    assert.deepEqual(
      instagramAdapterProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        profile: { username: "_heyclicky" },
        targetVerified: true
      }),
      { ok: true, reason: "verified_exact_profile_handle" }
    );
    assert.equal(
      instagramAdapterProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        profile: { username: "somebody_else" },
        targetVerified: true
      }).ok,
      false
    );
    assert.equal(
      instagramAdapterProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        profile: null,
        targetVerified: true
      }).ok,
      false
    );
    assert.equal(
      instagramAdapterProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        profile: { username: "_heyclicky" },
        targetVerified: false
      }).ok,
      false
    );
  });

  it("requires final browser URL plus visible or canonical exact profile identity", () => {
    assert.deepEqual(
      instagramBrowserProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        currentUrl: "https://www.instagram.com/_heyclicky/",
        canonicalUrl: "https://www.instagram.com/_heyclicky/",
        visibleHandles: ["heyclicky (@_heyclicky)"]
      }),
      { ok: true, reason: "verified_browser_profile_identity" }
    );
    assert.equal(
      instagramBrowserProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        currentUrl: "https://www.instagram.com/explore/",
        canonicalUrl: "https://www.instagram.com/_heyclicky/",
        visibleHandles: ["@_heyclicky"]
      }).ok,
      false
    );
    assert.equal(
      instagramBrowserProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        currentUrl: "https://www.instagram.com/_heyclicky/",
        visibleHandles: []
      }).ok,
      false
    );
    assert.equal(
      instagramBrowserProfileIdentityDecision({
        requestedHandle: "_heyclicky",
        currentUrl: "https://www.instagram.com/_heyclicky/",
        visibleHandles: ["@_heyclicky"],
        loginWall: true
      }).ok,
      false
    );
  });

  it("accepts only explicitly verified target mappings", () => {
    assert.equal(
      instagramTargetIsVerifiedForIngestion({
        account: { review_state: "verified" }
      }),
      true
    );
    assert.equal(
      instagramTargetIsVerifiedForIngestion({
        matchReason:
          "The exact official company website links directly to this native Instagram company profile."
      }),
      true
    );
    assert.equal(
      instagramTargetIsVerifiedForIngestion({
        matchReason: "OpenCLI Instagram search found an exact company handle."
      }),
      false
    );
    assert.equal(
      instagramTargetIsVerifiedForIngestion({
        matchReason: "No verification metadata was supplied."
      }),
      false
    );
  });

  it("preserves structured verification when duplicate plain links are merged", () => {
    assert.deepEqual(
      mergeVerifiedSocialAccountCandidates([
        {
          platform: "instagram",
          url: "https://www.instagram.com/example/",
          review_state: "verified",
          matchReason: "Verified graph account"
        },
        {
          platform: "instagram",
          url: "https://www.instagram.com/example/"
        }
      ]),
      [
        {
          platform: "instagram",
          url: "https://www.instagram.com/example/",
          review_state: "verified",
          matchReason: "Verified graph account"
        }
      ]
    );
  });

  it("rejects missing, invalid, and stale publication dates instead of silently passing them", () => {
    const cutoff = Date.parse("2025-01-01T00:00:00.000Z");
    assert.deepEqual(
      instagramRecencyDecision(null, cutoff),
      { eligible: false, reason: "missing_publication_date" }
    );
    assert.deepEqual(
      instagramRecencyDecision("not-a-date", cutoff),
      { eligible: false, reason: "invalid_publication_date" }
    );
    assert.deepEqual(
      instagramRecencyDecision("2024-12-31T23:59:59.000Z", cutoff),
      { eligible: false, reason: "before_recency_cutoff" }
    );
    assert.deepEqual(
      instagramRecencyDecision("2026-07-29T00:00:00.000Z", cutoff),
      { eligible: true, reason: "within_recency_window" }
    );
  });

  it("classifies Instagram auth, challenge, rate-limit, and command/profile failures", () => {
    assert.equal(
      instagramFailureKind(
        "Instagram browser grid extractor failed: login_wall"
      ),
      "auth"
    );
    assert.equal(
      instagramFailureKind(
        "Instagram browser profile identity was not proven: challenge_page"
      ),
      "challenge"
    );
    assert.equal(
      instagramFailureKind("HTTP 429 Too Many Requests"),
      "rate_limited"
    );
    assert.equal(
      instagramFailureKind(
        "Instagram profile adapter failed: command timed out"
      ),
      "command_or_profile"
    );
    assert.equal(
      instagramFailureKind(
        "No scored recent Instagram posts found with adapter or browser grid/detail extractor."
      ),
      "empty"
    );
  });

  it("fails closed on systemic reads while preserving legitimate empty native timelines", () => {
    assert.deepEqual(
      instagramCollectionAttemptState({
        evidenceCount: 0,
        completedTimelineSourceCount: 2,
        profileIdentityOk: true,
        failureMessages: [
          "No scored recent Instagram posts found with adapter or browser grid/detail extractor."
        ]
      }),
      {
        status: "done",
        collectionFailed: false,
        failureKind: "empty"
      }
    );
    assert.deepEqual(
      instagramCollectionAttemptState({
        evidenceCount: 0,
        completedTimelineSourceCount: 0,
        profileIdentityOk: true,
        failureMessages: [
          "Instagram user adapter failed: command timed out",
          "Instagram browser grid extractor failed: command timed out"
        ]
      }),
      {
        status: "failed",
        collectionFailed: true,
        failureKind: "command_or_profile"
      }
    );
    assert.deepEqual(
      instagramCollectionAttemptState({
        evidenceCount: 12,
        completedTimelineSourceCount: 1,
        profileIdentityOk: true,
        failureMessages: [
          "Instagram browser grid extractor failed: challenge_page"
        ]
      }),
      {
        status: "failed",
        collectionFailed: true,
        failureKind: "challenge"
      }
    );
    assert.equal(
      instagramCollectionAttemptState({
        evidenceCount: 0,
        completedTimelineSourceCount: 2,
        profileIdentityOk: false,
        failureMessages: ["profile_handle_mismatch"]
      }).collectionFailed,
      true
    );
  });

  it("opens the Instagram circuit immediately for auth/challenge/rate limits and after three command failures", () => {
    for (const failureKind of ["auth", "challenge", "rate_limited"]) {
      assert.deepEqual(
        instagramCircuitDecision({
          consecutiveFailures: 1,
          maxConsecutiveFailures: 3,
          failureKind
        }),
        { open: true, reason: failureKind }
      );
    }
    assert.deepEqual(
      instagramCircuitDecision({
        consecutiveFailures: 2,
        maxConsecutiveFailures: 3,
        failureKind: "command_or_profile"
      }),
      { open: false, reason: null }
    );
    assert.deepEqual(
      instagramCircuitDecision({
        consecutiveFailures: 3,
        maxConsecutiveFailures: 3,
        failureKind: "command_or_profile"
      }),
      { open: true, reason: "consecutive_failures" }
    );
  });

  it("prioritizes failed zero/low native coverage without counting profile rows or duplicates", () => {
    const targets = [
      target("covered", "https://instagram.com/covered/"),
      target("zero", "https://instagram.com/zero/"),
      target("failed", "https://instagram.com/failed/")
    ];
    const attempts = new Map([
      ["S26:instagram:failed:https://instagram.com/failed/", {
        status: "failed",
        checkedAt: "2026-07-29T00:00:00.000Z"
      }]
    ]);
    const evidence = [
      row("covered", "https://instagram.com/p/ONE/"),
      row("covered", "https://instagram.com/p/ONE/?duplicate=1"),
      row("covered", "https://instagram.com/p/TWO/"),
      row("zero", "https://instagram.com/zero/")
    ];

    assert.deepEqual(
      prioritizeInstagramTargets(targets, {
        evidence,
        attempts,
        attemptKey: (item) =>
          `${item.batchSlug}:${item.platform}:${item.entityId}:${item.url}`
      }).map((item) => item.entityId),
      ["failed", "zero", "covered"]
    );
  });
});

function target(entityId, url) {
  return {
    batchSlug: "S26",
    platform: "instagram",
    entityId,
    url
  };
}

function row(entityId, sourceUrl) {
  return {
    batchSlug: "S26",
    platform: "instagram",
    entityId,
    sourceUrl
  };
}
