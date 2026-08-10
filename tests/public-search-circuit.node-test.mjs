import assert from "node:assert/strict";
import test from "node:test";

import {
  PublicSearchUnavailableError,
  createPublicSearchCircuit
} from "../scripts/lib/public-search-circuit.mjs";

function boundedResult(text = "ok", status = 200) {
  return {
    response: new Response(null, { status }),
    text
  };
}

test("requires an explicit bounded transport instead of falling back to ordinary fetch", () => {
  assert.throws(
    () => createPublicSearchCircuit(),
    /requires a bounded transport implementation/
  );
});

test("opens after two transport failures and rejects later searches without network work", async () => {
  let currentTime = Date.parse("2026-08-02T00:00:00.000Z");
  let calls = 0;
  const circuit = createPublicSearchCircuit({
    transport: async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    },
    failureThreshold: 2,
    cooldownMs: 60_000,
    timeoutMs: 5_000,
    now: () => currentTime
  });

  await assert.rejects(
    circuit.fetchText("https://duckduckgo.com/html/?q=one"),
    (error) => error instanceof PublicSearchUnavailableError &&
      error.code === "public_search_transport_failure" &&
      error.retryAt === null
  );
  await assert.rejects(
    circuit.fetchText("https://duckduckgo.com/html/?q=two"),
    (error) => error.code === "public_search_transport_failure" &&
      error.retryAt === "2026-08-02T00:01:00.000Z"
  );
  await assert.rejects(
    circuit.fetchText("https://duckduckgo.com/html/?q=three"),
    (error) => error.code === "public_search_circuit_open" &&
      /ECONNRESET/.test(error.message)
  );
  assert.equal(calls, 2);
  assert.deepEqual(circuit.snapshot(), {
    provider: "duckduckgo_html",
    state: "open",
    consecutiveFailures: 2,
    retryAt: "2026-08-02T00:01:00.000Z",
    lastFailure: "DuckDuckGo public search transport failed: ECONNRESET"
  });

  currentTime += 60_000;
  assert.equal(circuit.snapshot().state, "closed");
});

test("auth and rate-limit responses open the circuit immediately", async () => {
  let calls = 0;
  const circuit = createPublicSearchCircuit({
    transport: async () => {
      calls += 1;
      return boundedResult("", 403);
    },
    failureThreshold: 5,
    cooldownMs: 60_000,
    timeoutMs: 5_000,
    now: () => Date.parse("2026-08-02T00:00:00.000Z")
  });

  await assert.rejects(
    circuit.fetchText("https://duckduckgo.com/html/?q=one"),
    (error) => error.code === "public_search_access_blocked" &&
      error.status === 403 &&
      error.retryAt === "2026-08-02T00:01:00.000Z"
  );
  await assert.rejects(
    circuit.fetchText("https://duckduckgo.com/html/?q=two"),
    (error) => error.code === "public_search_circuit_open"
  );
  assert.equal(calls, 1);
});

test("injects a total deadline and independent encoded and decoded limits into transport", async () => {
  let observed;
  const circuit = createPublicSearchCircuit({
    transport: async (_input, options) => {
      observed = options;
      return boundedResult("bounded");
    },
    timeoutMs: 1_234,
    maxEncodedBodyBytes: 4_096,
    maxDecodedBodyBytes: 16_384
  });

  const result = await circuit.fetchText("https://duckduckgo.com/html/?q=bounded", {
    headers: { accept: "text/html" }
  });
  assert.equal(result.text, "bounded");
  assert.equal(observed.timeoutMs, 1_234);
  assert.equal(observed.maxResponseBytes, 4_096);
  assert.equal(observed.maxDecodedBytes, 16_384);
  assert.equal(observed.cancelErrorBody, true);
  assert.ok(observed.signal instanceof AbortSignal);
  assert.equal(observed.headers.accept, "text/html");
});

test("a successful probe resets consecutive transport failures", async () => {
  const outcomes = [new Error("temporary"), boundedResult("ok"), new Error("temporary")];
  const circuit = createPublicSearchCircuit({
    transport: async () => {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    failureThreshold: 2,
    cooldownMs: 60_000,
    timeoutMs: 5_000
  });

  await assert.rejects(circuit.fetchText("https://duckduckgo.com/html/?q=one"));
  assert.equal((await circuit.fetchText("https://duckduckgo.com/html/?q=two")).response.status, 200);
  await assert.rejects(circuit.fetchText("https://duckduckgo.com/html/?q=three"));
  assert.equal(circuit.snapshot().state, "closed");
  assert.equal(circuit.snapshot().consecutiveFailures, 1);
});

test("serializes concurrent probes so queued work observes an opened circuit", async () => {
  let releaseFirst;
  let calls = 0;
  const first = new Promise((_, reject) => {
    releaseFirst = () => reject(new Error("offline"));
  });
  const circuit = createPublicSearchCircuit({
    transport: async () => {
      calls += 1;
      return first;
    },
    failureThreshold: 1,
    cooldownMs: 60_000,
    timeoutMs: 5_000
  });

  const firstRequest = circuit.fetchText("https://duckduckgo.com/html/?q=one");
  const queuedRequest = circuit.fetchText("https://duckduckgo.com/html/?q=two");
  const firstRejection = assert.rejects(firstRequest, /offline/);
  const queuedRejection = assert.rejects(
    queuedRequest,
    (error) => error.code === "public_search_circuit_open"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([firstRejection, queuedRejection]);
  assert.equal(calls, 1);
});

test("the circuit deadline aborts a stalled bounded transport", async () => {
  let observedAbort = false;
  const circuit = createPublicSearchCircuit({
    transport: async (_input, { signal }) => new Promise((_, reject) => {
      if (signal.aborted) {
        observedAbort = true;
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(signal.reason);
      }, { once: true });
    }),
    timeoutMs: 10,
    failureThreshold: 1,
    cooldownMs: 60_000,
    now: () => Date.parse("2026-08-02T00:00:00.000Z"),
    setTimeout: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout: () => {}
  });

  await assert.rejects(
    circuit.fetchText("https://duckduckgo.com/html/?q=stalled-body"),
    (error) => error.code === "public_search_timeout" &&
      error.retryAt === "2026-08-02T00:01:00.000Z"
  );
  assert.equal(observedAbort, true);
});

test("a timed-out transport keeps circuit admission until registered teardown settles", async () => {
  let calls = 0;
  let finishTeardown;
  const teardown = new Promise((resolve) => {
    finishTeardown = resolve;
  });
  const circuit = createPublicSearchCircuit({
    transport: async (_input, { signal, registerTeardown }) => {
      calls += 1;
      if (calls > 1) return boundedResult("second");
      registerTeardown(teardown);
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    timeoutMs: 10,
    failureThreshold: 5,
    cooldownMs: 60_000
  });

  await assert.rejects(
    circuit.fetchText("https://duckduckgo.com/html/?q=first"),
    (error) => error.code === "public_search_timeout"
  );
  const queued = circuit.fetchText("https://duckduckgo.com/html/?q=queued");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  finishTeardown();
  assert.equal((await queued).text, "second");
  assert.equal(calls, 2);
});

test("bounded transport body-limit failures do not poison the provider circuit", async () => {
  let calls = 0;
  const circuit = createPublicSearchCircuit({
    transport: async () => {
      calls += 1;
      const error = new Error("Response exceeded the 4-byte encoded body limit.");
      error.code = "public_body_limit";
      throw error;
    },
    maxEncodedBodyBytes: 4,
    maxDecodedBodyBytes: 8,
    failureThreshold: 1,
    cooldownMs: 60_000
  });

  await assert.rejects(
    circuit.fetchText("https://duckduckgo.com/html/?q=oversized"),
    (error) => error.code === "public_search_body_limit" && error.retryAt === null
  );
  await assert.rejects(
    circuit.fetchText("https://duckduckgo.com/html/?q=also-oversized"),
    (error) => error.code === "public_search_body_limit" && error.retryAt === null
  );
  assert.equal(calls, 2);
  assert.equal(circuit.snapshot().state, "closed");
});
