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

const ledgerKeys = new Set();
for (const line of (await readFile(ledgerPath, "utf8")).split(/\r?\n/)) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (row.nativeKey) ledgerKeys.add(row.nativeKey);
}

const seen = new Set();
const evidence = [];
for (const line of (await readFile(inputPath, "utf8")).split(/\r?\n/)) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  const key = row.nativeKey ?? `${row.platform}:${row.nativeId}`;
  if (ledgerKeys.has(key) || seen.has(key)) continue;
  seen.add(key);
  evidence.push({
    ...row,
    _candidateSource: {
      kind: sourceKind,
      sourcePath,
      sourceNativeKey: key
    }
  });
}

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
