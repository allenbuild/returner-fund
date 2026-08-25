import assert from "node:assert/strict";
import test from "node:test";
import {
  INGESTION_RETRY_ATTEMPT_CEILING,
  cappedExponentialBackoffMs,
  retryDelayBeforeDeadlineMs
} from "../scripts/lib/ingestion-retry-policy.mjs";

test("retry attempts use the PostgreSQL integer ceiling instead of a small terminal cap", () => {
  assert.equal(INGESTION_RETRY_ATTEMPT_CEILING, 2_147_483_647);
});

test("exponential retry delay grows and remains capped with deterministic jitter", () => {
  const options = {
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterRatio: 0.2,
    random: () => 0.5
  };
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 1_000].map((failureCount) =>
      cappedExponentialBackoffMs(failureCount, options)
    ),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]
  );
});

test("deadline-aware retries preserve the cleanup and lease-renewal reserve", () => {
  const common = {
    failureCount: 4,
    deadlineAt: 50_000,
    reserveMs: 35_000,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterRatio: 0
  };
  assert.equal(retryDelayBeforeDeadlineMs({ ...common, nowMs: 0 }), 8_000);
  assert.equal(retryDelayBeforeDeadlineMs({ ...common, nowMs: 10_000 }), 5_000);
  assert.equal(retryDelayBeforeDeadlineMs({ ...common, nowMs: 15_000 }), null);
});

test("retry policy rejects invalid counters, caps, jitter, and random samples", () => {
  assert.throws(() => cappedExponentialBackoffMs(0), /positive safe integer/);
  assert.throws(
    () => cappedExponentialBackoffMs(1, { baseDelayMs: 2, maxDelayMs: 1 }),
    /greater than or equal/
  );
  assert.throws(
    () => cappedExponentialBackoffMs(1, { jitterRatio: 2 }),
    /between zero and one/
  );
  assert.throws(
    () => cappedExponentialBackoffMs(1, { random: () => Number.NaN }),
    /between zero and one/
  );
});
