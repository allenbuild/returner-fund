import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BATCH_SNAPSHOTS = [
  { slug: "S2026", filename: "s2026.json" },
  { slug: "S26", filename: "s26.json" },
  { slug: "A16ZSR006", filename: "a16zsr006.json" }
];
const DEFAULT_PORT = 3100;
const SERVER_READY_TIMEOUT_MS = 120_000;
const SERVER_READY_POLL_MS = 1_000;
const CENTRAL_TIME_ZONE = "America/Chicago";

const args = parseArgs(process.argv.slice(2));
const now = args.now ? new Date(args.now) : new Date();

if (args.onlyCentralMidnight && !isCentralMidnightHour(now)) {
  console.log(
    `Skipping daily benchmark update; local ${CENTRAL_TIME_ZONE} time is ${formatCentralTime(now)}, not 12am.`
  );
  process.exit(0);
}

const server = await getGraphApiServer(args);

try {
  await waitForGraphApi(server.baseUrl);
  const writtenFiles = [];

  for (const batch of BATCH_SNAPSHOTS) {
    const graph = await fetchGraph(server.baseUrl, batch.slug);
    const outputPath = path.join(process.cwd(), "public", "graph", batch.filename);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(graph)}\n`, "utf8");
    writtenFiles.push({ batch: batch.slug, outputPath, generatedAt: graph.generatedAt });
  }

  console.log(JSON.stringify({ status: "updated", baseUrl: server.baseUrl, writtenFiles }, null, 2));
} finally {
  await server.stop();
}

async function getGraphApiServer(args) {
  if (args.baseUrl) {
    return {
      baseUrl: trimTrailingSlash(args.baseUrl),
      stop: async () => undefined
    };
  }

  const port = args.port ?? DEFAULT_PORT;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(npmCommand(), ["run", "start", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[next] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[next] ${chunk}`));

  return {
    baseUrl,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 5_000).unref();
      })
  };
}

async function waitForGraphApi(baseUrl) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < SERVER_READY_TIMEOUT_MS) {
    try {
      await fetchGraph(baseUrl, BATCH_SNAPSHOTS[0].slug);
      return;
    } catch (error) {
      lastError = error;
      await sleep(SERVER_READY_POLL_MS);
    }
  }

  throw new Error(`Graph API was not ready after ${SERVER_READY_TIMEOUT_MS}ms: ${lastError}`);
}

async function fetchGraph(baseUrl, batchSlug) {
  const url = new URL("/api/graph", `${trimTrailingSlash(baseUrl)}/`);
  url.searchParams.set("batch", batchSlug);
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Graph API failed for ${batchSlug}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function parseArgs(rawArgs) {
  const parsed = {
    baseUrl: process.env.GRAPH_API_BASE_URL,
    onlyCentralMidnight: false,
    port: Number(process.env.GRAPH_API_PORT) || DEFAULT_PORT,
    now: process.env.BENCHMARK_NOW
  };

  for (const arg of rawArgs) {
    if (arg === "--only-central-midnight") {
      parsed.onlyCentralMidnight = true;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      parsed.baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    if (arg.startsWith("--port=")) {
      const port = Number(arg.slice("--port=".length));
      if (Number.isFinite(port) && port > 0) {
        parsed.port = port;
      }
      continue;
    }
    if (arg.startsWith("--now=")) {
      parsed.now = arg.slice("--now=".length);
    }
  }

  return parsed;
}

function isCentralMidnightHour(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: CENTRAL_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date).map((part) => [part.type, part.value])
  );

  return parts.hour === "00" || parts.hour === "24";
}

function formatCentralTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "long"
  }).format(date);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
