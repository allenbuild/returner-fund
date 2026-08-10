const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 65_000;
const defaultGitHubRetryAdmission = createGitHubRetryAdmission();

export class GitHubApiError extends Error {
  constructor(message, {
    failureReason,
    endpoint,
    httpStatus = null,
    rateLimitRemaining = null,
    rateLimitResetAt = null,
    attempts = 1,
    retryable = false,
    causeCode = null,
    cause
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GitHubApiError";
    this.failureReason = failureReason;
    this.endpoint = endpoint;
    this.httpStatus = httpStatus;
    this.rateLimitRemaining = rateLimitRemaining;
    this.rateLimitResetAt = rateLimitResetAt;
    this.attempts = attempts;
    this.retryable = retryable;
    this.causeCode = causeCode;
  }
}

export async function fetchGitHubJsonResponse(url, {
  headers = {},
  fetchImplementation = globalThis.fetch,
  sleep = delay,
  now = Date.now,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxRateLimitWaitMs = DEFAULT_MAX_RATE_LIMIT_WAIT_MS,
  retryAdmission = defaultGitHubRetryAdmission
} = {}) {
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("fetchGitHubJsonResponse requires a fetch implementation.");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive integer.");
  }
  if (!retryAdmission || typeof retryAdmission.run !== "function") {
    throw new TypeError("retryAdmission must expose a run(operation) function.");
  }
  const endpoint = safeGitHubEndpoint(url);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      const request = () => fetchImplementation(url, { headers });
      response = attempt === 1
        ? await request()
        : await retryAdmission.run(request);
    } catch (error) {
      const causeCode = safeErrorCode(error);
      const detail = causeCode ? ` (${causeCode})` : "";
      throw new GitHubApiError(
        `GitHub API transport failed for ${endpoint}${detail}: ${errorMessage(error)}`,
        {
          failureReason: "github_transport_error",
          endpoint,
          attempts: attempt,
          retryable: true,
          causeCode,
          cause: error
        }
      );
    }

    if (response.ok) {
      return {
        data: await response.json(),
        headers: response.headers
      };
    }

    const remaining = numericHeader(response.headers, "x-ratelimit-remaining");
    const resetAt = githubResetAt(response.headers);
    if (response.status === 403 && remaining === 0) {
      const rateLimitError = new GitHubApiError(
        `GitHub API rate limit exhausted for ${endpoint} ` +
          `(403, remaining=0, resetAt=${resetAt ?? "unknown"}).`,
        {
          failureReason: "github_rate_limit_exhausted",
          endpoint,
          httpStatus: 403,
          rateLimitRemaining: 0,
          rateLimitResetAt: resetAt,
          attempts: attempt,
          retryable: true
        }
      );
      if (attempt === maxAttempts) throw rateLimitError;

      const resetAtMs = resetAt ? Date.parse(resetAt) : Number.NaN;
      const currentTime = Number(now());
      const waitMs = Math.min(
        Math.max(
          Number.isFinite(resetAtMs) && Number.isFinite(currentTime)
            ? resetAtMs - currentTime + 1_000
            : 5_000,
          5_000
        ),
        maxRateLimitWaitMs
      );
      await sleep(waitMs);
      continue;
    }

    const retryable = [403, 408, 425, 429].includes(response.status) || response.status >= 500;
    if (retryable && attempt < maxAttempts) {
      await sleep(1_000 * attempt);
      continue;
    }
    throw new GitHubApiError(
      `GitHub API request failed for ${endpoint}: ${response.status} ${response.statusText || "HTTP error"}.`,
      {
        failureReason: "github_http_error",
        endpoint,
        httpStatus: response.status,
        rateLimitRemaining: remaining,
        rateLimitResetAt: resetAt,
        attempts: attempt,
        retryable
      }
    );
  }

  throw new Error("GitHub API request exhausted attempts without a result.");
}

export function createGitHubRetryAdmission({
  minimumSpacingMs = 250,
  jitterMs = 250,
  now = Date.now,
  sleep = delay,
  random = Math.random
} = {}) {
  if (!Number.isSafeInteger(minimumSpacingMs) || minimumSpacingMs < 0) {
    throw new RangeError("minimumSpacingMs must be a nonnegative integer.");
  }
  if (!Number.isSafeInteger(jitterMs) || jitterMs < 0) {
    throw new RangeError("jitterMs must be a nonnegative integer.");
  }
  if (
    typeof now !== "function" ||
    typeof sleep !== "function" ||
    typeof random !== "function"
  ) {
    throw new TypeError("GitHub retry admission hooks must be functions.");
  }

  let tail = Promise.resolve();
  let nextAllowedAt = 0;
  let queued = 0;
  let active = false;

  const admission = {
    run(operation) {
      if (typeof operation !== "function") {
        return Promise.reject(new TypeError("GitHub retry admission requires an operation."));
      }
      queued += 1;
      const previous = tail;
      const current = previous.then(async () => {
        queued -= 1;
        const observedAt = finiteAdmissionClock(now());
        const randomValue = Number(random());
        if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
          throw new RangeError("GitHub retry admission random hook must return [0, 1).");
        }
        const randomizedDelay = Math.floor(randomValue * (jitterMs + 1));
        const waitMs = Math.max(0, nextAllowedAt - observedAt) + randomizedDelay;
        if (waitMs > 0) await sleep(waitMs);
        const admittedAt = finiteAdmissionClock(now());
        if (admittedAt < observedAt) {
          throw new Error("GitHub retry admission clock moved backwards.");
        }
        if (admittedAt < observedAt + waitMs) {
          throw new Error("GitHub retry admission sleep completed before its admission boundary.");
        }
        nextAllowedAt = admittedAt + minimumSpacingMs;
        active = true;
        try {
          return await operation();
        } finally {
          active = false;
        }
      });
      tail = current.then(() => undefined, () => undefined);
      return current;
    },
    snapshot() {
      return Object.freeze({
        active,
        queued,
        nextAllowedAt
      });
    }
  };
  return Object.freeze(admission);
}

export function githubApiFailureReceipt(error) {
  if (error instanceof GitHubApiError) {
    return {
      error: error.message,
      failureReason: error.failureReason,
      endpoint: error.endpoint,
      httpStatus: error.httpStatus,
      rateLimitRemaining: error.rateLimitRemaining,
      rateLimitResetAt: error.rateLimitResetAt,
      attempts: error.attempts,
      retryable: error.retryable,
      ...(error.causeCode ? { causeCode: error.causeCode } : {})
    };
  }
  return {
    error: errorMessage(error),
    failureReason: "github_unknown_error",
    endpoint: null,
    httpStatus: null,
    rateLimitRemaining: null,
    rateLimitResetAt: null,
    attempts: 1,
    retryable: false
  };
}

export function githubCollectorFailureOutcomeReason(results) {
  return (results ?? []).some(
    (result) => result?.failureReason === "github_rate_limit_exhausted"
  )
    ? "collector_github_rate_limited"
    : "collector_reported_failure";
}

export function safeGitHubEndpoint(value) {
  try {
    const parsed = new URL(value);
    return parsed.pathname || "/";
  } catch {
    return "/invalid-endpoint";
  }
}

function githubResetAt(headers) {
  const seconds = numericHeader(headers, "x-ratelimit-reset");
  if (seconds == null || seconds < 0) return null;
  const resetAtMs = seconds * 1_000;
  if (!Number.isFinite(resetAtMs)) return null;
  try {
    return new Date(resetAtMs).toISOString();
  } catch {
    return null;
  }
}

function numericHeader(headers, name) {
  const raw = headers?.get?.(name);
  if (raw == null || String(raw).trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeErrorCode(error) {
  const code = error?.cause?.code ?? error?.code;
  return /^[A-Z0-9_-]{1,40}$/.test(String(code ?? "")) ? String(code) : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function finiteAdmissionClock(value) {
  const clock = Number(value);
  if (!Number.isFinite(clock)) {
    throw new TypeError("GitHub retry admission clock must be finite.");
  }
  return clock;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
