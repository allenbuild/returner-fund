import { describe, expect, it } from "vitest";
import { buildLeakageSafeSplits, type V5CanonicalObservation } from "@/lib/scoring/v5";

describe("scoring v5 leakage-safe splits", () => {
  const splitSpec = {
    trainStart: "2025-01-01T00:00:00.000Z",
    trainEnd: "2025-12-31T23:59:59.999Z",
    validationEnd: "2026-03-31T23:59:59.999Z",
    testEnd: "2026-06-30T23:59:59.999Z",
    groupByEntity: true as const,
    groupByBatch: true
  };

  it("excludes an entity and batch that cross temporal boundaries", () => {
    const rows = [
      canonical("train", "shared-entity", "shared-batch", "2025-10-10T00:00:00.000Z"),
      canonical("validation", "shared-entity", "other-batch", "2026-02-10T00:00:00.000Z"),
      canonical("test", "test-entity", "shared-batch", "2026-05-10T00:00:00.000Z"),
      canonical("safe", "safe-entity", "safe-batch", "2025-11-10T00:00:00.000Z")
    ];
    const split = buildLeakageSafeSplits(rows, splitSpec);
    expect(split.assignments.map((item) => item.rowId)).toEqual(["safe"]);
    expect(split.exclusions).toEqual([
      { entityId: "shared-entity", reason: "entity_crosses_temporal_boundaries" },
      { entityId: "test-entity", reason: "batch_crosses_temporal_boundaries" }
    ]);
  });

  it("makes split hashes independent of source order", () => {
    const rows = [
      canonical("a", "a", "train", "2025-10-10T00:00:00.000Z"),
      canonical("b", "b", "validation", "2026-02-10T00:00:00.000Z"),
      canonical("c", "c", "test", "2026-05-10T00:00:00.000Z")
    ];
    const forward = buildLeakageSafeSplits(rows, splitSpec);
    const reverse = buildLeakageSafeSplits([...rows].reverse(), splitSpec);
    expect(reverse.assignments).toEqual(forward.assignments);
    expect(reverse.splitHash).toBe(forward.splitHash);
  });

  it("allows known entities in primary temporal periods while marking one stable unseen holdout", () => {
    const temporalSpec = { ...splitSpec, groupByEntity: false, groupByBatch: false };
    const rows = [
      canonical("known-train", "known-entity", "train", "2025-10-10T00:00:00.000Z"),
      canonical("known-validation", "known-entity", "validation", "2026-02-10T00:00:00.000Z")
    ];
    const split = buildLeakageSafeSplits(rows, temporalSpec);
    expect(split.assignments).toHaveLength(2);
    expect(new Set(split.assignments.map((item) => item.unseenEntityHoldout)).size).toBe(1);
  });

  it("excludes content-fingerprint duplicates that would cross temporal splits", () => {
    const temporalSpec = { ...splitSpec, groupByEntity: false, groupByBatch: false };
    const train = canonical("crosspost-a", "entity-a", "train", "2025-10-10T00:00:00.000Z");
    const validation = canonical(
      "crosspost-b",
      "entity-b",
      "validation",
      "2026-02-10T00:00:00.000Z"
    );
    train.contentFingerprint = "shared-content";
    validation.contentFingerprint = "shared-content";
    const split = buildLeakageSafeSplits([train, validation], temporalSpec);
    expect(split.assignments).toEqual([]);
    expect(split.exclusions.every((item) => item.reason.includes("content_fingerprint"))).toBe(true);
  });
});

function canonical(
  rowId: string,
  entityId: string,
  batchId: string,
  outcomeObservedAt: string
): V5CanonicalObservation {
  return {
    rowId,
    sourceId: "fixture",
    sourceRevision: "fixture-v2",
    sourceArtifactSha256: "a".repeat(64),
    sourceRowId: rowId,
    canonicalPostId: `post-${rowId}`,
    contentFingerprint: `content-${rowId}`,
    platform: "x",
    entityId,
    batchId,
    observationAt: outcomeObservedAt,
    publishedAt: new Date(Date.parse(outcomeObservedAt) - 24 * 3_600_000).toISOString(),
    publishedAtPrecision: "exact",
    outcomeObservedAt: new Date(Date.parse(outcomeObservedAt) + 168 * 3_600_000).toISOString(),
    collectorWaveId: `wave-${outcomeObservedAt.slice(0, 7)}`,
    horizonHours: 168,
    toleranceHours: 12,
    postAgeHours: 24,
    metrics: { likes: 1, views: 10 },
    metricObservedAt: { likes: outcomeObservedAt, views: outcomeObservedAt },
    targetMetric: "views",
    targetValueAtObservation: 10,
    targetValueAtOutcome: 11,
    growth: Math.log1p(11) - Math.log1p(10)
  };
}
