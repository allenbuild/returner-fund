import path from "node:path";
import { fileURLToPath } from "node:url";
import { BATCH_SNAPSHOTS } from "../update-daily-benchmarks.mjs";
import {
  GRAPH_ARTIFACTS,
  HISTORY_ARTIFACTS
} from "../validate-public-artifacts.mjs";
import { formatCommand, runCommand } from "./scoring-v4-ops-lib.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PORT = 3100;

export function parsePublishArgs(rawArgs, env = process.env) {
  const parsed = {
    mode: "dry-run",
    baseUrl: env.GRAPH_API_BASE_URL,
    port: parsePort(env.GRAPH_API_PORT ?? DEFAULT_PORT, "GRAPH_API_PORT"),
    skipBuild: false,
    allowDirtyArtifacts: false,
    explicitMode: undefined,
    explicitPort: false
  };

  for (const argument of rawArgs) {
    if (argument === "--dry-run" || argument === "--publish") {
      const requestedMode = argument === "--publish" ? "publish" : "dry-run";
      if (parsed.explicitMode && parsed.explicitMode !== requestedMode) {
        throw new Error("Choose either --dry-run or --publish.");
      }
      parsed.mode = requestedMode;
      parsed.explicitMode = requestedMode;
      continue;
    }
    if (argument.startsWith("--base-url=")) {
      parsed.baseUrl = validBaseUrl(argument.slice("--base-url=".length));
      continue;
    }
    if (argument.startsWith("--port=")) {
      parsed.port = parsePort(argument.slice("--port=".length), "--port");
      parsed.explicitPort = true;
      continue;
    }
    if (argument === "--skip-build") {
      parsed.skipBuild = true;
      continue;
    }
    if (argument === "--allow-dirty-artifacts") {
      parsed.allowDirtyArtifacts = true;
      continue;
    }
    throw new Error(`Unknown publication argument: ${argument}`);
  }

  if (parsed.baseUrl) parsed.baseUrl = validBaseUrl(parsed.baseUrl);
  if (parsed.baseUrl && parsed.explicitPort) {
    throw new Error("Choose either --base-url or --port, not both.");
  }
  return parsed;
}

export function buildPublicationPlan({ rootDir = REPOSITORY_ROOT, args }) {
  assertArtifactCoverage();
  const graphPaths = GRAPH_ARTIFACTS.map((artifact) => artifact.path);
  const historyPaths = HISTORY_ARTIFACTS.map((artifact) => artifact.path);
  const commands = [];
  const nextCli = path.join(rootDir, "node_modules", "next", "dist", "bin", "next");
  const publisher = path.join(rootDir, "scripts", "update-daily-benchmarks.mjs");
  const validator = path.join(rootDir, "scripts", "validate-public-artifacts.mjs");

  if (!args.baseUrl && !args.skipBuild) {
    commands.push({
      label: "build",
      command: process.execPath,
      args: [nextCli, "build"]
    });
  }
  commands.push({
    label: "publish",
    command: process.execPath,
    args: [publisher, args.baseUrl ? `--base-url=${args.baseUrl}` : `--port=${args.port}`]
  });
  commands.push({
    label: "validate",
    command: process.execPath,
    args: [validator]
  });

  return {
    graphPaths,
    historyPaths,
    outputPaths: [...graphPaths, ...historyPaths],
    commands
  };
}

export async function main(
  rawArgs = process.argv.slice(2),
  { rootDir = REPOSITORY_ROOT, env = process.env, commandRunner = runCommand } = {}
) {
  const args = parsePublishArgs(rawArgs, env);
  const plan = buildPublicationPlan({ rootDir, args });

  if (args.mode === "dry-run") {
    const result = {
      status: "dry-run",
      source: "existing scripts/update-daily-benchmarks.mjs direct-Next publisher",
      graphSnapshots: plan.graphPaths.length,
      historyFiles: plan.historyPaths.length,
      graphPaths: plan.graphPaths,
      historyPaths: plan.historyPaths,
      commands: plan.commands.map(({ label, command, args: commandArgs }) => ({
        label,
        command: formatCommand(command, commandArgs)
      })),
      historyBehavior: "append one v4 daily entry per Central day and weekly entries only when due",
      sourceRefreshPerformed: false,
      databaseBackfillPerformed: false
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (!args.allowDirtyArtifacts) {
    await assertPublicationTargetsClean(plan.outputPaths, { rootDir, env, commandRunner });
  }
  for (const command of plan.commands) {
    await commandRunner(command.command, command.args, { cwd: rootDir, env });
  }

  const result = {
    status: "published-and-validated",
    graphSnapshots: plan.graphPaths.length,
    historyFilesValidated: plan.historyPaths.length,
    sourceRefreshPerformed: false,
    databaseBackfillPerformed: false
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export function assertArtifactCoverage() {
  if (BATCH_SNAPSHOTS.length !== 9 || GRAPH_ARTIFACTS.length !== 9 || HISTORY_ARTIFACTS.length !== 3) {
    throw new Error("Scoring-v4 publication must cover exactly nine graphs and three histories.");
  }
  const publisherPaths = new Set(
    BATCH_SNAPSHOTS.map((snapshot) => path.posix.join("public", "graph", snapshot.filename))
  );
  const validatorPaths = new Set(GRAPH_ARTIFACTS.map((artifact) => artifact.path));
  if (
    publisherPaths.size !== validatorPaths.size ||
    [...publisherPaths].some((artifactPath) => !validatorPaths.has(artifactPath))
  ) {
    throw new Error("Publisher and validator graph artifact sets do not match.");
  }
}

async function assertPublicationTargetsClean(outputPaths, { rootDir, env, commandRunner }) {
  const result = await commandRunner(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...outputPaths],
    { cwd: rootDir, env, capture: true }
  );
  if (result.stdout.trim()) {
    throw new Error(
      "Publication targets already contain uncommitted work; review it or pass --allow-dirty-artifacts explicitly."
    );
  }
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return port;
}

function validBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid graph API base URL: ${value}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Graph API base URL must be an HTTP(S) URL without embedded credentials.");
  }
  return parsed.href.replace(/\/$/, "");
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
