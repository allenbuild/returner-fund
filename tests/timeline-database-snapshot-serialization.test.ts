import { describe, expect, it } from "vitest";
import {
  parseTimelineDatabaseSnapshotFile,
  serializeTimelineDatabaseSnapshotFile,
  type TimelineDatabaseSnapshot,
} from "../src/lib/timeline/database-backfill";

const SHA256 = "a".repeat(64);

function fixtureSnapshot(): TimelineDatabaseSnapshot {
  return {
    status: "loaded",
    byCompanySourceKey: new Map([
      ["company-zeta", {
        events: [],
        sourceCoverage: { company_page: "completed" },
        candidateEventCount: 2,
        unresolvedDateCount: 1,
      }],
      ["company-alpha", {
        events: [],
        sourceCoverage: { company_blog: "no_results" },
        candidateEventCount: 0,
        unresolvedDateCount: 0,
      }],
    ]),
    sha256: SHA256,
    generatedAt: "2026-08-23T00:00:00.000Z",
    publishedEvents: 7,
    limitations: null,
  };
}

describe("Timeline database snapshot file serialization", () => {
  it("round-trips the Map-backed company index through real JSON bytes", () => {
    const serialized = serializeTimelineDatabaseSnapshotFile(fixtureSnapshot());
    const raw = JSON.parse(serialized) as { format: string; byCompanySourceKey: unknown[] };
    expect(raw.format).toBe("returner.timeline-database-snapshot.v1");
    expect(raw.byCompanySourceKey).toHaveLength(2);

    const restored = parseTimelineDatabaseSnapshotFile(serialized);
    expect(restored.byCompanySourceKey).toBeInstanceOf(Map);
    expect(restored.byCompanySourceKey.get("company-zeta")).toEqual({
      events: [],
      sourceCoverage: { company_page: "completed" },
      candidateEventCount: 2,
      unresolvedDateCount: 1,
    });
    expect(restored.sha256).toBe(SHA256);
    expect(restored.generatedAt).toBe("2026-08-23T00:00:00.000Z");
    expect(restored.publishedEvents).toBe(7);
  });

  it("writes deterministic bytes regardless of Map insertion order", () => {
    const snapshot = fixtureSnapshot();
    const reversed = {
      ...snapshot,
      byCompanySourceKey: new Map([...snapshot.byCompanySourceKey.entries()].reverse()),
    };
    expect(serializeTimelineDatabaseSnapshotFile(reversed))
      .toBe(serializeTimelineDatabaseSnapshotFile(snapshot));
  });

  it("rejects the legacy lossy object encoding instead of silently loading an empty index", () => {
    expect(() => parseTimelineDatabaseSnapshotFile(JSON.stringify({
      format: "returner.timeline-database-snapshot.v1",
      status: "loaded",
      byCompanySourceKey: {},
      sha256: SHA256,
      generatedAt: null,
      publishedEvents: 0,
      limitations: null,
    }))).toThrow(/company index must be encoded as entries/i);
  });
});
