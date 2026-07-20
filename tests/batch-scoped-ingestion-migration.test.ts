import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "009_batch_scoped_ingestion_attribution.sql"),
  "utf8"
);

describe("batch-scoped ingestion attribution migration", () => {
  it("adds cohort identity to evidence attribution uniqueness", () => {
    expect(migration).toMatch(/alter table public\.evidence_attributions[\s\S]*add column if not exists batch_id uuid/i);
    expect(migration).toMatch(/evidence_attributions_company_type_key[\s\S]*coalesce\(batch_id/i);
    expect(migration).toMatch(/evidence_attributions_founder_type_key[\s\S]*coalesce\(batch_id/i);
    expect(migration).toMatch(/evidence_attributions_primary_entity_type_key[\s\S]*coalesce\(batch_id/i);
  });

  it("models account ownership as a batch-scoped, safely retired association", () => {
    expect(migration).toMatch(/create table if not exists public\.social_account_owners/i);
    expect(migration).toMatch(/social_account_id uuid not null references public\.social_accounts/i);
    expect(migration).toMatch(/batch_id uuid not null references public\.batches/i);
    expect(migration).toMatch(/owner_key text not null unique/i);
    expect(migration).toMatch(/retired_at timestamptz/i);
    expect(migration).toMatch(/retirement_reason text/i);
    expect(migration).toMatch(/review_state = 'rejected'/i);
    expect(migration).not.toMatch(/delete\s+from\s+public\.social_account_owners/i);
  });

  it("keeps the internal mapping service-role only", () => {
    expect(migration).toMatch(/alter table public\.social_account_owners enable row level security/i);
    expect(migration).toMatch(/revoke all privileges on table public\.social_account_owners from anon, authenticated/i);
    expect(migration).toMatch(/grant all privileges on table public\.social_account_owners to service_role/i);
  });
});
