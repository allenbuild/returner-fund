import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalCheckpointPayloads,
  checkpointCanonicalRows
} from "../scripts/lib/logged-in-checkpoint-union.mjs";

test("canonical checkpoint union preserves every cohort when canonical output is empty", () => {
  const entries = [
    { path: "s26", payload: { evidence: [{ id: "summer" }] } },
    { path: "s2026", payload: { evidence: [{ id: "spring" }] } },
    { path: "a16z", payload: { evidence: [{ id: "speedrun" }] } }
  ];

  const payloads = canonicalCheckpointPayloads(entries, {
    activePath: "s2026",
    activeCheckpoint: {
      evidence: [{ id: "spring-reconciled" }],
      attempts: { local: { status: "done" } }
    }
  });

  assert.deepEqual(
    checkpointCanonicalRows(payloads, "evidence").map((row) => row.id),
    ["summer", "spring-reconciled", "speedrun"]
  );
  assert.deepEqual(
    checkpointCanonicalRows(payloads, "attempts"),
    []
  );
});

test("missing checkpoint fields contribute no rows", () => {
  assert.deepEqual(
    checkpointCanonicalRows([{}, null, { failures: [{ id: "f" }] }], "failures"),
    [{ id: "f" }]
  );
});
