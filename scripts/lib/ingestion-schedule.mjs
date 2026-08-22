import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
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
export const INGESTION_RECOVERY_ROLLOUT_SLOT_KEY = "central-2026-08-22-0600";
export const INGESTION_RECOVERY_ROLLOUT_SCHEDULED_AT = "2026-08-22T11:00:00.000Z";

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
const CENTRAL_SLOT_KEY_PATTERN = /^central-\d{4}-\d{2}-\d{2}-(?:0600|1800)$/;
const PUBLICATION_SUBJECT_PREFIX = "Publish autonomous ingestion ";
const PUBLICATION_GIT_LOG_FORMAT = "%H%x00%s%x00%B%x00";
const FULL_HISTORY_CAPTURE_LIMIT = 64 * 1024 * 1024;

export function resolveIngestionSchedule({
  eventName,
  schedule,
  replayKey,
  publishedSlotKeys,
  now = new Date(),
  latenessWindowMinutes = DEFAULT_LATENESS_WINDOW_MINUTES
} = {}) {
  if (eventName === "schedule") {
    return resolveScheduledIngestion({
      schedule,
      publishedSlotKeys,
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
  publishedSlotKeys,
  now = new Date(),
  latenessWindowMinutes = DEFAULT_LATENESS_WINDOW_MINUTES
} = {}) {
  assertValidDate(now);
  assertValidLatenessWindow(latenessWindowMinutes);

  if (schedule === INGESTION_RECOVERY_CRON) {
    return resolveRecoveryIngestion({
      now,
      publishedSlotKeys
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
    latenessMinutes,
    recoveryDebt: false
  };
}

export function resolveRecoveryIngestion({
  now = new Date(),
  publishedSlotKeys = []
} = {}) {
  assertValidDate(now);
  const published = normalizePublishedSlotKeys(publishedSlotKeys);
  const expectedSlots = enumerateExpectedCentralSlotsThrough(now);
  if (expectedSlots.length === 0) return rejectedDecision("before-recovery-rollout-epoch");
  const missing = expectedSlots.find(({ slotKey }) => !published.has(slotKey));
  if (!missing) {
    const latest = expectedSlots.at(-1);
    return rejectedDecision("all-expected-slots-published", {
      latestExpectedSlotKey: latest.slotKey
    });
  }

  const latenessMinutes = (now.getTime() - missing.scheduledAt.getTime()) / 60_000;

  return {
    accepted: true,
    trigger: "schedule",
    reason: "retry-missing-publication",
    slotKey: missing.slotKey,
    centralDate: missing.centralDate,
    centralTime: missing.centralTime,
    scheduledAt: missing.scheduledAt.toISOString(),
    latenessMinutes,
    recoveryDebt: true
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
    latenessMinutes: null,
    recoveryDebt: false
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
    scheduled_at: decision.accepted ? decision.scheduledAt ?? "" : "",
    recovery_debt: String(decision.accepted && decision.recoveryDebt === true)
  };
  appendFileSync(
    outputPath,
    `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    "utf8"
  );
  return outputs;
}

export function main(env = process.env) {
  const publishedSlotKeys = readPublishedCentralSlotKeysFromGitHistory();
  const decision = resolveIngestionSchedule({
    eventName: env.GITHUB_EVENT_NAME,
    schedule: env.GITHUB_EVENT_SCHEDULE,
    replayKey: env.INGESTION_REPLAY_KEY,
    publishedSlotKeys
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

export function readPublishedCentralSlotKeysFromGitHistory({
  cwd = process.cwd(),
  ref = "HEAD"
} = {}) {
  const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd,
    encoding: "utf8"
  }).trim();
  if (shallow !== "false") {
    throw new Error("Autonomous ingestion recovery requires a complete, non-shallow git history.");
  }
  const output = execFileSync(
    "git",
    ["log", "--full-history", `--format=${PUBLICATION_GIT_LOG_FORMAT}`, ref, "--"],
    { cwd, encoding: "utf8", maxBuffer: FULL_HISTORY_CAPTURE_LIMIT }
  );
  return parsePublishedCentralSlotKeysFromGitLog(output);
}

export function parsePublishedCentralSlotKeysFromGitLog(output) {
  const fields = String(output ?? "").split("\0");
  const published = new Set();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const commit = fields[index].trim();
    const subject = fields[index + 1];
    const message = fields[index + 2];
    if (!/^[0-9a-f]{40}$/i.test(commit)) continue;
    const slotKey = exactPublicationTrailer(message, "Returner-Slot-Key");
    if (!CENTRAL_SLOT_KEY_PATTERN.test(slotKey ?? "")) continue;
    if (subject !== `${PUBLICATION_SUBJECT_PREFIX}${slotKey}`) continue;
    if (!/^[0-9a-f]{40}$/.test(exactPublicationTrailer(message, "Returner-Source-SHA") ?? "")) continue;
    if (!/^[1-9][0-9]*$/.test(exactPublicationTrailer(message, "Returner-Run-ID") ?? "")) continue;
    if (!/^[1-9][0-9]*$/.test(exactPublicationTrailer(message, "Returner-Run-Attempt") ?? "")) continue;
    if (!/^[0-9a-f]{64}$/.test(exactPublicationTrailer(message, "Returner-Receipt-SHA256") ?? "")) continue;
    published.add(slotKey);
  }
  return published;
}

export function enumerateExpectedCentralSlotsThrough(now = new Date()) {
  assertValidDate(now);
  const latest = latestPriorCentralSlot(now);
  const rollout = new Date(INGESTION_RECOVERY_ROLLOUT_SCHEDULED_AT);
  if (latest.getTime() < rollout.getTime()) return [];
  const expected = [];
  for (
    let instantMs = rollout.getTime();
    instantMs <= latest.getTime();
    instantMs += 60 * 60_000
  ) {
    const scheduledAt = new Date(instantMs);
    const central = centralDateTimeParts(scheduledAt);
    const centralTime = `${central.hour}:${central.minute}`;
    if (central.second !== "00" || !INGESTION_CENTRAL_SLOTS.includes(centralTime)) continue;
    const centralDate = `${central.year}-${central.month}-${central.day}`;
    expected.push({
      slotKey: `central-${centralDate}-${central.hour}${central.minute}`,
      centralDate,
      centralTime,
      scheduledAt
    });
  }
  if (expected[0]?.slotKey !== INGESTION_RECOVERY_ROLLOUT_SLOT_KEY) {
    throw new Error("Configured ingestion recovery rollout instant does not match its Central slot key.");
  }
  return expected;
}

export function latestPriorCentralSlot(now) {
  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  for (let offsetMinutes = 0; offsetMinutes <= 26 * 60; offsetMinutes += 1) {
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
  throw new Error("Unable to resolve a prior Central ingestion slot within 26 hours.");
}

function exactPublicationTrailer(message, key) {
  const values = String(message ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${key}: `))
    .map((line) => line.slice(key.length + 2));
  if (values.length !== 1 || !values[0] || /[\r\n\0]/.test(values[0])) return null;
  return values[0];
}

function normalizePublishedSlotKeys(values) {
  if (values == null || typeof values[Symbol.iterator] !== "function") {
    throw new TypeError("Published Central slot keys must be an iterable.");
  }
  return new Set([...values].filter((value) => typeof value === "string"));
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
    recoveryDebt: false,
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
