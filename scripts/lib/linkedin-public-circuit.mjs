const DEFAULT_DIRECT_TIMEOUT_MS = 8_000;
const DEFAULT_DIRECT_DEGRADED_TIMEOUT_MS = 5_000;
const DEFAULT_READER_TIMEOUT_MS = 10_000;
const DEFAULT_READER_DEGRADED_TIMEOUT_MS = 6_000;
const DEFAULT_DIRECT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_READER_MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;

const PROVIDERS = Object.freeze({
  DIRECT: "linkedin_public_html",
  READER: "jina_linkedin_reader"
});

const IMMEDIATE_BLOCK_STATUSES = new Set([401, 403, 429, 451, 999]);

class LinkedInPublicBodyLimitError extends Error {
  constructor(limit) {
    super(`LinkedIn public source exceeded the ${limit}-byte response limit`);
    this.name = "LinkedInPublicBodyLimitError";
    this.limit = limit;
  }
}

export class LinkedInPublicUnavailableError extends Error {
  constructor(message, {
    code = "linkedin_public_unavailable",
    provider,
    retryAt = null,
    status = null,
    cause
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "LinkedInPublicUnavailableError";
    this.code = code;
    this.provider = provider;
    this.retryAt = retryAt;
    this.status = status;
    this.retryable = true;
  }
}

/**
 * One anonymous LinkedIn lane with independent native-page and Jina circuits.
 *
 * A mapped profile used to pay a full native-page timeout and then a full Jina
 * timeout. Repeating that pair for every account made a provider outage look
 * like slow progress. This circuit keeps the existing single-request LinkedIn
 * admission policy, gives the first probe a reasonable deadline, shortens the
 * second degraded probe, and then emits an exact cooldown receipt. Native and
 * reader state stay independent so either source can remain a valid fallback.
 */
export function createLinkedInPublicCircuit(options = {}) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("createLinkedInPublicCircuit requires a fetch implementation");
  }

  const failureThreshold = positiveInteger(
    options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
    "failureThreshold"
  );
  const cooldownMs = nonNegativeInteger(options.cooldownMs ?? DEFAULT_COOLDOWN_MS, "cooldownMs");
  const providerConfig = Object.freeze({
    [PROVIDERS.DIRECT]: timeoutConfig(
      options.directTimeoutMs ?? DEFAULT_DIRECT_TIMEOUT_MS,
      options.directDegradedTimeoutMs ?? DEFAULT_DIRECT_DEGRADED_TIMEOUT_MS,
      options.directMaxBodyBytes ?? DEFAULT_DIRECT_MAX_BODY_BYTES,
      "direct"
    ),
    [PROVIDERS.READER]: timeoutConfig(
      options.readerTimeoutMs ?? DEFAULT_READER_TIMEOUT_MS,
      options.readerDegradedTimeoutMs ?? DEFAULT_READER_DEGRADED_TIMEOUT_MS,
      options.readerMaxBodyBytes ?? DEFAULT_READER_MAX_BODY_BYTES,
      "reader"
    )
  });
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeout ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  if (typeof now !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function") {
    throw new TypeError("createLinkedInPublicCircuit requires functional clock methods");
  }

  const states = new Map(
    Object.values(PROVIDERS).map((provider) => [provider, {
      consecutiveFailures: 0,
      lastFailure: null,
      openUntil: 0
    }])
  );
  let admissionTail = Promise.resolve();

  async function fetchThroughCircuit(input, init = {}, { readText = false } = {}) {
    const provider = normalizeProvider(init.provider);
    const state = states.get(provider);
    const previous = admissionTail;
    let release;
    admissionTail = new Promise((resolve) => {
      release = resolve;
    });
    let admitted = false;
    const teardownRegistry = createTransportTeardownRegistry();

    try {
      await waitForAdmission(previous, init.signal);
      admitted = true;
      const currentTime = now();
      if (state.openUntil > currentTime) {
        throw circuitOpenError(provider, state);
      }

      const controller = new AbortController();
      const parentSignal = init.signal;
      const timeoutMs = state.consecutiveFailures > 0
        ? providerConfig[provider].degradedTimeoutMs
        : providerConfig[provider].timeoutMs;

      try {
        const result = await fetchWithDeadline({
          fetchImplementation,
          input,
          init: withoutProvider(init),
          controller,
          parentSignal,
          timeoutMs,
          readText,
          maxBodyBytes: providerConfig[provider].maxBodyBytes,
          setTimer,
          clearTimer,
          teardownRegistry
        });
        const response = readText ? result.response : result;

        if (isProviderFailureStatus(response.status)) {
          const immediate = IMMEDIATE_BLOCK_STATUSES.has(response.status);
          const failure = `${providerLabel(provider)} returned HTTP ${response.status}`;
          recordFailure(state, failure, { immediate });
          throw unavailableError(provider, state, failure, {
            code: immediate ? "linkedin_public_access_blocked" : "linkedin_public_http_failure",
            status: response.status
          });
        }

        if (response.ok && readText) {
          if (looksLikeProviderWideBlock(result.text, provider)) {
            const failure = `${providerLabel(provider)} returned an HTTP 200 challenge/block page`;
            recordFailure(state, failure, { immediate: true });
            throw unavailableError(provider, state, failure, {
              code: "linkedin_public_soft_block",
              status: response.status
            });
          }
        }

        // Account-specific 404/410 responses are not provider outages. The
        // caller retains the native HTTP response and records the exact target
        // failure without poisoning unrelated profiles.
        state.consecutiveFailures = 0;
        state.lastFailure = null;
        return readText ? Object.freeze({ response, text: result.text }) : response;
      } catch (error) {
        if (error instanceof LinkedInPublicUnavailableError) throw error;
        if (parentSignal?.aborted) throw error;
        if (error instanceof LinkedInPublicBodyLimitError) {
          throw unavailableError(provider, state, error.message, {
            code: "linkedin_public_body_limit"
          });
        }

        const failure = controller.signal.aborted
          ? `${providerLabel(provider)} timed out after ${timeoutMs}ms`
          : `${providerLabel(provider)} transport failed: ${errorMessage(error)}`;
        recordFailure(state, failure);
        throw unavailableError(provider, state, failure, {
          code: controller.signal.aborted
            ? "linkedin_public_timeout"
            : "linkedin_public_transport_failure",
          cause: error
        });
      }
    } finally {
      if (admitted) void teardownRegistry.drain().then(release, release);
      else void previous.then(release, release);
    }
  }

  function recordFailure(state, message, { immediate = false } = {}) {
    state.consecutiveFailures += 1;
    state.lastFailure = message;
    if (immediate || state.consecutiveFailures >= failureThreshold) {
      state.openUntil = now() + cooldownMs;
    }
  }

  function unavailableError(provider, state, message, details = {}) {
    const retryAt = state.openUntil > now() ? new Date(state.openUntil).toISOString() : null;
    return new LinkedInPublicUnavailableError(
      retryAt ? `${message}; circuit open until ${retryAt}` : message,
      { ...details, provider, retryAt }
    );
  }

  return Object.freeze({
    fetch: (input, init) => fetchThroughCircuit(input, init),
    fetchText: (input, init) => fetchThroughCircuit(input, init, { readText: true }),
    snapshot() {
      const currentTime = now();
      return Object.freeze(Object.fromEntries(
        [...states.entries()].map(([provider, state]) => [provider, Object.freeze({
          provider,
          state: state.openUntil > currentTime ? "open" : "closed",
          consecutiveFailures: state.consecutiveFailures,
          retryAt: state.openUntil > currentTime ? new Date(state.openUntil).toISOString() : null,
          lastFailure: state.lastFailure
        })])
      ));
    }
  });

  function circuitOpenError(provider, state) {
    const retryAt = new Date(state.openUntil).toISOString();
    return new LinkedInPublicUnavailableError(
      `${providerLabel(provider)} circuit is open until ${retryAt}` +
        `${state.lastFailure ? ` after ${state.lastFailure}` : ""}`,
      {
        code: "linkedin_public_circuit_open",
        provider,
        retryAt
      }
    );
  }
}

export function linkedinPublicBlockerFromError(error) {
  if (!(error instanceof LinkedInPublicUnavailableError)) return null;
  return Object.freeze({
    provider: error.provider,
    code: error.code,
    retryAt: error.retryAt ?? null,
    httpStatus: Number.isInteger(error.status) ? error.status : null,
    message: error.message
  });
}

function timeoutConfig(timeoutMs, degradedTimeoutMs, maxBodyBytes, label) {
  const healthy = positiveInteger(timeoutMs, `${label}TimeoutMs`);
  const degraded = positiveInteger(degradedTimeoutMs, `${label}DegradedTimeoutMs`);
  const bodyLimit = positiveInteger(maxBodyBytes, `${label}MaxBodyBytes`);
  if (degraded > healthy) {
    throw new RangeError(`${label}DegradedTimeoutMs must be <= ${label}TimeoutMs`);
  }
  return Object.freeze({
    timeoutMs: healthy,
    degradedTimeoutMs: degraded,
    maxBodyBytes: bodyLimit
  });
}

function normalizeProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!Object.values(PROVIDERS).includes(provider)) {
    throw new TypeError(
      `LinkedIn public circuit provider must be ${Object.values(PROVIDERS).join(" or ")}`
    );
  }
  return provider;
}

function providerLabel(provider) {
  return provider === PROVIDERS.DIRECT
    ? "LinkedIn anonymous public HTML"
    : "Jina LinkedIn public reader";
}

function isProviderFailureStatus(status) {
  return IMMEDIATE_BLOCK_STATUSES.has(status) || status === 408 || status === 425 || status >= 500;
}

function looksLikeProviderWideBlock(text, provider) {
  const head = String(text ?? "").slice(0, 20_000);
  if (/SecurityCompromiseError|anonymous access\s+to\s+.*?\s+blocked until/i.test(head)) return true;
  if (/\b(?:too many requests|rate limit exceeded)\b/i.test(head)) return true;
  if (provider === PROVIDERS.DIRECT) {
    // Avoid matching dormant CAPTCHA strings in LinkedIn's large JavaScript
    // bundles. Only visible document/challenge markers open the global lane.
    return /<(?:title|h1)[^>]*>[^<]*(?:captcha|checkpoint|temporarily blocked)|<(?:form|div)[^>]+(?:id|class)=["'][^"']*(?:captcha|challenge-form|checkpoint)/i.test(head);
  }
  return /^(?:Title:\s*)?(?:access denied|captcha|temporarily blocked)\b/im.test(head) ||
    /\bcomplete (?:this |the )?captcha challenge\b/i.test(head);
}

function withoutProvider(init) {
  const fetchInit = { ...init };
  delete fetchInit.provider;
  return fetchInit;
}

function waitForAdmission(previous, signal) {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function fetchWithDeadline({
  fetchImplementation,
  input,
  init,
  controller,
  parentSignal,
  timeoutMs,
  readText,
  maxBodyBytes,
  setTimer,
  clearTimer,
  teardownRegistry
}) {
  let timer;
  let onParentAbort;
  const deadline = new Promise((_, reject) => {
    timer = setTimer(() => {
      const error = new Error(`LinkedIn public source timed out after ${timeoutMs}ms`);
      error.code = "LINKEDIN_PUBLIC_TIMEOUT";
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const callerAbort = parentSignal
    ? new Promise((_, reject) => {
        onParentAbort = () => {
          const reason = abortReason(parentSignal);
          controller.abort(reason);
          reject(reason);
        };
        if (parentSignal.aborted) onParentAbort();
        else parentSignal.addEventListener("abort", onParentAbort, { once: true });
      })
    : new Promise(() => {});

  try {
    const transportPromise = Promise.resolve().then(async () => {
        const response = await fetchImplementation(input, {
          ...init,
          signal: controller.signal,
          registerTeardown: teardownRegistry.register
        });
        if (!readText) return response;
        if (isProviderFailureStatus(response.status)) {
          await cancelBody(response.body);
          return { response, text: "" };
        }
        try {
          const text = await boundedResponseText(response, maxBodyBytes, {
            signal: controller.signal
          });
          return { response, text };
        } catch (error) {
          await cancelBody(response.body, error);
          throw error;
        }
      });
    transportPromise.catch(() => {});
    teardownRegistry.register(transportPromise);
    return await Promise.race([
      transportPromise,
      deadline,
      callerAbort
    ]);
  } finally {
    clearTimer(timer);
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  }
}

function createTransportTeardownRegistry() {
  const pending = [];
  const register = (value) => {
    if (!value || typeof value.then !== "function") return;
    pending.push(Promise.resolve(value).catch(() => undefined));
  };
  return {
    register,
    async drain() {
      let drainedThrough = 0;
      while (true) {
        const batch = pending.slice(drainedThrough);
        drainedThrough = pending.length;
        if (batch.length > 0) await Promise.all(batch);
        await Promise.resolve();
        if (drainedThrough === pending.length) return;
      }
    }
  };
}

async function boundedResponseText(response, maxBodyBytes, { signal } = {}) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    await cancelBody(response.body);
    throw new LinkedInPublicBodyLimitError(maxBodyBytes);
  }
  if (!response.body?.getReader) {
    await cancelBody(response.body);
    throw new TypeError("LinkedIn response body does not expose a bounded streaming reader");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  const onAbort = () => {
    void reader.cancel(abortReason(signal)).catch(() => {});
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        await reader.cancel();
        throw new LinkedInPublicBodyLimitError(maxBodyBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

async function cancelBody(body, reason) {
  if (!body) return;
  try {
    if (typeof body.cancel === "function") {
      await body.cancel(reason);
      return;
    }
    if (typeof body.destroy === "function") {
      body.on?.("error", () => {});
      body.destroy(reason instanceof Error ? reason : undefined);
    }
  } catch {
    // The response is already being abandoned; cancellation is best-effort.
  }
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("LinkedIn public source request aborted by caller");
  error.name = "AbortError";
  return error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}
