import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  Database,
  EntityType,
  IngestionTaskStatus,
  Json,
  JsonObject,
  TableInsert,
  TableRow
} from "@/types/database";

const operationalTables = [
  "ingestion_runs",
  "ingestion_tasks",
  "source_failures",
  "platform_coverage",
  "discovery_attempts",
  "source_discovery_paths",
  "evidence_items",
  "evidence_attributions",
  "metric_observations",
  "ingestion_runtime_locks",
  "ingestion_run_events",
  "ingestion_checkpoints",
  "provider_rate_limits",
  "ingestion_dead_letters",
  "ingestion_coverage_reports",
  "ingestion_artifact_manifests"
] as const satisfies readonly (keyof Database["public"]["Tables"])[];

type Functions = Database["public"]["Functions"];

describe("autonomous database types", () => {
  it("exposes every operational table added by migrations 002, 003, 004, and 008", () => {
    expect(operationalTables).toHaveLength(16);
  });

  it("types expanded ingestion runs and tasks", () => {
    expectTypeOf<Pick<TableRow<"companies">, "source_key">>().toEqualTypeOf<{
      source_key: string | null;
    }>();
    expectTypeOf<Pick<TableRow<"founders">, "source_key">>().toEqualTypeOf<{
      source_key: string | null;
    }>();
    expectTypeOf<Pick<TableRow<"social_accounts">, "source_key">>().toEqualTypeOf<{
      source_key: string | null;
    }>();

    expectTypeOf<
      Pick<
        TableRow<"ingestion_runs">,
        | "idempotency_key"
        | "heartbeat_at"
        | "lease_owner"
        | "lease_token"
        | "lease_expires_at"
        | "stats_json"
      >
    >().toEqualTypeOf<{
      idempotency_key: string | null;
      heartbeat_at: string | null;
      lease_owner: string | null;
      lease_token: string | null;
      lease_expires_at: string | null;
      stats_json: JsonObject;
    }>();

    expectTypeOf<
      Pick<
        TableRow<"ingestion_tasks">,
        | "entity_type"
        | "status"
        | "attempts"
        | "max_attempts"
        | "next_attempt_at"
        | "lease_token"
        | "terminal_at"
        | "last_error_json"
      >
    >().toEqualTypeOf<{
      entity_type: EntityType;
      status: IngestionTaskStatus;
      attempts: number;
      max_attempts: number;
      next_attempt_at: string | null;
      lease_token: string | null;
      terminal_at: string | null;
      last_error_json: JsonObject;
    }>();

    expectTypeOf<
      Pick<
        TableInsert<"ingestion_tasks">,
        "entity_type" | "company_name" | "platform" | "checkpoint_key" | "max_attempts"
      >
    >().toEqualTypeOf<{
      entity_type: EntityType;
      company_name: string;
      platform: string;
      checkpoint_key: string;
      max_attempts?: number;
    }>();
  });

  it("types runtime lock and task RPC signatures", () => {
    expectTypeOf<Functions["claim_ingestion_runtime_lock"]["Args"]>().toEqualTypeOf<{
      p_lock_key: string;
      p_owner_id: string;
      p_lease_duration?: string;
      p_metadata_json?: Json;
    }>();
    expectTypeOf<Functions["claim_ingestion_runtime_lock"]["Returns"]>().toEqualTypeOf<
      TableRow<"ingestion_runtime_locks">[]
    >();

    expectTypeOf<Functions["renew_ingestion_runtime_lock"]["Returns"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Functions["release_ingestion_runtime_lock"]["Returns"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Functions["finalize_completed_ingestion_run"]["Returns"]>().toEqualTypeOf<
      TableRow<"ingestion_runs">[]
    >();
    expectTypeOf<Functions["renew_ingestion_task_lease"]["Returns"]>().toEqualTypeOf<boolean>();

    expectTypeOf<Functions["claim_ingestion_tasks"]["Args"]>().toEqualTypeOf<{
      p_worker_id: string;
      p_limit?: number;
      p_lease_duration?: string;
      p_ingestion_run_id?: string | null;
      p_platform?: string | null;
    }>();
    expectTypeOf<Functions["claim_ingestion_tasks"]["Returns"]>().toEqualTypeOf<
      TableRow<"ingestion_tasks">[]
    >();
    expectTypeOf<Functions["claim_timeline_admin_tasks"]["Args"]>().toEqualTypeOf<{
      p_worker_id: string;
      p_limit?: number;
      p_lease_duration?: string;
      p_source_class?: string | null;
    }>();
    expectTypeOf<Functions["claim_timeline_admin_tasks"]["Returns"]>().toEqualTypeOf<
      TableRow<"ingestion_tasks">[]
    >();
    expectTypeOf<Functions["requeue_expired_ingestion_tasks"]["Args"]>().toEqualTypeOf<{
      p_limit?: number;
    }>();
    expectTypeOf<Functions["requeue_expired_ingestion_tasks"]["Returns"]>().toEqualTypeOf<
      TableRow<"ingestion_tasks">[]
    >();
  });
});
