#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { physicalSourceKey } from "./lib/ingestion-source-delta.mjs";
import {
  REPOSITORY_SIDECAR_HISTORY_PATHS,
  buildCohortOwnerCatalog,
  buildPromotionCandidateArtifact,
  evaluateHistoricalSidecarRow,
  extractCurrentEvidenceRows,
  extractCurrentHeldRows,
  extractEvidenceRows,
  physicalIdentityKeys,
  recoveryPhysicalKey,
  sha256,
  stableJson,
  summarizeRecoveryJournal,
  validateNativeCandidate
} from "./lib/repository-sidecar-history-recovery.mjs";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const baselineRef = args.baseline ?? "HEAD";
const outputDir = resolve(root, args.outputDir ?? "work/repository-sidecar-history-recovery/non-public-current");
const journalPath = resolve(outputDir, "journal.ndjson");
const checkpointPath = resolve(outputDir, "checkpoint.json");
const candidatePath = resolve(outputDir, "promotion-candidate.json");
const summaryPath = resolve(outputDir, "summary.json");
const discoveryWorkers = integerArg(args.workers, 8, { min: 1, max: 16 });
const validationWorkers = integerArg(args.validationWorkers, 6, { min: 1, max: 12 });
const requestTimeoutMs = integerArg(args.requestTimeoutMs, 15_000, { min: 1_000, max: 120_000 });
const retries = integerArg(args.retries, 3, { min: 1, max: 8 });
const maxBlobs = integerArg(args.maxBlobs, Number.MAX_SAFE_INTEGER, { min: 1 });
const maxValidations = integerArg(args.maxValidations, Number.MAX_SAFE_INTEGER, { min: 1 });
const offline = args.allowAnonymousLiveValidation !== true;
const implementationFingerprint = sha256([
  await readFile(new URL(import.meta.url), "utf8"),
  await readFile(new URL("./lib/repository-sidecar-history-recovery.mjs", import.meta.url), "utf8")
].join("\n--implementation-boundary--\n"));
const historyPaths = args.historyPaths
  ? args.historyPaths.split(",").map((value) => value.trim()).filter(Boolean)
  : [...REPOSITORY_SIDECAR_HISTORY_PATHS];

if (historyPaths.some((path) => /public-evidence-current\.json$/i.test(path))) {
  throw new Error("Public evidence history is explicitly excluded from this recovery lane.");
}
if (!args.resume && await exists(journalPath)) {
  throw new Error(`Output journal already exists at ${journalPath}; pass --resume or choose another output directory.`);
}
await mkdir(outputDir, { recursive: true });

const baselineCommit = (await gitText(["rev-parse", baselineRef])).trim();
const baselineCommittedAt = (await gitText(["show", "-s", "--format=%cI", baselineCommit])).trim();
const trackedPaths = parseLines(await gitText(["ls-tree", "-r", "--name-only", baselineCommit]));
const graphPaths = ["public/graph/s2026.json", "public/graph/s26.json", "public/graph/a16zsr006.json"];
const currentEvidencePaths = trackedPaths.filter(isCurrentEvidenceSourcePath);

process.stdout.write(`${JSON.stringify({
  phase: "baseline",
  baselineCommit,
  currentEvidenceSources: currentEvidencePaths.length,
  historyPaths: historyPaths.length,
  validationMode: offline ? "offline" : "anonymous_public_endpoints"
})}\n`);

const graphDocuments = await mapLimit(graphPaths, 3, async (path) => parseGitJson(baselineCommit, path));
const catalog = buildCohortOwnerCatalog(graphDocuments);
const currentIndex = await buildCurrentPhysicalIndex(baselineCommit, currentEvidencePaths);
const currentPhysicalKeys = currentIndex.keys;
const currentFingerprint = sha256(stableJson({
  paths: currentEvidencePaths,
  physicalKeys: [...currentPhysicalKeys].sort(),
  heldPhysicalKeys: [...currentIndex.heldKeys].sort()
}));

process.stdout.write(`${JSON.stringify({
  phase: "baseline_complete",
  currentPhysicalSources: currentIndex.primaryKeys.size,
  currentPhysicalIdentityKeys: currentPhysicalKeys.size,
  currentReviewHoldIdentityKeys: currentIndex.heldKeys.size,
  currentFingerprint
})}\n`);

const historyTasks = (await collectHistoryTasks(historyPaths)).slice(0, maxBlobs);
const runIdentity = sha256(stableJson({
  schemaVersion: 1,
  baselineCommit,
  currentFingerprint,
  implementationFingerprint,
  historyPaths,
  tasks: historyTasks.map((task) => ({ token: task.token, origins: task.origins }))
}));
const priorCheckpoint = await readJson(checkpointPath, null);
if (priorCheckpoint && priorCheckpoint.runIdentity !== runIdentity) {
  throw new Error("Recovery inputs changed since the checkpoint; choose a new output directory.");
}

let journalEvents = await readNdjson(journalPath);
let journalState = summarizeRecoveryJournal(journalEvents);
let processedBlobs = journalState.completedBlobs.size;
for (const chunk of chunks(
  historyTasks.filter((task) => !journalState.completedBlobs.has(task.token)),
  discoveryWorkers
)) {
  const results = await Promise.all(chunk.map(async (task) => {
    const blobText = await gitText(["cat-file", "blob", task.blob], 256 * 1024 * 1024);
    return inspectBlob(task, blobText, {
      catalog,
      currentPhysicalKeys,
      currentHeldPhysicalKeys: currentIndex.heldKeys
    });
  }));
  results.sort((left, right) => left.token.localeCompare(right.token));
  for (const event of results) {
    await appendNdjson(journalPath, event);
    journalEvents.push(event);
    processedBlobs += 1;
  }
  journalState = summarizeRecoveryJournal(journalEvents);
  await writeCheckpoint({
    phase: "discovery",
    runIdentity,
    baselineCommit,
    baselineCommittedAt,
    currentFingerprint,
    currentPhysicalSources: currentIndex.primaryKeys.size,
    currentPhysicalIdentityKeys: currentPhysicalKeys.size,
    currentReviewHoldIdentityKeys: currentIndex.heldKeys.size,
    historyTasks: historyTasks.length,
    processedBlobs,
    discoveredCandidates: journalState.candidates.size
  });
  process.stdout.write(`${JSON.stringify({
    phase: "discovery",
    processedBlobs,
    historyTasks: historyTasks.length,
    candidates: journalState.candidates.size
  })}\n`);
}

let validationsStarted = 0;
let validationRound = 0;
while (validationRound < 4) {
  validationRound += 1;
  journalState = summarizeRecoveryJournal(journalEvents);
  const pending = [...journalState.candidates.values()]
    .filter((candidate) => !journalState.validations.has(candidate.physicalKey))
    .sort((left, right) => left.physicalKey.localeCompare(right.physicalKey));
  if (pending.length === 0 || validationsStarted >= maxValidations) break;
  let deferredThisRound = 0;
  for (const chunk of chunks(pending.slice(0, maxValidations - validationsStarted), validationWorkers)) {
    const events = await Promise.all(chunk.map(async (candidate) => {
      validationsStarted += 1;
      const outcome = await validateWithRetry(candidate, {
        retries,
        timeoutMs: requestTimeoutMs,
        offline
      });
      if (outcome.status === "deferred") deferredThisRound += 1;
      return {
        schemaVersion: 1,
        type: "validation_checkpoint",
        physicalKey: candidate.physicalKey,
        checkedAt: new Date().toISOString(),
        ...outcome
      };
    }));
    events.sort((left, right) => left.physicalKey.localeCompare(right.physicalKey));
    for (const event of events) {
      await appendNdjson(journalPath, event);
      journalEvents.push(event);
    }
    journalState = summarizeRecoveryJournal(journalEvents);
    await writeCheckpoint({
      phase: "validation",
      runIdentity,
      baselineCommit,
      baselineCommittedAt,
      currentFingerprint,
      currentPhysicalSources: currentIndex.primaryKeys.size,
      currentPhysicalIdentityKeys: currentPhysicalKeys.size,
      currentReviewHoldIdentityKeys: currentIndex.heldKeys.size,
      historyTasks: historyTasks.length,
      processedBlobs,
      discoveredCandidates: journalState.candidates.size,
      completedValidations: journalState.validations.size
    });
    process.stdout.write(`${JSON.stringify({
      phase: "validation",
      round: validationRound,
      completed: journalState.validations.size,
      candidates: journalState.candidates.size
    })}\n`);
  }
  if (deferredThisRound === 0) break;
  if (validationsStarted >= maxValidations) break;
  await delay(Math.min(2_000 * validationRound, 8_000));
}

journalState = summarizeRecoveryJournal(journalEvents);
const discoveryAudit = aggregateDiscoveryAudit(journalEvents);
const artifact = buildPromotionCandidateArtifact({
  runIdentity,
  baselineCommit,
  historyPaths,
  candidates: journalState.candidates,
  validations: journalState.validations,
  audit: {
    currentEvidenceSourceCount: currentEvidencePaths.length,
    currentPhysicalSources: currentIndex.primaryKeys.size,
    currentPhysicalIdentityKeys: currentPhysicalKeys.size,
    currentReviewHoldIdentityKeys: currentIndex.heldKeys.size,
    historyBlobPathPairs: historyTasks.length,
    processedBlobPathPairs: journalState.completedBlobs.size,
    discoveredCandidates: journalState.candidates.size,
    completedValidations: journalState.validations.size,
    validationMode: offline ? "offline" : "anonymous_public_endpoints",
    scannedRows: discoveryAudit.scannedRows,
    rejectedRows: discoveryAudit.rejectedRows,
    uniqueOtherwiseEligibleReviewHeld: discoveryAudit.uniqueOtherwiseEligibleReviewHeld,
    otherwiseEligibleReviewHeldByCohortPlatform:
      discoveryAudit.otherwiseEligibleReviewHeldByCohortPlatform,
    discoveryRejectionCounts: discoveryAudit.rejectionCounts
  }
});
const artifactBody = stableJson(artifact);
await writeAtomic(candidatePath, artifactBody);

const complete = journalState.completedBlobs.size === historyTasks.length
  && journalState.validations.size === journalState.candidates.size;
const summary = {
  schemaVersion: 1,
  complete,
  runIdentity,
  baselineCommit,
  baselineCommittedAt,
  currentFingerprint,
  validationMode: offline ? "offline" : "anonymous_public_endpoints",
  candidateSha256: sha256(artifactBody),
  paths: {
    candidate: relativeToRoot(candidatePath),
    checkpoint: relativeToRoot(checkpointPath),
    journal: relativeToRoot(journalPath)
  },
  counts: artifact.counts,
  audit: artifact.audit
};
await writeAtomic(summaryPath, stableJson(summary));
await writeCheckpoint({
  phase: complete ? "complete" : "partial",
  runIdentity,
  baselineCommit,
  baselineCommittedAt,
  currentFingerprint,
  currentPhysicalSources: currentIndex.primaryKeys.size,
  currentPhysicalIdentityKeys: currentPhysicalKeys.size,
  currentReviewHoldIdentityKeys: currentIndex.heldKeys.size,
  historyTasks: historyTasks.length,
  processedBlobs: journalState.completedBlobs.size,
  discoveredCandidates: journalState.candidates.size,
  completedValidations: journalState.validations.size,
  validationMode: offline ? "offline" : "anonymous_public_endpoints",
  candidateSha256: summary.candidateSha256
});
process.stdout.write(`${stableJson(summary)}`);
if (!complete && !args.allowPartial) process.exitCode = 2;

async function buildCurrentPhysicalIndex(commit, paths) {
  const keys = new Set();
  const primaryKeys = new Set();
  const heldKeys = new Set();
  let rows = 0;
  for (const chunk of chunks(paths, 2)) {
    const documents = await Promise.all(chunk.map(async (path) => ({
      path,
      document: await parseGitJson(commit, path)
    })));
    for (const { path, document } of documents) {
      for (const row of extractCurrentEvidenceRows(document, { sourcePath: path })) {
        rows += 1;
        const key = physicalSourceKey(row);
        if (key) primaryKeys.add(key);
        for (const identity of physicalIdentityKeys(row)) keys.add(identity);
      }
      for (const row of extractCurrentHeldRows(document, { sourcePath: path })) {
        for (const identity of physicalIdentityKeys(row)) heldKeys.add(identity);
        const canonical = recoveryPhysicalKey(row);
        if (canonical) heldKeys.add(canonical);
      }
    }
  }
  return { keys, primaryKeys, heldKeys, rows };
}

async function collectHistoryTasks(paths) {
  const history = await gitText(["log", "--all", "--format=%H%x09%cI", "--", ...paths]);
  const commits = parseLines(history).map((line) => {
    const [commit, committedAt] = line.split("\t");
    return { commit, committedAt };
  });
  const byToken = new Map();
  for (const chunk of chunks(commits, discoveryWorkers)) {
    const trees = await Promise.all(chunk.map(async (entry) => ({
      ...entry,
      tree: await gitText(["ls-tree", "-r", entry.commit, "--", ...paths])
    })));
    for (const entry of trees) {
      for (const line of parseLines(entry.tree)) {
        const match = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/);
        if (!match) continue;
        const [, blob, path] = match;
        const token = `${path}:${blob}`;
        const task = byToken.get(token) ?? { token, blob, path, origins: [] };
        task.origins.push({ commit: entry.commit, committedAt: entry.committedAt });
        byToken.set(token, task);
      }
    }
  }
  for (const task of byToken.values()) {
    task.origins.sort((left, right) =>
      String(right.committedAt).localeCompare(String(left.committedAt))
      || String(right.commit).localeCompare(String(left.commit))
    );
  }
  return [...byToken.values()].sort((left, right) => left.token.localeCompare(right.token));
}

function inspectBlob(task, blobText, { catalog, currentPhysicalKeys, currentHeldPhysicalKeys }) {
  const origin = task.origins[0];
  const counters = { rows: 0, accepted: 0, rejected: {} };
  const candidates = [];
  const heldCandidates = new Map();
  let document;
  try {
    document = JSON.parse(blobText);
  } catch {
    counters.rejected.invalid_json_blob = 1;
    return blobEvent();
  }
  for (const [sourceIndex, row] of extractEvidenceRows(document).entries()) {
    counters.rows += 1;
    const decision = evaluateHistoricalSidecarRow(row, {
      catalog,
      currentPhysicalKeys,
      currentHeldPhysicalKeys,
      sourcePath: task.path
    });
    if (!decision.accepted) {
      for (const reason of decision.reasons) {
        counters.rejected[reason] = (counters.rejected[reason] ?? 0) + 1;
      }
      if (
        decision.physicalKey
        && decision.reasons.length === 1
        && decision.reasons[0] === "current_review_hold_not_promotion_ready"
      ) {
        heldCandidates.set(decision.physicalKey, {
          physicalKey: decision.physicalKey,
          batchSlug: decision.owner?.batchSlug ?? null,
          platform: decision.platform ?? null
        });
      }
      continue;
    }
    counters.accepted += 1;
    candidates.push({
      physicalKey: decision.physicalKey,
      blob: task.blob,
      commit: origin.commit,
      committedAt: origin.committedAt,
      path: task.path,
      sourceIndex,
      occurrenceCount: task.origins.length,
      row,
      decision: {
        ...decision,
        row: undefined
      }
    });
  }
  return blobEvent();

  function blobEvent() {
    return {
      schemaVersion: 1,
      type: "blob_checkpoint",
      token: task.token,
      blob: task.blob,
      path: task.path,
      origins: task.origins,
      observedAt: new Date().toISOString(),
      counters,
      heldCandidates: [...heldCandidates.values()].sort((left, right) =>
        left.physicalKey.localeCompare(right.physicalKey)
      ),
      candidates
    };
  }
}

async function validateWithRetry(candidate, { retries: retryLimit, timeoutMs, offline: offlineMode }) {
  if (offlineMode) {
    const result = await validateNativeCandidate(candidate, { offline: true, fetchImpl: null });
    return { ...result, attempts: 0 };
  }
  let last = null;
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        last = await validateNativeCandidate(candidate, {
          fetchImpl: (url, options = {}) => fetch(url, { ...options, signal: controller.signal })
        });
      } finally {
        clearTimeout(timeout);
      }
      if (last.status === "accepted" || !isTransientValidation(last)) {
        return { ...last, attempts: attempt };
      }
    } catch (error) {
      last = {
        status: "deferred",
        live: true,
        method: null,
        canonicalUrl: null,
        reasons: [error?.name === "AbortError" ? "native_validation_timeout" : "native_validation_network_error"]
      };
    }
    if (attempt < retryLimit) await delay(Math.min(250 * 2 ** (attempt - 1), 2_000));
  }
  return {
    ...(last ?? { live: true, method: null, canonicalUrl: null, reasons: ["native_validation_failed"] }),
    status: "deferred",
    attempts: retryLimit
  };
}

function isTransientValidation(result) {
  return (result?.reasons ?? []).some((reason) =>
    /_http_(?:408|425|429|500|502|503|504)$/.test(reason)
    || /(?:timeout|network_error)$/.test(reason)
  );
}

function aggregateDiscoveryAudit(events) {
  let scannedRows = 0;
  let rejectedRows = 0;
  const rejectionCounts = {};
  const heldCandidates = new Map();
  for (const event of events) {
    if (event?.type !== "blob_checkpoint") continue;
    const eventRows = Number(event?.counters?.rows ?? 0);
    const eventAccepted = Number(event?.counters?.accepted ?? 0);
    scannedRows += eventRows;
    rejectedRows += Math.max(0, eventRows - eventAccepted);
    for (const [reason, count] of Object.entries(event?.counters?.rejected ?? {})) {
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + Number(count ?? 0);
    }
    for (const candidate of event?.heldCandidates ?? []) {
      if (candidate?.physicalKey) heldCandidates.set(candidate.physicalKey, candidate);
    }
  }
  const otherwiseEligibleReviewHeldByCohortPlatform = {};
  for (const candidate of heldCandidates.values()) {
    const key = `${candidate.batchSlug ?? "unscoped"}:${candidate.platform ?? "unknown"}`;
    otherwiseEligibleReviewHeldByCohortPlatform[key] =
      (otherwiseEligibleReviewHeldByCohortPlatform[key] ?? 0) + 1;
  }
  return {
    scannedRows,
    rejectedRows,
    uniqueOtherwiseEligibleReviewHeld: heldCandidates.size,
    otherwiseEligibleReviewHeldByCohortPlatform: Object.fromEntries(
      Object.entries(otherwiseEligibleReviewHeldByCohortPlatform)
        .sort(([a], [b]) => a.localeCompare(b))
    ),
    rejectionCounts: Object.fromEntries(Object.entries(rejectionCounts).sort(([a], [b]) => a.localeCompare(b)))
  };
}

function isCurrentEvidenceSourcePath(path) {
  if (!path.endsWith(".json")) return false;
  return path.startsWith("src/lib/social/")
    || path.startsWith("public/graph/")
    || path.startsWith("public/topic-facets/")
    || (path.startsWith("src/lib/graph/") && /sidecar/i.test(path));
}

async function parseGitJson(commit, path) {
  const text = await gitText(["show", `${commit}:${path}`], 256 * 1024 * 1024);
  return JSON.parse(text);
}

async function gitText(argv, maxBuffer = 32 * 1024 * 1024) {
  const result = await execFileAsync("git", argv, {
    cwd: root,
    encoding: "utf8",
    maxBuffer
  });
  return result.stdout;
}

async function appendNdjson(path, value) {
  await appendFile(path, `${JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`);
}

async function readNdjson(path) {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeCheckpoint(value) {
  await writeAtomic(checkpointPath, stableJson(value));
}

async function writeAtomic(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, body);
  await rename(temporary, path);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function mapLimit(values, limit, mapper) {
  const output = [];
  for (const chunk of chunks(values, limit)) output.push(...await Promise.all(chunk.map(mapper)));
  return output;
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function parseLines(value) {
  return String(value ?? "").split(/\r?\n/).filter(Boolean);
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    parsed[toCamelCase(key)] = rest.length > 0 ? rest.join("=") : true;
  }
  return parsed;
}

function integerArg(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer from ${min} to ${max}; received ${value}.`);
  }
  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function relativeToRoot(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
