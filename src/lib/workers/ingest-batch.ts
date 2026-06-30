import { buildDemoGraph, normalizeBatchSlug } from "./demo-ingest";
import { createRunStore, isSupabaseConfigured } from "./run-store";
import type { IngestBatchRequest, IngestBatchResponse } from "./types";

export async function runIngestBatch(request: IngestBatchRequest): Promise<IngestBatchResponse> {
  const batchSlug = normalizeBatchSlug(request.batchSlug);
  const mode = shouldUseDemoMode(request) ? "demo" : "database";
  const store = createRunStore(mode);
  const errors: string[] = [];
  const run = await store.createRun({ batchSlug, mode });
  const logs = [...run.logs];

  const log = async (message: string) => {
    logs.push(message);
    await store.appendLog(run.runId, message);
  };

  try {
    await log(`Normalized batch slug to ${batchSlug}.`);
    await log("Manual refresh only: no schedule or autonomous scraper was created.");
    await log("Read-only policy active: connector pipeline has no mutation actions.");

    if (mode === "database") {
      await log("Database mode requested.");
      if (!isSupabaseConfigured()) {
        await log("Supabase environment variables are missing, so durable database persistence is unavailable.");
        errors.push("Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or run with options.demo=true.");
      } else {
        await log("Supabase run hooks are configured.");
        errors.push("Real database ingestion is intentionally blocked until YC and connector agents provide adapters.");
      }
      await log("YC adapters and social connectors are not wired in this worker slice yet.");
      await store.completeRun(run.runId, "failed", errors);
      return { runId: run.runId, status: "failed", logs, errors };
    }

    await log("Demo mode selected: using deterministic seed companies, founders, evidence, scores, and graph edges.");

    if (request.options?.refreshProfiles) {
      await log("refreshProfiles=true: demo identity candidates and needs-review examples were rebuilt.");
    }

    if (request.options?.refreshPosts) {
      await log("refreshPosts=true: demo evidence posts and metrics were refreshed.");
    }

    if (request.options?.platforms?.length) {
      await log(`Platform filter requested: ${request.options.platforms.join(", ")}.`);
    }

    const graph = buildDemoGraph({ ...request, batchSlug });
    await log(`Built demo graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges.`);
    await log(`Created ${graph.leaderboard.length} leaderboard rows and ${graph.fastestGaining.length} fastest-gaining rows.`);
    await store.completeRun(run.runId, "completed", []);

    return {
      runId: run.runId,
      status: "completed",
      logs,
      errors,
      graph
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown ingest pipeline error.";
    errors.push(message);
    logs.push(`Pipeline failed: ${message}`);
    await store.completeRun(run.runId, "failed", errors);
    return { runId: run.runId, status: "failed", logs, errors };
  }
}

function shouldUseDemoMode(request: IngestBatchRequest): boolean {
  if (request.options?.demo === true) {
    return true;
  }

  if (request.options?.demo === false) {
    return false;
  }

  return process.env.NEXT_PUBLIC_APP_MODE !== "database" || !isSupabaseConfigured();
}
