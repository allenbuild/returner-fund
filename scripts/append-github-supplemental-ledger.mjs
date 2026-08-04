#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const root = process.cwd();
const inputPath = resolve(root, argValue("--input") ?? "work/github-exhaustive-archive-2026-08-05/evidence-supplemental-2026-08-05.ndjson");
const ledgerPath = resolve(root, argValue("--ledger") ?? "work/github-exhaustive-archive-2026-08-05/post-ledger.ndjson");
const reportPath = resolve(root, argValue("--report") ?? "work/github-exhaustive-archive-2026-08-05/supplemental-append-report.json");

const existing = new Set();
await streamNdjson(ledgerPath, (entry) => {
  if (entry.nativeKey) existing.add(String(entry.nativeKey));
});

const appended = [];
const seen = new Set();
let sourceIndex = 0;
await streamNdjson(inputPath, (row) => {
  const nativeId = String(row.nativeId ?? "").trim();
  if (!nativeId) return;
  const nativeKey = `github:${nativeId}`;
  if (existing.has(nativeKey) || seen.has(nativeKey)) return;
  seen.add(nativeKey);
  appended.push({
    schemaVersion: 1,
    status: "github_exhaustive",
    platform: "github",
    nativeId,
    nativeKey,
    source: {
      kind: "github-exhaustive-supplemental-receipt",
      path: inputPath,
      sourceIndex,
      supplementalSource: row._supplementalSource ?? null
    },
    row
  });
  sourceIndex += 1;
});

if (appended.length) await appendFile(ledgerPath, appended.map((row) => `${JSON.stringify(row)}\n`).join(""));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  ledgerPath,
  inputPath,
  existingKeys: existing.size,
  inputRows: seen.size,
  appendedRows: appended.length,
  appendedNativeKeys: appended.map((row) => row.nativeKey)
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

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
