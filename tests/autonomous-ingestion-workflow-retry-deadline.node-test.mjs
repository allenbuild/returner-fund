import assert from "node:assert/strict";
import test from "node:test";

import { classifyAutonomousWorkflowAttempt } from
  "../scripts/lib/autonomous-ingestion-workflow-retry.mjs";

test("collector deadline failures remain eligible for a controller retry", () => {
  const decision = classifyAutonomousWorkflowAttempt({
    exitCode: 1,
    output: [
      "runner_status=failed",
      "publication_status=not_started",
      "published_commit=",
      "failure_domain=collector",
      "failure_code=collector_retryable_deadline",
      "failure_message=Collector snapshots still contain retryable failures after the collection deadline: public:S26 (1), public:A16ZSR006 (3); publication, freshness advancement, and run completion are prohibited."
    ].join("\n")
  });

  assert.equal(decision.completed, false);
  assert.equal(decision.retryable, true);
  assert.equal(decision.reason, "transient-infrastructure-failure");
});
