import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const startedAt = new Date();
const runId = `s26-collection-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
const durationMinutes = numberArg("--minutes") ?? 120;
const requestedMaxCompanies = numberArg("--max-companies");
const workers = numberArg("--workers") ?? 8;
const delayMs = numberArg("--delay-ms") ?? 900;
const checkpointEveryMinutes = numberArg("--checkpoint-minutes") ?? 15;
const forceSocial = hasArg("--force-social");
const forcePublic = forceSocial || hasArg("--force-public");
const forceLoggedIn = forceSocial || hasArg("--force-logged-in");
const stopAtMs = startedAt.getTime() + durationMinutes * 60_000;
let nextCheckpointAtMs = startedAt.getTime();
const eventLog = [];

await mkdir(path.join("outputs", "longrun"), { recursive: true });
let summerCompanySlugs = new Set();
let maxCompanies = requestedMaxCompanies;
await record("run_started", { runId, durationMinutes, maxCompanies, workers, delayMs });

const refreshPhase = phase("refresh-official-yc-snapshot", [
  command("scripts/fetch-yc-spring-2026.mjs")
], { required: true });

function collectionPhases() {
  return [
  phase("github-official-links", [
    command("scripts/fetch-github-traction.mjs", [`--max-companies=${maxCompanies}`])
  ]),
  phase("instagram-link-discovery", [
    command("scripts/discover-instagram-overrides.mjs", [
      "--write",
      "--append",
      "--search",
      "--web-search",
      "--promote-search",
      "--company-only",
      `--max-companies=${maxCompanies}`,
      `--workers=${Math.min(4, workers)}`
    ])
  ]),
  phase("public-web-and-community-evidence", [
    command("scripts/fetch-public-traction.mjs", [
      "--social=all",
      `--max-companies=${maxCompanies}`,
      `--workers=${workers}`,
      `--delay-ms=${delayMs}`,
      "--discover-missing-social",
      ...(forcePublic ? ["--force"] : [])
    ]),
    command("scripts/fetch-public-traction.mjs", [
      "--social=none",
      "--platform=product_hunt,youtube,hacker_news,reddit,web,rss",
      `--max-companies=${maxCompanies}`,
      `--workers=${workers}`,
      `--delay-ms=${delayMs}`,
      "--force"
    ])
  ]),
  phase("logged-in-x", [
    command("scripts/fetch-logged-in-social-traction.mjs", [
      "--platforms=x",
      "--entities=all",
      ...optionalTargetLimit("--x-targets"),
      `--workers=${Math.min(3, workers)}`,
      "--limit=30",
      "--scrolls=8",
      "--timeout-ms=90000",
      "--delay-ms=1800",
      "--retry-empty",
      ...(forceLoggedIn ? ["--force"] : [])
    ])
  ]),
  phase("logged-in-instagram", [
    command("scripts/fetch-logged-in-social-traction.mjs", [
      "--platforms=instagram",
      "--entities=all",
      ...optionalTargetLimit("--instagram-targets"),
      "--workers=1",
      "--limit=30",
      "--scrolls=16",
      "--timeout-ms=90000",
      "--delay-ms=2200",
      "--retry-empty",
      ...(forceLoggedIn ? ["--force"] : [])
    ])
  ]),
  phase("reports-and-benchmark-hydration", [
    command("scripts/plan-discovery-tasks.mjs"),
    command("scripts/debug-coverage-report.mjs"),
    command("scripts/debug-instagram-coverage.mjs"),
    command("scripts/debug-duplicates-report.mjs")
  ])
  ];
}

let loop = 0;
while (Date.now() < stopAtMs) {
  loop += 1;
  await record("loop_started", { loop });
  await runPhase(refreshPhase);
  await reloadSummerSnapshot();
  for (const currentPhase of collectionPhases()) {
    if (Date.now() >= stopAtMs) break;
    await runPhase(currentPhase);
  }
  await checkpoint(true);
}

await record("run_finished", { elapsedMinutes: elapsedMinutes() });
await writeRunLog();
console.log(JSON.stringify({ runId, elapsedMinutes: elapsedMinutes(), eventLogPath: eventLogPath(), status: "complete" }, null, 2));

function phase(name, commands, { required = false } = {}) {
  return { name, commands, required };
}

function command(script, args = []) {
  return {
    cmd: process.execPath,
    args: [script, ...args]
  };
}

async function runPhase(currentPhase) {
  await record("phase_started", { phase: currentPhase.name });
  for (const task of currentPhase.commands) {
    if (Date.now() >= stopAtMs) break;
    await runCommand(task, currentPhase.name, currentPhase.required);
    await checkpoint(false);
  }
  await record("phase_finished", { phase: currentPhase.name });
}

async function runCommand(task, phaseName, required = false) {
  const started = Date.now();
  await record("command_started", { phase: phaseName, command: commandLine(task) });
  const result = await exec(task);
  await record("command_finished", {
    phase: phaseName,
    command: commandLine(task),
    exitCode: result.exitCode,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  });
  if (required && result.exitCode !== 0) {
    throw new Error(
      `${phaseName} failed with exit code ${result.exitCode}; refusing to collect against a stale catalog.`
    );
  }
}

function exec(task) {
  return new Promise((resolve) => {
    const child = spawn(task.cmd, task.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
        GRAPH_API_URL: process.env.GRAPH_API_URL ?? "http://127.0.0.1:3000/api/graph?batch=S26&includeNonScoring=1"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString();
      stdout += value;
      process.stdout.write(value);
    });
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString();
      stderr += value;
      process.stderr.write(value);
    });
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.on("error", (error) => resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` }));
  });
}

async function checkpoint(force) {
  if (!force && Date.now() < nextCheckpointAtMs) return;
  nextCheckpointAtMs = Date.now() + checkpointEveryMinutes * 60_000;
  await record("checkpoint_started", { elapsedMinutes: elapsedMinutes() });
  await summarizeArtifacts();
  await record("checkpoint_finished", { elapsedMinutes: elapsedMinutes() });
}

async function summarizeArtifacts() {
  const summary = {
    generatedAt: new Date().toISOString(),
    runId,
    elapsedMinutes: elapsedMinutes(),
    publicEvidence: summarizeEvidence(await readJson("src/lib/social/public-evidence-current.json", null)),
    loggedInEvidence: summarizeEvidence(await readJson("src/lib/social/logged-in-evidence-current.json", null)),
    instagramDiscovery: summarizeInstagramDiscovery(await readJson("outputs/instagram-discovery-candidates.json", null)),
    benchmarks: await readJson("outputs/benchmarks/s26-score-benchmarks.json", null)
  };
  await writeFile(path.join("outputs", "longrun", `${runId}.summary.json`), JSON.stringify(summary, null, 2));
}

async function reloadSummerSnapshot() {
  const summerSnapshot = await readJson("src/lib/yc/summer-2026-companies.json", { companies: [] });
  const companies = summerSnapshot.companies ?? [];
  const expected = summerSnapshot.source?.expectedCompanyCount;
  const observed = summerSnapshot.source?.observedCompanyCount;
  summerCompanySlugs = new Set(companies.map((company) => company.slug).filter(Boolean));
  if (
    expected !== companies.length ||
    observed !== companies.length ||
    summerCompanySlugs.size !== companies.length
  ) {
    throw new Error(
      `Refreshed Summer catalog is incomplete or duplicated: ` +
      `expected=${expected}, observed=${observed}, companies=${companies.length}, ` +
      `uniqueSlugs=${summerCompanySlugs.size}.`
    );
  }
  if (requestedMaxCompanies === null) {
    maxCompanies = summerCompanySlugs.size;
  }
  await record("summer_snapshot_reloaded", {
    companyCount: summerCompanySlugs.size,
    maxCompanies
  });
}

function summarizeEvidence(snapshot) {
  const evidence = snapshot?.evidence ?? [];
  const failures = snapshot?.failures ?? [];
  const summerEvidence = evidence.filter((item) => summerCompanySlugs.has(item.companySlug));
  const summerFailures = failures.filter((item) => summerCompanySlugs.has(item.companySlug));
  return {
    evidenceRows: evidence.length,
    failureRows: failures.length,
    byPlatform: countBy(evidence, (item) => item.platform ?? "unknown"),
    summerRows: summerEvidence.length,
    summerFailureRows: summerFailures.length,
    summerByPlatform: countBy(summerEvidence, (item) => item.platform ?? "unknown")
  };
}

function summarizeInstagramDiscovery(snapshot) {
  if (!snapshot) return null;
  return {
    candidates: snapshot.candidates?.length ?? 0,
    newlyVerified: snapshot.newly_verified_in_this_run ?? snapshot.newlyVerified ?? 0,
    totalVerifiedCompanyInstagramProfiles: snapshot.verified_company_instagram_profiles ?? snapshot.totalVerifiedCompanyInstagramProfiles ?? 0
  };
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function record(type, payload) {
  eventLog.push({ type, at: new Date().toISOString(), elapsedMinutes: elapsedMinutes(), ...payload });
  await writeRunLog();
}

async function writeRunLog() {
  await writeFile(eventLogPath(), JSON.stringify({ runId, startedAt: startedAt.toISOString(), eventLog }, null, 2));
}

function eventLogPath() {
  return path.join("outputs", "longrun", `${runId}.json`);
}

function commandLine(task) {
  return [task.cmd, ...task.args].join(" ");
}

function tail(value, max = 1600) {
  const cleaned = String(value ?? "").trim();
  return cleaned.length > max ? cleaned.slice(-max) : cleaned;
}

function elapsedMinutes() {
  return Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 60_000));
}

function numberArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=").slice(1).join("=");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalTargetLimit(name) {
  const value = numberArg(name);
  return value === null ? [] : [`--max-targets=${value}`];
}

function hasArg(name) {
  return process.argv.includes(name);
}
