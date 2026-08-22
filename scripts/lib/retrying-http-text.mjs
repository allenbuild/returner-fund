import { computeRetryDelay, isRetryableHttpStatus } from "./http-policy.mjs";

const RETRYABLE_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

export async function fetchTextWithRetry(input, {
  fetch: fetchImplementation = globalThis.fetch,
  init = {},
  signal,
  timeoutMs = 30_000,
  totalTimeoutMs = 95_000,
  maxAttempts = 3,
  retry = {},
  random = Math.random,
  sleep = abortableDelay,
  onRetry = () => {}
} = {}) {
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("fetchTextWithRetry requires a fetch implementation");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new RangeError("totalTimeoutMs must be a positive finite number");
  }
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function");
  if (typeof onRetry !== "function") throw new TypeError("onRetry must be a function");

  const requestSignal = combineSignals(signal, AbortSignal.timeout(totalTimeoutMs));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(requestSignal);
    const attemptSignal = combineSignals(requestSignal, AbortSignal.timeout(timeoutMs));
    let response;
    let text;
    let attemptError = null;

    try {
      response = await fetchImplementation(input, { ...init, signal: attemptSignal });
      text = await response.text();
    } catch (error) {
      attemptError = error;
    }

    if (attemptError) {
      if (requestSignal.aborted) throw abortReason(requestSignal);
      const willRetry = isRetryableTransportError(attemptError) && attempt < maxAttempts;
      if (!willRetry) throw attemptError;
      await scheduleRetry({
        input,
        attempt,
        maxAttempts,
        error: attemptError,
        requestSignal,
        retry,
        random,
        sleep,
        onRetry
      });
      continue;
    }

    const willRetry = isRetryableHttpStatus(response.status) && attempt < maxAttempts;
    if (!willRetry) return { response, text, attempts: attempt };
    await scheduleRetry({
      input,
      attempt,
      maxAttempts,
      response,
      requestSignal,
      retry,
      random,
      sleep,
      onRetry
    });
  }

  throw new Error("HTTP retry loop exhausted without a response");
}

export function isRetryableTransportError(error) {
  if (error?.name === "TimeoutError" || error?.name === "TypeError") return true;
  return RETRYABLE_TRANSPORT_CODES.has(error?.code) ||
    RETRYABLE_TRANSPORT_CODES.has(error?.cause?.code);
}

async function scheduleRetry({
  input,
  attempt,
  maxAttempts,
  response,
  error,
  requestSignal,
  retry,
  random,
  sleep,
  onRetry
}) {
  const delay = computeRetryDelay({ attempt, response, random, ...retry });
  try {
    onRetry(Object.freeze({
      input: String(input),
      attempt,
      maxAttempts,
      status: response?.status ?? null,
      errorName: error?.name ?? null,
      delayMs: delay.delayMs,
      delaySource: delay.source
    }));
  } catch {
    // Retry diagnostics must never change request behavior.
  }
  await sleep(delay.delayMs, requestSignal);
}

function combineSignals(...signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 1) return activeSignals[0];
  return AbortSignal.any(activeSignals);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function abortableDelay(delayMs, signal) {
  throwIfAborted(signal);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => finish(abortReason(signal));
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
  });
}
