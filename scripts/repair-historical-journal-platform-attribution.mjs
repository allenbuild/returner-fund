#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.output || !args.report) {
  throw new Error("Usage: node scripts/repair-historical-journal-platform-attribution.mjs --input=... --output=... --report=...");
}

const inputPath = resolve(args.input);
const outputPath = resolve(args.output);
const reportPath = resolve(args.report);
const source = await readFile(inputPath, "utf8");
const sourceHash = sha256(source);
const repairedLines = [];
const repairs = [];
const removedByTarget = new Map();

for (const [index, line] of source.split("\n").entries()) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  if (record.type === "run_completed" && record.summary && typeof record.summary === "object") {
    const removedTotal = [...removedByTarget.values()].reduce((sum, value) => sum + value, 0);
    record.summary.totals.accepted = Math.max(0, record.summary.totals.accepted - removedTotal);
    for (const [targetKey, targetRemoved] of removedByTarget) {
      const [, , platform] = targetKey.split(":");
      const batch = targetKey.split(":")[0];
      if (record.summary.byPlatform?.[platform]) {
        record.summary.byPlatform[platform].accepted = Math.max(0, record.summary.byPlatform[platform].accepted - targetRemoved);
      }
      if (record.summary.byBatch?.[batch]) {
        record.summary.byBatch[batch].accepted = Math.max(0, record.summary.byBatch[batch].accepted - targetRemoved);
      }
    }
    repairedLines.push(JSON.stringify(record));
    continue;
  }
  const targetPlatform = targetPlatformFromKey(record.targetKey);
  if (!targetPlatform) {
    repairedLines.push(JSON.stringify(record));
    continue;
  }

  let removed = 0;
  let removedPlatforms = [];
  if (Array.isArray(record.evidence)) {
    const retained = record.evidence.filter((item) => item?.platform === targetPlatform);
    removed = record.evidence.length - retained.length;
    removedPlatforms = [...new Set(record.evidence.filter((item) => item?.platform !== targetPlatform).map((item) => item?.platform ?? null))];
    if (record.type === "page_checkpoint") {
      record.receipt.pageAccepted = retained.length;
      if (record.progress && typeof record.progress === "object") {
        record.progress.pageAccepted = retained.length;
      }
    }
    record.evidence = retained;
  }
  if (removed > 0) {
    removedByTarget.set(record.targetKey, (removedByTarget.get(record.targetKey) ?? 0) + removed);
    repairs.push({
      line: index + 1,
      sequence: record.sequence,
      targetKey: record.targetKey,
      targetPlatform,
      removed,
      removedPlatforms
    });
  }

  const removedForTarget = removedByTarget.get(record.targetKey) ?? 0;
  if (record.receipt && typeof record.receipt === "object") {
    record.receipt.accepted = Math.max(0, record.receipt.accepted - removedForTarget);
  }
  if (record.progress && typeof record.progress === "object") {
    record.progress.accepted = Math.max(0, record.progress.accepted - removedForTarget);
  }
  repairedLines.push(JSON.stringify(record));
}

const repairedSource = `${repairedLines.join("\n")}\n`;
await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(outputPath, repairedSource, "utf8");
const report = {
  schemaVersion: 1,
  status: "repaired_derived_journal",
  inputPath,
  inputSha256: sourceHash,
  outputPath,
  outputSha256: sha256(repairedSource),
  lines: repairedLines.length,
  repairCount: repairs.length,
  removedEvidenceRows: repairs.reduce((sum, repair) => sum + repair.removed, 0),
  repairs
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));

function targetPlatformFromKey(targetKey) {
  if (typeof targetKey !== "string") return null;
  const platform = targetKey.slice(targetKey.lastIndexOf(":") + 1);
  return platform || null;
}

function parseArgs(values) {
  const result = {};
  for (const value of values) {
    const match = value.match(/^--([^=]+)=(.+)$/);
    if (!match) throw new Error(`Expected --name=value; received ${value}`);
    result[match[1]] = match[2];
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
