import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { batchLabel } from "./demo-ingest";
import type { IngestRunRecord, IngestRunStatus } from "./types";

interface CreateRunInput {
  batchSlug: string;
  mode: "demo" | "database";
}

export interface IngestRunStore {
  createRun(input: CreateRunInput): Promise<IngestRunRecord>;
  appendLog(runId: string, message: string): Promise<void>;
  completeRun(runId: string, status: Extract<IngestRunStatus, "completed" | "failed">, errors: string[]): Promise<void>;
}

export function isSupabaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createRunStore(mode: "demo" | "database"): IngestRunStore {
  if (mode === "database" && isSupabaseConfigured()) {
    return new SupabaseRunStore();
  }

  return new MemoryRunStore();
}

class MemoryRunStore implements IngestRunStore {
  private readonly runs = new Map<string, IngestRunRecord>();

  async createRun(input: CreateRunInput): Promise<IngestRunRecord> {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const run: IngestRunRecord = {
      runId,
      batchSlug: input.batchSlug,
      mode: input.mode,
      logs: [`Created ${input.mode} ingestion run for ${input.batchSlug}.`]
    };
    this.runs.set(runId, run);
    return run;
  }

  async appendLog(runId: string, message: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.logs.push(message);
    }
  }

  async completeRun(
    runId: string,
    status: Extract<IngestRunStatus, "completed" | "failed">,
    errors: string[]
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.logs.push(`Run ${status}${errors.length ? ` with ${errors.length} error(s)` : ""}.`);
    }
  }
}

class SupabaseRunStore implements IngestRunStore {
  private readonly client: SupabaseClient;
  private readonly logsByRunId = new Map<string, string[]>();

  constructor() {
    this.client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
      auth: { persistSession: false }
    });
  }

  async createRun(input: CreateRunInput): Promise<IngestRunRecord> {
    const batch = await this.upsertBatch(input.batchSlug);
    const startedLog = `Created ${input.mode} ingestion run for ${input.batchSlug}.`;

    const { data, error } = await this.client
      .from("ingestion_runs")
      .insert({
        batch_id: batch.id,
        status: "running",
        started_at: new Date().toISOString(),
        logs: [startedLog],
        errors_json: []
      })
      .select("id")
      .single();

    if (error) {
      throw new Error(`Failed to create ingestion_run in Supabase: ${error.message}`);
    }

    const runId = String(data.id);
    this.logsByRunId.set(runId, [startedLog]);
    return { runId, batchSlug: input.batchSlug, mode: input.mode, logs: [startedLog] };
  }

  async appendLog(runId: string, message: string): Promise<void> {
    const logs = [...(this.logsByRunId.get(runId) ?? []), message];
    this.logsByRunId.set(runId, logs);
    await this.client.from("ingestion_runs").update({ logs }).eq("id", runId);
  }

  async completeRun(
    runId: string,
    status: Extract<IngestRunStatus, "completed" | "failed">,
    errors: string[]
  ): Promise<void> {
    const logs = [...(this.logsByRunId.get(runId) ?? []), `Run ${status}.`];
    this.logsByRunId.set(runId, logs);
    await this.client
      .from("ingestion_runs")
      .update({
        status,
        finished_at: new Date().toISOString(),
        logs,
        errors_json: errors
      })
      .eq("id", runId);
  }

  private async upsertBatch(slug: string): Promise<{ id: string }> {
    const { data, error } = await this.client
      .from("batches")
      .upsert(
        {
          slug,
          label: batchLabel(slug),
          updated_at: new Date().toISOString()
        },
        { onConflict: "slug" }
      )
      .select("id")
      .single();

    if (error) {
      throw new Error(`Failed to upsert batch in Supabase: ${error.message}`);
    }

    return { id: String(data.id) };
  }
}
