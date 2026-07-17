import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = path.join(process.cwd(), "supabase", "migrations");
const migrationPath = path.join(migrationsDirectory, "005_harden_public_table_access.sql");
const migrationSql = fs.readFileSync(migrationPath, "utf8");
const normalizedSql = normalizeSql(migrationSql);

const priorMigrationNames = [
  "001_initial_schema.sql",
  "002_public_ingestion_queue_and_timestamps.sql",
  "003_discovery_learning_tables.sql",
  "004_traction_scoring_evidence_lineage.sql"
];

const publicReadTables = [
  "batches",
  "companies",
  "founders",
  "company_founders",
  "industries",
  "company_industries",
  "graph_edges"
] as const;

const internalTables = [
  "social_accounts",
  "posts",
  "post_metrics",
  "platform_baselines",
  "ingestion_runs",
  "scoring_runs",
  "post_scores",
  "traction_snapshots",
  "founder_traction_snapshots",
  "ingestion_tasks",
  "source_failures",
  "platform_coverage",
  "discovery_attempts",
  "source_discovery_paths",
  "evidence_items",
  "evidence_attributions",
  "metric_observations",
  "scoring_model_versions"
] as const;

const protectedTables = [...publicReadTables, ...internalTables];

describe("database security migration", () => {
  it("classifies every public table introduced through migration 004", () => {
    const createdTables = priorMigrationNames.flatMap((migrationName) =>
      findCreatedPublicTables(fs.readFileSync(path.join(migrationsDirectory, migrationName), "utf8"))
    );

    expect(new Set(createdTables).size).toBe(createdTables.length);
    expect([...createdTables].sort()).toEqual([...protectedTables].sort());
  });

  it("enables RLS and resets API-role privileges on every exposed table", () => {
    for (const tableName of protectedTables) {
      expect(normalizedSql).toContain(
        normalizeSql(`alter table public.${tableName} enable row level security;`)
      );
      expect(normalizedSql).toContain(
        normalizeSql(`revoke all privileges on table public.${tableName} from anon, authenticated;`)
      );
      expect(normalizedSql).toContain(
        normalizeSql(`grant all privileges on table public.${tableName} to service_role;`)
      );
    }
  });

  it("recreates read-only access only for the intentional public graph model", () => {
    expect(migrationSql).toMatch(/intentionally remain publicly readable/i);
    expect(normalizedSql).not.toContain("from pg_policies");

    for (const tableName of publicReadTables) {
      const dropPolicy = normalizeSql(`drop policy if exists public_read on public.${tableName};`);
      const createPolicy = normalizeSql(
        `create policy public_read on public.${tableName} for select to anon, authenticated using (true);`
      );

      expect(normalizedSql).toContain(
        normalizeSql(`grant select on table public.${tableName} to anon, authenticated;`)
      );
      expect(findTableGrants(migrationSql, tableName)).toEqual([
        "select to anon, authenticated",
        "all privileges to service_role"
      ]);
      expect(normalizedSql).toContain(dropPolicy);
      expect(normalizedSql).toContain(createPolicy);
      expect(normalizedSql.indexOf(dropPolicy)).toBeLessThan(normalizedSql.indexOf(createPolicy));
    }

    for (const tableName of internalTables) {
      expect(findTableGrants(migrationSql, tableName)).toEqual(["all privileges to service_role"]);
      expect(normalizedSql).not.toContain(
        normalizeSql(`create policy public_read on public.${tableName}`)
      );
    }
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function findCreatedPublicTables(sql: string): string[] {
  return Array.from(
    sql.matchAll(/create\s+table(?:\s+if\s+not\s+exists)?\s+public\.([a-z_][a-z0-9_]*)/gi),
    (match) => match[1].toLowerCase()
  );
}

function findTableGrants(sql: string, tableName: string): string[] {
  const grantPattern = new RegExp(
    `grant\\s+([^;]+?)\\s+on\\s+table\\s+public\\.${tableName}\\s+to\\s+([^;]+);`,
    "gi"
  );

  return Array.from(sql.matchAll(grantPattern), (match) => {
    return `${normalizeSql(match[1])} to ${normalizeSql(match[2])}`;
  });
}
