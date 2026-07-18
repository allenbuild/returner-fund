import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildArtifactManifest,
  validateArtifactManifest,
  writeArtifactManifest
} from "../scripts/lib/artifact-manifest.mjs";
import { main, parseArgs } from "../scripts/write-artifact-manifest.mjs";

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
      schemaVersion: 1,
      publishedAt,
      ingestionRunId: "ingestion-run-42",
      evidenceCollectedAt: "2026-07-18T14:00:00.000Z",
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
    expect(parseArgs(["--ingestion-run-id=run-7", "--validate"])).toEqual({
      ingestionRunId: "run-7",
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
      const validated = await main(["--root-dir", rootDir, "--validate"], {});
      expect(validated.status).toBe("valid");
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
  await writeJson(path.join(rootDir, "public", "graph", "s2026.json"), graphFixture());
  await writeJson(
    path.join(rootDir, "public", "graph", "s2026-insiders.json"),
    graphFixture({ generatedAt: "2026-07-18T14:31:00.000Z" })
  );
  await writeJson(
    path.join(rootDir, "outputs", "benchmarks", "s2026-score-benchmarks.json"),
    benchmarkFixture()
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

function benchmarkFixture() {
  return {
    version: 1,
    batchSlug: "S2026",
    updatedAt: "2026-07-18T14:45:00.000Z",
    daily: [{ scoringModelVersion: "4.0.0" }],
    weekly: []
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}
