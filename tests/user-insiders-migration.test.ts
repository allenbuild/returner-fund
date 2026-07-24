import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("user Insiders migration", () => {
  const sql = readFileSync("supabase/migrations/011_user_insider_configurations.sql", "utf8");

  it("keeps rows private and binds access to auth.uid()", () => {
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/auth\.uid\(\).*user_id/is);
    expect(sql).toMatch(/revoke all.*anon/is);
    expect(sql).toMatch(/references auth\.users\(id\).*on delete cascade/is);
  });

  it("performs a version-checked atomic save", () => {
    expect(sql).toMatch(/for update/i);
    expect(sql).toMatch(/version <> p_expected_version/i);
    expect(sql).toMatch(/version = version \+ 1/i);
    expect(sql).toMatch(/40001/);
  });
});
