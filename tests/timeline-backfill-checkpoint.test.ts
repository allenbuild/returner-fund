import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeTimelineBackfillBuildFingerprint,
  runCompanyTimelineBackfill,
} from "@/lib/timeline/backfill";
import type { TimelineDatabaseSnapshot } from "@/lib/timeline/database-backfill";

const GENERATED_AT = "2026-08-02T12:00:00.000Z";
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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function serialized(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
