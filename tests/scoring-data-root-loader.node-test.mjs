import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceRoot = process.cwd();
const loaderPath = path.join(sourceRoot, "scripts", "lib", "scoring-diagnostics-ts-loader.mjs");
const builderPath = path.join(sourceRoot, "scripts", "build-topic-facets.mjs");
const scoringPath = path.join(sourceRoot, "scripts", "run-scoring-diagnostics-v4.mjs");
const sourceProbePath = path.join(sourceRoot, "tests", "fixtures", "topic-facet-boundary-probe.ts");
const fullGraphRoutePath = path.join(sourceRoot, "src", "app", "api", "graph", "full", "route.ts");

test("pinned loader resolves extensionless legacy package subpaths used by the full graph route", () => {
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--loader",
    loaderPath,
    "--input-type=module",
    "-e",
    `const route = await import(${JSON.stringify(pathToFileURL(fullGraphRoutePath).href)}); if (typeof route.GET !== "function") throw new Error("full graph GET export missing"); console.log("full-graph-route-imported");`
  ], {
    cwd: sourceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SCORING_DATA_ROOT: undefined,
      SCORING_ROOT: undefined
    },
    timeout: 20_000
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /full-graph-route-imported/);
});

test("topic facet execution pins TS while consuming alias and relative JSON from the explicit data root", async (t) => {
  const fixture = await createTargetRoot({ alias: true, relative: true, maliciousTargetCode: true });
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));

  const result = runProbe(fixture.root, fixture.marker);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(payload.aliasValue, "publication-alias");
  assert.equal(payload.relativeValue, "publication-relative");
  assert.equal(payload.moduleUrl, pathToFileURL(sourceProbePath).href);
  await assert.rejects(access(fixture.marker), { code: "ENOENT" });
});

test("explicit data root fails closed when aliased JSON is missing", async (t) => {
  const fixture = await createTargetRoot({ alias: false, relative: true });
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));

  const result = runProbe(fixture.root, fixture.marker);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required in-repository JSON: src[/\\]lib[/\\]yc[/\\]summer-2026-companies\.json/);
  assert.doesNotMatch(result.stdout, /pinned-source-relative/);
});

test("explicit data root fails closed when relative JSON is missing", async (t) => {
  const fixture = await createTargetRoot({ alias: true, relative: false });
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));

  const result = runProbe(fixture.root, fixture.marker);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required in-repository JSON: tests[/\\]fixtures[/\\]topic-facet-boundary-relative\.json/);
});

test("explicit data-root JSON may not escape through a symlink", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await createTargetRoot({ alias: true, relative: false });
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const outside = path.join(fixture.parent, "outside.json");
  await writeFile(outside, '{"fixtureValue":"outside"}\n');
  const relativePath = path.join(fixture.root, "tests", "fixtures", "topic-facet-boundary-relative.json");
  await symlink(outside, relativePath);

  const result = runProbe(fixture.root, fixture.marker);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Resolved scoring JSON escapes the configured data root/);
});

test("scoring diagnostics report pinned code SHA while writing only publication-root outputs", async (t) => {
  const fixture = await createTargetRoot({ alias: true, relative: true, maliciousTargetCode: true });
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  await writeFile(
    path.join(fixture.root, "scripts", "run-scoring-diagnostics-v4.mjs"),
    'import { writeFileSync } from "node:fs"; writeFileSync(process.env.TARGET_CODE_SENTINEL, "executed");\n'
  );
  runGit(fixture.root, ["init", "-b", "main"]);
  runGit(fixture.root, ["config", "user.name", "Target Fixture"]);
  runGit(fixture.root, ["config", "user.email", "target@example.com"]);
  runGit(fixture.root, ["add", "."]);
  runGit(fixture.root, ["commit", "-m", "malicious target code and mutable data"]);
  const targetSha = runGit(fixture.root, ["rev-parse", "HEAD^{commit}"]).stdout.trim();
  const sourceSha = runGit(sourceRoot, ["rev-parse", "HEAD^{commit}"]).stdout.trim();
  assert.notEqual(targetSha, sourceSha);

  const sourceAuditPath = path.join(sourceRoot, "docs", "outputs", "scoring-diagnostics-v4-audit.json");
  const sourceReportPath = path.join(sourceRoot, "docs", "outputs", "scoring-diagnostics-v4-report.md");
  const [sourceAuditBefore, sourceReportBefore] = await Promise.all([
    readFile(sourceAuditPath),
    readFile(sourceReportPath)
  ]);
  const result = runScoringRootFixture(fixture.root, fixture.marker, sourceSha);
  assert.equal(result.status, 0, result.stderr);

  const targetAudit = JSON.parse(await readFile(
    path.join(fixture.root, "docs", "outputs", "scoring-diagnostics-v4-audit.json"),
    "utf8"
  ));
  assert.equal(targetAudit.fixture, "scoring-root-interface");
  assert.equal(targetAudit.codeRoot, await realpath(sourceRoot));
  assert.equal(targetAudit.dataRoot, await realpath(fixture.root));
  assert.equal(targetAudit.sourceSha, sourceSha);
  assert.notEqual(targetAudit.sourceSha, targetSha);
  assert.deepEqual(await readFile(sourceAuditPath), sourceAuditBefore);
  assert.deepEqual(await readFile(sourceReportPath), sourceReportBefore);
  await assert.rejects(access(fixture.marker), { code: "ENOENT" });

  const mismatch = runScoringRootFixture(fixture.root, fixture.marker, "f".repeat(40));
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Pinned scoring source SHA mismatch/);
});

async function createTargetRoot({ alias, relative, maliciousTargetCode = false }) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "returner-scoring-root-"));
  const root = path.join(parent, "publication");
  const marker = path.join(parent, "target-code-executed");
  await Promise.all([
    mkdir(path.join(root, "src", "lib", "yc"), { recursive: true }),
    mkdir(path.join(root, "tests", "fixtures"), { recursive: true }),
    mkdir(path.join(root, "scripts"), { recursive: true })
  ]);
  await writeFile(path.join(root, "package.json"), '{"name":"publication-data-fixture"}\n');
  if (alias) {
    await writeFile(
      path.join(root, "src", "lib", "yc", "summer-2026-companies.json"),
      '{"fixtureValue":"publication-alias","companies":[]}\n'
    );
  }
  if (relative) {
    await writeFile(
      path.join(root, "tests", "fixtures", "topic-facet-boundary-relative.json"),
      '{"fixtureValue":"publication-relative"}\n'
    );
  }
  if (maliciousTargetCode) {
    const sentinel = [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.env.TARGET_CODE_SENTINEL, "executed");',
      'export const topicFacetBoundaryProbe = { moduleUrl: import.meta.url };',
      ""
    ].join("\n");
    await writeFile(path.join(root, "tests", "fixtures", "topic-facet-boundary-probe.ts"), sentinel);
    await writeFile(path.join(root, "scripts", "build-topic-facets.mjs"), sentinel);
  }
  return { parent, root, marker };
}

function runProbe(targetRoot, marker) {
  return spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--loader",
    loaderPath,
    builderPath,
    `--root=${targetRoot}`,
    "--boundary-probe"
  ], {
    cwd: sourceRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test",
      SCORING_DATA_ROOT: targetRoot,
      TARGET_CODE_SENTINEL: marker
    },
    timeout: 20_000
  });
}

function runScoringRootFixture(targetRoot, marker, sourceSha) {
  return spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--loader",
    loaderPath,
    scoringPath,
    `--root=${targetRoot}`,
    `--expected-source-sha=${sourceSha}`,
    "--root-interface-test-fixture"
  ], {
    cwd: sourceRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test",
      SCORING_DATA_ROOT: targetRoot,
      TARGET_CODE_SENTINEL: marker
    },
    timeout: 20_000
  });
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
