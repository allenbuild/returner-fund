import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND } from "./artifact-manifest.mjs";
import {
  INGESTION_ACCEPTANCE_MARKER_PATH,
  INGESTION_GRAPH_MANIFEST_PATH,
  INGESTION_PUBLICATION_RECEIPT_PATH,
  inspectIngestionAcceptanceMarker,
  inspectIngestionPublicationBinding
} from "./ingestion-acceptance-marker.mjs";

export const CENTRAL_TIME_ZONE = "America/Chicago";
export const INGESTION_PRIMARY_UTC_CRON_CANDIDATES = Object.freeze([
  "0 0 * * *",
  "0 11 * * *",
  "0 12 * * *",
  "0 23 * * *"
]);
export const INGESTION_RECOVERY_CRON = "7,22,37,52 * * * *";
export const INGESTION_RECOVERY_DISPATCH_EVENT = "autonomous-ingestion-recovery";
export const INGESTION_RECOVERY_DISPATCH_GITHUB_EVENT = "repository_dispatch";
export const REPOSITORY_ARTIFACT_READ_UNCERTAIN_CODE =
  "RETURNER_REPOSITORY_ARTIFACT_READ_UNCERTAIN";
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
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;
export const SCHEDULE_WATERMARK_RETRY_REASON = "retry-publication-watermark";
export const SCHEDULE_VALIDATION_RETRY_REASON = "retry-publication-validation";
const SCHEDULE_RETRY_REASONS = new Set([
  SCHEDULE_WATERMARK_RETRY_REASON,
  SCHEDULE_VALIDATION_RETRY_REASON
]);
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
  eventAction,
  recoveryExpectedHeadSha,
  triggerSha,
  publicationState,
  now = new Date()
} = {}) {
  if (
    eventName === "schedule" ||
    eventName === INGESTION_RECOVERY_DISPATCH_GITHUB_EVENT
  ) {
    const trustedSchedule = scheduleForTrustedEvent({
      eventName,
      schedule,
      eventAction,
      recoveryExpectedHeadSha,
      triggerSha
    });
    return resolveScheduledIngestion({ schedule: trustedSchedule, publicationState, now });
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
  let watermarkStatus = state.status;

  if (state.status === "valid") {
    if (watermarkMs >= latest.scheduledAt.getTime()) {
      watermarkStatus = "current";
    } else {
      watermarkStatus = "behind";
    }
  }

  const decisionDetails = {
    publicationWatermark: state.watermark?.toISOString() ?? null,
    watermarkStatus,
    acceptanceStatus: acceptanceStatusForSlot(state.acceptance, latest),
    acceptedPublicationCommit: state.acceptance?.marker?.publicationCommit ?? null,
    latestEligibleSlotKey: latest.slotKey,
    graphGeneratedAt: state.graphGeneratedAt
  };
  if (watermarkStatus === "current") {
    if (decisionDetails.acceptanceStatus === "current") {
      return rejectedDecision("publication-acceptance-current", {
        trigger: "schedule",
        ...decisionDetails
      });
    }
    return {
      accepted: true,
      trigger: "schedule",
      reason: SCHEDULE_VALIDATION_RETRY_REASON,
      slotKey: latest.slotKey,
      centralDate: latest.centralDate,
      centralTime: latest.centralTime,
      scheduledAt: latest.scheduledAt.toISOString(),
      latenessMinutes: (now.getTime() - latest.scheduledAt.getTime()) / 60_000,
      recoveryDebt: true,
      validationReplay: true,
      ...decisionDetails
    };
  }

  return {
    accepted: true,
    trigger: "schedule",
    reason: SCHEDULE_WATERMARK_RETRY_REASON,
    slotKey: latest.slotKey,
    centralDate: latest.centralDate,
    centralTime: latest.centralTime,
    scheduledAt: latest.scheduledAt.toISOString(),
    latenessMinutes: (now.getTime() - latest.scheduledAt.getTime()) / 60_000,
    recoveryDebt: true,
    validationReplay: false,
    ...decisionDetails
  };
}

export function revalidateIngestionCandidate({
  candidate,
  eventName,
  schedule,
  eventAction,
  recoveryExpectedHeadSha,
  triggerSha,
  publicationState,
  now = new Date()
} = {}) {
  const validated = validateCandidateForRevalidation(candidate, {
    eventName,
    schedule,
    eventAction,
    recoveryExpectedHeadSha,
    triggerSha
  });
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

  const current = resolveScheduledIngestion({
    schedule: validated.schedule,
    publicationState,
    now
  });
  if (!current.accepted) {
    if (current.reason !== "publication-acceptance-current") {
      throw new Error(`Scheduled candidate revalidation failed closed: ${current.reason}.`);
    }
    return rejectedDecision("queued-publication-acceptance-current", {
      trigger: validated.trigger,
      candidateSlotKey: validated.slotKey,
      publicationWatermark: current.publicationWatermark,
      watermarkStatus: current.watermarkStatus,
      acceptanceStatus: current.acceptanceStatus,
      acceptedPublicationCommit: current.acceptedPublicationCommit,
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
    reason: current.validationReplay
      ? "revalidated-publication-validation"
      : "revalidated-publication-watermark"
  };
}

export function validateCandidateForRevalidation(candidate, {
  eventName,
  schedule,
  eventAction,
  recoveryExpectedHeadSha,
  triggerSha
} = {}) {
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

  const trustedSchedule = scheduleForTrustedEvent({
    eventName,
    schedule,
    eventAction,
    recoveryExpectedHeadSha,
    triggerSha
  });
  if (trigger !== "schedule" || trustedSchedule === null) {
    throw new Error("Scheduled candidate must originate from a trusted schedule wakeup.");
  }
  if (!SCHEDULE_RETRY_REASONS.has(reason) || candidate.recoveryDebt !== true) {
    throw new Error("Scheduled candidate is not authorized by the publication/validation resolver.");
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
    recoveryDebt: true,
    schedule: trustedSchedule
  });
}

export function scheduleForTrustedEvent({
  eventName,
  schedule,
  eventAction,
  recoveryExpectedHeadSha,
  triggerSha
} = {}) {
  if (eventName === "schedule") return schedule;
  if (eventName !== INGESTION_RECOVERY_DISPATCH_GITHUB_EVENT) return null;
  if (eventAction !== INGESTION_RECOVERY_DISPATCH_EVENT) {
    throw new Error("Recovery dispatch event type is not trusted.");
  }

  const expectedHeadSha = cleanString(recoveryExpectedHeadSha)?.toLowerCase() ?? "";
  const actualTriggerSha = cleanString(triggerSha)?.toLowerCase() ?? "";
  if (!FULL_SHA_PATTERN.test(expectedHeadSha) || !FULL_SHA_PATTERN.test(actualTriggerSha)) {
    throw new Error("Recovery dispatch requires exact expected and triggered main commit SHAs.");
  }
  // repository_dispatch always binds github.sha to the then-current default
  // branch. A dashboard/ingestion artifact can legitimately advance main
  // after the supervisor reads it but before GitHub materializes the event.
  // Both values remain exact auditable receipts; resolve against the verified
  // trigger checkout instead of turning that harmless race into a red run.
  return INGESTION_RECOVERY_CRON;
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
  const completenessInstants = [];
  const generationInstants = [];
  let acceptance = Object.freeze({ status: "missing", marker: null, error: null });
  let missing = false;
  let invalid = false;

  await Promise.all([...PUBLICATION_WATERMARK_GRAPHS.map(async ({ path: relativePath, batchSlug }) => {
    let source;
    try {
      source = await reader(relativePath);
    } catch (error) {
      rethrowUncertainRepositoryRead(error);
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
      const { generatedAt } = graphPublicationProvenance({
        graph,
        relativePath,
        now
      });
      graphGeneratedAt[relativePath] = generatedAt.toISOString();
      generationInstants.push(generatedAt);
    } catch {
      graphGeneratedAt[relativePath] = null;
      invalid = true;
    }
  }), inspectPublicationManifest({
    reader,
    now,
    graphGeneratedAt,
    completenessInstants,
    generationInstants
  })
    .then(({ status }) => {
      if (status === "missing") missing = true;
      if (status === "invalid") invalid = true;
    }), inspectPublicationAcceptance({ reader, cwd, ref, now })
    .then((value) => {
      acceptance = value;
    })]);

  completenessInstants.sort((left, right) => left.getTime() - right.getTime());
  generationInstants.sort((left, right) => left.getTime() - right.getTime());
  const watermark = completenessInstants[0] ?? null;
  return Object.freeze({
    status: missing ? "missing" : invalid ? "invalid" : "valid",
    watermark,
    newestGeneratedAt: generationInstants.at(-1) ?? null,
    graphGeneratedAt: Object.freeze({ ...graphGeneratedAt }),
    acceptance
  });
}

async function inspectPublicationAcceptance({ reader, cwd, ref, now }) {
  let markerText;
  try {
    markerText = await reader(INGESTION_ACCEPTANCE_MARKER_PATH);
  } catch (error) {
    rethrowUncertainRepositoryRead(error);
    return Object.freeze({ status: "missing", marker: null, error: null });
  }

  try {
    const [receiptText, manifestText] = await Promise.all([
      reader(INGESTION_PUBLICATION_RECEIPT_PATH),
      reader(INGESTION_GRAPH_MANIFEST_PATH)
    ]);
    const inspected = inspectIngestionAcceptanceMarker({
      markerText,
      receiptText,
      manifestText,
      now
    });
    if (inspected.status !== "valid") return inspected;

    if (ref) {
      const publicationCommit = inspected.marker.publicationCommit;
      if (!(await gitIsAncestor({ cwd, ancestor: publicationCommit, descendant: ref }))) {
        throw new Error("accepted publication commit is not reachable from the publication ref");
      }
      const [publishedReceipt, publishedManifest, validatedReceipt, validatedManifest] = await Promise.all([
        readGitBlobText({
          cwd,
          ref: publicationCommit,
          relativePath: INGESTION_PUBLICATION_RECEIPT_PATH
        }),
        readGitBlobText({
          cwd,
          ref: publicationCommit,
          relativePath: INGESTION_GRAPH_MANIFEST_PATH
        }),
        readGitBlobText({
          cwd,
          ref: inspected.marker.validation.validatedSha,
          relativePath: INGESTION_PUBLICATION_RECEIPT_PATH
        }),
        readGitBlobText({
          cwd,
          ref: inspected.marker.validation.validatedSha,
          relativePath: INGESTION_GRAPH_MANIFEST_PATH
        })
      ]);
      const publicationInspection = inspectIngestionPublicationBinding({
        marker: inspected.marker,
        receiptText: publishedReceipt,
        manifestText: publishedManifest
      });
      if (publicationInspection.status !== "valid") {
        throw new Error(`immutable publication binding is invalid: ${publicationInspection.error}`);
      }
      const validationInspection = inspectIngestionAcceptanceMarker({
        markerText,
        receiptText: validatedReceipt,
        manifestText: validatedManifest,
        now
      });
      if (validationInspection.status !== "valid") {
        throw new Error(`validation target binding is invalid: ${validationInspection.error}`);
      }
      if (!(await gitIsAncestor({
        cwd,
        ancestor: inspected.marker.publicationSourceSha,
        descendant: publicationCommit
      }))) {
        throw new Error("accepted publication does not descend from its source SHA");
      }
      if (!(await gitIsAncestor({
        cwd,
        ancestor: inspected.marker.validation.validatedSha,
        descendant: ref
      }))) {
        throw new Error("acceptance validation target is not reachable from the publication ref");
      }
    }
    return inspected;
  } catch (error) {
    rethrowUncertainRepositoryRead(error);
    return Object.freeze({
      status: "invalid",
      marker: null,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function inspectPublicationManifest({
  reader,
  now,
  graphGeneratedAt,
  completenessInstants,
  generationInstants
}) {
  const descriptor = PUBLICATION_WATERMARK_MANIFEST;
  let source;
  try {
    source = await reader(descriptor.path);
  } catch (error) {
    rethrowUncertainRepositoryRead(error);
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
    if (manifest.evidenceCollectedAtKind !== ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND) {
      throw new Error("manifest evidence timestamp is not accepted full-collection provenance");
    }

    const publishedAt = publicationInstant(manifest.publishedAt, `${descriptor.path} publishedAt`, now);
    const evidenceCollectedAt = publicationInstant(
      manifest.evidenceCollectedAt,
      `${descriptor.path} evidenceCollectedAt`,
      now
    );
    const graphEntries = artifactEntryMap(manifest.graphArtifacts, "graph");
    const benchmarkEntries = artifactEntryMap(manifest.benchmarkArtifacts, "benchmark");
    const artifactInstants = [];
    const benchmarkInstants = [];
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
      if (result.instant) {
        artifactInstants.push(result.instant);
        benchmarkInstants.push(result.instant);
      }
    }
    if (missingArtifact) {
      graphGeneratedAt[descriptor.path] = null;
      return { status: "missing" };
    }
    if (artifactInstants.some((instant) => instant.getTime() > publishedAt.getTime())) {
      throw new Error("manifest publication timestamp predates a required artifact");
    }
    if (evidenceCollectedAt.getTime() > publishedAt.getTime()) {
      throw new Error("manifest publication timestamp predates its evidence");
    }

    graphGeneratedAt[descriptor.path] = publishedAt.toISOString();
    generationInstants.push(publishedAt, ...artifactInstants);
    completenessInstants.push(evidenceCollectedAt, ...benchmarkInstants);
    return { status: "valid" };
  } catch (error) {
    rethrowUncertainRepositoryRead(error);
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
  } catch (error) {
    rethrowUncertainRepositoryRead(error);
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
  const provenance = kind === "graph"
    ? graphPublicationProvenance({ graph: artifact, relativePath, now })
    : {
        generatedAt: publicationInstant(
          artifact.generatedAt ?? artifact.updatedAt,
          `${relativePath} generatedAt`,
          now
        )
      };
  const instant = provenance.generatedAt;
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

function graphPublicationProvenance({ graph, relativePath, now }) {
  const generatedAt = publicationInstant(
    graph.generatedAt,
    `${relativePath} generatedAt`,
    now
  );
  const evidenceAsOf = publicationInstant(
    graph.scoringContext?.evidenceAsOf,
    `${relativePath} scoringContext.evidenceAsOf`,
    now
  );
  if (evidenceAsOf.getTime() > generatedAt.getTime()) {
    throw new Error(`${relativePath} evidence timestamp is newer than its generation timestamp`);
  }
  return { generatedAt };
}

function descriptorLabel(kind) {
  return kind === "graph" ? "graph artifact" : "benchmark artifact";
}

function rethrowUncertainRepositoryRead(error) {
  if (error?.code === REPOSITORY_ARTIFACT_READ_UNCERTAIN_CODE) throw error;
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
    validation_replay: String(decision.accepted && decision.validationReplay === true),
    publication_watermark: decision.publicationWatermark ?? "",
    watermark_status: decision.watermarkStatus ?? "",
    acceptance_status: decision.acceptanceStatus ?? "",
    accepted_publication_commit: decision.acceptedPublicationCommit ?? "",
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
  if (
    eventName === "schedule" ||
    eventName === INGESTION_RECOVERY_DISPATCH_GITHUB_EVENT
  ) {
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
        eventAction: env.GITHUB_EVENT_ACTION,
        recoveryExpectedHeadSha: env.INGESTION_RECOVERY_EXPECTED_HEAD_SHA,
        triggerSha: env.GITHUB_TRIGGER_SHA ?? env.GITHUB_SHA,
        publicationState,
        now
      })
    : resolveIngestionSchedule({
        eventName,
        schedule: env.GITHUB_EVENT_SCHEDULE,
        replayKey: env.INGESTION_REPLAY_KEY,
        eventAction: env.GITHUB_EVENT_ACTION,
        recoveryExpectedHeadSha: env.INGESTION_RECOVERY_EXPECTED_HEAD_SHA,
        triggerSha: env.GITHUB_TRIGGER_SHA ?? env.GITHUB_SHA,
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
      graphGeneratedAt: {},
      acceptance: normalizeAcceptanceState(value?.acceptance)
    };
  }
  if (value.status !== "valid") {
    return {
      status: value.status,
      watermark: null,
      newestGeneratedAt: null,
      graphGeneratedAt: value.graphGeneratedAt ?? {},
      acceptance: normalizeAcceptanceState(value.acceptance)
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
      graphGeneratedAt: value.graphGeneratedAt ?? {},
      acceptance: normalizeAcceptanceState(value.acceptance)
    };
  }
  return {
    status: value.status,
    watermark,
    newestGeneratedAt,
    graphGeneratedAt: value.graphGeneratedAt ?? {},
    acceptance: normalizeAcceptanceState(value.acceptance)
  };
}

function normalizeAcceptanceState(value) {
  if (!value || !["valid", "missing", "invalid"].includes(value.status)) {
    return { status: "missing", marker: null, error: null };
  }
  if (value.status !== "valid" || !value.marker || typeof value.marker !== "object") {
    return { status: value.status, marker: null, error: cleanString(value.error) };
  }
  return { status: "valid", marker: value.marker, error: null };
}

function acceptanceStatusForSlot(acceptance, latest) {
  if (!acceptance || acceptance.status !== "valid") return acceptance?.status ?? "missing";
  const marker = acceptance.marker;
  if (
    marker?.slotKey === latest.slotKey &&
    marker?.scheduledAt === latest.scheduledAt.toISOString()
  ) {
    return "current";
  }
  try {
    const acceptedSlot = centralSlotFromScheduledAt(
      parseStrictUtcRfc3339(marker?.scheduledAt, "Acceptance marker scheduledAt")
    );
    if (acceptedSlot.slotKey !== marker?.slotKey) return "invalid";
    return acceptedSlot.scheduledAt.getTime() < latest.scheduledAt.getTime()
      ? "behind"
      : "divergent";
  } catch {
    return "invalid";
  }
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

function gitIsAncestor({ cwd, ancestor, descendant }) {
  for (const [value, label] of [[ancestor, "ancestor"], [descendant, "descendant"]]) {
    const normalized = cleanString(value);
    if (!normalized || normalized.startsWith("-") || /[:\r\n\0]/.test(normalized)) {
      return Promise.reject(new Error(`Publication acceptance ${label} ref is not safe.`));
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(true);
      if (code === 1) return resolve(false);
      reject(new Error(
        `Unable to verify publication acceptance ancestry: ${Buffer.concat(stderr).toString("utf8").trim()}`
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
    validationReplay: false,
    publicationWatermark: null,
    watermarkStatus: null,
    acceptanceStatus: null,
    acceptedPublicationCommit: null,
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
