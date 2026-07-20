import { canonicalJson, sha256Text, stableHash } from "./determinism";
import {
  V5_METRIC_FEATURES,
  V5_PLATFORM_IDS,
  isMetricFeature,
  type V5CanonicalObservation,
  type V5DatasetBuild,
  type V5InputManifest,
  type V5MetricFeature,
  type V5RawObservation,
  type V5RegisteredSource,
  type V5RejectedRow
} from "./types";
import {
  V5_PREREG_PLATFORM_TARGETS,
  V5_PREREG_SPLIT,
  V5_PREREG_TARGET_ID,
  V5_PREREG_THRESHOLD_DEFINITION,
  isMetricAllowedForPlatform
} from "./protocol";

const HOUR_MS = 3_600_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface RegisteredSourcePayload {
  schemaVersion: "scoring-v5-observations-v2";
  rows: V5RawObservation[];
}

export function validateInputManifest(manifest: V5InputManifest): void {
  if (manifest.schemaVersion !== "scoring-v5-input-manifest-v1") {
    throw new Error("Unsupported v5 input manifest schema.");
  }
  requireIso(manifest.registeredAt, "manifest.registeredAt");
  requireIso(manifest.split.trainStart, "manifest.split.trainStart");
  requireIso(manifest.split.trainEnd, "manifest.split.trainEnd");
  requireIso(manifest.split.validationEnd, "manifest.split.validationEnd");
  requireIso(manifest.split.testEnd, "manifest.split.testEnd");
  const trainStart = Date.parse(manifest.split.trainStart);
  const trainEnd = Date.parse(manifest.split.trainEnd);
  const validationEnd = Date.parse(manifest.split.validationEnd);
  const testEnd = Date.parse(manifest.split.testEnd);
  if (!(trainStart < trainEnd && trainEnd < validationEnd && validationEnd < testEnd)) {
    throw new Error("Split cutoffs must be strictly increasing.");
  }
  if (stableHash(manifest.split) !== stableHash(V5_PREREG_SPLIT)) {
    throw new Error("Split configuration does not match the frozen v5 pre-registration.");
  }
  if (
    manifest.target.id !== V5_PREREG_TARGET_ID ||
    manifest.target.outcome !== "binary_high_performance_at_horizon" ||
    manifest.target.observationRule !== "features_at_or_before_observation_time" ||
    manifest.target.thresholdDefinition !== V5_PREREG_THRESHOLD_DEFINITION ||
    !manifest.target.platformTargets ||
    typeof manifest.target.platformTargets !== "object"
  ) {
    throw new Error("The v5 target specification is invalid or incomplete.");
  }
  if (stableHash(manifest.target.platformTargets) !== stableHash(V5_PREREG_PLATFORM_TARGETS)) {
    throw new Error("Platform target table does not match the frozen v5 pre-registration.");
  }
  for (const target of Object.values(manifest.target.platformTargets)) {
    if (
      !target ||
      !V5_METRIC_FEATURES.includes(target.targetMetric) ||
      !Number.isInteger(target.horizonHours) ||
      target.horizonHours <= 0 ||
      !Number.isInteger(target.toleranceHours) ||
      target.toleranceHours < 0 ||
      target.thresholdQuantile !== 0.8
    ) {
      throw new Error("A platform target has an invalid counter, horizon, tolerance, or quantile.");
    }
  }

  const sourceIds = new Set<string>();
  const paths = new Set<string>();
  for (const source of manifest.sources) {
    validateRegisteredSource(source);
    if (sourceIds.has(source.id)) throw new Error(`Duplicate registered source id: ${source.id}`);
    if (paths.has(source.relativePath)) {
      throw new Error(`Duplicate registered source path: ${source.relativePath}`);
    }
    sourceIds.add(source.id);
    paths.add(source.relativePath);
  }
}

export function buildCanonicalDataset(
  manifest: V5InputManifest,
  registeredFiles: Readonly<Record<string, string>>
): V5DatasetBuild {
  validateInputManifest(manifest);
  const acceptedSources = [...manifest.sources]
    .filter((source) => source.status === "accepted")
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const registeredPaths = new Set(manifest.sources.map((source) => source.relativePath));
  const unregisteredPaths = Object.keys(registeredFiles).filter((path) => !registeredPaths.has(path));
  if (unregisteredPaths.length > 0) {
    throw new Error(`Training input is not registered: ${unregisteredPaths.sort()[0]}`);
  }

  const canonicalCandidates: V5CanonicalObservation[] = [];
  const rejectedRows: V5RejectedRow[] = [];
  const sourceHashes: Record<string, string> = {};

  for (const source of acceptedSources) {
    const content = registeredFiles[source.relativePath];
    if (content === undefined) {
      throw new Error(`Registered source file is missing: ${source.relativePath}`);
    }
    const actualHash = sha256Text(content);
    if (actualHash !== source.sha256) {
      throw new Error(`SHA-256 mismatch for registered source ${source.id}.`);
    }
    sourceHashes[source.id] = actualHash;
    const payload = parseSourcePayload(source, content);
    for (const raw of payload.rows) {
      const converted = canonicalizeRow(source, raw, manifest);
      if ("reason" in converted) rejectedRows.push(converted);
      else canonicalCandidates.push(converted);
    }
  }

  const rows = dedupePhysicalPosts(canonicalCandidates, rejectedRows);
  rejectedRows.sort((left, right) =>
    `${left.sourceId}\u0000${left.sourceRowId}\u0000${left.reason}`.localeCompare(
      `${right.sourceId}\u0000${right.sourceRowId}\u0000${right.reason}`,
      "en"
    )
  );

  return {
    rows,
    rejectedRows,
    datasetHash: stableHash(rows),
    sourceHashes: Object.fromEntries(Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b, "en")))
  };
}

export function registeredSourceForContent(
  source: Omit<V5RegisteredSource, "sha256">,
  content: string
): V5RegisteredSource {
  return { ...source, sha256: sha256Text(content) };
}

export function serializeSourceRows(rows: V5RawObservation[]): string {
  const stableRows = [...rows].sort((left, right) =>
    `${left.platform}\u0000${left.canonicalPostId}\u0000${left.observationAt}\u0000${left.outcomeObservedAt}\u0000${left.sourceRowId}\u0000${canonicalJson(left)}`.localeCompare(
      `${right.platform}\u0000${right.canonicalPostId}\u0000${right.observationAt}\u0000${right.outcomeObservedAt}\u0000${right.sourceRowId}\u0000${canonicalJson(right)}`,
      "en"
    )
  );
  return canonicalJson({ schemaVersion: "scoring-v5-observations-v2", rows: stableRows });
}

function validateRegisteredSource(source: V5RegisteredSource): void {
  if (!source.id.trim() || !source.relativePath.trim()) {
    throw new Error("Every source needs a stable id and relative path.");
  }
  if (source.relativePath.startsWith("/") || source.relativePath.includes("..")) {
    throw new Error(`Source path must remain relative and traversal-free: ${source.relativePath}`);
  }
  if (!SHA256_PATTERN.test(source.sha256)) {
    throw new Error(`Source ${source.id} does not contain a valid SHA-256.`);
  }
  if (!source.citation.trim() || !source.sourceRevision.trim() || !source.license.id.trim()) {
    throw new Error(`Source ${source.id} is missing citation, revision, or license provenance.`);
  }
  requireIso(source.accessedAt, `source ${source.id} accessedAt`);
  if (source.status === "accepted") {
    if (!source.license.permitsResearchUse) {
      throw new Error(`Accepted source ${source.id} does not permit research use.`);
    }
    if (source.rejectionReason !== null) {
      throw new Error(`Accepted source ${source.id} must not have a rejection reason.`);
    }
  } else if (!source.rejectionReason?.trim()) {
    throw new Error(`Rejected source ${source.id} must record a reason.`);
  }
}

function parseSourcePayload(source: V5RegisteredSource, content: string): RegisteredSourcePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Registered source ${source.id} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Registered source ${source.id} must be a JSON object.`);
  }
  const candidate = parsed as Partial<RegisteredSourcePayload>;
  if (candidate.schemaVersion !== source.schemaVersion || !Array.isArray(candidate.rows)) {
    throw new Error(`Registered source ${source.id} does not match its declared schema.`);
  }
  return candidate as RegisteredSourcePayload;
}

function canonicalizeRow(
  source: V5RegisteredSource,
  raw: V5RawObservation,
  manifest: V5InputManifest
): V5CanonicalObservation | V5RejectedRow {
  const actualSourceRowId = stringValue(raw?.sourceRowId);
  const sourceRowId = actualSourceRowId || "<missing>";
  const reject = (reason: string): V5RejectedRow => ({ sourceId: source.id, sourceRowId, reason });
  if (!raw || typeof raw !== "object") return reject("row_not_object");
  const canonicalPostId = stringValue(raw.canonicalPostId);
  const contentFingerprint = stringValue(raw.contentFingerprint) || null;
  const entityId = stringValue(raw.entityId);
  if (!actualSourceRowId || !canonicalPostId || !entityId) return reject("missing_stable_identity");
  if (!V5_PLATFORM_IDS.includes(raw.platform as (typeof V5_PLATFORM_IDS)[number])) {
    return reject("unsupported_platform_schema");
  }
  const platform = raw.platform as (typeof V5_PLATFORM_IDS)[number];
  const platformTarget = manifest.target.platformTargets[platform];
  if (!platformTarget) return reject("missing_platform_target_definition");
  if (raw.targetMetric !== platformTarget.targetMetric) return reject("target_counter_mismatch");
  const observationMs = parseCanonicalDate(raw.observationAt);
  const publishedMs = raw.publishedAt === null ? null : parseCanonicalDate(raw.publishedAt);
  const outcomeMs = parseCanonicalDate(raw.outcomeObservedAt);
  if (observationMs === null || outcomeMs === null) return reject("invalid_observation_or_outcome_time");
  if (publishedMs === null) return reject("missing_or_invalid_publication_time");
  if (raw.publishedAtPrecision !== "exact") return reject("publication_time_not_exact");
  if (observationMs < publishedMs) return reject("observation_precedes_publication");
  if (outcomeMs <= observationMs) return reject("outcome_not_after_observation");
  const nominalOutcomeMs = observationMs + platformTarget.horizonHours * HOUR_MS;
  const toleranceMs = platformTarget.toleranceHours * HOUR_MS;
  if (Math.abs(outcomeMs - nominalOutcomeMs) > toleranceMs) return reject("outcome_outside_registered_horizon_window");
  if (!raw.metrics || typeof raw.metrics !== "object") return reject("metrics_missing");
  if (!raw.metricObservedAt || typeof raw.metricObservedAt !== "object") {
    return reject("metric_observation_times_missing");
  }

  const metrics: Partial<Record<V5MetricFeature, number>> = {};
  const metricObservedAt: Partial<Record<V5MetricFeature, string>> = {};
  for (const metric of Object.keys(raw.metrics).sort((left, right) => left.localeCompare(right, "en"))) {
    const value = (raw.metrics as Record<string, number | null | undefined>)[metric];
    if (value === null || value === undefined) continue;
    if (!isMetricFeature(metric)) return reject(`unknown_metric:${metric}`);
    if (!isMetricAllowedForPlatform(platform, metric)) {
      return reject(`incompatible_platform_metric:${metric}`);
    }
  }
  for (const metric of V5_METRIC_FEATURES) {
    const value = raw.metrics[metric];
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) return reject(`invalid_metric:${metric}`);
    const metricTime = raw.metricObservedAt[metric];
    const metricTimeMs = parseCanonicalDate(metricTime);
    if (metricTimeMs === null) return reject(`invalid_metric_observation_time:${metric}`);
    if (metricTimeMs > observationMs) return reject(`feature_observed_after_t0:${metric}`);
    if (metricTimeMs !== observationMs) return reject(`metric_not_observed_at_t0:${metric}`);
    metrics[metric] = value;
    metricObservedAt[metric] = new Date(metricTimeMs).toISOString();
  }
  if (Object.keys(metrics).length === 0) return reject("no_inference_compatible_metrics");
  if (
    !Number.isFinite(raw.targetValueAtObservation) ||
    raw.targetValueAtObservation < 0 ||
    !Number.isFinite(raw.targetValueAtOutcome) ||
    raw.targetValueAtOutcome < 0
  ) {
    return reject("invalid_target_counter_value");
  }
  if (raw.targetValueAtOutcome < raw.targetValueAtObservation) {
    return reject("counter_decrease_requires_quarantine");
  }
  if (metrics[raw.targetMetric] !== raw.targetValueAtObservation) {
    return reject("target_counter_t0_feature_mismatch");
  }
  const collectorWaveId = stringValue(raw.collectorWaveId);
  if (!collectorWaveId) return reject("missing_collector_wave_id");

  const observationAt = new Date(observationMs).toISOString();
  const publishedAt = new Date(publishedMs).toISOString();
  const outcomeObservedAt = new Date(outcomeMs).toISOString();
  return {
    rowId: `physical-post:${platform}:${canonicalPostId}`,
    sourceId: source.id,
    sourceRevision: source.sourceRevision,
    sourceArtifactSha256: source.sha256,
    sourceRowId,
    canonicalPostId,
    contentFingerprint,
    platform,
    entityId,
    batchId: stringValue(raw.batchId ?? null) || null,
    observationAt,
    publishedAt,
    publishedAtPrecision: "exact",
    outcomeObservedAt,
    collectorWaveId,
    horizonHours: platformTarget.horizonHours,
    toleranceHours: platformTarget.toleranceHours,
    postAgeHours: (observationMs - publishedMs) / HOUR_MS,
    metrics,
    metricObservedAt,
    targetMetric: raw.targetMetric,
    targetValueAtObservation: raw.targetValueAtObservation,
    targetValueAtOutcome: raw.targetValueAtOutcome,
    growth: Math.log1p(raw.targetValueAtOutcome) - Math.log1p(raw.targetValueAtObservation)
  };
}

function dedupePhysicalPosts(
  candidates: V5CanonicalObservation[],
  rejectedRows: V5RejectedRow[]
): V5CanonicalObservation[] {
  const byPost = new Map<string, V5CanonicalObservation[]>();
  for (const row of candidates) {
    const key = `${row.platform}\u0000${row.canonicalPostId}`;
    const existing = byPost.get(key) ?? [];
    existing.push(row);
    byPost.set(key, existing);
  }

  const rows: V5CanonicalObservation[] = [];
  for (const duplicateSet of byPost.values()) {
    duplicateSet.sort(compareDuplicateProvenance);
    const earliestObservationAt = duplicateSet[0].observationAt;
    const earliestAnchors = duplicateSet.filter((row) => row.observationAt === earliestObservationAt);
    const laterAnchors = duplicateSet.filter((row) => row.observationAt !== earliestObservationAt);
    const earliestOutcomeAt = [...earliestAnchors]
      .map((row) => row.outcomeObservedAt)
      .sort((left, right) => left.localeCompare(right, "en"))[0];
    const targetAnchors = earliestAnchors.filter((row) => row.outcomeObservedAt === earliestOutcomeAt);
    const ignoredLaterOutcomes = earliestAnchors.filter((row) => row.outcomeObservedAt !== earliestOutcomeAt);
    const conflictReason = duplicateConflictReason(earliestAnchors, targetAnchors);
    if (conflictReason) {
      for (const row of duplicateSet) rejectDuplicate(rejectedRows, row, conflictReason);
      continue;
    }

    targetAnchors.sort(compareDuplicateProvenance);
    const representative = targetAnchors[0];
    const commonMetrics: Partial<Record<V5MetricFeature, number>> = {};
    const commonMetricObservedAt: Partial<Record<V5MetricFeature, string>> = {};
    for (const metric of V5_METRIC_FEATURES) {
      const values = earliestAnchors.map((row) => row.metrics[metric]);
      if (values.every((value): value is number => value !== undefined)) {
        commonMetrics[metric] = values[0];
        commonMetricObservedAt[metric] = representative.metricObservedAt[metric] as string;
      }
    }
    rows.push({ ...representative, metrics: commonMetrics, metricObservedAt: commonMetricObservedAt });
    const rejectedDuplicates = duplicateSet.filter((row) => row !== representative);
    for (const duplicate of rejectedDuplicates) {
      const reason = laterAnchors.includes(duplicate)
        ? "later_anchor_duplicate_physical_post"
        : ignoredLaterOutcomes.includes(duplicate)
          ? "later_outcome_duplicate_physical_post"
          : "duplicate_physical_post";
      rejectDuplicate(rejectedRows, duplicate, reason);
    }
  }

  return rows.sort((left, right) =>
    `${left.observationAt}\u0000${left.platform}\u0000${left.canonicalPostId}\u0000${left.rowId}`.localeCompare(
      `${right.observationAt}\u0000${right.platform}\u0000${right.canonicalPostId}\u0000${right.rowId}`,
      "en"
    )
  );
}

function duplicateConflictReason(
  earliestAnchors: readonly V5CanonicalObservation[],
  targetAnchors: readonly V5CanonicalObservation[]
): string | null {
  if (new Set(earliestAnchors.map((row) => row.targetMetric)).size > 1) return "conflicting_duplicate_target";
  if (new Set(earliestAnchors.map((row) => row.entityId)).size > 1) return "conflicting_duplicate_entity";
  if (new Set(earliestAnchors.map((row) => row.publishedAt)).size > 1) {
    return "conflicting_duplicate_publication_time";
  }
  const fingerprints = new Set(
    earliestAnchors.map((row) => row.contentFingerprint).filter((value): value is string => value !== null)
  );
  if (fingerprints.size > 1) return "conflicting_duplicate_content_fingerprint";
  if (new Set(targetAnchors.map((row) => row.targetValueAtOutcome)).size > 1) {
    return "conflicting_duplicate_t1_outcome";
  }
  if (new Set(earliestAnchors.map((row) => row.targetValueAtObservation)).size > 1) {
    return "conflicting_duplicate_t0_target";
  }
  for (const metric of V5_METRIC_FEATURES) {
    const observedValues = earliestAnchors
      .map((row) => row.metrics[metric])
      .filter((value): value is number => value !== undefined);
    if (new Set(observedValues).size > 1) return `conflicting_duplicate_t0_metric:${metric}`;
  }
  return null;
}

function compareDuplicateProvenance(
  left: V5CanonicalObservation,
  right: V5CanonicalObservation
): number {
  return `${left.observationAt}\u0000${left.sourceId}\u0000${left.sourceRevision}\u0000${left.sourceArtifactSha256}\u0000${left.sourceRowId}`.localeCompare(
    `${right.observationAt}\u0000${right.sourceId}\u0000${right.sourceRevision}\u0000${right.sourceArtifactSha256}\u0000${right.sourceRowId}`,
    "en"
  );
}

function rejectDuplicate(
  rejectedRows: V5RejectedRow[],
  row: V5CanonicalObservation,
  reason: string
): void {
  rejectedRows.push({ sourceId: row.sourceId, sourceRowId: row.sourceRowId, reason });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseCanonicalDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function requireIso(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
}
