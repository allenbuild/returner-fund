#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const root = process.cwd();
const inputPath = resolve(root, argValue("--input") ?? "work/github-exhaustive-archive-2026-08-05/evidence-deduped.ndjson");
const outputPath = resolve(root, argValue("--output") ?? "work/github-exhaustive-archive-2026-08-05/post-ledger.ndjson");
const summaryPath = resolve(root, argValue("--summary") ?? "work/github-exhaustive-archive-2026-08-05/summary.json");
const manifestPath = resolve(root, argValue("--manifest") ?? "work/github-exhaustive-archive-2026-08-05/manifest.json");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await mkdir(dirname(outputPath), { recursive: true });
const output = (await import("node:fs")).createWriteStream(outputPath, { encoding: "utf8" });
const reader = createInterface({ input: createReadStream(inputPath, { encoding: "utf8" }), crlfDelay: Infinity });
const keys = new Set();
const counts = { rows: 0, rowsWithNativeId: 0, uniqueNativeKeys: 0, repeatedKeyRows: 0, rowsRequiringAttributionReview: 0 };

try {
  for await (const line of reader) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const nativeId = String(row.nativeId ?? "").trim();
    if (!nativeId) continue;
    const nativeKey = `github:${nativeId}`;
    counts.rows += 1;
    counts.rowsWithNativeId += 1;
    if (keys.has(nativeKey)) counts.repeatedKeyRows += 1;
    else keys.add(nativeKey);
    if (row.requiresAttributionReview === true) counts.rowsRequiringAttributionReview += 1;
    const entry = {
      schemaVersion: 1,
      status: "github_exhaustive",
      platform: "github",
      nativeId,
      nativeKey,
      source: {
        kind: "github-exhaustive-receipt",
        path: inputPath,
        sourceIndex: counts.rows - 1,
        manifestPath
      },
      row
    };
    if (!output.write(`${JSON.stringify(entry)}\n`)) await onceDrain(output);
  }
} finally {
  reader.close();
  output.end();
}
await onceClosed(output);

counts.uniqueNativeKeys = keys.size;
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  kind: "github-exhaustive-record-archive",
  inputPath,
  outputPath,
  manifestPath,
  counts,
  sourceIntegrity: manifest.integrity ?? null,
  notes: [
    "GitHub records are preserved losslessly but remain separate from authored social-post counts.",
    "status=github_exhaustive is intentionally excluded from the social-post scoring projection.",
    "Repeated native keys retain all attribution rows in the lossless ledger."
  ]
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function argValue(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function onceDrain(stream) {
  return new Promise((resolvePromise) => stream.once("drain", resolvePromise));
}

function onceClosed(stream) {
  return new Promise((resolvePromise, reject) => {
    stream.once("close", resolvePromise);
    stream.once("error", reject);
  });
}
