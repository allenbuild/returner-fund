import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND,
  ARTIFACT_DERIVED_EVIDENCE_KIND,
  buildArtifactManifest,
  buildSupportingArtifactManifest,
  validateArtifactManifest,
  writeArtifactManifest
} from "../scripts/lib/artifact-manifest.mjs";
import {
  main,
  parseArgs
} from "../scripts/write-artifact-manifest.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact publication manifest", () => {
  it("records graph and benchmark integrity metadata and writes atomically", async () => {
    const rootDir = await fixtureRoot();
    const publishedAt = "2026-07-18T15:00:00.000Z";
    const { manifest, manifestPath } = await writeArtifactManifest({
      rootDir,
      ingestionRunId: "ingestion-run-42",
      publishedAt
    });

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      publishedAt,
      ingestionRunId: "ingestion-run-42",
      evidenceCollectedAt: "2026-07-18T14:00:00.000Z",
      evidenceCollectedAtKind: ARTIFACT_DERIVED_EVIDENCE_KIND,
      oldestPlatformRefreshAt: "2026-07-18T12:00:00.000Z",
      modelVersions: ["returner-traction@4.0.0"],
      models: [{ id: "returner-traction", version: "4.0.0", name: "canonical" }]
    });
    expect(manifest.graphArtifacts.map((entry) => entry.filename)).toEqual([
      "s2026-insiders.json",
      "s2026.json"
    ]);
    expect(manifest.benchmarkArtifacts.map((entry) => entry.filename)).toEqual([
      "s2026-score-benchmarks.json"
    ]);
    expect(manifest.graphArtifacts[1]).toMatchObject({
      byteSize: expect.any(Number),
      generatedAt: "2026-07-18T14:30:00.000Z",
      modelVersion: "4.0.0",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(manifest.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(manifest);
    expect((await readdir(path.dirname(manifestPath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const validation = await validateArtifactManifest({ rootDir });
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);

    const legacyValidation = await validateArtifactManifest(
      { ...manifest, schemaVersion: 1 },
      { rootDir }
    );
    expect(legacyValidation.ok).toBe(false);
    expect(legacyValidation.errors).toContain("Unsupported manifest schemaVersion: 1.");
  });

  it("detects changed files, missing files, and stale or absent references", async () => {
    const rootDir = await fixtureRoot();
    const manifest = await buildArtifactManifest({
      rootDir,
      ingestionRunId: "ingestion-run-42",
      publishedAt: "2026-07-18T15:00:00.000Z"
    });

    await writeFile(
      path.join(rootDir, "public", "graph", "s2026.json"),
      `${JSON.stringify(graphFixture({ generatedAt: "2026-07-18T14:31:00.000Z" }))}\n`
    );
    await unlink(path.join(rootDir, "public", "graph", "s2026-insiders.json"));
    await writeJson(
      path.join(rootDir, "outputs", "benchmarks", "new-score-benchmarks.json"),
      benchmarkFixture()
    );

    const result = await validateArtifactManifest(manifest, { rootDir });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/Changed graph file s2026\.json/);
    expect(result.errors.join("\n")).toMatch(/Missing graph file.*s2026-insiders\.json/);
    expect(result.errors.join("\n")).toMatch(/Unreferenced benchmark file.*new-score-benchmarks\.json/);
    expect(result.errors.join("\n")).toMatch(/Overall content hash changed/);
  });

  it("accepts CLI arguments or environment provenance and validates after writing", async () => {
    const rootDir = await fixtureRoot();
    expect(parseArgs([
      "--ingestion-run-id=run-7",
      `--evidence-collected-at-kind=${ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND}`,
      "--validate"
    ])).toEqual({
      ingestionRunId: "run-7",
      evidenceCollectedAtKind: ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND,
      validate: true
    });

    const originalLog = console.log;
    console.log = () => undefined;
    try {
      const written = await main(
        ["--root-dir", rootDir, "--published-at", "2026-07-18T15:00:00.000Z"],
        { ARTIFACT_INGESTION_RUN_ID: "env-run-9" }
      );
      expect(written.status).toBe("written");
      expect(JSON.parse(
        await readFile(path.join(rootDir, "public", "graph", "manifest.json"), "utf8")
      ).evidenceCollectedAtKind).toBe(ARTIFACT_DERIVED_EVIDENCE_KIND);
      const validated = await main(["--root-dir", rootDir, "--validate"], {});
      expect(validated.status).toBe("valid");
    } finally {
      console.log = originalLog;
    }
  });

  it("advances accepted collection freshness without new rows and preserves it across benchmark rewrites", async () => {
    const rootDir = await fixtureRoot();
    const originalLog = console.log;
    console.log = () => undefined;
    try {
      await expect(main([
        "--root-dir", rootDir,
        "--published-at", "2026-07-18T14:50:00.000Z",
        "--evidence-collected-at", "2026-07-18T14:10:00.000Z"
      ], { ARTIFACT_INGESTION_RUN_ID: "unmarked-run" })).rejects.toThrow(
        /requires both --evidence-collected-at and --evidence-collected-at-kind/
      );

      await main([
        "--root-dir", rootDir,
        "--published-at", "2026-07-18T14:50:00.000Z",
        "--evidence-collected-at", "2026-07-18T14:10:00.000Z",
        "--evidence-collected-at-kind", ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND
      ], { ARTIFACT_INGESTION_RUN_ID: "accepted-run-1" });
      let manifest = JSON.parse(
        await readFile(path.join(rootDir, "public", "graph", "manifest.json"), "utf8")
      );
      expect(manifest.evidenceCollectedAt).toBe("2026-07-18T14:10:00.000Z");
      expect(manifest.evidenceCollectedAtKind).toBe(
        ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND
      );

      await main([
        "--root-dir", rootDir,
        "--published-at", "2026-07-18T15:00:00.000Z",
        "--evidence-collected-at", "2026-07-18T14:50:00.000Z",
        "--evidence-collected-at-kind", ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND
      ], { ARTIFACT_INGESTION_RUN_ID: "accepted-run-2" });
      manifest = JSON.parse(
        await readFile(path.join(rootDir, "public", "graph", "manifest.json"), "utf8")
      );
      expect(manifest.evidenceCollectedAt).toBe("2026-07-18T14:50:00.000Z");
      expect(manifest.evidenceCollectedAtKind).toBe(
        ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND
      );
      expect(JSON.parse(
        await readFile(path.join(rootDir, "public", "graph", "s2026.json"), "utf8")
      ).scoringContext.evidenceAsOf).toBe("2026-07-18T14:00:00.000Z");

      await expect(main([
        "--root-dir", rootDir,
        "--published-at", "2026-07-18T15:01:00.000Z",
        "--evidence-collected-at", "2026-07-18T14:40:00.000Z",
        "--evidence-collected-at-kind", ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND
      ], { ARTIFACT_INGESTION_RUN_ID: "regressing-run" })).rejects.toThrow(
        /cannot regress below existing accepted timestamp/
      );
      manifest = JSON.parse(
        await readFile(path.join(rootDir, "public", "graph", "manifest.json"), "utf8")
      );
      expect(manifest.ingestionRunId).toBe("accepted-run-2");
      expect(manifest.evidenceCollectedAt).toBe("2026-07-18T14:50:00.000Z");

      await writeJson(
        path.join(rootDir, "outputs", "benchmarks", "s2026-score-benchmarks.json"),
        benchmarkFixture({ updatedAt: "2026-07-18T15:05:00.000Z" })
      );
      await main([
        "--root-dir", rootDir,
        "--published-at", "2026-07-18T15:10:00.000Z"
      ], { ARTIFACT_INGESTION_RUN_ID: manifest.ingestionRunId });
      manifest = JSON.parse(
        await readFile(path.join(rootDir, "public", "graph", "manifest.json"), "utf8")
      );
      expect(manifest.evidenceCollectedAt).toBe("2026-07-18T14:50:00.000Z");
      expect(manifest.evidenceCollectedAtKind).toBe(
        ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND
      );
      expect(manifest.benchmarkArtifacts[0].generatedAt).toBe("2026-07-18T15:05:00.000Z");

      const validated = await main(["--root-dir", rootDir, "--validate"], {});
      expect(validated.status).toBe("valid");
    } finally {
      console.log = originalLog;
    }
  });

  it("fails closed on missing or future collection provenance", async () => {
    const rootDir = await fixtureRoot();
    await expect(buildArtifactManifest({
      rootDir,
      ingestionRunId: "unmarked-run",
      publishedAt: "2026-07-18T15:00:00.000Z",
      evidenceCollectedAt: "2026-07-18T14:50:00.000Z"
    })).rejects.toThrow(/requires evidenceCollectedAtKind=accepted-full-collection/);
    await expect(buildArtifactManifest({
      rootDir,
      ingestionRunId: "future-run",
      publishedAt: "2026-07-18T15:00:00.000Z",
      evidenceCollectedAt: "2026-07-18T15:00:01.000Z",
      evidenceCollectedAtKind: ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND
    })).rejects.toThrow(/cannot be newer than publishedAt/);
    await expect(buildArtifactManifest({
      rootDir,
      ingestionRunId: "future-publication-run",
      publishedAt: "2026-07-18T15:00:00.000Z",
      evidenceCollectedAt: "2026-07-18T14:50:00.000Z",
      evidenceCollectedAtKind: ACCEPTED_FULL_COLLECTION_EVIDENCE_KIND,
      now: "2026-07-18T14:59:59.000Z"
    })).rejects.toThrow(/publishedAt cannot be in the future/);

    const manifest = await buildArtifactManifest({
      rootDir,
      ingestionRunId: "missing-run",
      publishedAt: "2026-07-18T15:00:00.000Z"
    });
    delete manifest.evidenceCollectedAt;
    const missing = await validateArtifactManifest(manifest, { rootDir });
    expect(missing.ok).toBe(false);
    expect(missing.errors).toContain(
      "Manifest evidenceCollectedAt must be an ISO-8601 timestamp."
    );

    const legacy = { ...manifest };
    delete legacy.evidenceCollectedAtKind;
    const legacyValidation = await validateArtifactManifest(legacy, { rootDir });
    expect(legacyValidation.ok).toBe(false);
    expect(legacyValidation.errors).toContain(
      "Manifest evidenceCollectedAtKind must be accepted-full-collection or artifact-derived."
    );
  });

  it("binds derived authenticated and public bundles to a compact deterministic catalog", async () => {
    const rootDir = await fixtureRoot();
    const originalLog = console.log;
    console.log = () => undefined;
    try {
      const written = await main(
        ["--root-dir", rootDir, "--published-at", "2026-07-18T15:00:00.000Z"],
        { ARTIFACT_INGESTION_RUN_ID: "derived-run-1" }
      );
      expect(written.supportingArtifacts).toBe(5);

      const manifest = JSON.parse(
        await readFile(path.join(rootDir, "public", "graph", "manifest.json"), "utf8")
      );
      expect(manifest.supportingArtifacts.map(({ key }) => key)).toEqual([
        "authenticatedEvidenceLedger",
        "topicFacets",
        "rankedPostsSidecar",
        "timelines",
        "scoringDiagnostics"
      ]);
      expect(manifest.supportingArtifacts.every((entry) =>
        entry.fileCount >= 1 &&
        Number.isSafeInteger(entry.totalByteSize) &&
        /^[a-f0-9]{64}$/.test(entry.contentHash) &&
        !Object.hasOwn(entry, "files")
      )).toBe(true);

      const first = await buildSupportingArtifactManifest({ rootDir });
      const second = await buildSupportingArtifactManifest({ rootDir });
      expect(second).toEqual(first);
      expect(await validateArtifactManifest(manifest, { rootDir })).toMatchObject({
        ok: true,
        errors: []
      });

      await writeFile(
        path.join(rootDir, "public", "topic-facets", "s2026.json"),
        JSON.stringify({ changed: true })
      );
      const stale = await validateArtifactManifest(manifest, { rootDir });
      expect(stale.ok).toBe(false);
      expect(stale.errors).toContain("Supporting artifact topicFacets is stale.");
      expect(stale.errors.join("\n")).toMatch(/Overall content hash changed/);
      expect(stale.current.contentHash).not.toBe(manifest.contentHash);
    } finally {
      console.log = originalLog;
    }
  });
});

async function fixtureRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "artifact-manifest-"));
  roots.push(rootDir);
  await mkdir(path.join(rootDir, "public", "graph"), { recursive: true });
  await mkdir(path.join(rootDir, "outputs", "benchmarks"), { recursive: true });
  await mkdir(path.join(rootDir, "public", "topic-facets"), { recursive: true });
  await mkdir(path.join(rootDir, "public", "timelines", "companies"), { recursive: true });
  await mkdir(path.join(rootDir, "src", "lib", "social"), { recursive: true });
  await mkdir(path.join(rootDir, "src", "lib", "graph"), { recursive: true });
  await mkdir(path.join(rootDir, "docs", "outputs"), { recursive: true });
  await writeJson(path.join(rootDir, "public", "graph", "s2026.json"), graphFixture());
  await writeJson(
    path.join(rootDir, "public", "graph", "s2026-insiders.json"),
    graphFixture({ generatedAt: "2026-07-18T14:31:00.000Z" })
  );
  await writeJson(
    path.join(rootDir, "outputs", "benchmarks", "s2026-score-benchmarks.json"),
    benchmarkFixture()
  );
  await writeJson(
    path.join(rootDir, "outputs", "benchmarks", "daily-publication-receipt.json"),
    {
      schemaVersion: 1,
      kind: "daily-score-benchmark-publication",
      slotKey: "daily-benchmark-2026-07-18"
    }
  );
  await writeJson(
    path.join(rootDir, "src", "lib", "social", "logged-in-evidence-current.json"),
    { schemaVersion: 1, evidence: [] }
  );
  await writeJson(path.join(rootDir, "public", "topic-facets", "s2026.json"), {
    version: "fixture",
    rows: []
  });
  await writeJson(path.join(rootDir, "src", "lib", "graph", "ranked-posts-sidecar.generated.json"), {
    version: "fixture"
  });
  await writeJson(path.join(rootDir, "public", "timelines", "companies", "fixture.json"), {
    generatedAt: "2026-07-18T14:30:00.000Z",
    events: []
  });
  await writeJson(path.join(rootDir, "docs", "outputs", "scoring-diagnostics-v4-audit.json"), {
    generatedAt: "2026-07-18T14:30:00.000Z"
  });
  await writeFile(
    path.join(rootDir, "docs", "outputs", "scoring-diagnostics-v4-report.md"),
    "fixture diagnostics\n"
  );
  return rootDir;
}

function graphFixture({ generatedAt = "2026-07-18T14:30:00.000Z" } = {}) {
  return {
    generatedAt,
    scoringContext: {
      modelId: "returner-traction",
      modelVersion: "4.0.0",
      modelName: "canonical",
      evidenceAsOf: "2026-07-18T14:00:00.000Z"
    },
    platformStatus: [],
    evidence: [
      {
        platform: "github",
        observedAt: "2026-07-18T12:00:00.000Z"
      },
      {
        platform: "x",
        metricsCheckedAt: "2026-07-18T13:00:00.000Z"
      }
    ]
  };
}

function benchmarkFixture({ updatedAt = "2026-07-18T14:45:00.000Z" } = {}) {
  return {
    version: 1,
    batchSlug: "S2026",
    updatedAt,
    daily: [{ scoringModelVersion: "4.0.0" }],
    weekly: []
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}
