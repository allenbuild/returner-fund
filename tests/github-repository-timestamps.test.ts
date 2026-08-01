import { describe, expect, it } from "vitest";
import { githubRepositoryEvidenceTimestamps } from "@/lib/graph/github-repository-timestamps";

describe("GitHub repository evidence timestamps", () => {
  it("does not turn an old repository refreshed today into a post from today", () => {
    const timestamps = githubRepositoryEvidenceTimestamps(
      {
        createdAt: "2024-06-19T13:23:56Z",
        updatedAt: "2026-08-01T05:24:08Z",
        pushedAt: "2026-08-01T05:52:02Z"
      },
      "2026-08-01T06:15:57.778Z"
    );

    expect(timestamps).toEqual({
      postedAt: "2024-06-19T13:23:56Z",
      publishedAtPrecision: "exact",
      lastUpdatedAt: "2026-08-01T05:52:02Z",
      provenance: {
        createdAt: "2024-06-19T13:23:56Z",
        updatedAt: "2026-08-01T05:24:08Z",
        pushedAt: "2026-08-01T05:52:02Z",
        observedAt: "2026-08-01T06:15:57.778Z"
      }
    });
  });

  it("uses the native creation time for a repository actually created today", () => {
    const timestamps = githubRepositoryEvidenceTimestamps(
      {
        createdAt: "2026-08-01T03:00:00Z",
        updatedAt: "2026-08-01T04:00:00Z",
        pushedAt: "2026-08-01T03:30:00Z"
      },
      "2026-08-01T06:00:00Z"
    );

    expect(timestamps.postedAt).toBe("2026-08-01T03:00:00Z");
    expect(timestamps.publishedAtPrecision).toBe("exact");
    expect(timestamps.lastUpdatedAt).toBe("2026-08-01T04:00:00Z");
  });

  it("marks publication unknown when GitHub creation time is missing", () => {
    const timestamps = githubRepositoryEvidenceTimestamps(
      {
        updatedAt: "2026-08-01T04:00:00Z",
        pushedAt: "2026-08-01T03:30:00Z"
      },
      "2026-08-01T06:00:00Z"
    );

    expect(timestamps.postedAt).toBe("2026-08-01T06:00:00Z");
    expect(timestamps.publishedAtPrecision).toBe("unknown");
    expect(timestamps.lastUpdatedAt).toBe("2026-08-01T04:00:00Z");
  });
});
