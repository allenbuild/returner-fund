const DEFAULT_TIMEOUT_MS = 8_000;
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
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("createPublicSearchCircuit requires a fetch implementation");
  }

  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
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
        const response = await fetchWithDeadline({
          fetchImplementation,
          input,
          init,
          controller,
          parentSignal,
          timeoutMs,
          setTimer,
          clearTimer
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

        const responseText = await response.clone().text();
        if (looksLikePublicSearchSoftBlock(responseText)) {
          const failure = "DuckDuckGo public search returned an HTTP 200 challenge/block page";
          recordFailure(failure, { immediate: true });
          throw unavailableError(failure, {
            code: "public_search_soft_block",
            status: response.status
          });
        }

        consecutiveFailures = 0;
        lastFailure = null;
        return response;
      } catch (error) {
        if (error instanceof PublicSearchUnavailableError) throw error;
        if (parentSignal?.aborted) throw error;

        const failure = controller.signal.aborted
          ? `DuckDuckGo public search timed out after ${timeoutMs}ms`
          : `DuckDuckGo public search transport failed: ${errorMessage(error)}`;
        recordFailure(failure);
        throw unavailableError(failure, {
          code: controller.signal.aborted ? "public_search_timeout" : "public_search_transport_failure",
          cause: error
        });
      }
    } finally {
      if (admitted) release();
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
    fetch: fetchThroughCircuit,
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
  fetchImplementation,
  input,
  init,
  controller,
  parentSignal,
  timeoutMs,
  setTimer,
  clearTimer
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
    return await Promise.race([
      Promise.resolve().then(() => fetchImplementation(input, { ...init, signal: controller.signal })),
      deadline,
      callerAbort
    ]);
  } finally {
    clearTimer(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
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
