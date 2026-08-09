import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const HEALTHY_DAILY_STATES = new Set(["healthy", "awaiting_second_slot"]);
const RECOGNIZED_DAILY_STATES = new Set([...HEALTHY_DAILY_STATES, "stale_day"]);
const KNOWN_COLLECTION_STATES = new Set(["complete", "degraded"]);
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function selectPublishedAutonomousIngestionReceipt({
  idempotencyKey,
  publishedCommit,
  currentReceipt = null,
  history = []
}) {
  const expectedKey = clean(idempotencyKey);
  if (!expectedKey) return null;

  const candidates = [
    currentReceipt,
    ...(Array.isArray(history) ? [...history].reverse() : [])
  ];
  for (const receipt of candidates) {
    if (receipt?.schemaVersion !== 1 || clean(receipt?.idempotencyKey) !== expectedKey) continue;
    const classification = classifyAutonomousIngestionReceipt({
      runnerStatus: "already_completed",
      publicationStatus: "already_completed",
      publishedCommit,
      collectionHealth: receipt.collectionHealth,
      providerBlocked: receipt.providerBlocked,
      mappedProviderBlocked: receipt.mappedProviderBlocked,
      mappedScopeUnsupported: receipt.mappedScopeUnsupported,
      mappedFailures: receipt.mappedFailures,
      newPhysicalSources: receipt.newPhysicalSources,
      dailyNewPhysicalSources: receipt.dailyNewPhysicalSources,
      dailySourceHealth: receipt.dailySourceHealth
    });
    if (classification.conclusion !== "failure") {
      return { receipt, classification, publishedCommit: clean(publishedCommit) };
    }
  }
  return null;
}

export function classifyAutonomousIngestionReceipt({
  runnerStatus,
  publicationStatus,
  publishedCommit,
  collectionHealth,
  providerBlocked,
  mappedProviderBlocked,
  mappedScopeUnsupported,
  mappedFailures,
  newPhysicalSources,
  dailyNewPhysicalSources,
  dailySourceHealth
}) {
  const normalizedRunnerStatus = clean(runnerStatus);
  const normalizedPublicationStatus = clean(publicationStatus);
  const normalizedPublishedCommit = clean(publishedCommit);
  const normalizedCoverageHealth = normalizeCoverageHealth({
    collectionHealth,
    providerBlocked,
    mappedProviderBlocked,
    mappedScopeUnsupported,
    mappedFailures
  });
  const normalizedCollectionHealth = normalizedCoverageHealth.collectionHealth;
  const normalizedDailySourceHealth = clean(dailySourceHealth);
  const normalizedNewPhysicalSources = nonNegativeInteger(newPhysicalSources);
  const normalizedDailyNewPhysicalSources = nonNegativeInteger(dailyNewPhysicalSources);
  const healthReceiptError = normalizedCoverageHealth.error ?? validateHealthReceipt({
    collectionHealth: normalizedCollectionHealth,
    newPhysicalSources: normalizedNewPhysicalSources,
    dailyNewPhysicalSources: normalizedDailyNewPhysicalSources,
    dailySourceHealth: normalizedDailySourceHealth
  });
  const commitReceiptError = validateCommitReceipt({
    publicationStatus: normalizedPublicationStatus,
    publishedCommit: normalizedPublishedCommit
  });

  if (commitReceiptError) {
    return failure(commitFailureStatus(normalizedPublicationStatus), commitReceiptError);
  }

  if (normalizedRunnerStatus === "already_completed") {
    if (normalizedPublicationStatus !== "already_completed" ||
        healthReceiptError) {
      return failure(
        "noop_missing_receipt",
        healthReceiptError ?? "The completed run is missing a recognized health receipt."
      );
    }
    if (normalizedDailySourceHealth === "stale_day") {
      return warning(
        "noop_stale_day",
        "The idempotent replay confirms a verified final slot with no new physical sources."
      );
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

  if (healthReceiptError) {
    return failure(
      normalizedPublicationStatus === "no_changes"
        ? "no_changes_missing_receipt"
        : "published_missing_receipt",
      healthReceiptError
    );
  }

  if (!["published", "no_changes"].includes(normalizedPublicationStatus)) {
    return failure(
      "unknown_outcome",
      `The refreshed runner returned an unknown publication outcome: ${normalizedPublicationStatus || "missing"}.`
    );
  }

  if (normalizedDailySourceHealth === "stale_day") {
    return warning(
      normalizedPublicationStatus === "no_changes" ? "no_changes_stale_day" : "published_stale_day",
      "Both Central ingestion slots completed without a new physical source; verified publication remains successful."
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
  const publishedCommit = clean(env.PUBLISHED_COMMIT);
  const result = classifyAutonomousIngestionReceipt({
    runnerStatus: env.RUNNER_STATUS,
    publicationStatus: env.PUBLICATION_STATUS,
    publishedCommit,
    collectionHealth: env.COLLECTION_HEALTH,
    providerBlocked: env.PROVIDER_BLOCKED,
    mappedProviderBlocked: env.MAPPED_PROVIDER_BLOCKED,
    mappedScopeUnsupported: env.MAPPED_SCOPE_UNSUPPORTED,
    mappedFailures: env.MAPPED_FAILURES,
    newPhysicalSources: env.NEW_PHYSICAL_SOURCES,
    dailyNewPhysicalSources: env.DAILY_NEW_PHYSICAL_SOURCES,
    dailySourceHealth: env.DAILY_SOURCE_HEALTH
  });
  const slotKey = clean(env.SLOT_KEY) || "unknown-slot";
  const outputPath = clean(env.GITHUB_OUTPUT);
  const summaryPath = clean(env.GITHUB_STEP_SUMMARY);
  const normalizedCoverageHealth = normalizeCoverageHealth({
    collectionHealth: env.COLLECTION_HEALTH,
    providerBlocked: env.PROVIDER_BLOCKED,
    mappedProviderBlocked: env.MAPPED_PROVIDER_BLOCKED,
    mappedScopeUnsupported: env.MAPPED_SCOPE_UNSUPPORTED,
    mappedFailures: env.MAPPED_FAILURES
  });

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
        `- Collection health: ${normalizedCoverageHealth.collectionHealth || "unknown"}`,
        `- Collection health reasons: ${clean(env.COLLECTION_HEALTH_REASONS) || "none"}`,
        `- Provider-blocked tasks (all): ${clean(env.PROVIDER_BLOCKED) || "0"}`,
        `- Provider blocker reasons (all): ${clean(env.PROVIDER_BLOCKED_BY_REASON) || "none"}`,
        `- Provider-blocked mapped tasks: ${clean(env.MAPPED_PROVIDER_BLOCKED) || "0"}`,
        `- Provider blocker reasons (mapped): ${clean(env.MAPPED_PROVIDER_BLOCKED_BY_REASON) || "none"}`,
        `- Mapped scope unsupported: ${clean(env.MAPPED_SCOPE_UNSUPPORTED) || "0"}`,
        `- Mapped hard failures: ${clean(env.MAPPED_FAILURES) || "0"}`,
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

function nonNegativeInteger(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const normalized = clean(value);
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeCoverageHealth({
  collectionHealth,
  providerBlocked,
  mappedProviderBlocked,
  mappedScopeUnsupported,
  mappedFailures
}) {
  const counts = {
    providerBlocked: optionalNonNegativeInteger(providerBlocked),
    mappedProviderBlocked: optionalNonNegativeInteger(mappedProviderBlocked),
    mappedScopeUnsupported: optionalNonNegativeInteger(mappedScopeUnsupported),
    mappedFailures: optionalNonNegativeInteger(mappedFailures)
  };
  if (Object.values(counts).some((value) => value === null)) {
    return {
      collectionHealth: clean(collectionHealth),
      error: "Collection coverage counts must be non-negative safe integers."
    };
  }
  const degraded = Object.values(counts).some((value) => value > 0);
  const declaredHealth = clean(collectionHealth);
  return {
    collectionHealth: declaredHealth === "complete" && degraded ? "degraded" : declaredHealth,
    error: null
  };
}

function optionalNonNegativeInteger(value) {
  if (!clean(value)) return 0;
  return nonNegativeInteger(value);
}

function validateHealthReceipt({
  collectionHealth,
  newPhysicalSources,
  dailyNewPhysicalSources,
  dailySourceHealth
}) {
  if (!KNOWN_COLLECTION_STATES.has(collectionHealth) ||
      !RECOGNIZED_DAILY_STATES.has(dailySourceHealth)) {
    return "The run is missing a recognized collection or daily source health state.";
  }
  if (newPhysicalSources === null || dailyNewPhysicalSources === null) {
    return "Source counts must be non-negative safe integers.";
  }
  if (dailyNewPhysicalSources < newPhysicalSources) {
    return (
      "The Central-day physical-source count cannot be smaller than the current slot count."
    );
  }
  if (dailySourceHealth === "healthy" && dailyNewPhysicalSources === 0) {
    return "Healthy daily source state requires a positive Central-day physical-source count.";
  }
  if (dailySourceHealth !== "healthy" && dailyNewPhysicalSources !== 0) {
    return (
      `${dailySourceHealth} daily source state requires a zero Central-day physical-source count.`
    );
  }
  return null;
}

function validateCommitReceipt({ publicationStatus, publishedCommit }) {
  if (!["published", "no_changes", "already_completed"].includes(publicationStatus)) {
    return null;
  }
  if (!FULL_COMMIT_SHA_PATTERN.test(publishedCommit)) {
    return (
      `The ${publicationStatus} outcome requires an exact full 40-hex repository commit SHA.`
    );
  }
  return null;
}

function commitFailureStatus(publicationStatus) {
  if (publicationStatus === "already_completed") return "noop_missing_commit";
  if (publicationStatus === "no_changes") return "no_changes_missing_commit";
  return "published_missing_commit";
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
