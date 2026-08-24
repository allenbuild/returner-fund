import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CENTRAL_TIME_ZONE = "America/Chicago";
export const INGESTION_PRIMARY_UTC_CRON_CANDIDATES = Object.freeze([
  "0 0 * * *",
  "0 11 * * *",
  "0 12 * * *",
  "0 23 * * *"
]);
export const INGESTION_RECOVERY_CRON = "7,22,37,52 * * * *";
export const INGESTION_UTC_CRON_CANDIDATES = Object.freeze([
  ...INGESTION_PRIMARY_UTC_CRON_CANDIDATES,
  INGESTION_RECOVERY_CRON
]);
export const INGESTION_CENTRAL_SLOTS = Object.freeze(["06:00", "18:00"]);
export const PUBLICATION_WATERMARK_GRAPHS = Object.freeze([
  Object.freeze({ path: "public/graph/s26.json", batchSlug: "S26" }),
  Object.freeze({ path: "public/graph/s2026.json", batchSlug: "S2026" })
]);
export const PUBLICATION_WATERMARK_MANIFEST = Object.freeze({
  path: "public/graph/manifest.json",
  schemaVersion: 2,
  graphFilenames: Object.freeze([
    "s2026.json",
    "s2026-yc-partners.json",
    "s2026-insiders.json",
    "s26.json",
    "s26-yc-partners.json",
    "s26-insiders.json",
    "a16zsr006.json",
    "a16zsr006-yc-partners.json",
    "a16zsr006-insiders.json"
  ]),
  benchmarkFilenames: Object.freeze([
    "s2026-score-benchmarks.json",
    "s26-score-benchmarks.json",
    "a16zsr006-score-benchmarks.json"
  ])
});

const REPLAY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CENTRAL_SLOT_KEY_PATTERN = /^central-\d{4}-\d{2}-\d{2}-(?:0600|1800)$/;
const SCHEDULE_RETRY_REASON = "retry-publication-watermark";
const STRICT_UTC_RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

const CENTRAL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

export function resolveIngestionSchedule({
  eventName,
  schedule,
  replayKey,
  publicationState,
  now = new Date()
} = {}) {
  if (eventName === "schedule") {
    return resolveScheduledIngestion({ schedule, publicationState, now });
  }

  if (eventName === "workflow_dispatch") {
    return resolveManualReplay(replayKey);
  }

  return rejectedDecision("unsupported-event");
}

export function resolveScheduledIngestion({
  schedule,
  publicationState,
  now = new Date()
} = {}) {
  assertValidDate(now);
  if (!INGESTION_UTC_CRON_CANDIDATES.includes(schedule)) {
    return rejectedDecision("unrecognized-cron");
  }

  const latest = latestEligibleCentralSlot(now);
  const state = normalizePublicationState(publicationState, now);
  const watermarkMs = state.watermark?.getTime() ?? null;
  const newestGraphMs = state.newestGeneratedAt?.getTime() ?? watermarkMs;
  let watermarkStatus = state.status;

  if (state.status === "valid") {
    if (watermarkMs >= latest.scheduledAt.getTime()) {
      watermarkStatus = "current";
    } else if (newestGraphMs >= latest.scheduledAt.getTime()) {
      watermarkStatus = "divergent";
    } else {
      watermarkStatus = "behind";
    }
  }

  const decisionDetails = {
    publicationWatermark: state.watermark?.toISOString() ?? null,
    watermarkStatus,
    latestEligibleSlotKey: latest.slotKey,
    graphGeneratedAt: state.graphGeneratedAt
  };
  if (watermarkStatus === "current") {
    return rejectedDecision("publication-watermark-current", {
      trigger: "schedule",
      ...decisionDetails
    });
  }

  return {
    accepted: true,
    trigger: "schedule",
    reason: SCHEDULE_RETRY_REASON,
    slotKey: latest.slotKey,
    centralDate: latest.centralDate,
    centralTime: latest.centralTime,
    scheduledAt: latest.scheduledAt.toISOString(),
    latenessMinutes: (now.getTime() - latest.scheduledAt.getTime()) / 60_000,
    recoveryDebt: true,
    ...decisionDetails
  };
}

export function revalidateIngestionCandidate({
  candidate,
  eventName,
  schedule,
  publicationState,
  now = new Date()
} = {}) {
  const validated = validateCandidateForRevalidation(candidate, { eventName });
  if (validated.trigger === "manual-replay") {
    return {
      accepted: true,
      trigger: "manual-replay",
      reason: "revalidated-manual-replay",
      slotKey: validated.slotKey,
      centralDate: null,
      centralTime: null,
      scheduledAt: null,
      latenessMinutes: null,
      recoveryDebt: false,
      publicationWatermark: null,
      watermarkStatus: "manual",
      latestEligibleSlotKey: null,
      graphGeneratedAt: {}
    };
  }

  const current = resolveScheduledIngestion({ schedule, publicationState, now });
  if (!current.accepted) {
    if (current.reason !== "publication-watermark-current") {
      throw new Error(`Scheduled candidate revalidation failed closed: ${current.reason}.`);
    }
    return rejectedDecision("queued-publication-watermark-current", {
      trigger: validated.trigger,
      candidateSlotKey: validated.slotKey,
      publicationWatermark: current.publicationWatermark,
      watermarkStatus: current.watermarkStatus,
      latestEligibleSlotKey: current.latestEligibleSlotKey,
      graphGeneratedAt: current.graphGeneratedAt
    });
  }
  if (current.slotKey !== validated.slotKey) {
    return rejectedDecision("queued-candidate-superseded", {
      trigger: validated.trigger,
      candidateSlotKey: validated.slotKey,
      publicationWatermark: current.publicationWatermark,
      watermarkStatus: current.watermarkStatus,
      latestEligibleSlotKey: current.slotKey,
      graphGeneratedAt: current.graphGeneratedAt
    });
  }
  if (current.scheduledAt !== validated.scheduledAt) {
    throw new Error("Queued scheduled candidate changed slot identity during revalidation.");
  }

  return {
    ...current,
    reason: "revalidated-publication-watermark"
  };
}

export function validateCandidateForRevalidation(candidate, { eventName } = {}) {
  const trigger = cleanString(candidate?.trigger);
  const slotKey = cleanString(candidate?.slotKey);
  const scheduledAt = cleanString(candidate?.scheduledAt);
  const reason = cleanString(candidate?.reason);
  if (typeof candidate?.recoveryDebt !== "boolean") {
    throw new Error("Queued candidate recovery debt must be boolean.");
  }
  if (!REPLAY_KEY_PATTERN.test(slotKey ?? "")) {
    throw new Error("Queued candidate slot key is not a valid stable idempotency key.");
  }

  if (trigger === "manual-replay") {
    if (eventName !== "workflow_dispatch") {
      throw new Error("Manual replay candidate must originate from workflow_dispatch.");
    }
    if (scheduledAt || reason !== "explicit-replay-key" || candidate.recoveryDebt) {
      throw new Error("Manual replay candidate has contradictory schedule or recovery metadata.");
    }
    return Object.freeze({ trigger, slotKey, scheduledAt: null, recoveryDebt: false });
  }

  if (trigger !== "schedule" || eventName !== "schedule") {
    throw new Error("Scheduled candidate must originate from a schedule event.");
  }
  if (reason !== SCHEDULE_RETRY_REASON || candidate.recoveryDebt !== true) {
    throw new Error("Scheduled candidate is not authorized by the publication-watermark resolver.");
  }
  if (!CENTRAL_SLOT_KEY_PATTERN.test(slotKey)) {
    throw new Error("Scheduled candidate slot key is not a Central publication slot.");
  }
  const scheduled = parseStrictUtcRfc3339(scheduledAt, "Queued candidate scheduled_at");
  const expected = centralSlotFromScheduledAt(scheduled);
  if (slotKey !== expected.slotKey) {
    throw new Error(
      `Queued scheduled candidate slot key mismatch (expected ${expected.slotKey}, observed ${slotKey}).`
    );
  }
  return Object.freeze({
    trigger,
    slotKey,
    scheduledAt: scheduled.toISOString(),
    recoveryDebt: true
  });
}

export function resolveManualReplay(replayKey) {
  const normalizedKey = typeof replayKey === "string" ? replayKey.trim() : "";
  if (!REPLAY_KEY_PATTERN.test(normalizedKey)) {
    throw new Error(
      "Manual replay key must be 1-128 characters and use only letters, numbers, period, underscore, colon, or hyphen."
    );
  }

  return {
    accepted: true,
    trigger: "manual-replay",
    reason: "explicit-replay-key",
    slotKey: normalizedKey,
    centralDate: null,
    centralTime: null,
    scheduledAt: null,
    latenessMinutes: null,
    recoveryDebt: false,
    publicationWatermark: null,
    watermarkStatus: "manual",
    latestEligibleSlotKey: null,
    graphGeneratedAt: {}
  };
}

export function centralDateTimeParts(date) {
  assertValidDate(date);
  return Object.fromEntries(
    CENTRAL_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
}

export function latestEligibleCentralSlot(now = new Date()) {
  assertValidDate(now);
  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  for (let offsetMinutes = 0; offsetMinutes <= 26 * 60; offsetMinutes += 1) {
    const central = centralDateTimeParts(candidate);
    if (
      central.minute === "00" &&
      central.second === "00" &&
      INGESTION_CENTRAL_SLOTS.includes(`${central.hour}:${central.minute}`)
    ) {
      return centralSlotFromScheduledAt(candidate);
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() - 1);
  }
  throw new Error("Unable to resolve a prior Central ingestion slot within 26 hours.");
}

export async function readPublicationWatermark({
  cwd = process.cwd(),
  ref = null,
  now = new Date(),
  readText = null
} = {}) {
  assertValidDate(now);
  const reader = readText ?? (ref
    ? (relativePath) => readGitBlobText({ cwd, ref, relativePath })
    : (relativePath) => readFile(path.join(cwd, relativePath), "utf8"));
  const graphGeneratedAt = {};
  const genuineInstants = [];
  let missing = false;
  let invalid = false;

  await Promise.all([...PUBLICATION_WATERMARK_GRAPHS.map(async ({ path: relativePath, batchSlug }) => {
    let source;
    try {
      source = await reader(relativePath);
    } catch {
      graphGeneratedAt[relativePath] = null;
      missing = true;
      return;
    }

    try {
      const graph = JSON.parse(source);
      if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
        throw new Error("graph root is not an object");
      }
      if (graph.batch?.slug !== batchSlug) {
        throw new Error(`graph batch is not ${batchSlug}`);
      }
      const generatedAt = parseStrictUtcRfc3339(
        graph.generatedAt,
        `${relativePath} generatedAt`
      );
      if (generatedAt.getTime() > now.getTime()) {
        throw new Error(`${relativePath} generatedAt is in the future`);
      }
      graphGeneratedAt[relativePath] = generatedAt.toISOString();
      genuineInstants.push(generatedAt);
    } catch {
      graphGeneratedAt[relativePath] = null;
      invalid = true;
    }
  }), inspectPublicationManifest({ reader, now, graphGeneratedAt, genuineInstants })
    .then(({ status }) => {
      if (status === "missing") missing = true;
      if (status === "invalid") invalid = true;
    })]);

  genuineInstants.sort((left, right) => left.getTime() - right.getTime());
  return Object.freeze({
    status: missing ? "missing" : invalid ? "invalid" : "valid",
    watermark: genuineInstants[0] ?? null,
    newestGeneratedAt: genuineInstants.at(-1) ?? null,
    graphGeneratedAt: Object.freeze({ ...graphGeneratedAt })
  });
}

async function inspectPublicationManifest({ reader, now, graphGeneratedAt, genuineInstants }) {
  const descriptor = PUBLICATION_WATERMARK_MANIFEST;
  let source;
  try {
    source = await reader(descriptor.path);
  } catch {
    graphGeneratedAt[descriptor.path] = null;
    return { status: "missing" };
  }

  try {
    const manifest = JSON.parse(source);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error("manifest root is not an object");
    }
    if (manifest.schemaVersion !== descriptor.schemaVersion) {
      throw new Error("manifest schema version is not recognized");
    }
    if (typeof manifest.ingestionRunId !== "string" || !manifest.ingestionRunId.trim()) {
      throw new Error("manifest ingestion run id is missing");
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.contentHash ?? "")) {
      throw new Error("manifest content hash is invalid");
    }

    const publishedAt = publicationInstant(manifest.publishedAt, `${descriptor.path} publishedAt`, now);
    const graphEntries = artifactEntryMap(manifest.graphArtifacts, "graph");
    const benchmarkEntries = artifactEntryMap(manifest.benchmarkArtifacts, "benchmark");
    const artifactInstants = [];
    let missingArtifact = false;
    for (const filename of descriptor.graphFilenames) {
      const result = await readManifestArtifactInstant({
        reader,
        entry: graphEntries.get(filename),
        filename,
        kind: "graph",
        relativePath: `public/graph/${filename}`,
        now,
        graphGeneratedAt
      });
      missingArtifact ||= result.status === "missing";
      if (result.instant) artifactInstants.push(result.instant);
    }
    for (const filename of descriptor.benchmarkFilenames) {
      const result = await readManifestArtifactInstant({
        reader,
        entry: benchmarkEntries.get(filename),
        filename,
        kind: "benchmark",
        relativePath: `outputs/benchmarks/${filename}`,
        now,
        graphGeneratedAt
      });
      missingArtifact ||= result.status === "missing";
      if (result.instant) artifactInstants.push(result.instant);
    }
    if (missingArtifact) {
      graphGeneratedAt[descriptor.path] = null;
      return { status: "missing" };
    }
    if (artifactInstants.some((instant) => instant.getTime() > publishedAt.getTime())) {
      throw new Error("manifest publication timestamp predates a required artifact");
    }

    graphGeneratedAt[descriptor.path] = publishedAt.toISOString();
    genuineInstants.push(publishedAt, ...artifactInstants);
    return { status: "valid" };
  } catch {
    graphGeneratedAt[descriptor.path] = null;
    return { status: "invalid" };
  }
}

function artifactEntryMap(value, label) {
  if (!Array.isArray(value)) throw new Error(`manifest ${label} artifacts must be an array`);
  const entries = new Map();
  for (const entry of value) {
    const filename = cleanString(entry?.filename);
    if (!filename || entries.has(filename)) {
      throw new Error(`manifest ${label} artifact filename is missing or duplicated`);
    }
    entries.set(filename, entry);
  }
  return entries;
}

async function readManifestArtifactInstant({
  reader,
  entry,
  filename,
  kind,
  relativePath,
  now,
  graphGeneratedAt
}) {
  if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") || !Number.isSafeInteger(entry.byteSize) || entry.byteSize <= 0) {
    throw new Error(`manifest artifact ${filename} is missing trusted identity metadata`);
  }

  let source;
  try {
    source = await reader(relativePath);
  } catch {
    graphGeneratedAt[relativePath] = null;
    return { status: "missing", instant: null };
  }

  const bytes = Buffer.from(source, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== entry.byteSize || sha256 !== entry.sha256) {
    throw new Error(`manifest artifact ${filename} does not match its trusted identity metadata`);
  }

  const artifact = JSON.parse(source);
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error(`manifest artifact ${filename} root is not an object`);
  }
  const actualGeneratedAt = kind === "graph"
    ? artifact.generatedAt
    : artifact.generatedAt ?? artifact.updatedAt;
  const instant = publicationInstant(actualGeneratedAt, `${relativePath} generatedAt`, now);
  const manifestInstant = publicationInstant(
    entry.generatedAt,
    `${descriptorLabel(kind)} manifest generatedAt`,
    now
  );
  if (instant.getTime() !== manifestInstant.getTime()) {
    throw new Error(`manifest artifact ${filename} generatedAt does not match its contents`);
  }
  graphGeneratedAt[relativePath] = instant.toISOString();
  return { status: "valid", instant };
}

function descriptorLabel(kind) {
  return kind === "graph" ? "graph artifact" : "benchmark artifact";
}

function publicationInstant(value, label, now) {
  const instant = parseStrictUtcRfc3339(value, label);
  if (instant.getTime() > now.getTime()) throw new Error(`${label} is in the future`);
  return instant;
}

export function writeGithubOutputs(decision, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required when writing workflow outputs.");
  }

  const outputs = {
    should_run: String(decision.accepted),
    slot_key: decision.accepted ? decision.slotKey ?? "" : "",
    trigger: decision.trigger ?? "",
    reason: decision.reason,
    scheduled_at: decision.accepted ? decision.scheduledAt ?? "" : "",
    recovery_debt: String(decision.accepted && decision.recoveryDebt === true),
    publication_watermark: decision.publicationWatermark ?? "",
    watermark_status: decision.watermarkStatus ?? "",
    latest_slot_key: decision.latestEligibleSlotKey ?? ""
  };
  appendFileSync(
    outputPath,
    `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    "utf8"
  );
  return outputs;
}

export async function main(env = process.env, { cwd = process.cwd(), now = new Date() } = {}) {
  const revalidation = env.INGESTION_REVALIDATE_CANDIDATE === "true";
  const eventName = env.GITHUB_EVENT_NAME;
  let publicationState = null;
  if (eventName === "schedule") {
    publicationState = await readPublicationWatermark({
      cwd,
      ref: cleanString(env.INGESTION_PUBLICATION_REF),
      now
    });
  }

  const decision = revalidation
    ? revalidateIngestionCandidate({
        candidate: {
          trigger: env.CANDIDATE_TRIGGER,
          slotKey: env.CANDIDATE_SLOT_KEY,
          scheduledAt: env.CANDIDATE_SCHEDULED_AT,
          reason: env.CANDIDATE_REASON,
          recoveryDebt: parseStrictBoolean(env.CANDIDATE_RECOVERY_DEBT, "candidate recovery debt")
        },
        eventName,
        schedule: env.GITHUB_EVENT_SCHEDULE,
        publicationState,
        now
      })
    : resolveIngestionSchedule({
        eventName,
        schedule: env.GITHUB_EVENT_SCHEDULE,
        replayKey: env.INGESTION_REPLAY_KEY,
        publicationState,
        now
      });

  writeGithubOutputs(decision, env.GITHUB_OUTPUT);
  console.log(
    decision.accepted
      ? `Accepted ${decision.trigger} ingestion key ${decision.slotKey} (${decision.reason}).`
      : `Skipping ingestion candidate: ${decision.reason}.`
  );
  return decision;
}

function normalizePublicationState(value, now) {
  if (!value || !["valid", "missing", "invalid"].includes(value.status)) {
    return {
      status: "invalid",
      watermark: null,
      newestGeneratedAt: null,
      graphGeneratedAt: {}
    };
  }
  if (value.status !== "valid") {
    return {
      status: value.status,
      watermark: null,
      newestGeneratedAt: null,
      graphGeneratedAt: value.graphGeneratedAt ?? {}
    };
  }
  const watermark = normalizeOptionalDate(value.watermark);
  const newestGeneratedAt = normalizeOptionalDate(value.newestGeneratedAt);
  if (
    value.status === "valid" &&
    (
      !watermark ||
      !newestGeneratedAt ||
      watermark.getTime() > newestGeneratedAt.getTime() ||
      newestGeneratedAt.getTime() > now.getTime()
    )
  ) {
    return {
      status: "invalid",
      watermark: null,
      newestGeneratedAt: null,
      graphGeneratedAt: value.graphGeneratedAt ?? {}
    };
  }
  return {
    status: value.status,
    watermark,
    newestGeneratedAt,
    graphGeneratedAt: value.graphGeneratedAt ?? {}
  };
}

function normalizeOptionalDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value);
  if (typeof value !== "string") return null;
  try {
    return parseStrictUtcRfc3339(value, "publication watermark");
  } catch {
    return null;
  }
}

function centralSlotFromScheduledAt(scheduledAt) {
  const central = centralDateTimeParts(scheduledAt);
  const centralTime = `${central.hour}:${central.minute}`;
  if (central.second !== "00" || !INGESTION_CENTRAL_SLOTS.includes(centralTime)) {
    throw new Error(`Scheduled instant is not a 06:00 or 18:00 ${CENTRAL_TIME_ZONE} slot.`);
  }
  const centralDate = `${central.year}-${central.month}-${central.day}`;
  return {
    slotKey: `central-${centralDate}-${central.hour}${central.minute}`,
    centralDate,
    centralTime,
    scheduledAt: new Date(scheduledAt)
  };
}

function parseStrictUtcRfc3339(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a UTC RFC3339 timestamp.`);
  const match = STRICT_UTC_RFC3339.exec(value);
  if (!match) throw new Error(`${label} must be a UTC RFC3339 timestamp.`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const calendarProbe = new Date(0);
  calendarProbe.setUTCFullYear(year, month - 1, day);
  calendarProbe.setUTCHours(hour, minute, second, 0);
  if (
    calendarProbe.getUTCFullYear() !== year ||
    calendarProbe.getUTCMonth() !== month - 1 ||
    calendarProbe.getUTCDate() !== day ||
    calendarProbe.getUTCHours() !== hour ||
    calendarProbe.getUTCMinutes() !== minute ||
    calendarProbe.getUTCSeconds() !== second
  ) {
    throw new Error(`${label} is not a real UTC calendar instant.`);
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error(`${label} is not a valid UTC instant.`);
  return instant;
}

function readGitBlobText({ cwd, ref, relativePath }) {
  const normalizedRef = cleanString(ref);
  if (!normalizedRef || normalizedRef.startsWith("-") || /[:\r\n\0]/.test(normalizedRef)) {
    return Promise.reject(new Error("Publication watermark git ref is not safe."));
  }
  const objectName = `${normalizedRef}:${relativePath}`;
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "blob", objectName], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(
        `Unable to read ${relativePath} from ${normalizedRef}: ` +
        Buffer.concat(stderr).toString("utf8").trim()
      ));
    });
  });
}

function parseStrictBoolean(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be exactly true or false.`);
}

function cleanString(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function rejectedDecision(reason, details = {}) {
  return {
    accepted: false,
    trigger: "schedule",
    reason,
    slotKey: null,
    centralDate: null,
    centralTime: null,
    scheduledAt: null,
    latenessMinutes: null,
    recoveryDebt: false,
    publicationWatermark: null,
    watermarkStatus: null,
    latestEligibleSlotKey: null,
    graphGeneratedAt: {},
    ...details
  };
}

function assertValidDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("A valid Date is required to resolve an ingestion slot.");
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
