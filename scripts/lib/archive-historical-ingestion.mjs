import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const CHECKPOINT_SCHEMA_VERSION = 1;
const DEFAULT_CHECKPOINT_SCOPE = "historical-ingestion";
const NORMALIZED_POST_EXCLUDED_FIELDS = new Set([
  "rawEnvelope",
  "raw_envelope",
  "metrics",
  "metricsCheckedAt",
  "last_checked_at"
]);

/**
 * Archive a completed historical journal, or page rows that have already been
 * normalized by a terminal-journal reader. No public-evidence artifact is read
 * or written here; LosslessPostArchive is the only persistence boundary.
 */
export async function archiveTerminalHistoricalJournalEvidence({
  archive,
  journalPath,
  pageRows,
  terminal,
  checkpointScope = DEFAULT_CHECKPOINT_SCOPE,
  observedAt
} = {}) {
  assertArchive(archive);
  if (Boolean(journalPath) === Boolean(pageRows)) {
    throw new TypeError("Pass exactly one of journalPath or pageRows");
  }

  const terminalState = journalPath
    ? await inspectTerminalJournal(journalPath)
    : normalizeTerminalState(terminal, observedAt);
  const rows = journalPath ? streamHistoricalPageRows(journalPath) : asAsyncIterable(pageRows);
  const fallbackObservedAt = observedAt ?? terminalState.recordedAt;
  if (!fallbackObservedAt) {
    throw new TypeError("Terminal historical page rows require a stable observedAt");
  }

  const groups = new Map();
  for (const target of terminalState.targets) ensureGroup(groups, target.platform, target.batchSlug)
    .targetKeys.add(target.targetKey);

  let archived = 0;
  let appended = 0;
  let replayed = 0;
  const skips = [];

  for await (const pageRow of rows) {
    const page = normalizePageRow(pageRow);
    const pagePlatform = normalizedPlatform(page.receipt?.platform);
    const pageBatchSlug = batchSlug(page.receipt);
    const pageGroup = pagePlatform
      ? ensureGroup(groups, pagePlatform, pageBatchSlug)
      : null;
    if (pageGroup && page.targetKey) pageGroup.targetKeys.add(page.targetKey);
    if (pageGroup) pageGroup.pageSequences.add(page.sequence);

    for (const [evidenceIndex, row] of page.evidence.entries()) {
      const platform = normalizedPlatform(row?.platform) ?? pagePlatform;
      const rowBatchSlug = batchSlug(row, pageBatchSlug);
      const group = ensureGroup(groups, platform ?? "unknown", rowBatchSlug);
      if (page.targetKey) group.targetKeys.add(page.targetKey);
      group.pageSequences.add(page.sequence);
      const nativeId = nativePostId(row);
      if (!nativeId) {
        const skip = {
          reason: "missing_native_id",
          platform: platform ?? "unknown",
          batchSlug: rowBatchSlug,
          targetKey: page.targetKey,
          pageSequence: page.sequence,
          evidenceIndex,
          sourceUrl: row?.sourceUrl ?? row?.source_url ?? null
        };
        group.skips.push(skip);
        skips.push(skip);
        continue;
      }
      if (!platform) throw new TypeError(`Historical evidence ${nativeId} is missing platform`);

      const rowObservedAt = observationTime(row, page.recordedAt ?? fallbackObservedAt);
      const source = {
        kind: "historical_backfill_journal",
        targetKey: page.targetKey,
        pageSequence: page.sequence,
        page: page.receipt?.page ?? null,
        requestUrl: page.receipt?.requestUrl ?? null
      };
      const result = await archive.appendPost({
        platform,
        nativeId,
        rawEnvelope: rawEnvelope(row),
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
      archived += 1;
      group.nativeIds.push(nativeId);
      if (result?.raw?.status === "duplicate" && result?.normalized?.status === "duplicate" &&
          result?.metrics?.every((metric) => metric.status === "duplicate")) {
        replayed += 1;
      } else {
        appended += 1;
      }
    }
  }

  const checkpointGroups = [...groups.values()].sort(compareGroups);
  for (const group of checkpointGroups) {
    await archive.updateCheckpoint({
      platform: group.platform,
      scope: `${checkpointScope}:${group.batchSlug}`,
      cursor: terminalState.lastSequence,
      checkpoint: {
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        batchSlug: group.batchSlug,
        terminalStatus: terminalState.status,
        journalLastSequence: terminalState.lastSequence,
        archivedNativePostCount: group.nativeIds.length,
        skippedWithoutNativeIdCount: group.skips.length,
        skips: group.skips
      },
      metadata: {
        configFingerprint: terminalState.configFingerprint,
        targetKeys: [...group.targetKeys].sort(),
        pageSequences: [...group.pageSequences].filter(Number.isInteger).sort((a, b) => a - b)
      },
      observedAt: terminalState.recordedAt ?? fallbackObservedAt
    });
  }

  return {
    archived,
    appended,
    replayed,
    skippedWithoutNativeId: skips.length,
    skips,
    checkpointsAdvanced: checkpointGroups.length
  };
}

/** Verify terminality before yielding any normalized page rows. */
export async function* streamTerminalHistoricalJournalEvidence(journalPath) {
  await inspectTerminalJournal(journalPath);
  yield* streamHistoricalPageRows(journalPath);
}

async function inspectTerminalJournal(journalPath) {
  let expectedSequence = 1;
  let initialized = null;
  let completed = null;
  let lastEvent = null;
  const completedTargets = new Map();
  for await (const event of streamJournalEvents(journalPath)) {
    if (!Number.isInteger(event.sequence) || event.sequence !== expectedSequence) {
      throw new Error(
        `Historical journal sequence is not contiguous at ${event.sequence ?? "missing"}; expected ${expectedSequence}`
      );
    }
    expectedSequence += 1;
    if (event.type === "run_initialized") initialized = event;
    if (event.type === "target_completed") completedTargets.set(event.targetKey, event.receipt);
    if (event.type === "run_completed") completed = event;
    lastEvent = event;
  }

  const expectedTargets = new Set(initialized?.config?.targetKeys ?? []);
  const targetSetMatches = expectedTargets.size > 0 &&
    completedTargets.size === expectedTargets.size &&
    [...expectedTargets].every((targetKey) => completedTargets.has(targetKey));
  const summary = completed?.summary;
  const summaryMatches = summary?.status === "completed" &&
    summary.targetPlatformPairs === expectedTargets.size &&
    summary.completedTargetPlatformPairs === completedTargets.size &&
    summary.totals?.targets === completedTargets.size;
  if (lastEvent?.type !== "run_completed" || !targetSetMatches || !summaryMatches) {
    throw new Error("Historical journal is not terminal and complete");
  }

  return normalizeTerminalState({
    status: summary.status,
    lastSequence: lastEvent.sequence,
    recordedAt: lastEvent.recordedAt ?? summary.completedAt,
    configFingerprint: initialized?.configFingerprint ?? null,
    targets: [...completedTargets].map(([targetKey, receipt]) => ({
      targetKey,
      platform: receipt?.platform,
      batchSlug: receipt?.batchSlug
    }))
  });
}

async function* streamHistoricalPageRows(journalPath) {
  for await (const event of streamJournalEvents(journalPath)) {
    if (event.type !== "page_checkpoint") continue;
    yield {
      sequence: event.sequence,
      recordedAt: event.recordedAt,
      targetKey: event.targetKey,
      receipt: event.receipt,
      evidence: event.evidence
    };
  }
}

async function* streamJournalEvents(journalPath) {
  const input = createReadStream(journalPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch (error) {
      throw new Error(`Historical journal contains invalid NDJSON at line ${lineNumber}`, { cause: error });
    }
  }
}

function normalizeTerminalState(terminal, fallbackObservedAt) {
  if (!terminal || terminal.status !== "completed") {
    throw new Error("Terminal historical metadata must have status completed");
  }
  const lastSequence = terminal.lastSequence ?? terminal.sequence;
  if (!Number.isInteger(lastSequence) || lastSequence < 1) {
    throw new TypeError("Terminal historical metadata requires lastSequence");
  }
  return {
    status: "completed",
    lastSequence,
    recordedAt: terminal.recordedAt ?? terminal.completedAt ?? fallbackObservedAt ?? null,
    configFingerprint: terminal.configFingerprint ?? null,
    targets: Array.isArray(terminal.targets) ? terminal.targets : []
  };
}

function normalizePageRow(pageRow) {
  if (!pageRow || typeof pageRow !== "object" || !Array.isArray(pageRow.evidence)) {
    throw new TypeError("Historical page rows require an evidence array");
  }
  return {
    sequence: pageRow.sequence ?? null,
    recordedAt: pageRow.recordedAt ?? null,
    targetKey: pageRow.targetKey ?? null,
    receipt: pageRow.receipt ?? {},
    evidence: pageRow.evidence
  };
}

function ensureGroup(groups, platform, slug) {
  const normalized = normalizedPlatform(platform) ?? "unknown";
  const normalizedSlug = batchSlug({ batchSlug: slug });
  const key = `${normalized}\u0000${normalizedSlug}`;
  if (!groups.has(key)) {
    groups.set(key, {
      platform: normalized,
      batchSlug: normalizedSlug,
      nativeIds: [],
      skips: [],
      targetKeys: new Set(),
      pageSequences: new Set()
    });
  }
  return groups.get(key);
}

function nativePostId(row) {
  const value = row?.platformPostId ?? row?.nativeId ?? row?.native_id ??
    row?.externalId ?? row?.external_id;
  if (value === null || value === undefined) return null;
  return String(value).trim() || null;
}

function normalizedPlatform(value) {
  const platform = String(value ?? "").trim().toLowerCase();
  return platform || null;
}

function batchSlug(value, fallback = "unscoped") {
  return String(value?.batchSlug ?? value?.batch_slug ?? fallback).trim() || "unscoped";
}

function observationTime(row, fallback) {
  return row?.last_checked_at ?? row?.metricsCheckedAt ?? row?.discoveredAt ?? fallback;
}

function rawEnvelope(row) {
  if (Object.hasOwn(row, "rawEnvelope")) return jsonValue(row.rawEnvelope, null);
  if (Object.hasOwn(row, "raw_envelope")) return jsonValue(row.raw_envelope, null);
  return jsonValue(row, {});
}

function normalizedPost(row) {
  return Object.fromEntries(
    Object.entries(jsonValue(row, {})).filter(([key]) => !NORMALIZED_POST_EXCLUDED_FIELDS.has(key))
  );
}

function compareGroups(left, right) {
  return left.platform.localeCompare(right.platform) || left.batchSlug.localeCompare(right.batchSlug);
}

function assertArchive(archive) {
  if (!archive || typeof archive.appendPost !== "function" ||
      typeof archive.updateCheckpoint !== "function") {
    throw new TypeError("archiveTerminalHistoricalJournalEvidence requires a LosslessPostArchive");
  }
}

function asAsyncIterable(value) {
  if (value?.[Symbol.asyncIterator] || value?.[Symbol.iterator]) return value;
  throw new TypeError("pageRows must be iterable");
}

function jsonValue(value, fallback) {
  if (value === undefined) return fallback;
  return JSON.parse(JSON.stringify(value));
}
