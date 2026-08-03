import assert from "node:assert/strict";
import test from "node:test";

import {
  PublicSearchUnavailableError,
  createPublicSearchCircuit
} from "../scripts/lib/public-search-circuit.mjs";

test("opens after two transport failures and rejects later searches without network work", async () => {
  let currentTime = Date.parse("2026-08-02T00:00:00.000Z");
  let calls = 0;
  const circuit = createPublicSearchCircuit({
    fetch: async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    },
    failureThreshold: 2,
    cooldownMs: 60_000,
    timeoutMs: 5_000,
    now: () => currentTime
  });

  await assert.rejects(
    circuit.fetch("https://duckduckgo.com/html/?q=one"),
    (error) => error instanceof PublicSearchUnavailableError &&
      error.code === "public_search_transport_failure" &&
      error.retryAt === null
  );
  await assert.rejects(
    circuit.fetch("https://duckduckgo.com/html/?q=two"),
    (error) => error.code === "public_search_transport_failure" &&
      error.retryAt === "2026-08-02T00:01:00.000Z"
  );
  await assert.rejects(
    circuit.fetch("https://duckduckgo.com/html/?q=three"),
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
    fetch: async () => {
      calls += 1;
      return new Response("blocked", { status: 403 });
    },
    failureThreshold: 5,
    cooldownMs: 60_000,
    timeoutMs: 5_000,
    now: () => Date.parse("2026-08-02T00:00:00.000Z")
  });

  await assert.rejects(
    circuit.fetch("https://duckduckgo.com/html/?q=one"),
    (error) => error.code === "public_search_access_blocked" &&
      error.status === 403 &&
      error.retryAt === "2026-08-02T00:01:00.000Z"
  );
  await assert.rejects(
    circuit.fetch("https://duckduckgo.com/html/?q=two"),
    (error) => error.code === "public_search_circuit_open"
  );
  assert.equal(calls, 1);
});

test("a successful probe resets consecutive transport failures", async () => {
  const outcomes = [new Error("temporary"), new Response("ok"), new Error("temporary")];
  const circuit = createPublicSearchCircuit({
    fetch: async () => {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    failureThreshold: 2,
    cooldownMs: 60_000,
    timeoutMs: 5_000
  });

  await assert.rejects(circuit.fetch("https://duckduckgo.com/html/?q=one"));
  assert.equal((await circuit.fetch("https://duckduckgo.com/html/?q=two")).status, 200);
  await assert.rejects(circuit.fetch("https://duckduckgo.com/html/?q=three"));
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
    fetch: async () => {
      calls += 1;
      return first;
    },
    failureThreshold: 1,
    cooldownMs: 60_000,
    timeoutMs: 5_000
  });

  const firstRequest = circuit.fetch("https://duckduckgo.com/html/?q=one");
  const queuedRequest = circuit.fetch("https://duckduckgo.com/html/?q=two");
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
