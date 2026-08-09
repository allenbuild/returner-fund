import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AutonomousCollectionBudgetExceededError,
  AutonomousCollectionDrainBudgetExceededError,
  AutonomousRunnerBudgetExceededError,
  AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS,
  AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS,
  createAutonomousCollectionBudget,
  createAutonomousCollectionDrainBudget,
  createAutonomousRunnerBudget
} from "../scripts/lib/autonomous-ingestion-budget.mjs";

describe("autonomous collection wall-clock budget", () => {
  it("caps every subprocess timeout at the shared phase deadline", () => {
    let currentTime = 1_000;
    const budget = createAutonomousCollectionBudget({
      phaseMs: 10_000,
      startedAt: currentTime,
      now: () => currentTime
    });

    assert.equal(budget.deadlineAt, 11_000);
    assert.equal(budget.timeoutMs(20_000, "first shard"), 10_000);
    currentTime = 8_500;
    assert.equal(budget.remainingMs(), 2_500);
    assert.equal(budget.timeoutMs(20_000, "queued shard"), 2_500);
  });

  it("successfully flushes within bounded drain headroom after the collection deadline expires", async () => {
    let currentTime = 1_000;
    const collectionBudget = createAutonomousCollectionBudget({
      phaseMs: 2_000,
      startedAt: currentTime,
      now: () => currentTime
    });
    const runnerBudget = createAutonomousRunnerBudget({
      phaseMs: 3_500,
      startedAt: currentTime,
      now: () => currentTime
    });
    const drainBudget = createAutonomousCollectionDrainBudget({
      collectionDeadlineAt: collectionBudget.deadlineAt,
      drainHeadroomMs: 5_000,
      runnerDeadlineAt: runnerBudget.deadlineAt,
      now: () => currentTime
    });

    currentTime = collectionBudget.deadlineAt + 100;
    assert.throws(
      () => collectionBudget.timeoutMs(1, "expired collector"),
      /collection phase exhausted/
    );
    assert.equal(drainBudget.deadlineAt, runnerBudget.deadlineAt);
    assert.equal(drainBudget.timeoutMs(2_000, "checkpoint flush"), 1_400);

    const flushResult = await runBoundedFlush(
      drainBudget.timeoutMs(2_000, "checkpoint flush"),
      async () => "checkpoint-flushed"
    );
    assert.equal(flushResult, "checkpoint-flushed");

    currentTime = runnerBudget.deadlineAt;
    assert.throws(
      () => drainBudget.timeoutMs(1, "late checkpoint flush"),
      (error) => {
        assert.ok(error instanceof AutonomousCollectionDrainBudgetExceededError);
        assert.equal(error.code, "AUTONOMOUS_COLLECTION_DRAIN_BUDGET_EXCEEDED");
        assert.equal(error.deadlineAt, runnerBudget.deadlineAt);
        return true;
      }
    );
  });

  it("refuses a queued command or retry delay that would cross the deadline", () => {
    let currentTime = 5_000;
    const budget = createAutonomousCollectionBudget({
      phaseMs: 2_000,
      startedAt: currentTime,
      now: () => currentTime
    });

    currentTime = 6_500;
    assert.throws(
      () => budget.delayMs(501, "rate-limit backoff"),
      (error) => {
        assert.ok(error instanceof AutonomousCollectionBudgetExceededError);
        assert.equal(error.code, "AUTONOMOUS_COLLECTION_BUDGET_EXCEEDED");
        assert.equal(error.remainingMs, 500);
        return true;
      }
    );

    currentTime = 7_000;
    assert.throws(
      () => budget.timeoutMs(1, "late shard"),
      /Autonomous collection phase exhausted before late shard/
    );
  });

  it("rejects invalid phase, timeout, delay, and clock values", () => {
    assert.throws(
      () => createAutonomousCollectionBudget({ phaseMs: 0 }),
      /phaseMs must be a positive/
    );
    const budget = createAutonomousCollectionBudget({
      phaseMs: 1_000,
      startedAt: 0,
      now: () => 0
    });
    assert.throws(() => budget.timeoutMs(0), /requestedMs must be a positive/);
    assert.throws(() => budget.delayMs(-1), /requestedMs must be a non-negative/);
    const brokenClock = createAutonomousCollectionBudget({
      phaseMs: 1_000,
      startedAt: 0,
      now: () => Number.NaN
    });
    assert.throws(() => brokenClock.remainingMs(), /now\(\) must be a finite/);
  });
});

async function runBoundedFlush(timeoutMs, flush) {
  let timer;
  try {
    return await Promise.race([
      flush(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("checkpoint flush timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("autonomous runner wall-clock budget", () => {
  it("caps all commands at one deadline and leaves workflow cleanup headroom", () => {
    let currentTime = 20_000;
    const budget = createAutonomousRunnerBudget({
      phaseMs: 5_000,
      startedAt: currentTime,
      now: () => currentTime
    });

    assert.equal(budget.timeoutMs(9_000, "publication build"), 5_000);
    currentTime = 24_750;
    assert.equal(budget.timeoutMs(30_000, "git show"), 250);
    currentTime = 25_000;
    assert.throws(
      () => budget.timeoutMs(1, "rebase conflict check"),
      (error) => {
        assert.ok(error instanceof AutonomousRunnerBudgetExceededError);
        assert.equal(error.code, "AUTONOMOUS_RUNNER_BUDGET_EXCEEDED");
        assert.match(error.message, /runner deadline exhausted/);
        return true;
      }
    );

    assert.equal(AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS, 324 * 60_000);
    assert.equal(AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS, 6 * 60_000);
    assert.equal(
      AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS + AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS,
      330 * 60_000
    );
  });
});
