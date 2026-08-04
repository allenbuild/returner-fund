#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { archiveAcceptedPublicSnapshot } from "./lib/archive-public-ingestion.mjs";
import { openLosslessPostArchive } from "./lib/lossless-post-archive.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const campaignDir = resolve(root, required(args.campaignDir, "campaign-dir"));
const archiveDir = resolve(root, args.archiveDir ?? join(args.campaignDir, "lossless-public-post-archive"));
const observedAt = args.observedAt ?? new Date().toISOString();
const files = (await readdir(campaignDir))
  .filter((name) => name.startsWith("checkpoint-public-") && name.endsWith(".json"))
  .sort();
if (files.length === 0) throw new Error(`No public checkpoint files found in ${campaignDir}.`);

const archive = await openLosslessPostArchive(archiveDir);
const results = [];
for (const name of files) {
  const payload = JSON.parse(await readFile(join(campaignDir, name), "utf8"));
  try {
    const result = await archiveAcceptedPublicSnapshot({
      archive,
      checkpointScope: `public-checkpoint:${name}`,
      observedAt,
      snapshot: {
        source: {
          label: `Public checkpoint ${name}`,
          fetchedAt: observedAt,
          campaignDir,
          checkpointFile: name
        },
        evidence: payload.evidence ?? []
      }
    });
    results.push({ file: name, status: "archived", ...result });
  } catch (error) {
    results.push({ file: name, status: "failed", error: error?.message ?? String(error) });
  }
}

const summary = {
  status: results.some((result) => result.status === "failed") ? "failed" : "completed",
  campaignDir,
  archiveDir,
  observedAt,
  files,
  results,
  archived: results.reduce((sum, result) => sum + (result.archived ?? 0), 0),
  skippedWithoutNativeId: results.reduce((sum, result) => sum + (result.skippedWithoutNativeId ?? 0), 0),
  checkpointsAdvanced: results.reduce((sum, result) => sum + (result.checkpointsAdvanced ?? 0), 0)
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.status !== "completed") process.exitCode = 2;

function parseArgs(argv) {
  const result = { campaignDir: null, archiveDir: null, observedAt: null };
  for (const arg of argv) {
    if (arg.startsWith("--campaign-dir=")) result.campaignDir = arg.slice("--campaign-dir=".length);
    else if (arg.startsWith("--archive-dir=")) result.archiveDir = arg.slice("--archive-dir=".length);
    else if (arg.startsWith("--observed-at=")) result.observedAt = arg.slice("--observed-at=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function required(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`--${name}=... is required.`);
  return text;
}
