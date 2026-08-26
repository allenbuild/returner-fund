import { describe, expect, it } from "vitest";

import {
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

describe("native link receipt attestation", () => {
  it("promotes a canonical X status only when its owner, ID, timestamps, and metric receipt agree", () => {
    const input = verifiedXInput();

    expect(hasVerifiedNativeLinkReceipt(input)).toBe(true);
    expect(nativeLinkStatusFromVerifiedReceipt(input)).toBe("verified");
    expect(nativeLinkStatusFromVerifiedReceipt({ ...input, publishedAtPrecision: "exact" })).toBe("verified");
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

  it("never upgrades an explicit invalid or blocked link", () => {
    const input = verifiedXInput();

    expect(nativeLinkStatusFromVerifiedReceipt({ ...input, linkStatus: "invalid" })).toBe("invalid");
    expect(nativeLinkStatusFromVerifiedReceipt({ ...input, linkStatus: "blocked" })).toBe("blocked");
  });
});
