import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/012_weighted_insider_registry.sql"),
  "utf8"
);

describe("weighted Insider registry migration", () => {
  it("is idempotent and merges the historical Johnston misspelling", () => {
    expect(migration).toContain("create table if not exists public.insider_registry");
    expect(migration).toContain("on conflict (person_id) do update");
    expect(migration).toContain("delete from public.insider_registry where person_id = 'phillip-johnston'");
    expect(migration).toContain("'philip-johnston','Philip Johnston'");
    expect(migration).toContain('"Phillip Johnston"');
  });

  it("enforces integer weights 1 through 5 in storage and the atomic save RPC", () => {
    expect(migration).toContain("weight between 1 and 5");
    expect(migration).toContain("not between 1 and 5");
    expect(migration).toContain("<> trunc");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("version = version + 1");
  });
});
