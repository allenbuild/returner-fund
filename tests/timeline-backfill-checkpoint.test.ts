import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeTimelineBackfillBuildFingerprint,
  loadCanonicalTimelinePublicDiscoveryInventory,
  runCompanyTimelineBackfill,
} from "@/lib/timeline/backfill";
import type { EvidenceItem, GraphResponse } from "@/lib/graph/types";
import type { TimelineDatabaseSnapshot } from "@/lib/timeline/database-backfill";
import { canonicalizeSourceUrl } from "@/lib/timeline/source-document";

const GENERATED_AT = "2026-08-02T12:00:00.000Z";
const FULL_CORPUS_SOURCE_PATHS = [
  "src/lib/social/public-evidence-current.json",
  "src/lib/social/logged-in-evidence-current.json",
  "src/lib/social/targeted-evidence-current.json",
  "src/lib/social/volume-evidence-current.json",
] as const;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Company Timeline backfill checkpoint integrity", () => {
  it("fingerprints deterministic transitive source contents instead of a manual version", async () => {
    const root = await temporaryRoot();
    const sourceRoot = join(root, "src", "lib", "timeline");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "backfill.ts"), [
      'import { dedupe } from "./dedupe";',
      "export const build = dedupe;",
      "",
    ].join("\n"));
    await writeFile(join(sourceRoot, "dedupe.ts"), [
      'import { canonicalize } from "./source-document";',
      "export const dedupe = canonicalize;",
      "",
    ].join("\n"));
    await writeFile(join(sourceRoot, "source-document.ts"), "export const canonicalize = 'v1';\n");

    const first = await computeTimelineBackfillBuildFingerprint(root);
    const repeated = await computeTimelineBackfillBuildFingerprint(root);
    await writeFile(join(sourceRoot, "source-document.ts"), "export const canonicalize = 'v2';\n");
    const changed = await computeTimelineBackfillBuildFingerprint(root);

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(repeated).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("rejects a corrupt detail hash and atomically self-heals the company", async () => {
    const root = await timelineFixtureRoot();
    const first = await backfill(root);
    expect(first).toMatchObject({ processedCompanies: 1, resumedCompanies: 0, publishedEvents: 1 });

    const eventPath = await firstDetailPath(root);
    const validBytes = await readFile(eventPath);
    await writeFile(eventPath, Buffer.concat([validBytes, Buffer.from("corrupt")]));

    const repaired = await backfill(root);
    expect(repaired).toMatchObject({ processedCompanies: 1, resumedCompanies: 0, publishedEvents: 1 });
    await expect(readJson(eventPath)).resolves.toMatchObject({
      schemaVersion: "company-timeline-event.v1",
      company: { id: "company-acme" },
    });

    const resumed = await backfill(root);
    expect(resumed).toMatchObject({ processedCompanies: 0, resumedCompanies: 1, publishedEvents: 1 });
  });

  it("validates detail schema and cross-artifact content even when its checkpoint hash is rewritten", async () => {
    const root = await timelineFixtureRoot();
    await backfill(root);
    const eventPath = await firstDetailPath(root);
    const detail = await readJson(eventPath) as Record<string, unknown>;
    detail.company = { id: "company-other", slug: "other", name: "Other" };
    const corruptedBytes = serialized(detail);
    await writeFile(eventPath, corruptedBytes);

    const checkpointPath = join(root, "work", "timeline-backfill-checkpoint.json");
    const checkpoint = await readJson(checkpointPath) as {
      detailArtifacts: Record<string, Array<{ path: string; sha256: string }>>;
    };
    checkpoint.detailArtifacts["company-acme"]![0]!.sha256 = sha256(corruptedBytes);
    await writeFile(checkpointPath, serialized(checkpoint));

    const repaired = await backfill(root);
    expect(repaired).toMatchObject({ processedCompanies: 1, resumedCompanies: 0 });
    await expect(readJson(eventPath)).resolves.toMatchObject({
      company: { id: "company-acme", slug: "acme", name: "Acme" },
    });
  });

  it("unions verified volume evidence into company timelines without weakening date gating", async () => {
    const root = await timelineFixtureRoot();
    const volumePath = join(root, "src", "lib", "social", "volume-evidence-current.json");
    await mkdir(join(root, "src", "lib", "social"), { recursive: true });
    await writeFile(volumePath, serialized({
      source: { fetchedAt: "2026-08-03T12:00:00.000Z" },
      evidence: [
        {
          id: "volume-funding",
          entityType: "company",
          entityId: "company-acme",
          companySlug: "acme",
          platform: "linkedin",
          authorName: "Acme",
          authorHandle: "acme",
          postedAt: "2026-08-02T10:00:00.000Z",
          publishedAtPrecision: "exact",
          title: "Acme raised a $10M Series A",
          text: "Acme raised a $10M Series A to expand its product.",
          sourceUrl: "https://www.linkedin.com/posts/acme_series-a-activity-456",
          metrics: { reactions: 100 },
          contributionScore: 50,
          review_state: "verified",
          linkStatus: "verified",
        },
        {
          id: "volume-founder-without-date",
          entityType: "founder",
          entityId: "founder-acme-alex-1",
          companySlug: "acme",
          platform: "linkedin",
          authorName: "Alex",
          authorHandle: "alex",
          postedAt: null,
          publishedAtPrecision: "unknown",
          title: "Acme reached 100 customers",
          text: "Acme reached 100 customers.",
          sourceUrl: "https://www.linkedin.com/posts/alex_milestone-activity-789",
          metrics: {},
          contributionScore: 0,
          review_state: "verified",
          linkStatus: "verified",
        },
      ],
    }));

    const result = await runCompanyTimelineBackfill({
      rootDir: root,
      volumeEvidencePath: "src/lib/social/volume-evidence-current.json",
      databaseSnapshot: emptyDatabaseSnapshot(),
      env: {} as NodeJS.ProcessEnv,
      logger: () => {},
    });
    expect(result).toMatchObject({ processedCompanies: 1, publishedEvents: 2, candidateEvents: 1 });
    const artifact = await readJson(join(root, "public", "timelines", "companies", "acme.json")) as {
      events: Array<{ title: string }>;
    };
    expect(artifact.events.map((event) => event.title)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Acme announced \$10M Series A/),
    ]));
    expect(artifact.events.map((event) => event.title)).toEqual(expect.arrayContaining([
      expect.stringMatching(/\$5M/),
    ]));
  });

  it("keeps full canonical source parity while deduplicating capped preview rows", async () => {
    const root = await timelineFixtureRoot();
    const canonicalEvidence = [
      evidence({
        id: "full-public-duplicate-of-preview",
        postedAt: "2026-08-01T10:00:00.000Z",
        title: "Acme raised a $5M seed round",
        text: "Acme raised a $5M seed round to expand its product.",
        sourceUrl: "https://www.linkedin.com/posts/acme_seed-funding-activity-123",
      }),
      evidence({
        id: "full-public-product-launch",
        platform: "web",
        postedAt: "2026-05-01T10:00:00.000Z",
        title: "Acme launched Acme Cloud",
        text: "Acme launched Acme Cloud for development teams.",
        sourceUrl: "https://acme.example/news/acme-cloud-launch",
      }),
      evidence({
        id: "full-logged-in-traction",
        entityType: "founder",
        entityId: "founder-acme-alex-1",
        attachedCompanyId: "company-acme",
        platform: "x",
        postedAt: "2026-06-01T10:00:00.000Z",
        title: "Acme reached 1,000 customers",
        text: "Acme reached 1,000 customers this month.",
        sourceUrl: "https://x.com/alex/status/1000",
      }),
      evidence({
        id: "full-targeted-partnership",
        platform: "rss",
        postedAt: "2026-07-01T10:00:00.000Z",
        title: "Acme partnered with Beta Corp",
        text: "Acme partnered with Beta Corp to distribute Acme Cloud.",
        sourceUrl: "https://acme.example/feed/beta-partnership",
      }),
    ];

    const result = await runCompanyTimelineBackfill({
      rootDir: root,
      canonicalEvidenceSnapshot: { evidence: canonicalEvidence },
      volumeEvidencePath: null,
      databaseSnapshot: emptyDatabaseSnapshot(),
      env: {} as NodeJS.ProcessEnv,
      logger: () => {},
    });
    expect(result).toMatchObject({
      processedCompanies: 1,
      publishedEvents: 4,
      candidateEvents: 0,
    });

    const artifact = await readJson(join(root, "public", "timelines", "companies", "acme.json")) as {
      events: Array<{ sourcePreview: Array<{ url: string }> }>;
    };
    const sourceUrls = artifact.events.flatMap((event) => event.sourcePreview.map((source) => source.url));
    expect(sourceUrls).toHaveLength(4);
    expect(new Set(sourceUrls)).toEqual(new Set([
      "https://acme.example/feed/beta-partnership",
      "https://acme.example/news/acme-cloud-launch",
      "https://www.linkedin.com/posts/acme_seed-funding-activity-123",
      "https://x.com/alex/status/1000",
    ]));
  });

  it("matches every mapped full graph evidence identity beyond the capped previews", async () => {
    const graphPaths = ["s2026.json", "s26.json", "a16zsr006.json"];
    const graphs = await Promise.all(graphPaths.map(async (filename) => JSON.parse(await readFile(
      join(process.cwd(), "public", "graph", filename),
      "utf8",
    )) as GraphResponse));
    const { yc2026GraphDataset } = await import("@/lib/graph/yc-spring-2026-dataset");
    const inventory = await loadCanonicalTimelinePublicDiscoveryInventory(process.cwd());
    const fullCorpusArtifacts = inventory.sourceArtifacts.filter((artifact) =>
      (FULL_CORPUS_SOURCE_PATHS as readonly string[]).includes(artifact.path));
    expect(fullCorpusArtifacts.map((artifact) => artifact.path)).toEqual(FULL_CORPUS_SOURCE_PATHS);
    for (const artifact of fullCorpusArtifacts) {
      expect(artifact.sha256).toBe(sha256(await readFile(join(process.cwd(), artifact.path))));
    }
    expect(fullCorpusArtifacts.filter((artifact) =>
      artifact.path === "src/lib/social/volume-evidence-current.json")).toHaveLength(1);
    const companyIds = new Set(
      graphs.flatMap((graph) => graph.nodes)
        .filter((node) => node.entityType === "company")
        .map((node) => node.entityId),
    );
    const founderCompanyIdById = new Map(
      graphs.flatMap((graph) => graph.nodes)
        .filter((node) => node.entityType === "company")
        .flatMap((node) => node.founders.map((founder) => [founder.id, node.entityId] as const)),
    );
    const previewKeys = new Set(graphs.flatMap((graph) => graph.evidence).map(timelineEvidenceKey));
    const fullSourceOnlyKeys = new Set(
      yc2026GraphDataset.evidence.map(timelineEvidenceKey).filter((key) => !previewKeys.has(key)),
    );
    expect(fullSourceOnlyKeys.size).toBeGreaterThan(1_000);

    const expectedByCompany = new Map<string, Set<string>>();
    for (const item of [
      ...graphs.flatMap((graph) => graph.evidence),
      ...yc2026GraphDataset.evidence,
    ]) {
      const companyId = item.attachedCompanyId && companyIds.has(item.attachedCompanyId)
        ? item.attachedCompanyId
        : item.entityType === "company" && companyIds.has(item.entityId)
          ? item.entityId
          : founderCompanyIdById.get(item.entityId);
      if (!companyId) continue;
      const keys = expectedByCompany.get(companyId) ?? new Set<string>();
      keys.add(timelineEvidenceKey(item));
      expectedByCompany.set(companyId, keys);
    }

    expect(inventory.companies.map((company) => [company.id, company.existingEvidenceCount]))
      .toEqual(inventory.companies.map((company) => [
        company.id,
        expectedByCompany.get(company.id)?.size ?? 0,
      ]));
  }, 120_000);

  it("invalidates resume when a direct full-corpus source digest changes", async () => {
    const root = await timelineFixtureRoot();
    const initialSourceArtifacts = await writeFullCorpusSourceArtifacts(root, "initial");
    const initialOptions = {
      rootDir: root,
      resume: true,
      canonicalEvidenceSnapshot: { evidence: [], sourceArtifacts: initialSourceArtifacts },
      volumeEvidencePath: null,
      databaseSnapshot: emptyDatabaseSnapshot(),
      env: {} as NodeJS.ProcessEnv,
      logger: () => {},
    };

    await expect(runCompanyTimelineBackfill(initialOptions)).resolves.toMatchObject({
      processedCompanies: 1,
      resumedCompanies: 0,
    });
    await expect(runCompanyTimelineBackfill(initialOptions)).resolves.toMatchObject({
      processedCompanies: 0,
      resumedCompanies: 1,
    });

    const coverage = await readJson(join(root, "artifacts", "company-timeline", "coverage.json")) as {
      sourceArtifacts: Array<{ path: string; sha256: string }>;
    };
    const fullCorpusArtifacts = coverage.sourceArtifacts.filter((artifact) =>
      (FULL_CORPUS_SOURCE_PATHS as readonly string[]).includes(artifact.path));
    expect(fullCorpusArtifacts).toEqual(initialSourceArtifacts);
    expect(fullCorpusArtifacts.filter((artifact) =>
      artifact.path === "src/lib/social/volume-evidence-current.json")).toHaveLength(1);

    const changedSourceArtifacts = await writeFullCorpusSourceArtifacts(root, "public-changed");
    await expect(runCompanyTimelineBackfill({
      ...initialOptions,
      canonicalEvidenceSnapshot: { evidence: [], sourceArtifacts: changedSourceArtifacts },
    })).resolves.toMatchObject({
      processedCompanies: 1,
      resumedCompanies: 0,
    });

    const checkpoint = await readJson(join(root, "work", "timeline-backfill-checkpoint.json")) as {
      sourceArtifacts: Array<{ path: string; sha256: string }>;
    };
    expect(checkpoint.sourceArtifacts.find((artifact) =>
      artifact.path === "src/lib/social/public-evidence-current.json")?.sha256)
      .toBe(changedSourceArtifacts[0]?.sha256);
    expect(changedSourceArtifacts[0]?.sha256).not.toBe(initialSourceArtifacts[0]?.sha256);
  });
});

async function timelineFixtureRoot(): Promise<string> {
  const root = await temporaryRoot();
  const graphDirectory = join(root, "public", "graph");
  await mkdir(graphDirectory, { recursive: true });
  await writeFile(join(graphDirectory, "fixture.json"), serialized({
    batch: { slug: "fixture", label: "Fixture", companyCountObserved: 1 },
    batches: [{ slug: "fixture", label: "Fixture", companyCountObserved: 1 }],
    nodes: [{
      id: "node-company-acme",
      entityType: "company",
      entityId: "company-acme",
      label: "Acme",
      batchSlug: "fixture",
      websiteUrl: "https://acme.example",
      sourceUrl: "https://acme.example/about",
      founders: [],
    }],
    evidence: [{
      id: "evidence-acme-seed",
      entityType: "company",
      entityId: "company-acme",
      platform: "linkedin",
      authorName: "Acme",
      authorHandle: "acme",
      postedAt: "2026-08-01T10:00:00.000Z",
      publishedAtPrecision: "exact",
      title: "Acme raised a $5M seed round",
      text: "Acme raised a $5M seed round to expand its product.",
      mediaType: "text",
      metrics: { likes: 50 },
      contributionScore: 25,
      sourceUrl: "https://www.linkedin.com/posts/acme_seed-funding-activity-123",
      why: "fixture",
      review_state: "verified",
      linkStatus: "verified",
    }],
    edges: [],
    leaderboard: [],
    fastestGaining: [],
    needsReview: [],
    platformStatus: [],
    topVoiceAudiences: [],
    selectedTopVoiceAudience: {
      id: "off", displayName: "Off", description: "", helperText: "",
      scoreLabel: "Score", scoreDescription: "", active: true, memberCount: 0,
    },
    generatedAt: GENERATED_AT,
    mode: "official_snapshot",
  }));
  return root;
}

async function backfill(rootDir: string) {
  return runCompanyTimelineBackfill({
    rootDir,
    resume: true,
    databaseSnapshot: emptyDatabaseSnapshot(),
    env: {} as NodeJS.ProcessEnv,
    logger: () => {},
  });
}

function emptyDatabaseSnapshot(): TimelineDatabaseSnapshot {
  return {
    status: "not_configured",
    byCompanySourceKey: new Map(),
    sha256: "fixture-database-sha256",
    generatedAt: null,
    publishedEvents: 0,
    limitations: "fixture",
  };
}

async function firstDetailPath(root: string): Promise<string> {
  const artifact = await readJson(join(root, "public", "timelines", "companies", "acme.json")) as {
    events: Array<{ id: string }>;
  };
  const eventId = artifact.events[0]?.id;
  if (!eventId) throw new Error("Expected a published fixture event.");
  return join(root, "public", "timelines", "events", `${eventId}.json`);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "timeline-checkpoint-"));
  temporaryRoots.push(root);
  return root;
}

async function writeFullCorpusSourceArtifacts(
  root: string,
  publicRevision: string,
): Promise<Array<{ path: string; sha256: string }>> {
  const artifacts: Array<{ path: string; sha256: string }> = [];
  await mkdir(join(root, "src", "lib", "social"), { recursive: true });
  for (const path of FULL_CORPUS_SOURCE_PATHS) {
    const body = serialized({
      source: { fetchedAt: GENERATED_AT },
      evidence: [],
      revision: path === "src/lib/social/public-evidence-current.json" ? publicRevision : "stable",
    });
    const absolutePath = join(root, path);
    await writeFile(absolutePath, body);
    artifacts.push({ path, sha256: sha256(body) });
  }
  return artifacts;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function serialized(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function evidence(overrides: Partial<EvidenceItem> & Pick<EvidenceItem, "id" | "postedAt" | "sourceUrl" | "text">): EvidenceItem {
  return {
    entityType: "company",
    entityId: "company-acme",
    platform: "linkedin",
    authorName: "Acme",
    authorHandle: "acme",
    publishedAtPrecision: "exact",
    mediaType: "text",
    metrics: {},
    contributionScore: 25,
    why: "canonical graph evidence fixture",
    review_state: "verified",
    linkStatus: "verified",
    ...overrides,
  };
}

function timelineEvidenceKey(item: EvidenceItem): string {
  return `${item.platform}|${item.platformObjectId ?? item.platformPostId ?? ""}|${canonicalizeSourceUrl(item.sourceUrl)}`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
