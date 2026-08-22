import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchTextWithRetry } from "../scripts/lib/retrying-http-text.mjs";

describe("retrying HTTP text requests", () => {
  it("retries transient HTTP responses and then returns the successful body", async () => {
    let attempts = 0;
    const retries = [];
    const result = await fetchTextWithRetry("https://example.test/catalog", {
      fetch: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("busy", { status: 503 })
          : new Response("ready", { status: 200 });
      },
      random: () => 0,
      sleep: async () => {},
      onRetry: (event) => retries.push(event)
    });

    assert.equal(result.text, "ready");
    assert.equal(result.attempts, 2);
    assert.equal(attempts, 2);
    assert.deepEqual(retries.map((event) => event.status), [503]);
  });

  it("keeps the attempt timeout active while reading the response body", async () => {
    let attempts = 0;
    const result = await fetchTextWithRetry("https://example.test/catalog", {
      fetch: async (_input, init) => {
        attempts += 1;
        if (attempts > 1) return new Response("ready", { status: 200 });
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          })
        };
      },
      timeoutMs: 5,
      totalTimeoutMs: 100,
      random: () => 0,
      sleep: async () => {}
    });

    assert.equal(result.text, "ready");
    assert.equal(attempts, 2);
  });

  it("does not retry ordinary non-transient HTTP failures", async () => {
    let attempts = 0;
    const result = await fetchTextWithRetry("https://example.test/missing", {
      fetch: async () => {
        attempts += 1;
        return new Response("missing", { status: 404 });
      }
    });

    assert.equal(result.response.status, 404);
    assert.equal(result.attempts, 1);
    assert.equal(attempts, 1);
  });

  it("stops before another attempt when the overall caller aborts during backoff", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const pending = fetchTextWithRetry("https://example.test/catalog", {
      signal: controller.signal,
      fetch: async () => {
        attempts += 1;
        return new Response("busy", { status: 503 });
      },
      sleep: async (_delayMs, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        controller.abort(new Error("caller stopped refresh"));
      })
    });

    await assert.rejects(pending, /caller stopped refresh/);
    assert.equal(attempts, 1);
  });
});
