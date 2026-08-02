import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TimelineArtifactValidationError, validateTimelineArtifacts } from "../scripts/validate-timeline-artifacts.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("timeline artifact validator", () => {
  it("keeps the directly served coverage index free of private operational fields and values", async () => {
    const publicIndex = JSON.parse(await readFile(
      path.join(process.cwd(), "public", "timelines", "coverage.json"),
      "utf8",
    ));
    expect(Object.keys(publicIndex).sort()).toEqual([
      "companyCount",
      "generatedAt",
      "publishedEventCount",
      "schemaVersion",
    ]);

    const serialized = JSON.stringify(publicIndex).toLowerCase();
    for (const forbidden of [
      "candidateeventcount", "unresolveddatecount", "unresolvedconflictcount",
      "sourcecoverage", "lasterror", "historicalbackfillstatus", "status",
      "authentication_required", "retry_pending", "rate_limited", "no_results",
      "timeline_existing_evidence", "historical_backfill",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("accepts a complete exact-date, direct-evidence inventory", async () => {
    const fixture = await writeFixture();
    const result = await validateTimelineArtifacts({ rootDir: fixture, now: new Date("2026-08-02T12:00:00Z") });

    expect(result).toMatchObject({
      inventoryRecords: 3,
      uniqueCompanies: 1,
      terminalUniqueCompanies: 1,
      publishedEvents: 1,
    });
  });

  it("rejects tracking URLs in public evidence", async () => {
    const fixture = await writeFixture({ sourceUrl: "https://acme.example/launch?utm_source=test" });

    await expect(validateTimelineArtifacts({ rootDir: fixture, now: new Date("2026-08-02T12:00:00Z") }))
      .rejects.toSatisfy((error) => error instanceof TimelineArtifactValidationError
        && error.violations.some((violation) => violation.includes("tracking parameter")));
  });
});

async function writeFixture({ sourceUrl = "https://acme.example/launch" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "returner-timeline-validator-"));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(path.join(root, "public", "graph"), { recursive: true }),
    mkdir(path.join(root, "public", "timelines", "companies"), { recursive: true }),
    mkdir(path.join(root, "public", "timelines", "events"), { recursive: true }),
    mkdir(path.join(root, "artifacts", "company-timeline"), { recursive: true }),
  ]);
  const generatedAt = "2026-08-02T10:00:00.000Z";
  const company = { id: "company-acme", slug: "acme", name: "Acme" };
  const graphDefinitions = [
    ["s2026.json", "S2026"],
    ["s26.json", "S26"],
    ["a16zsr006.json", "A16ZSR006"],
  ];
  const sourceArtifacts = [];
  for (const [filename, batchSlug] of graphDefinitions) {
    const relative = `public/graph/${filename}`;
    const body = JSON.stringify({ nodes: [{ entityType: "company", entityId: company.id, label: company.name, batchSlug }] });
    await writeFile(path.join(root, relative), body);
    sourceArtifacts.push({ path: relative, sha256: sha256(body) });
  }

  const source = {
    id: "source-acme-launch",
    title: "Acme launch announcement",
    publisher: "Acme",
    domain: "acme.example",
    sourceType: "company_post",
    publishedAt: "2026-01-02T09:00:00.000Z",
    evidenceRole: "primary",
    url: sourceUrl,
  };
  const event = {
    id: "event-acme-launch",
    eventDate: "2026-01-02",
    eventDateType: "announcement_date",
    title: "Launched Acme for public access",
    summary: "Acme announced public access to its first product for development teams.",
    category: "product_launch",
    isMajor: true,
    hasConflict: false,
    conflictSummary: null,
    evidenceCount: 1,
    sourcePreview: [source],
  };
  const companyArtifact = {
    schemaVersion: "company-timeline.v1",
    company,
    generatedAt,
    lastModifiedAt: generatedAt,
    events: [event],
    groups: [{ year: 2026, months: [{ month: "2026-01", count: 1 }] }],
    coverage: { status: "complete", publishedEventCount: 1, lastSuccessfulArtifactAt: generatedAt },
    nextCursor: null,
  };
  const companyBody = JSON.stringify(companyArtifact);
  await writeFile(path.join(root, "public", "timelines", "companies", "acme.json"), companyBody);

  const detail = {
    schemaVersion: "company-timeline-event.v1",
    company,
    event: {
      ...event,
      evidence: [{
        ...source,
        publicationDate: "2026-01-02T09:00:00.000Z",
        excerpt: "Acme is now publicly available to development teams.",
        sourceEventDate: "2026-01-02",
        isConflicting: false,
        conflictDescription: null,
      }],
      posts: [],
    },
    generatedAt,
    lastModifiedAt: generatedAt,
  };
  await writeFile(path.join(root, "public", "timelines", "events", `${event.id}.json`), JSON.stringify(detail));

  const inventory = [[company.id, { name: company.name, batches: graphDefinitions.map(([, batch]) => batch) }]];
  const coverage = {
    schemaVersion: "company-timeline-coverage.v1",
    generatedAt,
    inventorySha256: sha256(JSON.stringify(inventory)),
    sourceArtifacts,
    totals: {
      inventoryRecords: 3,
      uniqueCompanies: 1,
      terminalUniqueCompanies: 1,
      completeCompanies: 1,
      partialCompanies: 0,
      failedCompanies: 0,
      publishedEvents: 1,
      candidates: 0,
      unresolvedConflicts: 0,
      unresolvedDates: 0,
    },
    companies: [{
      company,
      artifactPath: "public/timelines/companies/acme.json",
      artifactSha256: sha256(companyBody),
      status: "complete",
      sourceCoverage: { existing_evidence: "completed" },
      publishedEventCount: 1,
      candidateEventCount: 0,
      unresolvedConflictCount: 0,
      unresolvedDateCount: 0,
      lastSuccessfulArtifactAt: generatedAt,
      lastError: null,
    }],
  };
  await writeFile(path.join(root, "artifacts", "company-timeline", "coverage.json"), JSON.stringify(coverage));
  await writeFile(path.join(root, "public", "timelines", "coverage.json"), JSON.stringify({
    schemaVersion: "company-timeline-public-index.v1",
    generatedAt,
    companyCount: coverage.totals.uniqueCompanies,
    publishedEventCount: coverage.totals.publishedEvents,
  }));
  return root;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
