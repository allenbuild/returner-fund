import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CircuitOpenError,
  HttpDeadlineError,
  computeRetryDelay,
  createHttpPolicy,
  isRetryableHttpStatus,
  parseGitHubResetMs,
  parseRetryAfterMs
} from "../scripts/lib/http-policy.mjs";

test("classifies only network-adjacent HTTP statuses as retryable", async () => {
  for (const status of [408, 425, 429, 500, 502, 599]) {
    assert.equal(isRetryableHttpStatus(status), true, String(status));
  }
  for (const status of [200, 301, 400, 403, 404, 409, 422, 499, 600]) {
    assert.equal(isRetryableHttpStatus(status), false, String(status));
  }

  let calls = 0;
  const policy = createHttpPolicy({
    fetch: async () => {
      calls += 1;
      return response(403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "9999999999"
      });
    },
    maxAttempts: 5
  });

  const result = await policy.fetch("https://api.github.com/rate-limited");
  assert.equal(result.status, 403);
  assert.equal(calls, 1, "GitHub reset headers must not broaden retryable statuses");
});

test("parses Retry-After and GitHub reset hints and applies full-jitter backoff", () => {
  const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
  assert.equal(parseRetryAfterMs("2.5", nowMs), 2500);
  assert.equal(parseRetryAfterMs("Sat, 18 Jul 2026 12:00:04 GMT", nowMs), 4000);
  assert.equal(parseRetryAfterMs("not-a-date", nowMs), null);
  assert.equal(
    parseGitHubResetMs(new Headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String((nowMs + 6000) / 1000)
    }), nowMs),
    6000
  );

  assert.deepEqual(
    computeRetryDelay({
      attempt: 3,
      nowMs,
      random: () => 0.25,
      baseDelayMs: 100,
      maxDelayMs: 1000
    }),
    { delayMs: 100, source: "backoff", backoffMs: 100, serverDelayMs: 0 }
  );
  assert.deepEqual(
    computeRetryDelay({
      attempt: 1,
      response: response(429, { "retry-after": "3" }),
      nowMs,
      random: () => 0.99,
      baseDelayMs: 100,
      maxDelayMs: 1000
    }),
    { delayMs: 3000, source: "retry-after", backoffMs: 99, serverDelayMs: 3000 }
  );
});

test("retries network errors and retryable responses with structured attempt events", async () => {
  const clock = new ManualClock(1000);
  const events = [];
  let calls = 0;
  const policy = createHttpPolicy({
    clock,
    random: () => 0.5,
    maxAttempts: 3,
    retry: { baseDelayMs: 100, maxDelayMs: 1000 },
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("socket closed");
      if (calls === 2) return response(503, { "retry-after": "2" });
      return response(200);
    },
    onEvent: (event) => events.push(event)
  });

  const result = await policy.fetch(
    "https://example.test/data",
    { method: "POST" },
    { provider: "Example", requestId: "fixture-request" }
  );

  assert.equal(result.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(clock.sleeps.filter((delay) => delay > 0), [50, 2000]);
  assert.deepEqual(events.map((event) => event.phase), [
    "start",
    "error",
    "retry_scheduled",
    "start",
    "response",
    "retry_scheduled",
    "start",
    "response"
  ]);
  assert.deepEqual(
    events.filter((event) => event.phase === "retry_scheduled").map((event) => [event.delayMs, event.delaySource]),
    [[50, "backoff"], [2000, "retry-after"]]
  );
  assert.ok(events.every((event) =>
    event.type === "http_attempt" &&
    event.requestId === "fixture-request" &&
    event.provider === "example" &&
    event.method === "POST" &&
    Number.isFinite(event.timestamp)
  ));
});

test("enforces global and per-provider concurrency without blocking other providers", async () => {
  const pending = [];
  const activeByProvider = new Map();
  let activeGlobal = 0;
  let maxGlobal = 0;
  const maxByProvider = new Map();
  const policy = createHttpPolicy({
    globalConcurrency: 2,
    providerConcurrency: 2,
    providers: {
      alpha: { providerConcurrency: 1 },
      beta: { providerConcurrency: 2 }
    },
    fetch: (input) => {
      const provider = new URL(String(input)).hostname.split(".")[0];
      activeGlobal += 1;
      activeByProvider.set(provider, (activeByProvider.get(provider) ?? 0) + 1);
      maxGlobal = Math.max(maxGlobal, activeGlobal);
      maxByProvider.set(provider, Math.max(
        maxByProvider.get(provider) ?? 0,
        activeByProvider.get(provider)
      ));
      return new Promise((resolve) => pending.push(() => {
        activeGlobal -= 1;
        activeByProvider.set(provider, activeByProvider.get(provider) - 1);
        resolve(response(200));
      }));
    }
  });

  const requests = [
    policy.fetch("https://alpha.test/1", {}, { provider: "alpha" }),
    policy.fetch("https://alpha.test/2", {}, { provider: "alpha" }),
    policy.fetch("https://alpha.test/3", {}, { provider: "alpha" }),
    policy.fetch("https://beta.test/1", {}, { provider: "beta" }),
    policy.fetch("https://beta.test/2", {}, { provider: "beta" }),
    policy.fetch("https://beta.test/3", {}, { provider: "beta" })
  ];

  await flushPromises();
  assert.equal(activeGlobal, 2);
  assert.equal(activeByProvider.get("alpha"), 1);
  assert.equal(activeByProvider.get("beta"), 1);

  while (pending.length > 0) {
    pending.shift()();
    await flushPromises();
  }
  await Promise.all(requests);

  assert.equal(maxGlobal, 2);
  assert.equal(maxByProvider.get("alpha"), 1);
  assert.ok(maxByProvider.get("beta") <= 2);
});

test("paces starts globally and per provider with an injectable clock", async () => {
  const clock = new ManualClock(0);
  const starts = [];
  const policy = createHttpPolicy({
    clock,
    globalConcurrency: 1,
    globalPaceMs: 10,
    providerPaceMs: 25,
    fetch: async () => {
      starts.push(clock.now());
      return response(200);
    }
  });

  await policy.fetch("https://alpha.test/1", {}, { provider: "alpha" });
  await policy.fetch("https://alpha.test/2", {}, { provider: "alpha" });
  await policy.fetch("https://beta.test/1", {}, { provider: "beta" });

  assert.deepEqual(starts, [0, 25, 35]);
});

test("releases concurrency while a retry waits in backoff", async () => {
  let firstCall = true;
  let releaseBackoff;
  const backoffStarted = new Promise((resolve) => { releaseBackoff = resolve; });
  let finishBackoff;
  const backoffBlocked = new Promise((resolve) => { finishBackoff = resolve; });
  const starts = [];
  const clock = {
    now: () => 0,
    setTimeout,
    clearTimeout,
    async sleep(delayMs) {
      if (delayMs > 0) {
        releaseBackoff();
        await backoffBlocked;
      }
    }
  };
  const policy = createHttpPolicy({
    clock,
    globalConcurrency: 1,
    maxAttempts: 2,
    random: () => 1,
    retry: { baseDelayMs: 10, maxDelayMs: 10 },
    fetch: async (input) => {
      starts.push(String(input));
      if (firstCall) {
        firstCall = false;
        return response(503);
      }
      return response(200);
    }
  });

  const retrying = policy.fetch("https://alpha.test/retry", {}, { provider: "alpha" });
  await backoffStarted;
  const independent = policy.fetch("https://beta.test/independent", {}, { provider: "beta" });
  assert.equal((await independent).status, 200);
  assert.deepEqual(starts, [
    "https://alpha.test/retry",
    "https://beta.test/independent"
  ]);

  finishBackoff();
  assert.equal((await retrying).status, 200);
});

test("aborts an attempt at its deadline using the injected clock", async () => {
  const clock = new ManualClock(500);
  let observedSignal;
  const policy = createHttpPolicy({
    clock,
    timeoutMs: 50,
    maxAttempts: 1,
    fetch: async (_input, init) => {
      observedSignal = init.signal;
      return new Promise(() => {});
    }
  });

  const request = policy.fetch("https://slow.test/resource", {}, { provider: "slow" });
  await flushPromises();
  assert.equal(observedSignal.aborted, false);
  clock.advance(50);

  await assert.rejects(request, (error) => {
    assert.ok(error instanceof HttpDeadlineError);
    assert.equal(error.scope, "attempt");
    assert.equal(error.deadlineAt, 550);
    return true;
  });
  assert.equal(observedSignal.aborted, true);
});

test("settles the circuit when the request deadline expires during backoff", async () => {
  const clock = new ManualClock(1000);
  const events = [];
  let calls = 0;
  const policy = createHttpPolicy({
    clock,
    totalTimeoutMs: 20,
    maxAttempts: 2,
    random: () => 1,
    retry: { baseDelayMs: 100, maxDelayMs: 100 },
    circuitBreaker: { failureThreshold: 1, cooldownMs: 50 },
    fetch: async () => {
      calls += 1;
      throw new TypeError("offline");
    },
    onEvent: (event) => events.push(event)
  });

  await assert.rejects(
    policy.fetch("https://offline.test/data", {}, { provider: "offline" }),
    (error) => error instanceof HttpDeadlineError && error.scope === "request"
  );
  assert.equal(calls, 1);
  assert.equal(events.at(-1).phase, "retry_aborted");
  assert.equal(policy.getCircuitState("offline").state, "open");
});

test("opens, cools down, admits one half-open probe, and reopens or closes from the probe", async () => {
  const clock = new ManualClock(10_000);
  let calls = 0;
  let resolveProbe;
  const policy = createHttpPolicy({
    clock,
    maxAttempts: 1,
    circuitBreaker: { failureThreshold: 2, cooldownMs: 100 },
    fetch: async () => {
      calls += 1;
      if (calls <= 2) return response(503);
      if (calls === 3) return new Promise((resolve) => { resolveProbe = resolve; });
      return response(200);
    }
  });

  assert.equal((await policy.fetch("https://api.test/1", {}, { provider: "api" })).status, 503);
  assert.equal((await policy.fetch("https://api.test/2", {}, { provider: "api" })).status, 503);
  assert.deepEqual(policy.getCircuitState("api"), {
    state: "open",
    failures: 2,
    retryAt: 10_100,
    probeInFlight: false
  });
  await assert.rejects(
    policy.fetch("https://api.test/blocked", {}, { provider: "api" }),
    CircuitOpenError
  );

  clock.advance(100);
  const failedProbe = policy.fetch("https://api.test/probe", {}, { provider: "api" });
  await flushPromises();
  assert.equal(policy.getCircuitState("api").state, "half-open");
  assert.equal(policy.getCircuitState("api").probeInFlight, true);
  await assert.rejects(
    policy.fetch("https://api.test/second-probe", {}, { provider: "api" }),
    CircuitOpenError
  );
  resolveProbe(response(503));
  assert.equal((await failedProbe).status, 503);
  assert.equal(policy.getCircuitState("api").state, "open");
  assert.equal(policy.getCircuitState("api").retryAt, 10_200);

  clock.advance(100);
  assert.equal((await policy.fetch("https://api.test/recovered", {}, { provider: "api" })).status, 200);
  assert.deepEqual(policy.getCircuitState("api"), {
    state: "closed",
    failures: 0,
    retryAt: null,
    probeInFlight: false
  });
});

class ManualClock {
  constructor(nowMs) {
    this.nowMs = nowMs;
    this.nextTimerId = 1;
    this.timers = new Map();
    this.sleeps = [];
  }

  now() {
    return this.nowMs;
  }

  sleep(delayMs) {
    this.sleeps.push(delayMs);
    this.advance(delayMs);
    return Promise.resolve();
  }

  setTimeout(callback, delayMs) {
    const id = this.nextTimerId++;
    this.timers.set(id, { callback, at: this.nowMs + delayMs });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  advance(delayMs) {
    const target = this.nowMs + delayMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.nowMs = timer.at;
      timer.callback();
    }
    this.nowMs = target;
  }
}

function response(status, headers = {}) {
  return new Response(null, { status, headers });
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}
