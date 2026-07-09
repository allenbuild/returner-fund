import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let cachedRuntime = null;

export async function runOpenCli(args, options = {}) {
  const runtime = resolveOpenCliRuntime();
  const result = await execFileAsync(runtime.command, [...runtime.prefixArgs, ...args], {
    cwd: options.cwd ?? process.cwd(),
    timeout: options.timeoutMs ?? 45_000,
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    windowsHide: true,
    env: runtime.env
  });
  return result.stdout;
}

export function openCliAvailable() {
  try {
    resolveOpenCliRuntime();
    return true;
  } catch {
    return false;
  }
}

export function describeOpenCliCommand() {
  try {
    const runtime = resolveOpenCliRuntime();
    return [runtime.command, ...runtime.prefixArgs].join(" ");
  } catch (error) {
    return error instanceof Error ? error.message : "OpenCLI command could not be resolved.";
  }
}

export function resolveOpenCliRuntime() {
  if (cachedRuntime) return cachedRuntime;

  const nodeBinDir = path.dirname(process.execPath);
  const env = {
    ...process.env,
    PATH: [nodeBinDir, process.env.PATH].filter(Boolean).join(path.delimiter)
  };

  const explicitBin = process.env.OPENCLI_BIN;
  if (explicitBin) {
    cachedRuntime = { command: explicitBin, prefixArgs: [], env };
    return cachedRuntime;
  }

  const explicitMain = process.env.OPENCLI_MAIN;
  if (explicitMain) {
    cachedRuntime = { command: process.execPath, prefixArgs: [explicitMain], env };
    return cachedRuntime;
  }

  const mainCandidates = [
    process.platform === "win32"
      ? path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@jackwener", "opencli", "dist", "src", "main.js")
      : "",
    path.join(os.homedir(), ".agent-reach", "tools", "opencli", "dist", "src", "main.js")
  ].filter(Boolean);
  for (const candidate of mainCandidates) {
    if (fs.existsSync(candidate)) {
      cachedRuntime = { command: process.execPath, prefixArgs: [candidate], env };
      return cachedRuntime;
    }
  }

  const binCandidates = [
    findOnPath("opencli", env.PATH),
    path.join(os.homedir(), ".agent-reach-venv", process.platform === "win32" ? "Scripts/opencli.exe" : "bin/opencli"),
    path.join(os.homedir(), ".local", "bin", "opencli"),
    "/opt/homebrew/bin/opencli",
    "/usr/local/bin/opencli",
    latestPnpmDlxOpenCliBin()
  ].filter(Boolean);
  for (const candidate of binCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      cachedRuntime = { command: candidate, prefixArgs: [], env };
      return cachedRuntime;
    }
  }

  const pnpmBin = process.env.PNPM_BIN ?? bundledPnpmPath();
  if (pnpmBin && fs.existsSync(pnpmBin)) {
    cachedRuntime = { command: pnpmBin, prefixArgs: ["dlx", "@jackwener/opencli"], env };
    return cachedRuntime;
  }

  throw new Error("OpenCLI not found. Set OPENCLI_BIN or OPENCLI_MAIN, or install @jackwener/opencli.");
}

function findOnPath(command, pathValue) {
  for (const dir of String(pathValue ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function bundledPnpmPath() {
  const candidate = path.resolve(path.dirname(process.execPath), "..", "..", "bin", process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  return fs.existsSync(candidate) ? candidate : null;
}

function latestPnpmDlxOpenCliBin() {
  const dlxRoot = path.join(os.homedir(), "Library", "Caches", "pnpm", "dlx");
  if (!fs.existsSync(dlxRoot)) return null;

  const candidates = [];
  collectOpenCliBins(dlxRoot, candidates, 0);
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path ?? null;
}

function collectOpenCliBins(dir, candidates, depth) {
  if (depth > 9) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectOpenCliBins(entryPath, candidates, depth + 1);
      continue;
    }
    if (entry.name !== "opencli" && entry.name !== "opencli.cmd") continue;
    if (!entryPath.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}`)) continue;
    try {
      candidates.push({ path: entryPath, mtimeMs: fs.statSync(entryPath).mtimeMs });
    } catch {
      // Ignore stale cache entries.
    }
  }
}
