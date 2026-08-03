import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION,
  TIMELINE_PUBLIC_DISCOVERY_SCHEMA_VERSION,
  TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES,
  loadTimelinePublicDiscoverySnapshot,
  runFileBackedTimelinePublicDiscovery,
} from "@/lib/timeline/file-discovery";
import {
  dispatchTimelineSourceClass,
  type TimelineIngestionCompany,
} from "@/lib/timeline/ingestion-runner";
import {
  loadCanonicalTimelinePublicDiscoveryInventory,
  runCompanyTimelineBackfill,
} from "@/lib/timeline/backfill";

const roots: string[] = [];
const INVENTORY_SHA = "a".repeat(64);
const FIRST_SCAN = "2026-08-02T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file-backed Timeline public discovery", () => {
  it("runs only a bounded shard, persists direct sources, and resumes at the next company", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-public-discovery-"));
    roots.push(root);
    const outputPath = join(root, "snapshot.json");
    const discover = vi.fn(async (sourceClass: string, company: TimelineIngestionCompany) => ({
      status: sourceClass === "timeline_official_site" ? "completed" as const : "no_results" as const,
      reason: "test",
      sources: sourceClass === "timeline_official_site" ? [{
        id: `source-${company.id}`,
        url: `${company.websiteUrl}/news/launch?utm_source=test`,
        originalUrl: `${company.websiteUrl}/news/launch?utm_source=test`,
        canonicalUrl: `${company.websiteUrl}/news/launch`,
        title: `${company.name} launched Widget`,
        publisher: company.name,
        author: null,
        sourceType: "company_blog" as const,
        platform: "web",
        publicationTimestamp: "2026-07-31T00:00:00.000Z",
        updatedTimestamp: null,
        publicationDatePrecision: "exact" as const,
        text: `${company.name} launched Widget for public customers.`,
        evidenceExcerpt: `${company.name} launched Widget for public customers.`,
        sourceQualityTier: 1 as const,
        attributionStatus: "verified" as const,
        linkStatus: "verified" as const,
        topic: null,
        authorRelationship: "company" as const,
        httpStatus: 200,
        metadata: { authorization: "must-not-be-persisted", safe: "also-omitted" },
      }] : [],
    }));

    const first = await runFileBackedTimelinePublicDiscovery({
      companies: [company("company-b"), company("company-a")],
      inventorySha256: INVENTORY_SHA,
      outputPath,
      maxCompanies: 1,
      concurrency: 1,
      now: () => new Date(FIRST_SCAN),
      discover,
      providers: [],
    });
    expect(first).toMatchObject({ selectedCompanies: 1, scannedCompanies: 1, sourceDocuments: 1 });
    expect(discover).toHaveBeenCalledTimes(TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES.length);

    const stored = await loadTimelinePublicDiscoverySnapshot(outputPath);
    expect(stored?.snapshot.companies).toHaveLength(1);
    expect(stored?.snapshot.companies[0]).toMatchObject({
      companyId: "company-a",
      coverage: {
        timeline_official_site: "completed",
        timeline_institutional_sources: "no_results",
        timeline_historical_archive: "no_results",
      },
    });
    expect(stored?.snapshot.companies[0]?.sources[0]).toMatchObject({
      canonicalUrl: "https://company-a.example/news/launch",
      publicationTimestamp: "2026-07-31T00:00:00.000Z",
    });
    expect(stored?.snapshot.companies[0]?.sources[0]).not.toHaveProperty("metadata");

    discover.mockClear();
    const second = await runFileBackedTimelinePublicDiscovery({
      companies: [company("company-b"), company("company-a")],
      inventorySha256: INVENTORY_SHA,
      outputPath,
      maxCompanies: 1,
      concurrency: 1,
      now: () => new Date("2026-08-02T12:00:30.000Z"),
      discover,
      providers: [],
    });
    expect(second).toMatchObject({ selectedCompanies: 1, scannedCompanies: 1 });
    expect((await loadTimelinePublicDiscoverySnapshot(outputPath))?.snapshot.companies.map((item) => item.companyId))
      .toEqual(["company-a", "company-b"]);
  });

  it("resumes an incomplete company immediately instead of deferring it for the freshness window", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-public-discovery-partial-"));
    roots.push(root);
    const outputPath = join(root, "snapshot.json");
    await writeFile(outputPath, JSON.stringify({
      schemaVersion: TIMELINE_PUBLIC_DISCOVERY_SCHEMA_VERSION,
      runnerVersion: TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION,
      generatedAt: "2026-08-02T12:00:00Z",
      inventorySha256: INVENTORY_SHA,
      companies: [{
        companyId: "company-a",
        companyName: "Company A",
        scannedAt: "2026-08-02T12:00:00Z",
        coverage: { timeline_official_site: "completed" },
        sources: [],
      }],
    }));
    const discover = vi.fn(async () => ({ status: "no_results" as const, reason: "test", sources: [] }));
    const receipt = await runFileBackedTimelinePublicDiscovery({
      companies: [company("company-a")],
      inventorySha256: INVENTORY_SHA,
      outputPath,
      maxCompanies: 1,
      concurrency: 1,
      now: () => new Date("2026-08-02T12:00:01.000Z"),
      discover,
      providers: [],
    });
    expect(receipt).toMatchObject({ selectedCompanies: 1, scannedCompanies: 1 });
    expect(discover).toHaveBeenCalledTimes(TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES.length);
    expect((await loadTimelinePublicDiscoverySnapshot(outputPath))?.snapshot.companies[0]?.coverage)
      .toMatchObject(Object.fromEntries(TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES.map((sourceClass) => [sourceClass, "no_results"])));
  });

  it("serializes concurrent snapshot commits without losing a company", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-public-discovery-concurrent-"));
    roots.push(root);
    const outputPath = join(root, "snapshot.json");
    const companies = ["company-a", "company-b", "company-c", "company-d"].map(company);
    await runFileBackedTimelinePublicDiscovery({
      companies,
      inventorySha256: INVENTORY_SHA,
      outputPath,
      maxCompanies: companies.length,
      concurrency: companies.length,
      now: () => new Date(FIRST_SCAN),
      providers: [],
      discover: async (sourceClass, current) => ({
        status: sourceClass === "timeline_official_site" ? "completed" : "no_results",
        reason: "test",
        sources: sourceClass === "timeline_official_site" ? [sourceFor(current)] : [],
      }),
    });
    expect((await loadTimelinePublicDiscoverySnapshot(outputPath))?.snapshot.companies.map((item) => item.companyId))
      .toEqual(companies.map((item) => item.id));
  });

  it("preserves last-good verified sources when a later complete scan fails or finds no results", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-public-discovery-preserve-"));
    roots.push(root);
    const outputPath = join(root, "snapshot.json");
    const target = company("company-a");
    await writeFile(outputPath, JSON.stringify({
      schemaVersion: TIMELINE_PUBLIC_DISCOVERY_SCHEMA_VERSION,
      runnerVersion: TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION,
      generatedAt: FIRST_SCAN,
      inventorySha256: INVENTORY_SHA,
      companies: [{
        companyId: target.id,
        companyName: target.name,
        scannedAt: FIRST_SCAN,
        coverage: Object.fromEntries(TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES.map((sourceClass) => [sourceClass, "completed"])),
        sources: [sourceFor(target)],
      }],
    }));
    await runFileBackedTimelinePublicDiscovery({
      companies: [target],
      inventorySha256: INVENTORY_SHA,
      outputPath,
      maxCompanies: 1,
      concurrency: 1,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      providers: [],
      discover: async (sourceClass) => ({
        status: sourceClass === "timeline_official_site" ? "failed" : "no_results",
        reason: "transient",
        sources: [],
      }),
    });
    expect((await loadTimelinePublicDiscoverySnapshot(outputPath))?.snapshot.companies[0]?.sources)
      .toEqual([expect.objectContaining({ id: `source-${target.id}` })]);
  });

  it("does not start a public fetch after the shared deadline expires", async () => {
    const startedAt = Date.now();
    const result = await dispatchTimelineSourceClass("timeline_official_site", company("company-a"), {
      networkAllowed: true,
      perFetchTimeoutMs: 12_000,
      providers: [],
      deadlineAt: Date.now() - 1,
    });
    expect(result).toMatchObject({
      status: "blocked",
      reason: "bounded_timeline_discovery_budget_exhausted",
      sources: [],
    });
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it("fails closed on an unsupported or malformed cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-public-discovery-invalid-"));
    roots.push(root);
    const outputPath = join(root, "snapshot.json");
    await writeFile(outputPath, JSON.stringify({
      schemaVersion: "company-timeline-public-discovery.v0",
      runnerVersion: "unknown",
      generatedAt: FIRST_SCAN,
      inventorySha256: INVENTORY_SHA,
      companies: [],
    }));
    await expect(loadTimelinePublicDiscoverySnapshot(outputPath)).rejects.toThrow(/unsupported version/i);
  });

  it("never serializes page metadata or reflected credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-public-discovery-secret-"));
    roots.push(root);
    const outputPath = join(root, "snapshot.json");
    await runFileBackedTimelinePublicDiscovery({
      companies: [company("company-a")],
      inventorySha256: INVENTORY_SHA,
      outputPath,
      maxCompanies: 1,
      concurrency: 1,
      now: () => new Date(FIRST_SCAN),
      providers: [],
      discover: async (sourceClass) => ({
        status: sourceClass === "timeline_official_site" ? "completed" : "no_results",
        reason: "test",
        sources: sourceClass === "timeline_official_site" ? [{
          id: "safe-source",
          url: "https://company-a.example/launch",
          title: "Company A launch",
          publisher: "Company A",
          sourceType: "company_page",
          platform: "web",
          publicationTimestamp: "2026-07-31T00:00:00.000Z",
          publicationDatePrecision: "exact",
          text: "Company A launched its product.",
          evidenceExcerpt: "Company A launched its product.",
          sourceQualityTier: 1,
          attributionStatus: "verified",
          linkStatus: "verified",
          topic: null,
          authorRelationship: "company",
          metadata: { apiKey: "reflected-secret-value" },
        }] : [],
      }),
    });
    expect(await readFile(outputPath, "utf8")).not.toContain("reflected-secret-value");
  });

  it("feeds verified cache sources into deterministic public artifact classification", async () => {
    const inventory = await loadCanonicalTimelinePublicDiscoveryInventory(process.cwd());
    const target = inventory.companies[0]!;
    const databaseSnapshot = {
      status: "not_configured" as const,
      byCompanySourceKey: new Map(),
      sha256: "not-configured",
      generatedAt: null,
      publishedEvents: 0,
      limitations: "test",
    };
    const baseline = await runCompanyTimelineBackfill({
      dryRun: true,
      maxCompanies: 1,
      databaseSnapshot,
      logger: () => undefined,
    });
    const discovered = await runCompanyTimelineBackfill({
      dryRun: true,
      maxCompanies: 1,
      databaseSnapshot,
      logger: () => undefined,
      publicDiscoverySnapshot: {
        schemaVersion: TIMELINE_PUBLIC_DISCOVERY_SCHEMA_VERSION,
        runnerVersion: TIMELINE_PUBLIC_DISCOVERY_RUNNER_VERSION,
        generatedAt: FIRST_SCAN,
        inventorySha256: inventory.inventorySha256,
        companies: [{
          companyId: target.id,
          companyName: target.name,
          scannedAt: FIRST_SCAN,
          coverage: Object.fromEntries(TIMELINE_PUBLIC_DISCOVERY_SOURCE_CLASSES.map((sourceClass) => [sourceClass, "completed"])),
          sources: [{
            id: "file-backed-series-z",
            url: `${target.websiteUrl ?? "https://example.com"}/news/series-z`,
            title: `${target.name} announced Series Z funding`,
            publisher: target.name,
            sourceType: "press_release",
            platform: "web",
            publicationTimestamp: "2024-01-02T00:00:00.000Z",
            publicationDatePrecision: "exact",
            text: `We raised $123 million in Series Z funding for ${target.name}.`,
            evidenceExcerpt: `We raised $123 million in Series Z funding for ${target.name}.`,
            sourceQualityTier: 1,
            attributionStatus: "verified",
            linkStatus: "verified",
            topic: null,
            authorRelationship: "company",
          }],
        }],
      },
    });
    expect(discovered.publishedEvents).toBe(baseline.publishedEvents + 1);
  });
});

function company(id: string): TimelineIngestionCompany {
  return {
    id,
    databaseId: id,
    batchId: "S2026",
    slug: id,
    name: id.replace("company-", "Company ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    aliases: [],
    websiteUrl: `https://${id}.example`,
    profileUrl: `https://www.ycombinator.com/companies/${id.replace("company-", "")}`,
    founderNames: [],
    existingEvidenceCount: 0,
  };
}

function sourceFor(company: TimelineIngestionCompany) {
  return {
    id: `source-${company.id}`,
    url: `${company.websiteUrl}/news/launch`,
    canonicalUrl: `${company.websiteUrl}/news/launch`,
    title: `${company.name} launched Widget`,
    publisher: company.name,
    sourceType: "company_blog" as const,
    platform: "web",
    publicationTimestamp: "2026-07-31T00:00:00.000Z",
    publicationDatePrecision: "exact" as const,
    text: `${company.name} launched Widget for public customers.`,
    evidenceExcerpt: `${company.name} launched Widget for public customers.`,
    sourceQualityTier: 1 as const,
    attributionStatus: "verified" as const,
    linkStatus: "verified" as const,
    topic: null,
    authorRelationship: "company" as const,
    httpStatus: 200,
  };
}
