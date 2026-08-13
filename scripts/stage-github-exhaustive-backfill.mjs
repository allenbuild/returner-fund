#!/usr/bin/env node

import { resolve } from "node:path";

import { stageGithubExhaustiveIntegration } from "./lib/github-exhaustive-integration.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

for (const flag of [
  "runDir",
  "canonicalS2026",
  "canonicalS26",
  "canonicalA16zsr006",
  "legacyQuarantine"
]) {
  if (!args[flag]) throw new Error(`--${camelToKebab(flag)} is required.`);
}
if (args.write && !args.outputDir) {
  throw new Error("--write requires an explicit --output-dir outside live and canonical directories.");
}

try {
  const receipt = await stageGithubExhaustiveIntegration({
    runDir: resolve(args.runDir),
    canonicalSnapshots: [
      { batchSlug: "S2026", path: resolve(args.canonicalS2026) },
      { batchSlug: "S26", path: resolve(args.canonicalS26) },
      { batchSlug: "A16ZSR006", path: resolve(args.canonicalA16zsr006) }
    ],
    legacyQuarantinePath: resolve(args.legacyQuarantine),
    outputDir: args.outputDir ? resolve(args.outputDir) : null,
    write: args.write
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const result = {
    help: false,
    write: false,
    runDir: null,
    outputDir: null,
    canonicalS2026: null,
    canonicalS26: null,
    canonicalA16zsr006: null,
    legacyQuarantine: null
  };
  const names = new Map([
    ["--run-dir", "runDir"],
    ["--output-dir", "outputDir"],
    ["--canonical-s2026", "canonicalS2026"],
    ["--canonical-s26", "canonicalS26"],
    ["--canonical-a16zsr006", "canonicalA16zsr006"],
    ["--legacy-quarantine", "legacyQuarantine"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--write") result.write = true;
    else {
      const [rawFlag, inlineValue] = splitArgument(argument);
      const property = names.get(rawFlag);
      if (!property) throw new Error(`Unknown GitHub exhaustive staging argument: ${argument}`);
      const value = inlineValue ?? requiredValue(argv, ++index, rawFlag);
      if (result[property]) throw new Error(`${rawFlag} was supplied more than once.`);
      result[property] = value;
    }
  }
  return result;
}

function splitArgument(argument) {
  const separator = argument.indexOf("=");
  return separator === -1
    ? [argument, null]
    : [argument.slice(0, separator), argument.slice(separator + 1)];
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function helpText() {
  return `Usage: node scripts/stage-github-exhaustive-backfill.mjs [options]\n\n` +
    `Fail-closed adapter from one completed exhaustive GitHub run into separate staged artifacts.\n` +
    `Dry-run is the default and performs validation without writing output. This command never publishes.\n\n` +
    `Required inputs:\n` +
    `  --run-dir=PATH                 Completed run containing journal, checkpoint, summary, and materialization\n` +
    `  --canonical-s2026=PATH         Current authoritative S2026 GitHub traction snapshot\n` +
    `  --canonical-s26=PATH           Current authoritative S26 GitHub traction snapshot\n` +
    `  --canonical-a16zsr006=PATH     Current authoritative A16ZSR006 GitHub traction snapshot\n` +
    `  --legacy-quarantine=PATH       Current legacy GitHub quarantine (all rows preserved exactly)\n\n` +
    `Write controls:\n` +
    `  --write                        Write separate staged artifacts; never changes canonical files\n` +
    `  --output-dir=PATH              Required with --write; must be fresh and outside live/canonical dirs\n` +
    `  --help                         Show this help\n`;
}
