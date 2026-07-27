import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TRACTION_SCORING_CONFIG } from "@/lib/scoring/traction-config";

const migrationsDirectory = path.join(process.cwd(), "supabase", "migrations");
const migrationSql = fs.readFileSync(
  path.join(migrationsDirectory, "007_register_traction_scoring_v4.sql"),
  "utf8"
);
const priorMigrationSql = fs
  .readdirSync(migrationsDirectory)
  .filter((fileName) => /^(?:00[1-6])_.*\.sql$/.test(fileName))
  .map((fileName) => fs.readFileSync(path.join(migrationsDirectory, fileName), "utf8"))
  .join("\n");
const normalizedSql = migrationSql.replace(/\s+/g, " ").trim().toLowerCase();
const legacyV4Config = {
  ...TRACTION_SCORING_CONFIG,
  version: "4.0.0",
  name: "returner-traction-v4-canonical",
  absoluteEvidenceWeight: 0.85,
  cohortPercentileWeight: 0.15
};

describe("traction scoring v4 model registration migration", () => {
  it("keeps the immutable 4.0.0 identity, config, and SHA-256", () => {
    const embeddedConfig = extractEmbeddedConfig(migrationSql);
    const embeddedHash = extractTextConstant(migrationSql, "v4_config_hash");

    expect(extractTextConstant(migrationSql, "v4_model_key")).toBe(
      legacyV4Config.modelId
    );
    expect(extractTextConstant(migrationSql, "v4_version")).toBe(
      legacyV4Config.version
    );
    expect(embeddedConfig).toEqual(legacyV4Config);
    expect(embeddedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(embeddedHash).toBe(sha256(canonicalJson(embeddedConfig)));
  });

  it("is rerunnable and rejects an existing version with config drift", () => {
    expect(normalizedSql).toContain("on conflict (model_key, version) do nothing");
    expect(normalizedSql).toContain("stored_hash is distinct from v4_config_hash");
    expect(normalizedSql).toContain("stored_config is distinct from v4_config");
    expect(normalizedSql).toContain("using errcode = '23514'");
    expect(normalizedSql).toContain(
      "create index if not exists scoring_runs_model_batch_as_of_idx"
    );
  });

  it("adds only the missing model-and-batch ordered history index", () => {
    const indexStatements = migrationSql.match(/create\s+(?:unique\s+)?index\b/gi) ?? [];

    expect(indexStatements).toHaveLength(1);
    expect(normalizedSql).toContain(
      "on public.scoring_runs ( scoring_model_version_id, batch_id, as_of_at desc, started_at desc )"
    );
    expect(priorMigrationSql.toLowerCase()).not.toContain(
      "scoring_runs_model_batch_as_of_idx"
    );
    expect(normalizedSql).not.toContain("metric_observations_evidence_metric_observed_idx");
    expect(normalizedSql).toContain(
      "where scoring_model_version_id is not null and batch_id is not null;"
    );
    expect(normalizedSql).not.toContain("and as_of_at is not null;");
  });

  it("does not rewrite schema objects or existing data", () => {
    const withoutComments = migrationSql.replace(/--.*$/gm, "").toLowerCase();

    expect(withoutComments).not.toMatch(
      /\b(?:drop|truncate|delete|update)\b|alter\s+table|create\s+table/
    );
    expect(normalizedSql).not.toContain("on conflict (model_key, version) do update");
  });
});

function extractEmbeddedConfig(sql: string): unknown {
  const match = sql.match(/v4_config\s+constant\s+jsonb\s*:=\s*\$config\$([\s\S]*?)\$config\$::jsonb;/i);
  if (!match?.[1]) {
    throw new Error("Migration does not contain the v4 JSON config constant.");
  }
  return JSON.parse(match[1]);
}

function extractTextConstant(sql: string, name: string): string {
  const match = sql.match(new RegExp(`${name}\\s+constant\\s+text\\s*:=\\s*'([^']+)'`, "i"));
  if (!match?.[1]) {
    throw new Error(`Migration does not contain ${name}.`);
  }
  return match[1];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Canonical scoring config cannot contain undefined values.");
  }
  return serialized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
