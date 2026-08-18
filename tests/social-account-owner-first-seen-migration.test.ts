import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "027_social_account_owner_first_seen.sql"
  ),
  "utf8"
);

const normalizedMigration = migration.replace(/\s+/g, " ").trim().toLowerCase();

describe("social account owner first_seen migration", () => {
  it("preserves the earliest first_seen_at across repeated owner upserts", () => {
    expect(normalizedMigration).toContain(
      "create or replace function public.preserve_social_account_owner_first_seen_at()"
    );
    expect(normalizedMigration).toContain(
      "new.first_seen_at := least(old.first_seen_at, new.first_seen_at)"
    );
    expect(normalizedMigration).toContain(
      "drop trigger if exists social_account_owners_preserve_first_seen_at on public.social_account_owners"
    );
    expect(normalizedMigration).toContain(
      "create trigger social_account_owners_preserve_first_seen_at before update on public.social_account_owners"
    );
    expect(normalizedMigration).toContain(
      "for each row execute function public.preserve_social_account_owner_first_seen_at()"
    );
  });
});
