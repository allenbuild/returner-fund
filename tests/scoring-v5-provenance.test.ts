import { describe, expect, it } from "vitest";
import {
  buildCanonicalDataset,
  registeredSourceForContent,
  serializeSourceRows,
  validateInputManifest,
  V5_PREREG_PLATFORM_TARGETS,
  V5_PREREG_SPLIT,
  V5_PREREG_THRESHOLD_DEFINITION,
  type V5InputManifest,
  type V5RawObservation
} from "@/lib/scoring/v5";

describe("scoring v5 registered data", () => {
  it("requires citations, valid licenses, hashes, and rejection reasons", () => {
    const { manifest } = registeredFixture([row("a", "2025-10-10T00:00:00.000Z", 1)]);
    expect(() => validateInputManifest(manifest)).not.toThrow();

    const noCitation = structuredClone(manifest);
    noCitation.sources[0].citation = "";
    expect(() => validateInputManifest(noCitation)).toThrow(/citation/);

    const forbiddenLicense = structuredClone(manifest);
    forbiddenLicense.sources[0].license.permitsResearchUse = false;
    expect(() => validateInputManifest(forbiddenLicense)).toThrow(/permit research use/);

    const rejectedWithoutReason = structuredClone(manifest);
    rejectedWithoutReason.sources[0].status = "rejected";
    rejectedWithoutReason.sources[0].rejectionReason = null;
    expect(() => validateInputManifest(rejectedWithoutReason)).toThrow(/record a reason/);
  });

  it("rejects any target-table, cutoff, or grouping mutation under the frozen protocol id", () => {
    const { manifest } = registeredFixture([row("a", "2026-08-09T00:00:00.000Z", 1)]);
    const targetMutation = structuredClone(manifest);
    targetMutation.target.platformTargets.x!.targetMetric = "likes";
    expect(() => validateInputManifest(targetMutation)).toThrow(/target table.*pre-registration/i);

    const cutoffMutation = structuredClone(manifest);
    cutoffMutation.split.trainStart = "2026-07-22T05:00:00.000Z";
    expect(() => validateInputManifest(cutoffMutation)).toThrow(/split configuration.*pre-registration/i);

    const groupingMutation = structuredClone(manifest);
    groupingMutation.split.groupByEntity = true;
    groupingMutation.split.groupByBatch = true;
    expect(() => validateInputManifest(groupingMutation)).toThrow(/split configuration.*pre-registration/i);
  });

  it("refuses unregistered files and a one-byte source mutation", () => {
    const fixture = registeredFixture([row("a", "2025-10-10T00:00:00.000Z", 1)]);
    expect(() =>
      buildCanonicalDataset(fixture.manifest, {
        ...fixture.files,
        "unregistered.json": "{}"
      })
    ).toThrow(/not registered/);
    expect(() =>
      buildCanonicalDataset(fixture.manifest, {
        "observations.json": `${fixture.files["observations.json"]} `
      })
    ).toThrow(/SHA-256 mismatch/);
  });

  it("deduplicates physical posts and rejects future-horizon feature observations", () => {
    const original = row("a", "2025-10-10T00:00:00.000Z", 1);
    const duplicate = {
      ...original,
      sourceRowId: "z-duplicate",
      metrics: { likes: original.metrics.likes, views: original.targetValueAtObservation }
    };
    const leaked = row("leaked", "2025-10-12T00:00:00.000Z", 1);
    leaked.observationAt = leaked.outcomeObservedAt;
    const fixture = registeredFixture([duplicate, leaked, original]);
    const dataset = buildCanonicalDataset(fixture.manifest, fixture.files);

    expect(dataset.rows).toHaveLength(1);
    expect(dataset.rows[0].sourceRowId).toBe("a");
    expect(dataset.rows[0].metrics.replies).toBeUndefined();
    expect(dataset.rejectedRows.map((item) => item.reason).sort()).toEqual([
      "duplicate_physical_post",
      "outcome_not_after_observation"
    ]);
  });

  it("requires canonical ISO instants and metric observations exactly at t0", () => {
    const dateOnly = row("date-only", "2026-08-09T00:00:00.000Z", 1);
    dateOnly.observationAt = "2026-08-02";
    dateOnly.publishedAt = "2026-08-01";
    dateOnly.outcomeObservedAt = "2026-08-09";
    dateOnly.metricObservedAt = { likes: "2026-08-02", replies: "2026-08-02", views: "2026-08-02" };
    const futureFeature = row("future-feature", "2026-08-09T00:00:00.000Z", 1);
    futureFeature.metricObservedAt.likes = futureFeature.outcomeObservedAt;
    const fixture = registeredFixture([dateOnly, futureFeature]);
    const dataset = buildCanonicalDataset(fixture.manifest, fixture.files);
    expect(dataset.rows).toEqual([]);
    expect(dataset.rejectedRows).toEqual([
      { sourceId: "fixture-source", sourceRowId: "date-only", reason: "invalid_observation_or_outcome_time" },
      { sourceId: "fixture-source", sourceRowId: "future-feature", reason: "feature_observed_after_t0:likes" }
    ]);
  });

  it("quarantines metrics outside the frozen platform namespace", () => {
    const incompatible = row("cross-platform", "2026-08-09T00:00:00.000Z", 1);
    incompatible.metrics.stars = 999;
    incompatible.metricObservedAt.stars = incompatible.observationAt;
    const fixture = registeredFixture([incompatible]);
    const dataset = buildCanonicalDataset(fixture.manifest, fixture.files);
    expect(dataset.rows).toEqual([]);
    expect(dataset.rejectedRows).toEqual([
      {
        sourceId: "fixture-source",
        sourceRowId: "cross-platform",
        reason: "incompatible_platform_metric:stars"
      }
    ]);
  });

  it("quarantines conflicting same-priority t1 outcomes without using growth as precedence", () => {
    const low = row("low-outcome", "2026-08-09T00:00:00.000Z", 0);
    low.canonicalPostId = "shared-post";
    low.contentFingerprint = "shared-content";
    low.entityId = "shared-entity";
    const high = { ...structuredClone(low), sourceRowId: "high-outcome", targetValueAtOutcome: 1_000 };
    const forward = registeredFixture([low, high]);
    const reverse = registeredFixture([high, low]);
    const forwardDataset = buildCanonicalDataset(forward.manifest, forward.files);
    const reverseDataset = buildCanonicalDataset(reverse.manifest, reverse.files);
    expect(forwardDataset.rows).toEqual([]);
    expect(forwardDataset.rejectedRows).toEqual([
      { sourceId: "fixture-source", sourceRowId: "high-outcome", reason: "conflicting_duplicate_t1_outcome" },
      { sourceId: "fixture-source", sourceRowId: "low-outcome", reason: "conflicting_duplicate_t1_outcome" }
    ]);
    expect(reverseDataset).toEqual(forwardDataset);
  });

  it("quarantines conflicting same-priority t0 metrics instead of choosing a value", () => {
    const first = row("first", "2026-08-09T00:00:00.000Z", 0);
    first.canonicalPostId = "shared-post";
    first.contentFingerprint = "shared-content";
    first.entityId = "shared-entity";
    const second = structuredClone(first);
    second.sourceRowId = "second";
    second.metrics.likes = (first.metrics.likes ?? 0) + 1;
    const fixture = registeredFixture([first, second]);
    const dataset = buildCanonicalDataset(fixture.manifest, fixture.files);
    expect(dataset.rows).toEqual([]);
    expect(dataset.rejectedRows).toEqual([
      { sourceId: "fixture-source", sourceRowId: "first", reason: "conflicting_duplicate_t0_metric:likes" },
      { sourceId: "fixture-source", sourceRowId: "second", reason: "conflicting_duplicate_t0_metric:likes" }
    ]);
  });

  it("canonicalizes source row order without changing the training-data hash", () => {
    const rows = [
      row("a", "2025-10-10T00:00:00.000Z", 1),
      row("b", "2026-02-10T00:00:00.000Z", 0),
      row("c", "2026-05-10T00:00:00.000Z", 1)
    ];
    const forward = registeredFixture(rows);
    const reverse = registeredFixture([...rows].reverse());
    const forwardDataset = buildCanonicalDataset(forward.manifest, forward.files);
    const reverseDataset = buildCanonicalDataset(reverse.manifest, reverse.files);
    expect(reverseDataset.rows).toEqual(forwardDataset.rows);
    expect(reverseDataset.datasetHash).toBe(forwardDataset.datasetHash);
  });
});

function registeredFixture(rows: V5RawObservation[]): {
  manifest: V5InputManifest;
  files: Record<string, string>;
} {
  const content = serializeSourceRows(rows);
  const source = registeredSourceForContent(
    {
      id: "fixture-source",
      relativePath: "observations.json",
      schemaVersion: "scoring-v5-observations-v2",
      citation: "Fixture source generated by deterministic unit tests.",
      sourceRevision: "fixture-v1",
      accessedAt: "2026-07-20T00:00:00.000Z",
      license: { id: "CC0-1.0", permitsResearchUse: true, redistribution: "allowed" },
      status: "accepted",
      rejectionReason: null
    },
    content
  );
  return { manifest: manifestWithSources([source]), files: { "observations.json": content } };
}

export function manifestWithSources(sources: V5InputManifest["sources"]): V5InputManifest {
  return {
    schemaVersion: "scoring-v5-input-manifest-v1",
    registeredAt: "2026-07-20T00:00:00.000Z",
    target: {
      id: "returner-post-performance-v5-prereg-2026-07-20",
      description: "Fixture probability target at a fixed future horizon.",
      thresholdDefinition: V5_PREREG_THRESHOLD_DEFINITION,
      platformTargets: structuredClone(V5_PREREG_PLATFORM_TARGETS),
      outcome: "binary_high_performance_at_horizon",
      observationRule: "features_at_or_before_observation_time"
    },
    split: { ...V5_PREREG_SPLIT },
    sources
  };
}

export function row(sourceRowId: string, outcomeObservedAt: string, outcome: 0 | 1): V5RawObservation {
  const outcomeTime = Date.parse(outcomeObservedAt);
  const observationAt = new Date(outcomeTime - 168 * 3_600_000).toISOString();
  const publishedAt = new Date(Date.parse(observationAt) - 24 * 3_600_000).toISOString();
  const targetValueAtObservation = 10;
  const targetValueAtOutcome = outcome ? 1_000 : 11;
  return {
    sourceRowId,
    canonicalPostId: `post-${sourceRowId}`,
    contentFingerprint: `content-${sourceRowId}`,
    platform: "x",
    entityId: `entity-${sourceRowId}`,
    batchId: outcomeObservedAt.slice(0, 7),
    observationAt,
    publishedAt,
    publishedAtPrecision: "exact",
    outcomeObservedAt,
    collectorWaveId: `wave-${outcomeObservedAt.slice(0, 7)}`,
    metrics: { likes: outcome ? 100 : 1, replies: outcome ? 20 : 0, views: targetValueAtObservation },
    metricObservedAt: { likes: observationAt, replies: observationAt, views: observationAt },
    targetMetric: "views",
    targetValueAtObservation,
    targetValueAtOutcome
  };
}
