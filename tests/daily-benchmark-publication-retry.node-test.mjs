import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectDailyBenchmarkPublicationRetry,
  parseRawGitDelta,
  transplantDailyBenchmarkPublicationCandidate
} from "../scripts/lib/daily-benchmark-publication-retry.mjs";

const temporaryRoots = [];

test.afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("transplants an exact validated benchmark delta across dashboard-only main drift", () => {
  const fixture = createFixture();
  const inspection = transplantDailyBenchmarkPublicationCandidate({
    repositoryRoot: fixture.repository,
    candidateBaseCommit: fixture.base,
    candidateCommit: fixture.candidate,
    retryBaseCommit: fixture.retryBase
  });

  assert.deepEqual(
    inspection.concurrentDelta.map(({ path: filePath }) => filePath).sort(),
    ["artifacts/dashboard/current.json", "public/dashboard/feed.json"]
  );
  assert.equal(git(fixture.repository, "rev-parse", "HEAD"), fixture.retryBase);
  assert.equal(readFileSync(path.join(fixture.repository, "artifacts/dashboard/current.json"), "utf8"), "dashboard-new\n");
  assert.equal(readFileSync(path.join(fixture.repository, "public/dashboard/feed.json"), "utf8"), "feed-new\n");
  assert.equal(readFileSync(path.join(fixture.repository, "outputs/benchmarks/s2026-score-benchmarks.json"), "utf8"), "benchmark-new\n");

  git(fixture.repository, "commit", "-m", "retry candidate");
  const retriedCandidate = git(fixture.repository, "rev-parse", "HEAD");
  assert.equal(git(fixture.repository, "rev-parse", `${retriedCandidate}^`), fixture.retryBase);
  assert.deepEqual(
    rawDelta(fixture.repository, fixture.retryBase, retriedCandidate),
    rawDelta(fixture.repository, fixture.base, fixture.candidate)
  );
});

test("accepts a regular-file subset of the validated dashboard drift allowlist", () => {
  const fixture = createFixture({ concurrentPaths: ["public/dashboard/feed.json"] });
  const inspection = inspectDailyBenchmarkPublicationRetry({
    repositoryRoot: fixture.repository,
    candidateBaseCommit: fixture.base,
    candidateCommit: fixture.candidate,
    retryBaseCommit: fixture.retryBase
  });
  assert.deepEqual(inspection.concurrentDelta.map(({ path: filePath }) => filePath), ["public/dashboard/feed.json"]);
});

test("fails closed when concurrent main changes source or policy", () => {
  const fixture = createFixture({ concurrentPaths: ["scripts/policy.mjs"] });
  assert.throws(
    () => inspectDailyBenchmarkPublicationRetry({
      repositoryRoot: fixture.repository,
      candidateBaseCommit: fixture.base,
      candidateCommit: fixture.candidate,
      retryBaseCommit: fixture.retryBase
    }),
    /only validated regular-file dashboard artifacts/
  );
  assert.equal(git(fixture.repository, "rev-parse", "HEAD"), fixture.retryBase);
});

test("fails closed on concurrent generated-artifact drift even when paths do not overlap", () => {
  const fixture = createFixture({ concurrentPaths: ["public/graph/s2026.json"] });
  assert.throws(
    () => inspectDailyBenchmarkPublicationRetry({
      repositoryRoot: fixture.repository,
      candidateBaseCommit: fixture.base,
      candidateCommit: fixture.candidate,
      retryBaseCommit: fixture.retryBase
    }),
    /only validated regular-file dashboard artifacts/
  );
});

function createFixture({
  concurrentPaths = ["artifacts/dashboard/current.json", "public/dashboard/feed.json"]
} = {}) {
  const repository = mkdtempSync(path.join(os.tmpdir(), "returner-daily-publication-race-"));
  temporaryRoots.push(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Daily Publication Test");
  git(repository, "config", "user.email", "daily-publication@example.com");
  for (const directory of [
    "artifacts/dashboard",
    "outputs/benchmarks",
    "public/dashboard",
    "public/graph",
    "scripts"
  ]) mkdirSync(path.join(repository, directory), { recursive: true });
  write(repository, "artifacts/dashboard/current.json", "dashboard-base\n");
  write(repository, "outputs/benchmarks/s2026-score-benchmarks.json", "benchmark-base\n");
  write(repository, "outputs/benchmarks/daily-publication-receipt.json", "receipt-base\n");
  write(repository, "public/dashboard/feed.json", "feed-base\n");
  write(repository, "public/graph/s2026.json", "graph-base\n");
  write(repository, "scripts/policy.mjs", "export const policy = 'base';\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "base");
  const base = git(repository, "rev-parse", "HEAD");

  write(repository, "outputs/benchmarks/s2026-score-benchmarks.json", "benchmark-new\n");
  write(repository, "outputs/benchmarks/daily-publication-receipt.json", "receipt-new\n");
  git(repository, "add", "outputs/benchmarks");
  git(repository, "commit", "-m", "daily candidate");
  const candidate = git(repository, "rev-parse", "HEAD");

  git(repository, "reset", "--hard", base);
  for (const filePath of concurrentPaths) {
    const content = filePath === "artifacts/dashboard/current.json"
      ? "dashboard-new\n"
      : filePath === "public/dashboard/feed.json"
        ? "feed-new\n"
        : `${filePath}-new\n`;
    write(repository, filePath, content);
  }
  git(repository, "add", ".");
  git(repository, "commit", "-m", "concurrent main");
  const retryBase = git(repository, "rev-parse", "HEAD");
  return { repository, base, candidate, retryBase };
}

function rawDelta(repository, base, target) {
  return parseRawGitDelta(execFileSync("git", [
    "diff", "--raw", "-z", "--no-abbrev", "--no-renames", base, target, "--"
  ], { cwd: repository }), { label: "test delta" });
}

function write(repository, filePath, content) {
  writeFileSync(path.join(repository, filePath), content);
}

function git(repository, ...args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}
