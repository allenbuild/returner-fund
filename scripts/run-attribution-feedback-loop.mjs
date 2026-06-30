import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const minutes = Math.max(1, Number(argValue("--minutes") ?? 300));
const checkpointMinutes = Math.max(1, Number(argValue("--checkpoint-minutes") ?? 30));
const workers = Math.max(1, Number(argValue("--workers") ?? os.cpus().length ?? 4));
const cycleDelayMs = Math.max(0, Number(argValue("--cycle-delay-ms") ?? 60_000));
const runId = argValue("--run-id") ?? `attribution-${timestampSlug(new Date())}`;
const startedAt = new Date();
const deadline = new Date(startedAt.getTime() + minutes * 60_000);
const statusPath = path.join("docs", "ATTRIBUTION_LONG_RUN_STATUS.md");
const latestPath = path.join("outputs", "attribution-feedback-loop-latest.json");
const runPath = path.join("outputs", "attribution-feedback-loop", `${runId}.json`);
const eventLog = [];

await fs.mkdir(path.dirname(runPath), { recursive: true });
await fs.mkdir("docs", { recursive: true });

await checkpoint("started", {
  run_id: runId,
  started_at: startedAt.toISOString(),
  target_minutes: minutes,
  workers,
  deadline: deadline.toISOString()
});

let iteration = 0;
let lastCheckpointAt = 0;

while (Date.now() < deadline.getTime()) {
  iteration += 1;
  await runIteration(iteration);

  const now = Date.now();
  if (now - lastCheckpointAt >= checkpointMinutes * 60_000) {
    lastCheckpointAt = now;
    await checkpoint("periodic_checkpoint", { iteration });
  }

  if (cycleDelayMs > 0 && Date.now() + cycleDelayMs < deadline.getTime()) {
    await sleep(cycleDelayMs);
  }
}

await runIteration(iteration + 1, { final: true });
await checkpoint("finished", { iteration: iteration + 1 });
console.log(JSON.stringify({ outputPath: latestPath, runPath, status: "finished", runId }, null, 2));

async function runIteration(number, options = {}) {
  const commands = [
    command("attribution_audit", "node", [
      "scripts/audit-evidence-attribution.mjs",
      `--workers=${workers}`,
      "--write-doc",
      "--strict"
    ]),
    command("duplicates", "npm", ["run", "debug:duplicates"]),
    command("coverage", "npm", ["run", "debug:coverage"]),
    command("scoring", "npm", ["run", "scoring:experiments"]),
    command("longrun_checkpoint", "npm", ["run", "longrun:checkpoint"]),
    command("longrun_report", "npm", ["run", "longrun:report"])
  ];

  await checkpoint("iteration_started", { iteration: number, final: Boolean(options.final) });

  for (const item of commands) {
    const result = await runCommand(item, number);
    eventLog.push({
      type: "command_finished",
      iteration: number,
      label: item.label,
      exit_code: result.exitCode,
      elapsed_seconds: result.elapsedSeconds,
      stdout_tail: result.stdoutTail,
      stderr_tail: result.stderrTail,
      at: new Date().toISOString()
    });
    await checkpoint("command_finished", { iteration: number, label: item.label, exit_code: result.exitCode });

    if (result.exitCode !== 0 && item.label === "attribution_audit") {
      await checkpoint("high_risk_detected", {
        iteration: number,
        message: "Strict attribution audit found high-risk scored rows. Live guard/report state saved; continuing validation loop."
      });
    }
  }

  await checkpoint("iteration_finished", { iteration: number, final: Boolean(options.final) });
}

function command(label, executable, args) {
  return { label, executable, args };
}

async function runCommand(item, iteration) {
  const started = Date.now();
  const child = spawn(item.executable, item.args, {
    cwd: process.cwd(),
    shell: true,
    windowsHide: true,
    env: process.env
  });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  const logDir = path.join("outputs", "attribution-feedback-loop", runId);
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(path.join(logDir, `${String(iteration).padStart(4, "0")}-${item.label}.stdout.log`), stdout);
  await fs.writeFile(path.join(logDir, `${String(iteration).padStart(4, "0")}-${item.label}.stderr.log`), stderr);

  return {
    exitCode,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr)
  };
}

async function checkpoint(type, details = {}) {
  const now = new Date();
  eventLog.push({ type, at: now.toISOString(), ...details });
  const latestAudit = await readJson(path.join("outputs", "evidence-attribution-audit-s2026.json"), null);
  const coverage = await readJson(path.join("outputs", "coverage-debug-s2026.json"), null);
  const duplicates = await readJson(path.join("outputs", "duplicates-debug-s2026.json"), null);
  const scoring = await readJson(path.join("outputs", "scoring-experiments-s2026.json"), null);
  const payload = {
    run_id: runId,
    status: type === "finished" ? "finished" : "running",
    started_at: startedAt.toISOString(),
    last_checkpoint_at: now.toISOString(),
    target_minutes: minutes,
    elapsed_minutes: Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 60_000)),
    deadline_at: deadline.toISOString(),
    workers,
    event_count: eventLog.length,
    latest_event: eventLog.at(-1),
    latest_audit: latestAudit
      ? {
          result: latestAudit.result,
          scored_evidence_count: latestAudit.scored_evidence_count,
          high_risk_scored_count: latestAudit.high_risk_scored_count,
          medium_risk_scored_count: latestAudit.medium_risk_scored_count,
          first_party_social_review_count: latestAudit.first_party_social_review_count ?? 0,
          founder_first_party_review_count: latestAudit.founder_first_party_review_count ?? 0,
          first_party_social_review_priority_counts: latestAudit.first_party_social_review_priority_counts ?? {},
          guarded_zero_score_rows: latestAudit.guarded_zero_score_rows
        }
      : null,
    coverage: coverage
      ? {
          company_count: coverage.company_count,
          evidence_count: coverage.evidence_count,
          logged_in_social: coverage.logged_in_social,
          x_target_coverage: coverage.x_target_coverage
        }
      : null,
    duplicates: duplicates
      ? {
          duplicate_groups: duplicates.duplicate_group_count ?? duplicates.duplicateGroups,
          duplicate_account_groups: duplicates.duplicate_account_group_count ?? duplicates.duplicateAccountGroups
        }
      : null,
    scoring: scoring
      ? {
          recommended_config: scoring.recommended_config,
          recommended_platform_weights: scoring.recommended_platform_weights
        }
      : null,
    event_log: eventLog.slice(-200)
  };

  await fs.writeFile(latestPath, JSON.stringify(payload, null, 2));
  await fs.writeFile(runPath, JSON.stringify(payload, null, 2));
  await writeStatusMarkdown(payload);
}

async function writeStatusMarkdown(payload) {
  const lines = [
    "# Attribution Long Run Status",
    "",
    "## Run",
    "",
    `- Run id: ${payload.run_id}.`,
    `- Status: ${payload.status}.`,
    `- Started at: ${payload.started_at}.`,
    `- Last checkpoint: ${payload.last_checkpoint_at}.`,
    `- Elapsed: ${Math.floor(payload.elapsed_minutes / 60)}h ${payload.elapsed_minutes % 60}m.`,
    `- Target: ${payload.target_minutes} minutes.`,
    `- Deadline: ${payload.deadline_at}.`,
    `- Workers: ${payload.workers}.`,
    "",
    "## Latest Audit",
    "",
    payload.latest_audit
      ? `- Result: ${payload.latest_audit.result}.`
      : "- Result: not run yet.",
    payload.latest_audit
      ? `- Scored evidence audited: ${payload.latest_audit.scored_evidence_count}.`
      : "- Scored evidence audited: not run yet.",
    payload.latest_audit
      ? `- High-risk scored rows: ${payload.latest_audit.high_risk_scored_count}.`
      : "- High-risk scored rows: not run yet.",
    payload.latest_audit
      ? `- Medium-risk scored rows: ${payload.latest_audit.medium_risk_scored_count}.`
      : "- Medium-risk scored rows: not run yet.",
    payload.latest_audit
      ? `- First-party social body-signal reviews: ${payload.latest_audit.first_party_social_review_count} (${JSON.stringify(payload.latest_audit.first_party_social_review_priority_counts)}).`
      : "- First-party social body-signal reviews: not run yet.",
    payload.latest_audit
      ? `- Founder first-party reviews: ${payload.latest_audit.founder_first_party_review_count}.`
      : "- Founder first-party reviews: not run yet.",
    payload.latest_audit
      ? `- Guarded zero-score rows: ${payload.latest_audit.guarded_zero_score_rows}.`
      : "- Guarded zero-score rows: not run yet.",
    "",
    "## Coverage / Dedupe / Scoring",
    "",
    payload.coverage
      ? `- Company count: ${payload.coverage.company_count}; evidence rows: ${payload.coverage.evidence_count}.`
      : "- Coverage: not run yet.",
    payload.coverage?.logged_in_social
      ? `- Logged-in read-only social: ${payload.coverage.logged_in_social.evidence_rows} rows, platforms ${JSON.stringify(payload.coverage.logged_in_social.platform_rows)}.`
      : "- Logged-in read-only social: not available.",
    payload.coverage?.x_target_coverage
      ? `- X targets: ${payload.coverage.x_target_coverage.attempted_targets}/${payload.coverage.x_target_coverage.known_x_targets} attempted; ${payload.coverage.x_target_coverage.companies_with_x_evidence} companies with X evidence.`
      : "- X targets: not available.",
    payload.duplicates
      ? `- Duplicate groups: ${payload.duplicates.duplicate_groups}; duplicate account groups: ${payload.duplicates.duplicate_account_groups}.`
      : "- Duplicates: not run yet.",
    payload.scoring
      ? `- Scoring config: ${payload.scoring.recommended_config}; weights ${JSON.stringify(payload.scoring.recommended_platform_weights)}.`
      : "- Scoring: not run yet.",
    "",
    "## Recent Events",
    "",
    ...payload.event_log.slice(-25).map((event) => `- ${event.at}: ${event.type}${event.label ? ` (${event.label})` : ""}${event.exit_code !== undefined ? ` exit=${event.exit_code}` : ""}.`),
    "",
    "Machine-readable status: `outputs/attribution-feedback-loop-latest.json`.",
    ""
  ];
  await fs.writeFile(statusPath, lines.join("\n"));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function tail(value, max = 1200) {
  return String(value ?? "").slice(-max).trim();
}

function timestampSlug(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function argValue(name) {
  const equalsValue = process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=").slice(1).join("=");
  if (equalsValue !== undefined) return equalsValue;
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
