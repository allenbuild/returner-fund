#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  reportHasStructuralFailures,
  runCohortCoverageAudit
} from "./lib/cohort-coverage-audit.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write([
    "Usage: node scripts/audit-cohort-coverage.mjs [options]",
    "",
    "Options:",
    "  --root=<path>      Repository root (default: current directory)",
    "  --run-dir=<path>   Autonomous run output directory to reconcile",
    "  --output=<path>    Write deterministic JSON to this path",
    "  --compact          Emit compact JSON",
    "  --help             Show this help",
    "",
    "Without --output the audit only writes JSON to stdout. Zero evidence or score is debt,",
    "not a failure. Structural owner omissions, unresolved entity references, and mapped",
    "accounts without an owner-scoped attempt are failures.",
    ""
  ].join("\n"));
  process.exit(0);
}

const rootDir = resolve(args.root ?? process.cwd());
const runDir = args.runDir ? resolve(rootDir, args.runDir) : null;
const report = await runCohortCoverageAudit({ rootDir, runDir });
const json = `${JSON.stringify(report, null, args.compact ? 0 : 2)}\n`;

if (args.output) {
  const outputPath = resolve(rootDir, args.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json);
} else {
  process.stdout.write(json);
}

if (reportHasStructuralFailures(report)) process.exitCode = 1;

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--compact") parsed.compact = true;
    else if (arg.startsWith("--root=")) parsed.root = arg.slice("--root=".length);
    else if (arg.startsWith("--run-dir=")) parsed.runDir = arg.slice("--run-dir=".length);
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
