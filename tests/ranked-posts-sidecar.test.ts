import { describe, expect, it } from "vitest";
import {
  RANKED_POSTS_SIDECAR_VERSION,
  rankedPostsSidecarSnapshot
} from "@/lib/graph/ranked-posts-sidecar";

describe("Ranked Posts full-corpus sidecar", () => {
  it("publishes complete digest and count metadata for every cohort/audience scope", () => {
    expect(rankedPostsSidecarSnapshot.version).toBe(RANKED_POSTS_SIDECAR_VERSION);
    expect(rankedPostsSidecarSnapshot.canonicalParity.fullRankableCount).toBeGreaterThan(0);
    expect(rankedPostsSidecarSnapshot.canonicalParity.representedRankableCount)
      .toBe(rankedPostsSidecarSnapshot.canonicalParity.fullRankableCount);
    expect(
      rankedPostsSidecarSnapshot.canonicalParity.previewRankableCount +
        rankedPostsSidecarSnapshot.canonicalParity.overflowRankableCount
    ).toBe(rankedPostsSidecarSnapshot.canonicalParity.fullRankableCount);
    expect(rankedPostsSidecarSnapshot.canonicalParity.previewRankableDigest)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(rankedPostsSidecarSnapshot.canonicalParity.representedRankableDigest)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(rankedPostsSidecarSnapshot.canonicalParity.representedRankableDigest)
      .toBe(rankedPostsSidecarSnapshot.canonicalParity.fullRankableDigest);
    if (rankedPostsSidecarSnapshot.canonicalParity.overflowRankableCount > 0) {
      expect(rankedPostsSidecarSnapshot.canonicalParity.previewRankableDigest)
        .not.toBe(rankedPostsSidecarSnapshot.canonicalParity.fullRankableDigest);
    }
    expect(rankedPostsSidecarSnapshot.canonicalParity.crossAudiencePreviewProjectionKeys)
      .toHaveLength(rankedPostsSidecarSnapshot.canonicalParity.crossAudiencePreviewProjectionCount);
    expect(new Set(rankedPostsSidecarSnapshot.canonicalParity.crossAudiencePreviewProjectionKeys).size)
      .toBe(rankedPostsSidecarSnapshot.canonicalParity.crossAudiencePreviewProjectionCount);
    const scopes = Object.values(rankedPostsSidecarSnapshot.batches)
      .flatMap((batch) => Object.values(batch))
      .filter((scope) => scope !== undefined);

    expect(scopes).toHaveLength(9);
    for (const scope of scopes) {
      expect(scope.sourceEvidenceCount).toBeGreaterThanOrEqual(scope.fullRankableCount);
      expect(scope.previewEvidenceCount).toBeGreaterThanOrEqual(scope.previewRankableCount);
      expect(scope.overflowRankableCount).toBe(scope.evidence.length);
      expect(scope.representedRankableDigest).toBe(scope.fullRankableDigest);
      expect(scope.fullRankableDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(scope.crossAudiencePreviewProjectionCount)
        .toBe(scope.crossAudiencePreviewProjectionKeys.length);
    }
  });
});
