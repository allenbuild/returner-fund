import { appendFileSync, readFileSync } from "node:fs";
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
export const DEFAULT_LATENESS_WINDOW_MINUTES = 11 * 60;

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

const CRON_TIME = new Map(
  INGESTION_PRIMARY_UTC_CRON_CANDIDATES.map((cron) => {
    const [minute, hour] = cron.split(" ").map(Number);
    return [cron, { hour, minute }];
  })
);
const REPLAY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function resolveIngestionSchedule({
  eventName,
  schedule,
  replayKey,
  publishedSlotKey,
  now = new Date(),
  latenessWindowMinutes = DEFAULT_LATENESS_WINDOW_MINUTES
} = {}) {
  if (eventName === "schedule") {
    return resolveScheduledIngestion({
      schedule,
      publishedSlotKey,
      now,
      latenessWindowMinutes
    });
  }

  if (eventName === "workflow_dispatch") {
    return resolveManualReplay(replayKey);
  }

  return rejectedDecision("unsupported-event");
}

export function resolveScheduledIngestion({
  schedule,
  publishedSlotKey,
  now = new Date(),
  latenessWindowMinutes = DEFAULT_LATENESS_WINDOW_MINUTES
} = {}) {
  assertValidDate(now);
  assertValidLatenessWindow(latenessWindowMinutes);

  if (schedule === INGESTION_RECOVERY_CRON) {
    return resolveRecoveryIngestion({
      now,
      publishedSlotKey,
      latenessWindowMinutes
    });
  }

  const utcTime = CRON_TIME.get(schedule);
  if (utcTime === undefined) {
    return rejectedDecision("unrecognized-cron");
  }

  const scheduledAt = nearestPriorCronOccurrence(now, utcTime);
  const latenessMinutes = (now.getTime() - scheduledAt.getTime()) / 60_000;
  if (latenessMinutes > latenessWindowMinutes) {
    return rejectedDecision("outside-lateness-window", {
      scheduledAt: scheduledAt.toISOString(),
      latenessMinutes
    });
  }

  const central = centralDateTimeParts(scheduledAt);
  const centralTime = `${central.hour}:${central.minute}`;
  if (!INGESTION_CENTRAL_SLOTS.includes(centralTime) || central.second !== "00") {
    return rejectedDecision("inactive-dst-candidate", {
      scheduledAt: scheduledAt.toISOString(),
      latenessMinutes
    });
  }

  const centralDate = `${central.year}-${central.month}-${central.day}`;
  return {
    accepted: true,
    trigger: "schedule",
    reason: "intended-central-slot",
    slotKey: `central-${centralDate}-${central.hour}${central.minute}`,
    centralDate,
    centralTime,
    scheduledAt: scheduledAt.toISOString(),
    latenessMinutes
  };
}

export function resolveRecoveryIngestion({
  now = new Date(),
  publishedSlotKey,
  latenessWindowMinutes = DEFAULT_LATENESS_WINDOW_MINUTES
} = {}) {
  assertValidDate(now);
  assertValidLatenessWindow(latenessWindowMinutes);

  const scheduledAt = latestPriorCentralSlot(now);
  const latenessMinutes = (now.getTime() - scheduledAt.getTime()) / 60_000;
  if (latenessMinutes > latenessWindowMinutes) {
    return rejectedDecision("outside-lateness-window", {
      scheduledAt: scheduledAt.toISOString(),
      latenessMinutes
    });
  }

  const central = centralDateTimeParts(scheduledAt);
  const centralDate = `${central.year}-${central.month}-${central.day}`;
  const centralTime = `${central.hour}:${central.minute}`;
  const slotKey = `central-${centralDate}-${central.hour}${central.minute}`;
  if (publishedSlotKey === slotKey) {
    return rejectedDecision("latest-slot-already-published", {
      scheduledAt: scheduledAt.toISOString(),
      latenessMinutes,
      centralDate,
      centralTime
    });
  }

  return {
    accepted: true,
    trigger: "schedule",
    reason: "retry-missing-publication",
    slotKey,
    centralDate,
    centralTime,
    scheduledAt: scheduledAt.toISOString(),
    latenessMinutes
  };
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
    latenessMinutes: null
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

export function writeGithubOutputs(decision, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required when writing workflow outputs.");
  }

  const outputs = {
    should_run: String(decision.accepted),
    slot_key: decision.accepted ? decision.slotKey ?? "" : "",
    trigger: decision.trigger ?? "",
    reason: decision.reason,
    scheduled_at: decision.accepted ? decision.scheduledAt ?? "" : ""
  };
  appendFileSync(
    outputPath,
    `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    "utf8"
  );
  return outputs;
}

export function main(env = process.env) {
  const publishedSlotKey = readPublishedSlotKey(
    env.INGESTION_PUBLICATION_RECEIPT_PATH ?? "outputs/ingestion-source-delta-current.json"
  );
  const decision = resolveIngestionSchedule({
    eventName: env.GITHUB_EVENT_NAME,
    schedule: env.GITHUB_EVENT_SCHEDULE,
    replayKey: env.INGESTION_REPLAY_KEY,
    publishedSlotKey
  });
  writeGithubOutputs(decision, env.GITHUB_OUTPUT);
  console.log(
    decision.accepted
      ? `Accepted ${decision.trigger} ingestion key ${decision.slotKey}.`
      : `Skipping ingestion candidate: ${decision.reason}.`
  );
  if (!decision.accepted && decision.reason === "outside-lateness-window") {
    throw new Error(
      `The intended ingestion slot was ${Math.round(decision.latenessMinutes ?? 0)} minutes late and requires replay.`
    );
  }
  return decision;
}

export function readPublishedSlotKey(receiptPath) {
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    return typeof receipt?.idempotencyKey === "string"
      ? receipt.idempotencyKey
      : null;
  } catch {
    return null;
  }
}

function latestPriorCentralSlot(now) {
  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  for (let offsetMinutes = 0; offsetMinutes <= 12 * 60; offsetMinutes += 1) {
    const central = centralDateTimeParts(candidate);
    if (
      central.minute === "00" &&
      central.second === "00" &&
      INGESTION_CENTRAL_SLOTS.includes(`${central.hour}:${central.minute}`)
    ) {
      return new Date(candidate);
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() - 1);
  }
  throw new Error("Unable to resolve a prior Central ingestion slot within 12 hours.");
}

function nearestPriorCronOccurrence(now, { hour, minute }) {
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute
  ));
  if (candidate.getTime() > now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  return candidate;
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
    ...details
  };
}

function assertValidDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("A valid Date is required to resolve an ingestion slot.");
  }
}

function assertValidLatenessWindow(value) {
  if (!Number.isFinite(value) || value < 0 || value >= 12 * 60) {
    throw new RangeError("Lateness window must be at least zero and less than 12 hours.");
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
