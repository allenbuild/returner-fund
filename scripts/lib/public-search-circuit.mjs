const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_ENCODED_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DECODED_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const IMMEDIATE_BLOCK_STATUSES = new Set([401, 403, 429, 451]);

export class PublicSearchUnavailableError extends Error {
  constructor(message, {
    code = "public_search_unavailable",
    provider = "duckduckgo_html",
    retryAt = null,
    status = null,
    cause
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PublicSearchUnavailableError";
    this.code = code;
    this.provider = provider;
    this.retryAt = retryAt;
    this.status = status;
    this.retryable = true;
  }
}

/**
 * A deliberately small, process-wide public-search admission lane.
 *
 * Missing-account discovery can fan out into thousands of queries. When the
 * shared search provider is unreachable, letting every entity pay a full
 * network timeout both slows the run and obscures the real coverage blocker.
 * This lane serializes probes, opens after repeated transport failures (or an
 * explicit auth/rate-limit response), and returns a structured, timestamped
 * blocker without converting the outage into a false "no account exists".
 */
export function createPublicSearchCircuit(options = {}) {
  const boundedTransport = options.transport;
  if (typeof boundedTransport !== "function") {
    throw new TypeError("createPublicSearchCircuit requires a bounded transport implementation");
  }

  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxEncodedBodyBytes = positiveInteger(
    options.maxEncodedBodyBytes ?? DEFAULT_MAX_ENCODED_BODY_BYTES,
    "maxEncodedBodyBytes"
  );
  const maxDecodedBodyBytes = positiveInteger(
    options.maxDecodedBodyBytes ?? DEFAULT_MAX_DECODED_BODY_BYTES,
    "maxDecodedBodyBytes"
  );
  const failureThreshold = positiveInteger(
    options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
    "failureThreshold"
  );
  const cooldownMs = nonNegativeInteger(options.cooldownMs ?? DEFAULT_COOLDOWN_MS, "cooldownMs");
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeout ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  if (typeof now !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function") {
    throw new TypeError("createPublicSearchCircuit requires functional clock methods");
  }

  let consecutiveFailures = 0;
  let openUntil = 0;
  let lastFailure = null;
  let admissionTail = Promise.resolve();

  async function fetchThroughCircuit(input, init = {}) {
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
      if (openUntil > currentTime) {
        throw circuitOpenError(openUntil, lastFailure);
      }

      const controller = new AbortController();
      const parentSignal = init.signal;

      try {
        const { response, text } = await fetchWithDeadline({
          boundedTransport,
          input,
          init,
          controller,
          parentSignal,
          timeoutMs,
          maxEncodedBodyBytes,
          maxDecodedBodyBytes,
          setTimer,
          clearTimer,
          teardownRegistry
        });
        if (isProviderFailureStatus(response.status)) {
          const immediate = IMMEDIATE_BLOCK_STATUSES.has(response.status);
          const failure = `DuckDuckGo public search returned HTTP ${response.status}`;
          recordFailure(failure, { immediate });
          throw unavailableError(failure, {
            code: immediate ? "public_search_access_blocked" : "public_search_http_failure",
            status: response.status
          });
        }

        if (looksLikePublicSearchSoftBlock(text)) {
          const failure = "DuckDuckGo public search returned an HTTP 200 challenge/block page";
          recordFailure(failure, { immediate: true });
          throw unavailableError(failure, {
            code: "public_search_soft_block",
            status: response.status
          });
        }

        consecutiveFailures = 0;
        lastFailure = null;
        return Object.freeze({ response, text });
      } catch (error) {
        if (error instanceof PublicSearchUnavailableError) throw error;
        if (parentSignal?.aborted) throw error;
        if (isPublicBodyLimitError(error)) {
          throw unavailableError(`DuckDuckGo public search ${errorMessage(error)}`, {
            code: "public_search_body_limit",
            cause: error
          });
        }

        const timedOut = controller.signal.aborted || isPublicTimeoutError(error);
        const failure = timedOut
          ? `DuckDuckGo public search timed out after ${timeoutMs}ms`
          : `DuckDuckGo public search transport failed: ${errorMessage(error)}`;
        recordFailure(failure);
        throw unavailableError(failure, {
          code: timedOut ? "public_search_timeout" : "public_search_transport_failure",
          cause: error
        });
      }
    } finally {
      if (admitted) void teardownRegistry.drain().then(release, release);
      else void previous.then(release, release);
    }
  }

  function recordFailure(message, { immediate = false } = {}) {
    consecutiveFailures += 1;
    lastFailure = message;
    if (immediate || consecutiveFailures >= failureThreshold) {
      openUntil = now() + cooldownMs;
    }
  }

  function unavailableError(message, details = {}) {
    const retryAt = openUntil > now() ? new Date(openUntil).toISOString() : null;
    return new PublicSearchUnavailableError(
      retryAt ? `${message}; circuit open until ${retryAt}` : message,
      { ...details, retryAt }
    );
  }

  return Object.freeze({
    fetchText: fetchThroughCircuit,
    snapshot() {
      const currentTime = now();
      return Object.freeze({
        provider: "duckduckgo_html",
        state: openUntil > currentTime ? "open" : "closed",
        consecutiveFailures,
        retryAt: openUntil > currentTime ? new Date(openUntil).toISOString() : null,
        lastFailure
      });
    }
  });
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
  boundedTransport,
  input,
  init,
  controller,
  parentSignal,
  timeoutMs,
  maxEncodedBodyBytes,
  maxDecodedBodyBytes,
  setTimer,
  clearTimer,
  teardownRegistry
}) {
  let timer;
  let onParentAbort;
  const deadline = new Promise((_, reject) => {
    timer = setTimer(() => {
      const error = new Error(`DuckDuckGo public search timed out after ${timeoutMs}ms`);
      error.code = "PUBLIC_SEARCH_TIMEOUT";
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
    const transportPromise = Promise.resolve().then(() => boundedTransport(input, {
      ...init,
      signal: controller.signal,
      timeoutMs,
      maxResponseBytes: maxEncodedBodyBytes,
      maxDecodedBytes: maxDecodedBodyBytes,
      cancelErrorBody: true,
      registerTeardown: teardownRegistry.register
    }));
    transportPromise.catch(() => {});
    teardownRegistry.register(transportPromise);
    const result = await Promise.race([
      transportPromise,
      deadline,
      callerAbort
    ]);
    if (!result?.response || typeof result.text !== "string") {
      throw new TypeError(
        "DuckDuckGo bounded transport must return { response, text }."
      );
    }
    return result;
  } finally {
    clearTimer(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
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
        // A transport can register its dispatcher/body teardown while the
        // outer transport promise is settling. Recheck after a microtask so a
        // timeout never releases admission ahead of that deeper cleanup.
        await Promise.resolve();
        if (drainedThrough === pending.length) return;
      }
    }
  };
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason ? String(signal.reason) : "The operation was aborted");
  error.name = "AbortError";
  return error;
}

function circuitOpenError(openUntil, lastFailure) {
  const retryAt = new Date(openUntil).toISOString();
  return new PublicSearchUnavailableError(
    `DuckDuckGo public search circuit is open until ${retryAt}` +
      (lastFailure ? ` after: ${lastFailure}` : ""),
    { code: "public_search_circuit_open", retryAt }
  );
}

function isProviderFailureStatus(status) {
  return status >= 400;
}

function isPublicBodyLimitError(error) {
  return error?.code === "public_body_limit";
}

function isPublicTimeoutError(error) {
  return error?.code === "public_fetch_timeout" || error?.code === "PUBLIC_SEARCH_TIMEOUT";
}

function looksLikePublicSearchSoftBlock(value) {
  const text = String(value ?? "").slice(0, 250_000);
  return /(?:anomaly-modal|challenge-form|captcha|unfortunately,? bots use duckduckgo too|complete (?:the following|this) challenge|automated (?:queries|requests)|access denied|temporarily blocked|rate.?limit)/i.test(text);
}

function errorMessage(error) {
  return String(error?.message ?? error ?? "unknown error").replace(/\s+/g, " ").trim();
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer`);
  return value;
}
