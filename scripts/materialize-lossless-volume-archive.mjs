#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { openLosslessPostArchive, LosslessArchiveConflictError } from "./lib/lossless-post-archive.mjs";

const root = process.cwd();
const ledgerPath = resolve(root, argValue("--ledger") ?? "work/volume-target-2026-08-05/post-ledger.ndjson");
const archiveDir = resolve(root, argValue("--archive-dir") ?? "work/lossless-post-archive/returner-fund-volume-2026-08-05");
const summaryPath = resolve(root, argValue("--summary") ?? "work/volume-target-2026-08-05/lossless-archive-summary.json");
const observedBase = Date.parse("2026-08-05T00:00:00.000Z");

const archive = await openLosslessPostArchive(archiveDir);

const counts = {
  ledgerRows: 0,
  rowsWithNativeId: 0,
  archivedRows: 0,
  alreadyMaterializedRows: 0,
  appendedRows: 0,
  replayedRows: 0,
  reviewRowsArchived: 0,
  skippedWithoutNativeId: 0,
  conflictRetries: 0
};
const groups = new Map();
const alreadyMaterialized = new Map();
try {
  await streamNdjson(resolve(archiveDir, "raw-envelopes.ndjson"), (record) => {
    const source = record?.content?.source?.ledgerSource;
    const token = sourceToken(source);
    const nativeKey = record?.key ?? nativeKeyFromRecord(record);
    if (token && nativeKey) {
      const keys = alreadyMaterialized.get(token) ?? new Set();
      keys.add(nativeKey);
      alreadyMaterialized.set(token, keys);
    }
  });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const ledgerNativeKeys = new Set();
await streamNdjson(ledgerPath, async (entry) => {
  const index = counts.ledgerRows;
  counts.ledgerRows += 1;
  if (!entry.platform || !entry.nativeId) {
    counts.skippedWithoutNativeId += 1;
    return;
  }
  ledgerNativeKeys.add(`${entry.platform}:${entry.nativeId}`);
  counts.rowsWithNativeId += 1;
  const token = sourceToken(entry.source);
  if (token && alreadyMaterialized.get(token)?.has(entry.nativeKey)) {
    counts.alreadyMaterializedRows += 1;
    return;
  }
  const source = {
    kind: "volume-ledger",
    ledgerStatus: entry.status,
    ledgerSource: entry.source,
    nativeKey: entry.nativeKey
  };
  const row = entry.row ?? {};
  const metrics = row.metrics;
  const request = {
    platform: entry.platform,
    nativeId: entry.nativeId,
    rawEnvelope: { ledgerStatus: entry.status, source, row },
    normalizedPost: { ...row, volumeLedgerStatus: entry.status },
    observedAt: observationTime(row, index),
    source
  };
  if (metrics !== undefined) {
    request.metricSnapshots = [{
      snapshotAt: row.metricsCheckedAt ?? row.last_checked_at ?? request.observedAt,
      observedAt: request.observedAt,
      metrics,
      source
    }];
  }

  let result;
  try {
    result = await archive.appendPost(request);
  } catch (error) {
    if (!(error instanceof LosslessArchiveConflictError)) throw error;
    counts.conflictRetries += 1;
    request.observedAt = new Date(observedBase + index).toISOString();
    if (request.metricSnapshots) {
      request.metricSnapshots = request.metricSnapshots.map((metric) => ({
        ...metric,
        observedAt: request.observedAt,
        snapshotAt: request.observedAt
      }));
    }
    result = await archive.appendPost(request);
  }
  counts.archivedRows += 1;
  if (token) {
    const keys = alreadyMaterialized.get(token) ?? new Set();
    keys.add(entry.nativeKey);
    alreadyMaterialized.set(token, keys);
  }
  if (entry.status === "review") counts.reviewRowsArchived += 1;
  const key = `${entry.platform}:${entry.nativeId}`;
  const group = groups.get(key) ?? { platform: entry.platform, nativeId: entry.nativeId, rows: 0 };
  group.rows += 1;
  groups.set(key, group);
  if (result?.normalized?.status === "appended") counts.appendedRows += 1;
  else counts.replayedRows += 1;
});

for (const group of groups.values()) {
  await archive.updateCheckpoint({
    platform: group.platform,
    scope: "volume-ledger",
    cursor: new Date().toISOString(),
    checkpoint: {
      schemaVersion: 1,
      nativePostKey: `${group.platform}:${group.nativeId}`,
      observationRows: group.rows,
      includesReviewRows: true
    },
    metadata: { source: ledgerPath },
    observedAt: new Date().toISOString()
  });
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  archiveDir,
  ledgerPath,
  counts: {
    ...counts,
    uniqueNativeKeysInLedger: ledgerNativeKeys.size,
    newlyProcessedNativeKeys: groups.size
  },
  notes: [
    "Review rows with native IDs are archived with volumeLedgerStatus=review; they are not promoted to accepted scoring evidence.",
    "Rows without a native platform post ID remain in the ledger but are skipped by this native-post archive.",
    "Conflict retries use a deterministic ingestion observation slot while preserving the source row's original timestamps in the raw envelope."
  ]
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function observationTime(row, index) {
  const candidate = row?.last_checked_at ?? row?.metricsCheckedAt ?? row?.discoveredAt ?? row?.first_seen_at;
  if (candidate && !Number.isNaN(Date.parse(candidate))) return new Date(candidate).toISOString();
  return new Date(observedBase + index).toISOString();
}

function sourceToken(source) {
  if (!source || typeof source !== "object") return null;
  const path = String(source.path ?? "").trim();
  const sourceIndex = source.sourceIndex;
  const pageSequence = source.pageSequence;
  const pageEvidenceIndex = source.pageEvidenceIndex;
  if (!path) return null;
  return JSON.stringify({ path, sourceIndex, pageSequence, pageEvidenceIndex });
}

function nativeKeyFromRecord(record) {
  const platform = String(record?.content?.platform ?? "").trim().toLowerCase();
  const nativeId = String(record?.content?.nativeId ?? "").trim();
  return platform && nativeId ? `${platform}:${nativeId}` : null;
}

async function streamNdjson(path, onRecord) {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      await onRecord(JSON.parse(line));
    }
  } finally {
    reader.close();
    input.destroy();
  }
}

function argValue(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}
