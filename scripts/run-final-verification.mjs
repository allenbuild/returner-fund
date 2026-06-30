import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const startedAt = new Date();
const runId = startedAt.toISOString().replace(/[:.]/g, "-");
const outputDir = path.join("outputs", "final-verification", runId);
const latestPath = path.join("outputs", "final-verification-latest.json");
const skipTargetedIngest = hasArg("--skip-targeted-ingest");
const commands = [
  check("typecheck", "npm", ["run", "typecheck"], true),
  check("tests", "npm", ["test"], true),
  check("build", "npm", ["run", "build"], true),
  check("coverage_report", "npm", ["run", "debug:coverage"], true),
  check("workers_report", "npm", ["run", "debug:workers"], true),
  check("duplicates_report", "npm", ["run", "debug:duplicates"], true),
  check("instagram_doctor", "npm", ["run", "instagram:doctor"], true),
  !skipTargetedIngest &&
    check(
      "heyclicky_instagram_targeted_check",
      "node",
      [
        "scripts/fetch-public-traction.mjs",
        "--social=all",
        "--platform=instagram",
        "--company=HeyClicky",
        "--workers=2",
        "--delay-ms=1200",
        "--force",
        "--discover-missing-social"
      ],
      false
    ),
  !skipTargetedIngest &&
    check(
      "heyclicky_x_targeted_check",
      "node",
      [
        "scripts/fetch-public-traction.mjs",
        "--social=all",
        "--platform=x",
        "--company=HeyClicky",
        "--workers=2",
        "--delay-ms=1200",
        "--force",
        "--discover-missing-social"
      ],
      false
    ),
  check("heyclicky_vs_insforge_scoring", "node", ["scripts/debug-scoring-report.mjs", "--company=HeyClicky", "--right=InsForge"], true),
  check("scoring_experiments", "npm", ["run", "scoring:experiments"], true),
  check("anomaly_report", "npm", ["run", "debug:anomalies"], true),
  check("longrun_checkpoint", "npm", ["run", "longrun:checkpoint"], true),
  check("longrun_final_report", "npm", ["run", "longrun:report"], true)
].filter(Boolean);

const summary = {
  run_id: runId,
  started_at: startedAt.toISOString(),
  finished_at: null,
  elapsed_seconds: null,
  skipped_targeted_ingest: skipTargetedIngest,
  command_count: commands.length,
  pass_count: 0,
  fail_count: 0,
  required_fail_count: 0,
  status: "running",
  commands: []
};

await mkdir(outputDir, { recursive: true });
await writeSummary();

for (const command of commands) {
  const result = await runCommand(command);
  summary.commands.push(result);
  summary.pass_count = summary.commands.filter((item) => item.exit_code === 0).length;
  summary.fail_count = summary.commands.filter((item) => item.exit_code !== 0).length;
  summary.required_fail_count = summary.commands.filter((item) => item.required && item.exit_code !== 0).length;
  await writeSummary();
}

summary.finished_at = new Date().toISOString();
summary.elapsed_seconds = Math.round((new Date(summary.finished_at).valueOf() - startedAt.valueOf()) / 1000);
summary.status = summary.required_fail_count === 0 ? "pass" : "fail";
await writeSummary();

// `longrun:report` reads final-verification-latest.json, so refresh it once
// after the verifier has written the terminal status. This keeps the report
// from saying the final verification is still running.
const finalReportRefresh = await runCommand(check("longrun_final_report", "npm", ["run", "longrun:report"], true));
const reportIndex = summary.commands.findIndex((item) => item.label === "longrun_final_report");
if (reportIndex >= 0) {
  summary.commands[reportIndex] = finalReportRefresh;
} else {
  summary.commands.push(finalReportRefresh);
  summary.command_count = summary.commands.length;
}
summary.pass_count = summary.commands.filter((item) => item.exit_code === 0).length;
summary.fail_count = summary.commands.filter((item) => item.exit_code !== 0).length;
summary.required_fail_count = summary.commands.filter((item) => item.required && item.exit_code !== 0).length;
summary.finished_at = new Date().toISOString();
summary.elapsed_seconds = Math.round((new Date(summary.finished_at).valueOf() - startedAt.valueOf()) / 1000);
summary.status = summary.required_fail_count === 0 ? "pass" : "fail";
await writeSummary();

console.log(
  JSON.stringify(
    {
      outputPath: latestPath,
      status: summary.status,
      passCount: summary.pass_count,
      failCount: summary.fail_count,
      requiredFailCount: summary.required_fail_count
    },
    null,
    2
  )
);

if (summary.required_fail_count > 0) {
  process.exitCode = 1;
}

function check(label, cmd, args, required) {
  return { label, cmd, args, required };
}

function runCommand(command) {
  return new Promise((resolve) => {
    const started = new Date();
    const child = spawn(command.cmd, command.args, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
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
    child.on("close", async (exitCode) => {
      const finished = new Date();
      const baseName = safeFileName(command.label);
      const stdoutPath = path.join(outputDir, `${baseName}.stdout.log`);
      const stderrPath = path.join(outputDir, `${baseName}.stderr.log`);
      await writeFile(stdoutPath, stdout);
      await writeFile(stderrPath, stderr);
      resolve({
        label: command.label,
        command: [command.cmd, ...command.args].join(" "),
        required: command.required,
        started_at: started.toISOString(),
        finished_at: finished.toISOString(),
        elapsed_seconds: Math.round((finished.valueOf() - started.valueOf()) / 1000),
        exit_code: exitCode ?? 1,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        stdout_tail: tail(stdout),
        stderr_tail: tail(stderr)
      });
    });
    child.on("error", async (error) => {
      const finished = new Date();
      resolve({
        label: command.label,
        command: [command.cmd, ...command.args].join(" "),
        required: command.required,
        started_at: started.toISOString(),
        finished_at: finished.toISOString(),
        elapsed_seconds: Math.round((finished.valueOf() - started.valueOf()) / 1000),
        exit_code: 1,
        stdout_path: null,
        stderr_path: null,
        stdout_tail: "",
        stderr_tail: error.message
      });
    });
  });
}

async function writeSummary() {
  await mkdir(path.dirname(latestPath), { recursive: true });
  await writeFile(latestPath, JSON.stringify(summary, null, 2));
}

function safeFileName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function tail(value, max = 1600) {
  const cleaned = String(value ?? "").trim();
  return cleaned.length > max ? cleaned.slice(-max) : cleaned;
}

function hasArg(name) {
  return process.argv.includes(name);
}
