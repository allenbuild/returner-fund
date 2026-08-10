import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DAILY_BENCHMARK_TIME_ZONE = "America/Chicago";
export const DAILY_BENCHMARK_UTC_CRON_CANDIDATES = Object.freeze([
  "0 5 * * *",
  "0 6 * * *"
]);
export const DAILY_BENCHMARK_LATENESS_WINDOW_MINUTES = 11 * 60;

const CENTRAL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: DAILY_BENCHMARK_TIME_ZONE,
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
  DAILY_BENCHMARK_UTC_CRON_CANDIDATES.map((cron) => {
    const [minute, hour] = cron.split(" ").map(Number);
    return [cron, { hour, minute }];
  })
);

export function resolveDailyBenchmarkSchedule({
  eventName,
  schedule,
  now = new Date(),
  latenessWindowMinutes = DAILY_BENCHMARK_LATENESS_WINDOW_MINUTES
} = {}) {
  if (eventName === "schedule") {
    return resolveScheduledDailyBenchmark({ schedule, now, latenessWindowMinutes });
  }
  if (eventName === "workflow_dispatch") {
    return {
      accepted: true,
      trigger: "manual-dispatch",
      reason: "explicit-manual-dispatch",
      scheduledUtcHour: null,
      scheduledAt: null,
      centralDate: null,
      latenessMinutes: null
    };
  }
  return rejectedDecision("unsupported-event");
}

export function resolveScheduledDailyBenchmark({
  schedule,
  now = new Date(),
  latenessWindowMinutes = DAILY_BENCHMARK_LATENESS_WINDOW_MINUTES
} = {}) {
  assertValidDate(now);
  assertValidLatenessWindow(latenessWindowMinutes);
  const utcTime = CRON_TIME.get(schedule);
  if (!utcTime) return rejectedDecision("unrecognized-cron");

  const scheduledAt = nearestPriorCronOccurrence(now, utcTime);
  const latenessMinutes = (now.getTime() - scheduledAt.getTime()) / 60_000;
  const details = {
    scheduledUtcHour: utcTime.hour,
    scheduledAt: scheduledAt.toISOString(),
    latenessMinutes
  };
  if (latenessMinutes > latenessWindowMinutes) {
    return rejectedDecision("outside-lateness-window", details);
  }

  const central = centralDateTimeParts(scheduledAt);
  if (central.hour !== "00" || central.minute !== "00" || central.second !== "00") {
    return rejectedDecision("inactive-dst-candidate", details);
  }

  return {
    accepted: true,
    trigger: "schedule",
    reason: "intended-central-midnight",
    ...details,
    centralDate: `${central.year}-${central.month}-${central.day}`
  };
}

export function writeDailyBenchmarkGithubOutputs(
  decision,
  outputPath = process.env.GITHUB_OUTPUT
) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required when writing workflow outputs.");
  const outputs = {
    should_run: String(decision.accepted),
    scheduled_utc_hour: decision.accepted ? decision.scheduledUtcHour ?? "" : "",
    trigger: decision.trigger ?? "",
    reason: decision.reason,
    scheduled_at: decision.accepted ? decision.scheduledAt ?? "" : "",
    central_date: decision.accepted ? decision.centralDate ?? "" : ""
  };
  appendFileSync(
    outputPath,
    `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    "utf8"
  );
  return outputs;
}

export function main(env = process.env) {
  const decision = resolveDailyBenchmarkSchedule({
    eventName: env.GITHUB_EVENT_NAME,
    schedule: env.GITHUB_EVENT_SCHEDULE
  });
  writeDailyBenchmarkGithubOutputs(decision, env.GITHUB_OUTPUT);
  console.log(
    decision.accepted
      ? `Accepted ${decision.trigger} daily benchmark candidate for ${decision.centralDate ?? "manual execution"}.`
      : `Skipping daily benchmark candidate: ${decision.reason}.`
  );
  if (!decision.accepted && decision.reason === "outside-lateness-window") {
    throw new Error(
      `The intended daily benchmark candidate was ${Math.round(decision.latenessMinutes ?? 0)} minutes late and requires manual replay.`
    );
  }
  return decision;
}

function centralDateTimeParts(date) {
  return Object.fromEntries(
    CENTRAL_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
}

function nearestPriorCronOccurrence(now, { hour, minute }) {
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute
  ));
  if (candidate.getTime() > now.getTime()) candidate.setUTCDate(candidate.getUTCDate() - 1);
  return candidate;
}

function rejectedDecision(reason, details = {}) {
  return {
    accepted: false,
    trigger: "schedule",
    reason,
    scheduledUtcHour: null,
    scheduledAt: null,
    centralDate: null,
    latenessMinutes: null,
    ...details
  };
}

function assertValidDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("A valid Date is required to resolve a daily benchmark schedule.");
  }
}

function assertValidLatenessWindow(value) {
  if (!Number.isFinite(value) || value < 0 || value >= 12 * 60) {
    throw new RangeError("The lateness window must be at least zero and less than 12 hours.");
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
