import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_SECONDS = 30;
const MIN_RESERVE_PERCENT = 5;
const MAX_RESERVE_PERCENT = 50;
const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 300;
const POWER_STATUS_TIMEOUT_MS = 5_000;

export function parseAutonomousPowerWatchdogConfig(environment = process.env) {
  const reserveValue = cleanString(
    environment.AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_RESERVE_PERCENT
  );
  if (!reserveValue) {
    return Object.freeze({
      enabled: false,
      reservePercent: null,
      intervalSeconds: DEFAULT_INTERVAL_SECONDS
    });
  }
  const reservePercent = parseBoundedInteger(
    reserveValue,
    "AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_RESERVE_PERCENT",
    MIN_RESERVE_PERCENT,
    MAX_RESERVE_PERCENT
  );
  const intervalValue = cleanString(
    environment.AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_INTERVAL_SECONDS
  );
  const intervalSeconds = intervalValue
    ? parseBoundedInteger(
        intervalValue,
        "AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_INTERVAL_SECONDS",
        MIN_INTERVAL_SECONDS,
        MAX_INTERVAL_SECONDS
      )
    : DEFAULT_INTERVAL_SECONDS;
  return Object.freeze({ enabled: true, reservePercent, intervalSeconds });
}

export function parseMacPowerStatus(source) {
  const value = typeof source === "string" ? source : "";
  const firstLine = value.split(/\r?\n/, 1)[0] ?? "";
  const batteryMatch = value.match(/\b([0-9]{1,3})%;/);
  const parsedPercent = batteryMatch ? Number(batteryMatch[1]) : null;
  return Object.freeze({
    onACPower: firstLine.includes("'AC Power'"),
    batteryPercent:
      Number.isInteger(parsedPercent) && parsedPercent >= 0 && parsedPercent <= 100
        ? parsedPercent
        : null
  });
}

export function shouldTerminateForLowPower(status, reservePercent) {
  return status?.onACPower === false &&
    Number.isInteger(status?.batteryPercent) &&
    status.batteryPercent <= reservePercent;
}

export async function readMacPowerStatus() {
  const { stdout } = await execFileAsync("/usr/bin/pmset", ["-g", "batt"], {
    encoding: "utf8",
    timeout: POWER_STATUS_TIMEOUT_MS,
    maxBuffer: 64 * 1_024
  });
  return parseMacPowerStatus(stdout);
}

export function startAutonomousIngestionPowerWatchdog({
  environment = process.env,
  onLowReserve,
  readPowerStatus = readMacPowerStatus,
  intervalMs,
  reporter = console
} = {}) {
  if (typeof onLowReserve !== "function") {
    throw new TypeError("onLowReserve must be a function.");
  }
  if (typeof readPowerStatus !== "function") {
    throw new TypeError("readPowerStatus must be a function.");
  }
  const config = parseAutonomousPowerWatchdogConfig(environment);
  if (!config.enabled) return disabledWatchdog();

  const pollIntervalMs = intervalMs ?? config.intervalSeconds * 1_000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RangeError("Power watchdog intervalMs must be a positive finite value.");
  }

  const abortController = new AbortController();
  let stopped = false;
  let tripped = false;
  let unreadableWarningEmitted = false;

  const done = (async () => {
    while (!stopped && !tripped) {
      let status;
      try {
        status = await readPowerStatus();
      } catch {
        status = null;
      }

      if (stopped) break;
      if (!status || (
        status.onACPower === false && !Number.isInteger(status.batteryPercent)
      )) {
        if (!unreadableWarningEmitted) {
          reporter.warn(
            "::warning title=Power watchdog read failed::The autonomous ingestion power watchdog could not verify the current battery reserve and will retry without exposing command output."
          );
          unreadableWarningEmitted = true;
        }
      } else {
        unreadableWarningEmitted = false;
        if (shouldTerminateForLowPower(status, config.reservePercent)) {
          tripped = true;
          reporter.error(
            `::error title=Runner battery reserve reached safe floor::The Mac is on battery at ${status.batteryPercent}%. Gracefully stopping autonomous ingestion at the ${config.reservePercent}% reserve floor; checkpoints and the stale Central slot remain retryable.`
          );
          onLowReserve(Object.freeze({
            batteryPercent: status.batteryPercent,
            reservePercent: config.reservePercent
          }));
          break;
        }
      }

      try {
        await delay(pollIntervalMs, undefined, {
          signal: abortController.signal,
          ref: false
        });
      } catch (error) {
        if (error?.name !== "AbortError") throw error;
      }
    }
  })();

  return Object.freeze({
    enabled: true,
    done,
    async stop() {
      if (!stopped) {
        stopped = true;
        abortController.abort();
      }
      await done;
    }
  });
}

function disabledWatchdog() {
  const done = Promise.resolve();
  return Object.freeze({
    enabled: false,
    done,
    async stop() {
      await done;
    }
  });
}

function parseBoundedInteger(value, label, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function cleanString(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}
