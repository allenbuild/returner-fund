#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const inputPath = resolve(root, process.argv[2] ?? "/tmp/returner-fund-reddit-deep-recovery-2026-08-05/verified-new-evidence.ndjson");
const ledgerPath = resolve(root, process.argv[3] ?? "work/volume-target-2026-08-05/post-ledger.ndjson");
const outputPath = resolve(root, process.argv[4] ?? "work/volume-target-2026-08-05/supplemental-reddit-deep-recovery.json");
const kind = process.env.SUPPLEMENT_KIND ?? "supplemental-reddit-deep-recovery";
const sourceKind = process.env.SUPPLEMENT_SOURCE_KIND ?? "deep-reddit-recovery";
const sourcePath = process.env.SUPPLEMENT_SOURCE_PATH ?? "work/historical-backfill/reddit-deep-recovery-2026-08-05/verified-new-evidence.ndjson";
const existingPath = process.env.SUPPLEMENT_EXISTING_PATH ? resolve(root, process.env.SUPPLEMENT_EXISTING_PATH) : null;
const ignoreSourceLabel = process.env.SUPPLEMENT_IGNORE_SOURCE_LABEL ?? null;
const requireNativeId = process.env.SUPPLEMENT_REQUIRE_NATIVE_ID === "1";

const ledgerKeys = new Set();
const ledgerSources = new Map();
for (const line of (await readFile(ledgerPath, "utf8")).split(/\r?\n/)) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (!row.nativeKey) continue;
  ledgerKeys.add(row.nativeKey);
  if (ignoreSourceLabel) {
    if (!ledgerSources.has(row.nativeKey)) ledgerSources.set(row.nativeKey, new Set());
    ledgerSources.get(row.nativeKey).add(row.source?.label ?? "unknown");
  }
}

const excludedByLedger = (key) => {
  if (!ignoreSourceLabel) return ledgerKeys.has(key);
  const sources = ledgerSources.get(key);
  return sources?.size > 0 && [...sources].some((source) => source !== ignoreSourceLabel);
};

const seen = new Set();
const evidence = [];
const addRow = (row, preserveExisting = false) => {
  const nativeId = row.nativeId ?? row.platformPostId ?? row.native_id;
  if (requireNativeId && !nativeId) return;
  const key = row.nativeKey ?? `${row.platform}:${nativeId}`;
  if ((!preserveExisting && excludedByLedger(key)) || seen.has(key)) return;
  seen.add(key);
  evidence.push({
    ...row,
    _candidateSource: {
      kind: sourceKind,
      sourcePath,
      sourceNativeKey: key
    }
  });
};

if (existingPath) {
  const existing = JSON.parse(await readFile(existingPath, "utf8"));
  for (const row of existing.evidence ?? []) addRow(row, true);
}

const inputText = await readFile(inputPath, "utf8");
let inputRows;
try {
  const parsed = JSON.parse(inputText);
  inputRows = parsed.evidence ?? [];
} catch {
  inputRows = inputText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
for (const row of inputRows) addRow(row);

await mkdir(resolve(root, "work/volume-target-2026-08-05"), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  kind,
  generatedAt: new Date().toISOString(),
  sourceArtifact: sourcePath,
  exclusionLedgerPath: "work/volume-target-2026-08-05/post-ledger.ndjson",
  evidence
}, null, 2)}\n`);
console.log(JSON.stringify({ inputRows: seen.size, emittedRows: evidence.length, outputPath }, null, 2));
