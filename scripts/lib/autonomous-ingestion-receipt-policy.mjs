import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const HEALTHY_DAILY_STATES = new Set(["healthy", "awaiting_second_slot"]);
const KNOWN_COLLECTION_STATES = new Set(["complete", "degraded"]);

export function classifyAutonomousIngestionReceipt({
  runnerStatus,
  publicationStatus,
  collectionHealth,
  newPhysicalSources,
  dailySourceHealth
}) {
  const normalizedRunnerStatus = clean(runnerStatus);
  const normalizedPublicationStatus = clean(publicationStatus);
  const normalizedCollectionHealth = clean(collectionHealth);
  const normalizedDailySourceHealth = clean(dailySourceHealth);
  const normalizedNewPhysicalSources = nonNegativeNumber(newPhysicalSources);

  if (normalizedRunnerStatus === "already_completed") {
    if (normalizedDailySourceHealth === "stale_day") {
      return failure("noop_stale_day", "The final daily receipt has no new physical sources.");
    }
    if (normalizedPublicationStatus !== "already_completed" ||
        normalizedNewPhysicalSources === null ||
        !HEALTHY_DAILY_STATES.has(normalizedDailySourceHealth) ||
        !KNOWN_COLLECTION_STATES.has(normalizedCollectionHealth)) {
      return failure("noop_missing_receipt", "The completed run is missing a recognized health receipt.");
    }
    if (normalizedCollectionHealth === "degraded") {
      return warning("noop_degraded", "The completed run is healthy enough to retain, with degraded collection coverage.");
    }
    if (normalizedDailySourceHealth === "awaiting_second_slot") {
      return warning("noop_no_new_sources", "The morning slot found no new sources; the final daily slot remains pending.");
    }
    return success("noop_completed", "The idempotent replay confirms an already-completed healthy run.");
  }

  if (normalizedRunnerStatus !== "refreshed") {
    return failure(
      "unknown_outcome",
      `The runner returned an unknown outcome: ${normalizedRunnerStatus || "missing"} / ` +
        `${normalizedPublicationStatus || "missing"}.`
    );
  }

  if (normalizedDailySourceHealth === "stale_day") {
    return failure(
      normalizedPublicationStatus === "no_changes" ? "no_changes_stale_day" : "published_stale_day",
      "Both Central ingestion slots completed without a new physical source."
    );
  }

  if (!HEALTHY_DAILY_STATES.has(normalizedDailySourceHealth) ||
      !KNOWN_COLLECTION_STATES.has(normalizedCollectionHealth)) {
    return failure(
      normalizedPublicationStatus === "no_changes"
        ? "no_changes_missing_receipt"
        : "published_missing_receipt",
      "The refreshed run is missing a recognized health receipt."
    );
  }

  if (!["published", "no_changes"].includes(normalizedPublicationStatus)) {
    return failure(
      "unknown_outcome",
      `The refreshed runner returned an unknown publication outcome: ${normalizedPublicationStatus || "missing"}.`
    );
  }

  if (normalizedNewPhysicalSources === null) {
    return failure(
      normalizedPublicationStatus === "no_changes"
        ? "no_changes_missing_receipt"
        : "published_missing_receipt",
      "The refreshed run is missing its physical-source count."
    );
  }

  if (normalizedPublicationStatus === "no_changes") {
    return warning(
      "no_changes",
      normalizedDailySourceHealth === "awaiting_second_slot"
        ? "The morning slot produced no repository changes; the final daily slot remains pending."
        : "The run completed without repository changes after the daily source target was already met."
    );
  }

  if (normalizedCollectionHealth === "degraded") {
    return warning(
      "published_degraded",
      "Artifacts were validated and published with degraded collection coverage."
    );
  }

  if (normalizedNewPhysicalSources === 0) {
    return warning(
      "published_no_new_sources",
      normalizedDailySourceHealth === "awaiting_second_slot"
        ? "The morning publication found no new physical sources; the final daily slot remains pending."
        : "This slot found no new physical sources after the daily source target was already met."
    );
  }

  return success("published", "Artifacts were validated and published with healthy collection coverage.");
}

export async function recordAutonomousIngestionReceipt({
  env = process.env,
  writeOutput = appendFile,
  writeSummary = appendFile
} = {}) {
  const result = classifyAutonomousIngestionReceipt({
    runnerStatus: env.RUNNER_STATUS,
    publicationStatus: env.PUBLICATION_STATUS,
    collectionHealth: env.COLLECTION_HEALTH,
    newPhysicalSources: env.NEW_PHYSICAL_SOURCES,
    dailySourceHealth: env.DAILY_SOURCE_HEALTH
  });
  const publishedCommit = clean(env.PUBLISHED_COMMIT);
  const slotKey = clean(env.SLOT_KEY) || "unknown-slot";
  const outputPath = clean(env.GITHUB_OUTPUT);
  const summaryPath = clean(env.GITHUB_STEP_SUMMARY);

  if (outputPath) {
    await writeOutput(
      outputPath,
      [
        `receipt_status=${result.receiptStatus}`,
        `receipt_conclusion=${result.conclusion}`,
        `published_commit=${publishedCommit}`,
        ""
      ].join("\n"),
      "utf8"
    );
  }

  if (summaryPath) {
    await writeSummary(
      summaryPath,
      [
        "## Autonomous ingestion publication receipt",
        `- Status: ${result.receiptStatus}`,
        `- Conclusion: ${result.conclusion}`,
        `- Slot: ${slotKey}`,
        `- Commit: ${publishedCommit || "none"}`,
        `- Collection health: ${clean(env.COLLECTION_HEALTH) || "unknown"}`,
        `- New physical sources this slot: ${clean(env.NEW_PHYSICAL_SOURCES) || "unknown"}`,
        `- New physical sources this Central day: ${clean(env.DAILY_NEW_PHYSICAL_SOURCES) || "unknown"}`,
        `- Daily source health: ${clean(env.DAILY_SOURCE_HEALTH) || "unknown"}`,
        `- Detail: ${result.message}`,
        "- Artifact validation: passed",
        ""
      ].join("\n"),
      "utf8"
    );
  }

  return {
    ...result,
    publishedCommit,
    slotKey
  };
}

function success(receiptStatus, message) {
  return { receiptStatus, conclusion: "success", message };
}

function warning(receiptStatus, message) {
  return { receiptStatus, conclusion: "warning", message };
}

function failure(receiptStatus, message) {
  return { receiptStatus, conclusion: "failure", message };
}

function nonNegativeNumber(value) {
  const normalized = clean(value);
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function clean(value) {
  return String(value ?? "").trim();
}

async function main() {
  const result = await recordAutonomousIngestionReceipt();
  const annotation = result.conclusion === "failure"
    ? "error"
    : result.conclusion === "warning"
      ? "warning"
      : "notice";
  const title = result.conclusion === "failure"
    ? "Autonomous ingestion receipt failed"
    : result.conclusion === "warning"
      ? "Autonomous ingestion completed with warnings"
      : "Autonomous ingestion completed";
  console.log(
    `::${annotation} title=${title}::${result.receiptStatus} for ${result.slotKey}: ${result.message}`
  );
  if (result.conclusion === "failure") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  await main();
}
