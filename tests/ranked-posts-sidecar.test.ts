import { describe, expect, it } from "vitest";
import {
  RANKED_POSTS_SIDECAR_VERSION,
  rankedPostsSidecarSnapshot
} from "@/lib/graph/ranked-posts-sidecar";

describe("Ranked Posts full-corpus sidecar", () => {
  it("publishes complete digest and count metadata for every cohort/audience scope", () => {
    expect(rankedPostsSidecarSnapshot.version).toBe(RANKED_POSTS_SIDECAR_VERSION);
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
    }
  });
});
