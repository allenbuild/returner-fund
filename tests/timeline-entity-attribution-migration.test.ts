import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(join(
  process.cwd(),
  "supabase",
  "migrations",
  "020_timeline_entity_attribution_invariants.sql",
), "utf8");
const normalized = migration.replace(/\s+/g, " ").toLowerCase();

describe("timeline entity-attribution invariants", () => {
  it("guards every source-evidence attachment, including admin RPC inserts", () => {
    expect(normalized).toContain("create trigger timeline_event_evidence_company_subject_guard");
    expect(normalized).toContain("before insert or update of event_id, source_document_id on public.timeline_event_evidence");
    expect(normalized).toContain("subject.company_id = target_company_id");
    expect(normalized).toContain("subject.relationship_type = 'subject'");
    expect(normalized).toContain("subject.founder_id is null");
    expect(normalized).toContain("enforced for ingestion and admin attachments");
  });

  it("fails closed on legacy mismatches and independently filters the public projection", () => {
    expect(normalized).toContain("do $existing_timeline_entity_attribution$");
    expect(normalized).toContain("existing timeline event % must have exactly one primary subject entity for company %");
    expect(normalized).toContain("having count(entity.id) filter (where entity.is_primary) <> 1");
    expect(normalized).toContain("existing timeline event % links source document % without same-company subject attribution");
    const publicView = normalized.match(
      /create or replace view public\.published_timeline_source_metadata([\s\S]*?)revoke all privileges/,
    )?.[1];
    expect(publicView).toBeDefined();
    expect(publicView).toContain("join public.source_document_entities as subject");
    expect(publicView).toContain("subject.company_id = event.primary_company_id");
    expect(publicView).toContain("subject.relationship_type = 'subject'");
  });

  it("enforces exactly one matching primary subject entity for every event", () => {
    const primaryAssertion = normalized.match(
      /create or replace function public\.assert_timeline_event_primary_entity_company([\s\S]*?)-- fail the migration closed/,
    )?.[1];
    expect(primaryAssertion).toBeDefined();
    expect(primaryAssertion).toContain("count(*) filter (where entity.is_primary)");
    expect(primaryAssertion).toContain("primary_entity_count <> 1 or matching_primary_entity_count <> 1");
    expect(normalized).toContain("create unique index if not exists timeline_event_entities_one_primary_idx on public.timeline_event_entities (event_id) where is_primary");
    expect(normalized).toContain("create trigger timeline_events_seed_primary_entity after insert on public.timeline_events");
    expect(normalized).toContain("for each row execute function public.seed_timeline_event_primary_entity()");
    expect(normalized).toContain("new.id, 'company', new.primary_company_id, null, null, 'subject', true");
    expect(normalized).toContain("create constraint trigger timeline_events_primary_entity_required");
    expect(normalized).toContain("after insert or update of primary_company_id on public.timeline_events deferrable initially deferred");
    expect(normalized).toContain("revalidate_timeline_primary_entity_after_event_mutation");
  });

  it("binds publication to same-company exact-claim evidence", () => {
    const predicate = normalized.match(
      /create or replace function public\.timeline_event_has_publishable_company_evidence([\s\S]*?)create or replace function public\.guard_timeline_event_publication/,
    )?.[1];
    expect(predicate).toBeDefined();
    expect(predicate).toContain("subject.company_id = target_company_id");
    expect(predicate).toContain("evidence.source_event_date = target_event_date");
    expect(predicate).toContain("trim(coalesce(evidence.extracted_claims ->> 'title', '')) = trim(target_title)");
    expect(predicate).toContain("trim(coalesce(evidence.extracted_claims ->> 'summary', '')) = trim(target_summary)");
    expect(normalized).toContain("before insert or update of status, published_at, title, summary, event_date, event_date_type, category, primary_company_id");
  });

  it("revalidates both sides of source and canonical-evidence rekeys", () => {
    const sourceRevalidation = normalized.match(
      /create or replace function public\.revalidate_timeline_evidence_after_subject_mutation\(\)([\s\S]*?)drop trigger if exists timeline_evidence_revalidate_subject_attribution/,
    )?.[1];
    expect(sourceRevalidation).toContain("array[old.source_document_id, new.source_document_id]");
    expect(normalized).toContain("after delete or update of source_document_id, company_id, founder_id, relationship_type on public.source_document_entities");

    const postRevalidation = normalized.match(
      /create or replace function public\.revalidate_timeline_posts_after_attribution_mutation\(\)([\s\S]*?)drop trigger if exists timeline_event_posts_revalidate_attribution/,
    )?.[1];
    expect(postRevalidation).toContain("array[old.evidence_id, new.evidence_id]");
    expect(postRevalidation).toContain("where post.evidence_id = affected_evidence_id");
    expect(normalized).toContain("after delete or update of evidence_id, company_id, entity_type, review_state on public.evidence_attributions");
  });

  it("blocks primary-company changes unless every source and post already matches the new company", () => {
    const companyGuard = normalized.match(
      /create or replace function public\.guard_timeline_event_primary_company_change\(\)([\s\S]*?)drop trigger if exists timeline_events_primary_company_attribution_guard/,
    )?.[1];
    expect(companyGuard).toContain("new.primary_company_id");
    expect(companyGuard).toContain("from public.timeline_event_evidence as evidence");
    expect(companyGuard).toContain("from public.timeline_event_posts as post");
    expect(companyGuard).toContain("assert_timeline_event_primary_entity_company");
    expect(companyGuard).toContain("assert_timeline_source_company_subject");
    expect(companyGuard).toContain("assert_timeline_post_company_attribution_for_company");
    expect(normalized).toContain("before update of primary_company_id on public.timeline_events");
    expect(normalized).toContain("create constraint trigger timeline_event_entities_primary_company_guard");
    expect(normalized).toContain("after insert or delete or update of event_id, entity_type, company_id, founder_id, external_entity_name, relationship_type, is_primary on public.timeline_event_entities");
    expect(normalized).toContain("entity.company_id = target_company_id");
    expect(normalized).toContain("entity.relationship_type = 'subject'");
  });

  it("provides an atomic service-only primary-company reassignment path", () => {
    const reassignment = normalized.match(
      /create or replace function public\.reassign_timeline_event_primary_company([\s\S]*?)-- centralize the exact-date/,
    )?.[1];
    expect(reassignment).toBeDefined();
    if (!reassignment) throw new Error("Expected primary-company reassignment function.");
    expect(reassignment).toContain("set constraints timeline_event_entities_primary_company_guard deferred");
    expect(reassignment).toContain("set constraints timeline_event_entities_primary_company_guard immediate");
    expect(reassignment).toContain("updated_primary_rows <> 1");
    expect(reassignment.indexOf("update public.timeline_event_entities")).toBeLessThan(
      reassignment.indexOf("update public.timeline_events"),
    );
    expect(normalized).toContain("revoke all privileges on function public.reassign_timeline_event_primary_company(uuid, uuid) from public, anon, authenticated");
    expect(normalized).toContain("grant execute on function public.reassign_timeline_event_primary_company(uuid, uuid) to service_role");
    expect(normalized).toContain("after destination source/post attributions are prepared; service role only");
  });
});
