import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resumeValidatedSnapshotOrRun } from "../scripts/lib/autonomous-ingestion-resume.mjs";

describe("autonomous ingestion snapshot resume", () => {
  it("runs a fresh collector when resume was requested without a valid snapshot", async () => {
    let freshRuns = 0;
    const result = await resumeValidatedSnapshotOrRun({
      resume: true,
      readSnapshot: async () => null,
      validateSnapshot: (snapshot) => {
        if (snapshot?.status !== "completed") throw new Error("incomplete");
      },
      runFresh: async () => {
        freshRuns += 1;
        return { status: "completed", source: "fresh" };
      }
    });

    assert.equal(freshRuns, 1);
    assert.equal(result.resumed, false);
    assert.deepEqual(result.snapshot, { status: "completed", source: "fresh" });
  });

  it("reuses a completed validated receipt without invoking the collector", async () => {
    const completed = { status: "completed", source: "snapshot" };
    let freshRuns = 0;
    const result = await resumeValidatedSnapshotOrRun({
      resume: true,
      readSnapshot: async () => completed,
      validateSnapshot: (snapshot) => {
        assert.equal(snapshot.status, "completed");
      },
      runFresh: async () => {
        freshRuns += 1;
        return { status: "completed", source: "fresh" };
      }
    });

    assert.equal(freshRuns, 0);
    assert.equal(result.resumed, true);
    assert.equal(result.snapshot, completed);
  });

  it("does not read a snapshot when resume is disabled", async () => {
    let snapshotReads = 0;
    const result = await resumeValidatedSnapshotOrRun({
      resume: false,
      readSnapshot: async () => {
        snapshotReads += 1;
        return { status: "completed" };
      },
      validateSnapshot: () => {},
      runFresh: async () => ({ status: "completed", source: "fresh" })
    });

    assert.equal(snapshotReads, 0);
    assert.equal(result.resumed, false);
    assert.equal(result.snapshot.source, "fresh");
  });
});
