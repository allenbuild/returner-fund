#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCompanyTimelineBackfill } from "../src/lib/timeline/backfill.ts";
import { loadPublishedTimelineDatabaseSnapshot } from "../src/lib/timeline/database-backfill.ts";

const options = parseArguments(process.argv.slice(2));

try {
  if (options.exportDatabaseSnapshotPath) {
    const snapshot = await loadPublishedTimelineDatabaseSnapshot(process.env);
    if (snapshot.status !== "loaded") {
      throw new Error(`Company Timeline database snapshot export requires loaded durable state; received ${snapshot.status}.`);
    }
    await writeFile(
      resolve(options.exportDatabaseSnapshotPath),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    process.stdout.write(`${JSON.stringify({ status: "exported", path: resolve(options.exportDatabaseSnapshotPath) })}\n`);
    process.exit(0);
  }
  if (options.databaseSnapshotPath) {
    options.databaseSnapshot = JSON.parse(
      await readFile(resolve(options.databaseSnapshotPath), "utf8")
    );
  }
  delete options.exportDatabaseSnapshotPath;
  delete options.databaseSnapshotPath;
  const result = await runCompanyTimelineBackfill(options);
  process.stdout.write(`${JSON.stringify({ status: "completed", ...result }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const options = {};
  for (const argument of args) {
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--resume") options.resume = true;
    else if (argument === "--force") options.force = true;
    else if (argument.startsWith("--root=")) options.rootDir = requiredValue(argument, "--root");
    else if (argument.startsWith("--checkpoint=")) options.checkpointPath = requiredValue(argument, "--checkpoint");
    else if (argument.startsWith("--public-discovery=")) options.publicDiscoveryPath = requiredValue(argument, "--public-discovery");
    else if (argument.startsWith("--database-snapshot=")) options.databaseSnapshotPath = requiredValue(argument, "--database-snapshot");
    else if (argument.startsWith("--export-database-snapshot=")) options.exportDatabaseSnapshotPath = requiredValue(argument, "--export-database-snapshot");
    else if (argument.startsWith("--max-companies=")) {
      const value = Number(requiredValue(argument, "--max-companies"));
      if (!Number.isInteger(value) || value < 1) throw new TypeError("--max-companies must be a positive integer.");
      options.maxCompanies = value;
    } else if (argument === "--help") {
      process.stdout.write([
        "Usage: backfill-company-timelines.mjs [options]",
        "  --dry-run              Classify and report without writing artifacts",
        "  --resume               Reuse verified artifacts from a compatible checkpoint",
        "  --force                Ignore an existing checkpoint and rebuild every company",
        "  --root=<path>           Repository root (defaults to cwd)",
        "  --checkpoint=<path>     Root-relative checkpoint path",
        "  --public-discovery=<path> Root-relative file-backed discovery snapshot",
        "  --database-snapshot=<path> Read a previously exported durable database snapshot",
        "  --export-database-snapshot=<path> Export durable database state and exit",
        "  --max-companies=<n>     Dry-run-only smoke-test bound",
      ].join("\n") + "\n");
      process.exit(0);
    } else {
      throw new TypeError(`Unknown timeline backfill argument: ${argument}`);
    }
  }
  return options;
}

function requiredValue(argument, flag) {
  const value = argument.slice(argument.indexOf("=") + 1).trim();
  if (!value) throw new TypeError(`${flag} requires a value.`);
  return value;
}
