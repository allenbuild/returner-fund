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

import { physicalSourceKey } from "./lib/ingestion-source-delta.mjs";
import { extractXPublicProfileReceipt } from "./lib/x-public-profile-html.mjs";
import {
  auditRepositoryHistoryXCandidate,
  buildRepositoryHistoryPublicEvidenceCandidate,
  withXPublicStatusValidation
} from "./lib/repository-history-public-evidence-candidate.mjs";
import { xStatusIdentity } from "./lib/repository-history-x-recovery.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const inputPath = resolve(root, required(args.input, "input"));
const candidatePath = resolve(root, required(args.candidate, "candidate"));
const reportPath = resolve(
  root,
  args.report ?? resolve(dirname(candidatePath), "candidate-build-report.json")
);
const statusCachePath = resolve(
  root,
  args.statusCache ?? resolve(dirname(candidatePath), "public-x-status-validation.ndjson")
);
const expectedTotal = integerArg(args.expectedTotal, null, { min: 1 });
const expectedS2026 = integerArg(args.expectedS2026, null, { min: 0 });
const expectedS26 = integerArg(args.expectedS26, null, { min: 0 });
const hostPaceMs = integerArg(args.hostPaceMs, 350, { min: 0, max: 60_000 });
const requestTimeoutMs = integerArg(args.requestTimeoutMs, 20_000, { min: 1_000, max: 120_000 });
const retries = integerArg(args.retries, 3, { min: 1, max: 8 });
const currentSnapshotPaths = [
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
  "src/lib/social/a16z-speedrun-006-social-evidence.json",
  "src/lib/social/eden-robotics-verified-native-evidence.json"
];

if (!args.resume && await exists(statusCachePath)) {
  throw new Error(`Status validation cache already exists at ${statusCachePath}; pass --resume or choose a new path.`);
}

const inputBytes = await readFile(inputPath);
const rows = parseNdjson(inputBytes.toString("utf8"), inputPath);
if (expectedTotal !== null && rows.length !== expectedTotal) {
  throw new Error(`Expected ${expectedTotal} recovered rows; input contained ${rows.length}.`);
}
const currentSnapshots = await Promise.all(currentSnapshotPaths.map(readJson));
const cached = await readStatusCache(statusCachePath);
const enrichedRows = [];

for (const [index, row] of rows.entries()) {
  const physicalKey = physicalSourceKey(row);
  const inputSha256 = sha256(JSON.stringify(row));
  const prior = cached.get(physicalKey);
  if (prior?.status === "accepted" && prior.inputSha256 === inputSha256 && prior.row) {
    enrichedRows.push(prior.row);
    process.stdout.write(`${JSON.stringify({ phase: "status_validation", index: index + 1, total: rows.length, physicalKey, status: "cached" })}\n`);
    continue;
  }

  const native = xStatusIdentity(row?.sourceUrl);
  if (!native || !physicalKey) {
    throw new Error(`Recovered row ${row?.id ?? index} does not have an exact native X identity.`);
  }
  const fetched = await fetchTextWithRetry(native.url, {
    retries,
    timeoutMs: requestTimeoutMs
  });
  const checkedAt = new Date().toISOString();
  let event;
  if (!fetched.ok) {
    event = {
      schemaVersion: 1,
      type: "status_validation_checkpoint",
      physicalKey,
      inputSha256,
      status: "rejected",
      checkedAt,
      endpoint: native.url,
      httpStatus: fetched.status,
      attempts: fetched.attempts,
      reason: `public_x_status_http_${fetched.status ?? "failed"}`
    };
  } else {
    try {
      const receipt = extractXPublicProfileReceipt({
        html: fetched.body,
        accountUrl: row.accountUrl,
        requestedHandle: native.handle,
        fetchedAt: checkedAt,
        limit: 5
      });
      const post = receipt.posts.find((candidate) => candidate.id === native.postId);
      if (!post) throw new Error("exact native post missing from public X status response");
      const enriched = withXPublicStatusValidation(row, {
        post,
        endpoint: native.url,
        checkedAt,
        httpStatus: fetched.status,
        responseBody: fetched.body
      });
      event = {
        schemaVersion: 1,
        type: "status_validation_checkpoint",
        physicalKey,
        inputSha256,
        status: "accepted",
        checkedAt,
        endpoint: native.url,
        httpStatus: fetched.status,
        attempts: fetched.attempts,
        row: enriched
      };
    } catch (error) {
      event = {
        schemaVersion: 1,
        type: "status_validation_checkpoint",
        physicalKey,
        inputSha256,
        status: "rejected",
        checkedAt,
        endpoint: native.url,
        httpStatus: fetched.status,
        attempts: fetched.attempts,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }
  await appendNdjson(statusCachePath, event);
  cached.set(physicalKey, event);
  process.stdout.write(`${JSON.stringify({ phase: "status_validation", index: index + 1, total: rows.length, physicalKey, status: event.status })}\n`);
  if (event.status !== "accepted") {
    throw new Error(`Public X status validation failed for ${physicalKey}: ${event.reason}.`);
  }
  enrichedRows.push(event.row);
  if (hostPaceMs > 0) await delay(hostPaceMs);
}

const generatedAt = enrichedRows
  .map((row) => row?._recoveryProvenance?.publicStatusValidation?.checkedAt)
  .filter(Boolean)
  .sort()
  .at(-1) ?? new Date().toISOString();
const candidate = buildRepositoryHistoryPublicEvidenceCandidate(enrichedRows, {
  generatedAt,
  inputPath
});
const expectedByBatch = Object.fromEntries([
  ["S2026", expectedS2026],
  ["S26", expectedS26]
].filter(([, value]) => value !== null));
const audit = auditRepositoryHistoryXCandidate(candidate, {
  currentSnapshots,
  expectedTotal,
  expectedByBatch
});
const candidateBody = `${JSON.stringify(candidate, null, 2)}\n`;
const report = {
  schemaVersion: 1,
  status: "candidate_built",
  generatedAt,
  inputPath,
  candidatePath,
  reportPath,
  statusCachePath,
  currentSnapshotPaths,
  inputSha256: sha256(inputBytes),
  candidateSha256: sha256(candidateBody),
  audit
};
await atomicWrite(candidatePath, candidateBody);
await atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function fetchTextWithRetry(url, { retries: retryLimit, timeoutMs }) {
  let lastStatus = null;
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "Mozilla/5.0 (compatible; ReturnerFundRepositoryHistoryRecovery/1.0)"
        },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs)
      });
      lastStatus = response.status;
      const body = Buffer.from(await response.arrayBuffer());
      if (response.ok && body.length > 0) {
        return { ok: true, status: response.status, attempts: attempt, body };
      }
      if (response.status !== 429 && response.status < 500) {
        return { ok: false, status: response.status, attempts: attempt, body };
      }
    } catch {
      // Retry bounded network and timeout failures.
    }
    if (attempt < retryLimit) await delay(Math.min(4_000, 500 * 2 ** (attempt - 1)));
  }
  return { ok: false, status: lastStatus, attempts: retryLimit, body: Buffer.alloc(0) };
}

async function readStatusCache(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  const events = parseNdjson(text, path);
  return new Map(events.map((event) => [event.physicalKey, event]));
}

function parseNdjson(text, sourcePath) {
  return String(text).split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid NDJSON in ${sourcePath} at line ${index + 1}: ${error.message}`);
    }
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function appendNdjson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
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

function parseArgs(values) {
  const parsed = { resume: false };
  const supported = new Set([
    "input",
    "candidate",
    "report",
    "status-cache",
    "expected-total",
    "expected-s2026",
    "expected-s26",
    "host-pace-ms",
    "request-timeout-ms",
    "retries"
  ]);
  for (const value of values) {
    if (value === "--resume") {
      parsed.resume = true;
      continue;
    }
    const match = value.match(/^--([^=]+)=(.*)$/);
    if (!match || !supported.has(match[1])) throw new Error(`Unknown argument: ${value}`);
    parsed[toCamelCase(match[1])] = match[2];
  }
  return parsed;
}

function integerArg(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`Expected an integer between ${min} and ${max}; received ${value}.`);
  }
  return parsed;
}

function required(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`--${name}=... is required.`);
  return text;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
