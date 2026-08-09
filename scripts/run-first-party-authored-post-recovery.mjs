#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  FIRST_PARTY_CURRENT_CANDIDATE_PATHS,
  FIRST_PARTY_HISTORY_PATHS,
  FIRST_PARTY_REFERENCE_PATHS,
  buildFirstPartyPromotionArtifact,
  buildFirstPartyReferenceIndex,
  buildOfficialDomainCatalog,
  evaluateFirstPartyAuthoredPost,
  extractFirstPartyRows,
  reconcileFirstPartyCandidates,
  sha256,
  stableJson,
} from "./lib/first-party-authored-post-recovery.mjs";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const baselineRef = args.baseline ?? "HEAD";
const outputDir = path.resolve(
  root,
  args.outputDir ?? "work/first-party-authored-post-recovery/current",
);
const candidatePath = path.join(outputDir, "promotion-candidate.json");
const summaryPath = path.join(outputDir, "summary.json");
const baselineCommit = (await gitText(["rev-parse", baselineRef])).trim();
const baselineCommittedAt = (
  await gitText(["show", "-s", "--format=%cI", baselineCommit])
).trim();
const includeHistory = args.history !== false;
const maxHistoryBlobs = integerArg(
  args.maxHistoryBlobs,
  Number.MAX_SAFE_INTEGER,
  {
    min: 0,
  },
);
const graphPaths = [
  "public/graph/s2026.json",
  "public/graph/s26.json",
  "public/graph/a16zsr006.json",
];
const referencePaths = listArg(
  args.referencePaths,
  FIRST_PARTY_REFERENCE_PATHS,
);
const currentCandidatePaths = listArg(
  args.currentCandidatePaths,
  FIRST_PARTY_CURRENT_CANDIDATE_PATHS,
);
const historyPaths = listArg(args.historyPaths, FIRST_PARTY_HISTORY_PATHS);
const externalInputs = listArg(args.inputs, []);

await mkdir(outputDir, { recursive: true });

const graphDocuments = await Promise.all(
  graphPaths.map((sourcePath) => readGitJson(baselineCommit, sourcePath)),
);
const catalog = buildOfficialDomainCatalog(graphDocuments);
const referenceDocuments = (
  await Promise.all(
    referencePaths.map((sourcePath) =>
      readGitJsonOptional(baselineCommit, sourcePath),
    ),
  )
).filter(Boolean);
const referenceIndex = buildFirstPartyReferenceIndex(referenceDocuments);

process.stdout.write(
  `${JSON.stringify({
    phase: "baseline",
    baselineCommit,
    officialOwners: catalog.byScopedEntity.size,
    referenceRows: referenceIndex.rows,
    referenceUrls: referenceIndex.urlKeys.size,
    referenceContentFingerprints: referenceIndex.contentKeys.size,
    networkMode: "offline_or_anonymous_public_only",
    linkedinAccess: false,
  })}\n`,
);

const evaluations = [];
const sourcePaths = [];
const scanAudit = {
  currentDocuments: 0,
  externalDocuments: 0,
  historyBlobPathPairs: 0,
  parsedDocuments: 0,
  parseFailures: 0,
  scannedRows: 0,
  scannedRowsBySource: {},
};

for (const sourcePath of currentCandidatePaths) {
  const document = await readGitJsonOptional(baselineCommit, sourcePath);
  if (!document) continue;
  scanDocument(document, {
    sourcePath,
    sourceKind: sourcePath.includes("public-ingestion-review-ledger")
      ? "current_review_ledger"
      : "current_artifact",
  });
  scanAudit.currentDocuments += 1;
}

for (const input of externalInputs) {
  const absolutePath = path.resolve(root, input);
  const document = JSON.parse(await readFile(absolutePath, "utf8"));
  scanDocument(document, {
    sourcePath: path.relative(root, absolutePath),
    sourceKind: "anonymous_public_refresh",
  });
  scanAudit.externalDocuments += 1;
}

if (includeHistory && maxHistoryBlobs > 0) {
  const historyTasks = (await collectHistoryBlobs(historyPaths)).slice(
    0,
    maxHistoryBlobs,
  );
  scanAudit.historyBlobPathPairs = historyTasks.length;
  let processed = 0;
  for (const task of historyTasks) {
    try {
      const document = JSON.parse(
        await gitText(["cat-file", "blob", task.blob]),
      );
      scanDocument(document, {
        sourcePath: task.path,
        sourceKind: "repository_history",
      });
    } catch (error) {
      scanAudit.parseFailures += 1;
      process.stderr.write(
        `Skipped unparsable history blob ${task.blob} ${task.path}: ${error.message}\n`,
      );
    }
    processed += 1;
    if (processed % 25 === 0 || processed === historyTasks.length) {
      process.stdout.write(
        `${JSON.stringify({
          phase: "history",
          processed,
          total: historyTasks.length,
          scannedRows: scanAudit.scannedRows,
          acceptedBeforeDeduplication: evaluations.filter(
            (entry) => entry.accepted,
          ).length,
        })}\n`,
      );
    }
  }
}

const reconciliation = reconcileFirstPartyCandidates(evaluations, {
  referenceIndex,
});
if (!reconciliation.audit.zeroDuplicateAudit) {
  throw new Error(
    `First-party candidate failed zero-duplicate audit: ${JSON.stringify(reconciliation.audit)}`,
  );
}

const artifact = buildFirstPartyPromotionArtifact({
  baselineCommit,
  generatedAt: new Date(baselineCommittedAt).toISOString(),
  sources: sourcePaths,
  reconciliation,
  scanAudit: {
    ...scanAudit,
    scannedRowsBySource: sortRecord(scanAudit.scannedRowsBySource),
  },
});
const candidateBody = stableJson(artifact);
await writeAtomic(candidatePath, candidateBody);

const summary = {
  schemaVersion: "first-party-authored-post-recovery-summary.v1",
  complete: true,
  baselineCommit,
  baselineCommittedAt,
  candidateSha256: sha256(candidateBody),
  constraints: artifact.constraints,
  paths: {
    candidate: path.relative(root, candidatePath),
    summary: path.relative(root, summaryPath),
  },
  counts: artifact.counts,
  audit: artifact.audit,
};
await writeAtomic(summaryPath, stableJson(summary));

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function scanDocument(document, { sourcePath, sourceKind }) {
  const rows = extractFirstPartyRows(document);
  scanAudit.parsedDocuments += 1;
  scanAudit.scannedRows += rows.length;
  scanAudit.scannedRowsBySource[sourceKind] =
    (scanAudit.scannedRowsBySource[sourceKind] ?? 0) + rows.length;
  sourcePaths.push(sourcePath);
  for (const row of rows) {
    evaluations.push(
      evaluateFirstPartyAuthoredPost(row, {
        catalog,
        referenceIndex,
        sourcePath,
        sourceKind,
      }),
    );
  }
}

async function collectHistoryBlobs(paths) {
  const tasks = new Map();
  for (const sourcePath of paths) {
    const lines = parseLines(
      await gitText(["rev-list", "--objects", "--all", "--", sourcePath]),
    );
    for (const line of lines) {
      const separator = line.indexOf(" ");
      if (separator < 0) continue;
      const blob = line.slice(0, separator);
      const objectPath = line.slice(separator + 1).trim();
      if (objectPath !== sourcePath || !/^[0-9a-f]{40,64}$/i.test(blob))
        continue;
      tasks.set(`${sourcePath}\u0000${blob}`, { path: sourcePath, blob });
    }
  }
  return [...tasks.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.blob.localeCompare(right.blob),
  );
}

async function readGitJson(commit, sourcePath) {
  return JSON.parse(await gitText(["show", `${commit}:${sourcePath}`]));
}

async function readGitJsonOptional(commit, sourcePath) {
  try {
    return await readGitJson(commit, sourcePath);
  } catch (error) {
    if (
      /does not exist|exists on disk, but not in|Path .* does not exist/i.test(
        error.message,
      )
    ) {
      return null;
    }
    throw error;
  }
}

async function gitText(command) {
  const result = await execFileAsync("git", command, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  return result.stdout;
}

async function writeAtomic(targetPath, body) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, body, "utf8");
  await rename(temporaryPath, targetPath);
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    if (value === "--no-history") {
      parsed.history = false;
      continue;
    }
    if (!value.startsWith("--")) continue;
    const separator = value.indexOf("=");
    if (separator < 0) {
      parsed[value.slice(2)] = true;
      continue;
    }
    parsed[value.slice(2, separator)] = value.slice(separator + 1);
  }
  return parsed;
}

function listArg(value, fallback) {
  if (value === undefined || value === null || value === "")
    return [...fallback];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function integerArg(
  value,
  fallback,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(
      `Expected integer between ${min} and ${max}, received ${value}.`,
    );
  }
  return number;
}

function parseLines(value) {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function sortRecord(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}
