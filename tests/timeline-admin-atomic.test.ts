import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyTimelineAdminCandidateAction,
  applyTimelineAdminCompanyAction,
  applyTimelineAdminEventAction,
} from "@/lib/timeline/store";
import { readTimelineAdminActionRequest } from "@/lib/timeline/admin-http";

const RPC_RESULT = {
  auditId: "e5c711c0-612c-49f0-a322-0f13a8c3e3ca",
  affectedEventIds: ["5be79d7a-d2c8-46d8-8d6f-8fe3b9359824"],
  cacheInvalidated: true,
};

describe("atomic timeline administration", () => {
  it("uses exactly one RPC for event, candidate, and company mutations", async () => {
    const rpc = vi.fn(async () => ({ data: RPC_RESULT, error: null }));
    const from = vi.fn(() => { throw new Error("atomic actions must not issue table writes"); });
    const client = { rpc, from } as never;
    const actor = { id: "reviewer-7", email: "reviewer@example.com" };

    await expect(applyTimelineAdminEventAction({
      type: "re_evaluate",
      eventId: "5be79d7a-d2c8-46d8-8d6f-8fe3b9359824",
      reason: "Re-run classification against the durable evidence.",
    }, actor, client)).resolves.toEqual(RPC_RESULT);
    await expect(applyTimelineAdminCandidateAction({
      type: "reject_candidate",
      candidateId: "c7903505-7b84-45ce-bace-243fd13b3d62",
      reason: "The source does not support the proposed company claim.",
    }, actor, client)).resolves.toEqual(RPC_RESULT);
    await expect(applyTimelineAdminCompanyAction({
      type: "rebuild_artifact",
      companyId: "company-screenpipe",
    }, actor, client)).resolves.toEqual(RPC_RESULT);

    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenNthCalledWith(1, "apply_timeline_admin_action", {
      p_scope: "event",
      p_action: expect.objectContaining({ type: "re_evaluate" }),
      p_actor: actor,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "apply_timeline_admin_action", {
      p_scope: "candidate",
      p_action: expect.objectContaining({ type: "reject_candidate" }),
      p_actor: actor,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "apply_timeline_admin_action", {
      p_scope: "company",
      p_action: { type: "rebuild_artifact", companyId: "company-screenpipe" },
      p_actor: actor,
    });
  });

  it("fails closed when the RPC result does not prove audit and invalidation", async () => {
    const client = {
      from: vi.fn(),
      rpc: vi.fn(async () => ({
        data: { auditId: "", affectedEventIds: [], cacheInvalidated: false },
        error: null,
      })),
    } as never;

    await expect(applyTimelineAdminEventAction({
      type: "unpublish",
      eventId: "5be79d7a-d2c8-46d8-8d6f-8fe3b9359824",
      reason: "The public evidence was withdrawn.",
    }, { id: "reviewer" }, client)).rejects.toMatchObject({
      code: "database_contract_error",
    });
  });

  it("accepts the bounded re-evaluate command at the HTTP boundary", async () => {
    const command = await readTimelineAdminActionRequest(new Request("https://returner.fund", {
      method: "POST",
      body: JSON.stringify({
        scope: "event",
        action: {
          type: "re_evaluate",
          eventId: "5be79d7a-d2c8-46d8-8d6f-8fe3b9359824",
          reason: "Re-run classification against the durable evidence.",
        },
      }),
    }));

    expect(command).toEqual(expect.objectContaining({
      scope: "event",
      action: expect.objectContaining({ type: "re_evaluate" }),
    }));
  });

  it("defines one locked service-role RPC for mutation, audit, invalidation, and queues", () => {
    const sql = readFileSync(join(
      process.cwd(),
      "supabase",
      "migrations",
      "018_atomic_timeline_admin_actions.sql",
    ), "utf8");
    const normalized = sql.replace(/\s+/g, " ").toLowerCase();

    expect(normalized).toContain("create or replace function public.apply_timeline_admin_action");
    expect(normalized).toContain("language plpgsql security definer");
    expect(normalized).toContain("for update");
    expect(normalized).toContain("insert into public.timeline_event_audit_log");
    expect(normalized).toContain("insert into public.timeline_artifact_invalidations");
    expect(normalized).toContain("insert into public.ingestion_tasks");
    expect(normalized).toContain("on conflict (checkpoint_key) do update");
    expect(normalized).toContain("insert into public.timeline_event_evidence");
    expect(normalized).toContain("insert into public.timeline_event_posts");
    expect(normalized).toContain("evidence.source_event_date = new.event_date");
    expect(normalized).toContain("evidence.source_event_date = event.event_date");
    expect(normalized).toContain("source.published_at at time zone 'utc'");
    expect(normalized).toContain("supports_event_date, supports_title, supports_summary, source_event_date, is_conflicting");
    expect(normalized).toContain("after update of attribution_status, canonical_url, published_at");
    expect(normalized).toContain("create trigger timeline_event_evidence_sync_conflict");
    expect(normalized).toContain("create trigger timeline_events_sync_conflict");
    expect(normalized).toContain("perform public.synchronize_timeline_event_conflict_state(old.event_id, false)");
    expect(normalized).toContain("set evidence_role = 'supporting', is_conflicting = false, conflict_description = null");
    expect(normalized).toContain("'adminconflictresolution'");
    expect(normalized).toContain("evidence.value ->> 'sourcedocumentid' = v_link.source_document_id::text");
    expect(normalized).toContain("v_payload -> 'durablesourcemap'");
    expect(normalized).toContain("case when v_supports ? 'eventdate' then v_candidate.proposed_event_date else null end");
    expect(normalized).toContain("when 're_evaluate'");
    expect(normalized).toContain("when 'merge'");
    expect(normalized).toContain("when 'split'");
    expect(normalized).toContain("where company.source_key = trim(p_action ->> 'companyid') order by company.id asc limit 1 for update");
    expect(normalized).toContain("revoke all on function public.apply_timeline_admin_action(text, jsonb, jsonb) from public, anon, authenticated");
    expect(normalized).toContain("grant execute on function public.apply_timeline_admin_action(text, jsonb, jsonb) to service_role");
    expect(normalized).toContain("create or replace function public.claim_timeline_admin_tasks");
    expect(normalized).toContain("where task.ingestion_run_id is null");
    expect(normalized).toContain("task.status in ('queued', 'retry_scheduled')");
    expect(normalized).toContain("for update of task skip locked");
    expect(normalized).toContain("revoke all on function public.claim_timeline_admin_tasks(text, integer, interval, text) from public, anon, authenticated");
    expect(normalized).toContain("grant execute on function public.claim_timeline_admin_tasks(text, integer, interval, text) to service_role");
  });

  it("rebinds published title and summary corrections to verified evidence before republishing", () => {
    const sql = readFileSync(join(
      process.cwd(),
      "supabase",
      "migrations",
      "018_atomic_timeline_admin_actions.sql",
    ), "utf8");
    const normalized = sql.replace(/\s+/g, " ").toLowerCase();
    const editBranch = normalized.match(/when 'edit' then ([\s\S]*?) when 'merge' then/)?.[1];

    expect(editBranch).toBeDefined();
    expect(editBranch).toContain("evidence.evidence_role in ('primary', 'supporting')");
    expect(editBranch).toContain("not evidence.is_conflicting");
    expect(editBranch).toContain("evidence.supports_event_date and evidence.supports_title and evidence.supports_summary");
    expect(editBranch).toContain("trim(coalesce(evidence.extracted_claims ->> 'title', '')) = trim(v_event.title)");
    expect(editBranch).toContain("trim(coalesce(evidence.extracted_claims ->> 'summary', '')) = trim(v_event.summary)");
    expect(editBranch).toContain("source.attribution_status = 'verified'");
    expect(editBranch).toContain("source.canonical_url ~* '^https?://'");
    expect(editBranch).toContain("for update of evidence");
    expect(editBranch).toContain("'adminclaimcorrection'");

    const temporarilyUnpublished = editBranch!.indexOf("set status = 'needs_review'");
    const claimsRebound = editBranch!.indexOf("update public.timeline_event_evidence as evidence");
    const guardedEventUpdate = editBranch!.lastIndexOf("update public.timeline_events");
    expect(temporarilyUnpublished).toBeGreaterThan(-1);
    expect(claimsRebound).toBeGreaterThan(temporarilyUnpublished);
    expect(guardedEventUpdate).toBeGreaterThan(claimsRebound);
    expect(editBranch).toContain("when v_event.status = 'published' and v_source_evidence_id is not null then 'published'");

    const publicationGuard = normalized.match(
      /create or replace function public\.guard_timeline_event_publication\(\) ([\s\S]*?) create or replace function public\.assert_published_timeline_event_has_evidence/,
    )?.[1];
    expect(publicationGuard).toContain("trim(coalesce(evidence.extracted_claims ->> 'title', '')) = trim(new.title)");
    expect(publicationGuard).toContain("trim(coalesce(evidence.extracted_claims ->> 'summary', '')) = trim(new.summary)");

  });
});
