import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompanyTimelineArtifact } from "@/lib/timeline/contracts";
import {
  applyTimelineAdminEventAction,
  getTimelineAdminEventDetail,
  getPublishedTimelineEventDetail,
  listPublishedTimelineEvents,
  listTimelineCoverage,
  resolveTimelineCompanyBySlug,
} from "@/lib/timeline/store";

describe("timeline artifact store", () => {
  it("routes source attachment through the single guarded admin RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        auditId: "e5c711c0-612c-49f0-a322-0f13a8c3e3ca",
        affectedEventIds: ["5be79d7a-d2c8-46d8-8d6f-8fe3b9359824"],
        cacheInvalidated: true,
      },
      error: null,
    }));
    const from = vi.fn(() => {
      throw new Error("source attachment must not bypass the guarded admin RPC");
    });
    const client = { rpc, from } as never;

    await expect(applyTimelineAdminEventAction({
      type: "attach_evidence",
      eventId: "5be79d7a-d2c8-46d8-8d6f-8fe3b9359824",
      sourceDocumentId: "7fac8e60-bb41-4e98-bc01-40b63ee5842d",
      evidenceRole: "supporting",
      reason: "Attach the reviewed same-company source.",
    }, { id: "reviewer" }, client)).resolves.toEqual(expect.objectContaining({
      cacheInvalidated: true,
    }));

    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("apply_timeline_admin_action", {
      p_scope: "event",
      p_action: expect.objectContaining({
        type: "attach_evidence",
        sourceDocumentId: "7fac8e60-bb41-4e98-bc01-40b63ee5842d",
      }),
      p_actor: { id: "reviewer", email: null },
    });
  });

  it("resolves canonical companies without batch duplication", async () => {
    const company = await resolveTimelineCompanyBySlug("conifer");
    expect(company).toEqual({ id: "company-conifer", slug: "conifer", name: "Conifer" });
  });

  it("paginates published events with a strict opaque cursor", async () => {
    const artifact = timelineArtifactWithAtLeastTwoEvents();
    const first = await listPublishedTimelineEvents({ companyId: artifact.company.id, limit: 1 });

    expect(first.events).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.events.every((event) => event.evidenceCount > 0 && event.sourcePreview.length > 0)).toBe(true);

    const second = await listPublishedTimelineEvents({
      companyId: artifact.company.id,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.id).not.toBe(first.events[0]!.id);
  });

  it("fails closed for malformed cursors instead of replaying page one", async () => {
    await expect(listPublishedTimelineEvents({
      companyId: "company-conifer",
      cursor: "malformed",
    })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("loads lazy evidence detail separately from the company artifact", async () => {
    const page = await listPublishedTimelineEvents({ companyId: "company-conifer", limit: 1 });
    const detail = await getPublishedTimelineEventDetail(page.events[0]!.id);

    expect(detail?.event.id).toBe(page.events[0]!.id);
    expect(detail?.event.evidence.length).toBeGreaterThan(0);
  });

  it("serves exact-day source provenance without inventing a timestamp", async () => {
    const page = await listPublishedTimelineEvents({ companyId: "company-ontora", limit: 100 });
    const event = page.events.find((item) =>
      item.sourcePreview.some((source) => source.publishedAt === "2026-06-08")
    );

    expect(event).toBeDefined();
    const detail = await getPublishedTimelineEventDetail(event!.id);
    expect(detail?.event.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ publicationDate: "2026-06-08" }),
    ]));
  });

  it("overlays durable publications so audited changes do not wait for a repository rebuild", async () => {
    const durableUpdatedAt = liveTimelineUpdatedAt();
    const client = liveTimelineClient(durableUpdatedAt);
    const page = await listPublishedTimelineEvents({ companyId: "company-conifer", limit: 100 }, client);
    const live = page.events.find((event) => event.id === "tldb-00000000-0000-4000-8000-000000000002");

    expect(live).toMatchObject({
      title: "Conifer opened its public platform",
      eventDate: "2025-01-02",
      evidenceCount: 1,
    });
    expect(page.cache.lastModifiedAt).toBe(durableUpdatedAt);
  });

  it("reads DB-backed detail from the current published projection", async () => {
    const detail = await getPublishedTimelineEventDetail(
      "tldb-00000000-0000-4000-8000-000000000002",
      liveTimelineClient(),
    );

    expect(detail?.company.id).toBe("company-conifer");
    expect(detail?.event.evidence).toEqual([
      expect.objectContaining({
        id: "srcdb-00000000-0000-4000-8000-000000000003",
        sourceEventDate: "2025-01-02",
      }),
    ]);
  });

  it("reports terminal coverage for the authoritative unique-company inventory", async () => {
    const coverage = await listTimelineCoverage({ limit: 100 });
    expect(coverage.items).toHaveLength(100);
    expect(coverage.nextCursor).toEqual(expect.any(String));
    expect(coverage.items.every((item) => item.company.id && item.company.slug)).toBe(true);
  });

  it("overlays live coverage from the lowest durable UUID with failures and cache state", async () => {
    const lowestCompanyId = "00000000-0000-4000-8000-000000000001";
    const duplicateCompanyId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const client = readOnlyTimelineClient({
      companies: [
        { id: duplicateCompanyId, source_key: "company-conifer" },
        { id: lowestCompanyId, source_key: "company-conifer" },
      ],
      timeline_company_state: [
        {
          company_id: duplicateCompanyId,
          historical_backfill_status: "failed",
          published_event_count: 999,
        },
        {
          company_id: lowestCompanyId,
          historical_backfill_status: "completed",
          historical_backfill_started_at: "2026-08-01T01:00:00.000Z",
          historical_backfill_completed_at: "2026-08-01T02:00:00.000Z",
          last_incremental_scan_at: "2026-08-02T03:00:00.000Z",
          last_deep_scan_at: "2026-08-02T04:00:00.000Z",
          published_event_count: 7,
          candidate_event_count: 3,
          unresolved_conflict_count: 2,
          unresolved_date_count: 1,
          source_coverage: { timeline_historical_archive: "completed" },
          last_successful_artifact_at: "2026-08-02T05:00:00.000Z",
          last_error: "One source class remains blocked.",
        },
      ],
      timeline_source_coverage: [
        { company_id: duplicateCompanyId, source_class: "timeline_public_web", status: "completed" },
        { company_id: lowestCompanyId, source_class: "timeline_public_web", status: "failed" },
        { company_id: lowestCompanyId, source_class: "timeline_official_site", status: "blocked" },
        { company_id: lowestCompanyId, source_class: "timeline_existing_evidence", status: "completed" },
      ],
      timeline_artifact_invalidations: [
        { company_id: lowestCompanyId, status: "completed", processed_at: "2026-08-01T00:00:00.000Z" },
        { company_id: lowestCompanyId, status: "pending", processed_at: null },
        { company_id: duplicateCompanyId, status: "failed", processed_at: null },
      ],
      ingestion_dead_letters: [
        {
          ingestion_task_id: "task-open-timeline",
          status: "open",
          resolved_at: null,
          task_snapshot_json: { entity_id: lowestCompanyId, platform: "timeline_public_web" },
        },
        {
          ingestion_task_id: "task-open-unrelated",
          status: "open",
          resolved_at: null,
          task_snapshot_json: { entity_id: lowestCompanyId, platform: "linkedin" },
        },
        {
          ingestion_task_id: "task-open-duplicate-company",
          status: "open",
          resolved_at: null,
          task_snapshot_json: { entity_id: duplicateCompanyId, platform: "timeline_historical_archive" },
        },
        {
          ingestion_task_id: "task-open-but-resolved-timeline",
          status: "open",
          resolved_at: "2026-08-02T05:30:00.000Z",
          task_snapshot_json: { entity_id: lowestCompanyId, platform: "timeline_official_site" },
        },
        {
          ingestion_task_id: "task-resolved-timeline",
          status: "resolved",
          resolved_at: "2026-08-02T06:00:00.000Z",
          task_snapshot_json: { entity_id: lowestCompanyId, platform: "timeline_official_site" },
        },
        {
          ingestion_task_id: "task-requeued-timeline",
          status: "requeued",
          resolved_at: "2026-08-02T07:00:00.000Z",
          task_snapshot_json: { entity_id: lowestCompanyId, platform: "timeline_gap_followup" },
        },
      ],
    });

    const result = await listTimelineCoverage({ q: "conifer", limit: 100 }, client);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      company: { id: "company-conifer" },
      historicalBackfillStatus: "completed",
      historicalBackfillStartedAt: "2026-08-01T01:00:00.000Z",
      historicalBackfillCompletedAt: "2026-08-01T02:00:00.000Z",
      lastIncrementalScanAt: "2026-08-02T03:00:00.000Z",
      lastDeepScanAt: "2026-08-02T04:00:00.000Z",
      publishedEventCount: 7,
      candidateEventCount: 3,
      unresolvedConflictCount: 2,
      unresolvedDateCount: 1,
      sourceCoverage: {
        timeline_public_web: "failed",
        timeline_official_site: "blocked",
        timeline_existing_evidence: "completed",
      },
      failedSourceCount: 2,
      deadLetterTaskCount: 1,
      cacheStatus: "pending",
      lastSuccessfulArtifactAt: "2026-08-02T05:00:00.000Z",
      lastError: "One source class remains blocked.",
    });
  });

  it("falls back to the last-good coverage artifact when timeline migrations are unavailable", async () => {
    const baseline = await listTimelineCoverage({ q: "conifer", limit: 100 });
    const client = readOnlyTimelineClient({
      companies: [{ id: "00000000-0000-4000-8000-000000000001", source_key: "company-conifer" }],
    }, {
      timeline_company_state: { code: "PGRST205", message: "timeline_company_state is not in the schema cache" },
    });

    const result = await listTimelineCoverage({ q: "conifer", limit: 100 }, client);

    expect(result).toEqual(baseline);
  });

  it("serves last-good public artifacts when the optional database company schema is unavailable", async () => {
    const artifactOnlyClient = readOnlyTimelineClient({ companies: [] });
    const baselineTimeline = await listPublishedTimelineEvents(
      { companyId: "company-conifer", limit: 100 },
      artifactOnlyClient,
    );
    const baselineCoverage = await listTimelineCoverage({ q: "conifer", limit: 100 }, artifactOnlyClient);
    const client = readOnlyTimelineClient({}, {
      companies: { message: "Could not find the table 'public.companies' in the schema cache" },
    });

    const timeline = await listPublishedTimelineEvents({ companyId: "company-conifer", limit: 100 }, client);
    const coverage = await listTimelineCoverage({ q: "conifer", limit: 100 }, client);

    expect(timeline).toEqual(baselineTimeline);
    expect(coverage).toEqual(baselineCoverage);
  });

  it("uses one coherent artifact snapshot while any required live projection is not migrated", async () => {
    const baseline = await listPublishedTimelineEvents(
      { companyId: "company-conifer", limit: 100 },
      readOnlyTimelineClient({ companies: [] }),
    );
    const tables = {
      companies: [{ id: "00000000-0000-4000-8000-000000000001", source_key: "company-conifer" }],
      published_timeline_events: [{
        id: "00000000-0000-4000-8000-000000000002",
        primary_company_id: "00000000-0000-4000-8000-000000000001",
      }],
      published_timeline_source_metadata: [],
      published_timeline_post_metadata: [],
    };

    for (const missingTable of [
      "published_timeline_events",
      "published_timeline_source_metadata",
      "published_timeline_post_metadata",
    ]) {
      const client = readOnlyTimelineClient(tables, {
        [missingTable]: { code: "PGRST205", message: `${missingTable} is not in the schema cache` },
      });

      await expect(
        listPublishedTimelineEvents({ companyId: "company-conifer", limit: 100 }, client),
      ).resolves.toEqual(baseline);
    }
  });

  it("fails closed instead of masking non-migration database errors", async () => {
    const client = readOnlyTimelineClient({}, {
      companies: { code: "42501", message: "permission denied for table companies" },
    });

    await expect(
      listPublishedTimelineEvents({ companyId: "company-conifer", limit: 100 }, client),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("fails closed when a migration gap and a non-migration projection error happen together", async () => {
    const tables = {
      companies: [{ id: "00000000-0000-4000-8000-000000000001", source_key: "company-conifer" }],
      published_timeline_events: [{
        id: "00000000-0000-4000-8000-000000000002",
        primary_company_id: "00000000-0000-4000-8000-000000000001",
      }],
    };
    const errors = {
      published_timeline_source_metadata: { code: "PGRST205", message: "source projection is not in the schema cache" },
      published_timeline_post_metadata: { code: "42501", message: "permission denied for post projection" },
    };
    const client = readOnlyTimelineClient(tables, errors);

    await expect(
      listPublishedTimelineEvents({ companyId: "company-conifer", limit: 100 }, client),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      getPublishedTimelineEventDetail("tldb-00000000-0000-4000-8000-000000000002", client),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps company-only admin audits valid while forbidding dual event/candidate targets", () => {
    const migration = readFileSync(
      join(process.cwd(), "supabase", "migrations", "017_company_timeline.sql"),
      "utf8",
    );
    expect(migration).toMatch(
      /timeline_event_audit_target_check check \(not \(event_id is not null and candidate_id is not null\)\)/,
    );
  });

  it("inspects private event evidence directly from durable tables", async () => {
    const client = readOnlyTimelineClient({
      timeline_events: [{
        id: "event-private", primary_company_id: "company-db", event_date: "2026-03-18",
        event_date_type: "announcement_date", title: "Acme announced a seed round",
        summary: "Acme announced seed financing to expand product development.",
        category: "funding", is_major: true, has_conflict: false, conflict_summary: null,
        status: "needs_review", importance_score: 90, event_key: "funding-acme-2026",
        published_at: null, classifier_version: "rules-v1", extraction_version: "extract-v1",
      }],
      timeline_event_evidence: [{
        event_id: "event-private", source_document_id: "source-private", evidence_role: "primary",
        evidence_excerpt: "Acme announced its seed financing on March 18.", source_event_date: "2026-03-18",
        is_conflicting: false, conflict_description: null,
      }],
      source_documents: [{
        id: "source-private", canonical_url: "https://acme.example/news/seed",
        source_type: "press_release", publisher: "Acme", domain: "acme.example",
        title: "Acme seed financing", published_at: "2026-03-18T14:00:00.000Z",
      }],
      timeline_event_posts: [{
        event_id: "event-private", evidence_id: "post-private", evidence_role: "supporting",
      }],
      evidence_items: [{
        id: "post-private", platform: "linkedin", canonical_url: "https://www.linkedin.com/posts/acme_seed-1",
        published_at: "2026-03-18T15:00:00.000Z",
        metadata_json: { authorHandle: "acme", text: "We announced our seed financing.", metrics: { likes: 42 } },
      }],
      timeline_event_audit_log: [{
        id: "audit-private", event_id: "event-private", actor_id: "reviewer",
        actor_email: "reviewer@example.com", action: "candidate_created", before_json: null,
        after_json: { status: "needs_review" }, reason: "Exact date needs review.",
        created_at: "2026-03-18T16:00:00.000Z",
      }],
    });

    const detail = await getTimelineAdminEventDetail("event-private", client);

    expect(detail?.event.status).toBe("needs_review");
    expect(detail?.event.evidenceCount).toBe(2);
    expect(detail?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "source-private", evidenceRole: "primary" }),
    ]));
    expect(detail?.posts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "post-private", account: "acme", metrics: { likes: 42 } }),
    ]));
    expect(detail?.auditHistory[0]?.id).toBe("audit-private");
  });
});

function readOnlyTimelineClient(
  tables: Record<string, Array<Record<string, unknown>>>,
  errors: Record<string, { code?: string; message: string }> = {},
) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const tableError = errors[table] ?? null;
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) { rows = rows.filter((row) => row[column] === value); return query; },
        in(column: string, values: readonly unknown[]) { rows = rows.filter((row) => values.includes(row[column])); return query; },
        order(column: string, options?: { ascending?: boolean }) {
          rows.sort((left, right) => String(left[column]).localeCompare(String(right[column])) * (options?.ascending === false ? -1 : 1));
          return query;
        },
        limit(value: number) { rows = rows.slice(0, value); return query; },
        range(from: number, to: number) {
          return Promise.resolve({ data: tableError ? null : rows.slice(from, to + 1), error: tableError });
        },
        maybeSingle() { return Promise.resolve({ data: tableError ? null : rows[0] ?? null, error: tableError }); },
        single() { return Promise.resolve({ data: tableError ? null : rows[0] ?? null, error: tableError }); },
        then<TResult1 = { data: Array<Record<string, unknown>> | null; error: { code?: string; message: string } | null }, TResult2 = never>(
          onfulfilled?: ((value: { data: Array<Record<string, unknown>> | null; error: { code?: string; message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve({ data: tableError ? null : rows, error: tableError }).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  } as never;
}

function liveTimelineUpdatedAt() {
  const artifact = JSON.parse(
    readFileSync(join(process.cwd(), "public", "timelines", "companies", "conifer.json"), "utf8"),
  ) as CompanyTimelineArtifact;
  return new Date(Date.parse(artifact.lastModifiedAt) + 60_000).toISOString();
}

function liveTimelineClient(updatedAt = liveTimelineUpdatedAt()) {
  return readOnlyTimelineClient({
    companies: [{
      id: "00000000-0000-4000-8000-000000000001",
      source_key: "company-conifer",
    }],
    published_timeline_events: [{
      id: "00000000-0000-4000-8000-000000000002",
      primary_company_id: "00000000-0000-4000-8000-000000000001",
      category: "product_launch",
      title: "Conifer opened its public platform",
      summary: "Conifer announced that its platform became publicly available.",
      event_date: "2025-01-02",
      event_date_type: "announcement_date",
      is_major: true,
      has_conflict: false,
      conflict_summary: null,
      published_at: "2026-08-02T11:00:00.000Z",
      updated_at: updatedAt,
    }],
    published_timeline_source_metadata: [{
      id: "00000000-0000-4000-8000-000000000003",
      event_id: "00000000-0000-4000-8000-000000000002",
      canonical_url: "https://conifer.example/launch",
      source_type: "company_blog",
      publisher: "Conifer",
      domain: "conifer.example",
      title: "Conifer public launch",
      author: null,
      published_at: "2025-01-02T09:00:00.000Z",
      evidence_role: "primary",
      evidence_excerpt: "Conifer is now publicly available.",
      source_event_date: "2025-01-02",
      is_conflicting: false,
      conflict_description: null,
    }],
  });
}

function timelineArtifactWithAtLeastTwoEvents(): CompanyTimelineArtifact {
  const directory = join(process.cwd(), "public", "timelines", "companies");
  for (const filename of readdirSync(directory).sort()) {
    if (!filename.endsWith(".json")) continue;
    const artifact = JSON.parse(readFileSync(join(directory, filename), "utf8")) as CompanyTimelineArtifact;
    if (artifact.events.length >= 2) return artifact;
  }
  throw new Error("Expected at least one generated company timeline with two published events.");
}
