const ARCHIVE_CHECKPOINT_SCHEMA_VERSION = 1;

const NORMALIZED_POST_EXCLUDED_FIELDS = new Set([
  "rawEnvelope",
  "raw_envelope",
  "rawVisibleText",
  "raw_visible_text",
  "metrics",
  "contributionScore",
  "first_seen_at",
  "last_checked_at",
  "last_updated_at",
  "checkedAt",
  "metricsCheckedAt"
]);

/**
 * Archive the accepted rows from a sanitized public-ingestion snapshot.
 *
 * Post writes are deliberately completed before any archive checkpoint is
 * advanced. A failed post write therefore leaves every affected checkpoint at
 * its previous position, and replay can safely retry the snapshot.
 */
export async function archiveAcceptedPublicSnapshot({
  archive,
  snapshot,
  checkpointScope = "public-ingestion",
  observedAt = snapshot?.source?.fetchedAt ?? new Date().toISOString()
}) {
  if (!archive || typeof archive.appendPost !== "function" ||
      typeof archive.updateCheckpoint !== "function") {
    throw new TypeError("archiveAcceptedPublicSnapshot requires an archive");
  }

  const rows = Array.isArray(snapshot?.evidence) ? snapshot.evidence : [];
  const archived = [];
  let skippedWithoutNativeId = 0;

  for (const row of rows) {
    const platform = normalizedPlatform(row?.platform);
    const nativeId = nativePostId(row);
    if (!platform || !nativeId) {
      skippedWithoutNativeId += 1;
      continue;
    }

    const rowObservedAt = observationTime(row, observedAt);
    const source = archivedPostSource(snapshot?.source, row);
    await archive.appendPost({
      platform,
      nativeId,
      rawEnvelope: rawPostEnvelope(row),
      normalizedPost: normalizedPost(row),
      observedAt: rowObservedAt,
      metricSnapshots: [{
        snapshotAt: row?.metricsCheckedAt ?? row?.last_checked_at ?? rowObservedAt,
        observedAt: rowObservedAt,
        metrics: jsonValue(row?.metrics, {}),
        source
      }],
      source
    });
    archived.push({
      platform,
      nativeId,
      batchSlug: String(row?.batchSlug ?? row?.batch_slug ?? "unscoped")
    });
  }

  const checkpointGroups = groupArchivedRows(archived);
  for (const group of checkpointGroups) {
    await archive.updateCheckpoint({
      platform: group.platform,
      scope: `${checkpointScope}:${group.batchSlug}`,
      cursor: observedAt,
      checkpoint: {
        schemaVersion: ARCHIVE_CHECKPOINT_SCHEMA_VERSION,
        acceptedNativePostCount: group.nativeIds.length,
        batchSlug: group.batchSlug,
        sourceFetchedAt: snapshot?.source?.fetchedAt ?? null
      },
      metadata: {
        sourceLabel: snapshot?.source?.label ?? null
      },
      observedAt
    });
  }

  return {
    archived: archived.length,
    skippedWithoutNativeId,
    checkpointsAdvanced: checkpointGroups.length
  };
}

function nativePostId(row) {
  const value = row?.platformPostId ?? row?.nativeId ?? row?.native_id;
  if (value === null || value === undefined) return null;
  return String(value).trim() || null;
}

function normalizedPlatform(value) {
  const platform = String(value ?? "").trim().toLowerCase();
  return platform || null;
}

function observationTime(row, fallback) {
  return row?.last_checked_at ?? row?.metricsCheckedAt ?? fallback;
}

function rawPostEnvelope(row) {
  if (row && Object.hasOwn(row, "rawEnvelope")) return jsonValue(row.rawEnvelope, null);
  if (row && Object.hasOwn(row, "raw_envelope")) return jsonValue(row.raw_envelope, null);
  if (row && Object.hasOwn(row, "rawVisibleText")) return jsonValue(row.rawVisibleText, "");
  if (row && Object.hasOwn(row, "raw_visible_text")) return jsonValue(row.raw_visible_text, "");
  return jsonValue(row, {});
}

function normalizedPost(row) {
  return Object.fromEntries(
    Object.entries(jsonValue(row, {}))
      .filter(([key]) => !NORMALIZED_POST_EXCLUDED_FIELDS.has(key))
  );
}

function archivedPostSource(snapshotSource, row) {
  return {
    snapshot: jsonValue(snapshotSource, null),
    evidence: {
      sourceUrl: row?.sourceUrl ?? row?.source_url ?? null,
      accountUrl: row?.accountUrl ?? row?.account_url ?? null,
      discoverySource: row?.discoverySource ?? row?.discovery_source ?? null,
      attributionProvenance: row?.attributionProvenance ?? null
    }
  };
}

function groupArchivedRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.platform}\u0000${row.batchSlug}`;
    const group = groups.get(key) ?? {
      platform: row.platform,
      batchSlug: row.batchSlug,
      nativeIds: []
    };
    group.nativeIds.push(row.nativeId);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.platform.localeCompare(right.platform) || left.batchSlug.localeCompare(right.batchSlug)
  );
}

function jsonValue(value, fallback) {
  if (value === undefined) return fallback;
  return JSON.parse(JSON.stringify(value));
}
