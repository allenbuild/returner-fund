import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  runTimelineAdminTaskDrain,
  runTimelineDiscoveryIngestion,
} from "../src/lib/timeline/ingestion-runner.ts";
import { isTimelineCoverageMigrationUnavailable } from "./lib/timeline-migration-availability.mjs";

const args = parseArgs(process.argv.slice(2));
const url = clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
const serviceKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!url || !serviceKey) throw new Error("Timeline ingestion requires Supabase service-role configuration.");
if (!args.runId || !args.workerId || !args.inventory) {
  throw new Error("Timeline ingestion requires --run-id, --worker-id, and --inventory.");
}

const inventory = JSON.parse(await readFile(resolve(args.inventory), "utf8"));
if (!Array.isArray(inventory)) throw new TypeError("Timeline inventory must be a JSON array.");
const client = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { headers: { "X-Client-Info": "returner-company-timeline-ingestion" } },
});
const totalBudgetMs = args.budgetMs ?? 180_000;
const adminBudgetMs = Math.min(45_000, Math.max(10_000, Math.floor(totalBudgetMs / 4)));
const discoveryBudgetMs = totalBudgetMs - adminBudgetMs;
// Probe the exact core coverage table before enqueuing or leasing any run-scoped
// Timeline tasks. The table is an optional migration relative to graph
// publication; all other database failures remain fatal.
const coveragePreflight = await client
  .from("timeline_source_coverage")
  .select("company_id")
  .limit(1);
if (coveragePreflight.error) {
  if (!isTimelineCoverageMigrationUnavailable(coveragePreflight.error)) {
    throw new Error(`preflight Timeline coverage persistence: ${coveragePreflight.error.message}`);
  }
  process.stdout.write(`${JSON.stringify({
    status: "migration_unavailable",
    reason: "timeline_source_coverage_unavailable",
    code: coveragePreflight.error.code ?? null,
    enqueuedTasks: 0,
    claimedTasks: 0,
  })}\n`);
} else {
  const adminTaskDrain = await runTimelineAdminTaskDrain({
    client,
    workerId: `${args.workerId}:admin`,
    companies: inventory,
    env: process.env,
    budgetMs: adminBudgetMs,
    concurrency: 8,
    perFetchTimeoutMs: 8_000,
  });
  // The admin queue is an optional, run-less maintenance lane. Its claim RPC may
  // lag the core Timeline schema without making the scheduled run-scoped lane or
  // the durable projections unavailable. Keep the two lanes independent: record
  // an unavailable admin drain, but still execute the scheduled discovery that
  // owns this run and can safely feed the normal artifact backfill.
  const receipt = await runTimelineDiscoveryIngestion({
    client,
    runId: args.runId,
    workerId: args.workerId,
    companies: inventory,
    env: process.env,
    budgetMs: discoveryBudgetMs,
    concurrency: 8,
    perFetchTimeoutMs: 8_000,
  });
  process.stdout.write(`${JSON.stringify({ ...receipt, adminTaskDrain })}\n`);
}

function parseArgs(values) {
  const parsed = { runId: null, workerId: null, inventory: null, budgetMs: undefined };
  for (const value of values) {
    if (value.startsWith("--run-id=")) parsed.runId = value.slice("--run-id=".length).trim();
    else if (value.startsWith("--worker-id=")) parsed.workerId = value.slice("--worker-id=".length).trim();
    else if (value.startsWith("--inventory=")) parsed.inventory = value.slice("--inventory=".length).trim();
    else if (value.startsWith("--budget-ms=")) {
      const budget = Number(value.slice("--budget-ms=".length));
      if (!Number.isFinite(budget) || budget < 20_000) {
        throw new TypeError("--budget-ms must be at least 20000 so admin and discovery drains each receive their 10-second minimum.");
      }
      parsed.budgetMs = Math.floor(budget);
    } else throw new TypeError(`Unknown Company Timeline ingestion argument: ${value}`);
  }
  return parsed;
}

function clean(value) {
  const normalized = value?.trim();
  return normalized || null;
}
