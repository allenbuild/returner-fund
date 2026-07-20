import { sha256Text, stableHash } from "./determinism";
import type {
  V5CanonicalObservation,
  V5Split,
  V5SplitAssignment,
  V5SplitBuild,
  V5SplitSpec
} from "./types";

export function buildLeakageSafeSplits(
  rows: readonly V5CanonicalObservation[],
  spec: V5SplitSpec
): V5SplitBuild {
  const preliminary = new Map<string, V5Split>();
  const excludedRowReasons = new Map<string, string>();
  for (const row of rows) {
    const split = temporalSplit(row.observationAt, spec);
    if (split) preliminary.set(row.rowId, split);
    else excludedRowReasons.set(row.rowId, "outside_pre_registered_test_window");
  }

  const entitySplits = groupedSplits(rows, preliminary, (row) => row.entityId);
  const contaminatedEntities = spec.groupByEntity
    ? new Set(
        [...entitySplits.entries()].filter(([, splits]) => splits.size > 1).map(([entityId]) => entityId)
      )
    : new Set<string>();
  const batchSplits = spec.groupByBatch
    ? groupedSplits(rows, preliminary, (row) => row.batchId)
    : new Map<string, Set<V5Split>>();
  const contaminatedBatches = new Set(
    [...batchSplits.entries()].filter(([, splits]) => splits.size > 1).map(([batchId]) => batchId)
  );
  const fingerprintSplits = groupedSplits(rows, preliminary, (row) => row.contentFingerprint);
  const contaminatedFingerprints = new Set(
    [...fingerprintSplits.entries()]
      .filter(([, splits]) => splits.size > 1)
      .map(([fingerprint]) => fingerprint)
  );

  const assignedRows: Record<V5Split, V5CanonicalObservation[]> = {
    train: [],
    validation: [],
    test: []
  };
  const assignments: V5SplitAssignment[] = [];
  const exclusions: Array<{ entityId: string; reason: string }> = [];
  const exclusionKeys = new Set<string>();
  const unseenEntityHoldoutIds = [...new Set(rows.map((row) => row.entityId))]
    .filter(isUnseenEntityHoldout)
    .sort((left, right) => left.localeCompare(right, "en"));
  const unseenEntityHoldoutSet = new Set(unseenEntityHoldoutIds);

  for (const row of rows) {
    const split = preliminary.get(row.rowId);
    let reason = excludedRowReasons.get(row.rowId) ?? null;
    if (contaminatedEntities.has(row.entityId)) reason = "entity_crosses_temporal_boundaries";
    if (!reason && row.batchId && contaminatedBatches.has(row.batchId)) {
      reason = "batch_crosses_temporal_boundaries";
    }
    if (!reason && row.contentFingerprint && contaminatedFingerprints.has(row.contentFingerprint)) {
      reason = "content_fingerprint_crosses_temporal_boundaries";
    }
    if (!split || reason) {
      const key = `${row.entityId}\u0000${reason ?? "unassigned"}`;
      if (!exclusionKeys.has(key)) {
        exclusions.push({ entityId: row.entityId, reason: reason ?? "unassigned" });
        exclusionKeys.add(key);
      }
      continue;
    }
    assignedRows[split].push(row);
    assignments.push({
      rowId: row.rowId,
      canonicalPostId: row.canonicalPostId,
      contentFingerprint: row.contentFingerprint,
      entityId: row.entityId,
      batchId: row.batchId,
      platform: row.platform,
      split,
      unseenEntityHoldout: unseenEntityHoldoutSet.has(row.entityId)
    });
  }

  for (const split of ["train", "validation", "test"] as const) {
    assignedRows[split].sort(compareRows);
  }
  assignments.sort((left, right) => left.rowId.localeCompare(right.rowId, "en"));
  exclusions.sort((left, right) =>
    `${left.entityId}\u0000${left.reason}`.localeCompare(`${right.entityId}\u0000${right.reason}`, "en")
  );

  assertNoLeakage(assignments, spec.groupByEntity, spec.groupByBatch);
  return {
    assignments,
    rows: assignedRows,
    exclusions,
    unseenEntityHoldoutIds,
    splitHash: stableHash(assignments)
  };
}

export function assertNoLeakage(
  assignments: readonly V5SplitAssignment[],
  groupByEntity: boolean,
  groupByBatch: boolean
): void {
  assertSingleSplit(assignments, (row) => `${row.platform}:${row.canonicalPostId}`, "canonical post");
  assertSingleSplit(
    assignments.filter((row) => row.contentFingerprint !== null),
    (row) => row.contentFingerprint as string,
    "content fingerprint"
  );
  if (groupByEntity) assertSingleSplit(assignments, (row) => row.entityId, "entity");
  if (groupByBatch) {
    assertSingleSplit(
      assignments.filter((row) => row.batchId !== null),
      (row) => row.batchId as string,
      "batch"
    );
  }
}

function temporalSplit(observationAt: string, spec: V5SplitSpec): V5Split | null {
  const value = Date.parse(observationAt);
  if (value < Date.parse(spec.trainStart)) return null;
  if (value <= Date.parse(spec.trainEnd)) return "train";
  if (value <= Date.parse(spec.validationEnd)) return "validation";
  if (value <= Date.parse(spec.testEnd)) return "test";
  return null;
}

export function isUnseenEntityHoldout(entityId: string): boolean {
  const digest = sha256Text(`v5-company-holdout\u0000${entityId}`);
  return Number.parseInt(digest.slice(0, 2), 16) < 51;
}

function groupedSplits(
  rows: readonly V5CanonicalObservation[],
  preliminary: ReadonlyMap<string, V5Split>,
  keyFor: (row: V5CanonicalObservation) => string | null
): Map<string, Set<V5Split>> {
  const result = new Map<string, Set<V5Split>>();
  for (const row of rows) {
    const key = keyFor(row);
    const split = preliminary.get(row.rowId);
    if (!key || !split) continue;
    const values = result.get(key) ?? new Set<V5Split>();
    values.add(split);
    result.set(key, values);
  }
  return result;
}

function assertSingleSplit(
  assignments: readonly V5SplitAssignment[],
  keyFor: (row: V5SplitAssignment) => string,
  label: string
): void {
  const seen = new Map<string, V5Split>();
  for (const row of assignments) {
    const key = keyFor(row);
    const prior = seen.get(key);
    if (prior && prior !== row.split) throw new Error(`Leakage detected: ${label} ${key} crosses splits.`);
    seen.set(key, row.split);
  }
}

function compareRows(left: V5CanonicalObservation, right: V5CanonicalObservation): number {
  return `${left.observationAt}\u0000${left.platform}\u0000${left.canonicalPostId}\u0000${left.rowId}`.localeCompare(
    `${right.observationAt}\u0000${right.platform}\u0000${right.canonicalPostId}\u0000${right.rowId}`,
    "en"
  );
}
