const DEFAULTS = Object.freeze({
  globalConcurrency: 8,
  globalPaceMs: 0,
  providerConcurrency: 4,
  providerPaceMs: 0,
  timeoutMs: 30_000,
  totalTimeoutMs: Infinity,
  maxAttempts: 3,
  retry: Object.freeze({
    baseDelayMs: 250,
    maxDelayMs: 30_000
  }),
  circuitBreaker: Object.freeze({
    failureThreshold: 5,
    cooldownMs: 30_000
  })
});

export class CircuitOpenError extends Error {
  constructor(provider, retryAt) {
    super(`HTTP circuit for ${provider} is open until ${new Date(retryAt).toISOString()}`);
    this.name = "CircuitOpenError";
    this.provider = provider;
    this.retryAt = retryAt;
  }
}

export class HttpDeadlineError extends Error {
  constructor(message, { deadlineAt, scope }) {
    super(message);
    this.name = "HttpDeadlineError";
    this.deadlineAt = deadlineAt;
    this.scope = scope;
  }
}

export function isRetryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value == null || String(value).trim() === "") return null;

  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds * 1000)) : null;
  }

  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

export function parseGitHubResetMs(headers, nowMs = Date.now()) {
  const remaining = getHeader(headers, "x-ratelimit-remaining");
  if (remaining !== "0") return null;

  const resetSeconds = Number(getHeader(headers, "x-ratelimit-reset"));
  if (!Number.isFinite(resetSeconds) || resetSeconds < 0) return null;
  return Math.max(0, Math.ceil(resetSeconds * 1000 - nowMs));
}

export function computeRetryDelay({
  attempt,
  response,
  nowMs = Date.now(),
  random = Math.random,
  baseDelayMs = DEFAULTS.retry.baseDelayMs,
  maxDelayMs = DEFAULTS.retry.maxDelayMs
}) {
  assertPositiveInteger(attempt, "attempt");
  assertNonNegativeFinite(baseDelayMs, "baseDelayMs");
  assertNonNegativeFinite(maxDelayMs, "maxDelayMs");

  const exponentialCap = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
  const randomValue = Number(random());
  if (!Number.isFinite(randomValue)) throw new TypeError("random() must return a finite number");
  const unitRandom = Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON);
  const backoffMs = Math.floor(unitRandom * exponentialCap);

  const retryAfterMs = parseRetryAfterMs(getHeader(response?.headers, "retry-after"), nowMs);
  const githubResetMs = parseGitHubResetMs(response?.headers, nowMs);
  const serverCandidates = [
    retryAfterMs == null ? null : { delayMs: retryAfterMs, source: "retry-after" },
    githubResetMs == null ? null : { delayMs: githubResetMs, source: "github-reset" }
  ].filter(Boolean);
  const serverDelay = serverCandidates.reduce(
    (longest, candidate) => candidate.delayMs > longest.delayMs ? candidate : longest,
    { delayMs: 0, source: null }
  );

  if (serverDelay.delayMs > backoffMs) {
    return {
      delayMs: serverDelay.delayMs,
      source: serverDelay.source,
      backoffMs,
      serverDelayMs: serverDelay.delayMs
    };
  }

  return {
    delayMs: backoffMs,
    source: "backoff",
    backoffMs,
    serverDelayMs: serverDelay.delayMs
  };
}

export function createHttpPolicy(options = {}) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("createHttpPolicy requires a fetch implementation");
  }

  const clock = normalizeClock(options.clock);
  const random = options.random ?? Math.random;
  const onEvent = options.onEvent ?? (() => {});
  if (typeof random !== "function") throw new TypeError("random must be a function");
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");

  const baseConfig = normalizeBaseConfig(options);
  const configuredProviders = options.providers ?? {};
  if (!configuredProviders || typeof configuredProviders !== "object" || Array.isArray(configuredProviders)) {
    throw new TypeError("providers must be an object");
  }
  const providers = Object.fromEntries(
    Object.entries(configuredProviders).map(([provider, config]) => [provider.toLowerCase(), config])
  );

  const admission = new AdmissionController(baseConfig.globalConcurrency);
  const pacer = new Pacer(clock);
  const circuits = new CircuitRegistry(clock);
  let nextRequestId = 1;

  async function policyFetch(input, init = {}, requestOptions = {}) {
    if (!requestOptions || typeof requestOptions !== "object" || Array.isArray(requestOptions)) {
      throw new TypeError("request options must be an object");
    }

    const provider = resolveProvider(input, requestOptions.provider);
    const config = providerConfig(baseConfig, providers[provider]);
    const requestId = requestOptions.requestId == null
      ? `http-${nextRequestId++}`
      : String(requestOptions.requestId);
    const method = String(init.method ?? requestMethod(input) ?? "GET").toUpperCase();
    const url = requestUrl(input);
    const requestStartedAt = clock.now();
    const deadlineAt = resolveRequestDeadline(requestStartedAt, config, requestOptions);
    const requestScope = createAbortScope({
      clock,
      parentSignal: init.signal,
      deadlineAt,
      deadlineError: () => new HttpDeadlineError("HTTP request deadline exceeded", {
        deadlineAt,
        scope: "request"
      })
    });
    const circuit = circuits.forProvider(provider, config.circuitBreaker);
    let circuitSettled = false;

    const eventBase = { type: "http_attempt", requestId, provider, method, url };
    const emit = (event) => {
      try {
        onEvent(Object.freeze({ ...eventBase, timestamp: clock.now(), ...event }));
      } catch {
        // Telemetry must not alter request behavior.
      }
    };
    const waitForRetry = async (delayMs, attempt) => {
      try {
        await clock.sleep(delayMs, requestScope.signal);
      } catch (error) {
        const normalizedError = normalizeAbortError(error, null, requestScope.signal);
        const retryable = normalizedError instanceof HttpDeadlineError;
        emit({
          phase: "retry_aborted",
          attempt,
          maxAttempts: config.maxAttempts,
          errorName: normalizedError.name ?? "Error",
          errorMessage: normalizedError.message ?? String(normalizedError),
          retryable,
          willRetry: false
        });
        if (retryable) circuit.recordFailure();
        else circuit.cancelProbe();
        circuitSettled = true;
        throw normalizedError;
      }
    };

    try {
      try {
        circuit.beforeRequest();
      } catch (error) {
        emit({ phase: "circuit_rejected", attempt: 0, retryAt: error.retryAt });
        throw error;
      }

      for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
        throwIfAborted(requestScope.signal);
        const release = await admission.acquire(provider, config.providerConcurrency, requestScope.signal);
        let attemptScope;
        let attemptStartedAt = clock.now();
        let response;
        let attemptError;

        try {
          await pacer.wait(provider, config.globalPaceMs, config.providerPaceMs, requestScope.signal);
          throwIfAborted(requestScope.signal);
          attemptStartedAt = clock.now();

          const attemptDeadlineAt = Math.min(
            deadlineAt,
            Number.isFinite(config.timeoutMs) ? clock.now() + config.timeoutMs : Infinity
          );
          attemptScope = createAbortScope({
            clock,
            parentSignal: requestScope.signal,
            deadlineAt: attemptDeadlineAt,
            deadlineError: () => new HttpDeadlineError("HTTP attempt deadline exceeded", {
              deadlineAt: attemptDeadlineAt,
              scope: "attempt"
            })
          });
          emit({ phase: "start", attempt, maxAttempts: config.maxAttempts });

          response = await abortableFetch(
            fetchImplementation,
            input,
            { ...init, signal: attemptScope.signal },
            attemptScope.signal
          );
        } catch (error) {
          attemptError = normalizeAbortError(error, attemptScope?.signal, requestScope.signal);
        } finally {
          attemptScope?.cleanup();
          release();
        }

        if (attemptError) {
          const requestAborted = requestScope.signal.aborted;
          const retryable = !isCallerAbort(requestScope.signal, init.signal) &&
            (!requestAborted || attemptError instanceof HttpDeadlineError);
          const willRetry = retryable && !requestAborted && attempt < config.maxAttempts;

          emit({
            phase: "error",
            attempt,
            maxAttempts: config.maxAttempts,
            durationMs: Math.max(0, clock.now() - attemptStartedAt),
            errorName: attemptError.name ?? "Error",
            errorMessage: attemptError.message ?? String(attemptError),
            retryable,
            willRetry
          });

          if (!willRetry) {
            if (retryable) circuit.recordFailure();
            else circuit.cancelProbe();
            circuitSettled = true;
            throw attemptError;
          }

          const delay = computeRetryDelay({
            attempt,
            nowMs: clock.now(),
            random,
            ...config.retry
          });
          emit({
            phase: "retry_scheduled",
            attempt,
            maxAttempts: config.maxAttempts,
            errorName: attemptError.name ?? "Error",
            delayMs: delay.delayMs,
            delaySource: delay.source
          });
          await waitForRetry(delay.delayMs, attempt);
          continue;
        }

        const retryable = isRetryableHttpStatus(response.status);
        const willRetry = retryable && attempt < config.maxAttempts;
        emit({
          phase: "response",
          attempt,
          maxAttempts: config.maxAttempts,
          durationMs: Math.max(0, clock.now() - attemptStartedAt),
          status: response.status,
          retryable,
          willRetry
        });

        if (!retryable) {
          circuit.recordSuccess();
          circuitSettled = true;
          return response;
        }

        if (!willRetry) {
          circuit.recordFailure();
          circuitSettled = true;
          return response;
        }

        const delay = computeRetryDelay({
          attempt,
          response,
          nowMs: clock.now(),
          random,
          ...config.retry
        });
        emit({
          phase: "retry_scheduled",
          attempt,
          maxAttempts: config.maxAttempts,
          status: response.status,
          delayMs: delay.delayMs,
          delaySource: delay.source
        });
        await waitForRetry(delay.delayMs, attempt);
      }

      throw new Error("HTTP policy exhausted attempts without a result");
    } finally {
      if (!circuitSettled) circuit.cancelProbe();
      requestScope.cleanup();
    }
  }

  return Object.freeze({
    fetch: policyFetch,
    request: policyFetch,
    getCircuitState(provider) {
      return circuits.snapshot(String(provider).toLowerCase());
    }
  });
}

class AdmissionController {
  constructor(globalLimit) {
    this.globalLimit = globalLimit;
    this.globalActive = 0;
    this.providerActive = new Map();
    this.queue = [];
  }

  acquire(provider, providerLimit, signal) {
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
      const entry = { provider, providerLimit, resolve, reject, signal, onAbort: null };
      entry.onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index === -1) return;
        this.queue.splice(index, 1);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }

  drain() {
    if (this.globalActive >= this.globalLimit) return;

    for (let index = 0; index < this.queue.length && this.globalActive < this.globalLimit;) {
      const entry = this.queue[index];
      const providerCount = this.providerActive.get(entry.provider) ?? 0;
      if (providerCount >= entry.providerLimit) {
        index += 1;
        continue;
      }

      this.queue.splice(index, 1);
      entry.signal?.removeEventListener("abort", entry.onAbort);
      this.globalActive += 1;
      this.providerActive.set(entry.provider, providerCount + 1);
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.globalActive -= 1;
        const active = (this.providerActive.get(entry.provider) ?? 1) - 1;
        if (active === 0) this.providerActive.delete(entry.provider);
        else this.providerActive.set(entry.provider, active);
        this.drain();
      });
    }
  }
}

class Pacer {
  constructor(clock) {
    this.clock = clock;
    this.nextGlobalAt = -Infinity;
    this.nextProviderAt = new Map();
  }

  async wait(provider, globalPaceMs, providerPaceMs, signal) {
    const now = this.clock.now();
    const startAt = Math.max(now, this.nextGlobalAt, this.nextProviderAt.get(provider) ?? -Infinity);
    this.nextGlobalAt = startAt + globalPaceMs;
    this.nextProviderAt.set(provider, startAt + providerPaceMs);
    await this.clock.sleep(Math.max(0, startAt - now), signal);
  }
}

class CircuitRegistry {
  constructor(clock) {
    this.clock = clock;
    this.circuits = new Map();
  }

  forProvider(provider, config) {
    if (config === false) return NOOP_CIRCUIT;
    let circuit = this.circuits.get(provider);
    if (!circuit) {
      circuit = new CircuitBreaker(provider, config, this.clock);
      this.circuits.set(provider, circuit);
    } else {
      circuit.config = config;
    }
    return circuit;
  }

  snapshot(provider) {
    return this.circuits.get(provider)?.snapshot() ?? {
      state: "closed",
      failures: 0,
      retryAt: null,
      probeInFlight: false
    };
  }
}

class CircuitBreaker {
  constructor(provider, config, clock) {
    this.provider = provider;
    this.config = config;
    this.clock = clock;
    this.state = "closed";
    this.failures = 0;
    this.retryAt = null;
    this.probeInFlight = false;
  }

  beforeRequest() {
    const now = this.clock.now();
    if (this.state === "open" && now >= this.retryAt) {
      this.state = "half-open";
      this.probeInFlight = false;
    }
    if (this.state === "open" || (this.state === "half-open" && this.probeInFlight)) {
      throw new CircuitOpenError(this.provider, this.retryAt);
    }
    if (this.state === "half-open") this.probeInFlight = true;
  }

  recordSuccess() {
    this.state = "closed";
    this.failures = 0;
    this.retryAt = null;
    this.probeInFlight = false;
  }

  recordFailure() {
    if (this.state === "half-open") {
      this.open();
      return;
    }

    this.failures += 1;
    if (this.failures >= this.config.failureThreshold) this.open();
  }

  cancelProbe() {
    if (this.state === "half-open" && this.probeInFlight) this.open();
  }

  open() {
    this.state = "open";
    this.retryAt = this.clock.now() + this.config.cooldownMs;
    this.probeInFlight = false;
  }

  snapshot() {
    return {
      state: this.state,
      failures: this.failures,
      retryAt: this.retryAt,
      probeInFlight: this.probeInFlight
    };
  }
}

const NOOP_CIRCUIT = Object.freeze({
  beforeRequest() {},
  recordSuccess() {},
  recordFailure() {},
  cancelProbe() {}
});

function normalizeBaseConfig(options) {
  const defaults = options.defaults ?? {};
  const config = {
    globalConcurrency: defaults.globalConcurrency ?? options.globalConcurrency ?? DEFAULTS.globalConcurrency,
    globalPaceMs: defaults.globalPaceMs ?? options.globalPaceMs ?? DEFAULTS.globalPaceMs,
    providerConcurrency: defaults.providerConcurrency ?? options.providerConcurrency ?? DEFAULTS.providerConcurrency,
    providerPaceMs: defaults.providerPaceMs ?? options.providerPaceMs ?? DEFAULTS.providerPaceMs,
    timeoutMs: defaults.timeoutMs ?? options.timeoutMs ?? DEFAULTS.timeoutMs,
    totalTimeoutMs: defaults.totalTimeoutMs ?? options.totalTimeoutMs ?? DEFAULTS.totalTimeoutMs,
    maxAttempts: defaults.maxAttempts ?? options.maxAttempts ?? DEFAULTS.maxAttempts,
    retry: { ...DEFAULTS.retry, ...options.retry, ...defaults.retry },
    circuitBreaker: options.circuitBreaker === false || defaults.circuitBreaker === false
      ? false
      : { ...DEFAULTS.circuitBreaker, ...options.circuitBreaker, ...defaults.circuitBreaker }
  };
  validateConfig(config);
  return config;
}

function providerConfig(base, override = {}) {
  if (override === false) return { ...base, circuitBreaker: false };
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    throw new TypeError("provider configuration must be an object or false");
  }

  const config = {
    ...base,
    ...override,
    globalConcurrency: base.globalConcurrency,
    globalPaceMs: override.globalPaceMs ?? base.globalPaceMs,
    retry: { ...base.retry, ...override.retry },
    circuitBreaker: override.circuitBreaker === false || base.circuitBreaker === false
      ? false
      : { ...base.circuitBreaker, ...override.circuitBreaker }
  };
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  assertPositiveInteger(config.globalConcurrency, "globalConcurrency");
  assertPositiveInteger(config.providerConcurrency, "providerConcurrency");
  assertNonNegativeFinite(config.globalPaceMs, "globalPaceMs");
  assertNonNegativeFinite(config.providerPaceMs, "providerPaceMs");
  assertPositiveFiniteOrInfinity(config.timeoutMs, "timeoutMs");
  assertPositiveFiniteOrInfinity(config.totalTimeoutMs, "totalTimeoutMs");
  assertPositiveInteger(config.maxAttempts, "maxAttempts");
  assertNonNegativeFinite(config.retry.baseDelayMs, "retry.baseDelayMs");
  assertNonNegativeFinite(config.retry.maxDelayMs, "retry.maxDelayMs");
  if (config.retry.maxDelayMs < config.retry.baseDelayMs) {
    throw new RangeError("retry.maxDelayMs must be greater than or equal to retry.baseDelayMs");
  }
  if (config.circuitBreaker !== false) {
    assertPositiveInteger(config.circuitBreaker.failureThreshold, "circuitBreaker.failureThreshold");
    assertNonNegativeFinite(config.circuitBreaker.cooldownMs, "circuitBreaker.cooldownMs");
  }
}

function normalizeClock(injected = {}) {
  if (!injected || typeof injected !== "object") throw new TypeError("clock must be an object");
  const now = injected.now ?? Date.now;
  const setTimer = injected.setTimeout ?? globalThis.setTimeout;
  const clearTimer = injected.clearTimeout ?? globalThis.clearTimeout;
  if (typeof now !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function") {
    throw new TypeError("clock requires now, setTimeout, and clearTimeout functions");
  }

  const sleepImplementation = injected.sleep;
  return {
    now: () => Number(now.call(injected)),
    setTimeout: (callback, delayMs) => setTimer.call(injected, callback, delayMs),
    clearTimeout: (timer) => clearTimer.call(injected, timer),
    sleep: sleepImplementation
      ? (delayMs, signal) => abortableSleep(sleepImplementation.call(injected, delayMs), signal)
      : (delayMs, signal) => timerSleep(delayMs, signal, setTimer, clearTimer, injected)
  };
}

function createAbortScope({ clock, parentSignal, deadlineAt, deadlineError }) {
  const controller = new AbortController();
  let timer = null;
  const onParentAbort = () => controller.abort(abortReason(parentSignal));

  if (parentSignal?.aborted) controller.abort(abortReason(parentSignal));
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  if (!controller.signal.aborted && Number.isFinite(deadlineAt)) {
    const delayMs = Math.max(0, deadlineAt - clock.now());
    if (delayMs === 0) controller.abort(deadlineError());
    else timer = clock.setTimeout(() => controller.abort(deadlineError()), delayMs);
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timer != null) clock.clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  };
}

async function abortableFetch(fetchImplementation, input, init, signal) {
  throwIfAborted(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => fetchImplementation(input, init)),
      aborted
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function abortableSleep(sleepPromise, signal) {
  if (!signal) return Promise.resolve(sleepPromise);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(sleepPromise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function timerSleep(delayMs, signal, setTimer, clearTimer, clockThis) {
  if (delayMs <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimer.call(clockThis, finish, delayMs);
    const onAbort = () => finish(abortReason(signal));
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(error) {
      clearTimer.call(clockThis, timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
  });
}

function resolveRequestDeadline(startedAt, config, requestOptions) {
  const totalTimeoutMs = requestOptions.totalTimeoutMs ?? config.totalTimeoutMs;
  assertPositiveFiniteOrInfinity(totalTimeoutMs, "request totalTimeoutMs");
  const relativeDeadline = Number.isFinite(totalTimeoutMs) ? startedAt + totalTimeoutMs : Infinity;
  if (requestOptions.deadlineAt == null) return relativeDeadline;

  const absoluteDeadline = Number(requestOptions.deadlineAt);
  if (!Number.isFinite(absoluteDeadline)) throw new TypeError("request deadlineAt must be finite");
  return Math.min(relativeDeadline, absoluteDeadline);
}

function resolveProvider(input, explicitProvider) {
  if (explicitProvider != null && String(explicitProvider).trim() !== "") {
    return String(explicitProvider).trim().toLowerCase();
  }
  try {
    return new URL(requestUrl(input)).hostname.toLowerCase() || "default";
  } catch {
    return "default";
  }
}

function requestUrl(input) {
  if (typeof input === "string" || input instanceof URL) return String(input);
  return String(input?.url ?? input);
}

function requestMethod(input) {
  return typeof input === "object" && input != null && "method" in input ? input.method : null;
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match == null ? null : String(match[1]);
}

function normalizeAbortError(error, attemptSignal, requestSignal) {
  if (attemptSignal?.aborted) return abortReason(attemptSignal);
  if (requestSignal?.aborted) return abortReason(requestSignal);
  return error instanceof Error ? error : new Error(String(error));
}

function isCallerAbort(requestSignal, callerSignal) {
  return Boolean(callerSignal?.aborted && requestSignal?.aborted && requestSignal.reason === callerSignal.reason);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

function assertNonNegativeFinite(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number`);
}

function assertPositiveFiniteOrInfinity(value, name) {
  if (value !== Infinity && (!Number.isFinite(value) || value <= 0)) {
    throw new RangeError(`${name} must be a positive finite number or Infinity`);
  }
}
