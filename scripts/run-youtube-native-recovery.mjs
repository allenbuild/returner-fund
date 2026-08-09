#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { loadAutonomousCatalogs } from "./lib/autonomous-ingestion-plan.mjs";
import {
  extractOperationalLedgerCandidates,
  loadCurrentEvidenceSources
} from "./lib/operational-ledger-post-recovery.mjs";
import {
  readPublicEvidenceArtifact
} from "./lib/public-evidence-artifact.mjs";
import {
  REPOSITORY_SIDECAR_HISTORY_PATHS,
  extractEvidenceRows,
  historyPathBatchSlug
} from "./lib/repository-sidecar-history-recovery.mjs";
import {
  YOUTUBE_NATIVE_RECOVERY_JOURNAL_VERSION,
  YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
  buildTrustedYouTubeChannelIndex,
  buildYouTubeCandidatePool,
  buildYouTubePromotionArtifact,
  buildYouTubeRecoveryInputManifest,
  candidateNeedsAnonymousValidation,
  isTrustedYouTubeReceiptRow,
  normalizeYouTubeVideo,
  sha256,
  stableStringify,
  validateAnonymousYouTubeVideo
} from "./lib/youtube-native-recovery.mjs";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

const outputDir = resolve(root, args.outputDir);
const journalPath = resolve(outputDir, "validation-journal.ndjson");
const checkpointPath = resolve(outputDir, "checkpoint.json");
const candidatePath = resolve(outputDir, "promotion-candidate.json");
const summaryPath = resolve(outputDir, "summary.json");
const canonicalPath = "src/lib/social/public-evidence-current.json";
const operationalPath = "outputs/public-ingestion-operational-ledger-current.json";

if (!args.resume && !args.validate && await exists(journalPath)) {
  throw new Error(
    `Validation journal already exists at ${repositoryPath(journalPath)}; pass --resume or choose a new output directory.`
  );
}

const baselineCommit = (await gitText(["rev-parse", "HEAD"])).trim();
const baselineCommittedAt = (await gitText([
  "show", "-s", "--format=%cI", baselineCommit
])).trim();
const implementationSha256 = sha256([
  await readFile(new URL(import.meta.url), "utf8"),
  await readFile(new URL("./lib/youtube-native-recovery.mjs", import.meta.url), "utf8")
].join("\n--youtube-recovery-implementation--\n"));

const [publicArtifact, catalogs, currentSources, operationalBytes, youtubeSourcePaths] =
  await Promise.all([
    readPublicEvidenceArtifact(canonicalPath, { rootDir: root }),
    loadAutonomousCatalogs(root),
    loadCurrentEvidenceSources(root),
    readFile(resolve(root, operationalPath)),
    trackedYouTubeSourcePaths()
  ]);
const operationalLedger = JSON.parse(operationalBytes.toString("utf8"));
const operationalCandidates = extractOperationalLedgerCandidates(operationalLedger)
  .filter((candidate) => candidate.platform === "youtube");
const currentEvidenceRows = currentSources.flatMap((source) =>
  (source.snapshot?.evidence ?? []).map((row) => ({
    sourcePath: source.path,
    row
  }))
);
const currentEvidenceOnlyRows = currentEvidenceRows.map((entry) => entry.row);
const preliminaryPool = buildYouTubeCandidatePool({
  currentEvidenceRows: currentEvidenceOnlyRows,
  reviewRows: publicArtifact.snapshot.needsReview ?? [],
  operationalCandidates
});

const youtubeSourceDocuments = await mapLimit(
  youtubeSourcePaths,
  Math.min(8, args.historyWorkers),
  async (path) => ({
    path,
    bytes: await readFile(resolve(root, path))
  })
);
const youtubeSourceRows = [];
for (const source of youtubeSourceDocuments) {
  const document = JSON.parse(source.bytes.toString("utf8"));
  for (const row of extractEvidenceRows(document)) {
    youtubeSourceRows.push({ sourcePath: source.path, row });
  }
}

const historyPaths = [...new Set([
  ...REPOSITORY_SIDECAR_HISTORY_PATHS,
  ...youtubeSourcePaths
])].sort();
const history = args.skipHistory
  ? emptyHistoryAudit()
  : await scanRepositoryHistory({
      paths: historyPaths,
      currentEvidenceVideoIds: preliminaryPool.currentEvidenceVideoIds,
      workers: args.historyWorkers
    });
const trustedRows = [
  ...currentEvidenceRows,
  ...youtubeSourceRows,
  ...history.trustedRows
];
const trustedIndex = buildTrustedYouTubeChannelIndex({ catalogs, trustedRows });
const pool = buildYouTubeCandidatePool({
  currentEvidenceRows: currentEvidenceOnlyRows,
  reviewRows: publicArtifact.snapshot.needsReview ?? [],
  operationalCandidates,
  historicalOccurrences: history.occurrences
});
const validationCandidates = pool.candidates.filter((candidate) =>
  candidateNeedsAnonymousValidation(candidate, { trustedIndex })
);

const manifest = buildYouTubeRecoveryInputManifest({
  schemaVersion: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
  baselineCommit,
  implementationSha256,
  publicArtifact: {
    canonicalSha256: publicArtifact.canonicalSha256,
    operationalLedgerSha256: publicArtifact.ledgerSha256,
    reviewLedgerSha256: publicArtifact.reviewLedgerSha256,
    evidenceCount: publicArtifact.snapshot.evidence?.length ?? 0,
    needsReviewCount: publicArtifact.snapshot.needsReview?.length ?? 0
  },
  operationalLedger: {
    path: operationalPath,
    bytes: operationalBytes.byteLength,
    sha256: sha256(operationalBytes),
    youtubeCandidateCount: operationalCandidates.length
  },
  currentEvidenceSources: currentSources.map((source) => ({
    path: source.path,
    bytes: source.bytes,
    sha256: source.sha256,
    evidenceCount: source.snapshot?.evidence?.length ?? 0
  })),
  trustedYouTubeSources: youtubeSourceDocuments.map((source) => ({
    path: source.path,
    bytes: source.bytes.byteLength,
    sha256: sha256(source.bytes)
  })),
  history: {
    enabled: !args.skipHistory,
    paths: historyPaths,
    taskCount: history.audit.blobPathPairs,
    taskFingerprint: history.audit.taskFingerprint,
    scannedRows: history.audit.scannedRows,
    nativeVideoRows: history.audit.nativeVideoRows
  },
  candidates: pool.candidates.map((candidate) => ({
    videoId: candidate.videoId,
    occurrenceFingerprint: sha256(stableStringify(
      candidate.occurrences.map((entry) => ({
        sourceKind: entry.sourceKind,
        sourcePath: entry.sourcePath,
        commit: entry.commit,
        rowId: entry.row?.id ?? null,
        rowSha256: sha256(stableStringify(entry.row))
      }))
    ))
  }))
});
const validationReceipts = await readJournal(journalPath, manifest.inputHash);

if (args.plan) {
  process.stdout.write(`${stableStringify({
    status: "planned",
    inputHash: manifest.inputHash,
    currentEvidenceYouTubeVideos: pool.currentEvidenceVideoIds.size,
    currentPublicReviewRows: publicArtifact.snapshot.needsReview?.filter((row) =>
      String(row?.platform ?? "").toLowerCase() === "youtube"
    ).length ?? 0,
    operationalYouTubeCandidates: operationalCandidates.length,
    history: history.audit,
    dedupedExcludedCandidates: pool.candidates.length,
    anonymousValidationCandidates: validationCandidates.length,
    trustedChannelKeys: trustedIndex.channels.size,
    ambiguousTrustedChannelKeys: [...trustedIndex.channels.values()].filter((owners) =>
      owners.size > 1
    ).length
  }, 2)}\n`);
  process.exit(0);
}

if (args.validate) {
  const artifact = buildArtifact();
  validateArtifact(artifact);
  const expected = `${stableStringify(artifact, 2)}\n`;
  const actual = await readFile(candidatePath, "utf8");
  if (actual !== expected) {
    throw new Error(
      `${repositoryPath(candidatePath)} is stale; rerun the YouTube recovery lane.`
    );
  }
  process.stdout.write(`${stableStringify({
    validated: true,
    candidatePath: repositoryPath(candidatePath),
    sha256: sha256(actual),
    counts: artifact.counts,
    inputHash: manifest.inputHash
  }, 2)}\n`);
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });
if (args.anonymousValidation) {
  await runAnonymousValidations();
}

const artifact = buildArtifact();
validateArtifact(artifact);
const candidateBody = `${stableStringify(artifact, 2)}\n`;
const sourceAudit = artifact.sourceAudit;
const summary = {
  schemaVersion: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
  complete: validationCandidates.every((candidate) =>
    validationReceipts.has(candidate.videoId)
  ),
  baselineCommit,
  baselineCommittedAt,
  inputHash: manifest.inputHash,
  candidatePath: repositoryPath(candidatePath),
  candidateSha256: sha256(candidateBody),
  counts: artifact.counts,
  sourceAudit,
  safety: {
    authenticatedAccessUsed: false,
    browserAccessUsed: false,
    linkedinAccessUsed: false,
    anonymousYouTubeOembedUsed: args.anonymousValidation,
    maxConcurrentRequests: 1,
    minRequestIntervalMs: args.minRequestIntervalMs
  }
};
await Promise.all([
  writeAtomic(candidatePath, candidateBody),
  writeAtomic(summaryPath, `${stableStringify(summary, 2)}\n`),
  writeCheckpoint()
]);
process.stdout.write(`${stableStringify({
  candidate: {
    path: repositoryPath(candidatePath),
    sha256: summary.candidateSha256
  },
  summary: {
    path: repositoryPath(summaryPath),
    counts: artifact.counts
  },
  complete: summary.complete,
  sourceAudit,
  safety: summary.safety
}, 2)}\n`);

function buildArtifact() {
  return buildYouTubePromotionArtifact({
    candidates: pool.candidates,
    trustedIndex,
    validationReceipts,
    inputManifest: manifest,
    sourceAudit: {
      currentEvidenceYouTubeVideos: pool.currentEvidenceVideoIds.size,
      currentPublicReviewYouTubeRows: publicArtifact.snapshot.needsReview?.filter((row) =>
        String(row?.platform ?? "").toLowerCase() === "youtube"
      ).length ?? 0,
      currentPublicReviewNativeVideos: preliminaryPool.candidates.filter((candidate) =>
        candidate.occurrences.some((entry) => entry.sourceKind === "current_review")
      ).length,
      operationalYouTubeCandidates: operationalCandidates.length,
      history: history.audit,
      candidatePoolRejectedNonPosts: pool.rejected.length,
      dedupedExcludedCandidates: pool.candidates.length,
      anonymousValidationCandidates: validationCandidates.length,
      completedAnonymousValidations: validationReceipts.size,
      trustedChannelKeys: trustedIndex.channels.size,
      ambiguousTrustedChannelKeys: [...trustedIndex.channels.values()].filter((owners) =>
        owners.size > 1
      ).length,
      rejectedTrustedRows: trustedIndex.rejectedTrustRows.length
    }
  });
}

async function runAnonymousValidations() {
  let lastRequestAt = 0;
  let completed = 0;
  for (const candidate of validationCandidates) {
    if (validationReceipts.has(candidate.videoId)) continue;
    if (completed >= args.maxAnonymousValidations) break;
    const elapsed = Date.now() - lastRequestAt;
    if (lastRequestAt && elapsed < args.minRequestIntervalMs) {
      await delay(args.minRequestIntervalMs - elapsed);
    }
    let receipt = await validateAnonymousYouTubeVideo(candidate, {
      timeoutMs: args.timeoutMs
    });
    lastRequestAt = Date.now();
    if (receipt.httpStatus === 429) {
      process.stderr.write(
        `YouTube oEmbed returned 429 at ${candidate.videoId}; stopping cleanly for resume.\n`
      );
      break;
    }
    if (
      receipt.status === "failed" &&
      /(?:network_error|timeout|http_5\d\d)$/u.test(String(receipt.reason ?? ""))
    ) {
      await delay(Math.max(2_000, args.minRequestIntervalMs));
      receipt = await validateAnonymousYouTubeVideo(candidate, {
        timeoutMs: args.timeoutMs
      });
      lastRequestAt = Date.now();
      if (receipt.httpStatus === 429) break;
    }
    await appendJournal(journalPath, {
      schemaVersion: YOUTUBE_NATIVE_RECOVERY_JOURNAL_VERSION,
      inputHash: manifest.inputHash,
      videoId: candidate.videoId,
      receipt
    });
    validationReceipts.set(candidate.videoId, receipt);
    completed += 1;
    if (completed % 25 === 0) {
      await writeCheckpoint();
      process.stdout.write(`${stableStringify({
        phase: "anonymous_validation",
        completedThisRun: completed,
        completedTotal: validationReceipts.size,
        required: validationCandidates.length
      })}\n`);
    }
  }
}

async function scanRepositoryHistory({ paths, currentEvidenceVideoIds, workers }) {
  const historyText = await gitText([
    "log", "--format=%H%x09%cI", "--", ...paths
  ], 64 * 1024 * 1024);
  const commits = parseLines(historyText).map((line) => {
    const [commit, committedAt] = line.split("\t");
    return { commit, committedAt };
  });
  const tasksByToken = new Map();
  for (const chunk of chunks(commits, workers)) {
    const trees = await Promise.all(chunk.map(async (entry) => ({
      ...entry,
      tree: await gitText([
        "ls-tree", "-r", entry.commit, "--", ...paths
      ], 32 * 1024 * 1024)
    })));
    for (const entry of trees) {
      for (const line of parseLines(entry.tree)) {
        const match = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/u);
        if (!match) continue;
        const [, blob, path] = match;
        const token = `${path}:${blob}`;
        const task = tasksByToken.get(token) ?? {
          token,
          blob,
          path,
          origins: []
        };
        task.origins.push({ commit: entry.commit, committedAt: entry.committedAt });
        tasksByToken.set(token, task);
      }
    }
  }
  const tasks = [...tasksByToken.values()].sort((left, right) =>
    left.token.localeCompare(right.token)
  );
  for (const task of tasks) {
    task.origins.sort((left, right) =>
      String(right.committedAt).localeCompare(String(left.committedAt)) ||
      String(right.commit).localeCompare(String(left.commit))
    );
  }

  let scannedRows = 0;
  let youtubeRows = 0;
  let nativeVideoRows = 0;
  let invalidJsonBlobs = 0;
  let evidenceDuplicates = 0;
  const occurrenceByVideo = new Map();
  const trustedByKey = new Map();
  let processed = 0;
  for (const chunk of chunks(tasks, workers)) {
    const results = await Promise.all(chunk.map(async (task) => {
      const text = await gitText(["cat-file", "blob", task.blob], 256 * 1024 * 1024);
      let document;
      try {
        document = JSON.parse(text);
      } catch {
        return { task, invalidJson: true, rows: [] };
      }
      return { task, invalidJson: false, rows: extractEvidenceRows(document) };
    }));
    for (const result of results) {
      processed += 1;
      if (result.invalidJson) {
        invalidJsonBlobs += 1;
        continue;
      }
      scannedRows += result.rows.length;
      const origin = result.task.origins[0];
      result.rows.forEach((row, sourceIndex) => {
        if (String(row?.platform ?? "").toLowerCase() !== "youtube") return;
        youtubeRows += 1;
        const native = normalizeYouTubeVideo(row);
        if (!native) return;
        nativeVideoRows += 1;
        const occurrence = {
          sourcePath: result.task.path,
          commit: origin.commit,
          committedAt: origin.committedAt,
          sourceIndex,
          fallbackBatchSlug: historyPathBatchSlug(result.task.path),
          row
        };
        if (isTrustedYouTubeReceiptRow(row)) {
          const key = `${result.task.path}:${native.videoId}:${row?.id ?? sourceIndex}`;
          const currentTrusted = trustedByKey.get(key);
          if (!currentTrusted || historyOccurrenceRank(occurrence) > historyOccurrenceRank(currentTrusted)) {
            trustedByKey.set(key, occurrence);
          }
        }
        if (currentEvidenceVideoIds.has(native.videoId)) {
          evidenceDuplicates += 1;
          return;
        }
        const current = occurrenceByVideo.get(native.videoId);
        if (!current || historyOccurrenceRank(occurrence) > historyOccurrenceRank(current)) {
          occurrenceByVideo.set(native.videoId, occurrence);
        }
      });
    }
    if (processed % 100 < workers) {
      process.stdout.write(`${stableStringify({
        phase: "history_scan",
        processedBlobPathPairs: processed,
        totalBlobPathPairs: tasks.length,
        nativeVideoRows,
        uniqueExcludedVideos: occurrenceByVideo.size
      })}\n`);
    }
  }
  return {
    occurrences: [...occurrenceByVideo.values()].sort((left, right) =>
      normalizeYouTubeVideo(left.row).videoId.localeCompare(
        normalizeYouTubeVideo(right.row).videoId
      )
    ),
    trustedRows: [...trustedByKey.values()].map((entry) => ({
      sourcePath: entry.sourcePath,
      fallbackBatchSlug: entry.fallbackBatchSlug,
      row: entry.row
    })),
    audit: {
      enabled: true,
      commits: commits.length,
      blobPathPairs: tasks.length,
      taskFingerprint: sha256(stableStringify(tasks.map((task) => task.token))),
      scannedRows,
      youtubeRows,
      nativeVideoRows,
      invalidJsonBlobs,
      evidenceDuplicateOccurrences: evidenceDuplicates,
      uniqueExcludedHistoryVideos: occurrenceByVideo.size,
      trustedHistoricalRows: trustedByKey.size
    }
  };
}

function historyOccurrenceRank(occurrence) {
  const row = occurrence.row ?? {};
  const verified = String(row.review_state ?? "").toLowerCase() === "verified" ? 1 : 0;
  const accountOwner = row.attributionMode === "account_owner" ? 1 : 0;
  const richness = Math.min(Object.keys(row).length, 999);
  const rawLength = Math.min(stableStringify(row.rawVisibleText ?? "").length, 99_999);
  return accountOwner * 1_000_000_000 + verified * 100_000_000 +
    richness * 100_000 + rawLength;
}

function emptyHistoryAudit() {
  return {
    occurrences: [],
    trustedRows: [],
    audit: {
      enabled: false,
      commits: 0,
      blobPathPairs: 0,
      taskFingerprint: sha256("history_disabled"),
      scannedRows: 0,
      youtubeRows: 0,
      nativeVideoRows: 0,
      invalidJsonBlobs: 0,
      evidenceDuplicateOccurrences: 0,
      uniqueExcludedHistoryVideos: 0,
      trustedHistoricalRows: 0
    }
  };
}

async function trackedYouTubeSourcePaths() {
  const text = await gitText(["ls-files", "outputs/source-hunt"]);
  return parseLines(text).filter((path) =>
    /youtube/iu.test(path) && path.endsWith(".json")
  ).sort();
}

function validateArtifact(artifact) {
  const seen = new Set();
  for (const row of artifact.evidence ?? []) {
    if (row.platform !== "youtube") throw new Error("Non-YouTube row in YouTube recovery artifact.");
    if (!["S2026", "S26", "A16ZSR006"].includes(row.batchSlug)) {
      throw new Error(`Unscoped YouTube recovery row: ${row.id}`);
    }
    const native = normalizeYouTubeVideo(row);
    if (!native) throw new Error(`Invalid YouTube native video row: ${row.id}`);
    if (pool.currentEvidenceVideoIds.has(native.videoId)) {
      throw new Error(`YouTube recovery duplicated current evidence: ${native.videoId}`);
    }
    if (seen.has(native.videoId)) {
      throw new Error(`Duplicate YouTube recovery video: ${native.videoId}`);
    }
    seen.add(native.videoId);
    if (row.nativeAuthorResolution?.status !== "matched") {
      throw new Error(`YouTube recovery row lacks matched owner: ${row.id}`);
    }
    if (!row._youtubeNativeRecovery?.validation) {
      throw new Error(`YouTube recovery row lacks explicit trust receipt: ${row.id}`);
    }
  }
  if (seen.size !== artifact.counts.total) {
    throw new Error("YouTube recovery count does not match unique physical videos.");
  }
}

async function readJournal(path, inputHash) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  const receipts = new Map();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.schemaVersion !== YOUTUBE_NATIVE_RECOVERY_JOURNAL_VERSION) {
      throw new Error(`Unsupported YouTube recovery journal schema at line ${index + 1}.`);
    }
    if (entry.inputHash !== inputHash) {
      throw new Error("YouTube recovery journal input hash no longer matches repository inputs.");
    }
    const previous = receipts.get(entry.videoId);
    if (previous && stableStringify(previous) !== stableStringify(entry.receipt)) {
      throw new Error(`Conflicting YouTube receipt for ${entry.videoId}.`);
    }
    receipts.set(entry.videoId, entry.receipt);
  }
  return receipts;
}

async function appendJournal(path, entry) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${stableStringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeCheckpoint() {
  const completed = [...validationReceipts.keys()].sort();
  const required = validationCandidates.map((candidate) => candidate.videoId).sort();
  await writeAtomic(checkpointPath, `${stableStringify({
    schemaVersion: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
    inputHash: manifest.inputHash,
    completedVideoIds: completed,
    pendingVideoIds: required.filter((videoId) => !validationReceipts.has(videoId)),
    complete: required.every((videoId) => validationReceipts.has(videoId))
  }, 2)}\n`);
}

async function writeAtomic(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function gitText(argv, maxBuffer = 32 * 1024 * 1024) {
  const result = await execFileAsync("git", argv, {
    cwd: root,
    encoding: "utf8",
    maxBuffer
  });
  return result.stdout;
}

async function mapLimit(values, limit, mapper) {
  const output = [];
  for (const chunk of chunks(values, limit)) {
    output.push(...await Promise.all(chunk.map(mapper)));
  }
  return output;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function parseLines(value) {
  return String(value ?? "").split(/\r?\n/u).filter(Boolean);
}

function repositoryPath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseArgs(values) {
  const parsed = {
    outputDir: "work/youtube-native-recovery/2026-08-09",
    anonymousValidation: false,
    resume: false,
    validate: false,
    plan: false,
    help: false,
    skipHistory: false,
    historyWorkers: 8,
    minRequestIntervalMs: 500,
    maxAnonymousValidations: 2_000,
    timeoutMs: 15_000
  };
  const seen = new Set();
  for (const value of values) {
    if (value === "--anonymous-validation") parsed.anonymousValidation = true;
    else if (value === "--resume") parsed.resume = true;
    else if (value === "--validate") parsed.validate = true;
    else if (value === "--plan") parsed.plan = true;
    else if (value === "--skip-history") parsed.skipHistory = true;
    else if (["--help", "-h"].includes(value)) parsed.help = true;
    else {
      const match = value.match(/^--([^=]+)=(.*)$/u);
      if (!match) throw new Error(`Expected --name=value; received ${value}`);
      const [, name, raw] = match;
      if (seen.has(name)) throw new Error(`Duplicate argument: --${name}`);
      seen.add(name);
      if (name === "output-dir") parsed.outputDir = requiredText(raw, name);
      else if (name === "history-workers") {
        parsed.historyWorkers = boundedInteger(raw, name, 1, 16);
      } else if (name === "min-request-interval-ms") {
        parsed.minRequestIntervalMs = boundedInteger(raw, name, 250, 60_000);
      } else if (name === "max-anonymous-validations") {
        parsed.maxAnonymousValidations = boundedInteger(raw, name, 0, 10_000);
      } else if (name === "timeout-ms") {
        parsed.timeoutMs = boundedInteger(raw, name, 1_000, 120_000);
      } else {
        throw new Error(`Unknown YouTube recovery argument: --${name}`);
      }
    }
  }
  if (parsed.validate && parsed.anonymousValidation) {
    throw new Error("--validate cannot make anonymous network requests.");
  }
  return parsed;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`--${name} requires a non-empty value.`);
  return text;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!/^\d+$/u.test(String(value))) throw new Error(`--${name} must be an integer.`);
  const number = Number(value);
  if (number < minimum || number > maximum) {
    throw new Error(`--${name} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function helpText() {
  return `Usage: node scripts/run-youtube-native-recovery.mjs [options]\n\n` +
    `Audits current public review/operational ledgers and reachable repository history for ` +
    `net-new native YouTube uploads, Shorts, and live archives. Ownership must resolve to ` +
    `one current cohort company/founder through a verified channel or an exact native author ` +
    `on an official YC/a16z/company-site anchor.\n\n` +
    `Options:\n` +
    `  --anonymous-validation            Use low-rate anonymous YouTube oEmbed\n` +
    `  --resume                          Resume an input-bound validation journal\n` +
    `  --plan                            Audit and print counts without writing\n` +
    `  --validate                        Rebuild and verify existing candidate bytes\n` +
    `  --output-dir=<path>               Work output directory\n` +
    `  --history-workers=<n>             Git history read concurrency (1-16)\n` +
    `  --min-request-interval-ms=<n>     Anonymous request spacing (minimum 250 ms)\n` +
    `  --max-anonymous-validations=<n>   Resume-safe request cap\n` +
    `  --timeout-ms=<n>                  Per-request timeout\n` +
    `  --skip-history                    Skip history only for isolated tests\n` +
    `  --help                            Show help\n\n` +
    `The lane never opens a browser, loads cookies, authenticates, or accesses LinkedIn.\n`;
}
