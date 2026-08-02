import { describe, expect, it, vi } from "vitest";
import type { EvidenceItem } from "@/lib/graph/types";
import {
  TIMELINE_SOURCE_CLASSES,
  type TimelineSourceClass,
} from "@/lib/timeline/coordinator";
import type { TimelineSourceCoverageState } from "@/lib/timeline/contracts";
import type { TimelineClassificationSource } from "@/lib/timeline/domain";
import {
  classifyDiscoveredTimelineSource,
  dispatchTimelineSourceClass,
  findSameCompanyTimelineEventBySourceDocuments,
  runTimelineAdminTaskDrain,
  runTimelineDiscoveryIngestion,
  SupabaseTimelineDiscoveryPersistence,
  timelineCandidatePayloadWithDurableSource,
  timelineEventEvidenceRows,
  type TimelineDiscoveryHandlerResult,
  type TimelineDiscoveryPersistence,
  type TimelineIngestionCompany,
} from "@/lib/timeline/ingestion-runner";
import {
  mergeTimelineSourceCoverage,
  mergeDatabaseEventsForArtifact,
  projectTimelineProposalConflicts,
  isTimelineBaseGraphFilename,
  runCompanyTimelineBackfill,
} from "@/lib/timeline/backfill";
import type {
  AppendRunEventInput,
  EnqueueTaskInput,
  IngestionCoverageReportRow,
  IngestionRunEventRow,
  IngestionTaskRow,
  JsonObject,
  PersistCoverageReportInput,
} from "@/lib/workers/autonomous-ingestion-store";

const NOW = "2026-08-02T12:00:00.000Z";

describe("bounded durable Timeline ingestion", () => {
  it("enqueues and terminalizes every source class for every canonical company", async () => {
    const store = new MemoryTaskStore();
    const persistence = new MemoryPersistence();
    const statuses: Record<TimelineSourceClass, TimelineDiscoveryHandlerResult["status"]> = {
      timeline_existing_evidence: "completed",
      timeline_official_site: "no_results",
      timeline_founder_sources: "no_applicable_source",
      timeline_institutional_sources: "completed",
      timeline_public_web: "authentication_required",
      timeline_historical_archive: "blocked",
      timeline_gap_followup: "no_results",
      timeline_reconcile_publish: "completed",
    };

    const receipt = await runTimelineDiscoveryIngestion({
      client: {} as never,
      runId: "run-1",
      workerId: "worker-1",
      companies: [company()],
      now: () => new Date(NOW),
      store,
      persistence,
      discover: async (sourceClass) => ({ status: statuses[sourceClass], reason: `test_${statuses[sourceClass]}`, sources: [] }),
    });

    expect(receipt).toMatchObject({ expectedTasks: 8, terminalTasks: 8, completedTasks: 3, blockedOrEmptyTasks: 5, deadLetteredTasks: 0 });
    expect(new Set(store.tasks.map((task) => task.platform))).toEqual(new Set(TIMELINE_SOURCE_CLASSES));
    expect(Object.keys(persistence.terminalCoverage.get("db-company-acme") ?? {}).sort()).toEqual([...TIMELINE_SOURCE_CLASSES].sort());
  });

  it("replays terminal checkpoints without rediscovery or duplicate work", async () => {
    const store = new MemoryTaskStore();
    const persistence = new MemoryPersistence();
    const discover = vi.fn(async (): Promise<TimelineDiscoveryHandlerResult> => ({
      status: "completed", reason: "done", sources: [],
    }));
    const input = {
      client: {} as never,
      runId: "run-resume",
      workerId: "worker-resume",
      companies: [company()],
      now: () => new Date(NOW),
      store,
      persistence,
      discover,
    };

    await runTimelineDiscoveryIngestion(input);
    const firstCalls = discover.mock.calls.length;
    const replay = await runTimelineDiscoveryIngestion(input);

    expect(firstCalls).toBe(8);
    expect(discover).toHaveBeenCalledTimes(8);
    expect(replay).toMatchObject({ expectedTasks: 8, terminalTasks: 8, resumedTerminalTasks: 8 });
    expect(store.tasks).toHaveLength(8);
  });

  it("creates fresh checkpoints for a later run while keeping same-run replay idempotent", async () => {
    const store = new MemoryTaskStore();
    const persistence = new MemoryPersistence();
    const discover = vi.fn(async (): Promise<TimelineDiscoveryHandlerResult> => ({
      status: "completed", reason: "done", sources: [],
    }));

    await runTimelineDiscoveryIngestion({
      client: {} as never, runId: "run-first", workerId: "worker", companies: [company()],
      now: () => new Date(NOW), store, persistence, discover,
    });
    await runTimelineDiscoveryIngestion({
      client: {} as never, runId: "run-second", workerId: "worker", companies: [company()],
      now: () => new Date(NOW), store, persistence, discover,
    });

    expect(store.tasks).toHaveLength(16);
    expect(discover).toHaveBeenCalledTimes(16);
    expect(new Set(store.tasks.map((task) => task.ingestion_run_id))).toEqual(new Set(["run-first", "run-second"]));
  });

  it("never claims an unrelated ingestion task from the shared parent run", async () => {
    const store = new MemoryTaskStore();
    await store.enqueueTasks([{
      runId: "run-shared",
      batchId: "db-batch",
      entityType: "company",
      entityId: "db-company-acme",
      companyName: "Acme",
      platform: "linkedin",
      checkpointKey: "unrelated-linkedin-task",
    }]);

    await runTimelineDiscoveryIngestion({
      client: {} as never,
      runId: "run-shared",
      workerId: "timeline-worker",
      companies: [company()],
      now: () => new Date(NOW),
      store,
      persistence: new MemoryPersistence(),
      discover: async () => ({ status: "completed", reason: "done", sources: [] }),
    });

    expect(store.tasks.find((task) => task.checkpoint_key === "unrelated-linkedin-task")).toMatchObject({
      status: "queued",
      attempts: 0,
      last_error: null,
    });
  });

  it("drains run-less admin reconciliation tasks without stealing run-scoped work", async () => {
    const store = new MemoryTaskStore();
    const [adminTask] = await store.enqueueTasks([{
      runId: "admin-placeholder",
      batchId: "db-batch",
      entityType: "company",
      entityId: "db-company-acme",
      companyName: "Acme",
      platform: "timeline_reconcile_publish",
      checkpointKey: "timeline:admin:reconcile:acme",
    }]);
    if (!adminTask) throw new Error("Expected an admin task fixture.");
    adminTask.ingestion_run_id = null;
    await store.enqueueTasks([{
      runId: "run-active",
      batchId: "db-batch",
      entityType: "company",
      entityId: "db-company-acme",
      companyName: "Acme",
      platform: "timeline_reconcile_publish",
      checkpointKey: "timeline:run:reconcile:acme",
    }]);
    const reconcileCompany = vi.fn(async () => ({
      sourceDocuments: 2,
      candidates: 1,
      publishedEvents: 1,
      unresolvedDates: 0,
    }));
    const persistence: TimelineDiscoveryPersistence = {
      markCoverage: vi.fn(async () => {}),
      persistSources: vi.fn(async () => ({ sourceDocuments: 0, candidates: 0, publishedEvents: 0, unresolvedDates: 0 })),
      reconcileCompany,
      finalizeCompanies: vi.fn(async () => {}),
    };
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      if (args.p_source_class !== "timeline_reconcile_publish"
          || adminTask?.status !== "queued") return { data: [], error: null };
      adminTask.status = "running";
      adminTask.attempts += 1;
      adminTask.locked_by = String(args.p_worker_id);
      adminTask.lease_token = "admin-lease";
      adminTask.lease_expires_at = "2099-01-01T00:00:00.000Z";
      return { data: [structuredClone(adminTask)], error: null };
    });

    const receipt = await runTimelineAdminTaskDrain({
      client: { rpc } as never,
      workerId: "timeline-admin-worker",
      companies: [company()],
      now: () => new Date(NOW),
      store,
      persistence,
      discover: async () => ({ status: "completed", reason: "durable_reconcile", sources: [] }),
    });

    expect(receipt).toMatchObject({
      status: "completed",
      claimedTasks: 1,
      terminalTasks: 1,
      sourceDocuments: 2,
      candidates: 1,
      publishedEvents: 1,
    });
    expect(reconcileCompany).toHaveBeenCalledWith(expect.objectContaining({
      id: "company-acme",
      databaseId: "db-company-acme",
    }), NOW);
    expect(store.tasks.find((task) => task.ingestion_run_id === null)).toMatchObject({ status: "completed" });
    expect(store.tasks.find((task) => task.ingestion_run_id === "run-active")).toMatchObject({ status: "queued" });
    expect(store.requeueExpiredCalls).toBe(1);
    expect(rpc).toHaveBeenCalledWith("claim_timeline_admin_tasks", expect.objectContaining({
      p_worker_id: "timeline-admin-worker",
      p_source_class: expect.stringMatching(/^timeline_/),
    }));
  });

  it("uses immediate bounded retries and dead-letters an exhausted handler", async () => {
    const store = new MemoryTaskStore();
    const persistence = new MemoryPersistence();
    const receipt = await runTimelineDiscoveryIngestion({
      client: {} as never,
      runId: "run-retry",
      workerId: "worker-retry",
      companies: [company()],
      now: () => new Date(NOW),
      store,
      persistence,
      discover: async (sourceClass) => sourceClass === "timeline_public_web"
        ? { status: "failed", reason: "provider_down", sources: [] }
        : { status: "completed", reason: "done", sources: [] },
    });

    expect(receipt).toMatchObject({ terminalTasks: 8, deadLetteredTasks: 1 });
    expect(store.tasks.find((task) => task.platform === "timeline_public_web")).toMatchObject({
      attempts: 5,
      status: "dead_lettered",
    });
  });

  it("finalizes company coverage from grouped durable counts without clobbering scan history", async () => {
    const secondCompany = { ...company(), id: "company-beta", databaseId: "db-company-beta", slug: "beta", name: "Beta" };
    const publishedEvents = Array.from({ length: 1_001 }, () => ({
      primary_company_id: "db-company-acme", status: "published", has_conflict: false,
    }));
    const database = timelinePersistenceClient({
      timeline_company_state: [{
        company_id: "db-company-acme",
        historical_backfill_status: "completed",
        historical_backfill_started_at: "2026-07-01T00:00:00.000Z",
        historical_backfill_completed_at: "2026-07-15T00:00:00.000Z",
        last_incremental_scan_at: "2026-07-31T00:00:00.000Z",
        last_deep_scan_at: "2026-07-15T00:00:00.000Z",
        source_coverage: { timeline_official_site: "completed" },
        published_event_count: 99,
        candidate_event_count: 99,
        unresolved_conflict_count: 99,
        unresolved_date_count: 99,
      }],
      timeline_events: [
        ...publishedEvents,
        { primary_company_id: "db-company-acme", status: "published", has_conflict: true },
        { primary_company_id: "db-company-acme", status: "needs_review", has_conflict: true },
        { primary_company_id: "db-company-acme", status: "rejected", has_conflict: true },
      ],
      timeline_event_candidates: [
        { company_id: "db-company-acme", status: "pending", proposed_event_date: null },
        { company_id: "db-company-acme", status: "needs_review", proposed_event_date: "2026-08-01" },
        { company_id: "db-company-acme", status: "accepted", proposed_event_date: null },
        { company_id: "db-company-beta", status: "processing", proposed_event_date: null },
        { company_id: "db-company-beta", status: "rejected", proposed_event_date: null },
      ],
    });
    const persistence = new SupabaseTimelineDiscoveryPersistence(database.client, () => new Date(NOW));
    const coverage = new Map<string, Record<string, TimelineSourceCoverageState>>([
      ["db-company-acme", {
        timeline_existing_evidence: "completed",
        timeline_historical_archive: "completed",
      }],
      ["db-company-beta", { timeline_existing_evidence: "completed" }],
    ]);

    await persistence.finalizeCompanies([company(), secondCompany], coverage, NOW);

    expect(database.upserts.timeline_company_state).toEqual([
      expect.objectContaining({
        company_id: "db-company-acme",
        historical_backfill_started_at: "2026-07-01T00:00:00.000Z",
        historical_backfill_completed_at: NOW,
        last_incremental_scan_at: "2026-07-31T00:00:00.000Z",
        last_deep_scan_at: NOW,
        published_event_count: 1_002,
        candidate_event_count: 2,
        unresolved_conflict_count: 2,
        unresolved_date_count: 1,
      }),
      expect.objectContaining({
        company_id: "db-company-beta",
        historical_backfill_status: "pending",
        historical_backfill_started_at: null,
        historical_backfill_completed_at: null,
        last_incremental_scan_at: NOW,
        last_deep_scan_at: null,
        published_event_count: 0,
        candidate_event_count: 1,
        unresolved_conflict_count: 0,
        unresolved_date_count: 1,
      }),
    ]);
    expect(database.reads.filter((read) => read.table === "timeline_events")).toHaveLength(2);
    expect(database.reads.filter((read) => read.table === "timeline_event_candidates")).toHaveLength(1);
    expect(database.reads.filter((read) => read.table === "timeline_company_state")).toHaveLength(1);
  });
});

describe("Timeline source-class and evidence boundaries", () => {
  it("never selects another company's event during conflict reconciliation", async () => {
    const identity = {
      eventKey: "funding-new-conflict",
      category: "funding" as const,
      eventDate: "2026-08-02",
      title: "Acme raised a $5M seed round",
    };
    const database = conflictLookupClient({
      timeline_event_evidence: [
        { source_document_id: "document-shared", event_id: "event-other-company" },
        { source_document_id: "document-shared", event_id: "event-acme" },
      ],
      timeline_events: [
        {
          id: "event-other-company", primary_company_id: "db-company-other", has_conflict: false,
          status: "published", event_key: "funding-other", category: "funding",
          event_date: "2026-08-02", title: "Other Co raised a $5M seed round",
        },
        {
          id: "event-acme", primary_company_id: "db-company-acme", has_conflict: true,
          status: "published", event_key: "funding-acme-old", category: "funding",
          event_date: "2026-08-02", title: "Acme raised a $5M seed round",
        },
      ],
    });

    await expect(findSameCompanyTimelineEventBySourceDocuments(
      database.client,
      "db-company-acme",
      ["document-shared"],
      identity,
    )).resolves.toMatchObject({ id: "event-acme", has_conflict: true });
    expect(database.filters).toContainEqual({
      table: "timeline_events",
      column: "primary_company_id",
      value: "db-company-acme",
    });

    const foreignOnly = conflictLookupClient({
      timeline_event_evidence: [
        { source_document_id: "document-shared", event_id: "event-other-company" },
      ],
      timeline_events: [
        {
          id: "event-other-company", primary_company_id: "db-company-other", has_conflict: false,
          status: "published", event_key: "funding-other", category: "funding",
          event_date: "2026-08-02", title: "Other Co raised a $5M seed round",
        },
      ],
    });
    await expect(findSameCompanyTimelineEventBySourceDocuments(
      foreignOnly.client,
      "db-company-acme",
      ["document-shared"],
      identity,
    )).resolves.toBeNull();
  });

  it("does not arbitrarily reuse one of two same-company events sharing a source", async () => {
    const database = conflictLookupClient({
      timeline_event_evidence: [
        { source_document_id: "document-shared", event_id: "event-acme-one" },
        { source_document_id: "document-shared", event_id: "event-acme-two" },
        { source_document_id: "document-terminal", event_id: "event-acme-rejected" },
      ],
      timeline_events: [
        {
          id: "event-acme-one", primary_company_id: "db-company-acme", has_conflict: false,
          status: "published", event_key: "funding-acme-one", category: "funding",
          event_date: "2026-08-02", title: "Acme raised a $5M seed round",
        },
        {
          id: "event-acme-two", primary_company_id: "db-company-acme", has_conflict: false,
          status: "needs_review", event_key: "funding-acme-two", category: "funding",
          event_date: "2026-08-03", title: "Acme raised a $5M seed round",
        },
        {
          id: "event-acme-rejected", primary_company_id: "db-company-acme", has_conflict: false,
          status: "rejected", event_key: "funding-new-conflict", category: "funding",
          event_date: "2026-08-02", title: "Acme raised a $5M seed round",
        },
      ],
    });

    await expect(findSameCompanyTimelineEventBySourceDocuments(
      database.client,
      "db-company-acme",
      ["document-shared", "document-terminal"],
      {
        eventKey: "funding-new-conflict",
        category: "funding",
        eventDate: "2026-08-02",
        title: "Acme raised a $5M seed round",
      },
    )).resolves.toBeNull();
  });

  it("automatically enrolls new base cohort graphs without ingesting derivative views", () => {
    expect([
      "s2026.json",
      "a16zsr006.json",
      "fall-2027.json",
      "manifest.json",
      "fall-2027-insiders.json",
      "fall-2027-yc-partners.json",
      "fall-2027-founders.json",
      "notes.txt",
    ].filter(isTimelineBaseGraphFilename)).toEqual([
      "s2026.json",
      "a16zsr006.json",
      "fall-2027.json",
    ]);
  });

  it("normalizes legacy coverage aliases so durable success replaces static blocked states", () => {
    const durable = Object.fromEntries(TIMELINE_SOURCE_CLASSES.map((sourceClass) => [sourceClass, "completed"])) as
      Partial<Record<string, TimelineSourceCoverageState>>;
    const merged = mergeTimelineSourceCoverage({
      existing_evidence: "completed",
      official_website: "blocked",
      historical_archive: "blocked",
    }, durable);

    expect(Object.keys(merged).sort()).toEqual([...TIMELINE_SOURCE_CLASSES].sort());
    expect(merged).toMatchObject({
      timeline_official_site: "completed",
      timeline_historical_archive: "completed",
    });
    expect(merged).not.toHaveProperty("official_website");
    expect(merged).not.toHaveProperty("historical_archive");
  });

  it("fails closed when durable projections disappear instead of dropping database events", async () => {
    await expect(runCompanyTimelineBackfill({
      dryRun: true,
      maxCompanies: 1,
      databaseSnapshot: {
        status: "migration_unavailable",
        byCompanySourceKey: new Map(),
        sha256: "migration-unavailable",
        generatedAt: null,
        publishedEvents: 0,
        limitations: "projection unavailable",
      },
      logger: () => {},
    })).rejects.toThrow(/refusing to replace last-good artifacts/i);
  });

  it("imports canonical graph evidence into durable source classification", async () => {
    const result = await dispatchTimelineSourceClass("timeline_existing_evidence", {
      ...company(),
      existingEvidence: [graphEvidence()],
      existingEvidenceCount: 1,
    }, {
      networkAllowed: false,
      perFetchTimeoutMs: 1_000,
      providers: [],
    });

    expect(result).toMatchObject({ status: "completed", reason: "canonical_graph_evidence_imported" });
    expect(result.sources).toEqual([
      expect.objectContaining({
        id: "graph-acme-funding",
        attributionStatus: "verified",
        publicationDatePrecision: "exact",
      }),
    ]);
  });

  it("has a truthful terminal handler for every source class when network budget is exhausted", async () => {
    const outcomes = await Promise.all(TIMELINE_SOURCE_CLASSES.map(async (sourceClass) => [
      sourceClass,
      await dispatchTimelineSourceClass(sourceClass, company(), {
        networkAllowed: false,
        perFetchTimeoutMs: 1_000,
        providers: [],
      }),
    ] as const));

    expect(outcomes.map(([sourceClass]) => sourceClass)).toEqual(TIMELINE_SOURCE_CLASSES);
    for (const [, result] of outcomes) {
      expect(["completed", "no_applicable_source", "no_results", "blocked", "authentication_required", "failed"]).toContain(result.status);
    }
    expect(outcomes.find(([sourceClass]) => sourceClass === "timeline_public_web")?.[1]).toMatchObject({
      status: "blocked",
      reason: "bounded_timeline_discovery_budget_exhausted",
    });
  });

  it("merges published database evidence into graph events and appends distinct database events", () => {
    const graph = artifactBundle("tle-graph", "Acme announced a $5M seed round", "https://social.example/acme");
    const duplicate = artifactBundle("tldb-db-1", "Acme announced a $5M seed round", "https://news.example/acme");
    const distinct = artifactBundle("tldb-db-2", "Acme launched a new product", "https://acme.example/launch", {
      category: "product_launch",
      eventDate: "2026-08-01",
    });

    const merged = mergeDatabaseEventsForArtifact([graph], [
      { ...duplicate, updatedAt: NOW },
      { ...distinct, updatedAt: NOW },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.event.id === "tldb-db-1")?.event).toMatchObject({ evidenceCount: 2 });
    expect(merged.find((item) => item.event.id === "tldb-db-1")?.detail.evidence.map((item) => item.url)).toEqual([
      "https://news.example/acme",
      "https://social.example/acme",
    ]);
    expect(merged.some((item) => item.event.id === "tldb-db-2")).toBe(true);
  });

  it("merges nearby cross-channel announcements of the same event", () => {
    const graph = artifactBundle("tle-graph", "Acme announced a $5M seed round", "https://social.example/acme");
    const database = artifactBundle("tldb-db", "Acme announced a $5M seed round", "https://news.example/acme", {
      eventDate: "2026-08-04",
    });

    const merged = mergeDatabaseEventsForArtifact([graph], [{ ...database, updatedAt: NOW }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.event).toMatchObject({ id: "tldb-db", evidenceCount: 2, hasConflict: false });
  });

  it("preserves and exposes conflicting occurrence dates when cross-store events merge", () => {
    const graph = artifactBundle("tle-graph", "Acme launched Widget", "https://social.example/acme", {
      category: "product_launch", eventDate: "2026-08-02", eventDateType: "occurrence_date",
    });
    const database = artifactBundle("tldb-db", "Acme launched Widget", "https://news.example/acme", {
      category: "product_launch", eventDate: "2026-08-04", eventDateType: "occurrence_date",
    });

    const merged = mergeDatabaseEventsForArtifact([graph], [{ ...database, updatedAt: NOW }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.event).toMatchObject({ hasConflict: true, conflictSummary: expect.stringMatching(/occurrence date/) });
    expect(merged[0]?.detail.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://news.example/acme", isConflicting: true, evidenceRole: "conflicting" }),
    ]));
  });

  it("never lets a safely fetched claim publish without an exact direct-source date", () => {
    const undated = source({ publicationTimestamp: null, publicationDatePrecision: "unknown" });
    const rejected = classifyDiscoveredTimelineSource(company(), [undated], undated);
    expect(rejected).toMatchObject({ isMeaningfulEvent: false, reason: "exact_date_unsupported" });

    const dated = source({ publicationTimestamp: NOW, publicationDatePrecision: "exact" });
    const accepted = classifyDiscoveredTimelineSource(company(), [dated], dated);
    expect(accepted).toMatchObject({
      isMeaningfulEvent: true,
      companyId: "company-acme",
      eventDate: "2026-08-02",
      category: "funding",
    });
    if (accepted.isMeaningfulEvent) {
      expect(accepted.evidence[0]?.supports).toEqual(expect.arrayContaining(["eventDate", "title", "summary"]));
    }

    const calendarDated = source({ publicationTimestamp: "2026-08-02", publicationDatePrecision: "day" });
    expect(classifyDiscoveredTimelineSource(company(), [calendarDated], calendarDated)).toMatchObject({
      isMeaningfulEvent: true,
      eventDate: "2026-08-02",
    });
  });

  it("persists the classifier-to-durable-source identity used by candidate review", () => {
    const dated = source({ publicationTimestamp: NOW, publicationDatePrecision: "exact" });
    const accepted = classifyDiscoveredTimelineSource(company(), [dated], dated);
    expect(accepted.isMeaningfulEvent).toBe(true);
    const payload = timelineCandidatePayloadWithDurableSource(
      accepted,
      dated.id,
      "96be6d99-ffec-4d64-995a-88ff8aefbbf2",
    );

    expect(payload.durableSourceMap).toEqual({
      "source-acme-funding": "96be6d99-ffec-4d64-995a-88ff8aefbbf2",
    });
    expect(payload.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: "source-acme-funding",
        sourceDocumentId: "96be6d99-ffec-4d64-995a-88ff8aefbbf2",
        supports: expect.arrayContaining(["eventDate", "title", "summary"]),
      }),
    ]));
  });

  it("projects every contradictory direct claim as durable review evidence", () => {
    const tierOne = source({
      id: "funding-primary",
      text: "Acme raised a $5M seed round.",
      title: "Acme raised a $5M seed round.",
      evidenceExcerpt: "Acme raised a $5M seed round.",
      publicationTimestamp: "2026-08-02T12:00:00.000Z",
      sourceQualityTier: 1,
    });
    const tierTwo = source({
      id: "funding-alternate",
      url: "https://news.example/acme-funding",
      text: "Acme raised a $7M seed round.",
      title: "Acme raised a $7M seed round.",
      evidenceExcerpt: "Acme raised a $7M seed round.",
      publicationTimestamp: "2026-08-03T12:00:00.000Z",
      sourceQualityTier: 2,
      sourceType: "news_article",
      publisher: "Example News",
      authorRelationship: "third_party",
    });
    const classification = classifyDiscoveredTimelineSource(company(), [tierOne, tierTwo], tierOne);
    expect(classification.isMeaningfulEvent).toBe(true);
    if (!classification.isMeaningfulEvent) throw new Error("Expected a conflict candidate.");

    const rows = timelineEventEvidenceRows("event-conflict", classification, new Map([
      [tierOne.id, { sourceDocumentId: "document-primary", sourceEventDate: "2026-08-02" }],
      [tierTwo.id, { sourceDocumentId: "document-alternate", sourceEventDate: "2026-08-03" }],
    ]));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_document_id: "document-primary",
        evidence_role: "primary",
        is_conflicting: false,
        supports_quantitative_claim: true,
      }),
      expect.objectContaining({
        source_document_id: "document-alternate",
        evidence_role: "conflicting",
        is_conflicting: true,
        supports_event_date: false,
        supports_quantitative_claim: false,
        conflict_description: expect.stringMatching(/disagree/i),
        extracted_claims: expect.objectContaining({
          eventDate: "2026-08-03",
          conflicts: expect.arrayContaining([
            expect.objectContaining({ field: "funding_amount", value: "$7M", selectedValue: "$5M" }),
          ]),
        }),
      }),
    ]));
  });

  it("projects material classifier conflicts into public artifact warnings", () => {
    const primary = source({
      id: "funding-primary",
      text: "Acme raised a $5M seed round.",
      title: "Acme raised a $5M seed round.",
      evidenceExcerpt: "Acme raised a $5M seed round.",
      sourceQualityTier: 1,
    });
    const alternate = source({
      id: "funding-alternate",
      url: "https://other-news.example/acme-funding",
      text: "Acme raised a $7M seed round.",
      title: "Acme raised a $7M seed round.",
      evidenceExcerpt: "Acme raised a $7M seed round.",
    });
    const classification = classifyDiscoveredTimelineSource(company(), [primary, alternate], primary);
    if (!classification.isMeaningfulEvent) throw new Error("Expected a material conflict fixture.");

    const projected = projectTimelineProposalConflicts([classification], false);

    expect(projected).toMatchObject({
      hasConflict: true,
      summary: expect.stringMatching(/funding amount/i),
    });
    expect(projected.descriptionsBySource.get("funding-primary")).toBeUndefined();
    expect(projected.descriptionsBySource.get("funding-alternate")).toMatch(/funding amount/i);
  });
});

function timelinePersistenceClient(tables: Record<string, Array<Record<string, unknown>>>) {
  const upserts: Record<string, Array<Record<string, unknown>>> = {};
  const reads: Array<{ table: string; from: number; to: number }> = [];
  const client = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const query = {
        select() { return query; },
        in(column: string, values: readonly unknown[]) {
          rows = rows.filter((row) => values.includes(row[column]));
          return query;
        },
        upsert(values: unknown) {
          const next = Array.isArray(values) ? values : [values];
          upserts[table] = next as Array<Record<string, unknown>>;
          return query;
        },
        range(from: number, to: number) {
          reads.push({ table, from, to });
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
        then<TResult1 = { data: null; error: null }, TResult2 = never>(
          onfulfilled?: ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve({ data: null, error: null }).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  };
  return { client: client as never, upserts, reads };
}

function conflictLookupClient(tables: Record<string, Array<Record<string, unknown>>>) {
  const filters: Array<{ table: string; column: string; value: unknown }> = [];
  const client = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const query = {
        select() { return query; },
        in(column: string, values: readonly unknown[]) {
          rows = rows.filter((row) => values.includes(row[column]));
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push({ table, column, value });
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        limit(value: number) {
          rows = rows.slice(0, value);
          return query;
        },
        maybeSingle() {
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then<TResult1 = { data: Array<Record<string, unknown>>; error: null }, TResult2 = never>(
          onfulfilled?: ((value: { data: Array<Record<string, unknown>>; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  };
  return { client: client as never, filters };
}

class MemoryPersistence implements TimelineDiscoveryPersistence {
  readonly terminalCoverage = new Map<string, Record<string, string>>();

  async markCoverage(company: TimelineIngestionCompany, sourceClass: TimelineSourceClass, status: string): Promise<void> {
    if (["pending", "running", "retry_pending", "rate_limited"].includes(status)) return;
    const current = this.terminalCoverage.get(company.databaseId) ?? {};
    current[sourceClass] = status;
    this.terminalCoverage.set(company.databaseId, current);
  }
  async persistSources() { return { sourceDocuments: 0, candidates: 0, publishedEvents: 0, unresolvedDates: 0 }; }
  async finalizeCompanies() {}
}

class MemoryTaskStore {
  readonly tasks: IngestionTaskRow[] = [];
  readonly events: JsonObject[] = [];
  requeueExpiredCalls = 0;

  async enqueueTasks(inputs: readonly EnqueueTaskInput[]): Promise<IngestionTaskRow[]> {
    for (const input of inputs) {
      if (this.tasks.some((task) => task.checkpoint_key === input.checkpointKey)) continue;
      this.tasks.push(taskRow(input, this.tasks.length));
    }
    return this.tasks.filter((task) => inputs.some((input) => input.checkpointKey === task.checkpoint_key));
  }
  async claimTasks(input: { workerId: string; runId?: string | null; platform?: string | null; limit?: number }): Promise<IngestionTaskRow[]> {
    const selected = this.tasks.filter((task) => task.ingestion_run_id === input.runId
        && (!input.platform || task.platform === input.platform)
        && ["queued", "retry_scheduled"].includes(task.status))
      .sort((left, right) => right.priority - left.priority)
      .slice(0, input.limit ?? 1);
    for (const task of selected) {
      task.status = "running";
      task.attempts += 1;
      task.locked_by = input.workerId;
      task.lease_token = `lease-${task.id}-${task.attempts}`;
      task.lease_expires_at = "2099-01-01T00:00:00.000Z";
    }
    return selected;
  }
  async requeueExpiredTasks() {
    this.requeueExpiredCalls += 1;
    return [];
  }
  async completeTask(input: { taskId: string; status?: "completed" | "needs_review" | "blocked_or_empty" | "skipped"; terminalReason?: string }) {
    const task = this.task(input.taskId);
    task.status = input.status ?? "completed";
    task.terminal_reason = input.terminalReason ?? task.status;
    task.terminal_at = NOW;
    task.locked_by = null;
    task.lease_token = null;
    return task;
  }
  async rescheduleTask(input: { taskId: string; nextAttemptAt: string; message: string }) {
    const task = this.task(input.taskId);
    task.status = "retry_scheduled";
    task.next_attempt_at = input.nextAttemptAt;
    task.last_error = input.message;
    task.locked_by = null;
    task.lease_token = null;
    return task;
  }
  async deadLetterTask(input: { taskId: string; terminalReason?: string; message: string }) {
    const task = this.task(input.taskId);
    task.status = "dead_lettered";
    task.terminal_reason = input.terminalReason ?? "dead_lettered";
    task.terminal_at = NOW;
    task.last_error = input.message;
    task.locked_by = null;
    task.lease_token = null;
    return task;
  }
  async persistCoverageReport(input: PersistCoverageReportInput): Promise<IngestionCoverageReportRow> {
    return { ...input, id: "coverage", ingestion_run_id: input.runId } as unknown as IngestionCoverageReportRow;
  }
  async appendEvent(input: AppendRunEventInput): Promise<IngestionRunEventRow> {
    this.events.push(input.payload ?? {});
    return { ...input, id: "event", ingestion_run_id: input.runId } as unknown as IngestionRunEventRow;
  }
  private task(id: string) { return this.tasks.find((task) => task.id === id)!; }
}

function company(): TimelineIngestionCompany {
  return {
    id: "company-acme",
    databaseId: "db-company-acme",
    batchId: "db-batch",
    slug: "acme",
    name: "Acme",
    aliases: ["Acme"],
    websiteUrl: "https://acme.example",
    profileUrl: "https://www.ycombinator.com/companies/acme",
    founderNames: ["Alice Founder"],
    existingEvidenceCount: 2,
  };
}

function source(overrides: Partial<TimelineClassificationSource> = {}): TimelineClassificationSource {
  return {
    id: "source-acme-funding",
    url: "https://news.example/acme-funding",
    title: "Acme raised a $5M seed round",
    publisher: "Example News",
    sourceType: "news_article",
    platform: "web",
    publicationTimestamp: NOW,
    publicationDatePrecision: "exact",
    text: "Acme raised a $5M seed round to expand its product.",
    evidenceExcerpt: "Acme raised a $5M seed round to expand its product.",
    sourceQualityTier: 2,
    attributionStatus: "verified",
    linkStatus: "verified",
    topic: null,
    authorRelationship: "third_party",
    ...overrides,
  };
}

function graphEvidence(): EvidenceItem {
  return {
    id: "graph-acme-funding",
    entityType: "company",
    entityId: "company-acme",
    platform: "linkedin",
    authorName: "Acme",
    authorHandle: "acme",
    postedAt: NOW,
    publishedAtPrecision: "exact",
    title: "Acme raised a $5M seed round",
    text: "Acme raised a $5M seed round to expand its product.",
    mediaType: "text",
    metrics: { likes: 50 },
    contributionScore: 25,
    sourceUrl: "https://www.linkedin.com/posts/acme-funding",
    why: "Verified company announcement.",
    review_state: "verified",
    linkStatus: "verified",
  };
}

function taskRow(input: EnqueueTaskInput, index: number): IngestionTaskRow {
  return {
    id: `task-${index}`,
    ingestion_run_id: input.runId,
    batch_id: input.batchId ?? null,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    company_name: input.companyName,
    platform: input.platform,
    status: "queued",
    attempts: 0,
    checkpoint_key: input.checkpointKey,
    rate_limit_ms: input.rateLimitMs ?? 0,
    last_error: null,
    locked_by: null,
    locked_at: null,
    max_attempts: input.maxAttempts ?? 3,
    priority: input.priority ?? 0,
    next_attempt_at: null,
    last_attempt_at: null,
    retry_base_delay_seconds: input.retryBaseDelaySeconds ?? 0,
    lease_token: null,
    lease_expires_at: null,
    terminal_at: null,
    terminal_reason: null,
    last_failure_kind: null,
    last_error_json: {},
    created_at: NOW,
    updated_at: NOW,
  };
}

function artifactBundle(
  id: string,
  title: string,
  url: string,
  overrides: {
    category?: "funding" | "product_launch";
    eventDate?: string;
    eventDateType?: "announcement_date" | "occurrence_date";
  } = {},
) {
  const evidence = {
    id: `source-${id}`,
    title,
    publisher: "Publisher",
    domain: new URL(url).hostname,
    sourceType: "news_article" as const,
    publishedAt: NOW,
    evidenceRole: "primary" as const,
    url,
    publicationDate: NOW,
    excerpt: title,
    sourceEventDate: overrides.eventDate ?? "2026-08-02",
    isConflicting: false,
    conflictDescription: null,
  };
  const event = {
    id,
    eventDate: overrides.eventDate ?? "2026-08-02",
    eventDateType: overrides.eventDateType ?? "announcement_date" as const,
    title,
    summary: `${title}.`,
    category: overrides.category ?? "funding" as const,
    isMajor: false,
    hasConflict: false,
    conflictSummary: null,
    evidenceCount: 1,
    sourcePreview: [{
      id: evidence.id,
      title: evidence.title,
      publisher: evidence.publisher,
      domain: evidence.domain,
      sourceType: evidence.sourceType,
      publishedAt: evidence.publishedAt,
      evidenceRole: evidence.evidenceRole,
      url: evidence.url,
    }],
  };
  return { event, detail: { ...event, evidence: [evidence], posts: [] } };
}
