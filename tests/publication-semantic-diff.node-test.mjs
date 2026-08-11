import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { comparePublicationSemantics } from "../scripts/lib/publication-semantic-diff.mjs";

const execFileAsync = promisify(execFile);
const roots = new Set();
const MODULE_PATH = path.join(process.cwd(), "scripts", "lib", "publication-semantic-diff.mjs");

test.afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test("ignores an exact changed provenance path only when target JSON is valid", async () => {
  const repo = await createRepo();
  await writeJson(path.join(repo, "outputs", "publication-provenance.json"), { runId: "run-2" });
  await commit(repo, "update provenance");

  assert.deepEqual(
    await comparePublicationSemantics({
      rootDir: repo,
      baseRef: "HEAD~1",
      targetRef: "HEAD",
      ignoredPaths: ["outputs/publication-provenance.json"]
    }),
    { changed: false, changedPaths: [] }
  );
  assert.deepEqual(
    await comparePublicationSemantics({ rootDir: repo, baseRef: "HEAD~1", targetRef: "HEAD" }),
    { changed: true, changedPaths: ["outputs/publication-provenance.json"] }
  );
});

test("accepts an array-backed ignored provenance history", async () => {
  const repo = await createRepo();
  await writeJson(path.join(repo, "outputs", "publication-history.json"), [
    { runId: "run-1" },
    { runId: "run-2" }
  ]);
  await commit(repo, "update provenance history");

  assert.deepEqual(
    await comparePublicationSemantics({
      rootDir: repo,
      baseRef: "HEAD~1",
      targetRef: "HEAD",
      ignoredPaths: ["outputs/publication-history.json"]
    }),
    { changed: false, changedPaths: [] }
  );
});

test("normalizes only top-level manifest publishedAt and ingestionRunId", async () => {
  const repo = await createRepo();
  await writeJson(path.join(repo, "public", "graph", "manifest.json"), {
    ...manifestFixture(),
    publishedAt: "2026-08-10T01:00:00.000Z",
    ingestionRunId: "run-2"
  });
  await commit(repo, "refresh manifest metadata");

  assert.deepEqual(
    await comparePublicationSemantics({ rootDir: repo, baseRef: "HEAD~1", targetRef: "HEAD" }),
    { changed: false, changedPaths: [] }
  );
});

test("reports data, contentHash, and artifact hash changes as semantic", async () => {
  const cases = [
    {
      name: "data",
      mutate: async (repo) => writeJson(path.join(repo, "public", "graph", "data.json"), { value: 2 }),
      expected: ["public/graph/data.json"]
    },
    {
      name: "contentHash",
      mutate: async (repo) => updateManifest(repo, { contentHash: "b".repeat(64) }),
      expected: ["public/graph/manifest.json"]
    },
    {
      name: "artifact hash",
      mutate: async (repo) => updateManifest(repo, {
        graphArtifacts: [{ filename: "data.json", sha256: "b".repeat(64) }]
      }),
      expected: ["public/graph/manifest.json"]
    }
  ];

  for (const scenario of cases) {
    const repo = await createRepo();
    await scenario.mutate(repo);
    await commit(repo, `change ${scenario.name}`);
    assert.deepEqual(
      await comparePublicationSemantics({ rootDir: repo, baseRef: "HEAD~1", targetRef: "HEAD" }),
      { changed: true, changedPaths: scenario.expected }
    );
  }
});

test("rejects changed malformed or missing manifest and provenance JSON", async () => {
  {
    const repo = await createRepo();
    await writeFile(path.join(repo, "public", "graph", "manifest.json"), "{not json\n");
    await commit(repo, "break manifest JSON");
    await assert.rejects(
      comparePublicationSemantics({ rootDir: repo, baseRef: "HEAD~1", targetRef: "HEAD" }),
      /manifest\.json is not valid JSON/
    );
  }

  {
    const repo = await createRepo();
    await unlink(path.join(repo, "public", "graph", "manifest.json"));
    await commit(repo, "remove manifest");
    await assert.rejects(
      comparePublicationSemantics({ rootDir: repo, baseRef: "HEAD~1", targetRef: "HEAD" }),
      /manifest\.json is missing at target/
    );
  }

  {
    const repo = await createRepo();
    await writeJson(path.join(repo, "outputs", "publication-provenance.json"), { runId: "run-2" });
    await commit(repo, "add provenance");
    await writeFile(path.join(repo, "outputs", "publication-provenance.json"), "not json\n");
    await commit(repo, "break provenance JSON");
    await assert.rejects(
      comparePublicationSemantics({
        rootDir: repo,
        baseRef: "HEAD~1",
        targetRef: "HEAD",
        ignoredPaths: ["outputs/publication-provenance.json"]
      }),
      /publication-provenance\.json is not valid JSON/
    );
  }

  {
    const repo = await createRepo();
    await writeJson(path.join(repo, "outputs", "publication-provenance.json"), { runId: "run-2" });
    await commit(repo, "add provenance");
    await unlink(path.join(repo, "outputs", "publication-provenance.json"));
    await commit(repo, "remove provenance");
    await assert.rejects(
      comparePublicationSemantics({
        rootDir: repo,
        baseRef: "HEAD~1",
        targetRef: "HEAD",
        ignoredPaths: ["outputs/publication-provenance.json"]
      }),
      /publication-provenance\.json is missing at target/
    );
  }
});

test("validates required manifest and provenance objects even when no path changed", async () => {
  {
    const repo = await createRepo();
    await unlink(path.join(repo, "public", "graph", "manifest.json"));
    await commit(repo, "remove manifest");
    await assert.rejects(
      comparePublicationSemantics({ rootDir: repo, baseRef: "HEAD", targetRef: "HEAD" }),
      /manifest\.json is missing at base/
    );
  }

  {
    const repo = await createRepo();
    await writeFile(path.join(repo, "public", "graph", "manifest.json"), "{broken\n");
    await commit(repo, "break manifest");
    await assert.rejects(
      comparePublicationSemantics({ rootDir: repo, baseRef: "HEAD", targetRef: "HEAD" }),
      /manifest\.json is not valid JSON at base/
    );
  }

  {
    const repo = await createRepo();
    await assert.rejects(
      comparePublicationSemantics({
        rootDir: repo,
        baseRef: "HEAD",
        targetRef: "HEAD",
        ignoredPaths: ["outputs/publication-provenance.json"]
      }),
      /publication-provenance\.json is missing at target/
    );
  }

  {
    const repo = await createRepo();
    await writeFile(path.join(repo, "outputs", "publication-provenance.json"), "null\n");
    await commit(repo, "write scalar provenance");
    await assert.rejects(
      comparePublicationSemantics({
        rootDir: repo,
        baseRef: "HEAD",
        targetRef: "HEAD",
        ignoredPaths: ["outputs/publication-provenance.json"]
      }),
      /must contain a JSON object/
    );
  }
});

test("rejects option-like refs and control-character paths before invoking git", async () => {
  const repo = await createRepo();
  await assert.rejects(
    comparePublicationSemantics({ rootDir: repo, baseRef: "--help", targetRef: "HEAD" }),
    /baseRef is missing or unsafe/
  );
  await assert.rejects(
    comparePublicationSemantics({
      rootDir: repo,
      baseRef: "HEAD",
      targetRef: "HEAD",
      ignoredPaths: ["outputs/bad\nreceipt.json"]
    }),
    /Unsafe repository path/
  );
});

test("compares the staged index and exposes CLI exit codes", async () => {
  const repo = await createRepo();
  await writeJson(path.join(repo, "outputs", "publication-provenance.json"), { runId: "run-2" });
  await execGit(repo, ["add", "outputs/publication-provenance.json"]);

  const noChange = await runCli(repo, ["--root", repo, "--base", "HEAD", "--target", "index", "--ignore", "outputs/publication-provenance.json"]);
  assert.equal(noChange.code, 0);
  assert.deepEqual(JSON.parse(noChange.stdout), { changed: false, changedPaths: [] });

  await writeJson(path.join(repo, "public", "graph", "data.json"), { value: 2 });
  await execGit(repo, ["add", "public/graph/data.json"]);
  const semanticChange = await runCli(repo, [
    "--root", repo, "--base", "HEAD", "--target", "index",
    "--ignore", "outputs/publication-provenance.json"
  ]);
  assert.equal(semanticChange.code, 1);
  assert.deepEqual(JSON.parse(semanticChange.stdout), {
    changed: true,
    changedPaths: ["public/graph/data.json"]
  });

  await writeFile(path.join(repo, "public", "graph", "manifest.json"), "{bad\n");
  await execGit(repo, ["add", "public/graph/manifest.json"]);
  const error = await runCli(repo, ["--root", repo, "--base", "HEAD", "--target", "index"]);
  assert.equal(error.code, 2);
  assert.match(error.stderr, /manifest\.json is not valid JSON/);
});

async function createRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "publication-semantic-diff-"));
  roots.add(repo);
  await execGit(repo, ["init", "-b", "main"]);
  await execGit(repo, ["config", "user.email", "test@example.com"]);
  await execGit(repo, ["config", "user.name", "Publication Diff Test"]);
  await mkdir(path.join(repo, "public", "graph"), { recursive: true });
  await mkdir(path.join(repo, "outputs"), { recursive: true });
  await writeJson(path.join(repo, "public", "graph", "manifest.json"), manifestFixture());
  await writeJson(path.join(repo, "public", "graph", "data.json"), { value: 1 });
  await execGit(repo, ["add", "."]);
  await commit(repo, "base publication");
  return repo;
}

function manifestFixture() {
  return {
    schemaVersion: 1,
    publishedAt: "2026-08-09T01:00:00.000Z",
    ingestionRunId: "run-1",
    contentHash: "a".repeat(64),
    graphArtifacts: [{ filename: "data.json", sha256: "a".repeat(64) }]
  };
}

async function updateManifest(repo, updates) {
  const manifest = JSON.parse(await readFile(path.join(repo, "public", "graph", "manifest.json"), "utf8"));
  await writeJson(path.join(repo, "public", "graph", "manifest.json"), { ...manifest, ...updates });
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function commit(repo, message) {
  await execGit(repo, ["add", "."]);
  await execGit(repo, ["commit", "-m", message]);
}

async function execGit(repo, args) {
  return execFileAsync("git", args, { cwd: repo, maxBuffer: 4 * 1024 * 1024 });
}

function runCli(repo, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MODULE_PATH, ...args], { cwd: repo });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
