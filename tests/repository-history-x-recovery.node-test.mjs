import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCohortOwnerCatalog,
  buildRecoveredEvidenceRow,
  evaluateHistoricalXRow,
  summarizeRecoveryJournal,
  validateXOembedPayload,
  xSnowflakeTimestamp
} from "../scripts/lib/repository-history-x-recovery.mjs";

const graph = {
  batch: { slug: "S2026" },
  nodes: [{
    entityType: "company",
    entityId: "company-example",
    label: "Example",
    socialAccounts: [],
    founders: [{
      id: "founder-example-alice-1",
      name: "Alice Example",
      socialAccounts: [{
        platform: "x",
        url: "https://x.com/AliceExample",
        review_state: "verified",
        matchReason: "Linked from the canonical founder profile."
      }]
    }]
  }]
};
const catalog = buildCohortOwnerCatalog([graph]);
const historicalRow = {
  id: "historical-x-row",
  batchSlug: "S2026",
  entityType: "founder",
  entityId: "founder-example-alice-1",
  companyName: "Example",
  platform: "x",
  sourceUrl: "https://twitter.com/AliceExample/status/1289216226527338496",
  platformPostId: "1289216226527338496",
  postedAt: "2020-07-31T05:00:00.000Z",
  review_state: "verified",
  rawVisibleText: JSON.stringify({ author: "AliceExample" })
};

test("accepts only missing native posts authored by the current verified owner", () => {
  const accepted = evaluateHistoricalXRow(historicalRow, {
    catalog,
    currentPhysicalKeys: new Set()
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.physicalKey, "x:1289216226527338496");
  assert.equal(accepted.owner.entityId, "founder-example-alice-1");
  assert.equal(accepted.officialAccount.handle, "aliceexample");
  assert.equal(accepted.exactPostedAt, "2020-07-31T15:07:55.540Z");

  const duplicate = evaluateHistoricalXRow(historicalRow, {
    catalog,
    currentPhysicalKeys: new Set(["x:1289216226527338496"])
  });
  assert.equal(duplicate.accepted, false);
  assert.ok(duplicate.reasons.includes("already_in_current_evidence"));

  const urlOnlyIdentity = evaluateHistoricalXRow({
    ...historicalRow,
    platformPostId: null
  }, { catalog, currentPhysicalKeys: new Set() });
  assert.equal(urlOnlyIdentity.accepted, true);
  assert.equal(urlOnlyIdentity.native.postId, "1289216226527338496");
});

test("fails closed on stale attribution, mismatched authors, and unverified rows", () => {
  const wrongAuthor = evaluateHistoricalXRow({
    ...historicalRow,
    sourceUrl: "https://x.com/notalice/status/1289216226527338496"
  }, { catalog });
  assert.equal(wrongAuthor.accepted, false);
  assert.ok(wrongAuthor.reasons.includes("native_author_not_current_verified_owner"));

  const wrongBatch = evaluateHistoricalXRow({ ...historicalRow, batchSlug: "S26" }, { catalog });
  assert.equal(wrongBatch.accepted, false);
  assert.ok(wrongBatch.reasons.includes("current_cohort_owner_not_resolved"));

  const unverified = evaluateHistoricalXRow({ ...historicalRow, review_state: "needs_review" }, { catalog });
  assert.equal(unverified.accepted, false);
  assert.ok(unverified.reasons.includes("historical_row_not_verified"));
});

test("validates official X oEmbed identity and post body", () => {
  const candidate = evaluateHistoricalXRow(historicalRow, { catalog });
  const accepted = validateXOembedPayload({
    url: "https://x.com/aliceexample/status/1289216226527338496",
    author_name: "Alice Example",
    author_url: "https://x.com/AliceExample",
    html: "<blockquote class=\"twitter-tweet\"><p>Hello</p></blockquote>"
  }, candidate);
  assert.equal(accepted.accepted, true);

  const rejected = validateXOembedPayload({
    url: "https://x.com/aliceexample/status/1289216226527338496",
    author_name: "Mallory",
    author_url: "https://x.com/mallory",
    html: "<blockquote><p>Hello</p></blockquote>"
  }, candidate);
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.reasons.includes("x_oembed_author_identity_mismatch"));
});

test("materializes exact timestamp and full recovery provenance without mutating the source row", () => {
  const candidate = evaluateHistoricalXRow(historicalRow, { catalog });
  const validation = validateXOembedPayload({
    url: candidate.native.url,
    author_name: "Alice Example",
    author_url: "https://x.com/aliceexample",
    html: "<blockquote><p>Hello</p></blockquote>"
  }, candidate);
  const recovered = buildRecoveredEvidenceRow(candidate, validation, {
    commit: "abc123",
    committedAt: "2026-08-01T00:00:00.000Z",
    path: "src/lib/social/logged-in-evidence-current.json",
    sourceIndex: 42,
    checkedAt: "2026-08-09T00:00:00.000Z",
    endpoint: "https://publish.twitter.com/oembed?url=example",
    returnedUrl: candidate.native.url
  });

  assert.equal(historicalRow.postedAt, "2020-07-31T05:00:00.000Z");
  assert.equal(recovered.postedAt, "2020-07-31T15:07:55.540Z");
  assert.equal(recovered.accountUrl, "https://x.com/AliceExample");
  assert.equal(recovered._recoveryProvenance.git.sourceIndex, 42);
  assert.deepEqual(recovered.attributionSignals, [
    "current_verified_account_mapping",
    "official_x_oembed_author_match",
    "native_x_snowflake_timestamp"
  ]);
});

test("journal reconstruction is resumable and idempotent", () => {
  const candidate = { physicalKey: "x:1", row: { id: "first" } };
  const state = summarizeRecoveryJournal([
    { type: "blob_checkpoint", token: "a:path", candidates: [candidate] },
    { type: "blob_checkpoint", token: "b:path", candidates: [{ physicalKey: "x:1", row: { id: "older" } }] },
    { type: "validation_checkpoint", physicalKey: "x:1", status: "rejected" },
    { type: "validation_checkpoint", physicalKey: "x:1", status: "accepted" }
  ]);
  assert.deepEqual([...state.completedBlobs], ["a:path", "b:path"]);
  assert.equal(state.candidates.get("x:1").row.id, "first");
  assert.equal(state.validations.get("x:1").status, "accepted");
});

test("derives millisecond publication time from immutable X snowflake IDs", () => {
  assert.equal(xSnowflakeTimestamp("321369260364546049"), "2013-04-08T21:09:37.080Z");
  assert.equal(xSnowflakeTimestamp("not-an-id"), null);
});
