import assert from "node:assert/strict";
import test from "node:test";

import {
  LinkedInPublicUnavailableError,
  createLinkedInPublicCircuit,
  linkedinPublicBlockerFromError
} from "../scripts/lib/linkedin-public-circuit.mjs";

test("uses a shorter degraded deadline, opens after two timeouts, and stops network work", async () => {
  let currentTime = Date.parse("2026-08-02T20:00:00.000Z");
  let calls = 0;
  const circuit = createLinkedInPublicCircuit({
    fetch: async () => {
      calls += 1;
      return new Promise(() => {});
    },
    directTimeoutMs: 10,
    directDegradedTimeoutMs: 4,
    readerTimeoutMs: 10,
    readerDegradedTimeoutMs: 4,
    failureThreshold: 2,
    cooldownMs: 60_000,
    now: () => currentTime,
    setTimeout: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout: () => {}
  });

  await assert.rejects(
    circuit.fetch("https://www.linkedin.com/company/one", { provider: "linkedin_public_html" }),
    (error) => error instanceof LinkedInPublicUnavailableError &&
      error.code === "linkedin_public_timeout" &&
      /after 10ms/.test(error.message) &&
      error.retryAt === null
  );
  await assert.rejects(
    circuit.fetch("https://www.linkedin.com/company/two", { provider: "linkedin_public_html" }),
    (error) => error.code === "linkedin_public_timeout" &&
      /after 4ms/.test(error.message) &&
      error.retryAt === "2026-08-02T20:01:00.000Z"
  );
  await assert.rejects(
    circuit.fetch("https://www.linkedin.com/company/three", { provider: "linkedin_public_html" }),
    (error) => error.code === "linkedin_public_circuit_open" &&
      error.retryAt === "2026-08-02T20:01:00.000Z"
  );
  assert.equal(calls, 2);

  currentTime += 60_000;
  assert.equal(circuit.snapshot().linkedin_public_html.state, "closed");
});

test("keeps direct LinkedIn and Jina reader health independent", async () => {
  const calls = [];
  const circuit = createLinkedInPublicCircuit({
    fetch: async (input) => {
      calls.push(String(input));
      return new URL(String(input)).hostname.endsWith("linkedin.com")
        ? new Response("rate limited", { status: 429 })
        : new Response("reader ok", { status: 200 });
    },
    failureThreshold: 5,
    cooldownMs: 60_000,
    now: () => Date.parse("2026-08-02T20:00:00.000Z")
  });

  await assert.rejects(
    circuit.fetch("https://www.linkedin.com/company/one", { provider: "linkedin_public_html" }),
    (error) => error.code === "linkedin_public_access_blocked" &&
      error.status === 429 &&
      error.retryAt === "2026-08-02T20:01:00.000Z"
  );
  assert.equal(
    (await circuit.fetch("https://r.jina.ai/http://https://www.linkedin.com/company/one", {
      provider: "jina_linkedin_reader"
    })).status,
    200
  );
  await assert.rejects(
    circuit.fetch("https://www.linkedin.com/company/two", { provider: "linkedin_public_html" }),
    (error) => error.code === "linkedin_public_circuit_open"
  );
  assert.equal(calls.length, 2, "the direct circuit must not consume another network call");
  assert.equal(circuit.snapshot().linkedin_public_html.state, "open");
  assert.equal(circuit.snapshot().jina_linkedin_reader.state, "closed");
});

test("serializes native and reader probes through one anonymous admission lane", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const circuit = createLinkedInPublicCircuit({
    fetch: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await firstGate;
      active -= 1;
      return new Response("ok", { status: 200 });
    }
  });

  const direct = circuit.fetch("https://www.linkedin.com/in/one", {
    provider: "linkedin_public_html"
  });
  const reader = circuit.fetch("https://r.jina.ai/http://https://www.linkedin.com/in/one", {
    provider: "jina_linkedin_reader"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "the reader must wait behind the in-flight native probe");
  releaseFirst();
  await Promise.all([direct, reader]);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test("retries after cooldown and closes the circuit on a successful half-open probe", async () => {
  let currentTime = Date.parse("2026-08-02T20:00:00.000Z");
  const outcomes = [new Error("reader offline"), new Response("reader recovered", { status: 200 })];
  const circuit = createLinkedInPublicCircuit({
    fetch: async () => {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    failureThreshold: 1,
    cooldownMs: 60_000,
    now: () => currentTime
  });

  await assert.rejects(
    circuit.fetch("https://r.jina.ai/http://https://www.linkedin.com/in/one", {
      provider: "jina_linkedin_reader"
    }),
    (error) => error.code === "linkedin_public_transport_failure" && Boolean(error.retryAt)
  );
  currentTime += 60_000;
  const response = await circuit.fetch(
    "https://r.jina.ai/http://https://www.linkedin.com/in/one",
    { provider: "jina_linkedin_reader" }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(circuit.snapshot().jina_linkedin_reader, {
    provider: "jina_linkedin_reader",
    state: "closed",
    consecutiveFailures: 0,
    retryAt: null,
    lastFailure: null
  });
});

test("does not poison unrelated accounts when a target returns 404", async () => {
  let calls = 0;
  const circuit = createLinkedInPublicCircuit({
    fetch: async () => {
      calls += 1;
      return new Response("not found", { status: 404 });
    },
    failureThreshold: 1,
    cooldownMs: 60_000
  });

  assert.equal((await circuit.fetch("https://www.linkedin.com/in/missing", {
    provider: "linkedin_public_html"
  })).status, 404);
  assert.equal((await circuit.fetch("https://www.linkedin.com/in/another", {
    provider: "linkedin_public_html"
  })).status, 404);
  assert.equal(calls, 2);
  assert.equal(circuit.snapshot().linkedin_public_html.state, "closed");
});

test("ordinary LinkedIn guest chrome does not open the provider circuit", async () => {
  const circuit = createLinkedInPublicCircuit({
    fetch: async () => new Response(
      '<html><head><title>Example | LinkedIn</title><script>const captchaFeature = true;</script></head>' +
      '<body>Agree & Join LinkedIn Sign in to continue</body></html>',
      { status: 200 }
    ),
    failureThreshold: 1,
    cooldownMs: 60_000
  });

  assert.equal((await circuit.fetchText("https://www.linkedin.com/in/example", {
    provider: "linkedin_public_html"
  })).response.status, 200);
  assert.equal(circuit.snapshot().linkedin_public_html.state, "closed");
});

test("the deadline covers a stalled response body, not only response headers", async () => {
  const circuit = createLinkedInPublicCircuit({
    fetch: async () => new Response(new ReadableStream({ start() {} })),
    directTimeoutMs: 10,
    directDegradedTimeoutMs: 4,
    failureThreshold: 1,
    cooldownMs: 60_000,
    now: () => Date.parse("2026-08-02T20:00:00.000Z"),
    setTimeout: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout: () => {}
  });

  await assert.rejects(
    circuit.fetchText("https://www.linkedin.com/in/example", {
      provider: "linkedin_public_html"
    }),
    (error) => error.code === "linkedin_public_timeout" &&
      error.retryAt === "2026-08-02T20:01:00.000Z"
  );
});

test("oversized bodies become target blockers without opening the provider circuit", async () => {
  let calls = 0;
  const circuit = createLinkedInPublicCircuit({
    fetch: async () => {
      calls += 1;
      return new Response("12345", { status: 200 });
    },
    directMaxBodyBytes: 4,
    failureThreshold: 1,
    cooldownMs: 60_000
  });

  await assert.rejects(
    circuit.fetchText("https://www.linkedin.com/in/oversized", {
      provider: "linkedin_public_html"
    }),
    (error) => error.code === "linkedin_public_body_limit" && error.retryAt === null
  );
  await assert.rejects(
    circuit.fetchText("https://www.linkedin.com/in/also-oversized", {
      provider: "linkedin_public_html"
    }),
    (error) => error.code === "linkedin_public_body_limit" && error.retryAt === null
  );
  assert.equal(calls, 2);
  assert.equal(circuit.snapshot().linkedin_public_html.state, "closed");
});

test("turns an HTTP 200 provider challenge into an exact cooldown blocker", async () => {
  const circuit = createLinkedInPublicCircuit({
    fetch: async () => new Response(
      "<html><body>SecurityCompromiseError anonymous access blocked until later</body></html>",
      { status: 200 }
    ),
    cooldownMs: 60_000,
    now: () => Date.parse("2026-08-02T20:00:00.000Z")
  });

  let blocker;
  await assert.rejects(
    circuit.fetchText("https://r.jina.ai/http://https://www.linkedin.com/in/one", {
      provider: "jina_linkedin_reader"
    }),
    (error) => {
      blocker = linkedinPublicBlockerFromError(error);
      return true;
    }
  );
  assert.deepEqual(blocker, {
    provider: "jina_linkedin_reader",
    code: "linkedin_public_soft_block",
    retryAt: "2026-08-02T20:01:00.000Z",
    httpStatus: 200,
    message:
      "Jina LinkedIn public reader returned an HTTP 200 challenge/block page; " +
      "circuit open until 2026-08-02T20:01:00.000Z"
  });
});
