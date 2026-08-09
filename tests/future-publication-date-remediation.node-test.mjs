import assert from "node:assert/strict";
import test from "node:test";

import {
  futurePublicationDateIssue,
  planFuturePublicationDateRemediation,
} from "../scripts/lib/future-publication-date-remediation.mjs";
import { remediateFuturePublicationDates } from "../scripts/remediate-future-publication-dates.mjs";

const ID = "first-party-rss-eac6547190ee8655e7235561";

test("remediates only a first-party publication claim after first observation", () => {
  const row = futureRow();
  const plan = planFuturePublicationDateRemediation(
    {
      evidence: [
        row,
        { ...row, id: "safe", postedAt: "2026-08-08T00:00:00.000Z" },
      ],
    },
    { now: new Date("2026-08-09T15:00:00.000Z") },
  );

  assert.equal(plan.repairs.length, 1);
  assert.equal(plan.newRepairs.length, 1);
  assert.equal(plan.alreadyRemediated.length, 0);
  assert.deepEqual(plan.unresolved, []);
  const repaired = plan.snapshot.evidence[0];
  assert.equal(repaired.postedAt, "2026-08-09T13:51:36.894Z");
  assert.equal(repaired.publishedAtPrecision, "unknown");
  assert.equal(repaired.last_updated_at, "2026-08-09T13:51:36.894Z");
  assert.ok(!repaired.attributionSignals.includes("title_text_date_provenance"));
  assert.ok(repaired.attributionSignals.includes("publication_date_observation_fallback"));
  assert.equal(
    repaired._recoveryProvenance.reportedPostedAt,
    "2026-08-13T00:00:00.000Z",
  );
  const receipt = JSON.parse(repaired.rawVisibleText);
  assert.equal(receipt.postedAt, undefined);
  assert.equal(receipt.reportedPostedAt, "2026-08-13T00:00:00.000Z");
  assert.equal(receipt.publicationDateDisposition, "rejected_after_observation");
});

test("recognizes a completed remediation as an idempotent no-op", () => {
  const first = planFuturePublicationDateRemediation(
    { evidence: [futureRow()] },
    { now: new Date("2026-08-09T15:00:00.000Z") },
  );
  const second = planFuturePublicationDateRemediation(first.snapshot, {
    now: new Date("2026-08-09T15:01:00.000Z"),
  });
  assert.equal(second.repairs.length, 1);
  assert.equal(second.newRepairs.length, 0);
  assert.equal(second.alreadyRemediated.length, 1);
  assert.deepEqual(second.snapshot, first.snapshot);
});

test("fails closed when first-party observation timestamps are missing or future", () => {
  const missing = futureRow();
  delete missing.first_seen_at;
  delete missing.last_checked_at;
  delete missing.linkCheckedAt;
  const missingPlan = planFuturePublicationDateRemediation(
    { evidence: [missing] },
    { now: new Date("2026-08-09T15:00:00.000Z") },
  );
  assert.equal(
    missingPlan.unresolved[0].reason,
    "first_party_recovery_observation_missing_or_untrusted",
  );

  const future = futureRow();
  future.first_seen_at = "2099-01-01T00:00:00.000Z";
  future.last_checked_at = "2099-01-01T00:00:00.000Z";
  future.linkCheckedAt = "2099-01-01T00:00:00.000Z";
  const futurePlan = planFuturePublicationDateRemediation(
    { evidence: [future] },
    { now: new Date("2026-08-09T15:00:00.000Z") },
  );
  assert.equal(
    futurePlan.unresolved[0].reason,
    "first_party_recovery_observation_missing_or_untrusted",
  );
});

test("write retries succeed without publishing the canonical artifact twice", async () => {
  let snapshot = { evidence: [futureRow()] };
  let publishes = 0;
  const dependencies = {
    now: () => new Date("2026-08-09T15:00:00.000Z"),
    stdout: { write() {} },
    readArtifact: async () => ({
      snapshot,
      canonicalSha256: `canonical-${publishes}`,
      ledgerSha256: "ledger",
      reviewLedgerSha256: "review",
    }),
    publishArtifact: async ({ snapshot: next }) => {
      publishes += 1;
      snapshot = next;
      return {
        canonicalSha256: `canonical-${publishes}`,
        ledgerSha256: "ledger",
        reviewLedgerSha256: "review",
      };
    },
  };
  const args = [
    "--write",
    "--expected-remediations=1",
    `--expected-id=${ID}`,
  ];
  const first = await remediateFuturePublicationDates(args, dependencies);
  const second = await remediateFuturePublicationDates(args, dependencies);
  assert.equal(first.status, "remediated");
  assert.equal(second.status, "already_remediated");
  assert.equal(publishes, 1);
});

test("flags future claims outside the narrow first-party remediation scope", () => {
  const row = { ...futureRow(), id: "youtube-row", platform: "youtube" };
  const plan = planFuturePublicationDateRemediation(
    { evidence: [row] },
    { now: new Date("2026-08-09T15:00:00.000Z") },
  );
  assert.equal(plan.repairs.length, 0);
  assert.equal(plan.unresolved[0].reason, "future_publication_date_outside_first_party_recovery");
});

test("detects the earliest valid observation deterministically", () => {
  assert.deepEqual(
    futurePublicationDateIssue(futureRow(), null, {
      now: new Date("2026-08-09T15:00:00.000Z"),
    }),
    {
      reportedPostedAt: "2026-08-13T00:00:00.000Z",
      observedAt: "2026-08-09T13:51:36.894Z",
    },
  );
});

function futureRow() {
  return {
    id: ID,
    platform: "rss",
    companyName: "Replicas",
    sourceUrl: "https://tryreplicas.com/customers/knowunity",
    title: "How Knowunity doubled engineering velocity with cloud agents",
    text: "Knowunity uses Replicas across GitHub and GitLab, where cloud agents now produce half of its pull requests.",
    postedAt: "2026-08-13T00:00:00.000Z",
    publishedAtPrecision: "day",
    first_seen_at: "2026-08-09T13:51:36.894Z",
    last_checked_at: "2026-08-10T00:00:00.000Z",
    linkCheckedAt: "2026-08-10T00:00:00.000Z",
    last_updated_at: "2026-08-13T00:00:00.000Z",
    rawVisibleText: JSON.stringify({
      recovery: "first_party_authored_post",
      postedAt: "2026-08-13T00:00:00.000Z",
    }),
    attributionSignals: [
      "current_cohort_owner",
      "exact_current_official_domain",
      "stable_authored_item_url",
      "title_text_date_provenance",
    ],
    _recoveryProvenance: {
      schemaVersion: 1,
      contentSha256: "stale",
    },
  };
}
