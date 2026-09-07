import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INGESTION_ACCEPTANCE_MARKER_PATH =
  "outputs/autonomous-ingestion-acceptance-current.json";
export const INGESTION_ACCEPTANCE_MARKER_KIND =
  "autonomous-ingestion-publication-acceptance";
export const INGESTION_ACCEPTANCE_MARKER_SCHEMA_VERSION = 1;
export const INGESTION_PUBLICATION_RECEIPT_PATH =
  "outputs/ingestion-source-delta-current.json";
export const INGESTION_GRAPH_MANIFEST_PATH = "public/graph/manifest.json";

const execFileAsync = promisify(execFile);
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CENTRAL_SLOT_KEY_PATTERN = /^central-\d{4}-\d{2}-\d{2}-(?:0600|1800)$/;
const STRICT_UTC_RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND = "accepted-full-collection";

export function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function inspectIngestionAcceptanceMarker({
  markerText,
  receiptText,
  manifestText,
  now = new Date()
} = {}) {
  assertValidDate(now, "acceptance inspection clock");
  try {
    const marker = parseObject(markerText, "acceptance marker");
    assertExactKeys(marker, [
      "acceptedAt",
      "bindingSha256",
      "evidenceCollectedAt",
      "kind",
      "manifestContentHash",
      "manifestPath",
      "manifestSha256",
      "publicationCommit",
      "publicationRunAttempt",
      "publicationRunId",
      "publicationSourceSha",
      "receiptPath",
      "receiptSha256",
      "scheduledAt",
      "schemaVersion",
      "slotKey",
      "validation"
    ], "acceptance marker");
    if (marker.schemaVersion !== INGESTION_ACCEPTANCE_MARKER_SCHEMA_VERSION) {
      throw new Error("acceptance marker schema version is not recognized");
    }
    if (marker.kind !== INGESTION_ACCEPTANCE_MARKER_KIND) {
      throw new Error("acceptance marker kind is not recognized");
    }
    if (!CENTRAL_SLOT_KEY_PATTERN.test(marker.slotKey ?? "")) {
      throw new Error("acceptance marker slot key is invalid");
    }
    const scheduledAt = strictInstant(marker.scheduledAt, "acceptance marker scheduledAt");
    assertSlotIdentity(marker.slotKey, scheduledAt);
    const acceptedAt = strictInstant(marker.acceptedAt, "acceptance marker acceptedAt");
    if (acceptedAt.getTime() > now.getTime()) {
      throw new Error("acceptance marker acceptedAt is in the future");
    }
    if (acceptedAt.getTime() < scheduledAt.getTime()) {
      throw new Error("acceptance marker predates its scheduled slot");
    }
    for (const [value, label] of [
      [marker.publicationCommit, "publication commit"],
      [marker.publicationSourceSha, "publication source SHA"]
    ]) {
      if (!FULL_SHA_PATTERN.test(value ?? "")) throw new Error(`${label} is invalid`);
    }
    if (!/^[1-9][0-9]*$/.test(marker.publicationRunId ?? "")) {
      throw new Error("publication run id is invalid");
    }
    if (!/^[1-9][0-9]*$/.test(marker.publicationRunAttempt ?? "")) {
      throw new Error("publication run attempt is invalid");
    }
    if (marker.receiptPath !== INGESTION_PUBLICATION_RECEIPT_PATH) {
      throw new Error("acceptance marker receipt path is invalid");
    }
    if (marker.manifestPath !== INGESTION_GRAPH_MANIFEST_PATH) {
      throw new Error("acceptance marker manifest path is invalid");
    }
    for (const [value, label] of [
      [marker.receiptSha256, "receipt SHA-256"],
      [marker.manifestSha256, "manifest SHA-256"],
      [marker.manifestContentHash, "manifest content hash"],
      [marker.bindingSha256, "acceptance binding SHA-256"]
    ]) {
      if (!SHA256_PATTERN.test(value ?? "")) throw new Error(`${label} is invalid`);
    }

    assertExactKeys(marker.validation, [
      "validatedSha",
      "workflowRunAttempt",
      "workflowRunId"
    ], "acceptance validation metadata");
    if (!FULL_SHA_PATTERN.test(marker.validation.validatedSha ?? "")) {
      throw new Error("validated SHA is invalid");
    }
    if (!/^[1-9][0-9]*$/.test(marker.validation.workflowRunId ?? "")) {
      throw new Error("validation workflow run id is invalid");
    }
    if (!/^[1-9][0-9]*$/.test(marker.validation.workflowRunAttempt ?? "")) {
      throw new Error("validation workflow run attempt is invalid");
    }

    const expectedBinding = acceptanceBindingSha256(marker);
    if (marker.bindingSha256 !== expectedBinding) {
      throw new Error("acceptance marker binding hash mismatch");
    }

    const receipt = parseObject(receiptText, "accepted publication receipt");
    const manifest = parseObject(manifestText, "accepted graph manifest");
    if (sha256Text(receiptText) !== marker.receiptSha256) {
      throw new Error("current publication receipt does not match acceptance marker");
    }
    if (sha256Text(manifestText) !== marker.manifestSha256) {
      throw new Error("current graph manifest does not match acceptance marker");
    }
    validateReceiptAndManifest({
      receipt,
      manifest,
      slotKey: marker.slotKey,
      scheduledAt: marker.scheduledAt,
      evidenceCollectedAt: marker.evidenceCollectedAt,
      manifestContentHash: marker.manifestContentHash
    });

    return Object.freeze({
      status: "valid",
      marker: Object.freeze(marker),
      error: null
    });
  } catch (error) {
    return Object.freeze({
      status: "invalid",
      marker: null,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function buildIngestionAcceptanceMarker({
  cwd = process.cwd(),
  publicationRef,
  validatedRef = publicationRef,
  currentRef,
  slotKey,
  scheduledAt,
  acceptedAt = new Date().toISOString(),
  validationWorkflowRunId,
  validationWorkflowRunAttempt,
  readTextAtRef = (ref, relativePath) => gitText(cwd, ref, relativePath),
  readCommitMessage = (ref) => gitCommitMessage(cwd, ref),
  isAncestor = (ancestor, descendant) => gitIsAncestor(cwd, ancestor, descendant)
} = {}) {
  const normalizedPublicationRef = normalizeFullSha(publicationRef, "publication ref");
  const normalizedValidatedRef = normalizeFullSha(validatedRef, "validated ref");
  if (typeof currentRef !== "string" || !currentRef.trim()) {
    throw new Error("current ref is required");
  }
  if (!CENTRAL_SLOT_KEY_PATTERN.test(slotKey ?? "")) {
    throw new Error("slot key is not a Central ingestion slot");
  }
  const scheduled = strictInstant(scheduledAt, "scheduledAt");
  assertSlotIdentity(slotKey, scheduled);
  const accepted = strictInstant(acceptedAt, "acceptedAt");
  if (accepted.getTime() < scheduled.getTime()) {
    throw new Error("acceptedAt predates scheduledAt");
  }
  const workflowRunId = positiveDecimal(validationWorkflowRunId, "validation workflow run id");
  const workflowRunAttempt = positiveDecimal(
    validationWorkflowRunAttempt,
    "validation workflow run attempt"
  );
  if (!(await isAncestor(normalizedPublicationRef, currentRef))) {
    throw new Error("validated publication is not reachable from current main");
  }
  if (!(await isAncestor(normalizedValidatedRef, currentRef))) {
    throw new Error("validation target is not reachable from current main");
  }

  const [
    publicationReceiptText,
    publicationManifestText,
    validatedReceiptText,
    validatedManifestText,
    currentReceiptText,
    currentManifestText,
    message
  ] =
    await Promise.all([
      readTextAtRef(normalizedPublicationRef, INGESTION_PUBLICATION_RECEIPT_PATH),
      readTextAtRef(normalizedPublicationRef, INGESTION_GRAPH_MANIFEST_PATH),
      readTextAtRef(normalizedValidatedRef, INGESTION_PUBLICATION_RECEIPT_PATH),
      readTextAtRef(normalizedValidatedRef, INGESTION_GRAPH_MANIFEST_PATH),
      readTextAtRef(currentRef, INGESTION_PUBLICATION_RECEIPT_PATH),
      readTextAtRef(currentRef, INGESTION_GRAPH_MANIFEST_PATH),
      readCommitMessage(normalizedPublicationRef)
    ]);
  const receiptSha256 = sha256Text(publicationReceiptText);
  const manifestSha256 = sha256Text(publicationManifestText);
  if (sha256Text(currentReceiptText) !== receiptSha256) {
    throw new Error("current main receipt diverged from the validated publication");
  }
  if (sha256Text(currentManifestText) !== manifestSha256) {
    throw new Error("current main graph manifest diverged from the validated publication");
  }
  if (sha256Text(validatedReceiptText) !== receiptSha256) {
    throw new Error("validation target receipt diverged from the bound publication");
  }
  if (sha256Text(validatedManifestText) !== manifestSha256) {
    throw new Error("validation target graph manifest diverged from the bound publication");
  }

  const receipt = parseObject(publicationReceiptText, "validated publication receipt");
  const manifest = parseObject(publicationManifestText, "validated graph manifest");
  validateReceiptAndManifest({
    receipt,
    manifest,
    slotKey,
    scheduledAt: scheduled.toISOString(),
    evidenceCollectedAt: receipt.evidenceCollectedAt,
    manifestContentHash: manifest.contentHash
  });
  const trailers = exactReturnerPublicationTrailers(message);
  if (trailers.slotKey !== slotKey) throw new Error("publication trailer slot does not match acceptance slot");
  if (trailers.receiptSha256 !== receiptSha256) {
    throw new Error("publication trailer receipt hash does not match validated receipt");
  }
  if (!(await isAncestor(trailers.sourceSha, normalizedPublicationRef))) {
    throw new Error("publication commit does not descend from its source trailer SHA");
  }

  const marker = {
    schemaVersion: INGESTION_ACCEPTANCE_MARKER_SCHEMA_VERSION,
    kind: INGESTION_ACCEPTANCE_MARKER_KIND,
    slotKey,
    scheduledAt: scheduled.toISOString(),
    acceptedAt: accepted.toISOString(),
    publicationCommit: normalizedPublicationRef,
    publicationSourceSha: trailers.sourceSha,
    publicationRunId: trailers.runId,
    publicationRunAttempt: trailers.runAttempt,
    receiptPath: INGESTION_PUBLICATION_RECEIPT_PATH,
    receiptSha256,
    manifestPath: INGESTION_GRAPH_MANIFEST_PATH,
    manifestSha256,
    manifestContentHash: manifest.contentHash,
    evidenceCollectedAt: receipt.evidenceCollectedAt,
    validation: {
      validatedSha: normalizedValidatedRef,
      workflowRunId,
      workflowRunAttempt
    }
  };
  marker.bindingSha256 = acceptanceBindingSha256(marker);
  const inspection = inspectIngestionAcceptanceMarker({
    markerText: `${JSON.stringify(marker)}\n`,
    receiptText: publicationReceiptText,
    manifestText: publicationManifestText,
    now: accepted
  });
  if (inspection.status !== "valid") {
    throw new Error(`generated acceptance marker failed self-validation: ${inspection.error}`);
  }
  return Object.freeze(marker);
}

export function acceptanceBindingSha256(marker) {
  const binding = { ...marker };
  delete binding.bindingSha256;
  return sha256Text(canonicalJson(binding));
}

function validateReceiptAndManifest({
  receipt,
  manifest,
  slotKey,
  scheduledAt,
  evidenceCollectedAt,
  manifestContentHash
}) {
  if (receipt.schemaVersion !== 1) throw new Error("publication receipt schema version is invalid");
  if (receipt.idempotencyKey !== slotKey) throw new Error("publication receipt slot does not match marker");
  if (receipt.trigger !== "schedule") throw new Error("accepted publication receipt is not scheduled ingestion");
  if (strictInstant(receipt.scheduledAt, "publication receipt scheduledAt").toISOString() !== scheduledAt) {
    throw new Error("publication receipt scheduledAt does not match marker");
  }
  const receiptEvidence = strictInstant(
    receipt.evidenceCollectedAt,
    "publication receipt evidenceCollectedAt"
  ).toISOString();
  if (receiptEvidence !== evidenceCollectedAt) {
    throw new Error("publication receipt evidence timestamp does not match marker");
  }
  if (manifest.schemaVersion !== 2) throw new Error("graph manifest schema version is invalid");
  if (manifest.evidenceCollectedAtKind !== ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND) {
    throw new Error("graph manifest does not contain accepted full-collection evidence");
  }
  if (strictInstant(manifest.evidenceCollectedAt, "graph manifest evidenceCollectedAt").toISOString() !== receiptEvidence) {
    throw new Error("graph manifest evidence timestamp does not match publication receipt");
  }
  if (!SHA256_PATTERN.test(manifest.contentHash ?? "") || manifest.contentHash !== manifestContentHash) {
    throw new Error("graph manifest content hash does not match marker");
  }
}

function exactReturnerPublicationTrailers(message) {
  const values = new Map();
  for (const line of String(message ?? "").split(/\r?\n/)) {
    const match = /^(Returner-(?:Slot-Key|Source-SHA|Run-ID|Run-Attempt|Receipt-SHA256)): (.+)$/.exec(line);
    if (!match) continue;
    values.set(match[1], [...(values.get(match[1]) ?? []), match[2]]);
  }
  for (const key of [
    "Returner-Slot-Key",
    "Returner-Source-SHA",
    "Returner-Run-ID",
    "Returner-Run-Attempt",
    "Returner-Receipt-SHA256"
  ]) {
    if (values.get(key)?.length !== 1) throw new Error(`${key} must occur exactly once`);
  }
  const sourceSha = normalizeFullSha(values.get("Returner-Source-SHA")[0], "publication source trailer");
  const receiptSha256 = values.get("Returner-Receipt-SHA256")[0];
  if (!SHA256_PATTERN.test(receiptSha256)) throw new Error("publication receipt trailer hash is invalid");
  return {
    slotKey: values.get("Returner-Slot-Key")[0],
    sourceSha,
    runId: positiveDecimal(values.get("Returner-Run-ID")[0], "publication run id"),
    runAttempt: positiveDecimal(values.get("Returner-Run-Attempt")[0], "publication run attempt"),
    receiptSha256
  };
}

function assertSlotIdentity(slotKey, scheduledAt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(scheduledAt).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  if (parts.second !== "00" || parts.minute !== "00" || !["06", "18"].includes(parts.hour)) {
    throw new Error("scheduledAt is not a Central ingestion slot");
  }
  const expected = `central-${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}`;
  if (slotKey !== expected) throw new Error(`slot identity mismatch (expected ${expected})`);
}

function strictInstant(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a strict UTC timestamp`);
  const match = STRICT_UTC_RFC3339.exec(value);
  if (!match) throw new Error(`${label} must be a strict UTC timestamp`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, 0);
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day ||
    instant.getUTCHours() !== hour ||
    instant.getUTCMinutes() !== minute ||
    instant.getUTCSeconds() !== second
  ) {
    throw new Error(`${label} is not a real UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed;
}

function parseObject(text, label) {
  const value = JSON.parse(String(text));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are not recognized`);
  }
}

function positiveDecimal(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new Error(`${label} must be a positive decimal integer`);
  return normalized;
}

function normalizeFullSha(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!FULL_SHA_PATTERN.test(normalized)) throw new Error(`${label} must be a full lowercase commit SHA`);
  return normalized;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function gitText(cwd, ref, relativePath) {
  const { stdout } = await execFileAsync("git", ["show", `${ref}:${relativePath}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
}

async function gitCommitMessage(cwd, ref) {
  const { stdout } = await execFileAsync("git", ["show", "-s", "--format=%B", ref], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

async function gitIsAncestor(cwd, ancestor, descendant) {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd });
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}

function assertValidDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
}

function parseCliArgs(argv) {
  const values = {};
  for (const token of argv) {
    const match = /^--([a-z0-9-]+)=(.*)$/.exec(token);
    if (!match) throw new Error(`Unsupported acceptance marker argument: ${token}`);
    values[match[1]] = match[2];
  }
  return values;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseCliArgs(argv);
  const output = args.output;
  if (!output) throw new Error("--output is required");
  const marker = await buildIngestionAcceptanceMarker({
    cwd: process.cwd(),
    publicationRef: args["publication-ref"],
    validatedRef: args["validated-ref"] ?? args["publication-ref"],
    currentRef: args["current-ref"],
    slotKey: args["slot-key"],
    scheduledAt: args["scheduled-at"],
    acceptedAt: args["accepted-at"] ?? new Date().toISOString(),
    validationWorkflowRunId: args["validation-run-id"] ?? env.GITHUB_RUN_ID,
    validationWorkflowRunAttempt: args["validation-run-attempt"] ?? env.GITHUB_RUN_ATTEMPT
  });
  await writeFile(output, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  process.stdout.write(`${marker.slotKey}\t${marker.publicationCommit}\t${marker.bindingSha256}\n`);
  return marker;
}

const isEntrypoint = process.argv[1] &&
  pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
