import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdir, readFile, rm, stat, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

const transitionPollMs = 10;
const malformedTicketGraceMs = 2_000;

export async function acquireClaimTransition(claimPath, {
  actorToken,
  role
}) {
  const ticketsPath = path.join(claimPath, ".transitions");
  await mkdir(ticketsPath, { recursive: true });

  const ticketToken = `${process.pid}-${randomUUID()}`;
  const choosingPath = path.join(ticketsPath, `choosing-${ticketToken}.json`);
  const ticketPath = path.join(ticketsPath, `ticket-${ticketToken}.json`);
  const identity = {
    ticketToken,
    actorToken,
    role,
    pid: process.pid,
    processFingerprint: processStartFingerprint(),
    createdAt: new Date().toISOString()
  };

  await writeJsonAtomic(choosingPath, identity);
  try {
    const existingTickets = await liveTransitionRecords(ticketsPath, "ticket-");
    const ticketNumber = existingTickets.reduce(
      (maximum, record) => Math.max(maximum, positiveInteger(record.value?.number) ?? 0),
      0
    ) + 1;
    await writeJsonAtomic(ticketPath, {
      ...identity,
      number: ticketNumber
    });
  } catch (error) {
    await rm(choosingPath, { force: true });
    throw error;
  }
  await rm(choosingPath, { force: true });

  let released = false;
  try {
    while (true) {
      const choosing = await liveTransitionRecords(ticketsPath, "choosing-");
      if (choosing.length) {
        await delay(transitionPollMs);
        continue;
      }

      const tickets = await liveTransitionRecords(ticketsPath, "ticket-");
      const ownTicket = tickets.find((record) => record.value?.ticketToken === ticketToken);
      if (!ownTicket) {
        throw new Error(`Claim transition ticket ${ticketToken} disappeared before admission.`);
      }
      tickets.sort(compareTickets);
      if (tickets[0]?.value?.ticketToken === ticketToken) {
        return {
          ticketToken,
          release: async () => {
            if (released) return;
            released = true;
            await rm(ticketPath, { force: true });
          }
        };
      }
      await delay(transitionPollMs);
    }
  } catch (error) {
    released = true;
    await rm(ticketPath, { force: true });
    throw error;
  }
}

export function processStartFingerprint(pid = process.pid) {
  const parsedPid = Number(pid);
  if (!Number.isInteger(parsedPid) || parsedPid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const command = [
        `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${parsedPid}"`,
        "if ($process) {",
        "  $created = $process.CreationDate.ToUniversalTime().Ticks",
        "  Write-Output ($created.ToString() + '|' + $process.CommandLine)",
        "}"
      ].join("; ");
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        {
          encoding: "utf8",
          timeout: 2_000,
          windowsHide: true
        }
      );
      if (result.status !== 0) return null;
      const value = result.stdout.trim().replace(/\s+/g, " ");
      return value || null;
    }
    const result = spawnSync(
      "ps",
      ["-p", String(parsedPid), "-o", "lstart=", "-o", "command="],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LC_ALL: "C",
          LANG: "C",
          TZ: "UTC"
        },
        timeout: 2_000,
        windowsHide: true
      }
    );
    if (result.status !== 0) return null;
    const value = result.stdout.trim().replace(/\s+/g, " ");
    return value || null;
  } catch {
    return null;
  }
}

async function liveTransitionRecords(ticketsPath, prefix) {
  let names;
  try {
    names = (await readdir(ticketsPath)).filter(
      (name) => name.startsWith(prefix) && name.endsWith(".json")
    );
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const name of names) {
    const recordPath = path.join(ticketsPath, name);
    const [value, ageMs] = await Promise.all([
      readJson(recordPath, null),
      pathAgeMs(recordPath)
    ]);
    const ownerAlive = transitionOwnerIsAlive(value);
    if (!ownerAlive && (value || ageMs >= malformedTicketGraceMs)) {
      await rm(recordPath, { force: true });
      continue;
    }
    records.push({ name, path: recordPath, value, ageMs });
  }
  return records;
}

function transitionOwnerIsAlive(value) {
  if (!isProcessRunning(value?.pid)) return false;
  if (!value?.processFingerprint) return true;
  const currentFingerprint = processStartFingerprint(value.pid);
  if (!currentFingerprint) return true;
  return currentFingerprint === value.processFingerprint;
}

function compareTickets(left, right) {
  const leftNumber = positiveInteger(left.value?.number) ?? Number.MAX_SAFE_INTEGER;
  const rightNumber = positiveInteger(right.value?.number) ?? Number.MAX_SAFE_INTEGER;
  if (leftNumber !== rightNumber) return leftNumber - rightNumber;

  const leftPid = positiveInteger(left.value?.pid) ?? Number.MAX_SAFE_INTEGER;
  const rightPid = positiveInteger(right.value?.pid) ?? Number.MAX_SAFE_INTEGER;
  if (leftPid !== rightPid) return leftPid - rightPid;

  return String(left.value?.ticketToken ?? left.name)
    .localeCompare(String(right.value?.ticketToken ?? right.name));
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isProcessRunning(pid) {
  const parsedPid = Number(pid);
  if (!Number.isInteger(parsedPid) || parsedPid <= 0) return false;
  try {
    process.kill(parsedPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function pathAgeMs(filePath) {
  try {
    const details = await stat(filePath);
    return Math.max(0, Date.now() - details.mtimeMs);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
