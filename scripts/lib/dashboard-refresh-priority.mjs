import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  INGESTION_RECOVERY_CRON,
  readPublicationWatermark,
  resolveScheduledIngestion
} from "./ingestion-schedule.mjs";

const WORKFLOW_RUN_EVENT = "workflow_run";
const DECIMAL_IDENTIFIER = /^[1-9][0-9]*$/;

export function parseDashboardRefreshTrigger({ eventName, eventPayloadText } = {}) {
  if (eventName !== WORKFLOW_RUN_EVENT) {
    return Object.freeze({ eventName, workflowRun: null });
  }

  try {
    const payload = JSON.parse(eventPayloadText);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("workflow event payload is not an object");
    }
    const workflowRun = payload.workflow_run;
    if (!workflowRun || typeof workflowRun !== "object" || Array.isArray(workflowRun)) {
      throw new Error("workflow event payload is missing workflow_run");
    }
    return Object.freeze({
      eventName,
      workflowRun: Object.freeze({
        id: workflowRun.id,
        runAttempt: workflowRun.run_attempt
      })
    });
  } catch {
    return Object.freeze({ eventName, workflowRun: null });
  }
}

export function resolveDashboardRefreshPriority({
  publicationState,
  now = new Date(),
  eventName,
  workflowRun
} = {}) {
  const ingestion = resolveScheduledIngestion({
    schedule: INGESTION_RECOVERY_CRON,
    publicationState,
    now
  });

  if (
    eventName === WORKFLOW_RUN_EVENT &&
    !workflowRunMatchesAcceptanceMarker(workflowRun, publicationState?.acceptance?.marker)
  ) {
    return Object.freeze({
      shouldRun: false,
      reason: "ignore-unbound-ingestion-completion",
      ingestionSlotKey: ingestion.slotKey ?? ingestion.latestEligibleSlotKey,
      publicationWatermark: ingestion.publicationWatermark,
      watermarkStatus: ingestion.watermarkStatus
    });
  }

  if (ingestion.accepted) {
    return Object.freeze({
      shouldRun: false,
      reason: "defer-for-stale-ingestion",
      ingestionSlotKey: ingestion.slotKey,
      publicationWatermark: ingestion.publicationWatermark,
      watermarkStatus: ingestion.watermarkStatus
    });
  }
  if (ingestion.reason !== "publication-acceptance-current") {
    throw new Error(`Dashboard priority resolver received an unexpected ingestion decision: ${ingestion.reason}.`);
  }

  return Object.freeze({
    shouldRun: true,
    reason: "ingestion-publication-current",
    ingestionSlotKey: ingestion.latestEligibleSlotKey,
    publicationWatermark: ingestion.publicationWatermark,
    watermarkStatus: ingestion.watermarkStatus
  });
}

export function writeDashboardRefreshPriorityOutputs(
  decision,
  outputPath = process.env.GITHUB_OUTPUT
) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required when writing dashboard priority outputs.");
  }
  const outputs = {
    should_run: String(decision.shouldRun),
    reason: decision.reason,
    ingestion_slot_key: decision.ingestionSlotKey ?? "",
    publication_watermark: decision.publicationWatermark ?? "",
    watermark_status: decision.watermarkStatus ?? ""
  };
  appendFileSync(
    outputPath,
    `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    "utf8"
  );
  return outputs;
}

export async function main(
  env = process.env,
  { cwd = process.cwd(), now = new Date(), readEventFile = readFile } = {}
) {
  const publicationState = await readPublicationWatermark({ cwd, now });
  let eventPayloadText = "";
  if (env.GITHUB_EVENT_NAME === WORKFLOW_RUN_EVENT && env.GITHUB_EVENT_PATH) {
    try {
      eventPayloadText = await readEventFile(env.GITHUB_EVENT_PATH, "utf8");
    } catch {
      // A workflow completion without a readable event payload is unbound and
      // therefore cannot wake a dashboard publication.
    }
  }
  const trigger = parseDashboardRefreshTrigger({
    eventName: env.GITHUB_EVENT_NAME,
    eventPayloadText
  });
  const decision = resolveDashboardRefreshPriority({
    publicationState,
    now,
    eventName: trigger.eventName,
    workflowRun: trigger.workflowRun
  });
  writeDashboardRefreshPriorityOutputs(decision, env.GITHUB_OUTPUT);
  console.log(
    decision.shouldRun
      ? `Dashboard refresh admitted after current ingestion slot ${decision.ingestionSlotKey}.`
      : decision.reason === "ignore-unbound-ingestion-completion"
        ? "Dashboard refresh ignored because the completed ingestion run is not bound to the current acceptance marker."
        : `Dashboard refresh deferred for stale ingestion slot ${decision.ingestionSlotKey} (${decision.watermarkStatus}).`
  );
  return decision;
}

function workflowRunMatchesAcceptanceMarker(workflowRun, marker) {
  const trigger = normalizeWorkflowRunBinding(workflowRun?.id, workflowRun?.runAttempt);
  if (!trigger || !marker || typeof marker !== "object" || Array.isArray(marker)) return false;

  const publication = normalizeWorkflowRunBinding(
    marker.publicationRunId,
    marker.publicationRunAttempt
  );
  const validation = normalizeWorkflowRunBinding(
    marker.validation?.workflowRunId,
    marker.validation?.workflowRunAttempt
  );
  return bindingsEqual(trigger, publication) || bindingsEqual(trigger, validation);
}

function normalizeWorkflowRunBinding(id, runAttempt) {
  const normalizedId = normalizeDecimalIdentifier(id);
  const normalizedAttempt = normalizeDecimalIdentifier(runAttempt);
  if (!normalizedId || !normalizedAttempt) return null;
  return Object.freeze({ id: normalizedId, runAttempt: normalizedAttempt });
}

function normalizeDecimalIdentifier(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return String(value);
  }
  if (typeof value !== "string" || !DECIMAL_IDENTIFIER.test(value)) return null;
  return value;
}

function bindingsEqual(left, right) {
  return Boolean(
    left &&
    right &&
    left.id === right.id &&
    left.runAttempt === right.runAttempt
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
