import { spawn } from "node:child_process";

const DATABASE_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function assertDatabaseEnvName(value) {
  if (!DATABASE_ENV_PATTERN.test(value)) {
    throw new Error(`Invalid database URL environment variable name: ${value}`);
  }
  return value;
}

export function databaseTarget(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Database URL must be a valid PostgreSQL URL.");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("Database URL must use the postgres: or postgresql: protocol.");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !database || database.includes("/")) {
    throw new Error("Database URL must identify one host and database name.");
  }

  return `${parsed.hostname}:${parsed.port || "5432"}/${database}`;
}

export function requireConfirmedDatabase({ env, envName, confirmation }) {
  const databaseUrl = env[envName];
  if (!databaseUrl) {
    throw new Error(`${envName} is required for this database operation.`);
  }
  const target = databaseTarget(databaseUrl);
  if (!confirmation) {
    throw new Error(`Pass --confirm-target=${target} after reviewing the database target.`);
  }
  if (confirmation !== target) {
    throw new Error(`Database target confirmation mismatch: expected ${target}.`);
  }
  return { databaseUrl, target };
}

export async function runCommand(
  command,
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    capture = false,
    timeoutMs,
    spawnImpl = spawn
  } = {}
) {
  return await new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    let timeout;

    if (capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    if (timeoutMs) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      timeout.unref();
    }

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      reject(
        new Error(
          `Command failed (${code ?? signal ?? "unknown"}): ${command}${detail ? `\n${detail}` : ""}`
        )
      );
    });
  });
}

export function formatCommand(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

export function lastOutputLine(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:=<>-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}
