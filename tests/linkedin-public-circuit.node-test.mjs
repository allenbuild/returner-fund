import assert from "node:assert/strict";
import test from "node:test";

import { createLinkedInPublicCircuit } from "../scripts/lib/linkedin-public-circuit.mjs";

test("LinkedIn HTTP error responses are canceled before the deadline is cleared", async () => {
  let cancellations = 0;
  const circuit = createLinkedInPublicCircuit({
    fetch: async () => new Response(new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancellations += 1;
      }
    }), { status: 403 }),
    directTimeoutMs: 5_000,
    directDegradedTimeoutMs: 5_000,
    failureThreshold: 1,
    cooldownMs: 60_000
  });

  await assert.rejects(
    circuit.fetchText("https://www.linkedin.com/company/example", {
      provider: "linkedin_public_html"
    }),
    (error) => error.code === "linkedin_public_access_blocked" && error.status === 403
  );
  assert.equal(cancellations, 1);
});

test("LinkedIn timeout admission remains occupied until transport teardown settles", async () => {
  let calls = 0;
  let finishTeardown;
  const teardown = new Promise((resolve) => {
    finishTeardown = resolve;
  });
  const circuit = createLinkedInPublicCircuit({
    fetch: async (_input, { signal, registerTeardown }) => {
      calls += 1;
      if (calls > 1) return new Response("second", { status: 200 });
      registerTeardown(teardown);
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    directTimeoutMs: 10,
    directDegradedTimeoutMs: 10,
    failureThreshold: 5,
    cooldownMs: 60_000
  });

  await assert.rejects(
    circuit.fetchText("https://www.linkedin.com/company/first", {
      provider: "linkedin_public_html"
    }),
    (error) => error.code === "linkedin_public_timeout"
  );
  const queued = circuit.fetchText("https://www.linkedin.com/company/queued", {
    provider: "linkedin_public_html"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  finishTeardown();
  assert.equal((await queued).text, "second");
  assert.equal(calls, 2);
});
