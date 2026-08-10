import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "public-artifacts.yml"),
  "utf8"
);
const packageJson = JSON.parse(
  readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
);

function concurrencyKeys(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)concurrency:\s*$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const keys = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor].trim()) continue;
      const childIndent = /^\s*/.exec(lines[cursor])[0].length;
      if (childIndent <= indent) break;
      if (childIndent === indent + 2) {
        const key = /^\s*([A-Za-z-]+):/.exec(lines[cursor])?.[1];
        if (key) keys.push(key);
      }
    }
    blocks.push(keys);
  }
  return blocks;
}

function expectExactExternalActionPins(source) {
  const uses = Array.from(source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/gm));
  const external = uses.filter((match) => !match[1].startsWith("./"));
  expect(external.length).toBeGreaterThan(0);
  for (const [, action, comment] of external) {
    expect(action).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
    expect(comment).toBe("v4");
  }
}

describe("Public Artifact Validation workflow", () => {
  it("supports exact-SHA reusable validation without canceling another commit", () => {
    expect(workflow).toMatch(/workflow_call:[\s\S]*?target_sha:[\s\S]*?required:\s*true/);
    expect(workflow).toMatch(/workflow_call:[\s\S]*?policy_source_sha:[\s\S]*?required:\s*true/);
    for (const input of [
      "publication_kind",
      "publication_receipt_path",
      "publication_source_sha",
      "publication_slot_key",
      "publication_run_id",
      "publication_run_attempt",
      "publication_trigger",
      "publication_scheduled_at"
    ]) expect(workflow).toContain(`${input}:`);
    expect(workflow).toMatch(/workflow_dispatch:[\s\S]*?target_sha:/);
    expect(workflow).toContain("validated_sha:");
    expect(workflow).toContain("value: ${{ jobs.validate.outputs.validated_sha }}");
    expect(workflow).toContain("group: public-artifacts-${{ inputs.target_sha || github.sha }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(concurrencyKeys(workflow)).toEqual([["group", "cancel-in-progress"]]);
    expect(workflow).not.toMatch(/^\s*queue:/m);
    expectExactExternalActionPins(workflow);
    expect(workflow).toMatch(/for attempt in 1 2 3 4/);
  });

  it("runs independent release gates in parallel behind one required result", () => {
    const applicationCommands = [
      "npm run lint",
      "npm run typecheck",
      "npm run test",
      "npm run test:collectors",
      "npm run test:logged-social",
      "npm run build"
    ];
    expect(packageJson.scripts.check.split(/\s*&&\s*/)).toEqual(applicationCommands);

    for (const [job, command, jobTimeout, gateTimeout] of [
      ["collectors", "npm run test:collectors", 60, 45],
      ["logged_social", "npm run test:logged-social", 30, 15],
      ["build", "npm run build", 35, 20],
      ["scoring", "npm run check:release:scoring", 70, 55],
      ["artifacts", "npm run check:release:artifacts", 70, 55]
    ]) {
      const section = workflow.match(
        new RegExp(`\\n  ${job}:[\\s\\S]*?(?=\\n  [a-z][a-z_-]*:|$)`)
      )?.[0] ?? "";
      expect(section).toContain(`timeout-minutes: ${jobTimeout}`);
      expect(section).toContain("timeout-minutes: 10");
      expect(section).toContain(`timeout-minutes: ${gateTimeout}`);
      expect(section).toContain("needs: resolve_target");
      expect(section).toContain("ref: ${{ needs.resolve_target.outputs.target_sha }}");
      expect(section).toContain("persist-credentials: false");
      expect(section).toContain("cache: npm");
      expect(section).toContain("run: npm ci");
      expect(section).toContain(`run: ${command}`);
    }

    const appTestsJob = workflow.match(
      /\n  app_tests:[\s\S]*?(?=\n  [a-z][a-z_-]*:|$)/
    )?.[0] ?? "";
    expect(appTestsJob).toContain("strategy:");
    expect(appTestsJob).toContain("fail-fast: false");
    expect(appTestsJob).toContain("max-parallel: 4");
    expect(appTestsJob).toContain("shard: [1, 2, 3, 4]");
    expect(appTestsJob).toContain("runs-on: ubuntu-latest");
    expect(appTestsJob).toContain("timeout-minutes: 100");
    expect(appTestsJob).toContain("timeout-minutes: 10");
    expect(appTestsJob).toContain("ref: ${{ needs.resolve_target.outputs.target_sha }}");
    expect(appTestsJob).toContain("persist-credentials: false");
    expect(appTestsJob).toContain("node-version: 24.14.0");
    expect(appTestsJob).toContain("cache: npm");
    expect(appTestsJob).toContain("run: npm ci");
    expect(appTestsJob).toContain("VITEST_SHARD_INDEX: ${{ matrix.shard }}");
    expect(appTestsJob).toContain("VITEST_SHARD_COUNT: 4");
    expect(appTestsJob).toContain("run: npm run test");
    expect(appTestsJob).not.toContain("--shard=");

    const qualityJob = workflow.match(
      /\n  quality:[\s\S]*?(?=\n  [a-z][a-z_-]*:|$)/
    )?.[0] ?? "";
    expect(qualityJob).toContain("timeout-minutes: 35");
    expect(qualityJob).toContain("needs: resolve_target");
    expect(qualityJob).toContain("ref: ${{ needs.resolve_target.outputs.target_sha }}");
    expect(qualityJob).toContain("persist-credentials: false");
    expect(qualityJob).toContain("cache: npm");
    expect(qualityJob).toContain("run: npm ci");
    expect(qualityJob).toContain("run: npm run lint");
    expect(qualityJob).toContain("run: npm run typecheck");
    expect(workflow).not.toMatch(/^\s*run:\s+npm run check\s*$/m);

    const validateJob = workflow.match(/\n  validate:[\s\S]*$/)?.[0] ?? "";
    expect(validateJob).toContain("if: always()");
    expect(validateJob).toContain("- resolve_target");
    for (const [job, resultName] of [
      ["quality", "QUALITY_RESULT"],
      ["app_tests", "APP_TESTS_RESULT"],
      ["collectors", "COLLECTORS_RESULT"],
      ["logged_social", "LOGGED_SOCIAL_RESULT"],
      ["build", "BUILD_RESULT"],
      ["scoring", "SCORING_RESULT"],
      ["artifacts", "ARTIFACTS_RESULT"]
    ]) {
      expect(validateJob).toContain(`- ${job}`);
      expect(validateJob).toContain(`${resultName}: \${{ needs.${job}.result }}`);
      expect(validateJob).toContain(`test "$${resultName}" = success`);
    }
    expect(validateJob).toContain("TARGET_SHA: ${{ needs.resolve_target.outputs.target_sha }}");
    expect(validateJob).toContain("outputs:");
    expect(validateJob).toContain("validated_sha: ${{ steps.finalize.outputs.validated_sha }}");
    expect(validateJob).toContain("name: Check out exact target for final audit");
    expect(validateJob).toContain("fetch-depth: 0");
    expect(validateJob).toContain("name: Require every release gate and reverify target");
    expect(validateJob).toContain("git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main");
    expect(validateJob).toContain('git merge-base --is-ancestor "$FINAL_SHA" refs/remotes/origin/main');
    expect(validateJob).toContain('echo "validated_sha=$FINAL_SHA" >> "$GITHUB_OUTPUT"');
  });

  it("validates branch pushes only on main while keeping pull requests", () => {
    expect(workflow).toContain("pull_request:");
    expect(workflow).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main/);
  });

  it("rejects fabricated and unpublished exact SHAs before release gates", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "returner-public-workflow-"));
    try {
      const remote = path.join(directory, "remote.git");
      const seed = path.join(directory, "seed");
      const checkout = path.join(directory, "checkout");
      mkdirSync(seed);
      runGit(directory, "init", "--bare", remote);
      runGit(seed, "init");
      runGit(seed, "checkout", "-b", "main");
      runGit(seed, "config", "user.name", "Workflow Test");
      runGit(seed, "config", "user.email", "workflow@example.com");
      writeFileSync(path.join(seed, "fixture.txt"), "published\n");
      runGit(seed, "add", "fixture.txt");
      runGit(seed, "commit", "-m", "published fixture");
      runGit(seed, "remote", "add", "origin", remote);
      runGit(seed, "push", "-u", "origin", "main");
      runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
      runGit(directory, "clone", remote, checkout);

      const publishedSha = runGit(checkout, "rev-parse", "HEAD");
      const script = workflowStepScript(workflow, "Verify exact validation target");
      const valid = runVerification(script, checkout, publishedSha, {
        requireMainReachability: true,
        eventName: "workflow_dispatch"
      });
      expect(valid.status, `${valid.stdout}\n${valid.stderr}`).toBe(0);
      expect(readFileSync(valid.outputPath, "utf8")).toContain(`target_sha=${publishedSha}`);

      runGit(checkout, "config", "user.name", "Workflow Test");
      runGit(checkout, "config", "user.email", "workflow@example.com");
      writeFileSync(path.join(checkout, "fixture.txt"), "unpublished\n");
      runGit(checkout, "add", "fixture.txt");
      runGit(checkout, "commit", "-m", "unpublished fixture");
      const unpublishedSha = runGit(checkout, "rev-parse", "HEAD");

      const unpublished = runVerification(script, checkout, unpublishedSha, {
        requireMainReachability: true,
        eventName: "workflow_dispatch"
      });
      expect(unpublished.status).toBe(1);
      expect(unpublished.stdout).toContain("is not reachable from origin/main");

      const fabricated = runVerification(script, checkout, "f".repeat(40), {
        requireMainReachability: true,
        eventName: "workflow_dispatch"
      });
      expect(fabricated.status).toBe(1);
      expect(fabricated.stdout).toContain("Validation checkout mismatch");

      const pullRequestCommit = runVerification(script, checkout, unpublishedSha, {
        requireMainReachability: false,
        eventName: "pull_request"
      });
      expect(pullRequestCommit.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("workflow-call validation requires exact policy parity with the caller source SHA", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "returner-policy-parity-"));
    try {
      const remote = path.join(directory, "remote.git");
      const seed = path.join(directory, "seed");
      const checkout = path.join(directory, "checkout");
      mkdirSync(seed);
      runGit(directory, "init", "--bare", remote);
      runGit(seed, "init");
      runGit(seed, "checkout", "-b", "main");
      runGit(seed, "config", "user.name", "Workflow Test");
      runGit(seed, "config", "user.email", "workflow@example.com");
      mkdirSync(path.join(seed, ".github", "workflows"), { recursive: true });
      writeFileSync(
        path.join(seed, ".github", "workflows", "public-artifacts.yml"),
        "name: fixture-policy-v1\n"
      );
      writeFileSync(path.join(seed, "fixture.txt"), "source\n");
      runGit(seed, "add", ".github/workflows/public-artifacts.yml", "fixture.txt");
      runGit(seed, "commit", "-m", "caller source policy");
      runGit(seed, "remote", "add", "origin", remote);
      runGit(seed, "push", "-u", "origin", "main");
      runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
      const callerSourceSha = runGit(seed, "rev-parse", "HEAD");

      writeFileSync(path.join(seed, "fixture.txt"), "data-only publication\n");
      runGit(seed, "add", "fixture.txt");
      runGit(seed, "commit", "-m", "data-only publication");
      runGit(seed, "push", "origin", "main");
      const dataOnlyTarget = runGit(seed, "rev-parse", "HEAD");
      runGit(directory, "clone", remote, checkout);
      runGit(checkout, "checkout", "--detach", dataOnlyTarget);

      const script = workflowStepScript(workflow, "Verify exact validation target");
      const valid = runVerification(script, checkout, dataOnlyTarget, {
        requireMainReachability: true,
        eventName: "workflow_call",
        callerSourceSha
      });
      expect(valid.status, `${valid.stdout}\n${valid.stderr}`).toBe(0);

      writeFileSync(
        path.join(seed, ".github", "workflows", "public-artifacts.yml"),
        "name: fixture-policy-v2\n"
      );
      runGit(seed, "add", ".github/workflows/public-artifacts.yml");
      runGit(seed, "commit", "-m", "drift validation policy");
      runGit(seed, "push", "origin", "main");
      const driftedTarget = runGit(seed, "rev-parse", "HEAD");
      runGit(checkout, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
      runGit(checkout, "checkout", "--detach", driftedTarget);

      const drifted = runVerification(script, checkout, driftedTarget, {
        requireMainReachability: true,
        eventName: "workflow_call",
        callerSourceSha
      });
      expect(drifted.status).toBe(1);
      expect(drifted.stdout).toContain("Validation policy drift");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("binds bot publications to exact trailers, receipt bytes, and semantic schedule metadata", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "returner-public-provenance-"));
    try {
      const remote = path.join(directory, "remote.git");
      const seed = path.join(directory, "seed");
      const checkout = path.join(directory, "checkout");
      mkdirSync(seed);
      runGit(directory, "init", "--bare", remote);
      runGit(seed, "init");
      runGit(seed, "checkout", "-b", "main");
      runGit(seed, "config", "user.name", "Workflow Test");
      runGit(seed, "config", "user.email", "workflow@example.com");
      mkdirSync(path.join(seed, ".github", "workflows"), { recursive: true });
      writeFileSync(
        path.join(seed, ".github", "workflows", "public-artifacts.yml"),
        "name: immutable-public-policy\n"
      );
      writeFileSync(path.join(seed, "fixture.txt"), "source\n");
      runGit(seed, "add", ".github/workflows/public-artifacts.yml", "fixture.txt");
      runGit(seed, "commit", "-m", "source policy");
      const sourceSha = runGit(seed, "rev-parse", "HEAD");
      runGit(seed, "remote", "add", "origin", remote);
      runGit(seed, "push", "-u", "origin", "main");
      runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");

      const runId = "31338649652";
      const runAttempt = "2";
      const centralDate = "2026-08-09";
      const slotKey = `daily-benchmark-${centralDate}`;
      const scheduledAt = "2026-08-09T05:00:00.000Z";
      const receiptPath = "outputs/benchmarks/daily-publication-receipt.json";
      const receipt = {
        schemaVersion: 1,
        kind: "daily-score-benchmark-publication",
        slotKey,
        sourceSha,
        runId,
        runAttempt,
        trigger: "schedule",
        scheduledUtcHour: "5",
        scheduledAt,
        centralDate
      };

      writeFileSync(path.join(seed, "fixture.txt"), "subject spoof\n");
      runGit(seed, "add", "fixture.txt");
      runGit(seed, "commit", "-m", "Update daily score benchmark snapshots");
      const subjectSpoof = runGit(seed, "rev-parse", "HEAD");
      const trailerSpoof = commitPublicationFixture(seed, {
        subject: "Update daily score benchmark snapshots",
        receiptPath,
        receipt,
        slotKey,
        sourceSha,
        runId,
        runAttempt: "999",
        fixtureValue: "trailer spoof\n"
      });
      const hashSpoof = commitPublicationFixture(seed, {
        subject: "Update daily score benchmark snapshots",
        receiptPath,
        receipt,
        slotKey,
        sourceSha,
        runId,
        runAttempt,
        receiptHash: "0".repeat(64),
        fixtureValue: "hash spoof\n"
      });
      const contradictoryReceipt = { ...receipt, centralDate: "2026-08-08" };
      const contradictory = commitPublicationFixture(seed, {
        subject: "Update daily score benchmark snapshots",
        receiptPath,
        receipt: contradictoryReceipt,
        slotKey,
        sourceSha,
        runId,
        runAttempt,
        fixtureValue: "contradictory metadata\n"
      });
      const validTarget = commitPublicationFixture(seed, {
        subject: "Update daily score benchmark snapshots",
        receiptPath,
        receipt,
        slotKey,
        sourceSha,
        runId,
        runAttempt,
        fixtureValue: "valid publication\n"
      });
      const autonomousSlotKey = "central-2026-08-09-1800";
      const autonomousScheduledAt = "2026-08-09T23:00:00.000Z";
      const autonomousReceiptPath = "outputs/ingestion-source-delta-current.json";
      const autonomousReceipt = {
        schemaVersion: 1,
        idempotencyKey: autonomousSlotKey,
        trigger: "schedule",
        scheduledAt: autonomousScheduledAt
      };
      const autonomousTarget = commitPublicationFixture(seed, {
        subject: `Publish autonomous ingestion ${autonomousSlotKey}`,
        receiptPath: autonomousReceiptPath,
        receipt: autonomousReceipt,
        slotKey: autonomousSlotKey,
        sourceSha,
        runId: "31338649653",
        runAttempt: "1",
        fixtureValue: "valid autonomous publication\n"
      });
      runGit(seed, "push", "origin", "main");
      runGit(directory, "clone", remote, checkout);

      const script = workflowStepScript(workflow, "Verify exact validation target");
      const provenance = {
        kind: "daily-benchmark",
        receiptPath,
        sourceSha,
        slotKey,
        runId,
        runAttempt,
        trigger: "schedule",
        scheduledAt,
        centralDate,
        scheduledUtcHour: "5"
      };
      runGit(checkout, "checkout", "--detach", validTarget);
      const valid = runVerification(script, checkout, validTarget, {
        requireMainReachability: true,
        eventName: "workflow_call",
        callerSourceSha: sourceSha,
        provenance
      });
      expect(valid.status, `${valid.stdout}\n${valid.stderr}`).toBe(0);

      runGit(checkout, "checkout", "--detach", autonomousTarget);
      const autonomousProvenance = {
        kind: "autonomous-ingestion",
        receiptPath: autonomousReceiptPath,
        sourceSha,
        slotKey: autonomousSlotKey,
        runId: "31338649653",
        runAttempt: "1",
        trigger: "schedule",
        scheduledAt: autonomousScheduledAt
      };
      const validAutonomous = runVerification(script, checkout, autonomousTarget, {
        requireMainReachability: true,
        eventName: "workflow_call",
        callerSourceSha: sourceSha,
        provenance: autonomousProvenance
      });
      expect(validAutonomous.status, `${validAutonomous.stdout}\n${validAutonomous.stderr}`).toBe(0);
      const mismatchedAutonomousTrigger = runVerification(script, checkout, autonomousTarget, {
        requireMainReachability: true,
        eventName: "workflow_call",
        callerSourceSha: sourceSha,
        provenance: { ...autonomousProvenance, trigger: "manual-replay", scheduledAt: "" }
      });
      expect(mismatchedAutonomousTrigger.status).not.toBe(0);

      writeFileSync(path.join(seed, "caller.txt"), "newer caller with identical validation policy\n");
      runGit(seed, "add", "caller.txt");
      runGit(seed, "commit", "-m", "advance caller source without policy drift");
      runGit(seed, "push", "origin", "main");
      const newerCallerSourceSha = runGit(seed, "rev-parse", "HEAD");
      runGit(checkout, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
      runGit(checkout, "checkout", "--detach", validTarget);
      const adoptedPriorTarget = runVerification(script, checkout, validTarget, {
        requireMainReachability: true,
        eventName: "workflow_call",
        callerSourceSha: newerCallerSourceSha,
        provenance
      });
      expect(adoptedPriorTarget.status, `${adoptedPriorTarget.stdout}\n${adoptedPriorTarget.stderr}`).toBe(0);

      for (const target of [subjectSpoof, trailerSpoof, hashSpoof]) {
        runGit(checkout, "checkout", "--detach", target);
        const spoofed = runVerification(script, checkout, target, {
          requireMainReachability: true,
          eventName: "workflow_call",
          callerSourceSha: sourceSha,
          provenance
        });
        expect(spoofed.status, `${target} unexpectedly passed`).not.toBe(0);
      }

      runGit(checkout, "checkout", "--detach", contradictory);
      const contradictoryResult = runVerification(script, checkout, contradictory, {
        requireMainReachability: true,
        eventName: "workflow_call",
        callerSourceSha: sourceSha,
        provenance: { ...provenance, centralDate: "2026-08-08" }
      });
      expect(contradictoryResult.status, "contradictory signed schedule metadata passed").not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects exact validation targets containing tracked symlinks", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "returner-public-modes-"));
    try {
      const remote = path.join(directory, "remote.git");
      const seed = path.join(directory, "seed");
      const checkout = path.join(directory, "checkout");
      mkdirSync(seed);
      runGit(directory, "init", "--bare", remote);
      runGit(seed, "init");
      runGit(seed, "checkout", "-b", "main");
      runGit(seed, "config", "user.name", "Workflow Test");
      runGit(seed, "config", "user.email", "workflow@example.com");
      writeFileSync(path.join(seed, "fixture.txt"), "source\n");
      runGit(seed, "add", "fixture.txt");
      runGit(seed, "commit", "-m", "source fixture");
      symlinkSync("fixture.txt", path.join(seed, "unsafe-link"));
      runGit(seed, "add", "unsafe-link");
      runGit(seed, "commit", "-m", "tracked symlink fixture");
      const targetSha = runGit(seed, "rev-parse", "HEAD");
      runGit(seed, "remote", "add", "origin", remote);
      runGit(seed, "push", "-u", "origin", "main");
      runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
      runGit(directory, "clone", remote, checkout);

      const script = workflowStepScript(workflow, "Verify exact validation target");
      const result = runVerification(script, checkout, targetSha, {
        requireMainReachability: true,
        eventName: "workflow_dispatch"
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "validation target contains prohibited symlink/submodule entries"
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("final aggregation rejects a target force-pushed off main after long gates", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "returner-final-reachability-"));
    try {
      const remote = path.join(directory, "remote.git");
      const seed = path.join(directory, "seed");
      const checkout = path.join(directory, "checkout");
      mkdirSync(seed);
      runGit(directory, "init", "--bare", remote);
      runGit(seed, "init");
      runGit(seed, "checkout", "-b", "main");
      runGit(seed, "config", "user.name", "Workflow Test");
      runGit(seed, "config", "user.email", "workflow@example.com");
      writeFileSync(path.join(seed, "fixture.txt"), "base\n");
      runGit(seed, "add", "fixture.txt");
      runGit(seed, "commit", "-m", "base");
      const baseSha = runGit(seed, "rev-parse", "HEAD");
      runGit(seed, "remote", "add", "origin", remote);
      runGit(seed, "push", "-u", "origin", "main");
      runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");

      writeFileSync(path.join(seed, "fixture.txt"), "validated target\n");
      runGit(seed, "add", "fixture.txt");
      runGit(seed, "commit", "-m", "validated target");
      runGit(seed, "push", "origin", "main");
      const targetSha = runGit(seed, "rev-parse", "HEAD");
      runGit(directory, "clone", remote, checkout);
      runGit(checkout, "checkout", "--detach", targetSha);

      const script = workflowStepScript(
        workflow,
        "Require every release gate and reverify target"
      );
      const valid = runFinalVerification(script, checkout, targetSha, true);
      expect(valid.status, `${valid.stdout}\n${valid.stderr}`).toBe(0);
      expect(readFileSync(valid.outputPath, "utf8")).toContain(`validated_sha=${targetSha}`);

      runGit(seed, "reset", "--hard", baseSha);
      runGit(seed, "push", "--force", "origin", "main");
      const removed = runFinalVerification(script, checkout, targetSha, true);
      expect(removed.status).toBe(1);
      expect(removed.stdout).toContain("Validation target no longer published");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function workflowStepScript(source, stepName) {
  const lines = source.split("\n");
  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  expect(stepIndex).toBeGreaterThanOrEqual(0);
  const runIndex = lines.findIndex(
    (line, index) => index > stepIndex && line.trim() === "run: |"
  );
  expect(runIndex).toBeGreaterThan(stepIndex);
  const runIndent = lines[runIndex].match(/^\s*/)?.[0].length ?? 0;
  const body = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (line.trim() && indent <= runIndent) break;
    body.push(line.slice(Math.min(line.length, runIndent + 2)));
  }
  return body.join("\n");
}

function runVerification(
  script,
  cwd,
  requestedSha,
  { requireMainReachability, eventName, callerSourceSha = requestedSha, provenance = {} }
) {
  const outputPath = path.join(cwd, `output-${Date.now()}-${Math.random()}`);
  const summaryPath = path.join(cwd, `summary-${Date.now()}-${Math.random()}`);
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        REQUESTED_SHA: requestedSha,
        REQUIRE_MAIN_REACHABILITY: String(requireMainReachability),
        POLICY_SOURCE_SHA: eventName === "workflow_call" ? callerSourceSha : "",
        PUBLICATION_KIND: provenance.kind ?? "",
        PUBLICATION_RECEIPT_PATH: provenance.receiptPath ?? "",
        PUBLICATION_SOURCE_SHA: provenance.sourceSha ?? "",
        PUBLICATION_SLOT_KEY: provenance.slotKey ?? "",
        PUBLICATION_RUN_ID: provenance.runId ?? "",
        PUBLICATION_RUN_ATTEMPT: provenance.runAttempt ?? "",
        PUBLICATION_TRIGGER: provenance.trigger ?? "",
        PUBLICATION_SCHEDULED_AT: provenance.scheduledAt ?? "",
        PUBLICATION_CENTRAL_DATE: provenance.centralDate ?? "",
        PUBLICATION_SCHEDULED_UTC_HOUR: provenance.scheduledUtcHour ?? "",
        PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0",
        GITHUB_EVENT_NAME: eventName,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath
      }
    }
  );
  return { ...result, outputPath, summaryPath };
}

function commitPublicationFixture(
  cwd,
  {
    subject,
    receiptPath,
    receipt,
    slotKey,
    sourceSha,
    runId,
    runAttempt,
    fixtureValue,
    receiptHash
  }
) {
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  const absoluteReceiptPath = path.join(cwd, receiptPath);
  mkdirSync(path.dirname(absoluteReceiptPath), { recursive: true });
  writeFileSync(absoluteReceiptPath, serialized);
  writeFileSync(path.join(cwd, "fixture.txt"), fixtureValue);
  const hash = receiptHash ?? createHash("sha256").update(serialized).digest("hex");
  const trailers = [
    `Returner-Slot-Key: ${slotKey}`,
    `Returner-Source-SHA: ${sourceSha}`,
    `Returner-Run-ID: ${runId}`,
    `Returner-Run-Attempt: ${runAttempt}`,
    `Returner-Receipt-SHA256: ${hash}`
  ].join("\n");
  runGit(cwd, "add", "fixture.txt", receiptPath);
  runGit(cwd, "commit", "-m", subject, "-m", trailers);
  return runGit(cwd, "rev-parse", "HEAD");
}

function runFinalVerification(script, cwd, targetSha, requireMainReachability) {
  const outputPath = path.join(cwd, `final-output-${Date.now()}-${Math.random()}`);
  const summaryPath = path.join(cwd, `final-summary-${Date.now()}-${Math.random()}`);
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        TARGET_RESULT: "success",
        TARGET_SHA: targetSha,
        REQUIRE_MAIN_REACHABILITY: String(requireMainReachability),
        QUALITY_RESULT: "success",
        APP_TESTS_RESULT: "success",
        COLLECTORS_RESULT: "success",
        LOGGED_SOCIAL_RESULT: "success",
        BUILD_RESULT: "success",
        SCORING_RESULT: "success",
        ARTIFACTS_RESULT: "success",
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath
      }
    }
  );
  return { ...result, outputPath, summaryPath };
}

function runGit(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}
