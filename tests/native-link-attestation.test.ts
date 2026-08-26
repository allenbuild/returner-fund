import { describe, expect, it } from "vitest";

import {
  exactNativePublicationDateFromVerifiedReceipt,
  hasVerifiedNativeLinkReceipt,
  nativeLinkStatusFromVerifiedReceipt,
  type NativeLinkAttestationInput
} from "@/lib/graph/native-link-attestation";

const X_POSTED_AT = "2026-08-23T03:46:00.000Z";
const X_CHECKED_AT = "2026-08-24T13:29:29.110Z";

function verifiedXInput(): NativeLinkAttestationInput {
  return {
    platform: "x",
    sourceUrl: "https://x.com/aidantiruvan/status/2091371352544674215",
    platformPostId: "2091371352544674215",
    postedAt: X_POSTED_AT,
    review_state: "verified",
    linkStatus: null,
    entityType: "founder",
    entityId: "founder-archal-aidan-tiruvan-2037605",
    batchSlug: "S26",
    authorHandle: "aidantiruvan",
    attributionVersion: 3,
    attributionStatus: "verified",
    attributionProvenance: "x_public_profile_schema_org_exact_owner_v1",
    nativeAuthorResolution: {
      status: "matched",
      author: { platform: "x", key: "aidantiruvan" },
      owner: {
        batchSlug: "S26",
        entityType: "founder",
        entityId: "founder-archal-aidan-tiruvan-2037605"
      }
    },
    rawVisibleText: JSON.stringify({
      source: "x_native_evidence_reconciled_v1",
      primary: {
        id: "2091371352544674215",
        sourceUrl: "https://x.com/aidantiruvan/status/2091371352544674215",
        authorHandle: "aidantiruvan",
        postedAt: X_POSTED_AT,
        attributionProvenance: "x_public_profile_schema_org_exact_owner_v1"
      },
      metricReceipt: {
        source: "x_native_metric_reconciliation_v1",
        nativePostId: "2091371352544674215",
        timestampConflict: false,
        observedTimestamps: [X_POSTED_AT],
        observations: [{
          source: "x_public_profile_schema_org_exact_owner_v1",
          checkedAt: X_CHECKED_AT,
          postedAt: X_POSTED_AT,
          metrics: { views: 111_800 }
        }]
      }
    })
  };
}

function verifiedYouTubeInput(): NativeLinkAttestationInput {
  return {
    platform: "youtube",
    sourceUrl: "https://youtube.com/watch?v=Tbd_RvuY04s",
    platformPostId: "Tbd_RvuY04s",
    postedAt: "2026-08-23T23:14:47.000Z",
    review_state: "verified",
    linkStatus: null,
    entityType: "company",
    entityId: "a16z-speedrun-006-sun",
    batchSlug: "A16ZSR006",
    accountUrl: "https://www.youtube.com/@getsunapp",
    attributionVersion: 3,
    attributionStatus: "verified",
    attributionProvenance: "youtube_official_atom_feed",
    rawVisibleText: JSON.stringify({
      schemaVersion: 1,
      collector: "historical-depth-backfill",
      platform: "youtube",
      batchSlug: "A16ZSR006",
      entityType: "company",
      entityId: "a16z-speedrun-006-sun",
      accountUrl: "https://youtube.com/@getsunapp",
      externalId: "youtube:Tbd_RvuY04s",
      nativeId: "Tbd_RvuY04s",
      sourceUrl: "https://www.youtube.com/watch?v=Tbd_RvuY04s",
      canonicalUrl: "https://www.youtube.com/watch?v=Tbd_RvuY04s",
      publishedAt: "2026-08-23T23:14:47.000Z",
      attribution: {
        status: "verified",
        method: "verified_channel_id_and_official_youtube_atom_feed",
        accountUrl: "https://youtube.com/@getsunapp",
        nativeChannelId: "UCDiqJ8cEQJzh55N5x0Evt3w"
      },
      discoveryMethod: "youtube_official_atom_feed"
    })
  };
}

function verifiedInstagramInput(
  receiptSource = "instagram_anonymous_native_feed_standalone_v1"
): NativeLinkAttestationInput {
  const postedAt = "2026-08-24T01:02:36.000Z";
  const fetchedAt = "2026-08-24T13:40:08.414Z";
  const nativeFeedFetchedAt = receiptSource === "instagram_anonymous_native_feed_standalone_v1"
    ? fetchedAt
    : "2026-08-24T13:40:12.918Z";
  return {
    platform: "instagram",
    sourceUrl: "https://instagram.com/reel/DcZ1Y7qSy_I",
    platformPostId: "DcZ1Y7qSy_I",
    postedAt,
    publishedAtPrecision: "exact",
    review_state: "verified",
    linkStatus: null,
    entityType: "company",
    entityId: "a16z-speedrun-006-snag",
    batchSlug: "A16ZSR006",
    accountUrl: "https://instagram.com/snagsubletsnyc",
    authorHandle: "snagsubletsnyc",
    attributionVersion: 3,
    attributionStatus: "verified",
    attributionProvenance: "instagram_anonymous_native_feed_native_owner_v1",
    nativeAuthorResolution: {
      status: "matched",
      author: { platform: "instagram", key: "snagsubletsnyc" },
      owner: {
        batchSlug: "A16ZSR006",
        entityType: "company",
        entityId: "a16z-speedrun-006-snag"
      }
    },
    rawVisibleText: JSON.stringify({
      receipt: {
        source: receiptSource,
        username: "snagsubletsnyc",
        accountUrl: "https://www.instagram.com/snagsubletsnyc/",
        fetchedAt,
        totalCount: 500,
        receivedEdgeCount: 12,
        processedEdgeCount: 12,
        nativeFeed: {
          source: "instagram_anonymous_native_feed_v1",
          fetchedAt: nativeFeedFetchedAt,
          receivedItemCount: 504,
          uniqueItemCount: 500
        }
      },
      post: {
        shortcode: "DcZ1Y7qSy_I",
        url: "https://www.instagram.com/reel/DcZ1Y7qSy_I/",
        authorUsername: "snagsubletsnyc",
        profileRole: "primary",
        postedAt,
        nativeFeedOnly: true,
        nativeFeedMetricSource: "instagram_anonymous_native_feed_v1"
      }
    })
  };
}

describe("native link receipt attestation", () => {
  it("promotes a canonical X status only when its owner, ID, timestamps, and metric receipt agree", () => {
    const input = verifiedXInput();

    expect(hasVerifiedNativeLinkReceipt(input)).toBe(true);
    expect(nativeLinkStatusFromVerifiedReceipt(input)).toBe("verified");
    expect(nativeLinkStatusFromVerifiedReceipt({ ...input, publishedAtPrecision: "exact" })).toBe("verified");
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...input,
      publishedAtPrecision: "unknown"
    })).toEqual({
      postedAt: X_POSTED_AT,
      publishedAtPrecision: "exact"
    });
  });

  it("fails closed for X identity, owner, timestamp, and receipt conflicts", () => {
    const input = verifiedXInput();
    const receipt = JSON.parse(String(input.rawVisibleText));

    expect(hasVerifiedNativeLinkReceipt({ ...input, platformPostId: "2091371352544674216" })).toBe(false);
    expect(hasVerifiedNativeLinkReceipt({
      ...input,
      nativeAuthorResolution: {
        ...input.nativeAuthorResolution,
        owner: { ...input.nativeAuthorResolution?.owner, entityId: "founder-someone-else" }
      }
    })).toBe(false);
    expect(hasVerifiedNativeLinkReceipt({ ...input, publishedAtPrecision: "unknown" })).toBe(false);
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...input,
      publishedAtPrecision: "unknown",
      sourceUrl: "https://x.com/aidantiruvan/status/2091371352544674216"
    })).toBeNull();
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...input,
      publishedAtPrecision: "unknown",
      rawVisibleText: JSON.stringify({ postedAt: input.postedAt })
    })).toBeNull();
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...input,
      publishedAtPrecision: "unknown",
      authorHandle: null
    })).toBeNull();
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...input,
      publishedAtPrecision: "unknown",
      authorHandle: "different_author"
    })).toBeNull();
    expect(hasVerifiedNativeLinkReceipt({
      ...input,
      rawVisibleText: JSON.stringify({
        ...receipt,
        metricReceipt: { ...receipt.metricReceipt, timestampConflict: true }
      })
    })).toBe(false);
  });

  it("promotes an official YouTube Atom item with an exact matching native receipt", () => {
    const input = verifiedYouTubeInput();

    expect(hasVerifiedNativeLinkReceipt(input)).toBe(true);
    expect(nativeLinkStatusFromVerifiedReceipt(input)).toBe("verified");
  });

  it("does not promote generic YouTube search evidence or invent a publication date", () => {
    const input = verifiedYouTubeInput();

    expect(hasVerifiedNativeLinkReceipt({
      ...input,
      postedAt: null,
      rawVisibleText: "How Tasklet Puts the Agency in Agents 1,613,079 views"
    })).toBe(false);
    expect(hasVerifiedNativeLinkReceipt({
      ...input,
      rawVisibleText: JSON.stringify({
        collector: "youtube-search",
        platform: "youtube",
        nativeId: "Tbd_RvuY04s"
      })
    })).toBe(false);
  });

  it("promotes exact primary-owner Instagram posts from either canonical native-feed receipt", () => {
    const standalone = verifiedInstagramInput();
    const profileInfo = verifiedInstagramInput(
      "instagram_public_web_profile_info_with_native_feed_metrics_v1"
    );

    expect(hasVerifiedNativeLinkReceipt(standalone)).toBe(true);
    expect(nativeLinkStatusFromVerifiedReceipt(standalone)).toBe("verified");
    expect(hasVerifiedNativeLinkReceipt(profileInfo)).toBe(true);
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...standalone,
      publishedAtPrecision: "unknown"
    })).toEqual({
      postedAt: "2026-08-24T01:02:36.000Z",
      publishedAtPrecision: "exact"
    });
  });

  it("recovers profile-receipt dates without trusting ISO shape alone", () => {
    const input = verifiedInstagramInput(
      "instagram_public_web_profile_info_with_native_feed_metrics_v1"
    );
    const payload = JSON.parse(String(input.rawVisibleText));
    const profileInput: NativeLinkAttestationInput = {
      ...input,
      publishedAtPrecision: "unknown",
      attributionProvenance: "instagram_public_web_profile_info_native_owner_v1",
      rawVisibleText: JSON.stringify({
        ...payload,
        receipt: {
          ...payload.receipt,
          totalCount: 866,
          receivedEdgeCount: 12,
          processedEdgeCount: 12
        },
        post: { ...payload.post, nativeFeedOnly: false }
      })
    };

    expect(exactNativePublicationDateFromVerifiedReceipt(profileInput)).toEqual({
      postedAt: "2026-08-24T01:02:36.000Z",
      publishedAtPrecision: "exact"
    });
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...profileInput,
      platformPostId: "Different_1"
    })).toBeNull();
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...profileInput,
      sourceUrl: "https://instagram.com/reel/Different_1"
    })).toBeNull();
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...profileInput,
      entityId: "a16z-speedrun-006-other"
    })).toBeNull();
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...profileInput,
      accountUrl: "https://instagram.com/another_owner"
    })).toBeNull();
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...profileInput,
      authorHandle: "another_owner"
    })).toBeNull();
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...profileInput,
      attributionProvenance: "instagram_search_result"
    })).toBeNull();
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...profileInput,
      rawVisibleText: JSON.stringify({ postedAt: profileInput.postedAt })
    })).toBeNull();
    expect(exactNativePublicationDateFromVerifiedReceipt({
      ...profileInput,
      rawVisibleText: JSON.stringify({
        ...JSON.parse(String(profileInput.rawVisibleText)),
        post: { ...JSON.parse(String(profileInput.rawVisibleText)).post, postedAt: "2026-08-24T01:02:37.000Z" }
      })
    })).toBeNull();
  });

  it("requires receipt-schema-consistent Instagram collection timestamps", () => {
    const standalone = verifiedInstagramInput();
    const standalonePayload = JSON.parse(String(standalone.rawVisibleText));
    expect(hasVerifiedNativeLinkReceipt({
      ...standalone,
      rawVisibleText: JSON.stringify({
        ...standalonePayload,
        receipt: {
          ...standalonePayload.receipt,
          nativeFeed: {
            ...standalonePayload.receipt.nativeFeed,
            fetchedAt: "2026-08-24T13:40:12.918Z"
          }
        }
      })
    })).toBe(false);

    const profileInfo = verifiedInstagramInput(
      "instagram_public_web_profile_info_with_native_feed_metrics_v1"
    );
    const profileInfoPayload = JSON.parse(String(profileInfo.rawVisibleText));
    expect(hasVerifiedNativeLinkReceipt({
      ...profileInfo,
      rawVisibleText: JSON.stringify({
        ...profileInfoPayload,
        receipt: {
          ...profileInfoPayload.receipt,
          nativeFeed: {
            ...profileInfoPayload.receipt.nativeFeed,
            fetchedAt: "2026-08-24T13:40:04.918Z"
          }
        }
      })
    })).toBe(false);
  });

  it("fails closed for Instagram native ID, author, owner, timestamp, and receipt conflicts", () => {
    const input = verifiedInstagramInput();
    const payload = JSON.parse(String(input.rawVisibleText));

    expect(hasVerifiedNativeLinkReceipt({ ...input, platformPostId: "Different_1" })).toBe(false);
    expect(hasVerifiedNativeLinkReceipt({
      ...input,
      rawVisibleText: JSON.stringify({
        ...payload,
        post: { ...payload.post, authorUsername: "another_owner" }
      })
    })).toBe(false);
    expect(hasVerifiedNativeLinkReceipt({
      ...input,
      nativeAuthorResolution: {
        ...input.nativeAuthorResolution,
        owner: { ...input.nativeAuthorResolution?.owner, entityId: "a16z-speedrun-006-other" }
      }
    })).toBe(false);
    expect(hasVerifiedNativeLinkReceipt({
      ...input,
      rawVisibleText: JSON.stringify({
        ...payload,
        post: { ...payload.post, postedAt: "2026-08-24T01:02:37.000Z" }
      })
    })).toBe(false);
    expect(hasVerifiedNativeLinkReceipt({
      ...input,
      rawVisibleText: JSON.stringify({
        ...payload,
        receipt: { ...payload.receipt, source: "instagram_search_result" }
      })
    })).toBe(false);
  });

  it("never upgrades an explicit invalid or blocked link", () => {
    const input = verifiedXInput();

    expect(nativeLinkStatusFromVerifiedReceipt({ ...input, linkStatus: "invalid" })).toBe("invalid");
    expect(nativeLinkStatusFromVerifiedReceipt({ ...input, linkStatus: "blocked" })).toBe("blocked");
  });
});
