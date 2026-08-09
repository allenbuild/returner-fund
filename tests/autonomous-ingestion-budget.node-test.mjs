import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AutonomousCollectionBudgetExceededError,
  createAutonomousCollectionBudget
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
