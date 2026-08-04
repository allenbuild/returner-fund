#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { canonicalJson, contentHash } from "./lib/lossless-post-archive.mjs";

const root = process.cwd();
const ledgerPath = resolve(root, argValue("--ledger") ?? "work/github-exhaustive-archive-2026-08-05/post-ledger.ndjson");
const archiveDir = resolve(root, argValue("--archive-dir") ?? "work/lossless-post-archive/returner-fund-github-volume-2026-08-05");
const summaryPath = resolve(root, argValue("--summary") ?? "work/github-exhaustive-archive-2026-08-05/lossless-archive-summary.json");
const observedBase = Date.parse("2026-08-05T00:00:00.000Z");
await mkdir(archiveDir, { recursive: true });

const existing = {
  raw: new Set(),
  normalized: new Set(),
  metrics: new Set()
};
for (const [kind, file] of Object.entries({
  raw: "raw-envelopes.ndjson",
  normalized: "normalized-posts.ndjson",
  metrics: "metric-snapshots.ndjson"
})) {
  await streamNdjson(resolve(archiveDir, file), (record) => {
    if (kind === "metrics") existing.metrics.add(metricSlot(record.key, record.content?.snapshotAt));
    else existing[kind].add(observationSlot(record.key, record.observedAt));
  });
}

const streams = {
  raw: createWriteStream(resolve(archiveDir, "raw-envelopes.ndjson"), { flags: "a", encoding: "utf8" }),
  normalized: createWriteStream(resolve(archiveDir, "normalized-posts.ndjson"), { flags: "a", encoding: "utf8" }),
  metrics: createWriteStream(resolve(archiveDir, "metric-snapshots.ndjson"), { flags: "a", encoding: "utf8" })
};
for (const stream of Object.values(streams)) stream.setMaxListeners(0);
const counts = {
  ledgerRows: 0,
  rowsWithNativeId: 0,
  archivedRows: 0,
  alreadyMaterializedRows: 0,
  appendedRawRows: 0,
  appendedNormalizedRows: 0,
  appendedMetricRows: 0,
  uniqueNativeKeys: 0,
  repeatedKeyRows: 0
};
const nativeKeys = new Set();

try {
  await streamNdjson(ledgerPath, async (entry) => {
    const index = counts.ledgerRows++;
    if (!entry.platform || !entry.nativeId) return;
    counts.rowsWithNativeId += 1;
    const platform = String(entry.platform).trim().toLowerCase();
    const nativeId = String(entry.nativeId).trim();
    const key = `${platform}:${nativeId}`;
    if (nativeKeys.has(key)) counts.repeatedKeyRows += 1;
    else nativeKeys.add(key);
    const observedAt = new Date(observedBase + index).toISOString();
    const source = {
      kind: "github-exhaustive-ledger",
      ledgerPath,
      sourceIndex: index,
      nativeKey: key
    };
    const row = entry.row ?? {};
    const normalizedPost = {
      ...row,
      platform,
      nativeId,
      volumeLedgerStatus: entry.status,
      media: Array.isArray(row.media) ? row.media : [],
      relationships: normalizeRelationships(row)
    };
    const rawRecord = makeRecord("raw_envelope", key, {
      platform,
      nativeId,
      rawEnvelope: { ledgerStatus: entry.status, source, row },
      source
    }, observedAt);
    const normalizedRecord = makeRecord("normalized_post", key, {
      platform,
      nativeId,
      post: normalizedPost
    }, observedAt);
    const metricRecord = makeRecord("metric_snapshot", key, {
      platform,
      nativeId,
      snapshotAt: observedAt,
      metrics: row.metrics ?? {},
      source
    }, observedAt);
    const slot = observationSlot(key, observedAt);
    const metricKey = metricSlot(key, observedAt);
    let appended = false;
    if (!existing.raw.has(slot)) {
      await writeRecord(streams.raw, rawRecord);
      existing.raw.add(slot);
      counts.appendedRawRows += 1;
      appended = true;
    }
    if (!existing.normalized.has(slot)) {
      await writeRecord(streams.normalized, normalizedRecord);
      existing.normalized.add(slot);
      counts.appendedNormalizedRows += 1;
      appended = true;
    }
    if (!existing.metrics.has(metricKey)) {
      await writeRecord(streams.metrics, metricRecord);
      existing.metrics.add(metricKey);
      counts.appendedMetricRows += 1;
      appended = true;
    }
    if (appended) counts.archivedRows += 1;
    else counts.alreadyMaterializedRows += 1;
  });
} finally {
  await Promise.all(Object.values(streams).map(closeStream));
}

counts.uniqueNativeKeys = nativeKeys.size;
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  archiveDir,
  ledgerPath,
  counts,
  notes: [
    "This streaming resume path exists for the large GitHub exhaustive archive and avoids loading the archive or ledger into one V8 heap.",
    "GitHub records remain separate from authored social-post counts.",
    "Existing complete observation slots are replay-safe and are not duplicated."
  ]
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function makeRecord(recordType, key, content, observedAt) {
  const immutable = { schemaVersion: 1, recordType, key, content };
  return { ...immutable, observedAt, contentHash: contentHash(immutable) };
}

function normalizeRelationships(row) {
  const relationships = row.relationships && typeof row.relationships === "object" && !Array.isArray(row.relationships)
    ? row.relationships
    : {};
  return {
    parent: relationships.parent ?? row.parent ?? row.parentId ?? null,
    thread: relationships.thread ?? row.thread ?? row.threadId ?? null,
    quote: relationships.quote ?? row.quote ?? row.quoteId ?? null
  };
}

function observationSlot(key, observedAt) { return `${key}\u001f${observedAt ?? ""}`; }
function metricSlot(key, snapshotAt) { return `${key}\u001f${snapshotAt ?? ""}`; }

async function writeRecord(stream, record) {
  if (!stream.write(`${canonicalJson(record)}\n`)) await once(stream, "drain");
}

async function closeStream(stream) {
  await new Promise((resolvePromise, reject) => {
    stream.once("close", resolvePromise);
    stream.once("error", reject);
    stream.end();
  });
}

async function streamNdjson(path, onRecord) {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      await onRecord(JSON.parse(line));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    reader.close();
    input.destroy();
  }
}

function once(emitter, event) {
  return new Promise((resolvePromise, reject) => {
    emitter.once(event, resolvePromise);
    emitter.once("error", reject);
  });
}

function argValue(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}
