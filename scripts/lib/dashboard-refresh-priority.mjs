import { appendFileSync } from "node:fs";
import {
  INGESTION_RECOVERY_CRON,
  readPublicationWatermark,
  resolveScheduledIngestion
} from "./ingestion-schedule.mjs";

export function resolveDashboardRefreshPriority({ publicationState, now = new Date() } = {}) {
  const ingestion = resolveScheduledIngestion({
    schedule: INGESTION_RECOVERY_CRON,
    publicationState,
    now
  });

  if (ingestion.accepted) {
    return Object.freeze({
      shouldRun: false,
      reason: "defer-for-stale-ingestion",
      ingestionSlotKey: ingestion.slotKey,
      publicationWatermark: ingestion.publicationWatermark,
      watermarkStatus: ingestion.watermarkStatus
    });
  }
  if (ingestion.reason !== "publication-watermark-current") {
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
  { cwd = process.cwd(), now = new Date() } = {}
) {
  const publicationState = await readPublicationWatermark({ cwd, now });
  const decision = resolveDashboardRefreshPriority({ publicationState, now });
  writeDashboardRefreshPriorityOutputs(decision, env.GITHUB_OUTPUT);
  console.log(
    decision.shouldRun
      ? `Dashboard refresh admitted after current ingestion slot ${decision.ingestionSlotKey}.`
      : `Dashboard refresh deferred for stale ingestion slot ${decision.ingestionSlotKey} (${decision.watermarkStatus}).`
  );
  return decision;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
