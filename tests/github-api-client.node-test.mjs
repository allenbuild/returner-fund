import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchGitHubJsonResponse,
  githubApiFailureReceipt,
  githubCollectorFailureOutcomeReason,
  GitHubApiError,
  safeGitHubEndpoint
} from "../scripts/lib/github-api-client.mjs";
import {
  autonomousCollectorRetryableFailures
} from "../scripts/lib/autonomous-ingestion-plan.mjs";

test("GitHub rate-limit exhaustion retains structured retry metadata", async () => {
  const resetSeconds = 1_800_000_010;
  const sleeps = [];
  const calls = [];
  const fetchImplementation = async (url) => {
    calls.push(url);
    return new Response(null, {
      status: 403,
      statusText: "rate limited",
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetSeconds)
      }
    });
  };

  let caught;
  try {
    await fetchGitHubJsonResponse(
      "https://api.github.com/users/example/repos?page=2&access_token=not-a-real-secret",
      {
        fetchImplementation,
        sleep: async (ms) => sleeps.push(ms),
        now: () => resetSeconds * 1_000 - 6_000,
        maxAttempts: 3
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof GitHubApiError);
  assert.equal(caught.failureReason, "github_rate_limit_exhausted");
  assert.equal(caught.endpoint, "/users/example/repos");
  assert.equal(caught.httpStatus, 403);
  assert.equal(caught.rateLimitRemaining, 0);
  assert.equal(caught.rateLimitResetAt, new Date(resetSeconds * 1_000).toISOString());
  assert.equal(caught.attempts, 3);
  assert.equal(caught.retryable, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [7_000, 7_000]);
  assert.doesNotMatch(caught.message, /access_token|not-a-real-secret/);

  const receipt = githubApiFailureReceipt(caught);
  assert.deepEqual(receipt, {
    error: caught.message,
    failureReason: "github_rate_limit_exhausted",
    endpoint: "/users/example/repos",
    httpStatus: 403,
    rateLimitRemaining: 0,
    rateLimitResetAt: new Date(resetSeconds * 1_000).toISOString(),
    attempts: 3,
    retryable: true
  });
  assert.equal(githubCollectorFailureOutcomeReason([receipt]), "collector_github_rate_limited");
});

test("GitHub non-rate HTTP failures retain status and retryability", async () => {
  await assert.rejects(
    fetchGitHubJsonResponse("https://api.github.com/users/missing", {
      fetchImplementation: async () => new Response(null, {
        status: 404,
        statusText: "Not Found"
      })
    }),
    (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.failureReason, "github_http_error");
      assert.equal(error.endpoint, "/users/missing");
      assert.equal(error.httpStatus, 404);
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      return true;
    }
  );

  const sleeps = [];
  await assert.rejects(
    fetchGitHubJsonResponse("https://api.github.com/users/flaky", {
      fetchImplementation: async () => new Response(null, {
        status: 503,
        statusText: "Unavailable"
      }),
      sleep: async (ms) => sleeps.push(ms)
    }),
    (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.httpStatus, 503);
      assert.equal(error.retryable, true);
      assert.equal(error.attempts, 3);
      return true;
    }
  );
  assert.deepEqual(sleeps, [1_000, 2_000]);
});

test("GitHub endpoint identifiers discard query and credential material", () => {
  assert.equal(
    safeGitHubEndpoint("https://user:password@api.github.com/repos/example/repo?token=secret"),
    "/repos/example/repo"
  );
});

test("structured GitHub rate limits remain terminal but resumably retryable", () => {
  const message = "GitHub API rate limit exhausted for /users/example (403, remaining=0, resetAt=unknown).";
  const snapshot = {
    attempts: {
      "company:company-example": {
        attemptKey: "company:company-example",
        platform: "github",
        entityType: "company",
        entityId: "company-example",
        status: "done",
        error: message,
        retryable: true,
        outcomeStatus: "failed",
        outcomeReason: "collector_github_rate_limited"
      }
    },
    accounts: [
      {
        attemptKey: "account:company:company-example:https://github.com/example",
        entityType: "company",
        entityId: "company-example",
        githubUrl: "https://github.com/example",
        fetched: false,
        error: message,
        failureReason: "github_rate_limit_exhausted",
        httpStatus: 403,
        rateLimitRemaining: 0,
        retryable: true
      }
    ]
  };

  assert.deepEqual(autonomousCollectorRetryableFailures(snapshot), [message]);
});
