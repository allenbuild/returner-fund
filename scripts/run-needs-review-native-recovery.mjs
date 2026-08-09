#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadAutonomousCatalogs } from "./lib/autonomous-ingestion-plan.mjs";
import {
  buildPublicNativeAuthorResolver
} from "./lib/public-evidence-attribution.mjs";
import {
  readPublicEvidenceArtifact
} from "./lib/public-evidence-artifact.mjs";
import {
  NEEDS_REVIEW_NATIVE_RECOVERY_VERSION,
  buildPhysicalPostIndex,
  discoverNeedsReviewNativeCandidates,
  recoveryInputFingerprint,
  summarizeRecovery,
  validateNetworkPayload,
  validateOfflineCandidate,
  validationEndpoint
} from "./lib/needs-review-native-recovery.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const outputDir = resolve(
  root,
  args.outputDir ?? "work/needs-review-native-recovery/2026-08-09"
);
const journalPath = resolve(outputDir, "journal.ndjson");
const checkpointPath = resolve(outputDir, "checkpoint.json");
const candidatePath = resolve(outputDir, "promotion-candidates.json");
const summaryPath = resolve(outputDir, "summary.json");
const workers = integerArg(args.workers, 2, { min: 1, max: 8 });
const delayMs = integerArg(args.delayMs, 750, { min: 250, max: 60_000 });
const timeoutMs = integerArg(args.timeoutMs, 15_000, { min: 1_000, max: 120_000 });
const retries = integerArg(args.retries, 3, { min: 1, max: 6 });
const maxValidations = integerArg(
  args.maxValidations,
  Number.MAX_SAFE_INTEGER,
  { min: 1 }
);
let nextRequestAt = 0;
let paceChain = Promise.resolve();

class StopRecoveryError extends Error {}

const publicPath = "src/lib/social/public-evidence-current.json";
const referencePaths = [
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json",
  "src/lib/social/eden-robotics-verified-native-evidence.json"
];

if (!args.resume && await exists(journalPath)) {
  throw new Error(
    `Recovery journal already exists at ${journalPath}; pass --resume or use a new --output-dir.`
  );
}

const [publicArtifact, referenceInputs, catalogs] = await Promise.all([
  readPublicEvidenceArtifact(publicPath, { rootDir: root }),
  Promise.all(referencePaths.map(readJsonWithHash)),
  loadAutonomousCatalogs(root)
]);
const snapshots = [
  publicArtifact.snapshot,
  ...referenceInputs.map((entry) => entry.value)
];
const currentPhysicalKeys = buildPhysicalPostIndex(snapshots);
const resolveNativeAuthor = buildPublicNativeAuthorResolver(catalogs);
const discovery = discoverNeedsReviewNativeCandidates({
  needsReview: publicArtifact.snapshot.needsReview,
  currentPhysicalKeys,
  resolveNativeAuthor,
  catalogs
});
const runIdentity = recoveryInputFingerprint({
  schemaVersion: NEEDS_REVIEW_NATIVE_RECOVERY_VERSION,
  publicCanonicalSha256: publicArtifact.canonicalSha256,
  publicOperationalLedgerSha256: publicArtifact.ledgerSha256,
  publicReviewLedgerSha256: publicArtifact.reviewLedgerSha256,
  references: referenceInputs.map((entry, index) => ({
    path: referencePaths[index],
    sha256: entry.sha256
  })),
  currentPhysicalKeys: [...currentPhysicalKeys].sort(),
  candidates: discovery.candidates.map((candidate) => ({
    physicalKey: candidate.physicalKey,
    id: candidate.row?.id ?? null
  }))
});
const priorCheckpoint = await readJson(checkpointPath, null);
if (priorCheckpoint && priorCheckpoint.runIdentity !== runIdentity) {
  throw new Error(
    "Recovery inputs changed since the checkpoint; use a new output directory."
  );
}
const startedAt = priorCheckpoint?.startedAt ?? new Date().toISOString();
let events = await readNdjson(journalPath);
const validations = validationIndex(events);
let journalWriteChain = Promise.resolve();
let checkpointWriteChain = Promise.resolve();

if (args.plan) {
  process.stdout.write(`${JSON.stringify({
    status: "planned",
    runIdentity,
    currentPhysicalSources: currentPhysicalKeys.size,
    needsReviewRows: publicArtifact.snapshot.needsReview?.length ?? 0,
    candidateRows: discovery.candidates.length,
    networkRows: discovery.candidates.filter((candidate) =>
      validateOfflineCandidate(candidate).status === "network_required"
    ).length,
    rejectionReasons: countReasons(discovery.rejected)
  }, null, 2)}\n`);
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });
await writeCheckpoint("validation");

for (const candidate of discovery.candidates) {
  if (validations.has(candidate.physicalKey)) continue;
  const decision = validateOfflineCandidate(candidate);
  if (decision.status === "network_required") continue;
  await recordValidation(candidate, {
    ...decision,
    checkedAt: new Date().toISOString(),
    endpoint: null,
    httpStatus: null,
    attempts: 0
  });
}

const networkCandidates = discovery.candidates.filter((candidate) =>
  !validations.has(candidate.physicalKey) &&
  validateOfflineCandidate(candidate).status === "network_required"
).slice(0, maxValidations);

let stopError = null;
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(workers, networkCandidates.length) }, async () => {
  while (!stopError) {
    const index = cursor;
    cursor += 1;
    const candidate = networkCandidates[index];
    if (!candidate) return;
    try {
      const endpoint = validationEndpoint(candidate);
      const response = await fetchJsonWithRetry(endpoint, {
        retries,
        timeoutMs,
        paceMs: delayMs
      });
      if (response.status === 429) {
        throw new StopRecoveryError(
          `Anonymous validation endpoint returned 429 for ${candidate.physicalKey}; stopped without retrying further candidates.`
        );
      }
      const decision = response.ok
        ? validateNetworkPayload(candidate, response.payload)
        : {
            accepted: false,
            reasons: [`anonymous_endpoint_http_${response.status ?? "failed"}`]
          };
      await recordValidation(candidate, {
        status: decision.accepted ? "accepted" : "rejected",
        reasons: decision.reasons,
        receipt: decision.receipt ?? null,
        checkedAt: new Date().toISOString(),
        endpoint,
        httpStatus: response.status,
        attempts: response.attempts
      });
    } catch (error) {
      if (error instanceof StopRecoveryError) {
        stopError = error;
        return;
      }
      await recordValidation(candidate, {
        status: "rejected",
        reasons: [`anonymous_endpoint_error:${errorMessage(error)}`],
        receipt: null,
        checkedAt: new Date().toISOString(),
        endpoint: validationEndpoint(candidate),
        httpStatus: null,
        attempts: retries
      });
    }
  }
}));

const recovery = summarizeRecovery({
  candidates: discovery.candidates,
  validations,
  discoveryRejected: discovery.rejected
});
const incomplete = discovery.candidates.filter((candidate) =>
  !validations.has(candidate.physicalKey)
).length;
const status = stopError
  ? "stopped"
  : incomplete > 0
    ? "partial"
    : "complete";
const audit = {
  schemaVersion: NEEDS_REVIEW_NATIVE_RECOVERY_VERSION,
  status,
  runIdentity,
  startedAt,
  completedAt: status === "complete" ? new Date().toISOString() : null,
  currentPhysicalSources: currentPhysicalKeys.size,
  needsReviewRows: publicArtifact.snapshot.needsReview?.length ?? 0,
  discoveredCandidates: discovery.candidates.length,
  completedValidations: validations.size,
  incompleteValidations: incomplete,
  accepted: recovery.accepted.length,
  byBatch: recovery.byBatch,
  byPlatform: recovery.byPlatform,
  rejectionReasons: recovery.rejectionReasons,
  rejectedSamples: recovery.rejected.slice(0, 100),
  stopReason: stopError?.message ?? null
};
const promotionCandidate = {
  schemaVersion: NEEDS_REVIEW_NATIVE_RECOVERY_VERSION,
  source: {
    collector: "offline_needs_review_plus_anonymous_native_validation",
    fetchedAt: startedAt,
    runIdentity,
    accepted: recovery.accepted.length,
    byBatch: recovery.byBatch,
    byPlatform: recovery.byPlatform
  },
  evidence: recovery.accepted,
  needsReview: [],
  attributionReconciliationLedger: [],
  failures: [],
  attempts: {},
  discoveryAttempts: [],
  sourceDiscoveryPaths: [],
  recoveryAudit: audit
};

await Promise.all([
  writeJsonAtomic(candidatePath, promotionCandidate),
  writeJsonAtomic(summaryPath, audit),
  writeCheckpoint(status)
]);
process.stdout.write(`${JSON.stringify({
  ...audit,
  candidatePath,
  summaryPath
}, null, 2)}\n`);
if (stopError) throw stopError;

async function recordValidation(candidate, decision) {
  const event = {
    schemaVersion: NEEDS_REVIEW_NATIVE_RECOVERY_VERSION,
    type: "validation",
    physicalKey: candidate.physicalKey,
    platform: candidate.native.platform,
    rowId: candidate.row?.id ?? null,
    ...decision
  };
  await appendJournal(event);
  validations.set(candidate.physicalKey, event);
  events.push(event);
  await writeCheckpoint("validation");
  process.stdout.write(`${JSON.stringify({
    physicalKey: candidate.physicalKey,
    status: event.status,
    completed: validations.size,
    total: discovery.candidates.length
  })}\n`);
}

function appendJournal(event) {
  journalWriteChain = journalWriteChain.then(() =>
    appendFile(journalPath, `${JSON.stringify(event)}\n`, "utf8")
  );
  return journalWriteChain;
}

function writeCheckpoint(phase) {
  checkpointWriteChain = checkpointWriteChain.then(() => writeJsonAtomic(checkpointPath, {
    schemaVersion: NEEDS_REVIEW_NATIVE_RECOVERY_VERSION,
    phase,
    runIdentity,
    startedAt,
    updatedAt: new Date().toISOString(),
    discoveredCandidates: discovery.candidates.length,
    completedValidations: validations.size
  }));
  return checkpointWriteChain;
}

async function globallyPacedFetch(url, options, paceMs) {
  let release;
  const predecessor = paceChain;
  paceChain = new Promise((resolvePace) => {
    release = resolvePace;
  });
  await predecessor;
  const waitMs = Math.max(0, nextRequestAt - Date.now());
  if (waitMs > 0) await delay(waitMs);
  nextRequestAt = Date.now() + paceMs;
  release();
  return fetch(url, options);
}

async function fetchJsonWithRetry(url, { retries, timeoutMs, paceMs }) {
  let lastStatus = null;
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await globallyPacedFetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "returner-fund-offline-recovery/1.0"
        }
      }, paceMs);
      lastStatus = response.status;
      if (response.status === 429) {
        return { ok: false, status: 429, attempts: attempt, payload: null };
      }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          return { ok: false, status: response.status, attempts: attempt, payload: null };
        }
        lastError = new Error(`HTTP ${response.status}`);
      } else {
        return {
          ok: true,
          status: response.status,
          attempts: attempt,
          payload: await response.json()
        };
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < retries) await delay(Math.min(4_000, 500 * 2 ** (attempt - 1)));
  }
  if (lastError) throw lastError;
  return { ok: false, status: lastStatus, attempts: retries, payload: null };
}

async function readJsonWithHash(relativePath) {
  const bytes = await readFile(resolve(root, relativePath));
  return {
    value: JSON.parse(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readNdjson(path) {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function validationIndex(events) {
  const index = new Map();
  for (const event of events ?? []) {
    if (event?.type === "validation" && event?.physicalKey) {
      index.set(event.physicalKey, event);
    }
  }
  return index;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx"
  });
  await rename(temporary, path);
}

function countReasons(rows) {
  const result = {};
  for (const row of rows ?? []) {
    for (const reason of row.reasons ?? []) result[reason] = (result[reason] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0])
  ));
}

function parseArgs(raw) {
  const result = {};
  for (const arg of raw) {
    if (arg === "--resume" || arg === "--plan") {
      result[arg.slice(2)] = true;
      continue;
    }
    const match = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!match) throw new Error(`Unknown recovery argument: ${arg}`);
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!["outputDir", "workers", "delayMs", "timeoutMs", "retries", "maxValidations"].includes(key)) {
      throw new Error(`Unknown recovery argument: --${match[1]}`);
    }
    result[key] = match[2];
  }
  return result;
}

function integerArg(value, fallback, { min, max = Number.MAX_SAFE_INTEGER }) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`Expected an integer; received ${value}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`Integer must be between ${min} and ${max}; received ${value}.`);
  }
  return number;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(error) {
  return String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 500);
}
