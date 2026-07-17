import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  EvidenceAttributionInsert,
  EvidenceItemInsert,
  JsonObject,
  MetricObservationInsert,
  ScoringModelVersionInsert,
  ScoringRunInsert,
  TableName,
  Timestamp
} from "@/types/database";

const migrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "004_traction_scoring_evidence_lineage.sql"
);
const migrationSql = fs.readFileSync(migrationPath, "utf8");
const normalizedSql = migrationSql.replace(/\s+/g, " ").trim().toLowerCase();

describe("traction scoring database migration", () => {
  it("remains strictly additive", () => {
    const destructiveStatements = migrationSql
      .split(";")
      .map((statement) => statement.replace(/--.*$/gm, "").trim().toLowerCase())
      .filter(
        (statement) =>
          /^(drop|truncate|delete|update)\b/.test(statement) ||
          (/^alter\s+table\b/.test(statement) && /\b(drop|rename)\b/.test(statement))
      );

    expect(destructiveStatements).toEqual([]);
  });

  it("defines canonical evidence, attribution, and observation lineage", () => {
    const tableNames: TableName[] = [
      "evidence_items",
      "evidence_attributions",
      "metric_observations",
      "scoring_model_versions"
    ];

    for (const tableName of tableNames) {
      expect(normalizedSql).toContain(`create table if not exists public.${tableName}`);
    }

    expect(normalizedSql).toContain("evidence_items_platform_canonical_key");
    expect(normalizedSql).toContain("evidence_attributions_target_check");
    expect(normalizedSql).toContain("evidence_attributions_score_eligible_check");
    expect(normalizedSql).toContain("metric_observations_identity_key");
    expect(normalizedSql).toContain("metric_observations_evidence_metric_observed_idx");
  });

  it("links versioned models to runs and run-scoped snapshots", () => {
    expect(normalizedSql).toContain("alter table public.scoring_runs");
    expect(normalizedSql).toContain("scoring_model_version_id uuid");
    expect(normalizedSql).toContain("input_observed_through timestamptz");
    expect(normalizedSql).toContain("scoring_runs_versioned_fields_together_check");
    expect(normalizedSql).toContain("alter table public.traction_snapshots");
    expect(normalizedSql).toContain("alter table public.founder_traction_snapshots");
    expect(normalizedSql).toContain("traction_snapshots_run_company_key");
    expect(normalizedSql).toContain("founder_traction_snapshots_run_founder_key");
  });

  it("requires reproducible provenance at completion and preserves it afterward", () => {
    expect(normalizedSql).toContain(
      "create or replace function public.enforce_completed_scoring_run_provenance()"
    );
    expect(normalizedSql).toContain("completed scoring run provenance is immutable");
    expect(normalizedSql).toContain(
      "completed scoring runs require model, as-of, input cutoff, input fingerprint, and run key"
    );
    expect(normalizedSql).toContain("before insert or update on public.scoring_runs");
    expect(normalizedSql).toContain("scoring_runs_completed_provenance_guard");

    for (const field of [
      "scoring_model_version_id",
      "as_of_at",
      "input_observed_through",
      "input_fingerprint",
      "run_key"
    ]) {
      expect(normalizedSql).toContain(`new.${field} is null`);
    }
  });

  it("protects a completed run from model-definition drift", () => {
    expect(normalizedSql).toContain(
      "create or replace function public.prevent_completed_scoring_model_version_rewrite()"
    );
    expect(normalizedSql).toContain("where scoring_model_version_id = old.id and status = 'completed'");
    expect(normalizedSql).toContain(
      "scoring model version used by a completed run is immutable"
    );
    expect(normalizedSql).toContain("before update on public.scoring_model_versions");
    expect(normalizedSql).toContain("scoring_model_versions_completed_run_guard");
  });

  it("guards named constraints and triggers so the additive migration can be replayed", () => {
    for (const constraint of [
      "scoring_runs_versioned_fields_together_check",
      "scoring_runs_observation_cutoff_check",
      "scoring_runs_input_fingerprint_not_blank",
      "scoring_runs_run_key_not_blank",
      "traction_snapshots_rank_positive",
      "traction_snapshots_evidence_count_nonnegative",
      "founder_traction_snapshots_rank_positive",
      "founder_traction_snapshots_evidence_count_nonnegative"
    ]) {
      expect(normalizedSql).toContain(`where conname = '${constraint}'`);
    }

    for (const trigger of [
      "evidence_items_set_updated_at",
      "evidence_attributions_set_updated_at",
      "scoring_runs_completed_provenance_guard",
      "scoring_model_versions_completed_run_guard"
    ]) {
      expect(normalizedSql).toContain("select 1 from pg_trigger");
      expect(normalizedSql).toContain(`where tgname = '${trigger}'`);
    }
  });

  it("exposes inserts for the new hand-maintained database contract", () => {
    const evidence: EvidenceItemInsert = {
      platform: "github",
      evidence_kind: "repository",
      canonical_key: "github:repository:openai/codex"
    };
    const attribution: EvidenceAttributionInsert = {
      evidence_id: "00000000-0000-0000-0000-000000000001",
      entity_type: "company",
      company_id: "00000000-0000-0000-0000-000000000002",
      match_reason: "Verified organization repository."
    };
    const observation: MetricObservationInsert = {
      evidence_id: evidence.id ?? "00000000-0000-0000-0000-000000000001",
      metric_name: "stars",
      metric_value: 1,
      observed_at: "2026-07-16T00:00:00.000Z",
      source_name: "github_api"
    };

    expect([evidence.evidence_kind, attribution.entity_type, observation.metric_name]).toEqual([
      "repository",
      "company",
      "stars"
    ]);
  });

  it("reflects object-constrained JSON and timestamp columns in the database contract", () => {
    const asOf: Timestamp = "2026-07-16T00:00:00.000Z";
    const modelConfig: JsonObject = { version: 4, weights: { github: 0.15 } };
    const model: ScoringModelVersionInsert = {
      model_key: "returner-traction",
      version: "4.0.0",
      config_hash: "a".repeat(64),
      config_json: modelConfig
    };
    const completedRun: ScoringRunInsert = {
      status: "completed",
      scoring_model_version_id: "00000000-0000-0000-0000-000000000010",
      as_of_at: asOf,
      input_observed_through: asOf,
      input_fingerprint: "sha256:inputs",
      run_key: "returner-traction:4.0.0:2026-07-16"
    };

    const invalidModel: ScoringModelVersionInsert = {
      model_key: "returner-traction",
      version: "4.0.0",
      config_hash: "b".repeat(64),
      // @ts-expect-error SQL constrains scoring model config_json to a JSON object.
      config_json: "not-an-object"
    };

    expect([model.config_json, completedRun.as_of_at, invalidModel.version]).toEqual([
      modelConfig,
      asOf,
      "4.0.0"
    ]);
  });
});
