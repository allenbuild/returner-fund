#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { physicalSourceKey } from "./lib/ingestion-source-delta.mjs";
import {
  buildCohortOwnerCatalog,
  buildRecoveredEvidenceRow,
  evaluateHistoricalXRow,
  summarizeRecoveryJournal,
  validateXOembedPayload
} from "./lib/repository-history-x-recovery.mjs";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const outputDir = resolve(root, args.outputDir ?? "work/repository-history-recovery/x-main-history");
const journalPath = resolve(outputDir, "journal.ndjson");
const checkpointPath = resolve(outputDir, "checkpoint.json");
const evidencePath = resolve(outputDir, "verified-new-evidence.ndjson");
const summaryPath = resolve(outputDir, "summary.json");
const revision = args.revision ?? "HEAD";
const blobPaceMs = integerArg(args.blobPaceMs, 10, { min: 0, max: 10_000 });
const hostPaceMs = integerArg(args.hostPaceMs, 300, { min: 0, max: 60_000 });
const requestTimeoutMs = integerArg(args.requestTimeoutMs, 15_000, { min: 1_000, max: 120_000 });
const retries = integerArg(args.retries, 3, { min: 1, max: 8 });
const maxCommits = integerArg(args.maxCommits, Number.MAX_SAFE_INTEGER, { min: 1 });
const maxValidations = integerArg(args.maxValidations, Number.MAX_SAFE_INTEGER, { min: 1 });

const historySourcePaths = [
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/volume-evidence-current.json"
];
const currentDedupePaths = [
  ...historySourcePaths,
  "src/lib/social/a16z-speedrun-006-social-evidence.json",
  "src/lib/social/eden-robotics-verified-native-evidence.json"
];
const graphPaths = [
  "public/graph/s2026.json",
  "public/graph/s26.json",
  "public/graph/a16zsr006.json"
];

if (!args.resume && await exists(journalPath)) {
  throw new Error(`Output journal already exists at ${journalPath}; pass --resume or choose a new --output-dir.`);
}
await mkdir(outputDir, { recursive: true });

const [headCommit, graphSnapshots, currentSnapshots, inputFingerprint] = await Promise.all([
  gitText(["rev-parse", revision]).then((value) => value.trim()),
  Promise.all(graphPaths.map(readJson)),
  Promise.all(currentDedupePaths.map(readJson)),
  fingerprintFiles([...currentDedupePaths, ...graphPaths])
]);
const catalog = buildCohortOwnerCatalog(graphSnapshots);
const currentPhysicalKeys = new Set();
for (const snapshot of currentSnapshots) {
  for (const row of snapshot?.evidence ?? []) {
    const key = physicalSourceKey(row);
    if (key) currentPhysicalKeys.add(key);
  }
}

const commits = (await gitText(["rev-list", revision, "--", ...historySourcePaths]))
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .slice(0, maxCommits);
const runIdentity = sha256(JSON.stringify({
  schemaVersion: 1,
  headCommit,
  revision,
  commits,
  historySourcePaths,
  currentDedupePaths,
  graphPaths,
  inputFingerprint
}));
const priorCheckpoint = await readJson(checkpointPath, null);
if (priorCheckpoint && priorCheckpoint.runIdentity !== runIdentity) {
  throw new Error("Recovery inputs changed since the checkpoint; use a new output directory instead of mixing runs.");
}

let journalEvents = await readNdjson(journalPath);
let journalState = summarizeRecoveryJournal(journalEvents);
let processedBlobs = journalState.completedBlobs.size;
for (const [commitIndex, commit] of commits.entries()) {
  const committedAt = (await gitText(["show", "-s", "--format=%cI", commit])).trim();
  for (const sourcePath of historySourcePaths) {
    const token = `${commit}:${sourcePath}`;
    if (journalState.completedBlobs.has(token)) continue;
    const blob = await gitTextOrNull(["show", `${commit}:${sourcePath}`]);
    const counters = { rows: 0, accepted: 0, rejected: {} };
    const candidates = [];
    if (blob !== null) {
      let snapshot;
      try {
        snapshot = JSON.parse(blob);
      } catch {
        counters.rejected.invalid_json_blob = 1;
        snapshot = { evidence: [] };
      }
      for (const [sourceIndex, row] of (snapshot?.evidence ?? []).entries()) {
        counters.rows += 1;
        const decision = evaluateHistoricalXRow(row, { catalog, currentPhysicalKeys });
        if (!decision.accepted) {
          for (const reason of decision.reasons) {
            counters.rejected[reason] = (counters.rejected[reason] ?? 0) + 1;
          }
          continue;
        }
        counters.accepted += 1;
        candidates.push({
          physicalKey: decision.physicalKey,
          commit,
          committedAt,
          path: sourcePath,
          sourceIndex,
          row
        });
      }
    } else {
      counters.rejected.path_absent_at_commit = 1;
    }
    const event = {
      schemaVersion: 1,
      type: "blob_checkpoint",
      token,
      commit,
      committedAt,
      commitIndex,
      path: sourcePath,
      observedAt: new Date().toISOString(),
      counters,
      candidates
    };
    await appendNdjson(journalPath, event);
    journalEvents.push(event);
    journalState = summarizeRecoveryJournal(journalEvents);
    processedBlobs += 1;
    await writeCheckpoint({ phase: "discovery", runIdentity, headCommit, inputFingerprint, commits, processedBlobs });
    process.stdout.write(`${JSON.stringify({ phase: "discovery", processedBlobs, totalBlobs: commits.length * historySourcePaths.length, candidates: journalState.candidates.size })}\n`);
    if (blobPaceMs > 0) await delay(blobPaceMs);
  }
}

let validationsStarted = 0;
for (const candidateRecord of journalState.candidates.values()) {
  if (journalState.validations.has(candidateRecord.physicalKey)) continue;
  if (validationsStarted >= maxValidations) break;
  validationsStarted += 1;
  const decision = evaluateHistoricalXRow(candidateRecord.row, { catalog, currentPhysicalKeys });
  let validationEvent;
  if (!decision.accepted) {
    validationEvent = {
      schemaVersion: 1,
      type: "validation_checkpoint",
      physicalKey: candidateRecord.physicalKey,
      status: "rejected",
      checkedAt: new Date().toISOString(),
      reasons: decision.reasons,
      attempts: 0
    };
  } else {
    const endpoint = xOembedUrl(decision.native.url);
    const response = await fetchJsonWithRetry(endpoint, { retries, timeoutMs: requestTimeoutMs });
    const liveDecision = response.ok
      ? validateXOembedPayload(response.payload, decision)
      : { accepted: false, reasons: [`x_oembed_http_${response.status ?? "failed"}`] };
    validationEvent = {
      schemaVersion: 1,
      type: "validation_checkpoint",
      physicalKey: candidateRecord.physicalKey,
      status: liveDecision.accepted ? "accepted" : "rejected",
      checkedAt: new Date().toISOString(),
      endpoint,
      attempts: response.attempts,
      httpStatus: response.status,
      reasons: liveDecision.reasons,
      payload: response.ok ? response.payload : null
    };
  }
  await appendNdjson(journalPath, validationEvent);
  journalEvents.push(validationEvent);
  journalState = summarizeRecoveryJournal(journalEvents);
  await writeCheckpoint({ phase: "validation", runIdentity, headCommit, inputFingerprint, commits, processedBlobs });
  process.stdout.write(`${JSON.stringify({ phase: "validation", physicalKey: candidateRecord.physicalKey, status: validationEvent.status })}\n`);
  if (hostPaceMs > 0) await delay(hostPaceMs);
}

const recoveredRows = [];
const liveRejections = {};
for (const [physicalKey, candidateRecord] of journalState.candidates) {
  const validationEvent = journalState.validations.get(physicalKey);
  if (!validationEvent || validationEvent.status !== "accepted") {
    for (const reason of validationEvent?.reasons ?? ["live_validation_not_completed"]) {
      liveRejections[reason] = (liveRejections[reason] ?? 0) + 1;
    }
    continue;
  }
  const decision = evaluateHistoricalXRow(candidateRecord.row, { catalog, currentPhysicalKeys });
  const liveDecision = validateXOembedPayload(validationEvent.payload, decision);
  if (!decision.accepted || !liveDecision.accepted) continue;
  recoveredRows.push(buildRecoveredEvidenceRow(decision, liveDecision, {
    commit: candidateRecord.commit,
    committedAt: candidateRecord.committedAt,
    path: candidateRecord.path,
    sourceIndex: candidateRecord.sourceIndex,
    checkedAt: validationEvent.checkedAt,
    endpoint: validationEvent.endpoint,
    returnedUrl: validationEvent.payload?.url ?? null
  }));
}
recoveredRows.sort((left, right) =>
  left.batchSlug.localeCompare(right.batchSlug) ||
  left.entityId.localeCompare(right.entityId) ||
  left.postedAt.localeCompare(right.postedAt) ||
  left.platformPostId.localeCompare(right.platformPostId)
);

const recoveredKeys = recoveredRows.map((row) => physicalSourceKey(row));
if (recoveredKeys.some((key) => !key || currentPhysicalKeys.has(key))) {
  throw new Error("Dry-run output contains a missing or already-current physical identity.");
}
if (new Set(recoveredKeys).size !== recoveredKeys.length) {
  throw new Error("Dry-run output contains duplicate physical identities.");
}

const blobEvents = journalEvents.filter((event) => event?.type === "blob_checkpoint");
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  dryRun: true,
  lane: "main_branch_repository_history_x",
  revision,
  headCommit,
  inputFingerprint,
  disjointFromActivePlatforms: ["hacker_news", "rss"],
  historySourcePaths,
  currentDedupePaths,
  graphPaths,
  output: {
    journalPath,
    checkpointPath,
    verifiedNewEvidencePath: evidencePath
  },
  counts: {
    commitsPlanned: commits.length,
    blobsPlanned: commits.length * historySourcePaths.length,
    blobsCompleted: journalState.completedBlobs.size,
    historicalEvidenceRowsScanned: blobEvents.reduce((sum, event) => sum + Number(event?.counters?.rows ?? 0), 0),
    currentPhysicalKeys: currentPhysicalKeys.size,
    deduplicatedHistoryCandidates: journalState.candidates.size,
    liveValidationsCompleted: journalState.validations.size,
    exactNewVerifiedRows: recoveredRows.length,
    byBatch: countBy(recoveredRows, (row) => row.batchSlug),
    byOwner: countBy(recoveredRows, (row) => `${row.batchSlug}:${row.entityType}:${row.entityId}`),
    liveRejections
  },
  guarantees: [
    "Every emitted row was accepted evidence in main-branch Git history.",
    "Every native X author matches a current verified company/founder account mapping.",
    "Every post was revalidated through the official public X oEmbed endpoint without credentials.",
    "Every exact publication timestamp was derived from the immutable native X snowflake ID.",
    "Every physical post identity is absent from all current canonical source snapshots and unique within this dry-run output.",
    "No canonical evidence, workflow, graph, scoring, stats, topic, timeline, or ranked-post artifact was modified."
  ]
};
await atomicWrite(evidencePath, recoveredRows.map((row) => `${ndjson(row)}\n`).join(""));
await atomicWrite(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
await writeCheckpoint({
  phase: journalState.validations.size === journalState.candidates.size ? "complete" : "validation",
  runIdentity,
  headCommit,
  inputFingerprint,
  commits,
  processedBlobs,
  exactNewVerifiedRows: recoveredRows.length
});
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

async function writeCheckpoint(extra) {
  await atomicWrite(checkpointPath, `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    ...extra
  }, null, 2)}\n`);
}

async function fetchJsonWithRetry(url, { retries: retryLimit, timeoutMs }) {
  let lastStatus = null;
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "ReturnerFundRepositoryHistoryRecovery/1.0 (+public-evidence-audit)"
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      lastStatus = response.status;
      if (response.ok) {
        return { ok: true, status: response.status, attempts: attempt, payload: await response.json() };
      }
      if (response.status !== 429 && response.status < 500) {
        return { ok: false, status: response.status, attempts: attempt, payload: null };
      }
    } catch {
      // Retry bounded transport failures and timeouts.
    }
    if (attempt < retryLimit) await delay(Math.min(4_000, 500 * 2 ** (attempt - 1)));
  }
  return { ok: false, status: lastStatus, attempts: retryLimit, payload: null };
}

function xOembedUrl(statusUrl) {
  const url = new URL("https://publish.twitter.com/oembed");
  url.searchParams.set("omit_script", "1");
  url.searchParams.set("dnt", "1");
  url.searchParams.set("url", statusUrl);
  return url.toString();
}

async function gitText(argsList) {
  const { stdout } = await execFileAsync("git", argsList, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 192 * 1024 * 1024
  });
  return stdout;
}

async function gitTextOrNull(argsList) {
  try {
    return await gitText(argsList);
  } catch {
    return null;
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(resolve(root, path), "utf8"));
  } catch (error) {
    if (arguments.length > 1 && error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readNdjson(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid recovery journal JSON at line ${index + 1}: ${error.message}`);
    }
  });
}

async function fingerprintFiles(paths) {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function appendNdjson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${ndjson(value)}\n`);
}

async function atomicWrite(path, body) {
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

function countBy(rows, keyFor) {
  const counts = {};
  for (const row of rows) {
    const key = keyFor(row) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    if (value === "--resume") parsed.resume = true;
    else if (value.startsWith("--")) {
      const [key, ...rest] = value.slice(2).split("=");
      parsed[toCamelCase(key)] = rest.join("=");
    }
  }
  return parsed;
}

function integerArg(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`Expected an integer between ${min} and ${max}, received ${value}.`);
  }
  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ndjson(value) {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
