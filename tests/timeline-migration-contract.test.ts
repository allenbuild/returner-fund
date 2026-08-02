import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "017_company_timeline.sql"),
  "utf8",
);

describe("company timeline migration contract", () => {
  it("defines the normalized timeline tables and safe public projections", () => {
    for (const table of [
      "source_documents",
      "source_document_entities",
      "timeline_events",
      "timeline_event_entities",
      "timeline_event_evidence",
      "timeline_event_posts",
      "timeline_event_candidates",
      "timeline_candidate_sources",
      "timeline_company_state",
      "timeline_source_coverage",
      "timeline_event_audit",
      "timeline_artifact_invalidations",
    ]) {
      expect(migration).toContain(`create table if not exists public.${table}`);
    }
    expect(migration).toContain("create or replace view public.published_timeline_events");
    expect(migration).toContain("create or replace view public.published_timeline_source_metadata");
  });

  it("guards every publication-relevant update with direct verified evidence", () => {
    expect(migration.match(/create or replace function public\.guard_timeline_event_publication\(\)[\s\S]*?\$\$;/)?.[0])
      .toMatch(/returns trigger\s+language plpgsql\s+security invoker/);
    expect(migration).toMatch(/before insert or update of status, published_at, title, summary, event_date, event_date_type, category/);
    expect(migration).toMatch(/supports_event_date[\s\S]*supports_title[\s\S]*supports_summary[\s\S]*attribution_status = 'verified'/);
    expect(migration).not.toMatch(/language plpgsql\s+language plpgsql/);
  });

  it("revalidates published events when evidence or source verification changes", () => {
    expect(migration).toContain("function public.assert_published_timeline_event_has_evidence(target_event_id uuid)");
    expect(migration).toMatch(/timeline_event_evidence_revalidate_publication[\s\S]*after delete or update of event_id, source_document_id, evidence_role,[\s\S]*supports_event_date, supports_title, supports_summary, is_conflicting/);
    expect(migration).toMatch(/source_documents_revalidate_timeline_publication[\s\S]*after update of attribution_status, canonical_url/);
    expect(migration).toMatch(/published timeline event % must retain verified direct evidence/);
  });

  it("requires conflicting role and conflict state to agree in both directions", () => {
    expect(migration).toMatch(/is_conflicting and evidence_role = 'conflicting'/);
    expect(migration).toMatch(/not is_conflicting and evidence_role <> 'conflicting' and conflict_description is null/);
  });

  it("permits company-only audit rows but forbids ambiguous dual targets", () => {
    expect(migration).toMatch(
      /timeline_event_audit_target_check check \(not \(event_id is not null and candidate_id is not null\)\)/,
    );
  });

  it("enforces append-only audit history and grants only insert/select", () => {
    expect(migration).toMatch(/timeline_event_audit_log_immutable[\s\S]*before update or delete on public\.timeline_event_audit_log/);
    expect(migration).toContain("raise exception 'timeline_event_audit_log is append-only'");
    expect(migration).toContain("grant select, insert on table public.timeline_event_audit_log to service_role");
    expect(migration).not.toContain("grant all privileges on table public.timeline_event_audit_log to service_role");
  });

  it("does not grant anonymous reads on the internal timeline event table", () => {
    expect(migration).not.toMatch(/grant\s+select\s+on\s+(?:table\s+)?public\.timeline_events\s+to\s+(?:anon|public)/i);
    expect(migration).toMatch(/alter table public\.timeline_events enable row level security/);
  });
});
